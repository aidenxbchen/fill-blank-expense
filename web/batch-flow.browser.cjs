/* Actual browser/UI, intercepted local assets and synthetic API fixtures only.
 * NODE_PATH=<installed Playwright node_modules> node web/batch-flow.browser.cjs
 * Every request is intercepted. No approval service or real account is contacted.
 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..');
const form=JSON.parse(fs.readFileSync(path.join(root,'ocr/purchase_definition.json'),'utf8')).form;
const schema={ok:true,projects:form.find(w=>w.name==='项目').option.map(o=>o.text),methods:form.find(w=>w.name==='采购方式').option.map(o=>({name:o.text,fields:form.find(w=>w.type==='fieldList'&&JSON.stringify(w.display_condition).includes(o.value)).children.map(w=>({name:w.name,type:w.type,required:w.required,options:Array.isArray(w.option)?w.option.map(o=>o.text):[]}))}))};
async function run(browser,width){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
  const page=await context.newPage(),errors=[],requests=[];let revision=0,parsed=0,stored=0,submitted;
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),p=url.pathname;
    if(url.hostname!=='fixture.invalid')throw Error('Unexpected network: '+url.hostname);
    const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(p.startsWith('/api/')){
      requests.push(p);
      if(p==='/api/purchase-schema')return json(schema);
      if(p==='/api/auth/me')return json({loggedIn:true,user:{openId:'fixture-alice',name:'本地夹具'}});
      if(p==='/api/ai-settings')return json({ok:true,configured:true,settings:{hasApiKey:true,baseUrl:'https://fixture.invalid/v1',textModel:'fixture'}});
      if(p==='/api/budgets')return json({ok:true,budgets:[{instanceId:'11111111-1111-4111-8111-111111111111',title:'合成研发预算',project:'公共办公',subjects:[]}]});
      if(p==='/api/drafts')return json({ok:true,items:[]});
      if(p.startsWith('/api/drafts/'))return json({ok:true,record:{id:p.split('/').pop(),revision:++revision,title:'合成批量采购'}});
      if(['/api/fill-history','/api/fill-suggestions','/api/choice-suggestions'].includes(p))return json({ok:true,suggestions:{global:{},rows:{}}});
      if(p==='/api/health')return json({ok:true});
      if(p==='/api/invoice-files')return json({ok:true,attachment:{file_id:String(++stored).padStart(32,'0'),name:'fixture-'+stored+'.pdf',mime:'application/pdf',size:200}});
      if(p==='/api/parse-invoice'){
        const body=req.postDataJSON(),n=parsed++,kind=['transit','meal','lodging'][n%3];
        return json({ok:true,amount:100+n,merchant:{transit:'合成交通服务',meal:'合成餐饮服务',lodging:'合成客房服务'}[kind],date:'2026-11-20',category:kind,confidence:.95,source:'offline-fixture',attachment:body.attachment,items:[]});
      }
      if(p==='/api/prefill'){
        const c=req.postDataJSON().claim,answers={...c.answers},evidence={};
        for(const inv of c.invoices)for(const [field,value] of [['差旅科目','差旅费'],['费用类型',{transit:'交通费',meal:'餐费补贴',lodging:'住宿费'}[inv.category]]]){
          const key=`purchase:差旅费:${inv.id}:${field}`;
          if(!(key in answers))answers[key]=value;
          evidence[key]={suggested:value,hard:true,source:'工作手册 · 已确认执行规则'};
        }
        return json({ok:true,answers,evidence,rulesVersion:3});
      }
      if(p==='/api/review')return json({ok:true,attachmentCount:25});
      if(p==='/api/feishu-expense'){
        submitted=req.postDataJSON();
        return json({ok:true,instanceCode:'fixture-created',requestId:'fixture-only',initiator:'本地夹具',approvalUrl:'https://fixture.invalid/approval',attachmentCount:25,attachmentsConfirmed:true});
      }
      throw Error('Unhandled fixture route '+p);
    }
    const relative=p==='/'?'index.html':p.slice(1),file=path.join(__dirname,relative);
    if(!file.startsWith(__dirname+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:'fixture missing'});
    const ext=path.extname(file),types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.webp':'image/webp'};
    return route.fulfill({contentType:types[ext]||'application/octet-stream',body:fs.readFileSync(file)});
  });
  await page.goto('http://fixture.invalid/?v=20261124batch1');
  await page.waitForLoadState('networkidle');
  await page.locator('#file-input').setInputFiles(Array.from({length:25},(_,i)=>({name:'fixture-'+i+'.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF offline invoice '+i)})));
  await page.waitForFunction(()=>{const b=document.querySelector('#btn-start-interview');return !b.disabled&&document.querySelectorAll('#invoice-summary-body tr').length===25;});
  assert.equal(stored,25);assert.equal(parsed,25);
  await page.locator('#btn-start-interview').click();
  await page.locator('#chat-input').fill('本次上海出差的交通住宿和伙食');
  await page.locator('#btn-send-answer').click();
  await page.getByRole('button',{name:'差旅费',exact:true}).click();
  await page.getByRole('button',{name:'公共办公',exact:true}).click();
  await page.locator('#chip-row [data-chip]').first().click();
  await page.locator('#stage-draft').waitFor({state:'visible'});
  assert.equal(await page.locator('#detail-sheets [data-answer]').count(),50);
  assert.equal(await page.locator('#chat-log .chat-user').count(),4,'only four claim-wide answers for 25 invoices');
  assert.equal(await page.locator('#detail-sheets details').count(),0,'selection fields are directly visible');
  assert.equal(await page.locator('header').count(),1);
  await page.screenshot({path:`/tmp/baoxiao-batch-${width}-list.png`,fullPage:true});
  const firstSubject=page.locator('#detail-sheets select[data-answer]').first();
  await firstSubject.selectOption('业务招待费');
  await page.locator('#btn-goto-submit').click();
  await page.locator('#stage-submit').waitFor({state:'visible'});
  assert.equal(await page.locator('.preview-invoice').count(),25);
  await page.waitForFunction(()=>document.querySelector('#submit-preview').textContent.includes('与手册规则冲突'));
  assert.equal(await page.locator('#btn-feishu-submit').isDisabled(),true,'manual conflict is preserved and blocks submission');
  assert.ok((await page.locator('#submit-preview').textContent()).includes('产品 / 流程强制'));
  assert.ok(!requests.includes('/api/feishu-expense'),'preview never initiates approval');
  await page.locator('#btn-back-draft').click();
  await page.locator('#detail-sheets select[data-answer]').first().selectOption('差旅费');
  await page.locator('#btn-goto-submit').click();
  await page.waitForFunction(()=>!document.querySelector('#btn-feishu-submit').disabled);
  await page.screenshot({path:`/tmp/baoxiao-batch-${width}-preview.png`,fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  assert.equal(overflow,false,'page must fit viewport');
  await page.locator('#btn-feishu-submit').click();
  await page.locator('#result-title').filter({hasText:'采购申请已发起'}).waitFor();
  assert.equal(submitted.claim.invoices.length,25);
  assert.equal(requests.filter(x=>x==='/api/feishu-expense').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log(`Batch browser ${width}px: 25 uploads, four answers, 50 prefilled selections, full preview, conflict correction, one fixture submit passed`);
  await context.close();
}
(async()=>{
  const executablePath=process.env.BAOXIAO_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser=await chromium.launch({headless:true,executablePath});
  try{await run(browser,1440);await run(browser,390);}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
