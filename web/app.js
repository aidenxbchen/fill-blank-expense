/**
 * 填空报销 · local prototype (4 scenarios)
 * Vanilla JS only. Per-scenario localStorage. Mock OCR via window.__invoiceOCR. No real Feishu calls.
 */

const ACTIVE_KEY = "fill-blank-expense:active-scenario";
const STORAGE_PREFIX = "fill-blank-expense:v2:";
const LEGACY_KEY = "fill-blank-expense:v1";

const SCENARIO_META = {
  travel: {
    id: "travel",
    label: "差旅",
    hint: "按天填住宿 / 餐饮 / 交通发票；各场景草稿在本地分开保存。",
    contentTitle: "按天填空",
    contentHint: "每天三个槽位：住宿、餐饮必填；交通·其他可选。拖入 PDF / 图片或点「上传」。",
    flow1: "行程",
    flow2: "按天填空",
  },
  purchase: {
    id: "purchase",
    label: "日常采购",
    hint: "按品名登记采购明细；可按行或整单挂发票。缺口：缺金额或发票。",
    contentTitle: "采购明细",
    contentHint: "每行填写品名 / 供应商 / 日期 / 金额，并上传对应发票（也可在上方挂整单发票）。",
    flow1: "说明",
    flow2: "明细填空",
  },
  local_transit: {
    id: "local_transit",
    label: "市内交通",
    hint: "按每次出行登记；请附票据 / 发票。缺口：缺票据。",
    contentTitle: "出行明细",
    contentHint: "每条填写日期、起点、终点、方式、金额，并上传票据 / 发票。",
    flow1: "说明",
    flow2: "出行填空",
  },
  entertainment: {
    id: "entertainment",
    label: "招待宴请",
    hint: "按场次登记；餐费 / 礼品·其他槽位。缺口：缺餐费发票等。",
    contentTitle: "招待场次",
    contentHint: "每场填写日期、对象/事由、人数、金额；上传餐费与礼品·其他发票。",
    flow1: "说明",
    flow2: "场次填空",
  },
};

const TRAVEL_SLOT_DEFS = [
  { key: "lodging", label: "住宿", icon: "🏨" },
  { key: "meal", label: "餐饮", icon: "🍜" },
  { key: "other", label: "交通·其他", icon: "🚕" },
];

const ENT_SLOT_DEFS = [
  { key: "meal", label: "餐费", icon: "🍽", required: true },
  { key: "gift", label: "礼品·其他", icon: "🎁", required: false },
];

const CATEGORY_LABEL = {
  lodging: "住宿",
  meal: "餐饮",
  other: "交通·其他",
  gift: "礼品·其他",
  purchase: "采购",
  transit: "市内交通",
};

/** Default detail-sheet titles by invoice category (titles are user-editable). */
const SHEET_KIND_META = {
  meal: { kind: "meal", title: "餐饮表" },
  lodging: { kind: "lodging", title: "住宿表" },
  purchase: { kind: "purchase", title: "物品表" },
  transit: { kind: "transit", title: "交通表" },
  gift: { kind: "gift", title: "礼品表" },
  other: { kind: "other", title: "其他支出表" },
};

const MOCK_MERCHANTS = {
  lodging: ["如家酒店", "全季酒店", "亚朵酒店", "希尔顿欢朋", "桔子酒店"],
  meal: ["海底捞", "星巴克", "麦当劳", "外婆家", "喜茶"],
  other: ["滴滴出行", "高德打车", "12306", "中国国航", "地铁交通卡"],
  gift: ["星巴克礼品卡", "茶叶礼盒", "果篮", "文具礼盒"],
  purchase: ["京东商城", "得力办公", "震旦家具", "晨光文具", "天猫超市"],
  transit: ["滴滴出行", "高德打车", "地铁交通卡", "出租车发票", "共享单车"],
};

const TRANSIT_MODES = ["出租车", "网约车", "地铁", "公交", "共享单车", "其他"];

/** @type {string} */
let activeScenario = "travel";

/** Per-scenario working states (in memory). */
const drafts = {
  travel: emptyTravel(),
  purchase: emptyPurchase(),
  local_transit: emptyLocalTransit(),
  entertainment: emptyEntertainment(),
};

let lastDraft = null;

function emptyTravel() {
  return { startDate: "", endDate: "", city: "", reason: "", days: [], detailSheets: [] };
}

function emptyPurchase() {
  return { reason: "", claimInvoices: [], items: [], detailSheets: [] };
}

function emptyLocalTransit() {
  return { reason: "", trips: [], detailSheets: [] };
}

function emptyEntertainment() {
  return { reason: "", events: [], detailSheets: [] };
}

function newPurchaseItem() {
  return {
    id: uid("pur"),
    name: "",
    vendor: "",
    date: formatYMD(new Date()),
    amount: "",
    invoices: [],
  };
}

function newTransitTrip() {
  return {
    id: uid("trp"),
    date: formatYMD(new Date()),
    from: "",
    to: "",
    mode: "网约车",
    amount: "",
    invoices: [],
  };
}

function newEntEvent() {
  return {
    id: uid("ent"),
    date: formatYMD(new Date()),
    party: "",
    guests: "",
    amount: "",
    meal: [],
    gift: [],
  };
}

