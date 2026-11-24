"""Recurring internet expense planning. This release has NO live submission path.

Both switches are code-owned, not environment/request/database settings. A future
live release requires a separate review and the user's explicit confirmation in
this chat or their invoice-assistant chat. Email/agents/UI are not authorization.
"""
import copy
import hashlib
import json
import os
import re
import threading
import time
import uuid
from decimal import Decimal

import approval_files
import expense_data as data
import expense_records as records
import feishu_oauth as auth
import feishu_purchase as purchase
import filling_workflow as filling
import internet_mail
import invoice_registry as registry
from invoice_extract import parse_uploaded_invoice

FORCE_DRY_RUN = True
LIVE_RELEASE_ENABLED = False
EXPECTED_BUYER = '澜理商贸（珠海）有限公司'
TASK_ID = 'internet'
_worker = None


class TaskError(ValueError):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


class Paused(TaskError):
    pass


def tables(con):
    con.executescript('''
      CREATE TABLE IF NOT EXISTS internet_tasks (
        owner TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}',
        running TEXT, next_run INTEGER, last_run TEXT);
      CREATE TABLE IF NOT EXISTS internet_runs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL,
        started INTEGER NOT NULL, finished INTEGER, result TEXT NOT NULL DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS internet_run_owner ON internet_runs(owner,started DESC);
      CREATE TABLE IF NOT EXISTS internet_candidates (
        run_id TEXT NOT NULL, identity TEXT NOT NULL, owner TEXT NOT NULL,
        status TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(run_id,identity));
      CREATE INDEX IF NOT EXISTS internet_candidate_identity ON internet_candidates(identity,status);
      CREATE TABLE IF NOT EXISTS internet_leases (
        identity TEXT PRIMARY KEY, run_id TEXT NOT NULL, owner TEXT NOT NULL);
    ''')


def state_row(con, owner):
    con.execute('INSERT OR IGNORE INTO internet_tasks(owner) VALUES(?)', (owner,))
    return dict(con.execute('SELECT * FROM internet_tasks WHERE owner=?', (owner,)).fetchone())


def status(owner):
    with data.database() as con:
        tables(con)
        task = state_row(con, owner)
        runs = [dict(r) for r in con.execute('SELECT * FROM internet_runs WHERE owner=? ORDER BY started DESC,rowid DESC LIMIT 20', (owner,))]
    for r in runs:
        r.pop('owner')
        r['result'] = json.loads(r['result'])
    config = json.loads(task['config'])
    return {'ok':True, 'id':TASK_ID, 'name':'常规网费自动任务', 'enabled':bool(task['enabled']),
            'mode':'dry-run', 'dryRun':True, 'liveSubmissionEnabled':False,
            'schedulerRegistered':bool(_worker and _worker.is_alive()), 'expectedBuyer':EXPECTED_BUYER,
            'revision':task['revision'], 'running':task['running'], 'nextRun':task['next_run'],
            'config':config, 'runs':runs, 'missingConfig':missing_config(config)}


def missing_config(config):
    required = {'intervalSeconds':'扫描周期', 'templateDraftId':'已核对的报销配置草稿',
                'scanSince':'扫描起始时间（避免历史票）'}
    result = [label for key,label in required.items() if not config.get(key)]
    if config.get('emptyTaxIdAllowed') is None: result.append('购方税号为空的实际规则')
    if not config.get('expectedTaxId') and config.get('emptyTaxIdAllowed') is False:
        result.append('购方税号')
    return result


