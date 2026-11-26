import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import expense_records as records
import expense_data as data
import feishu_purchase as purchase
from test_expense_http import ExpenseHTTPTests
from test_feishu_purchase import CreateTests


def state_for(ref=None):
    return {'draftId':'draft_test','stage':'interview','invoices':[{'id':'inv1','fileName':'original.pdf','amount':'123.45',
        **({'attachment':ref} if ref else {})}], 'answers':{'costCenter':'公共办公','purchaseMethod':'个人垫付',
        'selectedBudget':{'instanceId':'budget1'},'purchase:个人垫付:inv1:采购科目':'办公费'},
        'chat':[{'role':'user','text':'已确认'}], 'draft':None, 'composerText':'还没发出的回答'}


class RecordTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        for name,value in [('DB_PATH',Path(self.tmp.name)/'data.db'),('FILE_ROOT',Path(self.tmp.name)/'files')]:
            p=patch.object(data,name,value);p.start();self.addCleanup(p.stop)
        self.ref=data.save_file('alice',b'%PDF-1.7 original','original.pdf','application/pdf')
        self.state=state_for(self.ref)

    def save(self,revision=0,state=None):
        return records.save_draft('alice','draft_test',{'state':state or self.state,'revision':revision})

    def test_all_stages_round_trip_and_files_survive_process_restart(self):
        revision=0
        for stage in ['upload','interview','draft','submit']:
            self.state['stage']=stage
            self.state['draft']={'detailSheets':[], 'total':123.45}
            result=self.save(revision);revision=result['revision']
            restored=records.get_draft('alice','draft_test')['state']
            self.assertEqual(restored,self.state)
            self.assertEqual(data.resolve_file('alice',restored['invoices'][0]['attachment'])[1],b'%PDF-1.7 original')
        self.assertEqual(data.DB_PATH.stat().st_mode & 0o777,0o600)

    def test_titles_follow_purpose_and_keep_explicit_renames(self):
        self.state['answers']['purpose']='前往香港向高瓴汇报，前往深圳与工程师交流'
        saved=self.save();self.assertEqual(saved['title'],self.state['answers']['purpose'])
        self.state['answers']['purpose']='新的实质性事由'
        saved=self.save(saved['revision']);self.assertEqual(saved['title'],'新的实质性事由')
        renamed=records.change_draft('alice','draft_test',saved['revision'],title='自定义有效标题')
        self.state['answers']['purpose']='再修改事由'
        self.assertEqual(self.save(renamed['revision'])['title'],'自定义有效标题')

    def test_legacy_invoice_titles_are_displayed_as_the_actual_purpose(self):
        self.state['answers']['purpose']='前往深圳与工程师交流'
        self.save()
        with data.database() as con:con.execute("UPDATE drafts SET title='original.pdf · 2026-11-26'")
        self.assertEqual(records.list_records('alice','drafts')['items'][0]['title'],'前往深圳与工程师交流')

    def test_receipt_status_is_owner_scoped_and_uses_submitted_purpose(self):
        self.save()
        claim={'purpose':'前往深圳与工程师交流','invoices':self.state['invoices'],'costCenter':'公共办公'}
        receipt={'ok':True,'instanceCode':'real-code','requestId':'fixture-request','approvalUrl':'https://fixture.invalid/approval','attachmentCount':1}
        records.record_submission('alice','draft_test',claim,receipt)
        status=records.submission_status('alice','draft_test')
        self.assertTrue(status['submitted']);self.assertEqual(status['receipt']['instanceCode'],'real-code')
        self.assertEqual(status['title'],claim['purpose'])
        self.assertEqual(records.list_records('alice','history')['items'][0]['title'],claim['purpose'])
        with patch.object(purchase,'receipt_for_draft',return_value=None):self.assertFalse(records.submission_status('bob','draft_test')['submitted'])

    def test_cross_owner_never_reads_renames_deletes_or_links_original(self):
        self.save()
        self.assertEqual(records.list_records('bob','drafts')['items'],[])
        for fn in [lambda:records.get_draft('bob','draft_test'),lambda:records.change_draft('bob','draft_test',1,title='偷改'),lambda:records.change_draft('bob','draft_test',1,delete=True),lambda:records.save_draft('bob','draft_test',{'state':self.state,'revision':0})]:
            with self.assertRaises(records.RecordError):fn()

    def test_revision_conflict_rename_delete_no_resurrection_and_keeps_original(self):
        self.save()
        with self.assertRaisesRegex(records.RecordError,'其他页面'):self.save()
        renamed=records.change_draft('alice','draft_test',1,title='我的办公采购')
        self.assertEqual(renamed['revision'],2)
        with self.assertRaises(records.RecordError):records.change_draft('alice','draft_test',1,delete=True)
        records.change_draft('alice','draft_test',2,delete=True)
        for rev in [0,2,3]:
            with self.assertRaises(records.RecordError):self.save(rev)
        self.assertEqual(records.list_records('alice','drafts')['items'],[])
        self.assertTrue(data.resolve_file('alice',self.ref)[1])

    def test_submission_snapshot_is_immutable_and_transition_atomic(self):
        self.save()
        claim={'costCenter':'公共办公','purchaseMethod':'个人垫付','purpose':'购买纸张','answers':self.state['answers'],
               'invoices':[dict(self.state['invoices'][0],merchant='更正商户',invoiceNo='edited-no')]}
        receipt={'ok':True,'instanceCode':'real-code','requestId':'request-code','approvalUrl':'https://feishu.cn/a','serialNumber':'N123'}
        records.record_submission('alice','draft_test',claim,receipt,1234567890)
        claim['invoices'][0]['amount']='999'
        records.record_submission('alice','draft_test',claim,receipt,1234567900)
        item=records.get_history('alice','real-code')
        self.assertEqual(item['total'],'123.45');self.assertEqual(item['submitted_at'],1234567890)
        self.assertEqual(item['snapshot']['claim']['invoices'][0]['invoiceNo'],'edited-no')
        self.assertEqual(item['snapshot']['attachmentNames'],['original.pdf'])
        self.assertEqual(item['snapshot']['state'],self.state)
        self.assertEqual(records.list_records('alice','drafts')['items'],[])
        self.assertEqual(len(records.list_records('alice','history')['items']),1)
        with self.assertRaises(records.RecordError):self.save(1)
        with self.assertRaises(records.RecordError):records.get_history('bob','real-code')

    def test_pagination_and_empty_user(self):
        for i in range(31):
            state=copy.deepcopy(self.state);state['draftId']='draft_'+str(i);state['invoices'][0].pop('attachment',None)
            records.save_draft('alice',state['draftId'],{'revision':0,'state':state})
        page=records.list_records('alice','drafts')
        self.assertEqual(len(page['items']),30);self.assertEqual(page['nextOffset'],30)
        self.assertEqual(len(records.list_records('alice','drafts',30)['items']),1)
        self.assertEqual(records.list_records('bob','history')['items'],[])

    def test_invalid_state_and_never_record_failed_receipt(self):
        for bad in [{'draftId':'x'},dict(self.state,stage='bad'),dict(self.state,answers=[]),dict(self.state,invoices=[5])]:
            with self.assertRaises(records.RecordError):self.save(state=bad)
        with self.assertRaises(records.RecordError):records.record_submission('alice','draft_test',{}, {'ok':False})
        self.assertEqual(records.list_records('alice','history')['items'],[])


