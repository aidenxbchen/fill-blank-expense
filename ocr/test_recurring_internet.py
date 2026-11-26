"""Isolated acceptance: temp stores + deny all external network and real creation."""
import copy
import json
import os
import re
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import approval_files
import expense_data as data
import expense_records as records
import feishu_oauth as auth
import feishu_purchase as purchase
import internet_mail as mail
import invoice_extract as extract
import recurring_internet as tasks
import server
import test_expense_http as http_fixture
from test_feishu_purchase import SCHEMA, claim_for

NORMAL_CREATE = purchase.create_purchase
NORMAL_FILE_CODES = approval_files.file_codes

TEXT = '''电子发票 发票号码：12345678901234567890 开票日期：2026年11月20日
买 名称：澜理商贸（珠海）有限公司                  售 名称：中国电信股份有限公司广州分公司
信 统一社会信用代码/纳税人识别号：                  信 统一社会信用代码/纳税人识别号：91440100123456789P
项目名称  单位 数量 单价 金额
*电信服务*通信服务费 项 1 379.00 379.00
价税合计（小写）¥379.00
计费周期:202610;号码:internet-test-account;
'''


def invoice(text=TEXT):
    return {**extract.parse_invoice_from_text(text),'raw':text,'items':[{'name':'*电信服务*通信服务费','unit':'项','quantity':1}], 'amount':379}


class TaskTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        root=Path(self.tmp.name)
        for obj,key,val in [(data,'DB_PATH',root/'data.db'),(data,'FILE_ROOT',root/'files'),(purchase,'DB_PATH',root/'receipts.db')]:
            p=patch.object(obj,key,val);p.start();self.addCleanup(p.stop)
        # A missed mock fails closed before any outbound read/write or approval.
        for obj,key in [(auth,'http_json'),(tasks.purchase,'create_purchase'),(approval_files,'upload_file'),(approval_files,'file_codes')]:
            p=patch.object(obj,key,side_effect=AssertionError('Forbidden real network/approval/upload'))
            m=p.start();self.addCleanup(p.stop)
            if key=='create_purchase': self.create=m
        p=patch('urllib.request.urlopen',side_effect=AssertionError('Forbidden external network'));p.start();self.addCleanup(p.stop)
        p=patch('urllib.request.OpenerDirector.open',side_effect=AssertionError('Forbidden download'));p.start();self.addCleanup(p.stop)
        for obj,key,val in [(purchase,'definition',SCHEMA),(auth,'fetch_user_info',{'openId':'alice','name':'合成测试用户'}),
                            (auth,'get_tenant_access_token','offline'),
                            (auth,'fetch_instance',{'approval_code':auth.BUDGET_DEFINITIONS[0]['approval_code'],'status':'APPROVED'}),
                            (auth,'list_approved_budgets',([{'instanceId':'11111111-1111-1111-1111-111111111111'}],''))]:
            p=patch.object(obj,key,return_value=val);p.start();self.addCleanup(p.stop)
        self.sess={'access_token':'synthetic','user':{'openId':'alice'}}
        claim=claim_for()
        state={'draftId':'template','stage':'draft','answers':{**claim['answers'],'purpose':'常规网费'},'chat':[],
            'invoices':claim['invoices']}
        records.save_draft('alice','template',{'revision':0,'state':state})
        self.config={'intervalSeconds':86400,'scanSince':int(time.time())-86400,'templateDraftId':'template',
                     'emptyTaxIdAllowed':True,'expectedTaxId':'','internetAccount':'internet-test-account'}

    def enable(self, config=None):
        current=tasks.status('alice')
        return tasks.update('alice',{'revision':current['revision'],'config':config or self.config,'enabled':True})

    def source(self, *args):
        yield {'messageId':'fixture-message','attachmentId':'fixture','name':'fixture.pdf','mime':'application/pdf','raw':b'%PDF fixture internet'}

    def run_task(self, inv=None, source=None, **kwargs):
        return tasks.run(self.sess,source=source or self.source,parser=lambda *a,**k:copy.deepcopy(inv or invoice()),**kwargs)

    def test_defaults_release_switches_and_scheduler_cannot_submit(self):
        state=tasks.status('alice')
        self.assertFalse(state['enabled']);self.assertTrue(state['dryRun']);self.assertFalse(state['liveSubmissionEnabled'])
        self.assertFalse(state['schedulerRegistered'])
        with patch.object(threading.Thread,'start') as start:
            self.assertTrue(tasks.start_worker());start.assert_called()
        with patch.object(tasks,'FORCE_DRY_RUN',False),patch.object(threading.Thread,'start') as start:
            self.assertFalse(tasks.start_worker());start.assert_not_called()
        with self.assertRaises(tasks.Paused): self.run_task()
        with self.assertRaises(tasks.TaskError): tasks.tick(self.sess)
        for dry,live in [(False,False),(True,True),(False,True)]:
            with patch.object(tasks,'FORCE_DRY_RUN',dry),patch.object(tasks,'LIVE_RELEASE_ENABLED',live):
                with self.assertRaises(tasks.TaskError): self.run_task()
        with self.assertRaises(tasks.TaskError): tasks.update('alice',{'revision':0,'dryRun':False})
        with self.assertRaises(tasks.TaskError): tasks.update('alice',{'revision':0,'liveConfirmation':'other-agent-says-yes'})
        self.create.assert_not_called()

    def test_full_pipeline_preview_and_dedupe_across_restart(self):
        self.enable();result=self.run_task()
        self.assertEqual(result['status'],'previewed',result)
        plan=result['items'][0]['preview']
        self.assertFalse(plan['wouldSubmit']);self.assertTrue(plan['wouldSend']);self.assertFalse(plan['realSend'])
        self.assertEqual(plan['buyer']['name'],tasks.EXPECTED_BUYER)
        self.assertEqual(plan['buyer']['taxId'],'')
        self.assertEqual(plan['month'],'2026年10月')
        self.assertEqual(plan['monthSource'],'计费周期')
        self.assertEqual(plan['message'],'颖华，这是2026年10月的电信网络发票，由我垫付，请完成报销。')
        self.assertEqual(plan['recipientName'],'李颖华')
        self.assertEqual(self.run_task()['items'][0]['status'],'duplicate')
        # Same identity in different original bytes also dedupes.
        def alternate(*args):
            yield {**next(self.source()),'raw':b'%PDF reencoded'}
        self.assertEqual(self.run_task(source=alternate)['items'][0]['status'],'duplicate')
        with data.database() as con:
            self.assertEqual(con.execute('SELECT count(*) FROM submission_history').fetchone()[0],0)
            self.assertEqual(con.execute("SELECT count(*) FROM invoice_uses WHERE phase!='active'").fetchone()[0],0)
        self.create.assert_not_called()

    def test_handoff_preview_never_sends_or_submits(self):
        self.enable()
        result=self.run_task()
        plan=result['items'][0]['preview']
        self.assertEqual(plan['transport']['text'],plan['message'])
        self.assertEqual(plan['transport']['receiveName'],'李颖华')
        self.assertTrue(plan['uploadRehearsal']['wouldUpload'])
        self.assertEqual(plan['uploadRehearsal']['fileName'],'fixture.pdf')
        self.assertEqual(plan['attachments'][0]['size'],len(b'%PDF fixture internet'))
        self.assertNotIn('openId', json.dumps(plan))
        self.assertFalse(plan['sent'])
        self.assertEqual(result['realApprovalsCreated'],0)
        self.assertEqual(result.get('realMessagesSent'),0)
        self.create.assert_not_called()
        import internet_handoff as handoff
        blocked=handoff.deliver(invoice(),{'name':'net.pdf','mime':'application/pdf','raw':b'%PDF fixture internet'},dry_run=False,live_enabled=True)
        self.assertFalse(blocked['sent']);self.assertFalse(blocked['realSend'])

    def test_buyer_blank_tax_and_wrong_tax_fail_closed(self):
        self.assertEqual(tasks.check_buyer(invoice(),self.config)['taxId'],'')
        for rule in [None,False]:
            cfg={**self.config,'emptyTaxIdAllowed':rule}
            with self.assertRaisesRegex(tasks.TaskError,'税号为空'): tasks.check_buyer(invoice(),cfg)
        for name in ['深圳市澜锘创新科技有限责任公司','其他有限公司']:
            with self.assertRaisesRegex(tasks.TaskError,'购方'):
                tasks.check_buyer(invoice(TEXT.replace(tasks.EXPECTED_BUYER,name)),self.config)
        nonempty=TEXT.replace('识别号：                  信','识别号：123456789012345678                  信')
        with self.assertRaisesRegex(tasks.TaskError,'税号异常'):tasks.check_buyer(invoice(nonempty),self.config)
        self.assertEqual(tasks.check_buyer(invoice(nonempty),{**self.config,'expectedTaxId':'123456789012345678'})['taxId'],'123456789012345678')
        with self.assertRaisesRegex(tasks.TaskError,'税号区域'):tasks.check_buyer(invoice(TEXT.replace('纳税人识别号','未识别区域')),self.config)

    def test_scope_mixed_unknown_and_ocr_anomaly_block(self):
        for inv,cfg in [(invoice(),{**self.config,'internetAccount':''}),
                        ({**invoice(),'items':[{'name':'宽带网费'},{'name':'手机话费'}]},self.config),
                        ({**invoice(),'items':[{'name':'餐饮费'}]},self.config),
                        ({**invoice(),'needs_review':True},self.config),
                        ({**invoice(),'review_error':'offline error'},self.config)]:
            with self.assertRaises(tasks.TaskError):tasks.internet_evidence(inv,cfg)
        self.assertTrue(tasks.internet_evidence({**invoice(),'items':[{'name':'宽带网费'}]},self.config))

    def test_missing_month_and_failure_tracking(self):
        self.enable()
        blank={**invoice(),'raw':TEXT.replace('计费周期:202610;','').replace('开票日期：2026年11月20日',''),'date':'待确认'}
        result=self.run_task(inv=blank)
        self.assertEqual(result['items'][0]['status'],'blocked')
        self.assertIn('月份',result['items'][0]['message'])
        def broken(*args): raise RuntimeError('private-token-should-not-be-recorded')
        result=tasks.run(self.sess,source=broken)
        self.assertEqual(result['status'],'failed');self.assertNotIn('private-token',json.dumps(result))
        self.assertIsNone(tasks.status('alice')['running'])
        self.create.assert_not_called()

    def test_pause_before_run_mid_scan_and_before_persist(self):
        self.enable()
        def pause():
            current=tasks.status('alice')
            tasks.update('alice',{'revision':current['revision'],'enabled':False})
        def paused_source(*args):
            pause();yield next(self.source())
        self.assertEqual(self.run_task(source=paused_source)['status'],'paused')
        with self.assertRaises(tasks.Paused):self.run_task()
        self.enable()
        original=tasks.preview
        def pause_at_last_check(*args):
            result=original(*args);pause();return result
        with patch.object(tasks,'preview',side_effect=pause_at_last_check):
            self.assertEqual(self.run_task()['status'],'paused')
        with data.database() as con:
            self.assertEqual(con.execute("SELECT count(*) FROM internet_candidates WHERE status='previewed'").fetchone()[0],0)
        self.create.assert_not_called()

    def test_concurrent_process_guard_and_global_lease(self):
        self.enable();entered=threading.Event();release=threading.Event()
        def slow(*args):
            entered.set();release.wait(5);yield next(self.source())
        with ThreadPoolExecutor(2) as pool:
            first=pool.submit(self.run_task,source=slow)
            self.assertTrue(entered.wait(3))
            try:
                with self.assertRaisesRegex(tasks.TaskError,'正在运行'):self.run_task()
            finally: release.set()
            self.assertEqual(first.result(5)['status'],'previewed')
        self.assertFalse(tasks.lease('bob','different-run',['digital:12345678901234567890']))
        self.create.assert_not_called()

    def test_existing_manual_invoice_is_never_processed(self):
        self.enable()
        ref=data.save_file('alice',next(self.source())['raw'],'owned.pdf','application/pdf')
        with data.database() as con:
            import invoice_registry
            invoice_registry.sync_draft(con,'alice','existing',[{'id':'inv','attachment':ref}])
        result=self.run_task()
        self.assertEqual(result['items'][0]['status'],'blocked')
        self.assertNotIn('preview',result['items'][0]);self.create.assert_not_called()

    def test_revision_owner_scope_and_interrupted_recovery(self):
        self.enable()
        with self.assertRaises(tasks.TaskError):tasks.update('alice',{'revision':0,'enabled':False})
        self.assertFalse(tasks.status('bob')['enabled']);self.assertEqual(tasks.status('bob')['runs'],[])
        with self.assertRaises(records.RecordError):tasks.update('bob',{'revision':0,'config':self.config})
        current=tasks.status('alice');tasks.update('alice',{'revision':current['revision'],'enabled':False})
        with data.database() as con:
            con.execute("INSERT INTO internet_runs(id,owner,status,started) VALUES('crash','alice','running',1)")
            con.execute("UPDATE internet_tasks SET running='crash' WHERE owner='alice'")
        current=tasks.status('alice');tasks.recover_interrupted('alice',current['revision'])
        self.assertIsNone(tasks.status('alice')['running'])
        self.assertEqual(tasks.status('alice')['runs'][0]['status'],'interrupted')

    def test_schedule_due_and_pause_use_same_gate(self):
        self.enable();self.assertEqual(self.run_task(scheduled=True)['status'],'previewed')
        self.assertTrue(self.run_task(scheduled=True)['notDue'])
        current=tasks.status('alice');tasks.update('alice',{'revision':current['revision'],'enabled':False})
        with self.assertRaises(tasks.Paused):tasks.tick(self.sess)

    def test_missing_session_is_audited_and_pause_prevents_scheduler_attempt(self):
        self.enable();tasks.record_missing_session('alice')
        task=tasks.status('alice')
        self.assertEqual(task['runs'][0]['status'],'blocked')
        self.assertIn('重新登录',task['runs'][0]['result']['message'])
        tasks.update('alice',{'revision':task['revision'],'enabled':False})
        tasks.record_missing_session('alice')
        self.assertEqual(len(tasks.status('alice')['runs']),1)
        self.create.assert_not_called()

    def test_real_pdf_heuristic_pipeline_offline(self):
        path=Path('/Users/chenxibin/Desktop/Invoice/10 月网费/通讯-1120-379.pdf')
        if not path.exists():self.skipTest('local acceptance original unavailable')
        raw=path.read_bytes();self.assertEqual(len(raw),57804)
        text=extract.extract_pdf_text(raw)
        account=re.search(r'(?:^|[;；\s])号码[：:]\s*([A-Za-z0-9_-]+)',text,re.M).group(1)
        self.enable({**self.config,'internetAccount':account})
        def real_original(*args):
            yield {'raw':raw,'name':'local-acceptance.pdf','mime':'application/pdf'}
        with patch.object(extract,'resolve_review_endpoint',return_value=(None,'offline')), patch.object(extract,'review_fields_with_llm',return_value=None):
            result=tasks.run(self.sess,source=real_original)
        self.assertEqual(result['status'],'previewed',result)
        plan=result['items'][0]['preview']
        self.assertEqual(plan['buyer']['name'],tasks.EXPECTED_BUYER)
        self.assertEqual(plan['buyer']['taxId'],'')
        self.assertTrue(plan['month'])
        self.assertIn('请完成报销',plan['message'])
        self.assertFalse(plan['realSend']);self.create.assert_not_called()


