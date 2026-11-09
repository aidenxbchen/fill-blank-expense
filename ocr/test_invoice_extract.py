#!/usr/bin/env python3
"""Heuristic parse tests for invoice_extract (no Ollama required)."""

from invoice_extract import extract_invoice_no, parse_invoice_from_text

OCR_ONE_LINE = (
    "发票号码：26447000001361137126 开票日期：2026年11月04日 电子发票（普通发票） "
    "购买方信息 名称：深圳市澜锘创新科技有限责任公司 销售方信息 "
    "名称：迅销（中国）商贸有限公司广州高德广场店 "
    "统一社会信用代码/纳税人识别号：91440300MAK1RFD569 "
    "合 计 ¥299.11 ¥38.89 价税合计（大写） 叁佰叁拾捌圆整 （小写）￥338.00 "
    "开票人：张文婕"
)

PDF_LAYOUT = """电子发票（普通发票）                                  发票号码：26447000001361137126
                                                                     开票日期：2026年11月04日

购 名称：深圳市澜锘创新科技有限责任公司                           销 名称：迅销（中国）商贸有限公司广州高德广场店
价税合计（大写）               （小写）¥338.00
"""


def test_ocr_text_prefers_tax_inclusive():
    fields = parse_invoice_from_text(OCR_ONE_LINE)
    assert fields["amount"] == 338.0, fields
    assert fields["amount_via"] == "tax_inclusive", fields
    assert "迅销" in fields["merchant"], fields
    assert fields["date"] == "2026-11-04", fields
    assert fields["invoice_no"] == "26447000001361137126", fields
    assert fields["category"] == "other", fields


def test_pdf_layout_text():
    fields = parse_invoice_from_text(PDF_LAYOUT)
    assert fields["amount"] == 338.0, fields
    assert fields["invoice_no"] == "26447000001361137126", fields
    assert "迅销" in fields["merchant"], fields
    assert fields["date"] == "2026-11-04", fields


def test_invoice_no_helper():
    assert extract_invoice_no("发票号码：25317000001234567890") == "25317000001234567890"


if __name__ == "__main__":
    test_ocr_text_prefers_tax_inclusive()
    test_pdf_layout_text()
    test_invoice_no_helper()
    print("ok")
