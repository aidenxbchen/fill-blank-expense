"""Additive invoice identity / line-item extraction; no model or credential access."""
import math
import re
import unicodedata


def numeric(value):
    try:
        n = float(str(value).replace(',', ''))
        return n if math.isfinite(n) and 0 < n <= 1e9 else None
    except (ValueError, TypeError):
        return None


def normalize_items(rows):
    if not isinstance(rows, list): return []
    out = []
    for row in rows[:200]:
        if not isinstance(row, dict): continue
        def get(*keys): return next((row[k] for k in keys if row.get(k) not in (None, '')), '')
        item = {'name':str(get('name','名称','货物或应税劳务名称','项目名称'))[:240],
                'specification':str(get('specification','spec','规格型号'))[:120],
                'unit':str(get('unit','单位'))[:20], 'quantity':numeric(get('quantity','qty','数量')),
                'unit_price':get('unit_price','unitPrice','单价'), 'amount':get('amount','金额')}
        if item['name'] or item['quantity'] or item['unit']: out.append(item)
    return out


def from_text(text):
    text = unicodedata.normalize('NFKC', str(text or ''))
    rows = []
    in_table = False
    pattern = re.compile(r'^(.+?)\s+([\u4e00-\u9fffA-Za-z/]{1,8})\s+(\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s|$)')
    for line in text.splitlines():
        if '数量' in line and ('单位' in line or '单价' in line): in_table = True; continue
        if any(x in line for x in ('价税合计','合计金额','销售方信息','购买方信息')): in_table = False
        match = pattern.search(line.strip()) if in_table or line.strip().startswith('*') else None
        if match:
            name, unit, qty, price, amount = match.groups()
            rows.append({'name':name.strip(), 'unit':unit, 'quantity':qty, 'unit_price':price, 'amount':amount})
    for line in text.splitlines():
        label=line.strip()
        if re.match(r'^\*[^*]+\*.+',label) and not any(label.startswith(r['name']) for r in rows):
            rows.append({'name':label})
    result = {'items':normalize_items(rows)}
    for key, label, count in [('invoice_code','发票代码','10,12'),('check_code','校验码','6,20')]:
        m = re.search(label+r'[：:\s]*([0-9]{'+count+r'})',text)
        result[key] = m.group(1) if m else ''
    if not rows:
        q = re.search(r'数量[：:]\s*(\d+(?:\.\d+)?)',text)
        u = re.search(r'单位[：:]\s*([\u4e00-\u9fffA-Za-z/]{1,8})',text)
        if q: result['quantity'] = numeric(q.group(1))
        if u: result['unit'] = u.group(1)
    return result


def quantity_unit(inv):
    rows = normalize_items(inv.get('items') or inv.get('line_items') or [])
    if len(rows) > 1: return {'quantity':1, 'unit':'份/批', 'quantity_mode':'batch'}
    row = rows[0] if rows else {}
    q = numeric(inv.get('quantity')) or numeric(row.get('quantity'))
    u = str(inv.get('unit') or row.get('unit') or '').strip()[:20]
    return {'quantity':q or 1, 'unit':u or '份/批', 'quantity_mode':'invoice' if q and u else 'default'}


def identity_keys(inv):
    digits = lambda v: re.sub(r'\s+', '', unicodedata.normalize('NFKC',str(v or '')))
    no = digits(inv.get('invoice_no') or inv.get('invoiceNo'))
    code = digits(inv.get('invoice_code') or inv.get('invoiceCode'))
    if re.fullmatch(r'\d{20}', no): return ['digital:'+no]
    if re.fullmatch(r'\d{8}',no) and re.fullmatch(r'\d{10}|\d{12}',code): return ['vat:'+code+':'+no]
    return []  # An 8-digit number without its code is not globally unique.