function uid(prefix) {
  return `${prefix || "inv"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeDetailSheets(list) {
  if (!Array.isArray(list)) return [];
  return list.map((sheet) => ({
    id: sheet.id || uid("sheet"),
    title: sheet.title || "明细表",
    kind: sheet.kind || "custom",
    rows: Array.isArray(sheet.rows)
      ? sheet.rows.map((row) => ({
          id: row.id || uid("row"),
          date: row.date || "",
          description: row.description || "",
          amount: row.amount === 0 || row.amount ? String(row.amount) : "",
          hasInvoice: Boolean(row.hasInvoice),
          invoiceRef: row.invoiceRef || "",
          note: row.note || "",
        }))
      : [],
  }));
}

function sheetKindFromCategory(category) {
  const cat = category || "other";
  if (SHEET_KIND_META[cat]) return cat;
  if (cat === "other") return "other";
  return "other";
}

function ensureDetailSheet(kind, titleOverride) {
  const s = current();
  if (!Array.isArray(s.detailSheets)) s.detailSheets = [];
  const meta = SHEET_KIND_META[kind] || { kind: kind || "custom", title: titleOverride || "明细表" };
  let sheet = s.detailSheets.find((x) => x.kind === meta.kind);
  if (!sheet) {
    sheet = {
      id: uid("sheet"),
      title: titleOverride || meta.title,
      kind: meta.kind,
      rows: [],
    };
    s.detailSheets.push(sheet);
  } else if (titleOverride && !sheet.title) {
    sheet.title = titleOverride;
  }
  return sheet;
}

function newManualSheetRow() {
  return {
    id: uid("row"),
    date: formatYMD(new Date()),
    description: "",
    amount: "",
    hasInvoice: false,
    invoiceRef: "",
    note: "无发票",
  };
}

function rowFromInvoice(inv) {
  return {
    id: uid("row"),
    date: inv.date || "",
    description: inv.merchant || inv.fileName || "",
    amount: inv.amount == null ? "" : String(inv.amount),
    hasInvoice: true,
    invoiceRef: inv.id || "",
    note: inv.fileName ? `发票：${inv.fileName}` : "有发票",
  };
}

/** Append OCR/PDF-parsed invoices into category detail sheets (dedupe by invoiceRef). */
function ingestInvoicesToSheets(invoices) {
  if (!invoices?.length) return;
  const s = current();
  if (!Array.isArray(s.detailSheets)) s.detailSheets = [];
  for (const inv of invoices) {
    const kind = sheetKindFromCategory(inv.category);
    const sheet = ensureDetailSheet(kind);
    if (inv.id && sheet.rows.some((r) => r.invoiceRef === inv.id)) continue;
    sheet.rows.push(rowFromInvoice(inv));
  }
}

function removeSheetRowsByInvoice(invoiceId) {
  if (!invoiceId) return;
  const s = current();
  if (!Array.isArray(s.detailSheets)) return;
  for (const sheet of s.detailSheets) {
    sheet.rows = sheet.rows.filter((r) => r.invoiceRef !== invoiceId);
  }
  // Drop empty auto sheets that only existed for removed invoices (keep if titled/custom or any rows)
  s.detailSheets = s.detailSheets.filter((sheet) => sheet.rows.length > 0 || sheet.kind === "custom");
}

function sumDetailSheetManual() {
  const s = current();
  if (!Array.isArray(s.detailSheets)) return 0;
  let sum = 0;
  for (const sheet of s.detailSheets) {
    for (const row of sheet.rows) {
      if (row.hasInvoice) continue;
      const amt = parseAmount(row.amount);
      if (amt != null) sum += amt;
    }
  }
  return sum;
}

function sumDetailSheetsAll() {
  const s = current();
  if (!Array.isArray(s.detailSheets)) return [];
  return s.detailSheets.map((sheet) => {
    let total = 0;
    for (const row of sheet.rows) {
      const amt = parseAmount(row.amount);
      if (amt != null) total += amt;
    }
    return { id: sheet.id, title: sheet.title, kind: sheet.kind, total, rowCount: sheet.rows.length };
  });
}

function addBlankDetailSheet() {
  const s = current();
  if (!Array.isArray(s.detailSheets)) s.detailSheets = [];
  const n = s.detailSheets.filter((x) => x.kind === "custom").length + 1;
  s.detailSheets.push({
    id: uid("sheet"),
    title: `自定义表 ${n}`,
    kind: "custom",
    rows: [newManualSheetRow()],
  });
  saveCurrentDraft();
  render();
  toast("已添加明细表");
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

function parseAmount(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2200);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function current() {
  return drafts[activeScenario];
}

/**
 * Invoice OCR entry point.
 * If window.__invoiceOCR is set (e.g. by ocr-bridge.js), it is used; otherwise mock runs.
 * @param {File} file
 * @param {{ categoryHint?: string, dayDate?: string }} [opts]
 */
async function parseInvoice(file, opts = {}) {
  if (typeof window.__invoiceOCR === "function") {
    return window.__invoiceOCR(file, opts);
  }
  return parseInvoiceMock(file, opts);
}

async function parseInvoiceMock(file, opts = {}) {
  await new Promise((r) => setTimeout(r, 280 + Math.random() * 420));

  const category =
    opts.categoryHint && (CATEGORY_LABEL[opts.categoryHint] || MOCK_MERCHANTS[opts.categoryHint])
      ? opts.categoryHint
      : guessCategoryFromName(file.name);

  const merchants = MOCK_MERCHANTS[category] || MOCK_MERCHANTS.other;
  const merchant = merchants[Math.floor(Math.random() * merchants.length)];
  const amountBase =
    category === "lodging" ? 280 + Math.random() * 520 :
    category === "meal" ? 28 + Math.random() * 180 :
    category === "purchase" ? 40 + Math.random() * 600 :
    category === "transit" ? 8 + Math.random() * 120 :
    category === "gift" ? 50 + Math.random() * 400 :
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
  if (/meal|餐饮|food|餐厅|cafe|咖啡|lunch|dinner|宴/.test(n)) return "meal";
  if (/gift|礼品|礼盒/.test(n)) return "gift";
  if (/采购|purchase|办公|耗材|文具/.test(n)) return "purchase";
  if (/taxi|滴滴|地铁|transit|交通|打车/.test(n)) return "transit";
  return "other";
}

function isAcceptableFile(f) {
  return (
    f.type.startsWith("image/") ||
    f.type === "application/pdf" ||
    /\.(pdf|png|jpe?g|webp|gif|heic)$/i.test(f.name)
  );
}

async function filesToInvoices(fileList, opts = {}) {
  const files = Array.from(fileList || []).filter((f) => {
    const ok = isAcceptableFile(f);
    if (!ok) toast(`已跳过不支持的文件：${f.name}`);
    return ok;
  });
  if (!files.length) return [];

  const out = [];
  for (const file of files) {
    try {
      const parsed = await parseInvoice(file, opts);
      out.push({
        id: uid("inv"),
        amount: parsed.amount,
        merchant: parsed.merchant,
        date: parsed.date,
        category: parsed.category || opts.categoryHint || "other",
        confidence: parsed.confidence,
        source: parsed.source || "mock",
        fileName: file.name,
      });
    } catch (err) {
      console.error(err);
      toast(`解析失败：${file.name}`);
    }
  }
  return out;
}

function ocrLabel() {
  return typeof window.__invoiceOCR === "function" ? "OCR" : "mock 识别";
}

function storageKey(scenario) {
  return STORAGE_PREFIX + scenario;
}

function saveActiveScenario() {
  try {
    localStorage.setItem(ACTIVE_KEY, activeScenario);
  } catch (err) {
    console.warn("save active scenario failed", err);
  }
}

function saveCurrentDraft() {
  try {
    localStorage.setItem(storageKey(activeScenario), JSON.stringify(current()));
  } catch (err) {
    console.warn("localStorage save failed", err);
  }
}

function loadDraft(scenario) {
  try {
    const raw = localStorage.getItem(storageKey(scenario));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn("localStorage load failed", err);
    return null;
  }
}

function normalizeTravel(data) {
  const s = emptyTravel();
  if (!data) return s;
  s.startDate = data.startDate || "";
  s.endDate = data.endDate || "";
  s.city = data.city || "";
  s.reason = data.reason || "";
  s.days = Array.isArray(data.days)
    ? data.days.map((day) => ({
        date: day.date,
        lodging: Array.isArray(day.lodging) ? day.lodging : [],
        meal: Array.isArray(day.meal) ? day.meal : [],
        other: Array.isArray(day.other) ? day.other : [],
      }))
    : [];
  s.detailSheets = normalizeDetailSheets(data.detailSheets);
  return s;
}

function normalizePurchase(data) {
  const s = emptyPurchase();
  if (!data) return s;
  s.reason = data.reason || "";
  s.claimInvoices = Array.isArray(data.claimInvoices) ? data.claimInvoices : [];
  s.items = Array.isArray(data.items)
    ? data.items.map((it) => ({
        id: it.id || uid("pur"),
        name: it.name || "",
        vendor: it.vendor || "",
        date: it.date || "",
        amount: it.amount === 0 || it.amount ? String(it.amount) : "",
        invoices: Array.isArray(it.invoices) ? it.invoices : [],
      }))
    : [];
  s.detailSheets = normalizeDetailSheets(data.detailSheets);
  return s;
}

function normalizeLocalTransit(data) {
  const s = emptyLocalTransit();
  if (!data) return s;
  s.reason = data.reason || "";
  s.trips = Array.isArray(data.trips)
    ? data.trips.map((t) => ({
        id: t.id || uid("trp"),
        date: t.date || "",
        from: t.from || "",
        to: t.to || "",
        mode: t.mode || "网约车",
        amount: t.amount === 0 || t.amount ? String(t.amount) : "",
        invoices: Array.isArray(t.invoices) ? t.invoices : [],
      }))
    : [];
  s.detailSheets = normalizeDetailSheets(data.detailSheets);
  return s;
}

function normalizeEntertainment(data) {
  const s = emptyEntertainment();
  if (!data) return s;
  s.reason = data.reason || "";
  s.events = Array.isArray(data.events)
    ? data.events.map((e) => ({
        id: e.id || uid("ent"),
        date: e.date || "",
        party: e.party || "",
        guests: e.guests === 0 || e.guests ? String(e.guests) : "",
        amount: e.amount === 0 || e.amount ? String(e.amount) : "",
        meal: Array.isArray(e.meal) ? e.meal : [],
        gift: Array.isArray(e.gift) ? e.gift : [],
      }))
    : [];
  s.detailSheets = normalizeDetailSheets(data.detailSheets);
  return s;
}

function migrateLegacyTravel() {
  try {
    if (localStorage.getItem(storageKey("travel"))) return;
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    localStorage.setItem(storageKey("travel"), JSON.stringify(normalizeTravel(data)));
  } catch (err) {
    console.warn("legacy migrate failed", err);
  }
}

function loadAllDrafts() {
  migrateLegacyTravel();
  drafts.travel = normalizeTravel(loadDraft("travel")) || emptyTravel();
  drafts.purchase = normalizePurchase(loadDraft("purchase")) || emptyPurchase();
  drafts.local_transit = normalizeLocalTransit(loadDraft("local_transit")) || emptyLocalTransit();
  drafts.entertainment = normalizeEntertainment(loadDraft("entertainment")) || emptyEntertainment();

  try {
    const saved = localStorage.getItem(ACTIVE_KEY);
    if (saved && SCENARIO_META[saved]) activeScenario = saved;
  } catch (_) {}
}

function getGaps() {
  if (activeScenario === "travel") return getTravelGaps();
  if (activeScenario === "purchase") return getPurchaseGaps();
  if (activeScenario === "local_transit") return getTransitGaps();
  if (activeScenario === "entertainment") return getEntGaps();
  return [];
}

function getTravelGaps() {
  const s = drafts.travel;
  const gaps = [];
  for (const day of s.days) {
    const missing = [];
    if (!day.lodging.length) missing.push("住宿");
    if (!day.meal.length) missing.push("餐饮");
    if (missing.length) gaps.push({ key: day.date, label: `${day.date} ${weekdayCN(day.date)}`, missing });
  }
  return gaps;
}

function getPurchaseGaps() {
  const s = drafts.purchase;
  const gaps = [];
  const hasClaimInv = s.claimInvoices.length > 0;
  s.items.forEach((it, i) => {
    const missing = [];
    const amt = parseAmount(it.amount);
    if (amt == null) missing.push("金额");
    if (!it.invoices.length && !hasClaimInv) missing.push("发票");
    if (missing.length) {
      const name = it.name || `第 ${i + 1} 行`;
      gaps.push({ key: it.id, label: name, missing });
    }
  });
  return gaps;
}

function getTransitGaps() {
  const s = drafts.local_transit;
  const gaps = [];
  s.trips.forEach((t, i) => {
    const missing = [];
    if (!t.invoices.length) missing.push("票据/发票");
    if (missing.length) {
      const label = t.from && t.to ? `${t.from} → ${t.to}` : `第 ${i + 1} 次出行`;
      gaps.push({ key: t.id, label: `${t.date || ""} ${label}`.trim(), missing });
    }
  });
  return gaps;
}

function getEntGaps() {
  const s = drafts.entertainment;
  const gaps = [];
  s.events.forEach((e, i) => {
    const missing = [];
    if (!e.meal.length) missing.push("餐费发票");
    if (missing.length) {
      const label = e.party || `第 ${i + 1} 场`;
      gaps.push({ key: e.id, label: `${e.date || ""} ${label}`.trim(), missing });
    }
  });
  return gaps;
}

function computeTotals() {
  if (activeScenario === "travel") return computeTravelTotals();
  if (activeScenario === "purchase") return computePurchaseTotals();
  if (activeScenario === "local_transit") return computeTransitTotals();
  if (activeScenario === "entertainment") return computeEntTotals();
  return { rows: [], grand: 0 };
}

function computeTravelTotals() {
  const byCat = { lodging: 0, meal: 0, other: 0 };
  const byDay = drafts.travel.days.map((day) => {
    const lodging = sumInvoices(day.lodging);
    const meal = sumInvoices(day.meal);
    const other = sumInvoices(day.other);
    byCat.lodging += lodging;
    byCat.meal += meal;
    byCat.other += other;
    return { date: day.date, lodging, meal, other, total: lodging + meal + other };
  });
  const manual = sumDetailSheetManual();
  const rows = [
    { key: "lodging", label: "住宿", value: byCat.lodging },
    { key: "meal", label: "餐饮", value: byCat.meal },
    { key: "other", label: "交通·其他", value: byCat.other },
  ];
  if (manual > 0) rows.push({ key: "manual", label: "无票明细", value: manual });
  return {
    rows,
    byCat,
    byDay,
    grand: byCat.lodging + byCat.meal + byCat.other + manual,
    grandLabel: "行程合计（CNY）",
  };
}

function computePurchaseTotals() {
  const s = drafts.purchase;
  let itemsSum = 0;
  for (const it of s.items) {
    const amt = parseAmount(it.amount);
    if (amt != null) itemsSum += amt;
    else itemsSum += sumInvoices(it.invoices);
  }
  const claimSum = sumInvoices(s.claimInvoices);
  const hasLineAmounts = s.items.some((it) => parseAmount(it.amount) != null);
  const grand = hasLineAmounts ? itemsSum : itemsSum + claimSum;
  const manual = sumDetailSheetManual();
  const rows = [
    { key: "items", label: "明细金额", value: itemsSum },
    { key: "claim", label: "整单发票额", value: claimSum },
  ];
  if (manual > 0) rows.push({ key: "manual", label: "无票明细", value: manual });
  return {
    rows,
    grand: grand + manual,
    grandLabel: "采购合计（CNY）",
  };
}

function computeTransitTotals() {
  let sum = 0;
  for (const t of drafts.local_transit.trips) {
    const amt = parseAmount(t.amount);
    sum += amt != null ? amt : sumInvoices(t.invoices);
  }
  const manual = sumDetailSheetManual();
  const rows = [{ key: "trips", label: "出行次数金额", value: sum }];
  if (manual > 0) rows.push({ key: "manual", label: "无票明细", value: manual });
  return {
    rows,
    grand: sum + manual,
    grandLabel: "交通合计（CNY）",
  };
}

function computeEntTotals() {
  const byCat = { meal: 0, gift: 0 };
  let declared = 0;
  for (const e of drafts.entertainment.events) {
    byCat.meal += sumInvoices(e.meal);
    byCat.gift += sumInvoices(e.gift);
    const amt = parseAmount(e.amount);
    if (amt != null) declared += amt;
  }
  const invTotal = byCat.meal + byCat.gift;
  const grand = declared > 0 ? declared : invTotal;
  const manual = sumDetailSheetManual();
  const rows = [
    { key: "meal", label: "餐费", value: byCat.meal },
    { key: "gift", label: "礼品·其他", value: byCat.gift },
    { key: "declared", label: "申报金额", value: declared },
  ];
  if (manual > 0) rows.push({ key: "manual", label: "无票明细", value: manual });
  return {
    rows,
    byCat,
    grand: grand + manual,
    grandLabel: "招待合计（CNY）",
  };
}

function hasDetailSheetRows() {
  const sheets = current()?.detailSheets;
  return Array.isArray(sheets) && sheets.some((sh) => sh.rows?.length);
}

function hasContent() {
  if (hasDetailSheetRows()) return true;
  if (activeScenario === "travel") return drafts.travel.days.length > 0;
  if (activeScenario === "purchase") return drafts.purchase.items.length > 0;
  if (activeScenario === "local_transit") return drafts.local_transit.trips.length > 0;
  if (activeScenario === "entertainment") return drafts.entertainment.events.length > 0;
  return false;
}

function hasAnyInvoice() {
  if (activeScenario === "travel") {
    return drafts.travel.days.some((d) => d.lodging.length || d.meal.length || d.other.length);
  }
  if (activeScenario === "purchase") {
    const s = drafts.purchase;
    return s.claimInvoices.length > 0 || s.items.some((it) => it.invoices.length);
  }
  if (activeScenario === "local_transit") {
    return drafts.local_transit.trips.some((t) => t.invoices.length);
  }
  if (activeScenario === "entertainment") {
    return drafts.entertainment.events.some((e) => e.meal.length || e.gift.length);
  }
  return false;
}

function regenerateTimeline() {
  const s = drafts.travel;
  const dates = daysBetweenInclusive(s.startDate, s.endDate);
  const prev = new Map(s.days.map((d) => [d.date, d]));
  s.days = dates.map((date) => {
    const existing = prev.get(date);
    if (existing) {
      return {
        date: existing.date,
        lodging: existing.lodging || [],
        meal: existing.meal || [],
        other: existing.other || [],
      };
    }
    return { date, lodging: [], meal: [], other: [] };
  });
  saveCurrentDraft();
  render();
}

async function handleTravelFiles(dayDate, category, fileList) {
  const day = drafts.travel.days.find((d) => d.date === dayDate);
  if (!day) return;
  const invoices = await filesToInvoices(fileList, { categoryHint: category, dayDate });
  if (!invoices.length) return;
  if (!day[category]) day[category] = [];
  day[category].push(...invoices);
  ingestInvoicesToSheets(invoices);
  saveCurrentDraft();
  render();
  toast(`已添加 ${invoices.length} 张发票（${ocrLabel()}）· 已写入明细表`);
}

function removeTravelInvoice(dayDate, category, invoiceId) {
  const day = drafts.travel.days.find((d) => d.date === dayDate);
  if (!day || !day[category]) return;
  day[category] = day[category].filter((inv) => inv.id !== invoiceId);
  removeSheetRowsByInvoice(invoiceId);
  saveCurrentDraft();
  render();
}

async function handlePurchaseLineFiles(itemId, fileList) {
  const item = drafts.purchase.items.find((it) => it.id === itemId);
  if (!item) return;
  const invoices = await filesToInvoices(fileList, {
    categoryHint: "purchase",
    dayDate: item.date || formatYMD(new Date()),
  });
  if (!invoices.length) return;
  item.invoices.push(...invoices);
  if (parseAmount(item.amount) == null && invoices[0]) item.amount = String(invoices[0].amount);
  if (!item.vendor && invoices[0]?.merchant) item.vendor = invoices[0].merchant;
  if (!item.date && invoices[0]?.date) item.date = invoices[0].date;
  ingestInvoicesToSheets(invoices);
  saveCurrentDraft();
  render();
  toast(`已添加 ${invoices.length} 张发票（${ocrLabel()}）· 已写入明细表`);
}

async function handlePurchaseClaimFiles(fileList) {
  const invoices = await filesToInvoices(fileList, {
    categoryHint: "purchase",
    dayDate: formatYMD(new Date()),
  });
  if (!invoices.length) return;
  drafts.purchase.claimInvoices.push(...invoices);
  ingestInvoicesToSheets(invoices);
  saveCurrentDraft();
  render();
  toast(`已添加 ${invoices.length} 张整单发票（${ocrLabel()}）· 已写入明细表`);
}

function removePurchaseLineInvoice(itemId, invoiceId) {
  const item = drafts.purchase.items.find((it) => it.id === itemId);
  if (!item) return;
  item.invoices = item.invoices.filter((inv) => inv.id !== invoiceId);
  removeSheetRowsByInvoice(invoiceId);
  saveCurrentDraft();
  render();
}

function removePurchaseClaimInvoice(invoiceId) {
  drafts.purchase.claimInvoices = drafts.purchase.claimInvoices.filter((inv) => inv.id !== invoiceId);
  removeSheetRowsByInvoice(invoiceId);
  saveCurrentDraft();
  render();
}

async function handleTransitFiles(tripId, fileList) {
  const trip = drafts.local_transit.trips.find((t) => t.id === tripId);
  if (!trip) return;
  const invoices = await filesToInvoices(fileList, {
    categoryHint: "transit",
    dayDate: trip.date || formatYMD(new Date()),
  });
  if (!invoices.length) return;
  trip.invoices.push(...invoices);
  if (parseAmount(trip.amount) == null && invoices[0]) trip.amount = String(invoices[0].amount);
  if (!trip.date && invoices[0]?.date) trip.date = invoices[0].date;
  ingestInvoicesToSheets(invoices);
  saveCurrentDraft();
  render();
  toast(`已添加 ${invoices.length} 张票据（${ocrLabel()}）· 已写入明细表`);
}

function removeTransitInvoice(tripId, invoiceId) {
  const trip = drafts.local_transit.trips.find((t) => t.id === tripId);
  if (!trip) return;
  trip.invoices = trip.invoices.filter((inv) => inv.id !== invoiceId);
  removeSheetRowsByInvoice(invoiceId);
  saveCurrentDraft();
  render();
}

async function handleEntFiles(eventId, category, fileList) {
  const ev = drafts.entertainment.events.find((e) => e.id === eventId);
  if (!ev) return;
  const invoices = await filesToInvoices(fileList, {
    categoryHint: category === "gift" ? "gift" : "meal",
    dayDate: ev.date || formatYMD(new Date()),
  });
  if (!invoices.length) return;
  if (!ev[category]) ev[category] = [];
  ev[category].push(...invoices);
  if (parseAmount(ev.amount) == null) {
    const total = sumInvoices(ev.meal) + sumInvoices(ev.gift);
    if (total > 0) ev.amount = String(Math.round(total * 100) / 100);
  }
  ingestInvoicesToSheets(invoices);
  saveCurrentDraft();
  render();
  toast(`已添加 ${invoices.length} 张发票（${ocrLabel()}）· 已写入明细表`);
}

function removeEntInvoice(eventId, category, invoiceId) {
  const ev = drafts.entertainment.events.find((e) => e.id === eventId);
  if (!ev || !ev[category]) return;
  ev[category] = ev[category].filter((inv) => inv.id !== invoiceId);
  removeSheetRowsByInvoice(invoiceId);
  saveCurrentDraft();
  render();
}

function buildDraftPayload() {
  const totals = computeTotals();
  const gaps = getGaps();
  const base = {
    product: "填空报销",
    version: 2,
    scenario: activeScenario,
    scenarioLabel: SCENARIO_META[activeScenario].label,
    generatedAt: new Date().toISOString(),
    totals: {
      rows: totals.rows,
      grandTotal: totals.grand,
      currency: "CNY",
    },
    gaps: gaps.map((g) => ({ key: g.key, label: g.label, missing: g.missing })),
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
     *   //     { id: "scenario", type: "input", value: scenario },
     *   //     { id: "amount", type: "amount", value: totals.grandTotal },
     *   //   ]),
     *   // });
     *
     * ---------------------------------------------------------------------------
     */
    feishuApprovalStub: {
      status: "not_submitted",
      note: "Prototype only — see commented stub in app.js buildDraftPayload()",
    },
    detailSheets: (current().detailSheets || []).map((sheet) => ({
      id: sheet.id,
      title: sheet.title,
      kind: sheet.kind,
      rows: sheet.rows.map((r) => ({
        id: r.id,
        date: r.date,
        description: r.description,
        amount: parseAmount(r.amount),
        hasInvoice: r.hasInvoice,
        invoiceRef: r.invoiceRef || null,
        note: r.note || "",
      })),
      subtotal: sheet.rows.reduce((acc, r) => acc + (parseAmount(r.amount) || 0), 0),
    })),
  };

  if (activeScenario === "travel") {
    const s = drafts.travel;
    const t = totals;
    return {
      ...base,
      trip: {
        startDate: s.startDate,
        endDate: s.endDate,
        city: s.city,
        reason: s.reason,
        dayCount: s.days.length,
      },
      days: s.days.map((day, i) => ({
        dayIndex: i + 1,
        date: day.date,
        weekday: weekdayCN(day.date),
        slots: { lodging: day.lodging, meal: day.meal, other: day.other },
        subtotal: t.byDay[i],
        gaps: gaps.find((g) => g.key === day.date)?.missing || [],
      })),
      totals: {
        lodging: t.byCat.lodging,
        meal: t.byCat.meal,
        other: t.byCat.other,
        tripTotal: t.grand,
        grandTotal: t.grand,
        currency: "CNY",
      },
    };
  }

  if (activeScenario === "purchase") {
    const s = drafts.purchase;
    return {
      ...base,
      purchase: {
        reason: s.reason,
        claimInvoices: s.claimInvoices,
        items: s.items.map((it) => ({
          id: it.id,
          name: it.name,
          vendor: it.vendor,
          date: it.date,
          amount: parseAmount(it.amount),
          invoices: it.invoices,
          gaps: gaps.find((g) => g.key === it.id)?.missing || [],
        })),
      },
    };
  }

  if (activeScenario === "local_transit") {
    const s = drafts.local_transit;
    return {
      ...base,
      localTransit: {
        reason: s.reason,
        trips: s.trips.map((t) => ({
          id: t.id,
          date: t.date,
          from: t.from,
          to: t.to,
          mode: t.mode,
          amount: parseAmount(t.amount),
          invoices: t.invoices,
          gaps: gaps.find((g) => g.key === t.id)?.missing || [],
        })),
      },
    };
  }

  const s = drafts.entertainment;
  return {
    ...base,
    entertainment: {
      reason: s.reason,
      events: s.events.map((e) => ({
        id: e.id,
        date: e.date,
        party: e.party,
        guests: e.guests === "" ? null : Number(e.guests),
        amount: parseAmount(e.amount),
        slots: { meal: e.meal, gift: e.gift },
        gaps: gaps.find((g) => g.key === e.id)?.missing || [],
      })),
    },
  };
}

function buildHumanSummary(payload) {
  const lines = [];
  lines.push("【填空报销 · 草稿摘要】");
  lines.push(`场景：${payload.scenarioLabel}（${payload.scenario}）`);

  if (payload.scenario === "travel") {
    lines.push(`城市：${payload.trip.city || "（未填）"}`);
    lines.push(`事由：${payload.trip.reason || "（未填）"}`);
    lines.push(
      `行程：${payload.trip.startDate || "?"} ~ ${payload.trip.endDate || "?"}（共 ${payload.trip.dayCount} 天）`
    );
    lines.push("");
    for (const day of payload.days) {
      const gapText = day.gaps.length ? ` ⚠ 缺：${day.gaps.join("、")}` : "";
      lines.push(`■ ${day.date} ${day.weekday}${gapText}`);
      for (const def of TRAVEL_SLOT_DEFS) {
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
  } else if (payload.scenario === "purchase") {
    lines.push(`事由：${payload.purchase.reason || "（未填）"}`);
    lines.push(`明细行数：${payload.purchase.items.length}`);
    lines.push(`整单发票：${payload.purchase.claimInvoices.length} 张`);
    lines.push("");
    payload.purchase.items.forEach((it, i) => {
      const gapText = it.gaps.length ? ` ⚠ 缺：${it.gaps.join("、")}` : "";
      lines.push(`■ ${i + 1}. ${it.name || "（未填品名）"}${gapText}`);
      lines.push(`  供应商：${it.vendor || "—"} · 日期：${it.date || "—"} · 金额：${formatCNY(it.amount)}`);
      if (it.invoices.length) {
        for (const inv of it.invoices) {
          lines.push(`  · 发票：${inv.merchant} ${formatCNY(inv.amount)}（${inv.fileName || "文件"}）`);
        }
      } else {
        lines.push("  · 行发票：—");
      }
    });
    if (payload.purchase.claimInvoices.length) {
      lines.push("");
      lines.push("整单发票：");
      for (const inv of payload.purchase.claimInvoices) {
        lines.push(`  · ${inv.merchant} ${formatCNY(inv.amount)}（${inv.fileName || "文件"}）`);
      }
    }
    lines.push("");
    lines.push(`采购合计：${formatCNY(payload.totals.grandTotal)} CNY`);
  } else if (payload.scenario === "local_transit") {
    lines.push(`事由：${payload.localTransit.reason || "（未填）"}`);
    lines.push(`出行次数：${payload.localTransit.trips.length}`);
    lines.push("");
    payload.localTransit.trips.forEach((t, i) => {
      const gapText = t.gaps.length ? ` ⚠ 缺：${t.gaps.join("、")}` : "";
      lines.push(`■ ${i + 1}. ${t.date || "?"} ${t.from || "?"} → ${t.to || "?"}（${t.mode || "?"}）${gapText}`);
      lines.push(`  金额：${formatCNY(t.amount)}`);
      if (t.invoices.length) {
        for (const inv of t.invoices) {
          lines.push(`  · 票据：${inv.merchant} ${formatCNY(inv.amount)}（${inv.fileName || "文件"}）`);
        }
      } else {
        lines.push("  · 票据：—");
      }
    });
    lines.push("");
    lines.push(`交通合计：${formatCNY(payload.totals.grandTotal)} CNY`);
  } else if (payload.scenario === "entertainment") {
    lines.push(`整体事由：${payload.entertainment.reason || "（未填）"}`);
    lines.push(`场次数：${payload.entertainment.events.length}`);
    lines.push("");
    payload.entertainment.events.forEach((e, i) => {
      const gapText = e.gaps.length ? ` ⚠ 缺：${e.gaps.join("、")}` : "";
      lines.push(`■ ${i + 1}. ${e.date || "?"} · ${e.party || "（未填对象）"} · ${e.guests ?? "?"}人${gapText}`);
      lines.push(`  申报金额：${formatCNY(e.amount)}`);
      for (const def of ENT_SLOT_DEFS) {
        const list = e.slots[def.key] || [];
        if (!list.length) {
          lines.push(`  · ${def.label}：—`);
          continue;
        }
        for (const inv of list) {
          lines.push(`  · ${def.label}：${inv.merchant} ${formatCNY(inv.amount)}（${inv.fileName || "文件"}）`);
        }
      }
    });
    lines.push("");
    lines.push(`招待合计：${formatCNY(payload.totals.grandTotal)} CNY`);
  }

  if (payload.detailSheets?.length) {
    lines.push("");
    lines.push("—— 分类明细表 ——");
    for (const sheet of payload.detailSheets) {
      lines.push(`■ ${sheet.title}（${sheet.rows.length} 行 · 小计 ${formatCNY(sheet.subtotal)}）`);
      sheet.rows.forEach((r, i) => {
        const flag = r.hasInvoice ? "有票" : "无票";
        lines.push(
          `  ${i + 1}. ${r.date || "—"} · ${r.description || "（未填）"} · ${formatCNY(r.amount)} · ${flag}${r.note ? ` · ${r.note}` : ""}`
        );
      });
    }
  }

  if (payload.gaps.length) {
    lines.push("");
    lines.push("缺口：");
    for (const g of payload.gaps) {
      lines.push(`  - ${g.label}：缺 ${g.missing.join("、")}`);
    }
  } else {
    lines.push("");
    lines.push("缺口：无");
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
  const stamp = (payload.generatedAt || "").slice(0, 10).replace(/-/g, "") || "draft";
  a.href = url;
  a.download = `填空报销草稿_${payload.scenario || "claim"}_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function openDraftModal() {
  if (!hasContent()) {
    toast(activeScenario === "travel" ? "请先设置行程日期" : "请先添加至少一条明细");
    return;
  }
  const payload = buildDraftPayload();
  lastDraft = payload;
  document.getElementById("draft-summary").textContent = buildHumanSummary(payload);
  document.getElementById("draft-modal").classList.add("open");
  downloadJSON(payload);
  toast("已下载 JSON 草稿");
}

function renderInvoiceCard(inv, removeAttrs) {
  const confPct = Math.round((inv.confidence || 0) * 100);
  const confClass = confPct < 80 ? "confidence low" : "confidence";
  return `
    <div class="invoice">
      <div class="invoice-top">
        <div class="invoice-merchant">${escapeHtml(inv.merchant)}</div>
        <div class="invoice-amount">${formatCNY(inv.amount)}</div>
      </div>
      <div class="invoice-meta">
        <span>${escapeHtml(inv.date || "")}</span>
        <span class="${confClass}">${confPct}% · ${escapeHtml(inv.source || "mock")}</span>
        <span title="${escapeHtml(inv.fileName || "")}">${escapeHtml(truncate(inv.fileName || "文件", 18))}</span>
      </div>
      <div class="invoice-actions">
        <button type="button" class="btn btn-danger btn-sm" data-remove-invoice ${removeAttrs}>移除</button>
      </div>
    </div>`;
}

function bindDropZone(el, onFiles) {
  const input = el.querySelector('input[type="file"]');
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("drag-over");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    if (e.dataTransfer?.files?.length) onFiles(e.dataTransfer.files);
  });
  input?.addEventListener("change", () => {
    if (input.files?.length) {
      onFiles(input.files);
      input.value = "";
    }
  });
}

