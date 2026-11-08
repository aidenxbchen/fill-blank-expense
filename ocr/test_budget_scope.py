"""Unit tests for budget-scope filter helpers (no live OAuth)."""

from __future__ import annotations

import json
import unittest

from feishu_oauth import (
    BUDGET_DEFINITIONS,
    MISSING_SCOPE_WARNING,
    TRAVEL_DEFINITION,
    FeishuAPIError,
    collect_scope_ids_from_form,
    extract_contact_ids,
    is_missing_scope,
    kind_for_code,
    logged_in_user_ids,
    user_in_budget_scope,
)


class BudgetDefinitionsTest(unittest.TestCase):
    def test_primary_list_excludes_travel(self):
        names = {d["name"] for d in BUDGET_DEFINITIONS}
        kinds = {d["kind"] for d in BUDGET_DEFINITIONS}
        self.assertEqual(names, {"立项预算申请", "项目预算变更申请"})
        self.assertEqual(kinds, {"init", "change"})
        self.assertEqual(TRAVEL_DEFINITION["kind"], "travel")
        self.assertNotIn(TRAVEL_DEFINITION["approval_code"], {d["approval_code"] for d in BUDGET_DEFINITIONS})

    def test_kind_for_known_codes(self):
        self.assertEqual(kind_for_code("5FEA33D4-2FC3-4B95-BD5B-37B6F31DD35F"), "init")
        self.assertEqual(kind_for_code("9BACB334-4059-4DB2-AC98-A56587B0F150"), "change")


class ContactParseTest(unittest.TestCase):
    def test_list_of_objects(self):
        value = [
            {"open_id": "ou_aaa", "name": "甲"},
            {"open_id": "ou_bbb", "user_id": "uid_b", "name": "乙"},
        ]
        self.assertEqual(extract_contact_ids(value), {"ou_aaa", "ou_bbb", "uid_b"})

    def test_list_of_id_strings(self):
        self.assertEqual(extract_contact_ids(["ou_aaa", "ou_bbb"]), {"ou_aaa", "ou_bbb"})

    def test_single_string(self):
        self.assertEqual(extract_contact_ids("ou_solo"), {"ou_solo"})

    def test_json_string_of_objects(self):
        raw = json.dumps([{"open_id": "ou_json", "name": "丙"}])
        self.assertEqual(extract_contact_ids(raw), {"ou_json"})

    def test_nested_value_dict(self):
        value = {"value": [{"openId": "ou_nested", "name": "丁"}]}
        self.assertEqual(extract_contact_ids(value), {"ou_nested"})


class ScopeFilterTest(unittest.TestCase):
    FORM = [
        {"id": "w1", "name": "项目名称", "type": "input", "value": "公共办公"},
        {
            "id": "w2",
            "name": "项目负责人",
            "type": "contact",
            "value": [{"open_id": "ou_owner", "name": "负责人"}],
        },
        {
            "id": "w3",
            "name": "项目参与人",
            "type": "contact",
            "value": [{"open_id": "ou_member", "name": "参与人"}, "ou_extra"],
        },
    ]

    def test_collect_scope_ids(self):
        ids = collect_scope_ids_from_form(self.FORM)
        self.assertEqual(ids, {"ou_owner", "ou_member", "ou_extra"})
        self.assertEqual(collect_scope_ids_from_form(json.dumps(self.FORM, ensure_ascii=False)), ids)

    def test_participant_in_scope(self):
        detail = {"form": self.FORM, "open_id": "ou_someone_else", "user_id": "ou_someone_else"}
        self.assertTrue(user_in_budget_scope({"ou_member"}, detail))
        self.assertTrue(user_in_budget_scope({"ou_owner"}, detail))
        self.assertTrue(user_in_budget_scope({"ou_extra"}, detail))

    def test_initiator_in_scope_even_if_not_on_form(self):
        detail = {"form": self.FORM, "open_id": "ou_initiator", "user_id": "ou_initiator"}
        self.assertTrue(user_in_budget_scope({"ou_initiator"}, detail))
        self.assertTrue(
            user_in_budget_scope(
                {"ou_from_query"},
                {"form": self.FORM},
                {"user_id": "ou_from_query"},
            )
        )

    def test_outsider_excluded(self):
        detail = {"form": self.FORM, "open_id": "ou_other", "user_id": "ou_other"}
        self.assertFalse(user_in_budget_scope({"ou_stranger"}, detail))
        self.assertFalse(user_in_budget_scope(set(), detail))

    def test_logged_in_user_ids_accepts_js_camel_case(self):
        self.assertEqual(logged_in_user_ids({"openId": "ou_me", "userId": "uid_me"}), {"ou_me", "uid_me"})


class MissingScopeTest(unittest.TestCase):
    def test_code_99991672(self):
        err = FeishuAPIError(400, {"code": 99991672, "msg": "Access denied. One of the following scopes is required: [approval:approval.list:readonly]"})
        self.assertTrue(is_missing_scope(err))
        self.assertIn("approval:approval.list:readonly", MISSING_SCOPE_WARNING)
        self.assertIn("approval:approval:readonly", MISSING_SCOPE_WARNING)

    def test_unrelated_error_not_treated_as_missing_scope(self):
        err = FeishuAPIError(400, {"code": 1390001, "msg": "param is invalid"})
        self.assertFalse(is_missing_scope(err))


if __name__ == "__main__":
    unittest.main()
