#!/usr/bin/env python3
"""Invoice text/OCR extraction + local LLM review.

Pipeline:
  PDF  → native text (pdftotext / PyMuPDF)
  Image → preprocess (EXIF, resize, HEIC→JPEG) → Xiaomi-OCR full-text
  Both → heuristic KIE → local LLM JSON review (fills gaps, checks 价税合计)
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from io import BytesIO
from typing import Any

DEFAULT_OLLAMA = "http://127.0.0.1:11434/v1"
DEFAULT_MODEL = "longwayxu/xiaomi-ocr-0:bf16"
# Same Mini already has gemma:7b, but 8GB RAM + loaded vision model makes
# swapping slow. Default review to the already-loaded OCR chat model.
DEFAULT_REVIEW_MODEL = "longwayxu/xiaomi-ocr-0:bf16"

MAX_IMAGE_EDGE = 2048
JPEG_QUALITY = 88

OCR_TEXT_PROMPT = """请完整识别这张中国发票/收据图片中的全部可见文字，按阅读顺序输出纯文本。
不要总结，不要翻译，不要省略数字、日期、发票号码、价税合计、金额和商户名称。
保留换行。只输出识别出的文字。
"""

OCR_KIE_PROMPT = """你是中国发票关键信息抽取（KIE）助手。请从这张发票/收据图片中提取字段，只输出一个 JSON 对象，不要 Markdown，不要解释。

键与要求：
- amount: number，价税合计金额（人民币元），不要货币符号。必须用「价税合计（小写）」而不是未税合计/税额
- merchant: string，销售方/开票方名称，不是购买方
- date: string，开票或消费日期，格式 YYYY-MM-DD；无法识别则用空字符串
- invoice_no: string，发票号码；无法识别则用空字符串
- category: 仅允许 lodging | meal | other
  - lodging = 住宿/酒店
  - meal = 餐饮/饭店
  - other = 交通、服装、办公或其他
- confidence: number 0 到 1，对本次抽取整体把握

只输出 JSON，例如：
{"amount":128.5,"merchant":"某某酒店","date":"2026-11-03","invoice_no":"25317000000012345678","category":"lodging","confidence":0.86}
"""

REVIEW_PROMPT = """你是中国增值税发票字段校对助手。下面给出发票原文和初步抽取结果。
请对照原文核对，输出纠正后的 JSON 对象，不要 Markdown，不要解释。

键：
- amount: number，价税合计（小写）人民币元。不要用未税金额、税额，也不要用「合计」栏里未含税的数字。大写金额可作核对。
- merchant: string，销售方/开票方名称，不是购买方
- date: string，开票日期 YYYY-MM-DD；原文没有则空字符串
- invoice_no: string，发票号码（多为 8–20 位数字）；原文没有则空字符串
- category: lodging | meal | other
  - lodging = 住宿/酒店
  - meal = 餐饮/饭店
  - other = 交通、服装、办公或其他
- confidence: number 0 到 1
- corrections: string[]，你改动了什么；没改则为 []

