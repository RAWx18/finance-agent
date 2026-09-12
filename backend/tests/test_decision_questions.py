# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date

import pytest

from .conftest import facts, money, record
from .test_decision_priorities import next_action
from .test_finance import project


@pytest.mark.parametrize("reverse", [False, True])
def test_dependency_uses_earlier_protected_deadline_not_labels_or_input_order(reverse):
    items = [
        record("urgent", "essential", "1000", "2026-09-12", label="Z need"),
        record("later", "debt", "1000", "2026-09-20", label="A loan"),
    ]
    for item in items:
        item["amount"] = money(None, "unknown")
    if reverse:
        items.reverse()
        items[0]["label"], items[1]["label"] = items[1]["label"], items[0]["label"]
    plan = project(facts("100", items))
    assert plan.decision_assessment.next_question_id == "urgent:amount"
    assert next_action(plan).before_date == date(2026, 9, 12)


@pytest.mark.parametrize("reverse", [False, True])
def test_receipt_dependency_uses_reconciled_relief_not_name_or_receipt_order(reverse):
    items = [
        record("small", "income", "100", "2026-09-12", label="A wages", reliability="unknown"),
        record("large", "income", "1000", "2026-09-13", label="Z wages", reliability="unknown"),
        record("rent", "essential", "800", "2026-09-14"),
    ]
    if reverse:
        items.reverse()
        items[1]["label"], items[2]["label"] = items[2]["label"], items[1]["label"]
    plan = project(facts("0", items))
    assert plan.decision_assessment.next_question_id == "large:receipt"
    assert next_action(plan).before_date == date(2026, 9, 14)
    assert plan.first_gap.amount_paise == 80000
    assert plan.reliable_income_paise == 0


def test_blocking_conflict_precedes_receipt_and_usable_cash():
    data = facts(
        "0",
        [
            record("salary", "income", "1000", "2026-09-12", reliability="unknown"),
            record("loan", "debt", "800", "2026-09-14", outstanding=money("0")),
        ],
    )
    assert project(data).decision_assessment.next_question_id == "loan:debtBalanceConflict"
    data["opening"] = money(None, "unknown")
    assert project(data).decision_assessment.next_question_id == "loan:debtBalanceConflict"
    data["records"][1]["outstanding"] = money("800")
    assert project(data).decision_assessment.next_question_id == "opening"


def test_undated_requirement_has_no_invented_due_date():
    plan = project(
        facts(
            "100",
            [record("rent", "essential", "200", None), record("salary", "income", "500", None)],
        )
    )
    assert next_action(plan).id == "clarify:rent:schedule.date"
    assert next_action(plan).before_date is None
    assert next_action(plan).question == "When is rent due?"
    assert plan.first_gap is None
    assert plan.decision_assessment.constraints[0].date is None


def test_known_income_amount_missing_date_asks_availability_date_not_amount():
    plan = project(
        facts(
            "0",
            [
                record("salary", "income", "1000", None),
                record("rent", "essential", "800", "2026-09-14"),
            ],
        )
    )
    assert next_action(plan).id == "clarify:salary:schedule.date"
    assert next_action(plan).question == "When will salary be available to use?"
    assert "salary:amount" not in {u.id for u in plan.decision_assessment.uncertainties}


@pytest.mark.parametrize("reliability", ["uncertain", "unknown"])
def test_late_income_availability_cannot_displace_earlier_gap(reliability):
    plan = project(
        facts(
            "100",
            [
                record("rent", "essential", "500", "2026-09-12"),
                record("salary", "income", "10000", "2026-09-20", reliability=reliability),
            ],
        )
    )
    assert next_action(plan).id == "contact:rent:2026-09-12"


@pytest.mark.parametrize("field", ["amount", "target"])
def test_required_minimum_and_intended_payment_have_distinct_questions(field):
    card = record("card", "debt", "500", "2026-09-12", debtType="card", target=money("1000"))
    card[field] = money(None, "unknown")
    action = next_action(project(facts("2000", [card])))
    assert action.id == f"clarify:card:{field}"
    assert "required" in action.question
    assert "extra" in action.question if field == "amount" else "INR 500.00" in action.question


@pytest.mark.parametrize("status", ["unknown", "none"])
def test_focused_purchase_stops_after_explicit_needs_answer_without_income_inventory(status):
    data = facts(
        "50000",
        [record("phone", "optional", "5000", "2026-09-20")],
        coverage={"optional": "reviewed", "essential": status, "debt": status},
        decision={"intent": "specificDecision", "focusRecordIds": ["phone"]},
    )
    plan = project(data)
    assert next_action(plan).kind == "reviewOutcome"
    assert plan.decision_assessment.next_question_id is None
    if status == "unknown":
        assert "fit" not in plan.decision_assessment.outcome.summary
        assert plan.decision_assessment.outcome.branch == "uncertain"


def test_funded_focused_purchase_does_not_interview_unneeded_income():
    data = facts(
        "50000",
        [
            record("phone", "optional", "5000", "2026-09-20"),
            record("bonus", "income", "1000", None),
        ],
        decision={"intent": "specificDecision", "focusRecordIds": ["phone"]},
    )
    plan = project(data)
    assert next_action(plan).kind == "reviewOutcome"
    assert plan.decision_assessment.outcome.readiness == "qualified"
    assert any(u.id == "bonus:schedule.date" for u in plan.decision_assessment.uncertainties)


def test_known_urgent_gap_gets_help_before_scope_check():
    plan = project(
        facts(
            "100",
            [record("rent", "essential", "500", "2026-09-12")],
            coverage={},
            decision={"intent": "specificDecision", "focusRecordIds": ["rent"]},
        )
    )
    assert next_action(plan).id == "contact:rent:2026-09-12"
    assert "INR 400.00" in next_action(plan).question


def test_opening_and_scope_questions_do_not_expose_internal_category_states():
    data = facts("0", [], coverage={})
    data["opening"] = money(None, "unknown")
    text = next_action(project(data)).question
    assert "available" in text and "original cash basis" not in text
    data["opening"] = money("500")
    data["records"] = [record("food", "essential", "100", "2026-09-12")]
    text = next_action(project(data)).question
    assert "anything else" in text
    assert not any(word in text for word in ("scope", "absent", "complete", "notDiscussed"))


@pytest.mark.parametrize("reverse", [False, True])
def test_protection_depends_on_commitment_not_kind_or_label_inventory(reverse):
    items = [
        record("required", "optional", "1000", None, controllability="committed", label="Z item"),
        record("small", "essential", "100", None, label="A item"),
        record("income", "income", "10000", None),
    ]
    if reverse:
        items.reverse()
        items[1]["label"], items[2]["label"] = items[2]["label"], items[1]["label"]
    plan = project(facts("100", items))
    assert next_action(plan).id == "clarify:required:schedule.date"
    assert next_action(plan).before_date is None


@pytest.mark.parametrize("intent", ["plan30Days", "specificDecision"])
def test_unknown_outflow_scope_never_gives_positive_assurance_with_dated_records(intent):
    plan = project(
        facts(
            "50000",
            [record("phone", "optional", "5000", "2026-09-20")],
            coverage={
                "optional": "reviewed",
                "income": "none",
                "essential": "unknown",
                "debt": "unknown",
            },
            decision={"intent": intent, "focusRecordIds": ["phone"]},
        )
    )
    assert next_action(plan).kind == "reviewOutcome"
    assert plan.decision_assessment.outcome.readiness == "qualified"
    assert "fit" not in plan.decision_assessment.outcome.summary
    assert "cannot be established" in plan.decision_assessment.outcome.summary
