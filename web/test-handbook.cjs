/* Read-only handbook entry and renderer checks. No network, no credentials.
 * --fixture /tmp/handbook.html renders the real Markdown/CSS in a browser,
 * with only the auth/handbook responses replaced by local, read-only fixtures.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');

const web = __dirname;
const root = path.join(web, '..');
const index = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const handbookPage = fs.readFileSync(path.join(web, 'handbook.html'), 'utf8');
const handbookJs = fs.readFileSync(path.join(web, 'handbook.js'), 'utf8');
const css = fs.readFileSync(path.join(web, 'styles.css'), 'utf8');
const md = fs.readFileSync(path.join(root, '报了呗.md'), 'utf8');

if (process.argv[2] === '--fixture') {
  assert.ok(process.argv[3], 'provide an output HTML path');
  const data = JSON.stringify(md).replace(/</g, '\\u003c');
  const bootstrap = `<base href="${pathToFileURL(web + path.sep).href}"><script>
    window.fetch = async function (url) {
      const route = new URL(url, 'https://fixture.invalid').pathname;
      let data;
      if (route === '/api/auth/me') data = {loggedIn: true, user: {name: '本地排版核对'}};
      else if (route === '/api/handbook') data = {ok: true, markdown: ${data}};
      else throw new Error('Fixture blocked unexpected request: ' + route);
      return {ok: true, status: 200, json: async () => data};
    };
  </script>`;
  fs.writeFileSync(process.argv[3], handbookPage.replace('<head>', '<head>' + bootstrap));
  console.log('Offline handbook fixture: ' + process.argv[3]);
  process.exit(0);
}

assert.ok(index.includes('href="./handbook.html"') && index.includes('工作手册'), 'main page needs a handbook entry');
assert.equal((index.match(/<header\b/g) || []).length, 1, 'main page must keep a single header');
assert.ok(index.includes('id="btn-reset"') && index.includes('>新建报销</button>'), '新建报销 stays a standalone button');
assert.ok(index.includes('id="upload-triad"'), 'triad layout hook must remain');
assert.ok(!index.includes('contenteditable') && !handbookPage.includes('contenteditable'));
assert.ok(!handbookPage.includes('<textarea'));
assert.ok(!handbookJs.includes('localStorage.setItem') && !handbookJs.includes('contenteditable'));
assert.ok(handbookJs.includes('/api/handbook') && !handbookJs.includes('/api/feishu-expense'));
assert.ok(!handbookJs.match(/method:\s*['"]PUT['"]/) && !handbookJs.match(/method:\s*['"]PATCH['"]/));
assert.equal((handbookPage.match(/<header\b/g) || []).length, 1);
assert.ok(handbookPage.includes('logo-zbs') && handbookPage.includes('报了呗'));
assert.ok(handbookPage.includes('styles.css?v=20261123handbook2'));
assert.ok(handbookPage.includes('handbook.js?v=20261123handbook2'));
assert.ok(handbookJs.includes('credentials: "include"'));
assert.ok(css.includes('.handbook-article') && css.includes('.site-footer'));
assert.ok(!css.includes('blessing-eye') && !handbookPage.includes('ornament'));

const forbidden = [/sk-[a-zA-Z0-9]{10,}/, /api[_-]?key\s*=/i, /BAOXIAO_SECRETS_KEY/, /BEGIN (RSA |OPENSSH )?PRIVATE KEY/];
for (const re of forbidden) assert.ok(!re.test(md), 'handbook must not contain secrets: ' + re);

assert.ok(md.includes('这份准则是什么'));
assert.ok(md.includes('执行准则') && md.includes('案例是证据，不是模板'));
assert.ok(md.includes('表单强制') && md.includes('产品 / 流程强制'));

assert.ok(md.includes('~/Code/fill-blank-expense'));
assert.ok(md.includes('restart-local.sh'));
assert.ok(md.includes('不要 git push') || md.includes('不要 `git push`'));
assert.ok(md.includes('cli_aaa28a16ca785cba'));
assert.ok(md.includes('ou_320bc2979ab87189e5e649aa6ea60ad3'));
assert.ok(md.includes('ou_ec0bada34f29c4020d794b917b4e7fbb'));
assert.ok(md.includes('提交前检查清单'));
assert.ok(md.includes('代订附加'));
assert.ok(md.includes('但是你没加附件，这是不对的'));
assert.ok(!/\d{8,}/.test(md.replace(/cli_aaa28a16ca785cba/g, '').replace(/ou_[a-f0-9]+/g, '').replace(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g, '')), 'avoid personal invoice-like long numbers');

const context = { window: {}, document: { getElementById: () => ({ addEventListener() {}, hidden: true }) }, location: { hostname: 'baoxiao.xbchen.top' } };
context.window.__handbookTestHooks = {};
vm.runInNewContext(handbookJs, context);
const hooks = context.window.__handbookTestHooks;
assert.equal(typeof hooks.renderMarkdown, 'function');
const rendered = hooks.renderMarkdown('# 标题\n\n这是 **加粗** 与 `code` 和 [链接](https://baoxiao.xbchen.top)。\n\n- 一项\n\n```\n<script>alert(1)</script>\n```\n\n<div>raw</div>');
assert.ok(rendered.includes('<h1><span class="handbook-text">标题</span></h1>'));
assert.ok(rendered.includes('<p><span class="handbook-text">这是 <strong>加粗</strong>'));
assert.ok(rendered.includes('<strong>加粗</strong>'));
assert.ok(rendered.includes('<code>code</code>'));
assert.ok(rendered.includes('href="https://baoxiao.xbchen.top"'));
assert.ok(rendered.includes('<ul>') && rendered.includes('<li><span class="handbook-text">一项</span></li>'));
assert.ok(rendered.includes('<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>'));
assert.ok(rendered.includes('&lt;div&gt;raw&lt;/div&gt;'));
assert.ok(!rendered.includes('<script>') && !rendered.includes('<div>raw</div>'));

const span = text => '<span class="handbook-text">' + text + '</span>';
for (let level = 1; level <= 4; level++) {
  assert.equal(hooks.renderMarkdown('#'.repeat(level) + ' 中文标题'), `<h${level}>${span('中文标题')}</h${level}>`);
}
assert.equal(hooks.renderMarkdown('第一行\r\n第二行\r\n\r\n末段'),
  `<p>${span('第一行\n第二行')}</p>\n<p>${span('末段')}</p>`);
assert.equal(hooks.renderMarkdown('- 无序一\n- **无序二**\n1. 有序一\n2. 有序二\n\n---'),
  `<ul>\n<li>${span('无序一')}</li>\n<li>${span('<strong>无序二</strong>')}</li>\n</ul>\n<ol>\n<li>${span('有序一')}</li>\n<li>${span('有序二')}</li>\n</ol>\n<hr />`);
assert.equal(hooks.renderMarkdown('```js\n# 原样\n- 不转换 **加粗**\n<&\n```'),
  '<pre><code># 原样\n- 不转换 **加粗**\n&lt;&amp;</code></pre>');
assert.equal(hooks.renderMarkdown('```\n未闭合代码'), '<pre><code>未闭合代码</code></pre>');
const links = hooks.renderMarkdown('[网页](https://example.com/a?q=1&b=2) [本页](/handbook) [相对](./index.html) [拒绝](javascript:alert)');
assert.ok(links.includes('<a href="https://example.com/a?q=1&amp;b=2" rel="noopener noreferrer">网页</a>'));
assert.ok(links.includes('<a href="/handbook"') && links.includes('<a href="./index.html"'));
assert.ok(!links.includes('href="javascript:'));
assert.equal(hooks.renderMarkdown(''), '');

const full = hooks.renderMarkdown(md);
assert.ok(!/<(?:p|li|h[1-4])>(?!<span class="handbook-text">)/.test(full), 'every text block needs an inline selection wrapper');
assert.equal((full.match(/class="handbook-text"/g) || []).length, (full.match(/<(?:p|li|h[1-4])>/g) || []).length);
assert.ok(full.includes('发起日期不早于 2026 年 11 月'), 'rendered handbook keeps its learning scope');
assert.ok(full.includes('抄送给我'), 'handbook mentions CC learning');
assert.ok(full.includes('提交人所属部门'), 'handbook mentions department selection');
console.log('Handbook: readonly entry, unchanged source rules, inline selection wrappers, headings, paragraphs, lists, code and safe links passed');
