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
  const page=await context.newPage(),errors=[],requests=[];let created=false;let revision=0,parsed=0,stored=0,submitted,releaseReview,reviewStarted,releaseCreate,createStarted;
  const createPending=new Promise(resolve=>{createStarted=resolve;});
  const reviewPending=new Promise(resolve=>{reviewStarted=resolve;});
  page.on('pageerror',e=>{errors.push(e.message);console.error('Browser error:',e.message);});
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),p=url.pathname;
    if(url.hostname!=='fixture.invalid')throw Error('Unexpected network: '+url.hostname);
    const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(p.startsWith('/api/')){
      requests.push(p);
      if(p==='/api/purchase-schema')return json(schema);
      if(p==='/api/auth/me')return json({loggedIn:true,user:{openId:'fixture-alice',name:'本地夹具'}});
      if(p==='/api/ai-settings')return json({ok:true,configured:true,settings:{hasApiKey:true,baseUrl:'https://fixture.invalid/v1',textModel:'fixture'}});
      if(p==='/api/jev-settings')return json({ok:true,configured:false,settings:{}});
      if(p==='/api/budgets')return json({ok:true,budgets:[{instanceId:'11111111-1111-4111-8111-111111111111',title:'合成研发预算',project:'公共办公',subjects:[]}]});
      if(p==='/api/automatic-tasks/internet')return json({ok:true,enabled:false,config:{},runs:[]});
      if(p.startsWith('/api/submission-status/'))return json(created && submitted?.draftId===p.split('/').pop() ? {ok:true,submitted:true,receipt:{ok:true,instanceCode:'fixture-created',requestId:'fixture-only',initiator:'本地夹具',approvalUrl:'https://fixture.invalid/approval',attachmentCount:25},claim:submitted.claim} : {ok:true,submitted:false});
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
      if(p==='/api/travel-match')return json({ok:true,owner:'fixture-alice',candidates:[{instanceId:'22222222-2222-4222-8222-222222222222',kind:'travel',title:'合成出差审批',trip:{},recommendation:{evidence:['深圳餐饮开票日期邻近22日出差'],warnings:[]}}],recommendedId:'22222222-2222-4222-8222-222222222222',groups:[],autoSelectId:null,notice:'',message:'请选择出差申请'});
      if(p==='/api/review'){reviewStarted();await new Promise(resolve=>{releaseReview=resolve;});return json({ok:true,attachmentCount:25});}
      if(p==='/api/feishu-expense'){
        submitted=req.postDataJSON();createStarted();await new Promise(resolve=>{releaseCreate=resolve;});created=true;
        return json({ok:true,instanceCode:'fixture-created',requestId:'fixture-only',initiator:'本地夹具',approvalUrl:'https://fixture.invalid/approval',attachmentCount:25,attachmentsConfirmed:true});
      }
      throw Error('Unhandled fixture route '+p);
    }
    const relative=p==='/'?'index.html':p.slice(1),file=path.join(__dirname,relative);
    if(!file.startsWith(__dirname+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:'fixture missing'});
    const ext=path.extname(file),types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.webp':'image/webp'};
    return route.fulfill({contentType:types[ext]||'application/octet-stream',body:fs.readFileSync(file)});
  });
  await page.goto('http://fixture.invalid/?v=20261124t108ulist1');
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('main, [role=main]').count(),1,'one main landmark');
  assert.equal(await page.locator('#astryx-root').count(),0,'historical blue workspace is active');
  assert.equal(await page.locator('script[src*="astryx/workspace"]').count(),0,'neutral shell must not replace the blue workspace');
  assert.equal(await page.locator('header').count(),1,'single top bar');
  assert.equal(await page.locator('#btn-reset').isVisible(),true,'independent new-expense entry');
  assert.deepEqual(await page.locator('.stage-name').allTextContents(),['上传发票','问问题','匹配预算','匹配关联审批','预览','提交']);
  assert.equal(await page.locator('#budget-picker').isVisible(),false,'budget choice comes after questions');
  await page.screenshot({path:`/tmp/baoxiao-six-${width}-home.png`,fullPage:true});
  await page.locator('#btn-periodic-tasks').waitFor({state:'visible'});
  assert.equal(await page.locator('#btn-start-interview').isDisabled(),true,'cannot proceed before upload');
  const ids=await page.locator('[id]').evaluateAll(nodes=>nodes.map(n=>n.id));
  assert.equal(new Set(ids).size,ids.length,'desktop and mobile shell must not duplicate command IDs');
  await page.getByRole('button',{name:'我的报销',exact:true}).last().click();
  await page.locator('#records-modal').waitFor({state:'visible'});
  assert.equal(await page.locator('#main-content').evaluate(el=>el.inert),true,'dialog makes the workspace inert');
  assert.equal(await page.locator('body > header').evaluate(el=>el.inert),true,'dialog makes the top bar inert');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#records-modal').isHidden(),true);
  assert.equal(await page.locator('#main-content').evaluate(el=>el.inert),false);
  if(width<768) {
    await page.getByRole('button',{name:'AI 设置',exact:true}).click();
    await page.locator('#ai-settings-modal').waitFor({state:'visible'});
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#ai-settings-modal').isHidden(),true);
    assert.equal(await page.locator('#main-content').evaluate(el=>el.inert),false);
  }
  await page.locator('#file-input').setInputFiles(Array.from({length:25},(_,i)=>({name:'fixture-'+i+'.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF offline invoice '+i)})));
  await page.waitForFunction(()=>{const b=document.querySelector('#btn-start-interview');return !b.disabled&&document.querySelectorAll('#invoice-summary-body tr').length===25;});
  assert.equal(stored,25);assert.equal(parsed,25);
  await page.locator('#btn-start-interview').click();
  await page.locator('#chat-input').fill('本次上海出差的交通住宿和伙食');
  await page.locator('#btn-send-answer').click();
  await page.getByRole('button',{name:'差旅费',exact:true}).click();
  await page.getByRole('button',{name:'公共办公',exact:true}).click();
  await page.locator('#stage-budget').waitFor({state:'visible'});
  if(width===390){
    await page.locator('#budget-none').check();
    await page.locator('#no-budget-reason').fill('临时采购尚无对应预算');
  } else await page.locator('[data-budget-id]').first().click();
  await page.screenshot({path:`/tmp/baoxiao-six-${width}-budget.png`,fullPage:true});
  await page.locator('#btn-budget-next').click();
  await page.locator('#stage-relation').waitFor({state:'visible'});
  await page.locator('#btn-relation-next').click();
  assert.equal(await page.locator('#stage-relation').isVisible(),true,'travel cannot continue without a trip approval');
  await page.waitForFunction(()=>document.querySelector('#relation-status').textContent.includes('深圳餐饮开票日期'));
  assert.match(await page.locator('#relation-choice').textContent(),/【推荐】/);
  await page.locator('#relation-choice').selectOption('22222222-2222-4222-8222-222222222222');
  await page.screenshot({path:`/tmp/baoxiao-six-${width}-relation.png`,fullPage:true});
  await page.locator('#btn-relation-next').click();
  await page.locator('#stage-draft').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-travel-field]').count(),0,'itinerary input is removed');
  await page.waitForFunction(()=>document.querySelector('.stage-item.is-active')?.textContent.includes('预览'));
  assert.equal(await page.locator('#detail-sheets [data-answer]').count(),50);
  assert.equal(await page.locator('#chat-log .chat-user').count(),3,'budget and relation are not questions');
  assert.equal(await page.locator('#detail-sheets details').count(),0,'selection fields are directly visible');
  assert.equal(await page.locator('header').count(),1);
  await page.screenshot({path:`/tmp/baoxiao-batch-${width}-list.png`,fullPage:true});
  const firstSubject=page.locator('#detail-sheets select[data-answer]').first();
  await firstSubject.selectOption('业务招待费');
  await page.locator('#btn-goto-submit').click();
  await page.locator('#stage-submit').waitFor({state:'visible'});
  assert.equal(await page.locator('.preview-invoice').count(),25);
  assert.match(await page.locator('#submit-preview').textContent(),/已关联出差申请/);
  assert.equal(await page.locator('#submit-preview [data-refresh-travel]').count(),0);
  assert.equal(await page.locator('#submit-preview [data-rank-travel]').count(),0);
  await page.waitForFunction(()=>document.querySelector('#submit-preview').textContent.includes('与手册规则冲突'));
  assert.equal(await page.locator('#btn-feishu-submit').isDisabled(),true,'manual conflict is preserved and blocks submission');
  assert.ok((await page.locator('#submit-preview').textContent()).includes('产品 / 流程强制'));
  assert.ok(!requests.includes('/api/feishu-expense'),'preview never initiates approval');
  await page.locator('#btn-back-draft').click();
  await page.locator('#detail-sheets select[data-answer]').first().selectOption('差旅费');
  await page.locator('#btn-goto-submit').click();
  await reviewPending;
  assert.match(await page.locator('#btn-feishu-submit').textContent(),/正在核验/);
  assert.equal(await page.locator('#btn-feishu-submit').getAttribute('aria-busy'),'true');
  assert.equal(await page.locator('#preview-server-status').textContent(),'','loading text belongs on the submit button');
  assert.equal(await page.locator('#submit-preview #preview-server-status').count(),0,'result detail sits by the button');
  await page.locator('.submit-actions').screenshot({path:`/tmp/baoxiao-review-button-${width}.png`});
  releaseReview();
  await page.waitForFunction(()=>!document.querySelector('#btn-feishu-submit').disabled);
  await page.screenshot({path:`/tmp/baoxiao-batch-${width}-preview.png`,fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  assert.equal(overflow,false,'page must fit viewport');
  await page.evaluate(()=>{
    document.querySelector('#btn-feishu-submit').addEventListener('click',()=>{
      const start=performance.now();
      const observer=new MutationObserver(()=>{if(!document.querySelector('#stage-confirmation').hidden){window.submitFeedbackMs=performance.now()-start;observer.disconnect();}});
      observer.observe(document.querySelector('main'),{subtree:true,attributes:true,childList:true});
    },{capture:true,once:true});
  });
  await page.locator('#btn-feishu-submit').click();
  await createPending;
  assert.match(await page.locator('#confirmation-title').textContent(),/正在提交/);
  assert.equal(await page.locator('#btn-confirmation-home').isVisible(),false,'never announce success before Feishu receipt');
  const feedback=await page.evaluate(()=>window.submitFeedbackMs);
  assert.ok(feedback<=200,`submission feedback must be within 0.2s, got ${feedback}ms`);
  await page.screenshot({path:`/tmp/baoxiao-submit-${width}-pending.png`,fullPage:true});
  if(width===390){
    created=true; // Durable success may arrive while the original POST is still blocked.
    await page.locator('#confirmation-title').filter({hasText:'报销已提交成功'}).waitFor();
  }
  releaseCreate();
  await page.locator('#confirmation-title').filter({hasText:'报销已提交成功'}).waitFor();
  assert.equal(await page.locator('#stage-submit').isVisible(),false,'completed claims never stay in submission UI');
  assert.equal(await page.locator('#confirmation-details').textContent().then(t=>t.includes('fixture-created')),true);
  await page.screenshot({path:`/tmp/baoxiao-submit-${width}-success.png`,fullPage:true});
  await page.evaluate(()=>{
    const key=Object.keys(localStorage).find(k=>k.endsWith(':fixture-alice') && k.startsWith('fill-blank-expense:'));
    const raw=JSON.parse(localStorage.getItem(key));raw.submitted=false;raw.state.lastFeishu=null;raw.state.submissionPending=false;
    localStorage.setItem(key,JSON.stringify(raw));
  });
  await page.reload();await page.waitForLoadState('networkidle');
  await page.locator('#confirmation-title').filter({hasText:'报销已提交成功'}).waitFor();
  assert.equal(requests.filter(x=>x==='/api/feishu-expense').length,1,'stale local submit state recovers receipt without another creation');
  await page.locator('#btn-confirmation-home').click();
  assert.equal(await page.locator('#stage-upload').isVisible(),true);
  assert.equal(await page.locator('#stage-confirmation').isVisible(),false);
  await page.reload();await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#stage-upload').isVisible(),true,'returning home remains home after reload');
  assert.equal(submitted.claim.invoices.length,25);
  assert.equal(submitted.claim.relatedApproval.instanceId,'22222222-2222-4222-8222-222222222222');
  if(width===390){assert.equal(submitted.claim.matchedBudget,null);assert.equal(submitted.claim.noBudgetReason,'临时采购尚无对应预算');}else assert.equal(submitted.claim.matchedBudget.instanceId,'11111111-1111-4111-8111-111111111111');
  assert.equal(requests.filter(x=>x==='/api/feishu-expense').length,1);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log(`Batch browser ${width}px: six stages, 25 uploads, three answers, independent budget and trip, 50 prefilled selections, full preview, conflict correction, one fixture submit and confirmation passed; feedback=${feedback.toFixed(1)}ms`);
  await context.close();
}
(async()=>{
  const executablePath=process.env.BAOXIAO_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser=await chromium.launch({headless:true,executablePath});
  try{await run(browser,1440);await run(browser,390);}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
