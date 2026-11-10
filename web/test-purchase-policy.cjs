const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const definition = JSON.parse(fs.readFileSync('ocr/purchase_definition.json','utf8')).form;
const methods = definition.find(w=>w.name==='采购方式').option.map(o=>{
  const group=definition.find(w=>w.type==='fieldList' && JSON.stringify(w.display_condition).includes(o.value));
  return {name:o.text, fields:group.children.map(w=>({name:w.name, type:w.type, required:w.required, options:Array.isArray(w.option)?w.option.map(x=>x.text):[]}))};
});
const window = {__purchaseSchema:{methods,projects:definition.find(w=>w.name==='项目').option.map(o=>o.text)}, __approvedBudgets:[{instanceId:'budget',title:'软件组预算',project:'软件组',serialId:'123'}]};
vm.runInNewContext(fs.readFileSync('web/policy.js','utf8'),{window});
const inv=[{id:'corrected-row',merchant:'已改商户',amount:'100.50',category:'meal',fileName:'餐饮-1103-241.pdf',date:'2025-11-03'}];
for (const method of methods) {
  const answers={};
  let rounds=0;
  while (true) {
    const q=window.ExpensePolicy.nextQuestion(inv,answers);
    if (!q) break;
    assert.ok(++rounds<30,'interview must complete');
    assert.equal(q.required,true);
    if(q.id==='purchaseMethod')answers[q.id]=method.name;
    else if(q.id==='costCenter')answers[q.id]='软件组';
    else if(q.id==='selectBudget')answers.selectedBudget={instanceId:'budget'};
    else if(q.input==='bank-profile')window.ExpensePolicy.applyBankProfile(method,answers,{fields:{account:'622200000000',bank:'合成测试支行',holder:'合成测试户名'}},q.bankSide);
    else answers[q.id]=q.chips.length?q.chips[0]:'用户填写';
  }
  if(method.name!=='预付款项')assert.ok(answers.selectedBudget);
  else assert.equal(answers.selectedBudget,undefined);
}
assert.equal(window.ExpensePolicy.nextQuestion(inv,{purchaseMethod:'错误方式'}).id,'purchaseMethod');
assert.equal(window.ExpensePolicy.nextQuestion(inv,{purchaseMethod:'个人垫付',costCenter:'待定'}).id,'costCenter');
console.log('7 purchase methods: one-question interview completes with exact project/subject options');
const options=methods.find(m=>m.name==='个人垫付').fields.find(w=>w.name.includes('科目')).options;
window.__fillSuggestions={global:{purchaseMethod:[{value:'个人垫付',probability:0.8,evidence:4}]},rows:{'corrected-row':{'科目':[{value:options[2],probability:0.7,evidence:3},{value:'已删除选项',probability:0.2,evidence:10}]}}};
const answers={purchaseMethod:'个人垫付',costCenter:'公共办公',purpose:'日常采购',selectedBudget:{instanceId:'budget'}};
const question=window.ExpensePolicy.nextQuestion(inv,answers);
assert.equal(question.chips[0],options[2]);
assert.equal(question.recommended.value,options[2]);
assert.ok(question.text.includes('【公共办公】'));
assert.ok(!question.text.includes('已改商户'));
assert.ok(!question.chips.includes('已删除选项'));
assert.equal(answers[question.id],undefined,'a recommendation must never auto-fill an answer');
const nextMethod=window.ExpensePolicy.nextQuestion(inv,{});
assert.equal(nextMethod.chips[0],'个人垫付');
assert.equal(nextMethod.recommended.evidence,4);
console.log('Project subjects, ranked suggestions, deleted options and explicit selection verified');

// Per-invoice referent: 项目名称 + 金额 only
assert.equal(window.ExpensePolicy.invoiceItemName(inv[0]), '餐饮');
assert.equal(window.ExpensePolicy.invoiceAmountLabel(inv[0]), '¥100.50');
assert.equal(window.ExpensePolicy.invoiceReferent(inv[0], inv), '¥100.50');
assert.ok(question.text.includes('¥100.50'));
assert.ok(question.text.includes('属于哪个科目') || question.text.includes('里的'));
assert.ok(!question.text.includes('发票尾号'));
assert.ok(!question.text.includes('第 ') && !/第\s*\d+\s*张票/.test(question.text));
assert.equal(question.hint, '');
assert.ok(!String(question.hint).includes('发票尾号'));

const clothing={id:'cloth',merchant:'某店',amount:338,category:'purchase',fileName:'服装-1104-338.pdf',date:'2025-11-04'};
assert.equal(window.ExpensePolicy.invoiceItemName(clothing), '服装');
assert.equal(window.ExpensePolicy.invoiceReferent(clothing, [clothing]), '¥338.00');
const mealOnly={id:'meal2',merchant:'X',amount:241,category:'meal',date:'2025-11-03'};
assert.equal(window.ExpensePolicy.invoiceItemName(mealOnly), '餐饮');
assert.equal(window.ExpensePolicy.invoiceReferent(mealOnly, [mealOnly]), '¥241.00');
const dupA={id:'a',fileName:'餐饮-1103-241.pdf',amount:241,category:'meal',date:'2025-11-03'};
const dupB={id:'b',fileName:'餐饮-1105-241.pdf',amount:241,category:'meal',date:'2025-11-05'};
assert.equal(window.ExpensePolicy.invoiceReferent(dupA,[dupA,dupB]),'¥241.00');
assert.equal(window.ExpensePolicy.invoiceReferent(dupB,[dupA,dupB]),'¥241.00');
const qCloth=window.ExpensePolicy.nextQuestion([clothing],answers);
assert.ok(qCloth.text.startsWith('¥338.00'));
assert.ok(!qCloth.text.includes('某店'));
assert.ok(!qCloth.text.includes('发票尾号'));
assert.ok(!/第\s*\d+\s*张票/.test(qCloth.text));
console.log('Invoice referent uses 项目名称+金额; no 尾号 / 第N张票 / merchant');
