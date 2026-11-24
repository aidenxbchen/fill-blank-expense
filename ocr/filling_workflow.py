"""Handbook-first prefilling and approval-gated learning, separate from submission/OCR.

The server retains the generated baseline. A submitted edit is pending evidence until
the PURCHASE instance and an actually connected BUDGET both pass verification.
"""
import copy
import json
import re
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import expense_data as data
import feishu_oauth as auth
import handbook

RULE_BLOCK = re.compile(r'```baoxiao-prefill-rules\n(.*?)\n```', re.S)
_lock = threading.RLock()
_syncing = set()
_last_import = {}
_rules_cache = None
PURCHASE_CODE = 'D448D0FB-77DB-4640-9650-1FB99512888C'


def tables(con):
    con.executescript('''
      CREATE TABLE IF NOT EXISTS workflow_prefills (
        owner TEXT NOT NULL, draft_id TEXT NOT NULL, baseline TEXT NOT NULL,
        PRIMARY KEY(owner,draft_id)
      );
      CREATE TABLE IF NOT EXISTS workflow_learning (
        owner TEXT NOT NULL, instance_code TEXT NOT NULL, baseline TEXT NOT NULL,
        final TEXT NOT NULL, differences TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(owner,instance_code)
      );
    ''')


def rules():
    global _rules_cache
    stat = handbook.HANDBOOK_PATH.stat()
    key = (str(handbook.HANDBOOK_PATH), stat.st_mtime_ns, stat.st_size)
    with _lock:
        if not _rules_cache or _rules_cache[0] != key:
            match = RULE_BLOCK.search(handbook.read_handbook())
            if not match:
                raise ValueError('工作手册缺少预填执行规则，请联系维护者')
            _rules_cache = (key, json.loads(match[1]))
        return _rules_cache[1]


def month(value):
    try:
        stamp = float(value)
        if stamp > 10**11:
            stamp /= 1000
        return datetime.fromtimestamp(stamp, ZoneInfo('Asia/Shanghai')).strftime('%Y-%m')
    except (ValueError, TypeError, OverflowError, OSError):
        return ''


def widgets(detail):
    form = detail.get('form') or []
    if isinstance(form, str):
        form = json.loads(form)
    return form if isinstance(form, list) else []


def eligible(detail, fetch):
    # Check admission BEFORE reading invoice/expense content. DONE tasks are not approval.
    if (detail.get('approval_code') != PURCHASE_CODE
            or not auth.is_approved_status(detail.get('status'))
            or month(detail.get('start_time')) != '2026-11'
            or month(detail.get('end_time')) != '2026-11'):
        return False
    budget_codes = {d['approval_code'] for d in auth.BUDGET_DEFINITIONS}
    for w in widgets(detail):
        if w.get('type') != 'connect' or not isinstance(w.get('value'), list):
            continue
        for ref in w['value']:
            code = ref if isinstance(ref, str) else (ref.get('instance_code') or ref.get('instance_id')) if isinstance(ref, dict) else None
            if not code:
                continue
            linked = fetch(code)
            if linked.get('approval_code') in budget_codes and auth.is_approved_status(linked.get('status')):
                return True
    return False


def business_context(purpose):
    # Purpose is a necessary fact supplied for THIS claim, never copied from a sample.
    for key, pattern in rules()['contexts'].items():
        if re.search(pattern, str(purpose or '')):
            return key
    return ''


def content_class(inv):
    config = rules()
    items = ' '.join(str(r.get('name') or '') for r in inv.get('items', []) if isinstance(r, dict))
    text = items + ' ' + ' '.join(str(inv.get(k) or '') for k in ('merchant', 'note'))
    if re.search(config['contentPatterns']['insurance'], text, re.I):
        return 'insurance'
    # Confirmed invoice categories and item descriptions outrank a hotel's merchant name.
    if inv.get('category') in ('meal', 'transit', 'lodging', 'entertainment'):
        return inv['category']
    for content in (items, text):
        for key, pattern in config['contentPatterns'].items():
            if re.search(pattern, content, re.I):
                return key
    return inv.get('category') or 'other'


def hard_values(claim, inv):
    config = rules()
    method = claim.get('purchaseMethod') or (claim.get('answers') or {}).get('purchaseMethod')
    kind = content_class(inv)
    if method == '差旅费':
        result = {'差旅科目': '差旅费'}
        if kind in config['travel']:
            result['费用类型'] = config['travel'][kind]
        return result
    return {}


def validate_claim(claim):
    for inv in claim.get('invoices') or []:
        for field, value in hard_values(claim, inv).items():
            key = f"purchase:{claim.get('purchaseMethod')}:{inv['id']}:{field}"
            if (claim.get('answers') or {}).get(key) != value:
                raise ValueError(f"【{claim.get('costCenter') or '待选项目'}】¥{float(inv.get('amount') or 0):.2f}：{field}应为「{value}」，请在清单核对手册规则冲突")


