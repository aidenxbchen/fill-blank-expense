/**
 * Local Xiaomi-OCR bridge for fill-blank-expense.
 * Sets window.__invoiceOCR so app.js uses the local OCR server instead of mock.
 *
 * Requires: python3 ocr/server.py  (http://127.0.0.1:8788)
 * On failure this throws — app.js will surface the error; leave __invoiceOCR
 * unset (or omit this script) to keep the built-in mock fallback.
 */
(function () {
  "use strict";

  var OCR_BASE = "http://127.0.0.1:8788";

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
      throw new Error(
        "OCR 桥接已启动，但 Ollama 不可达（" +
          (data.endpoint || "http://127.0.0.1:11434/v1") +
          "）。请先 ollama serve 并 pull 模型。"
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
    form.append("file", file, file.name || "invoice");
    if (opts.categoryHint) form.append("categoryHint", opts.categoryHint);
    if (opts.dayDate) form.append("dayDate", opts.dayDate);

    var res = await fetch(OCR_BASE + "/api/parse-invoice", {
      method: "POST",
      mode: "cors",
      body: form,
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
      throw new Error(msg);
    }

    if (!data || typeof data.amount !== "number") {
      throw new Error("OCR 结果缺少 amount");
    }

    var category = data.category;
    if (category !== "lodging" && category !== "meal" && category !== "other") {
      category = opts.categoryHint || "other";
    }

    return {
      amount: data.amount,
      merchant: data.merchant != null ? String(data.merchant) : "",
      date: data.date || opts.dayDate || "",
      category: category,
      confidence:
        typeof data.confidence === "number"
          ? data.confidence
          : Number(data.confidence) || 0,
      source: data.source || "xiaomi-ocr-0",
      raw: data.raw,
    };
  }

  window.__invoiceOCR = invoiceOCR;
})();
