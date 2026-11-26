"""Handoff of telecom invoices to 李颖华 via Feishu IM.

Month is taken from the invoice (billing period first, then invoice date).
The send adapter is complete, but FORCE / LIVE flags keep this branch dry-run
until the user explicitly allows a real send. Recipient open_id is read from
BAOXIAO_HANDOFF_OPEN_ID or a gitignored local file, never from tracked config.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

CONFIG_PATH = Path(__file__).resolve().parent / 'internet_handoff.json'
LOCAL_PATH = Path(__file__).resolve().parent / 'internet_handoff.local.json'
LIVE_SEND_ENABLED = False
IM_SEND_URL = 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id'
IM_FILE_URL = 'https://open.feishu.cn/open-apis/im/v1/files'
SHANGHAI = ZoneInfo('Asia/Shanghai')
# 计费周期:202610 / 2026-10 / 2026年10月 / 2026/10
BILLING_PERIOD = re.compile(
    r'计费周期[:：\s]*((?:20\d{2})(?:[-./年]?(?:1[0-2]|0[1-9]|[1-9]))?(?:\s*月)?)',
    re.I,
)
YEAR_MONTH = re.compile(r'(20\d{2})\s*[-./年]?\s*(1[0-2]|0[1-9]|[1-9])')
COMPACT = re.compile(r'(20\d{2})(0[1-9]|1[0-2])')


class HandoffError(ValueError):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def _secret_open_id():
    env = str(os.environ.get('BAOXIAO_HANDOFF_OPEN_ID') or '').strip()
    if env:
        return env
    if LOCAL_PATH.is_file():
        try:
            data = json.loads(LOCAL_PATH.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            data = {}
        return str(data.get('openId') or '').strip()
    return ''


def load_recipient():
    if not CONFIG_PATH.is_file():
        raise HandoffError('未找到网费转交联系人配置，请先用飞书通讯录核对李颖华')
    data = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
    name = str(data.get('recipientName') or '').strip()
    honorific = str(data.get('messageHonorific') or '颖华').strip() or '颖华'
    open_id = _secret_open_id()
    if name != '李颖华' or not re.fullmatch(r'ou_[A-Za-z0-9]{8,}', open_id):
        raise HandoffError('未配置转交联系人密钥。请设置环境变量或本地密钥文件后重试（界面只显示姓名）')
    return {'name': name, 'openId': open_id, 'honorific': honorific}


def public_recipient():
    rec = load_recipient()
    return {'name': rec['name'], 'honorific': rec['honorific']}


def _format_month(year, month):
    return f'{int(year)}年{int(month)}月'


def _parse_year_month(text):
    cleaned = re.sub(r'\s+', '', str(text or ''))
    compact = COMPACT.search(cleaned)
    if compact:
        return _format_month(compact.group(1), compact.group(2))
    match = YEAR_MONTH.search(str(text or ''))
    if match:
        return _format_month(match.group(1), match.group(2))
    return ''


def invoice_month(inv):
    """Return (label, source). Prefer billing period, then invoice date. Never guess."""
    chunks = [str(inv.get(k) or '') for k in ('raw', 'text', 'note', 'merchant')]
    for row in inv.get('items') or []:
        if isinstance(row, dict):
            chunks.extend(str(row.get(k) or '') for k in ('name', 'note', 'desc'))
    blob = '\n'.join(chunks)
    billing = BILLING_PERIOD.search(blob)
    if billing:
        label = _parse_year_month(billing.group(1))
        if label:
            return label, '计费周期'
    for key in ('date', 'invoice_date', 'invoiceDate', 'issuedAt', '开票日期'):
        value = inv.get(key)
        if not value:
            continue
        label = _parse_year_month(value)
        if label:
            return label, '开票日期'
        try:
            stamp = float(value)
            if stamp > 10**11:
                stamp /= 1000
            dt = datetime.fromtimestamp(stamp, SHANGHAI)
            return _format_month(dt.year, dt.month), '开票日期'
        except (TypeError, ValueError, OverflowError, OSError):
            continue
    # Bare date strings like 2026年11月20日 already handled by YEAR_MONTH on date field
    # and on raw text as a fallback only when no billing period exists.
    fallback = YEAR_MONTH.search(blob)
    if fallback:
        return _format_month(fallback.group(1), fallback.group(2)), '开票日期'
    raise HandoffError('发票上没有可用的计费周期或开票月份，不能编造月份后发给李颖华')


def message_for(inv, recipient=None):
    recipient = recipient or load_recipient()
    month, source = invoice_month(inv)
    text = f"{recipient['honorific']}，这是{month}的电信网络发票，由我垫付，请完成报销。"
    return {'text': text, 'month': month, 'monthSource': source}


def preview(inv, attachment=None):
    recipient = load_recipient()
    built = message_for(inv, recipient)
    name = (attachment or {}).get('name') or (inv.get('attachment') or {}).get('name') or inv.get('fileName') or '电信网络发票.pdf'
    return {
        'dryRun': True,
        'wouldSubmit': False,
        'wouldSend': True,
        'realSend': False,
        'realSubmission': False,
        'recipientName': recipient['name'],
        'message': built['text'],
        'month': built['month'],
        'monthSource': built['monthSource'],
        'attachments': [{'name': name}],
        'adapter': 'feishu-im',
        'blockers': ['发送适配器已就绪，本版仍强制 dry-run，不会实际发送飞书消息，也不会发起审批'],
    }


def build_transport(plan):
    # Never echo the open_id in previews, API payloads, or logs.
    return {
        'channel': 'im',
        'msgType': 'file+text',
        'receiveName': plan['recipientName'],
        'text': plan['message'],
        'files': [item['name'] for item in plan['attachments']],
    }


def im_file_type(name, mime=''):
    ext = Path(str(name or '')).suffix.lower()
    mime = str(mime or '').lower()
    if ext == '.pdf' or 'pdf' in mime:
        return 'pdf'
    if ext in ('.doc', '.docx') or 'msword' in mime or 'wordprocessingml' in mime:
        return 'doc'
    if ext in ('.xls', '.xlsx') or 'excel' in mime or 'spreadsheetml' in mime:
        return 'xls'
    if ext in ('.ppt', '.pptx') or 'powerpoint' in mime or 'presentationml' in mime:
        return 'ppt'
    if ext in ('.mp4',) or mime.startswith('video/'):
        return 'mp4'
    if ext in ('.opus',) or 'opus' in mime:
        return 'opus'
    return 'stream'


def resolve_attachment(attachment=None, raw=None, inv=None, owner=None):
    """Require real invoice bytes. Never pretend a name-only payload is an attachment."""
    att = attachment if isinstance(attachment, dict) else {}
    inv = inv if isinstance(inv, dict) else {}
    inv_att = inv.get('attachment') if isinstance(inv.get('attachment'), dict) else {}
    data = raw if isinstance(raw, (bytes, bytearray)) else att.get('raw') or inv_att.get('raw')
    name = att.get('name') or inv_att.get('name') or inv.get('fileName') or '电信网络发票.pdf'
    mime = att.get('mime') or att.get('contentType') or inv_att.get('mime') or 'application/pdf'
    if not data:
        file_id = att.get('file_id') or att.get('fileId') or inv_att.get('file_id') or inv_att.get('fileId')
        if file_id and owner:
            import expense_data as expense_data
            record, data = expense_data.resolve_file(owner, {**inv_att, **att, 'file_id': file_id})
            name = record.get('name') or name
            mime = record.get('mime') or mime
    if not isinstance(data, (bytes, bytearray)) or not data:
        raise HandoffError('网费转交缺少发票附件，不能只发送文字', 422)
    return {
        'name': str(name or '电信网络发票.pdf'),
        'mime': str(mime or 'application/pdf'),
        'raw': bytes(data),
        'size': len(data),
        'sha256': hashlib.sha256(bytes(data)).hexdigest(),
        'fileType': im_file_type(name, mime),
    }


def build_im_file_form(file):
    """Construct the multipart body that /im/v1/files expects. Used by rehearsal and live upload."""
    boundary = 'baoxiao' + uuid.uuid4().hex
    chunks = []
    for key, value in (('file_type', file['fileType']), ('file_name', file['name'])):
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    chunks.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{file["name"]}"\r\nContent-Type: {file["mime"]}\r\n\r\n'.encode()
    )
    chunks.extend([file['raw'], f'\r\n--{boundary}--\r\n'.encode()])
    body = b''.join(chunks)
    return {
        'url': IM_FILE_URL,
        'headers': {'Content-Type': 'multipart/form-data; boundary=' + boundary, 'User-Agent': 'fill-blank-expense/baoxiao'},
        'body': body,
    }


def rehearse_upload(file):
    form = build_im_file_form(file)
    return {
        'wouldUpload': True,
        'url': IM_FILE_URL,
        'fileType': file['fileType'],
        'fileName': file['name'],
        'mime': file['mime'],
        'size': file['size'],
        'sha256': file['sha256'],
        'formBytes': len(form['body']),
    }


def upload_im_file(token, file):
    form = build_im_file_form(file)
    req = urllib.request.Request(form['url'], data=form['body'], method='POST', headers={
        **form['headers'],
        'Authorization': 'Bearer ' + token,
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            result = json.load(response)
    except urllib.error.HTTPError as e:
        try:
            result = json.loads(e.read())
        except (ValueError, UnicodeError):
            result = {'error': f'飞书附件上传失败（HTTP {e.code}）'}
        raise HandoffError('飞书附件上传失败，未发送文字或文件，也未提交审批', 502) from e
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        raise HandoffError('飞书附件上传未完成，未发送文字或文件，也未提交审批', 502) from e
    key = (result.get('data') or {}).get('file_key')
    if result.get('code') not in (0, None) or not isinstance(key, str) or not key:
        raise HandoffError('飞书没有返回有效文件 file_key，未发送文字或文件，也未提交审批', 502)
    return key


def send_handoff(token, recipient, message, attachment=None, raw=None, inv=None, owner=None):
    """Upload the invoice to IM, then send text + file. Missing bytes fail before any message."""
    if not token:
        raise HandoffError('真实发送需要登录令牌', 401)
    file = resolve_attachment(attachment, raw, inv, owner)
    file_key = upload_im_file(token, file)
    import feishu_oauth as auth
    text = auth.http_json('POST', IM_SEND_URL, token=token, payload={
        'receive_id': recipient['openId'],
        'msg_type': 'text',
        'content': json.dumps({'text': message}, ensure_ascii=False),
    })
    if text.get('code') not in (0, None):
        raise HandoffError('飞书文本消息发送失败；附件已上传但未作为消息发出，也未提交审批', 502)
    file_msg = auth.http_json('POST', IM_SEND_URL, token=token, payload={
        'receive_id': recipient['openId'],
        'msg_type': 'file',
        'content': json.dumps({'file_key': file_key}, ensure_ascii=False),
    })
    if file_msg.get('code') not in (0, None):
        raise HandoffError('飞书文件消息发送失败；请在会话中核对是否只收到文字，也未提交审批', 502)
    return {
        'text': True,
        'file': True,
        'fileName': file['name'],
        'size': file['size'],
        'sha256': file['sha256'],
        'fileType': file['fileType'],
    }


def deliver(inv, attachment=None, *, dry_run=True, live_enabled=False, token=None, raw=None, owner=None):
    file = resolve_attachment(attachment, raw, inv, owner)
    plan = preview(inv, {**(attachment or {}), 'name': file['name']})
    plan['adapter'] = 'feishu-im'
    rehearsal = rehearse_upload(file)
    plan['attachments'] = [{'name': file['name'], 'size': file['size'], 'sha256': file['sha256'], 'mime': file['mime']}]
    plan['uploadRehearsal'] = rehearsal
    plan['transport'] = build_transport(plan)
    plan['transport']['files'] = [rehearsal]
    gated = dry_run or not live_enabled or not LIVE_SEND_ENABLED
    if gated:
        plan['sent'] = False
        plan['realSend'] = False
        return plan
    if not token:
        raise HandoffError('真实发送需要登录令牌', 401)
    send_handoff(token, load_recipient(), plan['message'], attachment, raw, inv, owner)
    plan['sent'] = True
    plan['realSend'] = True
    plan['dryRun'] = False
    return plan
