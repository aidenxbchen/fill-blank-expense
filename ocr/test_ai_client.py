import io
import json
import unittest
import urllib.error
from unittest.mock import patch

import ai_client


class FakeResp:
    def __init__(self, payload, status=200):
        self.status = status
        self._raw = json.dumps(payload).encode("utf-8") if not isinstance(payload, bytes) else payload

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class AIClientTests(unittest.TestCase):
    def test_join_chat_url(self):
        self.assertEqual(
            ai_client.join_chat_url("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/v1/chat/completions",
        )
        self.assertEqual(
            ai_client.join_chat_url("https://api.deepseek.com/v1/"),
            "https://api.deepseek.com/v1/chat/completions",
        )
        self.assertEqual(
            ai_client.join_chat_url("https://api.deepseek.com/v1/chat/completions"),
            "https://api.deepseek.com/v1/chat/completions",
        )
        self.assertEqual(
            ai_client.join_chat_url("http://127.0.0.1:11434/v1"),
            "http://127.0.0.1:11434/v1/chat/completions",
        )
        self.assertEqual(
            ai_client.normalize_base_url("https://api.deepseek.com"),
            "https://api.deepseek.com/v1",
        )
        self.assertEqual(
            ai_client.join_chat_url("https://api.deepseek.com"),
            "https://api.deepseek.com/v1/chat/completions",
        )
        with self.assertRaisesRegex(ValueError, "http"):
            ai_client.join_chat_url("ftp://example.com")
        with self.assertRaisesRegex(ValueError, "API Base URL"):
            ai_client.join_chat_url("   ")

    def test_mask_api_key(self):
        self.assertEqual(ai_client.mask_api_key("sk-abcdefghijklmnop"), "sk-***mnop")
        self.assertEqual(ai_client.mask_api_key("abcd"), "***abcd")
        self.assertEqual(ai_client.mask_api_key(""), "")
        self.assertTrue(ai_client.looks_masked("sk-***mnop"))
        self.assertTrue(ai_client.looks_masked(""))
        self.assertFalse(ai_client.looks_masked("sk-real-secret-key"))

    def test_public_error_strips_secrets(self):
        msg = ai_client.public_error(RuntimeError("failed Bearer sk-supersecretkeyvalue and sk-abcdefghij"))
        self.assertNotIn("supersecret", msg)
        self.assertNotIn("sk-abcdefghij", msg)

    def test_chat_uses_joined_url_and_returns_content(self):
        captured = {}

        def fake_urlopen(req, timeout=0):
            captured["url"] = req.full_url
            captured["auth"] = req.headers.get("Authorization")
            return FakeResp({"choices": [{"message": {"content": "ok"}}]})

        with patch("ai_client.urllib.request.urlopen", side_effect=fake_urlopen):
            out = ai_client.chat_completions(
                base_url="https://api.deepseek.com/v1",
                api_key="sk-testkey9999",
                model="deepseek-chat",
                messages=[{"role": "user", "content": "hi"}],
            )
        self.assertEqual(out, "ok")
        self.assertEqual(captured["url"], "https://api.deepseek.com/v1/chat/completions")
        self.assertEqual(captured["auth"], "Bearer sk-testkey9999")

    def test_http_error_is_chinese(self):
        def boom(req, timeout=0):
            raise urllib.error.HTTPError(
                req.full_url, 401, "Unauthorized", hdrs=None, fp=io.BytesIO(b'{"error":"nope"}')
            )

        with patch("ai_client.urllib.request.urlopen", side_effect=boom):
            with self.assertRaisesRegex(RuntimeError, "API Key"):
                ai_client.chat_completions(
                    base_url="https://api.deepseek.com/v1",
                    api_key="sk-bad",
                    model="deepseek-chat",
                    messages=[{"role": "user", "content": "hi"}],
                )


if __name__ == "__main__":
    unittest.main()
