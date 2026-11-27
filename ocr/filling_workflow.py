"""Handbook-first prefilling and approval-gated learning, separate from submission/OCR.

The server retains the generated baseline. A submitted edit is pending evidence until
the 费用报销 instance is approved. Purchase-application instances are never decoded
or admitted as expense samples.
"""
import copy
import json
import re
import threading
import time
from decimal import Decimal
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
import form_alignment

EXPENSE_CODE = form_alignment.EXPENSE_CODE
PURCHASE_CODE = form_alignment.PURCHASE_CODE  # rejected for learning


def tables(con):
    con.executescript('''
      CREATE TABLE IF NOT EXISTS workflow_prefills (
        owner TEXT NOT NULL, draft_id TEXT NOT NULL, baseline TEXT NOT NULL,
        PRIMARY KEY(owner,draft_id)
      );
      CREATE TABLE IF NOT EXISTS workflow_learning (
        owner TEXT NOT NULL, instance_code TEXT NOT NULL, baseline TEXT NOT NULL,
        final TEXT NOT NULL, differences TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
        occurred_at INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'self',
        PRIMARY KEY(owner,instance_code)
      );
    ''')
    for stmt in (
        "ALTER TABLE workflow_learning ADD COLUMN occurred_at INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE workflow_learning ADD COLUMN source TEXT NOT NULL DEFAULT 'self'",
    ):
        try:
            con.execute(stmt)
        except Exception:
            pass


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




def claim_type(claim):
    answers = (claim or {}).get('answers') or {}
    return str((claim or {}).get('expenseType') or answers.get('expenseType') or '').strip()


def row_key(claim, invoice_id, field):
    return f"expense:{claim_type(claim)}:{invoice_id}:{field}"


def iter_connect_refs(detail):
    for widget in widgets(detail):
        if widget.get('type') == 'connect' and isinstance(widget.get('value'), list):
            yield from widget['value']
        if widget.get('type') != 'fieldList':
            continue
        for row in widget.get('value') or []:
            if not isinstance(row, list):
                continue
            for cell in row:
                if isinstance(cell, dict) and cell.get('type') == 'connect' and isinstance(cell.get('value'), list):
                    yield from cell['value']


def widgets(detail):
    form = detail.get('form') or []
    if isinstance(form, str):
        form = json.loads(form)
    return form if isinstance(form, list) else []


def eligible(detail, fetch):
    # Check admission BEFORE reading invoice/expense content. DONE tasks are not approval.
    # Do not admit 采购申请 instances into the 费用报销 learning set.
    started = month(detail.get('start_time'))
    if (detail.get('approval_code') != EXPENSE_CODE
            or not auth.is_approved_status(detail.get('status'))
            or started < '2026-11'):
        return False
    # Expense form has no required budget connect except travel's 关联审批.
    # fetch is accepted for signature compatibility and for optional link checks.
    return True


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
    typ = claim_type(claim)
    kind = content_class(inv)
    if typ == '差旅费' and kind in config['travel']:
        return {'名称': config['travel'][kind]}
    return {}


def validate_claim(claim):
    for inv in claim.get('invoices') or []:
        for field, value in hard_values(claim, inv).items():
            key = row_key(claim, inv['id'], field)
            if (claim.get('answers') or {}).get(key) != value:
                raise ValueError(f"¥{float(inv.get('amount') or 0):.2f}：{field}应为「{value}」，请在清单核对手册规则冲突")


def review(owner, claim, form):
    import approval_files
    from feishu_purchase import build_form
    validate_claim(claim)
    build_form(form, claim)  # Unknown required fields/options fail closed here too. assert_row_in_group runs inside build_form.
    files = approval_files.resolve_invoices(owner, claim, verify_amounts=True)
    total = sum((Decimal(str(inv['amount'])) for inv in claim['invoices']), Decimal('0'))
    return {'ok': True, 'attachmentCount': len(files), 'amountVerifiedCount': len(claim['invoices']), 'verifiedTotal': f'{total:.2f}'}


