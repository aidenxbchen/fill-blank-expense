import assert from 'node:assert/strict';
import {internetReference as ref,prefillInternetReference as prefill} from '../src/internet-reference.mjs';
const budget={instanceId:ref.budgetInstance,project:'公共办公',title:'立项预算申请 · 公共办公'};
const record={state:{stage:'draft',answers:{purchaseMethod:'个人垫付',purpose:'人工核对的网费说明','purchase:个人垫付:a:个人垫付科目':'待人工确认'},invoices:[{id:'a',amount:380,merchant:'票面服务商'}],draft:{purpose:'人工核对的网费说明'}}};
const original=structuredClone(record),result=prefill(record,[budget],['公共办公']);
assert.deepEqual(record,original,'input never mutated');
assert.equal(result.answers.costCenter,'公共办公');assert.equal(result.answers.selectedBudget.instanceId,ref.budgetInstance);
assert.equal(result.selectedBudgetId,ref.budgetInstance);assert.equal(result.draft.costCenter,'公共办公');
assert.equal(result.answers.purpose,'人工核对的网费说明');assert.equal(result.answers['purchase:个人垫付:a:个人垫付科目'],'待人工确认');
assert.deepEqual(result.invoices,original.state.invoices);assert.equal(result.answers.purchaseMethod,'个人垫付');
for(const [list,projects] of [[[],['公共办公']],[[{...budget,project:'其他弹性支出'}],['公共办公']],[[budget],[]]])assert.throws(()=>prefill(record,list,projects),/未能核对/);
for(const change of [r=>r.state.answers.costCenter='其他项目',r=>r.state.answers.selectedBudget={instanceId:'different'},r=>r.state.answers.selectedBudget={instanceCode:'different'},r=>r.state.selectedBudgetId='different',r=>r.state.invoices.push({id:'b'}),r=>r.state.invoices=[]]){
 const conflict=structuredClone(record);change(conflict);const before=structuredClone(conflict);
 assert.throws(()=>prefill(conflict,[budget],['公共办公']));assert.deepEqual(conflict,before);
}
const empty=structuredClone(record);delete empty.state.answers.purpose;delete empty.state.draft.purpose;
assert.equal(prefill(empty,[budget],['公共办公']).answers.purpose,ref.purpose);
console.log('Internet reference: approved-list identity/project gate, manual conflict protection, invoice/category/method preservation passed');
