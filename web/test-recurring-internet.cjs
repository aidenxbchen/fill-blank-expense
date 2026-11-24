/* Isolated browser acceptance. All requests intercepted, synthetic account only. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
async function run(browser,width){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
  const page=await context.newPage(),errors=[],requests=[];
  let holdPreview=false,releasePreview=null,loadStatus=200;
  let task={ok:true,enabled:false,dryRun:true,liveSubmissionEnabled:false,revision:0,running:null,nextRun:null,
    schedulerRegistered:false,expectedBuyer:'澜理商贸（珠海）有限公司',missingConfig:[],
    config:{intervalSeconds:86400,scanSince:1795449600,templateDraftId:'template',emptyTaxIdAllowed:null,expectedTaxId:'',internetAccount:''},runs:[]};
  const plan={dryRun:true,wouldSubmit:true,realSubmission:false,message:'若启用则会提交；本次仅预演',buyer:{name:task.expectedBuyer,taxId:''},
    claim:{costCenter:'软件组',purchaseMethod:'个人垫付',purpose:'常规网费',answers:{'purchase:个人垫付:internet_invoice:个人垫付科目':'办公费'}},displayForm:[{name:'项目',value:'软件组'},{name:'采购方式',value:'个人垫付'},{name:'采购事由',value:'常规网费'},{name:'个人垫付科目',value:'办公费'},{name:'附件',value:'1 份原件（仅本地校验）'}],attachmentCount:1};
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),p=url.pathname;
    assert.equal(url.hostname,'fixture.invalid','external network forbidden');
    const json=(obj,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(obj)});
    if(p.startsWith('/api/')){
      requests.push(p);
      assert(!p.includes('feishu-expense'),'real approval endpoint forbidden');
      if(p==='/api/drafts')return json({ok:true,items:[{id:'template',title:'常规网费配置草稿'}]});
      if(p==='/api/automatic-tasks/internet'){
        if(loadStatus!==200)return json({ok:false,error:loadStatus===401?'请先登录飞书并确认读取权限':'夹具读取失败'},loadStatus);
        if(req.method()==='POST'){
          const b=req.postDataJSON();assert.equal(b.dryRun,true);assert.equal(b.revision,task.revision);
          if(b.config)task.config=b.config;
          if(b.enabled!==undefined)task.enabled=b.enabled;
          task.revision++;
        }
        return json(task);
      }
      if(p==='/api/automatic-tasks/internet/preview'){
        assert.equal(task.enabled,true);assert.deepEqual(req.postDataJSON(),{dryRun:true});
        if(holdPreview){
          await new Promise(resolve=>releasePreview=resolve);
          assert.equal(task.enabled,false,'pause must work while the preview request is pending');
          return json({ok:true,dryRun:true,status:'paused',realApprovalsCreated:0,items:[]});
        }
        const result={ok:true,dryRun:true,status:'previewed',realApprovalsCreated:0,items:[{label:'通信服务费 + ¥379.00',status:'previewed',preview:plan}]};
        task.runs=[{id:'synthetic-run',started:1795490000,status:'previewed',result}];return json(result);
      }
      throw Error('Unexpected API: '+p);
    }
    const file=path.resolve(__dirname,p.slice(1));
    assert(file.startsWith(__dirname+path.sep));
    if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
    const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'};
    return route.fulfill({body:fs.readFileSync(file),contentType:types[path.extname(file)]||'application/octet-stream'});
  });
  await page.goto('http://fixture.invalid/automatic-tasks.html');await page.waitForLoadState('networkidle');
  assert.equal(await page.getByRole('heading',{name:'周期性任务',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'扫描邮箱并预演一次',exact:true}).isDisabled(),true);
  await page.getByRole('heading',{name:'周期性任务列表',exact:true}).waitFor();
  await page.getByText('周期：每 86400 秒',{exact:true}).waitFor();
  await page.getByText('最近结果：尚未运行',{exact:true}).waitFor();
  await page.getByLabel('已确认的网费账户',{exact:true}).fill('confirmed-internet-account');
  await page.getByLabel('扫描起始时间',{exact:true}).fill('2026-11-20T00:00:00+08:00');
  await page.getByRole('button',{name:'保存预演配置',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('button[aria-busy="true"]'));
  assert.equal(task.config.internetAccount,'confirmed-internet-account');
  assert.equal(task.config.scanSince,Math.floor(Date.parse('2026-11-20T00:00:00+08:00')/1000));
  await page.getByRole('button',{name:'开启预演任务',exact:true}).click();
  await page.getByRole('button',{name:'暂停任务',exact:true}).waitFor();
  holdPreview=true;
  await page.getByRole('button',{name:'扫描邮箱并预演一次',exact:true}).click();
  for(let n=0;n<100&&!releasePreview;n++)await new Promise(r=>setTimeout(r,20));
  assert(releasePreview,'held preview started');
  assert.equal(await page.getByRole('button',{name:'暂停任务',exact:true}).isEnabled(),true);
  await page.getByRole('button',{name:'暂停任务',exact:true}).click();
  await page.getByRole('button',{name:'开启预演任务',exact:true}).waitFor();
  releasePreview();holdPreview=false;
  await page.getByText('预演结束，创建真实审批 0 条。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'开启预演任务',exact:true}).click();
  await page.getByRole('button',{name:'暂停任务',exact:true}).waitFor();
  await page.getByRole('button',{name:'扫描邮箱并预演一次',exact:true}).click();
  await page.getByRole('heading',{name:'本次预演内容',exact:true}).waitFor();
  await page.getByText('购方：澜理商贸（珠海）有限公司 · 税号：票面为空，未填造',{exact:true}).waitFor();
  assert((await page.locator('body').innerText()).includes('税号：票面为空，未填造'));
  await page.getByRole('button',{name:'暂停任务',exact:true}).click();
  await page.getByRole('button',{name:'开启预演任务',exact:true}).waitFor();
  assert.equal(task.enabled,false);
  assert.equal(await page.getByRole('button',{name:'扫描邮箱并预演一次',exact:true}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no horizontal overflow');
  assert.deepEqual(errors,[]);
  await page.screenshot({path:`/tmp/baoxiao-t104-task-configured-${width}.png`,fullPage:true});
  // Empty/config/login/error states are all isolated fixtures, never production rows.
  task={...task,config:{},runs:[],missingConfig:['扫描周期','已核对的报销配置草稿','扫描起始时间（避免历史票）']};
  await page.reload();await page.waitForLoadState('networkidle');
  await page.getByText('尚未配置周期性任务',{exact:true}).waitFor();
  assert.equal(await page.getByText('常规网费 · 仅预演',{exact:true}).count(),0,'no fabricated task row');
  assert.equal(await page.getByRole('button',{name:'开启预演任务',exact:true}).isDisabled(),true);
  const configLink=page.getByRole('link',{name:'前往配置网费预演',exact:true});
  await configLink.click();assert.equal(new URL(page.url()).hash,'#task-config');
  assert.equal(await page.getByLabel('扫描周期（秒）',{exact:true}).inputValue(),'');
  await page.goto('http://fixture.invalid/automatic-tasks.html');await page.waitForLoadState('networkidle');
  await page.screenshot({path:`/tmp/baoxiao-t104-task-empty-${width}.png`,fullPage:true});
  for(const status of [401,403,503]){
    loadStatus=status;await page.reload();await page.waitForLoadState('networkidle');
    await page.getByText(status===401?'请先登录飞书查看周期性任务':status===403?'暂时无权读取周期性任务':'任务列表暂时无法加载',{exact:true}).waitFor();
    assert.equal(await page.getByText('尚未配置周期性任务',{exact:true}).count(),0,'failure is not an empty list');
    assert.equal(await page.getByLabel('扫描周期（秒）',{exact:true}).count(),0,'no stale config after failed read');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    if(status===401){
      assert.equal(await page.getByRole('link',{name:'用飞书登录',exact:true}).getAttribute('href'),'/api/auth/feishu/login');
      await page.screenshot({path:`/tmp/baoxiao-t104-task-login-${width}.png`,fullPage:true});
    }
  }
  loadStatus=200;await page.getByRole('button',{name:'重新加载任务',exact:true}).click();
  await page.getByText('尚未配置周期性任务',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  assert(!requests.some(p=>p.includes('feishu-expense')));
  console.log(`${width}px: config, start/pause, preview, empty/login/403/503 recovery, zero real endpoints, no overflow passed`);
  await context.close();
}
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.BAOXIAO_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});try{await run(browser,1200);await run(browser,390);}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
