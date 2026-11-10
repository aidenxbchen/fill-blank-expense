/**
 * Local Xiaomi-OCR bridge for fill-blank-expense.
 * Sets window.__invoiceOCR so app.js uses the local OCR server instead of mock.
 *
 * Requires: python3 ocr/server.py  (http://127.0.0.1:18790)
 * On failure this throws — app.js will surface the error; leave __invoiceOCR
 * unset (or omit this script) to keep the built-in mock fallback.
 */
(function () {
  "use strict";

  // Localhost → direct OCR port; public tunnel hostname → same-origin /api proxy
  var OCR_BASE =
    location.hostname === "127.0.0.1" || location.hostname === "localhost"
      ? "http://127.0.0.1:18790"
      : "";

  async function checkHealth() {
    var res = await fetch(OCR_BASE + "/api/health", {
      method: "GET",
      mode: "cors",
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error("OCR 健康检查失败 HTTP " + res.status);
    }
    var data = await res.json();
    if (!data || !data.ok) {
      throw new Error("OCR 服务未就绪");
    }
    if (data.ollamaReachable === false) {
      console.info(
        "本机 OCR 暂不可达（" +
          (data.endpoint || "http://127.0.0.1:11434/v1") +
          "）。图片识别可能失败；字段校对可用顶栏「AI 设置」（推荐 Deepseek）。"
      );
    }
    return data;
  }

  /**
   * @param {File} file
   * @param {{ categoryHint?: string, dayDate?: string }} [opts]
   * @returns {Promise<{amount:number, merchant:string, date:string, category:string, confidence:number, source:string, raw?:string}>}
   */
  async function invoiceOCR(file, opts) {
    opts = opts || {};
    await checkHealth();

    var form = new FormData();
    if (!opts.attachment) {form.append("file", file, file.name || "invoice");if(opts.draftId)form.append("draftId",opts.draftId);if(opts.invoiceId)form.append("invoiceId",opts.invoiceId);}
    if (opts.categoryHint) form.append("categoryHint", opts.categoryHint);
    if (opts.dayDate) form.append("dayDate", opts.dayDate);

    var res = await fetch(OCR_BASE + "/api/parse-invoice", {
      method: "POST",
      mode: "cors",
      credentials: "include",
      headers: opts.attachment ? {"Content-Type":"application/json"} : {},
      body: opts.attachment ? JSON.stringify({attachment:opts.attachment,draftId:opts.draftId,invoiceId:opts.invoiceId}) : form,
    });

    var text = await res.text();
    var data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      throw new Error("OCR 返回非 JSON: " + text.slice(0, 200));
    }

    if (!res.ok) {
      var msg =
        (data && (data.error || data.message)) ||
        "OCR 失败 HTTP " + res.status;
      var error = new Error(msg);
      error.attachment = data && data.attachment;
      error.duplicate = !!(data && data.duplicate);
      throw error;
    }

    if (!data) {
      throw new Error("OCR 结果为空");
    }

    var known = { lodging: 1, meal: 1, other: 1, purchase: 1, transit: 1, gift: 1 };
    var hintPreferred = { meal: 1, lodging: 1, purchase: 1, transit: 1, gift: 1 };
    var category = data.category;
    if (!known[category]) {
      category = opts.categoryHint || "other";
    } else if (category === "other" && opts.categoryHint && hintPreferred[opts.categoryHint]) {
      // User uploaded into a typed slot; don't force 「其他」from vague OCR
      category = opts.categoryHint;
    }

    var amount = typeof data.amount === "number" ? data.amount : Number(data.amount);
    if (!Number.isFinite(amount)) amount = null;

    return {
      amount: amount,
      attachment: data.attachment || null,
      merchant: data.merchant != null ? String(data.merchant) : "",
      date: data.date || opts.dayDate || "",
      invoiceNo: data.invoice_no || data.invoiceNo || "",
      invoiceCode:data.invoice_code || data.invoiceCode || "", items:data.items || [], quantity:data.quantity, unit:data.unit || "", quantityMode:data.quantity_mode || "default",
      category: category,
      confidence:
        typeof data.confidence === "number"
          ? data.confidence
          : Number(data.confidence) || 0,
      source: data.source || "xiaomi-ocr-0",
      raw: data.raw,
      extract_method: data.extract_method || "",
      review_model: data.reviewModel || data.review_model || "",
      review_error: data.review_error || data.reviewError || "",
      review_setup_needed: !!data.review_setup_needed,
      corrections: Array.isArray(data.corrections) ? data.corrections : [],
      needsReview: !!data.needs_review || amount == null,
    };
  }

  window.__storeInvoiceFile = async function (file, context) {
    var form = new FormData(); form.append("file", file, file.name || "invoice.pdf");
    if(context && context.draftId)form.append("draftId",context.draftId);if(context && context.invoiceId)form.append("invoiceId",context.invoiceId);
    var response = await fetch(OCR_BASE + "/api/invoice-files", {method:"POST", credentials:"include", body:form});
    var result = await response.json();
    if (!response.ok || !result.ok || !result.attachment) {var e=new Error(result.error || "原件保存失败");e.duplicate=!!result.duplicate;throw e;}
    return result.attachment;
  };
  window.__invoiceOCR = invoiceOCR;
})();