def review(owner, claim, form):
    import approval_files
    from feishu_purchase import build_form
    validate_claim(claim)
    build_form(form, claim)  # Unknown required fields/options fail closed here too.
    files = approval_files.resolve_invoices(owner, claim)
    return {'ok': True, 'attachmentCount': len(files)}


def baseline_diff(baseline, final):
    before = baseline.get('answers') or {}
    after = final.get('answers') or {}
    keys = {'purchaseMethod', 'costCenter', 'purpose'} | {k for k in before.keys() | after.keys() if k.startswith('purchase:')}
    changes = [{'field': k, 'prefilled': before.get(k, ''), 'submitted': after.get(k, '')}
               for k in sorted(keys) if before.get(k, '') != after.get(k, '')]
    if baseline.get('selectedBudget') != final.get('selectedBudget'):
        changes.append({'field': 'selectedBudget', 'prefilled': baseline.get('selectedBudget'), 'submitted': final.get('selectedBudget')})
    old_rows = {i['id']: i for i in baseline.get('invoices', [])}
    for inv in final.get('invoices', []):
        old = old_rows.get(inv['id'], {})
        for key in ('amount', 'date', 'merchant', 'category', 'quantity', 'unit', 'note', 'invoiceNo', 'attachment'):
            if str(old.get(key, '')) != str(inv.get(key, '')):
                changes.append({'invoiceId': inv['id'], 'field': key, 'prefilled': old.get(key, ''), 'submitted': inv.get(key, '')})
    return changes


def verified_claims(owner):
    with data.database() as con:
        tables(con)
        return [json.loads(r[0]) for r in con.execute('SELECT final FROM workflow_learning WHERE owner=? AND verified=1', (owner,))]


def history_choices(owner, claim, inv, field, samples):
    method = claim.get('purchaseMethod')
    context = business_context(claim.get('purpose') or (claim.get('answers') or {}).get('purpose'))
    kind = content_class(inv)
    if not context or kind == 'other':
        return []
    counts = {}
    for sample in samples:
        if sample.get('purchaseMethod') != method or business_context(sample.get('purpose')) != context:
            continue
        votes = set()  # One approval is one supporting observation, even with 25 similar rows.
        for old in sample.get('invoices', []):
            if content_class(old) != kind:
                continue
            value = (sample.get('answers') or {}).get(f"purchase:{method}:{old['id']}:{field}")
            if value:
                votes.add(value)
        for value in votes:
            counts[value] = counts.get(value, 0) + 1
    total = sum(counts.values())
    return [{'value': value, 'evidence': count, 'probability': round(count / total, 3),
             'source': '已通过且关联预算的同用途同类历史'}
            for value, count in sorted(counts.items(), key=lambda x: (-x[1], x[0]))]


def suggestions(owner, claim, schema):
    samples = verified_claims(owner)
    method = next((m for m in schema['methods'] if m['name'] == claim.get('purchaseMethod')), {})
    rows = {}
    for inv in (claim.get('invoices') or [])[:100]:
        rows[inv['id']] = {data.role(w['name']): history_choices(owner, claim, inv, w['name'], samples)
                           for w in method.get('fields', []) if w.get('options')}
    return {'global': {}, 'rows': rows}


