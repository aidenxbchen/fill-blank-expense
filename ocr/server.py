#!/usr/bin/env python3
"""
Local OCR bridge for fill-blank-expense.

POST multipart invoice image → Xiaomi-OCR via Ollama OpenAI-compatible API
→ JSON fields for the web app.

Stdlib only. Bind: 127.0.0.1:8788
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = 8788

DEFAULT_OLLAMA = "http://127.0.0.1:11434/v1"
DEFAULT_MODEL = "longwayxu/xiaomi-ocr-0:bf16"

ALLOWED_IMAGE_TYPES = {
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/bmp",
}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}

OCR_PROMPT = """你是中国发票关键信息抽取（KIE）助手。请从这张发票/收据图片中提取字段，只输出一个 JSON 对象，不要 Markdown，不要解释。

键与要求：
- amount: number，价税合计金额（人民币元），不要货币符号
- merchant: string，商户/开票方名称
- date: string，开票或消费日期，格式 YYYY-MM-DD；无法识别则用空字符串
- category: 仅允许 lodging | meal | other
  - lodging = 住宿/酒店
  - meal = 餐饮/饭店
  - other = 交通或其他
- confidence: number 0 到 1，对本次抽取整体把握

只输出 JSON，例如：
{"amount":128.5,"merchant":"某某酒店","date":"2026-11-03","category":"lodging","confidence":0.86}
"""


def ollama_base() -> str:
    return (os.environ.get("XIAOMI_OCR_LOCAL_URL") or DEFAULT_OLLAMA).rstrip("/")


def ollama_model() -> str:
    return os.environ.get("XIAOMI_OCR_MODEL") or DEFAULT_MODEL


def guess_mime(filename: str, content_type: str | None) -> str:
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct in ALLOWED_IMAGE_TYPES or ct == "application/pdf":
        return ct
    name = (filename or "").lower()
    if name.endswith(".pdf"):
        return "application/pdf"
    for ext, mime in (
        (".jpg", "image/jpeg"),
        (".jpeg", "image/jpeg"),
        (".png", "image/png"),
        (".webp", "image/webp"),
        (".gif", "image/gif"),
        (".bmp", "image/bmp"),
    ):
        if name.endswith(ext):
            return mime
    return ct or "application/octet-stream"


def parse_multipart(body: bytes, content_type: str) -> list[dict[str, Any]]:
    """Parse multipart/form-data into list of {name, filename, content_type, data}."""
    if "multipart/form-data" not in content_type.lower():
        raise ValueError("Content-Type must be multipart/form-data")
    # email parser needs a full MIME message header
    header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
    msg = BytesParser(policy=policy.default).parsebytes(header + body)
    parts: list[dict[str, Any]] = []
    if not msg.is_multipart():
        return parts
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        filename = part.get_filename()
        ctype = part.get_content_type()
        payload = part.get_payload(decode=True)
        if payload is None:
            continue
        parts.append(
            {
                "name": name,
                "filename": filename or "",
                "content_type": ctype,
                "data": payload,
            }
        )
    return parts


def extract_file_part(parts: list[dict[str, Any]]) -> dict[str, Any]:
    preferred = ("file", "image", "invoice", "upload")
    for key in preferred:
        for p in parts:
            if (p.get("name") or "").lower() == key and p.get("data"):
                return p
    for p in parts:
        if p.get("filename") and p.get("data"):
            return p
    for p in parts:
        if p.get("data"):
            return p
    raise ValueError("multipart 中未找到文件字段（期望 name=file）")


def strip_json_fences(text: str) -> str:
    t = (text or "").strip()
    if not t:
        return t
    # ```json ... ``` or ``` ... ```
    fence = re.search(r"```(?:json|JSON)?\s*([\s\S]*?)```", t)
    if fence:
        return fence.group(1).strip()
    # leading/trailing prose: take first {...} object
    start = t.find("{")
    end = t.rfind("}")
    if start != -1 and end != -1 and end > start:
        return t[start : end + 1]
    return t


def coerce_fields(obj: dict[str, Any]) -> dict[str, Any]:
    amount_raw = obj.get("amount", 0)
    try:
        if isinstance(amount_raw, str):
            amount_raw = amount_raw.replace("¥", "").replace(",", "").replace("元", "").strip()
        amount = float(amount_raw)
    except (TypeError, ValueError):
        raise ValueError("模型返回的 amount 无法解析为数字") from None

    merchant = obj.get("merchant")
    if merchant is None:
        merchant = ""
    merchant = str(merchant).strip()

    date = obj.get("date")
    if date is None:
        date = ""
    date = str(date).strip()
    # normalize common CN date forms lightly
    m = re.match(r"^(\d{4})[./年-](\d{1,2})[./月-](\d{1,2})", date)
    if m:
        date = f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    elif not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        date = date  # leave as-is; app may use dayDate

    cat = str(obj.get("category") or "other").strip().lower()
    if cat not in ("lodging", "meal", "other"):
        # map common Chinese labels
        if any(k in cat for k in ("住宿", "酒店", "hotel", "lodg")):
            cat = "lodging"
        elif any(k in cat for k in ("餐饮", "餐", "饭", "meal", "food")):
            cat = "meal"
        else:
            cat = "other"

    conf_raw = obj.get("confidence", 0.5)
    try:
        confidence = float(conf_raw)
    except (TypeError, ValueError):
        confidence = 0.5
    confidence = max(0.0, min(1.0, confidence))

    return {
        "amount": amount,
        "merchant": merchant,
        "date": date,
        "category": cat,
        "confidence": confidence,
        "source": "xiaomi-ocr-0",
    }


def call_ollama_vision(image_b64: str, mime: str) -> tuple[dict[str, Any], str]:
    url = f"{ollama_base()}/chat/completions"
    # data URL so vision models that expect OpenAI image_url work
    data_url = f"data:{mime};base64,{image_b64}"
    payload = {
        "model": ollama_model(),
        "temperature": 0,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": OCR_PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise RuntimeError(f"Ollama HTTP {e.code}: {err_body[:500] or e.reason}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"无法连接 Ollama（{ollama_base()}）: {e.reason}") from e

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Ollama 返回非 JSON: {raw[:300]}") from e

    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"Ollama 响应缺少 choices.message.content: {raw[:400]}") from e

    if isinstance(content, list):
        # some APIs return content parts
        texts = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                texts.append(part.get("text") or "")
            elif isinstance(part, str):
                texts.append(part)
        content = "\n".join(texts)

    if not isinstance(content, str):
        content = str(content)

    cleaned = strip_json_fences(content)
    try:
        obj = json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"模型输出不是合法 JSON: {cleaned[:400]}") from e
    if not isinstance(obj, dict):
        raise RuntimeError("模型 JSON 根节点必须是对象")

    fields = coerce_fields(obj)
    return fields, content


def probe_ollama() -> bool:
    # Prefer /api/tags (native) falling back to models list
    candidates = [
        ollama_base().replace("/v1", "") + "/api/tags",
        ollama_base() + "/models",
    ]
    for u in candidates:
        try:
            req = urllib.request.Request(u, method="GET", headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=3) as resp:
                if 200 <= resp.status < 300:
                    return True
        except Exception:
            continue
    return False


class Handler(BaseHTTPRequestHandler):
    server_version = "FillBlankOCR/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self) -> None:
        origin = self.headers.get("Origin") or "*"
        # Allow localhost static servers (any port) and file:// often sends null
        if origin in ("null",) or origin.startswith("http://127.0.0.1") or origin.startswith(
            "http://localhost"
        ):
            self.send_header("Access-Control-Allow-Origin", origin)
        else:
            self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:5173")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Accept",
        )
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Vary", "Origin")

    def _json(self, status: int, obj: dict[str, Any]) -> None:
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/health":
            reachable = probe_ollama()
            self._json(
                200,
                {
                    "ok": True,
                    "backend": "ollama-openai-compat",
                    "model": ollama_model(),
                    "ollamaReachable": reachable,
                    "endpoint": ollama_base(),
                },
            )
            return
        if path in ("/", "/api"):
            self._json(
                200,
                {
                    "service": "fill-blank-expense OCR bridge",
                    "endpoints": ["GET /api/health", "POST /api/parse-invoice"],
                },
            )
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        # Explicitly refuse silent money invention; ?fallback=mock is acknowledged but not implemented
        if "fallback" in qs and qs["fallback"] and qs["fallback"][0] == "mock":
            # Still do not invent amounts — document via error that mock is app-side only
            pass

        if path != "/api/parse-invoice":
            self._json(404, {"ok": False, "error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = 0
        if length <= 0:
            self._json(400, {"ok": False, "error": "空请求体"})
            return
        if length > 25 * 1024 * 1024:
            self._json(413, {"ok": False, "error": "文件过大（上限 25MB）"})
            return

        body = self.rfile.read(length)
        ctype = self.headers.get("Content-Type") or ""

        try:
            if "multipart/form-data" in ctype.lower():
                parts = parse_multipart(body, ctype)
                part = extract_file_part(parts)
                filename = part.get("filename") or "upload"
                mime = guess_mime(filename, part.get("content_type"))
                data = part["data"]
            elif ctype.lower().startswith("application/json"):
                # optional: { "image_base64": "...", "mime": "image/png", "filename": "..." }
                meta = json.loads(body.decode("utf-8"))
                b64 = meta.get("image_base64") or meta.get("base64")
                if not b64:
                    raise ValueError("JSON 需含 image_base64")
                data = base64.b64decode(b64)
                filename = meta.get("filename") or "upload.png"
                mime = guess_mime(filename, meta.get("mime") or meta.get("content_type"))
            else:
                # raw body as image bytes
                filename = self.headers.get("X-Filename") or "upload"
                mime = guess_mime(filename, ctype)
                data = body
        except Exception as e:
            self._json(400, {"ok": False, "error": f"无法解析上传内容: {e}"})
            return

        if mime == "application/pdf" or (filename or "").lower().endswith(".pdf"):
            self._json(
                415,
                {
                    "ok": False,
                    "error": (
                        "当前桥接以图片为主，暂不在 stdlib 内解析 PDF 首页。"
                        "请先将 PDF 转为 PNG/JPEG（或导出首页图片）后再上传。"
                    ),
                },
            )
            return

        if mime not in ALLOWED_IMAGE_TYPES:
            # still try if looks like image by magic
            if data[:3] == b"\xff\xd8\xff":
                mime = "image/jpeg"
            elif data[:8] == b"\x89PNG\r\n\x1a\n":
                mime = "image/png"
            elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
                mime = "image/webp"
            else:
                self._json(
                    415,
                    {
                        "ok": False,
                        "error": f"不支持的类型 {mime or 'unknown'}；请上传 JPEG/PNG/WebP 图片",
                    },
                )
                return

        try:
            b64 = base64.b64encode(data).decode("ascii")
            fields, raw_text = call_ollama_vision(b64, mime)
        except Exception as e:
            self._json(
                502,
                {
                    "ok": False,
                    "error": str(e),
                    "message": str(e),
                },
            )
            return

        # include raw model text optionally for debugging
        out = dict(fields)
        out["raw"] = raw_text
        out["ok"] = True
        self._json(200, out)


def main() -> None:
    addr = (HOST, PORT)
    httpd = ThreadingHTTPServer(addr, Handler)
    print(
        f"fill-blank-expense OCR bridge on http://{HOST}:{PORT}\n"
        f"  model={ollama_model()}\n"
        f"  ollama={ollama_base()}\n"
        f"  GET  /api/health\n"
        f"  POST /api/parse-invoice (multipart file=...)",
        flush=True,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)


if __name__ == "__main__":
    main()
