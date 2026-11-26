/* Home fixtures only; no request leaves fixture.invalid, no production DB. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
async function run(browser,width){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'}),page=await context.newPage();
  const errors=[],writes=[];let count=3,taskReads=0;
  let task={ok:true,enabled:false,config:{},runs:[]};
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),p=url.pathname;
    assert.equal(url.hostname,'fixture.invalid');
    if(request.method()!=='GET')writes.push(p);
    const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(p.startsWith('/api/')){
      assert.equal(request.method(),'GET','home only reads');
      if(p==='/api/auth/me')return json({loggedIn:true,user:{openId:'fixture-alice',name:'隔离夹具'}});
      if(p==='/api/automatic-tasks/internet'){taskReads++;return json(task);}
      if(p==='/api/budgets')return json({ok:true,budgets:Array.from({length:count},(_,i)=>({instanceId:'fixture-budget-'+i,project:i===0?'公共办公':'合成项目 '+i,kind:'init',totalAmount:725000,subjects:[{name:'服务费'},{name:'快递通讯费'}],startTime:'2026-10-01'}))});
      if(p==='/api/ai-settings')return json({ok:true,configured:true,settings:{hasApiKey:true}});
      if(p==='/api/purchase-schema')return json({ok:true,projects:['公共办公'],methods:[]});
      return json({ok:true,configured:false,settings:{},items:[]});
    }
    const file=path.resolve(__dirname,p==='/'?'index.html':p.slice(1));
    assert(file.startsWith(__dirname+path.sep));
    await route.fulfill({body:fs.readFileSync(file),contentType:({'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream'});
  });
  await page.goto('http://fixture.invalid');await page.waitForLoadState('networkidle');
  const grid=page.locator('#budget-grid');
  await page.getByText('1. 网络服务费',{exact:true}).waitFor();
  assert.equal((await page.locator('.routine-task-card').innerText()).replace(/\s+/g,' '),'常规任务 1. 网络服务费 月度 · 发给李颖华报销');
  assert.ok(!(await page.locator('.routine-task-card').innerText()).includes('1. 1.'));
  assert.equal(await page.locator('.routine-task-card :is(button,input,select,form)').count(),0);
  assert.equal(await page.locator('.routine-task-link').getAttribute('href'),'./automatic-tasks.html?v=20261126rework3');
  assert.equal(await page.locator('#routine-task-summary li').count(),1);
  // Budget picking lives on the later budget stage, not the upload triad.
  await page.screenshot({path:`/tmp/baoxiao-t108-home-three-${width}.png`,fullPage:true});
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  assert.equal((await page.locator('.routine-task-card').innerText()).replace(/\s+/g,' '),'常规任务 1. 网络服务费 月度 · 发给李颖华报销');
  assert.ok(!(await page.locator('.routine-task-card').innerText()).includes('1. 1.'));
  assert.equal(taskReads,0,'business list does not read or imply scheduler state');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.locator('header').count(),1);assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  await context.close();console.log(`${width}: home routine card, handoff link, no overflow or writes passed`);
}
(async()=>{const browser=await chromium.launch({headless:true});try{for(const width of [1440,390,768,320])await run(browser,width);}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
