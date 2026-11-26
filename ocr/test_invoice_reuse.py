"""Synthetic-only tests; no production DB, OCR/model, OAuth, or Feishu calls."""
import copy
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

import expense_data as data
import expense_records as records
import invoice_registry as registry
import invoice_items as items
import invoice_extract as extract
import filling_profiles as profiles
from test_expense_records import state_for


class IsolatedData(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        for key,value in [('DB_PATH',Path(tmp.name)/'data.db'),('FILE_ROOT',Path(tmp.name)/'files')]:
            p=patch.object(data,key,value);p.start();self.addCleanup(p.stop)
        self.raw=b'\x89PNG\r\n\x1a\nsynthetic invoice only'
        self.parser=Mock(return_value={'amount':123,'invoice_no':'20261110000000000001','items':[{'name':'测试纸张','unit':'包','quantity':2}]})

    def attach(self,owner='alice',draft='draft_a',row='inv_a',raw=None):
        raw=raw or self.raw
        registry.reserve_upload(owner,raw,'image/png',draft,row)
        return data.save_file(owner,raw,'fixture.png','image/png')

    def save(self,ref,draft='draft_a',owner='alice',row='inv_a',revision=0):
        state=state_for(ref);state['draftId']=draft;state['invoices'][0]['id']=row
        return records.save_draft(owner,draft,{'state':state,'revision':revision})


class ReuseTests(IsolatedData):
    def test_repeat_read_and_resume_calls_parser_once(self):
        ref=self.attach();self.save(ref)
        a=registry.parse_once('alice',ref,self.parser,'draft_a','inv_a')
        b=registry.parse_once('alice',ref,self.parser,'draft_a','inv_a')
        self.assertFalse(a['cached']);self.assertTrue(b['cached']);self.parser.assert_called_once()
        self.save(ref,revision=1)  # Autosave/resume of the same row is allowed.
        self.assertEqual(records.get_draft('alice','draft_a')['revision'],2)

    def test_same_file_same_draft_other_row_and_other_user_rejected_before_read(self):
        ref=self.attach();self.save(ref)
        for owner,draft,row in [('alice','draft_a','inv_b'),('alice','draft_b','inv_a'),('bob','draft_b','inv_b')]:
            with self.assertRaises(registry.DuplicateError):self.attach(owner,draft,row)
        self.parser.assert_not_called()
        state=state_for(ref);state['draftId']='draft_a';state['invoices']*=2
        with self.assertRaises(records.RecordError):records.save_draft('alice','draft_a',{'state':state,'revision':1})

    def test_different_bytes_same_digital_invoice_blocked_and_cache_not_repeated(self):
        ref=self.attach();self.save(ref);registry.parse_once('alice',ref,self.parser,'draft_a','inv_a')
        other=self.attach('bob','draft_b','inv_b',self.raw+b'different encoding')
        with self.assertRaisesRegex(registry.DuplicateError,'购买办公用品'):
            registry.parse_once('bob',other,self.parser,'draft_b','inv_b')
        self.assertEqual(self.parser.call_count,2)  # Different bytes need one recognition to learn their number.
        with self.assertRaises(registry.DuplicateError):registry.parse_once('bob',other,self.parser,'draft_b','inv_b')
        self.assertEqual(self.parser.call_count,2)
        # Client-edited numbers cannot evade the immutable server result.
        state=state_for(other);state['draftId']='draft_b';state['invoices'][0].update(id='inv_b',invoiceNo='changed')
        with self.assertRaises(records.RecordError):records.save_draft('bob','draft_b',{'state':state,'revision':0})

    def test_concurrent_same_file_parsed_once(self):
        ref=self.attach();calls=[];results=[]
        def parser(*args,**kwargs):calls.append(1);time.sleep(.03);return {'amount':1}
        threads=[threading.Thread(target=lambda:results.append(registry.parse_once('alice',ref,parser,'draft_a','inv_a'))) for _ in range(2)]
        for t in threads:t.start()
        for t in threads:t.join(5)
        self.assertEqual(len(results),2);self.assertEqual(len(calls),1)

    def test_failed_parse_retry_and_deleted_draft_releases_but_cache_survives(self):
        ref=self.attach();self.save(ref)
        with self.assertRaises(RuntimeError):registry.parse_once('alice',ref,Mock(side_effect=RuntimeError('synthetic offline')),'draft_a','inv_a')
        registry.parse_once('alice',ref,self.parser,'draft_a','inv_a')
        records.change_draft('alice','draft_a',1,delete=True)
        other=self.attach('bob','draft_b','inv_b')
        out=registry.parse_once('bob',other,self.parser,'draft_b','inv_b')
        self.assertTrue(out['cached']);self.parser.assert_called_once()
        self.assertEqual(out['attachment']['file_id'],other['file_id'])
        with self.assertRaises(data.DataError):data.resolve_file('bob',ref)

    def test_pending_and_submitted_never_released_or_saved_as_active(self):
        ref=self.attach();self.save(ref);invs=records.get_draft('alice','draft_a')['state']['invoices']
        registry.submission('alice','draft_a',invs,phase='pending')
        with self.assertRaises(records.RecordError):self.save(ref,revision=1)
        with self.assertRaises(records.RecordError):records.change_draft('alice','draft_a',1,delete=True)
        registry.reject_submission('alice','draft_a');self.save(ref,revision=1)
        claim={'invoices':invs,'expenseType':'普通采购','payer':'个人支付'}
        records.record_submission('alice','draft_a',claim,{'ok':True,'instanceCode':'synthetic-result','requestId':'synthetic-request','approvalUrl':'https://example.invalid'})
        with self.assertRaises(registry.DuplicateError):self.attach('bob','draft_b','inv_b')

    def test_backfill_existing_drafts_and_history_on_first_use(self):
        ref=data.save_file('alice',self.raw,'fixture.png','image/png')
        self.save(ref)
        with data.database() as con:
            con.execute('DELETE FROM invoice_uses');con.execute('DELETE FROM invoice_registry_meta')
        with self.assertRaises(registry.DuplicateError):self.attach('bob','draft_b','inv_b')

    def test_native_pdf_number_checked_without_parser(self):
        ref=self.attach();self.save(ref);registry.parse_once('alice',ref,self.parser,'draft_a','inv_a')
        with patch.object(extract,'extract_pdf_text',return_value='发票号码：20261110000000000001'):
            with self.assertRaises(registry.DuplicateError):registry.reserve_upload('bob',b'%PDF-synthetic','application/pdf','draft_b','inv_b')
        self.parser.assert_called_once()


class ItemTests(unittest.TestCase):
    def test_single_multi_missing_and_identity(self):
        text='发票号码：20261110000000000001\n发票代码：123456789012\n名称 规格型号 单位 数量 单价 金额\n*办公用品*纸张 A4 包 3 10.00 30.00\n价税合计 30.00'
        result=extract.parse_invoice_from_text(text)
        self.assertEqual((result['quantity'],result['unit']),(3,'包'))
        self.assertEqual(result['invoice_code'],'123456789012')
        result=items.from_text(text.replace('价税合计','*办公用品*笔 支 2 1.00 2.00\n价税合计'))
        self.assertEqual(items.quantity_unit(result),{'quantity':1,'unit':'份/批','quantity_mode':'batch'})
        self.assertEqual(items.quantity_unit({})['quantity'],1)
        self.assertEqual(items.quantity_unit({})['unit'],'份/批')
        self.assertEqual(items.identity_keys({'invoiceNo':'１２３４５６７８','invoiceCode':'1234567890'}),['vat:1234567890:12345678'])
        self.assertEqual(items.identity_keys({'invoiceNo':'12345678'}),[])
        self.assertNotEqual(items.identity_keys({'invoiceNo':'12345678','invoiceCode':'1234567890'}),items.identity_keys({'invoiceNo':'12345678','invoiceCode':'1234567891'}))

    def test_form_uses_editable_summary_single_and_batch_not_stale_answers(self):
        from test_feishu_purchase import SCHEMA,claim_for
        import feishu_purchase as purchase
        for row,quantity,unit in [({'quantity':4,'unit':'包'},4,'包'),({'items':[{'name':'纸'},{'name':'笔'}],'quantity':9,'unit':'件'},1,'份/批')]:
            claim=claim_for();claim['invoices'][0].update(row)
            form=purchase.build_form(SCHEMA,claim);group=purchase.active_group(SCHEMA,'普通采购')[2]
            cells=next(w['value'][0] for w in form if w['type']=='fieldList')
            byid={w['id']:w['value'] for w in cells}
            for widget in group['children']:
                if widget['name']=='数量':self.assertEqual(byid[widget['id']],quantity)
                if widget['name']=='规格':self.assertEqual(byid[widget['id']],unit)


class ProfileTests(IsolatedData):
    def body(self,**kw):return dict(kind='bank',side='counterparty',title='合成供应商',fields={'account':'6222 0000 1234','bank':'合成测试支行','holder':'测试公司'},**kw)
    def test_shared_read_creator_only_edit_disable_and_revision(self):
        a=profiles.save('alice','测试甲',self.body())
        b=profiles.listing('bob')[0]
        self.assertEqual(b['createdBy'],'测试甲');self.assertFalse(b['canEdit']);self.assertEqual(b['fields']['account'],'622200001234')
        self.assertNotIn('creator',b)
        with self.assertRaises(profiles.ProfileError):profiles.save('bob','乙',self.body(revision=1),a['id'])
        with self.assertRaises(profiles.ProfileError):profiles.remove('bob',a['id'],1)
        changed=profiles.save('alice','甲',dict(self.body(revision=1),side='ours'),a['id']);self.assertEqual(changed['revision'],2)
        with self.assertRaises(profiles.ProfileError):profiles.save('alice','甲',self.body(revision=1),a['id'])
        self.assertEqual(profiles.listing('bob','counterparty'),[])
        profiles.remove('alice',a['id'],2);self.assertEqual(profiles.listing('bob'),[])
    def test_pair_required_never_partial(self):
        for key in ['account','bank']:
            body=self.body();body['fields'][key]=''
            with self.assertRaises(profiles.ProfileError):profiles.save('alice','甲',body)
        self.assertEqual(profiles.listing('alice'),[])

class ProfileHTTPTests(unittest.TestCase):
    # Reuse only isolated setup/helpers, not an inherited duplicate test suite.
    from test_expense_http import ExpenseHTTPTests as _Fixture
    setUp=_Fixture.setUp
    close_server=_Fixture.close_server
    request=_Fixture.request
    def test_authenticated_crud_shared_and_restricted(self):
        import server
        body=ProfileTests.body(self)
        status,result,headers=self.request('/api/filling-profiles',json.dumps(body).encode())
        self.assertEqual(status,200);self.assertEqual(headers['Cache-Control'],'no-store')
        ident=result['profile']['id'];path='/api/filling-profiles/'+ident
        bob={'user':{'openId':'bob','name':'测试乙'}}
        with patch.object(server.auth,'get_session',return_value=bob),patch.object(server.auth,'ensure_fresh_session',return_value=bob):
            result=self.request('/api/filling-profiles')[1];self.assertFalse(result['items'][0]['canEdit'])
            self.assertEqual(self.request(path,json.dumps(dict(body,revision=1)).encode(),method='PATCH')[0],403)
            self.assertEqual(self.request(path,b'{"revision":1}',method='DELETE')[0],403)
        self.assertEqual(self.request(path,json.dumps(dict(body,revision=1)).encode(),method='PATCH')[0],200)
        self.assertEqual(self.request(path,b'{"revision":1}',method='DELETE')[0],409)
        self.assertEqual(self.request(path,b'{"revision":2}',method='DELETE')[0],200)
        self.assertEqual(self.request('/api/filling-profiles')[1]['items'],[])
        with patch.object(server.auth,'get_session',return_value=None):
            self.assertEqual(self.request('/api/filling-profiles')[0],401)
            self.assertEqual(self.request('/api/filling-profiles',json.dumps(body).encode())[0],401)

class SubmitGuardTests(unittest.TestCase):
    from test_feishu_purchase import CreateTests as _Fixture
    setUp=_Fixture.setUp
    claim=_Fixture.claim
    def test_created_invoice_cannot_replay_as_another_draft_or_modified_request(self):
        import feishu_purchase as purchase
        import feishu_oauth as auth
        with patch.object(auth,'http_json',return_value={'code':0,'data':{'instance_code':'synthetic-instance'}}) as call:
            purchase.create_purchase(self.sess,{'draftId':'draft_a','claim':self.claim()})
            with self.assertRaisesRegex(purchase.ValidationError,'其他报销'):
                purchase.create_purchase(self.sess,{'draftId':'draft_b','claim':self.claim()})
            claim=self.claim();claim['purpose']='changed purpose'
            with self.assertRaisesRegex(purchase.ValidationError,'发票已在'):
                purchase.create_purchase(self.sess,{'draftId':'draft_b','claim':claim})
            self.assertEqual(call.call_count,1)

class ReviewedItemTests(unittest.TestCase):
    def test_sparse_ocr_review_items_need_evidence_and_preserve_unit(self):
        text='*办公用品*纸张\n包\n3\n30.00\n价税合计 30.00'
        heuristic=extract.parse_invoice_from_text(text)
        reviewed=extract.coerce_fields({'items':[{'name':'纸张','quantity':3,'unit':'包'}]})
        merged=extract.merge_heuristic_and_review(heuristic,reviewed,text)
        self.assertEqual((merged['quantity'],merged['unit']),(3,'包'))
        fake=extract.coerce_fields({'items':[{'name':'未出现在票面','quantity':9,'unit':'箱'}]})
        merged=extract.merge_heuristic_and_review(heuristic,fake,text)
        self.assertEqual((merged['quantity'],merged['unit']),(1,'份/批'))

class RevisionGuardTests(IsolatedData):
    def test_pending_transition_rechecks_revision_and_tombstone(self):
        ref=self.attach();self.save(ref)
        invoices=records.get_draft('alice','draft_a')['state']['invoices']
        records.change_draft('alice','draft_a',1,title='合成改名')
        with self.assertRaises(registry.DuplicateError):registry.submission('alice','draft_a',invoices,revision=1)
        records.change_draft('alice','draft_a',2,delete=True)
        with self.assertRaises(registry.DuplicateError):registry.submission('alice','draft_a',invoices,revision=3)

class UploadDedupeHTTPTests(ProfileHTTPTests):
    def test_upload_duplicate_409_and_retained_reference_cache(self):
        import base64
        import server
        raw=b'\x89PNG\r\n\x1a\nsynthetic'
        body={'filename':'synthetic.png','mime':'image/png','image_base64':base64.b64encode(raw).decode(),'draftId':'draft_a','invoiceId':'inv_a'}
        with patch.object(server,'parse_uploaded_invoice',return_value={'amount':123,'invoice_no':'20261110000000000001'}) as parser:
            status,result,_=self.request('/api/invoice-files',json.dumps(body).encode());self.assertEqual(status,200)
            ctx={'attachment':result['attachment'],'draftId':'draft_a','invoiceId':'inv_a'}
            for _ in range(2):self.assertEqual(self.request('/api/parse-invoice',json.dumps(ctx).encode())[0],200)
            self.assertEqual(parser.call_count,1)
            body['invoiceId']='inv_b'
            status,error,_=self.request('/api/invoice-files',json.dumps(body).encode())
            self.assertEqual(status,409);self.assertTrue(error['duplicate'])
            parser.assert_called_once()

class LegacyReceiptGuardTests(SubmitGuardTests):
    def test_legacy_receipt_uses_original_history_or_fails_closed(self):
        import sqlite3
        import feishu_purchase as purchase
        import feishu_oauth as auth
        body={'draftId':'draft_a','claim':self.claim()}
        with patch.object(auth,'http_json',return_value={'code':0,'data':{'instance_code':'synthetic-instance'}}) as call:
            receipt=purchase.create_purchase(self.sess,body)
            with sqlite3.connect(purchase.DB_PATH) as con:con.execute("UPDATE submissions SET history_source=''")
            self.assertEqual(purchase.create_purchase(self.sess,body)['instanceCode'],receipt['instanceCode'])
            with self.assertRaises(purchase.ValidationError):purchase.create_purchase(self.sess,dict(body,draftId='draft_b'))
            with data.database() as con:con.execute('DELETE FROM submission_history')
            with self.assertRaisesRegex(purchase.ValidationError,'成功回执'):purchase.create_purchase(self.sess,body)
            self.assertEqual(call.call_count,1)
