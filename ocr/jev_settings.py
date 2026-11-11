"""Optional TypeSafe credentials. Never resolve a global or another owner's key."""
import time
from urllib.parse import urlsplit

import ai_client
import ai_settings as settings
import expense_data as data

DEFAULT_BASE = 'https://api.typesafe.ai'
DEFAULT_MODEL = 'jev-latest'


def ensure_table(con):
    con.execute('''CREATE TABLE IF NOT EXISTS jev_settings (
        owner TEXT PRIMARY KEY, base_url TEXT NOT NULL, api_key_enc TEXT NOT NULL,
        model TEXT NOT NULL, updated_at INTEGER NOT NULL)''')


def validate_base(value):
    base = str(value or DEFAULT_BASE).strip().rstrip('/')
    parsed = urlsplit(base)
    if (len(base) > 300 or parsed.scheme != 'https' or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in ('', '/v1')):
        raise settings.SettingsError('Jev Base URL 请填写 HTTPS 服务根地址，例如 https://api.typesafe.ai')
    return base[:-3] if base.endswith('/v1') else base


def load_credentials(owner):
    if not owner:
        return None
    with data.database() as con:
        ensure_table(con)
        row = con.execute('SELECT * FROM jev_settings WHERE owner=?', (owner,)).fetchone()
    if not row:
        return None
    try:
        key = settings.decrypt_secret(row['api_key_enc'])
    except Exception:
        return None
    if not key:
        return None
    return dict(base_url=row['base_url'], api_key=key, model=row['model'])


def public_view(owner):
    creds = load_credentials(owner)
    return {'ok': True, 'configured': bool(creds), 'settings': {
        'baseUrl': creds['base_url'] if creds else DEFAULT_BASE,
        'model': creds['model'] if creds else DEFAULT_MODEL,
        'hasApiKey': bool(creds),
        'apiKeyMasked': ai_client.mask_api_key(creds['api_key']) if creds else ''}}


def save(owner, body):
    if not owner or not isinstance(body, dict):
        raise settings.SettingsError('请先登录并填写有效的 Jev 设置')
    if body.get('clear') is True:
        with data.database() as con:
            ensure_table(con)
            con.execute('DELETE FROM jev_settings WHERE owner=?', (owner,))
        return public_view(owner)
    base = validate_base(body.get('baseUrl'))
    model = settings._validate_model(body.get('model') or DEFAULT_MODEL, required=True)
    incoming = body.get('apiKey')
    key = incoming.strip() if isinstance(incoming, str) else ''
    if ai_client.looks_masked(key):
        key = (load_credentials(owner) or {}).get('api_key', '')
    if not key or len(key) > settings.MAX_KEY or any(c.isspace() for c in key):
        raise settings.SettingsError('请填写自己的 Jev API Key；留空仅能保留本账号已保存的密钥')
    with data.database() as con:
        ensure_table(con)
        con.execute('''INSERT INTO jev_settings VALUES(?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET
            base_url=excluded.base_url, api_key_enc=excluded.api_key_enc,
            model=excluded.model, updated_at=excluded.updated_at''',
            (owner, base, settings.encrypt_secret(key), model, int(time.time())))
    return public_view(owner)
