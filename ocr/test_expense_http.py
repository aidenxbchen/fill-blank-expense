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
        for obj,key,val in [(server.auth,'get_session',self.session),(server.auth,'ensure_fresh_session',self.session),(server,'definition',SCHEMA)]:
            patcher=patch.object(obj,key,return_value=val);patcher.start();self.addCleanup(patcher.stop)

    def close_server(self):
        self.http.shutdown();self.http.server_close();self.thread.join(2)

    def request(self,path,raw,content_type):
        req=urllib.request.Request(self.base+path,data=raw,headers={'Content-Type':content_type},method='POST')
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
        self.assertEqual(status,200);self.assertTrue(result['suggestions']['rows']['inv1']['科目'])
        self.assertEqual(self.request('/api/fill-suggestions',json.dumps(body).encode(),'application/json')[0],200)


if __name__=='__main__':unittest.main()
