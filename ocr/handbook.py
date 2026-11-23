"""Read-only handbook source. Serves 报了呗.md from the repo root."""
from __future__ import annotations

from pathlib import Path

HANDBOOK_NAME = "报了呗.md"
ROOT = Path(__file__).resolve().parent.parent
HANDBOOK_PATH = ROOT / HANDBOOK_NAME


def read_handbook() -> str:
    if not HANDBOOK_PATH.is_file():
        raise FileNotFoundError(f"未找到 {HANDBOOK_NAME}")
    text = HANDBOOK_PATH.read_text(encoding="utf-8")
    if not text.strip():
        raise ValueError(f"{HANDBOOK_NAME} 为空")
    return text
