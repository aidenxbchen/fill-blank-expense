/* Read-only home summary. No task writes, scanning, or submission paths. */
(() => {
  const summary=document.getElementById('routine-task-summary');
  if(!summary)return;
  const base=['localhost','127.0.0.1'].includes(location.hostname)?'http://127.0.0.1:18790':'';
  const labels={running:'运行中',previewed:'预演完成',paused:'已暂停',blocked:'已阻止',failed:'失败',empty:'未发现候选',interrupted:'运行中断',duplicate:'重复，已跳过'};
  let controller,epoch=0;
  const paragraph=text=>{const p=document.createElement('p');p.textContent=text;return p;};
  const clear=text=>summary.replaceChildren(paragraph(text));
  async function load(){
    controller?.abort();controller=new AbortController();const ticket=++epoch;
    try{
      const response=await fetch(base+'/api/automatic-tasks/internet',{credentials:'include',cache:'no-store',signal:controller.signal});
      const task=await response.json();
      if(ticket!==epoch)return;
      if(!response.ok||!task.ok){
        clear(response.status===401?'请先登录飞书，查看任务状态、周期和最近结果。':response.status===403?'暂无读取权限，请到管理页检查。':'任务状态读取失败，请到管理页重试。');return;
      }
      const config=task.config||{},runs=task.runs||[];
      const configured=Object.keys(config).length>0||task.enabled||task.running||runs.length>0;
      const state=task.running?(task.enabled?'运行中':'暂停中，正在停止本轮'):task.enabled?'预演已开启':'已暂停（默认关闭）';
      const recent=runs[0];
      const list=document.createElement('dl');
      for(const [label,value] of [
        ['状态',state],['周期',config.intervalSeconds?`每 ${config.intervalSeconds} 秒`:'未配置'],
        ['最近结果',recent?`${labels[recent.status]||recent.status} · ${new Date(recent.started*1000).toLocaleString('zh-CN')}`:'尚未运行']
      ]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;list.append(dt,dd);}
      summary.replaceChildren(...(configured?[]:[paragraph('尚未配置常规任务')]),list);
    }catch(error){if(ticket===epoch&&error.name!=='AbortError')clear('任务状态读取失败，请到管理页重试。');}
  }
  // renderAuth updates this existing element on login/logout. Cancel stale account reads.
  const auth=document.getElementById('auth-user');
  if(auth)new MutationObserver(()=>{epoch++;controller?.abort();clear('正在读取任务状态…');load();}).observe(auth,{attributes:true,attributeFilter:['hidden']});
  window.addEventListener('focus',load);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
  load();
})();
