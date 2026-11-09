"""Per-user OpenAI-compatible API settings, stored next to expense data."""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import time
from typing import Any

import ai_client
import expense_data as data

MAX_BASE = 300
MAX_MODEL = 120
MAX_KEY = 512


class SettingsError(ValueError):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def _secret_material() -> str:
    env = (os.environ.get("BAOXIAO_SECRETS_KEY") or os.environ.get("FEISHU_APP_SECRET") or "").strip()
    if env:
        return env
    path = data.ROOT / ".baoxiao-secrets-key"
    if path.is_file():
        return path.read_text(encoding="utf-8").strip()
    token = secrets.token_hex(32)
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(token)
    os.chmod(path, 0o600)
    return token


def _fernet_key() -> bytes:
    return hashlib.sha256(b"baoxiao-ai-settings:" + _secret_material().encode("utf-8")).digest()


def encrypt_secret(plain: str) -> str:
    raw = (plain or "").encode("utf-8")
    nonce = os.urandom(16)
    key = _fernet_key()
    stream = b""
    n = 0
    while len(stream) < len(raw):
        stream += hmac.new(key, nonce + n.to_bytes(4, "big"), hashlib.sha256).digest()
        n += 1
    ct = bytes(a ^ b for a, b in zip(raw, stream))
    tag = hmac.new(key, nonce + ct, hashlib.sha256).digest()[:16]
    return base64.urlsafe_b64encode(nonce + tag + ct).decode("ascii")


def decrypt_secret(blob: str) -> str:
    try:
        raw = base64.urlsafe_b64decode((blob or "").encode("ascii"))
    except Exception as e:
        raise SettingsError("保存的密钥已损坏，请重新填写 API Key") from e
    if len(raw) < 32:
        raise SettingsError("保存的密钥已损坏，请重新填写 API Key")
    nonce, tag, ct = raw[:16], raw[16:32], raw[32:]
    key = _fernet_key()
    expect = hmac.new(key, nonce + ct, hashlib.sha256).digest()[:16]
    if not hmac.compare_digest(tag, expect):
        raise SettingsError("无法解密已保存的 API Key，请重新填写")
    stream = b""
    n = 0
    while len(stream) < len(ct):
        stream += hmac.new(key, nonce + n.to_bytes(4, "big"), hashlib.sha256).digest()
        n += 1
    return bytes(a ^ b for a, b in zip(ct, stream)).decode("utf-8")


def ensure_table(con) -> None:
    con.execute(
        """CREATE TABLE IF NOT EXISTS ai_settings (
            owner TEXT PRIMARY KEY,
            base_url TEXT NOT NULL,
            api_key_enc TEXT NOT NULL,
            text_model TEXT NOT NULL,
            vision_model TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
        )"""
    )


def _validate_base(url: str) -> str:
    url = (url or "").strip()
    if not url:
        raise SettingsError("请填写 API Base URL")
    if len(url) > MAX_BASE:
        raise SettingsError("API Base URL 过长")
    try:
        ai_client.join_chat_url(url)
    except ValueError as e:
        raise SettingsError(str(e)) from e
    return url.rstrip("/")


def _validate_model(name: str, *, required: bool) -> str:
    name = (name or "").strip()
    if required and not name:
        raise SettingsError("请填写文本 / 校对模型名称")
    if len(name) > MAX_MODEL:
        raise SettingsError("模型名称过长")
    if name and not re.fullmatch(r"[\w./:+-]{1,120}", name):
        raise SettingsError("模型名称包含不支持的字符")
    return name


def public_view(owner: str) -> dict[str, Any]:
    row = None
    with data.database() as con:
        ensure_table(con)
        row = con.execute("SELECT * FROM ai_settings WHERE owner=?", (owner,)).fetchone()
    settings = {
        "baseUrl": "",
        "apiKeyMasked": "",
        "hasApiKey": False,
        "textModel": "",
        "visionModel": "",
    }
    if row:
        masked = ""
        if row["api_key_enc"]:
            try:
                masked = ai_client.mask_api_key(decrypt_secret(row["api_key_enc"]))
            except SettingsError:
                masked = "***"
        settings = {
            "baseUrl": row["base_url"],
            "apiKeyMasked": masked,
            "hasApiKey": bool(row["api_key_enc"]),
            "textModel": row["text_model"],
            "visionModel": row["vision_model"] or "",
        }
    return {
        "ok": True,
        "configured": bool(row and row["api_key_enc"] and row["base_url"] and row["text_model"]),
        "settings": settings,
        "defaults": ai_client.defaults(),
        "ocrNote": ai_client.OCR_NOTE,
    }


