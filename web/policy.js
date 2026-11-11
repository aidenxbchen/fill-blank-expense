/** Purchase interview: the live Feishu definition decides required fields. */
(function (global) {
  "use strict";
  const CAT_LABEL = {lodging:"住宿", meal:"餐饮", entertainment:"招待", purchase:"采购", transit:"交通", gift:"礼品", other:"其他"};
  const POLICY = {name:"飞书采购申请", version:2};
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
    ask("purchaseMethod", "这次用哪种采购方式？", schema.methods.map(m=>m.name));
    ask("costCenter", "这笔采购属于哪个项目？", schema.projects, "已选预算的项目会自动带入；名称不一致时请选实际项目。");
    ask("purpose", "这次采购的事由是什么？", [], "一句话说明用途即可。");
    const method = schema.methods.find(m=>m.name === answers.purchaseMethod);
    if (!method) return q;
    if (method.name !== "预付款项") {
      const budgets = global.__approvedBudgets || [];
      if (!answers.selectedBudget || !budgets.some(b=>b.instanceId === answers.selectedBudget.instanceId)) {
        q.push({id:"selectBudget", text:"这次采购关联哪一条已通过的预算？", hint:budgets.length ? "点选后会自动关联该审批。":"暂无可用预算，请返回首页检查登录和预算权限。预付款项以外必须有关联审批。", chips:budgets.map((b,i)=>`${i+1}. ${b.title || b.project} · ${b.serialId || b.instanceId.slice(0,8)}`), required:true, input:"chips", budgetIds:budgets.map(b=>b.instanceId)});
      }
    }
    for (const side of ['counterparty','ours']) {
      const fields=method.fields.filter(w=>bankRole(w.name) && bankSide(w.name)===side);
      if(fields.some(w=>w.required && !present(answers[`purchase:${method.name}:shared:${w.name}`])))
        q.push({id:`bank:${method.name}:${side}`,text:side==='ours' ? '这次采购使用哪份我方银行档案？' : '这次采购使用哪份收款银行档案？',hint:'账号和开户行成对录入；可点选共享档案，或新增并保存。',input:'bank-profile',bankSide:side,required:true,chips:[]});
    }
    const list = invoices || [];
    restoreInvoiceQuantities(list,answers);
    for(const inv of list) {
      const auto=quantityUnit(inv);
      for(const field of method.fields.filter(w=>['数量','单位','规格'].includes(w.name))) {
        const key=`purchase:${method.name}:${inv.id}:${field.name}`;
        answers[key]=String(field.name==='数量' ? auto.quantity : auto.unit);
      }
    }
    for (const inv of list) {
      const project = answers.costCenter || (answers.selectedBudget || {}).project || "待选项目";
      const referent = invoiceReferent(inv, list);
      for (const w of method.fields) {
        if (!w.required || bankRole(w.name) || ["金额","名称","数量","规格","单位"].includes(w.name)) continue;
        let chips = w.options || [];
        if (w.name.includes("科目")) {
          const names = ((answers.selectedBudget || {}).subjects || []).map(s=>s.name || s["科目"] || s["费用科目"]);
          chips = [...chips.filter(x=>names.includes(x)), ...chips.filter(x=>!names.includes(x))];
        }
        const id = `purchase:${method.name}:${inv.id}:${w.name}`;
        const v = answers[id];
        if (present(v) && (!w.options.length || w.options.includes(v)) && (w.type !== "number" || Number.isFinite(Number(v)) && Number(v)>0)) continue;
        const field = w.name.includes("科目") ? "科目" : w.name;
        const rank = ordered(chips, [...((((choices.rows || {})[inv.id] || {})[field]) || []), ...((((learned.rows || {})[inv.id] || {})[field]) || [])], Boolean(w.options.length));
        const text = field === "科目"
          ? `${referent} 在【${project}】里属于哪个科目？`
          : `${referent} 在【${project}】里的${w.name}是？`;
        q.push({id, text, hint:"", ...rank, required:true, input:"chips+text", numeric:w.type === "number", options:w.options});
      }
    }
    return q;
  }
  global.ExpensePolicy = {POLICY, CAT_LABEL, buildQuestionQueue, restoreInvoiceQuantities, quantityUnit, bankRole, bankSide, applyBankProfile, invoiceItemName, invoiceAmountLabel, invoiceReferent,
    remainingCount:(i,a)=>buildQuestionQueue(i,a).length,
    nextQuestion:(i,a)=>buildQuestionQueue(i,a)[0] || null};
})(window);