class TaskHTTPTests(unittest.TestCase):
    setUp=http_fixture.ExpenseHTTPTests.setUp
    close_server=http_fixture.ExpenseHTTPTests.close_server
    request=http_fixture.ExpenseHTTPTests.request

    def test_authenticated_default_state_reject_live_and_injected_invoice(self):
        status,body,_=self.request('/api/automatic-tasks/internet')
        self.assertEqual(status,200);self.assertFalse(body['enabled']);self.assertTrue(body['dryRun'])
        with patch.object(server,'handle_create') as create,patch.object(purchase,'create_purchase') as purchase_create:
            self.assertEqual(self.request('/api/automatic-tasks/internet',b'{"revision":0,"dryRun":false}')[0],403)
            self.assertEqual(self.request('/api/automatic-tasks/internet/preview',b'{"dryRun":false}')[0],403)
            self.assertEqual(self.request('/api/automatic-tasks/internet/preview',b'{"dryRun":true,"claim":{}}')[0],403)
            self.assertEqual(self.request('/api/automatic-tasks/internet/preview',b'{"dryRun":true}')[0],409)
            create.assert_not_called();purchase_create.assert_not_called()
        with patch.object(server.auth,'get_session',return_value=None):
            self.assertEqual(self.request('/api/automatic-tasks/internet')[0],401)
            self.assertEqual(self.request('/api/automatic-tasks/internet',b'{"revision":0,"enabled":true}')[0],401)
        self.assertEqual(self.request('/api/automatic-tasks/internet',b'[]')[0],422)
        self.assertEqual(self.request('/api/automatic-tasks/internet',b'{"revision":0,"enabled":true}')[0],422)


    def test_full_http_preview_uses_mock_scan_and_never_creates(self):
        claim=claim_for()
        state={'draftId':'template','stage':'draft','chat':[],'invoices':claim['invoices'],
               'answers':{**claim['answers'],
                          'purpose':'常规网费'}}
        records.save_draft('alice','template',{'revision':0,'state':state})
        config={'intervalSeconds':86400,'scanSince':int(time.time())-3600,'templateDraftId':'template',
                'emptyTaxIdAllowed':True,'internetAccount':'internet-test-account'}
        status,_,_=self.request('/api/automatic-tasks/internet',json.dumps({'revision':0,'config':config,'enabled':True}).encode())
        self.assertEqual(status,200)
        source=[{'raw':b'%PDF http fixture','name':'fixture.pdf','mime':'application/pdf'}]
        with patch.object(mail,'attachments',return_value=iter(source)), patch.object(tasks,'parse_uploaded_invoice',return_value=invoice()), patch.object(purchase,'definition',return_value=SCHEMA), patch.object(auth,'fetch_user_info',return_value={'openId':'alice'}), patch.object(auth,'get_tenant_access_token',return_value='offline'), patch.object(purchase,'validate_relation'), patch.object(auth,'http_json',side_effect=AssertionError('external network forbidden')), patch.object(purchase,'create_purchase') as create, patch.object(approval_files,'upload_file') as upload:
            status,result,_=self.request('/api/automatic-tasks/internet/preview',b'{"dryRun":true}')
        self.assertEqual(status,200)
        self.assertEqual(result['status'],'previewed',result)
        plan=result['items'][0]['preview']
        self.assertTrue(plan['wouldSend']);self.assertFalse(plan['realSend'])
        self.assertEqual(plan['month'],'2026年10月')
        self.assertEqual(plan['message'],'颖华，这是2026年10月的电信网络发票，由我垫付，请完成报销。')
        create.assert_not_called();upload.assert_not_called()
        self.assertEqual(result['realApprovalsCreated'],0)