规则：
- 禁止编造原文没有的发票号码、日期、商户或金额
- 若原文有「价税合计」，amount 必须用价税合计小写
- 只输出 JSON
"""


def ollama_base() -> str:
    return (os.environ.get("XIAOMI_OCR_LOCAL_URL") or DEFAULT_OLLAMA).rstrip("/")


def ollama_model() -> str:
    return os.environ.get("XIAOMI_OCR_MODEL") or DEFAULT_MODEL


def review_model() -> str:
    return os.environ.get("INVOICE_REVIEW_MODEL") or DEFAULT_REVIEW_MODEL


def _which(cmd: str) -> str:
    from shutil import which

    return which(cmd) or ""


def extract_pdf_text(pdf_bytes: bytes) -> str:
    """Extract text from PDF. Prefer pdftotext -layout, else PyMuPDF page text."""
    if not pdf_bytes:
        return ""

    pdftotext = "/opt/homebrew/bin/pdftotext"
    if not os.path.isfile(pdftotext):
        pdftotext = _which("pdftotext")
    if pdftotext:
        with tempfile.TemporaryDirectory(prefix="ocr-pdftxt-") as td:
            pdf_path = os.path.join(td, "in.pdf")
            with open(pdf_path, "wb") as f:
                f.write(pdf_bytes)
            proc = subprocess.run(
                [pdftotext, "-layout", "-f", "1", "-l", "1", pdf_path, "-"],
                capture_output=True,
                timeout=30,
            )
            if proc.returncode == 0:
                out = (proc.stdout or b"").decode("utf-8", errors="replace").strip()
                if out:
                    return out

    try:
        import fitz  # type: ignore

        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            parts: list[str] = []
            for i in range(min(doc.page_count, 3)):
                parts.append(doc.load_page(i).get_text("text") or "")
            return "\n".join(parts).strip()
        finally:
            doc.close()
    except Exception:
        return ""


def pdf_text_usable(text: str) -> bool:
    t = (text or "").strip()
    if len(t) < 40:
        return False
    if not re.search(r"\d", t):
        return False
    if not re.search(r"[\u4e00-\u9fffA-Za-z]", t):
        return False
    return True


def pdf_to_png_bytes(pdf_bytes: bytes) -> tuple[bytes, str]:
    if not pdf_bytes:
        raise ValueError("空 PDF")

    try:
        import fitz  # type: ignore

        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            if doc.page_count < 1:
                raise ValueError("PDF 无页面")
            page = doc.load_page(0)
            mat = fitz.Matrix(200 / 72, 200 / 72)
            pix = page.get_pixmap(matrix=mat, alpha=False)
            return pix.tobytes("png"), "image/png"
        finally:
            doc.close()
    except ImportError:
        fitz_err: Exception | None = None
    except Exception as e:
        fitz_err = e
    else:
        fitz_err = None

    pdftoppm = "/opt/homebrew/bin/pdftoppm"
    if not os.path.isfile(pdftoppm):
        pdftoppm = _which("pdftoppm")
    if not pdftoppm:
        detail = f"（PyMuPDF 失败: {fitz_err}）" if fitz_err else ""
        raise RuntimeError("无法将 PDF 转为 PNG：未安装 PyMuPDF 且找不到 pdftoppm" + detail)

    with tempfile.TemporaryDirectory(prefix="ocr-pdf-") as td:
        pdf_path = os.path.join(td, "in.pdf")
        out_prefix = os.path.join(td, "page")
        with open(pdf_path, "wb") as f:
            f.write(pdf_bytes)
        proc = subprocess.run(
            [pdftoppm, "-png", "-f", "1", "-l", "1", "-r", "200", pdf_path, out_prefix],
            capture_output=True,
            timeout=60,
        )
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or b"").decode("utf-8", errors="replace")[:400]
            raise RuntimeError(f"pdftoppm 失败: {err or proc.returncode}")
        candidates = [
            os.path.join(td, "page-1.png"),
            os.path.join(td, "page.png"),
        ]
        png_path = next((p for p in candidates if os.path.isfile(p)), None)
        if not png_path:
            for name in os.listdir(td):
                if name.lower().endswith(".png"):
                    png_path = os.path.join(td, name)
                    break
        if not png_path:
            raise RuntimeError("pdftoppm 未生成 PNG")
        with open(png_path, "rb") as f:
            return f.read(), "image/png"


def _sips_to_jpeg(data: bytes) -> bytes:
    sips = _which("sips") or "/usr/bin/sips"
    if not os.path.isfile(sips):
        raise RuntimeError("无法转换 HEIC：系统没有 sips")
    with tempfile.TemporaryDirectory(prefix="ocr-heic-") as td:
        src = os.path.join(td, "in.heic")
        dst = os.path.join(td, "out.jpg")
        with open(src, "wb") as f:
            f.write(data)
        proc = subprocess.run(
            [sips, "-s", "format", "jpeg", src, "--out", dst],
            capture_output=True,
            timeout=30,
        )
        if proc.returncode != 0 or not os.path.isfile(dst):
            err = (proc.stderr or proc.stdout or b"").decode("utf-8", errors="replace")[:300]
            raise RuntimeError(f"HEIC 转换失败: {err or proc.returncode}")
        with open(dst, "rb") as f:
            return f.read()


def prepare_image_for_ocr(data: bytes, mime: str, filename: str = "") -> tuple[bytes, str]:
    """Normalize photos so vision OCR sees a readable, reasonably sized JPEG."""
    name = (filename or "").lower()
    raw_mime = (mime or "").split(";")[0].strip().lower()
    if raw_mime in {"image/heic", "image/heif"} or name.endswith((".heic", ".heif")):
        data = _sips_to_jpeg(data)
        mime = "image/jpeg"
        raw_mime = mime

    try:
        from PIL import Image, ImageOps

        im = Image.open(BytesIO(data))
        im = ImageOps.exif_transpose(im) or im
        if im.mode != "RGB":
            im = im.convert("RGB")
        w, h = im.size
        edge = max(w, h)
        if edge > MAX_IMAGE_EDGE:
            scale = MAX_IMAGE_EDGE / float(edge)
            im = im.resize(
                (max(1, int(w * scale)), max(1, int(h * scale))),
                Image.Resampling.LANCZOS,
            )
        buf = BytesIO()
        im.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return buf.getvalue(), "image/jpeg"
    except Exception as e:
        sys.stderr.write(f"image preprocess skipped: {e}\n")
        return data, mime or raw_mime or "image/jpeg"


def strip_json_fences(text: str) -> str:
    t = (text or "").strip()
    if not t:
        return t
    fence = re.search(r"```(?:json|JSON)?\s*([\s\S]*?)```", t)
    if fence:
        return fence.group(1).strip()
    start = t.find("{")
    end = t.rfind("}")
    if start != -1 and end != -1 and end > start:
        return t[start : end + 1]
    return t


def normalize_ocr_text(text: str) -> str:
    t = (text or "").strip()
    wrapped = re.match(r"^<([a-zA-Z][\w:-]*)>\s*([\s\S]*?)\s*</\1>$", t)
    if wrapped:
        t = wrapped.group(2).strip()
    return t


def parse_model_json(content: str) -> dict[str, Any]:
    cleaned = strip_json_fences(content)
    try:
        obj = json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"模型输出不是合法 JSON: {cleaned[:400]}") from e
    if isinstance(obj, str):
        try:
            obj = json.loads(strip_json_fences(obj))
        except json.JSONDecodeError:
            pass
    if isinstance(obj, list):
        obj = next((x for x in obj if isinstance(x, dict)), obj)
    if not isinstance(obj, dict):
        raise RuntimeError(f"模型 JSON 根节点必须是对象: {cleaned[:400]}")
    return obj


def extract_invoice_no(text: str) -> str:
    t = text or ""
    for pat in (
        r"发票号码[：:\s]*([0-9]{8,22})",
        r"发票号码[：:\s]*([0-9]{8,12}\s*[0-9]{8,12})",
        r"No[\.:]?\s*([0-9]{8,22})",
    ):
        m = re.search(pat, t, re.I)
        if m:
            return re.sub(r"\s+", "", m.group(1))
    return ""


def _parse_amount(text: str) -> tuple[float | None, str]:
    t_norm = (text or "").replace("￥", "¥").replace(",", "")
    for pat in (
        r"价税合计[^\d]{0,80}[（(]小写[）)]\s*¥?\s*(\d+(?:\.\d+)?)",
        r"[（(]小写[）)]\s*¥\s*(\d+(?:\.\d+)?)",
        r"价税合计[^\n]{0,80}?¥\s*(\d+(?:\.\d+)?)",
        r"价税合计[：:]\s*¥?\s*(\d+(?:\.\d+)?)",
        r"合计金额[：:]\s*¥?\s*(\d+(?:\.\d+)?)",
        r"实付[：:]\s*¥?\s*(\d+(?:\.\d+)?)",
    ):
        m = re.search(pat, t_norm, re.S)
        if m:
            return float(m.group(1)), "tax_inclusive"
    amounts = [float(x) for x in re.findall(r"¥\s*(\d+(?:\.\d+)?)", t_norm)]
    if amounts:
        return max(amounts), "fallback_max"
    return None, ""


def parse_invoice_from_text(text: str, require_amount: bool = False) -> dict[str, Any]:
    t = text or ""
    t_norm = t.replace("￥", "¥").replace(",", "")

    amount, amount_via = _parse_amount(t)
    if amount is None and require_amount:
        raise ValueError("未能从文本解析 amount")

    date = ""
    m = re.search(
        r"开票日期[：:\s]*(\d{4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})",
        t_norm,
    )
    if not m:
        m = re.search(r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", t_norm)
    if not m:
        m = re.search(r"(\d{4})-(\d{2})-(\d{2})", t_norm)
    if m:
        date = f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"

    merchant = ""
    m = re.search(
        r"销\s*(?:售\s*方)?[^\n]{0,24}名称[：:]\s*([^\n]+)",
        t_norm,
    )
    if m:
        merchant = m.group(1).strip()
    if not merchant:
        names = re.findall(r"名称[：:]\s*([^\n]+)", t_norm)
        names = [n.strip() for n in names if n.strip() and "统一社会信用" not in n]
        if len(names) >= 2:
            merchant = names[1]
        elif names:
            merchant = names[0]
    if not merchant:
        cos = re.findall(
            r"([\u4e00-\u9fffA-Za-z0-9（）()\-]{2,40}(?:有限责任公司|有限公司|公司)[^\n]{0,30})",
            t_norm,
        )
        cos = [c.strip() for c in cos]
        if len(cos) >= 2:
            merchant = cos[1]
        elif cos:
            merchant = cos[0]
    merchant = re.split(r"\s{2,}|\t|统一社会信用", merchant)[0].strip()
    merchant = merchant.strip(" ：:|")

    cat = "other"
    low = t_norm.lower()
    if any(k in t_norm for k in ("住宿", "酒店", "宾馆", "旅馆")) or "hotel" in low:
        cat = "lodging"
    elif any(k in t_norm for k in ("餐饮", "餐费", "饭店", "料理", "火锅", "烧烤")):
        cat = "meal"

    invoice_no = extract_invoice_no(t_norm)

    conf = 0.4
    if amount is not None:
        conf += 0.2 if amount_via == "tax_inclusive" else 0.1
    if date:
        conf += 0.15
    if merchant:
        conf += 0.15
    if invoice_no:
        conf += 0.1
    conf = min(0.95, conf)

    fields = coerce_fields(
        {
            "amount": amount if amount is not None else 0,
            "merchant": merchant,
            "date": date,
            "invoice_no": invoice_no,
            "category": cat,
            "confidence": conf,
        }
    )
    fields["source"] = "text-heuristic"
    fields["amount_via"] = amount_via
    if amount is None:
        fields["needs_review"] = True
        fields["amount"] = 0
    return fields


def coerce_fields(obj: dict[str, Any]) -> dict[str, Any]:
    amount_raw = obj.get("amount", 0)
    try:
        if isinstance(amount_raw, str):
            amount_raw = amount_raw.replace("¥", "").replace("￥", "").replace(",", "").replace("元", "").strip()
        amount = float(amount_raw) if amount_raw not in (None, "") else 0.0
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
    m = re.match(r"^(\d{4})[./年-](\d{1,2})[./月-](\d{1,2})", date)
    if m:
        date = f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"

    invoice_no = obj.get("invoice_no") or obj.get("invoiceNo") or obj.get("invoice_number") or ""
    invoice_no = re.sub(r"\s+", "", str(invoice_no).strip())

    cat = str(obj.get("category") or "other").strip().lower()
    if cat not in ("lodging", "meal", "other"):
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

    corrections = obj.get("corrections") or []
    if not isinstance(corrections, list):
        corrections = [str(corrections)]

    return {
        "amount": amount,
        "merchant": merchant,
        "date": date,
        "invoice_no": invoice_no,
        "category": cat,
        "confidence": confidence,
        "corrections": [str(x) for x in corrections if str(x).strip()],
        "source": "xiaomi-ocr-0",
    }


def _ollama_chat(payload: dict[str, Any], timeout: int = 180) -> str:
    url = f"{ollama_base()}/chat/completions"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
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
        texts = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                texts.append(part.get("text") or "")
            elif isinstance(part, str):
                texts.append(part)
        content = "\n".join(texts)
    if not isinstance(content, str):
        content = str(content)
    return content


def call_ollama_ocr_text(image_b64: str, mime: str) -> str:
    data_url = f"data:{mime};base64,{image_b64}"
    payload = {
        "model": ollama_model(),
        "temperature": 0,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": OCR_TEXT_PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
    }
    content = _ollama_chat(payload, timeout=180)
    return normalize_ocr_text(content)


def call_ollama_vision(image_b64: str, mime: str) -> tuple[dict[str, Any], str]:
    data_url = f"data:{mime};base64,{image_b64}"
    payload = {
        "model": ollama_model(),
        "temperature": 0,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": OCR_KIE_PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
    }
    content = _ollama_chat(payload, timeout=180)
    obj = parse_model_json(content)
    fields = coerce_fields(obj)
    return fields, content


def _value_in_text(value: Any, text: str) -> bool:
    if value is None:
        return False
    t = (text or "").replace(",", "").replace(" ", "").replace("￥", "¥")
    if isinstance(value, float):
        candidates = {f"{value:.2f}", f"{value:.1f}", str(int(value)) if value == int(value) else "", str(value)}
        candidates.discard("")
        return any(c in t or c.replace(".", "") in t.replace(".", "") for c in candidates)
    s = str(value).strip()
    if not s:
        return False
    compact = s.replace(" ", "").replace(",", "")
    if compact in t or s in (text or ""):
        return True
    if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
        y, mo, d = s.split("-")
        return bool(re.search(rf"{int(y)}\s*年?\s*0?{int(mo)}\s*月?\s*0?{int(d)}", text or ""))
    return False


def review_fields_with_llm(text: str, draft: dict[str, Any]) -> dict[str, Any] | None:
    if not (text or "").strip():
        return None
    draft_view = {
        "amount": draft.get("amount") or None,
        "merchant": draft.get("merchant") or "",
        "date": draft.get("date") or "",
        "invoice_no": draft.get("invoice_no") or "",
        "category": draft.get("category") or "other",
        "confidence": draft.get("confidence") or 0,
    }
    user = (
        REVIEW_PROMPT
        + "\n\n【发票原文】\n"
        + text[:6000]
        + "\n\n【初步抽取】\n"
        + json.dumps(draft_view, ensure_ascii=False)
    )
    payload = {
        "model": review_model(),
        "temperature": 0,
        "messages": [{"role": "user", "content": user}],
    }
    content = _ollama_chat(payload, timeout=90)
    obj = parse_model_json(content)
    fields = coerce_fields(obj)
    fields["source"] = "llm-review"
    return fields


def merge_heuristic_and_review(
    heuristic: dict[str, Any], reviewed: dict[str, Any] | None, text: str
) -> dict[str, Any]:
    out = dict(heuristic)
    out["corrections"] = list(heuristic.get("corrections") or [])
    if not reviewed:
        return out

    notes: list[str] = list(reviewed.get("corrections") or [])

    def take(key: str, value: Any, *, require_in_text: bool) -> None:
        if value in (None, "", 0, 0.0) and key != "amount":
            return
        if key == "amount" and not value:
            return
        if require_in_text and text and not _value_in_text(value, text):
            return
        prev = out.get(key)
        if prev != value and value not in (None, ""):
            if prev not in (None, "", 0, 0.0):
                notes.append(f"{key}: {prev} → {value}")
            out[key] = value

    # Strong heuristic 价税合计 wins over a weaker LLM guess, unless the LLM
    # amount also looks like a 价税合计 figure present in the text.
    llm_amount = reviewed.get("amount")
    heur_via = heuristic.get("amount_via")
    if llm_amount:
        if heur_via == "tax_inclusive" and heuristic.get("amount"):
            if float(llm_amount) == float(heuristic["amount"]):
                out["amount"] = float(llm_amount)
            elif text and _value_in_text(llm_amount, text):
                # keep heuristic tax-inclusive unless LLM matches the same figure
                pass
        else:
            take("amount", float(llm_amount), require_in_text=True)

    take("merchant", reviewed.get("merchant") or "", require_in_text=True)
    take("date", reviewed.get("date") or "", require_in_text=True)
    take("invoice_no", reviewed.get("invoice_no") or "", require_in_text=True)

    rev_cat = reviewed.get("category")
    if rev_cat in ("lodging", "meal", "other") and out.get("category") == "other" and rev_cat != "other":
        out["category"] = rev_cat
        notes.append(f"category: other → {rev_cat}")
    elif rev_cat in ("lodging", "meal", "other") and heur_via != "tax_inclusive":
        out["category"] = rev_cat

    if reviewed.get("confidence"):
        try:
            out["confidence"] = max(float(out.get("confidence") or 0), float(reviewed["confidence"]))
        except (TypeError, ValueError):
            pass

    # unique notes
    seen = set()
    uniq = []
    for n in notes:
        if n and n not in seen:
            seen.add(n)
            uniq.append(n)
    out["corrections"] = uniq
    if reviewed.get("source"):
        out["review_source"] = reviewed.get("source")
    return out


def extract_fields_from_text(text: str, extract_method: str) -> dict[str, Any]:
    heuristic = parse_invoice_from_text(text, require_amount=False)
    reviewed = None
    review_error = ""
    try:
        reviewed = review_fields_with_llm(text, heuristic)
    except Exception as e:
        review_error = str(e)
        sys.stderr.write(f"llm review failed: {e}\n")

    fields = merge_heuristic_and_review(heuristic, reviewed, text)
    fields["ok"] = True
    fields["raw"] = text[:4000]
    fields["extract_method"] = extract_method + ("+llm-review" if reviewed else "+heuristic")
    fields["review_model"] = review_model() if reviewed else ""
    if review_error:
        fields["review_error"] = review_error[:300]
    if not fields.get("amount"):
        fields["needs_review"] = True
    return fields


def parse_image_invoice(data: bytes, filename: str, mime: str) -> dict[str, Any]:
    prepared, prep_mime = prepare_image_for_ocr(data, mime, filename)
    b64 = base64.b64encode(prepared).decode("ascii")

    ocr_error = ""
    ocr_text = ""
    try:
        ocr_text = call_ollama_ocr_text(b64, prep_mime)
    except Exception as e:
        ocr_error = str(e)
        sys.stderr.write(f"vision OCR text failed: {e}\n")

    if pdf_text_usable(ocr_text) or (ocr_text and len(ocr_text.strip()) >= 20):
        fields = extract_fields_from_text(ocr_text, "vision-ocr")
        if fields.get("amount") or fields.get("merchant") or fields.get("invoice_no"):
            return fields
        # keep going to KIE fallback if almost nothing useful

    try:
        kie, raw = call_ollama_vision(b64, prep_mime)
    except Exception as e:
        if ocr_text:
            fields = extract_fields_from_text(ocr_text, "vision-ocr")
            fields["needs_review"] = True
            if ocr_error:
                fields["ocr_error"] = ocr_error[:300]
            return fields
        raise RuntimeError(ocr_error or str(e)) from e

    # If we also got OCR text, let review reconcile KIE vs text
    if ocr_text:
        merged = merge_heuristic_and_review(
            parse_invoice_from_text(ocr_text, require_amount=False), kie, ocr_text
        )
        try:
            reviewed = review_fields_with_llm(ocr_text, merged)
            merged = merge_heuristic_and_review(merged, reviewed, ocr_text)
            merged["extract_method"] = "vision-ocr+kie+llm-review" if reviewed else "vision-ocr+kie"
            merged["review_model"] = review_model() if reviewed else ""
        except Exception as e:
            merged["extract_method"] = "vision-ocr+kie"
            merged["review_error"] = str(e)[:300]
        merged["ok"] = True
        merged["raw"] = ocr_text[:4000]
        return merged

    kie["ok"] = True
    kie["raw"] = raw
    kie["extract_method"] = "vision-kie"
    if ocr_error:
        kie["ocr_error"] = ocr_error[:300]
    return kie


def parse_uploaded_invoice(data: bytes, filename: str, mime: str) -> dict[str, Any]:
    is_pdf = (mime or "") == "application/pdf" or (filename or "").lower().endswith(".pdf")
    if is_pdf:
        try:
            pdf_text = extract_pdf_text(data)
        except Exception:
            pdf_text = ""
        if pdf_text_usable(pdf_text):
            fields = extract_fields_from_text(pdf_text, "pdf-text")
            if fields.get("amount") or fields.get("merchant") or fields.get("invoice_no"):
                return fields
            sys.stderr.write("pdf-text usable but fields weak, falling back to raster OCR\n")
        try:
            png, png_mime = pdf_to_png_bytes(data)
        except Exception as e:
            if pdf_text:
                fields = extract_fields_from_text(pdf_text, "pdf-text")
                fields["needs_review"] = True
                fields["ocr_error"] = f"PDF 无可用文本且首页转 PNG 失败: {e}"[:300]
                return fields
            raise RuntimeError(f"PDF 无可用文本且首页转 PNG 失败: {e}") from e
        out = parse_image_invoice(png, (filename or "upload.pdf").rsplit(".", 1)[0] + ".png", png_mime)
        method = out.get("extract_method") or "vision-ocr"
        if not str(method).startswith("vision-pdf"):
            out["extract_method"] = "vision-pdf+" + str(method)
        return out

    return parse_image_invoice(data, filename, mime)


def probe_ollama() -> bool:
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
