/* Read-only local/public static acceptance. API responses are isolated fixtures.
 * Only the explicit unauthenticated task status probe reaches a real API (GET).
 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {chromium}=require('playwright');
const version='20261124tasks2',sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const bases=['http://127.0.0.1:5173','https://baoxiao.xbchen.top'];
async function run(browser,base,width){
  const name=base.startsWith('https:')?'public':'local';
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce',serviceWorkers:'block'});
  const page=await context.newPage(),errors=[],assets=[];
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),p=url.pathname;
    assert.equal(req.method(),'GET','verification must never write');
    const json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    if(p.startsWith('/api/')){
      if(p==='/api/auth/me')return json({loggedIn:false});
      if(p==='/api/purchase-schema')return json({ok:true,projects:[],methods:[]});
      if(p==='/api/automatic-tasks/internet')return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({ok:false,error:'请先登录飞书并确认读取权限'})});
      return json({ok:true,configured:false,settings:{},items:[],budgets:[]});
    }
    if(url.origin!==base||p.startsWith('/cdn-cgi/'))return route.fulfill({contentType:'application/javascript',body:''});
    const response=await route.fetch(),body=await response.body();
    assert.equal(response.status(),200,req.url());
    const relative=p==='/'?'index.html':p.slice(1),file=path.resolve(__dirname,relative);
    assert(file.startsWith(__dirname+path.sep)&&fs.existsSync(file),'known repository resource: '+p);
    if(!p.endsWith('.html')&&p!=='/')assert.equal(sha(body),sha(fs.readFileSync(file)),p+' matches repository');
    else assert(body.toString().includes(version),'HTML contains current cache-bust');
    assets.push({path:p,query:url.search,status:response.status(),sha256:sha(body)});
    await route.fulfill({response,body});
  });
  await page.goto(base+'/?v='+version);await page.waitForLoadState('networkidle');
  const entry=page.locator('#btn-periodic-tasks');
  await entry.waitFor({state:'visible'});
  const rect=await entry.boundingBox();
  assert(rect.x>=0&&rect.y>=0&&rect.y+rect.height<=900,'entry visible without scrolling');
  assert.equal(await page.locator('header').count(),1);
  assert.equal(await page.locator('.triad-card').count(),3);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()),'#1f56c9');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.getByText('请先登录飞书，查看任务状态、周期和最近结果。',{exact:true}).waitFor();
  await page.screenshot({path:`/tmp/baoxiao-t105-${name}-home-${width}.png`,fullPage:true});
  await entry.click();await page.waitForLoadState('networkidle');
  await page.getByText('请先登录飞书查看周期性任务',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).pathname,'/automatic-tasks.html');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:`/tmp/baoxiao-t105-${name}-login-${width}.png`,fullPage:true});
  assert.deepEqual(errors,[]);
  for(const p of ['/internet-task/task.js','/internet-task/task.css','/styles.css','/app.js','/ui.js','/routine-task-card.js'])assert(assets.some(a=>a.path===p),'loaded '+p);
  await context.close();
  return {name,width,entry:rect,errors,assets};
}
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.BAOXIAO_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try{
    const result=[];
    for(const base of bases){
      // No cookie/session: this probe cannot create a per-user task or scan email.
      const endpoint=base.startsWith('https:')?base:'http://127.0.0.1:18790';
      const context=await browser.newContext();
      const response=await context.request.get(endpoint+'/api/automatic-tasks/internet');
      assert.equal(response.status(),401,'task data requires login');
      result.push({base,taskAPIStatus:response.status(),taskAPI:await response.json()});
      await context.close();
      for(const width of [1440,390]){
        result.push(await run(browser,base,width));
        console.log(`${base} ${width}px: first-screen entry, click to login state, matching static resources, no writes passed`);
      }
    }
    fs.writeFileSync('/tmp/baoxiao-t105-live-verification.json',JSON.stringify(result,null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