class MailAdapterTests(unittest.TestCase):
    def test_pagination_download_and_oauth_only(self):
        calls=[]
        def response(method,url,token,payload=None):
            calls.append((method,url,token,payload))
            if url.endswith('/profile'):return {'code':0,'data':{'primary_email_address':'fixture@example.invalid'}}
            if '/search?' in url:
                page='page_token=' in url
                return {'code':0,'data':{'items':[{'id':'m2' if page else 'm1'}],'has_more':not page,'page_token':'next' if not page else ''}}
            if '/attachments/download_url?' in url:return {'code':0,'data':{'download_urls':[{'attachment_id':'a1','download_url':'https://sample.feishu.cn/attachment'}]}}
            return {'code':0,'data':{'message':{'message_state':1,'attachments':[
                {'id':'inline','filename':'pixel.pdf','is_inline':True},{'id':'text','filename':'notes.txt'},
                {'id':'a1','filename':'invoice.pdf'}]}}}
        sess={'access_token':'synthetic-user-only'}
        with patch.object(auth,'http_json',side_effect=response),patch.object(auth,'get_tenant_access_token',side_effect=AssertionError('no tenant fallback')), patch.object(mail,'download',return_value=b'%PDF fixture'):
            items=list(mail.attachments(sess,1,2))
        self.assertEqual(len(items),2)
        self.assertTrue(all(token=='synthetic-user-only' for _,_,token,_ in calls))
        self.assertTrue(all(method=='GET' or '/search?' in url for method,url,_,_ in calls))
        self.assertEqual([item['messageId'] for item in items],['m1','m2'])
        search=next(c for c in calls if '/search?' in c[1])
        self.assertEqual(search[3]['filter']['folder'],['inbox'])
        self.assertEqual(search[3]['filter']['create_time']['start_time'],'1970-01-01T00:00:01+00:00')

    def test_untrusted_download_urls_and_partial_scans_fail_closed(self):
        for url in ['http://sample.feishu.cn/file','https://127.0.0.1/file','https://feishu.cn.evil.invalid/file','https://sample.feishu.cn:8443/file','https://user:password@sample.feishu.cn/file']:
            with self.assertRaises(data.DataError):mail.download(url)
        for payload in [{'notice':'truncated'}, {'items':[],'has_more':True,'page_token':''}]:
            with patch.object(mail,'api',side_effect=[{'primary_email_address':'fixture@example.invalid'},payload]):
                with self.assertRaises(data.DataError):list(mail.attachments({'access_token':'synthetic'},1,2))
        def paused():raise tasks.Paused('paused')
        with patch.object(mail,'api') as api:
            with self.assertRaises(tasks.Paused):list(mail.attachments({'access_token':'synthetic'},1,2,paused))
            api.assert_not_called()
