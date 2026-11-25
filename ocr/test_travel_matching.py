"""COD-8 offline acceptance: every store is temporary; every upstream call mocked."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import expense_data as data
import expense_records as records
import travel_context as ctx
import feishu_oauth as auth
import feishu_purchase as purchase
import travel_matching as travel
from test_feishu_purchase import SCHEMA, claim_for
import test_expense_http as http_fixture

REAL_ACTOR = ctx.actor_for
REAL_RELATION = purchase.validate_relation

ACTOR = {'openId': 'ou_alice', 'name': '合成旅客甲'}
SESSION = {'access_token': 'mock-only', 'user': ACTOR}
CODE = '11111111-1111-1111-1111-111111111111'


def ticket(date='2026-11-22', origin='广州南', destination='深圳北', passenger='合成旅客甲', identifier='ticket'):
    return {'id': identifier, 'amount': 100, 'category': 'transit', 'date': '2026-11-25',
        'raw': f'电子发票（铁路电子客票）\n开票日期：2026年11月25日\n旅客：{passenger}\n乘车日期：{date} 出发站：{origin} 到达站：{destination}'}


def candidate(code=CODE, start='2026-11-22', end='2026-11-22', destination='深圳'):
    return {'instanceId': code, 'kind': 'travel', 'approvalCode': auth.TRAVEL_DEFINITION['approval_code'],
        'title': '出差申请 · 合成深圳业务交流', 'travelerNames': [ACTOR['name']],
        'fields': {'出发地': '广州', '目的地': destination, '开始时间': start, '结束时间': end}}


def claim(*invoices):
    result = claim_for('差旅费')
    result.update(invoices=list(invoices) or [ticket()], selectedBudget={'instanceId': CODE})
    return result


class MatchingTests(unittest.TestCase):
    def decide(self, invoices, candidates, ai=None):
        with patch.object(travel, 'ai_rank', return_value=(ai or {'instanceId': CODE}, '')):
            return travel.match('ou_alice', ACTOR, claim(*invoices), candidates)

    def test_shenzhen_station_date_not_issue_date_and_airport(self):
        result = self.decide([ticket()], [candidate()])
        self.assertEqual(result['autoSelectId'], CODE)
        fact = result['groups'][0]['facts']
        self.assertEqual(fact['segments'][0]['date'], '2026-11-22')
        self.assertEqual(fact['segments'][0]['destinationCity'], '深圳')
        flight = ticket(origin='CAN', destination='SZX')
        flight['raw'] = flight['raw'].replace('铁路电子客票', '航空行程单').replace('乘车日期', '起飞日期')
        self.assertEqual(self.decide([flight], [candidate()])['autoSelectId'], CODE)
        self.assertEqual(travel.city('陌生站'), '')
        layout = ticket()
        layout['raw'] = '铁路电子客票\n广州南站 G123 深圳北站\n2026年11月22日 10:00 开\n4401**********1234 合成旅客甲'
        self.assertEqual(self.decide([layout], [candidate()])['autoSelectId'], CODE)

    def test_cross_month_return_and_multi_day_multi_city(self):
        route = [ticket('2026-10-31'), ticket('2026-11-02', '深圳北', '广州南', identifier='return')]
        self.assertEqual(self.decide(route, [candidate(start='2026-10-31', end='2026-11-02')])['autoSelectId'], CODE)
        route.append(ticket('2026-11-01', '深圳北', '上海虹桥', identifier='middle'))
        self.assertEqual(self.decide(route, [candidate(start='2026-10-31', end='2026-11-02', destination='深圳、上海')])['autoSelectId'], CODE)
        gap = candidate(start='2026-10-31', end='2026-11-02')
        gap['periods'] = [{'start':'2026-10-31','end':'2026-10-31'}, {'start':'2026-11-02','end':'2026-11-02'}]
        self.assertIsNone(self.decide([ticket('2026-11-01')], [gap])['autoSelectId'])

    def test_ambiguity_absence_missing_passenger_and_unknown_station(self):
        self.assertIsNone(self.decide([ticket()], [candidate(), candidate('22222222-2222-2222-2222-222222222222')])['autoSelectId'])
        self.assertIsNone(self.decide([ticket()], [])['autoSelectId'])
        self.assertIsNone(self.decide([ticket(passenger='')], [candidate()])['autoSelectId'])
        self.assertIsNone(self.decide([ticket(destination='未知机场')], [candidate()])['autoSelectId'])
        only_issue = ticket(); only_issue['raw'] = '铁路电子客票 开票日期：2026-11-22 旅客：合成旅客甲'
        self.assertEqual(travel.facts(only_issue)['segments'], [])

    def test_ai_invented_id_is_rejected_even_with_unique_real_candidate(self):
        with patch.object(travel, 'resolve_review_endpoint', return_value=({}, 'mock')), patch.object(travel.ai_client, 'chat_completions', return_value='{"instanceId":"invented"}'):
            result = travel.match(ACTOR['openId'], ACTOR, claim(), [candidate()])
        self.assertIsNone(result['autoSelectId'])
        self.assertIn('真实候选编号', result['notice'])

    def test_mixed_trip_grouping_never_blanket_links(self):
        mix = [ticket(), {'id': 'meal', 'category': 'meal', 'amount': 10}]
        self.assertIsNone(self.decide(mix, [candidate()])['autoSelectId'])
        with self.assertRaisesRegex(ValueError, '混合'): travel.validate_grouping(claim(*mix), candidate())
        with self.assertRaisesRegex(ValueError, '分组'):
            travel.validate_grouping(claim(ticket(), ticket('2026-11-23', destination='北京南', identifier='other')), candidate())
        travel.validate_grouping(claim(ticket(), ticket(origin='深圳北', destination='广州南', identifier='return')), candidate())

    def test_manual_travel_without_tickets_calls_ai_but_cannot_auto_link(self):
        with patch.object(travel, 'ai_rank', return_value=({'instanceId': CODE}, '')) as ai:
            result = travel.match(ACTOR['openId'], ACTOR, claim({'id': 'hotel', 'category': 'lodging'}), [candidate()])
        ai.assert_called_once();self.assertIsNone(result['autoSelectId'])


class OAuthContextTests(unittest.TestCase):
    def test_user_scope_query_dedup_and_fresh_detail_status(self):
        rows = [{'instance_code': CODE, 'definition_code': auth.TRAVEL_DEFINITION['approval_code'], 'summaries': []}]
        detail = {'definition_code': auth.TRAVEL_DEFINITION['approval_code'], 'definition_name': '出差申请', 'user_id': ACTOR['openId'], 'status': 'APPROVED',
            'form': [{'type': 'input', 'name': '出发地', 'value': '广州'}, {'type': 'input', 'name': '目的地', 'value': '深圳'},
                {'type': 'tripGroup', 'value': {'peer_open_ids': [], 'schedule': [{'start': '2026-11-22T12:00:00+08:00', 'end': '2026-11-23T00:00:00+08:00'}]}}]}
        urls = []
        def get(path, token):
            urls.append(path);self.assertEqual(token, 'mock-only')
            if '/tasks/query' in path:
                self.assertIn('user_id=ou_alice', path)
                return {'has_more': False, 'tasks': [{'definition_code': auth.TRAVEL_DEFINITION['approval_code'], 'process_code': CODE, 'process_status': '2'}]}
            if '/instances/detail?' in path: return detail
            raise AssertionError(path)
        with patch.object(auth, 'list_initiated', return_value=rows), patch.object(ctx, 'checked_get', side_effect=get):
            first = ctx.travel_candidates(SESSION, ACTOR)
            self.assertEqual(len(first), 1)
            self.assertEqual(first[0]['trip']['end'], '2026-11-22')
            detail['status'] = 'CANCELED'
            self.assertEqual(ctx.travel_candidates(SESSION, ACTOR), [])
        self.assertEqual(sum('/tasks/query' in u for u in urls), 10)

    def test_cross_user_identity_and_scope_errors_are_not_empty(self):
        with patch.object(auth, 'fetch_user_info', return_value={'openId': 'ou_other'}):
            with self.assertRaisesRegex(ValueError, '身份不匹配'):ctx.actor_for(SESSION)
        with patch.object(auth, 'list_initiated', side_effect=auth.FeishuAPIError(403, {'code': 99991672, 'msg': 'scope required'})):
            with self.assertRaises(auth.FeishuAPIError):ctx.travel_candidates(SESSION, ACTOR)

    def test_incomplete_task_pagination_fails_instead_of_partial_list(self):
        with patch.object(ctx, 'checked_get', return_value={'has_more': True, 'tasks': []}):
            with self.assertRaisesRegex(ValueError, '分页不完整'):ctx.participant_instances(SESSION, ACTOR)

    def test_budget_detail_read_denial_not_disguised_as_empty(self):
        with patch.object(auth, 'get_tenant_access_token', return_value='mock'), patch.object(auth, 'query_approved_instances', return_value=[{'instance': {'code': CODE}}]), patch.object(auth, 'fetch_instance', side_effect=auth.FeishuAPIError(403, {'msg':'Forbidden'})):
            rows, warning = auth.list_approved_budgets(ACTOR, refresh=True)
        self.assertEqual(rows, []);self.assertIn('读取权限', warning)

    def test_live_connect_schema_rejects_removed_travel_definition(self):
        purchase.validate_connect_definition(SCHEMA, claim(), auth.TRAVEL_DEFINITION['approval_code'])
        form = copy.deepcopy(SCHEMA)
        next(w for w in form if w['type'] == 'connect')['option']['definitionIds'].remove(auth.TRAVEL_DEFINITION['numeric_id'])
        with self.assertRaisesRegex(ValueError, '允许范围'):
            purchase.validate_connect_definition(form, claim(), auth.TRAVEL_DEFINITION['approval_code'])


class PayloadRegressionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        for obj, key, value in [(data, 'DB_PATH', Path(self.tmp.name)/'data.db'), (data, 'FILE_ROOT', Path(self.tmp.name)/'files'),
                                (purchase, 'DB_PATH', Path(self.tmp.name)/'receipts.db')]:
            p = patch.object(obj, key, value);p.start();self.addCleanup(p.stop)
        self.actor = dict(ACTOR, department_ids=['fixture-a', 'fixture-b'])
        for obj, key, value in [(auth, 'fetch_user_info', self.actor), (auth, 'get_tenant_access_token', 'mock-tenant'),
                                (purchase, 'definition', SCHEMA)]:
            p = patch.object(obj, key, return_value=value);p.start();self.addCleanup(p.stop)

    def prepare(self, method='个人垫付'):
        c = claim_for(method)
        if method == '差旅费':
            import filling_workflow
            c['invoices'] = [ticket(identifier='inv1')]
            for field, value in filling_workflow.hard_values(c, c['invoices'][0]).items():
                c['answers'][f'purchase:差旅费:inv1:{field}'] = value
        c['invoices'][0]['invoiceNo'] = 'fixture-' + method
        c['invoices'][0]['attachment'] = data.save_file(ACTOR['openId'], ('%PDF fixture '+method).encode(), 'test.pdf', 'application/pdf')
        return c

    def test_multidepartment_all_nontravel_methods_keep_original_create_path(self):
        methods = [m['name'] for m in purchase.public_schema(SCHEMA)['methods'] if m['name'] != '差旅费']
        for method in methods:
            with self.subTest(method=method):
                c = self.prepare(method)
                with patch.object(ctx, 'checked_get', side_effect=AssertionError('No new OAuth contact/task read on non-travel')), patch.object(auth, 'fetch_instance', return_value={'approval_code':auth.BUDGET_DEFINITIONS[0]['approval_code'],'status':'APPROVED','form':[]}), patch.object(auth, 'list_approved_budgets', return_value=([{'instanceId':CODE}],'')), patch.object(purchase.approval_files, 'file_codes', return_value=['mock-original']), patch.object(auth, 'http_json', return_value={'code':0,'data':{'instance_code':CODE}}) as create:
                    receipt = purchase.create_purchase(SESSION, {'claim':c})
                self.assertTrue(receipt['ok'])
                payload = create.call_args.kwargs['payload']
                self.assertEqual(set(payload), {'approval_code','form','uuid'})
                self.assertEqual(payload['approval_code'],purchase.APPROVAL_CODE)
                self.assertEqual(create.call_args.kwargs['token'],SESSION['access_token'])
                self.assertTrue(create.call_args.args[1].endswith('/instances/initiate'))
                self.assertEqual(next(w['value'] for w in json.loads(payload['form']) if w['type']=='attachmentV2'),['mock-original'])
                self.assertNotIn('department', receipt)

    def test_multidepartment_travel_create_checks_real_candidate_and_attachment(self):
        c = self.prepare('差旅费')
        with patch.object(ctx, 'travel_candidates', return_value=[candidate()]) as candidates, patch.object(auth, 'fetch_instance', return_value={}), patch.object(purchase.approval_files, 'file_codes', return_value=['mock-original']), patch.object(auth, 'http_json', return_value={'code':0,'data':{'instance_code':CODE}}) as create:
            self.assertTrue(purchase.create_purchase(SESSION, {'claim':c})['ok'])
        candidates.assert_called_once()
        self.assertEqual(set(create.call_args.kwargs['payload']), {'approval_code','form','uuid'})

    def test_revoked_travel_candidate_stops_before_upload_and_create(self):
        c = self.prepare('差旅费')
        with patch.object(ctx, 'travel_candidates', return_value=[]), patch.object(purchase.approval_files, 'file_codes') as upload, patch.object(auth, 'http_json') as create:
            with self.assertRaisesRegex(ValueError,'不可关联'):purchase.create_purchase(SESSION, {'claim':c})
        upload.assert_not_called();create.assert_not_called()

    def test_nontravel_original_budget_scope_rule_still_rejects_outsider(self):
        c = self.prepare()
        with patch.object(auth,'fetch_instance',return_value={'approval_code':auth.BUDGET_DEFINITIONS[0]['approval_code'],'status':'APPROVED','form':[]}), patch.object(auth,'list_approved_budgets',return_value=([],'')), patch.object(purchase.approval_files,'file_codes') as upload, patch.object(auth,'http_json') as create:
            with self.assertRaisesRegex(ValueError,'范围'):purchase.create_purchase(SESSION,{'claim':c})
        upload.assert_not_called();create.assert_not_called()


class ContextHTTPTests(unittest.TestCase):
    close_server = http_fixture.ExpenseHTTPTests.close_server
    request = http_fixture.ExpenseHTTPTests.request

    def setUp(self):
        http_fixture.ExpenseHTTPTests.setUp(self)
        p = patch.object(auth,'fetch_user_info',return_value=dict(ACTOR,openId='alice'))
        p.start();self.addCleanup(p.stop)

    def test_manual_travel_without_ticket_retrieves_real_candidates_and_runs_ai(self):
        c = claim({'id':'hotel','amount':10,'category':'lodging'})
        with patch.object(ctx,'travel_candidates',return_value=[candidate()]) as read, patch.object(travel,'ai_rank',return_value=({'instanceId':CODE},'')) as ai:
            status,result,_ = self.request('/api/travel-match',json.dumps({'claim':c}).encode())
        self.assertEqual(status,200);read.assert_called_once();ai.assert_called_once()
        self.assertEqual(result['owner'],'alice');self.assertIsNone(result['autoSelectId'])

    def test_permission_error_is_403_not_empty_candidate_success(self):
        with patch.object(ctx,'travel_candidates',side_effect=auth.FeishuAPIError(400,{'code':99991672,'msg':'scope required'})):
            status,result,_ = self.request('/api/travel-match',json.dumps({'claim':claim()}).encode())
        self.assertEqual(status,403);self.assertFalse(result['ok'])
        self.assertIn('产品 OAuth',result['error']);self.assertIn('CLI',result['error']);self.assertNotIn('candidates',result)

    def test_travel_preview_rechecks_candidate_and_keeps_original_file_rules(self):
        import filling_workflow
        c = claim_for('差旅费');c['invoices']=[ticket(identifier='inv1')]
        c['invoices'][0]['attachment']=data.save_file('alice',b'%PDF fixture preview','preview.pdf','application/pdf')
        for field,value in filling_workflow.hard_values(c,c['invoices'][0]).items():c['answers'][f'purchase:差旅费:inv1:{field}']=value
        with patch.object(ctx,'travel_candidates',return_value=[candidate()]) as candidates, patch.object(auth,'http_json') as upstream:
            body=json.dumps({'claim':c}).encode()
            status,result,_=self.request('/api/review',body)
            self.assertEqual(status,200,result);self.assertEqual(result['attachmentCount'],1)
            candidates.return_value=[]
            status,result,_=self.request('/api/review',body)
            self.assertEqual(status,422);self.assertIn('不可关联',result['error'])
            upstream.assert_not_called()

    def test_nontravel_preview_requires_no_new_oauth_profile_or_task_read(self):
        c=claim_for();c['invoices'][0]['attachment']=data.save_file('alice',b'%PDF non-travel','personal.pdf','application/pdf')
        with patch.object(auth,'fetch_user_info',side_effect=AssertionError('No additional profile read')), patch.object(ctx,'checked_get',side_effect=AssertionError('No added OAuth scope')):
            status,result,_=self.request('/api/review',json.dumps({'claim':c}).encode())
        self.assertEqual(status,200,result)


if __name__ == '__main__':unittest.main()
