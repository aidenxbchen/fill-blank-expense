#!/usr/bin/env python3
"""
Local OCR bridge for fill-blank-expense.

POST multipart invoice → text PDF parse or image OCR, then LLM review
(user-configured OpenAI-compatible API if set, else local Ollama).
See invoice_extract.py and ai_client.py for the pipeline.

Bind: 127.0.0.1:18790
"""

from __future__ import annotations

import base64
import json
import time
import os
import sys
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from feishu_oauth import (
    handle_budgets,
    handle_callback,
    handle_login,
    handle_logout,
    handle_me,
    load_dotenv as load_feishu_dotenv,
)
import feishu_oauth as auth
import invoice_registry
import filling_profiles
import expense_data
import expense_records as records
from feishu_purchase import handle_create, handle_schema, definition, public_schema
import ai_client
import ai_settings
from invoice_extract import (
    ollama_base,
    ollama_model,
    parse_uploaded_invoice,
    probe_ollama,
    review_model,
)

HOST = "127.0.0.1"
PORT = int(os.environ.get("OCR_PORT", "18790"))

ALLOWED_IMAGE_TYPES = {
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/bmp",
    "image/heic",
    "image/heif",
}


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
        (".heic", "image/heic"),
        (".heif", "image/heif"),
    ):
        if name.endswith(ext):
            return mime
    return ct or "application/octet-stream"


def parse_multipart(body: bytes, content_type: str) -> list[dict[str, Any]]:
    """Parse multipart/form-data into list of {name, filename, content_type, data}."""
    if "multipart/form-data" not in content_type.lower():
        raise ValueError("Content-Type must be multipart/form-data")
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


def sniff_image_mime(data: bytes, mime: str) -> str:
    if mime in ALLOWED_IMAGE_TYPES or mime == "application/pdf":
        return mime
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return mime


