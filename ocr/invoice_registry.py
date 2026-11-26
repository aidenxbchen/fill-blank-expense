"""Application-tenant-wide invoice occupancy and successful OCR cache.

One deployment / Feishu tenant shares expense_data.DB_PATH. Originals remain owner
scoped; a cache is accessible only after resolving the caller's own original.
"""
import hashlib
import json
import threading
import time

import expense_data as data
from invoice_items import identity_keys


class DuplicateError(data.DataError):
    pass


_locks_guard = threading.Lock()
_locks = {}


def keys_for(con, owner, inv):
    keys = identity_keys(inv)
    ref = inv.get('attachment') or {}
    row = con.execute('SELECT sha256 FROM invoice_files WHERE owner=? AND file_id=?', (owner,ref.get('file_id'))).fetchone()
    if row:
        digest = row['sha256']; keys.append('sha:'+digest)
        cached = con.execute("SELECT result_json FROM invoice_reads WHERE sha256=? AND status='done'",(digest,)).fetchone()
        if cached: keys += identity_keys(json.loads(cached['result_json']))
    return list(dict.fromkeys(keys))


def bootstrap(con):
    if con.execute('SELECT 1 FROM invoice_registry_meta WHERE id=1').fetchone(): return
    # Index existing history first; never alter or delete legacy business records.
    rows = con.execute('SELECT owner,draft_id,request_id,project,snapshot_json FROM submission_history ORDER BY submitted_at').fetchall()
    for row in rows:
        claim=json.loads(row['snapshot_json']).get('claim') or {}
        for inv in claim.get('invoices') or []:
            insert_legacy(con,row['owner'],row['draft_id'] or 'submit_'+row['request_id'],inv,'submitted',row['project'])
    for row in con.execute("SELECT * FROM drafts WHERE status IN ('active','submitted') ORDER BY created_at").fetchall():
        state=json.loads(row['state_json']); project=context_label(state=state)
        for inv in state.get('invoices') or []: insert_legacy(con,row['owner'],row['id'],inv,row['status'],project)
    con.execute('INSERT INTO invoice_registry_meta VALUES(1)')


def context_label(claim=None, answers=None, state=None):
    claim = claim or {}
    state = state or {}
    answers = answers or claim.get('answers') or state.get('answers') or {}
    draft = state.get('draft') or {}
    return str(answers.get('purpose') or claim.get('purpose') or answers.get('expenseType') or claim.get('expenseType') or answers.get('costCenter') or claim.get('costCenter') or draft.get('costCenter') or '')


def insert_legacy(con,owner,draft_id,inv,phase,project):
    for key in keys_for(con,owner,inv):
        con.execute('INSERT OR IGNORE INTO invoice_uses VALUES(?,?,?,?,?,?,?,?)',
                    (key,owner,draft_id,str(inv.get('id') or ''),phase,project,str(inv.get('amount') or ''),int(time.time())))


def duplicate_message(row):
    # No foreign user, file, account, document ID or invoice number disclosure.
    label = ('【'+row['project']+'】') if row['project'] else '其他'
    amount = (' ¥'+row['amount']) if row['amount'] else ''
    return f'这张发票已在{label}{amount}的报销中使用（{"已提交/提交处理中" if row["phase"] != "active" else "进行中"}），请继续原报销或移除重复票'


