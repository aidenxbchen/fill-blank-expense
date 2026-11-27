"""Exact monetary evidence from owned originals, independent of edited form data."""
from __future__ import annotations

import base64
import json
from decimal import Decimal, InvalidOperation
import re
import time
import unicodedata


VERSION = 'original-money-v1'
# A token must end completely: 69 must never match the prefix of 69.50.
MONEY = r'(?<![\d.,])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?![\d.,])'


class AmountVerificationError(ValueError):
    pass


def normalize_money_text(text):
    text = unicodedata.normalize('NFKC', str(text or '')).replace('￥', '¥')
    return re.sub(r'(?<=\d)\s*\.\s*(?=\d)', '.', text)


def money_tokens(text):
    return [Decimal(m.group().replace(',', '')) for m in re.finditer(MONEY, normalize_money_text(text))]


def uppercase_amounts(text):
    digits = dict(zip('零壹贰叁肆伍陆柒捌玖', range(10)))
    def integer(s):
        for unit, scale in [('亿', 100000000), ('万', 10000)]:
            if unit in s:
                left, right = s.split(unit, 1)
                return integer(left) * scale + integer(right)
        total = number = 0
        for char in s:
            if char in digits:number = digits[char]
            elif char in '拾佰仟':
                total += (number or 1) * {'拾':10,'佰':100,'仟':1000}[char];number = 0
        return total + number
    values = set()
    pattern = r'大写\)?\s*[:：]?\s*(?:人民币)?([零壹贰叁肆伍陆柒捌玖拾佰仟万亿元圆整正角分]+)'
    for match in re.finditer(pattern, text):
        value = match.group(1)
        parts = re.fullmatch(r'(.+?)[元圆](.*)', value)
        if not parts:continue
        whole, fraction = parts.groups()
        jiao = re.search(r'([零壹贰叁肆伍陆柒捌玖])角', fraction)
        fen = re.search(r'([零壹贰叁肆伍陆柒捌玖])分', fraction)
        values.add(Decimal(integer(whole)) + Decimal(digits[jiao[1]] if jiao else 0)/10 + Decimal(digits[fen[1]] if fen else 0)/100)
    return values


def total_evidence(text):
    """Prefer gross total, then explicit fare/payment. Conflicting totals fail closed."""
    text = normalize_money_text(text)
    sources = [
        ('价税合计', [r'小写\)?\s*[:：]?\s*¥?\s*(' + MONEY + ')',
                   r'价税合计[^\d\n]{0,80}?¥\s*(' + MONEY + ')',
                   r'价税合计\s*[:：]?\s*¥?\s*(' + MONEY + ')']),
        ('票价/实付', [r'(?:票价|票款|实付(?:金额)?|支付金额|合计金额|应付金额)\s*[:：]?\s*¥?\s*(' + MONEY + ')']),
    ]
    # Paper rail reimbursement vouchers print a single currency figure without
    # the literal 票价 label. Multiple figures are never resolved by taking max.
    if re.search(r'仅供报销使用|报销凭证|铁路.{0,12}客票', text):
        sources.append(('票价', [r'¥\s*(' + MONEY + ')']))
    for source, patterns in sources:
        values = {Decimal(m.group(1).replace(',', '')) for pattern in patterns for m in re.finditer(pattern, text)}
        if len(values) > 1:
            raise AmountVerificationError('原件存在互相矛盾的合计金额，须核对原票后重新识别')
        if values:
            amount = values.pop()
            if amount <= 0:
                raise AmountVerificationError('原件合计金额必须大于零')
            uppercase = uppercase_amounts(text)
            if uppercase and uppercase != {amount}:
                raise AmountVerificationError('原件大小写金额不一致，须核对原票后重新识别')
            if source == '票价/实付' and re.search(r'票价|票款', text):source = '票价'
            return amount, source
    return None


def original_amount(record, raw):
    """Cache only server-read evidence, keyed by owner, original hash and parser version."""
    import expense_data as data
    import invoice_extract as extract
    key = (record['owner'], record['sha256'], VERSION)
    with data.database() as con:
        con.execute('''CREATE TABLE IF NOT EXISTS original_amount_checks (
            owner TEXT NOT NULL, sha256 TEXT NOT NULL, version TEXT NOT NULL,
            amount TEXT NOT NULL, source TEXT NOT NULL, checked_at INTEGER NOT NULL,
            PRIMARY KEY(owner,sha256,version))''')
        row = con.execute('SELECT amount,source FROM original_amount_checks WHERE owner=? AND sha256=? AND version=?', key).fetchone()
    if row:
        return Decimal(row['amount']), row['source']
    mime = record.get('mime') or ''
    text = extract.extract_pdf_text(raw) if mime == 'application/pdf' or raw.startswith(b'%PDF') else ''
    if not text.strip():
        # Reuse the immutable server OCR text for these exact bytes, not its
        # previously selected amount, client raw, or an uploaded filename.
        with data.database() as con:
            cached = con.execute("SELECT result_json FROM invoice_reads WHERE sha256=? AND status='done'", (record['sha256'],)).fetchone()
        if cached:
            text = str((json.loads(cached['result_json']) or {}).get('raw') or '')
    evidence = total_evidence(text)
    if not text.strip():
        # Image-only originals use local OCR, never a client-supplied raw field or filename.
        if mime == 'application/pdf' or raw.startswith(b'%PDF'):
            image, image_mime = extract.pdf_to_png_bytes(raw)
        else:
            image, image_mime = extract.prepare_image_for_ocr(raw, mime, record['name'])
        text = extract.call_ollama_ocr_text(base64.b64encode(image).decode('ascii'), image_mime)
        evidence = total_evidence(text)
    if evidence is None:
        raise AmountVerificationError('无法从原件可靠核验价税合计或票价，请重新识别或补传清晰原件；不能视为金额核对通过')
    amount, source = evidence
    with data.database() as con:
        con.execute('INSERT OR REPLACE INTO original_amount_checks VALUES(?,?,?,?,?,?)', (*key, str(amount), source, int(time.time())))
    return amount, source


def validate_amount(record, raw, value):
    try:
        expected, source = original_amount(record, raw)
    except AmountVerificationError:
        raise
    except Exception as e:
        raise AmountVerificationError('原件金额读取失败，尚未完成金额核对，请重新识别或补传清晰原件') from e
    try:
        actual = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise AmountVerificationError('清单金额不是有效数字，请按原件重新核对') from None
    if not actual.is_finite() or actual != expected:
        submitted = f'¥{actual:.2f}' if actual.is_finite() else '无效金额'
        difference = f'，差额 ¥{abs(actual-expected):.2f}' if actual.is_finite() else ''
        raise AmountVerificationError(f'金额核对未通过：清单 {submitted}，原件{source} ¥{expected:.2f}{difference}。请按原件更正后重新核验')
    return expected
