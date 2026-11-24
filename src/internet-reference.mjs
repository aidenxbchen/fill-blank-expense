/* Verified read-only Feishu evidence, 2026-11-24. The short URL is unresolved. */
export const internetReference=Object.freeze({
  sourceInstance:'1B20E44E-BA66-4D06-8E35-CED3BB08F0D0',
  shortUrl:'https://go.feishu.cn/approval/s/uo3lpFCvCSA/',
  budgetInstance:'FB727F0B-C731-492C-9BDD-8D1D7F4DF620',
  budgetDefinition:'5FEA33D4-2FC3-4B95-BD5B-37B6F31DD35F',
  budgetSerial:'202609300022',project:'公共办公',
  purpose:'因办公上网需要，采购电信宽带网络服务，供团队日常办公使用',
  historicalCategory:'服务费',historicalName:'网费',historicalQuantity:1,
  buyer:'澜理商贸（珠海）有限公司',
});

// Explicit user action only. Never create a task, change its mode, or pick a subject.
// Uses the current account's approved-budget list; reference IDs alone grant no access.
export function prefillInternetReference(record,budgets,projects){
  const ref=internetReference;
  const budget=budgets.find(b=>b.instanceId===ref.budgetInstance);
  if(!budget||budget.project!==ref.project||!projects.includes(ref.project))
    throw Error('当前账号的可用预算与项目列表未能核对公共办公审批，请刷新预算或检查权限；未写入草稿。');
  const state=structuredClone(record.state);
  if(!state||!state.answers||state.invoices?.length!==1)
    throw Error('请选择含一张已核对网费发票的配置草稿；未写入草稿。');
  const links=[state.selectedBudgetId,state.selectedBudget?.instanceId||state.selectedBudget?.instanceCode,state.answers.selectedBudget?.instanceId||state.answers.selectedBudget?.instanceCode,state.draft?.selectedBudget?.instanceId||state.draft?.selectedBudget?.instanceCode];
  if(links.some(id=>id&&id!==ref.budgetInstance)||[state.answers.costCenter,state.draft?.costCenter].some(p=>p&&p!==ref.project))
    throw Error('草稿已有不同项目或关联审批，请先在工作台核对；不会覆盖手工选择。');
  state.answers.costCenter=ref.project;
  state.answers.selectedBudget=structuredClone(budget);
  state.answers.purpose ||= state.draft?.purpose||ref.purpose;
  state.selectedBudgetId=budget.instanceId;
  if(state.draft){state.draft.costCenter=ref.project;state.draft.selectedBudget=structuredClone(budget);state.draft.purpose ||= state.answers.purpose;}
  return state;
}
