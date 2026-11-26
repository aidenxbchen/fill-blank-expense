/* Isolated browser acceptance. All requests intercepted, synthetic account only. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
async function run(browser,width){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
  const page=await context.newPage(),errors=[],requests=[];
  let loadStatus=200;
  let task={ok:true,enabled:false,dryRun:true,liveSubmissionEnabled:false,liveSendEnabled:false,revision:0,running:null,nextRun:null,
    schedulerRegistered:false,expectedBuyer:'澜理商贸（珠海）有限公司',recipientName:'李颖华',missingConfig:[],
    config:{intervalSeconds:86400,scanSince:1795449600,emptyTaxIdAllowed:true,expectedTaxId:'',internetAccount:''},
    runs:[{id:'synthetic-run',started:1795490000,status:'previewed',result:{ok:true,dryRun:true,status:'previewed',realApprovalsCreated:0,realMessagesSent:0,
      items:[{label:'通信服务费 + ¥379.00',status:'previewed',preview:{dryRun:true,wouldSend:true,realSend:false,recipientName:'李颖华',
        message:'颖华，这是2026年10月的电信网络发票，由我垫付，请完成报销。',month:'2026年10月',monthSource:'计费周期',
        notice:'本轮只预览发给李颖华的消息和附件，不会发起审批，也不会真实发消息。',
        buyer:{name:'澜理商贸（珠海）有限公司',taxId:''},attachments:[{name:'october-net.pdf'}]}}]}}]};
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),p=url.pathname;
    assert.equal(url.hostname,'fixture.invalid','external network forbidden');
    const json=(obj,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(obj)});
    if(p.startsWith('/api/')){
      requests.push(p);
      assert(!p.includes('feishu-expense'),'real approval endpoint forbidden');
      assert(!p.includes('/im/'),'real message endpoint forbidden');
      if(p==='/api/automatic-tasks/internet'){
        if(loadStatus!==200)return json({ok:false,error:loadStatus===401?'请先登录飞书并确认读取权限':'夹具读取失败'},loadStatus);
        return json(task);
      }
      throw Error('Unexpected API: '+p);
    }
    const file=path.resolve(__dirname,p.slice(1));
    assert(file.startsWith(__dirname+path.sep));
    if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
    const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'};
    return route.fulfill({body:fs.readFileSync(file),contentType:types[path.extname(file)]||'application/octet-stream'});
  });
  const forbiddenNames=['前往配置网费预演','扫描邮箱并预演一次','开启预演任务','预填公共办公关联到所选草稿','保存预演配置'];
  await page.goto('http://fixture.invalid/automatic-tasks.html');await page.waitForLoadState('networkidle');
  assert.equal(await page.getByRole('heading',{level:1,name:'常规任务',exact:true}).count(),1);
  await page.getByText('1. 网络服务费',{exact:true}).waitFor();
  await page.getByText('月度 · 发给李颖华报销',{exact:true}).waitFor();
  await page.getByText('颖华，这是2026年10月的电信网络发票，由我垫付，请完成报销。',{exact:true}).waitFor();
  await page.getByText('发票月份：2026年10月（来源：计费周期）',{exact:true}).waitFor();
  assert((await page.locator('body').innerText()).includes('税号：票面未识别到税号'));
  for(const name of forbiddenNames){
    assert.equal(await page.getByRole('button',{name,exact:true}).count(),0,name);
    assert.equal(await page.getByRole('link',{name,exact:true}).count(),0,name);
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no horizontal overflow');
  assert.deepEqual(errors,[]);
  await page.screenshot({path:`/tmp/baoxiao-handoff-task-${width}.png`,fullPage:true});
  for(const status of [401,403,503]){
    loadStatus=status;await page.reload();await page.waitForLoadState('networkidle');
    await page.getByText(status===401?'请先登录飞书查看常规任务':status===403?'暂时无权读取常规任务':'任务列表暂时无法加载',{exact:true}).waitFor();
    assert.equal(await page.getByText('1. 网络服务费',{exact:true}).count(),0,'failure is not a fabricated task list');
    for(const name of forbiddenNames){
      assert.equal(await page.getByRole('button',{name,exact:true}).count(),0,name);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    if(status===401){
      assert.equal(await page.getByRole('link',{name:'用飞书登录',exact:true}).getAttribute('href'),'/api/auth/feishu/login');
      await page.screenshot({path:`/tmp/baoxiao-handoff-task-login-${width}.png`,fullPage:true});
    }
  }
  loadStatus=200;await page.getByRole('button',{name:'重新加载任务',exact:true}).click();
  await page.getByText('1. 网络服务费',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  assert(!requests.some(p=>p.includes('feishu-expense')||p.includes('/im/')));
  console.log(`${width}px: routine card, handoff preview, login/403/503 recovery, zero real endpoints, no overflow passed`);
  await context.close();
}
(async()=>{
  const browser=await chromium.launch();
  try{for(const width of [1200,390])await run(browser,width);}finally{await browser.close();}
})();
