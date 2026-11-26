import copy
import unittest
from unittest.mock import patch
import feishu_purchase as p
import feishu_oauth as auth
from test_feishu_purchase import SCHEMA,claim_for

TRIP='22222222-2222-4222-8222-222222222222'
class SixStepTests(unittest.TestCase):
    def claim(self,method='个人垫付'):
        c=claim_for(method);c['workflowVersion']=2
        c['matchedBudget']=copy.deepcopy(c['selectedBudget']);c['relatedApproval']=None
        return c
    def links(self,form):
        return next((w['value'] for w in form if w['type']=='connect'),[])
    def test_nontravel_budget_and_no_extra_relation(self):
        c=self.claim();self.assertEqual(self.links(p.build_form(SCHEMA,c)),[c['matchedBudget']['instanceId']])
    def test_trip_does_not_overwrite_budget(self):
        c=self.claim('差旅费');c['relatedApproval']={'instanceId':TRIP}
        self.assertEqual(self.links(p.build_form(SCHEMA,c)),[c['matchedBudget']['instanceId'],TRIP])
    def test_budget_cannot_replace_mandatory_trip(self):
        with self.assertRaisesRegex(p.ValidationError,'差旅必须'):p.build_form(SCHEMA,self.claim('差旅费'))
    def test_no_budget_reason_is_required(self):
        c=self.claim();c['matchedBudget']=None
        with self.assertRaisesRegex(p.ValidationError,'无预算原因'):p.build_form(SCHEMA,c)
    def test_optional_live_connect_accepts_no_links_and_preserves_reason(self):
        c=self.claim();c.update(matchedBudget=None,noBudgetReason='临时采购')
        schema=copy.deepcopy(SCHEMA)
        for w in schema:
            if w['type']=='connect':w['required']=False
        self.assertEqual(self.links(p.build_form(schema,c)),[])
        with self.assertRaisesRegex(p.ValidationError,'当前飞书表单'):p.build_form(SCHEMA,c)
    def test_no_budget_travel_can_still_link_trip(self):
        c=self.claim('差旅费');c.update(matchedBudget=None,noBudgetReason='临时出差',relatedApproval={'instanceId':TRIP})
        self.assertEqual(self.links(p.build_form(SCHEMA,c)),[TRIP])
    def test_forged_budget_rejected_even_if_trip_is_valid(self):
        c=self.claim('差旅费');c['relatedApproval']={'instanceId':TRIP}
        with patch.object(auth,'list_approved_budgets',return_value=([],'')):
            with self.assertRaisesRegex(p.ValidationError,'预算不在'):p.validate_relation(c,{},'',{},SCHEMA)
