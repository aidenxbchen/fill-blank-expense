"""Offline acceptance fixtures: no production approval creation or handbook writes."""
import copy
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock, patch

import expense_data as data
import feishu_oauth as auth
import feishu_purchase as purchase
import filling_workflow as flow
import handbook
from test_feishu_purchase import SCHEMA, claim_for


def ts(iso):
    return int(datetime.fromisoformat(iso).timestamp() * 1000)


def approved(status='APPROVED', linked='budget'):
    return {'approval_code': purchase.APPROVAL_CODE, 'status': status,
            'start_time': ts('2026-11-02T09:00:00+08:00'), 'end_time': ts('2026-11-03T09:00:00+08:00'),
            'user_id': 'alice', 'form': [{'type': 'connect', 'value': [linked]}]}


def budget(code=None, status='APPROVED'):
    return {'approval_code': code or auth.BUDGET_DEFINITIONS[0]['approval_code'], 'status': status}


class FillingWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        source = handbook.read_handbook()
        self.md = root / '报了呗.md'
        self.md.write_text(source)
        for obj, key, value in [(data, 'DB_PATH', root / 'db.sqlite'), (data, 'FILE_ROOT', root / 'files'),
                                (handbook, 'HANDBOOK_PATH', self.md)]:
            p = patch.object(obj, key, value)
            p.start()
            self.addCleanup(p.stop)
        self.schema = purchase.public_schema(SCHEMA)

    def claim(self, method='普通采购', purpose='研发试制'):
        typ = '普通采购' if method=='个人垫付' else method
        claim = claim_for(typ)
        claim['purpose'] = purpose
        claim['answers']['purpose'] = purpose
        claim['answers']['expenseType'] = typ
        claim['expenseType'] = typ
        claim['answers'].pop(f'expense:{typ}:{claim["invoices"][0]["id"]}:明细采购类别', None)
        claim['invoices'][0].update(category='meal', merchant='合成餐饮服务', items=[])
        return claim

    def test_admission_rejects_tasks_and_trip_only_before_reading_expenses(self):
        for status in ('PENDING', 'DONE', 'CANCELED', 'REJECTED', 'DELETED'):
            fetch = Mock(side_effect=AssertionError('must not inspect excluded expenses'))
            self.assertFalse(flow.eligible(approved(status), fetch))
            fetch.assert_not_called()
        purchase_form = approved()
        purchase_form['approval_code'] = flow.PURCHASE_CODE
        self.assertFalse(flow.eligible(purchase_form, lambda _: budget()))
        # Expense claims do not require a budget connect; an approved form is enough.
        self.assertTrue(flow.eligible(approved(), lambda _: budget()))
        empty = approved(); empty['form'] = []
        self.assertTrue(flow.eligible(empty, Mock(side_effect=AssertionError('no link required'))))

    def test_shanghai_month_boundary_and_approved_date_are_enforced(self):
        detail = approved()
        detail['start_time'] = ts('2026-10-31T16:00:00+00:00')
        self.assertTrue(flow.eligible(detail, lambda _: budget()))
        detail['start_time'] -= 1
        self.assertFalse(flow.eligible(detail, lambda _: budget()))
        detail = approved()
        detail['end_time'] = ts('2026-11-30T16:00:00+00:00')
        self.assertTrue(flow.eligible(detail, lambda _: budget()))
        later = approved()
        later['start_time'] = ts('2026-12-15T00:00:00+08:00')
        later['end_time'] = ts('2026-12-16T00:00:00+08:00')
        self.assertTrue(flow.eligible(later, lambda _: budget()))

    def test_twenty_five_rows_prefill_hard_rules_and_keep_manual_conflict(self):
        c = self.claim('差旅费', '本次上海出差')
        kinds = [('保险费', 'other', '交通费'), ('代订附加', 'transit', '交通费'),
                 ('餐饮服务', 'meal', '餐费补贴'), ('客房服务', 'lodging', '住宿费')]
        c['invoices'] = [{**c['invoices'][0], 'id': 'r' + str(i), 'merchant': kinds[i % 4][0], 'category': kinds[i % 4][1]} for i in range(25)]
        manual = 'expense:差旅费:r1:名称'
        c['answers'][manual] = '其他'
        result = flow.prefill('alice', 'batch', c, self.schema)
        for i in range(25):
            key = f'expense:差旅费:r{i}:名称'
            if i != 1:
                self.assertEqual(result['answers'][key], kinds[i % 4][2])
        self.assertEqual(result['answers'][manual], '其他')
        self.assertTrue(result['evidence'][manual]['hard'])
        with self.assertRaisesRegex(ValueError, '手册规则冲突'):
            flow.validate_claim({**c, 'answers': result['answers']})
        result['answers'][manual] = '交通费'
        flow.validate_claim({**c, 'answers': result['answers']})

    def test_purpose_is_required_for_nontravel_inference_and_live_options_win(self):
        c = self.claim(purpose='')
        c['invoices'][0].update(merchant='合成元器件供应商', category='purchase')
        self.assertNotIn('expense:普通采购:inv1:明细采购类别', flow.prefill('alice', 'unknown', c, self.schema)['answers'])
        c['purpose'] = '研发试制'
        result = flow.prefill('alice', 'known', c, self.schema)
        self.assertEqual(result['answers']['expense:普通采购:inv1:明细采购类别'], '研发耗材')
        schema = copy.deepcopy(self.schema)
        for m in schema['methods']:
            for w in m['fields']:
                w['options'] = [v for v in w['options'] if v != '研发耗材']
        self.assertNotIn('expense:普通采购:inv1:明细采购类别', flow.prefill('alice', 'changed', c, schema)['answers'])

    def test_confirmed_meal_and_invoice_items_outrank_hotel_merchant(self):
        self.assertEqual(flow.content_class({'merchant': '合成酒店', 'category': 'meal'}), 'meal')
        self.assertEqual(flow.content_class({'merchant': '合成酒店', 'items': [{'name': '餐饮服务'}]}), 'meal')

    def test_submit_hook_keeps_baseline_and_differences_immutable_until_verified(self):
        c = self.claim(purpose='面试沟通')
        flow.prefill('alice', 'draft', c, self.schema)
        c['answers']['expense:普通采购:inv1:明细采购类别'] = '招聘费'
        c['invoices'][0]['amount'] = 88
        # Re-opening/re-prefilling after editing must not replace the generated baseline.
        flow.prefill('alice', 'draft', c, self.schema)
        receipt = {'ok': True, 'instanceCode': 'new-approval'}
        with patch.object(purchase.expense_records, 'record_submission') as persist:
            purchase.save_history({'owner': 'alice', 'draftId': 'draft', 'claim': c}, receipt)
            persist.assert_called_once()
        flow.capture_submission('alice', 'draft', {**c, 'purpose': 'tampered replay'}, receipt)
        with data.database() as con:
            row = con.execute('SELECT * FROM workflow_learning').fetchone()
        differences = json.loads(row['differences'])
        self.assertTrue(any(d['field'] == 'amount' for d in differences))
        self.assertTrue(any(d['submitted'] == '招聘费' for d in differences))
        self.assertEqual(json.loads(row['final'])['purpose'], '面试沟通')
        self.assertEqual(row['verified'], 0)
        before = self.md.read_text()
        flow.sync_pending(fetch=lambda _: approved('PENDING'))
        self.assertEqual(flow.verified_claims('alice'), [])
        self.assertEqual(flow.rules()['learned'], [])
        flow.sync_pending(fetch=lambda code: approved() if code == 'new-approval' else budget())
        self.assertEqual(len(flow.verified_claims('alice')), 1)
        self.assertNotEqual(self.md.read_text(), before)
        self.assertIn('已核验正样本 1 单', self.md.read_text())

    def test_three_distinct_approvals_upgrade_md_then_next_prefill_uses_it(self):
        key = 'expense:普通采购:inv1:明细采购类别'
        c = self.claim(purpose='招聘面试沟通')
        for i in range(3):
            flow.prefill('alice', 'd' + str(i), c, self.schema)
            final = copy.deepcopy(c)
            final['answers'][key] = '招聘费'
            # Repeated rows in the same instance must not inflate support.
            final['invoices'] *= 25
            flow.capture_submission('alice', 'd' + str(i), final, {'ok': True, 'instanceCode': 'p' + str(i)})
        flow.sync_pending(fetch=lambda code: budget() if code == 'budget' else approved())
        learned = flow.rules()['learned']
        self.assertEqual(len(learned), 1)
        self.assertEqual(learned[0]['support'], 3)
        self.assertEqual(flow.prefill('bob', 'next', c, self.schema)['answers'][key], '招聘费')
        self.assertEqual(flow.rules()['travel']['insurance'], '交通费')
        other = self.claim(purpose='客户接待')
        self.assertNotIn(key, flow.prefill('bob', 'other', other, self.schema)['answers'])
        # Conflicting evidence withdraws the generated suggestion on the next update.
        other = copy.deepcopy(c)
        other['answers'][key] = '业务招待费'
        flow.capture_submission('alice', 'different', other, {'ok': True, 'instanceCode': 'p4'})
        flow.sync_pending(fetch=lambda code: budget() if code == 'budget' else approved())
        self.assertEqual(flow.rules()['learned'], [])

    def test_unverified_old_observations_never_become_history_and_owner_isolation(self):
        c = self.claim(purpose='面试沟通')
        key = 'expense:普通采购:inv1:明细采购类别'
        c['answers'][key] = '招聘费'
        data.record_fills('alice', 'legacy', c, self.schema)
        self.assertEqual(flow.suggestions('alice', c, self.schema)['rows']['inv1']['科目'], [])
        flow.capture_submission('alice', 'legacy', c, {'ok': True, 'instanceCode': 'p'})
        flow.sync_pending(fetch=lambda code: budget() if code == 'budget' else approved())
        fresh = self.claim(purpose='面试沟通')
        self.assertEqual(flow.prefill('alice', 'next', fresh, self.schema)['answers'][key], '招聘费')
        self.assertNotIn(key, flow.prefill('bob', 'next', fresh, self.schema)['answers'])

    def test_preview_validates_real_originals_without_upload_or_initiation(self):
        c = claim_for()
        ref = data.save_file('alice', b'%PDF fixture original', 'fixture.pdf', 'application/pdf')
        c['invoices'][0]['attachment'] = ref
        with patch.object(purchase.approval_files, 'file_codes') as upload, patch.object(auth, 'http_json') as network:
            self.assertEqual(flow.review('alice', c, SCHEMA)['attachmentCount'], 1)
            upload.assert_not_called()
            network.assert_not_called()
        with self.assertRaisesRegex(ValueError, '不属于'):
            flow.review('bob', c, SCHEMA)
        (data.FILE_ROOT / ref['file_id']).write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, '完整性'):
            flow.review('alice', c, SCHEMA)

    def test_history_import_reads_only_qualified_owned_purchase_content(self):
        items = [{'instance_code': 'mine', 'user_id': 'alice'}, {'instance_code': 'other', 'user_id': 'bob'},
                 {'instance_code': 'old', 'user_id': 'alice', 'start_time': ts('2026-10-01T00:00:00+08:00')},
                 {'instance_code': 'trip-only', 'user_id': 'alice'}]
        copied = [{'instance_code': 'cced', 'user_id': 'bob', 'start_time': ts('2026-12-02T00:00:00+08:00')}]
        lookup = {'mine': approved(), 'trip-only': {**approved(), 'approval_code': flow.PURCHASE_CODE},
                  'cced': {**approved(), 'user_id': 'bob', 'cc_user_ids': ['alice'], 'start_time': ts('2026-12-02T00:00:00+08:00'), 'end_time': ts('2026-12-03T00:00:00+08:00')}}
        def read(token, code):
            return lookup[code]
        with patch.object(auth, 'get_tenant_access_token', return_value='fixture'), patch.object(auth, 'query_approved_instances', return_value=items), patch.object(auth, 'query_cc_instances', return_value=copied), patch.object(auth, 'fetch_instance', side_effect=read) as fetch, patch.object(purchase, 'definition', return_value=SCHEMA), patch.object(flow, 'decode_claim', return_value=self.claim()) as decode:
            flow.import_history({'openId': 'alice'})
            self.assertEqual(decode.call_count, 2)
            fetched = [c.args[1] for c in fetch.call_args_list]
            self.assertNotIn('other', fetched)
            self.assertNotIn('old', fetched)
            self.assertIn('cced', fetched)
        self.assertEqual(len(flow.verified_claims('alice')), 2)

    def test_definition_option_ids_decode_and_markdown_write_recovers_after_crash(self):
        c = claim_for()
        detail = approved()
        detail['form'] = purchase.build_form(SCHEMA, c)
        decoded = flow.decode_claim(detail, SCHEMA)
        self.assertEqual(decoded['expenseType'], c['expenseType'])
        self.assertEqual(decoded['payer'], c['payer'])
        self.assertEqual(decoded['purpose'], c['purpose'])
        flow.capture_submission('alice', 'draft', c, {'ok': True, 'instanceCode': 'approved-local'})
        with patch.object(flow, 'update_handbook', side_effect=OSError('fixture disk unavailable')):
            with self.assertRaises(OSError):
                flow.sync_pending(fetch=lambda code: budget() if code == 'budget' else approved())
        self.assertEqual(len(flow.verified_claims('alice')), 1)
        # No pending rows remain. The next worker cycle still repairs the Markdown.
        flow.sync_pending(fetch=Mock(side_effect=AssertionError('no extra network needed')))
        self.assertIn('已核验正样本 1 单', self.md.read_text())

    def test_newer_history_outranks_older_same_pattern(self):
        key = 'expense:普通采购:inv1:明细采购类别'
        older = self.claim(purpose='面试沟通')
        newer = self.claim(purpose='面试沟通')
        older['answers'][key] = '业务招待费'
        newer['answers'][key] = '招聘费'
        now = int(__import__("time").time())
        with data.database() as con:
            flow.tables(con)
            con.execute('INSERT INTO workflow_learning(owner,instance_code,baseline,final,differences,verified,occurred_at,source) VALUES(?,?,?,?,?,1,?,?)',
                        ('alice','old','{}', __import__('json').dumps(older, ensure_ascii=False),'[]', now-180*86400, 'self'))
            con.execute('INSERT INTO workflow_learning(owner,instance_code,baseline,final,differences,verified,occurred_at,source) VALUES(?,?,?,?,?,1,?,?)',
                        ('alice','new','{}', __import__('json').dumps(newer, ensure_ascii=False),'[]', now-86400, 'cc'))
        fresh = self.claim(purpose='面试沟通')
        result = flow.prefill('alice', 'recency', fresh, self.schema)
        self.assertEqual(result['answers'][key], '招聘费')
        choices = flow.history_choices('alice', fresh, fresh['invoices'][0], '明细采购类别', flow.verified_samples('alice'))
        self.assertEqual(choices[0]['value'], '招聘费')
        self.assertGreater(choices[0]['probability'], choices[1]['probability'])

    def test_cc_import_failure_is_explicit(self):
        items = [{'instance_code': 'mine', 'user_id': 'alice'}]
        with patch.object(auth, 'get_tenant_access_token', return_value='fixture'), patch.object(auth, 'query_approved_instances', return_value=items), patch.object(auth, 'query_cc_instances', side_effect=auth.FeishuAPIError(502, {'code': -1, 'msg': '抄送列表读取失败'})), patch.object(auth, 'fetch_instance', return_value=approved()), patch.object(purchase, 'definition', return_value=SCHEMA), patch.object(flow, 'decode_claim', return_value=self.claim()):
            result = flow.import_history({'openId': 'alice'})
        self.assertFalse(result['ok'])
        self.assertTrue(result['ccError'])
        self.assertEqual(len(flow.verified_claims('alice')), 1)
        self.assertIn('抄送列表读取失败', self.md.read_text())

if __name__ == '__main__':
    unittest.main()