function render() {
  renderScenarioChrome();
  renderMetaPanels();
  renderTotals();
  renderGaps();
  renderStickyBar();
  renderContent();
  renderDetailSheets();
  updateFlowSteps();
}

function renderScenarioChrome() {
  const meta = SCENARIO_META[activeScenario];
  document.querySelectorAll(".scenario-tab").forEach((btn) => {
    const on = btn.dataset.scenario === activeScenario;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.getElementById("scenario-hint").textContent = meta.hint;
  document.getElementById("content-heading").textContent = meta.contentTitle;
  document.getElementById("content-hint").textContent = meta.contentHint;

  const flowLabels = document.querySelectorAll("#flow-steps-list .flow-label");
  if (flowLabels[0]) flowLabels[0].textContent = meta.flow1;
  if (flowLabels[1]) flowLabels[1].textContent = meta.flow2;

  document.querySelectorAll("[data-scenario-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.scenarioPanel !== activeScenario;
  });

  const actions = document.getElementById("content-actions");
  if (activeScenario === "travel") {
    actions.innerHTML = "";
  } else if (activeScenario === "purchase") {
    actions.innerHTML = `<button type="button" class="btn btn-secondary btn-sm" id="btn-add-item">＋ 添加采购行</button>`;
    actions.querySelector("#btn-add-item")?.addEventListener("click", () => {
      drafts.purchase.items.push(newPurchaseItem());
      saveCurrentDraft();
      render();
    });
  } else if (activeScenario === "local_transit") {
    actions.innerHTML = `<button type="button" class="btn btn-secondary btn-sm" id="btn-add-trip">＋ 添加出行</button>`;
    actions.querySelector("#btn-add-trip")?.addEventListener("click", () => {
      drafts.local_transit.trips.push(newTransitTrip());
      saveCurrentDraft();
      render();
    });
  } else if (activeScenario === "entertainment") {
    actions.innerHTML = `<button type="button" class="btn btn-secondary btn-sm" id="btn-add-event">＋ 添加场次</button>`;
    actions.querySelector("#btn-add-event")?.addEventListener("click", () => {
      drafts.entertainment.events.push(newEntEvent());
      saveCurrentDraft();
      render();
    });
  }
}

function renderMetaPanels() {
  if (activeScenario === "travel") {
    const s = drafts.travel;
    const startEl = document.getElementById("start-date");
    const endEl = document.getElementById("end-date");
    const cityEl = document.getElementById("city");
    const reasonEl = document.getElementById("reason-travel");
    if (document.activeElement !== startEl) startEl.value = s.startDate;
    if (document.activeElement !== endEl) endEl.value = s.endDate;
    if (document.activeElement !== cityEl) cityEl.value = s.city;
    if (document.activeElement !== reasonEl) reasonEl.value = s.reason;

    const hint = document.getElementById("day-count-hint");
    if (!s.startDate || !s.endDate) {
      hint.textContent = "请选择起止日期以生成按天时间轴";
    } else if (parseYMD(s.endDate) < parseYMD(s.startDate)) {
      hint.textContent = "结束日期不能早于开始日期";
    } else {
      hint.textContent = `共 ${s.days.length} 天 · 改日期会保留重叠日期上的发票`;
    }
    return;
  }

  if (activeScenario === "purchase") {
    const s = drafts.purchase;
    const reasonEl = document.getElementById("reason-purchase");
    if (document.activeElement !== reasonEl) reasonEl.value = s.reason;

    const box = document.getElementById("purchase-claim-invoices");
    box.innerHTML = s.claimInvoices
      .map((inv) => renderInvoiceCard(inv, `data-kind="claim" data-id="${inv.id}"`))
      .join("");
    box.querySelectorAll("[data-remove-invoice]").forEach((btn) => {
      btn.addEventListener("click", () => removePurchaseClaimInvoice(btn.dataset.id));
    });
    return;
  }

  if (activeScenario === "local_transit") {
    const reasonEl = document.getElementById("reason-local_transit");
    if (document.activeElement !== reasonEl) reasonEl.value = drafts.local_transit.reason;
    return;
  }

  if (activeScenario === "entertainment") {
    const reasonEl = document.getElementById("reason-entertainment");
    if (document.activeElement !== reasonEl) reasonEl.value = drafts.entertainment.reason;
  }
}

function renderTotals() {
  const totals = computeTotals();
  const panel = document.getElementById("totals-panel");
  const stats = totals.rows
    .map(
      (r) => `
      <div class="stat">
        <div class="label">${escapeHtml(r.label)}</div>
        <div class="value">${formatCNY(r.value)}</div>
      </div>`
    )
    .join("");
  panel.innerHTML =
    stats +
    `
    <div class="stat total">
      <div class="label">${escapeHtml(totals.grandLabel || "合计（CNY）")}</div>
      <div class="value">${formatCNY(totals.grand)}</div>
    </div>`;
}

function renderGaps() {
  const box = document.getElementById("gap-summary");
  if (!hasContent()) {
    const msg =
      activeScenario === "travel"
        ? "设置行程后，将显示缺少住宿或餐饮的日期"
        : "添加明细后，将显示缺口提示";
    box.innerHTML = `
      <div class="gap-item ok">
        <span class="gap-dot"></span>
        <span>${msg}</span>
      </div>`;
    return;
  }
  const gaps = getGaps();
  if (!gaps.length) {
    box.innerHTML = `
      <div class="gap-item ok">
        <span class="gap-dot"></span>
        <span>太好了！当前没有缺口</span>
      </div>`;
    return;
  }
  box.innerHTML = gaps
    .map(
      (g) => `
      <div class="gap-item">
        <span class="gap-dot"></span>
        <span><strong>${escapeHtml(g.label)}</strong>：缺 ${escapeHtml(g.missing.join("、"))}</span>
      </div>`
    )
    .join("");
}

function renderStickyBar() {
  const bar = document.getElementById("sticky-cta");
  const totalEl = document.getElementById("sticky-total");
  const gapsEl = document.getElementById("sticky-gaps");
  const totals = computeTotals();
  const gaps = getGaps();
  const ready = hasContent();
  bar.hidden = !ready;
  totalEl.textContent = `合计 ${formatCNY(totals.grand)}`;
  gapsEl.textContent = ready ? (gaps.length ? `缺口 ${gaps.length}` : "缺口 0") : "缺口 —";
  ["btn-draft", "btn-draft-sticky"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !ready;
  });
}

