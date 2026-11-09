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

// All invoice references use confirmed content, never a merchant or serial suffix.
const invoiceQuestions = (rows, given=answers) => window.ExpensePolicy.buildQuestionQueue(rows,given)
  .filter(q=>q.id.startsWith('purchase:个人垫付:') && !q.id.includes(':shared:'));
const meal={id:'meal-row',category:'meal',amount:'241.00',date:'2026-11-03',merchant:'测试商户，不作主语',invoiceNo:'SYNTHETIC000001',fileName:'餐饮-1103-241.pdf'};
const mealQs=invoiceQuestions([meal]);
assert.equal(mealQs[0].text,'餐费 ¥241 在【公共办公】里属于哪个科目？');
assert.equal(mealQs[0].hint,'2026-11-03');
assert.equal(mealQs[0].id,'purchase:个人垫付:meal-row:个人垫付科目');
assert.equal(mealQs.find(q=>q.id.endsWith(':规格')).text,'餐费 ¥241 在【公共办公】里的规格是？');
assert.equal(mealQs.find(q=>q.id.endsWith(':数量')).text,'餐费 ¥241 在【公共办公】里的数量是？');
for(const q of mealQs) {
  assert.ok(!/发票尾号|第\s*\d+\s*张票/.test(q.text+'\n'+q.hint));
  assert.ok(!q.text.includes(meal.merchant));
  assert.ok(!q.hint.includes('¥241'),'avoid redundant amount in the hint');
  assert.ok(!q.text.includes(meal.invoiceNo) && !q.hint.includes(meal.invoiceNo));
}
for(const [category,label] of Object.entries({meal:'餐费',lodging:'住宿',entertainment:'招待',purchase:'采购',transit:'交通',gift:'礼品',other:'其他'})) {
  const q=invoiceQuestions([{...meal,category,amount:'241.50'}])[0];
  assert.equal(q.text,`${label} ¥241.5 在【公共办公】里属于哪个科目？`);
}
const twins=invoiceQuestions([meal,{...meal,id:'another-meal',amount:241,date:'2026-11-04'}]);
assert.equal(twins[0].text,'餐费 ¥241（11-03） 在【公共办公】里属于哪个科目？');
assert.equal(twins.find(q=>q.id.includes(':another-meal:')).text,'餐费 ¥241（11-04） 在【公共办公】里属于哪个科目？');
assert.ok(twins.every(q=>q.hint===''),'do not repeat dates already in the question');
assert.equal(new Set(twins.map(q=>q.id)).size,twins.length,'stable, distinct answer keys');
// Multiple invoices with different content do not need numbering or date suffixes.
const distinct=invoiceQuestions([meal,{...meal,id:'hotel-row',category:'lodging'}]);
assert.equal(distinct[0].text,mealQs[0].text);
assert.equal(distinct.find(q=>q.id.includes(':hotel-row:')).text,'住宿 ¥241 在【公共办公】里属于哪个科目？');
for(const fileName of ['餐饮-1103-241.pdf','/synthetic/餐饮-1103-241.png','C:\\synthetic\\餐饮-1103-241.jpg']) {
  assert.equal(invoiceQuestions([{...meal,category:'',fileName}])[0].text,'餐饮-1103-241 ¥241 在【公共办公】里属于哪个科目？');
}
for(const fileName of ['', '123456789.pdf',meal.merchant+'.pdf']) {
  assert.equal(invoiceQuestions([{...meal,category:null,fileName}])[0].text,'这笔 ¥241 在【公共办公】里属于哪个科目？');
}
for(const amount of ['',null,undefined,'not-a-number']) {
  const text=invoiceQuestions([{...meal,amount}])[0].text;
  assert.ok(text.startsWith('餐费 在【公共办公】'));
  assert.ok(!/NaN|undefined|¥0/.test(text),'do not invent an absent amount');
}
// Completing a field still advances one question at a time using the old key.
const afterSubject={...answers,[mealQs[0].id]:mealQs[0].chips[0]};
assert.equal(window.ExpensePolicy.nextQuestion([meal],afterSubject).id,'purchase:个人垫付:meal-row:规格');
const learnedMeal={...meal,id:'corrected-row'};
const ranked=invoiceQuestions([learnedMeal])[0];
assert.equal(ranked.chips[0],options[2]);
assert.equal(ranked.recommended.evidence,3);
assert.ok(ranked.text.startsWith('餐费 ¥241 '));
console.log('Content labels, amounts, duplicate dates, filename fallback, stable answer keys and ranked suggestions verified');

// A resumed draft can end with the old wording for the same unanswered ID.
// Execute the actual app function without starting the app or making requests.
const appSource=fs.readFileSync('web/app.js','utf8');
const ensureStart=appSource.indexOf('  function ensureCurrentQuestionAsked() {');
const ensureEnd=appSource.indexOf('\n  function ',ensureStart+1);
assert.ok(ensureStart>=0 && ensureEnd>ensureStart);
const history={id:'answered-message',role:'assistant',text:'已回答的历史问题',meta:{qid:'purpose'}};
const pending={id:'existing-message',role:'assistant',text:'第 1 张票在【公共办公】里属于哪个科目？\n发票尾号 SYN001',meta:{qid:mealQs[0].id}};
const resumed={chat:[history,pending],answers};
vm.runInNewContext(appSource.slice(ensureStart,ensureEnd)+'\nensureCurrentQuestionAsked();ensureCurrentQuestionAsked();',{
  window,session:resumed,okInvoices:()=>[meal],pushChat:()=>assert.fail('must not append a duplicate prompt')
});
assert.equal(resumed.chat.length,2);
assert.equal(pending.id,'existing-message');
assert.equal(pending.meta.qid,mealQs[0].id);
assert.equal(pending.text,mealQs[0].text+'\n2026-11-03');
assert.equal(history.text,'已回答的历史问题');
const answeredSession={chat:[history,{id:'answer',role:'user',text:'办公费'}],answers:afterSubject};
let pushed;
vm.runInNewContext(appSource.slice(ensureStart,ensureEnd)+'\nensureCurrentQuestionAsked();',{
  window,session:answeredSession,okInvoices:()=>[meal],pushChat:(role,text,meta)=>{pushed={role,text,meta};}
});
assert.equal(pushed.meta.qid,'purchase:个人垫付:meal-row:规格');
assert.equal(pushed.text,'餐费 ¥241 在【公共办公】里的规格是？\n2026-11-03');
console.log('Resumed unanswered prompt refreshed without duplicate messages or rewriting answered history');