def prefill(owner, draft_id, claim, schema):
    if not isinstance(draft_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', draft_id):
        raise ValueError('预填缺少草稿标识')
    invoices = claim.get('invoices')
    if not isinstance(invoices, list) or not 1 <= len(invoices) <= 100 or any(not isinstance(i, dict) or not isinstance(i.get('id'), str) for i in invoices):
        raise ValueError('预填需要 1～100 张发票')
    answers = copy.deepcopy(claim.get('answers') or {})
    method = next((m for m in schema['methods'] if m['name'] == claim.get('purchaseMethod')), None)
    if not method:
        raise ValueError('请先选择整单采购方式')
    samples = verified_claims(owner)
    evidence = {}
    for inv in invoices:
        hard = hard_values(claim, inv)
        for w in method['fields']:
            name, options = w['name'], w.get('options') or []
            if not options:
                continue
            key = f"purchase:{method['name']}:{inv['id']}:{name}"
            value, source = hard.get(name), '工作手册 · 已确认执行规则'
            if not value:
                candidates = [c for c in history_choices(owner, claim, inv, name, samples) if c['value'] in options]
                if candidates and candidates[0]['probability'] >= .75:
                    value, source = candidates[0]['value'], candidates[0]['source'] + f"（{candidates[0]['evidence']} 单，建议待检查）"
                else:
                    config = rules()
                    context, kind = business_context(claim.get('purpose')), content_class(inv)
                    for rule in config.get('conditional', []) + config.get('learned', []):
                        if (rule['context'] == context and rule['kind'] == kind and rule['field'] == data.role(name)
                                and (not rule.get('method') or rule['method'] == method['name'])):
                            value, source = rule['value'], '工作手册 · 有条件建议，待检查'
                            break
            if value not in options:
                value = None
            # Existing values include manual edits and resumed drafts. Never overwrite them.
            if key not in answers and value:
                answers[key] = value
            evidence[key] = {'source': source if value else '无同类历史 / 待检查',
                             'suggested': value, 'hard': name in hard, 'needsCheck': name not in hard}
    generated = {**copy.deepcopy(claim), 'answers': answers}
    with data.database() as con:
        tables(con)
        # The generated version is retained before any client edits; refresh cannot erase it.
        previous = con.execute('SELECT baseline FROM workflow_prefills WHERE owner=? AND draft_id=?', (owner, draft_id)).fetchone()
        if not previous or json.loads(previous[0]).get('purchaseMethod') != method['name']:
            con.execute('INSERT OR REPLACE INTO workflow_prefills VALUES(?,?,?)', (owner, draft_id, json.dumps(generated, ensure_ascii=False)))
    return {'answers': answers, 'evidence': evidence, 'rulesVersion': rules()['version']}


def capture_submission(owner, draft_id, final, receipt):
    if not receipt.get('ok') or not receipt.get('instanceCode'):
        return
    with data.database() as con:
        tables(con)
        row = con.execute('SELECT baseline FROM workflow_prefills WHERE owner=? AND draft_id=?', (owner, draft_id)).fetchone()
        baseline = json.loads(row[0]) if row else {}
        con.execute('INSERT OR IGNORE INTO workflow_learning(owner,instance_code,baseline,final,differences) VALUES(?,?,?,?,?)',
                    (owner, receipt['instanceCode'], json.dumps(baseline, ensure_ascii=False), json.dumps(final, ensure_ascii=False),
                     json.dumps(baseline_diff(baseline, final), ensure_ascii=False)))


def decode_claim(detail, schema):
    """Read historical form labels, mapping option IDs through the current definition."""
    def value(w, options=()):
        v = w.get('value', '')
        if isinstance(v, dict):
            v = v.get('value', v.get('text', ''))
        return next((o['text'] for o in options if v in (o['text'], o['value'])), v)
    top = widgets(detail)
    definitions = {w['id']: w for w in schema}
    named = {definitions.get(w.get('id'), {}).get('name', w.get('name')): w for w in top}
    defs_by_name = {w['name']: w for w in schema}
    method = value(named.get('采购方式', {}), defs_by_name['采购方式'].get('option', []))
    project = value(named.get('项目', {}), defs_by_name['项目'].get('option', []))
    purpose = value(named.get('采购事由', {}))
    answers = {'purchaseMethod': method, 'costCenter': project, 'purpose': purpose}
    invoices = []
    for group in top:
        if group.get('type') != 'fieldList':
            continue
        children = {w['id']: w for w in definitions.get(group.get('id'), {}).get('children', [])}
        for idx, row in enumerate(group.get('value') or []):
            if not isinstance(row, list):
                continue
            inv = {'id': 'history_' + str(idx), 'category': 'other'}
            for cell in row:
                d = children.get(cell.get('id'), {})
                name = d.get('name') or cell.get('name', '')
                v = value(cell, d.get('option', []) if isinstance(d.get('option'), list) else [])
                if name in ('名称', '备注', '金额'):
                    inv[{'名称': 'merchant', '备注': 'note', '金额': 'amount'}[name]] = v
                elif '科目' in name or name == '费用类型':
                    answers[f"purchase:{method}:{inv['id']}:{name}"] = v
            invoices.append(inv)
    return {'purchaseMethod': method, 'costCenter': project, 'purpose': purpose, 'answers': answers, 'invoices': invoices}


def update_handbook():
    """Rebuild aggregate evidence; never promote an individual claim to a hard rule."""
    with _lock:
        with data.database() as con:
            tables(con)
            rows = con.execute('SELECT final FROM workflow_learning WHERE verified=1').fetchall()
        counts = {}
        for row in rows:
            claim = json.loads(row[0])
            context = business_context(claim.get('purpose'))
            votes = set()
            for inv in claim.get('invoices', []):
                hard = hard_values(claim, inv)
                kind = content_class(inv)
                for key, value in (claim.get('answers') or {}).items():
                    if not key.startswith(f"purchase:{claim.get('purchaseMethod')}:{inv['id']}:"):
                        continue
                    field = key.split(':')[-1]
                    if ('科目' not in field and field != '费用类型') or (field in hard and value != hard[field]):
                        continue  # A human edit cannot silently repeal a confirmed hard rule.
                    if context and kind != 'other':
                        votes.add((claim['purchaseMethod'], context, kind, data.role(field), value))
            for vote in votes:
                counts[vote] = counts.get(vote, 0) + 1
        config = copy.deepcopy(rules())
        config['learned'] = []
        for (method, context, kind, field, value), n in sorted(counts.items()):
            siblings = [v for (m, c, k, f, v) in counts if (m, c, k, f) == (method, context, kind, field)]
            if n >= 3 and len(siblings) == 1 and method != '差旅费':
                config['learned'].append(dict(method=method, context=context, kind=kind, field=field, value=value, support=n))
        text = handbook.read_handbook()
        replacement = '```baoxiao-prefill-rules\n' + json.dumps(config, ensure_ascii=False, indent=2) + '\n```'
        text = RULE_BLOCK.sub(lambda _: replacement, text, count=1)
        evidence = f'已核验正样本 {len(rows)} 单；按不同审批单计支持度。同一单多行不增加规则支持度。只有同用途、同票面类型、同采购方式至少三单一致，才升级为可复用建议；冲突会撤下建议，既有硬规则保持。'
        marker = '<!-- workflow-learning:start -->'
        end = '<!-- workflow-learning:end -->'
        section = marker + '\n' + evidence + '\n' + end
        if marker in text:
            text = re.sub(re.escape(marker) + r'.*?' + re.escape(end), lambda _: section, text, flags=re.S)
        else:
            text += '\n\n### 自动学习证据\n\n' + section + '\n'
        if text != handbook.read_handbook():
            temporary = handbook.HANDBOOK_PATH.with_suffix('.md.tmp')
            temporary.write_text(text, encoding='utf-8')
            temporary.replace(handbook.HANDBOOK_PATH)


def sync_pending(owner=None, fetch=None):
    with data.database() as con:
        tables(con)
        query = 'SELECT owner,instance_code FROM workflow_learning WHERE verified=0'
        pending = con.execute(query + (' AND owner=?' if owner else ''), (owner,) if owner else ()).fetchall()
    if pending and fetch is None:
        token = auth.get_tenant_access_token()
        fetch = lambda code: auth.fetch_instance(token, code)
    for row in pending:
        try:
            detail = fetch(row['instance_code'])
            admitted = eligible(detail, fetch)
        except Exception:
            continue  # One unavailable relation must not stall every other submitted claim.
        if admitted:
            with data.database() as con:
                con.execute('UPDATE workflow_learning SET verified=1 WHERE owner=? AND instance_code=?', tuple(row))
    # Also repairs a crash between DB admission and Markdown write.
    update_handbook()


def import_history(actor):
    """Tenant read access is filtered to the logged-in initiator before content is used."""
    from feishu_purchase import definition
    token = auth.get_tenant_access_token()
    fetch = lambda code: auth.fetch_instance(token, code)
    ids = auth.logged_in_user_ids(actor)
    schema = None
    for item in auth.query_approved_instances(token, PURCHASE_CODE):
        summary = item.get('instance') or item
        start = summary.get('start_time') or summary.get('instance_start_time')
        if start and month(start) != '2026-11':
            continue
        initiator = summary.get('user_id') or summary.get('open_id')
        if initiator and initiator not in ids:
            continue
        code = summary.get('instance_code') or summary.get('instance_id')
        if not code:
            continue
        with data.database() as con:
            tables(con)
            if con.execute('SELECT 1 FROM workflow_learning WHERE owner=? AND instance_code=? AND verified=1', (actor['openId'], code)).fetchone():
                continue
        try:
            detail = fetch(code)
            admitted = (detail.get('user_id') or detail.get('open_id')) in ids and eligible(detail, fetch)
        except Exception:
            continue
        if not admitted:
            continue
        schema = schema or definition()
        claim = decode_claim(detail, schema)
        # Upsert only missing historical evidence; keep locally captured comparisons intact.
        with data.database() as con:
            tables(con)
            con.execute('INSERT OR IGNORE INTO workflow_learning VALUES(?,?,?,?,?,1)',
                        (actor['openId'], code, '{}', json.dumps(claim, ensure_ascii=False), '[]'))
    sync_pending(actor['openId'], fetch)
    update_handbook()


def start_sync(actor):
    owner = actor.get('openId')
    if not owner:
        return
    with _lock:
        if owner in _syncing:
            return
        _syncing.add(owner)
    def run():
        try:
            sync_pending(owner)
            if time.monotonic() - _last_import.get(owner, -3601) > 3600:
                import_history(actor)
                _last_import[owner] = time.monotonic()
        except Exception:
            pass  # Unverified history stays out of positive evidence; next sync retries.
        finally:
            with _lock:
                _syncing.discard(owner)
    threading.Thread(target=run, daemon=True).start()


def start_worker():
    def run():
        while True:
            try:
                sync_pending()
            except Exception:
                pass
            time.sleep(60)
    threading.Thread(target=run, daemon=True).start()