def reserve_keys(con,owner,draft_id,invoice_id,keys,phase='active',project='',amount=''):
    if not project:
        context=con.execute("SELECT project FROM invoice_uses WHERE owner=? AND draft_id=? AND project!='' LIMIT 1",(owner,draft_id)).fetchone()
        if context: project=context['project']
    for key in keys:
        row=con.execute('SELECT * FROM invoice_uses WHERE invoice_key=?',(key,)).fetchone()
        if row and (row['owner'],row['draft_id'],row['invoice_id']) != (owner,draft_id,invoice_id):
            raise DuplicateError(duplicate_message(row))
        if row and row['phase'] != 'active' and phase=='active':
            raise DuplicateError('这张发票已提交或正在提交，请在原报销中查看结果')
    for key in keys:
        con.execute("INSERT INTO invoice_uses VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(invoice_key) DO UPDATE SET phase=excluded.phase,project=CASE WHEN excluded.project='' THEN invoice_uses.project ELSE excluded.project END,amount=CASE WHEN excluded.amount='' THEN invoice_uses.amount ELSE excluded.amount END,updated_at=excluded.updated_at",
                    (key,owner,draft_id,invoice_id,phase,project,str(amount),int(time.time())))


def sync_draft(con,owner,draft_id,invoices,phase='active',project=''):
    bootstrap(con)
    if phase=='active' and con.execute("SELECT 1 FROM invoice_uses WHERE owner=? AND draft_id=? AND phase!='active'",(owner,draft_id)).fetchone():
        raise DuplicateError('此报销已提交或提交处理中，请在原报销中核对结果')
    retained=set()
    for inv in invoices:
        invoice_id=str(inv.get('id') or '')
        for key in keys_for(con,owner,inv):
            if key in retained: raise DuplicateError('这份报销中包含相同发票，请移除重复票')
            retained.add(key)
        reserve_keys(con,owner,draft_id,invoice_id,keys_for(con,owner,inv),phase,project,inv.get('amount') or '')
    # Active removals release occupancy, successful/unknown submissions never do.
    for row in con.execute("SELECT invoice_key FROM invoice_uses WHERE owner=? AND draft_id=? AND phase='active'",(owner,draft_id)).fetchall():
        if row['invoice_key'] not in retained: con.execute('DELETE FROM invoice_uses WHERE invoice_key=?',(row['invoice_key'],))


def release_draft(con,owner,draft_id):
    bootstrap(con)
    if con.execute("SELECT 1 FROM invoice_uses WHERE owner=? AND draft_id=? AND phase!='active'",(owner,draft_id)).fetchone():
        raise DuplicateError('报销已提交或提交处理中，不能释放发票')
    con.execute("DELETE FROM invoice_uses WHERE owner=? AND draft_id=? AND phase='active'",(owner,draft_id))


def reserve_upload(owner,raw,mime,draft_id=None,invoice_id=None):
    if not owner or not raw or len(raw)>data.MAX_FILE_BYTES: raise data.DataError('请登录后上传不超过24MB的原件')
    if mime!='application/pdf' and not mime.startswith('image/'): raise data.DataError('只支持PDF或图片')
    if bool(draft_id)!=bool(invoice_id): raise data.DataError('草稿与发票行标识必须同时提供')
    digest=hashlib.sha256(raw).hexdigest(); keys=['sha:'+digest]
    # Native PDF text reveals a stable number without calling OCR or any LLM.
    if mime=='application/pdf':
        from invoice_extract import extract_pdf_text, extract_invoice_no
        from invoice_items import from_text
        try:
            text=extract_pdf_text(raw)
            keys+=identity_keys(dict(from_text(text),invoice_no=extract_invoice_no(text)))
        except Exception: pass
    with data.database() as con:
        con.execute('BEGIN IMMEDIATE');bootstrap(con)
        cached=con.execute("SELECT result_json FROM invoice_reads WHERE sha256=? AND status='done'",(digest,)).fetchone()
        if cached: keys+=identity_keys(json.loads(cached['result_json']))
        if draft_id and invoice_id:
            from expense_records import record_id
            record_id(draft_id);record_id(invoice_id)
            existing=con.execute('SELECT status FROM drafts WHERE owner=? AND id=?',(owner,draft_id)).fetchone()
            if existing and existing['status']!='active': raise DuplicateError('原报销已提交或删除，请新建报销')
            reserve_keys(con,owner,draft_id,invoice_id,keys)
        else:
            for key in keys:
                row=con.execute('SELECT * FROM invoice_uses WHERE invoice_key=?',(key,)).fetchone()
                if row: raise DuplicateError(duplicate_message(row))
    return digest


