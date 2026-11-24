// Copyright (c) Meta Platforms, Inc. and affiliates.
// Adapted from Astryx 0.7.17 settings template. Keep its Layout header,
// content padding=4, VStack gap=4, section Grid gap=10 and form gap=4.
import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Layout,LayoutContent,LayoutHeader} from '@astryxdesign/core/Layout';
import {HStack,VStack,StackItem} from '@astryxdesign/core/Stack';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading,Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Selector} from '@astryxdesign/core/Selector';
import {List,ListItem} from '@astryxdesign/core/List';
import {Divider} from '@astryxdesign/core/Divider';
import {Theme} from '@astryxdesign/core/theme';
import {InternationalizationProvider} from '@astryxdesign/core/i18n';
import zhCN from '@astryxdesign/core/locales/zh-CN.generated.js';
import {neutralTheme} from '@astryxdesign/theme-neutral/built';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import '@astryxdesign/theme-neutral/fonts.css';

const BASE=['127.0.0.1','localhost'].includes(location.hostname)?'http://127.0.0.1:18790':'';
const ENDPOINT='/api/automatic-tasks/internet';
async function api(path,body){
  const res=await fetch(BASE+path,{method:body?'POST':'GET',credentials:'include',cache:'no-store',
    headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const value=await res.json();
  if(!res.ok||!value.ok){const error=new Error(value.error||'任务请求失败');error.status=res.status;throw error;}
  return value;
}
const labels={running:'运行中',previewed:'预演完成',paused:'已暂停',blocked:'已阻止',failed:'失败',empty:'未发现候选',interrupted:'运行中断',duplicate:'重复，已跳过'};
const at=t=>t?new Date(t*1000).toLocaleString('zh-CN'):'暂无';
function Section({id,title,description,children}){return <Grid columns={{minWidth:320,max:3}} gap={10}>
  <VStack gap={1}><Heading id={id} level={3} accessibilityLevel={2}>{title}</Heading><Text color="secondary">{description}</Text></VStack>
  <VStack gap={4}>{children}</VStack>
</Grid>;}
function App(){
  const [task,setTask]=useState(null),[drafts,setDrafts]=useState([]),[config,setConfig]=useState({}),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[selected,setSelected]=useState(null),[scanSinceText,setScanSinceText]=useState(''),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState(null);
  const load=async()=>{setLoading(true);setLoadError(null);try{const t=await api(ENDPOINT);setTask(t);setConfig(t.config);setScanSinceText(t.config.scanSince?new Date(t.config.scanSince*1000).toISOString():'');return t;}catch(e){setTask(null);setLoadError(e);throw e;}finally{setLoading(false);}};
  useEffect(()=>{load().catch(e=>setMessage(e.message));api('/api/drafts').then(r=>setDrafts(r.items||r.records||[])).catch(()=>{});},[]);
  const change=(key,value)=>setConfig(c=>({...c,[key]:value}));
  const action=async(fn)=>{setBusy(true);setMessage('');try{await fn();await load();}catch(e){setMessage(e.message);}finally{setBusy(false);}};
  const save=()=>action(()=>api(ENDPOINT,{revision:task.revision,config:{...config,scanSince:Number.isFinite(Date.parse(scanSinceText))?Math.floor(Date.parse(scanSinceText)/1000):null},dryRun:true}));
  const toggle=()=>action(()=>api(ENDPOINT,{revision:task.revision,enabled:!task.enabled,dryRun:true}));
  const run=()=>action(async()=>{const r=await api(ENDPOINT+'/preview',{dryRun:true});setSelected(r);setMessage('预演结束，创建真实审批 0 条。');});
  const latest=selected||task?.runs?.[0]?.result;
  const hasConfiguration=task&&(Object.keys(task.config).length>0||task.enabled||task.running||task.runs.length>0);
  const state=task&&(task.running?(task.enabled?'运行中':'暂停中，正在停止本轮'):task.enabled?'预演任务已开启':'已暂停（默认关闭）');
  const recent=task&&(task.runs.length?`${labels[task.runs[0].status]||task.runs[0].status} · ${at(task.runs[0].started)}`:'尚未运行');
  return <Layout height="auto" contentWidth={1440} header={<LayoutHeader hasDivider>
    <HStack vAlign="center" wrap="wrap" gap={2}><StackItem size="fill"><Heading level={1}>周期性任务</Heading></StackItem><Button label="返回报销工作台" href="./" /></HStack>
  </LayoutHeader>} content={<LayoutContent role="main" padding={4}><VStack gap={4}>
    <Text>常规网费 · 仅预演。任务默认关闭；本页面不能开启真实审批。</Text>
    <Text as="p" id="task-message" role="status" aria-live="polite">{task?message:loading?'正在加载周期性任务…':''}</Text>
    {!task&&!loading&&<Section title="周期性任务列表" description="任务配置与运行记录仅对当前飞书登录账号可见。">
      <Text weight="bold">{loadError?.status===401?'请先登录飞书查看周期性任务':loadError?.status===403?'暂时无权读取周期性任务':'任务列表暂时无法加载'}</Text>
      <Text>{loadError?.status===401?'当前未登录或登录已过期，尚未读取你的任务配置与运行记录，不能据此判断任务为空。登录后请重新进入周期性任务页。':loadError?.status===403?'请确认当前账号的读取权限后重试；当前状态不代表没有任务。':`未能读取任务数据：${loadError?.message||'未知错误'}。请重试；若持续失败，请检查任务服务。`}</Text>
      <Text>支持常规网费周期预演；运行状态、扫描周期、最近结果会在读取成功后显示。</Text>
      <HStack gap={2} wrap="wrap">
        {loadError?.status===401&&<Button label="用飞书登录" variant="primary" href={BASE+'/api/auth/feishu/login'} />}
        <Button label="重新加载任务" onClick={()=>action(load)} isLoading={busy} />
      </HStack>
    </Section>}
    {task&&<>
      <Section title="周期性任务列表" description="只展示当前账号实际保存的配置与运行记录；不会自动创建或启用任务。">
        {hasConfiguration?<List hasDividers>
          <ListItem label="常规网费 · 仅预演" description={<VStack gap={1}>
            <Text>运行状态：{state}</Text>
            <Text>周期：{task.config.intervalSeconds?`每 ${task.config.intervalSeconds} 秒`:'未配置'}</Text>
            <Text>最近结果：{recent}</Text>
          </VStack>} />
        </List>:<VStack gap={2}>
          <Text weight="bold">尚未配置周期性任务</Text>
          <Text>当前账号没有保存网费周期配置，也没有运行记录。任务保持关闭；周期、配置草稿与扫描起始时间均待你确认。</Text>
        </VStack>}
        <HStack><Button label={hasConfiguration?'查看或修改配置':'前往配置网费预演'} href="#task-config" /></HStack>
      </Section>
      <Divider />
      <Section title="运行状态" description="暂停会中止扫描，并在识别和预览落盘前再次检查。">
        <List hasDividers>
          <ListItem label="当前状态" description={state} />
          <ListItem label="扫描周期" description={task.config.intervalSeconds?`每 ${task.config.intervalSeconds} 秒`:'待配置，未猜测周期'} />
          <ListItem label="周期调度器" description={task.schedulerRegistered?'仅预演调度器已注册':'未注册；可手动运行一次预演'} />
          <ListItem label="下一次计划检查" description={at(task.nextRun)} />
          <ListItem label="最近结果" description={recent} />
          <ListItem label="真实审批" description="强制 dry-run · 发布锁关闭 · 本页面不能授权真实提交" />
        </List>
        <HStack gap={2} wrap="wrap">
          <Button label={task.enabled?'暂停任务':'开启预演任务'} onClick={toggle} isDisabled={!task.enabled&&(busy||!!task.missingConfig.length)} />
          <Button label="扫描邮箱并预演一次" onClick={run} isDisabled={busy||!task.enabled||!!task.running} />
          <Button label="刷新状态" onClick={()=>action(load)} isDisabled={busy} />
          {task.running&&!task.enabled&&<Button label="清理中断运行" onClick={()=>action(()=>api(ENDPOINT+'/recover',{revision:task.revision}))} isDisabled={busy} />}
        </HStack>
        {!!task.missingConfig.length&&<Text>待补充：{task.missingConfig.join('、')}</Text>}
      </Section>
      <Divider />
      <Section id="task-config" title="沿用报销配置" description="只读取当前账号选定草稿的整单字段与一个模板行。不会提交草稿里的票，也不会猜测审批人、部门或预算。">
        <Selector label="配置来源草稿" value={config.templateDraftId||''} onChange={v=>change('templateDraftId',v)} options={drafts.map(d=>({value:d.id,label:d.title}))} />
        <TextInput label="扫描周期（秒）" inputMode="numeric" value={String(config.intervalSeconds||'')} onChange={v=>change('intervalSeconds',v?Number(v):null)} description="60 秒至 31 天；没有既有周期时须明确填写。" />
        <TextInput label="扫描起始时间" value={scanSinceText} onChange={setScanSinceText} description="ISO 时间，含时区，例如 2026-11-24T00:00:00+08:00；只扫描此时间后的收件箱 PDF 附件。" />
        <Text>预期购方：澜理商贸（珠海）有限公司</Text>
        <TextInput label="购方预期税号" value={config.expectedTaxId||''} onChange={v=>change('expectedTaxId',v)} description="只填真实已核对税号；票面为空时保持空白，不补造。" />
        <Selector label="购方税号为空时的实际规则" value={config.emptyTaxIdAllowed===true?'allow':config.emptyTaxIdAllowed===false?'block':''} onChange={v=>change('emptyTaxIdAllowed',v==='allow'?true:v==='block'?false:null)} options={[{value:'',label:'待确认，阻止自动提交'},{value:'block',label:'规则要求税号，阻止'},{value:'allow',label:'已核对实际规则允许为空'}]} />
        <TextInput label="已确认的网费账户" value={config.internetAccount||''} onChange={v=>change('internetAccount',v)} description="项目仅写通信服务费时，必须与票面号码一致；未确认的通信费用会被阻止。" />
        <HStack><Button label="保存预演配置" variant="primary" onClick={save} isDisabled={busy||!!task.running} /></HStack>
      </Section>
      <Divider />
      <Section title="最近运行与失败追踪" description="每次运行保留结果；重复原件、相同发票及正在处理的候选均会拦截。">
        <List hasDividers>{task.runs.map(r=><ListItem key={r.id} label={`${at(r.started)} · ${labels[r.status]||r.status}`} description={<Text>{r.result.message||`候选 ${r.result.items?.length||0} 项 · 真实审批 0 条`}</Text>} onClick={()=>setSelected(r.result)} />)}</List>
        {!task.runs.length&&<Text color="secondary">尚无运行记录。</Text>}
      </Section>
      {latest&&<><Divider /><VStack gap={4}><Heading level={2}>本次预演内容</Heading><Text>{latest.message||'预演不会上传附件或发起审批。'}</Text>
        <List hasDividers>{(latest.items||[]).map((item,i)=><ListItem key={i} label={`${item.label} · ${labels[item.status]||item.status}`} description={<VStack gap={2}>
          {item.message&&<Text>{item.message}</Text>}
          {item.preview&&<><Text>{item.preview.message}</Text><Text>购方：{item.preview.buyer.name} · 税号：{item.preview.buyer.taxId||'票面为空，未填造'}</Text>
            {(item.preview.displayForm||[]).map((field,index)=><Text key={index}>{field.name}：{field.value}</Text>)}
            <Text>审批人和部门由现有正常审批流程决定。</Text></>}
        </VStack>} />)}</List>
      </VStack></>}
    </>}
  </VStack></LayoutContent>} />;
}
createRoot(document.getElementById('internet-task-root')).render(<InternationalizationProvider locale="zh-CN" messages={{'zh-CN':zhCN}}><Theme theme={neutralTheme} mode="light"><App /></Theme></InternationalizationProvider>);
