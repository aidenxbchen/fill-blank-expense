#!/usr/bin/env node
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const start = src.indexOf("const INCOMPLETE_OCR_MSG");
const end = src.indexOf("function restoreState");
assert.ok(start > 0 && end > start, "resume helpers missing");
const snippet = src.slice(start, end) + `
function invoiceHasAmount(inv) {
  if (!inv || inv.amount === "" || inv.amount == null) return false;
  return Number.isFinite(Number(inv.amount));
}
`;
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(snippet + "; this.ExpenseOCRResume = window.ExpenseOCRResume;", sandbox);
const api = sandbox.window.ExpenseOCRResume;
assert.equal(api.INCOMPLETE_OCR_MSG, "上次识别未完成，请核对后手动补全或重新上传");

const parsing = { id: "a", status: "parsing", fileName: "a.pdf", attachment: { file_id: "x".repeat(32) } };
const incomplete = { id: "b", status: "error", error: api.INCOMPLETE_OCR_MSG, fileName: "b.pdf", amount: "" };
const ok = { id: "c", status: "ok", amount: 12, fileName: "c.pdf" };
const noFile = { id: "d", status: "parsing" };

assert.equal(api.invoiceNeedsStoredReparse(parsing), true);
assert.equal(api.invoiceNeedsStoredReparse(incomplete), true);
assert.equal(api.invoiceNeedsStoredReparse(ok), false);

const prepared = api.prepareInvoicesForResume([parsing, incomplete, ok, noFile]);
assert.equal(prepared.toResume.length, 2);
assert.equal(prepared.invoices.find((i) => i.id === "a").status, "parsing");
assert.equal(prepared.invoices.find((i) => i.id === "a").phase, "queued");
assert.equal(prepared.invoices.find((i) => i.id === "d").status, "error");
assert.equal(prepared.invoices.find((i) => i.id === "d").error, api.INCOMPLETE_OCR_MSG);
assert.equal(prepared.invoices.find((i) => i.id === "c").status, "ok");
console.log("test-ocr-resume: ok");
