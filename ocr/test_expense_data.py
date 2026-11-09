import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import expense_data as d
import approval_files as files
import feishu_oauth as auth
import feishu_purchase as p
from test_feishu_purchase import SCHEMA, claim_for
import test_feishu_purchase as purchase_tests


class DataTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        for key,value in [('DB_PATH',Path(self.tmp.name)/'db.sqlite'),('FILE_ROOT',Path(self.tmp.name)/'files')]:
            x=patch.object(d,key,value);x.start();self.addCleanup(x.stop)
        self.schema=p.public_schema(SCHEMA)

    def test_original_survives_reload_and_cannot_cross_owner(self):
        ref=d.save_file('alice',b'%PDF-1.7 original','../../invoice.pdf','application/pdf')
        self.assertEqual(ref['name'],'invoice.pdf')
        record,raw=d.resolve_file('alice',ref)
        self.assertEqual(raw,b'%PDF-1.7 original')
        self.assertEqual(record['size'],len(raw))
        self.assertEqual((d.FILE_ROOT/ref['file_id']).stat().st_mode & 0o777,0o600)
        self.assertEqual(d.DB_PATH.stat().st_mode & 0o777,0o600)
        with self.assertRaisesRegex(d.DataError,'不属于'):d.resolve_file('bob',ref)
        with self.assertRaises(d.DataError):d.resolve_file('alice',{'file_id':'../../.env'})
        # Client metadata cannot change the actual invoice bytes or filename.
        self.assertEqual(d.resolve_file('alice',{**ref,'name':'.env','sha256':'forged'})[0]['name'],'invoice.pdf')
        self.assertEqual(d.save_file('alice',raw,'invoice.pdf','application/pdf')['file_id'],ref['file_id'])

    def test_missing_or_corrupt_original_requires_reattach_and_is_repairable(self):
        ref=d.save_file('a',b'%PDF-original','a.pdf','application/pdf');path=d.FILE_ROOT/ref['file_id']
        path.write_bytes(b'corrupt')
        with self.assertRaisesRegex(d.DataError,'完整性'):d.resolve_file('a',ref)
        restored=d.save_file('a',b'%PDF-original','a.pdf','application/pdf')
        self.assertEqual(restored['file_id'],ref['file_id']);self.assertEqual(d.resolve_file('a',ref)[1],b'%PDF-original')
        path.unlink()
        with self.assertRaisesRegex(d.DataError,'不可用'):d.resolve_file('a',ref)

    def test_no_history_falls_back_and_owner_isolation(self):
        c=claim_for();self.assertEqual(d.suggestions('a',c)['rows']['inv1']['科目'],[])
        d.record_fills('a','draft1',c,self.schema)
        self.assertTrue(d.suggestions('a',c)['rows']['inv1']['科目'])
        self.assertEqual(d.suggestions('b',c)['rows']['inv1']['科目'],[])

    def test_corrected_answer_replaces_evidence_and_does_not_learn_bank_info(self):
        c=claim_for('预付款项');d.record_fills('a','same',c,self.schema);d.record_fills('a','same',c,self.schema)
        with d.database() as con:
            self.assertEqual(con.execute("SELECT count(*) FROM fill_observations WHERE field='科目'").fetchone()[0],1)
            self.assertEqual(con.execute("SELECT count(*) FROM fill_observations WHERE field LIKE '%账户%' OR field LIKE '%账号%'").fetchone()[0],0)
        key='purchase:预付款项:inv1:预付款科目';c['answers'][key]='研发耗材'
        d.record_fills('a','same',c,self.schema)
        result=d.suggestions('a',c)['rows']['inv1']['科目']
        self.assertEqual(result[0]['value'],'研发耗材');self.assertEqual(result[0]['evidence'],1)

    def test_context_beats_unrelated_global_frequency(self):
        for i in range(15):
            c=claim_for();c['costCenter']='公共办公';c['invoices'][0]['merchant']='无关商户';c['invoices'][0]['amount']=9000
            d.record_fills('a',f'unrelated{i}',c,self.schema)
        for i in range(3):
            c=claim_for();c['answers']['purchase:个人垫付:inv1:个人垫付科目']='研发耗材'
            d.record_fills('a',f'match{i}',c,self.schema)
        result=d.suggestions('a',claim_for())['rows']['inv1']['科目']
        self.assertEqual(result[0]['value'],'研发耗材')
        self.assertGreater(result[0]['probability'],result[1]['probability'])
        self.assertAlmostEqual(sum(x['probability'] for x in result),1.0,places=3)

    def test_invalid_option_not_learned(self):
        c=claim_for();c['answers']['purchase:个人垫付:inv1:个人垫付科目']='不存在的科目'
        d.record_fills('a','test',c,self.schema)
        self.assertEqual(d.suggestions('a',c)['rows']['inv1']['科目'],[])

    def test_definition_can_make_attachment_required(self):
        schema=copy.deepcopy(SCHEMA)
        next(w for w in schema if w['type']=='attachmentV2')['required']=True
        form=p.build_form(schema,claim_for())
        files.add_attachment(form,schema,['native-code'])
        self.assertEqual(next(w['value'] for w in form if w['type']=='attachmentV2'),['native-code'])

    def test_upload_code_cache_and_attachment_control(self):
        ref=d.save_file('a',b'%PDF-original','a.pdf','application/pdf')
        claim={'invoices':[{'attachment':ref},{'attachment':ref}]}
        original=files.resolve_invoices('a',claim);self.assertEqual(len(original),1)
        with patch.object(files,'upload_file',return_value='real-native-code') as upload:
            self.assertEqual(files.file_codes('a',original),['real-native-code'])
            cached=files.resolve_invoices('a',claim)
            self.assertEqual(files.file_codes('a',cached),['real-native-code']);self.assertEqual(upload.call_count,1)
        form=[];files.add_attachment(form,SCHEMA,['real-native-code'])
        self.assertEqual(form,[{'id':'widget16510609389860001','type':'attachmentV2','value':['real-native-code']}])


