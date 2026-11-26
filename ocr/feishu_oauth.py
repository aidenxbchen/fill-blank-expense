"""Feishu OAuth (user login) and approved-budget listing for fill-blank-expense.

Login still uses user OAuth so we know who is signed in. Budget listing uses
tenant_access_token to query approved 立项/变更 instances (including ones
others initiated) and keeps those where the user is initiator or listed in
项目负责人 / 项目参与人 contact fields. Being in 项目参与人 alone is enough.

Form contact widgets store tenant user_id strings even when instances are
fetched with user_id_type=open_id. We expand the logged-in user's open_id
with user_id aliases harvested from timeline / task / CC payloads.
Never logs tokens or app secrets.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any

SHANGHAI = timezone(timedelta(hours=8))

FEISHU_AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize"
FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token"
FEISHU_USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info"
FEISHU_INITIATED_URL = "https://open.feishu.cn/open-apis/approval/v4/instances/initiated"
FEISHU_INSTANCE_URL = "https://open.feishu.cn/open-apis/approval/v4/instances/{instance_id}"
FEISHU_QUERY_URL = "https://open.feishu.cn/open-apis/approval/v4/instances/query"
FEISHU_TENANT_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"

DEFAULT_SCOPES = (
    "approval:instance:write approval:instance:read "
    "offline_access auth:user.id:read contact:user.base:readonly"
)
DEFAULT_REDIRECT = "https://baoxiao.xbchen.top/api/auth/feishu/callback"
DEFAULT_WEB_ORIGIN = "https://baoxiao.xbchen.top"

COOKIE_NAME = "baoxiao_sid"
STATE_TTL_SEC = 600
SESSION_COOKIE_MAX_AGE = 30 * 24 * 3600
REFRESH_SKEW_SEC = 120

# Primary budget list: 立项 / 变更 only. 出差 is kept separately and must
# not appear as "已通过的预算".
BUDGET_DEFINITIONS = [
    {
        "approval_code": "5FEA33D4-2FC3-4B95-BD5B-37B6F31DD35F",
        "numeric_id": "7158358317407027202",
        "name": "立项预算申请",
        "kind": "init",
    },
    {
        "approval_code": "9BACB334-4059-4DB2-AC98-A56587B0F150",
        "numeric_id": "7158358317494960130",
        "name": "项目预算变更申请",
        "kind": "change",
    },
]

# Optional later; never included in GET /api/budgets.
TRAVEL_DEFINITION = {
    "approval_code": "87FAB2C0-D271-4ACF-9344-E7608532FA5C",
    "numeric_id": "7158358316662112257",
    "name": "出差申请",
    "kind": "travel",
}

KIND_LABELS = {
    "init": "立项",
    "change": "变更",
    "travel": "出差",
}

SCOPE_FIELD_NAMES = {"项目参与人", "项目负责人"}

MISSING_SCOPE_CODES = {99991672, 99991663, 99991668, 99991679}
MISSING_SCOPE_WARNING = (
    "管理员请在飞书开放平台为 baoxiao 应用开通应用身份权限 "
    "approval:approval.list:readonly 和 approval:approval:readonly，"
    "并创建版本发布后再试。当前无法列出预算。"
)

BUDGET_CACHE_TTL_SEC = 5
_BUDGET_FETCH_WORKERS = 8
_budget_cache_lock = threading.Lock()
# open_id-key -> (expires_at_epoch, budgets_list, warning)
_budget_cache: dict[str, tuple[float, list[dict[str, Any]], str]] = {}


def clear_budget_cache() -> None:
    """Test/helper: drop in-memory budget list cache."""
    with _budget_cache_lock:
        _budget_cache.clear()


def _budget_cache_key(user: dict[str, Any] | None) -> str:
    ids = sorted(x for x in logged_in_user_ids(user) if x)
    return "|".join(ids)


APPROVED_STATUSES = {
    "2",
    "APPROVED",
    "approved",
    "Approved",
    "Passed",
    "PASSED",
    "passed",
    "已通过",
    "SUCCESS",
    "success",
}

_lock = threading.Lock()
_oauth_states: dict[str, float] = {}
_option_map: dict[str, str] | None = None
_tenant_token = ""
_tenant_token_expires_at = 0.0


class FeishuAPIError(RuntimeError):
    def __init__(self, http_status: int, payload: Any):
        self.http_status = http_status
        self.payload = payload if isinstance(payload, dict) else {"error": str(payload)}
        msg = (
            self.payload.get("msg")
            or self.payload.get("error_description")
            or self.payload.get("error")
            or f"HTTP {http_status}"
        )
        super().__init__(str(msg))
        self.feishu_code = self.payload.get("code")


def _root_dir() -> Path:
    return Path(__file__).resolve().parent.parent


def load_dotenv(path: str | os.PathLike[str] | None = None) -> None:
    """Load KEY=VALUE from .env into os.environ if the key is not already set."""
    env_path = Path(path) if path else _root_dir() / ".env"
    if not env_path.is_file():
        return
    try:
        text = env_path.read_text(encoding="utf-8")
    except OSError:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        if key and key not in os.environ:
            os.environ[key] = val


def app_id() -> str:
    return (os.environ.get("FEISHU_APP_ID") or "").strip()


def app_secret() -> str:
    return (os.environ.get("FEISHU_APP_SECRET") or "").strip()


def redirect_uri() -> str:
    return (os.environ.get("FEISHU_REDIRECT_URI") or DEFAULT_REDIRECT).strip()


def web_origin() -> str:
    explicit = (os.environ.get("FEISHU_WEB_ORIGIN") or "").strip().rstrip("/")
    if explicit:
        return explicit
    parsed = urllib.parse.urlparse(redirect_uri())
    if parsed.scheme and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}"
    return DEFAULT_WEB_ORIGIN


def oauth_scopes() -> str:
    return " ".join(dict.fromkeys(((os.environ.get("FEISHU_SCOPES") or DEFAULT_SCOPES)
                                  + " approval:instance:read approval:instance:write").split()))


def _sessions_path() -> Path:
    return _root_dir() / ".sessions.json"


def _load_option_map() -> dict[str, str]:
    global _option_map
    if _option_map is not None:
        return _option_map
    path = Path(__file__).resolve().parent / "feishu_option_map.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        _option_map = {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except Exception:
        _option_map = {}
    return _option_map


def lookup_option(value: Any) -> str:
    if value is None:
        return ""
    key = str(value)
    return _load_option_map().get(key, "")


def config_ready() -> tuple[bool, str]:
    if not app_id():
        return False, "未配置 FEISHU_APP_ID"
    if not app_secret():
        return False, "未配置 FEISHU_APP_SECRET"
    return True, ""


def _read_sessions() -> dict[str, Any]:
    path = _sessions_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_sessions(data: dict[str, Any]) -> None:
    path = _sessions_path()
    tmp = path.with_suffix(".json.tmp")
    raw = json.dumps(data, ensure_ascii=False)
    tmp.write_text(raw, encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def save_session(sid: str, session: dict[str, Any]) -> None:
    with _lock:
        all_s = _read_sessions()
        all_s[sid] = session
        _write_sessions(all_s)


def delete_session(sid: str) -> None:
    if not sid:
        return
    with _lock:
        all_s = _read_sessions()
        if sid in all_s:
            all_s.pop(sid, None)
            _write_sessions(all_s)


def get_session(sid: str | None) -> dict[str, Any] | None:
    if not sid:
        return None
    with _lock:
        all_s = _read_sessions()
        sess = all_s.get(sid)
        return dict(sess) if isinstance(sess, dict) else None


def new_oauth_state() -> str:
    state = secrets.token_urlsafe(24)
    now = time.time()
    with _lock:
        expired = [k for k, ts in _oauth_states.items() if now - ts > STATE_TTL_SEC]
        for k in expired:
            _oauth_states.pop(k, None)
        _oauth_states[state] = now
    return state


def consume_oauth_state(state: str | None) -> bool:
    if not state:
        return False
    with _lock:
        ts = _oauth_states.pop(state, None)
    if ts is None:
        return False
    return (time.time() - ts) <= STATE_TTL_SEC


def authorize_url(state: str) -> str:
    params = {
        "client_id": app_id(),
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "state": state,
        "scope": oauth_scopes(),
    }
    return FEISHU_AUTHORIZE_URL + "?" + urllib.parse.urlencode(params)


def http_json(
    method: str,
    url: str,
    *,
    token: str | None = None,
    payload: dict[str, Any] | None = None,
    timeout: int = 20,
) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "User-Agent": "fill-blank-expense/baoxiao",
    }
    if payload is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            status = resp.status
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        parsed: Any
        try:
            parsed = json.loads(err_body) if err_body else {"error": e.reason}
        except json.JSONDecodeError:
            parsed = {"error": err_body[:400] or str(e.reason)}
        raise FeishuAPIError(e.code, parsed) from e
    except urllib.error.URLError as e:
        raise FeishuAPIError(502, {"error": f"无法连接飞书: {e.reason}"}) from e
    try:
        obj = json.loads(raw) if raw else {}
    except json.JSONDecodeError as e:
        raise FeishuAPIError(status, {"error": f"飞书返回非 JSON: {raw[:300]}"}) from e
    if not isinstance(obj, dict):
        raise FeishuAPIError(status, {"error": "飞书返回非对象"})
    return obj


def exchange_code(code: str) -> dict[str, Any]:
    obj = http_json(
        "POST",
        FEISHU_TOKEN_URL,
        payload={
            "grant_type": "authorization_code",
            "client_id": app_id(),
            "client_secret": app_secret(),
            "code": code,
            "redirect_uri": redirect_uri(),
        },
    )
    if obj.get("code") not in (0, None) and not obj.get("access_token"):
        raise FeishuAPIError(400, obj)
    if not obj.get("access_token"):
        raise FeishuAPIError(400, obj if obj else {"error": "兑换 token 失败"})
    return obj


def refresh_access_token(refresh_token: str) -> dict[str, Any]:
    obj = http_json(
        "POST",
        FEISHU_TOKEN_URL,
        payload={
            "grant_type": "refresh_token",
            "client_id": app_id(),
            "client_secret": app_secret(),
            "refresh_token": refresh_token,
        },
    )
    if obj.get("code") not in (0, None) and not obj.get("access_token"):
        raise FeishuAPIError(400, obj)
    if not obj.get("access_token"):
        raise FeishuAPIError(400, obj if obj else {"error": "刷新 token 失败"})
    return obj


def fetch_user_info(access_token: str) -> dict[str, Any]:
    obj = http_json("GET", FEISHU_USER_INFO_URL, token=access_token)
    if obj.get("code") not in (0, None):
        raise FeishuAPIError(400, obj)
    data = obj.get("data") if isinstance(obj.get("data"), dict) else obj
    name = (
        data.get("name")
        or data.get("en_name")
        or data.get("user_name")
        or ""
    )
    avatar = (
        data.get("avatar_thumb")
        or data.get("avatar_url")
        or data.get("avatar_middle")
        or data.get("picture")
        or ""
    )
    return {
        "name": str(name or "").strip() or "飞书用户",
        "enName": str(data.get("en_name") or "").strip(),
        "openId": str(data.get("open_id") or data.get("openId") or "").strip(),
        "unionId": str(data.get("union_id") or "").strip(),
        "userId": str(data.get("user_id") or "").strip(),
        "avatar": str(avatar or "").strip(),
        "tenantKey": str(data.get("tenant_key") or "").strip(),
    }


def tokens_to_session(token_obj: dict[str, Any], user: dict[str, Any] | None = None) -> dict[str, Any]:
    now = time.time()
    expires_in = int(token_obj.get("expires_in") or 7200)
    refresh_expires_in = int(token_obj.get("refresh_token_expires_in") or 0)
    sess: dict[str, Any] = {
        "access_token": token_obj.get("access_token") or "",
        "refresh_token": token_obj.get("refresh_token") or "",
        "access_expires_at": now + max(expires_in, 60),
        "refresh_expires_at": (now + refresh_expires_in) if refresh_expires_in else 0,
        "scope": token_obj.get("scope") or "",
        "user": user or {},
        "updated_at": now,
    }
    return sess


def ensure_fresh_session(sid: str, sess: dict[str, Any]) -> dict[str, Any]:
    access = sess.get("access_token") or ""
    exp = float(sess.get("access_expires_at") or 0)
    if access and exp and exp - time.time() > REFRESH_SKEW_SEC:
        return sess
    refresh = sess.get("refresh_token") or ""
    if not refresh:
        if access and exp > time.time():
            return sess
        raise FeishuAPIError(401, {"error": "登录已过期，请重新用飞书登录"})
    token_obj = refresh_access_token(refresh)
    user = sess.get("user") if isinstance(sess.get("user"), dict) else {}
    updated = tokens_to_session(token_obj, user)
    if not updated.get("refresh_token"):
        updated["refresh_token"] = refresh
        updated["refresh_expires_at"] = sess.get("refresh_expires_at") or 0
    save_session(sid, updated)
    return updated


def is_approved_status(status: Any) -> bool:
    if status is None:
        return False
    return str(status).strip() in APPROVED_STATUSES


def fmt_ts(raw: Any) -> str:
    if raw is None or raw == "":
        return ""
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return str(raw)
    if n > 10**11:
        n //= 1000
    try:
        return datetime.fromtimestamp(n, tz=SHANGHAI).strftime("%Y-%m-%d")
    except (OSError, OverflowError, ValueError):
        return str(raw)


def parse_amount(val: Any) -> float | None:
    if val is None or val == "":
        return None
    if isinstance(val, bool):
        return None
    if isinstance(val, (int, float)):
        return float(val)
    if isinstance(val, dict):
        for key in ("value", "amount", "number", "text"):
            if key in val and val[key] not in (None, ""):
                parsed = parse_amount(val[key])
                if parsed is not None:
                    return parsed
        return None
    s = str(val).replace(",", "").replace("¥", "").replace("￥", "").replace("元", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def display_value(val: Any) -> str:
    if val is None or val == "":
        return ""
    if isinstance(val, bool):
        return "是" if val else "否"
    if isinstance(val, (int, float)):
        mapped = lookup_option(val)
        return mapped or str(val)
    if isinstance(val, str):
        mapped = lookup_option(val)
        return mapped or val
    if isinstance(val, dict):
        if val.get("text"):
            return str(val["text"])
        if "start" in val or "end" in val:
            start = val.get("start") or val.get("startTime") or ""
            end = val.get("end") or val.get("endTime") or ""
            return " ~ ".join(p for p in (str(start), str(end)) if p)
        inner = val.get("value")
        if inner is not None and inner != val:
            shown = display_value(inner)
            if shown:
                return shown
        name = val.get("name")
        if name and val.get("type"):
            return display_value(val.get("value"))
        return ""
    if isinstance(val, list):
        parts = [display_value(x) for x in val]
        return "；".join(p for p in parts if p)
    return str(val)


def iter_widgets(form: Any) -> list[dict[str, Any]]:
    widgets: list[dict[str, Any]] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("name") and ("type" in node or "value" in node or "id" in node):
                widgets.append(node)
            for key in ("children", "value"):
                walk(node.get(key))
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(form)
    return widgets


def parse_form(form_raw: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Return (flat fields by name, subject rows)."""
    form: Any = form_raw
    if isinstance(form_raw, str) and form_raw.strip():
        try:
            form = json.loads(form_raw)
        except json.JSONDecodeError:
            return {}, []
    fields: dict[str, Any] = {}
    subjects: list[dict[str, Any]] = []
    top = form if isinstance(form, list) else [form] if isinstance(form, dict) else []
    for widget in top:
        if not isinstance(widget, dict):
            continue
        name = str(widget.get("name") or "").strip()
        wtype = str(widget.get("type") or "")
        value = widget.get("value")
        if name:
            fields[name] = display_value(value)
            if wtype == "amount" or name in ("项目总预算", "变更后总预算", "变更后预算总金额"):
                amt = parse_amount(value)
                if amt is not None:
                    fields[name] = amt
        if wtype == "fieldList" or name == "明细":
            rows = value if isinstance(value, list) else []
            for row in rows:
                row_widgets = row if isinstance(row, list) else (
                    row.get("children") if isinstance(row, dict) else None
                )
                if not isinstance(row_widgets, list):
                    if isinstance(row, dict) and row.get("name"):
                        row_widgets = [row]
                    else:
                        continue
                entry: dict[str, Any] = {}
                for cell in row_widgets:
                    if not isinstance(cell, dict):
                        continue
                    cname = str(cell.get("name") or "").strip()
                    cval = cell.get("value")
                    if not cname:
                        continue
                    if "金额" in cname:
                        entry["amount"] = parse_amount(cval)
                        entry[cname] = entry["amount"] if entry["amount"] is not None else display_value(cval)
                    elif cname in ("科目", "费用科目"):
                        entry["name"] = display_value(cval)
                    elif cname in ("备注",):
                        entry["note"] = display_value(cval)
                    else:
                        entry[cname] = display_value(cval)
                if entry:
                    subjects.append(entry)
    return fields, subjects


