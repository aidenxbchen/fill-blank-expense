/* Actual handlers and rendering, synthetic HTTP only. Never opens a production page. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness(){
  const requests=[],timers=[];
  const window={};
  const elements={"relation-status":{innerHTML:""},"relation-choice":{innerHTML:"",disabled:false}};
  const context={window,document:{readyState:'loading',getElementById:id=>elements[id] || null,querySelectorAll:()=>[],addEventListener(){}},
    location:{hostname:'fixture.invalid'},AbortController,AbortSignal,console,setTimeout(fn){timers.push(fn);return timers.length;},clearTimeout(){},setInterval(){},
    fetch(url,options){return new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));}};
  let source=fs.readFileSync(require.resolve('./app.js'),'utf8');const end=source.lastIndexOf('})();');
  source=source.slice(0,end)+`window.h={refreshTravelMatch,applyAnswerSideEffects,applyParsedInvoice,buildFeishuPayload,previewMarkup,travelMarkup,selectBudget,snapshot,
    setUser(id){authUser=id ? {openId:id,name:'合成旅客'} : null;},setState(value){session=Object.assign(emptySession(),value);},state(){return session;},
    reset(){resetBudgets();}};`+source.slice(end);
  vm.runInNewContext(source,context);
  return {h:window.h,window,requests,timers,context,elements};
}
const respond=(r,data,status=200)=>r.resolve({ok:status===200,status,json:async()=>data});
const trip=id=>({instanceId:id,kind:'travel',title:'出差申请 · 11-22 深圳',trip:{start:'2026-11-22',end:'2026-11-22',destinations:['深圳']}});
const initial={stage:'upload',draftId:'draft-a',invoices:[{id:'one',amount:10,status:'ok',travel:{isTicket:true,passenger:'合成旅客',segments:[{date:'2026-11-22',origin:'广州南',destination:'深圳北'}]}}],answers:{purpose:'业务交流',costCenter:'软件组'},draft:{purchaseMethod:'差旅费',purpose:'业务交流',costCenter:'软件组'}};
(async()=>{
  const a=harness();a.h.setUser('alice');a.h.setState(initial);
  a.h.applyAnswerSideEffects('purchaseMethod','差旅费');assert.equal(a.timers.length,0,'questions must not trigger approval matching before the budget step');
  const request=a.h.refreshTravelMatch(true,'match');assert.equal(a.requests[0].url,'/api/travel-match');
  const posted=JSON.parse(a.requests[0].options.body).claim;assert.equal(posted.invoices[0].travel.segments[0].date,'2026-11-22');
  respond(a.requests[0],{ok:true,owner:'alice',candidates:[trip('real')],groups:[{invoiceId:'one',facts:{isTicket:true,passenger:'重新解析旅客',segments:[{date:'2026-11-22',origin:'广州南',destination:'深圳北'}]}}],autoSelectId:'real',message:'唯一匹配'});await request;
  assert.equal(a.h.state().answers.selectedBudget.instanceId,'real');assert.equal(a.h.state().answers.costCenter,'软件组','trip reason cannot replace project');
  assert.equal(a.h.state().invoices[0].travel.passenger,'重新解析旅客','updated generated facts are displayed');
  a.h.state().invoices[0]._travelEdited=true;
  a.h.state().invoices[0].travel.passenger='手动修正旅客';
  a.h.selectBudget('real');assert.equal(a.h.state().answers.selectedBudget.selectionSource,'manual');
  const again=a.h.refreshTravelMatch(true,'match');respond(a.requests[1],{ok:true,owner:'alice',candidates:[trip('other')],groups:[{invoiceId:'one',facts:{passenger:'不应覆盖'}}],autoSelectId:'other'});await again;
  assert.equal(a.h.state().answers.selectedBudget.instanceId,'real','manual selection is never silently overwritten');
  assert.equal(a.h.state().invoices[0].travel.passenger,'手动修正旅客','manual travel facts cannot be overwritten');
  const b=harness();b.h.setUser('alice');b.h.setState({...initial,answers:{purchaseMethod:'差旅费'}});
  const late=b.h.refreshTravelMatch();b.h.setUser('bob');b.h.setState({...initial,answers:{purchaseMethod:'差旅费'}});
  respond(b.requests[0],{ok:true,candidates:[trip('alice-only')],groups:[],autoSelectId:'alice-only'});await late;
  assert.equal(b.h.state().answers.selectedBudget,undefined,'late match cannot cross accounts');
  const c=harness();c.h.setUser('alice');c.h.setState({...initial,answers:{purchaseMethod:'差旅费'}});
  const claim=c.h.buildFeishuPayload().claim;
  assert.equal(claim.departmentId,undefined);assert.equal(claim.invoices[0].travel.segments[0].date,'2026-11-22');
  c.window.__purchaseSchema={methods:[]};c.window.ExpensePolicy={quantityUnit:()=>({quantity:1,unit:'份'})};
  assert.doesNotMatch(c.h.previewMarkup(claim,[]),/所属部门/);assert.equal(c.h.travelMarkup('one'),'','no itinerary input is shown');
  const e=harness();e.h.setUser('alice');e.h.setState({invoices:[{id:'ocr',status:'parsing'}],answers:{}});
  e.h.applyParsedInvoice(e.h.state().invoices[0],{amount:10,travel:{isTicket:true,passenger:'合成旅客',segments:[]}});
  assert.equal(e.h.state().answers.purchaseMethod,'差旅费','recognized rail/air ticket prefills travel method');
  e.h.state().answers.purchaseMethod='个人垫付';e.h.applyParsedInvoice(e.h.state().invoices[0],{amount:10,travel:{isTicket:true}});
  assert.equal(e.h.state().answers.purchaseMethod,'个人垫付','existing method can be overridden only by user');
  const f=harness();f.h.setUser('alice');f.h.setState({...JSON.parse(JSON.stringify(initial)),stage:'relation',answers:{purpose:'同一用途',purchaseMethod:'差旅费',costCenter:'软件组'}});
  const timeouts=[];f.context.AbortSignal={timeout(ms){timeouts.push(ms);return AbortSignal.timeout(ms);}};
  const first=f.h.refreshTravelMatch();
  assert.equal(timeouts[0],60000,'approval reads use their own timeout budget');
  assert.equal(f.elements['relation-choice'].disabled,true,'pending first load is explicit');
  assert.match(f.elements['relation-status'].innerHTML,/正在读取/);
  assert.equal(JSON.parse(f.requests[0].options.body).mode,'candidates','candidate selection must not await AI');
  await f.h.refreshTravelMatch(true);
  assert.equal(f.requests.length,1,'repeated entry does not duplicate in-flight work');
  f.h.state().answers['purchase:差旅费:shared:银行']='其他银行';
  respond(f.requests[0],{ok:true,owner:'alice',candidates:[{...trip('visible'),recommendation:{evidence:['11月23日深圳餐饮，邻近22日出差'],warnings:[]}}],recommendedId:'visible',groups:[],autoSelectId:'visible',message:'已读取'});
  await first;
  assert.match(f.elements['relation-choice'].innerHTML,/visible/,'unrelated edits cannot discard loaded options');
  assert.match(f.elements['relation-choice'].innerHTML,/【推荐】/);
  assert.match(f.elements['relation-status'].innerHTML,/邻近22日出差/);
  assert.equal(f.elements['relation-choice'].disabled,false);
  assert.equal(f.h.state().answers.relatedApproval,undefined,'candidate loading never auto-confirms a trip');
  const retry=f.h.refreshTravelMatch(true);
  assert.equal(f.elements['relation-choice'].disabled,false,'loaded options remain selectable during refresh');
  f.requests[1].reject(Object.assign(new Error('Fetch is aborted'),{name:'AbortError'}));
  await retry;
  assert.match(f.elements['relation-choice'].innerHTML,/visible/,'timeout retains known options');
  assert.match(f.elements['relation-status'].innerHTML,/超时/);
  assert.doesNotMatch(f.elements['relation-status'].innerHTML,/Fetch is aborted/);
  console.log('COD-8 frontend: ticket default, manual trigger, real candidate, manual preservation, owner isolation, travel payload/preview and unchanged department behavior passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
