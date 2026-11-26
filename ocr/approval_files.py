"""Approval-native file codes for attachmentV2; creation still uses OAuth.

Official approval upload uses tenant_access_token. The v2 endpoint works with
existing approval read access; it does not change the approval initiator.
"""
from __future__ import annotations
import json
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor

import expense_data as data
import feishu_oauth as auth

UPLOAD_URL = 'https://www.feishu.cn/approval/openapi/v2/file/upload'


def upload_file(record, raw):
    boundary='baoxiao'+uuid.uuid4().hex
    chunks=[]
    for key,value in [('name',record['name']),('type','attachment')]:
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="content"; filename="{record["name"]}"\r\nContent-Type: {record["mime"]}\r\n\r\n'.encode())
    chunks.extend([raw,f'\r\n--{boundary}--\r\n'.encode()])
    req=urllib.request.Request(UPLOAD_URL,data=b''.join(chunks),method='POST',headers={
        'Authorization':'Bearer '+auth.get_tenant_access_token(),
        'Content-Type':'multipart/form-data; boundary='+boundary,
        'User-Agent':'fill-blank-expense/baoxiao'})
    try:
        with urllib.request.urlopen(req,timeout=60) as response:
            result=json.load(response)
    except urllib.error.HTTPError as e:
        try: result=json.loads(e.read())
        except (ValueError,UnicodeError): result={'error':f'飞书附件上传失败（HTTP {e.code}）'}
        err=auth.FeishuAPIError(e.code,result);err.identity='tenant';raise err from e
    except (urllib.error.URLError,TimeoutError,OSError,ValueError) as e:
        raise data.DataError('发票附件上传未完成，尚未发起审批，请检查网络后重试') from e
    code=(result.get('data') or {}).get('code')
    if result.get('code') != 0:
        err=auth.FeishuAPIError(400,result);err.identity='tenant';raise err
    if not isinstance(code,str) or not code:
        raise data.DataError('飞书没有返回有效附件 code，尚未发起审批，请稍后重试')
    return code


def resolve_invoices(owner, claim):
    """Require and hash-verify an owned original for every submitted invoice."""
    files=[];seen=set()
    for inv in claim['invoices']:
        record,raw=data.resolve_file(owner,inv.get('attachment'))
        # One file may legitimately be referenced more than once, attach it once.
        if record['file_id'] not in seen:
            files.append((record,None));seen.add(record['file_id'])
    if not files:raise data.DataError('必须附上发票原文件才能发起费用报销')
    return files


def file_codes(owner, files):
    def prepare(item):
        record,raw=item
        code=record.get('remote_code')
        if not code or record.get('remote_app_id') != auth.app_id() or time.time()-(record.get('uploaded_at') or 0)>3600:
            if raw is None:record,raw=data.resolve_file(owner,{'file_id':record['file_id']})
            code=upload_file(record,raw)
            data.cache_upload(record['file_id'],owner,auth.app_id(),code)
        return code
    if not files:return []
    with ThreadPoolExecutor(max_workers=min(4,len(files))) as pool:
        return list(pool.map(prepare,files))


def add_attachment(form, schema, codes):
    fields=[w for w in schema if w['type']=='attachmentV2' and w.get('visible',True)]
    if len(fields)!=1:raise data.DataError('费用报销的附件字段已变化，已停止提交，请联系管理员')
    form.append({'id':fields[0]['id'],'type':'attachmentV2','value':codes})
