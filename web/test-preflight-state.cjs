const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
function harness(){
  const requests=[],timeouts=[],attributes={};
  const button={textContent:'',disabled:false,setAttribute(k,v){attributes[k]=v;}};
  const elements={'btn-feishu-submit':button,'submit-preview':{innerHTML:''},'preview-server-status':{textContent:''}};
  const policy={issues:[],buildQuestionQueue(){return this.issues.map(text=>({text}));},rowIssues(){return [];},quantityUnit(){return {quantity:1,unit:'份'};}};
  const window={ExpensePolicy:policy,__purchaseSchema:{methods:[{name:'普通采购',fields:[]}],expenseTypes:['普通采购'],payers:['个人支付']}};
  const context={window,document:{readyState:'loading',getElementById:id=>elements[id]||null,querySelectorAll:()=>[],addEventListener(){}},location:{hostname:'fixture.invalid'},AbortController,AbortSignal:{timeout(ms){timeouts.push(ms);return AbortSignal.timeout(ms);}},console,setTimeout,clearTimeout,setInterval,fetch(url,options){return new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));}};
  let source=fs.readFileSync(require.resolve('./app.js'),'utf8');const end=source.lastIndexOf('})();');
  source=source.slice(0,end)+`window.h={renderSubmit,submitFeishu,refreshTravelMatch,buildFeishuPayload,state(){return session;},setState(value){session=Object.assign(emptySession(),value);},setUser(id){authUser={openId:id,name:'夹具'};}};`+source.slice(end);
  vm.runInNewContext(source,context);
  const h=window.h;h.setUser('alice');h.setState({stage:'submit',draftId:'fixture',answers:{expenseType:'普通采购',payer:'个人支付',purpose:'夹具',matchedBudget:{instanceId:'budget'}},draft:{expenseType:'普通采购',payer:'个人支付',purpose:'夹具'},invoices:[{id:'one',amount:10,status:'ok',merchant:'商户',invoiceNo:'INV-1',raw:'原票面',attachment:{file_id:'fixture'}}]});
  return {h,requests,timeouts,attributes,button,elements,policy};
}
function success(req){req.resolve({ok:true,json:async()=>({ok:true,attachmentCount:1})});}
(async()=>{
  const a=harness(),pending=a.h.renderSubmit();
  assert.equal(a.button.disabled,true);assert.match(a.button.textContent,/正在核验/);assert.equal(a.attributes['aria-busy'],'true');assert.equal(a.timeouts[0],60000);
  assert.equal(a.elements['preview-server-status'].textContent,'','checking is on the button');
  await a.h.renderSubmit();assert.equal(a.requests.length,1,'duplicate renders share the in-flight review');
  success(a.requests[0]);await pending;
  assert.equal(a.button.disabled,false);assert.equal(a.h.state().reviewState,'ready');assert.equal(a.attributes['aria-busy'],'false');assert.ok(a.h.state().reviewContext);
  const b=harness(),changed=b.h.renderSubmit();b.h.state().invoices[0].note='new content';success(b.requests[0]);await changed;
  assert.equal(b.h.state().reviewState,'retry');assert.match(b.button.textContent,/重新核验/);assert.equal(b.button.disabled,false);assert.equal(b.h.state().reviewContext,'','stale results cannot authorize a submit');
  await b.h.submitFeishu();assert.equal(b.requests[1].url,'/api/review','retry button only rechecks');assert.ok(!b.requests.some(r=>r.url.includes('feishu-expense')));
  success(b.requests[1]);await new Promise(resolve=>setImmediate(resolve));
  const c=harness(),timeout=c.h.renderSubmit();c.requests[0].reject(Object.assign(new Error('Fetch is aborted'),{name:'TimeoutError'}));await timeout;
  assert.match(c.button.textContent,/核验超时，点击重试/);assert.equal(c.button.disabled,false);assert.equal(c.attributes['aria-busy'],'false');
  const d=harness();d.policy.issues=['缺少必填项'];await d.h.renderSubmit();assert.equal(d.requests.length,0);assert.equal(d.button.disabled,true);assert.match(d.button.textContent,/必填项/);assert.match(d.elements['preview-server-status'].textContent,/缺少必填项/);
  const e=harness(),first=e.h.renderSubmit();e.h.state().invoices[0].note='changed';const second=e.h.renderSubmit();
  success(e.requests[1]);await second;const proven=e.h.state().reviewContext;
  e.requests[0].reject(new Error('old failure'));await first;assert.equal(e.h.state().reviewState,'ready');assert.equal(e.h.state().reviewContext,proven,'late failure cannot overwrite a newer successful review');
  const f=harness();f.h.state().answers.expenseType='差旅费';f.h.state().draft.expenseType='差旅费';f.h.state().answers.relatedApproval={instanceId:'trip'};
  const before=JSON.stringify(f.h.buildFeishuPayload().claim),matching=f.h.refreshTravelMatch();
  f.requests[0].resolve({ok:true,json:async()=>({ok:true,owner:'alice',candidates:[],groups:[{invoiceId:'one',facts:{isTicket:true,segments:[]}}],autoSelectId:null})});await matching;
  assert.equal(JSON.stringify(f.h.buildFeishuPayload().claim),before,'background travel matching cannot mutate the preview payload');
  console.log('Preflight: button states, timeout/retry, stale data, duplicate and late responses, validation and frozen preview passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
