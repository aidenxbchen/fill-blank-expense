"""Owner-scoped drafts and immutable successful submission snapshots.

The duplicate-submission ledger stays separate; its durable history outbox repairs
history after a crash without ever initiating another approval.
"""
import json
import re
import time
from datetime import datetime
from decimal import Decimal

import expense_data as data
import invoice_registry as registry


class RecordError(ValueError):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def record_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value):
        raise RecordError('无效草稿编号')
    return value


def title_for(state):
    answers = state.get('answers') or {}
    first = next(iter(state.get('invoices') or []), {})
    title = answers.get('costCenter') or (state.get('draft') or {}).get('costCenter') or first.get('merchant') or first.get('fileName') or '未命名采购'
    return f'{str(title)[:100]} · {datetime.now():%Y-%m-%d}'


def clean_title(value):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 160:
        raise RecordError('草稿名称须为 1～160 个字')
    return value.strip()


def validate_state(owner, id, state):
    if not isinstance(state, dict) or state.get('draftId') != id:
        raise RecordError('草稿状态与编号不一致')
    if state.get('stage') not in ('upload', 'interview', 'draft', 'submit'):
        raise RecordError('无效填写步骤')
    if not isinstance(state.get('answers'), dict) or not isinstance(state.get('chat'), list):
        raise RecordError('无效问答状态')
    invoices = state.get('invoices')
    if not isinstance(invoices, list) or len(invoices) > 100 or any(not isinstance(i, dict) for i in invoices):
        raise RecordError('草稿最多保存 100 张发票')
    if state.get('draft') is not None and not isinstance(state['draft'], dict):
        raise RecordError('无效采购汇总')
    # Metadata is never accepted as ownership proof. Verify every retained file ID.
    with data.database() as con:
        for inv in invoices:
            ref = inv.get('attachment')
            if ref is not None:
                if not isinstance(ref, dict) or not con.execute('SELECT 1 FROM invoice_files WHERE owner=? AND file_id=?', (owner, ref.get('file_id'))).fetchone():
                    raise RecordError('发票原件不属于当前用户，请补传原件')
    raw = json.dumps(state, ensure_ascii=False, allow_nan=False)
    if len(raw.encode()) > 4 * 1024 * 1024:
        raise RecordError('草稿超过 4MB，请减少发票后重试', 413)
    return raw


def draft_view(row, detail=False):
    obj = dict(row)
    raw = obj.pop('state_json')
    state = json.loads(raw)
    invoices = state.get('invoices') or []
    obj.update(project=(state.get('answers') or {}).get('costCenter') or (state.get('draft') or {}).get('costCenter') or '',
               invoiceCount=len(invoices))
    if detail:
        obj['state'] = state
    obj.pop('owner', None)
    return obj


def get_draft(owner, id):
    record_id(id)
    with data.database() as con:
        row = con.execute("SELECT * FROM drafts WHERE owner=? AND id=? AND status='active'", (owner,id)).fetchone()
    if not row:
        raise RecordError('草稿不存在、已删除或已提交，请刷新我的报销',404)
    return draft_view(row, True)


def list_records(owner, kind, offset=0):
    with data.database() as con:
        if kind == 'drafts':
            rows = con.execute("SELECT * FROM drafts WHERE owner=? AND status='active' ORDER BY updated_at DESC,id LIMIT 31 OFFSET ?", (owner,offset)).fetchall()
            items = [draft_view(r) for r in rows[:30]]
        else:
            rows = con.execute('SELECT * FROM submission_history WHERE owner=? ORDER BY submitted_at DESC,instance_code LIMIT 31 OFFSET ?', (owner,offset)).fetchall()
            items = [history_view(r) for r in rows[:30]]
    return {'items':items, 'nextOffset':offset+30 if len(rows)>30 else None}


def save_draft(owner, id, body):
    record_id(id)
    revision = body.get('revision')
    if type(revision) is not int or revision < 0:
        raise RecordError('缺少草稿版本，请从我的报销重新打开')
    raw = validate_state(owner,id,body.get('state'))
    now = int(time.time())
    with data.database() as con:
        con.execute('BEGIN IMMEDIATE')
        row = con.execute('SELECT * FROM drafts WHERE owner=? AND id=?',(owner,id)).fetchone()
        if row and (row['status'] != 'active' or row['revision'] != revision):
            raise RecordError('草稿已在其他页面修改、删除或提交，请从我的报销重新打开；当前内容仍保留在本机',409)
        if not row and revision != 0:
            raise RecordError('草稿不存在，请从我的报销重新打开',404)
        title = clean_title(body['title']) if body.get('title') is not None else (row['title'] if row else title_for(body['state']))
        try:
            registry.sync_draft(con,owner,id,body['state']['invoices'],project=(body['state'].get('answers') or {}).get('costCenter') or '')
        except registry.DuplicateError as e: raise RecordError(str(e),409)
        if row:
            con.execute('UPDATE drafts SET state_json=?,stage=?,title=?,revision=revision+1,updated_at=? WHERE owner=? AND id=?',
                        (raw,body['state']['stage'],title,now,owner,id))
        else:
            con.execute('INSERT INTO drafts(owner,id,title,state_json,stage,revision,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)',
                        (owner,id,title,raw,body['state']['stage'],now,now))
        result = con.execute('SELECT * FROM drafts WHERE owner=? AND id=?',(owner,id)).fetchone()
    return draft_view(result)


