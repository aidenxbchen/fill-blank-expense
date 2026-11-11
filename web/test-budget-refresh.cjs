/* Actual app handlers, fake clock/HTTP only; never contacts Feishu. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness(){
  let now=100000;
  const elements=new Map(),events={},windowEvents={},intervals=[],requests=[];
  const el=id=>{
    if(!elements.has(id))elements.set(id,{id,hidden:false,disabled:false,textContent:'',innerHTML:'',scrollTop:0,
      events:{},classList:{toggle(){},add(){},remove(){}},setAttribute(name,value){this[name]=value;},
      addEventListener(name,fn){this.events[name]=fn;}});
    return elements.get(id);
  };
  const context={document:{readyState:'loading',visibilityState:'visible',getElementById:el,addEventListener(name,fn){events[name]=fn;}},
    window:{addEventListener(name,fn){windowEvents[name]=fn;}},location:{hostname:'fixture.invalid'},
    Date:class extends Date{static now(){return now;}},AbortController,AbortSignal,console,setTimeout:()=>1,clearTimeout(){},
    setInterval(fn,ms){intervals.push({fn,ms});return intervals.length;},
    fetch(url,options){return new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));}};
  let source=fs.readFileSync(require.resolve('./app.js'),'utf8');const end=source.lastIndexOf('})();');
  source=source.slice(0,end)+`window.h={loadBudgets,bindBudgetFreshness,refreshVisibleBudgets,
    setUser(id){authUser=id ? {openId:id}:null;},owner(){return ownerId();},budgets(){return approvedBudgets;},
    busy(){return budgetsLoading;},answers(){return session.answers;},select(){session.answers.selectedBudget={instanceId:'old-selection'};}};`+source.slice(end);
  vm.runInNewContext(source,context);
  return {h:context.window.h,context,el,events,windowEvents,intervals,requests,advance:ms=>{now+=ms;}};
}
const budget=id=>({instanceId:id,project:'合成项目',totalAmount:50000,kind:'init',subjects:[]});
const flush=()=>new Promise(r=>setImmediate(r));
const respond=(request,ids,status=200)=>request.resolve({status,ok:status===200,json:async()=>status===200
  ? {ok:true,loggedIn:true,user:{openId:'alice'},budgets:ids.map(budget)}
  : {ok:false,loggedIn:status===401 ? false:true,error:status===401 ? '登录过期':'合成：读取失败'}});
(async()=>{
  const a=harness();a.h.bindBudgetFreshness();a.h.bindBudgetFreshness();
  assert.equal(a.intervals.length,1);assert.equal(a.intervals[0].ms,25000);
  a.el('btn-refresh-budgets').events.click();await a.h.refreshVisibleBudgets();assert.equal(a.requests.length,0,'signed-out does not poll or refresh');
  assert.match(a.el('toast').textContent,/登录/);
  a.h.setUser('alice');a.h.select();const selected=JSON.stringify(a.h.answers());
  const first=a.h.loadBudgets(),same=a.h.loadBudgets();assert.equal(first,same,'in-flight requests coalesce');
  assert.equal(a.requests.length,1);assert.equal(a.el('btn-refresh-budgets').disabled,true);
  assert.match(a.el('budget-refresh-status').textContent,/正在刷新/);
  assert.equal(a.requests[0].url,'/api/budgets?refresh=1');assert.equal(a.requests[0].options.credentials,'include');assert.equal(a.requests[0].options.cache,'no-store');
  respond(a.requests[0],['old']);await first;
  assert.equal(a.el('btn-refresh-budgets').disabled,false);assert.match(a.el('budget-grid').innerHTML,/old/);
  a.el('btn-refresh-budgets').events.click();assert.equal(a.requests.length,2);
  respond(a.requests[1],['old','newly-approved']);await flush();
  assert.equal(a.h.budgets().length,2);assert.match(a.el('budget-refresh-status').textContent,/已更新/);
  assert.equal(JSON.stringify(a.h.answers()),selected,'refresh does not overwrite selected draft metadata');
  a.context.document.visibilityState='hidden';a.advance(30000);a.events.visibilitychange();a.intervals[0].fn();a.windowEvents.focus();
  assert.equal(a.requests.length,2,'hidden tab pauses all automatic reads');
  a.context.document.visibilityState='visible';a.events.visibilitychange();a.windowEvents.focus();a.windowEvents.pageshow();a.intervals[0].fn();
  assert.equal(a.requests.length,3,'visible/focus/interval burst makes one request');respond(a.requests[2],['newly-approved']);await flush();
  a.advance(1000);a.windowEvents.focus();assert.equal(a.requests.length,3,'focus burst is throttled');
  a.advance(25000);a.intervals[0].fn();assert.equal(a.requests.length,4,'visible interval refreshes');
  respond(a.requests[3],[],503);await flush();assert.equal(a.h.budgets().length,1,'failure preserves prior list');
  assert.match(a.el('budget-refresh-status').textContent,/失败.*保留/);
  a.el('btn-refresh-budgets').events.click();respond(a.requests[4],['recovered']);await flush();assert.equal(a.h.budgets()[0].instanceId,'recovered');
  const expired=a.h.loadBudgets();respond(a.requests[5],[],401);await expired;
  assert.equal(a.h.budgets().length,0);assert.match(a.el('budget-grid').innerHTML,/重新用飞书登录/);
  a.advance(50000);a.windowEvents.focus();a.intervals[0].fn();assert.equal(a.requests.length,6,'401 pauses automatic reads');
  assert.equal(a.h.owner(),'alice','budget refresh never changes auth identity or drafts');
  a.el('btn-refresh-budgets').events.click();respond(a.requests[6],['relogin-recovered']);await flush();assert.equal(a.h.budgets().length,1);
  const b=harness();b.h.setUser('alice');const old=b.h.loadBudgets();b.h.setUser('bob');const next=b.h.loadBudgets();
  assert.equal(b.requests[0].options.signal.aborted,true);
  respond(b.requests[0],['alice-only']);await old;assert.equal(b.h.budgets().length,0);assert.equal(b.h.busy(),true,'late account response cannot finish new request');
  b.requests[1].resolve({ok:true,status:200,json:async()=>({ok:true,user:{openId:'bob'},budgets:[budget('bob-only')]})});await next;
  assert.equal(b.h.budgets()[0].instanceId,'bob-only');
  const c=harness();c.h.setUser('alice');const late=c.h.loadBudgets();c.h.setUser(null);await c.h.loadBudgets();respond(c.requests[0],['late']);await late;
  assert.equal(c.h.budgets().length,0);assert.equal(c.h.busy(),false,'logout discards old response');
  const d=harness();d.h.setUser('alice');const fail=d.h.loadBudgets();d.requests[0].reject(Error('offline'));await fail;
  assert.equal(d.el('btn-refresh-budgets').disabled,false);assert.match(d.el('budget-refresh-status').textContent,/重试/);
  const html=fs.readFileSync(require.resolve('./index.html'),'utf8');
  assert.ok(html.includes('id="btn-refresh-budgets"')&&html.includes('aria-controls="budget-grid"'));
  assert.ok(html.includes('id="budget-refresh-status" role="status" aria-live="polite"'));
  console.log('Budget refresh: button/busy/retry, cache bypass, 25s visible polling, focus debounce, auth/owner guards and draft preservation passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
