# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import json
from datetime import UTC, date, datetime
from uuid import uuid4

import pytest

from app.voice_tools import VoiceTools, canonical, response_guidance

from .conftest import facts, money, parsed_command, record
from .test_finance import project


@pytest.mark.parametrize("cash,question", [("20000", False), ("5000", True)])
def test_missing_bill_date_blocks_only_when_funding_depends_on_it(cash, question):
    """Reserve known requirements without inventing due dates or collecting immaterial detail."""
    plan = project(
        facts(
            cash,
            [
                record("rent", "essential", "8000", None),
                record("salary", "income", "10000", "2026-09-20"),
            ],
        ),
        date(2026, 9, 12),
    )
    assert plan.decision_assessment.outcome.plan_ready is not question
    assert (plan.decision_assessment.next_question_id == "rent:schedule.date") is question
    assert plan.undated_impact.outflow_paise == 800000
    assert all(event.record_id != "rent" for event in plan.events)
    assert "what-if" in plan.decision_assessment.outcome.summary


@pytest.mark.parametrize(
    "recurrence,count", [("weekly", 5), ("fortnightly", 3), ("daily", 30), ("monthly", 1)]
)
def test_recurring_living_costs_reach_a_qualified_plan(recurrence, count):
    """Derive natural spending occurrences and finish without asking about each trip."""
    grocery = record("groceries", "essential", "100", None)
    grocery["schedule"] = {"date": None, "recurrence": recurrence, "basis": "allowance"}
    plan = project(facts("20000", [grocery]), date(2026, 9, 12))
    assert len(plan.events) == count
    assert plan.outflow_paise == count * 10000
    assert plan.decision_assessment.next_question_id is None
    assert plan.decision_assessment.outcome.plan_ready
    assert plan.decision_assessment.outcome.readiness == "qualified"
    assert "monthly-pattern" not in plan.decision_assessment.outcome.summary.casefold()
    assert "forecast" in plan.decision_assessment.outcome.conditions.casefold()


async def test_gradual_expenses_need_one_contextual_check_not_a_category_loop(store):
    """Preserve incomplete coverage yet present a plan after one answered omissions check."""
    store.clock = lambda: datetime(2026, 9, 12, 6, tzinfo=UTC)
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    tools.user_turn = "I have 20000 rupees. Rent is 8000 due September 15. Help me plan the month."
    await tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money("20000"),
            "records": [
                {
                    "kind": "essential",
                    "label": "Rent",
                    "amount": money("8000"),
                    "schedule": {"date": "2026-09-15"},
                }
            ],
        },
        "rent",
    )
    initial = canonical(await store.get("owner"))
    assert initial["currentAction"]["id"] == "clarify:coverage"
    assert not initial["outcome"]["planReady"]
    tools.user_turn = "I also spend about 1000 rupees a week on groceries."
    await tools.update_facts(
        {
            "expectedRevision": 1,
            "decision": {"scopeChecked": True},
            "scopeEvidence": tools.user_turn,
            "records": [
                {
                    "kind": "essential",
                    "label": "Groceries",
                    "amount": money("1000", "estimate"),
                    "schedule": {"recurrence": "weekly", "basis": "allowance"},
                }
            ],
        },
        "groceries",
    )
    saved = await store.get("owner")
    state = canonical(saved)
    assert saved.facts.coverage.essential == "reported"
    assert saved.facts.coverage.debt == saved.facts.coverage.income == "notDiscussed"
    assert state["outcome"]["planReady"]
    assert state["dialogue"]["questionOptions"] == []
    assert saved.plan.closing_paise == 700000
    result = next(item for item in saved.workspace.results if item.id == "closing")
    assert not any("share of a monthly budget" in text for text in result.qualifications)
    assert any("weekly occurrence" in text for text in result.qualifications)
    assert "Present the 30-day plan now" in response_guidance(state)
    guidance = response_guidance(state)
    evidence = json.loads(next(line for line in guidance.splitlines() if line.startswith("{")))
    assert evidence["periodThrough"] == "2026-10-11"
    assert evidence["recurringAllowances"][0]["occurrences"] == 5
    assert evidence["unconfirmedCategories"] == ["income", "essential", "optional", "debt"]
    assert "scopeEvidence" not in saved.model_dump_json()

    tools.user_turn = "The rent is 9000, not 8000."
    await tools.update_facts(
        {
            "expectedRevision": 2,
            "records": [{"id": saved.facts.records[0].id, "amount": money("9000")}],
        },
        "correction",
    )
    corrected = await store.get("owner")
    assert corrected.facts.decision.scope_checked
    assert corrected.plan.decision_assessment.outcome.plan_ready
    assert corrected.plan.closing_paise == 600000
    assert corrected.sequence > saved.sequence


async def test_post_plan_edit_reopens_only_the_material_question(store):
    """Recalculate readiness from changed amounts instead of retaining a completed latch."""
    await store.create("owner")
    data = facts("20000", [record("rent", "essential", "8000", None)])
    saved = await store.command("owner", parsed_command(data))
    assert saved.plan.decision_assessment.outcome.plan_ready
    data["opening"] = money("5000")
    data["records"].append(record("salary", "income", "10000", "2026-09-20"))
    data["coverage"]["income"] = "reviewed"
    changed = await store.command("owner", parsed_command(data, 1))
    assert not changed.plan.decision_assessment.outcome.plan_ready
    assert changed.plan.decision_assessment.next_question_id == "rent:schedule.date"
    data["records"][0]["schedule"]["date"] = "2026-09-21"
    settled = await store.command("owner", parsed_command(data, 2))
    assert settled.plan.decision_assessment.outcome.plan_ready
    assert settled.plan.closing_paise == 700000


async def test_scope_check_requires_an_answer_and_resets_for_a_different_goal(store):
    """A scope check never manufactures category completeness or survives a different decision."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {"expectedRevision": 0, "decision": {"scopeChecked": True}},
        "unsupported",
    )
    assert result["code"] == "invalidFacts"
    assert (await store.get("owner")).revision == 0
    tools.user_turn = "That is all I can add for now."
    await tools.update_facts(
        {
            "expectedRevision": 0,
            "decision": {"scopeChecked": True},
            "scopeEvidence": tools.user_turn,
        },
        "answered",
    )
    await tools.update_facts(
        {"expectedRevision": 1, "decision": {"concern": "Can I buy a car instead?"}},
        "different-goal",
    )
    assert not (await store.get("owner")).facts.decision.scope_checked
