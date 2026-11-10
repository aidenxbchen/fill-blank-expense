"""Shared bank pairs for this single-app tenant. Creator-only edits, soft deletion."""
import json
import re
import time
import uuid

import expense_data as data


class ProfileError(ValueError):
    def __init__(self,message,status=422): super().__init__(message);self.status=status


def public(row,owner):
    return {'id':row['id'],'kind':row['kind'],'side':row['side'],'title':row['title'],
            'fields':json.loads(row['fields_json']),'createdBy':row['creator_name'] or '飞书用户',
            'canEdit':row['creator']==owner,'revision':row['revision']}


def listing(owner,side=None):
    if side and side not in ('ours','counterparty'): raise ProfileError('无效账户类型')
    with data.database() as con:
        rows=con.execute("SELECT * FROM filling_profiles WHERE active=1 AND kind='bank' ORDER BY updated_at DESC,id").fetchall()
    return [public(r,owner) for r in rows if not side or r['side']==side]


def save(owner,name,body,ident=None):
    if not owner: raise ProfileError('请先用飞书登录',401)
    if body.get('kind','bank')!='bank' or body.get('side') not in ('ours','counterparty'): raise ProfileError('请选我方或对方账户')
    fields=body.get('fields') or {}
    title=str(body.get('title') or '').strip(); bank=str(fields.get('bank') or '').strip(); holder=str(fields.get('holder') or '').strip()
    account=re.sub(r'\s+','',str(fields.get('account') or ''))
    if not title or len(title)>80 or not bank or len(bank)>160 or len(holder)>120 or not re.fullmatch(r'[0-9]{6,40}',account):
        raise ProfileError('请填写简称、6～40位账号与开户行；户名可选')
    now=int(time.time())
    with data.database() as con:
        con.execute('BEGIN IMMEDIATE')
        if ident:
            row=con.execute('SELECT * FROM filling_profiles WHERE id=? AND active=1',(ident,)).fetchone()
            if not row: raise ProfileError('档案已停用，请刷新',404)
            if row['creator']!=owner: raise ProfileError('只能修改自己创建的档案',403)
            if body.get('revision')!=row['revision']: raise ProfileError('档案已更新，请刷新后重试',409)
            con.execute('UPDATE filling_profiles SET side=?,title=?,fields_json=?,revision=revision+1,updated_at=? WHERE id=?',
                        (body['side'],title,json.dumps(dict(account=account,bank=bank,holder=holder),ensure_ascii=False),now,ident))
        else:
            ident=uuid.uuid4().hex
            con.execute('INSERT INTO filling_profiles VALUES(?,?,?,?,?,?,?,1,1,?,?)',
                        (ident,'bank',body['side'],title,json.dumps(dict(account=account,bank=bank,holder=holder),ensure_ascii=False),owner,str(name or '飞书用户')[:120],now,now))
        return public(con.execute('SELECT * FROM filling_profiles WHERE id=?',(ident,)).fetchone(),owner)


def remove(owner,ident,revision):
    with data.database() as con:
        con.execute('BEGIN IMMEDIATE');row=con.execute('SELECT * FROM filling_profiles WHERE id=? AND active=1',(ident,)).fetchone()
        if not row: raise ProfileError('档案已停用',404)
        if row['creator']!=owner: raise ProfileError('只能停用自己创建的档案',403)
        if revision!=row['revision']: raise ProfileError('档案已更新，请刷新后重试',409)
        con.execute('UPDATE filling_profiles SET active=0,revision=revision+1,updated_at=? WHERE id=?',(int(time.time()),ident))
