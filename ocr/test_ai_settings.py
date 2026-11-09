import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import ai_client
import ai_settings
import expense_data as data


class AISettingsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        for key, value in [("DB_PATH", root / "data.db"), ("FILE_ROOT", root / "files"), ("ROOT", root)]:
            patcher = patch.object(data, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.key_env = patch.dict("os.environ", {"BAOXIAO_SECRETS_KEY": "unit-test-secret"}, clear=False)
        self.key_env.start()
        self.addCleanup(self.key_env.stop)

    def test_save_masks_key_and_keeps_secret_server_side(self):
        view = ai_settings.save(
            "alice",
            {
                "baseUrl": "https://api.deepseek.com/v1",
                "apiKey": "sk-abcdefghijklmnop",
                "textModel": "deepseek-chat",
            },
        )
        self.assertTrue(view["configured"])
        self.assertEqual(view["settings"]["apiKeyMasked"], "sk-***mnop")
        self.assertTrue(view["settings"]["hasApiKey"])
        self.assertNotIn("sk-abcdefghijklmnop", str(view))
        creds = ai_settings.load_credentials("alice")
        self.assertEqual(creds["api_key"], "sk-abcdefghijklmnop")
        self.assertEqual(creds["model"], "deepseek-chat")
        self.assertIsNone(ai_settings.load_credentials("bob"))

    def test_empty_or_masked_key_is_replace_only(self):
        ai_settings.save(
            "alice",
            {"baseUrl": "https://api.deepseek.com/v1", "apiKey": "sk-oldkey00001234", "textModel": "deepseek-chat"},
        )
        again = ai_settings.save(
            "alice",
            {
                "baseUrl": "https://api.deepseek.com/v1",
                "apiKey": "sk-***1234",
                "textModel": "deepseek-chat",
                "visionModel": "",
            },
        )
        self.assertEqual(ai_settings.load_credentials("alice")["api_key"], "sk-oldkey00001234")
        self.assertEqual(again["settings"]["apiKeyMasked"], "sk-***1234")
        kept = ai_settings.save(
            "alice",
            {"baseUrl": "https://api.deepseek.com/v1", "apiKey": "", "textModel": "deepseek-reasoner"},
        )
        self.assertEqual(ai_settings.load_credentials("alice")["model"], "deepseek-reasoner")
        self.assertEqual(ai_settings.load_credentials("alice")["api_key"], "sk-oldkey00001234")
        self.assertEqual(kept["defaults"]["provider"], "Deepseek")

    def test_clear_and_first_save_requires_key(self):
        with self.assertRaisesRegex(ai_settings.SettingsError, "API Key"):
            ai_settings.save("alice", {"baseUrl": "https://api.deepseek.com/v1", "textModel": "deepseek-chat"})
        ai_settings.save(
            "alice",
            {"baseUrl": "https://api.deepseek.com/v1", "apiKey": "sk-tempkey", "textModel": "deepseek-chat"},
        )
        cleared = ai_settings.save("alice", {"clear": True})
        self.assertFalse(cleared["configured"])
        self.assertIsNone(ai_settings.load_credentials("alice"))


if __name__ == "__main__":
    unittest.main()