def update(owner, body):
    if not isinstance(body, dict) or set(body) - {'revision','enabled','config','dryRun'}:
        raise TaskError('任务请求含不受支持的配置；本版只允许预演')
    if body.get('dryRun', True) is not True:
        raise TaskError('本版强制 dry-run，用户确认前不能关闭或提交真实审批', 403)
    if 'enabled' in body and type(body['enabled']) is not bool:
        raise TaskError('启停状态必须是布尔值')
    supplied = body.get('config', {})
    allowed = {'intervalSeconds','templateDraftId','scanSince','emptyTaxIdAllowed','expectedTaxId','internetAccount'}
    if not isinstance(supplied, dict) or set(supplied) - allowed:
        raise TaskError('不支持的网费配置；不能配置审批人、部门或其他费用任务')
    for key in ('intervalSeconds','scanSince'):
        if key in supplied and supplied[key] is not None:
            value = supplied[key]
            if type(value) is not int or (key == 'intervalSeconds' and not 60 <= value <= 31*86400) or (key == 'scanSince' and not 0 < value <= int(time.time())):
                raise TaskError('周期须为 60 秒～31 天，扫描起始时间须为过去的秒级时间戳')
    if 'emptyTaxIdAllowed' in supplied and supplied['emptyTaxIdAllowed'] is not None and type(supplied['emptyTaxIdAllowed']) is not bool:
        raise TaskError('必须明确选择税号为空的实际规则')
    for key in ('expectedTaxId','internetAccount'):
        if key in supplied:
            if not isinstance(supplied[key], str) or len(supplied[key]) > 80:
                raise TaskError('网费账户或税号格式不正确')
            supplied[key] = supplied[key].strip()
    tax = supplied.get('expectedTaxId')
    if tax and not re.fullmatch(r'[A-Z0-9]{15,20}',tax): raise TaskError('购方税号格式不正确')
    if supplied.get('templateDraftId'):
        # Configuration reuses only the current owner's explicit draft selection.
        records.get_draft(owner, supplied['templateDraftId'])
    with data.database() as con:
        tables(con)
        con.execute('BEGIN IMMEDIATE')
        task = state_row(con, owner)
        if type(body.get('revision')) is not int or body['revision'] != task['revision']:
            raise TaskError('任务配置已变化，请刷新后重试',409)
        if task['running'] and supplied:
            raise TaskError('运行期间只能暂停，修改配置请等本轮结束',409)
        config = {**json.loads(task['config']), **supplied}
        enabled = body.get('enabled', bool(task['enabled']))
        if enabled and missing_config(config):
            raise TaskError('预演任务尚缺：' + '、'.join(missing_config(config)))
        con.execute('UPDATE internet_tasks SET enabled=?,config=?,revision=revision+1,next_run=? WHERE owner=?',
                    (enabled,json.dumps(config,ensure_ascii=False),int(time.time()) if enabled else None,owner))
    return status(owner)


def buyer_from_text(text):
    """Additional automation-only evidence, never edits the core OCR parser.

    Native PDF layout prints buyer and seller in two columns. Split the line at
    the second 名称/税号 label, so an empty buyer ID never borrows the seller ID.
    Unknown/ambiguous layouts fail closed.
    """
    names = [line for line in str(text).splitlines() if '名称' in line and ('买' in line or '购买方' in line)]
    if len(names) != 1: raise TaskError('无法唯一识别购买方原文，请人工核对')
    if len(re.findall(r'名称[：:]',names[0])) != 2 or not re.search(r'售|销',names[0]):
        raise TaskError('购销方版式未能分列确认，请人工核对')
    match = re.search(r'名称[：:]\s*(.+?)(?:\s{2,}|$)', names[0])
    if not match: raise TaskError('购买方名称未识别，请人工核对')
    name = match.group(1).strip()
    taxlines = [line for line in str(text).splitlines() if '纳税人识别号' in line]
    if not taxlines: raise TaskError('购买方税号区域未识别，不能视为空税号')
    line = taxlines[0]
    if len(re.findall(r'纳税人识别号[：:]',line)) != 2:
        raise TaskError('购买方税号区域未能与销售方分列确认，请人工核对')
    match = re.search(r'纳税人识别号[：:][^\S\n]*([A-Za-z0-9]*)',line)
    if not match: raise TaskError('购买方税号区域无法解析')
    return {'name':name, 'taxId':match.group(1).strip(), 'taxIdPresent':bool(match.group(1).strip())}