class Handler(BaseHTTPRequestHandler):
    server_version = "FillBlankOCR/0.2"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self) -> None:
        origin = self.headers.get("Origin") or "*"
        allowed_exact = {
            "null",
            "http://127.0.0.1:5173",
            "https://baoxiao.xbchen.top",
        }
        if (
            origin in allowed_exact
            or origin.startswith("http://127.0.0.1")
            or origin.startswith("http://localhost")
        ):
            self.send_header("Access-Control-Allow-Origin", origin)
        else:
            self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:5173")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Accept",
        )
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Vary", "Origin")

    def _json(
        self,
        status: int,
        obj: dict[str, Any],
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        if self._profiles_request(path):
            return
        if self._ai_settings_request(path):
            return
        if self._records_request(path):
            return
        if path == "/api/auth/feishu/login":
            handle_login(self)
            return
        if path == "/api/auth/feishu/callback":
            handle_callback(self, qs)
            return
        if path == "/api/auth/me":
            handle_me(self)
            return
        if path == "/api/purchase-schema":
            handle_schema(self)
            return
        if path == "/api/budgets":
            handle_budgets(self)
            return
        if path == "/api/invoice-files/by-name":
            try:
                owner = self._owner()
            except auth.FeishuAPIError as e:
                self._json(e.http_status if e.http_status in (401, 403) else 502, {"ok": False, "error": str(e)})
                return
            name = (qs.get("name") or [""])[0]
            try:
                attachment = expense_data.lookup_file(owner, name)
            except expense_data.DataError as e:
                self._json(422, {"ok": False, "error": str(e)})
                return
            if not attachment:
                self._json(404, {"ok": False, "error": "未找到同名已存原件，请补传"})
                return
            self._json(200, {"ok": True, "attachment": attachment})
            return
        if path == "/api/health":
            reachable = probe_ollama()
            self._json(
                200,
                {
                    "ok": True,
                    "backend": "ollama-openai-compat",
                    "features": {
                        "invoiceOriginals": True,
                        "invoiceDedupe": True,
                        "invoiceQuantity": True,
                        "sharedBankProfiles": True,
                        "historySuggestions": True,
                        "draftsAndHistory": True,
                        "userAiConfigurable": True,
                    },
                    "model": ollama_model(),
                    "reviewModel": review_model(),
                    "pipeline": "pdf-text|vision-ocr-text → heuristic → llm-review",
                    "ollamaReachable": reachable,
                    "endpoint": ollama_base(),
                    "userAiConfigurable": True,
                    "aiProviderHint": "deepseek",
                    "recommendedProvider": ai_client.RECOMMENDED_PROVIDER,
                    "recommendedBaseUrl": ai_client.RECOMMENDED_BASE_URL,
                    "recommendedModel": ai_client.RECOMMENDED_MODEL,
                    "ocrNote": ai_client.OCR_NOTE,
                },
            )
            return
        if path in ("/", "/api"):
            self._json(
                200,
                {
                    "service": "fill-blank-expense OCR bridge",
                    "endpoints": [
                        "GET /api/health",
                        "GET /api/auth/feishu/login",
                        "GET /api/auth/feishu/callback",
                        "GET /api/auth/me",
                        "POST /api/auth/logout",
                        "GET /api/budgets",
                        "POST /api/parse-invoice",
                        "GET /api/invoice-files/by-name",
                        "POST /api/feishu-expense",
                        "GET/PUT /api/ai-settings",
                        "POST /api/ai-settings/test",
                    ],
                },
            )
            return
        self._json(404, {"ok": False, "error": "not found"})

    def _owner(self):
        origin = self.headers.get("Origin")
        if origin and origin not in {auth.web_origin(), "http://127.0.0.1:5173", "http://localhost:5173"}:
            raise auth.FeishuAPIError(403, {"error": "上传来源不受信任"})
        sid = auth.cookie_from_headers(self.headers)
        session = auth.get_session(sid)
        if not session: raise auth.FeishuAPIError(401, {"error":"请先用飞书登录"})
        session = auth.ensure_fresh_session(sid, session)
        owner = (session.get("user") or {}).get("openId")
        if not owner: raise auth.FeishuAPIError(401, {"error":"登录身份不完整，请重新登录"})
        return owner

    def do_PUT(self):
        path = urlparse(self.path).path
        if self._profiles_request(path):
            return
        if self._ai_settings_request(path):
            return
        if not self._records_request(path):
            self._json(404, {"ok":False,"error":"not found"})

    do_PATCH = do_PUT
    do_DELETE = do_PUT

    def _profiles_request(self, path):
        if path != '/api/filling-profiles' and not path.startswith('/api/filling-profiles/'): return False
        try:
            owner=self._owner(); parts=path.strip('/').split('/'); ident=parts[2] if len(parts)==3 else None
            if len(parts)>3: raise filling_profiles.ProfileError('接口不存在',404)
            if self.command=='GET' and not ident:
                side=parse_qs(urlparse(self.path).query).get('side',[None])[0]
                self._json(200,{'ok':True,'items':filling_profiles.listing(owner,side)})
            elif self.command in ('POST','PATCH','DELETE'):
                length=int(self.headers.get('Content-Length') or 0)
                if not 0<length<=32768: raise filling_profiles.ProfileError('档案请求为空或过大')
                body=json.loads(self.rfile.read(length))
                if not isinstance(body,dict): raise filling_profiles.ProfileError('无效档案')
                if self.command=='DELETE' and ident:
                    filling_profiles.remove(owner,ident,body.get('revision'));self._json(200,{'ok':True})
                elif (self.command=='POST' and not ident) or (self.command=='PATCH' and ident):
                    session=auth.get_session(auth.cookie_from_headers(self.headers)) or {}
                    name=(session.get('user') or {}).get('name') or '飞书用户'
                    self._json(200,{'ok':True,'profile':filling_profiles.save(owner,name,body,ident)})
                else: raise filling_profiles.ProfileError('此操作不受支持',405)
            else: raise filling_profiles.ProfileError('此操作不受支持',405)
        except auth.FeishuAPIError as e: self._json(e.http_status if e.http_status in (401,403) else 502,{'ok':False,'error':str(e)})
        except filling_profiles.ProfileError as e: self._json(e.status,{'ok':False,'error':str(e)})
        except (ValueError,TypeError,AttributeError): self._json(422,{'ok':False,'error':'档案格式无效'})
        except Exception: self._json(503,{'ok':False,'error':'档案暂不可用，请重试；当前填写仍保留'})
        return True

    def _ai_settings_request(self, path):
        if path not in ("/api/ai-settings", "/api/ai-settings/test"):
            return False
        try:
            owner = self._owner()
            method = self.command
            body = {}
            if method != "GET":
                length = int(self.headers.get("Content-Length") or 0)
                if length < 0 or length > 32 * 1024:
                    raise ai_settings.SettingsError("设置内容过大", 413)
                raw = self.rfile.read(length) if length else b"{}"
                body = json.loads(raw.decode("utf-8") or "{}")
                if not isinstance(body, dict):
                    raise ai_settings.SettingsError("无效的设置内容")
            if path == "/api/ai-settings" and method == "GET":
                self._json(200, ai_settings.public_view(owner))
            elif path == "/api/ai-settings" and method == "PUT":
                self._json(200, ai_settings.save(owner, body))
            elif path == "/api/ai-settings/test" and method == "POST":
                self._json(200, ai_settings.test_connection(owner, body))
            else:
                raise ai_settings.SettingsError("此操作不受支持", 405)
        except auth.FeishuAPIError as e:
            self._json(e.http_status if e.http_status in (401, 403) else 502, {"ok": False, "error": str(e)})
        except ai_settings.SettingsError as e:
            self._json(e.status, {"ok": False, "error": str(e)})
        except json.JSONDecodeError:
            self._json(422, {"ok": False, "error": "设置数据格式不正确"})
        except Exception:
            self._json(503, {"ok": False, "error": "AI 设置暂时不可用，请稍后重试"})
        return True

    def _records_request(self, path):
        if path not in ("/api/drafts", "/api/history") and not path.startswith(("/api/drafts/", "/api/history/")):
            return False
        try:
            owner = self._owner()
            method = self.command
            parts = path.strip('/').split('/')
            kind = parts[1]
            ident = parts[2] if len(parts) >= 3 else None
            action = parts[3] if len(parts) == 4 else None
            if len(parts) > 4 or (action and action != 'delete'):
                raise records.RecordError("接口不存在",404)
            qs = parse_qs(urlparse(self.path).query)
            body = {}
            if method != 'GET':
                length = int(self.headers.get('Content-Length') or 0)
                if length > 4 * 1024 * 1024:
                    raise records.RecordError("草稿请求为空或超过 4MB",413)
                if length > 0:
                    body = json.loads(self.rfile.read(length))
                    if not isinstance(body,dict):
                        raise records.RecordError("无效草稿请求")
                elif method in ('POST','PUT','PATCH') and not (kind=='drafts' and ident and action=='delete' and method=='POST'):
                    # DELETE may omit a body (proxies often strip it); revision can come from ?revision=
                    raise records.RecordError("草稿请求为空或超过 4MB",413)
            def revision_of():
                rev = body.get('revision')
                if rev is None and qs.get('revision'):
                    try:
                        rev = int(qs['revision'][0])
                    except (TypeError, ValueError):
                        rev = qs['revision'][0]
                return rev
            if method == 'GET':
                if action:
                    raise records.RecordError("此操作不受支持",405)
                if kind == 'history':
                    from feishu_purchase import recover_history
                    recover_history(owner)
                if ident:
                    item = records.get_draft(owner,ident) if kind=='drafts' else records.get_history(owner,ident)
                    self._json(200, {"ok":True,"record":item})
                else:
                    offset = int(qs.get('offset',['0'])[0])
                    if not 0 <= offset <= 100000:
                        raise records.RecordError("无效分页参数")
                    self._json(200, {"ok":True,**records.list_records(owner,kind,offset)})
            elif kind == 'drafts' and ((method=='POST' and not ident) or (method=='PUT' and ident and not action)):
                self._json(200, {"ok":True,"record":records.save_draft(owner,ident or body.get('id'),body)})
            elif kind=='drafts' and ident and (
                (method in ('PATCH','DELETE') and not action) or
                (method=='POST' and action=='delete')
            ):
                delete = method=='DELETE' or action=='delete'
                item = records.change_draft(owner,ident,revision_of(),None if delete else body.get('title'),delete=delete)
                self._json(200, {"ok":True,"record":item})
            else:
                raise records.RecordError("此操作不受支持",405)
        except auth.FeishuAPIError as e:
            self._json(e.http_status if e.http_status in (401,403) else 502, {"ok":False,"error":str(e)})
        except records.RecordError as e:
            self._json(e.status, {"ok":False,"error":str(e)})
        except (ValueError, TypeError, KeyError, AttributeError):
            self._json(422, {"ok":False,"error":"草稿数据格式不正确"})
        except Exception:
            self._json(503, {"ok":False,"error":"记录暂时不可用，当前内容仍保留在本机，请稍后重试"})
        return True

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        if "fallback" in qs and qs["fallback"] and qs["fallback"][0] == "mock":
            pass

        if self._profiles_request(path):
            return
        if self._ai_settings_request(path):
            return
        if self._records_request(path):
            return
        if path == "/api/auth/logout":
            handle_logout(self)
            return

        if path in ("/api/fill-history", "/api/fill-suggestions"):
            try:
                owner = self._owner()
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 1024 * 1024: raise ValueError("填写请求为空或过大")
                body = json.loads(self.rfile.read(length))
                claim = body.get("claim")
                if not isinstance(claim, dict) or not isinstance(claim.get("answers", {}), dict):
                    raise ValueError("无效填写数据")
                if path == "/api/fill-history":
                    expense_data.record_fills(owner, body.get("draftId"), claim, public_schema(definition()))
                self._json(200, {"ok":True, "suggestions":expense_data.suggestions(owner, claim)})
            except auth.FeishuAPIError as e:
                self._json(e.http_status if e.http_status in (401,403) else 502, {"ok":False,"error":str(e)})
            except (ValueError, TypeError, KeyError, AttributeError) as e:
                self._json(422, {"ok":False,"error":str(e)})
            except Exception:
                self._json(503, {"ok":False,"error":"填写建议暂不可用，可继续手动选择"})
            return

        if path == "/api/feishu-expense":
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                self._json(400, {"ok": False, "error": "无效请求长度"})
                return
            if not 0 < length <= 1024 * 1024:
                self._json(413, {"ok": False, "error": "采购请求为空或超过 1MB"})
                return
            raw = self.rfile.read(length)
            try:
                body = json.loads(raw.decode("utf-8") or "{}")
            except Exception as e:
                self._json(400, {"ok": False, "error": f"invalid JSON: {e}"})
                return
            handle_create(self, body)
            return

        if path not in ("/api/parse-invoice", "/api/invoice-files"):
            self._json(404, {"ok": False, "error": "not found"})
            return

        try:
            owner = self._owner()
        except auth.FeishuAPIError as e:
            self._json(e.http_status if e.http_status in (401,403) else 502, {"ok":False,"error":str(e)})
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

        draft_id=invoice_id=None
        try:
            if "multipart/form-data" in ctype.lower():
                parts = parse_multipart(body, ctype)
                ctx={p["name"]:p["data"].decode("utf-8") for p in parts if p.get("name") in ("draftId","invoiceId")}
                draft_id,invoice_id=ctx.get("draftId"),ctx.get("invoiceId")
                part = extract_file_part(parts)
                filename = part.get("filename") or "upload"
                mime = guess_mime(filename, part.get("content_type"))
                data = part["data"]
            elif ctype.lower().startswith("application/json"):
                meta = json.loads(body.decode("utf-8"))
                draft_id,invoice_id=meta.get("draftId"),meta.get("invoiceId")
                if path=="/api/parse-invoice" and meta.get("attachment"):
                    original, data = expense_data.resolve_file(owner,meta['attachment'])
                    filename, mime = original['name'], original['mime']
                    try:
                        out=invoice_registry.parse_once(owner,meta["attachment"],parse_uploaded_invoice,draft_id,invoice_id)
                        out.update(ok=True,attachment=expense_data.public_file(original))
                        self._json(200,out)
                    except invoice_registry.DuplicateError as e:
                        self._json(409,{"ok":False,"duplicate":True,"error":str(e)})
                    except Exception as e:
                        self._json(502,{"ok":False,"error":str(e),"attachment":expense_data.public_file(original)})
                    return
                b64 = meta.get("image_base64") or meta.get("base64")
                if not b64:
                    raise ValueError("JSON 需含 image_base64")
                data = base64.b64decode(b64)
                filename = meta.get("filename") or "upload.png"
                mime = guess_mime(filename, meta.get("mime") or meta.get("content_type"))
            else:
                filename = self.headers.get("X-Filename") or "upload"
                mime = guess_mime(filename, ctype)
                data = body
        except Exception as e:
            self._json(400, {"ok": False, "error": f"无法解析上传内容: {e}"})
            return

        mime = sniff_image_mime(data, mime)
        is_pdf = mime == "application/pdf" or (filename or "").lower().endswith(".pdf")
        if not is_pdf and mime not in ALLOWED_IMAGE_TYPES:
            self._json(
                415,
                {
                    "ok": False,
                    "error": f"不支持的类型 {mime or 'unknown'}；请上传 JPEG/PNG/WebP/HEIC 图片或 PDF",
                },
            )
            return

        try:
            invoice_registry.reserve_upload(owner,data,mime,draft_id,invoice_id)
            attachment = expense_data.save_file(owner, data, filename, mime)
        except invoice_registry.DuplicateError as e:
            self._json(409,{"ok":False,"duplicate":True,"error":str(e)});return
        except (ValueError, OSError) as e:
            self._json(422, {"ok":False,"error":str(e)})
            return
        if path == "/api/invoice-files":
            self._json(200, {"ok":True,"attachment":attachment})
            return
        try:
            out = invoice_registry.parse_once(owner,attachment,parse_uploaded_invoice,draft_id,invoice_id)
        except invoice_registry.DuplicateError as e:
            self._json(409,{"ok":False,"duplicate":True,"error":str(e)});return
        except Exception as e:
            self._json(
                502,
                {
                    "ok": False,
                    "error": str(e),
                    "message": str(e),
                    "attachment": attachment,
                },
            )
            return

        out = dict(out)
        out["ok"] = True
        out["attachment"] = attachment
        self._json(200, out)


def main() -> None:
    load_feishu_dotenv()
    addr = (HOST, PORT)
    httpd = ThreadingHTTPServer(addr, Handler)
    print(
        f"fill-blank-expense OCR bridge on http://{HOST}:{PORT}\n"
        f"  model={ollama_model()}\n"
        f"  review={review_model()}\n"
        f"  ollama={ollama_base()}\n"
        f"  GET  /api/health\n"
        f"  GET  /api/auth/feishu/login | /api/auth/me | /api/budgets\n"
        f"  GET/PUT /api/ai-settings  POST /api/ai-settings/test\n"
        f"  POST /api/parse-invoice (multipart file=...)\n"
        f"  POST /api/feishu-expense (native purchase approval)\n"
        f"  feishu_oauth={'configured' if os.environ.get('FEISHU_APP_ID') else 'missing FEISHU_*'}",
        flush=True,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)


if __name__ == "__main__":
    main()
