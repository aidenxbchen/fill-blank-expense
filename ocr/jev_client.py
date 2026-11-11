"""TypeSafe System One HTTP client, deliberately separate from chat/completions."""
import json
import urllib.error
import urllib.request

from jev_settings import validate_base


class JevError(RuntimeError):
    pass


def system_one(*, base_url, api_key, model, state, questions, timeout=12):
    req = urllib.request.Request(validate_base(base_url) + '/v1/systemone',
        data=json.dumps({'model': model, 'state': state, 'questions': questions}, ensure_ascii=False).encode(),
        headers={'Authorization': 'Bearer ' + api_key, 'Content-Type': 'application/json'}, method='POST')
    # Never follow a redirect carrying this user's Authorization to another service.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=timeout) as response:
            raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise JevError('Jev 响应过大，已转用文本模型')
        result = json.loads(raw)
        if not isinstance(result, dict) or not isinstance(result.get('answers'), dict):
            raise JevError('Jev 响应格式无效，已转用文本模型')
        return result
    except urllib.error.HTTPError as exc:
        # Upstream bodies can echo secrets/state: do not read or log them.
        message = {401: '密钥无效，请在 AI 设置更新 Jev 密钥', 403: '权限不足，请检查 Jev 账号',
                   429: '请求限流，已转用文本模型'}.get(exc.code, '服务暂不可用，已转用文本模型')
        raise JevError('Jev ' + message) from None
    except JevError:
        raise
    except Exception:
        raise JevError('Jev 连接或响应异常，已转用文本模型') from None
