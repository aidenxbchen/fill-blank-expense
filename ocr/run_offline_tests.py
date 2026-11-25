"""Run acceptance tests with temporary stores and no external sockets.

Usage: PYTHONDONTWRITEBYTECODE=1 python3 ocr/run_offline_tests.py [pytest args]
Local random HTTP test ports are permitted; no app server or workers are started.
"""
import os
from pathlib import Path
import socket
import sys
import tempfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'ocr'))


def main():
    import expense_data
    import feishu_purchase
    import feishu_oauth
    import handbook
    import pytest
    with tempfile.TemporaryDirectory(prefix='baoxiao-cod8-tests-') as directory:
        temporary = Path(directory)
        expense_data.ROOT = temporary
        expense_data.DB_PATH = temporary / 'data.db'
        expense_data.FILE_ROOT = temporary / 'files'
        feishu_purchase.DB_PATH = temporary / 'receipts.db'
        feishu_oauth._sessions_path = lambda: temporary / 'sessions.json'
        handbook.HANDBOOK_PATH = temporary / '报了呗.md'
        handbook.HANDBOOK_PATH.write_text((ROOT / '报了呗.md').read_text())
        for key in list(os.environ):
            if key.startswith(('FEISHU_', 'OPENAI_', 'DEEPSEEK_', 'BAOXIAO_AI_')):
                os.environ.pop(key, None)
        os.environ['BAOXIAO_SECRETS_KEY'] = 'offline-fixture-only'
        original = socket.socket.connect

        def connect(sock, address):
            if isinstance(address, tuple) and address[0] not in ('127.0.0.1', 'localhost', '::1'):
                raise AssertionError('Offline tests prohibit external network')
            return original(sock, address)

        socket.socket.connect = connect
        try:
            return pytest.main(['-q', '-p', 'no:cacheprovider', str(ROOT / 'ocr'), *sys.argv[1:]])
        finally:
            socket.socket.connect = original


if __name__ == '__main__':
    sys.exit(main())
