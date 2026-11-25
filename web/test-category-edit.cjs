#!/usr/bin/env node
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const start = src.indexOf("function fieldWasEdited(entry, key)");
const end = src.indexOf("// Exported for unit tests: OCR merge must keep user-picked");
assert.ok(start > 0 && end > start, "merge helpers missing");
const after = src.indexOf("window.ExpenseInvoiceMerge = {", end);
const close = src.indexOf("};", after);
assert.ok(after > 0 && close > after);
const snippet =
  src.slice(start, close + 2) +
  `
function normalizeCategory(c) {
  const known = { meal:1, lodging:1, transit:1, purchase:1, other:1 };
  return c && known[c] ? c : "other";
}
`;
const sandbox = { window: {}, console, session:{answers:{}}, queueTravelMatch(){} };
vm.createContext(sandbox);
vm.runInContext(snippet + "; this.ExpenseInvoiceMerge = window.ExpenseInvoiceMerge;", sandbox);
const api = sandbox.window.ExpenseInvoiceMerge;

const entry = {
  id: "inv-1",
  fileName: "a.pdf",
  category: "meal",
  amount: 241,
  merchant: "手改商户",
  date: "2026-11-01",
  invoiceNo: "NO1",
  _editedFields: { category: true, merchant: true },
  _userEdited: true,
};
api.applyParsedInvoice(entry, {
  amount: 99,
  merchant: "OCR商户",
  date: "2026-11-09",
  invoiceNo: "OCRNO",
  category: "purchase",
  confidence: 0.9,
  needsReview: false,
});
assert.equal(entry.category, "meal", "user category must stick");
assert.equal(entry.merchant, "手改商户", "user merchant must stick");
assert.equal(entry.amount, 99, "unedited amount takes OCR");
assert.equal(entry.date, "2026-11-09");
assert.equal(entry.status, "ok");

const fresh = { id: "inv-2", fileName: "b.pdf", _editedFields: {} };
api.applyParsedInvoice(fresh, { amount: 10, merchant: "M", date: "2026-11-08", invoiceNo: "X", category: "transit" });
assert.equal(fresh.category, "transit");
assert.equal(fresh.merchant, "M");

// Simulate N successive category edits surviving concurrent OCR merges
const rows = ["meal", "transit", "lodging", "purchase"].map((cat, i) => ({
  id: "r" + i,
  fileName: "f" + i + ".pdf",
  category: cat,
  amount: 100 + i,
  _editedFields: { category: true },
  _userEdited: true,
}));
rows.forEach((row, i) => {
  api.applyParsedInvoice(row, {
    amount: 1,
    merchant: "ocr",
    date: "2026-01-01",
    invoiceNo: "n",
    category: "other",
  });
  assert.equal(row.category, ["meal", "transit", "lodging", "purchase"][i]);
});
console.log("test-category-edit: ok");
