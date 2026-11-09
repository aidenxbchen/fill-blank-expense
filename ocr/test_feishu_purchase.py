"""Purchase mapping and exactly-once guard tests. Never creates live approvals."""
import copy
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

import feishu_oauth as auth
import feishu_purchase as p

SCHEMA = json.loads((Path(__file__).parent / 'purchase_definition.json').read_text())
ASSOCIATED = '11111111-2222-3333-4444-555555555555'


def claim_for(method='个人垫付'):
    method_widget = next(w for w in SCHEMA['form'] if w['name'] == '采购方式')
    method_value = p.option_value(method_widget, method)
    table = next(w for w in SCHEMA['form'] if w['type'] == 'fieldList' and p.visible(w, {method_widget['id']: method_value}))
    fields = {}
    for c in table['children']:
        if c['name'] in ('金额', '名称', '备注'):
            continue
        fields[c['id']] = c['option'][0]['value'] if c['type'] == 'radioV2' else ('2' if c['type'] == 'number' else '已确认信息')
    return {'purchaseMethod': method, 'project': '软件组', 'purpose': '测试映射，不发起审批',
            'selectedBudget': {'instanceCode': ASSOCIATED},
            'total': 99999, 'detailSheets': [{'rows': [{'amount': 99999}]}],
            'invoiceRows': [{'id': 'invoice-1', 'merchant': '用户改后的商户', 'amount': '12.34',
                             'date': '2026-11-08', 'invoiceNo': '12345678', 'source': 'pdf-text', 'fields': fields}]}


class Mapping(unittest.TestCase):
    def test_seven_purchase_branches(self):
        methods = next(w for w in SCHEMA['form'] if w['name'] == '采购方式')['option']
        for method in methods:
            with self.subTest(method=method['text']):
                form, total, linked = p.build_form(claim_for(method['text']), SCHEMA)
                self.assertEqual(str(total), '12.34')
                self.assertEqual(len([w for w in form if w['type'] == 'fieldList']), 1)
                self.assertEqual(bool(linked), method['text'] != '预付款项')
                table = next(w for w in form if w['type'] == 'fieldList')
                amount = next(c for c in table['value'][0] if c['type'] == 'amount')
                self.assertEqual(amount['value'], 12.34)
                self.assertEqual(amount['currency'], 'CNY')
                note = next(c for c in table['value'][0] if c['type'] == 'textarea')
                self.assertIn('12345678', note['value'])
                self.assertIn('用户改后的商户', note['value'])
                if linked:
                    self.assertEqual(next(w for w in form if w['type'] == 'connect')['value'], [ASSOCIATED])

    def test_required_top_fields(self):
        for field in ('purchaseMethod', 'project', 'purpose'):
            claim = claim_for(); claim[field] = ''
            with self.subTest(field=field), self.assertRaises(p.ValidationError):
                p.build_form(claim, SCHEMA)

    def test_reject_invalid_invoice_facts(self):
        for amount in ('', 'NaN', 'Infinity', '-1', '0', '1.001', True, None):
            claim = claim_for(); claim['invoiceRows'][0]['amount'] = amount
            with self.subTest(amount=amount), self.assertRaises(p.ValidationError):
                p.build_form(claim, SCHEMA)

    def test_empty_rows_and_mock_not_submitted(self):
        claim = claim_for(); claim['invoiceRows'] = []
        with self.assertRaises(p.ValidationError): p.build_form(claim, SCHEMA)
        claim = claim_for(); claim['invoiceRows'][0]['source'] = 'mock'
        with self.assertRaises(p.ValidationError): p.build_form(claim, SCHEMA)

    def test_no_guessed_spec_quantity_or_payee(self):
        for method in ('个人垫付', '合同审批', '预付款项', '京东工品汇'):
            claim = claim_for(method); claim['invoiceRows'][0]['fields'] = {}
            with self.subTest(method=method), self.assertRaises(p.ValidationError):
                p.build_form(claim, SCHEMA)

    def test_association_required_except_prepayment(self):
        claim = claim_for(); claim['selectedBudget'] = None
        with self.assertRaises(p.ValidationError): p.build_form(claim, SCHEMA)
        claim = claim_for('预付款项'); claim['selectedBudget'] = None
        self.assertEqual(p.build_form(claim, SCHEMA)[2], '')

    @patch.object(p, 'api')
    def test_association_type_and_approved_status_checked(self, api):
        for definition, status in [(p.APPROVAL_CODE, 'APPROVED'), (next(iter(p.ALLOWED_CODES)), 'PENDING')]:
            api.return_value = {'definition_code': definition, 'status': status}
            with self.assertRaises(p.ValidationError): p.validate_association('user-token', ASSOCIATED)
        for definition in p.ALLOWED_CODES:
            api.return_value = {'definition_code': definition, 'status': 'APPROVED'}
            p.validate_association('user-token', ASSOCIATED)

    @patch.dict('os.environ', {'FEISHU_SCOPES': 'offline_access approval:instance:read'})
    def test_old_scope_override_cannot_drop_creation_permissions(self):
        self.assertIn(p.WRITE_SCOPE, auth.oauth_scopes().split())
        self.assertIn(p.READ_SCOPE, auth.oauth_scopes().split())


