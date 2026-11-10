/* node web/test-ui.cjs; --fixture [source-root] produces an offline Browser fixture.
 * All requests inside the fixture are intercepted, including approval submission.
 * All identities, invoices and records are synthetic. No credentials are used.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {run} = require('./ui.js');

function fixture(sourceRoot = path.join(__dirname, '..')) {
  const web=path.join(sourceRoot,'web');
  const schema={ok:true,projects:['公共办公','研发项目'],methods:[{name:'个人垫付',fields:[
    {name:'科目',type:'radioV2',required:true,options:['办公用品','交通费','其他费用']},
    {name:'名称',type:'input',required:true,options:[]},
    {name:'规格',type:'input',required:true,options:[]},
    {name:'数量',type:'number',required:true,options:[]},
    {name:'金额',type:'amount',required:true,options:[]}
  ]},{name:'预付款项',fields:[{name:'银行账户',type:'input',required:true,options:[]},{name:'收款账号',type:'input',required:true,options:[]},{name:'开户支行',type:'input',required:true,options:[]}] }]};
  const bootstrap = function(schema) {
    const demo=window.__demo={calls:[],failSave:false,failSubmit:true,failAI:false,holdOCR:false,aiConfigured:false};
    const budget={instanceId:'demo-budget',project:'公共办公',title:'公共办公预算（示例）',kind:'init',subjects:[{name:'办公用品'}],totalAmount:20000};
    const invoices=[{id:'example-a',fileName:'示例发票 A.pdf',status:'ok',amount:128,merchant:'示例商户 A',date:'2026-11-09',invoiceNo:'EXAMPLE0001',category:'purchase',attachment:{fileId:'example-original-a'},source:'fixture'},
      {id:'example-b',fileName:'示例发票 B.png',status:'ok',amount:46,merchant:'示例商户 B',date:'2026-11-08',invoiceNo:'EXAMPLE0002',category:'transit',attachment:{fileId:'example-original-b'},source:'fixture',needsReview:true}];
    const state={stage:'upload',draftId:'draft-example',invoices,answers:{costCenter:'公共办公',purchaseMethod:'个人垫付',purpose:'采购办公用品',selectedBudget:budget},selectedBudgetId:budget.instanceId,chat:[],draft:null,parseErrors:[]};
    const memory=new Map([['fill-blank-expense:delight:v1:demo-owner',JSON.stringify({state,revision:0})]]);
    Object.defineProperty(window,'localStorage',{value:{getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)}});
    const profiles=[];
    demo.state=()=>JSON.parse(memory.get('fill-blank-expense:delight:v1:demo-owner')||'null');
    window.fetch=async (url,options={})=>{
      const route=new URL(url,'https://fixture.invalid').pathname, method=options.method||'GET';
      let body={};try {body=JSON.parse(options.body||'{}');} catch (_) {}
      demo.calls.push({route,method});
      let data={ok:true},status=200;
      if(route==='/api/purchase-schema') data=schema;
      else if(route==='/api/auth/me') data={loggedIn:true,user:{openId:'demo-owner',name:'体验账号'}};
      else if(route==='/api/budgets') data={ok:true,budgets:[budget]};
      else if(route==='/api/health') data={ok:true};
      else if(route==='/api/drafts' || route==='/api/history') data={ok:true,items:[],nextOffset:null};
      else if(route.startsWith('/api/drafts/')) {
        await new Promise(r=>setTimeout(r,100));
        if(demo.failSave) {status=503;data={ok:false,error:'示例：网络暂不可用，内容已保留，请重试保存'};}
        else data={ok:true,record:{state:body.state || state,revision:(body.revision||0)+1,title:'公共办公采购（示例）'}};
      }
      else if(route==='/api/fill-history' || route==='/api/fill-suggestions') {
        await new Promise(r=>setTimeout(r,120));
        data={ok:true,suggestions:{global:{},rows:{'example-a':{'科目':[{value:'办公用品',probability:.8}]}}}};
      }
      else if(route.startsWith('/api/filling-profiles')) {
        const id=route.split('/')[3];
        if(method==='POST') {const profile={...body,id:'profile-'+(profiles.length+1),revision:1,createdBy:'体验账号',canEdit:true};profiles.push(profile);data={ok:true,profile};}
        else if(method==='DELETE') {const index=profiles.findIndex(p=>p.id===id);if(index>=0)profiles.splice(index,1);}
        else if(method==='PATCH') {const index=profiles.findIndex(p=>p.id===id);profiles[index]={...profiles[index],...body,revision:body.revision+1};data={ok:true,profile:profiles[index]};}
        else data={ok:true,items:profiles};
      }
      else if(route==='/api/ai-settings') {
        if(method==='PUT') demo.aiConfigured=!body.clear;
        data={ok:true,configured:demo.aiConfigured,settings:{hasApiKey:demo.aiConfigured,apiKeyMasked:'example-masked'},defaults:{baseUrl:'https://api.deepseek.com/v1',textModel:'deepseek-chat'}};
      }
      else if(route==='/api/ai-settings/test') {await new Promise(r=>setTimeout(r,120));status=503;data={ok:false,error:'示例：连接超时，请检查接口地址后重试'};}
      else if(route==='/api/invoice-files') {await new Promise(r=>setTimeout(r,150));if(demo.duplicateUpload){status=409;data={ok:false,duplicate:true,error:'这张发票已在【公共办公】 ¥128.00的报销中使用（进行中）'};}else data={ok:true,attachment:{fileId:'example-new-original'}};}
      else if(route==='/api/parse-invoice') {
        await new Promise(r=>{demo.resolveOCR=r;if(!demo.holdOCR)setTimeout(r,150);});
        data={amount:99,merchant:'合成测试商户',date:'2026-11-09',invoice_no:'EXAMPLE0003',category:'purchase',attachment:{fileId:'example-new-original'},source:'fixture'};
      }
      else if(route==='/api/feishu-expense') {
        await new Promise(r=>setTimeout(r,150));
        status=403;data={ok:false,error:'示例：审批权限未开通，请开通权限后重新登录。草稿已保留。',permissionUrl:'https://open.feishu.cn/'};
      }
      else {status=500;data={ok:false,error:'Fixture blocked unexpected request: '+route};}
      return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
    };
  };
  let html=fs.readFileSync(path.join(web,'index.html'),'utf8');
  html=html.replace(/<link[^>]+href="\.\/styles\.css[^>]*>/,()=>'<style>'+fs.readFileSync(path.join(web,'styles.css'),'utf8')+'</style>');
  html=html.replace(/<script src="\.\/([^?]+)\?[^>]+><\/script>/g,(_,name)=>'<script>'+fs.readFileSync(path.join(web,name),'utf8').replace(/<\/script/gi,'<\\/script')+'</script>');
  html=html.replace('<head>','<head><script>('+bootstrap.toString()+')('+JSON.stringify(schema)+');</script>');
  return html;
}

async function test() {
  function button(text,disabled=false) {return {textContent:text,disabled,attrs:{},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];}};}
  const primary=button('保存'),peer=button('测试'),locked=button('不可用',true);
  let finish,calls=0;
  const action=run(primary,()=>{calls++;return new Promise(r=>{finish=r;});},'正在保存…',[peer,locked]);
  assert.equal(primary.disabled,true);assert.equal(peer.disabled,true);assert.equal(primary.attrs['aria-busy'],'true');
  await run(primary,()=>{calls++;},'重复');assert.equal(calls,1,'duplicate clicks must not execute');
  finish('saved');assert.equal(await action,'saved');
  assert.equal(primary.textContent,'保存');assert.equal(primary.disabled,false);assert.equal(peer.disabled,false);assert.equal(locked.disabled,true);
  await assert.rejects(run(primary,async()=>{throw Error('offline');},'正在保存…'),/offline/);
  assert.equal(primary.disabled,false);assert.equal(primary.attrs['aria-busy'],undefined);
  const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(ids.length,new Set(ids).size,'unique hooks');
  const app=fs.readFileSync(path.join(__dirname,'app.js'),'utf8');
  for (const [,id] of app.matchAll(/getElementById\("([^"]+)"\)/g)) assert.ok(ids.includes(id),'missing hook '+id);
  assert.ok(fixture().includes('Fixture blocked unexpected request'));
  console.log('UI: busy feedback, duplicate prevention, error recovery, disabled-state preservation, DOM hooks, offline fixture passed');
}
if (process.argv[2]==='--fixture') process.stdout.write(fixture(process.argv[3]));
else test().catch(e=>{console.error(e);process.exitCode=1;});
