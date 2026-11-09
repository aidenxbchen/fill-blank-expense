"""Local invoice originals and user-confirmed filling observations (SQLite).

No OAuth secrets are stored here. Drafts may contain user-entered payment details. Opaque file IDs are scoped to
OAuth open_id; filenames/paths supplied by clients are never filesystem paths.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import time
import unicodedata
import uuid
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / '.expense-data.sqlite3'
FILE_ROOT = ROOT / '.invoice-files'
MAX_FILE_BYTES = 24 * 1024 * 1024
ROLES = {'采购方式', '项目', '科目', '规格', '数量', '费用类型'}


class DataError(ValueError):
    pass


@contextmanager
def database():
    fd = os.open(DB_PATH, os.O_CREAT | os.O_RDWR, 0o600); os.close(fd)
    os.chmod(DB_PATH, 0o600)
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    try:
        con.execute('PRAGMA foreign_keys=ON')
        con.executescript('''
          CREATE TABLE IF NOT EXISTS invoice_files (
            file_id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
            mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
            created_at INTEGER NOT NULL, remote_code TEXT, remote_app_id TEXT,
            uploaded_at INTEGER, UNIQUE(owner, sha256, name)
          );
          CREATE TABLE IF NOT EXISTS fill_observations (
            owner TEXT NOT NULL, draft_id TEXT NOT NULL, invoice_id TEXT NOT NULL,
            field TEXT NOT NULL, value TEXT NOT NULL, project TEXT NOT NULL,
            method TEXT NOT NULL, merchant TEXT NOT NULL, category TEXT NOT NULL,
            amount_bucket TEXT NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(owner, draft_id, invoice_id, field)
          );
          CREATE TABLE IF NOT EXISTS drafts (
            owner TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
            state_json TEXT NOT NULL, stage TEXT NOT NULL, revision INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL, instance_code TEXT,
            PRIMARY KEY(owner,id)
          );
          CREATE INDEX IF NOT EXISTS draft_list ON drafts(owner,status,updated_at DESC);
          CREATE TABLE IF NOT EXISTS submission_history (
            owner TEXT NOT NULL, instance_code TEXT NOT NULL, request_id TEXT NOT NULL,
            draft_id TEXT, title TEXT NOT NULL, project TEXT NOT NULL, total TEXT NOT NULL,
            status TEXT NOT NULL, submitted_at INTEGER NOT NULL, approval_url TEXT NOT NULL,
            receipt_json TEXT NOT NULL, snapshot_json TEXT NOT NULL,
            PRIMARY KEY(owner,instance_code), UNIQUE(owner,request_id)
          );
          CREATE INDEX IF NOT EXISTS submission_list ON submission_history(owner,submitted_at DESC);
          CREATE INDEX IF NOT EXISTS fill_lookup ON fill_observations(owner,field,updated_at);
          CREATE TABLE IF NOT EXISTS ai_settings (
            owner TEXT PRIMARY KEY, base_url TEXT NOT NULL, api_key_enc TEXT NOT NULL,
            text_model TEXT NOT NULL, vision_model TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
          );
        ''')
        with con:
            yield con
    finally:
        con.close()


def safe_name(name):
    name = str(name).replace('\\', '/').split('/')[-1]
    name = ''.join(c for c in name if c >= ' ' and c not in '\x7f"')[:180]
    return name or 'invoice.pdf'


def public_file(row):
    return {k: row[k] for k in ('file_id','name','mime','size','sha256')}


def save_file(owner, data, name, mime):
    if not owner:
        raise DataError('请先用飞书登录后上传发票')
    if not data or len(data) > MAX_FILE_BYTES:
        raise DataError('发票原文件为空或超过 24MB，请压缩后重传')
    if mime != 'application/pdf' and not mime.startswith('image/'):
        raise DataError('发票原文件只支持 PDF 或图片')
    digest = hashlib.sha256(data).hexdigest()
    name = safe_name(name)
    FILE_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(FILE_ROOT, 0o700)
    with database() as con:
        con.execute('BEGIN IMMEDIATE')
        row = con.execute('SELECT * FROM invoice_files WHERE owner=? AND sha256=? AND name=?', (owner,digest,name)).fetchone()
        file_id = row['file_id'] if row else uuid.uuid4().hex
        path = FILE_ROOT / file_id
        if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            temporary = FILE_ROOT / (file_id + '.' + uuid.uuid4().hex + '.tmp')
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd,'wb') as out: out.write(data)
            temporary.replace(path)
        if not row:
            con.execute('INSERT INTO invoice_files(file_id,owner,name,mime,size,sha256,created_at) VALUES(?,?,?,?,?,?,?)',
                        (file_id,owner,name,mime,len(data),digest,int(time.time())))
            row = con.execute('SELECT * FROM invoice_files WHERE file_id=?',(file_id,)).fetchone()
        return public_file(row)


def resolve_file(owner, ref):
    file_id = ref.get('file_id') if isinstance(ref,dict) else None
    if not isinstance(file_id,str) or not re.fullmatch('[0-9a-f]{32}',file_id):
        raise DataError('这张发票缺少原文件，请返回识别汇总补传原件')
    with database() as con:
        row = con.execute('SELECT * FROM invoice_files WHERE file_id=? AND owner=?',(file_id,owner)).fetchone()
    if not row:
        raise DataError('原文件不存在或不属于当前登录用户，请重新上传')
    path = FILE_ROOT / file_id
    if not path.is_file():
        raise DataError('原文件已不可用，请返回识别汇总补传原件')
    raw = path.read_bytes()
    if len(raw) != row['size'] or hashlib.sha256(raw).hexdigest() != row['sha256']:
        raise DataError('发票原文件完整性校验失败，请补传原件')
    return dict(row), raw


def lookup_file(owner, name):
    """Latest original for this owner+filename, or None. Used to resume after a draft lost attachment refs."""
    if not owner:
        raise DataError('请先用飞书登录')
    name = safe_name(name)
    with database() as con:
        row = con.execute(
            'SELECT * FROM invoice_files WHERE owner=? AND name=? ORDER BY created_at DESC LIMIT 1',
            (owner, name),
        ).fetchone()
    return public_file(row) if row else None


def cache_upload(file_id, owner, app_id, code):
    with database() as con:
        con.execute('UPDATE invoice_files SET remote_code=?,remote_app_id=?,uploaded_at=? WHERE file_id=? AND owner=?',
                    (code,app_id,int(time.time()),file_id,owner))


def normalized(value):
    return re.sub(r'\s+','',unicodedata.normalize('NFKC',str(value or ''))).casefold()[:180]


def amount_bucket(value):
    try: n=float(value)
    except (TypeError,ValueError):return ''
    if not math.isfinite(n) or n <= 0:return ''
    for cap in (100,500,1000,5000,10000):
        if n <= cap:return str(cap)
    return '10000+'


def context(claim, inv):
    a=claim.get('answers') or {}
    return {'project':str(claim.get('costCenter') or a.get('costCenter') or ''),
            'method':str(claim.get('purchaseMethod') or a.get('purchaseMethod') or ''),
            'merchant':normalized(inv.get('merchant')), 'category':str(inv.get('category') or ''),
            'amount_bucket':amount_bucket(inv.get('amount'))}


def role(name):
    return '科目' if '科目' in name else name


def record_fills(owner, draft_id, claim, schema):
    """Upsert the latest explicit answers; generated suggestions are never answers."""
    if not owner or not isinstance(draft_id,str) or not 1 <= len(draft_id) <= 128:
        raise DataError('填写记录缺少会话标识')
    invoices=claim.get('invoices') or []
    if not isinstance(invoices,list) or len(invoices)>100:
        raise DataError('填写记录最多 100 张发票')
    answers=claim.get('answers') or {}
    method=next((m for m in schema['methods'] if m['name']==(claim.get('purchaseMethod') or answers.get('purchaseMethod'))),None)
    with database() as con:
        # One draft/row/field counts once; corrections replace rather than inflate evidence.
        con.execute('DELETE FROM fill_observations WHERE owner=? AND draft_id=?',(owner,draft_id))
        for inv in invoices:
            if not isinstance(inv,dict) or not isinstance(inv.get('id'),str):continue
            ctx=context(claim,inv)
            values={}
            if ctx['project'] in schema['projects']: values['项目']=ctx['project']
            if method:
                values['采购方式']=method['name']
                for w in method['fields']:
                    r=role(w['name'])
                    if r not in ROLES:continue
                    v=answers.get(f"purchase:{method['name']}:{inv['id']}:{w['name']}")
                    if not isinstance(v,str) or not v.strip() or len(v)>80:continue
                    if w['options'] and v not in w['options']:continue
                    if r=='数量':
                        try:
                            if not math.isfinite(float(v)) or float(v)<=0:continue
                        except ValueError:continue
                    values[r]=v.strip()
            for field,value in values.items():
                con.execute('INSERT INTO fill_observations VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                    (owner,draft_id,inv['id'],field,value,ctx['project'],ctx['method'],ctx['merchant'],ctx['category'],ctx['amount_bucket'],int(time.time())))


def rank_choices(owner, field, ctx):
    """Mixture of Laplace-smoothed empirical probabilities, back off on no data."""
    with database() as con:
        rows=[dict(r) for r in con.execute('SELECT value,project,method,merchant,category,amount_bucket FROM fill_observations WHERE owner=? AND field=? ORDER BY updated_at DESC LIMIT 10000',(owner,field))]
    if not rows:return []
    candidates=sorted({r['value'] for r in rows})
    levels=[((),0.25),(('project',),2),(('merchant',),2),(('method',),1),
            (('category','amount_bucket'),1),(('project','method'),3),
            (('project','merchant'),4),(('project','merchant','method','amount_bucket'),8)]
    # Never condition on the answer we are trying to predict.
    target={'项目':'project','采购方式':'method'}.get(field)
    scores={v:0.0 for v in candidates}; weight_sum=0.0
    for keys,weight in levels:
        if target in keys or any(not ctx.get(k) for k in keys):continue
        matches=[r for r in rows if all(r[k]==ctx[k] for k in keys)]
        if not matches:continue
        weight_sum+=weight
        for value in candidates:
            scores[value]+=weight*(sum(r['value']==value for r in matches)+1)/(len(matches)+len(candidates))
    return [{'value':v,'probability':round(scores[v]/weight_sum,4),'evidence':sum(r['value']==v for r in rows)}
            for v in sorted(candidates,key=lambda v:(-scores[v],v))][:24]


def suggestions(owner, claim):
    invoices=claim.get('invoices') or []
    if not isinstance(invoices,list) or len(invoices)>100:raise DataError('建议请求最多 100 张发票')
    first=invoices[0] if invoices else {}
    common=context(claim,first)
    global_values={name:rank_choices(owner,field,common) for name,field in [('purchaseMethod','采购方式'),('costCenter','项目')]}
    rows={}
    for inv in invoices:
        if not isinstance(inv,dict) or not inv.get('id'):continue
        ctx=context(claim,inv)
        rows[inv['id']]={field:rank_choices(owner,field,ctx) for field in ('科目','规格','数量','费用类型')}
    return {'global':global_values,'rows':rows}
