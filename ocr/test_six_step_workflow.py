import copy
import unittest
from unittest.mock import patch
import feishu_purchase as p
import feishu_oauth as auth
import travel_context
from test_feishu_purchase import SCHEMA,claim_for

TRIP='22222222-2222-4222-8222-222222222222'
class SixStepTests(unittest.TestCase):
    def claim(self, typ='普通采购'):
        c=claim_for(typ);c['workflowVersion']=2
        if typ!='差旅费':
            c['relatedApproval']=None
        return c
    def links(self,form):
        for w in form:
            if w.get('type')=='connect':
                return w['value']
            if w.get('type')=='fieldList':
                for row in w.get('value') or []:
                    for cell in row:
                        if cell.get('type')=='connect':
                            return cell['value']
        return []
    def test_nontravel_budget_and_no_extra_relation(self):
        self.assertEqual(self.links(p.build_form(SCHEMA,self.claim())),[])
    def test_trip_does_not_overwrite_budget(self):
        c=self.claim('差旅费')
        self.assertEqual(self.links(p.build_form(SCHEMA,c)),[TRIP])
    def test_budget_cannot_replace_mandatory_trip(self):
        c=self.claim('差旅费');c['relatedApproval']=None
        with self.assertRaisesRegex(p.ValidationError,'出差关联审批|差旅必须'):p.build_form(SCHEMA,c)
    def test_no_budget_reason_is_required(self):
        c=self.claim();c['matchedBudget']=None
        self.assertEqual(self.links(p.build_form(SCHEMA,c)),[])
    def test_optional_live_connect_accepts_no_links_and_preserves_reason(self):
        c=self.claim();c.update(matchedBudget=None,noBudgetReason='临时采购')
        self.assertEqual(self.links(p.build_form(SCHEMA,c)),[])
    def test_no_budget_travel_can_still_link_trip(self):
        c=self.claim('差旅费');c.update(matchedBudget=None,noBudgetReason='临时出差')
        self.assertEqual(self.links(p.build_form(SCHEMA,c)),[TRIP])
    def test_forged_budget_rejected_even_if_trip_is_valid(self):
        c=self.claim('差旅费')
        c['relatedApproval']={'instanceId':'00000000-0000-4000-8000-000000000000','kind':'travel','title':'伪造出差'}
        with patch.object(travel_context,'validate_travel'), patch.object(auth,'fetch_instance',return_value={'status':'PENDING','approval_code':auth.TRAVEL_DEFINITION['approval_code']}):
            with self.assertRaisesRegex(p.ValidationError, '出差|通过|关联|差旅'):
                p.validate_relation(c,{},'token',sess={'access_token':'x'},schema=SCHEMA)

if __name__=='__main__':unittest.main()
