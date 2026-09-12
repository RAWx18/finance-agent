# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date

import pytest

from app.decisions import action_dependency_key
from app.finance import calculate, normalize
from app.models import ActionResponse, FactsInput

from .conftest import facts, money, parsed_command, record
from .test_action_responses import response_command
from .test_decision_priorities import next_action
from .test_finance import ANCHOR, project


@pytest.mark.parametrize("intent", ["plan30Days", "specificDecision"])
@pytest.mark.parametrize("scope_checked", [False, True])
@pytest.mark.parametrize("rent", [False, True])
def test_undiscussed_income_precedes_expense_discovery(intent, scope_checked, rent):
    """Opening cash and an omissions check do not establish expected receipts."""
    data = facts(
        "18000",
        [record("rent", "essential", "10000", "2026-09-15")] if rent else [],
        coverage={"essential": "reported" if rent else "notDiscussed"},
        decision={"intent": intent, "scopeChecked": scope_checked},
    )
    plan = project(data)
    assessment = plan.decision_assessment
    assert next_action(plan).id == "clarify:income"
    assert assessment.next_question_id == "income"
    assert next_action(plan).question == (
        "What income do you expect during these 30 days, roughly how much and when available?"
    )
    uncertainty = next(item for item in assessment.uncertainties if item.id == "income")
    assert uncertainty.field == "coverage.income"
    assert uncertainty.record_ids == []
    assert "Opening cash" in uncertainty.reason and "receipts" in uncertainty.reason
    assert "fullPlan" in uncertainty.blocks
    assert not assessment.outcome.plan_ready
    assert plan.closing_paise == (800000 if rent else 1800000)


def test_missing_opening_precedes_income():
    """Income discovery leaves the existing opening-cash prerequisite first."""
    data = facts(coverage={})
    data["opening"] = money(None, "unknown")
    plan = project(data)
    assert next_action(plan).id == "clarify:opening"
    assert any(item.id == "clarify:income" for item in plan.decision_assessment.actions)
    assert not plan.decision_assessment.outcome.plan_ready


def test_exact_zero_opening_is_known_cash_not_missing_cash():
    """An explicitly reported zero remains exact rather than prompting for cash again."""
    plan = project(facts("0", coverage={}))
    assert next_action(plan).id == "clarify:income"
    assert all(item.id != "opening" for item in plan.decision_assessment.uncertainties)


@pytest.mark.parametrize("field", ["opening", "amount"])
def test_actual_conflicts_precede_income(field):
    """Resolve disputed funding facts before asking about unreported receipts."""
    data = facts(
        "18000",
        [record("rent", "essential", "10000", "2026-09-15")],
        coverage={},
        conflicts=[
            {
                "id": f"conflict:{'rent' if field == 'amount' else 'opening'}:{field}",
                "field": field,
                **({"recordId": "rent"} if field == "amount" else {}),
                "values": [
                    {"id": "a", "status": "exact", "amountPaise": 1800000},
                    {"id": "b", "status": "exact", "amountPaise": 2000000},
                ],
            }
        ],
    )
    if field == "opening":
        data["opening"] = money(None, "unknown")
    else:
        data["records"][0]["amount"] = money(None, "unknown")
    assert next_action(project(data)).id == f"clarify:{data['conflicts'][0]['id']}"


@pytest.mark.parametrize("status", ["none", "unknown", "reported"])
def test_discussed_income_does_not_trigger_an_income_interview(status):
    """A reported discussion status is not replaced by an assumption of silence."""
    data = facts("18000", coverage={"income": status})
    plan = project(data)
    assert next_action(plan).id == "clarify:coverage"
    assert all(item.id != "income" for item in plan.decision_assessment.uncertainties)
    assert "income" not in next_action(plan).question.casefold()
    assert not plan.decision_assessment.outcome.plan_ready


@pytest.mark.parametrize("income", ["none", "unknown"])
def test_settled_costs_do_not_reopen_discussed_income(income):
    """Explicitly absent costs and discussed income need no further intake."""
    data = facts("18000")
    data["coverage"]["income"] = income
    plan = project(data)
    assert plan.decision_assessment.next_question_id is None
    assert plan.decision_assessment.outcome.plan_ready


@pytest.mark.parametrize("status", ["notDiscussed", "reported", "reviewed"])
def test_recorded_income_does_not_force_other_receipts(status):
    """One usable receipt is sufficient without a salary or source checklist."""
    data = facts("18000", [record("receipt", "income", "10000", "2026-09-20")])
    data["coverage"]["income"] = status
    plan = project(data)
    assert plan.decision_assessment.next_question_id is None
    assert plan.decision_assessment.outcome.plan_ready
    assert all(item.id != "income" for item in plan.decision_assessment.uncertainties)
    assert plan.reliable_income_paise == 1000000


@pytest.mark.parametrize("field", ["amount", "schedule.date", "receipt"])
def test_reported_receipt_uses_its_existing_material_question(field):
    """Unknown receipt terms use record-specific questions, not category discovery."""
    receipt = record("receipt", "income", "10000", "2026-09-12")
    if field == "amount":
        receipt["amount"] = money(None, "unknown")
    elif field == "schedule.date":
        receipt["schedule"]["date"] = None
    else:
        receipt["reliability"] = "unknown"
    data = facts("0", [receipt, record("rent", "essential", "8000", "2026-09-15")])
    data["coverage"]["income"] = "notDiscussed"
    plan = project(data)
    assert next_action(plan).id == f"clarify:receipt:{field}"
    assert all(item.id != "income" for item in plan.decision_assessment.uncertainties)