function updateFlowSteps() {
  const steps = document.querySelectorAll(".flow-step");
  if (!steps.length) return;
  const ready = hasContent();
  const gaps = getGaps();
  const anyInv = hasAnyInvoice();
  steps.forEach((el) => el.classList.remove("is-active", "is-done"));
  steps[0].classList.add(ready ? "is-done" : "is-active");
  if (ready) steps[1].classList.add(anyInv ? "is-done" : "is-active");
  if (anyInv) steps[2].classList.add(gaps.length === 0 ? "is-done" : "is-active");
  if (ready && gaps.length === 0 && anyInv) steps[3].classList.add("is-active");
}

function renderDetailSheets() {
  const host = document.getElementById("detail-sheets");
  if (!host) return;
  const s = current();
  if (!Array.isArray(s.detailSheets)) s.detailSheets = [];
  const sheets = s.detailSheets;

  host.hidden = false;
  if (!sheets.length) {
    host.innerHTML = `
      <div class="detail-sheets-head">
        <div>
          <h2>分类明细表</h2>
          <p class="section-hint">上传发票后按类别自动生成（如餐饮表、物品表）；也可手动添加无票支出。</p>
        </div>
        <div class="detail-sheets-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-add-sheet>＋ 添加明细表</button>
        </div>
      </div>
      <div class="detail-sheets-empty">
        暂无明细表。上传发票后会出现「餐饮表 / 物品表」等；也可先点「添加明细表」登记无票支出。
      </div>`;
    host.querySelector("[data-add-sheet]")?.addEventListener("click", addBlankDetailSheet);
    return;
  }

  host.innerHTML = `
    <div class="detail-sheets-head">
      <div>
        <h2>分类明细表</h2>
        <p class="section-hint">表名可改；单元格可编辑；「添加行」可登记无发票支出。</p>
      </div>
      <div class="detail-sheets-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-add-sheet>＋ 添加明细表</button>
      </div>
    </div>
    <div class="detail-sheets-stack">
      ${sheets
        .map((sheet) => {
          const subtotal = sheet.rows.reduce((acc, r) => acc + (parseAmount(r.amount) || 0), 0);
          const rowsHtml = sheet.rows.length
            ? sheet.rows
                .map(
                  (row) => `
            <tr data-row-id="${row.id}">
              <td><input type="date" data-sheet-field="date" data-sheet="${sheet.id}" data-row="${row.id}" value="${escapeHtml(row.date)}" /></td>
              <td><input type="text" data-sheet-field="description" data-sheet="${sheet.id}" data-row="${row.id}" value="${escapeHtml(row.description)}" placeholder="商户 / 品名 / 说明" /></td>
              <td><input type="number" min="0" step="0.01" data-sheet-field="amount" data-sheet="${sheet.id}" data-row="${row.id}" value="${escapeHtml(row.amount)}" placeholder="0.00" /></td>
              <td class="sheet-flag">
                <span class="sheet-badge ${row.hasInvoice ? "has-inv" : "no-inv"}">${row.hasInvoice ? "有发票" : "无发票"}</span>
              </td>
              <td><input type="text" data-sheet-field="note" data-sheet="${sheet.id}" data-row="${row.id}" value="${escapeHtml(row.note)}" placeholder="备注" /></td>
              <td class="sheet-row-actions">
                <button type="button" class="btn btn-danger btn-sm" data-remove-row data-sheet="${sheet.id}" data-row="${row.id}">删除</button>
              </td>
            </tr>`
                )
                .join("")
            : `<tr class="sheet-empty-row"><td colspan="6">暂无行 · 点「添加行」或上传发票</td></tr>`;
          return `
        <article class="detail-sheet-card" data-sheet-id="${sheet.id}">
          <div class="detail-sheet-card-head">
            <div class="detail-sheet-title-wrap">
              <label class="sr-only" for="sheet-title-${sheet.id}">表名</label>
              <input
                class="detail-sheet-title"
                id="sheet-title-${sheet.id}"
                type="text"
                data-sheet-title="${sheet.id}"
                value="${escapeHtml(sheet.title)}"
                placeholder="表名（可改）"
              />
              <span class="muted-sm">${sheet.rows.length} 行 · 小计 ${formatCNY(subtotal)}</span>
            </div>
            <div class="detail-sheet-card-actions">
              <button type="button" class="btn btn-secondary btn-sm" data-add-row="${sheet.id}">＋ 添加行</button>
              <button type="button" class="btn btn-danger btn-sm" data-remove-sheet="${sheet.id}">删除表</button>
            </div>
          </div>
          <div class="detail-sheet-table-wrap">
            <table class="detail-sheet-table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>说明 / 商户</th>
                  <th>金额</th>
                  <th>发票</th>
                  <th>备注</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </article>`;
        })
        .join("")}
    </div>`;

  host.querySelector("[data-add-sheet]")?.addEventListener("click", addBlankDetailSheet);

  host.querySelectorAll("[data-sheet-title]").forEach((input) => {
    const apply = () => {
      const sheet = s.detailSheets.find((x) => x.id === input.dataset.sheetTitle);
      if (!sheet) return;
      sheet.title = input.value.trim() || sheet.title || "明细表";
      saveCurrentDraft();
    };
    input.addEventListener("change", () => {
      apply();
      renderTotals();
      renderStickyBar();
    });
    input.addEventListener("input", apply);
  });

  host.querySelectorAll("[data-sheet-field]").forEach((input) => {
    const apply = () => {
      const sheet = s.detailSheets.find((x) => x.id === input.dataset.sheet);
      const row = sheet?.rows.find((r) => r.id === input.dataset.row);
      if (!row) return;
      row[input.dataset.sheetField] = input.value;
      saveCurrentDraft();
    };
    input.addEventListener("change", () => {
      apply();
      renderTotals();
      renderStickyBar();
      // refresh subtotal labels without full re-render to keep focus — light re-render ok
      const active = document.activeElement;
      const keep =
        active?.dataset?.sheetField
          ? { sheet: active.dataset.sheet, row: active.dataset.row, field: active.dataset.sheetField }
          : null;
      renderDetailSheets();
      if (keep) {
        const el = host.querySelector(
          `[data-sheet-field="${keep.field}"][data-sheet="${keep.sheet}"][data-row="${keep.row}"]`
        );
        if (el) {
          el.focus();
          if (typeof el.selectionStart === "number") {
            const len = el.value.length;
            el.setSelectionRange(len, len);
          }
        }
      }
    });
    input.addEventListener("input", apply);
  });

  host.querySelectorAll("[data-add-row]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sheet = s.detailSheets.find((x) => x.id === btn.dataset.addRow);
      if (!sheet) return;
      sheet.rows.push(newManualSheetRow());
      saveCurrentDraft();
      render();
      toast("已添加无票明细行");
    });
  });

  host.querySelectorAll("[data-remove-row]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sheet = s.detailSheets.find((x) => x.id === btn.dataset.sheet);
      if (!sheet) return;
      sheet.rows = sheet.rows.filter((r) => r.id !== btn.dataset.row);
      saveCurrentDraft();
      render();
    });
  });

  host.querySelectorAll("[data-remove-sheet]").forEach((btn) => {
    btn.addEventListener("click", () => {
      s.detailSheets = s.detailSheets.filter((x) => x.id !== btn.dataset.removeSheet);
      saveCurrentDraft();
      render();
      toast("已删除明细表");
    });
  });
}

