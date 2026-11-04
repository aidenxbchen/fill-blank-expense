/**
 * 填空报销 · local prototype
 * Vanilla JS only. Persists to localStorage. Mock OCR. No real Feishu calls.
 */

const STORAGE_KEY = "fill-blank-expense:v1";

const SLOT_DEFS = [
  { key: "lodging", label: "住宿", icon: "🏨" },
  { key: "meal", label: "餐饮", icon: "🍜" },
  { key: "other", label: "交通·其他", icon: "🚕" },
];

const CATEGORY_LABEL = {
  lodging: "住宿",
  meal: "餐饮",
  other: "交通·其他",
};

const MOCK_MERCHANTS = {
  lodging: ["如家酒店", "全季酒店", "亚朵酒店", "希尔顿欢朋", "桔子酒店"],
  meal: ["海底捞", "星巴克", "麦当劳", "外婆家", "喜茶"],
  other: ["滴滴出行", "高德打车", "12306", "中国国航", "地铁交通卡"],
};

/** @typedef {{ id: string, amount: number, merchant: string, date: string, category: string, confidence: number, source: string, fileName: string }} Invoice */
/** @typedef {{ date: string, lodging: Invoice[], meal: Invoice[], other: Invoice[] }} Day */

const state = {
  startDate: "",
  endDate: "",
  city: "",
  reason: "",
  /** @type {Day[]} */
  days: [],
  lastDraft: null,
};

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function uid() {
  return `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseYMD(str) {
  if (!str) return null;
  const [y, m, d] = str.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function formatYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatCNY(n) {
  const v = Number(n) || 0;
  return `¥${v.toFixed(2)}`;
}

function weekdayCN(dateStr) {
  const names = ["日", "一", "二", "三", "四", "五", "六"];
  const d = parseYMD(dateStr);
  return d ? `周${names[d.getDay()]}` : "";
}

function daysBetweenInclusive(startStr, endStr) {
  const start = parseYMD(startStr);
  const end = parseYMD(endStr);
  if (!start || !end || end < start) return [];
  const out = [];
  const cur = new Date(start);
  while (cur <= end) {
    out.push(formatYMD(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function sumInvoices(list) {
  return (list || []).reduce((acc, inv) => acc + (Number(inv.amount) || 0), 0);
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2200);
}

// ---------------------------------------------------------------------------
/**
 * Invoice OCR entry point.
 *
 * Swap to a real engine (e.g. Xiaomi-OCR) without touching the rest of the app:
 *
 *   window.__invoiceOCR = async (file, opts) => {
 *     // opts: { categoryHint?: string, dayDate?: string }
 *     // return shape MUST match mock below:
 *     //   { amount, merchant, date, category, confidence, source }
 *     return await myXiaomiOCR(file, opts);
 *   };
 *
 * If __invoiceOCR is set, it is used; otherwise the built-in mock runs.
 *
 * @param {File} file
 * @param {{ categoryHint?: string, dayDate?: string }} [opts]
 */
async function parseInvoice(file, opts = {}) {
  if (typeof window.__invoiceOCR === "function") {
    return window.__invoiceOCR(file, opts);
  }
  return parseInvoiceMock(file, opts);
}

/** Built-in mock — keep return shape stable for OCR adapters. */
async function parseInvoiceMock(file, opts = {}) {
  // Simulate network / model latency
  await new Promise((r) => setTimeout(r, 280 + Math.random() * 420));

  const category =
    opts.categoryHint && CATEGORY_LABEL[opts.categoryHint]
      ? opts.categoryHint
      : guessCategoryFromName(file.name);

  const merchants = MOCK_MERCHANTS[category] || MOCK_MERCHANTS.other;
  const merchant = merchants[Math.floor(Math.random() * merchants.length)];
  const amountBase =
    category === "lodging" ? 280 + Math.random() * 520 :
    category === "meal" ? 28 + Math.random() * 180 :
    15 + Math.random() * 320;
  const amount = Math.round(amountBase * 100) / 100;
  const confidence = Math.round((0.72 + Math.random() * 0.25) * 100) / 100;

  return {
    amount,
    merchant,
    date: opts.dayDate || formatYMD(new Date()),
    category,
    confidence,
    source: "mock",
  };
}

function guessCategoryFromName(name) {
  const n = (name || "").toLowerCase();
  if (/hotel|住宿|酒店|lodg|inn|motel/.test(n)) return "lodging";
  if (/meal|餐饮|food|餐厅|cafe|咖啡|lunch|dinner/.test(n)) return "meal";
  return "other";
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function saveState() {
  const payload = {
    startDate: state.startDate,
    endDate: state.endDate,
    city: state.city,
    reason: state.reason,
    days: state.days,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("localStorage save failed", err);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    state.startDate = data.startDate || "";
    state.endDate = data.endDate || "";
    state.city = data.city || "";
    state.reason = data.reason || "";
    state.days = Array.isArray(data.days) ? data.days.map(normalizeDay) : [];
  } catch (err) {
    console.warn("localStorage load failed", err);
  }
}

function normalizeDay(day) {
  return {
    date: day.date,
    lodging: Array.isArray(day.lodging) ? day.lodging : [],
    meal: Array.isArray(day.meal) ? day.meal : [],
    other: Array.isArray(day.other) ? day.other : [],
  };
}

// ---------------------------------------------------------------------------
// Timeline regeneration
// ---------------------------------------------------------------------------

function regenerateTimeline() {
  const dates = daysBetweenInclusive(state.startDate, state.endDate);
  const prev = new Map(state.days.map((d) => [d.date, d]));
  state.days = dates.map((date) => {
    const existing = prev.get(date);
    if (existing) return normalizeDay(existing);
    return { date, lodging: [], meal: [], other: [] };
  });
  saveState();
  render();
}

function getGaps() {
  /** @type {{ date: string, missing: string[] }[]} */
  const gaps = [];
  for (const day of state.days) {
    const missing = [];
    if (!day.lodging.length) missing.push("住宿");
    if (!day.meal.length) missing.push("餐饮");
    // 交通·其他非必填，不计入缺口高亮
    if (missing.length) gaps.push({ date: day.date, missing });
  }
  return gaps;
}

function computeTotals() {
  const byCat = { lodging: 0, meal: 0, other: 0 };
  const byDay = state.days.map((day) => {
    const lodging = sumInvoices(day.lodging);
    const meal = sumInvoices(day.meal);
    const other = sumInvoices(day.other);
    byCat.lodging += lodging;
    byCat.meal += meal;
    byCat.other += other;
    return { date: day.date, lodging, meal, other, total: lodging + meal + other };
  });
  const tripTotal = byCat.lodging + byCat.meal + byCat.other;
  return { byCat, byDay, tripTotal };
}

// ---------------------------------------------------------------------------
// Invoice attach / remove
// ---------------------------------------------------------------------------

async function handleFiles(dayDate, category, fileList) {
  const files = Array.from(fileList || []).filter((f) => {
    const ok =
      f.type.startsWith("image/") ||
      f.type === "application/pdf" ||
      /\.(pdf|png|jpe?g|webp|gif|heic)$/i.test(f.name);
    if (!ok) toast(`已跳过不支持的文件：${f.name}`);
    return ok;
  });
  if (!files.length) return;

  const day = state.days.find((d) => d.date === dayDate);
  if (!day) return;

  for (const file of files) {
    try {
      const parsed = await parseInvoice(file, {
        categoryHint: category,
        dayDate,
      });
      /** @type {Invoice} */
      const invoice = {
        id: uid(),
        amount: parsed.amount,
        merchant: parsed.merchant,
        date: parsed.date,
        category: parsed.category || category,
        confidence: parsed.confidence,
        source: parsed.source || "mock",
        fileName: file.name,
      };
      // Attach into the slot the user dropped into (slot is source of truth for UX)
      const slotKey = category;
      if (!day[slotKey]) day[slotKey] = [];
      day[slotKey].push(invoice);
    } catch (err) {
      console.error(err);
      toast(`解析失败：${file.name}`);
    }
  }
  saveState();
  render();
  toast(`已添加 ${files.length} 张发票（${typeof window.__invoiceOCR === "function" ? "OCR" : "mock 识别"}）`);
}

function removeInvoice(dayDate, category, invoiceId) {
  const day = state.days.find((d) => d.date === dayDate);
  if (!day || !day[category]) return;
  day[category] = day[category].filter((inv) => inv.id !== invoiceId);
  saveState();
  render();
}

// ---------------------------------------------------------------------------
// Draft export
// ---------------------------------------------------------------------------

function buildDraftPayload() {
  const totals = computeTotals();
  const gaps = getGaps();
  return {
    product: "填空报销",
    version: 1,
    generatedAt: new Date().toISOString(),
    trip: {
      startDate: state.startDate,
      endDate: state.endDate,
      city: state.city,
      reason: state.reason,
      dayCount: state.days.length,
    },
    days: state.days.map((day, i) => ({
      dayIndex: i + 1,
      date: day.date,
      weekday: weekdayCN(day.date),
      slots: {
        lodging: day.lodging,
        meal: day.meal,
        other: day.other,
      },
      subtotal: totals.byDay[i],
      gaps: gaps.find((g) => g.date === day.date)?.missing || [],
    })),
    totals: {
      lodging: totals.byCat.lodging,
      meal: totals.byCat.meal,
      other: totals.byCat.other,
      tripTotal: totals.tripTotal,
      currency: "CNY",
    },
    gaps,
    /*
     * ---------------------------------------------------------------------------
     * Feishu / Lark approval stub (DO NOT call real APIs from this prototype)
     * brand = feishu (lark-cli)
     *
     * Intended flow later:
     *   1) lark-cli / feishu: approval approvals search  → find reimbursement definition
     *   2) approval approvals get                        → read form schema / widget ids
     *   3) approval instances create                     → submit instance with this payload
     *
     * Example (commented only):
     *
     *   // await feishu.approval.approvals.search({ approval_name: "差旅报销" });
     *   // await feishu.approval.approvals.get({ approval_code: "..." });
     *   // await feishu.approval.instances.create({
     *   //   approval_code: "...",
     *   //   form: JSON.stringify([
     *   //     { id: "city", type: "input", value: trip.city },
     *   //     { id: "amount", type: "amount", value: totals.tripTotal },
     *   //     // ... map slots / attachments per schema
     *   //   ]),
     *   // });
     *
     * ---------------------------------------------------------------------------
     */
    feishuApprovalStub: {
      status: "not_submitted",
      note: "Prototype only — see commented stub in app.js buildDraftPayload()",
    },
  };
}

function buildHumanSummary(payload) {
  const lines = [];
  lines.push("【填空报销 · 草稿摘要】");
  lines.push(`城市：${payload.trip.city || "（未填）"}`);
  lines.push(`事由：${payload.trip.reason || "（未填）"}`);
  lines.push(
    `行程：${payload.trip.startDate || "?"} ~ ${payload.trip.endDate || "?"}（共 ${payload.trip.dayCount} 天）`
  );
  lines.push("");
  for (const day of payload.days) {
    const gapText = day.gaps.length ? ` ⚠ 缺：${day.gaps.join("、")}` : "";
    lines.push(`■ ${day.date} ${day.weekday}${gapText}`);
    for (const def of SLOT_DEFS) {
      const list = day.slots[def.key] || [];
      if (!list.length) {
        lines.push(`  · ${def.label}：—`);
        continue;
      }
      for (const inv of list) {
        lines.push(
          `  · ${def.label}：${inv.merchant} ${formatCNY(inv.amount)}（${inv.fileName || "发票"}，置信度 ${Math.round((inv.confidence || 0) * 100)}%）`
        );
      }
    }
    lines.push(
      `  当日小计：${formatCNY(day.subtotal.total)}（住 ${formatCNY(day.subtotal.lodging)} / 餐 ${formatCNY(day.subtotal.meal)} / 其他 ${formatCNY(day.subtotal.other)}）`
    );
    lines.push("");
  }
  lines.push("—— 合计 ——");
  lines.push(`住宿：${formatCNY(payload.totals.lodging)}`);
  lines.push(`餐饮：${formatCNY(payload.totals.meal)}`);
  lines.push(`交通·其他：${formatCNY(payload.totals.other)}`);
  lines.push(`行程合计：${formatCNY(payload.totals.tripTotal)} CNY`);
  if (payload.gaps.length) {
    lines.push("");
    lines.push("缺口：");
    for (const g of payload.gaps) {
      lines.push(`  - ${g.date}：缺 ${g.missing.join("、")}`);
    }
  } else {
    lines.push("");
    lines.push("缺口：无（住宿与餐饮均已覆盖）");
  }
  lines.push("");
  lines.push("（飞书审批未提交 · stub only）");
  return lines.join("\n");
}

function downloadJSON(payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = (payload.trip.startDate || "draft").replace(/-/g, "");
  a.href = url;
  a.download = `填空报销草稿_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function openDraftModal() {
  if (!state.days.length) {
    toast("请先设置行程日期");
    return;
  }
  const payload = buildDraftPayload();
  state.lastDraft = payload;
  const summary = buildHumanSummary(payload);
  document.getElementById("draft-summary").textContent = summary;
  document.getElementById("draft-modal").classList.add("open");
  downloadJSON(payload);
  toast("已下载 JSON 草稿");
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  // Form fields (avoid clobbering while typing if focused — we set from state on load/regen)
  const startEl = document.getElementById("start-date");
  const endEl = document.getElementById("end-date");
  const cityEl = document.getElementById("city");
  const reasonEl = document.getElementById("reason");
  if (document.activeElement !== startEl) startEl.value = state.startDate;
  if (document.activeElement !== endEl) endEl.value = state.endDate;
  if (document.activeElement !== cityEl) cityEl.value = state.city;
  if (document.activeElement !== reasonEl) reasonEl.value = state.reason;

  const hint = document.getElementById("day-count-hint");
  if (!state.startDate || !state.endDate) {
    hint.textContent = "请选择起止日期以生成按天时间轴";
  } else if (parseYMD(state.endDate) < parseYMD(state.startDate)) {
    hint.textContent = "结束日期不能早于开始日期";
  } else {
    hint.textContent = `共 ${state.days.length} 天 · 改日期会保留重叠日期上的发票`;
  }

  const totals = computeTotals();
  document.getElementById("total-lodging").textContent = formatCNY(totals.byCat.lodging);
  document.getElementById("total-meal").textContent = formatCNY(totals.byCat.meal);
  document.getElementById("total-other").textContent = formatCNY(totals.byCat.other);
  document.getElementById("total-all").textContent = formatCNY(totals.tripTotal);

  renderGaps();
  renderStickyBar(totals);
  renderTimeline(totals);
  updateFlowSteps();
}

function updateFlowSteps() {
  const steps = document.querySelectorAll(".flow-step");
  if (!steps.length) return;
  const hasTrip = Boolean(state.startDate && state.endDate && state.days.length);
  const gaps = getGaps();
  const hasAnyInvoice = state.days.some(
    (d) => d.lodging.length || d.meal.length || d.other.length
  );
  // Mark progress: 1 always "active" base; highlight current furthest
  steps.forEach((el) => el.classList.remove("is-active", "is-done"));
  steps[0].classList.add(hasTrip ? "is-done" : "is-active");
  if (hasTrip) {
    steps[1].classList.add(hasAnyInvoice ? "is-done" : "is-active");
  }
  if (hasAnyInvoice) {
    steps[2].classList.add(gaps.length === 0 ? "is-done" : "is-active");
  }
  if (hasTrip && gaps.length === 0 && hasAnyInvoice) {
    steps[3].classList.add("is-active");
  }
}

function renderStickyBar(totals) {
  const bar = document.getElementById("sticky-cta");
  const totalEl = document.getElementById("sticky-total");
  const gapsEl = document.getElementById("sticky-gaps");
  if (!bar || !totalEl || !gapsEl) return;

  const hasDays = state.days.length > 0;
  bar.hidden = !hasDays;

  totalEl.textContent = `合计 ${formatCNY(totals.tripTotal)}`;
  const gaps = getGaps();
  gapsEl.textContent = gaps.length
    ? `缺口 ${gaps.length} 天`
    : hasDays
      ? "缺口 0"
      : "缺口 —";

  const draftBtns = [
    document.getElementById("btn-draft"),
    document.getElementById("btn-draft-sticky"),
  ];
  draftBtns.forEach((btn) => {
    if (btn) btn.disabled = !hasDays;
  });
}

function renderGaps() {
  const box = document.getElementById("gap-summary");
  if (!state.days.length) {
    box.innerHTML = `
      <div class="gap-item ok">
        <span class="gap-dot"></span>
        <span>设置行程后，将显示缺少住宿或餐饮的日期</span>
      </div>`;
    return;
  }
  const gaps = getGaps();
  if (!gaps.length) {
    box.innerHTML = `
      <div class="gap-item ok">
        <span class="gap-dot"></span>
        <span>太好了！每天住宿与餐饮均已填入</span>
      </div>`;
    return;
  }
  box.innerHTML = gaps
    .map(
      (g) => `
      <div class="gap-item">
        <span class="gap-dot"></span>
        <span><strong>${g.date}</strong> ${weekdayCN(g.date)}：缺 ${g.missing.join("、")}</span>
      </div>`
    )
    .join("");
}

function renderTimeline(totals) {
  const root = document.getElementById("day-timeline");
  if (!state.days.length) {
    root.innerHTML = `
      <div class="empty-state">
        <strong>还没有行程天数</strong>
        <span>在上方选择开始与结束日期后，会按天生成「住宿 / 餐饮 / 交通·其他」填空槽位。</span>
      </div>`;
    return;
  }

  const gapMap = new Map(getGaps().map((g) => [g.date, g.missing]));

  root.innerHTML = state.days
    .map((day, idx) => {
      const missing = gapMap.get(day.date) || [];
      const sub = totals.byDay[idx];
      const hasGap = missing.length > 0;
      return `
        <article class="day-card ${hasGap ? "has-gap" : ""}" data-date="${day.date}">
          <div class="day-head">
            <div class="day-title">
              <span>第 ${idx + 1} 天 · ${day.date}</span>
              <span class="day-badge">${weekdayCN(day.date)}</span>
              ${
                hasGap
                  ? `<span class="day-badge gap">缺 ${missing.join("、")}</span>`
                  : `<span class="day-badge ok">齐全</span>`
              }
            </div>
            <div class="day-meta">当日小计 ${formatCNY(sub.total)}</div>
          </div>
          <div class="day-body">
            ${SLOT_DEFS.map((def) => renderSlot(day, def)).join("")}
          </div>
        </article>`;
    })
    .join("");

  // Bind slot interactions
  root.querySelectorAll(".slot").forEach((slotEl) => {
    const date = slotEl.dataset.date;
    const category = slotEl.dataset.category;
    const input = slotEl.querySelector('input[type="file"]');

    slotEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      slotEl.classList.add("drag-over");
    });
    slotEl.addEventListener("dragleave", () => slotEl.classList.remove("drag-over"));
    slotEl.addEventListener("drop", (e) => {
      e.preventDefault();
      slotEl.classList.remove("drag-over");
      if (e.dataTransfer?.files?.length) {
        handleFiles(date, category, e.dataTransfer.files);
      }
    });

    input?.addEventListener("change", () => {
      if (input.files?.length) {
        handleFiles(date, category, input.files);
        input.value = "";
      }
    });
  });

  root.querySelectorAll("[data-remove-invoice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      removeInvoice(btn.dataset.date, btn.dataset.category, btn.dataset.id);
    });
  });
}