def parse_once(owner,attachment,parser,draft_id=None,invoice_id=None):
    if bool(draft_id)!=bool(invoice_id): raise data.DataError('草稿与发票行标识必须同时提供')
    if draft_id:
        from expense_records import record_id
        record_id(draft_id);record_id(invoice_id)
    original,raw=data.resolve_file(owner,attachment); digest=original['sha256']
    with _locks_guard: lock=_locks.setdefault(digest,threading.Lock())
    with lock:
        with data.database() as con:
            con.execute('BEGIN IMMEDIATE');bootstrap(con)
            use=con.execute('SELECT * FROM invoice_uses WHERE invoice_key=?',('sha:'+digest,)).fetchone()
            if use and (use['owner']!=owner or (draft_id and (use['draft_id'],use['invoice_id'])!=(draft_id,invoice_id))):
                raise DuplicateError(duplicate_message(use))
            row=con.execute('SELECT * FROM invoice_reads WHERE sha256=?',(digest,)).fetchone()
            if row and row['status']=='done': result=json.loads(row['result_json'])
            else:
                if row and row['status']=='reading' and time.time()-row['updated_at']<1200:
                    raise DuplicateError('这张发票正在识别，请稍后从原报销继续，勿重复上传')
                con.execute("INSERT INTO invoice_reads VALUES(?,'reading','',?) ON CONFLICT(sha256) DO UPDATE SET status='reading',updated_at=excluded.updated_at",(digest,int(time.time())))
                result=None
        cached=result is not None
        if result is None:
            try: result=dict(parser(raw,original['name'],original['mime'],owner=owner))
            except Exception:
                with data.database() as con: con.execute("UPDATE invoice_reads SET status='failed',updated_at=? WHERE sha256=?",(int(time.time()),digest))
                raise
            with data.database() as con:
                con.execute("UPDATE invoice_reads SET status='done',result_json=?,updated_at=? WHERE sha256=?",(json.dumps(result,ensure_ascii=False),int(time.time()),digest))
        # Cached fields are server facts; a caller cannot edit the dedupe identity away.
        with data.database() as con:
            con.execute('BEGIN IMMEDIATE');bootstrap(con)
            keys=['sha:'+digest]+identity_keys(result)
            if draft_id and invoice_id:
                existing=con.execute('SELECT status FROM drafts WHERE owner=? AND id=?',(owner,draft_id)).fetchone()
                if existing and existing['status']!='active': raise DuplicateError('原报销已提交或删除，不能重新识别')
                reserve_keys(con,owner,draft_id,invoice_id,keys,project='',amount=result.get('amount') or '')
            else:
                # Legacy retained-reference resumes can read their own cache; final
                # draft/save/submit still enforces the global occupancy ledger.
                for key in keys:
                    row=con.execute('SELECT * FROM invoice_uses WHERE invoice_key=?',(key,)).fetchone()
                    if row and row['owner']!=owner: raise DuplicateError(duplicate_message(row))
        return dict(result,ok=True,attachment=data.public_file(original),cached=cached)


def submission(owner,draft_id,invoices,project='',phase='pending',revision=None):
    with data.database() as con:
        con.execute('BEGIN IMMEDIATE')
        row=con.execute('SELECT status,revision FROM drafts WHERE owner=? AND id=?',(owner,draft_id)).fetchone()
        if row and (row['status']!='active' or (revision is not None and row['revision']!=revision)):
            raise DuplicateError('草稿已在其他页面更新、删除或提交，请重新打开核对')
        sync_draft(con,owner,draft_id,invoices,phase,project)


def reject_submission(owner,draft_id):
    with data.database() as con:
        con.execute("UPDATE invoice_uses SET phase='active' WHERE owner=? AND draft_id=? AND phase='pending'",(owner,draft_id))