def baseline_diff(baseline, final):
    before = baseline.get('answers') or {}
    after = final.get('answers') or {}
    keys = {'expenseType', 'payer', 'purpose'} | {k for k in before.keys() | after.keys() if k.startswith('expense:')}
    changes = [{'field': k, 'prefilled': before.get(k, ''), 'submitted': after.get(k, '')}
               for k in sorted(keys) if before.get(k, '') != after.get(k, '')]
    if baseline.get('selectedBudget') != final.get('selectedBudget'):
        changes.append({'field': 'selectedBudget', 'prefilled': baseline.get('selectedBudget'), 'submitted': final.get('selectedBudget')})
    for key in ('matchedBudget','relatedApproval','noBudgetReason'):
        if baseline.get(key) != final.get(key):
            changes.append({'field':key,'prefilled':baseline.get(key),'submitted':final.get(key)})
    old_rows = {i['id']: i for i in baseline.get('invoices', [])}
    for inv in final.get('invoices', []):
        old = old_rows.get(inv['id'], {})
        for key in ('amount', 'date', 'merchant', 'category', 'quantity', 'unit', 'note', 'invoiceNo', 'attachment'):
            if str(old.get(key, '')) != str(inv.get(key, '')):
                changes.append({'invoiceId': inv['id'], 'field': key, 'prefilled': old.get(key, ''), 'submitted': inv.get(key, '')})
    return changes


def recency_weight(occurred_at, now=None):
    """Half-life of 45 days so newer approved records outrank stale ones."""
    now = int(time.time() if now is None else now)
    try:
        stamp = int(occurred_at or 0)
    except (TypeError, ValueError):
        stamp = 0
    if stamp <= 0:
        return 0.25
    age_days = max(0.0, (now - stamp) / 86400)
    return 0.5 ** (age_days / 45.0)


def _sample_row(row):
    keys = row.keys() if hasattr(row, 'keys') else []
    occurred = row['occurred_at'] if 'occurred_at' in keys else 0
    source = row['source'] if 'source' in keys else 'self'
    return {'claim': json.loads(row['final'] if 'final' in keys else row[0]),
            'occurredAt': occurred or 0, 'source': source or 'self',
            'instanceCode': row['instance_code'] if 'instance_code' in keys else ''}


def verified_samples(owner=None):
    with data.database() as con:
        tables(con)
        if owner:
            rows = con.execute('SELECT final, occurred_at, source, instance_code FROM workflow_learning WHERE owner=? AND verified=1', (owner,)).fetchall()
        else:
            rows = con.execute('SELECT final, occurred_at, source, instance_code FROM workflow_learning WHERE verified=1').fetchall()
    return [_sample_row(r) for r in rows]


def verified_claims(owner):
    return [s['claim'] for s in verified_samples(owner)]


def _claim_of(sample):
    if isinstance(sample, dict) and isinstance(sample.get('claim'), dict):
        return sample['claim'], recency_weight(sample.get('occurredAt') or sample.get('occurred_at'))
    return sample, recency_weight(0)


def history_choices(owner, claim, inv, field, samples):
    typ = claim_type(claim)
    context = business_context(claim.get('purpose') or (claim.get('answers') or {}).get('purpose'))
    kind = content_class(inv)
    if not context or kind == 'other':
        return []
    weights = {}
    support = {}
    for sample in samples:
        body, weight = _claim_of(sample)
        if claim_type(body) != typ or business_context(body.get('purpose')) != context:
            continue
        votes = set()  # One approval is one supporting observation, even with 25 similar rows.
        for old in body.get('invoices', []):
            if content_class(old) != kind:
                continue
            value = (body.get('answers') or {}).get(row_key(body, old['id'], field))
            if value:
                votes.add(value)
        for value in votes:
            weights[value] = weights.get(value, 0.0) + weight
            support[value] = support.get(value, 0) + 1
    total = sum(weights.values())
    return [{'value': value, 'evidence': support[value], 'weight': round(weights[value], 4),
             'probability': round(weights[value] / total, 3),
             'source': '已通过的同用途同类费用报销（越新权重越高，含抄送我的成功单）'}
            for value in sorted(weights, key=lambda x: (-weights[x], x))]