def summaries_to_map(summaries: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    if not isinstance(summaries, list):
        return out
    for item in summaries:
        if isinstance(item, dict):
            key = str(item.get("key") or item.get("name") or "").strip()
            val = display_value(item.get("value"))
            if key and val:
                out[key] = val
    return out


def kind_for_code(code: str, name: str = "") -> str:
    for item in BUDGET_DEFINITIONS:
        if code and code == item["approval_code"]:
            return item["kind"]
        if name and name == item["name"]:
            return item["kind"]
    if "变更" in (name or ""):
        return "change"
    if "出差" in (name or ""):
        return "travel"
    if "立项" in (name or "") or "预算" in (name or ""):
        return "init"
    return "other"


def list_initiated(access_token: str, definition_code: str | None = None) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page_token = ""
    pages = 0
    while pages < 10:
        pages += 1
        query: dict[str, Any] = {"page_size": 100, "locale": "zh-CN", "user_id_type": "open_id"}
        if definition_code:
            query["definition_code"] = definition_code
        if page_token:
            query["page_token"] = page_token
        url = FEISHU_INITIATED_URL + "?" + urllib.parse.urlencode(query)
        obj = http_json("GET", url, token=access_token)
        if obj.get("code") not in (0, None):
            raise FeishuAPIError(400, obj)
        data = obj.get("data") if isinstance(obj.get("data"), dict) else {}
        batch = data.get("instances") or []
        if isinstance(batch, list):
            items.extend(x for x in batch if isinstance(x, dict))
        if data.get("has_more"):
            if pages == 10 or not data.get('page_token') or data.get('page_token') == page_token:
                raise FeishuAPIError(502, {"msg": "已发起审批超过读取上限，候选不完整，请缩小查询范围"})
            page_token = str(data.get("page_token"))
            continue
        break
    return items


def is_missing_scope(err: FeishuAPIError) -> bool:
    code = err.feishu_code
    try:
        code_int = int(code) if code is not None else None
    except (TypeError, ValueError):
        code_int = None
    if code_int in MISSING_SCOPE_CODES:
        return True
    msg = " ".join(
        str(x)
        for x in (
            err,
            (err.payload or {}).get("msg"),
            (err.payload or {}).get("error"),
            code,
        )
        if x
    )
    if "99991672" in msg:
        return True
    low = msg.lower()
    return "scope" in low and ("denied" in low or "required" in low or "access denied" in low)


def get_tenant_access_token() -> str:
    global _tenant_token, _tenant_token_expires_at
    with _lock:
        if _tenant_token and _tenant_token_expires_at - time.time() > REFRESH_SKEW_SEC:
            return _tenant_token
    ok, err = config_ready()
    if not ok:
        raise FeishuAPIError(500, {"error": err})
    obj = http_json(
        "POST",
        FEISHU_TENANT_TOKEN_URL,
        payload={"app_id": app_id(), "app_secret": app_secret()},
    )
    token = str(obj.get("tenant_access_token") or "")
    if obj.get("code") not in (0, None) or not token:
        raise FeishuAPIError(400, obj if obj else {"error": "获取 tenant_access_token 失败"})
    expire = int(obj.get("expire") or 7200)
    with _lock:
        _tenant_token = token
        _tenant_token_expires_at = time.time() + max(expire, 60)
    return token


def extract_contact_ids(value: Any) -> set[str]:
    """Collect open_id / user_id strings from a contact widget value."""
    ids: set[str] = set()

    def add(raw: Any) -> None:
        s = str(raw or "").strip()
        if s:
            ids.add(s)

    if value is None or value == "":
        return ids
    if isinstance(value, str):
        stripped = value.strip()
        if stripped[:1] in ("{", "["):
            try:
                return extract_contact_ids(json.loads(stripped))
            except json.JSONDecodeError:
                add(stripped)
                return ids
        add(stripped)
        return ids
    if isinstance(value, dict):
        for key in ("open_id", "openId", "user_id", "userId", "id"):
            if value.get(key) not in (None, ""):
                add(value.get(key))
        inner = value.get("value")
        if inner is not None and inner is not value:
            ids |= extract_contact_ids(inner)
        return ids
    if isinstance(value, list):
        for item in value:
            ids |= extract_contact_ids(item)
        return ids
    add(value)
    return ids


def collect_scope_ids_from_form(form_raw: Any) -> set[str]:
    form: Any = form_raw
    if isinstance(form_raw, str) and form_raw.strip():
        try:
            form = json.loads(form_raw)
        except json.JSONDecodeError:
            return set()
    ids: set[str] = set()
    for widget in iter_widgets(form):
        name = str(widget.get("name") or "").strip()
        wtype = str(widget.get("type") or "")
        if name in SCOPE_FIELD_NAMES or (
            wtype == "contact" and ("负责人" in name or "参与人" in name)
        ):
            ids |= extract_contact_ids(widget.get("value"))
    return ids


def initiator_ids(*sources: Any) -> set[str]:
    ids: set[str] = set()
    for src in sources:
        if not isinstance(src, dict):
            continue
        for key in ("open_id", "openId", "user_id", "userId", "union_id", "unionId"):
            val = str(src.get(key) or "").strip()
            if val:
                ids.add(val)
    return ids


def logged_in_user_ids(user: dict[str, Any] | None) -> set[str]:
    return initiator_ids(user or {})


_IDENTITY_KEY_GROUPS = (
    ("open_id", "openId"),
    ("user_id", "userId"),
    ("union_id", "unionId"),
)


def harvest_identity_pairs(node: Any, id_map: dict[str, set[str]] | None = None) -> dict[str, set[str]]:
    """Record aliases when a dict lists more than one of open_id / user_id / union_id.

    Approval contact widgets keep tenant user_id values even if the get-instance
    call asked for open_id. Timeline, task_list and cc_user_list often include
    both IDs for the same person, which lets a logged-in open_id match
    项目参与人 / 项目负责人.
    """
    if id_map is None:
        id_map = {}

    def link(ids: list[str]) -> None:
        uniq = []
        for item in ids:
            if item and item not in uniq:
                uniq.append(item)
        for a in uniq:
            bucket = id_map.setdefault(a, set())
            for b in uniq:
                if a != b:
                    bucket.add(b)

    def walk(cur: Any) -> None:
        if isinstance(cur, dict):
            found: list[str] = []
            for group in _IDENTITY_KEY_GROUPS:
                for key in group:
                    val = str(cur.get(key) or "").strip()
                    if val:
                        found.append(val)
                        break
            if len(found) >= 2:
                link(found)
            for val in cur.values():
                walk(val)
        elif isinstance(cur, list):
            for item in cur:
                walk(item)

    walk(node)
    return id_map


def expand_user_ids_with_map(user_ids: set[str], id_map: dict[str, set[str]]) -> set[str]:
    """Expand a user's known IDs with aliases discovered from instance payloads."""
    out = {item for item in user_ids if item}
    queue = list(out)
    while queue:
        cur = queue.pop()
        for alias in id_map.get(cur, ()):
            if alias and alias not in out:
                out.add(alias)
                queue.append(alias)
    return out


def user_in_budget_scope(
    user_ids: set[str],
    detail: dict[str, Any] | None,
    inst_node: dict[str, Any] | None = None,
) -> bool:
    """True if the logged-in user initiated the instance or is in scope fields."""
    if not user_ids:
        return False
    if user_ids & initiator_ids(detail or {}, inst_node or {}):
        return True
    scope_ids = collect_scope_ids_from_form((detail or {}).get("form"))
    return bool(user_ids & scope_ids)


def _is_time_window_error(err: FeishuAPIError) -> bool:
    msg = " ".join(
        str(x)
        for x in (err, (err.payload or {}).get("msg"), (err.payload or {}).get("error"))
        if x
    )
    keys = (
        "不得大于 30",
        "不得大于30",
        "大于 30 天",
        "大于30天",
        "时间跨度",
        "time span",
        "time window",
        "instance_start_time",
    )
    return any(k in msg for k in keys)


def _query_instances_page(
    token: str,
    approval_code: str,
    page_token: str = "",
    extra_body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    query: dict[str, Any] = {"page_size": 100, "user_id_type": "open_id"}
    if page_token:
        query["page_token"] = page_token
    url = FEISHU_QUERY_URL + "?" + urllib.parse.urlencode(query)
    body: dict[str, Any] = {
        "approval_code": approval_code,
        "instance_status": "APPROVED",
        "locale": "zh-CN",
    }
    if extra_body:
        body.update(extra_body)
    obj = http_json("POST", url, token=token, payload=body)
    if obj.get("code") not in (0, None):
        raise FeishuAPIError(400, obj)
    return obj.get("data") if isinstance(obj.get("data"), dict) else {}


def _paginate_query(
    token: str,
    approval_code: str,
    extra_body: dict[str, Any] | None = None,
    max_pages: int = 50,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page_token = ""
    pages = 0
    while pages < max_pages:
        pages += 1
        data = _query_instances_page(token, approval_code, page_token, extra_body)
        batch = data.get("instance_list") or []
        if isinstance(batch, list):
            items.extend(x for x in batch if isinstance(x, dict))
        if data.get("has_more") and data.get("page_token"):
            page_token = str(data.get("page_token"))
            continue
        break
    return items


def _query_approved_in_chunks(token: str, approval_code: str, years: int = 2) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    now_ms = int(time.time() * 1000)
    window_ms = 30 * 24 * 3600 * 1000
    start_ms = now_ms - years * 365 * 24 * 3600 * 1000
    cursor = start_ms
    while cursor <= now_ms:
        end = min(cursor + window_ms - 1, now_ms)
        batch = _paginate_query(
            token,
            approval_code,
            {
                "instance_start_time_from": str(cursor),
                "instance_start_time_to": str(end),
            },
            max_pages=20,
        )
        for item in batch:
            inst = item.get("instance") if isinstance(item.get("instance"), dict) else {}
            code = str(inst.get("code") or item.get("instance_code") or "")
            if code and code in seen:
                continue
            if code:
                seen.add(code)
            items.append(item)
        cursor = end + 1
    return items


def query_approved_instances(token: str, approval_code: str) -> list[dict[str, Any]]:
    """List approved instances of one approval definition via tenant query API."""
    try:
        return _paginate_query(token, approval_code)
    except FeishuAPIError as e:
        if is_missing_scope(e):
            raise
        if _is_time_window_error(e):
            return _query_approved_in_chunks(token, approval_code)
        raise



def query_cc_instances(token: str, approval_code: str, actor: dict[str, Any] | str) -> list[dict[str, Any]]:
    """List approved instances carbon-copied to the learner. Fail closed if every endpoint errors."""
    user_id = actor if isinstance(actor, str) else (actor.get('openId') or actor.get('open_id') or actor.get('userId') or '')
    if not user_id:
        return []
    query = urllib.parse.urlencode({"page_size": 100, "user_id_type": "open_id"})
    payload = {
        "user_id": user_id,
        "approval_code": approval_code,
        "instance_status": "APPROVED",
        "locale": "zh-CN",
    }
    urls = (
        "https://open.feishu.cn/open-apis/approval/v4/instances/search/cc?" + query,
        "https://open.feishu.cn/open-apis/approval/v4/tasks/query?" + query,
    )
    items: list[dict[str, Any]] = []
    last_error = None
    for url in urls:
        try:
            body = dict(payload)
            if 'tasks/query' in url:
                body = {"user_id": user_id, "topic": "CC", "approval_code": approval_code}
            obj = http_json("POST", url, token=token, payload=body)
            if obj.get("code") not in (0, None):
                last_error = obj
                continue
            data = obj.get("data") if isinstance(obj.get("data"), dict) else {}
            batch = data.get("instance_list") or data.get("cc_list") or data.get("tasks") or data.get("items") or []
            if isinstance(batch, list):
                items.extend(x for x in batch if isinstance(x, dict))
            if items or obj.get("code") in (0, None):
                return items
        except Exception as exc:
            last_error = exc
            continue
    if last_error is not None:
        message = str(last_error)[:300] if not isinstance(last_error, FeishuAPIError) else str(last_error)
        raise FeishuAPIError(502, {"code": -1, "msg": f"抄送列表读取失败，不能把抄送学习标记为已完成：{message}"})
    return items


def list_user_departments(access_token: str, open_id: str) -> list[dict[str, str]]:
    """Departments the current OAuth user belongs to, for 提交人所属部门."""
    if not open_id:
        return []
    query = urllib.parse.urlencode({"user_id_type": "open_id", "department_id_type": "open_department_id"})
    obj = http_json("GET", f"https://open.feishu.cn/open-apis/contact/v3/users/{urllib.parse.quote(open_id)}?{query}", token=access_token)
    if obj.get("code") not in (0, None):
        raise FeishuAPIError(400, obj)
    user = (obj.get("data") or {}).get("user") or {}
    dept_ids = [str(x) for x in (user.get("department_ids") or user.get("orders") or []) if x]
    if user.get("department_ids") is None and isinstance(user.get("orders"), list):
        dept_ids = [str(item.get("department_id") or item) for item in user["orders"] if item]
    departments: list[dict[str, str]] = []
    for dept_id in dict.fromkeys(dept_ids):
        if not dept_id or dept_id in {x.get("id") for x in departments}:
            continue
        try:
            detail = http_json(
                "GET",
                "https://open.feishu.cn/open-apis/contact/v3/departments/"
                + urllib.parse.quote(dept_id)
                + "?"
                + urllib.parse.urlencode({"department_id_type": "open_department_id"}),
                token=access_token,
            )
            name = ((detail.get("data") or {}).get("department") or {}).get("name") or dept_id
        except Exception:
            name = dept_id
        departments.append({"id": dept_id, "name": str(name)})
    return departments



def fetch_instance(access_token: str, instance_id: str) -> dict[str, Any]:
    url = FEISHU_INSTANCE_URL.format(instance_id=urllib.parse.quote(instance_id, safe=""))
    url += "?locale=zh-CN&user_id_type=open_id"
    obj = http_json("GET", url, token=access_token)
    if obj.get("code") not in (0, None):
        raise FeishuAPIError(400, obj)
    data = obj.get("data") if isinstance(obj.get("data"), dict) else {}
    return data


def _friendly_item(inst: dict[str, Any], detail: dict[str, Any] | None) -> dict[str, Any]:
    code = str(
        inst.get("definition_code")
        or (detail or {}).get("approval_code")
        or ""
    )
    name = str(
        inst.get("definition_name")
        or (detail or {}).get("approval_name")
        or ""
    )
    kind = kind_for_code(code, name)
    summaries = summaries_to_map(inst.get("summaries"))
    fields: dict[str, Any] = dict(summaries)
    subjects: list[dict[str, Any]] = []
    if detail:
        parsed_fields, subjects = parse_form(detail.get("form"))
        for k, v in parsed_fields.items():
            if v not in (None, ""):
                fields[k] = v
    project = (
        fields.get("项目名称")
        or summaries.get("项目名称")
        or fields.get("事由")
        or ""
    )
    title_bits = [name or "审批"]
    if project and str(project) not in title_bits:
        title_bits.append(str(project))
    title = " · ".join(title_bits)
    total = None
    for key in ("项目总预算", "变更后总预算", "变更后预算总金额", "金额"):
        total = parse_amount(fields.get(key))
        if total is not None:
            break
    if total is None and subjects:
        nums = [s.get("amount") for s in subjects if isinstance(s.get("amount"), (int, float))]
        if nums:
            total = round(sum(float(x) for x in nums), 2)
    start = ""
    if detail:
        start = fmt_ts(detail.get("start_time"))
        if fields.get("DateInterval"):
            start = start or str(fields.get("DateInterval"))
    instance_code = str(inst.get("instance_code") or (detail or {}).get("instance_code") or "")
    status = inst.get("instance_status")
    if detail and detail.get("status"):
        status = detail.get("status")
    return {
        "instanceId": instance_code,
        "instanceCode": instance_code,
        "approvalCode": code,
        "approvalName": name,
        "kind": kind,
        "status": status,
        "title": title,
        "project": project,
        "serialId": str((detail or {}).get("serial_number") or inst.get("serial_id") or ""),
        "startTime": start,
        "totalAmount": total,
        "subjects": subjects,
        "kindLabel": KIND_LABELS.get(kind, name or ""),
        "description": str(
            fields.get("项目描述")
            or fields.get("预算变更说明")
            or ""
        ),
        "fields": fields,
    }


def list_approved_budgets(user: dict[str, Any] | None, *, refresh: bool = False) -> tuple[list[dict[str, Any]], str]:
    """Return approved 立项/变更 budgets in the logged-in user's scope.

    Uses tenant_access_token + instances/query. Never falls back to the
    user-initiated list (which mixed in 出差申请). Fetches instance details
    in parallel and caches per-user results briefly.
    """
    user_ids = logged_in_user_ids(user)
    if not user_ids:
        return [], "无法识别登录用户的飞书身份，请重新用飞书登录"
    cache_key = _budget_cache_key(user)
    now = time.time()
    if cache_key and not refresh:
        with _budget_cache_lock:
            hit = _budget_cache.get(cache_key)
            if hit and hit[0] > now:
                budgets, warning = hit[1], hit[2]
                return [dict(b) for b in budgets], warning
    try:
        token = get_tenant_access_token()
    except FeishuAPIError as e:
        if is_missing_scope(e):
            return [], MISSING_SCOPE_WARNING
        return [], f"读取预算失败: {e}"

    collected: list[dict[str, Any]] = []
    seen: set[str] = set()
    pending: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any], str]] = []
    id_map: dict[str, set[str]] = {}
    try:
        for defn in BUDGET_DEFINITIONS:
            try:
                batch = query_approved_instances(token, defn["approval_code"])
            except FeishuAPIError as e:
                if is_missing_scope(e):
                    return [], MISSING_SCOPE_WARNING
                raise
            for item in batch:
                inst_node = item.get("instance") if isinstance(item.get("instance"), dict) else item
                approval_node = item.get("approval") if isinstance(item.get("approval"), dict) else {}
                instance_code = str(
                    inst_node.get("code")
                    or inst_node.get("instance_code")
                    or item.get("instance_code")
                    or ""
                )
                if not instance_code or instance_code in seen:
                    continue
                seen.add(instance_code)
                pending.append((defn, approval_node, inst_node, instance_code))

        details_by_code: dict[str, dict[str, Any]] = {}
        missing_scope = False
        fetch_error: FeishuAPIError | None = None

        def _fetch(code: str) -> tuple[str, dict[str, Any] | None, FeishuAPIError | None]:
            try:
                return code, fetch_instance(token, code), None
            except FeishuAPIError as err:
                return code, None, err

        with ThreadPoolExecutor(max_workers=_BUDGET_FETCH_WORKERS) as pool:
            futures = [pool.submit(_fetch, code) for *_, code in pending]
            for fut in as_completed(futures):
                code, detail, err = fut.result()
                if err is not None:
                    if is_missing_scope(err):
                        missing_scope = True
                        break
                    sys.stderr.write(f"instance detail failed {code}: {err}\n")
                    fetch_error = err
                    continue
                if detail is not None:
                    details_by_code[code] = detail
        if missing_scope:
            return [], MISSING_SCOPE_WARNING
        if fetch_error is not None:
            return [], '读取预算详情失败，候选不完整，请检查应用读取权限后刷新；不能视为没有可用申请'

        candidates: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any], str, dict[str, Any], Any]] = []
        for defn, approval_node, inst_node, instance_code in pending:
            detail = details_by_code.get(instance_code)
            if not detail:
                continue
            status = detail.get("status") if detail.get("status") is not None else inst_node.get("status")
            if not is_approved_status(status):
                continue
            harvest_identity_pairs(detail, id_map)
            harvest_identity_pairs(inst_node, id_map)
            candidates.append((defn, approval_node, inst_node, instance_code, detail, status))

        user_ids = expand_user_ids_with_map(user_ids, id_map)
        for defn, approval_node, inst_node, instance_code, detail, status in candidates:
            if not user_in_budget_scope(user_ids, detail, inst_node):
                continue
            inst = {
                "instance_code": instance_code,
                "definition_code": (
                    approval_node.get("code")
                    or detail.get("approval_code")
                    or defn["approval_code"]
                ),
                "definition_name": (
                    approval_node.get("name")
                    or detail.get("approval_name")
                    or defn["name"]
                ),
                "instance_status": status,
                "serial_id": inst_node.get("serial_id") or detail.get("serial_number"),
            }
            collected.append(_friendly_item(inst, detail))
    except FeishuAPIError as e:
        if is_missing_scope(e):
            return [], MISSING_SCOPE_WARNING
        return [], f"读取预算失败: {e}"
    collected.sort(
        key=lambda b: (str(b.get("startTime") or ""), str(b.get("project") or "")),
        reverse=True,
    )
    warning = ""
    if cache_key:
        with _budget_cache_lock:
            _budget_cache[cache_key] = (
                time.time() + BUDGET_CACHE_TTL_SEC,
                [dict(b) for b in collected],
                warning,
            )
    return collected, warning



