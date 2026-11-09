"""Native purchase approvals through the signed-in user's OAuth identity.

The /initiate endpoint is deliberately used instead of the tenant-only create
endpoint. No fallback to a tenant token, a mock result, or another applicant.
"""
from __future__ import annotations

import hashlib
import json
import os
from contextlib import contextmanager
import sqlite3
import uuid
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import feishu_oauth as auth

APPROVAL_CODE = "D448D0FB-77DB-4640-9650-1FB99512888C"
BASE = "https://open.feishu.cn/open-apis/approval/v4"
ALLOWED_CODES = {d["approval_code"] for d in auth.BUDGET_DEFINITIONS + [auth.TRAVEL_DEFINITION]}
WRITE_SCOPE = "approval:instance:write"
READ_SCOPE = "approval:approval:read"
_DEFINITION_REQUEST = object()


class ValidationError(ValueError):
    pass


class SubmissionConflict(ValidationError):
    pass


def api(method: str, path: str, token: str, payload=None):
    result = auth.http_json(method, BASE + path, token=token, payload=payload)
    if result.get("code") != 0:
        raise auth.FeishuAPIError(400, result)
    data = result.get("data")
    if not isinstance(data, dict):
        raise auth.FeishuAPIError(502, {"error": "飞书响应缺少 data"})
    return data


def definition(token: str):
    data = api("GET", f"/approvals/{APPROVAL_CODE}/detail?locale=zh-CN", token)
    if data.get("approval_name") != "采购申请":
        raise ValidationError("采购审批定义名称不匹配，请联系管理员核实")
    form = data.get("form")
    if isinstance(form, str):
        form = json.loads(form)
    if not isinstance(form, list) or not form:
        raise ValidationError("采购审批定义没有表单")
    if any(n.get("need_approver") for n in data.get("node_list", [])):
        raise ValidationError("审批流程现要求自选审批人，请先在飞书中发起或联系管理员")
    return {"approval_code": APPROVAL_CODE, "approval_name": "采购申请", "form": form}


def visible(widget, values):
    if widget.get("visible") is False:
        return False
    condition = widget.get("display_condition")
    if not condition:
        return True

    def matches(node):
        checks = [matches(n) for n in node.get("conditions") or []]
        for exp in node.get("expressions") or []:
            if exp.get("compare_type") != "is":
                raise ValidationError("审批显示条件已变更，请联系管理员核实")
            checks.append(values.get(exp["source_widget"]["id"]) == exp.get("standard_value"))
        return any(checks) if node.get("conditional") == "OR" else all(checks)

    return matches(condition)


def option_value(widget, raw):
    for opt in widget.get("option") or []:
        if raw in (opt.get("value"), opt.get("text")):
            return opt["value"]
    raise ValidationError(f"{widget['name']}请选择飞书定义中的有效选项")


def numeric(raw, name):
    if raw is None or isinstance(raw, bool) or not str(raw).strip():
        raise ValidationError(f"{name}必填")
    try:
        value = Decimal(str(raw))
    except InvalidOperation:
        raise ValidationError(f"{name}必须是数字")
    if not value.is_finite() or value <= 0 or value > Decimal("1000000000000"):
        raise ValidationError(f"{name}必须大于 0 且不超过一万亿")
    return value


def control(widget, raw):
    name, kind = widget["name"], widget["type"]
    if raw is None or raw == "":
        if widget.get("required"):
            raise ValidationError(f"{name}必填")
        return None
    item = {"id": widget["id"], "type": kind}
    if kind == "radioV2":
        value = option_value(widget, raw)
    elif kind in ("number", "amount"):
        number = numeric(raw, name)
        if kind == "amount":
            if number != number.quantize(Decimal("0.01")):
                raise ValidationError("金额最多保留两位小数")
            item["currency"] = "CNY"
        value = float(number)
    elif kind in ("input", "textarea"):
        if not isinstance(raw, str) or not raw.strip():
            raise ValidationError(f"{name}必填")
        value = raw.strip()
    else:
        raise ValidationError(f"暂不支持审批控件：{name}（{kind}）")
    return dict(item, value=value)


