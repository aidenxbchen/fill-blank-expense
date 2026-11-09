/** Purchase interview: the live Feishu definition decides required fields. */
(function (global) {
  "use strict";
  const CAT_LABEL = {lodging:"住宿", meal:"餐费", entertainment:"招待", purchase:"采购", transit:"交通", gift:"礼品", other:"其他"};
  const POLICY = {name:"飞书采购申请", version:2};
  const present = v => v != null && String(v).trim() && v !== "（跳过）";
  function invoiceContent(inv) {
    let label = Object.prototype.hasOwnProperty.call(CAT_LABEL, inv.category) ? CAT_LABEL[inv.category] : "";
    if (!label) {
      const stem = String(inv.fileName || "").split(/[\\/]/).pop().replace(/\.[a-z0-9]{1,8}$/i, "").replace(/\s+/g, " ").trim();
      // A filename may supply readable content, but never promote the merchant
      // or an invoice-number-only filename into the question's subject.
      if (stem && stem !== String(inv.merchant || "").trim() && !/^\d+$/.test(stem) && !/发票尾号|^第\s*\d+\s*张票/.test(stem)) {
        label = [...stem].slice(0, 24).join("") + ([...stem].length > 24 ? "…" : "");
      }
    }
    const raw = inv.amount;
    const amount = raw != null && typeof raw !== "boolean" && String(raw).trim() !== "" ? Number(raw) : NaN;
    const money = Number.isFinite(amount) ? ` ¥${amount.toLocaleString("zh-CN", {useGrouping:false, maximumFractionDigits:2})}` : "";
    return `${label || "这笔"}${money}`;
  }
  function invoiceDate(inv) {
    const date = String(inv.date || "").trim();
    const match = date.match(/^\d{4}[-/](\d{2})[-/](\d{2})(?:$|T)/);
    return match ? `${match[1]}-${match[2]}` : date;
  }
  function buildQuestionQueue(invoices, answers) {
    answers = answers || {};
    const schema = global.__purchaseSchema;
    if (!schema) return [{id:"schemaUnavailable", text:"采购表单暂未加载，请返回首页重试。", required:true}];
    const q = [];
    const learned = global.__fillSuggestions || {global:{},rows:{}};
    function ordered(chips, history, strict) {
      history = (history || []).filter(h=>!strict || chips.includes(h.value));
      const values = [...history.map(h=>h.value), ...chips];
      return {chips:[...new Set(values)], recommended:history[0] || null};
    }
    function ask(id, text, chips, hint) {
      const v = answers[id];
      if (present(v) && (!chips || !chips.length || chips.includes(v))) return;
      const rank = ordered(chips || [], (learned.global || {})[id], Boolean(chips && chips.length));
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
    for (const w of method.fields) {
      if (["账户名称","银行账户","收款账号","开户支行"].includes(w.name))
        ask(`purchase:${method.name}:shared:${w.name}`, `本次所有明细的${w.name}是？`, [], "如各行收款信息不同，请分开提交申请。");
    }
    const invoiceRows = invoices || [];
    const contentCounts = new Map();
    for (const inv of invoiceRows) {
      const content = invoiceContent(inv);
      contentCounts.set(content, (contentCounts.get(content) || 0) + 1);
    }
    for (const inv of invoiceRows) {
      const project = answers.costCenter || (answers.selectedBudget || {}).project || "待选项目";
      const content = invoiceContent(inv);
      const date = invoiceDate(inv);
      const needsDate = contentCounts.get(content) > 1 && Boolean(date);
      const ticket = needsDate ? `${content}（${date}）` : content;
      for (const w of method.fields) {
        if (!w.required || ["金额","名称","账户名称","银行账户","收款账号","开户支行"].includes(w.name)) continue;
        let chips = w.options || [];
        if (w.name.includes("科目")) {
          const names = ((answers.selectedBudget || {}).subjects || []).map(s=>s.name || s["科目"] || s["费用科目"]);
          chips = [...chips.filter(x=>names.includes(x)), ...chips.filter(x=>!names.includes(x))];
        }
        if (w.name === "规格") chips = ["次","份","件","台","套"];
        if (w.name === "数量") chips = ["1","2","3"];
        const id = `purchase:${method.name}:${inv.id}:${w.name}`;
        const v = answers[id];
        if (present(v) && (!w.options.length || w.options.includes(v)) && (w.type !== "number" || Number.isFinite(Number(v)) && Number(v)>0)) continue;
        const field = w.name.includes("科目") ? "科目" : w.name;
        const rank = ordered(chips, (((learned.rows || {})[inv.id] || {})[field]), Boolean(w.options.length));
        const text = field === "科目" ? `${ticket} 在【${project}】里属于哪个科目？` : `${ticket} 在【${project}】里的${w.name}是？`;
        const hint = needsDate ? "" : String(inv.date || "");
        q.push({id, text, hint, ...rank, required:true, input:"chips+text", numeric:w.type === "number", options:w.options});
      }
    }
    return q;
  }
  global.ExpensePolicy = {POLICY, CAT_LABEL, buildQuestionQueue,
    remainingCount:(i,a)=>buildQuestionQueue(i,a).length,
    nextQuestion:(i,a)=>buildQuestionQueue(i,a)[0] || null};
})(window);
