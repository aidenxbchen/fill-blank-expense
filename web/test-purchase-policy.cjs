const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const definition = JSON.parse(fs.readFileSync('ocr/purchase_definition.json','utf8')).form;
const methods = definition.find(w=>w.name==='采购方式').option.map(o=>{
  const group=definition.find(w=>w.type==='fieldList' && JSON.stringify(w.display_condition).includes(o.value));
  return {name:o.text, fields:group.children.map(w=>({name:w.name, type:w.type, required:w.required, options:Array.isArray(w.option)?w.option.map(x=>x.text):[]}))};
});
const window = {__purchaseSchema:{methods,projects:definition.find(w=>w.name==='项目').option.map(o=>o.text)}, __approvedBudgets:[{instanceId:'budget',title:'软件组预算',project:'软件组',serialId:'123'}, {instanceId:'trip',title:'合成出差',kind:'travel',serialId:'456'}]};
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
    else if(q.id==='selectBudget')answers.selectedBudget={instanceId:method.name==='差旅费' ? 'trip' : 'budget'};
    else if(q.input==='bank-profile')window.ExpensePolicy.applyBankProfile(method,answers,{fields:{account:'622200000000',bank:'合成测试支行',holder:'合成测试户名'}},q.bankSide);
    else answers[q.id]=q.chips.length?q.chips[0]:'用户填写';
  }
  assert.equal(answers.selectedBudget,undefined,'budget matching follows the questions');
}
assert.equal(window.ExpensePolicy.nextQuestion(inv,{}).id,'purpose');
assert.equal(window.ExpensePolicy.nextQuestion(inv,{purpose:'研发试制',purchaseMethod:'错误方式'}).id,'purchaseMethod');
assert.equal(window.ExpensePolicy.nextQuestion(inv,{purpose:'研发试制',purchaseMethod:'个人垫付',costCenter:'待定'}).id,'costCenter');
const many=Array.from({length:25},(_,i)=>({...inv[0],id:'row'+i}));
const answers={purpose:'这次出差',purchaseMethod:'差旅费',costCenter:'公共办公',selectedBudget:{instanceId:'trip'}};
assert.equal(window.ExpensePolicy.buildQuestionQueue(many,answers).length,0,'25 invoices never add row selection questions');
const globalQueue=window.ExpensePolicy.buildQuestionQueue(many,{});
assert.deepEqual(Array.from(globalQueue,q=>q.id),['purpose','purchaseMethod','costCenter']);
assert.equal(window.ExpensePolicy.invoiceAmountLabel(inv[0]),'¥100.50');
assert.equal(window.ExpensePolicy.invoiceReferent(inv[0],inv),'¥100.50');
console.log('Seven methods collect only claim-wide facts; 25 invoices add zero per-invoice questions');