class RecordsHTTPTests(ExpenseHTTPTests):
    def call(self,path,method='GET',body=None,origin=None):
        import urllib.request,urllib.error
        headers={'Content-Type':'application/json',**({'Origin':origin} if origin else {})}
        data=None if body is None else json.dumps(body).encode()
        if body is None and method in ('DELETE','POST','PUT','PATCH'):
            # Explicit empty body helpers still set Content-Length: 0 via urllib.
            headers.pop('Content-Type',None)
        req=urllib.request.Request(self.base+path,data=data,method=method,headers=headers)
        try:res=urllib.request.urlopen(req,timeout=5)
        except urllib.error.HTTPError as e:res=e
        with res:return res.status,json.load(res),res.headers

    def test_submission_status_is_authenticated_owner_scoped_and_read_only(self):
        receipt={'ok':True,'instanceCode':'created-code','requestId':'created-request','attachmentCount':0,'approvalUrl':'https://fixture.invalid/approval/created-code'}
        claim={'purpose':'前往深圳与工程师交流','costCenter':'软件组','invoices':[]}
        records.record_submission('alice','draft_test',claim,receipt)
        with patch.object(purchase,'recover_history') as repair,patch.object(purchase,'receipt_for_draft',return_value=None),patch.object(purchase,'create_purchase') as create:
            status,result,headers=self.call('/api/submission-status/draft_test')
            self.assertEqual(status,200);self.assertTrue(result['submitted'])
            self.assertEqual(result['receipt'],receipt);self.assertEqual(result['title'],claim['purpose'])
            self.assertEqual(headers['Cache-Control'],'no-store')
            with patch.object(purchase.auth,'get_session',return_value=None):
                self.assertEqual(self.call('/api/submission-status/draft_test')[0],401)
            bob={'user':{'openId':'bob'}}
            with patch.object(purchase.auth,'get_session',return_value=bob),patch.object(purchase.auth,'ensure_fresh_session',return_value=bob):
                self.assertFalse(self.call('/api/submission-status/draft_test')[1]['submitted'])
            repair.assert_not_called();create.assert_not_called()

    def test_crud_authenticated_and_cors(self):
        s=state_for()
        status,result,_=self.call('/api/drafts','POST',{'id':'draft_test','state':s,'revision':0})
        self.assertEqual(status,200)
        status,result,headers=self.call('/api/drafts/draft_test')
        self.assertEqual(status,200);self.assertEqual(result['record']['state'],s);self.assertEqual(headers['Cache-Control'],'no-store')
        self.assertEqual(self.call('/api/drafts/draft_test','PATCH',{'revision':1,'title':'新标题'})[0],200)
        self.assertEqual(self.call('/api/drafts/draft_test','PUT',{'revision':1,'state':s})[0],409)
        self.assertEqual(self.call('/api/drafts/draft_test','DELETE',{'revision':2})[0],200)
        self.assertEqual(self.call('/api/drafts/draft_test')[0],404)
        self.assertEqual(self.call('/api/drafts')[1]['items'],[])
        self.assertEqual(self.call('/api/drafts','POST',{'id':'draft_test','state':s,'revision':0})[0],409)
        self.assertEqual(self.call('/api/drafts',origin='https://evil.example')[0],403)
        with patch.object(purchase,'recover_history'):
            self.assertEqual(self.call('/api/history')[1]['items'],[])
        with patch.object(purchase,'recover_history') as recovery,patch.object(purchase.auth,'get_session',return_value=None):
            for path in ['/api/drafts','/api/drafts/draft_test','/api/history','/api/history/code']:
                self.assertEqual(self.call(path)[0],401)
            recovery.assert_not_called()

    def test_delete_via_query_without_body_and_post_delete(self):
        def make(draft_id):
            s=copy.deepcopy(state_for()); s['draftId']=draft_id; return s
        self.assertEqual(self.call('/api/drafts','POST',{'id':'draft_q','state':make('draft_q'),'revision':0})[0],200)
        # No body + ?revision= must succeed (browser/proxy-safe path).
        status,result,_=self.call('/api/drafts/draft_q?revision=1','DELETE')
        self.assertEqual(status,200);self.assertEqual(result['record']['status'],'deleted')
        self.assertEqual(self.call('/api/drafts/draft_q')[0],404)
        self.assertEqual(self.call('/api/drafts','POST',{'id':'draft_post','state':make('draft_post'),'revision':0})[0],200)
        status,result,_=self.call('/api/drafts/draft_post/delete?revision=1','POST')
        self.assertEqual(status,200);self.assertEqual(result['record']['status'],'deleted')
        # Missing revision / empty DELETE body without query rejects clearly.
        self.assertEqual(self.call('/api/drafts','POST',{'id':'draft_bad','state':make('draft_bad'),'revision':0})[0],200)
        self.assertEqual(self.call('/api/drafts/draft_bad','DELETE')[0],422)
        self.assertEqual(self.call('/api/drafts/draft_bad?revision=nope','DELETE')[0],422)
        self.assertEqual(self.call('/api/drafts/draft_bad','PUT')[0],413)

    def test_ocr_from_retained_reference_without_reupload(self):
        _,body,_=self.upload();ref=body['attachment']
        with patch.object(__import__('server'),'parse_uploaded_invoice',return_value={'amount':123}) as parse:
            status,result,_=self.call('/api/parse-invoice','POST',{'attachment':ref})
        self.assertEqual(status,200);self.assertEqual(result['attachment'],ref)
        self.assertEqual(parse.call_args.args[0],b'%PDF-1.7 raw-original')
        with patch.object(purchase.auth,'get_session',return_value={'user':{'openId':'bob'}}),patch.object(purchase.auth,'ensure_fresh_session',return_value={'user':{'openId':'bob'}}),patch.object(__import__('server'),'parse_uploaded_invoice') as parse:
            self.assertEqual(self.call('/api/parse-invoice','POST',{'attachment':ref})[0],400)
            parse.assert_not_called()


