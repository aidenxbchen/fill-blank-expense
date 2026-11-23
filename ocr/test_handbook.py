import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
import urllib.error
import urllib.request

import handbook
import server


class QuietHandler(server.Handler):
    def log_message(self, *args):
        pass


class HandbookTests(unittest.TestCase):
    def test_source_file_is_readable_and_secret_free(self):
        text = handbook.read_handbook()
        self.assertIn('这份准则是什么', text)
        self.assertIn('提交前检查清单', text)
        self.assertIn('案例是证据，不是模板', text)
        lowered = text.lower()
        for needle in ('baoxiao_secrets_key', 'begin rsa private key', 'sk-'):
            self.assertNotIn(needle, lowered)

    def test_http_requires_login_and_returns_markdown(self):
        session = {'access_token': 'private-not-printed', 'user': {'openId': 'alice'}}
        with patch.object(server.auth, 'get_session', return_value=session), patch.object(
            server.auth, 'ensure_fresh_session', return_value=session
        ), patch('socket.getfqdn', return_value='localhost'):
            httpd = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(lambda: (httpd.shutdown(), httpd.server_close(), thread.join(2)))
            base = 'http://127.0.0.1:' + str(httpd.server_port)

            def request():
                req = urllib.request.Request(base + '/api/handbook', method='GET')
                try:
                    response = urllib.request.urlopen(req, timeout=5)
                except urllib.error.HTTPError as e:
                    response = e
                with response:
                    return response.status, json.load(response)

            status, body = request()
            self.assertEqual(status, 200)
            self.assertTrue(body['ok'])
            self.assertEqual(body['filename'], '报了呗.md')
            self.assertIn('这份准则是什么', body['markdown'])

            with patch.object(server.auth, 'get_session', return_value=None):
                status, body = request()
            self.assertEqual(status, 401)
            self.assertFalse(body['ok'])
