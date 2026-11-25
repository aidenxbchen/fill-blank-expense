"""Fresh OAuth-user travel context. No shared or historical cache."""
import urllib.parse
import json
from datetime import datetime, timedelta

import feishu_oauth as auth
import travel_matching

API = 'https://open.feishu.cn/open-apis'


def checked_get(path, token):
    obj = auth.http_json('GET', API + path, token=token)
    if obj.get('code') != 0:
        raise auth.FeishuAPIError(403 if auth.is_missing_scope(auth.FeishuAPIError(400, obj)) else 502, obj)
    return obj.get('data') or {}


def actor_for(sess):
    actor = auth.fetch_user_info(sess['access_token'])
    if not actor.get('openId') or actor['openId'] != (sess.get('user') or {}).get('openId'):
        raise ValueError('OAuth 用户身份不匹配，请重新登录')
    return actor


def user_instance(sess, code):
    return checked_get('/approval/v4/instances/detail?' + urllib.parse.urlencode({
        'instance_code': code, 'locale': 'zh-CN', 'user_id_type': 'open_id'}), sess['access_token'])


def participant_instances(sess, actor, definition_codes=None):
    """Only official caller-visible tasks, never tenant search or project contact scope."""
    codes = set()
    definition_codes = definition_codes or {auth.TRAVEL_DEFINITION['approval_code']}
    for topic in (1, 2, 3, 17, 18):
        page = ''
        for count in range(50):
            data = checked_get('/approval/v4/tasks/query?' + urllib.parse.urlencode({
                'user_id': actor['openId'], 'user_id_type': 'open_id', 'topic': topic,
                'page_size': 100, **({'page_token': page} if page else {})}), sess['access_token'])
            for task in data.get('tasks') or []:
                if task.get('user_id') and task['user_id'] != actor['openId']: continue
                if task.get('definition_code') in definition_codes and auth.is_approved_status(task.get('process_status')):
                    codes.add(task['process_code'])
            if not data.get('has_more'): break
            next_page = data.get('page_token')
            if not next_page or next_page == page or count == 49:
                raise ValueError('出差候选分页不完整，请刷新后重试')
            page = next_page
    return codes


def candidate_from_detail(sess, actor, code, detail, summary=None):
    if detail.get('definition_code') != auth.TRAVEL_DEFINITION['approval_code'] or not auth.is_approved_status(detail.get('status')) or detail.get('reverted'):
        return None
    form = detail.get('form') or []
    if isinstance(form, str): form = json.loads(form)
    fields, _ = auth.parse_form(form)
    # tripGroup schedule end is exclusive (next-day midnight in half-day requests).
    travel = next((w.get('value') for w in form if w.get('type') == 'tripGroup'), {}) or {}
    schedules = travel.get('schedule') or []
    if schedules:
        fields['开始时间'] = min(s['start'] for s in schedules)
        end = datetime.fromisoformat(max(s['end'] for s in schedules)) - timedelta(seconds=1)
        fields['结束时间'] = end.date().isoformat()
    if summary:
        # Summary half-day boundaries are the applicant-visible travel days.
        fields = {**auth.summaries_to_map(summary.get('summaries')), **fields}
    traveler_ids = {detail.get('user_id')} | set(travel.get('peer_open_ids') or [])
    traveler_ids.discard(None)
    names = []
    for person in traveler_ids:
        if person == actor['openId']: names.append(actor['name']); continue
        user = checked_get('/contact/v3/users/' + urllib.parse.quote(str(person), safe='')
            + '?user_id_type=open_id', sess['access_token']).get('user') or {}
        if not user.get('name'): raise ValueError('出差旅客名称无权限读取，请检查通讯录范围')
        names.append(user['name'])
    candidate = auth._friendly_item({'instance_code': code, 'definition_code': detail['definition_code'],
        'definition_name': detail.get('definition_name'), 'instance_status': detail['status']}, None)
    candidate.update(fields=fields, travelerNames=names, periods=[{'start': travel_matching.date_value(s['start']),
        'end': (datetime.fromisoformat(s['end']) - timedelta(seconds=1)).date().isoformat()} for s in schedules])
    candidate['trip'] = travel_matching.candidate_facts(candidate)
    candidate['title'] = ' · '.join(filter(None, ['出差申请', str(fields.get('出差事由') or travel.get('reason') or ''),
        candidate['trip']['start'] + '～' + candidate['trip']['end'], str(fields.get('目的地') or '')]))
    return candidate


def travel_candidates(sess, actor=None):
    actor = actor or actor_for(sess)
    # Official OAuth list: the caller's initiated instances. No CLI/tenant fallback.
    rows = auth.list_initiated(sess['access_token'], auth.TRAVEL_DEFINITION['approval_code'])
    summaries = {r['instance_code']: r for r in rows if r.get('definition_code') == auth.TRAVEL_DEFINITION['approval_code']}
    codes = set(summaries) | participant_instances(sess, actor)
    result = []
    for code in sorted(codes):
        candidate = candidate_from_detail(sess, actor, code, user_instance(sess, code), summaries.get(code))
        if candidate: result.append(candidate)
    return result


def validate_travel(sess, actor, claim):
    code = (claim.get('selectedBudget') or {}).get('instanceId') or (claim.get('selectedBudget') or {}).get('instanceCode')
    candidate = next((c for c in travel_candidates(sess, actor) if c['instanceId'] == code), None)
    if candidate is None: raise ValueError('所选出差申请当前不可关联：必须在当前 OAuth 用户待办、已办、抄送或已发起范围内且已通过')
    travel_matching.validate_grouping(claim, candidate)
    return candidate