function renderContent() {
  const root = document.getElementById("main-content");
  if (activeScenario === "travel") return renderTravelContent(root);
  if (activeScenario === "purchase") return renderPurchaseContent(root);
  if (activeScenario === "local_transit") return renderTransitContent(root);
  if (activeScenario === "entertainment") return renderEntContent(root);
}

function renderTravelContent(root) {
  const s = drafts.travel;
  const totals = computeTravelTotals();
  if (!s.days.length) {
    root.innerHTML = `
      <div class="empty-state">
        <strong>还没有行程天数</strong>
        <span>在上方选择开始与结束日期后，会按天生成「住宿 / 餐饮 / 交通·其他」填空槽位。</span>
      </div>`;
    return;
  }
  const gapMap = new Map(getTravelGaps().map((g) => [g.key, g.missing]));
  root.innerHTML = s.days
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
            ${TRAVEL_SLOT_DEFS.map((def) => renderTravelSlot(day, def)).join("")}
          </div>
        </article>`;
    })
    .join("");

  root.querySelectorAll(".slot").forEach((slotEl) => {
    bindDropZone(slotEl, (files) =>
      handleTravelFiles(slotEl.dataset.date, slotEl.dataset.category, files)
    );
  });
  root.querySelectorAll("[data-remove-invoice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      removeTravelInvoice(btn.dataset.date, btn.dataset.category, btn.dataset.id);
    });
  });
}

function renderTravelSlot(day, def) {
  const list = day[def.key] || [];
  const sum = sumInvoices(list);
  const required = def.key === "lodging" || def.key === "meal";
  const isMissing = required && !list.length;
  const isFilled = list.length > 0;
  const stateClass = isFilled ? "is-filled" : isMissing ? "is-missing" : "";
  const missingHint = isMissing ? `<div class="slot-missing">尚未填入${def.label}</div>` : "";
  const body = list.length
    ? `<div class="invoice-list">${list
        .map((inv) =>
          renderInvoiceCard(
            inv,
            `data-date="${day.date}" data-category="${def.key}" data-id="${inv.id}"`
          )
        )
        .join("")}</div>`
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

function renderPurchaseContent(root) {
  const s = drafts.purchase;
  if (!s.items.length) {
    root.innerHTML = `
      <div class="empty-state">
        <strong>还没有采购明细</strong>
        <span>点击右上角「添加采购行」，填写品名 / 供应商 / 日期 / 金额，并上传发票。</span>
      </div>`;
    return;
  }
  const gapMap = new Map(getPurchaseGaps().map((g) => [g.key, g.missing]));
  root.innerHTML = `<div class="line-list">${s.items
    .map((it, idx) => {
      const missing = gapMap.get(it.id) || [];
      const hasGap = missing.length > 0;
      const filled = it.invoices.length > 0;
      return `
        <article class="line-card ${hasGap ? "has-gap" : ""}" data-item-id="${it.id}">
          <div class="line-head">
            <div class="line-title">
              <span>第 ${idx + 1} 行</span>
              ${
                hasGap
                  ? `<span class="day-badge gap">缺 ${missing.join("、")}</span>`
                  : `<span class="day-badge ok">齐全</span>`
              }
            </div>
            <div class="line-actions">
              <button type="button" class="btn btn-danger btn-sm" data-remove-item="${it.id}">删除行</button>
            </div>
          </div>
          <div class="line-body">
            <div class="line-fields">
              <div class="field">
                <label>品名</label>
                <input type="text" data-field="name" data-id="${it.id}" value="${escapeHtml(it.name)}" placeholder="例如：A4 打印纸" />
              </div>
              <div class="field">
                <label>供应商</label>
                <input type="text" data-field="vendor" data-id="${it.id}" value="${escapeHtml(it.vendor)}" placeholder="供应商名称" />
              </div>
              <div class="field">
                <label>日期</label>
                <input type="date" data-field="date" data-id="${it.id}" value="${escapeHtml(it.date)}" />
              </div>
              <div class="field">
                <label>金额（CNY）</label>
                <input type="number" min="0" step="0.01" data-field="amount" data-id="${it.id}" value="${escapeHtml(it.amount)}" placeholder="0.00" />
              </div>
            </div>
            <div class="line-attach ${filled ? "is-filled" : hasGap && missing.includes("发票") ? "is-missing" : ""}" data-attach-item="${it.id}">
              <div class="line-attach-head">
                <span>行发票</span>
                <span class="slot-sum">${it.invoices.length ? formatCNY(sumInvoices(it.invoices)) : "—"}</span>
              </div>
              <label class="btn btn-secondary upload-btn">
                上传发票
                <input class="file-input-hidden" type="file" accept="image/*,application/pdf,.pdf,.png,.jpg,.jpeg,.webp,.gif" multiple />
              </label>
              ${
                it.invoices.length
                  ? `<div class="invoice-list">${it.invoices
                      .map((inv) =>
                        renderInvoiceCard(inv, `data-kind="line" data-item="${it.id}" data-id="${inv.id}"`)
                      )
                      .join("")}</div>`
                  : `<div class="slot-empty"><div class="drop-hint">拖入 PDF / 图片</div><div>或点上传</div></div>`
              }
              ${hasGap && missing.includes("发票") ? `<div class="slot-missing">尚未挂发票（行或整单）</div>` : ""}
            </div>
          </div>
        </article>`;
    })
    .join("")}</div>`;

  root.querySelectorAll("[data-field]").forEach((input) => {
    input.addEventListener("change", () => {
      const item = s.items.find((x) => x.id === input.dataset.id);
      if (!item) return;
      item[input.dataset.field] = input.value;
      saveCurrentDraft();
      renderGaps();
      renderTotals();
      renderStickyBar();
      updateFlowSteps();
    });
    input.addEventListener("input", () => {
      const item = s.items.find((x) => x.id === input.dataset.id);
      if (!item) return;
      item[input.dataset.field] = input.value;
      saveCurrentDraft();
    });
  });

  root.querySelectorAll("[data-remove-item]").forEach((btn) => {
    btn.addEventListener("click", () => {
      drafts.purchase.items = drafts.purchase.items.filter((x) => x.id !== btn.dataset.removeItem);
      saveCurrentDraft();
      render();
    });
  });

  root.querySelectorAll("[data-attach-item]").forEach((el) => {
    bindDropZone(el, (files) => handlePurchaseLineFiles(el.dataset.attachItem, files));
  });

  root.querySelectorAll('[data-remove-invoice][data-kind="line"]').forEach((btn) => {
    btn.addEventListener("click", () => removePurchaseLineInvoice(btn.dataset.item, btn.dataset.id));
  });
}

function renderTransitContent(root) {
  const s = drafts.local_transit;
  if (!s.trips.length) {
    root.innerHTML = `
      <div class="empty-state">
        <strong>还没有出行记录</strong>
        <span>点击右上角「添加出行」，填写日期、起终点、方式与金额，并上传票据。</span>
      </div>`;
    return;
  }
  const gapMap = new Map(getTransitGaps().map((g) => [g.key, g.missing]));
  root.innerHTML = `<div class="line-list">${s.trips
    .map((t, idx) => {
      const missing = gapMap.get(t.id) || [];
      const hasGap = missing.length > 0;
      const filled = t.invoices.length > 0;
      const modeOpts = TRANSIT_MODES.map(
        (m) => `<option value="${m}" ${t.mode === m ? "selected" : ""}>${m}</option>`
      ).join("");
      return `
        <article class="line-card ${hasGap ? "has-gap" : ""}" data-trip-id="${t.id}">
          <div class="line-head">
            <div class="line-title">
              <span>第 ${idx + 1} 次</span>
              ${
                hasGap
                  ? `<span class="day-badge gap">缺 ${missing.join("、")}</span>`
                  : `<span class="day-badge ok">齐全</span>`
              }
            </div>
            <div class="line-actions">
              <button type="button" class="btn btn-danger btn-sm" data-remove-trip="${t.id}">删除</button>
            </div>
          </div>
          <div class="line-body">
            <div class="line-fields cols-5">
              <div class="field">
                <label>日期</label>
                <input type="date" data-field="date" data-id="${t.id}" value="${escapeHtml(t.date)}" />
              </div>
              <div class="field">
                <label>起点</label>
                <input type="text" data-field="from" data-id="${t.id}" value="${escapeHtml(t.from)}" placeholder="起点" />
              </div>
              <div class="field">
                <label>终点</label>
                <input type="text" data-field="to" data-id="${t.id}" value="${escapeHtml(t.to)}" placeholder="终点" />
              </div>
              <div class="field">
                <label>方式</label>
                <select data-field="mode" data-id="${t.id}">${modeOpts}</select>
              </div>
              <div class="field">
                <label>金额（CNY）</label>
                <input type="number" min="0" step="0.01" data-field="amount" data-id="${t.id}" value="${escapeHtml(t.amount)}" placeholder="0.00" />
              </div>
            </div>
            <div class="line-attach ${filled ? "is-filled" : hasGap ? "is-missing" : ""}" data-attach-trip="${t.id}">
              <div class="line-attach-head">
                <span>票据 / 发票</span>
                <span class="slot-sum">${t.invoices.length ? formatCNY(sumInvoices(t.invoices)) : "—"}</span>
              </div>
              <label class="btn btn-secondary upload-btn">
                上传票据
                <input class="file-input-hidden" type="file" accept="image/*,application/pdf,.pdf,.png,.jpg,.jpeg,.webp,.gif" multiple />
              </label>
              ${
                t.invoices.length
                  ? `<div class="invoice-list">${t.invoices
                      .map((inv) =>
                        renderInvoiceCard(inv, `data-kind="trip" data-trip="${t.id}" data-id="${inv.id}"`)
                      )
                      .join("")}</div>`
                  : `<div class="slot-empty"><div class="drop-hint">拖入 PDF / 图片</div><div>或点上传</div></div>`
              }
              ${hasGap ? `<div class="slot-missing">尚未上传票据</div>` : ""}
            </div>
          </div>
        </article>`;
    })
    .join("")}</div>`;

  root.querySelectorAll("[data-field]").forEach((input) => {
    const apply = () => {
      const trip = s.trips.find((x) => x.id === input.dataset.id);
      if (!trip) return;
      trip[input.dataset.field] = input.value;
      saveCurrentDraft();
    };
    input.addEventListener("change", () => {
      apply();
      renderGaps();
      renderTotals();
      renderStickyBar();
      updateFlowSteps();
    });
    input.addEventListener("input", apply);
  });

  root.querySelectorAll("[data-remove-trip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      drafts.local_transit.trips = drafts.local_transit.trips.filter((x) => x.id !== btn.dataset.removeTrip);
      saveCurrentDraft();
      render();
    });
  });

  root.querySelectorAll("[data-attach-trip]").forEach((el) => {
    bindDropZone(el, (files) => handleTransitFiles(el.dataset.attachTrip, files));
  });

  root.querySelectorAll('[data-remove-invoice][data-kind="trip"]').forEach((btn) => {
    btn.addEventListener("click", () => removeTransitInvoice(btn.dataset.trip, btn.dataset.id));
  });
}

function renderEntContent(root) {
  const s = drafts.entertainment;
  if (!s.events.length) {
    root.innerHTML = `
      <div class="empty-state">
        <strong>还没有招待场次</strong>
        <span>点击右上角「添加场次」，填写日期、对象/事由、人数与金额，并上传餐费 / 礼品发票。</span>
      </div>`;
    return;
  }
  const gapMap = new Map(getEntGaps().map((g) => [g.key, g.missing]));
  root.innerHTML = `<div class="line-list">${s.events
    .map((e, idx) => {
      const missing = gapMap.get(e.id) || [];
      const hasGap = missing.length > 0;
      return `
        <article class="line-card ${hasGap ? "has-gap" : ""}" data-event-id="${e.id}">
          <div class="line-head">
            <div class="line-title">
              <span>第 ${idx + 1} 场</span>
              ${
                hasGap
                  ? `<span class="day-badge gap">缺 ${missing.join("、")}</span>`
                  : `<span class="day-badge ok">齐全</span>`
              }
            </div>
            <div class="line-actions">
              <button type="button" class="btn btn-danger btn-sm" data-remove-event="${e.id}">删除</button>
            </div>
          </div>
          <div class="line-body">
            <div class="line-fields">
              <div class="field">
                <label>日期</label>
                <input type="date" data-field="date" data-id="${e.id}" value="${escapeHtml(e.date)}" />
              </div>
              <div class="field field-span-2">
                <label>对象 / 事由</label>
                <input type="text" data-field="party" data-id="${e.id}" value="${escapeHtml(e.party)}" placeholder="例如：XX 客户答谢宴" />
              </div>
              <div class="field">
                <label>人数</label>
                <input type="number" min="1" step="1" data-field="guests" data-id="${e.id}" value="${escapeHtml(e.guests)}" placeholder="人数" />
              </div>
              <div class="field">
                <label>金额（CNY）</label>
                <input type="number" min="0" step="0.01" data-field="amount" data-id="${e.id}" value="${escapeHtml(e.amount)}" placeholder="0.00" />
              </div>
            </div>
            <div class="line-slots">
              ${ENT_SLOT_DEFS.map((def) => renderEntSlot(e, def)).join("")}
            </div>
          </div>
        </article>`;
    })
    .join("")}</div>`;

  root.querySelectorAll("[data-field]").forEach((input) => {
    const apply = () => {
      const ev = s.events.find((x) => x.id === input.dataset.id);
      if (!ev) return;
      ev[input.dataset.field] = input.value;
      saveCurrentDraft();
    };
    input.addEventListener("change", () => {
      apply();
      renderGaps();
      renderTotals();
      renderStickyBar();
      updateFlowSteps();
    });
    input.addEventListener("input", apply);
  });

  root.querySelectorAll("[data-remove-event]").forEach((btn) => {
    btn.addEventListener("click", () => {
      drafts.entertainment.events = drafts.entertainment.events.filter(
        (x) => x.id !== btn.dataset.removeEvent
      );
      saveCurrentDraft();
      render();
    });
  });

  root.querySelectorAll(".slot").forEach((slotEl) => {
    bindDropZone(slotEl, (files) =>
      handleEntFiles(slotEl.dataset.event, slotEl.dataset.category, files)
    );
  });

  root.querySelectorAll("[data-remove-invoice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      removeEntInvoice(btn.dataset.event, btn.dataset.category, btn.dataset.id);
    });
  });
}

function renderEntSlot(ev, def) {
  const list = ev[def.key] || [];
  const sum = sumInvoices(list);
  const isMissing = def.required && !list.length;
  const isFilled = list.length > 0;
  const stateClass = isFilled ? "is-filled" : isMissing ? "is-missing" : "";
  const missingHint = isMissing ? `<div class="slot-missing">尚未填入${def.label}</div>` : "";
  const body = list.length
    ? `<div class="invoice-list">${list
        .map((inv) =>
          renderInvoiceCard(
            inv,
            `data-event="${ev.id}" data-category="${def.key}" data-id="${inv.id}"`
          )
        )
        .join("")}</div>`
    : `<div class="slot-empty">
         <div class="icon" aria-hidden="true">${def.icon}</div>
         <div class="drop-hint">拖入 PDF / 图片</div>
         <div>或点上方上传</div>
       </div>`;

  return `
    <div class="slot ent-slot ${stateClass}" data-event="${ev.id}" data-category="${def.key}">
      <div class="slot-head">
        <span class="slot-label">${def.label}${def.required ? "" : " · 可选"}</span>
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

function switchScenario(next) {
  if (!SCENARIO_META[next] || next === activeScenario) return;
  saveCurrentDraft();
  activeScenario = next;
  saveActiveScenario();
  lastDraft = null;
  render();
  toast(`已切换到「${SCENARIO_META[next].label}」`);
}

function resetCurrent() {
  const label = SCENARIO_META[activeScenario].label;
  if (!confirm(`确定清空「${label}」场景的当前草稿？其他场景不受影响。`)) return;
  if (activeScenario === "travel") drafts.travel = emptyTravel();
  else if (activeScenario === "purchase") drafts.purchase = emptyPurchase();
  else if (activeScenario === "local_transit") drafts.local_transit = emptyLocalTransit();
  else if (activeScenario === "entertainment") drafts.entertainment = emptyEntertainment();
  lastDraft = null;
  saveCurrentDraft();
  render();
  toast("已清空当前场景草稿");
}

function bindEvents() {
  document.querySelectorAll(".scenario-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchScenario(btn.dataset.scenario));
  });

  const startEl = document.getElementById("start-date");
  const endEl = document.getElementById("end-date");
  const onDates = () => {
    drafts.travel.startDate = startEl.value;
    drafts.travel.endDate = endEl.value;
    regenerateTimeline();
  };
  startEl.addEventListener("change", onDates);
  endEl.addEventListener("change", onDates);

  document.getElementById("city").addEventListener("input", (e) => {
    drafts.travel.city = e.target.value;
    saveCurrentDraft();
  });
  document.getElementById("reason-travel").addEventListener("input", (e) => {
    drafts.travel.reason = e.target.value;
    saveCurrentDraft();
  });
  document.getElementById("reason-purchase").addEventListener("input", (e) => {
    drafts.purchase.reason = e.target.value;
    saveCurrentDraft();
  });
  document.getElementById("reason-local_transit").addEventListener("input", (e) => {
    drafts.local_transit.reason = e.target.value;
    saveCurrentDraft();
  });
  document.getElementById("reason-entertainment").addEventListener("input", (e) => {
    drafts.entertainment.reason = e.target.value;
    saveCurrentDraft();
  });

  const claimFile = document.getElementById("purchase-claim-file");
  claimFile?.addEventListener("change", () => {
    if (claimFile.files?.length) {
      handlePurchaseClaimFiles(claimFile.files);
      claimFile.value = "";
    }
  });

  document.getElementById("btn-reset").addEventListener("click", resetCurrent);
  document.getElementById("btn-draft").addEventListener("click", openDraftModal);
  document.getElementById("btn-draft-sticky")?.addEventListener("click", openDraftModal);

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
    const payload = lastDraft || buildDraftPayload();
    downloadJSON(payload);
    toast("已下载 JSON");
  });
}

loadAllDrafts();
bindEvents();
if (
  activeScenario === "travel" &&
  drafts.travel.startDate &&
  drafts.travel.endDate &&
  !drafts.travel.days.length
) {
  regenerateTimeline();
} else {
  render();
}
