/* Synthetic fields only: real definition + policy + OCR merge. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const def=JSON.parse(fs.readFileSync('ocr/purchase_definition.json','utf8')).form;
const methods=def.find(w=>w.name==='采购方式').option.map(o=>({name:o.text,fields:def.find(w=>w.type==='fieldList'&&JSON.stringify(w.display_condition).includes(o.value)).children.map(w=>({name:w.name,type:w.type,required:w.required,options:(Array.isArray(w.option)?w.option:[]).map(o=>o.text)}))}));
const window={__purchaseSchema:{methods,projects:['公共办公']},__approvedBudgets:[{instanceId:'budget'}]};
vm.runInNewContext(fs.readFileSync('web/policy.js','utf8'),{window});const p=window.ExpensePolicy;
for(const inv of [{id:'single',quantity:3,unit:'包',items:[{name:'纸张',quantity:3,unit:'包'}]},{id:'batch',quantity:7,unit:'件',items:[{name:'纸张'},{name:'笔'}]},{id:'missing'}]) {
  for(const method of methods) {
    const answers={purchaseMethod:method.name,costCenter:'公共办公',purpose:'合成采购',selectedBudget:{instanceId:'budget'}};
    const queue=p.buildQuestionQueue([Object.assign({amount:123,merchant:'不作为主语',fileName:'商户-1103-123.pdf'},inv)],answers);
    assert.ok(queue.every(q=>!/(数量|规格|单位)$/.test(q.id)),'never ask quantity or unit');
    for(const field of method.fields.filter(w=>['数量','单位','规格'].includes(w.name)))assert.equal(answers[`purchase:${method.name}:${inv.id}:${field.name}`],String(field.name==='数量' ? (inv.id==='single'?3:1) : (inv.id==='single'?'包':'份/批')));
    for(const q of queue.filter(q=>q.id.includes(inv.id))) {assert.ok(q.text.includes('【公共办公】'));assert.ok(q.text.includes('¥123.00'));assert.ok(!q.text.includes('商户')&&!q.text.includes('不作为主语'));}
  }
}
const profile={side:'counterparty',fields:{account:'622200000123',bank:'合成支行',holder:'合成公司'}};
for(const name of ['预付款项','合同审批']) {
  const method=methods.find(m=>m.name===name),answers={purchaseMethod:name,costCenter:'公共办公',purpose:'采购',selectedBudget:{instanceId:'budget'}};
  assert.equal(p.buildQuestionQueue([],answers).filter(q=>q.input==='bank-profile').length,1,'one paired bank question');
  p.applyBankProfile(method,answers,profile,'counterparty');
  assert.equal(p.buildQuestionQueue([],answers).filter(q=>q.input==='bank-profile').length,0);
  for(const field of method.fields.filter(w=>p.bankRole(w.name))) assert.equal(answers[`purchase:${name}:shared:${field.name}`],profile.fields[p.bankRole(field.name)]);
}
const future={name:'future',fields:[{name:'我方账号'},{name:'我方开户行'},{name:'收款账号'},{name:'开户支行'}]},answers={};
p.applyBankProfile(future,answers,profile,'ours');assert.equal(answers['purchase:future:shared:我方账号'],profile.fields.account);assert.equal(answers['purchase:future:shared:收款账号'],undefined);
console.log('Quantity: single/batch/missing for all methods; project+amount prompts; bank pair and side mapping passed');
const legacy=[{id:'old',amount:30}],legacyAnswers={purchaseMethod:'个人垫付','purchase:个人垫付:old:数量':'3','purchase:个人垫付:old:规格':'包'};
p.restoreInvoiceQuantities(legacy,legacyAnswers);assert.equal(legacy[0].quantity,3);assert.equal(legacy[0].unit,'包');
p.buildQuestionQueue(legacy,legacyAnswers);assert.equal(legacyAnswers['purchase:个人垫付:old:数量'],'3');
console.log('Legacy draft quantities preserved as editable invoice facts without re-reading');
