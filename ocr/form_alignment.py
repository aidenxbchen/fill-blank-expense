"""Keep Feishu form children under the parent group they belong to.

The live 费用报销 and 采购申请 definitions switch detail tables by a top-level
type field. A child of one group must never be written into another group.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXPENSE_PATH = ROOT / 'expense_definition.json'
PURCHASE_PATH = ROOT / 'purchase_definition.json'
EXPENSE_CODE = '7C35D7A9-DFF0-46BC-9FC7-61C90E142E51'
PURCHASE_CODE = 'D448D0FB-77DB-4640-9650-1FB99512888C'


def load_definition(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    form = data.get('form')
    if isinstance(form, str):
        form = json.loads(form)
    if not isinstance(form, list):
        raise ValueError(f'表单定义无效：{path}')
    return data, form


def switch_value(condition):
    if not isinstance(condition, dict):
        return None
    for block in condition.get('conditions') or []:
        found = switch_value(block)
        if found:
            return found
    for exp in condition.get('expressions') or []:
        if exp.get('compare_type') == 'is':
            return {
                'widgetId': (exp.get('source_widget') or {}).get('id'),
                'value': exp.get('standard_value'),
            }
    return None


def groups(form):
    """Return visible-when groups and their exclusive children."""
    result = []
    for widget in form:
        if widget.get('type') != 'fieldList':
            continue
        children = []
        for child in widget.get('children') or []:
            children.append({
                'id': child.get('id'),
                'name': child.get('name'),
                'type': child.get('type'),
                'required': child.get('required', False),
                'options': [o.get('text') for o in child.get('option') or [] if isinstance(o, dict)],
            })
        result.append({
            'id': widget.get('id'),
            'name': widget.get('name'),
            'required': widget.get('required', False),
            'visibleWhen': switch_value(widget.get('display_condition')),
            'children': children,
        })
    return result


def index_children(form):
    """Map child id/name to the single parent group they belong to."""
    mapping = {}
    for group in groups(form):
        for child in group['children']:
            if child['id']:
                owner = mapping.get(child['id'])
                if owner and owner != group['name']:
                    raise ValueError(f'字段 id「{child["id"]}」同时出现在「{owner}」和「{group["name"]}」，不能安全对齐')
                mapping[child['id']] = group['name']
            # The same label may legitimately appear in several groups (e.g. 名称).
            # Name lookup is only used when the target group actually has that label.
    # Unique names can be resolved without an id; shared labels cannot.
    names = {}
    for group in groups(form):
        for child in group['children']:
            if not child['name']:
                continue
            names.setdefault(child['name'], set()).add(group['name'])
    for name, owners in names.items():
        if len(owners) == 1:
            mapping[name] = next(iter(owners))
    return mapping


def assert_row_in_group(form, group_name, row):
    """row is a list of {id,name,...}. Reject children from another group."""
    allowed = {group['name']: group for group in groups(form)}
    if group_name not in allowed:
        raise ValueError(f'不存在的明细表：{group_name}')
    valid = {(child['id'], child['name']) for child in allowed[group_name]['children']}
    valid_ids = {child['id'] for child in allowed[group_name]['children']}
    valid_names = {child['name'] for child in allowed[group_name]['children']}
    belonging = index_children(form)
    for cell in row or []:
        if not isinstance(cell, dict):
            continue
        ident = cell.get('id') or cell.get('name')
        owner = belonging.get(cell.get('id')) or belonging.get(cell.get('name'))
        if owner and owner != group_name:
            raise ValueError(f'不能把「{ident}」放到「{group_name}」下，它属于「{owner}」')
        if ident and ident not in valid_ids and ident not in valid_names:
            raise ValueError(f'「{group_name}」没有字段「{ident}」')
    return True


def expense_schema():
    data, form = load_definition(EXPENSE_PATH)
    top = [w for w in form if w.get('type') != 'fieldList']
    return {
        'approvalCode': data.get('approval_code') or EXPENSE_CODE,
        'approvalName': data.get('approval_name') or '费用报销',
        'top': [{'name': w.get('name'), 'type': w.get('type'), 'required': w.get('required', False),
                 'options': [o.get('text') for o in w.get('option') or [] if isinstance(o, dict)]} for w in top],
        'groups': groups(form),
        'departmentField': next((c for g in groups(form) for c in g['children'] if c['name'] == '部门'), None),
    }


def purchase_groups():
    _, form = load_definition(PURCHASE_PATH)
    return groups(form)
