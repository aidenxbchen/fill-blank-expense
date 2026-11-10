/* Focused tests against actual app handlers; only synthetic settings responses. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ui=require('./ui.js');
const missing={ok:true,configured:false,settings:{hasApiKey:false}};
const saved={ok:true,configured:true,settings:{hasApiKey:true,apiKeyMasked:'example-masked'}};
function harness(){
  const elements=new Map();
  const el=id=>{if(!elements.has(id))elements.set(id,{id,hidden:true,value:'',textContent:'',classList:{add(){},remove(){},toggle(){}},setAttribute(){},removeAttribute(){}});return elements.get(id);};
  const document={readyState:'loading',addEventListener(){},getElementById:el,querySelector(){return null;}};
  const requests=[];
  let response=missing;
  const context={document,window:{ExpenseUI:ui},location:{hostname:'fixture.invalid'},AbortSignal,console,
    setTimeout:()=>1,clearTimeout(){},localStorage:{getItem(){throw Error('reminder must not persist dismissal');},setItem(){throw Error('reminder must not persist dismissal');}},
    fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>response};}};
  let source=fs.readFileSync(require.resolve('./app.js'),'utf8');
  const end=source.lastIndexOf('})();');
  source=source.slice(0,end)+`window.handlers={checkAiSetup,setAiSetupStatus,saveAiSettings,openAiSettings,remindAiOnUpload,
    setUser(user){authUser=user;aiSetupOwner=null;aiSetupConfigured=null;aiSetupEpoch++;},
    configured(){return aiSetupConfigured;}};`+source.slice(end);
  vm.runInNewContext(source,context);
  const h=context.window.handlers;
  return {h,context,el,requests,setResponse:r=>{response=r;}};
}
(async()=>{
  assert.equal(ui.needsAiSetup(saved),false);
  for(const data of [missing,{},null,{...saved,configured:false},{...saved,settings:{hasApiKey:false}}]) assert.equal(ui.needsAiSetup(data),true);
  const a=harness();a.h.setUser({openId:'synthetic-a'});
  await a.h.checkAiSetup(true);assert.equal(a.el('ai-first-use-modal').hidden,false,'first authenticated check prompts');
  assert.equal(a.requests[0].options.credentials,'include');assert.equal(a.requests[0].options.cache,'no-store');
  a.el('ai-first-use-modal').hidden=true;
  assert.equal(await a.h.checkAiSetup(false),false,'upload still detects missing configuration after later');
  assert.equal(a.el('ai-first-use-modal').hidden,true,'upload check allows local OCR without reopening modal');
  a.h.remindAiOnUpload();assert.match(a.el('toast').textContent,/尚未填写/);
  a.h.openAiSettings();await new Promise(r=>setImmediate(r));
  assert.equal(a.el('ai-settings-modal').hidden,false,'primary action opens existing settings');
  a.setResponse(saved);await a.h.saveAiSettings();
  assert.equal(a.h.configured(),true);a.el('toast').textContent='';a.h.remindAiOnUpload();assert.equal(a.el('toast').textContent,'','saved key suppresses upload reminders');await a.h.checkAiSetup(true);assert.equal(a.el('ai-first-use-modal').hidden,true,'saved key stops prompts');
  a.h.setUser({openId:'synthetic-b'});a.setResponse(missing);await a.h.checkAiSetup(true);
  assert.equal(a.el('ai-first-use-modal').hidden,false,'next account does not inherit saved status');
  const fresh=harness();fresh.h.setUser({openId:'synthetic-b'});await fresh.h.checkAiSetup(true);
  assert.equal(fresh.el('ai-first-use-modal').hidden,false,'refresh repeats until configured');
  let finish;
  const b=harness();b.h.setUser({openId:'synthetic-a'});
  b.context.fetch=()=>new Promise(r=>{finish=r;});
  const pending=b.h.checkAiSetup(true);
  b.h.setAiSetupStatus(saved,'synthetic-a',true);
  finish({ok:true,json:async()=>missing});await pending;
  assert.equal(b.h.configured(),true);assert.equal(b.el('ai-first-use-modal').hidden,true,'late read cannot re-prompt after save');
  const late=b.h.checkAiSetup(true);b.h.setUser({openId:'synthetic-b'});
  finish({ok:true,json:async()=>saved});await late;
  assert.equal(b.h.configured(),null,'late account response ignored');
  const c=harness();c.h.setUser({openId:'synthetic-c'});c.context.fetch=async()=>{throw Error('offline');};
  assert.equal(await c.h.checkAiSetup(true),null);assert.equal(c.el('ai-first-use-modal').hidden,true);
  assert.match(c.el('toast').textContent,/重试/);
  console.log('AI reminder: missing/configured flags, owner isolation, refresh, later/upload, settings save, stale reads and network failure passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
