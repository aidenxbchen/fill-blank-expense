/**
 * Team reimbursement policy + rule-based interview queue (v1, no LLM).
 * Structure leaves room for a later LLM plug-in via window.__expenseInterviewLLM.
 */
(function (global) {
  "use strict";

  const POLICY = {
    version: 1,
    name: "典型中国初创团队报销规范（演示）",
    locale: "zh-CN",
    requirePurpose: true,
    categories: {
      lodging: {
        label: "住宿",
        dailyCapOptional: 500,
        requireDate: true,
        askPrivatePublic: false,
      },
      meal: {
        label: "餐饮",
        dailyCapOptional: 120,
        askAttendees: true,
        askAlcohol: true,
        askPrivatePublic: true,
        requireDate: true,
      },
      entertainment: {
        label: "招待宴请",
        requireGuestCompany: true,
        askAttendees: true,
        askAlcohol: true,
        askPrivatePublic: true,
      },
      purchase: {
        label: "采购",
        requireProject: true,
        requirePurposeDetail: true,
      },
      transit: {
        label: "交通",
        askRoute: true,
        requireDate: true,
      },
      gift: {
        label: "礼品",
        requireGuestCompany: true,
        requirePurposeDetail: true,
      },
      other: {
        label: "其他",
        requirePurposeDetail: true,
      },
    },
    global: {
      askCashNoInvoice: true,
      askCostCenter: true,
      softWarnOverCap: true,
    },
  };

  const CAT_LABEL = {
    lodging: "住宿",
    meal: "餐饮",
    entertainment: "招待",
    purchase: "采购",
    transit: "交通",
    gift: "礼品",
    other: "其他",
  };

  function answered(answers, id) {
    const v = answers[id];
    if (v == null) return false;
    if (typeof v === "string") return v.trim().length > 0;
    if (typeof v === "boolean") return true;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  }

  function catsPresent(invoices) {
    const set = new Set();
    (invoices || []).forEach((inv) => {
      if (inv && inv.category) set.add(inv.category);
    });
    return set;
  }

  function missingDates(invoices) {
    return (invoices || []).filter((inv) => !inv.date || String(inv.date).trim() === "");
  }

  function categoryConflicts(invoices) {
    // Soft: merchant keywords vs OCR category
    const conflicts = [];
    const hotelRe = /酒店|宾馆|旅店|Hilton|Marriott|如家|全季|亚朵/i;
    const mealRe = /餐|饭店|火锅|咖啡|茶|麦当劳|肯德基|海底捞|星巴克/i;
    (invoices || []).forEach((inv) => {
      const m = inv.merchant || "";
      if (hotelRe.test(m) && inv.category && inv.category !== "lodging") {
        conflicts.push({ id: inv.id, merchant: m, category: inv.category, suggest: "lodging" });
      } else if (mealRe.test(m) && inv.category && !["meal", "entertainment"].includes(inv.category)) {
        conflicts.push({ id: inv.id, merchant: m, category: inv.category, suggest: "meal" });
      }
    });
    return conflicts;
  }

  function overCapHints(invoices, policy) {
    const hints = [];
    const byDayMeal = {};
    const byDayLodge = {};
    (invoices || []).forEach((inv) => {
      const d = inv.date || "unknown";
      const amt = Number(inv.amount) || 0;
      if (inv.category === "meal") {
        byDayMeal[d] = (byDayMeal[d] || 0) + amt;
      }
      if (inv.category === "lodging") {
        byDayLodge[d] = (byDayLodge[d] || 0) + amt;
      }
    });
    const mealCap = policy.categories.meal.dailyCapOptional;
    const lodgeCap = policy.categories.lodging.dailyCapOptional;
    Object.entries(byDayMeal).forEach(([d, sum]) => {
      if (mealCap && sum > mealCap) hints.push({ kind: "meal", date: d, sum, cap: mealCap });
    });
    Object.entries(byDayLodge).forEach(([d, sum]) => {
      if (lodgeCap && sum > lodgeCap) hints.push({ kind: "lodging", date: d, sum, cap: lodgeCap });
    });
    return hints;
  }

  /**
   * Build ordered interview questions from invoices + current answers.
   * Returns array of { id, text, hint?, chips?: string[], input: 'chips'|'text'|'chips+text', required: boolean, meta? }
   */
  function buildQuestionQueue(invoices, answers, policy) {
    policy = policy || POLICY;
    answers = answers || {};
    const q = [];
    const cats = catsPresent(invoices);
    const hasMeal = cats.has("meal") || cats.has("entertainment");
    const hasPurchase = cats.has("purchase");
    const hasGift = cats.has("gift");
    const hasTransit = cats.has("transit") || cats.has("other");
    const hasLodge = cats.has("lodging");
    const treatAsEnt =
      cats.has("entertainment") ||
      answers.expenseKind === "entertainment" ||
      (hasMeal && answers.isEntertainment === true);

    // 1) Overall purpose — always
    if (policy.requirePurpose && !answered(answers, "purpose")) {
      q.push({
        id: "purpose",
        text: "这次报销的主要事由是什么？",
        hint: "一句话即可，例如：拜访客户 / 团建 / 采购办公用品",
        chips: ["客户拜访", "出差会议", "团建活动", "采购物资", "招待客户", "其他"],
        input: "chips+text",
        required: true,
      });
    }

    // 2) Cost center / project — global soft + purchase hard
    if (policy.global.askCostCenter && !answered(answers, "costCenter")) {
      q.push({
        id: "costCenter",
        text: "费用归属哪个项目 / 成本中心？",
        hint: hasPurchase ? "采购类建议写清项目名" : "没有可写「日常运营」",
        chips: (function () {
          const fromBudgets = [];
          (global.__approvedBudgets || []).forEach(function (b) {
            const label = (b && (b.project || b.title)) || "";
            if (label && fromBudgets.indexOf(label) === -1) fromBudgets.push(label);
          });
          ["日常运营", "销售项目", "研发项目", "市场活动", "待定"].forEach(function (c) {
            if (fromBudgets.indexOf(c) === -1) fromBudgets.push(c);
          });
          return fromBudgets;
        })(),
        input: "chips+text",
        required: hasPurchase || Boolean(policy.categories.purchase.requireProject && hasPurchase),
      });
    }

    // 3) Entertainment vs personal meal
    if (hasMeal && !answered(answers, "isEntertainment") && !cats.has("entertainment")) {
      q.push({
        id: "isEntertainment",
        text: "餐饮发票是对外招待，还是同事内部用餐？",
        chips: ["对外招待", "内部用餐", "个人垫付出差餐"],
        input: "chips",
        required: true,
        map: {
          "对外招待": true,
          "内部用餐": false,
          "个人垫付出差餐": false,
        },
      });
    }

    if ((treatAsEnt || cats.has("entertainment") || cats.has("gift")) && !answered(answers, "guestCompany")) {
      if (policy.categories.entertainment.requireGuestCompany || hasGift) {
        q.push({
          id: "guestCompany",
          text: "招待 / 礼品的对方公司或客户是谁？",
          hint: "写公司名或客户名",
          chips: ["暂不方便透露", "个人客户"],
          input: "chips+text",
          required: true,
        });
      }
    }

    if ((hasMeal || treatAsEnt) && policy.categories.meal.askAttendees && !answered(answers, "attendees")) {
      q.push({
        id: "attendees",
        text: "一起用餐的人有哪些？（己方 + 对方）",
        hint: "例如：我、张三；客户李四",
        chips: ["仅自己", "2 人", "3–5 人", "5 人以上"],
        input: "chips+text",
        required: true,
      });
    }

    if ((hasMeal || treatAsEnt) && policy.categories.meal.askAlcohol && !answered(answers, "hasAlcohol")) {
      q.push({
        id: "hasAlcohol",
        text: "账单里是否包含酒水？",
        chips: ["没有酒水", "有酒水（可报）", "有酒水（自费剔除）"],
        input: "chips",
        required: true,
      });
    }

    if ((hasMeal || treatAsEnt) && policy.categories.meal.askPrivatePublic && !answered(answers, "privatePublic")) {
      q.push({
        id: "privatePublic",
        text: "这是对公商务费用，还是偏私人性质？",
        chips: ["对公商务", "私人（不报）", "部分对公"],
        input: "chips",
        required: true,
      });
    }

    if (hasPurchase && !answered(answers, "purchaseProject")) {
      q.push({
        id: "purchaseProject",
        text: "采购对应的项目名称是？",
        hint: "例如：官网改版、展会物料",
        chips: ["与上方成本中心相同", "办公行政"],
        input: "chips+text",
        required: true,
      });
    }

    if (hasTransit && policy.categories.transit.askRoute && !answered(answers, "transitContext")) {
      q.push({
        id: "transitContext",
        text: "交通费主要用于什么行程？",
        chips: ["机场/车站往返", "客户拜访市内", "办公通勤补贴", "其他"],
        input: "chips+text",
        required: false,
      });
    }

    if (hasLodge && !answered(answers, "travelCity")) {
      q.push({
        id: "travelCity",
        text: "住宿对应的出差城市是？",
        chips: ["北京", "上海", "深圳", "杭州", "其他"],
        input: "chips+text",
        required: false,
      });
    }

    const miss = missingDates(invoices);
    if (miss.length && !answered(answers, "fixMissingDates")) {
      const names = miss
        .slice(0, 3)
        .map((i) => i.merchant || i.fileName || "未命名")
        .join("、");
      q.push({
        id: "fixMissingDates",
        text: `有 ${miss.length} 张发票缺日期（如 ${names}）。请补一个统一日期，或说明各张日期。`,
        hint: "可填 YYYY-MM-DD，或「按文件名」",
        chips: ["用上传日", "稍后在草稿里改"],
        input: "chips+text",
        required: true,
        meta: { missingIds: miss.map((i) => i.id) },
      });
    }

    const conflicts = categoryConflicts(invoices);
    if (conflicts.length && !answered(answers, "resolveCategoryConflict")) {
      const c0 = conflicts[0];
      q.push({
        id: "resolveCategoryConflict",
        text: `「${c0.merchant}」识别为 ${CAT_LABEL[c0.category] || c0.category}，但名称更像 ${CAT_LABEL[c0.suggest] || c0.suggest}。如何归类？`,
        chips: [
          `改为${CAT_LABEL[c0.suggest] || c0.suggest}`,
          `保持${CAT_LABEL[c0.category] || c0.category}`,
          "拆成多类（稍后草稿改）",
        ],
        input: "chips",
        required: true,
        meta: { conflict: c0 },
      });
    }

    if (policy.global.askCashNoInvoice && !answered(answers, "cashNoInvoice")) {
      q.push({
        id: "cashNoInvoice",
        text: "还有没有「无发票」的现金支出要一并报销？",
        chips: ["没有了", "有，稍后在草稿添加", "有地铁/停车等小额"],
        input: "chips+text",
        required: false,
      });
    }

    if (policy.global.softWarnOverCap) {
      const caps = overCapHints(invoices, policy);
      if (caps.length && !answered(answers, "overCapAck")) {
        const c0 = caps[0];
        const label = c0.kind === "meal" ? "餐饮" : "住宿";
        q.push({
          id: "overCapAck",
          text: `${c0.date === "unknown" ? "某日" : c0.date} ${label}合计 ¥${c0.sum.toFixed(2)}，超过建议上限 ¥${c0.cap}。如何处理？`,
          chips: ["知道了，仍要报销", "会在草稿里拆分/自费", "金额有误，稍后改"],
          input: "chips",
          required: false,
          meta: { caps },
        });
      }
    }

    // Optional free note before finish — only if queue otherwise empty we don't force
    if (q.length === 0 && !answered(answers, "extraNote") && !answers.__skipExtra) {
      // no forced extra
    }

    return q;
  }

  function remainingCount(invoices, answers, policy) {
    return buildQuestionQueue(invoices, answers, policy).length;
  }

  function nextQuestion(invoices, answers, policy) {
    const queue = buildQuestionQueue(invoices, answers, policy);
    return queue[0] || null;
  }

  /**
   * Optional LLM hook: if window.__expenseInterviewLLM is a function,
   * app may call it with { invoices, answers, policy, ruleQuestion } and use its question.
   * v1 does not call it by default.
   */
  global.ExpensePolicy = {
    POLICY,
    CAT_LABEL,
    buildQuestionQueue,
    remainingCount,
    nextQuestion,
    categoryConflicts,
    missingDates,
    overCapHints,
  };
})(typeof window !== "undefined" ? window : globalThis);
