import hashlib
import io
import json
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

import form_alignment as alignment
import internet_handoff as handoff
import test_recurring_internet as internet

PDF = b'%PDF fixture internet'
ATTACHMENT = {'name': 'net.pdf', 'mime': 'application/pdf', 'raw': PDF}


class HandoffTests(unittest.TestCase):
    def test_billing_period_outranks_invoice_date(self):
        month, source = handoff.invoice_month(internet.invoice())
        self.assertEqual(month, '2026年10月')
        self.assertEqual(source, '计费周期')
        self.assertEqual(handoff.message_for(internet.invoice())['text'],
                         '颖华，这是2026年10月的电信网络发票，由我垫付，请完成报销。')

    def test_invoice_date_used_when_no_billing_period(self):
        inv = internet.invoice(internet.TEXT.replace('计费周期:202610;号码:internet-test-account;', '号码:internet-test-account;'))
        month, source = handoff.invoice_month(inv)
        self.assertEqual(month, '2026年11月')
        self.assertEqual(source, '开票日期')

    def test_missing_month_fails_closed(self):
        text = internet.TEXT.replace('计费周期:202610;号码:internet-test-account;', '').replace('开票日期：2026年11月20日', '')
        with self.assertRaisesRegex(handoff.HandoffError, '月份'):
            handoff.invoice_month(internet.invoice(text))

    def test_public_preview_hides_open_id_and_never_sends(self):
        def boom(*args, **kwargs):
            raise AssertionError('dry-run must not hit the network')
        with patch.object(urllib.request, 'urlopen', boom):
            plan = handoff.deliver(internet.invoice(), ATTACHMENT, dry_run=True)
        self.assertFalse(plan['sent'])
        self.assertEqual(plan['recipientName'], '李颖华')
        self.assertTrue(plan['uploadRehearsal']['wouldUpload'])
        self.assertEqual(plan['uploadRehearsal']['fileName'], 'net.pdf')
        self.assertEqual(plan['uploadRehearsal']['fileType'], 'pdf')
        self.assertEqual(plan['uploadRehearsal']['size'], len(PDF))
        self.assertEqual(plan['attachments'][0]['sha256'], hashlib.sha256(PDF).hexdigest())
        self.assertEqual(plan['transport']['files'][0]['fileName'], 'net.pdf')
        self.assertNotIn('openId', str(plan))
        self.assertNotIn(handoff.load_recipient()['openId'], str(plan))
        with self.assertRaisesRegex(handoff.HandoffError, '附件'):
            handoff.deliver(internet.invoice(), {'name': 'net.pdf'}, dry_run=True)
        with self.assertRaisesRegex(handoff.HandoffError, '附件'):
            handoff.deliver(internet.invoice(), dry_run=False, live_enabled=True)
        blocked = handoff.deliver(internet.invoice(), ATTACHMENT, dry_run=False, live_enabled=True)
        self.assertFalse(blocked['sent'])
        self.assertFalse(blocked['realSend'])
        self.assertTrue(blocked['uploadRehearsal']['wouldUpload'])
        self.assertNotIn('openId', str(blocked))

    def test_send_handoff_uploads_then_sends_text_and_file(self):
        calls = []
        def fake_urlopen(req, timeout=60):
            calls.append(('upload', req.full_url, req.data))
            self.assertIn('/open-apis/im/v1/files', req.full_url)
            self.assertIn(b'net.pdf', req.data)
            self.assertIn(PDF, req.data)
            return io.BytesIO(json.dumps({'code': 0, 'data': {'file_key': 'fk_test'}}).encode())
        def fake_http(method, url, token=None, payload=None):
            calls.append((payload['msg_type'], json.loads(payload['content'])))
            return {'code': 0}
        with patch.object(urllib.request, 'urlopen', fake_urlopen), patch('feishu_oauth.http_json', fake_http):
            result = handoff.send_handoff('tok', {'openId': 'test-recipient-id'}, '颖华，这是测试。', ATTACHMENT)
        self.assertEqual([c[0] for c in calls], ['upload', 'text', 'file'])
        self.assertEqual(calls[1][1], {'text': '颖华，这是测试。'})
        self.assertEqual(calls[2][1], {'file_key': 'fk_test'})
        self.assertTrue(result['file'])
        self.assertEqual(result['fileName'], 'net.pdf')

    def test_send_handoff_stops_before_messages_if_upload_fails(self):
        messages = []
        def fail_upload(req, timeout=60):
            import urllib.error
            raise urllib.error.URLError('upload blocked')
        def fake_http(method, url, token=None, payload=None):
            messages.append(payload)
            return {'code': 0}
        with patch.object(urllib.request, 'urlopen', fail_upload), patch('feishu_oauth.http_json', fake_http):
            with self.assertRaisesRegex(handoff.HandoffError, '附件上传未完成'):
                handoff.send_handoff('tok', {'openId': 'test-recipient-id'}, '不应发出', ATTACHMENT)
        self.assertEqual(messages, [])


class FormAlignmentTests(unittest.TestCase):
    def test_expense_children_stay_in_their_groups(self):
        _, form = alignment.load_definition(alignment.EXPENSE_PATH)
        mapping = alignment.index_children(form)
        self.assertEqual(mapping['部门'], '费用明细')
        self.assertEqual(mapping['出差备注'], '出差明细')
        self.assertEqual(mapping['关联审批'], '出差明细')
        with self.assertRaisesRegex(ValueError, '属于'):
            alignment.assert_row_in_group(form, '出差明细', [{'name': '部门'}])
        alignment.assert_row_in_group(form, '费用明细', [{'name': '部门'}])
        schema = alignment.expense_schema()
        self.assertEqual(schema['approvalCode'], alignment.EXPENSE_CODE)
        names = {g['name'] for g in schema['groups']}
        self.assertEqual(names, {'费用明细', '出差明细', '薪酬明细'})
        self.assertEqual(schema['departmentField']['name'], '部门')

    def test_purchase_groups_do_not_share_unique_children(self):
        groups = {g['name']: {c['name'] for c in g['children']} for g in alignment.purchase_groups()}
        self.assertIn('个人垫付科目', groups['个人垫付'])
        self.assertIn('差旅科目', groups['差旅费'])
        self.assertNotIn('个人垫付科目', groups['差旅费'])
        self.assertNotIn('差旅科目', groups['个人垫付'])


if __name__ == '__main__':
    unittest.main()
