/* Synthetic fields only: real definition + policy + OCR merge. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const def=JSON.parse(fs.readFileSync('ocr/expense_definition.json','utf8')).form;
function fieldsFor(typeValue){
  const group=def.find(w=>w.type==='fieldList'&&JSON.stringify(w.display_condition||{}).includes(typeValue));
  return group.children.map(w=>({name:w.name,type:w.type,required:w.required,options:(Array.isArray(w.option)?w.option:[]).map(o=>o.text)}));
}
const typeWidget=def.find(w=>w.name==='费用类型');
const methods=typeWidget.option.map(o=>({name:o.text,fields:fieldsFor(o.value)}));
const window={__purchaseSchema:{methods,expenseTypes:typeWidget.option.map(o=>o.text),payers:['个人支付'],projects:[]},__approvedBudgets:[{instanceId:'budget'}]};
vm.runInNewContext(fs.readFileSync('web/policy.js','utf8'),{window});const p=window.ExpensePolicy;
for(const inv of [{id:'single',quantity:3,unit:'包',items:[{name:'纸张',quantity:3,unit:'包'}]},{id:'batch',quantity:7,unit:'件',items:[{name:'纸张'},{name:'笔'}]},{id:'missing'}]) {
  for(const method of methods) {
    const answers={expenseType:method.name,payer:'个人支付',purpose:'合成采购'};
    const queue=p.buildQuestionQueue([Object.assign({amount:123,merchant:'不作为主语',fileName:'商户-1103-123.pdf'},inv)],answers);
    assert.ok(queue.every(q=>!/(数量|规格|单位)$/.test(q.id)),'never ask quantity or unit');
    assert.equal(p.quantityUnit(inv).quantity,inv.id==='single'?3:1);assert.equal(p.quantityUnit(inv).unit,inv.id==='single'?'包':'份/批');
    for(const q of queue.filter(q=>q.id.includes(inv.id))) {assert.ok(q.text.includes('¥123.00'));assert.ok(!q.text.includes('商户')&&!q.text.includes('不作为主语'));}
  }
}
const profile={side:'counterparty',fields:{account:'622200000123',bank:'合成支行',holder:'合成公司'}};
const future={name:'future',fields:[{name:'我方账号'},{name:'我方开户行'},{name:'收款账号'},{name:'开户支行'}]},answers={};
p.applyBankProfile(future,answers,profile,'ours');assert.equal(answers['expense:future:shared:我方账号'],profile.fields.account);assert.equal(answers['expense:future:shared:收款账号'],undefined);
console.log('Quantity: single/batch/missing for all expense types; amount prompts; bank side mapping passed');
const legacy=[{id:'old',amount:30}],legacyAnswers={expenseType:'普通采购','expense:普通采购:old:数量':'3','expense:普通采购:old:规格':'包'};
p.restoreInvoiceQuantities(legacy,legacyAnswers);assert.equal(legacy[0].quantity,3);assert.equal(legacy[0].unit,'包');
p.buildQuestionQueue(legacy,legacyAnswers);assert.equal(legacyAnswers['expense:普通采购:old:数量'],'3');
console.log('Legacy draft quantities preserved as editable invoice facts without re-reading');