function renderSlot(day, def) {
  const list = day[def.key] || [];
  const sum = sumInvoices(list);
  const required = def.key === "lodging" || def.key === "meal";
  const isMissing = required && !list.length;
  const isFilled = list.length > 0;
  const stateClass = isFilled ? "is-filled" : isMissing ? "is-missing" : "";

  const missingHint = isMissing
    ? `<div class="slot-missing">尚未填入${def.label}</div>`
    : "";

  const body = list.length
    ? `<div class="invoice-list">${list.map((inv) => renderInvoice(day.date, def.key, inv)).join("")}</div>`
    : `<div class="slot-empty">
         <div class="icon" aria-hidden="true">${def.icon}</div>
         <div class="drop-hint">拖入 PDF / 图片</div>
         <div>或点上方上传</div>
       </div>`;

  return `
    <div class="slot ${stateClass}" data-date="${day.date}" data-category="${def.key}">
      <div class="slot-head">
        <span class="slot-label">${def.label}${required ? "" : " · 可选"}</span>
        <span class="slot-sum">${list.length ? formatCNY(sum) : "—"}</span>
      </div>
      <div class="slot-upload">
        <label class="btn btn-secondary upload-btn">
          上传发票
          <input class="file-input-hidden" type="file" accept="image/*,application/pdf,.pdf,.png,.jpg,.jpeg,.webp,.gif" multiple />
        </label>
      </div>
      ${body}
      ${missingHint}
    </div>`;
}