def internet_evidence(inv, config):
    items = inv.get('items') or []
    if not items or any(not isinstance(item,dict) for item in items):
        raise TaskError('缺少项目名称，无法确认仅为网费')
    labels = [str(item.get('name') or '') for item in items]
    raw = str(inv.get('raw') or '')
    account = re.search(r'(?:^|[;；\s])号码[：:]\s*([A-Za-z0-9_-]+)', raw, re.M)
    matched_account = bool(config.get('internetAccount') and account and account.group(1) == config['internetAccount'])
    # Generic communications service is not enough: it needs an explicitly
    # configured, confirmed internet account. Mixed invoices always stop.
    for label in labels:
        if re.search(r'网费|宽带|互联网接入|因特网',label): continue
        if '通信服务费' in label and matched_account: continue
        raise TaskError('项目未确认为网费，或混有其他费用；通信服务费须匹配已确认网费账户')
    if inv.get('needs_review') or inv.get('review_setup_needed') or inv.get('review_error'):
        raise TaskError('识别结果仍需核对，已阻止自动提交')
    if not inv.get('date') or not (inv.get('invoice_no') or inv.get('invoiceNo')):
        raise TaskError('发票日期或号码未识别，已阻止自动提交')
    purchase.number(inv.get('amount'), '发票金额', money=True)
    return '、'.join(labels)


def check_buyer(inv, config):
    buyer = buyer_from_text(inv.get('raw'))
    if data.normalized(buyer['name']) != data.normalized(EXPECTED_BUYER):
        raise TaskError('购方与常规网费预期公司不符，已阻止自动提交')
    if not buyer['taxId']:
        if config.get('emptyTaxIdAllowed') is not True:
            raise TaskError('购方匹配；税号为空，缺少允许空税号的实际规则，已阻止自动提交')
    elif not config.get('expectedTaxId') or buyer['taxId'] != config['expectedTaxId']:
        raise TaskError('购方税号异常或未配置，已阻止自动提交')
    return buyer


def template_claim(owner, config, inv, draft_id):
    record = records.get_draft(owner, config['templateDraftId'])
    state = record['state']
    answers = copy.deepcopy(state.get('answers') or {})
    draft = state.get('draft') or {}
    method = draft.get('purchaseMethod') or answers.get('purchaseMethod')
    # Template must contain one row: never arbitrarily choose among multiple rows.
    rows = state.get('invoices') or []
    if len(rows) != 1: raise TaskError('网费配置草稿须有且仅有一个已核对的网费模板行')
    prefix = f"purchase:{method}:{rows[0]['id']}:"
    common = {k:v for k,v in answers.items() if not k.startswith('purchase:') or ':shared:' in k}
    common.update({f"purchase:{method}:{inv['id']}:"+k[len(prefix):]:v for k,v in answers.items() if k.startswith(prefix)})
    claim = {'purchaseMethod':method, 'costCenter':draft.get('costCenter') or answers.get('costCenter'),
             'purpose':draft.get('purpose') or answers.get('purpose'), 'answers':common,
             'selectedBudget':copy.deepcopy(answers.get('selectedBudget') or state.get('selectedBudget') or draft.get('selectedBudget')),
             'invoices':[inv]}
    generated = filling.prefill(owner, draft_id, claim, purchase.public_schema(purchase.definition()))
    # Unreviewed learned suggestions must not silently become automatic answers.
    for key,evidence in generated['evidence'].items():
        if key not in common and not evidence['hard'] and generated['answers'].get(key):
            raise TaskError('预填含待核对建议，请先在配置草稿明确填写该字段')
    claim['answers'] = generated['answers']
    return claim


