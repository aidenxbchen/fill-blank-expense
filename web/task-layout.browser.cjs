/* Home fixtures only; no request leaves fixture.invalid, no production DB. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
async function run(browser,width){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'}),page=await context.newPage();
  const errors=[],writes=[];let count=3,taskStatus=200;
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
      if(p==='/api/automatic-tasks/internet')return json(task,taskStatus);
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
  await page.getByText('尚未配置常规任务',{exact:true}).waitFor();
  const height=await page.locator('#budget-picker').evaluate(e=>e.getBoundingClientRect().height);
  const metrics=()=>grid.evaluate(e=>({client:e.clientHeight,scroll:e.scrollHeight,top:e.scrollTop,rows:[...e.children].map(c=>({top:c.offsetTop,height:c.offsetHeight}))}));
  let m=await metrics();assert.equal(m.rows.length,3);assert(m.scroll<=m.client+1,'three budgets fit without scrolling');
  await page.screenshot({path:`/tmp/baoxiao-t105-home-three-${width}.png`,fullPage:true});
  count=8;await page.locator('#btn-refresh-budgets').click();await page.waitForFunction(()=>document.querySelectorAll('.budget-card').length===8);
  m=await metrics();assert(m.scroll>m.client,'more than three scrolls internally');
  assert.equal(await page.locator('#budget-picker').evaluate(e=>e.getBoundingClientRect().height),height,'budget count does not change card height');
  await grid.focus();await page.keyboard.press('PageDown');await page.waitForFunction(()=>document.querySelector('#budget-grid').scrollTop>0);
  await page.keyboard.press('End');await page.waitForFunction(()=>{const e=document.querySelector('#budget-grid');return e.scrollTop+e.clientHeight>=e.scrollHeight-2;});
  await grid.locator('button').last().focus();await page.keyboard.press('Enter');
  assert.equal(await grid.locator('button').last().getAttribute('aria-pressed'),'true','last budget is keyboard selectable');
  await page.screenshot({path:`/tmp/baoxiao-t105-home-scroll-${width}.png`,fullPage:true});
  count=1;await page.locator('#btn-refresh-budgets').click();await page.waitForFunction(()=>document.querySelectorAll('.budget-card').length===1);
  assert.equal(await page.locator('#budget-picker').evaluate(e=>e.getBoundingClientRect().height),height);
  count=0;await page.locator('#btn-refresh-budgets').click();await page.getByText('暂无已通过的立项 / 变更预算。',{exact:false}).waitFor();
  assert.equal(await page.locator('#budget-picker').evaluate(e=>e.getBoundingClientRect().height),height);
  task={...task,config:{intervalSeconds:86400},runs:[{status:'blocked',started:1795449600}]};
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByText('每 86400 秒',{exact:true}).waitFor();
  await page.getByText('已阻止 ·',{exact:false}).waitFor();
  assert.equal(await page.getByText('尚未配置常规任务',{exact:true}).count(),0);
  await page.screenshot({path:`/tmp/baoxiao-t105-home-configured-${width}.png`,fullPage:true});
  for(const status of [401,403,503]){
    taskStatus=status;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.getByText(status===401?'请先登录飞书，查看任务状态、周期和最近结果。':status===403?'暂无读取权限，请到管理页检查。':'任务状态读取失败，请到管理页重试。',{exact:true}).waitFor();
    assert.equal(await page.getByText('每 86400 秒',{exact:true}).count(),0,'no stale task after failed read');
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.locator('header').count(),1);assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  await page.getByRole('link',{name:'管理常规任务',exact:true}).click();assert.equal(new URL(page.url()).pathname,'/automatic-tasks.html');
  await context.close();console.log(`${width}: 0/1/3/8 budgets, fixed height, PageDown/End/select, task empty/config/errors, no overflow or writes passed`);
}
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{for(const width of [1440,390,768,320])await run(browser,width);}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
