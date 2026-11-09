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
const inv=[{id:'corrected-row',merchant:'已改商户',amount:'100.50'}];
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
    else answers[q.id]=q.chips.length?q.chips[0]:'用户填写';
  }
  if(method.name!=='预付款项')assert.ok(answers.selectedBudget);
  else assert.equal(answers.selectedBudget,undefined);
}
assert.equal(window.ExpensePolicy.nextQuestion(inv,{purchaseMethod:'错误方式'}).id,'purchaseMethod');
assert.equal(window.ExpensePolicy.nextQuestion(inv,{purchaseMethod:'个人垫付',costCenter:'待定'}).id,'costCenter');
console.log('7 purchase methods: one-question interview completes with exact project/subject options');
