/**
 * 填空报销 · delight flow
 * dump invoices → parse → one-at-a-time policy interview → editable draft → Feishu stub
 */
(function () {
  "use strict";

  const STORAGE_KEY = "fill-blank-expense:delight:v1";
  const ASSET_V = "20261106a";

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

  function save() {
    try {
      const slim = {
        stage: session.stage,
        invoices: session.invoices.map(stripPreview),
        answers: session.answers,
        chat: session.chat,
        draft: session.draft,
        parseErrors: session.parseErrors,
        lastFeishu: session.lastFeishu,
        selectedBudgetId: session.selectedBudgetId,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch (e) {
      console.warn("save failed", e);
    }
  }

  function stripPreview(inv) {
    const { previewUrl, ...rest } = inv;
    return rest;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      session = Object.assign(emptySession(), data);
      if (!Array.isArray(session.invoices)) session.invoices = [];
      if (!session.answers) session.answers = {};
      if (!Array.isArray(session.chat)) session.chat = [];
    } catch (e) {
      console.warn("load failed", e);
    }
  }

  function showToast(msg, ms) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("is-visible");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove("is-visible"), ms || 2800);
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
    session.stage = stage;
    document.querySelectorAll(".stage-item").forEach((el) => {
      const s = el.getAttribute("data-stage");
      el.classList.toggle("is-active", s === stage);
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

  function renderUpload() {
    const list = document.getElementById("invoice-list");
    const actions = document.getElementById("upload-actions");
    const status = document.getElementById("parse-status");
    const startBtn = document.getElementById("btn-start-interview");
    if (!list) return;

    if (!session.invoices.length) {
      list.hidden = true;
      actions.hidden = true;
      status.hidden = true;
      list.innerHTML = "";
      return;
    }

    list.hidden = false;
    actions.hidden = false;
    list.innerHTML = session.invoices
      .map((inv) => {
        const ok = inv.status === "ok";
        const err = inv.status === "error";
        const parsing = inv.status === "parsing";
        const badge = parsing ? "识别中…" : err ? "失败" : `${formatMoney(inv.amount)} · ${CAT_LABEL[inv.category] || inv.category || "—"}`;
        return `<div class="inv-chip ${err ? "is-error" : ok ? "is-ok" : "is-busy"}" data-id="${esc(inv.id)}">
          <div class="inv-chip-main">
            <strong>${esc(inv.merchant || inv.fileName || "发票")}</strong>
            <span>${esc(badge)}</span>
            ${inv.date ? `<span class="muted-sm">${esc(inv.date)}</span>` : ""}
            ${err && inv.error ? `<span class="err-sm">${esc(inv.error)}</span>` : ""}
          </div>
          <button type="button" class="btn btn-ghost btn-sm inv-remove" data-remove="${esc(inv.id)}" aria-label="移除">×</button>
        </div>`;
      })
      .join("");

    const okCount = session.invoices.filter((i) => i.status === "ok").length;
    const busy = session.invoices.some((i) => i.status === "parsing");
    startBtn.disabled = okCount === 0 || busy;
    startBtn.textContent = busy ? "识别中…" : `开始问答（${okCount} 张）`;

    if (session.parseErrors.length) {
      status.hidden = false;
      status.innerHTML = session.parseErrors
        .slice(-3)
        .map((e) => `<div class="parse-err">${esc(e)}</div>`)
        .join("");
    } else {
      status.hidden = true;
    }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    for (const file of files) {
      const id = uid("inv");
      const entry = {
        id,
        fileName: file.name,
        status: "parsing",
        amount: null,
        merchant: "",
        date: "",
        category: "",
        confidence: 0,
        source: "",
        error: "",
        raw: null,
      };
      session.invoices.push(entry);
      renderUpload();
      save();

      try {
        const result = await parseInvoice(file, {});
        Object.assign(entry, {
          status: "ok",
          amount: result.amount,
          merchant: result.merchant || file.name.replace(/\.[^.]+$/, ""),
          date: result.date || "",
          category: normalizeCategory(result.category),
          confidence: result.confidence || 0,
          source: result.source || "",
          raw: result.raw || null,
          extract_method: result.extract_method,
        });
      } catch (err) {
        entry.status = "error";
        entry.error = (err && err.message) || String(err);
        session.parseErrors.push(`${file.name}: ${entry.error}`);
        showToast(`识别失败：${file.name}`);
      }
      renderUpload();
      save();
    }
  }

  function normalizeCategory(c) {
    const known = SHEET_KIND_META;
    if (c && known[c]) return c;
    return "other";
  }

  /* ---------- interview ---------- */

  function okInvoices() {
    return session.invoices.filter((i) => i.status === "ok");
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
            <strong>${esc(inv.merchant || inv.fileName)}</strong>
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
      progress.textContent = remaining > 0 ? `还差 ${remaining} 个问题` : "问题已齐，正在生成草稿…";
    }

    // Seed opening message once
    if (!session.chat.length) {
      pushChat(
        "assistant",
        `已识别 ${invs.length} 张发票，合计 ${formatMoney(invs.reduce((s, i) => s + (Number(i.amount) || 0), 0))}。我会按「${(policy && policy.name) || "团队规范"}」一次只问一个问题。`
      );
    }

    ensureCurrentQuestionAsked();

    if (log) {
      log.innerHTML = session.chat
        .map((m) => `<div class="chat-bubble chat-${m.role}"><div class="chat-bubble-inner">${esc(m.text)}</div></div>`)
        .join("");
      log.scrollTop = log.scrollHeight;
    }

    const q = window.ExpensePolicy ? window.ExpensePolicy.nextQuestion(invs, session.answers, policy) : null;
    if (!q) {
      chipRow.innerHTML = "";
      document.getElementById("chat-input").disabled = true;
      document.getElementById("btn-send-answer").disabled = true;
      if (skipBtn) skipBtn.hidden = true;
      // auto advance to draft
      setTimeout(() => {
        if (session.stage === "interview") {
          buildDraft();
          setStage("draft");
          showToast("草稿已生成");
        }
      }, 450);
      return;
    }

    document.getElementById("chat-input").disabled = false;
    document.getElementById("btn-send-answer").disabled = false;
    if (skipBtn) skipBtn.hidden = !!q.required;

    chipRow.innerHTML = (q.chips || [])
      .map((c) => `<button type="button" class="chip" data-chip="${esc(c)}">${esc(c)}</button>`)
      .join("");
    session._currentQuestion = q;
  }

  function ensureCurrentQuestionAsked() {
    const invs = okInvoices();
    const policy = window.ExpensePolicy && window.ExpensePolicy.POLICY;
    const q = window.ExpensePolicy ? window.ExpensePolicy.nextQuestion(invs, session.answers, policy) : null;
    if (!q) return;
    const last = session.chat[session.chat.length - 1];
    if (last && last.role === "assistant" && last.meta && last.meta.qid === q.id) return;
    // avoid duplicating same question text if already last
    if (last && last.role === "assistant" && last.text === q.text) {
      if (!last.meta) last.meta = { qid: q.id };
      return;
    }
    pushChat("assistant", q.text + (q.hint ? `\n${q.hint}` : ""), { qid: q.id });
  }

  function submitAnswer(raw) {
    const value = String(raw == null ? "" : raw).trim();
    if (!value) return;
    const q = session._currentQuestion;
    if (!q) return;
    pushChat("user", value, { qid: q.id });
    applyAnswerSideEffects(q.id, value, q);
    save();
    renderInterview();
  }

  /* ---------- draft ---------- */

  function buildDraft() {
    const invs = okInvoices().map((i) => ({ ...i }));
    // remap entertainment label for meals if needed
    if (session.answers.isEntertainment === true) {
      invs.forEach((inv) => {
        if (inv.category === "meal") inv.category = "entertainment";
      });
    }

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
        amount: inv.amount == null ? "" : String(inv.amount),
        hasInvoice: true,
        invoiceRef: inv.id,
        note: "",
      });
    });

    // cash no invoice placeholder
    const cash = session.answers.cashNoInvoice || "";
    if (cash && !/没有/.test(cash)) {
      if (!sheetsMap.other) {
        sheetsMap.other = {
          id: uid("sheet"),
          title: SHEET_KIND_META.other.title,
          kind: "other",
          rows: [],
        };
      }
      sheetsMap.other.rows.push({
        id: uid("row"),
        date: "",
        description: "无发票支出（待补）",
        amount: "",
        hasInvoice: false,
        invoiceRef: "",
        note: String(cash),
      });
    }

    const sheets = Object.values(sheetsMap);
    const total = sheets.reduce(
      (s, sh) => s + sh.rows.reduce((a, r) => a + (parseFloat(r.amount) || 0), 0),
      0
    );

    session.draft = {
      generatedAt: new Date().toISOString(),
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
      line.textContent = `事由：${d.purpose || "（未填）"} · 归属：${d.costCenter || "（未填）"} · ${d.detailSheets.length} 张明细表`;
    }

    if (meta) {
      meta.innerHTML = `
        <div class="draft-meta-grid">
          <div class="field"><label>事由</label><input type="text" data-meta="purpose" value="${esc(d.purpose)}" /></div>
          <div class="field"><label>项目 / 成本中心</label><input type="text" data-meta="costCenter" value="${esc(d.costCenter)}" /></div>
          <div class="field"><label>对方公司</label><input type="text" data-meta="guestCompany" value="${esc(d.guestCompany)}" /></div>
          <div class="field"><label>用餐人</label><input type="text" data-meta="attendees" value="${esc(d.attendees)}" /></div>
          <div class="field"><label>酒水</label><input type="text" data-meta="hasAlcohol" value="${esc(d.hasAlcohol)}" /></div>
          <div class="field"><label>对公 / 私人</label><input type="text" data-meta="privatePublic" value="${esc(d.privatePublic)}" /></div>
        </div>`;
    }

    if (sheetsEl) {
      sheetsEl.innerHTML = d.detailSheets
        .map((sheet, si) => {
          const rows = sheet.rows
            .map((row, ri) => {
              return `<tr data-si="${si}" data-ri="${ri}">
                <td><input data-cell="date" value="${esc(row.date)}" /></td>
                <td><input data-cell="description" value="${esc(row.description)}" /></td>
                <td><input data-cell="amount" inputmode="decimal" value="${esc(row.amount)}" /></td>
                <td class="td-inv">${row.hasInvoice ? "有票" : "无票"}</td>
                <td><input data-cell="note" value="${esc(row.note || "")}" placeholder="备注" /></td>
                <td><button type="button" class="btn btn-ghost btn-sm" data-del-row="${si}:${ri}">删</button></td>
              </tr>`;
            })
            .join("");
          return `<section class="panel sheet-card" data-sheet="${si}">
            <div class="sheet-head">
              <input class="sheet-title-input" data-sheet-title="${si}" value="${esc(sheet.title)}" />
              <button type="button" class="btn btn-secondary btn-sm" data-add-row="${si}">添加行</button>
            </div>
            <div class="table-wrap">
              <table class="sheet-table">
                <thead><tr><th>日期</th><th>摘要</th><th>金额</th><th>发票</th><th>备注</th><th></th></tr></thead>
                <tbody>${rows || `<tr><td colspan="6" class="muted">暂无行</td></tr>`}</tbody>
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
    recomputeDraftTotal();
  }

  /* ---------- submit / feishu stub ---------- */

  function buildFeishuPayload() {
    syncDraftFromDom();
    const d = session.draft;
    return {
      stub: true,
      api: "POST /api/feishu-expense",
      note: "Real Feishu approval wiring comes later. This payload is what would be sent.",
      submittedAt: new Date().toISOString(),
      claim: {
        purpose: d.purpose,
        costCenter: d.costCenter,
        guestCompany: d.guestCompany,
        attendees: d.attendees,
        hasAlcohol: d.hasAlcohol,
        privatePublic: d.privatePublic,
        travelCity: d.travelCity,
        purchaseProject: d.purchaseProject,
        total: d.total,
        currency: "CNY",
        invoiceCount: (d.invoices || []).length,
        detailSheets: d.detailSheets,
        answers: d.answers,
        policyName: d.policyName,
        selectedBudget: (session.answers && session.answers.selectedBudget) || null,
      },
    };
  }

  function renderSubmit() {
    const prev = document.getElementById("submit-preview");
    if (!session.draft) buildDraft();
    const payload = buildFeishuPayload();
    if (prev) {
      prev.innerHTML = `
        <div class="submit-stat"><span>事由</span><strong>${esc(payload.claim.purpose || "—")}</strong></div>
        <div class="submit-stat"><span>合计</span><strong>${esc(formatMoney(payload.claim.total))}</strong></div>
        <div class="submit-stat"><span>发票</span><strong>${esc(payload.claim.invoiceCount)} 张</strong></div>
        <div class="submit-stat"><span>明细表</span><strong>${esc(payload.claim.detailSheets.length)} 张</strong></div>
      `;
    }
  }

  async function submitFeishu() {
    const payload = buildFeishuPayload();
    let result;
    try {
      const base =
        location.hostname === "127.0.0.1" || location.hostname === "localhost"
          ? "http://127.0.0.1:18790"
          : "";
      const res = await fetch(base + "/api/feishu-expense", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = { ok: false, error: "non-json", raw: text.slice(0, 400) };
      }
      if (!res.ok) throw new Error((data && (data.error || data.message)) || "HTTP " + res.status);
      result = data;
    } catch (err) {
      // client stub fallback
      result = {
        ok: true,
        stub: true,
        clientFallback: true,
        message: "OCR 桥接不可达，已使用前端 stub",
        errorDetail: String(err && err.message ? err.message : err),
        echo: payload,
        feishuApprovalId: "STUB-" + Date.now().toString(36).toUpperCase(),
      };
    }

    session.lastFeishu = result;
    save();
    showResultModal(result);
    showToast(result.ok ? "已提交（stub 成功）" : "提交失败");
  }

  function showResultModal(result) {
    const modal = document.getElementById("result-modal");
    const pre = document.getElementById("result-payload");
    if (pre) pre.textContent = JSON.stringify(result, null, 2);
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
    document.getElementById("btn-start-interview").addEventListener("click", () => {
      if (!okInvoices().length) return;
      session.chat = [];
      setStage("interview");
    });

    document.getElementById("invoice-list").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-remove]");
      if (!btn) return;
      const id = btn.getAttribute("data-remove");
      session.invoices = session.invoices.filter((i) => i.id !== id);
      save();
      renderUpload();
    });

    document.getElementById("btn-back-upload").addEventListener("click", () => setStage("upload"));
    document.getElementById("btn-back-interview").addEventListener("click", () => setStage("interview"));
    document.getElementById("btn-back-draft").addEventListener("click", () => setStage("draft"));

    document.getElementById("btn-send-answer").addEventListener("click", () => {
      const inputEl = document.getElementById("chat-input");
      submitAnswer(inputEl.value);
      inputEl.value = "";
      inputEl.focus();
    });
    document.getElementById("chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        document.getElementById("btn-send-answer").click();
      }
    });
    document.getElementById("chip-row").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-chip]");
      if (!chip) return;
      const q = session._currentQuestion;
      if (q && (q.input === "chips" || !document.getElementById("chat-input").value)) {
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

    document.getElementById("btn-regen-draft").addEventListener("click", () => {
      buildDraft();
      renderDraft();
      showToast("已按当前答案重生成");
    });
    document.getElementById("btn-goto-submit").addEventListener("click", () => {
      syncDraftFromDom();
      setStage("submit");
    });

    document.getElementById("detail-sheets").addEventListener("input", (e) => {
      if (!e.target.matches("input")) return;
      syncDraftFromDom();
    });
    document.getElementById("draft-meta").addEventListener("input", () => syncDraftFromDom());
    document.getElementById("detail-sheets").addEventListener("click", (e) => {
      const add = e.target.closest("[data-add-row]");
      if (add) {
        const si = Number(add.getAttribute("data-add-row"));
        session.draft.detailSheets[si].rows.push({
          id: uid("row"),
          date: "",
          description: "",
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
        session.draft.detailSheets[si].rows.splice(ri, 1);
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

    document.getElementById("btn-reset").addEventListener("click", () => {
      if (!confirm("清空当前会话（发票、问答、草稿）？")) return;
      session = emptySession();
      localStorage.removeItem(STORAGE_KEY);
      setStage("upload");
      showToast("已清空");
    });
  }

  function selectBudget(id) {
    const b = approvedBudgets.find((x) => x.instanceId === id || x.instanceCode === id);
    if (!b) return;
    session.selectedBudgetId = b.instanceId;
    session.answers.costCenter = b.project || b.title || "";
    session.answers.selectedBudgetId = b.instanceId;
    session.answers.selectedBudget = {
      instanceId: b.instanceId,
      approvalName: b.approvalName,
      project: b.project,
      title: b.title,
      totalAmount: b.totalAmount,
      subjects: b.subjects || [],
    };
    if (b.project) session.answers.purchaseProject = b.project;
    save();
    renderBudgets();
    showToast("已选择预算：" + (b.project || b.title || ""));
  }

  function renderBudgets() {
    const box = document.getElementById("budget-picker");
    const grid = document.getElementById("budget-grid");
    const hint = document.getElementById("budget-picker-hint");
    const pill = document.getElementById("budget-count-pill");
    if (!box || !grid) return;
    box.hidden = false;
    if (!authUser) {
      if (pill) pill.textContent = "0";
      if (hint) hint.textContent = "用飞书登录后，这里会列出你已通过的立项 / 变更预算，点选即可带进问答。";
      grid.innerHTML = `<a class="btn btn-primary" href="${esc(loginHref())}">用飞书登录</a>`;
      return;
    }
    if (pill) pill.textContent = String(approvedBudgets.length);
    if (!approvedBudgets.length) {
      if (hint) hint.textContent = "没有已通过的立项或变更预算，问答时仍可手填项目。";
      grid.innerHTML = `<p class="budget-empty">暂无已通过的预算</p>`;
      return;
    }
    if (hint) hint.textContent = "点选一条已通过的预算，问答会自动带上项目，不必再手填。";
    grid.innerHTML = approvedBudgets
      .map((b) => {
        const selected = session.selectedBudgetId === b.instanceId;
        const amt = b.totalAmount != null ? formatMoney(b.totalAmount) : "";
        const subjects = (b.subjects || [])
          .map((s) => s.name)
          .filter(Boolean)
          .slice(0, 4)
          .join("、");
        return `<button type="button" class="budget-card${selected ? " is-selected" : ""}" data-budget-id="${esc(b.instanceId)}">
        <span class="budget-card-kind">${esc(b.approvalName || "")}</span>
        <strong class="budget-card-title">${esc(b.project || b.title || "未命名项目")}</strong>
        <span class="budget-card-meta">${esc([amt, subjects, b.startTime].filter(Boolean).join(" · "))}</span>
      </button>`;
      })
      .join("");
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
      try {
        const res = await fetch(apiBase() + "/api/budgets", {
          credentials: "include",
          cache: "no-store",
        });
        const data = await res.json();
        approvedBudgets = data && Array.isArray(data.budgets) ? data.budgets : [];
        window.__approvedBudgets = approvedBudgets;
        if (data && data.error && !approvedBudgets.length) {
          const hint = document.getElementById("budget-picker-hint");
          if (hint) hint.textContent = data.error;
        }
      } catch (e) {
        approvedBudgets = [];
        window.__approvedBudgets = [];
      }
    } else {
      approvedBudgets = [];
      window.__approvedBudgets = [];
    }
    renderBudgets();
  }

  async function logout() {
    try {
      await fetch(apiBase() + "/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch (e) {}
    authUser = null;
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

  function init() {
    load();
    bind();
    consumeAuthQuery();
    refreshAuth();
    // restore stage
    const stage = session.stage || "upload";
    if (stage === "interview" && !okInvoices().length) session.stage = "upload";
    if (stage === "draft" && !session.draft && !okInvoices().length) session.stage = "upload";
    setStage(session.stage || "upload");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
