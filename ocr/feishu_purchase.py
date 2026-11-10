"""Native 采购申请 through the OAuth user's /instances/initiate API.

Definition and budget reads retain the existing tenant read-only access.
Creation exclusively uses the verified OAuth user token; no tenant fallback.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import uuid
from contextlib import closing
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlencode, urlparse

import feishu_oauth as auth
import approval_files
import expense_data
import invoice_registry
import invoice_items
import expense_records
import time

APPROVAL_CODE = "D448D0FB-77DB-4640-9650-1FB99512888C"
CREATE_URL = "https://open.feishu.cn/open-apis/approval/v4/instances/initiate"
ALLOWED_LINKS = {d["approval_code"] for d in auth.BUDGET_DEFINITIONS} | {auth.TRAVEL_DEFINITION["approval_code"]}
DB_PATH = Path(__file__).resolve().parent.parent / ".submissions.sqlite3"
_submit_lock = threading.Lock()


class ValidationError(ValueError):
    pass


def definition():
    obj = auth.http_json("GET", f"https://open.feishu.cn/open-apis/approval/v4/approvals/{APPROVAL_CODE}?locale=zh-CN", token=auth.get_tenant_access_token())
    if obj.get("code") != 0:
        raise auth.FeishuAPIError(502, obj)
    data = obj.get("data") or {}
    if data.get("approval_name") != "采购申请":
        raise ValidationError("审批定义名称不匹配，已停止提交")
    form = data.get("form")
    return json.loads(form) if isinstance(form, str) else form


def visible(widget, values):
    def evaluate(c):
        tests = [evaluate(x) for x in (c.get("conditions") or [])]
        for exp in c.get("expressions") or []:
            if exp.get("compare_type") != "is":
                raise ValidationError("采购定义出现不支持的显隐条件，请更新字段映射")
            tests.append(values.get(exp["source_widget"]["id"]) == exp.get("standard_value"))
        return (any(tests) if c.get("conditional") == "OR" else all(tests))
    return widget.get("visible", True) and (not widget.get("display_condition") or evaluate(widget["display_condition"]))


def option_value(widget, value):
    for o in widget.get("option") or []:
        if value in (o["text"], o["value"]):
            return o["value"]
    raise ValidationError(f"{widget['name']}必须从飞书现有选项中选择")


def active_group(form, method):
    method_widget = next(w for w in form if w["name"] == "采购方式")
    selected = option_value(method_widget, method)
    values = {method_widget["id"]: selected}
    groups = [w for w in form if w["type"] == "fieldList" and visible(w, values)]
    if len(groups) != 1:
        raise ValidationError("采购明细定义无法唯一匹配，请管理员检查审批配置")
    return method_widget, selected, groups[0], values


def public_schema(form):
    def field(w):
        return {"name": w["name"], "type": w["type"], "required": w.get("required", False),
                "options": [o["text"] for o in w.get("option", [])] if isinstance(w.get("option"), list) else []}
    method_widget = next(w for w in form if w["name"] == "采购方式")
    return {"approvalCode": APPROVAL_CODE, "projects": next(field(w)["options"] for w in form if w["name"] == "项目"),
            "methods": [{"name": o["text"], "fields": [field(w) for w in active_group(form, o["text"])[2]["children"]]} for o in method_widget["option"]]}


def number(value, label, money=False):
    try:
        n = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValidationError(f"{label}必须是有效数字")
    if not n.is_finite() or n <= 0 or n > Decimal("1000000000"):
        raise ValidationError(f"{label}必须大于零且不超过十亿")
    if money and n != n.quantize(Decimal(".01")):
        raise ValidationError(f"{label}最多保留两位小数")
    return float(n)


def build_form(form, claim):
    if not isinstance(claim, dict):
        raise ValidationError("缺少采购申请数据")
    answers = claim.get("answers") or {}
    method = claim.get("purchaseMethod") or answers.get("purchaseMethod")
    method_widget, selected, group, values = active_group(form, method)
    project = claim.get("costCenter") or answers.get("costCenter")
    purpose = str(claim.get("purpose") or "").strip()
    if not purpose or len(purpose) > 10000:
        raise ValidationError("请填写采购事由（最多 10000 字）")
    invoices = claim.get("invoices")
    if not isinstance(invoices, list) or not 1 <= len(invoices) <= 100:
        raise ValidationError("请确认识别汇总，至少一张发票，最多 100 张")
    rows = []
    invoice_ids = set()
    for row_number, inv in enumerate(invoices, 1):
        if not isinstance(inv, dict) or not inv.get("id") or inv["id"] in invoice_ids:
            raise ValidationError("发票行标识缺失或重复，请返回识别汇总")
        invoice_ids.add(inv["id"])
        if inv.get("source") == "mock":
            raise ValidationError("模拟发票不能发起真实审批，请上传真实发票并核对识别汇总")
        amount = number(inv.get("amount"), "发票金额", money=True)
        cells = []
        for w in group["children"]:
            name = w["name"]
            key = f"purchase:{method}:{inv['id']}:{name}"
            val = answers.get(key, "")
            if name == "金额":
                val = amount
            elif name in ("数量","单位","规格"):
                auto=invoice_items.quantity_unit(inv)
                val=auto["quantity"] if name=="数量" else auto["unit"]
            elif name == "名称":
                val = inv.get("merchant") or inv.get("fileName") or ""
            elif name == "备注":
                val = " · ".join(str(x) for x in [inv.get("date"), inv.get("merchant"), f"发票号：{inv['invoiceNo']}" if inv.get("invoiceNo") else "", inv.get("category"), inv.get("note"), val] if x)
            elif name in ("账户名称", "银行账户", "收款账号", "开户支行"):
                val = answers.get(f"purchase:{method}:shared:{name}", "")
            if w.get("required") and not str(val).strip():
                raise ValidationError(f"【{project}】¥{amount:.2f} 还缺{name}，请返回问答补充")
            if val == "" and not w.get("required"):
                continue
            if w["type"] == "radioV2":
                val = option_value(w, val)
            elif w["type"] == "number":
                val = number(val, name)
            elif w["type"] not in ("amount", "input", "textarea"):
                raise ValidationError(f"不支持的采购明细控件：{name}")
            cell = {"id": w["id"], "type": w["type"], "value": val}
            if w["type"] == "amount":
                cell["currency"] = "CNY"
            cells.append(cell)
        rows.append(cells)
    result = []
    for w in form:
        if not visible(w, values):
            continue
        name = w["name"]
        if name == "采购方式": val = selected
        elif name == "项目": val = option_value(w, project)
        elif name == "采购事由": val = purpose
        elif w["id"] == group["id"]: val = rows
        elif w["type"] == "connect":
            b = claim.get("selectedBudget") or {}
            code = b.get("instanceId") or b.get("instanceCode")
            if not code: raise ValidationError("除预付款项外，请先选择一条已通过的预算或出差申请")
            try: uuid.UUID(code)
            except (ValueError, TypeError): raise ValidationError("关联审批实例编号无效")
            val = [code]
        elif w["type"] == "attachmentV2":
            continue  # Always populated from owned originals after upload.
        elif w.get("required"):
            raise ValidationError(f"采购定义新增必填字段：{name}，请更新问答")
        else: continue
        result.append({"id": w["id"], "type": w["type"], "value": val})
    return result


def validate_relation(claim, actor, token):
    b = claim.get("selectedBudget") or {}
    code = b.get("instanceId") or b.get("instanceCode")
    if not code:
        return
    detail = auth.fetch_instance(token, code)
    if detail.get("approval_code") not in ALLOWED_LINKS or not auth.is_approved_status(detail.get("status")):
        raise ValidationError("关联审批必须是已通过的立项预算、项目预算变更或出差申请")
    # Reuse the same server-side budget visibility rules and ID alias expansion.
    budgets, warning = auth.list_approved_budgets(actor)
    if warning: raise ValidationError(warning)
    if any(x["instanceId"] == code for x in budgets):
        return
    ids = auth.logged_in_user_ids(actor)
    id_map = {}
    auth.harvest_identity_pairs(detail, id_map)
    ids = auth.expand_user_ids_with_map(ids, id_map)
    if not auth.user_in_budget_scope(ids, detail):
        raise ValidationError("所选关联审批不在当前登录用户的可用范围内")


def permission_error(err, identity="user"):
    # Return only actionable, bounded upstream error details, never token payloads.
    missing = [v.get("subject") for v in (err.payload.get("error") or {}).get("permission_violations", []) if v.get("subject")]
    scopes = missing or (["approval:instance:write"] if identity == "user" else ["approval:approval:readonly"])
    query = urlencode({"q": ",".join(scopes), "op_from": "openapi", "token_type": identity})
    return {"ok": False, "error": f"飞书审批创建失败：{str(err)[:1600]}", "feishuCode": err.feishu_code,
            "requiredScopes": missing, "permissionUrl": f"https://open.feishu.cn/app/{auth.app_id()}/auth?{query}",
            "loginUrl": "/api/auth/feishu/login"}


def _db():
    # Only submission hashes and receipts are stored; no invoices or tokens.
    fd = os.open(DB_PATH, os.O_CREAT | os.O_RDWR, 0o600)
    os.close(fd)
    os.chmod(DB_PATH, 0o600)
    db = sqlite3.connect(DB_PATH)
    db.execute("CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, status TEXT, receipt TEXT)")
    if 'history_source' not in {r[1] for r in db.execute('PRAGMA table_info(submissions)')}:
        db.execute("ALTER TABLE submissions ADD COLUMN history_source TEXT NOT NULL DEFAULT ''")
        db.commit()
    return db


def save_history(source, receipt):
    expense_records.record_submission(source['owner'],source.get('draftId'),source['claim'],receipt,source.get('submittedAt'))


def recover_history(owner):
    # Only this OAuth owner's outbox is eligible. Never retry an approval create.
    with _submit_lock, closing(_db()) as db:
        rows=db.execute("SELECT receipt,history_source FROM submissions WHERE status='created' AND history_source!=''").fetchall()
    for raw,meta in rows:
        try:
            source=json.loads(meta)
            if source.get('owner')==owner:
                save_history(source,json.loads(raw))
        except Exception:
            continue


def create_purchase(sess, body):
    actor = auth.fetch_user_info(sess["access_token"])
    if not actor.get("openId") or actor["openId"] != (sess.get("user") or {}).get("openId"):
        raise ValidationError("OAuth 用户身份不匹配，请重新登录")
    claim = body.get("claim")
    schema = definition()
    form = build_form(schema, claim)
    files = approval_files.resolve_invoices(actor["openId"], claim)
    token = auth.get_tenant_access_token()
    if (claim.get("purchaseMethod") or (claim.get("answers") or {}).get("purchaseMethod")) != "预付款项":
        validate_relation(claim, actor, token)
    # Content-addressed idempotency survives reloads, repeated clicks and server restarts.
    canonical = json.dumps([actor["openId"], form, [{"sha256":r["sha256"],"name":r["name"]} for r,raw in files]], ensure_ascii=False, sort_keys=True)
    request_id = str(uuid.uuid5(uuid.NAMESPACE_URL, hashlib.sha256(canonical.encode()).hexdigest()))
    with _submit_lock, closing(_db()) as db:
        previous = db.execute("SELECT status, receipt, history_source FROM submissions WHERE id=?", (request_id,)).fetchone()
        if previous:
            if previous[0] == "created":
                stored_source=json.loads(previous[2]) if previous[2] else None
                if stored_source is None:
                    with expense_data.database() as con:
                        historical=con.execute('SELECT draft_id FROM submission_history WHERE owner=? AND request_id=?',(actor['openId'],request_id)).fetchone()
                    if not historical: raise ValidationError('该发票已有成功回执，请先在我的报销或飞书核对原单')
                    stored_source={'draftId':historical['draft_id']}
                if stored_source.get('draftId')!=body.get('draftId'):
                    raise ValidationError('这张发票已在其他报销中提交，请查看原报销记录')
                receipt=json.loads(previous[1])
                source={'owner':actor['openId'],'draftId':body.get('draftId'),'claim':json.loads(json.dumps(claim)),'submittedAt':int(time.time())}
                for invoice,(meta,_) in zip(source['claim']['invoices'],files): invoice['attachment']=expense_data.public_file(meta)
                try: save_history(source,receipt)
                except Exception: receipt['historyWarning']='采购已发起，历史同步暂失败；请稍后在我的报销刷新'
                return receipt
            raise ValidationError(f"该申请提交结果待确认（请求号 {request_id}），请先在飞书「已发起」核对，勿重复提交")
        if body.get('draftId'):
            with expense_data.database() as con:
                draft=con.execute('SELECT status,revision FROM drafts WHERE owner=? AND id=?',(actor['openId'],body['draftId'])).fetchone()
            if draft and draft['status']!='active':
                raise ValidationError('此草稿已提交或删除，请从我的报销查看记录，填写新单请新建报销')
            if draft and body.get('draftRevision') is not None and draft['revision']!=body['draftRevision']:
                raise ValidationError('草稿在其他页面发生变化，请重新打开核对后提交')
        registry_draft=body.get('draftId') or 'submit_'+request_id
        try: invoice_registry.submission(actor['openId'],registry_draft,claim['invoices'],claim.get('costCenter') or '',phase='active')
        except invoice_registry.DuplicateError as e: raise ValidationError(str(e))
        # File upload failure happens before any approval is initiated.
        codes = approval_files.file_codes(actor["openId"], files)
        approval_files.add_attachment(form, schema, codes)
        try: invoice_registry.submission(actor['openId'],registry_draft,claim['invoices'],claim.get('costCenter') or '',phase='pending',revision=body.get('draftRevision'))
        except invoice_registry.DuplicateError as e: raise ValidationError(str(e))
        db.execute("INSERT INTO submissions(id,status,receipt) VALUES (?, 'pending', '')", (request_id,))
        db.commit()
        try:
            obj = auth.http_json("POST", CREATE_URL, token=sess["access_token"], payload={"approval_code": APPROVAL_CODE,
                "form": json.dumps(form, ensure_ascii=False), "uuid": request_id})
            if obj.get("code") != 0:
                raise auth.FeishuAPIError(400, obj)
        except auth.FeishuAPIError as e:
            # Only an explicit Feishu rejection proves that creation did not happen.
            if e.feishu_code is not None and e.feishu_code != 60012 and e.http_status < 500:
                db.execute("DELETE FROM submissions WHERE id=?", (request_id,)); db.commit()
                invoice_registry.reject_submission(actor["openId"],registry_draft)
            raise
        data = obj.get("data") or {}
        code = data.get("instance_code")
        if not code:
            raise ValidationError(f"飞书未返回实例编号，结果待确认（请求号 {request_id}），请核对后再操作")
        link = data.get("instance_link") or f"https://applink.feishu.cn/client/approval?instanceCode={code}"
        if urlparse(link).scheme != "https":
            link = f"https://applink.feishu.cn/client/approval?instanceCode={code}"
        receipt = {"ok": True, "approvalCode": APPROVAL_CODE, "approvalName": "采购申请", "instanceCode": code,
                   "feishuApprovalId": code, "approvalUrl": link, "serialNumber": data.get("serial_number") or "",
                   "requestId": request_id, "initiator": actor["name"],
                   "attachmentCount": len(codes), "attachmentsConfirmed": False}
        # Creation is already successful. A detail-read failure must never trigger another create.
        try:
            detail = auth.fetch_instance(token, code)
            receipt["serialNumber"] = detail.get("serial_number") or receipt["serialNumber"]
            saved_form = detail.get("form") or []
            if isinstance(saved_form, str): saved_form = json.loads(saved_form)
            receipt["attachmentsConfirmed"] = any(w.get("type")=="attachmentV2" and len(w.get("value") or []) >= len(codes) for w in saved_form)
        except Exception:
            pass
        source={'owner':actor['openId'],'draftId':body.get('draftId'),'claim':json.loads(json.dumps(claim)),'submittedAt':int(time.time())}
        for invoice,(meta,_) in zip(source['claim']['invoices'],files): invoice['attachment']=expense_data.public_file(meta)
        db.execute("UPDATE submissions SET status='created', receipt=?,history_source=? WHERE id=?", (json.dumps(receipt, ensure_ascii=False),json.dumps(source,ensure_ascii=False),request_id))
        db.commit()
        try: save_history(source,receipt)
        except Exception: receipt['historyWarning']='采购已发起，历史同步暂失败；请稍后在我的报销刷新' 
        try:
            if body.get("draftId"):
                expense_data.record_fills(actor["openId"], body["draftId"], claim, public_schema(schema))
        except Exception:
            pass  # A suggestion-library failure must not obscure a created approval.
        return receipt


def handle_schema(handler):
    try:
        handler._json(200, {"ok": True, **public_schema(definition())})
    except auth.FeishuAPIError as e:
        handler._json(403 if auth.is_missing_scope(e) else 502, permission_error(e, "tenant"))
    except (ValidationError, ValueError) as e:
        handler._json(422, {"ok": False, "error": str(e)})
    except Exception:
        handler._json(502, {"ok": False, "error": "采购表单加载失败，请稍后重试"})


def handle_create(handler, body):
    origin = handler.headers.get("Origin")
    if origin and origin not in {auth.web_origin(), "http://127.0.0.1:5173", "http://localhost:5173"}:
        handler._json(403, {"ok": False, "error": "提交来源不受信任"}); return
    sid = auth.cookie_from_headers(handler.headers)
    sess = auth.get_session(sid)
    if not sess:
        handler._json(401, {"ok": False, "error": "请先用飞书登录", "loginUrl": "/api/auth/feishu/login"}); return
    try:
        sess = auth.ensure_fresh_session(sid, sess)
        handler._json(200, create_purchase(sess, body))
    except auth.FeishuAPIError as e:
        handler._json(403 if auth.is_missing_scope(e) else 502, permission_error(e, getattr(e, "identity", "user")))
    except (ValidationError, ValueError, TypeError, KeyError) as e:
        handler._json(422, {"ok": False, "error": str(e)})
    except Exception:
        handler._json(502, {"ok": False, "error": "提交异常，结果可能待确认，请先核对飞书「已发起」，勿重复提交"})
