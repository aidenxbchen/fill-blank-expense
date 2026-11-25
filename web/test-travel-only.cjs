/* Actual handlers and rendering, synthetic HTTP only. Never opens a production page. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness(){
  const requests=[],timers=[];
  const window={};
  const context={window,document:{readyState:'loading',getElementById:()=>null,querySelectorAll:()=>[],addEventListener(){}},
    location:{hostname:'fixture.invalid'},AbortController,AbortSignal,console,setTimeout(fn){timers.push(fn);return timers.length;},clearTimeout(){},setInterval(){},
    fetch(url,options){return new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));}};
  let source=fs.readFileSync(require.resolve('./app.js'),'utf8');const end=source.lastIndexOf('})();');
  source=source.slice(0,end)+`window.h={refreshTravelMatch,applyAnswerSideEffects,applyParsedInvoice,buildFeishuPayload,previewMarkup,travelMarkup,selectBudget,snapshot,
    setUser(id){authUser=id ? {openId:id,name:'合成旅客'} : null;},setState(value){session=Object.assign(emptySession(),value);},state(){return session;},
    reset(){resetBudgets();}};`+source.slice(end);
  vm.runInNewContext(source,context);
  return {h:window.h,window,requests,timers,context};
}
const respond=(r,data,status=200)=>r.resolve({ok:status===200,status,json:async()=>data});
const trip=id=>({instanceId:id,kind:'travel',title:'出差申请 · 11-22 深圳',trip:{start:'2026-11-22',end:'2026-11-22',destinations:['深圳']}});
const initial={stage:'upload',draftId:'draft-a',invoices:[{id:'one',amount:10,status:'ok',travel:{isTicket:true,passenger:'合成旅客',segments:[{date:'2026-11-22',origin:'广州南',destination:'深圳北'}]}}],answers:{purpose:'业务交流',costCenter:'软件组'},draft:{purchaseMethod:'差旅费',purpose:'业务交流',costCenter:'软件组'}};
(async()=>{
  const a=harness();a.h.setUser('alice');a.h.setState(initial);
  a.h.applyAnswerSideEffects('purchaseMethod','差旅费');assert.ok(a.timers.length,'manual travel selection queues matching even without a ticket');
  const request=a.h.refreshTravelMatch();assert.equal(a.requests[0].url,'/api/travel-match');
  const posted=JSON.parse(a.requests[0].options.body).claim;assert.equal(posted.invoices[0].travel.segments[0].date,'2026-11-22');
  respond(a.requests[0],{ok:true,owner:'alice',candidates:[trip('real')],groups:[],autoSelectId:'real',message:'唯一匹配'});await request;
  assert.equal(a.h.state().answers.selectedBudget.instanceId,'real');assert.equal(a.h.state().answers.costCenter,'软件组','trip reason cannot replace project');
  a.h.selectBudget('real');assert.equal(a.h.state().answers.selectedBudget.selectionSource,'manual');
  const again=a.h.refreshTravelMatch(true);respond(a.requests[1],{ok:true,owner:'alice',candidates:[trip('other')],groups:[],autoSelectId:'other'});await again;
  assert.equal(a.h.state().answers.selectedBudget.instanceId,'real','manual selection is never silently overwritten');
  const b=harness();b.h.setUser('alice');b.h.setState({...initial,answers:{purchaseMethod:'差旅费'}});
  const late=b.h.refreshTravelMatch();b.h.setUser('bob');b.h.setState({...initial,answers:{purchaseMethod:'差旅费'}});
  respond(b.requests[0],{ok:true,candidates:[trip('alice-only')],groups:[],autoSelectId:'alice-only'});await late;
  assert.equal(b.h.state().answers.selectedBudget,undefined,'late match cannot cross accounts');
  const c=harness();c.h.setUser('alice');c.h.setState({...initial,answers:{purchaseMethod:'差旅费'}});
  const claim=c.h.buildFeishuPayload().claim;
  assert.equal(claim.departmentId,undefined);assert.equal(claim.invoices[0].travel.segments[0].date,'2026-11-22');
  c.window.__purchaseSchema={methods:[]};c.window.ExpensePolicy={quantityUnit:()=>({quantity:1,unit:'份'})};
  assert.doesNotMatch(c.h.previewMarkup(claim,[]),/所属部门/);assert.match(c.h.travelMarkup('one'),/实际行程/);
  const e=harness();e.h.setUser('alice');e.h.setState({invoices:[{id:'ocr',status:'parsing'}],answers:{}});
  e.h.applyParsedInvoice(e.h.state().invoices[0],{amount:10,travel:{isTicket:true,passenger:'合成旅客',segments:[]}});
  assert.equal(e.h.state().answers.purchaseMethod,'差旅费','recognized rail/air ticket prefills travel method');
  e.h.state().answers.purchaseMethod='个人垫付';e.h.applyParsedInvoice(e.h.state().invoices[0],{amount:10,travel:{isTicket:true}});
  assert.equal(e.h.state().answers.purchaseMethod,'个人垫付','existing method can be overridden only by user');
  console.log('COD-8 frontend: ticket default, manual trigger, real candidate, manual preservation, owner isolation, travel payload/preview and unchanged department behavior passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