def test_known_gap_warns_but_discovers_income_before_cuts():
    """A modeled shortage remains visible without assuming no future income."""
    data = facts(
        "18000",
        [
            record("rent", "essential", "10000", "2026-09-11"),
            record("purchase", "optional", "10000", "2026-09-12"),
        ],
        decision={"intent": "specificDecision", "scopeChecked": True},
    )
    data["coverage"]["income"] = "notDiscussed"
    plan = project(data)
    assert plan.first_gap.amount_paise == 200000
    assert next_action(plan).id == "clarify:income"
    assert any(item.kind == "previewChange" for item in plan.decision_assessment.actions)
    assert "shortfall" in plan.decision_assessment.outcome.summary
    assert "Expected income has not been established" in plan.decision_assessment.outcome.summary
    assert not plan.decision_assessment.outcome.plan_ready


async def test_unavailable_income_is_not_repeated_or_settled_by_scope(store):
    """An unavailable response suppresses only its question, not missing costs or uncertainty."""
    await store.create("owner")
    saved = await store.command("owner", parsed_command(facts("18000", coverage={})))
    assert next_action(saved.plan).id == "clarify:income"
    answered = await store.command("owner", response_command(saved, "unavailable"))
    assert answered.facts.coverage.income == "notDiscussed"
    assert answered.facts.records == []
    assert next_action(answered.plan).id == "clarify:coverage"
    assert "income" not in next_action(answered.plan).question.casefold()
    assert not answered.plan.decision_assessment.outcome.plan_ready
    answered.facts.decision.scope_checked = True
    plan = calculate(answered.facts, answered.anchor_date, store.config)
    assert plan.decision_assessment.next_question_id is None
    assert any(item.id == "income" for item in plan.decision_assessment.uncertainties)
    assert "Unavailable details remain unknown" in plan.decision_assessment.outcome.conditions


async def test_unavailable_income_allows_only_a_qualified_comparison(store):
    """With costs reported, unavailable income permits comparison without inventing receipts."""
    await store.create("owner")
    data = facts(
        "18000",
        [record("rent", "essential", "10000", "2026-09-15")],
        decision={"scopeChecked": True},
    )
    data["coverage"]["income"] = "notDiscussed"
    saved = await store.command("owner", parsed_command(data))
    answered = await store.command("owner", response_command(saved, "unavailable"))
    assessment = answered.plan.decision_assessment
    assert assessment.next_question_id is None
    assert assessment.outcome.plan_ready
    assert assessment.outcome.readiness == "qualified"
    assert "Expected income has not been established" in assessment.outcome.summary
    assert answered.plan.closing_paise == saved.plan.closing_paise == 800000
    assert answered.facts.records == saved.facts.records
    assert answered.facts.coverage == saved.facts.coverage


def test_income_dependency_tracks_status_and_receipt_source_only(config):
    """Unrelated edits preserve an answer while income source changes invalidate it."""
    data = normalize(FactsInput.model_validate(facts("18000", coverage={})), config)
    plan = calculate(data, ANCHOR, config)
    key = action_dependency_key(data, plan, "clarify:income")
    assert key is not None
    data.opening.amount_paise = 2000000
    data.decision.scope_checked = True
    data.coverage.essential = "none"
    data.decision.intent = "specificDecision"
    assert action_dependency_key(data, plan, "clarify:income") == key
    data.records = normalize(
        FactsInput.model_validate(
            facts("20000", [record("rent", "essential", "10000", "2026-09-15")])
        ),
        config,
    ).records
    data.coverage.essential = "reported"
    assert action_dependency_key(data, plan, "clarify:income") == key
    data.coverage.income = "unknown"
    assert action_dependency_key(data, plan, "clarify:income") != key
    data.coverage.income = "notDiscussed"
    data.decision.responses = [
        ActionResponse(action_id="clarify:income", response="unavailable", dependency_key=key)
    ]
    data.records = normalize(
        FactsInput.model_validate(
            facts("18000", [record("receipt", "income", "10000", "2026-09-20")])
        ),
        config,
    ).records
    plan = calculate(data, ANCHOR, config)
    receipt_key = action_dependency_key(data, plan, "clarify:income")
    assert receipt_key != key
    assert "Unavailable details" not in plan.decision_assessment.outcome.conditions
    data.records[0].label = "Confirmed receipt"
    assert action_dependency_key(data, plan, "clarify:income") == receipt_key
    data.records[0].schedule.date = date(2026, 9, 21)
    assert action_dependency_key(data, plan, "clarify:income") != receipt_key


@pytest.mark.parametrize("day,gap", [("2026-09-14", False), ("2026-09-16", True)])
def test_receipt_addition_recalculates_funding_and_respects_timing(day, gap):
    """A later receipt improves closing cash without erasing an earlier rent shortfall."""
    data = facts("5000", [record("rent", "essential", "10000", "2026-09-15")])
    data["coverage"]["income"] = "notDiscussed"
    assert next_action(project(data)).id == "clarify:income"
    data["records"].append(record("receipt", "income", "10000", day))
    plan = project(data)
    assert all(item.id != "income" for item in plan.decision_assessment.uncertainties)
    assert plan.closing_paise == 500000
    assert (plan.first_gap is not None) is gap
    if gap:
        assert plan.first_gap.date == date(2026, 9, 15)
        assert plan.first_gap.amount_paise == 500000
        assert "cannot fund the earlier deadline" in plan.decision_assessment.outcome.conditions
