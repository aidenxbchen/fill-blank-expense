/* Read-only handbook entry and renderer checks. No network, no credentials. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const web = __dirname;
const root = path.join(web, '..');
const index = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const handbookPage = fs.readFileSync(path.join(web, 'handbook.html'), 'utf8');
const handbookJs = fs.readFileSync(path.join(web, 'handbook.js'), 'utf8');
const css = fs.readFileSync(path.join(web, 'styles.css'), 'utf8');
const md = fs.readFileSync(path.join(root, '报了呗.md'), 'utf8');

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
assert.ok(handbookPage.includes('styles.css?v=20261123handbook1'));
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
assert.ok(rendered.includes('<h1>标题</h1>'));
assert.ok(rendered.includes('<strong>加粗</strong>'));
assert.ok(rendered.includes('<code>code</code>'));
assert.ok(rendered.includes('href="https://baoxiao.xbchen.top"'));
assert.ok(rendered.includes('<ul>') && rendered.includes('<li>一项</li>'));
assert.ok(rendered.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
assert.ok(rendered.includes('&lt;div&gt;raw&lt;/div&gt;'));
assert.ok(!rendered.includes('<script>') && !rendered.includes('<div>raw</div>'));
console.log('Handbook: entry, readonly page, secret-free markdown and escaped renderer passed');