def load_credentials(owner: str | None) -> dict[str, str] | None:
    if not owner:
        return None
    with data.database() as con:
        ensure_table(con)
        row = con.execute("SELECT * FROM ai_settings WHERE owner=?", (owner,)).fetchone()
    if not row or not row["api_key_enc"] or not row["base_url"] or not row["text_model"]:
        return None
    try:
        key = decrypt_secret(row["api_key_enc"])
    except SettingsError:
        return None
    if not key:
        return None
    return {
        "base_url": row["base_url"],
        "api_key": key,
        "model": row["text_model"],
    }


def has_configured(owner: str | None) -> bool:
    return load_credentials(owner) is not None


def save(owner: str, body: dict[str, Any]) -> dict[str, Any]:
    if not owner:
        raise SettingsError("请先用飞书登录", 401)
    if not isinstance(body, dict):
        raise SettingsError("无效的设置内容")
    if body.get("clear") is True:
        with data.database() as con:
            ensure_table(con)
            con.execute("DELETE FROM ai_settings WHERE owner=?", (owner,))
        return public_view(owner)

    base = _validate_base(body.get("baseUrl") or body.get("base_url") or "")
    text_model = _validate_model(body.get("textModel") or body.get("text_model") or "", required=True)
    vision_model = _validate_model(body.get("visionModel") or body.get("vision_model") or "", required=False)
    incoming_key = body.get("apiKey") if "apiKey" in body else body.get("api_key")
    incoming_key = incoming_key.strip() if isinstance(incoming_key, str) else ""

    existing_enc = ""
    with data.database() as con:
        ensure_table(con)
        row = con.execute("SELECT api_key_enc FROM ai_settings WHERE owner=?", (owner,)).fetchone()
        existing_enc = row["api_key_enc"] if row else ""

    if ai_client.looks_masked(incoming_key):
        if not existing_enc:
            raise SettingsError("请填写 API Key")
        enc = existing_enc
    else:
        if not incoming_key:
            raise SettingsError("请填写 API Key")
        if len(incoming_key) > MAX_KEY:
            raise SettingsError("API Key 过长")
        enc = encrypt_secret(incoming_key)

    now = int(time.time())
    with data.database() as con:
        ensure_table(con)
        con.execute(
            """INSERT INTO ai_settings(owner, base_url, api_key_enc, text_model, vision_model, updated_at)
               VALUES(?,?,?,?,?,?)
               ON CONFLICT(owner) DO UPDATE SET
                 base_url=excluded.base_url,
                 api_key_enc=excluded.api_key_enc,
                 text_model=excluded.text_model,
                 vision_model=excluded.vision_model,
                 updated_at=excluded.updated_at""",
            (owner, base, enc, text_model, vision_model, now),
        )
    return public_view(owner)


def test_connection(owner: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    body = body if isinstance(body, dict) else {}
    base = (body.get("baseUrl") or body.get("base_url") or "").strip()
    model = (body.get("textModel") or body.get("text_model") or "").strip()
    key = body.get("apiKey") if "apiKey" in body else body.get("api_key")
    key = key.strip() if isinstance(key, str) else ""
    stored = load_credentials(owner)
    if not base:
        base = (stored or {}).get("base_url") or ""
    if not model:
        model = (stored or {}).get("model") or ""
    if ai_client.looks_masked(key):
        key = (stored or {}).get("api_key") or ""
    if not key and base and ("127.0.0.1" in base or "localhost" in base):
        key = ""
    elif not base or not model or not key:
        raise SettingsError("请先填写 Base URL、API Key 和模型，或先保存后再测试")
    base = _validate_base(base)
    model = _validate_model(model, required=True)
    try:
        content = ai_client.chat_completions(
            base_url=base,
            api_key=key,
            model=model,
            messages=[{"role": "user", "content": "只回复 ok"}],
            timeout=20,
            temperature=0,
        )
    except Exception as e:
        raise SettingsError(ai_client.public_error(e), 502) from e
    preview = (content or "").strip().replace("\n", " ")[:80]
    return {"ok": True, "message": "连接成功", "model": model, "preview": preview}
