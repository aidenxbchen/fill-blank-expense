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
