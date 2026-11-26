import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import feishu_oauth as auth
import feishu_purchase as p

SCHEMA = json.loads(Path(__file__).with_name('expense_definition.json').read_text())['form']
ACTOR = {'openId':'ou_oauth_user', 'name':'测试申请人'}


def claim_for(expense_type='普通采购', payer='个人支付'):
    answers = {'expenseType':expense_type, 'payer':payer, 'purpose':'费用报销测试（不发起真实审批）',
               'submitterOpenId':ACTOR['openId'], 'submitterDepartmentId':'od_fixture_dept'}
    group = p.active_group(SCHEMA, expense_type)[2]
    for w in group['children']:
        if not w.get('required') or w['name'] in ('名称','金额','发票号码','日期','日期（年-月-日）','采购备注','出差备注','申请人','发起人','部门','关联审批'):
            if w['type']=='radioV2' and w['name']=='名称':
                answers[f"expense:{expense_type}:inv1:{w['name']}"] = '交通费' if expense_type=='差旅费' else w['option'][0]['text']
            elif w['name']=='明细采购类别':
                answers[f"expense:{expense_type}:inv1:{w['name']}"] = w['option'][0]['text']
            elif w['name']=='费用类型' and expense_type=='薪酬':
                answers[f"expense:{expense_type}:inv1:{w['name']}"] = w['option'][0]['text']
            continue
        val = w['option'][0]['text'] if w['type']=='radioV2' else '2' if w['type']=='number' else '已核对信息'
        answers[f"expense:{expense_type}:inv1:{w['name']}"] = val
    category = 'transit' if expense_type=='差旅费' else 'purchase'
    claim = {'expenseType':expense_type, 'payer':payer, 'purpose':'费用报销测试（不发起真实审批）',
            'submitterOpenId':ACTOR['openId'], 'submitterDepartmentId':'od_fixture_dept',
            'invoices':[{'id':'inv1','amount':'123.45','merchant':'用户修正的商户','date':'2026-11-08','invoiceNo':'EDITED-123','category':category}],
            'answers':answers}
    if expense_type=='差旅费':
        claim['relatedApproval']={'instanceId':'22222222-2222-4222-8222-222222222222','kind':'travel','title':'出差夹具'}
        claim['answers']['expense:差旅费:inv1:名称']='交通费'
    return claim


class FormTests(unittest.TestCase):
    def test_three_expense_types_keep_children_in_the_active_group(self):
        schema=p.public_schema(SCHEMA)
        self.assertEqual(schema['approvalName'],'费用报销')
        self.assertEqual(schema['expenseTypes'],['差旅费','普通采购','薪酬'])
        self.assertIn('个人支付',schema['payers'])
        for typ in schema['expenseTypes']:
            with self.subTest(expenseType=typ):
                c=claim_for(typ);form=p.build_form(SCHEMA,c)
                groups=[w for w in form if w['type']=='fieldList']
                self.assertEqual(len(groups),1)
                self.assertEqual(groups[0]['id'],p.active_group(SCHEMA,typ)[2]['id'])
                amount=next(x for x in groups[0]['value'][0] if x['type']=='amount')
                self.assertEqual(amount['value'],123.45)
                self.assertEqual(amount['currency'],'CNY')
                names={w.get('name') or next((c['name'] for c in p.active_group(SCHEMA,typ)[2]['children'] if c['id']==w['id']), '') for w in groups[0]['value'][0]}
                if typ=='普通采购':
                    self.assertIn('部门',{c['name'] for c in p.active_group(SCHEMA,typ)[2]['children']})
                    self.assertTrue(any(w['type']=='department' for w in groups[0]['value'][0]))
                    self.assertFalse(any(w['type']=='connect' for w in groups[0]['value'][0]))
                if typ=='差旅费':
                    self.assertTrue(any(w['type']=='connect' for w in groups[0]['value'][0]))
                    self.assertFalse(any(w['type']=='department' for w in groups[0]['value'][0]))
                if typ=='薪酬':
                    self.assertFalse(any(w['type'] in ('department','connect') for w in groups[0]['value'][0]))

    def test_missing_required_fields_and_misplaced_children(self):
        c=claim_for('差旅费');c['relatedApproval']=None
        with self.assertRaisesRegex(p.ValidationError,'关联审批'):p.build_form(SCHEMA,c)
        c=claim_for();c['invoices'][0]['invoiceNo']=''
        with self.assertRaisesRegex(p.ValidationError,'发票号码'):p.build_form(SCHEMA,c)
        c=claim_for();c['payer']='';c['answers']['payer']=''
        with self.assertRaisesRegex(p.ValidationError,'支出方'):p.build_form(SCHEMA,c)
        c=claim_for();c['submitterDepartmentId']='';c['answers']['submitterDepartmentId']=''
        with self.assertRaisesRegex(p.ValidationError,'部门'):p.build_form(SCHEMA,c)
        # 普通采购 does not require a related approval on this form.
        self.assertTrue(p.build_form(SCHEMA,claim_for('普通采购')))

    def test_amount_and_exact_options(self):
        for bad in ['NaN','Infinity','-1','0','1.001','abc']:
            c=claim_for();c['invoices'][0]['amount']=bad
            with self.assertRaises(p.ValidationError):p.build_form(SCHEMA,c)
        c=claim_for();c['expenseType']='对公转账';c['answers']['expenseType']='对公转账'
        with self.assertRaises(p.ValidationError):p.build_form(SCHEMA,c)
        c=claim_for();c['payer']='待定';c['answers']['payer']='待定'
        with self.assertRaises(p.ValidationError):p.build_form(SCHEMA,c)

    def test_unexpected_new_required_field_fails_closed(self):
        schema=copy.deepcopy(SCHEMA);schema.append({'id':'new','name':'新增必填','type':'input','required':True})
        with self.assertRaisesRegex(p.ValidationError,'新增必填'):p.build_form(schema,claim_for())

    def test_mock_invoice_cannot_be_submitted(self):
        c=claim_for();c['invoices'][0]['source']='mock'
        with self.assertRaisesRegex(p.ValidationError,'模拟发票'):p.build_form(SCHEMA,c)

    def test_wrong_group_child_is_rejected(self):
        from form_alignment import assert_row_in_group
        with self.assertRaisesRegex(ValueError,'部门'):
            assert_row_in_group(SCHEMA,'出差明细',[{'name':'部门'}])

    def test_relation_not_trusting_client_metadata(self):
        travel=claim_for('差旅费')
        for detail in [dict(approval_code='evil',status='APPROVED'),dict(approval_code=next(iter(p.ALLOWED_LINKS)),status='PENDING')]:
            with patch.object(auth,'fetch_instance',return_value=detail),patch.object(p.travel_context,'validate_travel'):
                with self.assertRaises(p.ValidationError):p.validate_relation(travel,ACTOR,'tenant',sess={'access_token':'t'})
        # Ordinary purchase has no connect field; a missing budget does not block packing.
        p.validate_relation(claim_for('普通采购'),ACTOR,'tenant')


class CreateTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        for name,value in [('DB_PATH',Path(self.tmp.name)/'receipt.db')]:
            x=patch.object(p,name,value);x.start();self.addCleanup(x.stop)
        for obj,name,value in [(auth,'fetch_user_info',ACTOR),(auth,'get_tenant_access_token','tenant-token'),(p,'definition',SCHEMA),(p,'validate_relation',None),(auth,'fetch_instance',{'serial_number':'202611090001'})]:
            x=patch.object(obj,name,return_value=value);x.start();self.addCleanup(x.stop)
        for name,value in [('DB_PATH',Path(self.tmp.name)/'data.db'),('FILE_ROOT',Path(self.tmp.name)/'files')]:
            x=patch.object(p.expense_data,name,value);x.start();self.addCleanup(x.stop)
        x=patch.object(p.approval_files,'upload_file',return_value='approval-native-file-code');x.start();self.addCleanup(x.stop)
        self.attachment=p.expense_data.save_file(ACTOR['openId'],b'%PDF-1.7 fixture','invoice.pdf','application/pdf')
        self.sess={'access_token':'oauth-token','user':ACTOR}

    def claim(self):
        c=claim_for();c['invoices'][0]['attachment']=self.attachment;return c

    def test_oauth_actor_pinned_and_receipt_survives_repeat(self):
        body={'claim':self.claim(),'open_id':'ou_forged','user_id':'forged'}
        with patch.object(auth,'http_json',return_value={'code':0,'data':{'instance_code':'real-id','instance_link':'https://feishu.cn/approval/real'}}) as call:
            a=p.create_purchase(self.sess,body);b=p.create_purchase(self.sess,body)
            self.assertEqual(a,b);self.assertEqual(call.call_count,1)
            self.assertNotIn('open_id',call.call_args.kwargs['payload'])
            self.assertNotIn('user_id',call.call_args.kwargs['payload'])
            self.assertEqual(call.call_args.kwargs['token'],'oauth-token')
            self.assertTrue(call.call_args.args[1].endswith('/instances/initiate'))
            self.assertEqual(a['approvalUrl'],'https://feishu.cn/approval/real')
            self.assertEqual(a['serialNumber'],'202611090001')
            self.assertEqual(a['attachmentCount'],1)
            controls=json.loads(call.call_args.kwargs['payload']['form'])
            self.assertEqual(next(w['value'] for w in controls if w['type']=='attachmentV2'),['approval-native-file-code'])
            self.assertEqual(p.DB_PATH.stat().st_mode & 0o777,0o600)

    def test_missing_scope_never_success_and_can_retry_after_fix(self):
        err=auth.FeishuAPIError(400,{'code':99991672,'msg':'missing scope','error':{'permission_violations':[{'subject':'approval:instance'}]}})
        with patch.object(auth,'http_json',side_effect=err) as call:
            for _ in range(2):
                with self.assertRaises(auth.FeishuAPIError):p.create_purchase(self.sess,{'claim':self.claim()})
            self.assertEqual(call.call_count,2)
        self.assertEqual(p.permission_error(err)['requiredScopes'],['approval:instance'])
        self.assertFalse(p.permission_error(err)['ok'])

    def test_unknown_transport_outcome_blocks_repeat(self):
        with patch.object(auth,'http_json',side_effect=TimeoutError) as call:
            with self.assertRaises(TimeoutError):p.create_purchase(self.sess,{'claim':self.claim()})
            with self.assertRaisesRegex(p.ValidationError,'待确认'):p.create_purchase(self.sess,{'claim':self.claim()})
            self.assertEqual(call.call_count,1)

    def test_missing_instance_code_never_success(self):
        with patch.object(auth,'http_json',return_value={'code':0,'data':{}}):
            with self.assertRaisesRegex(p.ValidationError,'未返回实例编号'):p.create_purchase(self.sess,{'claim':self.claim()})

    def test_uuid_conflict_remains_pending(self):
        with patch.object(auth,'http_json',side_effect=auth.FeishuAPIError(400,{'code':60012,'msg':'UUID conflict'})) as call:
            with self.assertRaises(auth.FeishuAPIError):p.create_purchase(self.sess,{'claim':self.claim()})
            with self.assertRaisesRegex(p.ValidationError,'待确认'):p.create_purchase(self.sess,{'claim':self.claim()})
            self.assertEqual(call.call_count,1)

    def test_actor_mismatch_stops_before_create(self):
        self.sess['user']={'openId':'another'}
        with patch.object(auth,'http_json') as call:
            with self.assertRaisesRegex(p.ValidationError,'身份不匹配'):p.create_purchase(self.sess,{'claim':self.claim()})
            call.assert_not_called()

    def test_detail_read_failure_does_not_repeat_create(self):
        with patch.object(auth,'fetch_instance',side_effect=RuntimeError),patch.object(auth,'http_json',return_value={'code':0,'data':{'instance_code':'real'}}) as call:
            self.assertTrue(p.create_purchase(self.sess,{'claim':self.claim()})['ok'])
            self.assertTrue(p.create_purchase(self.sess,{'claim':self.claim()})['ok'])
            self.assertEqual(call.call_count,1)

    def test_durable_receipt_is_readable_before_optional_detail_and_history(self):
        body={'draftId':'draft_pending_detail','claim':self.claim()}
        def during_detail(*args):
            status=p.expense_records.submission_status(ACTOR['openId'],body['draftId'])
            self.assertTrue(status['submitted'])
            self.assertEqual(status['receipt']['instanceCode'],'real-early')
            self.assertEqual(status['title'],body['claim']['purpose'])
            self.assertIsNone(p.receipt_for_draft('another-user',body['draftId']))
            return {'serial_number':'202611260001'}
        with patch.object(auth,'fetch_instance',side_effect=during_detail) as detail,patch.object(auth,'http_json',return_value={'code':0,'data':{'instance_code':'real-early'}}) as create:
            receipt=p.create_purchase(self.sess,body)
            detail.assert_called_once()
            create.assert_called_once()
            self.assertEqual(receipt['serialNumber'],'202611260001')


class HandlerTests(unittest.TestCase):
    class Handler:
        headers={}
        def _json(self,status,body):self.status=status;self.body=body

    def test_unauthenticated_and_cross_origin(self):
        h=self.Handler()
        with patch.object(auth,'get_session',return_value=None):p.handle_create(h,{'claim':claim_for()})
        self.assertEqual(h.status,401);self.assertFalse(h.body['ok'])
        h.headers={'Origin':'https://evil.example'};p.handle_create(h,{})
        self.assertEqual(h.status,403)

    def test_permission_response(self):
        h=self.Handler()
        with patch.object(auth,'get_session',return_value={'access_token':'a'}),patch.object(auth,'ensure_fresh_session',return_value={}),patch.object(p,'create_purchase',side_effect=auth.FeishuAPIError(400,{'code':99991672,'msg':'approval:instance required'})):
            p.handle_create(h,{})
        self.assertEqual(h.status,403);self.assertFalse(h.body['ok']);self.assertIn('/auth',h.body['permissionUrl'])


if __name__=='__main__':unittest.main()
