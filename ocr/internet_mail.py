"""Read-only Feishu mail adapter using the existing OAuth user's token.

No CLI account, tenant-token fallback, mark-read, send, or subscription API.
Mail bodies and filenames are untrusted data and never configure the task.
"""
import urllib.request
from datetime import datetime, timezone
from urllib.parse import quote, urlencode, urlparse

import expense_data as data
import feishu_oauth as auth

BASE = 'https://open.feishu.cn/open-apis/mail/v1/user_mailboxes/me'


def api(sess, method, path, payload=None):
    obj = auth.http_json(method, BASE + path, token=sess['access_token'], payload=payload)
    if obj.get('code') != 0:
        raise auth.FeishuAPIError(502, obj)
    return obj.get('data') or {}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise data.DataError('邮箱附件下载发生跳转，已阻止，请人工核对')


def download(url):
    # Signed attachment URLs only, never user/body-supplied URLs. No OAuth header.
    parsed = urlparse(url)
    host = parsed.hostname or ''
    if (parsed.scheme != 'https' or parsed.username or parsed.password
            or parsed.port not in (None, 443)
            or not any(host.endswith('.' + d) for d in ('feishu.cn', 'larksuite.com', 'feishucdn.com', 'larksuitecdn.com'))):
        raise data.DataError('邮箱附件下载域名未获信任，请人工核对')
    opener = urllib.request.build_opener(NoRedirect)
    with opener.open(urllib.request.Request(url, headers={'User-Agent':'baoxiao-internet-preview'}), timeout=30) as response:
        raw = response.read(data.MAX_FILE_BYTES + 1)
    if not raw or len(raw) > data.MAX_FILE_BYTES:
        raise data.DataError('邮箱附件为空或超过 24MB')
    return raw


def attachments(sess, since, until, check_active=lambda: None):
    """Bounded, paginated received-mail scan; any truncation fails visibly."""
    check_active()
    profile = api(sess, 'GET', '/profile')
    if not profile.get('primary_email_address'):
        raise data.DataError('当前 OAuth 用户未开通飞书邮箱或缺少邮箱读取权限')
    iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat()
    page = ''
    seen = set()
    for _ in range(20):
        check_active()
        query = {'page_size':15}
        if page: query['page_token'] = page
        result = api(sess, 'POST', '/search?' + urlencode(query), {
            'query':'发票', 'filter':{'has_attachment':True, 'folder':['inbox'],
                                    'create_time':{'start_time':iso(since), 'end_time':iso(until)}}})
        if result.get('notice'):
            raise data.DataError('邮箱搜索结果不完整，请缩小扫描范围后重试')
        for hit in result.get('items') or []:
            check_active()
            mid = hit['id']
            if mid in seen: continue
            seen.add(mid)
            message = api(sess, 'GET', '/messages/' + quote(mid, safe='') + '?format=full').get('message') or {}
            if message.get('message_state') != 1: continue
            if (message.get('security_level') or {}).get('is_risk'):
                raise data.DataError('邮箱发现风险邮件，已停止本轮，请人工核对')
            for attachment in message.get('attachments') or []:
                check_active()
                name = str(attachment.get('filename') or '')
                # The first release supports PDF originals only. No invoice URLs in email bodies.
                if attachment.get('is_inline') or not name.lower().endswith('.pdf'): continue
                aid = attachment['id']
                urls = api(sess, 'GET', '/messages/' + quote(mid, safe='') + '/attachments/download_url?' + urlencode({'attachment_ids':aid}))
                found = next((u for u in urls.get('download_urls') or [] if u.get('attachment_id') == aid), None)
                if not found or not found.get('download_url'):
                    raise data.DataError('邮箱未返回附件下载地址，请检查附件读取权限')
                raw = download(found['download_url'])
                check_active()
                yield {'messageId':mid, 'attachmentId':aid, 'name':name, 'mime':'application/pdf', 'raw':raw}
        if not result.get('has_more'): return
        next_page = result.get('page_token')
        if not next_page or next_page == page:
            raise data.DataError('邮箱分页异常，已停止本轮扫描')
        page = next_page
    raise data.DataError('邮箱扫描超过 300 封上限，请缩小范围')
