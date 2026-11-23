/**
 * Read-only handbook page. Fetches Markdown after Feishu login; never edits or saves.
 */
(function () {
  "use strict";

  function apiBase() {
    return location.hostname === "127.0.0.1" || location.hostname === "localhost"
      ? "http://127.0.0.1:18790"
      : "";
  }

  function loginHref() {
    return location.hostname === "127.0.0.1" || location.hostname === "localhost"
      ? "https://baoxiao.xbchen.top/api/auth/feishu/login"
      : "/api/auth/feishu/login";
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function inline(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, function (_, code) {
      return "<code>" + code + "</code>";
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*|\.\/[^)\s]+)\)/g, function (_, label, href) {
      return '<a href="' + href + '" rel="noopener noreferrer">' + label + "</a>";
    });
    return out;
  }

  function renderMarkdown(src) {
    const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
    const html = [];
    let inList = null;
    let inCode = false;
    let code = [];
    let para = [];

    function closePara() {
      if (!para.length) return;
      html.push("<p>" + inline(para.join("\n")) + "</p>");
      para = [];
    }

    function closeList() {
      if (!inList) return;
      html.push(inList === "ol" ? "</ol>" : "</ul>");
      inList = null;
    }

    function closeCode() {
      if (!inCode) return;
      html.push("<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>");
      inCode = false;
      code = [];
    }

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (inCode) {
        if (/^```/.test(line)) closeCode();
        else code.push(line);
        continue;
      }
      if (/^```/.test(line)) {
        closePara();
        closeList();
        inCode = true;
        code = [];
        continue;
      }
      const heading = /^(#{1,4})\s+(.+)$/.exec(line);
      if (heading) {
        closePara();
        closeList();
        const level = heading[1].length;
        html.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
        continue;
      }
      if (/^---+\s*$/.test(line)) {
        closePara();
        closeList();
        html.push("<hr />");
        continue;
      }
      const ul = /^\s*[-*]\s+(.+)$/.exec(line);
      if (ul) {
        closePara();
        if (inList !== "ul") {
          closeList();
          html.push("<ul>");
          inList = "ul";
        }
        html.push("<li>" + inline(ul[1]) + "</li>");
        continue;
      }
      const ol = /^\s*(\d+)\.\s+(.+)$/.exec(line);
      if (ol) {
        closePara();
        if (inList !== "ol") {
          closeList();
          html.push("<ol>");
          inList = "ol";
        }
        html.push("<li>" + inline(ol[2]) + "</li>");
        continue;
      }
      if (!line.trim()) {
        closePara();
        closeList();
        continue;
      }
      closeList();
      para.push(line);
    }
    closeCode();
    closePara();
    closeList();
    return html.join("\n");
  }

  let authUser = null;

  function renderAuth() {
    const loginBtn = document.getElementById("btn-feishu-login");
    const userEl = document.getElementById("auth-user");
    const nameEl = document.getElementById("auth-name");
    const av = document.getElementById("auth-avatar");
    if (authUser) {
      if (loginBtn) loginBtn.hidden = true;
      if (userEl) userEl.hidden = false;
      if (nameEl) nameEl.textContent = authUser.name || "飞书用户";
      if (av) {
        if (authUser.avatar) {
          av.src = authUser.avatar;
          av.hidden = false;
        } else {
          av.removeAttribute("src");
          av.hidden = true;
        }
      }
    } else if (loginBtn) {
      loginBtn.hidden = false;
      loginBtn.href = loginHref();
      if (userEl) userEl.hidden = true;
    }
  }

  function showStatus(html, isError) {
    const status = document.getElementById("handbook-status");
    const article = document.getElementById("handbook-article");
    article.hidden = true;
    article.innerHTML = "";
    status.hidden = false;
    status.classList.toggle("is-error", !!isError);
    status.innerHTML = html;
  }

  function showArticle(markdown) {
    const status = document.getElementById("handbook-status");
    const article = document.getElementById("handbook-article");
    status.hidden = true;
    status.textContent = "";
    article.innerHTML = renderMarkdown(markdown);
    article.hidden = false;
  }

  async function refreshAuth() {
    const loginBtn = document.getElementById("btn-feishu-login");
    if (loginBtn) loginBtn.href = loginHref();
    try {
      const res = await fetch(apiBase() + "/api/auth/me", {
        credentials: "include",
        cache: "no-store",
      });
      const data = await res.json();
      authUser = data && data.loggedIn ? data.user : null;
    } catch (e) {
      authUser = null;
    }
    renderAuth();
    return authUser;
  }

  async function loadHandbook() {
    const user = await refreshAuth();
    if (!user) {
      showStatus(
        "这份工作手册需登录后阅读，与工作台使用同一套飞书登录。<br />登录成功后会先回到工作台，再点一次「工作手册」即可。" +
          ' <a class="btn btn-primary handbook-login-cta" href="' +
          loginHref() +
          '">用飞书登录</a>',
        false
      );
      return;
    }
    showStatus("正在载入工作手册…", false);
    try {
      const res = await fetch(apiBase() + "/api/handbook", {
        credentials: "include",
        cache: "no-store",
      });
      const data = await res.json().catch(function () { return {}; });
      if (res.status === 401) {
        authUser = null;
        renderAuth();
        showStatus(
          "登录已失效，请重新用飞书登录后再看手册。" +
            ' <a class="btn btn-primary handbook-login-cta" href="' +
            loginHref() +
            '">用飞书登录</a>',
          true
        );
        return;
      }
      if (!res.ok || !data.ok || typeof data.markdown !== "string") {
        throw new Error(data.error || "手册暂不可用");
      }
      showArticle(data.markdown);
    } catch (e) {
      showStatus("手册载入失败：" + (e && e.message ? e.message : "请稍后重试"), true);
    }
  }

  async function logout() {
    try {
      await fetch(apiBase() + "/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch (e) {}
    authUser = null;
    renderAuth();
    showStatus(
      "已退出。这份工作手册需登录后阅读。" +
        ' <a class="btn btn-primary handbook-login-cta" href="' +
        loginHref() +
        '">用飞书登录</a>',
      false
    );
  }

  if (typeof window.__handbookTestHooks === "object") {
    window.__handbookTestHooks.renderMarkdown = renderMarkdown;
    window.__handbookTestHooks.escapeHtml = escapeHtml;
  } else {
    document.getElementById("btn-logout").addEventListener("click", logout);
    loadHandbook();
  }
})();