def preview(owner, sess, config, inv, draft_id, check_active):
    buyer = check_buyer(inv,config)
    claim = template_claim(owner, config, inv, draft_id)
    schema = purchase.definition()
    filling.review(owner,claim,schema)
    actor = auth.fetch_user_info(sess['access_token'])
    if not actor.get('openId') or actor['openId'] != owner:
        raise TaskError('OAuth 用户身份不匹配，已停止',403)
    if claim['purchaseMethod'] != '预付款项':
        purchase.validate_relation(claim,actor,auth.get_tenant_access_token())
    files = approval_files.resolve_invoices(owner,claim)
    form = purchase.build_form(schema,claim)
    # Placeholder is visibly symbolic; never upload a file during a preview.
    approval_files.add_attachment(form,schema,['DRY_RUN_OWNED_ORIGINAL'])
    display = []
    def describe(control, definitions):
        widget = next(w for w in definitions if w['id'] == control['id'])
        value = control['value']
        if widget['type'] == 'fieldList':
            for row in value:
                for cell in row: describe(cell,widget['children'])
            return
        if widget['type'] == 'radioV2':
            value = next(o['text'] for o in widget['option'] if o['value'] == value)
        if widget['type'] == 'connect':
            budget = claim.get('selectedBudget') or {}
            value = budget.get('title') or budget.get('name') or '配置草稿中的关联审批（已核验通过状态与可用范围）'
        if widget['type'] == 'attachmentV2': value = f'{len(files)} 份原件（仅本地校验）'
        display.append({'name':widget['name'],'value':str(value)})
    for control in form: describe(control,schema)
    check_active()
    return {'dryRun':True, 'wouldSubmit':True, 'realSubmission':False,
            'message':'若完成启用条件并经用户确认，将通过现有 OAuth 审批与官方附件上传链路提交；本次仅预演',
            'buyer':buyer, 'claim':claim, 'form':form, 'displayForm':display, 'attachmentCount':len(files),
            'approvalCode':purchase.APPROVAL_CODE, 'blockers':['本版强制预演','尚未获得用户首次真实提交确认']}


def lease(owner, run_id, keys):
    # Tenant-wide compare-and-set across processes and OAuth owners. No expiry
    # that could let a slow or unknown run be retried concurrently.
    with data.database() as con:
        con.execute('BEGIN IMMEDIATE')
        for key in keys:
            row = con.execute('SELECT run_id FROM internet_leases WHERE identity=?',(key,)).fetchone()
            if row and row['run_id'] != run_id: return False
        for key in keys:
            con.execute('INSERT OR IGNORE INTO internet_leases VALUES(?,?,?)',(key,run_id,owner))
    return True


