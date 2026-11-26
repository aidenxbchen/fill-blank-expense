/** Purchase interview: the live Feishu definition decides required fields. */
(function (global) {
  "use strict";
  const CAT_LABEL = {lodging:"住宿", meal:"餐饮", entertainment:"招待", purchase:"采购", transit:"交通", gift:"礼品", other:"其他"};
  const POLICY = {name:"飞书采购申请", version:3};
  const present = v => v != null && String(v).trim() && v !== "（跳过）";

  /** Prefer fileName stem like 餐饮/服装/鞋类 from 品类-MMDD-金额.pdf; else CAT_LABEL; else 这笔. */
  function invoiceItemName(inv) {
    const name = String((inv && inv.fileName) || "").trim();
    const m = name.match(/^([^-\/]+)-\d{4}-\d+(?:\.\d+)?(?:\.[^.]+)?$/);
    if (m && m[1]) return m[1];
    const cat = inv && inv.category;
    if (cat && CAT_LABEL[cat]) return CAT_LABEL[cat];
    return "这笔";
  }

  function invoiceAmountLabel(inv) {
    const amount = Number(inv && inv.amount);
    return Number.isFinite(amount) ? `¥${amount.toFixed(2)}` : "";
  }

  /** Short MM-DD from inv.date when needed to disambiguate identical item+amount. */
  function invoiceShortDate(inv) {
    const d = String((inv && inv.date) || "").trim();
    const iso = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[2]}-${iso[3]}`;
    const md = d.match(/^(\d{1,2})-(\d{1,2})$/);
    if (md) return `${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`;
    return "";
  }

  /** Referent for Q&A: 项目名称 + 金额 only. Never 尾号 / 第 N 张 / merchant. */
  function invoiceReferent(inv, invoices) {
    return invoiceAmountLabel(inv) || '这笔采购';
  }

  function quantityUnit(inv) {
    const items=Array.isArray(inv.items) ? inv.items : [];
    if(items.length>1) return {quantity:1,unit:'份/批',batch:true};
    const row=items[0] || inv, quantity=Number(inv.quantity || row.quantity), unit=inv.unit || row.unit;
    return {quantity:Number.isFinite(quantity)&&quantity>0 ? quantity : 1,unit:unit || '份/批',batch:false};
  }
  function restoreInvoiceQuantities(invoices,answers) {
    const method=answers.purchaseMethod;
    for(const inv of invoices || []) {
      if((inv.items || []).length || inv.quantity!=null || inv.unit)continue;
      const q=Number(answers[`purchase:${method}:${inv.id}:数量`]);
      const unit=answers[`purchase:${method}:${inv.id}:单位`] || answers[`purchase:${method}:${inv.id}:规格`];
      if(Number.isFinite(q) && q>0 && unit) {inv.quantity=q;inv.unit=unit;inv.quantityMode='legacy';}
    }
  }
  function bankRole(name) {
    if(/户名|账户名称/.test(name))return 'holder';
    if(/开户|支行|银行名称/.test(name))return 'bank';
    if(/账号|银行账户|付款账户/.test(name))return 'account';
    return '';
  }
  function bankSide(name) {return /我方|付款/.test(name) ? 'ours' : 'counterparty';}
  function applyBankProfile(method, answers, profile, side='counterparty') {
    for(const w of method.fields) {
      const role=bankRole(w.name);
      if(role && bankSide(w.name)===side) answers[`purchase:${method.name}:shared:${w.name}`]=String(profile.fields[role] || '');
    }
    return answers;
  }
  function buildQuestionQueue(invoices, answers) {
    answers = answers || {};
    const schema = global.__purchaseSchema;
    if (!schema) return [{id:"schemaUnavailable", text:"采购表单暂未加载，请返回首页重试。", required:true}];
    const q = [];
    const learned = global.__fillSuggestions || {global:{},rows:{}};
    const choices = global.__choiceSuggestions || {global:{},rows:{}};
    function ordered(chips, history, strict) {
      history = (history || []).filter(h=>!strict || chips.includes(h.value));
      const values = [...history.map(h=>h.value), ...chips];
      return {chips:[...new Set(values)], recommended:history[0] || null};
    }
    function ask(id, text, chips, hint) {
      const v = answers[id];
      if (present(v) && (!chips || !chips.length || chips.includes(v))) return;
      const rank = ordered(chips || [], [...((choices.global || {})[id] || []), ...((learned.global || {})[id] || [])], Boolean(chips && chips.length));
      q.push({id, text, ...rank, hint:hint || "", required:true, input:rank.chips.length ? "chips+text":"text", options:chips || []});
    }
    ask("purpose", "这次花销的目的是什么？", [], "说明本次用途；例如研发试制、招聘沟通或哪段出差，后续按这个事实整理整单。");
    ask("purchaseMethod", "这次整单用哪种采购方式？", schema.methods.map(m=>m.name));
    ask("costCenter", "这笔采购属于哪个项目？", schema.projects, "已选预算的项目会自动带入；名称不一致时请选实际项目。");
    const method = schema.methods.find(m=>m.name === answers.purchaseMethod);
    if (!method) return q;
    for (const side of ['counterparty','ours']) {
      const fields=method.fields.filter(w=>bankRole(w.name) && bankSide(w.name)===side);
      if(fields.some(w=>w.required && !present(answers[`purchase:${method.name}:shared:${w.name}`])))
        q.push({id:`bank:${method.name}:${side}`,text:side==='ours' ? '这次采购使用哪份我方银行档案？' : '这次采购使用哪份收款银行档案？',hint:'账号和开户行成对录入；可点选共享档案，或新增并保存。',input:'bank-profile',bankSide:side,required:true,chips:[]});
    }
    // Row-specific choices are edited together in the invoice list, never asked in chat.
    return q;
  }
  function rowIssues(invoices, answers, evidence={}) {
    const schema=global.__purchaseSchema;
    const method=schema && schema.methods.find(m=>m.name===answers.purchaseMethod);
    if(!method) return [];
    const issues=[];
    for(const inv of invoices) {
      const label=`【${answers.costCenter || '待选项目'}】${invoiceAmountLabel(inv)}`;
      const amount=Number(inv.amount);
      if(!Number.isFinite(amount) || amount<=0 || Math.abs(amount*100-Math.round(amount*100))>0.00001) issues.push(`${label}：金额须大于零且最多两位小数`);
      if(!inv.attachment) issues.push(`${label}：缺少原件附件（产品 / 流程强制）`);
      if(inv.source==='mock') issues.push(`${label}：模拟发票不能提交`);
      for(const w of method.fields) {
        if(bankRole(w.name)) continue;
        const key=`purchase:${method.name}:${inv.id}:${w.name}`;
        const auto=quantityUnit(inv);
        const v=w.name==='金额' ? inv.amount : w.name==='名称' ? inv.merchant || inv.fileName : w.name==='数量' ? auto.quantity : ['规格','单位'].includes(w.name) ? auto.unit : answers[key];
        if(w.required && !present(v)) issues.push(`${label}：缺少${w.name}（表单强制）`);
        else if(present(v) && w.options && w.options.length && !w.options.includes(v)) issues.push(`${label}：${w.name}不在当前飞书选项中`);
        const rule=evidence[key];
        if(rule && rule.hard && rule.suggested && present(v) && v!==rule.suggested) issues.push(`${label}：${w.name}与手册规则冲突，应为「${rule.suggested}」；保留了你的修改，请集中核对`);
      }
    }
    return issues;
  }
  function mergePrefill(answers, result, requested) {
    // A late response must not replace a value edited while the request was in flight.
    for(const [key,value] of Object.entries(result.answers || {})) {
      if(key.startsWith('purchase:') && !(key in answers) && !(key in requested)) answers[key]=value;
    }
  }
  global.ExpensePolicy = {POLICY, CAT_LABEL, buildQuestionQueue, rowIssues, mergePrefill, restoreInvoiceQuantities, quantityUnit, bankRole, bankSide, applyBankProfile, invoiceItemName, invoiceAmountLabel, invoiceReferent,
    remainingCount:(i,a)=>buildQuestionQueue(i,a).length,
    nextQuestion:(i,a)=>buildQuestionQueue(i,a)[0] || null};
})(window);