def suggestions(owner, claim, schema):
    samples = verified_samples(owner)
    method = next((m for m in schema.get('methods') or [] if m['name'] == claim_type(claim)), {})
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
    method = next((m for m in schema.get('methods') or [] if m['name'] == claim_type(claim)), None)
    if not method:
        raise ValueError('请先选择费用类型')
    samples = verified_samples(owner)
    evidence = {}
    for inv in invoices:
        hard = hard_values(claim, inv)
        for w in method['fields']:
            name, options = w['name'], w.get('options') or []
            if not options:
                continue
            key = row_key(claim, inv['id'], name)
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
                                and (not rule.get('method') or rule['method'] == claim_type(claim))):
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
        if not previous or claim_type(json.loads(previous[0])) != claim_type(claim):
            con.execute('INSERT OR REPLACE INTO workflow_prefills VALUES(?,?,?)', (owner, draft_id, json.dumps(generated, ensure_ascii=False)))
    return {'answers': answers, 'evidence': evidence, 'rulesVersion': rules()['version']}


def capture_submission(owner, draft_id, final, receipt):
    if not receipt.get('ok') or not receipt.get('instanceCode'):
        return
    with data.database() as con:
        tables(con)
        row = con.execute('SELECT baseline FROM workflow_prefills WHERE owner=? AND draft_id=?', (owner, draft_id)).fetchone()
        baseline = json.loads(row[0]) if row else {}
        con.execute('INSERT OR IGNORE INTO workflow_learning(owner,instance_code,baseline,final,differences,verified,occurred_at,source) VALUES(?,?,?,?,?,0,?,?)',
                    (owner, receipt['instanceCode'], json.dumps(baseline, ensure_ascii=False), json.dumps(final, ensure_ascii=False),
                     json.dumps(baseline_diff(baseline, final), ensure_ascii=False), int(time.time()), 'self'))


def decode_claim(detail, schema):
    """Decode a 费用报销 instance only. Refuse purchase-application payloads."""
    code = detail.get('approval_code')
    if code and code != EXPENSE_CODE:
        raise ValueError('不能用费用报销解码器解读其他审批定义的样本')
    def value(w, options=()):
        v = w.get('value', '')
        if isinstance(v, dict):
            v = v.get('value', v.get('text', ''))
        if isinstance(v, list) and v and isinstance(v[0], dict):
            return v
        return next((o['text'] for o in options if v in (o['text'], o['value'])), v)
    top = widgets(detail)
    definitions = {w['id']: w for w in schema}
    named = {definitions.get(w.get('id'), {}).get('name', w.get('name')): w for w in top}
    defs_by_name = {w['name']: w for w in schema}
    typ = value(named.get('费用类型', {}), defs_by_name.get('费用类型', {}).get('option', []))
    payer = value(named.get('支出方', {}), defs_by_name.get('支出方', {}).get('option', []))
    purpose = value(named.get('报销事由', {}))
    answers = {'expenseType': typ, 'payer': payer, 'purpose': purpose}
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
                if name in ('名称',) and not isinstance(v, list):
                    if typ == '差旅费':
                        answers[row_key({'expenseType': typ, 'answers': answers}, inv['id'], '名称')] = v
                    else:
                        inv['merchant'] = v
                elif name in ('采购备注', '出差备注'):
                    inv['note'] = v
                elif name == '金额':
                    inv['amount'] = v
                elif name in ('日期', '日期（年-月-日）'):
                    inv['date'] = v
                elif name == '发票号码':
                    inv['invoiceNo'] = v
                elif name in ('明细采购类别', '费用类型') or d.get('type') == 'radioV2':
                    answers[f"expense:{typ}:{inv['id']}:{name}"] = v
            invoices.append(inv)
    return {'expenseType': typ, 'payer': payer, 'purpose': purpose, 'answers': answers, 'invoices': invoices}


