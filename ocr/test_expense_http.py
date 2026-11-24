import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import server
import expense_data as data
from test_feishu_purchase import SCHEMA


class QuietHandler(server.Handler):
    def log_message(self,*args):pass


class ExpenseHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        for key,value in [('DB_PATH',Path(self.tmp.name)/'data.db'),('FILE_ROOT',Path(self.tmp.name)/'files')]:
            obj=patch.object(data,key,value);obj.start();self.addCleanup(obj.stop)
        with patch('socket.getfqdn',return_value='localhost'):
            self.http=ThreadingHTTPServer(('127.0.0.1',0),QuietHandler)
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self.close_server)
        self.base='http://127.0.0.1:'+str(self.http.server_port)
        self.session={'access_token':'private-not-printed','user':{'openId':'alice'}}
        sync=patch.object(server.filling_workflow,'start_sync');sync.start();self.addCleanup(sync.stop)
        env=patch.dict('os.environ',{'BAOXIAO_SECRETS_KEY':'http-test-secret','ORG_JEV_OWNER_OPEN_ID':'alice'},clear=False)
        env.start();self.addCleanup(env.stop)
        for obj,key,val in [(server.auth,'get_session',self.session),(server.auth,'ensure_fresh_session',self.session),(server,'definition',SCHEMA)]:
            patcher=patch.object(obj,key,return_value=val);patcher.start();self.addCleanup(patcher.stop)

    def close_server(self):
        self.http.shutdown();self.http.server_close();self.thread.join(2)

    def request(self,path,raw=None,content_type='application/json',method=None):
        headers={}
        if content_type: headers['Content-Type']=content_type
        if method is None: method='POST' if raw is not None else 'GET'
        req=urllib.request.Request(self.base+path,data=raw,headers=headers,method=method)
        try:response=urllib.request.urlopen(req,timeout=5)
        except urllib.error.HTTPError as e:response=e
        with response:return response.status,json.load(response),response.headers

    def upload(self,path='/api/invoice-files'):
        body=b'--x\r\nContent-Disposition: form-data; name="file"; filename="invoice.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7 raw-original\r\n--x--\r\n'
        return self.request(path,body,'multipart/form-data; boundary=x')

    def test_login_required_for_uploads_and_history(self):
        with patch.object(server.auth,'get_session',return_value=None):
            self.assertEqual(self.upload()[0],401)
            self.assertEqual(self.request('/api/fill-suggestions',b'{"claim":{}}','application/json')[0],401)

    def test_budget_refresh_query_is_authenticated_and_bypasses_cache(self):
        with patch.object(server.auth, 'list_approved_budgets', return_value=([],'')) as listing:
            self.assertEqual(self.request('/api/budgets?refresh=1')[0],200)
            listing.assert_called_once_with(self.session['user'],refresh=True)
            listing.reset_mock()
            self.assertEqual(self.request('/api/budgets')[0],200)
            listing.assert_called_once_with(self.session['user'],refresh=False)
            listing.reset_mock()
            with patch.object(server.auth,'get_session',return_value=None):
                self.assertEqual(self.request('/api/budgets?refresh=1')[0],401)
            listing.assert_not_called()

    def test_original_upload_works_without_ocr(self):
        with patch.object(server,'parse_uploaded_invoice') as ocr:
            status,body,headers=self.upload()
            self.assertEqual(status,200);self.assertEqual(headers['Cache-Control'],'no-store')
            self.assertEqual(data.resolve_file('alice',body['attachment'])[1],b'%PDF-1.7 raw-original')
            ocr.assert_not_called()

    def test_ocr_failure_still_returns_original_for_manual_correction(self):
        with patch.object(server,'parse_uploaded_invoice',side_effect=RuntimeError('OCR unavailable')):
            status,body,_=self.upload('/api/parse-invoice')
        self.assertEqual(status,502);self.assertFalse(body['ok']);self.assertIn('attachment',body)
        self.assertEqual(data.resolve_file('alice',body['attachment'])[1],b'%PDF-1.7 raw-original')

    def test_record_and_read_suggestions_http(self):
        from test_feishu_purchase import claim_for
        body={'draftId':'draft1','claim':claim_for()}
        status,result,_=self.request('/api/fill-history',json.dumps(body).encode(),'application/json')
        self.assertEqual(status,200);self.assertEqual(result['suggestions']['rows']['inv1']['科目'], [], 'unapproved draft is never positive evidence')
        self.assertEqual(self.request('/api/fill-suggestions',json.dumps(body).encode(),'application/json')[0],200)

    def test_batch_prefill_and_preview_are_authenticated_and_do_not_create(self):
        from test_feishu_purchase import claim_for
        claim=claim_for('差旅费')
        claim['purpose']='本次出差'
        claim['answers']={'purchaseMethod':'差旅费','costCenter':claim['costCenter'],'purpose':claim['purpose']}
        claim['invoices'][0].update(category='meal',merchant='合成餐饮服务')
        body={'draftId':'batch','claim':claim}
        with patch.object(server.filling_workflow,'start_sync') as sync, patch.object(server,'handle_create') as create:
            status,result,_=self.request('/api/prefill',json.dumps(body).encode())
            self.assertEqual(status,200)
            self.assertEqual(result['answers']['purchase:差旅费:inv1:费用类型'],'餐费补贴')
            sync.assert_called_once()
            claim['answers']=result['answers']
            ref=data.save_file('alice',b'%PDF offline fixture','fixture.pdf','application/pdf')
            claim['invoices'][0]['attachment']=ref
            status,result,_=self.request('/api/review',json.dumps(body).encode())
            self.assertEqual(status,200)
            self.assertEqual(result['attachmentCount'],1)
            claim['answers']['purchase:差旅费:inv1:差旅科目']='业务招待费'
            self.assertEqual(self.request('/api/review',json.dumps(body).encode())[0],422)
            create.assert_not_called()
            with patch.object(server.auth,'get_session',return_value=None):
                self.assertEqual(self.request('/api/prefill',json.dumps(body).encode())[0],401)
                self.assertEqual(self.request('/api/review',json.dumps(body).encode())[0],401)

    def test_health_exposes_user_ai_flags_without_keys(self):
        status,body,_=self.request('/api/health')
        self.assertEqual(status,200)
        self.assertTrue(body['userAiConfigurable'])
        self.assertEqual(body['aiProviderHint'],'deepseek')
        self.assertEqual(body['recommendedModel'],'deepseek-chat')
        dumped=json.dumps(body)
        self.assertNotIn('apiKey', dumped)
        self.assertNotIn('sk-', dumped)

    def test_ai_settings_require_login_and_mask_saved_key(self):
        with patch.object(server.auth,'get_session',return_value=None):
            self.assertEqual(self.request('/api/ai-settings')[0],401)
            self.assertEqual(self.request('/api/ai-settings',b'{}',method='PUT')[0],401)
        payload=json.dumps({
            'baseUrl':'https://api.deepseek.com/v1',
            'apiKey':'sk-http-secret-key99',
            'textModel':'deepseek-chat',
        }).encode()
        status,body,_=self.request('/api/ai-settings',payload,method='PUT')
        self.assertEqual(status,200)
        self.assertTrue(body['configured'])
        self.assertEqual(body['settings']['apiKeyMasked'],'sk-***ey99')
        self.assertNotIn('sk-http-secret-key99', json.dumps(body))
        status,again,_=self.request('/api/ai-settings')
        self.assertEqual(status,200)
        self.assertEqual(again['settings']['apiKeyMasked'],'sk-***ey99')
        self.assertNotIn('sk-http-secret-key99', json.dumps(again))

    def test_jev_http_owner_auth_no_global_fallback(self):
        with patch.object(server.auth,'get_session',return_value=None):
            self.assertEqual(self.request('/api/jev-settings')[0],401)
            self.assertEqual(self.request('/api/choice-suggestions',b'{"claim":{}}')[0],401)
        status,body,_=self.request('/api/jev-settings',b'{"apiKey":"synthetic-jev-secret"}',method='PUT')
        self.assertEqual(status,200);self.assertTrue(body['configured']);self.assertTrue(body['isOrgOwner'])
        self.assertNotIn('synthetic-jev-secret',json.dumps(body))
        self.assertFalse(self.request('/api/ai-settings')[1]['configured'])
        other={'access_token':'synthetic','user':{'openId':'bob'}}
        with patch.object(server.auth,'get_session',return_value=other), patch.object(server.auth,'ensure_fresh_session',return_value=other):
            status_bob,body_bob,_=self.request('/api/jev-settings')
            self.assertEqual(status_bob,200)
            self.assertTrue(body_bob['configured'])
            self.assertTrue(body_bob['orgShared'])
            self.assertFalse(body_bob['isOrgOwner'])
            self.assertFalse(body_bob['settings']['hasApiKey'])
            self.assertEqual(body_bob['settings']['apiKeyMasked'],'')
            self.assertNotIn('synthetic-jev-secret',json.dumps(body_bob))
            self.assertEqual(self.request('/api/jev-settings',b'{"apiKey":"bob-key"}',method='PUT')[0],403)
            self.assertEqual(self.request('/api/jev-settings/test',b'{}',method='POST')[0],403)
            self.assertFalse(self.request('/api/ai-settings')[1]['configured'])
        with patch.object(server.choice_suggestions,'suggest',return_value={'rows':{},'global':{}}) as suggest:
            status,body,_=self.request('/api/choice-suggestions',b'{"owner":"bob","claim":{"answers":{},"invoices":[]}}')
            self.assertEqual(status,200);self.assertEqual(suggest.call_args.args[0],'alice')


if __name__=='__main__':unittest.main()
