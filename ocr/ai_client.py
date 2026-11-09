#!/usr/bin/env python3
"""Unified OpenAI-compatible chat client for every LLM call in this app.

Text review (and the future Q&A hook) resolve per-user settings first
(recommended: Deepseek). Image OCR still talks to local Ollama through
this same client so URLs and keys are not scattered.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any

RECOMMENDED_PROVIDER = "Deepseek"
RECOMMENDED_BASE_URL = "https://api.deepseek.com/v1"
RECOMMENDED_MODEL = "deepseek-chat"
RECOMMENDED_DOCS_URL = "https://platform.deepseek.com/api_keys"
OCR_NOTE = "图片文字识别默认仍用本机 OCR；字段校对 / 文本 AI 用你配置的接口（推荐 Deepseek）"
SETUP_CTA = (
    "尚未配置文本 AI，本机校对也不可用。"
    "请在顶栏「AI 设置」填写自己的接口（推荐 Deepseek："
    f"{RECOMMENDED_BASE_URL}，模型 {RECOMMENDED_MODEL}）。"
)


def join_chat_url(base_url: str) -> str:
    base = (base_url or "").strip()
    if not base:
        raise ValueError("请填写 API Base URL")
    if not re.match(r"^https?://", base, re.I):
        raise ValueError("API Base URL 必须以 http:// 或 https:// 开头")
    base = base.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return base + "/chat/completions"


def mask_api_key(key: str) -> str:
    key = (key or "").strip()
    if not key:
        return ""
    tail = key[-4:] if len(key) >= 4 else key
    if key.startswith("sk-"):
        return f"sk-***{tail}"
    return f"***{tail}"


def looks_masked(key: str) -> bool:
    key = (key or "").strip()
    return (not key) or ("***" in key)


def _sanitize(text: str) -> str:
    text = text or ""
    text = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._\-]+", r"\1***", text)
    text = re.sub(r"sk-[A-Za-z0-9]{6,}", lambda m: mask_api_key(m.group(0)), text)
    return text


def public_error(exc: BaseException) -> str:
    raw = _sanitize(str(exc))
    if isinstance(exc, urllib.error.HTTPError):
        code = exc.code
        if code in (401, 403):
            return "AI 接口拒绝访问，请检查 API Key 是否正确、是否有额度"
        if code == 404:
            return "AI 接口地址不存在，请确认 Base URL 是否包含 /v1（Deepseek 示例：https://api.deepseek.com/v1）"
        if code == 429:
            return "AI 接口请求过于频繁或额度不足，请稍后重试"
        if 500 <= code < 600:
            return f"AI 接口服务暂时不可用（HTTP {code}）"
        return f"AI 接口返回 HTTP {code}"
    if isinstance(exc, (urllib.error.URLError, TimeoutError, ConnectionError)):
        return "无法连接 AI 接口，请检查 Base URL 或网络"
    lowered = raw.lower()
    if "无法连接" in raw or "timed out" in lowered or "timeout" in lowered:
        if "ollama" in lowered or "11434" in raw:
            return raw[:240] if "无法连接" in raw else f"无法连接本机 OCR/校对服务：{raw[:180]}"
        return "连接 AI 接口超时或不可达，请检查 Base URL 与网络"
    if "非 JSON" in raw:
        return "AI 接口返回了无法解析的内容，请确认 Base URL 与模型名称"
    return raw[:300]


def is_unreachable(exc: BaseException) -> bool:
    if isinstance(exc, (urllib.error.URLError, TimeoutError, ConnectionError)):
        return True
    text = str(exc).lower()
    return (
        "无法连接" in str(exc)
        or "timed out" in text
        or "timeout" in text
        or "connection refused" in text
    )


def chat_completions(
    *,
    base_url: str,
    model: str,
    messages: list[Any],
    api_key: str = "",
    timeout: int = 90,
    temperature: float = 0,
    extra: dict[str, Any] | None = None,
) -> str:
    if not (model or "").strip():
        raise ValueError("请填写模型名称")
    url = join_chat_url(base_url)
    payload: dict[str, Any] = {
        "model": model.strip(),
        "temperature": temperature,
        "messages": messages,
    }
    if extra:
        payload.update(extra)
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        snippet = _sanitize(err_body[:240])
        raise RuntimeError(public_error(e) + (f"：{snippet}" if snippet else "")) from e
    except urllib.error.URLError as e:
        raise RuntimeError(public_error(e)) from e
    except TimeoutError as e:
        raise RuntimeError("连接 AI 接口超时，请稍后重试") from e

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"AI 接口返回非 JSON: {_sanitize(raw[:200])}") from e

    if isinstance(data, dict) and data.get("error"):
        err = data["error"]
        if isinstance(err, dict):
            msg = err.get("message") or err.get("msg") or json.dumps(err, ensure_ascii=False)
        else:
            msg = str(err)
        raise RuntimeError(f"AI 接口错误：{_sanitize(str(msg)[:240])}")

    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"AI 接口响应缺少 choices.message.content: {_sanitize(raw[:240])}") from e

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


def defaults() -> dict[str, str]:
    return {
        "provider": RECOMMENDED_PROVIDER,
        "baseUrl": RECOMMENDED_BASE_URL,
        "textModel": RECOMMENDED_MODEL,
        "docsUrl": RECOMMENDED_DOCS_URL,
        "ocrNote": OCR_NOTE,
        "hint": "推荐使用 Deepseek",
    }


def resolve_text_endpoint(owner: str | None) -> dict[str, str] | None:
    """Per-user text/review chat settings, or None if the user has not configured any.

    Future Q&A LLM should call this (or chat_for_qa) instead of reading URLs/keys itself.
    """
    if not owner:
        return None
    try:
        import ai_settings as settings
    except ImportError:
        return None
    return settings.load_credentials(owner)


def chat_for_qa(owner: str, messages: list[Any], timeout: int = 60, temperature: float = 0) -> str:
    """Hook for a future interview LLM. Keep all URL/key resolution here."""
    endpoint = resolve_text_endpoint(owner)
    if not endpoint:
        raise RuntimeError(SETUP_CTA)
    return chat_completions(messages=messages, timeout=timeout, temperature=temperature, **endpoint)