def update_handbook(cc_error=None):
    """Rebuild aggregate evidence; never promote an individual claim to a hard rule.

    Promotion uses recency-weighted votes and ignores samples older than 180 days,
    so newer approvals outrank stale ones when rules change.
    """
    now = int(time.time())
    max_age = 180 * 86400
    with _lock:
        with data.database() as con:
            tables(con)
            rows = con.execute('SELECT final, occurred_at, source FROM workflow_learning WHERE verified=1').fetchall()
        counts = {}
        admitted = len(rows)
        for row in rows:
            claim = json.loads(row[0])
            occurred = int(row[1] or 0)
            if occurred and now - occurred > max_age:
                continue
            weight = recency_weight(occurred, now)
            typ = claim_type(claim)
            context = business_context(claim.get('purpose'))
            votes = set()
            for inv in claim.get('invoices', []):
                hard = hard_values(claim, inv)
                kind = content_class(inv)
                for key, value in (claim.get('answers') or {}).items():
                    if not key.startswith(f"expense:{typ}:{inv['id']}:"):
                        continue
                    field = key.split(':')[-1]
                    if field in hard and value != hard[field]:
                        continue
                    if typ == '差旅费':
                        continue  # Travel hard rules are never learned over.
                    role = data.role(field)
                    if role not in ('科目', '名称', '费用类型'):
                        continue
                    if context and kind != 'other':
                        votes.add((typ, context, kind, role, value))
            for vote in votes:
                counts[vote] = counts.get(vote, 0.0) + weight
        config = copy.deepcopy(rules())
        config['learned'] = []
        grouped = {}
        for (method, context, kind, field, value), n in counts.items():
            grouped.setdefault((method, context, kind, field), []).append((value, n))
        for key, options in grouped.items():
            method, context, kind, field = key
            options.sort(key=lambda item: -item[1])
            best, best_n = options[0]
            second_n = options[1][1] if len(options) > 1 else 0
            if best_n >= 3 and second_n < 1 and method != '差旅费':
                config['learned'].append(dict(method=method, context=context, kind=kind, field=field, value=best, support=round(best_n, 2)))
        text = handbook.read_handbook()
        replacement = '```baoxiao-prefill-rules\n' + json.dumps(config, ensure_ascii=False, indent=2) + '\n```'
        text = RULE_BLOCK.sub(lambda _: replacement, text, count=1)
        evidence = (f'已核验正样本 {admitted} 单（含本人提交与抄送本人且已通过的费用报销）；'
                    '手册升级与预填均按时间衰减计权重，超过 180 天的样本不参与规则升级，越新越高。'
                    '同一单多行不增加规则支持度。加权支持度至少 3 且无明显冲突，才升级为可复用建议；冲突会撤下建议，既有硬规则保持。'
                    '只学习费用报销定义、2026 年 11 月起且已通过的单据；采购申请不会混入。')
        if cc_error:
            evidence += f' 抄送列表读取失败，不能把抄送学习标记为已完成：{cc_error}'
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


def collected_user_ids(blob, keys=('user_id', 'open_id', 'userId', 'openId', 'id')):
    found = set()
    if isinstance(blob, str) and blob:
        found.add(blob)
    elif isinstance(blob, dict):
        for key in keys:
            if blob.get(key):
                found.add(str(blob[key]))
        for value in blob.values():
            if isinstance(value, (dict, list)):
                found.update(collected_user_ids(value, keys))
    elif isinstance(blob, list):
        for item in blob:
            found.update(collected_user_ids(item, keys))
    return found


def cc_user_ids(detail):
    ids = set()
    if not isinstance(detail, dict):
        return ids
    for key in ('cc_user_ids', 'cc_users', 'cc_user_id_list', 'start_cc_list', 'cc_list'):
        ids.update(collected_user_ids(detail.get(key)))
    for ev in detail.get('timeline') or []:
        typ = str((ev or {}).get('type') or (ev or {}).get('node_type') or '').upper()
        if typ in ('CC', 'CC_NODE', 'CARBON_COPY'):
            ids.update(collected_user_ids(ev))
    return ids


