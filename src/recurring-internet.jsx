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
import {List,ListItem} from '@astryxdesign/core/List';
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
async function api(path,body,method){
  const res=await fetch(BASE+path,{method:method||(body?'POST':'GET'),credentials:'include',cache:'no-store',
    headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const value=await res.json();
  if(!res.ok||!value.ok){const error=new Error(value.error||'任务请求失败');error.status=res.status;throw error;}
  return value;
}
const labels={running:'运行中',previewed:'已预览',paused:'已暂停',blocked:'已阻止',failed:'失败',empty:'未发现候选',interrupted:'运行中断',duplicate:'重复，已跳过'};
const at=t=>t?new Date(t*1000).toLocaleString('zh-CN'):'暂无';
function Section({title,description,children}){return <Grid columns={{minWidth:320,max:3}} gap={10}>
  <VStack gap={1}><Heading level={3} accessibilityLevel={2}>{title}</Heading>{description?<Text color="secondary">{description}</Text>:null}</VStack>
  <VStack gap={4}>{children}</VStack>
</Grid>;}
function App(){
  const [task,setTask]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState(null);
  const load=async()=>{setLoading(true);setLoadError(null);try{const t=await api(ENDPOINT);setTask(t);return t;}catch(e){setTask(null);setLoadError(e);throw e;}finally{setLoading(false);}};
  useEffect(()=>{load().catch(e=>setMessage(e.message));},[]);
  const action=async(fn,refresh=true)=>{setBusy(true);setMessage('');try{await fn();if(refresh)await load();}catch(e){setMessage(e.message);}finally{setBusy(false);}};
  const latest=task?.runs?.[0]?.result;
  const item=(latest?.items||[]).find(i=>i.preview)||(latest?.items||[])[0];
  const preview=item?.preview;
  const recent=task&&(task.runs.length?`${labels[task.runs[0].status]||task.runs[0].status} · ${at(task.runs[0].started)}`:'尚未运行');
  return <Layout height="auto" contentWidth={1440} header={<LayoutHeader hasDivider>
    <HStack vAlign="center" wrap="wrap" gap={2}><StackItem size="fill"><Heading level={1}>常规任务</Heading></StackItem><Button label="返回报销工作台" href="./" /></HStack>
  </LayoutHeader>} content={<LayoutContent role="main" padding={4}><VStack gap={4}>
    <Text as="p" id="task-message" role="status" aria-live="polite">{task?message:loading?'正在加载常规任务…':''}</Text>
    {!task&&!loading&&<Section title="常规任务" description="任务记录仅对当前飞书登录账号可见。">
      <Text weight="bold">{loadError?.status===401?'请先登录飞书查看常规任务':loadError?.status===403?'暂时无权读取常规任务':'任务列表暂时无法加载'}</Text>
      <Text>{loadError?.status===401?'当前未登录或登录已过期，尚未读取你的任务记录。登录后请重新进入。':loadError?.status===403?'请确认当前账号的读取权限后重试。':`未能读取任务数据：${loadError?.message||'未知错误'}。`}</Text>
      <HStack gap={2} wrap="wrap">
        {loadError?.status===401&&<Button label="用飞书登录" variant="primary" href={BASE+'/api/auth/feishu/login'} />}
        <Button label="重新加载任务" onClick={()=>action(load)} isLoading={busy} />
      </HStack>
    </Section>}
    {task&&<>
      <Section title="常规任务">
        <List hasDividers>
          <ListItem label="1. 网络服务费" description={<VStack gap={1}>
            <Text>月度 · 发给{task.recipientName||'李颖华'}报销</Text>
            <Text>读取邮箱中的电信网络发票后，预览将发送的消息和附件。不会发起审批，也不会真实发消息。</Text>
            <Text>最近结果：{recent}</Text>
          </VStack>} />
        </List>
      </Section>
      {preview&&<Section title="最近一次预览">
        <VStack gap={2}>
          <Text>{preview.notice||'以下内容不会真实发送。'}</Text>
          {preview.message&&<Text weight="bold">{preview.message}</Text>}
          {preview.month&&<Text>发票月份：{preview.month}（来源：{preview.monthSource||'发票'}）</Text>}
          {preview.buyer&&<Text>购方：{preview.buyer.name} · 税号：{preview.buyer.taxId||'票面为空，未填造'}</Text>}
          {(preview.attachments||[]).map((file,i)=><Text key={i}>附件：{file.name}</Text>)}
        </VStack>
      </Section>}
    </>}
  </VStack></LayoutContent>} />;
}
createRoot(document.getElementById('internet-task-root')).render(<InternationalizationProvider locale="zh-CN" messages={{'zh-CN':zhCN}}><Theme theme={neutralTheme} mode="light"><App /></Theme></InternationalizationProvider>);