def run(sess, *, scheduled=False, source=None, parser=None):
    owner = (sess.get('user') or {}).get('openId')
    if not owner: raise TaskError('请先用飞书登录',401)
    # Safe under every switch permutation: this release deliberately has no live adapter.
    if not FORCE_DRY_RUN or LIVE_RELEASE_ENABLED:
        raise TaskError('自动提交发布锁异常；本版不支持真实审批',403)
    now = int(time.time())
    run_id = uuid.uuid4().hex
    with data.database() as con:
        tables(con)
        con.execute('BEGIN IMMEDIATE')
        task = state_row(con,owner)
        if not task['enabled']: raise Paused('任务已暂停；扫描、回调与预演均停止',409)
        if task['running']: raise TaskError('任务正在运行或上次进程中断，请先核对运行记录',409)
        if scheduled and task['next_run'] and task['next_run'] > now: return {'ok':True,'notDue':True,'dryRun':True}
        config = json.loads(task['config'])
        if missing_config(config): raise TaskError('配置不完整：'+'、'.join(missing_config(config)))
        revision = task['revision']
        con.execute("INSERT INTO internet_runs(id,owner,status,started) VALUES(?,?,'running',?)",(run_id,owner,now))
        con.execute('UPDATE internet_tasks SET running=?,last_run=?,next_run=? WHERE owner=?',
                    (run_id,run_id,now+config['intervalSeconds'],owner))

    def active():
        with data.database() as con:
            current = con.execute('SELECT enabled,revision,running FROM internet_tasks WHERE owner=?',(owner,)).fetchone()
        if not current or not current['enabled'] or current['revision'] != revision or current['running'] != run_id:
            raise Paused('任务已暂停或配置发生变化，本轮停止',409)

    result = {'ok':True,'runId':run_id,'dryRun':True,'realApprovalsCreated':0,'items':[]}
    final = 'previewed'
    try:
        scan = source or internet_mail.attachments
        parse = parser or parse_uploaded_invoice
        # Never advance scanSince automatically on partial/error scans; dedupe handles overlaps.
        for attachment in scan(sess,config['scanSince'],now,active):
            active()
            digest = hashlib.sha256(attachment['raw']).hexdigest()
            ident = 'sha:'+digest
            item = {'label':'待识别项目 + 待核对金额'}
            try:
                # Check normal manual/submitted occupancy BEFORE saving or parsing originals.
                registry.reserve_upload(owner,attachment['raw'],attachment['mime'])
                if not lease(owner,run_id,[ident]):
                    item.update(status='duplicate',message='相同原件已预演或正在处理，请查看原运行记录')
                    result['items'].append(item)
                    continue
                with data.database() as con:
                    previous = con.execute("SELECT owner,result FROM internet_candidates WHERE identity=? AND status='previewed' ORDER BY rowid DESC LIMIT 1",(ident,)).fetchone()
                if previous:
                    item.update(status='duplicate',message='相同原件已预演，请查看原运行记录')
                else:
                    ref = data.save_file(owner,attachment['raw'],attachment['name'],attachment['mime'])
                    inv = registry.parse_once(owner,ref,parse)
                    active()
                    inv = {**inv,'id':'internet_invoice','attachment':ref,'source':'mail',
                           'invoiceNo':inv.get('invoice_no') or inv.get('invoiceNo')}
                    label = internet_evidence(inv,config)
                    item['label'] = f"{label} + ¥{Decimal(str(inv['amount'])):.2f}"
                    check_buyer(inv,config)
                    # Stable invoice identity stops a renamed or re-encoded duplicate too.
                    with data.database() as con:
                        keys = registry.keys_for(con,owner,inv)
                        marks = ','.join('?' for _ in keys)
                        duplicates = con.execute(f"SELECT 1 FROM internet_candidates WHERE identity IN ({marks}) AND status='previewed' LIMIT 1",keys).fetchone()
                        registry.bootstrap(con)
                        for key in keys:
                            if con.execute('SELECT 1 FROM invoice_uses WHERE invoice_key=?',(key,)).fetchone():
                                raise registry.DuplicateError('发票已在报销中占用或提交，请核对原报销')
                    if duplicates or not lease(owner,run_id,keys):
                        item.update(status='duplicate',message='相同发票已预演，请查看原运行记录')
                    else:
                        plan = preview(owner,sess,config,inv,'internet_'+run_id,active)
                        active()
                        item.update(status='previewed',preview=plan)
                        with data.database() as con:
                            con.execute('BEGIN IMMEDIATE')
                            current = con.execute('SELECT enabled,revision FROM internet_tasks WHERE owner=?',(owner,)).fetchone()
                            if not current['enabled'] or current['revision'] != revision: raise Paused('任务已暂停，本轮停止',409)
                            for key in keys:
                                con.execute('INSERT INTO internet_candidates VALUES(?,?,?,?,?)',(run_id,key,owner,'previewed',json.dumps(item,ensure_ascii=False)))
            except Paused: raise
            except (ValueError, auth.FeishuAPIError) as exc:
                # Do not persist upstream response/token/mail content in task logs.
                item.update(status='blocked',message=str(exc)[:500] if isinstance(exc,ValueError) else '飞书读取或权限校验失败，请检查邮箱、预算权限与 OAuth 登录')
                final = 'blocked'
            except Exception:
                item.update(status='failed',message='识别或原件处理失败，请核对服务后重试；尚未提交审批')
                final = 'failed'
            result['items'].append(item)
            if item['status'] in ('blocked','failed'):
                with data.database() as con:
                    con.execute('INSERT OR REPLACE INTO internet_candidates VALUES(?,?,?,?,?)',(run_id,ident,owner,item['status'],json.dumps(item,ensure_ascii=False)))
                    con.execute('DELETE FROM internet_leases WHERE run_id=? AND identity NOT IN (SELECT identity FROM internet_candidates WHERE run_id=? AND status=?)',(run_id,run_id,'previewed'))
        active()
        if not result['items']: final = 'empty'
        elif all(i['status']=='duplicate' for i in result['items']): final = 'duplicate'
    except Paused as exc:
        final = 'paused'; result['message'] = str(exc)
    except Exception:
        final = 'failed'; result['message'] = '邮箱扫描失败；请核对读取权限、下载域名及连接。未提交审批，可重试。'
    result['status'] = final
    with data.database() as con:
        con.execute('UPDATE internet_runs SET status=?,finished=?,result=? WHERE id=?',(final,int(time.time()),json.dumps(result,ensure_ascii=False),run_id))
        con.execute('UPDATE internet_tasks SET running=NULL WHERE owner=? AND running=?',(owner,run_id))
        con.execute("DELETE FROM internet_leases WHERE run_id=? AND identity NOT IN (SELECT identity FROM internet_candidates WHERE run_id=? AND status='previewed')",(run_id,run_id))
    return result


