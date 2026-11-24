/**
 * 填空报销 · delight flow
 * batch upload → claim-wide facts → handbook/history prefill → full preview → native Feishu purchase approval
 */
(function () {
  "use strict";

  const STORAGE_KEY = "fill-blank-expense:delight:v1";
  const ASSET_V = "20261124batch1";

  function apiBase() {
    return location.hostname === "127.0.0.1" || location.hostname === "localhost"
      ? "http://127.0.0.1:18790"
      : "";
  }

  function loginHref() {
    return location.hostname === "127.0.0.1" || location.hostname === "localhost"
      ? "https://baoxiao.xbchen.top/api/auth/feishu/login"
      : "/api/auth/feishu/login";
  }

  let authUser = null;
  let approvedBudgets = [];
  let budgetWarning = "";
  let budgetsLoading = false;
  const BUDGET_REFRESH_INTERVAL_MS = 25000;
  const BUDGET_FOCUS_DEBOUNCE_MS = 3000;
  let budgetRequest = null, budgetDataOwner = null, budgetAuthExpiredOwner = null;
  let budgetLastAttempt = 0, budgetRefreshBound = false, budgetRefreshMessage = "";
  let aiSetupOwner = null, aiSetupConfigured = null, aiSetupEpoch = 0;

  const SHEET_KIND_META = {
    meal: { kind: "meal", title: "餐饮表" },
    lodging: { kind: "lodging", title: "住宿表" },
    purchase: { kind: "purchase", title: "物品表" },
    transit: { kind: "transit", title: "交通表" },
    gift: { kind: "gift", title: "礼品表" },
    other: { kind: "other", title: "其他支出表" },
    entertainment: { kind: "entertainment", title: "招待表" },
  };

  const CAT_LABEL = (window.ExpensePolicy && window.ExpensePolicy.CAT_LABEL) || {
    lodging: "住宿",
    meal: "餐饮",
    entertainment: "招待",
    purchase: "采购",
    transit: "交通",
    gift: "礼品",
    other: "其他",
  };

  /** @type {{ stage: string, invoices: any[], answers: Record<string, any>, chat: any[], draft: any, parseErrors: any[] }} */
  let session = emptySession();

  function emptySession() {
    return {
      stage: "upload",
      draftId: uid("draft"),
      invoices: [],
      answers: {},
      chat: [],
      draft: null,
      parseErrors: [],
      lastFeishu: null,
      selectedBudgetId: null,
    };
  }

  function uid(prefix) {
    return `${prefix || "id"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function formatMoney(n) {
    const x = Number(n) || 0;
    return "¥" + x.toFixed(2);
  }

  let saveTimer, saveQueue = Promise.resolve(), readyToSave = false;
  let recordsTab = "drafts", recordsOffset = null, recordItems = [], recordsLoading = false;
  const ownerId = () => authUser && authUser.openId;
  const localKey = () => STORAGE_KEY + ":" + ownerId();

  function stripPreview({previewUrl,...rest}) { return rest; }

  function snapshot() {
    const {stage,draftId,answers,chat,draft,parseErrors,lastFeishu,selectedBudgetId,composerText,prefillEvidence,prefillContext,prefillWarning} = session;
    return JSON.parse(JSON.stringify({stage,draftId,answers,chat,draft,parseErrors,lastFeishu,selectedBudgetId,composerText,prefillEvidence,prefillContext,prefillWarning,
      invoices:session.invoices.map(({previewUrl,...rest})=>rest)}));
  }

  function save() {
    if (!ownerId() || !readyToSave) return;
    try { localStorage.setItem(localKey(), JSON.stringify({state:snapshot(),revision:session.recordRevision || 0,
      title:session.recordTitle || "",submitted:!!session.submitted})); }
    catch (_) { setSaveStatus("本机缓存不可用，请点保存草稿确认服务器已保存"); }
    clearTimeout(saveTimer);
    if (!session.submitted && !session.saveConflict) {
      setSaveStatus("有未保存的修改…");
      saveTimer = setTimeout(()=>persistDraft(false).catch(()=>{}),900);
    }
  }

  const INCOMPLETE_OCR_MSG = "上次识别未完成，请核对后手动补全或重新上传";

  function invoiceNeedsStoredReparse(inv) {
    if (!inv) return false;
    if (inv.status === "parsing") return true;
    if (inv.status !== "error") return false;
    if (inv.error === INCOMPLETE_OCR_MSG) return true;
    return !invoiceHasAmount(inv);
  }

  function prepareInvoicesForResume(invoices) {
    const list = Array.isArray(invoices) ? invoices : [];
    const toResume = [];
    list.forEach((i) => {
      if (!invoiceNeedsStoredReparse(i)) return;
      const hasAtt = !!(i.attachment && (i.attachment.file_id || i.attachment.fileId));
      if (hasAtt || i.fileName) {
        // Keep as parsing so UI shows progress; resume will requeue from stored original.
        i.status = "parsing";
        i.phase = "queued";
        i.error = "";
        toResume.push(i);
      } else if (i.status === "parsing") {
        i.status = "error";
        i.phase = "";
        i.error = INCOMPLETE_OCR_MSG;
      }
    });
    return { invoices: list, toResume };
  }

  // Exported for unit tests (restore → auto-reparse hook).
  window.ExpenseOCRResume = {
    INCOMPLETE_OCR_MSG,
    invoiceNeedsStoredReparse,
    prepareInvoicesForResume,
  };

  function restoreState(state, metadata={}) {
    document.getElementById("draft-meta").replaceChildren();
    document.getElementById("detail-sheets").replaceChildren();
    document.getElementById("invoice-summary-body").replaceChildren();
    session = Object.assign(emptySession(),state);
    session.invoices = Array.isArray(session.invoices) ? session.invoices : [];
    session.answers = session.answers || {};
    window.ExpensePolicy.restoreInvoiceQuantities(session.invoices,session.answers);
    session.chat = Array.isArray(session.chat) ? session.chat : [];
    session.recordRevision = metadata.revision || 0;
    session.recordTitle = metadata.title || "";
    session.submitted = !!metadata.submitted || !!(session.lastFeishu && session.lastFeishu.ok);
    const prepared = prepareInvoicesForResume(session.invoices);
    session.invoices = prepared.invoices;
    session._pendingResumeOCR = prepared.toResume;
  }

  function localLooksLikeIncompleteOCR(state) {
    const invs = (state && state.invoices) || [];
    if (!invs.length) return false;
    const stuck = invs.filter((i) => i.status === "parsing" || (i.status === "error" && (i.error === INCOMPLETE_OCR_MSG || !invoiceHasAmount(i))));
    return stuck.length >= Math.ceil(invs.length / 2);
  }

  function serverLooksRicher(serverState, localState) {
    const s = (serverState && serverState.invoices) || [];
    const l = (localState && localState.invoices) || [];
    const score = (invs) => invs.reduce((n, i) => n + (i.attachment ? 2 : 0) + (invoiceHasAmount(i) ? 3 : 0) + (i.status === "ok" ? 1 : 0), 0);
    return score(s) > score(l);
  }

  async function load() {
    if (!ownerId()) return;
    let hadLocal = false;
    try {
      const raw = JSON.parse(localStorage.getItem(localKey()) || "null");
      if (raw && raw.state) {
        hadLocal = true;
        restoreState(raw.state,raw);
        if (session.recordRevision && !session.submitted) {
          try {
            const result=await recordsAPI("/api/drafts/"+encodeURIComponent(session.draftId));
            const remote = result.record;
            if (remote.revision > session.recordRevision) restoreState(remote.state, remote);
            else if (remote.revision === session.recordRevision && localLooksLikeIncompleteOCR(raw.state) && serverLooksRicher(remote.state, raw.state)) {
              restoreState(remote.state, remote);
            }
          } catch(e) {
            if (e.status===404) { session=emptySession(); showToast("上次草稿已删除或提交，可在我的报销查看"); }
            else showToast("暂时无法核对服务器草稿，保留本机内容；保存时会检查版本",6000);
          }
        }
      }
    } catch(e) { setSaveStatus("本机缓存读取失败，请从我的报销继续草稿"); }
    if (!hadLocal) {
      try {
        const listed = await recordsAPI("/api/drafts?offset=0");
        if (listed.items && listed.items.length) {
          const data = await recordsAPI("/api/drafts/"+encodeURIComponent(listed.items[0].id));
          restoreState(data.record.state, data.record);
          setSaveStatus("已恢复最近一份草稿，也可在「我的报销」查看全部");
          showToast("已恢复最近一份未完成的报销");
        }
      } catch (e) {
        setSaveStatus("暂时无法读取云端草稿，可稍后点「我的报销」重试");
      }
    }
  }

  function setSaveStatus(text, state) {
    const el=document.getElementById("draft-save-status");
    if (el) el.textContent=text;
    state = state || (/未完成|不可用|失败|冲突|暂时无法/.test(text) ? "error" : /正在保存/.test(text) ? "saving" : /未保存/.test(text) ? "dirty" : /已保存|已提交/.test(text) ? "saved" : "idle");
    const strip=document.querySelector(".save-strip");
    if (strip) strip.dataset.state=state;
    const retry=document.getElementById("btn-retry-save");
    if (retry) { retry.hidden=state!=="error";retry.textContent=session.saveConflict ? "查看草稿" : "重试保存"; }
  }

  async function recordsAPI(path, method="GET", body) {
    const response=await fetch(apiBase()+path,{method,credentials:"include",cache:"no-store",
      headers:body ? {"Content-Type":"application/json"} : {},body:body ? JSON.stringify(body) : undefined,
      signal:AbortSignal.timeout(15000)});
    const result=await response.json();
    if (!response.ok || !result.ok) { const err=new Error(result.error || "记录读取失败"); err.status=response.status; throw err; }
    return result;
  }

  let bankProfiles = [], bankProfilesOwner = null, bankTargetSide = 'counterparty', bankEditing = null;
  function activeBankMethod() {
    return ((window.__purchaseSchema || {}).methods || []).find(m=>m.name === session.answers.purchaseMethod);
  }
  async function loadBankProfiles() {
    const owner=ownerId();
    if(!owner) throw new Error('请先用飞书登录');
    const result=await recordsAPI('/api/filling-profiles');
    if(owner!==ownerId()) throw new Error('登录身份已改变，请重新打开档案');
    bankProfiles=result.items || [];bankProfilesOwner=owner;return bankProfiles;
  }
  function bankChoices(side, compact=false) {
    const items=bankProfiles.filter(p=>p.side===side);
    if(!items.length) return '<p class="section-hint">还没有档案。新增一对账号与开户行，以后点一下即可填入。</p>';
    return items.map(p=>`<div class="bank-profile-item"><button type="button" class="bank-profile-choice" data-bank-use="${esc(p.id)}"><strong>${esc(p.title)}</strong><span>${esc(p.fields.bank)} · 尾号 ${esc(p.fields.account.slice(-4))}</span><small>${esc(p.fields.holder || (p.side==='ours' ? '我方账户' : '对方账户'))} · ${esc(p.createdBy)} 创建</small></button>${!compact && p.canEdit ? `<div class="bank-profile-actions"><button type="button" class="btn btn-ghost btn-sm" data-bank-edit="${esc(p.id)}">修改</button><button type="button" class="btn btn-ghost btn-sm" data-bank-disable="${esc(p.id)}">停用</button></div>` : ''}</div>`).join('');
  }
  function renderBankTools(q) {
    const tools=document.getElementById('bank-profile-tools'), isBank=!!q && q.input==='bank-profile';
    tools.hidden=!isBank;
    document.querySelector('#chat-composer .composer-row').hidden=isBank;
    if(!isBank) return;
    bankTargetSide=q.bankSide;
    document.getElementById('bank-quick-list').innerHTML=bankProfilesOwner===ownerId() ? bankChoices(q.bankSide,true) : '<p class="section-hint">正在读取共享档案…</p>';
    if(bankProfilesOwner!==ownerId()) loadBankProfiles().then(()=>{if(session.stage==='interview')renderInterview();}).catch(e=>{
      document.getElementById('bank-quick-list').innerHTML='<p class="section-hint">'+esc(e.message)+'；点下方按钮重试。</p>';
    });
  }
  function renderBankModal() {
    document.getElementById('bank-profile-list').innerHTML=bankChoices(document.getElementById('bank-profile-side').value);
  }
  function clearBankForm() {
    bankEditing=null;document.getElementById('bank-profile-form').reset();
    document.getElementById('bank-profile-save').textContent='保存并填入';
    document.getElementById('bank-profile-error').textContent='';
  }
  async function openBankProfiles(side) {
    if(busyEditing())return;
    bankTargetSide=side || 'counterparty';clearBankForm();
    document.getElementById('bank-profile-side').value=bankTargetSide;
    document.getElementById('bank-profile-list').innerHTML='<p class="section-hint">正在读取共享档案…</p>';
    document.getElementById('bank-profiles-modal').hidden=false;
    try {await loadBankProfiles();renderBankModal();}
    catch(e) {document.getElementById('bank-profile-error').textContent=e.message;}
  }
  function useBankProfile(profile) {
    if(busyEditing() || bankProfilesOwner!==ownerId())return;
    const method=activeBankMethod();
    if(!method)return showToast('请先选择采购方式');
    if(profile.side!==bankTargetSide)return showToast('档案已保存；当前字段需要'+(bankTargetSide==='ours' ? '我方' : '对方收款')+'档案，请切回对应类型选择');
    // Snapshot current edits before replacing the pair, never copy a partial pair.
    if(session.stage==='draft')syncDraftFromDom();
    const targets=method.fields.filter(w=>window.ExpensePolicy.bankRole(w.name) && window.ExpensePolicy.bankSide(w.name)===bankTargetSide);
    if(!targets.length)return showToast('当前采购表单没有此类银行字段');
    if(targets.some(w=>w.required && window.ExpensePolicy.bankRole(w.name)==='holder') && !profile.fields.holder)
      return showToast('此采购方式需要户名，请修改档案补齐户名后再选');
    window.ExpensePolicy.applyBankProfile(method,session.answers,profile,bankTargetSide);
    document.getElementById('bank-profiles-modal').hidden=true;
    if(session.stage==='interview') {pushChat('user',`已选择「${profile.title}」，账号与开户行已一起填入。`);renderInterview();}
    else {buildDraft();renderDraft();}
    save();showToast('银行信息已成对填入');
  }
  async function bankListAction(event) {
    const button=event.target.closest('[data-bank-use],[data-bank-edit],[data-bank-disable]');if(!button)return;
    const id=button.dataset.bankUse || button.dataset.bankEdit || button.dataset.bankDisable;
    const profile=bankProfiles.find(p=>p.id===id);if(!profile)return;
    if(button.hasAttribute('data-bank-use'))return useBankProfile(profile);
    if(!profile.canEdit)return;
    if(button.hasAttribute('data-bank-edit')) {
      bankEditing=profile;document.getElementById('bank-profile-side').value=profile.side;
      for(const [key,value] of Object.entries({title:profile.title,...profile.fields}))document.getElementById('bank-profile-form').elements[key].value=value;
      document.getElementById('bank-profile-save').textContent='更新并填入';
      document.getElementById('bank-profile-form').elements.title.focus({preventScroll:true});return;
    }
    await window.ExpenseUI.run(button,async()=>{
      try {await recordsAPI('/api/filling-profiles/'+profile.id,'DELETE',{revision:profile.revision});await loadBankProfiles();renderBankModal();if(bankEditing && bankEditing.id===profile.id)clearBankForm();showToast('已停用；已填写的报销不会被改动');}
      catch(e){document.getElementById('bank-profile-error').textContent=e.message;}
    },'正在停用…');
  }
  async function saveBankProfile(event) {
    event.preventDefault();const owner=ownerId(),draftId=session.draftId,methodName=session.answers.purchaseMethod;
    const form=event.currentTarget,button=document.getElementById('bank-profile-save');
    await window.ExpenseUI.run(button,async()=>{
      document.getElementById('bank-profile-error').textContent='';
      const body={kind:'bank',side:document.getElementById('bank-profile-side').value,title:form.elements.title.value,
        fields:{holder:form.elements.holder.value,account:form.elements.account.value,bank:form.elements.bank.value},revision:bankEditing && bankEditing.revision};
      try {
        const result=await recordsAPI('/api/filling-profiles'+(bankEditing ? '/'+bankEditing.id : ''),bankEditing ? 'PATCH' : 'POST',body);
        if(owner!==ownerId())return;
        await loadBankProfiles();renderBankModal();clearBankForm();
        if(draftId===session.draftId && methodName===session.answers.purchaseMethod)useBankProfile(result.profile);
      } catch(e) {document.getElementById('bank-profile-error').textContent=e.message+'；填写内容已保留，请重试。';}
    },'正在保存…');
  }

  function persistDraft(manual) {
    clearTimeout(saveTimer);
    if (!ownerId()) return manual ? Promise.reject(new Error("请先用飞书登录")) : Promise.resolve();
    if (session.submitted) { setSaveStatus("已提交 · 可在我的报销查看历史"); return Promise.resolve(); }
    if (!manual && !session.invoices.length && !Object.keys(session.answers).length) {
      setSaveStatus("填写内容会自动保存，也可以随时点保存草稿"); return Promise.resolve();
    }
    // Avoid writing a dead-end server snapshot of empty in-flight rows with no originals yet.
    if (!manual) {
      const invs = session.invoices || [];
      const allEmptyParsing = invs.length && invs.every((i) => i.status === "parsing" && !i.attachment && !invoiceHasAmount(i));
      if (allEmptyParsing) {
        setSaveStatus("正在上传原件，识别完成后会自动保存");
        return Promise.resolve();
      }
    }
    const target=session, owner=ownerId(), state=snapshot();
    const fingerprint=JSON.stringify(state);
    const job=async()=>{
      if (target.deleted || target.submitted || owner!==ownerId()) return;
      if(target.savedFingerprint===fingerprint) {
        if (session===target) setSaveStatus(JSON.stringify(snapshot())===fingerprint ? "已保存 · "+new Date().toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"}) : "有未保存的修改…");
        if(manual) showToast("草稿已保存，可在我的报销继续");
        return;
      }
      if (target.saveConflict) throw new Error("草稿版本冲突，请从我的报销重新打开；当前内容保留在本机");
      setSaveStatus("正在保存草稿…");
      try {
        const result=await recordsAPI("/api/drafts/"+encodeURIComponent(state.draftId),"PUT",{state,revision:target.recordRevision || 0});
        target.savedFingerprint=fingerprint;
        target.recordRevision=result.record.revision;
        target.recordTitle=result.record.title;
        if (session===target && owner===ownerId()) {
          localStorage.setItem(localKey(),JSON.stringify({state:snapshot(),revision:target.recordRevision,title:target.recordTitle,submitted:false}));
          if (JSON.stringify(snapshot())===fingerprint) setSaveStatus("已保存 · "+new Date().toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"}));
          else setSaveStatus("有未保存的修改…", "dirty");
          if (manual) showToast("草稿已保存，稍后可在「我的报销」继续");
        }
      } catch(e) {
        if (e.status===409 || e.status===404) target.saveConflict=true;
        if (session===target) setSaveStatus("保存未完成："+e.message);
        throw e;
      }
    };
    const pending=saveQueue.catch(()=>{}).then(job);
    saveQueue=pending;
    return pending;
  }

  function syncCurrentEditor() {
    if(session.submitted) return;
    if (session.stage==="upload") syncSummaryFromDom();
    else if (session.stage==="draft") syncDraftFromDom();
    if (session.stage==="interview") session.composerText=document.getElementById("chat-input").value;
  }

  function busyEditing() {
    if (submitting || answering || session.invoices.some(i=>i.status==="parsing")) {
      showToast("正在识别或处理回答，请完成后再切换记录；当前草稿仍可保存"); return true;
    }
    return false;
  }

  async function openRecords() {
    if (!ownerId()) { showToast("请先用飞书登录，查看自己的草稿和历史"); return; }
    document.getElementById("records-modal").hidden=false;
    document.getElementById("btn-import-legacy").hidden=!localStorage.getItem(STORAGE_KEY);
    await refreshRecords();
  }

  async function importLegacy() {
    if(busyEditing()) return;
    try {
      syncCurrentEditor();await persistDraft(false);
      const old=JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if(!old) return;
      old.draftId=uid("draft");
      const result=await recordsAPI("/api/drafts/"+old.draftId,"PUT",{state:old,revision:0});
      restoreState(old,result.record);clearTimeout(saveTimer);
      localStorage.removeItem(STORAGE_KEY);
      document.getElementById("records-modal").hidden=true;
      setStage(session.stage);showToast("旧版填写内容已恢复并保存为草稿");
    } catch(e) {showToast("无法导入："+e.message,7000);}
  }

  async function refreshRecords(more=false) {
    if (recordsLoading) return;
    recordsLoading=true;
    const controls=[...document.querySelectorAll("[data-record-tab], #btn-refresh-records, #btn-more-records")];
    controls.forEach(b=>{b.disabled=true;});
    document.getElementById("records-list").setAttribute("aria-busy","true");
    const tab=recordsTab;
    const message=document.getElementById("records-message");
    message.textContent="正在读取…";
    try {
      const result=await recordsAPI("/api/"+tab+"?offset="+(more ? recordsOffset : 0));
      if(tab!==recordsTab) return;
      recordItems=more ? recordItems.concat(result.items) : result.items;
      recordsOffset=result.nextOffset;
      renderRecords();
      message.textContent=recordItems.length ? "" : (tab==="drafts" ? "还没有进行中的报销。上传发票并登录后，草稿会自动出现在这里，可随时继续。" : "还没有已提交记录。完成「发起飞书采购申请」后，摘要会出现在这里；审批进度请在飞书查看。");
    } catch(e) { message.textContent=e.message; }
    finally { recordsLoading=false;controls.forEach(b=>{b.disabled=false;});document.getElementById("records-list").removeAttribute("aria-busy"); }
  }

  function renderRecords() {
    const stageName={upload:"识别汇总",interview:"问答中",draft:"核对草稿",submit:"待提交"};
    document.getElementById("records-list").innerHTML=recordItems.map((r,index)=>`<article class="record-card" data-record-index="${index}">
      <div><h4>${esc(r.title)}</h4><p class="muted-sm">${esc(r.project || "项目待选")} · ${recordsTab==="drafts" ? esc(stageName[r.stage])+" · "+r.invoiceCount+" 张发票" : esc(formatMoney(r.total))+" · 已提交"}</p>
      <p class="muted-sm">${esc(new Date((r.updated_at || r.submitted_at)*1000).toLocaleString("zh-CN"))}${r.serialNumber ? " · 单号 "+esc(r.serialNumber) : ""}</p></div>
      ${recordsTab==="drafts" ? `<div class="record-actions"><button type="button" class="btn btn-primary btn-sm" data-record-action="continue">继续填写</button><button type="button" class="btn btn-ghost btn-sm" data-record-action="rename">重命名</button><button type="button" class="btn btn-ghost btn-sm" data-record-action="delete">删除</button></div>
      <div class="record-rename" hidden><input aria-label="草稿名称" maxlength="160" value="${esc(r.title)}"><button type="button" class="btn btn-secondary btn-sm" data-record-action="save-title">保存名称</button></div>` : '<button type="button" class="btn btn-secondary" data-record-action="detail">查看摘要</button>'}
      </article>`).join("");
    document.getElementById("btn-more-records").hidden=recordsOffset==null;
  }

  function historyDetail(r) {
    const c=r.snapshot.claim, answers=c.answers || {};
    const detail=document.getElementById("record-detail");
    const names=r.snapshot.attachmentNames || [];
    const rows=(c.invoices || []).map(i=>`<tr><td>${esc(i.date)}</td><td>${esc(i.merchant)}</td><td>${esc(i.invoiceNo)}</td><td>${esc(formatMoney(i.amount))}</td><td>${Object.entries(answers).filter(([k])=>k.startsWith("purchase:"+c.purchaseMethod+":"+i.id+":")).map(([k,v])=>esc(k.split(":").pop())+"："+esc(v)).join("<br>")}</td></tr>`).join("");
    detail.hidden=false;
    detail.innerHTML=`<h4>${esc(r.title)}</h4><p>${esc(c.costCenter)} · ${esc(c.purchaseMethod)} · 合计 ${esc(formatMoney(r.total))}</p><p>${esc(c.purpose)}</p>
      <p>关联审批：${esc((c.selectedBudget || {}).title || "未关联")}</p><p>状态：已提交（实时进度请在飞书查看）</p><p>单号：${esc(r.serialNumber || "同步中")} · 实例：${esc(r.instance_code)}</p>
      <div class="table-wrap"><table class="sheet-table"><thead><tr><th>日期</th><th>商户</th><th>发票号</th><th>金额</th><th>采购明细</th></tr></thead><tbody>${rows}</tbody></table></div><p>发票附件：${names.map(esc).join("、") || "无"}</p>`;
    if (/^https:\/\//.test(r.approval_url)) { const a=document.createElement("a"); a.href=r.approval_url;a.target="_blank";a.rel="noopener noreferrer";a.className="btn btn-primary";a.textContent="打开飞书采购申请";detail.append(a); }
    detail.scrollIntoView({block:"nearest",behavior:"smooth"});
  }

  async function recordAction(event) {
    const button=event.target.closest("[data-record-action]");
    if (!button) return;
    const card=button.closest("[data-record-index]"), row=recordItems[Number(card.dataset.recordIndex)], action=button.dataset.recordAction;
    if (action==="rename") {card.querySelector(".record-rename").hidden=false;card.querySelector("input").focus();return;}
    if (action==="delete" && !confirm("删除这份草稿？已提交记录不受影响。")) return;
    button.disabled=true;
    try {
      if (action==="detail") { historyDetail((await recordsAPI("/api/history/"+encodeURIComponent(row.instance_code))).record); return; }
      if (busyEditing()) return;
      syncCurrentEditor();
      await persistDraft(false); // Flush before switching or mutating a listed current draft.
      await saveQueue;
      const current=row.id===session.draftId;
      const revision=current ? session.recordRevision : row.revision;
      if(action==="continue") {
        const data=await recordsAPI("/api/drafts/"+encodeURIComponent(row.id));
        clearTimeout(saveTimer);
        restoreState(data.record.state,data.record);
        document.getElementById("records-modal").hidden=true;
        await refreshFillSuggestions(false);
        setStage(session.stage);
        document.getElementById("chat-input").value=session.composerText || "";
        showToast("已恢复草稿，接着上次的位置继续");
        resumeIncompleteOCR().catch((e)=>showToast(e.message||String(e),7000));
      } else if(action==="save-title") {
        const result=await recordsAPI("/api/drafts/"+encodeURIComponent(row.id),"PATCH",{revision,title:card.querySelector("input").value});
        if(current) {session.recordRevision=result.record.revision;session.recordTitle=result.record.title;save();}
        await refreshRecords();
      } else if(action==="delete") {
        // Prefer query revision: DELETE bodies are often dropped by proxies/browsers.
        await recordsAPI("/api/drafts/"+encodeURIComponent(row.id)+"?revision="+encodeURIComponent(revision),"DELETE");
        if(current) {
          clearTimeout(saveTimer);
          session.deleted=true;
          try { localStorage.removeItem(localKey()); } catch(_) {}
          session=emptySession();
          setStage("upload");
        }
        showToast("草稿已删除");
        await refreshRecords();
      }
    } catch(e) { showToast(e.message,7000);document.getElementById("records-message").textContent=e.message; }
    finally {button.disabled=false;}
  }

  function showToast(msg, ms) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("is-visible");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove("is-visible"), ms || 2800);
    // Login-wall toasts should not leave a stuck focus ring on the trigger.
    const active = document.activeElement;
    if (active && active !== document.body && typeof active.blur === "function" && active.closest(".header-actions, .auth-box, .workspace-menu")) {
      active.blur();
    }
  }

  async function parseInvoice(file, opts) {
    opts = opts || {};
    if (typeof window.__invoiceOCR === "function") {
      return window.__invoiceOCR(file, opts);
    }
    return parseInvoiceMock(file, opts);
  }

  async function parseInvoiceMock(file, opts) {
    await new Promise((r) => setTimeout(r, 350 + Math.random() * 400));
    const name = (file && file.name) || "invoice";
    const lower = name.toLowerCase();
    let category = opts.categoryHint || "other";
    if (/hotel|酒店|住宿|如家|全季/.test(lower)) category = "lodging";
    else if (/餐|meal|咖啡|火锅|外卖/.test(lower)) category = "meal";
    else if (/滴滴|taxi|地铁|高铁|机票|transit/.test(lower)) category = "transit";
    else if (/采购|京东|得力|文具/.test(lower)) category = "purchase";
    const amount = Math.round((80 + Math.random() * 420) * 100) / 100;
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    return {
      amount,
      merchant: name.replace(/\.[^.]+$/, "") || "示例商户",
      date: opts.dayDate || ymd,
      category,
      confidence: 0.42,
      source: "mock",
    };
  }

  /* ---------- stage chrome ---------- */

  function setStage(stage) {
    if (session.submitted && stage !== "submit") { showToast("这份采购已提交，可在我的报销查看摘要；继续填新单请点新建报销"); stage="submit"; }
    if(stage==='upload' && session.stage!=='upload') document.getElementById('invoice-summary-body').replaceChildren();
    session.stage = stage;
    document.querySelectorAll(".stage-item").forEach((el) => {
      const s = el.getAttribute("data-stage");
      el.classList.toggle("is-active", s === stage);
      if (s===stage) el.setAttribute("aria-current","step"); else el.removeAttribute("aria-current");
      el.classList.toggle("is-done", stageOrder(s) < stageOrder(stage));
    });
    document.querySelectorAll("[data-stage-panel]").forEach((el) => {
      el.hidden = el.getAttribute("data-stage-panel") !== stage;
    });
    save();
    if (stage === "upload") renderUpload();
    if (stage === "interview") renderInterview();
    if (stage === "draft") renderDraft();
    if (stage === "submit") renderSubmit();
  }

  function stageOrder(s) {
    return { upload: 0, interview: 1, draft: 2, submit: 3 }[s] ?? 0;
  }

  /* ---------- upload ---------- */

  function invoiceHasAmount(inv) {
    if (!inv || inv.amount === "" || inv.amount == null) return false;
    return Number.isFinite(Number(inv.amount));
  }

  function refreshUploadActions() {
    const startBtn = document.getElementById("btn-start-interview");
    const totalEl = document.getElementById("summary-total");
    const countPill = document.getElementById("summary-count-pill");
    const okCount = okInvoices().length;
    const busy = session.invoices.some((i) => i.status === "parsing");
    if (countPill) countPill.textContent = String(session.invoices.length);
    if (startBtn) {
      startBtn.disabled = okCount === 0 || busy || okCount !== session.invoices.length;
      startBtn.textContent = busy ? "识别中…" : okCount !== session.invoices.length ? `还有 ${session.invoices.length-okCount} 张待核对金额` : `补充整单信息（${okCount} 张）`;
    }
    if (totalEl) {
      const total = session.invoices.reduce(
        (s, i) => s + (invoiceHasAmount(i) ? Number(i.amount) || 0 : 0),
        0
      );
      totalEl.textContent = `表内合计 ${formatMoney(total)} · ${okCount} 张可用`;
    }
  }

  function renderUpload() {
    const list = document.getElementById("invoice-list");
    const summary = document.getElementById("invoice-summary");
    const body = document.getElementById("invoice-summary-body");
    const actions = document.getElementById("upload-actions");
    const status = document.getElementById("parse-status");
    if (!actions) return;
    // Capture in-progress edits before wiping the table (OCR completions race with category selects).
    if (body && body.querySelector("tr[data-inv]")) syncSummaryFromDom();

    if (list) {
      list.hidden = true;
      list.innerHTML = "";
    }

    if (!session.invoices.length) {
      if (summary) summary.hidden = true;
      actions.hidden = true;
      if (status) status.hidden = true;
      return;
    }

    if (summary) summary.hidden = false;
    actions.hidden = false;

    if (body) {
      body.innerHTML = session.invoices
        .map((inv) => {
          const err = inv.status === "error";
          const parsing = inv.status === "parsing";
          const shownAmount = inv.amount === "" || inv.amount == null ? "" : inv.amount;
          let state = ({queued:"排队中",uploading:"正在保存原件…",recognizing:"正在识别与校对…"})[inv.phase] || "正在识别与校对…";
          if (err) state = inv.error ? `失败：${inv.error}` : "失败，可手改";
          else if (!parsing) {
            if (inv._userEdited) state = "已编辑";
            else if (inv.needsReview) state = "待核对";
            else state = "已识别";
            if (inv.corrections && inv.corrections.length) state += " · 已校对";
            else if (inv.review_error) state += " · 未校对";
          }
          const disabled = parsing ? "disabled" : "";
          const cat = inv.category || "other";
          const options = Object.keys(CAT_LABEL)
            .map((k) => `<option value="${esc(k)}"${k === cat ? " selected" : ""}>${esc(CAT_LABEL[k])}</option>`)
            .join("");
          const dateType = /^\d{4}-\d{2}-\d{2}$/.test(inv.date || "") || !inv.date ? "date" : "text";
          return `<tr data-inv="${esc(inv.id)}" class="${err ? "is-error" : parsing ? "is-busy" : "is-ok"}">
            <td class="td-file" title="${esc(inv.fileName || "")}">${esc(inv.fileName || "发票")}<small>${inv.attachment ? "原件已保存" : "需要补传原件"}</small><button type="button" class="btn btn-ghost btn-sm" data-reattach="${esc(inv.id)}" ${disabled}>${inv.attachment ? "更换原件" : "补传原件"}</button>${err && inv.attachment ? `<button type="button" class="btn btn-secondary btn-sm" data-reparse="${esc(inv.id)}">用原件重新识别</button>` : ""}</td>
            <td data-label="日期"><input aria-label="发票日期" data-sum="date" type="${dateType}" value="${esc(inv.date || "")}" ${disabled} /></td>
            <td data-label="商户"><input aria-label="发票商户" data-sum="merchant" type="text" value="${esc(inv.merchant || "")}" ${disabled} /></td>
            <td data-label="发票号码"><input aria-label="发票号码" data-sum="invoiceNo" type="text" value="${esc(inv.invoiceNo || "")}" ${disabled} /></td>
            <td data-label="金额"><input aria-label="发票金额" data-sum="amount" inputmode="decimal" value="${esc(shownAmount)}" ${disabled} /></td>
            <td data-label="类别"><select aria-label="发票类别" data-sum="category" ${disabled}>${options}</select></td>
            <td data-label="数量 / 单位"><div class="invoice-quantity"><input aria-label="票面数量" data-sum="quantity" ${(inv.items || []).length>1 ? "readonly" : ""} inputmode="decimal" value="${esc((window.ExpensePolicy.quantityUnit(inv)).quantity)}" ${disabled} /><input aria-label="票面单位" data-sum="unit" ${(inv.items || []).length>1 ? "readonly" : ""} value="${esc((window.ExpensePolicy.quantityUnit(inv)).unit)}" ${disabled} /></div><small>${(inv.items || []).length>1 ? "合开按一批" : inv.quantityMode==='invoice' ? "来自票面" : inv.quantityMode==='legacy' ? "保留原草稿填写" : "缺项使用默认值，可核对"}</small></td>
            <td data-label="处理状态"><span class="invoice-state${parsing && inv.phase!=="queued" ? " is-processing" : ""}">${esc(state)}</span></td>
            <td><button type="button" class="btn btn-ghost btn-sm" data-remove="${esc(inv.id)}" ${parsing ? "disabled" : ""} aria-label="移除${esc(inv.fileName || "发票")}">×</button></td>
          </tr>`;
        })
        .join("");
    }

    refreshUploadActions();

    if (status) {
      const busy=session.invoices.filter(i=>i.status==="parsing");
      const errors=session.invoices.filter(i=>i.status==="error");
      status.hidden=!busy.length && !errors.length;
      status.innerHTML=busy.length ? `<div class="parse-activity is-processing">已处理 ${session.invoices.length-busy.length} / ${session.invoices.length} 份，剩余文件正在处理。你可以先核对已识别的内容。</div>` : errors.length ? `<div class="parse-err">${errors.length} 份未完成识别。可用已保存原件重新识别，也可在表格手动补全；缺原件时请补传。</div>` : "";
    }
  }

  function syncSummaryFromDom() {
    document.querySelectorAll("#invoice-summary-body tr[data-inv]").forEach((tr) => {
      const id = tr.getAttribute("data-inv");
      const inv = session.invoices.find((i) => i.id === id);
      if (!inv || inv.status === "parsing") return;
      if (!inv._editedFields) inv._editedFields = {};
      tr.querySelectorAll("[data-sum]").forEach((el) => {
        // Skip disabled cells (still-parsing rows). After applyParsedInvoice the model
        // is already "ok" but the DOM may still show the old disabled empty inputs
        // until this render finishes — never let those wipe OCR/user values.
        if (el.disabled) return;
        const key = el.getAttribute("data-sum");
        const val = el.value;
        const prev = inv[key] == null ? "" : inv[key];
        if (String(prev) !== String(val)) {
          inv._userEdited = true;
          inv._editedFields[key] = true;
        }
        if (key === "amount") {
          inv.amount = String(val).trim() === "" ? "" : String(val).trim();
          if (invoiceHasAmount(inv) && inv.status === "error") {
            inv.status = "ok";
            inv.error = "";
          }
        } else {
          inv[key] = val;
        }
      });
      if (inv._userEdited) inv.confirmed = true;
    });
    save();
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function handleFiles(fileList) {
    if (session.submitted) { showToast("这份采购已提交，请点新建报销"); return; }
    if(submitting) return;
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!authUser) { showToast("请先用飞书登录，再上传发票；原件会随采购申请提交"); return; }

    remindAiOnUpload();

    syncSummaryFromDom();
    const queued=files.map(file=>({file,entry:{
      id:uid("inv"),fileName:file.name,status:"parsing",phase:"queued",amount:"",merchant:"",date:"",invoiceNo:"",category:"",confidence:0,source:"",error:"",raw:null,corrections:[],needsReview:false,confirmed:false
    }}));
    session.invoices.push(...queued.map(item=>item.entry));
    renderUpload();save();
    for (const {file,entry} of queued) {
      syncSummaryFromDom();
      entry.phase="uploading";renderUpload();
      try {
        if(window.__storeInvoiceFile) {
          entry.attachment=await window.__storeInvoiceFile(file,{draftId:session.draftId,invoiceId:entry.id});
          save();
          // Persist the original reference BEFORE starting potentially slow OCR.
          await persistDraft(false);
        }
        syncSummaryFromDom();
        entry.phase="recognizing";renderUpload();
        const result=await parseInvoice(file,{attachment:entry.attachment,draftId:session.draftId,invoiceId:entry.id});
        // Capture edits to OTHER rows before replacing the DOM. This row is still
        // parsing, so its empty disabled inputs must never overwrite the result.
        syncSummaryFromDom();
        applyParsedInvoice(entry,result);
        renderUpload();
        save();
        // Persist each successful parse immediately so a refresh can resume instead of losing amounts.
        await persistDraft(false);
        if(result.review_setup_needed) showToast("字段校对需要配置 AI：请打开 AI 设置，推荐使用 Deepseek",7000);
        else if(result.review_error) showToast("已识别，但文本校对未完成："+result.review_error,6000);
      } catch(err) {
        syncSummaryFromDom();
        if(err.duplicate) {session.invoices=session.invoices.filter(i=>i!==entry);showToast(err.message,9000);renderUpload();save();continue;}
        entry.status="error";entry.phase="";
        if(err.attachment) entry.attachment=err.attachment;
        entry.error=(err && err.message) || String(err);
        session.parseErrors.push(`${file.name}: ${entry.error}`);
        showToast("识别未完成，可在汇总表重试或手动补全",6000);
        renderUpload();save();
        await persistDraft(false).catch(()=>{});
      }
      renderUpload();save();
    }
  }

  function fieldWasEdited(entry, key) {
    return !!(entry && entry._editedFields && entry._editedFields[key]);
  }

  function applyParsedInvoice(entry, result) {
    const edited = entry._editedFields || {};
    const parsedAmount = result.amount;
    const ocrAmount =
      parsedAmount == null || (Number(parsedAmount) === 0 && result.needsReview)
        ? ""
        : parsedAmount;
    Object.assign(entry, {
      status: "ok",
      phase: "",
      attachment: result.attachment || entry.attachment || null,
      amount: edited.amount ? entry.amount : ocrAmount,
      merchant: edited.merchant
        ? entry.merchant
        : result.merchant || (entry.fileName || "").replace(/\.[^.]+$/, ""),
      date: edited.date ? entry.date : result.date || "",
      invoiceNo: edited.invoiceNo ? entry.invoiceNo : result.invoiceNo || "",
      invoiceCode: result.invoiceCode || entry.invoiceCode || '',
      items: result.items || entry.items || [],
      quantity: edited.quantity ? entry.quantity : result.quantity,
      unit: edited.unit ? entry.unit : result.unit || '',
      quantityMode: result.quantityMode || 'default',
      // Never overwrite a user-picked 类别 when concurrent OCR finishes.
      category: edited.category ? entry.category : normalizeCategory(result.category),
      confidence: result.confidence || 0,
      source: result.source || "",
      raw: result.raw || null,
      extract_method: result.extract_method,
      review_model: result.review_model || "",
      review_error: result.review_error || "",
      corrections: result.corrections || [],
      needsReview: !!result.needsReview,
    });
  }

  // Exported for unit tests: OCR merge must keep user-picked 类别 across concurrent parses.
  window.ExpenseInvoiceMerge = {
    fieldWasEdited,
    applyParsedInvoice,
  };

  async function ensureAttachment(inv) {
    if (inv.attachment && (inv.attachment.file_id || inv.attachment.fileId)) return inv.attachment;
    if (!inv.fileName || !ownerId()) return null;
    const response = await fetch(
      apiBase() + "/api/invoice-files/by-name?name=" + encodeURIComponent(inv.fileName),
      { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(10000) }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.attachment) return null;
    inv.attachment = data.attachment;
    return inv.attachment;
  }

  async function reparseFromStored(inv, { force = false } = {}) {
    if (!force && busyEditing()) return;
    syncSummaryFromDom();
    inv.status = "parsing";
    inv.phase = "recognizing";
    inv.error = "";
    save();
    renderUpload();
    try {
      const attachment = await ensureAttachment(inv);
      if (!attachment) throw new Error("缺少已存原件，请补传后再识别");
      const result = await parseInvoice(null, { attachment,draftId:session.draftId,invoiceId:inv.id });
      syncSummaryFromDom();
      applyParsedInvoice(inv, result);
      renderUpload();
      save();
      await persistDraft(false);
    } catch (e) {
      syncSummaryFromDom();
      inv.status = "error";
      inv.phase = "";
      inv.error = e.message || String(e);
      showToast(inv.error, 6000);
      save();
      renderUpload();
    }
  }

  async function retryStoredOCR(inv) {
    return reparseFromStored(inv, { force: false });
  }

  async function resumeIncompleteOCR() {
    const pending = Array.isArray(session._pendingResumeOCR) ? session._pendingResumeOCR.slice() : [];
    session._pendingResumeOCR = null;
    const targets = session.invoices.filter(
      (i) =>
        pending.includes(i) ||
        (invoiceNeedsStoredReparse(i) && (i.attachment || i.fileName))
    );
    // Dedupe by id
    const seen = new Set();
    const list = [];
    targets.forEach((i) => {
      if (!i || seen.has(i.id)) return;
      seen.add(i.id);
      list.push(i);
    });
    if (!list.length || session.submitted) return;
    showToast("正在用已存原件继续识别…", 5000);
    setSaveStatus("正在用已存原件继续识别…", "saving");
    for (const inv of list) {
      if (!session.invoices.includes(inv)) continue;
      await reparseFromStored(inv, { force: true });
    }
    const left = session.invoices.filter((i) => i.status === "error").length;
    if (!left) showToast("已用原件完成识别，请核对汇总表");
    else showToast(`仍有 ${left} 份需手动补全或补传原件`, 7000);
  }

  function normalizeCategory(c) {
    const known = SHEET_KIND_META;
    if (c && known[c]) return c;
    return "other";
  }

  /* ---------- interview ---------- */

  function okInvoices() {
    return session.invoices.filter((i) => i.status !== "parsing" && invoiceHasAmount(i));
  }

  function applyAnswerSideEffects(qid, value, question) {
    const answers = session.answers;
    if (qid === "isEntertainment") {
      const map = (question && question.map) || {
        对外招待: true,
        内部用餐: false,
        个人垫付出差餐: false,
      };
      if (typeof map[value] === "boolean") answers.isEntertainment = map[value];
      else answers.isEntertainment = /招待/.test(String(value));
      answers.isEntertainmentLabel = value;
      return;
    }
    if (qid === "resolveCategoryConflict" && question && question.meta && question.meta.conflict) {
      const c = question.meta.conflict;
      if (String(value).startsWith("改为")) {
        const inv = session.invoices.find((i) => i.id === c.id);
        if (inv) inv.category = c.suggest;
      }
    }
    if (qid === "fixMissingDates" && question && question.meta) {
      const ids = question.meta.missingIds || [];
      let dateVal = "";
      if (/^\d{4}-\d{2}-\d{2}/.test(String(value).trim())) dateVal = String(value).trim().slice(0, 10);
      else if (String(value).includes("上传日")) {
        const d = new Date();
        dateVal = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      }
      if (dateVal) {
        ids.forEach((id) => {
          const inv = session.invoices.find((i) => i.id === id);
          if (inv && !inv.date) inv.date = dateVal;
        });
      }
    }
    answers[qid] = value;
  }

  function pushChat(role, text, meta) {
    session.chat.push({ id: uid("msg"), role, text, meta: meta || null, at: Date.now() });
  }

  function renderInterview() {
    if(choiceRequestKey!==JSON.stringify(choiceContext()))window.__choiceSuggestions=null;
    const side = document.getElementById("sidebar-invoices");
    const pill = document.getElementById("invoice-count-pill");
    const log = document.getElementById("chat-log");
    const progress = document.getElementById("chat-progress");
    const chipRow = document.getElementById("chip-row");
    const skipBtn = document.getElementById("btn-skip-optional");
    const invs = okInvoices();

    if (pill) pill.textContent = String(invs.length);
    if (side) {
      side.innerHTML = invs
        .map(
          (inv) => `<li>
            <strong>【${esc(session.answers.costCenter || "待选项目")}】${esc(formatMoney(inv.amount))}</strong>
            <span>${esc(formatMoney(inv.amount))} · ${esc(CAT_LABEL[inv.category] || inv.category)}</span>
            <span class="muted-sm">${esc(inv.date || "无日期")}</span>
          </li>`
        )
        .join("");
    }

    const policy = window.ExpensePolicy && window.ExpensePolicy.POLICY;
    const remaining = window.ExpensePolicy
      ? window.ExpensePolicy.remainingCount(invs, session.answers, policy)
      : 0;
    if (progress) {
      progress.textContent = remaining > 0 ? `还差 ${remaining} 项整单信息` : "整单信息已齐，正在整理预填清单…";
    }

    // Seed opening message once
    if (!session.chat.length) {
      pushChat(
        "assistant",
        `已识别 ${invs.length} 张发票，合计 ${formatMoney(invs.reduce((s, i) => s + (Number(i.amount) || 0), 0))}。只需补充这次的花销目的和整单信息；各张发票的科目等会直接整理到清单，最后一起检查。`
      );
    }

    ensureCurrentQuestionAsked();
    save();

    if (log) {
      log.innerHTML = session.chat
        .map((m) => `<div class="chat-bubble chat-${m.role==="user" ? "user" : "assistant"}"><div class="chat-bubble-inner">${esc(m.text)}</div></div>`)
        .join("");
      log.scrollTop = log.scrollHeight;
    }

    const q = window.ExpensePolicy ? window.ExpensePolicy.nextQuestion(invs, session.answers, policy) : null;
    renderBankTools(q);
    if (!q) {
      chipRow.innerHTML = "";
      document.getElementById("chat-input").disabled = true;
      document.getElementById("btn-send-answer").disabled = true;
      if (skipBtn) skipBtn.hidden = true;
      // auto advance to draft
      setTimeout(async () => {
        if (session.stage === "interview") {
          await prepareDraft();
        }
      }, 450);
      return;
    }

    document.getElementById("chat-input").disabled = false;
    document.getElementById("btn-send-answer").disabled = false;
    if (skipBtn) skipBtn.hidden = !!q.required;

    renderQuestionChips(q);
    session._currentQuestion = q;
  }

  function renderQuestionChips(q) {
    document.getElementById('chip-row').innerHTML = (q.chips || [])
      .map((c) => `<button type="button" class="chip${q.recommended && q.recommended.value === c ? " is-recommended" : ""}" data-chip="${esc(c)}" aria-pressed="false">${esc(c)}${q.recommended && q.recommended.value === c ? `<small>${esc(q.recommended.source ? q.recommended.source + ' 建议' : '历史常用')}</small>` : ""}</button>`)
      .join("");
  }

  function ensureCurrentQuestionAsked() {
    const invs = okInvoices();
    const policy = window.ExpensePolicy && window.ExpensePolicy.POLICY;
    const q = window.ExpensePolicy ? window.ExpensePolicy.nextQuestion(invs, session.answers, policy) : null;
    if (!q) return;
    const expected = q.text + (q.hint ? `\n${q.hint}` : "");
    const last = session.chat[session.chat.length - 1];
    // Same unanswered question: refresh wording so old drafts drop 尾号 / 第 N 张票 phrasing.
    if (last && last.role === "assistant" && last.meta && last.meta.qid === q.id) {
      if (last.text !== expected) last.text = expected;
      return;
    }
    // avoid duplicating same question text if already last
    if (last && last.role === "assistant" && last.text === expected) {
      if (!last.meta) last.meta = { qid: q.id };
      return;
    }
    pushChat("assistant", expected, { qid: q.id });
  }

  function fillingClaim() {
    return {costCenter:session.answers.costCenter || "", purchaseMethod:session.answers.purchaseMethod || "",
      purpose:session.answers.purpose || "", answers:{...session.answers}, selectedBudget:session.answers.selectedBudget || null, invoices:okInvoices().map(({id,amount,merchant,category,items,quantity,unit,note,date,invoiceNo,attachment,fileName,source})=>({id,amount,merchant,category,items,quantity,unit,note,date,invoiceNo,attachment,fileName,source}))};
  }

  let choiceRequestKey = "";
  let choiceRequestEpoch = 0;
  const choiceCache = new Map();
  function choiceContext() {
    const claim=fillingClaim();
    // Closed answers don't invalidate a decision; edits to its invoice facts do.
    claim.answers={purchaseMethod:claim.purchaseMethod,costCenter:claim.costCenter,purpose:session.answers.purpose || ""};
    return {owner:ownerId(),draft:session.draftId,claim};
  }
  async function refreshChoiceSuggestions(force=false) {
    if (!authUser || !okInvoices().length) return;
    const context=choiceContext(), key=JSON.stringify(context);
    if (key===choiceRequestKey && !force) return;
    choiceRequestKey=key;
    const epoch=++choiceRequestEpoch;
    const cached=choiceCache.get(key);
    if(cached && Date.now()-cached.at<600000) {window.__choiceSuggestions=cached.suggestions;return;}
    window.__choiceSuggestions=null;
    try {
      const response=await fetch(apiBase()+"/api/choice-suggestions",{
        method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({claim:context.claim}),signal:AbortSignal.timeout(60000)
      });
      const result=await response.json();
      // Never apply an earlier invoice revision, draft or another login's result.
      if (epoch!==choiceRequestEpoch || key!==choiceRequestKey || key!==JSON.stringify(choiceContext())) return;
      if (!response.ok || !result.ok) throw new Error("建议暂不可用");
      if(choiceCache.size>=100)choiceCache.clear();
      if(!result.suggestions.notices || !result.suggestions.notices.length)
        choiceCache.set(key,{at:Date.now(),suggestions:result.suggestions});
      window.__choiceSuggestions=result.suggestions;
      if(session.stage==="interview") {
        // Refresh only suggestions; preserve composer text, chat scroll and keyboard focus.
        const q=window.ExpensePolicy.nextQuestion(okInvoices(),session.answers);
        if(!answering && q && session._currentQuestion && q.id===session._currentQuestion.id &&
            !(document.activeElement && document.activeElement.matches('[data-chip]'))) {
          renderQuestionChips(q);session._currentQuestion=q;
        }
        if(result.suggestions.notices && result.suggestions.notices.length) showToast(result.suggestions.notices.join('；'),8000);
      }
    } catch (_) {
      if(epoch===choiceRequestEpoch && key===choiceRequestKey && key===JSON.stringify(choiceContext()) && session.stage==="interview")
        showToast("选项建议暂不可用，可继续手动选择；重新进入问答可重试",6500);
      if(epoch===choiceRequestEpoch && key===choiceRequestKey)choiceRequestKey="";
    }
  }

  async function refreshFillSuggestions(record) {
    if (!authUser || !okInvoices().length) return;
    const owner=ownerId(), draft=session.draftId;
    try {
      const response = await fetch(apiBase() + (record ? "/api/fill-history" : "/api/fill-suggestions"), {
        method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({draftId:session.draftId,claim:fillingClaim()}), signal:AbortSignal.timeout(4000)
      });
      const result = await response.json();
      if(owner===ownerId() && draft===session.draftId) window.__fillSuggestions = response.ok && result.ok ? result.suggestions : null;
    } catch (_) { if(owner===ownerId() && draft===session.draftId) window.__fillSuggestions = null; }
    // Don't make a remote model call on every autosave. It runs alongside interview preparation.
    if((session.stage==="interview" || !record) && !session.answers.purchaseMethod) refreshChoiceSuggestions(!record);
  }

  let fillingTimer;
  function queueFillingHistory() {
    clearTimeout(fillingTimer);
    fillingTimer = setTimeout(()=>refreshFillSuggestions(true), 500);
  }

  let answering = false;
  async function submitAnswer(raw) {
    if (answering) return;
    const value = String(raw == null ? "" : raw).trim();
    if (!value) return;
    const q = session._currentQuestion;
    if (!q) return;
    if (q.id === "schemaUnavailable") { showToast("采购表单加载失败，请刷新重试"); return; }
    if (q.numeric && (!Number.isFinite(Number(value)) || Number(value) <= 0)) { showToast("请输入大于零的数量"); return; }
    if (q.options && q.options.length && !q.options.includes(value)) { showToast("请从现有选项中选择"); return; }
    if (q.id === "selectBudget") {
      const index = (q.chips || []).indexOf(value);
      if (index < 0) { showToast("请点选一条已通过的预算"); return; }
      selectBudget(q.budgetIds[index]);
    }
    pushChat("user", value, { qid: q.id });
    applyAnswerSideEffects(q.id, value, q);
    answering = true;
    const input=document.getElementById("chat-input"), send=document.getElementById("btn-send-answer");
    const restoreInputFocus=document.activeElement===input;
    input.value="";session.composerText="";
    document.querySelectorAll("[data-chip]").forEach(chip=>{chip.disabled=true;chip.classList.toggle("is-selected",chip.dataset.chip===value);chip.setAttribute("aria-pressed",String(chip.dataset.chip===value));});
    input.disabled=true;send.disabled=true;send.setAttribute("aria-busy","true");send.textContent="已选择";
    document.getElementById("chat-progress").textContent="已记录回答，正在准备下一问…";
    save();
    try { await refreshFillSuggestions(true); }
    finally { answering=false;send.removeAttribute("aria-busy");send.textContent="发送";renderInterview();if(restoreInputFocus && session.stage==="interview" && !input.disabled) input.focus({preventScroll:true}); }
    return true;
  }

  /* ---------- draft ---------- */

  let preparingDraft = false;
  async function prepareDraft() {
    if(preparingDraft) return;
    preparingDraft=true;
    const owner=ownerId(), target=session, context=JSON.stringify(choiceContext()), requested={...session.answers};
    try {
      const result=await recordsAPI('/api/prefill','POST',{draftId:session.draftId,claim:fillingClaim()});
      if(owner!==ownerId() || target!==session || context!==JSON.stringify(choiceContext())) return;
      window.ExpensePolicy.mergePrefill(session.answers,result,requested);
      session.prefillEvidence=result.evidence || {};
      session.prefillContext=context;
      session.prefillWarning='';
    } catch(e) {
      if(owner!==ownerId() || target!==session) return;
      session.prefillWarning='历史预填暂不可用，清单中的空项请集中补全：'+e.message;
    } finally { preparingDraft=false; }
    if(target!==session || owner!==ownerId() || session.stage!=="interview") return;
    buildDraft();setStage('draft');showToast('发票清单已整理，请集中检查');
  }

  function buildDraft() {
    const invs = okInvoices().map((i) => ({ ...i }));
    const sheetsMap = {};
    invs.forEach((inv) => {
      const kind = SHEET_KIND_META[inv.category] ? inv.category : "other";
      if (!sheetsMap[kind]) {
        const meta = SHEET_KIND_META[kind];
        sheetsMap[kind] = {
          id: uid("sheet"),
          title: meta.title,
          kind: meta.kind,
          rows: [],
        };
      }
      sheetsMap[kind].rows.push({
        id: uid("row"),
        date: inv.date || "",
        description: inv.merchant || inv.fileName || "",
        invoiceNo: inv.invoiceNo || "",
        amount: inv.amount == null ? "" : String(inv.amount),
        hasInvoice: true,
        invoiceRef: inv.id,
        note: "",
      });
    });

    const sheets = Object.values(sheetsMap);
    const total = sheets.reduce(
      (s, sh) => s + sh.rows.reduce((a, r) => a + (parseFloat(r.amount) || 0), 0),
      0
    );

    session.draft = {
      generatedAt: new Date().toISOString(),
      purchaseMethod: session.answers.purchaseMethod || "",
      purpose: session.answers.purpose || "",
      costCenter: session.answers.costCenter || "",
      guestCompany: session.answers.guestCompany || "",
      attendees: session.answers.attendees || "",
      hasAlcohol: session.answers.hasAlcohol || "",
      privatePublic: session.answers.privatePublic || "",
      travelCity: session.answers.travelCity || "",
      purchaseProject: session.answers.purchaseProject || session.answers.costCenter || "",
      transitContext: session.answers.transitContext || "",
      answers: { ...session.answers },
      invoices: invs.map(stripPreview),
      detailSheets: sheets,
      total,
      policyName: (window.ExpensePolicy && window.ExpensePolicy.POLICY.name) || "",
    };
    save();
  }

  function renderDraft() {
    if (!session.draft) buildDraft();
    const d = session.draft;
    const meta = document.getElementById("draft-meta");
    const sheetsEl = document.getElementById("detail-sheets");
    const totalEl = document.getElementById("draft-total");
    const line = document.getElementById("draft-summary-line");

    if (line) {
      line.textContent = session.prefillWarning || `花销目的：${d.purpose || "（未填）"} · ${okInvoices().length} 张发票 · 科目和费用类型已按手册与合格历史预填，可直接修改。`;
    }

    if (meta) {
      const schema = window.__purchaseSchema || {projects:[], methods:[]};
      const choices = (items, current) => `<option value="">请选择</option>${current && !items.includes(current) ? `<option value="${esc(current)}" selected>已失效：${esc(current)}</option>` : ''}` + items.map(x=>`<option value="${esc(x)}" ${x===current ? "selected":""}>${esc(x)}</option>`).join("");
      const method = schema.methods.find(m=>m.name === d.purchaseMethod);
      const sharedFields = method ? method.fields.filter(w=>window.ExpensePolicy.bankRole(w.name)).map(w=>{
        const key = `purchase:${method.name}:shared:${w.name}`;
        return `<div class="field"><label>${esc(w.name)}（所有行共用）</label><input aria-label="${esc(w.name)}" data-answer="${esc(key)}" value="${esc(session.answers[key] || "")}" /></div>`;
      }).join("") : "";
      meta.innerHTML = `<div class="draft-meta-grid">
        <div class="field"><label>花销目的 / 采购事由（整单）</label><input aria-label="采购事由" data-meta="purpose" value="${esc(d.purpose)}" /></div>
        <div class="field"><label>项目</label><select aria-label="项目" data-meta="costCenter">${choices(schema.projects,d.costCenter)}</select></div>
        <div class="field"><label>采购方式</label><select aria-label="采购方式" data-meta="purchaseMethod">${choices(schema.methods.map(m=>m.name),d.purchaseMethod)}</select></div>
        <div class="field"><label>关联审批${d.purchaseMethod==='预付款项' ? '（当前方式隐藏）' : '（整单必填）'}</label>${d.purchaseMethod==='预付款项' ? '<span>无需提交</span>' : `<select aria-label="关联审批" data-meta-budget><option value="">请选择已通过预算</option>${approvedBudgets.map(b=>`<option value="${esc(b.instanceId)}" ${b.instanceId===(session.answers.selectedBudget || {}).instanceId ? 'selected' : ''}>${esc(b.title || b.project)}</option>`).join('')}</select>`}</div>
        ${sharedFields}
        ${method && sharedFields ? [...new Set(method.fields.filter(w=>window.ExpensePolicy.bankRole(w.name)).map(w=>window.ExpensePolicy.bankSide(w.name)))].map(side=>`<button type="button" class="btn btn-secondary" data-open-bank="${side}">点选${side==='ours' ? '我方' : '收款'}银行档案 / 新增</button>`).join('') : ''}
      </div><p class="section-hint">整单信息只填一次。修改采购方式后，点「整理当前清单」应用对应规则；已填写内容会保留。提交前集中预览所有必填项与附件。</p>`;
    }

    if (sheetsEl) {
      sheetsEl.innerHTML = d.detailSheets
        .map((sheet, si) => {
          const rows = sheet.rows
            .map((row, ri) => {
              return `<tr data-si="${si}" data-ri="${ri}">
                <td><input aria-label="日期" data-cell="date" value="${esc(row.date)}" /></td>
                <td><input aria-label="摘要" data-cell="description" value="${esc(row.description)}" /></td>
                <td><input aria-label="发票号码" data-cell="invoiceNo" value="${esc(row.invoiceNo || "")}" /></td>
                <td><input aria-label="金额" data-cell="amount" inputmode="decimal" value="${esc(row.amount)}" /></td>
                <td class="td-inv">${(session.invoices.find(i=>i.id===row.invoiceRef) || {}).attachment ? "原件已保存" : "缺原件 · 实务必填"}</td>
                <td><input aria-label="备注" data-cell="note" value="${esc(row.note || "")}" placeholder="备注" />${purchaseRowFields(row.invoiceRef)}</td>
                <td><button type="button" class="btn btn-ghost btn-sm" data-del-row="${si}:${ri}">删</button></td>
              </tr>`;
            })
            .join("");
          return `<section class="panel sheet-card" data-sheet="${si}">
            <div class="sheet-head">
              <input aria-label="明细表名称" class="sheet-title-input" data-sheet-title="${si}" value="${esc(sheet.title)}" />

            </div>
            <div class="table-wrap">
              <table class="sheet-table">
                <thead><tr><th>日期</th><th>摘要</th><th>发票号码</th><th>金额</th><th>发票</th><th>备注</th><th></th></tr></thead>
                <tbody>${rows || `<tr><td colspan="7" class="muted">暂无行</td></tr>`}</tbody>
              </table>
            </div>
          </section>`;
        })
        .join("");
    }

    recomputeDraftTotal();
    if (totalEl) totalEl.textContent = `合计 ${formatMoney(session.draft.total)}`;
  }

  function recomputeDraftTotal() {
    if (!session.draft) return;
    let t = 0;
    session.draft.detailSheets.forEach((sh) => {
      sh.rows.forEach((r) => {
        t += parseFloat(r.amount) || 0;
      });
    });
    session.draft.total = Math.round(t * 100) / 100;
    const totalEl = document.getElementById("draft-total");
    if (totalEl) totalEl.textContent = `合计 ${formatMoney(session.draft.total)}`;
    save();
  }

  function syncDraftFromDom() {
    if (!session.draft) return;
    const previousMethod=session.answers.purchaseMethod;
    document.querySelectorAll('[data-invoice-field]').forEach(input=>{
      const inv=session.invoices.find(i=>i.id===input.dataset.invoice);
      if(inv) {inv[input.dataset.invoiceField]=input.value;inv._userEdited=true;inv._editedFields={...(inv._editedFields || {}),[input.dataset.invoiceField]:true};}
    });
    document.querySelectorAll("[data-answer]").forEach(input => { session.answers[input.dataset.answer] = input.value; });
    document.querySelectorAll("#draft-meta [data-meta]").forEach((input) => {
      const key = input.getAttribute("data-meta");
      session.draft[key] = input.value;
      session.answers[key] = input.value;
    });
    document.querySelectorAll("[data-sheet-title]").forEach((input) => {
      const si = Number(input.getAttribute("data-sheet-title"));
      if (session.draft.detailSheets[si]) session.draft.detailSheets[si].title = input.value;
    });
    document.querySelectorAll(".sheet-table tbody tr[data-si]").forEach((tr) => {
      const si = Number(tr.getAttribute("data-si"));
      const ri = Number(tr.getAttribute("data-ri"));
      const row = session.draft.detailSheets[si] && session.draft.detailSheets[si].rows[ri];
      if (!row) return;
      tr.querySelectorAll("[data-cell]").forEach((input) => {
        row[input.getAttribute("data-cell")] = input.value;
      });
    });
    queueFillingHistory();
    session.draft.answers = {...session.answers};
    session.draft.detailSheets.forEach(sh => sh.rows.forEach(row => {
      const inv = session.invoices.find(i => i.id === row.invoiceRef);
      if (inv) Object.assign(inv, {date:row.date, merchant:row.description, invoiceNo:row.invoiceNo, amount:row.amount, note:row.note});
    }));
    recomputeDraftTotal();
    if(previousMethod!==session.answers.purchaseMethod) {
      session.prefillEvidence={};session.prefillContext='';
      renderDraft();
    }
  }

  /* ---------- real purchase submission ---------- */

  function purchaseRowFields(invoiceId) {
    const method = ((window.__purchaseSchema || {}).methods || []).find(m=>m.name === session.draft.purchaseMethod);
    if (!method) return "";
    const inv=session.invoices.find(i=>i.id===invoiceId) || {}, auto=window.ExpensePolicy.quantityUnit(inv);
    const quantityFields=method.fields.some(w=>w.name==='数量') ? `<label>数量 · 表单必填<input aria-label="数量" data-invoice="${esc(invoiceId)}" data-invoice-field="quantity" value="${esc(auto.quantity)}" ${auto.batch ? 'readonly' : ''} inputmode="decimal" /></label><label>规格 / 单位 · 表单必填<input aria-label="规格 / 单位" data-invoice="${esc(invoiceId)}" data-invoice-field="unit" value="${esc(auto.unit)}" ${auto.batch ? 'readonly' : ''} /></label>` : '';
    return `<div class="purchase-row-fields">${quantityFields}${method.fields.filter(w=>!["金额","名称","备注","数量","规格","单位"].includes(w.name) && !window.ExpensePolicy.bankRole(w.name)).map(w=>{
      const shared = ["账户名称","银行账户","收款账号","开户支行"].includes(w.name);
      const key = `purchase:${method.name}:${shared ? "shared":invoiceId}:${w.name}`;
      const value = session.answers[key] || "";
      const control = w.options.length ? `<select data-answer="${esc(key)}"><option value="">请选择</option>${value && !w.options.includes(value) ? `<option value="${esc(value)}" selected>已失效：${esc(value)}</option>` : ''}${w.options.map(o=>`<option ${o===value ? "selected":""}>${esc(o)}</option>`).join("")}</select>` : `<input data-answer="${esc(key)}" value="${esc(value)}" />`;
      const evidence=(session.prefillEvidence || {})[key];
      return `<label>${esc(w.name)}${w.required ? " · 表单必填" : ""}${control}<small>${esc(evidence ? evidence.source : "无同类历史 / 待检查")}</small></label>`;
    }).join("")}</div>`;
  }

  function buildFeishuPayload() {
    if (session.stage==="draft") syncDraftFromDom();
    const d = session.draft;
    return {draftId:session.draftId,claim:{purchaseMethod:d.purchaseMethod, purpose:d.purpose, costCenter:d.costCenter,
      invoices:okInvoices().map(({id,date,merchant,invoiceNo,invoiceCode,items,quantity,unit,amount,category,note,fileName,source,attachment})=>({id,date,merchant,invoiceNo,invoiceCode,items,quantity,unit,amount,category,note,fileName,source,attachment})), answers:{...session.answers},
      selectedBudget:session.answers.selectedBudget || null}};
  }

  function reviewIssues(c) {
    const q=window.ExpensePolicy.buildQuestionQueue(c.invoices,c.answers);
    return [...q.map(x=>x.id==='selectBudget' ? '关联审批未选择（表单强制，预付款项除外）' : x.text),
      ...window.ExpensePolicy.rowIssues(c.invoices,c.answers,session.prefillEvidence || {})];
  }

  function previewMarkup(c, issues) {
    const method=((window.__purchaseSchema || {}).methods || []).find(m=>m.name===c.purchaseMethod);
    const rows=c.invoices.map(inv=>{
      const auto=window.ExpensePolicy.quantityUnit(inv);
      const fields=(method ? method.fields : []).map(w=>{
        const bank=window.ExpensePolicy.bankRole(w.name);
        const key=`purchase:${c.purchaseMethod}:${bank ? 'shared' : inv.id}:${w.name}`;
        const value=w.name==='金额' ? formatMoney(inv.amount) : w.name==='名称' ? inv.merchant || inv.fileName : w.name==='数量' ? auto.quantity : ['规格','单位'].includes(w.name) ? auto.unit : w.name==='备注' ? inv.note || '—' : c.answers[key] || '未填';
        return `<li><span>${esc(w.name)}${w.required ? ' · 表单必填' : ''}</span><strong>${esc(value)}</strong></li>`;
      }).join('');
      return `<article class="preview-invoice"><h4>【${esc(c.costCenter)}】${esc(formatMoney(inv.amount))}</h4><p class="muted-sm">日期：${esc(inv.date || '未识别')} · 商户：${esc(inv.merchant || '未识别')}</p><ul class="preview-field-list">${fields}</ul><p class="attachment-check ${inv.attachment ? '' : 'is-missing'}">原件附件 · 产品 / 流程强制：${inv.attachment ? '已保存，提交时重新上传并核对' : '缺失，请返回上传补传'}</p></article>`;
    }).join('');
    return `<div class="submit-stat"><span>采购方式 · 整单必填</span><strong>${esc(c.purchaseMethod || '未填')}</strong></div>
      <div class="submit-stat"><span>项目 · 整单必填</span><strong>${esc(c.costCenter || '未填')}</strong></div>
      <div class="submit-stat"><span>花销目的 / 采购事由 · 整单必填</span><strong>${esc(c.purpose || '未填')}</strong></div>
      <div class="submit-stat"><span>关联审批${c.purchaseMethod==='预付款项' ? ' · 当前方式隐藏' : ' · 表单必填'}</span><strong>${esc(c.purchaseMethod==='预付款项' ? '无需提交' : (c.selectedBudget || {}).title || '未选择')}</strong></div>
      <div class="submit-stat"><span>发票合计</span><strong>${c.invoices.length} 张 · ${esc(formatMoney(c.invoices.reduce((a,i)=>a+Number(i.amount),0)))}</strong></div>
      <div class="preview-checks" role="status">${issues.length ? '<strong>请集中处理以下必填项或冲突</strong><ul>'+issues.map(x=>`<li>${esc(x)}</li>`).join('')+'</ul>' : '表内必填项已齐，请检查下方完整清单。'}<p id="preview-server-status">正在核验当前表单与原件完整性…</p></div>
      <h3>发票清单及对应必填项</h3>${rows}<p class="section-hint">发起后保存本次预填与最终修改的差异；整体审批通过并核验实际预算关联后才参与学习。</p>`;
  }

  async function renderSubmit() {
    const prev=document.getElementById('submit-preview'), button=document.getElementById('btn-feishu-submit');
    button.textContent=session.submitted ? '查看已提交结果' : '确认清单，发起飞书采购申请';
    if(!session.draft) buildDraft();
    const payload=buildFeishuPayload(), c=payload.claim, issues=reviewIssues(c);
    if(prev) prev.innerHTML=previewMarkup(c,issues);
    if(session.submitted) {button.disabled=false;document.getElementById('preview-server-status').textContent='已提交，附件核对结果见提交回执。';return;}
    button.disabled=true;session.reviewContext='';
    const owner=ownerId(), target=session, context=JSON.stringify(payload.claim);
    try {
      const result=await recordsAPI('/api/review','POST',payload);
      if(target!==session || owner!==ownerId() || session.stage!=='submit' || context!==JSON.stringify(buildFeishuPayload().claim)) return;
      session.reviewContext=context;
      button.disabled=issues.length>0;
      document.getElementById('preview-server-status').textContent=`已核验当前表单与 ${result.attachmentCount} 份原件；请检查上述信息及下方清单，确认后发起。`;
    } catch(e) {
      if(target===session && owner===ownerId() && session.stage==='submit') document.getElementById('preview-server-status').textContent='暂不能提交：'+e.message+'。返回清单修改后重新预览。';
    }
  }

  let submitting = false;
  async function submitFeishu() {
    if (submitting) return;
    if (session.submitted) { showResultModal(session.lastFeishu); return; }
    if (!authUser) { showToast("请先用飞书登录"); return; }
    if (okInvoices().some(i=>!i.attachment)) { showToast("还有发票缺少原件，请在识别汇总补传后再提交"); setStage("upload"); return; }
    const payload = buildFeishuPayload();
    const issues=reviewIssues(payload.claim);
    if(issues.length) {showToast('还有必填项或规则冲突，请返回清单集中处理',7000);renderSubmit();return;}
    if(session.reviewContext!==JSON.stringify(payload.claim)) {showToast('请等待预览核验完成');renderSubmit();return;}
    submitting = true;
    document.querySelector("main").inert=true;
    const button = document.getElementById("btn-feishu-submit");
    button.disabled = true;
    button.setAttribute("aria-busy","true");
    button.textContent = "正在发起采购申请…";
    let result;
    try {
      await persistDraft(true);
      payload.draftRevision=session.recordRevision;
    } catch(e) {
      submitting=false;document.querySelector("main").inert=false;button.disabled=false;button.removeAttribute("aria-busy");button.textContent="发起飞书采购申请";
      showToast("请先保存草稿："+e.message,7000);return;
    }
    try {
      const res = await fetch(apiBase() + "/api/feishu-expense", {
        method:"POST", credentials:"include", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)
      });
      result = await res.json();
      if (!res.ok || !result || !result.ok || !result.instanceCode || result.stub) {
        result = {...result, ok:false, error:(result && result.error) || "飞书未确认创建成功"};
      }
    } catch (err) {
      result = {ok:false, error:"未收到飞书创建确认，请先检查飞书「已发起」，重试时会防止重复创建。"};
    } finally {
      submitting = false;
      document.querySelector("main").inert=false;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "发起飞书采购申请";
    }
    session.lastFeishu = result;
    if (result.ok) {session.submitted=true;clearTimeout(saveTimer);}
    save();
    if(result.ok) setSaveStatus(result.historyWarning || "已提交 · 可在我的报销查看历史");
    if (session.stage === "submit") renderSubmit();
    showResultModal(result);
    showToast(result.ok ? "采购申请已发起":"提交未完成，请查看原因");
  }

  function showResultModal(result) {
    const modal = document.getElementById("result-modal");
    const pre = document.getElementById("result-payload");
    const title = document.getElementById("result-title");
    if (title) title.textContent = result.ok ? "采购申请已发起" : "采购申请未完成";
    document.getElementById("btn-close-result-2").textContent=result.ok ? "完成" : "返回检查";
    const links = document.getElementById("result-links");
    if (links) {
      links.replaceChildren();
      const addLink = (label, url) => {
        if (!url || !/^https:\/\//.test(url)) return;
        const a = document.createElement("a"); a.href=url; a.target="_blank"; a.rel="noopener noreferrer"; a.textContent=label; a.className="btn btn-primary"; links.append(a);
      };
      if (result.ok) addLink("打开飞书采购申请", result.approvalUrl);
      else { addLink("开通飞书审批权限", result.permissionUrl); if (result.loginUrl) addLink("重新用飞书登录", new URL(result.loginUrl, location.origin).href); }
    }
    if (pre) pre.textContent = result.ok ? `采购申请已发起\n申请人：${result.initiator}\n审批单号：${result.serialNumber || "同步中"}\n实例编号：${result.instanceCode}\n发票附件：${result.attachmentCount || 0} 个${result.attachmentsConfirmed ? "（飞书侧已确认）" : "（请在飞书核对）"}` : result.error;
    if (modal) modal.hidden = false;
  }

  function hideResultModal() {
    const modal = document.getElementById("result-modal");
    if (modal) modal.hidden = true;
  }

  /* ---------- events ---------- */

  function bind() {
    const dz = document.getElementById("dropzone");
    const input = document.getElementById("file-input");
    document.querySelectorAll('.records-tabs [role="tab"]').forEach(tab=>tab.addEventListener("keydown",event=>{
      if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
      const tabs=[...document.querySelectorAll('.records-tabs [role="tab"]')];
      const index=event.key==="Home" ? 0 : event.key==="End" ? tabs.length-1 : (tabs.indexOf(tab)+(event.key==="ArrowRight" ? 1 : -1)+tabs.length)%tabs.length;
      event.preventDefault();if(!tabs[index].disabled){tabs[index].focus();tabs[index].click();}
    }));

    function openPicker() {
      input.click();
    }
    dz.addEventListener("click", (e) => {
      if (e.target === input) return;
      openPicker();
    });
    dz.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openPicker();
      }
    });
    ["dragenter", "dragover"].forEach((ev) => {
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach((ev) => {
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.remove("is-dragover");
      });
    });
    dz.addEventListener("drop", (e) => {
      handleFiles(e.dataTransfer.files);
    });
    input.addEventListener("change", () => {
      handleFiles(input.files);
      input.value = "";
    });

    document.getElementById("btn-add-more").addEventListener("click", openPicker);
    document.getElementById("btn-start-interview").addEventListener("click", event => window.ExpenseUI.run(event.currentTarget, async () => {
      syncSummaryFromDom();
      if (!window.__purchaseSchema) { showToast("采购表单加载失败，请刷新重试"); return; }
      if (!authUser) { showToast("请先用飞书登录"); return; }
      if (!okInvoices().length || okInvoices().length !== session.invoices.length) {
        showToast("请先核对全部发票金额，或移除不提交的发票");
        renderUpload();
        return;
      }
      session.invoices.forEach((inv) => {
        if (invoiceHasAmount(inv)) inv.confirmed = true;
      });
      session.chat = [];
      session.draft = null;
      save();
      await refreshFillSuggestions(false);
      setStage("interview");
    }, "正在准备问答…"));

    const invoiceList = document.getElementById("invoice-list");
    document.getElementById("invoice-summary-body").addEventListener("click", (event) => {
      const button = event.target.closest("[data-reattach]");
      if (!button) return;
      if (!authUser) { showToast("请先用飞书登录"); return; }
      const inv = session.invoices.find(i=>i.id === button.dataset.reattach);
      if (!inv) return;
      const picker = document.createElement("input"); picker.type="file"; picker.accept="image/*,application/pdf";
      picker.addEventListener("change", async () => {
        const file = picker.files[0]; if (!file) return;
        button.disabled=true;
        try {
          syncSummaryFromDom();
          inv.attachment = await window.__storeInvoiceFile(file,{draftId:session.draftId,invoiceId:inv.id});
          inv.fileName = file.name; save(); showToast("原件已补传，识别汇总中的填写保持不变");
        } catch (err) { showToast(err.message,6000); }
        finally { syncSummaryFromDom(); renderUpload(); }
      });
      picker.click();
    });
    if (invoiceList) {
      invoiceList.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-remove]");
        if (!btn) return;
        syncSummaryFromDom();
        const id = btn.getAttribute("data-remove");
        session.invoices = session.invoices.filter((i) => i.id !== id);
        save();
        renderUpload();
      });
    }
    const summaryEl = document.getElementById("invoice-summary");
    if (summaryEl) {
      summaryEl.addEventListener("input", () => {
        syncSummaryFromDom();
        refreshUploadActions();
      });
      summaryEl.addEventListener("change", () => {
        syncSummaryFromDom();
        refreshUploadActions();
      });
      summaryEl.addEventListener("click", (e) => {
        const retry=e.target.closest("[data-reparse]");
        if(retry) {const inv=session.invoices.find(i=>i.id===retry.dataset.reparse);if(inv) retryStoredOCR(inv);return;}
        const btn = e.target.closest("[data-remove]");
        if (!btn) return;
        syncSummaryFromDom();
        const id = btn.getAttribute("data-remove");
        session.invoices = session.invoices.filter((i) => i.id !== id);
        save();
        renderUpload();
      });
    }

    document.getElementById("btn-back-upload").addEventListener("click", () => setStage("upload"));
    document.getElementById("btn-back-interview").addEventListener("click", () => {document.querySelector('[data-meta="purpose"]').focus();showToast("在这里修改本次花销目的、项目和采购方式；改完可整理当前清单");});
    document.getElementById("btn-back-draft").addEventListener("click", () => setStage("draft"));

    document.getElementById("btn-send-answer").addEventListener("click", () => {
      const inputEl = document.getElementById("chat-input");
      submitAnswer(inputEl.value);
    });
    document.getElementById("chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        document.getElementById("btn-send-answer").click();
      }
    });
    document.getElementById("chip-row").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-chip]");
      if (!chip) return;
      const q = session._currentQuestion;
      if (q) {
        submitAnswer(chip.getAttribute("data-chip"));
      } else {
        document.getElementById("chat-input").value = chip.getAttribute("data-chip");
        document.getElementById("chat-input").focus();
      }
    });
    document.getElementById("btn-skip-optional").addEventListener("click", () => {
      const q = session._currentQuestion;
      if (!q || q.required) return;
      submitAnswer("（跳过）");
    });

    document.getElementById("btn-regen-draft").addEventListener("click", async () => {
      syncDraftFromDom();setStage('interview');
    });
    document.getElementById("btn-goto-submit").addEventListener("click", () => {
      syncDraftFromDom();
      setStage("submit");
    });

    document.getElementById("detail-sheets").addEventListener("input", (e) => {
      if (!e.target.matches("input, select")) return;
      syncDraftFromDom();
    });
    document.getElementById("draft-meta").addEventListener("input", () => syncDraftFromDom());
    document.getElementById("draft-meta").addEventListener("change", event => {
      if(event.target.matches('[data-meta-budget]')) {
        syncDraftFromDom();
        if(event.target.value) selectBudget(event.target.value);
        else {session.answers.selectedBudget=null;session.selectedBudgetId=null;}
        renderDraft();
      }
    });
    document.getElementById("detail-sheets").addEventListener("change", () => syncDraftFromDom());
    document.getElementById("draft-meta").addEventListener("click",event=>{const b=event.target.closest('[data-open-bank]');if(b)openBankProfiles(b.dataset.openBank);});
    document.getElementById('btn-bank-profiles').addEventListener('click',()=>openBankProfiles(bankTargetSide));
    document.getElementById('btn-close-bank-profiles').addEventListener('click',()=>{document.getElementById('bank-profiles-modal').hidden=true;});
    document.getElementById('btn-refresh-bank-profiles').addEventListener('click',event=>window.ExpenseUI.run(event.currentTarget,async()=>{try{await loadBankProfiles();renderBankModal();}catch(e){document.getElementById('bank-profile-error').textContent=e.message;}},'正在读取…'));
    document.getElementById('bank-profile-side').addEventListener('change',()=>{clearBankForm();renderBankModal();});
    document.getElementById('bank-profile-form').addEventListener('submit',saveBankProfile);
    document.getElementById('btn-bank-profile-new').addEventListener('click',clearBankForm);
    document.getElementById('bank-profile-list').addEventListener('click',bankListAction);
    document.getElementById('bank-quick-list').addEventListener('click',bankListAction);
    document.getElementById("detail-sheets").addEventListener("click", (e) => {
      const add = e.target.closest("[data-add-row]");
      if (add) {
        const si = Number(add.getAttribute("data-add-row"));
        session.draft.detailSheets[si].rows.push({
          id: uid("row"),
          date: "",
          description: "",
          invoiceNo: "",
          amount: "",
          hasInvoice: false,
          invoiceRef: "",
          note: "无发票",
        });
        save();
        renderDraft();
        return;
      }
      const del = e.target.closest("[data-del-row]");
      if (del) {
        const [si, ri] = del.getAttribute("data-del-row").split(":").map(Number);
        const removed = session.draft.detailSheets[si].rows.splice(ri, 1)[0];
        if (removed && removed.invoiceRef) session.invoices = session.invoices.filter(i=>i.id !== removed.invoiceRef);
        save();
        renderDraft();
      }
    });

    document.getElementById("btn-feishu-submit").addEventListener("click", () => {
      submitFeishu();
    });
    document.getElementById("btn-close-result").addEventListener("click", hideResultModal);
    document.getElementById("btn-close-result-2").addEventListener("click", hideResultModal);
    document.getElementById("btn-copy-payload").addEventListener("click", async () => {
      const text = document.getElementById("result-payload").textContent || "";
      try {
        await navigator.clipboard.writeText(text);
        showToast("已复制");
      } catch (e) {
        showToast("复制失败");
      }
    });

    const logoutBtn = document.getElementById("btn-logout");
    if (logoutBtn) logoutBtn.addEventListener("click", logout);
    const loginBtn = document.getElementById("btn-feishu-login");
    if (loginBtn) loginBtn.href = loginHref();
    const budgetGrid = document.getElementById("budget-grid");
    if (budgetGrid) {
      budgetGrid.addEventListener("click", (e) => {
        const card = e.target.closest("[data-budget-id]");
        if (!card) return;
        selectBudget(card.getAttribute("data-budget-id"));
      });
    }

    document.getElementById("btn-reset").addEventListener("click", event => window.ExpenseUI.run(event.currentTarget, async () => {
      if(busyEditing()) return;
      try { syncCurrentEditor();await persistDraft(false);clearTimeout(saveTimer);session=emptySession();setStage("upload");showToast("已新建，上份草稿可在我的报销继续"); }
      catch(e) {showToast("请先处理保存问题："+e.message,7000);}
    }, "正在保存上份草稿…"));
    const saveNow=()=>{syncCurrentEditor();return persistDraft(true).catch(e=>showToast(e.message,7000));};
    document.getElementById("btn-save-draft").addEventListener("click",event=>window.ExpenseUI.run(event.currentTarget,saveNow,"正在保存…"));
    document.getElementById("btn-retry-save").addEventListener("click",event=>window.ExpenseUI.run(event.currentTarget,session.saveConflict ? openRecords : saveNow,"正在处理…"));
    document.getElementById("btn-ai-remind-configure").addEventListener("click",openAiSettings);
    document.getElementById("btn-ai-remind-later").addEventListener("click",()=>{document.getElementById("ai-first-use-modal").hidden=true;});
    document.getElementById("btn-ai-settings").addEventListener("click",openAiSettings);
    document.getElementById("btn-close-ai-settings").addEventListener("click",closeAiSettings);
    const jevControls=["btn-save-jev","btn-test-jev","btn-clear-jev"].map(id=>document.getElementById(id));
    [["btn-save-jev","PUT",false],["btn-test-jev","POST",false],["btn-clear-jev","PUT",true]].forEach(([id,method,clear])=>{
      document.getElementById(id).addEventListener("click",event=>window.ExpenseUI.run(event.currentTarget,()=>updateJevSettings(method,clear),"正在处理…",jevControls));
    });
    const aiControls=["btn-save-ai","btn-test-ai","btn-clear-ai"].map(id=>document.getElementById(id));
    [["btn-save-ai",saveAiSettings,"正在保存…"],["btn-test-ai",testAiSettings,"正在测试…"],["btn-clear-ai",clearAiSettings,"正在清除…"]].forEach(([id,action,label])=>{
      document.getElementById(id).addEventListener("click",event=>window.ExpenseUI.run(event.currentTarget,action,label,aiControls));
    });
    document.getElementById("btn-records").addEventListener("click",openRecords);
    document.getElementById("btn-import-legacy").addEventListener("click",importLegacy);
    document.getElementById("btn-close-records").addEventListener("click",()=>{document.getElementById("records-modal").hidden=true;});
    document.getElementById("btn-refresh-records").addEventListener("click",()=>refreshRecords());
    document.getElementById("btn-more-records").addEventListener("click",()=>refreshRecords(true));
    document.getElementById("records-list").addEventListener("click",recordAction);
    document.querySelectorAll("[data-record-tab]").forEach(b=>b.addEventListener("click",async()=>{
      if(recordsLoading) return;
      recordsTab=b.dataset.recordTab;
      document.querySelectorAll("[data-record-tab]").forEach(t=>{t.setAttribute("aria-selected",String(t===b));t.classList.toggle("btn-secondary",t===b);t.classList.toggle("btn-ghost",t!==b);});
      document.getElementById("record-detail").hidden=true;
      await refreshRecords();
    }));
    document.getElementById("chat-input").addEventListener("input",e=>{session.composerText=e.target.value;save();});
    window.addEventListener("pagehide",()=>{save();});
  }

  function selectBudget(id) {
    if(session.submitted || submitting) return;
    const b = approvedBudgets.find((x) => x.instanceId === id || x.instanceCode === id);
    if (!b) return;
    session.selectedBudgetId = b.instanceId;
    session.answers.costCenter = b.project || b.title || "";
    session.answers.selectedBudgetId = b.instanceId;
    session.answers.selectedBudget = {
      instanceId: b.instanceId,
      approvalName: b.approvalName,
      approvalCode: b.approvalCode,
      project: b.project,
      title: b.title,
      totalAmount: b.totalAmount,
      subjects: b.subjects || [],
    };
    if (b.project) session.answers.purchaseProject = b.project;
    queueFillingHistory();
    if (session.draft) session.draft.costCenter = session.answers.costCenter;
    save();
    renderBudgets();
    showToast("已选择预算：" + (b.project || b.title || ""));
  }

  function renderBudgets() {
    const box = document.getElementById("budget-picker");
    const grid = document.getElementById("budget-grid");
    const hint = document.getElementById("budget-picker-hint");
    const pill = document.getElementById("budget-count-pill");
    const refresh = document.getElementById("btn-refresh-budgets");
    const status = document.getElementById("budget-refresh-status");
    if (refresh) {
      refresh.disabled = budgetsLoading;
      refresh.textContent = budgetsLoading ? "刷新中…" : "刷新预算";
      refresh.setAttribute("aria-busy", String(budgetsLoading));
    }
    if (status) status.textContent = authUser ? (budgetsLoading ? "正在刷新预算…" : budgetRefreshMessage) : "";
    if (!box || !grid) return;
    box.hidden = false;
    if (!authUser) {
      budgetsLoading = false;
      if (pill) pill.textContent = "0";
      if (hint) hint.textContent = "用飞书登录后，这里会列出你已通过的立项 / 变更预算，点选即可带进问答。";
      grid.innerHTML = `<a class="btn btn-primary" href="${esc(loginHref())}">用飞书登录</a>`;
      return;
    }
    if (budgetAuthExpiredOwner === ownerId()) {
      if (pill) pill.textContent = "0";
      if (hint) hint.textContent = "飞书登录已过期或账号已变更，请重新登录后刷新预算。";
      grid.innerHTML = `<a class="btn btn-primary" href="${esc(loginHref())}">重新用飞书登录</a>`;
      return;
    }
    if (budgetsLoading && !approvedBudgets.length && !budgetWarning) {
      if (pill) pill.textContent = "…";
      if (hint) hint.textContent = "正在加载可用预算…";
      grid.innerHTML = `<p class="budget-empty is-loading">正在加载可用预算…</p>`;
      return;
    }
    if (pill) pill.textContent = String(approvedBudgets.length);
    if (budgetWarning) {
      if (hint) hint.textContent = budgetWarning;
      if (!approvedBudgets.length) {
        grid.innerHTML = `<p class="budget-empty">${esc(budgetWarning)}</p>`;
        return;
      }
    }
    if (!approvedBudgets.length) {
      if (hint) hint.textContent = "没有可用的已通过预算；除预付款项外，须先在飞书完成预算审批。";
      grid.innerHTML = `<p class="budget-empty">暂无已通过的立项 / 变更预算。<span class="empty-next">去飞书完成预算审批后，点刷新或重新登录即可出现在这里。</span></p>`;
      return;
    }
    if (hint && !budgetWarning) hint.textContent = "点选一条已通过的预算，问答会自动带上项目，不必再手填。";
    const html = approvedBudgets
      .map((b) => {
        const selected = session.selectedBudgetId === b.instanceId;
        const amt = b.totalAmount != null ? formatMoney(b.totalAmount) : "";
        const subjects = (b.subjects || [])
          .map((s) => s.name)
          .filter(Boolean)
          .slice(0, 4)
          .join("、");
        const kindLabel = b.kindLabel || ({ init: "立项", change: "变更" }[b.kind] || b.approvalName || "");
        return `<button type="button" class="budget-card${selected ? " is-selected" : ""}" data-budget-id="${esc(b.instanceId)}" aria-pressed="${selected}">
        <span class="budget-card-kind">${esc(kindLabel)}</span>
        <strong class="budget-card-title">${esc(b.project || b.title || "未命名项目")}</strong>
        <span class="budget-card-meta">${esc([amt, subjects, b.startTime].filter(Boolean).join(" · "))}</span>
      </button>`;
      })
      .join("");
    // Unchanged polls must not replace focused buttons or reset the card's scroll.
    if (grid.innerHTML !== html) {
      const scroll = grid.scrollTop;
      const focused = document.activeElement && document.activeElement.getAttribute('data-budget-id');
      grid.innerHTML = html;
      grid.scrollTop = scroll;
      if (focused) {
        const button = [...grid.querySelectorAll('[data-budget-id]')].find(b=>b.dataset.budgetId===focused);
        if(button)button.focus({preventScroll:true});
      }
    }
  }

  function renderAuth() {
    const loginBtn = document.getElementById("btn-feishu-login");
    const userEl = document.getElementById("auth-user");
    const nameEl = document.getElementById("auth-name");
    const av = document.getElementById("auth-avatar");
    if (authUser) {
      if (loginBtn) loginBtn.hidden = true;
      if (userEl) userEl.hidden = false;
      if (nameEl) nameEl.textContent = authUser.name || "飞书用户";
      if (av) {
        if (authUser.avatar) {
          av.src = authUser.avatar;
          av.hidden = false;
        } else {
          av.removeAttribute("src");
          av.hidden = true;
        }
      }
    } else {
      if (loginBtn) {
        loginBtn.hidden = false;
        loginBtn.href = loginHref();
      }
      if (userEl) userEl.hidden = true;
    }
  }

  function normalizeAiBaseUrl(url) {
    url = (url || "").trim().replace(/\/+$/, "");
    if (/^https:\/\/api\.deepseek\.com$/i.test(url)) return "https://api.deepseek.com/v1";
    return url;
  }

  function aiSettingsForm() {
    return {
      baseUrl: normalizeAiBaseUrl(document.getElementById("ai-base-url").value || ""),
      apiKey: (document.getElementById("ai-api-key").value || "").trim(),
      textModel: (document.getElementById("ai-text-model").value || "").trim(),
      visionModel: (document.getElementById("ai-vision-model").value || "").trim(),
    };
  }

  function setAiMessage(text, ok) {
    const el = document.getElementById("ai-settings-message");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-ok", !!ok && !!text);
    el.classList.toggle("is-err", !ok && !!text);
  }

  // Page-memory only. A fresh login/refresh always checks this account again.
  function setAiSetupStatus(data, owner, changed = false) {
    if (!owner || owner !== ownerId()) return;
    aiSetupOwner = owner;
    aiSetupConfigured = !window.ExpenseUI.needsAiSetup(data);
    if (changed) aiSetupEpoch++; // A write supersedes older in-flight reads.
    if (aiSetupConfigured) document.getElementById("ai-first-use-modal").hidden = true;
  }

  async function checkAiSetup(remind) {
    const owner = ownerId(), epoch = aiSetupEpoch;
    if (!owner) return null;
    try {
      const res = await fetch(apiBase() + "/api/ai-settings", {
        credentials:"include", cache:"no-store", signal:AbortSignal.timeout(10000)
      });
      const data = await res.json();
      if (owner !== ownerId() || epoch !== aiSetupEpoch) return null;
      if (!res.ok || !data.ok) throw new Error(data.error || "读取失败");
      setAiSetupStatus(data, owner);
      if (remind && !aiSetupConfigured) {
        if (!document.querySelector('.modal-backdrop:not([hidden])')) document.getElementById("ai-first-use-modal").hidden = false;
        else showToast("请在 AI 设置填写自己的 API，推荐 Deepseek；不会使用其他人的密钥",7000);
      }
      return aiSetupConfigured;
    } catch (e) {
      if (owner === ownerId() && epoch === aiSetupEpoch) showToast("暂时无法核对 AI 设置，请在 AI 设置中重试；仍可使用本机 OCR",7000);
      return null;
    }
  }

  function remindAiOnUpload() {
    const owner=ownerId();
    const notify=()=>showToast("尚未填写自己的 AI API：请打开 AI 设置，推荐 Deepseek。现在继续使用本机 OCR / 校对，不会使用他人的密钥。",9000);
    if (aiSetupOwner===owner && aiSetupConfigured===false) notify();
    else if (aiSetupOwner!==owner || aiSetupConfigured==null) {
      // A slow settings endpoint must not delay queuing or uploading originals.
      checkAiSetup(false).then(configured=>{
        if (configured===false && owner===ownerId() && aiSetupConfigured===false) notify();
      });
    }
  }

  function openAiSettings() {
    if (!authUser) {
      showToast("请先用飞书登录，再填写自己的 AI 接口（推荐 Deepseek）");
      return;
    }
    document.getElementById("ai-first-use-modal").hidden = true;
    document.getElementById("ai-settings-modal").hidden = false;
    loadAiSettings();
    loadJevSettings();
  }

  let jevSettingsEpoch=0;
  function setJevMessage(text, ok=true) {
    const el=document.getElementById("jev-settings-message");
    if(el){el.textContent=text;el.classList.toggle("is-err",!ok);}
  }
  async function loadJevSettings() {
    const owner=ownerId(), epoch=jevSettingsEpoch;
    setJevMessage("正在读取 Jev 设置…");
    try {
      const res=await fetch(apiBase()+"/api/jev-settings",{credentials:"include",cache:"no-store",signal:AbortSignal.timeout(10000)});
      const data=await res.json();
      if(owner!==ownerId() || epoch!==jevSettingsEpoch)return;
      if(!res.ok || !data.ok)throw new Error(data.error || "Jev 设置读取失败");
      const s=data.settings || {};
      const isOwner = !!data.isOrgOwner;
      const orgShared = !!data.orgShared;
      const formEl = document.getElementById("jev-settings-form");
      const actionsEl = document.getElementById("jev-actions");
      const keyEl = document.getElementById("jev-api-key");
      const baseUrlEl = document.getElementById("jev-base-url");
      const modelEl = document.getElementById("jev-model");
      const btnSave = document.getElementById("btn-save-jev");
      const btnTest = document.getElementById("btn-test-jev");
      const btnClear = document.getElementById("btn-clear-jev");

      if (!isOwner) {
        if (formEl) formEl.hidden = true;
        if (actionsEl) actionsEl.hidden = true;
        if (keyEl) { keyEl.disabled = true; keyEl.value = ""; }
        if (baseUrlEl) baseUrlEl.disabled = true;
        if (modelEl) modelEl.disabled = true;
        if (btnSave) btnSave.hidden = true;
        if (btnTest) btnTest.hidden = true;
        if (btnClear) btnClear.hidden = true;
        if (orgShared) {
          setJevMessage("团队已共用 Jev，封闭选项将自动优化，无需填写密钥。");
        } else {
          setJevMessage("团队暂未配置 Jev，封闭选项继续使用你的文本模型或本机 Ollama。");
        }
      } else {
        if (formEl) formEl.hidden = false;
        if (actionsEl) actionsEl.hidden = false;
        if (keyEl) keyEl.disabled = false;
        if (baseUrlEl) baseUrlEl.disabled = false;
        if (modelEl) modelEl.disabled = false;
        if (btnSave) btnSave.hidden = false;
        if (btnTest) btnTest.hidden = false;
        if (btnClear) btnClear.hidden = false;
        if (baseUrlEl) baseUrlEl.value = s.baseUrl || "https://api.typesafe.ai";
        if (modelEl) modelEl.value = s.model || "jev-latest";
        if (keyEl) {
          keyEl.value = "";
          keyEl.placeholder = s.hasApiKey ? ("已保存 " + s.apiKeyMasked + "（留空保留）") : "填写团队管理员的 TypeSafe API Key";
        }
        setJevMessage(data.configured ? "Jev 已配置，团队成员将共用此服务提建议。" : "Jev 未配置，封闭选项继续使用文本模型或本机 Ollama。");
      }
    } catch(e) {if(owner===ownerId() && epoch===jevSettingsEpoch)setJevMessage(e.message || "读取失败，请重开设置重试",false);}
  }
  async function updateJevSettings(method, clear) {
    if(clear && !confirm("只清除本团队的 Jev 设置？DeepSeek 设置会保留。"))return;
    const owner=ownerId(), epoch=++jevSettingsEpoch;
    setJevMessage(method==="POST" ? "正在测试 Jev 连接…" : "正在保存…");
    try {
      const baseUrlEl = document.getElementById("jev-base-url");
      const keyEl = document.getElementById("jev-api-key");
      const modelEl = document.getElementById("jev-model");
      const res=await fetch(apiBase()+"/api/jev-settings"+(method==="POST" ? "/test" : ""),{
        method,credentials:"include",headers:{"Content-Type":"application/json"},signal:AbortSignal.timeout(20000),
        body:JSON.stringify(clear ? {clear:true} : {
          baseUrl: baseUrlEl ? baseUrlEl.value : "",
          apiKey: keyEl ? keyEl.value.trim() : "",
          model: modelEl ? modelEl.value : ""
        })
      });
      const data=await res.json();
      if(owner!==ownerId() || epoch!==jevSettingsEpoch)return;
      if(!res.ok || !data.ok)throw new Error(data.error || "Jev 操作失败，请重试");
      if(method!=="POST") {
        choiceCache.clear();choiceRequestKey="";window.__choiceSuggestions=null;
        await loadJevSettings();
        if(session.stage==="interview")refreshChoiceSuggestions();
      }
      setJevMessage(method==="POST" ? "Jev 连接成功" : clear ? "Jev 设置已清除，继续使用文本模型 / 本机回退。" : "Jev 已保存，团队全员已共用 Jev。");
    } catch(e) {if(owner===ownerId() && epoch===jevSettingsEpoch)setJevMessage(e.message || "操作失败，请重试",false);}
  }

  function closeAiSettings() {
    const modal = document.getElementById("ai-settings-modal");
    if (modal) modal.hidden = true;
  }

  async function loadAiSettings() {
    const owner=ownerId(), epoch=aiSetupEpoch;
    setAiMessage("正在读取…", true);
    try {
      const res = await fetch(apiBase() + "/api/ai-settings", {
        credentials: "include",
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error((data && data.error) || "读取失败");
      if (owner !== ownerId() || epoch !== aiSetupEpoch) return;
      setAiSetupStatus(data, owner);
      const s = data.settings || {};
      const d = data.defaults || {};
      const base = document.getElementById("ai-base-url");
      const key = document.getElementById("ai-api-key");
      const model = document.getElementById("ai-text-model");
      const vision = document.getElementById("ai-vision-model");
      if (base) {
        base.placeholder = d.baseUrl || "https://api.deepseek.com/v1";
        base.value = s.baseUrl || "";
      }
      if (model) {
        model.placeholder = d.textModel || "deepseek-chat";
        model.value = s.textModel || "";
      }
      if (vision) vision.value = s.visionModel || "";
      if (key) {
        key.value = "";
        key.placeholder = s.hasApiKey
          ? ("已保存 " + (s.apiKeyMasked || "sk-***"))
          : "在 Deepseek 开放平台申请后粘贴";
      }
      const hint = document.getElementById("ai-key-hint");
      if (hint) {
        hint.textContent = s.hasApiKey
          ? ("当前密钥：" + s.apiKeyMasked + "（留空保存则不更改）")
          : "密钥只保存在服务器，页面不会再次显示原文";
      }
      if (data.needsReenterKey) {
        setAiMessage(data.message || "无法解密已保存的 API Key，请重新填写", false);
      } else {
        setAiMessage(
          data.configured
            ? "已配置，字段校对将使用你的接口（推荐 Deepseek）"
            : "尚未配置，将尝试本机校对；推荐填写 Deepseek",
          true
        );
      }
    } catch (e) {
      setAiMessage((e && e.message) || "读取失败", false);
    }
  }

  async function saveAiSettings() {
    const owner=ownerId();
    setAiMessage("正在保存…", true);
    try {
      const res = await fetch(apiBase() + "/api/ai-settings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(aiSettingsForm()),
      });
      const data = await res.json();
      if (owner !== ownerId()) return;
      if (!res.ok || !data.ok) throw new Error((data && data.error) || "保存失败");
      setAiSetupStatus(data, owner, true);
      choiceCache.clear();choiceRequestKey="";window.__choiceSuggestions=null;
      const key = document.getElementById("ai-api-key");
      if (key) key.value = "";
      await loadAiSettings();
      setAiMessage("已保存。字段校对 / 文本 AI 将使用该接口。", true);
      if(session.stage==="interview")refreshChoiceSuggestions();
      showToast("AI 设置已保存");
    } catch (e) {
      setAiMessage((e && e.message) || "保存失败", false);
    }
  }

  async function testAiSettings() {
    setAiMessage("正在测试连接…", true);
    try {
      const res = await fetch(apiBase() + "/api/ai-settings/test", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(aiSettingsForm()),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error((data && data.error) || "测试失败");
      setAiMessage("连接成功" + (data.preview ? "（" + data.preview + "）" : ""), true);
      showToast("AI 接口连接成功");
    } catch (e) {
      setAiMessage((e && e.message) || "测试失败", false);
    }
  }

  async function clearAiSettings() {
    const owner=ownerId();
    if (!window.confirm("清除后将改回本机校对（若可用）。确定？")) return;
    try {
      const res = await fetch(apiBase() + "/api/ai-settings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear: true }),
      });
      const data = await res.json();
      if (owner !== ownerId()) return;
      if (!res.ok || !data.ok) throw new Error((data && data.error) || "清除失败");
      setAiSetupStatus(data, owner, true);
      choiceCache.clear();choiceRequestKey="";window.__choiceSuggestions=null;
      ["ai-base-url", "ai-api-key", "ai-text-model", "ai-vision-model"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      });
      await loadAiSettings();
      setAiMessage("已清除，未配置时将尝试本机校对", true);
      showToast("已清除 AI 设置");
    } catch (e) {
      setAiMessage((e && e.message) || "清除失败", false);
    }
  }

  function resetBudgets() {
    if(budgetRequest)budgetRequest.controller.abort();
    budgetRequest=null;budgetDataOwner=null;budgetAuthExpiredOwner=null;
    budgetLastAttempt=0;budgetRefreshMessage="";budgetsLoading=false;budgetWarning="";
    approvedBudgets=[];window.__approvedBudgets=[];
  }

  function loadBudgets({manual=false}={}) {
    if (!authUser) {
      resetBudgets();
      renderBudgets();
      return Promise.resolve();
    }
    const owner=ownerId();
    if(budgetRequest && budgetRequest.owner===owner)return budgetRequest.promise;
    if(budgetAuthExpiredOwner===owner && !manual)return Promise.resolve();
    if(budgetDataOwner!==owner)resetBudgets();
    budgetDataOwner=owner;
    const request={owner,controller:new AbortController(),promise:null};
    budgetRequest=request;
    const current=()=>budgetRequest===request && owner===ownerId();
    budgetLastAttempt=Date.now();
    budgetsLoading = true;
    budgetWarning = "";
    renderBudgets();
    request.promise=(async()=>{try {
      const res = await fetch(apiBase() + "/api/budgets?refresh=1", {
        credentials: "include",
        cache: "no-store",
        signal:AbortSignal.any([request.controller.signal,AbortSignal.timeout(20000)]),
      });
      const data = await res.json();
      if(!current())return;
      if(res.status===401 || data.loggedIn===false || (data.user && data.user.openId && data.user.openId!==owner)) {
        budgetAuthExpiredOwner=owner;
        approvedBudgets=[];window.__approvedBudgets=[];
        budgetRefreshMessage="登录已过期，请重新登录";
        return;
      }
      if(!res.ok || !data.ok || !Array.isArray(data.budgets))
        throw new Error(data.error || data.warning || "预算读取失败，请检查网络并点刷新预算重试");
      budgetAuthExpiredOwner=null;
      budgetRefreshMessage="预算已更新";
      approvedBudgets = data.budgets;
      window.__approvedBudgets = approvedBudgets;
    } catch (e) {
      if(!current())return;
      budgetWarning = e.message || "预算读取失败，请检查网络并刷新重试";
      budgetRefreshMessage=approvedBudgets.length ? "刷新失败，保留上次列表；请点刷新预算重试" : "刷新失败，请点刷新预算重试";
    } finally {
      if(current()) {budgetRequest=null;budgetsLoading=false;renderBudgets();}
    }})();
    return request.promise;
  }

  function refreshVisibleBudgets() {
    if(document.visibilityState==='hidden' || !authUser || budgetAuthExpiredOwner===ownerId())return;
    if(Date.now()-budgetLastAttempt<BUDGET_FOCUS_DEBOUNCE_MS)return;
    return loadBudgets();
  }

  function bindBudgetFreshness() {
    if(budgetRefreshBound)return;
    budgetRefreshBound=true;
    document.getElementById('btn-refresh-budgets').addEventListener('click',()=>{
      if(!authUser){showToast('请先用飞书登录，再刷新预算');return;}
      loadBudgets({manual:true});
    });
    document.addEventListener('visibilitychange',refreshVisibleBudgets);
    window.addEventListener('focus',refreshVisibleBudgets);
    window.addEventListener('pageshow',refreshVisibleBudgets);
    setInterval(refreshVisibleBudgets,BUDGET_REFRESH_INTERVAL_MS);
  }

  async function refreshAuth() {
    const loginBtn = document.getElementById("btn-feishu-login");
    if (loginBtn) loginBtn.href = loginHref();
    try {
      const res = await fetch(apiBase() + "/api/auth/me", {
        credentials: "include",
        cache: "no-store",
      });
      const data = await res.json();
      authUser = data && data.loggedIn ? data.user : null;
    } catch (e) {
      authUser = null;
    }
    renderAuth();
    if (authUser) {
      budgetAuthExpiredOwner=null;
      aiSetupOwner=ownerId();aiSetupConfigured=null;aiSetupEpoch++;
      checkAiSetup(true);
      // Do not block login toast / page paint on slow budget listing.
      loadBudgets();
    } else {
      aiSetupOwner=null;aiSetupConfigured=null;aiSetupEpoch++;
      document.getElementById("ai-first-use-modal").hidden=true;
      resetBudgets();
      renderBudgets();
    }
  }

  async function logout() {
    if(busyEditing()) return;
    try { syncCurrentEditor();await persistDraft(false);await saveQueue; } catch(e) {showToast("请先保存草稿再退出："+e.message,7000);return;}
    try {
      await fetch(apiBase() + "/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch (e) {}
    clearTimeout(saveTimer);clearTimeout(fillingTimer);
    readyToSave=false;session=emptySession();
    document.getElementById("records-modal").hidden=true;
    const aiModal = document.getElementById("ai-settings-modal");
    if (aiModal) aiModal.hidden = true;
    authUser = null;
    resetBudgets();
    bankProfiles=[];bankProfilesOwner=null;document.getElementById('bank-profiles-modal').hidden=true;
    aiSetupOwner=null;aiSetupConfigured=null;aiSetupEpoch++;
    document.getElementById("ai-first-use-modal").hidden=true;
    window.__fillSuggestions=null;
    window.__choiceSuggestions=null;choiceCache.clear();choiceRequestKey="";jevSettingsEpoch++;
    setStage("upload");
    setSaveStatus("已退出，登录后可在我的报销继续草稿");
    budgetsLoading = false;
    budgetWarning = "";
    approvedBudgets = [];
    window.__approvedBudgets = [];
    renderAuth();
    renderBudgets();
    showToast("已退出飞书登录");
  }

  function consumeAuthQuery() {
    const params = new URLSearchParams(location.search);
    let dirty = false;
    if (params.get("logged_in") === "1") {
      showToast("飞书登录成功");
      params.delete("logged_in");
      dirty = true;
    }
    const authErr = params.get("auth_error");
    if (authErr) {
      showToast("飞书登录失败：" + authErr);
      params.delete("auth_error");
      dirty = true;
    }
    if (dirty) {
      const q = params.toString();
      history.replaceState({}, "", location.pathname + (q ? "?" + q : "") + location.hash);
    }
  }

  async function init() {
    window.ExpenseUI.bindDialogs(document);
    bind();
    bindBudgetFreshness();
    consumeAuthQuery();
    try {
      const res = await fetch(apiBase() + "/api/purchase-schema", {cache:"no-store"});
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "采购表单加载失败");
      window.__purchaseSchema = data;
    } catch (err) { showToast(err.message, 10000); }
    await refreshAuth();
    await load();
    readyToSave=true;
    await refreshFillSuggestions(false);
    // restore stage
    const stage = session.stage || "upload";
    if (stage === "interview" && !okInvoices().length) session.stage = "upload";
    if (stage === "draft" && !session.draft && !okInvoices().length) session.stage = "upload";
    setStage(session.stage || "upload");
    document.getElementById("chat-input").value=session.composerText || "";
    if (session.submitted) setSaveStatus("已提交 · 可在我的报销查看历史");
    // Do not await: resume runs in background so the UI stays interactive.
    resumeIncompleteOCR().catch((e)=>showToast(e.message||String(e),7000));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