function renderInvoice(date, category, inv) {
  const confPct = Math.round((inv.confidence || 0) * 100);
  const confClass = confPct < 80 ? "confidence low" : "confidence";
  return `
    <div class="invoice">
      <div class="invoice-top">
        <div class="invoice-merchant">${escapeHtml(inv.merchant)}</div>
        <div class="invoice-amount">${formatCNY(inv.amount)}</div>
      </div>
      <div class="invoice-meta">
        <span>${escapeHtml(inv.date || date)}</span>
        <span class="${confClass}">${confPct}% · ${escapeHtml(inv.source || "mock")}</span>
        <span title="${escapeHtml(inv.fileName || "")}">${escapeHtml(truncate(inv.fileName || "文件", 18))}</span>
      </div>
      <div class="invoice-actions">
        <button type="button" class="btn btn-danger btn-sm" data-remove-invoice
          data-date="${date}" data-category="${category}" data-id="${inv.id}">移除</button>
      </div>
    </div>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bindEvents() {
  const startEl = document.getElementById("start-date");
  const endEl = document.getElementById("end-date");
  const cityEl = document.getElementById("city");
  const reasonEl = document.getElementById("reason");

  const onDates = () => {
    state.startDate = startEl.value;
    state.endDate = endEl.value;
    regenerateTimeline();
  };
  startEl.addEventListener("change", onDates);
  endEl.addEventListener("change", onDates);

  cityEl.addEventListener("input", () => {
    state.city = cityEl.value;
    saveState();
  });
  reasonEl.addEventListener("input", () => {
    state.reason = reasonEl.value;
    saveState();
  });

  document.getElementById("btn-reset").addEventListener("click", () => {
    if (!confirm("确定清空当前行程与所有发票？")) return;
    state.startDate = "";
    state.endDate = "";
    state.city = "";
    state.reason = "";
    state.days = [];
    state.lastDraft = null;
    saveState();
    render();
    toast("已清空");
  });

  document.getElementById("btn-draft").addEventListener("click", openDraftModal);
  const stickyDraft = document.getElementById("btn-draft-sticky");
  if (stickyDraft) stickyDraft.addEventListener("click", openDraftModal);

  document.getElementById("btn-close-modal").addEventListener("click", () => {
    document.getElementById("draft-modal").classList.remove("open");
  });
  document.getElementById("draft-modal").addEventListener("click", (e) => {
    if (e.target.id === "draft-modal") {
      document.getElementById("draft-modal").classList.remove("open");
    }
  });

  document.getElementById("btn-copy-summary").addEventListener("click", async () => {
    const text = document.getElementById("draft-summary").textContent || "";
    try {
      await navigator.clipboard.writeText(text);
      toast("摘要已复制");
    } catch {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast("摘要已复制");
    }
  });

  document.getElementById("btn-download-json").addEventListener("click", () => {
    const payload = state.lastDraft || buildDraftPayload();
    downloadJSON(payload);
    toast("已下载 JSON");
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadState();
bindEvents();
// If dates exist but days empty/outdated, regenerate
if (state.startDate && state.endDate) {
  if (!state.days.length) regenerateTimeline();
  else render();
} else {
  render();
}