class PurchaseHistoryTests(CreateTests):
    def test_created_only_history_and_outbox_repair_without_new_approval(self):
        c=self.claim();state=state_for(self.attachment);state['answers']=c['answers'];state['invoices']=c['invoices']
        records.save_draft(self.sess['user']['openId'],'draft_test',{'state':state,'revision':0})
        body={'draftId':'draft_test','draftRevision':1,'claim':c}
        with patch.object(purchase.auth,'http_json',return_value={'code':0,'data':{'instance_code':'real-code'}}) as api:
            with patch.object(records,'record_submission',side_effect=OSError('disk busy')):
                receipt=purchase.create_purchase(self.sess,body)
            self.assertTrue(receipt['ok']);self.assertIn('historyWarning',receipt)
            self.assertEqual(records.list_records('ou_oauth_user','history')['items'],[])
            purchase.recover_history('someone-else')
            self.assertEqual(records.list_records('ou_oauth_user','history')['items'],[])
            purchase.recover_history('ou_oauth_user')
            self.assertEqual(api.call_count,1)
            history=records.get_history('ou_oauth_user','real-code')
            self.assertEqual(history['total'],'123.45')
            self.assertEqual(history['snapshot']['attachmentNames'],['invoice.pdf'])
            self.assertEqual(records.list_records('ou_oauth_user','drafts')['items'],[])
            again=purchase.create_purchase(self.sess,body)
            self.assertEqual(again['instanceCode'],'real-code');self.assertEqual(api.call_count,1)
            c['purpose']='修改已提交内容'
            with self.assertRaisesRegex(purchase.ValidationError,'已提交'):purchase.create_purchase(self.sess,body)
            self.assertEqual(api.call_count,1)

    def test_stale_draft_blocks_before_create_and_rejection_stays_draft(self):
        c=self.claim();s=state_for(self.attachment)
        records.save_draft('ou_oauth_user','draft_test',{'state':s,'revision':0})
        with patch.object(purchase.auth,'http_json') as api:
            with self.assertRaisesRegex(purchase.ValidationError,'其他页面'):purchase.create_purchase(self.sess,{'draftId':'draft_test','draftRevision':0,'claim':c})
            api.assert_not_called()
        with patch.object(purchase.auth,'http_json',side_effect=purchase.auth.FeishuAPIError(400,{'code':99991672,'msg':'missing scope'})):
            with self.assertRaises(purchase.auth.FeishuAPIError):purchase.create_purchase(self.sess,{'draftId':'draft_test','draftRevision':1,'claim':c})
        self.assertEqual(records.get_draft('ou_oauth_user','draft_test')['revision'],1)
        self.assertEqual(records.list_records('ou_oauth_user','history')['items'],[])


if __name__=='__main__':unittest.main()