def build_form(claim: dict, schema: dict):
    """Only invoiceRows (the editable recognition summary) supply invoice facts.

    Caller-supplied totals, old OCR objects and detailSheets are never read.
    Extra fields supply business choices, specifications, quantity and payee info.
    """
    if not isinstance(claim, dict):
        raise ValidationError("缺少采购申请数据")
    rows = claim.get("invoiceRows")
    if not isinstance(rows, list) or not rows or len(rows) > 200:
        raise ValidationError("识别汇总表需要 1–200 行有效发票")
    values, form = {}, []
    top = {"采购方式": claim.get("purchaseMethod"), "项目": claim.get("project"),
           "采购事由": claim.get("purpose")}
    for w in schema["form"]:
        if w["name"] in top:
            item = control(w, top[w["name"]])
            if item:
                form.append(item)
                values[w["id"]] = item["value"]
    if len(form) != 3:
        raise ValidationError("采购申请必填字段发生变化，请联系管理员")
    total = Decimal("0")
    ids = set()
    active_lists = [w for w in schema["form"] if w["type"] == "fieldList" and visible(w, values)]
    if len(active_lists) != 1:
        raise ValidationError("无法确定当前采购方式的明细表")
    table = active_lists[0]
    output_rows = []
    for index, row in enumerate(rows, 1):
        if not isinstance(row, dict) or not row.get("id") or str(row["id"]) in ids:
            raise ValidationError("识别汇总行 ID 缺失或重复")
        ids.add(str(row["id"]))
        if row.get("source") == "mock":
            raise ValidationError("模拟发票不能发起真实审批，请使用真实识别结果")
        amount = numeric(row.get("amount"), f"第 {index} 行金额")
        total += amount
        extras = row.get("fields") or {}
        if not isinstance(extras, dict):
            raise ValidationError("明细补充信息格式错误")
        fact_note = "；".join(str(v) for v in [row.get("date"), row.get("merchant"),
                           ("发票号：" + str(row["invoiceNo"])) if row.get("invoiceNo") else "",
                           row.get("note")] if v)
        cells = []
        for child in table.get("children", []):
            name = child["name"]
            if name == "金额":
                raw = str(amount)
            elif name == "名称":
                raw = row.get("description") or row.get("merchant")
            elif name == "备注":
                raw = "；".join(v for v in [fact_note, extras.get(child["id"], "")] if v)
            else:
                raw = extras.get(child["id"])
            if not visible(child, values):
                continue
            try:
                cell = control(child, raw)
            except ValidationError as err:
                raise ValidationError(f"第 {index} 行：{err}") from err
            if cell:
                cells.append(cell)
        output_rows.append(cells)
    form.append({"id": table["id"], "type": "fieldList", "value": output_rows})
    selected = claim.get("selectedBudget")
    if selected is not None and not isinstance(selected, dict):
        raise ValidationError("关联审批数据格式错误")
    connect_code = ""
    for w in schema["form"]:
        if w["type"] == "connect" and visible(w, values):
            connect_code = str((selected or {}).get("instanceCode") or (selected or {}).get("instanceId") or "")
            try:
                uuid.UUID(connect_code)
            except (ValueError, AttributeError):
                raise ValidationError("请选择已通过的立项 / 变更，或填写出差审批实例 Code")
            form.append({"id": w["id"], "type": "connect", "value": [connect_code]})
        elif w["name"] not in top and w["type"] not in ("fieldList", "connect") and w.get("required") and visible(w, values):
            raise ValidationError(f"审批新增必填字段：{w['name']}，请联系管理员")
    return form, total, connect_code


def validate_association(token, code):
    if not code:
        return
    detail = api("GET", "/instances/detail?instance_code=" + code, token)
    definition_code = detail.get("definition_code") or detail.get("approval_code")
    if definition_code not in ALLOWED_CODES or not auth.is_approved_status(detail.get("status")):
        raise ValidationError("关联审批必须是已通过的立项、预算变更或出差申请")


def journal_path():
    return auth._root_dir() / ".purchase-submissions.sqlite3"


@contextmanager
def journal():
    con = sqlite3.connect(journal_path(), timeout=10)
    try:
        os.chmod(journal_path(), 0o600)
        con.execute("CREATE TABLE IF NOT EXISTS submissions (owner TEXT, request_id TEXT, digest TEXT, state TEXT, result TEXT, PRIMARY KEY(owner, request_id))")
        with con:
            yield con
    finally:
        con.close()