def recover_interrupted(owner, revision):
    """A paused run may be abandoned after a process crash; never retry create."""
    with data.database() as con:
        tables(con); con.execute('BEGIN IMMEDIATE')
        task = state_row(con,owner)
        if task['enabled'] or task['revision'] != revision:
            raise TaskError('请先暂停并刷新任务，再清理中断运行',409)
        if task['running']:
            con.execute("DELETE FROM internet_leases WHERE run_id=? AND identity NOT IN (SELECT identity FROM internet_candidates WHERE run_id=? AND status='previewed')",(task['running'],task['running']))
            con.execute("UPDATE internet_runs SET status='interrupted',finished=?,result=? WHERE id=? AND owner=?",
                        (int(time.time()),json.dumps({'dryRun':True,'realApprovalsCreated':0,'message':'暂停后已清理中断运行；没有真实提交'}),task['running'],owner))
            con.execute('UPDATE internet_tasks SET running=NULL,revision=revision+1 WHERE owner=?',(owner,))
    return status(owner)


def tick(sess):
    """Same gate for scheduler/callback integrations; no separate submission path."""
    return run(sess,scheduled=True)


def record_missing_session(owner):
    now = int(time.time())
    with data.database() as con:
        tables(con); con.execute('BEGIN IMMEDIATE')
        task = state_row(con,owner)
        if not task['enabled'] or task['running'] or (task['next_run'] or 0) > now: return
        run_id = uuid.uuid4().hex
        result = {'dryRun':True,'realApprovalsCreated':0,'items':[],
                  'message':'当前用户的 OAuth 会话不存在，请重新登录；未扫描邮箱或发起审批'}
        con.execute('INSERT INTO internet_runs VALUES(?,?,?,?,?,?)',
                    (run_id,owner,'blocked',now,now,json.dumps(result,ensure_ascii=False)))
        config = json.loads(task['config'])
        con.execute('UPDATE internet_tasks SET last_run=?,next_run=? WHERE owner=?',
                    (run_id,now+config['intervalSeconds'],owner))


def start_worker():
    """Optional DRY-RUN worker. Default: no thread, no timer, no registration.

    This switch cannot enable real approvals. It is intentionally not set by the
    task UI or saved config, and is not enabled in this change.
    """
    global _worker
    if os.environ.get('BAOXIAO_INTERNET_DRY_RUN_SCHEDULER') != '1': return False
    if not FORCE_DRY_RUN or LIVE_RELEASE_ENABLED: return False
    if _worker and _worker.is_alive(): return True
    def work():
        while True:
            try:
                with data.database() as con:
                    tables(con)
                    due = {r['owner'] for r in con.execute('SELECT owner FROM internet_tasks WHERE enabled=1 AND running IS NULL AND next_run<=?',(int(time.time()),))}
                # Reuse existing stored OAuth sessions; no tenant impersonation.
                with auth._lock:
                    sessions = auth._read_sessions()
                seen = set()
                for sid,sess in sessions.items():
                    owner = (sess.get('user') or {}).get('openId')
                    if owner not in due or owner in seen: continue
                    seen.add(owner)
                    try:
                        # Refresh inside the run's scan boundary, so failure is logged.
                        def source(old,since,until,active):
                            refreshed = auth.ensure_fresh_session(sid,old)
                            old.update(refreshed)
                            yield from internet_mail.attachments(old,since,until,active)
                        run(sess,scheduled=True,source=source)
                    except TaskError:
                        pass  # paused/concurrent update; all started runs persist results
                for owner in due - seen:
                    record_missing_session(owner)
            except Exception:
                pass  # no fallback to submit, and no server startup failure
            time.sleep(30)
    _worker = threading.Thread(target=work,name='internet-dry-run-only',daemon=True)
    _worker.start()
    return True