class AttachmentCreationTests(unittest.TestCase):
    setUp = purchase_tests.CreateTests.setUp
    claim = purchase_tests.CreateTests.claim
    def test_missing_original_stops_before_initiate(self):
        c=self.claim();c['invoices'][0].pop('attachment')
        with patch.object(auth,'http_json') as call:
            with self.assertRaisesRegex(d.DataError,'缺少原文件'):p.create_purchase(self.sess,{'claim':c})
            call.assert_not_called()

    def test_failed_upload_never_initiates_and_can_retry(self):
        err=auth.FeishuAPIError(400,{'code':99991672,'msg':'file scope missing'});err.identity='tenant'
        with patch.object(files,'upload_file',side_effect=err),patch.object(auth,'http_json') as call:
            with self.assertRaises(auth.FeishuAPIError):p.create_purchase(self.sess,{'claim':self.claim()})
            call.assert_not_called()
        with patch.object(auth,'http_json',return_value={'code':0,'data':{'instance_code':'actual'}}):
            self.assertTrue(p.create_purchase(self.sess,{'claim':self.claim()})['ok'])

    def test_changed_file_contents_get_new_idempotency_key(self):
        c=self.claim();other=d.save_file('ou_oauth_user',b'%PDF-different','different.pdf','application/pdf')
        with patch.object(auth,'http_json',return_value={'code':0,'data':{'instance_code':'actual'}}) as call:
            first=p.create_purchase(self.sess,{'claim':c});c['invoices'][0]['attachment']=other
            second=p.create_purchase(self.sess,{'claim':c})
            self.assertNotEqual(first['requestId'],second['requestId']);self.assertEqual(call.call_count,2)

    def test_feishu_detail_confirms_visible_attachment(self):
        with patch.object(auth,'http_json',return_value={'code':0,'data':{'instance_code':'actual'}}),patch.object(auth,'fetch_instance',return_value={'form':json.dumps([{'type':'attachmentV2','value':['https://example.test/invoice.pdf']}])}):
            self.assertTrue(p.create_purchase(self.sess,{'claim':self.claim()})['attachmentsConfirmed'])


if __name__=='__main__':unittest.main()