def instance_code_of(item):
    summary = item.get('instance') or item if isinstance(item, dict) else {}
    if not isinstance(summary, dict):
        return '', {}
    inst = summary.get('instance') if isinstance(summary.get('instance'), dict) else {}
    code = (summary.get('instance_code') or summary.get('instance_id') or inst.get('code')
            or inst.get('instance_code') or item.get('instance_code'))
    return str(code or ''), summary


def import_history(actor):
    """Learn from the user's own approved claims and from successful claims CC'd to them."""
    from feishu_purchase import definition
    token = auth.get_tenant_access_token()
    fetch = lambda code: auth.fetch_instance(token, code)
    ids = auth.logged_in_user_ids(actor)
    candidates = {}
    cc_error = None
    for item in auth.query_approved_instances(token, EXPENSE_CODE):
        code, summary = instance_code_of(item)
        start = summary.get('start_time') or summary.get('instance_start_time')
        if start and month(start) < '2026-11':
            continue
        initiator = summary.get('user_id') or summary.get('open_id')
        if initiator and initiator in ids:
            candidates[code] = {'source': 'self', 'start': start}
    try:
        for item in auth.query_cc_instances(token, EXPENSE_CODE, actor):
            code, summary = instance_code_of(item)
            start = summary.get('start_time') or summary.get('instance_start_time')
            if start and month(start) < '2026-11':
                continue
            if code and code not in candidates:
                candidates[code] = {'source': 'cc', 'start': start}
    except Exception as exc:
        cc_error = str(exc)[:200] or exc.__class__.__name__
    schema = None
    for code, meta in candidates.items():
        if not code:
            continue
        with data.database() as con:
            tables(con)
            if con.execute('SELECT 1 FROM workflow_learning WHERE owner=? AND instance_code=? AND verified=1', (actor['openId'], code)).fetchone():
                continue
        try:
            detail = fetch(code)
            if detail.get('approval_code') and detail.get('approval_code') != EXPENSE_CODE:
                continue
            initiator = detail.get('user_id') or detail.get('open_id') or detail.get('openId')
            if meta['source'] == 'self':
                visible = initiator in ids
            else:
                visible = bool(cc_user_ids(detail) & ids)
            admitted = visible and eligible(detail, fetch)
        except Exception:
            continue
        if not admitted:
            continue
        schema = schema or definition()
        claim = decode_claim(detail, schema)
        occurred = 0
        try:
            raw = detail.get('end_time') or detail.get('start_time') or meta.get('start')
            occurred = int(float(raw) / (1000 if float(raw) > 10**11 else 1))
        except (TypeError, ValueError, OverflowError):
            occurred = 0
        with data.database() as con:
            tables(con)
            con.execute('INSERT OR IGNORE INTO workflow_learning(owner,instance_code,baseline,final,differences,verified,occurred_at,source) VALUES(?,?,?,?,?,1,?,?)',
                        (actor['openId'], code, '{}', json.dumps(claim, ensure_ascii=False), '[]', occurred, meta['source']))
    sync_pending(actor['openId'], fetch)
    update_handbook(cc_error=cc_error)
    if cc_error:
        return {'ok': False, 'error': '抄送列表读取失败，已保留本人成功单的学习，但不能把抄送学习标记为已完成。', 'ccError': cc_error}
    return {'ok': True, 'ccError': None}


_last_import_result = {}


def last_import_result(owner):
    return _last_import_result.get(owner) or {}


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
                result = import_history(actor)
                _last_import[owner] = time.monotonic()
                _last_import_result[owner] = {**(result or {}), 'at': time.time()}
        except Exception as e:
            _last_import_result[owner] = {'ok': False, 'error': str(e) or '历史学习同步失败', 'ccError': str(e), 'at': time.time()}
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
