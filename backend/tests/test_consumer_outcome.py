# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import UTC, datetime
from uuid import uuid4

import pytest

from app.voice_tools import VoiceTools, canonical, currency_context, turn_needs_tools

from .conftest import money


@pytest.fixture
async def tools(store):
    """Provide voice tools over an isolated store fixed at 13 September 2026."""
    store.clock = lambda: datetime(2026, 9, 13, 6, tzinfo=UTC)
    await store.create("owner")
    return VoiceTools(store, "owner", uuid4(), lambda snapshot: None)


async def test_gradual_salaried_renter_reaches_a_plan_without_confirming_estimates(tools, store):
    """Verify pattern salary, pattern rent and estimated groceries produce a ready plain plan."""
    tools.user_turn = "about 12 thousand in the bank"
    await tools.update_facts({"expectedRevision": 0, "opening": money("12000", "estimate")}, "a")
    tools.user_turn = "salary 45000 on the 1st, rent 15000 on the 5th, groceries about 2500 a week"
    await tools.update_facts(
        {
            "expectedRevision": 1,
            "records": [
                {
                    "kind": "income",
                    "label": "Salary",
                    "amount": money("45000"),
                    "schedule": {
                        "recurrence": "monthly",
                        "pattern": {"kind": "dayOfMonth", "day": 1},
                    },
                    "reliability": "reliable",
                },
                {
                    "kind": "essential",
                    "label": "Rent",
                    "amount": money("15000"),
                    "schedule": {
                        "recurrence": "monthly",
                        "pattern": {"kind": "dayOfMonth", "day": 5},
                    },
                    "controllability": "committed",
                },
                {
                    "kind": "essential",
                    "label": "Groceries",
                    "amount": money("2500", "estimate"),
                    "schedule": {"recurrence": "weekly", "basis": "allowance"},
                    "controllability": "controllable",
                },
            ],
        },
        "b",
    )
    state = canonical(await store.get("owner"))
    assert state["activePlan"]["firstGap"] is None
    assert state["activePlan"]["reliableIncomePaise"] == 4500000
    assert [item["id"] for item in state["dialogue"]["questionOptions"]] == ["coverage"]
    assert not any("confirm" in item["question"].lower() for item in state["workspace"]["actions"])
    tools.user_turn = "no that's about it"
    await tools.update_facts(
        {
            "expectedRevision": 2,
            "decision": {"scopeChecked": True},
            "scopeEvidence": "that's about it",
        },
        "c",
    )
    outcome = canonical(await store.get("owner"))["outcome"]
    assert outcome["planReady"] is True
    assert outcome["headline"].startswith("Your dated payments fit")
    assert outcome["action"].startswith("Salary is counted on 2026-10-01 from your usual monthly")
    assert "Check it has actually arrived before paying Rent on 2026-10-05" in outcome["action"]
    assert outcome["topCaveat"].startswith("Salary is counted on its usual day and amount")
    assert outcome["secondary"] == "Without Salary, Rent on 2026-10-05 would be INR 13000.00 short."


async def test_purchase_question_names_the_skip_and_its_effect(tools, store):
    """Verify a purchase decision yields a headline gap and a plain skip-the-purchase step."""
    tools.user_turn = "can I buy a 9000 phone this week? 14000 in the account, no income this month"
    await tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money("14000"),
            "coverage": {"income": "none"},
            "coverageEvidence": {"income": "no income this month"},
            "decision": {"intent": "specificDecision", "concern": "buy a 9000 phone this week"},
            "records": [
                {
                    "kind": "optional",
                    "label": "Phone",
                    "amount": money("9000"),
                    "schedule": {"date": "2026-09-16", "recurrence": "once"},
                    "controllability": "controllable",
                },
                {
                    "kind": "essential",
                    "label": "Rent",
                    "amount": money("8000"),
                    "schedule": {"date": "2026-10-01", "recurrence": "monthly"},
                    "controllability": "committed",
                },
                {
                    "kind": "essential",
                    "label": "Food",
                    "amount": money("4000", "estimate"),
                    "schedule": {"recurrence": "monthly", "basis": "allowance"},
                    "controllability": "controllable",
                },
            ],
        },
        "a",
    )
    outcome = canonical(await store.get("owner"))["outcome"]
    assert outcome["planReady"] is True
    assert outcome["headline"] == "Rent on 2026-10-01 is INR 7000.00 short."
    assert outcome["action"].startswith("Skipping Phone on 2026-09-16 would remove the shortfall.")
    assert outcome["topCaveat"] == "Anything you have not mentioned yet is not included."
    assert outcome["secondary"] is None


def test_turn_needs_tools_only_relaxes_for_number_free_questions_about_a_ready_plan():
    """Verify forced tool rounds stay for facts, decisions and any turn before the plan is ready."""
    assert turn_needs_tools("so I just wait for the salary?", plan_ready=False)
    assert not turn_needs_tools("so I just wait for the salary?", plan_ready=True)
    assert not turn_needs_tools("I don't really follow what I should do first.", plan_ready=True)
    assert turn_needs_tools("rent is 10000 not 8000", plan_ready=True)
    assert turn_needs_tools("make that fifteen thousand", plan_ready=True)
    assert turn_needs_tools("yes, do that", plan_ready=True)
    assert turn_needs_tools("no, skip the phone", plan_ready=True)
    assert turn_needs_tools("actually remove the loan", plan_ready=True)


async def test_currency_guidance_is_only_attached_when_currency_appears(tools, store):
    """Verify foreign-currency guidance keys off saved conversions or currency words."""
    tools.user_turn = "cash 5000"
    await tools.update_facts({"expectedRevision": 0, "opening": money("5000")}, "a")
    state = canonical(await store.get("owner"))
    assert not currency_context(state, "rent is 8000")
    assert currency_context(state, "I pay $20 for a subscription")
    assert currency_context(state, "about 40 dollars a month")
    tools.user_turn = "a 20 USD subscription"
    await tools.update_facts(
        {
            "expectedRevision": 1,
            "records": [
                {
                    "kind": "essential",
                    "label": "Subscription",
                    "amount": {
                        "amount": "20",
                        "status": "exact",
                        "conversion": {"currency": "USD"},
                    },
                    "schedule": {"date": "2026-10-05", "recurrence": "monthly"},
                }
            ],
        },
        "b",
    )
    assert currency_context(canonical(await store.get("owner")), "thanks")