def cookie_from_headers(headers: Any) -> str:
    raw = headers.get("Cookie") if headers is not None else ""
    if not raw:
        return ""
    jar = SimpleCookie()
    try:
        jar.load(raw)
    except Exception:
        return ""
    morsel = jar.get(COOKIE_NAME)
    return morsel.value if morsel else ""


def build_set_cookie(value: str, *, max_age: int, secure: bool) -> str:
    parts = [
        f"{COOKIE_NAME}={value}",
        "HttpOnly",
        "Path=/",
        "SameSite=Lax",
        f"Max-Age={max(0, int(max_age))}",
    ]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def clear_set_cookie(secure: bool) -> str:
    return build_set_cookie("", max_age=0, secure=secure)


def request_is_https(handler: Any) -> bool:
    proto = (handler.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
    if proto == "https":
        return True
    if getattr(handler, "is_https", False):
        return True
    return False


def public_user(sess: dict[str, Any] | None) -> dict[str, Any] | None:
    if not sess:
        return None
    user = sess.get("user") if isinstance(sess.get("user"), dict) else {}
    if not user:
        return None
    return {
        "name": user.get("name") or "飞书用户",
        "enName": user.get("enName") or "",
        "openId": user.get("openId") or "",
        "avatar": user.get("avatar") or "",
    }


def send_redirect(handler: Any, location: str, set_cookie: str | None = None) -> None:
    handler.send_response(302)
    handler._cors()
    if set_cookie:
        handler.send_header("Set-Cookie", set_cookie)
    handler.send_header("Location", location)
    handler.send_header("Content-Length", "0")
    handler.end_headers()


def handle_login(handler: Any) -> None:
    ok, err = config_ready()
    if not ok:
        handler._json(500, {"ok": False, "error": err})
        return
    state = new_oauth_state()
    send_redirect(handler, authorize_url(state))


def handle_callback(handler: Any, qs: dict[str, list[str]]) -> None:
    origin = web_origin()
    err = (qs.get("error") or [""])[0]
    if err:
        send_redirect(handler, f"{origin}/?auth_error={urllib.parse.quote(err)}")
        return
    code = (qs.get("code") or [""])[0]
    state = (qs.get("state") or [""])[0]
    if not code:
        send_redirect(handler, f"{origin}/?auth_error={urllib.parse.quote('missing_code')}")
        return
    if not consume_oauth_state(state):
        send_redirect(handler, f"{origin}/?auth_error={urllib.parse.quote('invalid_state')}")
        return
    try:
        token_obj = exchange_code(code)
        user = fetch_user_info(token_obj["access_token"])
    except FeishuAPIError as e:
        send_redirect(handler, f"{origin}/?auth_error={urllib.parse.quote(str(e)[:180])}")
        return
    except Exception as e:
        send_redirect(handler, f"{origin}/?auth_error={urllib.parse.quote('login_failed')}")
        sys.stderr.write(f"oauth callback failed: {e}\n")
        return
    sid = secrets.token_urlsafe(32)
    save_session(sid, tokens_to_session(token_obj, user))
    cookie = build_set_cookie(sid, max_age=SESSION_COOKIE_MAX_AGE, secure=request_is_https(handler) or True)
    send_redirect(handler, f"{origin}/?logged_in=1", set_cookie=cookie)


def handle_me(handler: Any) -> None:
    sid = cookie_from_headers(handler.headers)
    sess = get_session(sid)
    if not sess:
        handler._json(200, {"ok": True, "loggedIn": False})
        return
    try:
        sess = ensure_fresh_session(sid, sess)
    except FeishuAPIError:
        delete_session(sid)
        handler._json(
            200,
            {
                "ok": True,
                "loggedIn": False,
                "error": "登录已过期，请重新登录",
            },
            extra_headers={"Set-Cookie": clear_set_cookie(request_is_https(handler))},
        )
        return
    handler._json(200, {"ok": True, "loggedIn": True, "user": public_user(sess)})



def handle_departments(handler: Any) -> None:
    sid = cookie_from_headers(handler.headers)
    sess = get_session(sid)
    if not sess:
        handler._json(401, {"ok": False, "loggedIn": False, "error": "未登录", "departments": []})
        return
    try:
        sess = ensure_fresh_session(sid, sess)
        open_id = (sess.get("user") or {}).get("openId") or ""
        departments = list_user_departments(sess.get("access_token") or "", open_id)
        handler._json(200, {"ok": True, "departments": departments})
    except FeishuAPIError as e:
        status = 403 if is_missing_scope(e) else (e.http_status if e.http_status in (401, 403) else 502)
        handler._json(status, {"ok": False, "error": "暂时无法读取提交人所属部门，请检查通讯录权限后重试", "departments": []})


def handle_logout(handler: Any) -> None:
    sid = cookie_from_headers(handler.headers)
    delete_session(sid)
    handler._json(
        200,
        {"ok": True, "loggedIn": False},
        extra_headers={"Set-Cookie": clear_set_cookie(request_is_https(handler))},
    )


def handle_budgets(handler: Any) -> None:
    sid = cookie_from_headers(handler.headers)
    sess = get_session(sid)
    if not sess:
        handler._json(401, {"ok": False, "loggedIn": False, "error": "未登录", "budgets": []})
        return
    try:
        sess = ensure_fresh_session(sid, sess)
    except FeishuAPIError:
        delete_session(sid)
        handler._json(
            401,
            {"ok": False, "loggedIn": False, "error": "登录已过期，请重新登录", "budgets": []},
            extra_headers={"Set-Cookie": clear_set_cookie(request_is_https(handler))},
        )
        return
    user = sess.get("user") if isinstance(sess.get("user"), dict) else {}
    try:
        refresh = urllib.parse.parse_qs(urllib.parse.urlsplit(handler.path).query).get('refresh') == ['1']
        budgets, warning = list_approved_budgets(user, refresh=refresh)
    except FeishuAPIError as e:
        handler._json(
            200,
            {
                "ok": False,
                "loggedIn": True,
                "budgets": [],
                "error": f"读取预算失败: {e}",
                "user": public_user(sess),
            },
        )
        return
    body: dict[str, Any] = {
        "ok": not warning,
        "loggedIn": True,
        "budgets": budgets,
        "user": public_user(sess),
    }
    if warning:
        body["warning"] = warning
        body["error"] = warning
        body["ok"] = False
    else:
        body["ok"] = True
    handler._json(200, body)