def create_purchase(token, user, body):
    try:
        request_id = str(uuid.UUID(str(body.get("requestId", ""))))
    except ValueError:
        raise ValidationError("缺少有效的提交标识，请刷新后重试")
    owner = user.get("openId") or user.get("userId")
    if not owner:
        raise ValidationError("登录身份缺少用户 ID，请重新登录")
    claim = body.get("claim")
    digest = hashlib.sha256(json.dumps(claim, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    # Read saved success before any network access; a restart/expired token must
    # never turn an already-created purchase into a second POST.
    with journal() as con:
        saved = con.execute("SELECT digest,state,result FROM submissions WHERE owner=? AND request_id=?", (owner, request_id)).fetchone()
    if saved:
        if saved[0] != digest:
            raise SubmissionConflict("该提交标识已用于不同内容，请回到提交页重新确认")
        if saved[1] == "success":
            return json.loads(saved[2])
        if saved[1] == "pending":
            raise SubmissionConflict("上次提交结果尚未确认，请先在飞书‘我发起的’核对，勿重复创建")
    schema = definition(token)
    form, total, associated = build_form(claim, schema)
    validate_association(token, associated)
    with journal() as con:
        con.execute("BEGIN IMMEDIATE")
        current = con.execute("SELECT digest,state,result FROM submissions WHERE owner=? AND request_id=?", (owner, request_id)).fetchone()
        if current and current[0] != digest:
            raise SubmissionConflict("该提交标识已用于不同内容，请重新确认")
        if current and current[1] == "success":
            return json.loads(current[2])
        if current and current[1] == "pending":
            raise SubmissionConflict("提交正在处理，请勿重复点击")
        con.execute("INSERT OR REPLACE INTO submissions VALUES (?,?,?,?,?)", (owner, request_id, digest, "pending", ""))
    try:
        created = api("POST", "/instances/initiate", token, {
            "approval_code": APPROVAL_CODE, "form": json.dumps(form, ensure_ascii=False), "uuid": request_id,
        })
    except auth.FeishuAPIError as err:
        # Explicit business rejection is safe to retry. Network/5xx failures may
        # already have created an instance; leave pending for manual reconciliation.
        if err.feishu_code is not None and err.feishu_code != 60012 and err.http_status < 500:
            with journal() as con:
                con.execute("UPDATE submissions SET state='rejected' WHERE owner=? AND request_id=?", (owner, request_id))
        raise
    code = created.get("instance_code")
    if not code:
        raise auth.FeishuAPIError(502, {"error": "飞书未返回审批实例 Code，请先核对‘我发起的’，勿重复提交"})
    result = {"ok": True, "approvalCode": APPROVAL_CODE, "approvalName": "采购申请",
              "instanceCode": code, "feishuApprovalId": code, "instanceLink": created.get("instance_link") or "",
              "total": str(total), "invoiceCount": len(claim["invoiceRows"])}
    with journal() as con:
        con.execute("UPDATE submissions SET state='success',result=? WHERE owner=? AND request_id=?", (json.dumps(result, ensure_ascii=False), owner, request_id))
    return result


def session_for(handler):
    sid = auth.cookie_from_headers(handler.headers)
    sess = auth.get_session(sid)
    if not sess:
        raise auth.FeishuAPIError(401, {"error": "请先用飞书登录"})
    return auth.ensure_fresh_session(sid, sess)


def handle_purchase(handler, body=_DEFINITION_REQUEST):
    try:
        sess = session_for(handler)
        token = sess["access_token"]
        if body is _DEFINITION_REQUEST:
            data = {"ok": True, **definition(token)}
        else:
            if not isinstance(body, dict):
                raise ValidationError("请求必须是 JSON 对象")
            data = create_purchase(token, sess.get("user") or {}, body)
        handler._json(200, data)
    except SubmissionConflict as err:
        handler._json(409, {"ok": False, "error": str(err)})
    except (ValidationError, json.JSONDecodeError) as err:
        handler._json(400, {"ok": False, "error": str(err)})
    except auth.FeishuAPIError as err:
        missing = auth.is_missing_scope(err)
        status = 403 if missing else (401 if err.http_status == 401 else 502)
        message = str(err)
        if missing:
            message = ("飞书权限不足：请管理员为应用开通并发布用户身份权限 "
                       "approval:approval:read、approval:instance:read、approval:instance:write，随后退出并重新登录授权。")
        handler._json(status, {"ok": False, "error": message, "feishuCode": err.feishu_code,
                              "requiredScopes": [READ_SCOPE, "approval:instance:read", WRITE_SCOPE] if missing else []})
    except (OSError, sqlite3.Error, TimeoutError):
        handler._json(502, {"ok": False, "error": "提交服务暂时不可用；如已点击提交，请先核对飞书‘我发起的’，勿重复创建"})