def change_draft(owner,id,revision,title=None,delete=False):
    record_id(id)
    if type(revision) is not int:
        raise RecordError('缺少草稿版本')
    with data.database() as con:
        con.execute('BEGIN IMMEDIATE')
        row=con.execute("SELECT * FROM drafts WHERE owner=? AND id=? AND status='active'",(owner,id)).fetchone()
        if not row:
            raise RecordError('草稿不存在、已删除或已提交',404)
        if row['revision']!=revision:
            raise RecordError('草稿已在其他页面更新，请刷新后重试',409)
        if delete:
            try: registry.release_draft(con,owner,id)
            except registry.DuplicateError as e: raise RecordError(str(e),409)
            # Tombstone prevents late debounced saves resurrecting a deleted draft.
            con.execute("UPDATE drafts SET status='deleted',state_json='{}',revision=revision+1,updated_at=? WHERE owner=? AND id=?",(int(time.time()),owner,id))
        else:
            con.execute('UPDATE drafts SET title=?,revision=revision+1,updated_at=? WHERE owner=? AND id=?',(clean_title(title),int(time.time()),owner,id))
        result=con.execute('SELECT * FROM drafts WHERE owner=? AND id=?',(owner,id)).fetchone()
    return draft_view(result)


def history_view(row, detail=False):
    obj=dict(row)
    receipt=json.loads(obj.pop('receipt_json'))
    snapshot=obj.pop('snapshot_json')
    obj.pop('owner',None)
    obj['serialNumber']=receipt.get('serialNumber','')
    if detail:
        obj['receipt']=receipt
        obj['snapshot']=json.loads(snapshot)
    return obj


def get_history(owner, code):
    with data.database() as con:
        row=con.execute('SELECT * FROM submission_history WHERE owner=? AND instance_code=?',(owner,code)).fetchone()
    if not row:
        raise RecordError('提交记录不存在',404)
    return history_view(row,True)


def record_submission(owner, draft_id, claim, receipt, submitted_at=None):
    """Idempotent snapshot + draft transition in ONE transaction; success only."""
    if not receipt.get('ok') or not receipt.get('instanceCode'):
        raise RecordError('飞书尚未确认提交成功')
    invoices=claim['invoices']
    total=str(sum((Decimal(str(i['amount'])) for i in invoices),Decimal('0')).quantize(Decimal('.01')))
    now=submitted_at or int(time.time())
    with data.database() as con:
        con.execute('BEGIN IMMEDIATE')
        previous=con.execute('SELECT draft_id FROM submission_history WHERE owner=? AND request_id=?',(owner,receipt['requestId'])).fetchone()
        if previous:
            if previous['draft_id']!=draft_id: raise RecordError('这张发票已在其他报销中提交',409)
            return  # Successful snapshots and occupancy are immutable on replay.
        row=con.execute('SELECT * FROM drafts WHERE owner=? AND id=?',(owner,draft_id)).fetchone()
        state=json.loads(row['state_json']) if row and row['status']!='deleted' else None
        title=row['title'] if row else title_for({'answers':{'costCenter':claim.get('costCenter')},'invoices':invoices})
        snapshot={'claim':claim,'state':state,'attachmentNames':[i.get('attachment',{}).get('name') or i.get('fileName','') for i in invoices]}
        con.execute('INSERT OR IGNORE INTO submission_history VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                    (owner,receipt['instanceCode'],receipt['requestId'],draft_id,title,claim.get('costCenter') or '',total,
                     'submitted',now,receipt['approvalUrl'],json.dumps(receipt,ensure_ascii=False),json.dumps(snapshot,ensure_ascii=False)))
        registry.sync_draft(con,owner,draft_id or 'submit_'+receipt['requestId'],claim['invoices'],'submitted',claim.get('costCenter') or '')
        if row and row['status']=='active':
            con.execute("UPDATE drafts SET status='submitted',instance_code=?,revision=revision+1,updated_at=? WHERE owner=? AND id=?",
                        (receipt['instanceCode'],now,owner,draft_id))