class Create(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.patch = patch.object(p, 'journal_path', return_value=Path(self.temp.name) / 'submissions.sqlite')
        self.patch.start(); self.addCleanup(self.patch.stop)
        self.body = {'requestId': str(uuid.uuid4()), 'claim': claim_for()}
        self.user = {'openId': 'ou_current_user'}
        self.definition = patch.object(p, 'definition', return_value=copy.deepcopy(SCHEMA)).start()
        self.association = patch.object(p, 'validate_association').start()
        self.addCleanup(patch.stopall)

    def create(self):
        return p.create_purchase('current-oauth-token', self.user, self.body)

    @patch.object(p, 'api', return_value={'instance_code': ASSOCIATED, 'instance_link': 'https://go.feishu.cn/approval/example'})
    def test_posts_with_user_token_and_replays_success_after_restart(self, api):
        first = self.create(); self.assertEqual(first, self.create())
        api.assert_called_once()
        args = api.call_args.args
        self.assertEqual(args[:3], ('POST', '/instances/initiate', 'current-oauth-token'))
        self.assertEqual(args[3]['approval_code'], p.APPROVAL_CODE)
        self.assertEqual(args[3]['uuid'], self.body['requestId'])
        self.assertNotIn('open_id', args[3])
        self.assertNotIn('stub', first)
        # A cached success does not depend on a subsequent definition read.
        self.definition.assert_called_once()

    @patch.object(p, 'api', side_effect=auth.FeishuAPIError(502, {'error': 'connection lost'}))
    def test_uncertain_network_result_blocks_second_post(self, api):
        with self.assertRaises(auth.FeishuAPIError): self.create()
        with self.assertRaises(p.SubmissionConflict): self.create()
        api.assert_called_once()

    @patch.object(p, 'api', return_value={})
    def test_missing_instance_code_is_not_success(self, api):
        with self.assertRaises(auth.FeishuAPIError): self.create()
        with self.assertRaises(p.SubmissionConflict): self.create()

    @patch.object(p, 'api', side_effect=auth.FeishuAPIError(400, {'code': 99991672, 'msg': 'Access denied. scopes required'}))
    def test_explicit_scope_rejection_can_retry_after_reauthorization(self, api):
        with self.assertRaises(auth.FeishuAPIError): self.create()
        api.side_effect = None; api.return_value = {'instance_code': ASSOCIATED}
        self.assertTrue(self.create()['ok'])
        self.assertEqual(api.call_count, 2)

    @patch.object(p, 'api', return_value={'instance_code': ASSOCIATED})
    def test_same_uuid_cannot_be_reused_with_other_content(self, api):
        self.create(); self.body['claim']['purpose'] = 'changed'
        with self.assertRaises(p.SubmissionConflict): self.create()
        api.assert_called_once()

    @patch.object(p, 'api')
    def test_mapping_failure_never_calls_create(self, api):
        self.body['claim']['purpose'] = ''
        with self.assertRaises(p.ValidationError): self.create()
        api.assert_not_called()

    @patch.object(p, 'api', return_value={'instance_code': ASSOCIATED})
    def test_concurrent_clicks_create_only_once(self, api):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        gate = Barrier(2)
        self.definition.side_effect = lambda token: (gate.wait(timeout=5), copy.deepcopy(SCHEMA))[1]
        def invoke():
            try: return self.create()
            except p.SubmissionConflict: return {'pending': True}
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: invoke(), range(2)))
        self.assertTrue(any(r.get('ok') for r in results))
        api.assert_called_once()


class Handler(unittest.TestCase):
    @patch.object(p, 'session_for', side_effect=auth.FeishuAPIError(401, {'error': '请先用飞书登录'}))
    def test_no_login_is_401(self, _):
        handler = Mock(); p.handle_purchase(handler, {})
        self.assertEqual(handler._json.call_args.args[0], 401)
        self.assertFalse(handler._json.call_args.args[1]['ok'])

    @patch.object(p, 'session_for', return_value={'access_token': 'user-token', 'user': {'openId': 'ou_user'}})
    @patch.object(p, 'create_purchase', side_effect=auth.FeishuAPIError(403, {'code': 99991672, 'msg': 'Access denied. scope required'}))
    def test_missing_scope_has_actionable_error(self, *_):
        handler = Mock(); p.handle_purchase(handler, {})
        status, result = handler._json.call_args.args
        self.assertEqual(status, 403)
        self.assertFalse(result['ok'])
        self.assertIn(p.WRITE_SCOPE, result['requiredScopes'])

    @patch.object(p, 'session_for', return_value={'access_token': 'user-token'})
    def test_json_null_cannot_return_definition_as_submission_success(self, _):
        handler = Mock(); p.handle_purchase(handler, None)
        status, result = handler._json.call_args.args
        self.assertEqual(status, 400)
        self.assertFalse(result['ok'])


class Routing(unittest.TestCase):
    def test_real_http_routes_require_login_and_reject_invalid_json(self):
        import threading
        import urllib.error
        import urllib.request
        from http.server import ThreadingHTTPServer
        from server import Handler as HTTPHandler
        server = ThreadingHTTPServer(('127.0.0.1', 0), HTTPHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = 'http://127.0.0.1:' + str(server.server_port)
            with patch.object(auth, 'get_session', return_value=None):
                for path, body, expected in [('/api/feishu-purchase-definition', None, 401),
                                              ('/api/feishu-expense', b'{}', 401),
                                              ('/api/feishu-expense', b'{', 400)]:
                    req = urllib.request.Request(base + path, data=body, headers={'Content-Type':'application/json'})
                    with self.assertRaises(urllib.error.HTTPError) as err:
                        urllib.request.urlopen(req)
                    self.assertEqual(err.exception.code, expected)
                    result = json.loads(err.exception.read())
                    err.exception.close()
                    self.assertFalse(result['ok'])
                    self.assertNotIn('feishuApprovalId', result)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=5)


if __name__ == '__main__': unittest.main()
