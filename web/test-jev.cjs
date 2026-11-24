/* Actual handlers and policy; synthetic identities and responses only. */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
function harness(){
  const elements=new Map();
  const el=id=>{if(!elements.has(id))elements.set(id,{hidden:false,value:'',textContent:'',innerHTML:'',classList:{toggle(){}}});return elements.get(id);};
  const requests=[];
  const context={document:{readyState:'loading',addEventListener(){},getElementById:el},window:{},location:{hostname:'fixture.invalid'},
    AbortSignal,setTimeout:()=>1,clearTimeout(){},console,fetch:async(url,options)=>{
      requests.push({url,options});return {ok:true,json:async()=>({ok:true,suggestions:{global:{},rows:{i:{科目:[{value:'办公费',source:'Jev'}]}},notices:[]}})};
    }};
  const source=fs.readFileSync(require.resolve('./app.js'),'utf8'),end=source.lastIndexOf('})();');
  vm.runInNewContext(source.slice(0,end)+`window.h={refreshChoiceSuggestions,choiceContext,loadJevSettings,updateJevSettings,
    setOwner(id){authUser={openId:id};},setDraft(id){session.draftId=id;},editAmount(v){session.invoices[0].amount=v;},
    answer(v){session.answers['purchase:个人垫付:i:科目']=v;},answers(){return session.answers;},
    setup(){authUser={openId:'alice'};session={draftId:'a',stage:'upload',answers:{purchaseMethod:'个人垫付',costCenter:'公共办公',purpose:'合成测试'},invoices:[{id:'i',status:'ok',amount:128,category:'meal',items:[{name:'餐饮服务',quantity:1,unit:'份'}]}]};}};`+source.slice(end),context);
  context.window.h.setup();return {context,h:context.window.h,el,requests};
}
(async()=>{
  const a=harness();await a.h.refreshChoiceSuggestions();await a.h.refreshChoiceSuggestions();
  assert.equal(a.requests.length,1,'same facts reuse suggestions');
  assert.equal(a.requests[0].options.credentials,'include');
  assert.equal(JSON.parse(a.requests[0].options.body).claim.invoices[0].items[0].name,'餐饮服务');
  a.h.answer('用户手选');await a.h.refreshChoiceSuggestions();
  assert.equal(a.requests.length,1,'answering does not re-read same invoice');
  assert.equal(a.h.answers()['purchase:个人垫付:i:科目'],'用户手选');
  a.h.editAmount(129);await a.h.refreshChoiceSuggestions();assert.equal(a.requests.length,2);
  const b=harness();let finish;
  b.context.fetch=()=>new Promise(r=>{finish=r;});
  const pending=b.h.refreshChoiceSuggestions();b.h.setOwner('bob');
  finish({ok:true,json:async()=>({ok:true,suggestions:{rows:{sensitive:'alice-only'}}})});await pending;
  assert.equal(b.context.window.__choiceSuggestions,null,'late account result discarded');
  const c=harness();c.context.fetch=()=>new Promise(r=>{finish=r;});
  const changed=c.h.refreshChoiceSuggestions();c.h.editAmount(999);
  finish({ok:true,json:async()=>({ok:true,suggestions:{rows:{outdated:true}}})});await changed;
  assert.equal(c.context.window.__choiceSuggestions,null,'late invoice revision discarded');
  const d=harness();d.context.fetch=async()=>{throw Error('network');};await d.h.refreshChoiceSuggestions();
  assert.equal(d.context.window.__choiceSuggestions,null);
  const p={__purchaseSchema:{projects:['公共办公'],methods:[{name:'个人垫付',fields:[{name:'个人垫付科目',required:true,type:'radioV2',options:['办公费','招待费']}]}]},__approvedBudgets:[{instanceId:'b'}],
    __fillSuggestions:{rows:{i:{科目:[{value:'办公费'}]}}},__choiceSuggestions:{rows:{i:{科目:[{value:'招待费',source:'Jev'},{value:'已删除选项',source:'Jev'}]}}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('./policy.js'),'utf8'),{window:p});
  const answers={purchaseMethod:'个人垫付',costCenter:'公共办公',purpose:'采购',selectedBudget:{instanceId:'b'}};
  const queue=p.ExpensePolicy.buildQuestionQueue([{id:'i',amount:128}],answers);
  assert.equal(queue.length,0,'model suggestions do not reintroduce per-row questions');
  const requested={...answers};
  answers['purchase:个人垫付:i:个人垫付科目']='办公费';
  p.ExpensePolicy.mergePrefill(answers,{answers:{'purchase:个人垫付:i:个人垫付科目':'招待费'}},requested);
  assert.equal(answers['purchase:个人垫付:i:个人垫付科目'],'办公费','manual edit wins over late prefill');
  const html=fs.readFileSync(require.resolve('./index.html'),'utf8');
  for(const id of ['jev-base-url','jev-api-key','jev-model','btn-save-jev','btn-test-jev','btn-clear-jev'])assert.ok(html.includes(`id="${id}"`));
  const e=harness();
  e.context.fetch=async(url)=>{
    if(url.endsWith('/api/jev-settings')){
      return {ok:true,json:async()=>({ok:true,configured:true,isOrgOwner:false,orgShared:true,settings:{baseUrl:'https://api.typesafe.ai',model:'jev-latest',hasApiKey:false,apiKeyMasked:''}})};
    }
    return {ok:true,json:async()=>({})};
  };
  await e.h.loadJevSettings();
  assert.ok(e.el('jev-settings-message').textContent.includes('团队已共用 Jev'));
  assert.equal(e.el('jev-settings-form').hidden,true);
  assert.equal(e.el('btn-save-jev').hidden,true);
  assert.equal(e.el('jev-api-key').disabled,true);

  const f=harness();
  f.context.fetch=async(url)=>{
    if(url.endsWith('/api/jev-settings')){
      return {ok:true,json:async()=>({ok:true,configured:true,isOrgOwner:true,orgShared:false,settings:{baseUrl:'https://api.typesafe.ai',model:'jev-latest',hasApiKey:true,apiKeyMasked:'sk-***ey'}})};
    }
    return {ok:true,json:async()=>({})};
  };
  await f.h.loadJevSettings();
  assert.equal(f.el('jev-settings-form').hidden,false);
  assert.equal(f.el('btn-save-jev').hidden,false);
  assert.equal(f.el('jev-api-key').disabled,false);
  assert.ok(f.el('jev-api-key').placeholder.includes('已保存'));

  console.log('Jev UI: per-fact reuse, changed facts, owner/revision guards, manual edits, real options, org-sharing hooks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
