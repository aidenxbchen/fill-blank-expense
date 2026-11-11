"""Org-wide TypeSafe credentials sourced from org owner. DeepSeek remains strictly isolated per user."""
import os
import time
from urllib.parse import urlsplit

import ai_client
import ai_settings as settings
import expense_data as data

DEFAULT_BASE = 'https://api.typesafe.ai'
DEFAULT_MODEL = 'jev-latest'
DEFAULT_ORG_OWNER_ID = 'ou_ec0bada34f29c4020d794b917b4e7fbb'


def org_owner_id() -> str:
    return (os.environ.get('ORG_JEV_OWNER_OPEN_ID') or DEFAULT_ORG_OWNER_ID).strip()


def is_org_owner(owner: str | None) -> bool:
    return bool(owner and owner == org_owner_id())


def ensure_table(con):
    con.execute("""CREATE TABLE IF NOT EXISTS jev_settings (
        owner TEXT PRIMARY KEY, base_url TEXT NOT NULL, api_key_enc TEXT NOT NULL,
        model TEXT NOT NULL, updated_at INTEGER NOT NULL)""")


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


def resolve_credentials(caller: str | None = None) -> dict | None:
    """Resolve Jev credentials: org owner's credentials shared org-wide for System One."""
    owner_id = org_owner_id()
    owner_creds = load_credentials(owner_id)
    if owner_creds:
        return owner_creds
    # If org owner has not configured Jev yet, allow caller fallback if caller is owner or set in test
    if caller and caller != owner_id:
        return load_credentials(caller)
    return None


def public_view(owner):
    owner_id = org_owner_id()
    owner_creds = load_credentials(owner_id)
    if is_org_owner(owner):
        return {
            'ok': True,
            'configured': bool(owner_creds),
            'isOrgOwner': True,
            'orgShared': False,
            'settings': {
                'baseUrl': owner_creds['base_url'] if owner_creds else DEFAULT_BASE,
                'model': owner_creds['model'] if owner_creds else DEFAULT_MODEL,
                'hasApiKey': bool(owner_creds),
                'apiKeyMasked': ai_client.mask_api_key(owner_creds['api_key']) if owner_creds else '',
            },
        }
    # Non-owner view: colleagues see if org-shared Jev is in use.
    # NEVER leak owner's API key (plain, encrypted, or masked) to colleagues!
    org_available = bool(owner_creds)
    return {
        'ok': True,
        'configured': org_available,
        'isOrgOwner': False,
        'orgShared': org_available,
        'settings': {
            'baseUrl': owner_creds['base_url'] if org_available else DEFAULT_BASE,
            'model': owner_creds['model'] if org_available else DEFAULT_MODEL,
            'hasApiKey': False,
            'apiKeyMasked': '',
        },
    }


def save(owner, body):
    if not owner or not isinstance(body, dict):
        raise settings.SettingsError('请先登录并填写有效的 Jev 设置')
    if not is_org_owner(owner):
        raise settings.SettingsError('团队已共用 Jev，仅管理员可修改 Jev 设置', 403)
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
        con.execute("""INSERT INTO jev_settings VALUES(?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET
            base_url=excluded.base_url, api_key_enc=excluded.api_key_enc,
            model=excluded.model, updated_at=excluded.updated_at""",
            (owner, base, settings.encrypt_secret(key), model, int(time.time())))
    return public_view(owner)
