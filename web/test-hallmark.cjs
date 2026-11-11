/* App restyle regression: fixture uses actual app markup/code, synthetic requests only. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process'),crypto=require('node:crypto');
const web=__dirname;
function inlineCSS(css) { return css.replace(/@import url\("\.\/([^?"]+)(?:\?[^"\n]*)?"\);/g,(_,file)=>inlineCSS(fs.readFileSync(path.join(web,file),'utf8'))); }
function fixture() {
  const html=cp.execFileSync(process.execPath,[path.join(web,'test-ui.cjs'),'--fixture'],{encoding:'utf8'});
  return html.replace(/<style>([\s\S]*?)<\/style>/,(_,css)=>'<style>'+inlineCSS(css)+'</style>');
}
if(process.argv.includes('--fixture')) {process.stdout.write(fixture());process.exit(0);}
const html=fs.readFileSync(path.join(web,'index.html'),'utf8'),css=fs.readFileSync(path.join(web,'styles.css'),'utf8'),app=fs.readFileSync(path.join(web,'app.js'),'utf8');
assert.ok(html.includes('报了呗')&&html.includes('发票放进去了，唠唠就完事了。'));
assert.ok(html.includes('id="btn-reset"')&&html.includes('>新建报销</button>'));
assert.equal((html.match(/<header\b/g)||[]).length,1);
for(const id of ['upload-triad','blessing-card','budget-picker','dropzone','upload-detail-zone','invoice-summary','bank-profiles-modal','ai-first-use-modal','ai-settings-modal'])assert.ok(html.includes(`id="${id}"`));
assert.ok(css.includes('Hallmark')&&css.includes('redesign: restyle'));
assert.ok(css.includes('grid-template-columns: repeat(3, minmax(0, 1fr))'));
assert.ok(css.includes('@media(orientation:portrait)'));
assert.ok(css.includes('.ambient,.blessing-ornament,.blessing-constellation,.save-indicator { display:none; }'));
const manifest=JSON.parse(fs.readFileSync(path.join(web,'../.hallmark/wiring-regression.json'),'utf8'));
if(process.argv.includes('--kept-source')) {
const digest=crypto.createHash('sha256').update(app.replace(/20261111hallmark1/g,'20261110qty1')).digest('hex');
assert.equal(digest,manifest.appSHA256,'app logic differs beyond cache version');
for(const [name,sha]of Object.entries(manifest.unchanged))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(web,name))).digest('hex'),sha,`${name} business code changed`);
}
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.ok(manifest.ids.every(id=>ids.includes(id)),'baseline ID missing');
assert.ok(fixture().includes('--blessing-warm:')&&!fixture().includes('@import url('),'fixture includes actual tokens/base without network');
console.log('Hallmark: exact brand/layout hooks, all baseline IDs, unchanged business sources and offline fixture imports passed');
