import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import feishu_oauth as auth
import feishu_purchase as p

SCHEMA = json.loads(Path(__file__).with_name('purchase_definition.json').read_text())['form']
ACTOR = {'openId':'ou_oauth_user', 'name':'测试申请人'}


def claim_for(method='个人垫付'):
    answers = {'purchaseMethod':method}
    group = p.active_group(SCHEMA, method)[2]
    for w in group['children']:
        if not w.get('required') or w['name'] in ('名称','金额'): continue
        val = w['option'][0]['text'] if w['type']=='radioV2' else '2' if w['type']=='number' else '已核对信息'
        shared = w['name'] in ('账户名称','银行账户','收款账号','开户支行')
        answers[f"purchase:{method}:{'shared' if shared else 'inv1'}:{w['name']}"] = val
    return {'purchaseMethod':method, 'costCenter':'软件组','purpose':'采购测试（不发起真实审批）',
            'invoices':[{'id':'inv1','amount':'123.45','merchant':'用户修正的商户','date':'2026-11-08','invoiceNo':'EDITED-123','category':'purchase'}],
            'answers':answers, 'selectedBudget':{'instanceId':'11111111-1111-1111-1111-111111111111'}}


class FormTests(unittest.TestCase):
    def test_all_seven_methods_and_only_active_details(self):
        for method in p.public_schema(SCHEMA)['methods']:
            with self.subTest(method=method['name']):
                c=claim_for(method['name']);form=p.build_form(SCHEMA,c)
                groups=[w for w in form if w['type']=='fieldList']
                self.assertEqual(len(groups),1)
                self.assertEqual(groups[0]['id'],p.active_group(SCHEMA,method['name'])[2]['id'])
                self.assertEqual(any(w['type']=='connect' for w in form),method['name']!='预付款项')
                amount=next(x for x in groups[0]['value'][0] if x['type']=='amount')
                self.assertEqual(amount['value'],123.45)
                self.assertEqual(amount['currency'],'CNY')
                note=next(x['value'] for x in groups[0]['value'][0] if x['type']=='textarea')
                self.assertIn('EDITED-123',note)
                self.assertIn('2026-11-08',note)
                for w in groups[0]['value'][0]:
                    if w['type']=='radioV2': self.assertNotIn(w['value'],('办公费','交通费'))

    def test_missing_relation_and_required_row_fields(self):
        c=claim_for();c['selectedBudget']=None
        with self.assertRaisesRegex(p.ValidationError,'选择'):p.build_form(SCHEMA,c)
        c=claim_for();c['answers'].pop('purchase:个人垫付:inv1:规格')
        with self.assertRaisesRegex(p.ValidationError,'规格'):p.build_form(SCHEMA,c)
        c=claim_for('预付款项');c['selectedBudget']=None
        self.assertTrue(p.build_form(SCHEMA,c))

    def test_amount_and_exact_options(self):
        for bad in ['NaN','Infinity','-1','0','1.001','abc']:
            c=claim_for();c['invoices'][0]['amount']=bad
            with self.assertRaises(p.ValidationError):p.build_form(SCHEMA,c)
        for key,val in [('costCenter','待定'),('purchaseMethod','费用报销')]:
            c=claim_for();c[key]=val
            with self.assertRaises(p.ValidationError):p.build_form(SCHEMA,c)

    def test_unexpected_new_required_field_fails_closed(self):
        schema=copy.deepcopy(SCHEMA);schema.append({'id':'new','name':'新增必填','type':'input','required':True})
        with self.assertRaisesRegex(p.ValidationError,'新增必填'):p.build_form(schema,claim_for())

    def test_relation_not_trusting_client_metadata(self):
        for detail in [dict(approval_code='evil',status='APPROVED'),dict(approval_code=next(iter(p.ALLOWED_LINKS)),status='PENDING')]:
            with patch.object(auth,'fetch_instance',return_value=detail):
                with self.assertRaises(p.ValidationError):p.validate_relation(claim_for(),ACTOR,'tenant')
        with patch.object(auth,'fetch_instance',return_value={'approval_code':next(iter(p.ALLOWED_LINKS)),'status':'APPROVED','form':[]}),patch.object(auth,'list_approved_budgets',return_value=([],'')):
            with self.assertRaisesRegex(p.ValidationError,'范围'):p.validate_relation(claim_for(),ACTOR,'tenant')


class CreateTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        for name,value in [('DB_PATH',Path(self.tmp.name)/'receipt.db')]:
            x=patch.object(p,name,value);x.start();self.addCleanup(x.stop)
        for obj,name,value in [(auth,'fetch_user_info',ACTOR),(auth,'get_tenant_access_token','tenant-token'),(p,'definition',SCHEMA),(p,'validate_relation',None),(auth,'fetch_instance',{'serial_number':'202611090001'})]:
            x=patch.object(obj,name,return_value=value);x.start();self.addCleanup(x.stop)
        self.sess={'access_token':'oauth-token','user':ACTOR}

    def test_oauth_actor_pinned_and_receipt_survives_repeat(self):
        body={'claim':claim_for(),'open_id':'ou_forged','user_id':'forged'}
        with patch.object(auth,'http_json',return_value={'code':0,'data':{'instance_code':'real-id','instance_link':'https://feishu.cn/approval/real'}}) as call:
            a=p.create_purchase(self.sess,body);b=p.create_purchase(self.sess,body)
            self.assertEqual(a,b);self.assertEqual(call.call_count,1)
            self.assertEqual(call.call_args.kwargs['payload']['open_id'],ACTOR['openId'])
            self.assertEqual(call.call_args.kwargs['token'],'tenant-token')
            self.assertEqual(a['approvalUrl'],'https://feishu.cn/approval/real')
            self.assertEqual(a['serialNumber'],'202611090001')
            self.assertEqual(p.DB_PATH.stat().st_mode & 0o777,0o600)

    def test_missing_scope_never_success_and_can_retry_after_fix(self):
        err=auth.FeishuAPIError(400,{'code':99991672,'msg':'missing scope','error':{'permission_violations':[{'subject':'approval:instance'}]}})
        with patch.object(auth,'http_json',side_effect=err) as call:
            for _ in range(2):
                with self.assertRaises(auth.FeishuAPIError):p.create_purchase(self.sess,{'claim':claim_for()})
            self.assertEqual(call.call_count,2)
        self.assertEqual(p.permission_error(err)['requiredScopes'],['approval:instance'])
        self.assertFalse(p.permission_error(err)['ok'])

    def test_unknown_transport_outcome_blocks_repeat(self):
        with patch.object(auth,'http_json',side_effect=TimeoutError) as call:
            with self.assertRaises(TimeoutError):p.create_purchase(self.sess,{'claim':claim_for()})
            with self.assertRaisesRegex(p.ValidationError,'待确认'):p.create_purchase(self.sess,{'claim':claim_for()})
            self.assertEqual(call.call_count,1)

    def test_missing_instance_code_never_success(self):
        with patch.object(auth,'http_json',return_value={'code':0,'data':{}}):
            with self.assertRaisesRegex(p.ValidationError,'未返回实例编号'):p.create_purchase(self.sess,{'claim':claim_for()})

    def test_actor_mismatch_stops_before_create(self):
        self.sess['user']={'openId':'another'}
        with patch.object(auth,'http_json') as call:
            with self.assertRaisesRegex(p.ValidationError,'身份不匹配'):p.create_purchase(self.sess,{'claim':claim_for()})
            call.assert_not_called()

    def test_detail_read_failure_does_not_repeat_create(self):
        with patch.object(auth,'fetch_instance',side_effect=RuntimeError),patch.object(auth,'http_json',return_value={'code':0,'data':{'instance_code':'real'}}) as call:
            self.assertTrue(p.create_purchase(self.sess,{'claim':claim_for()})['ok'])
            self.assertTrue(p.create_purchase(self.sess,{'claim':claim_for()})['ok'])
            self.assertEqual(call.call_count,1)


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
