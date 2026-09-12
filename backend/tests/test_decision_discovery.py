# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import json
from copy import deepcopy
from datetime import UTC, datetime
from uuid import uuid4

import pytest

from app.voice_tools import VoiceTools, canonical, response_guidance

from .conftest import money

CONCERN = "Bills before payday. Can I keep the outing without cutting food or missing payments?"
TURNS = [
    "My problem: " + CONCERN,
    "Starting cash: 20000 rupees, correction, 18000 rupees available on 12 September 2026. "
    "Salary: 30000 rupees net on 25 September, monthly and reliable. "
    "Freelance: 4000 rupees net estimate around 20 September; it might never arrive.",
]
INCOME = [
    {
        "kind": "income",
        "label": "Salary",
        "amount": money("30000"),
        "schedule": {"date": "2026-09-25", "recurrence": "monthly"},
        "reliability": "reliable",
    },
    {
        "kind": "income",
        "label": "Freelance",
        "amount": money("4000", "estimate"),
        "schedule": {"date": "2026-09-20", "certainty": "estimate"},
        "reliability": "uncertain",
    },
]


@pytest.fixture
async def discovery(store):
    """Capture a stated goal, available cash correction, and income without invented expenses."""
    store.clock = lambda: datetime(2026, 9, 12, 6, tzinfo=UTC)
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    tools.user_turn = TURNS[0]
    await tools.update_facts(
        {"expectedRevision": 0, "decision": {"intent": "specificDecision", "concern": CONCERN}},
        "concern",
    )
    tools.user_turn = "I have 20000 rupees available on September 12, 2026."
    await tools.update_facts({"expectedRevision": 1, "opening": money("20000")}, "cash")
    tools.user_turn = TURNS[1]
    await tools.update_facts(
        {"expectedRevision": 2, "opening": money("18000"), "records": deepcopy(INCOME)},
        "correction-and-income",
    )
    return tools


async def test_cash_and_income_do_not_answer_the_outing_decision(discovery, store):
    """Keep necessary spending discovery ahead of optional income details and acknowledgement."""
    saved = await store.get("owner")
    state = canonical(saved)
    assert saved.facts.opening.amount_paise == 1800000
    assert saved.facts.decision.concern == CONCERN
    assert all(item.kind == "income" for item in saved.facts.records)
    assert saved.facts.coverage.essential == saved.facts.coverage.debt == "notDiscussed"
    assert saved.facts.coverage.optional == "notDiscussed"
    assert saved.plan.first_gap is None
    assert saved.plan.reliable_income_paise == 3000000
    assert saved.plan.decision_assessment.outcome.readiness != "ready"
    assert state["dialogue"]["purpose"] == "chooseUsefulQuestion"
    assert [item["id"] for item in state["dialogue"]["questionOptions"]] == ["coverage"]
    assert "next bill or essential living cost" in state["currentAction"]["question"]
    assert "initial discovery" in state["dialogue"]["questionOptions"][0]["why"]
    assert "any other" not in state["currentAction"]["question"]
    guidance = response_guidance(state)
    evidence = json.loads(next(line for line in guidance.splitlines() if line.startswith("{")))
    assert evidence["decisionConcern"] == CONCERN
    assert evidence["questionOptions"] == state["dialogue"]["questionOptions"]
    assert "Saving information is not the same as answering the user's decision" in guidance
    assert "Ask one still-needed, decision-relevant follow-up" in guidance
    assert "first completed explanation" not in guidance
    assert await store.get("owner") == saved


async def test_next_commitment_answer_selects_its_missing_detail(discovery, store):
    """Follow the supplied bill's material missing date rather than repeating cash or income."""
    discovery.user_turn = "Rent is 22000 rupees, still unpaid."
    await discovery.update_facts(
        {
            "expectedRevision": 3,
            "records": [{"kind": "essential", "label": "Rent", "amount": money("22000")}],
        },
        "rent",
    )
    saved = await store.get("owner")
    rent = saved.facts.records[-1]
    state = canonical(saved)
    assert state["currentAction"]["recordIds"] == [rent.id]
    assert state["dialogue"]["questionOptions"][0]["id"] == f"{rent.id}:schedule.date"
    assert all(
        item["id"] != f"{saved.facts.records[1].id}:receipt"
        for item in state["dialogue"]["questionOptions"]
    )
    assert saved.facts.decision.concern == CONCERN


async def test_sufficient_commitments_allow_conclusion_without_optional_income_interview(
    discovery, store
):
    """Stop useful intake once the outing and protected commitments can be compared."""
    discovery.user_turn = (
        "Rent 10000 on September 15, food 5000 on September 16, outing 2000 on September 19. "
        "That is all my essential and optional spending. No debts."
    )
    await discovery.update_facts(
        {
            "expectedRevision": 3,
            "records": [
                {
                    "kind": kind,
                    "label": label,
                    "amount": money(amount),
                    "schedule": {"date": day},
                }
                for kind, label, amount, day in [
                    ("essential", "Rent", "10000", "2026-09-15"),
                    ("essential", "Food", "5000", "2026-09-16"),
                    ("optional", "Outing", "2000", "2026-09-19"),
                ]
            ],
            "coverage": {"essential": "reviewed", "optional": "reviewed", "debt": "none"},
            "coverageEvidence": {
                "essential": "That is all my essential and optional spending.",
                "optional": "That is all my essential and optional spending.",
                "debt": "No debts.",
            },
        },
        "commitments",
    )
    saved = await store.get("owner")
    state = canonical(saved)
    assert saved.plan.trough_paise == 100000
    assert saved.plan.closing_paise == 3100000
    assert state["dialogue"]["questionOptions"] == []
    assert state["dialogue"]["purpose"] == "explainNextStep"
    assert "Ask one still-needed, decision-relevant follow-up" not in response_guidance(state)
    assert saved.facts.records[1].reliability == "uncertain"
    assert saved.facts.records[1].amount.status == "estimate"
    assert saved.facts.decision.concern == CONCERN


async def test_material_uncertain_receipt_retains_availability_qualification(discovery, store):
    """Keep the actual-receipt limitation when a reported bill has an unfunded gap."""
    discovery.user_turn = "Rent is 22000 rupees due September 21, unpaid and fixed."
    await discovery.update_facts(
        {
            "expectedRevision": 3,
            "records": [
                {
                    "kind": "essential",
                    "label": "Rent",
                    "amount": money("22000"),
                    "schedule": {"date": "2026-09-21"},
                    "controllability": "committed",
                }
            ],
        },
        "dependent-rent",
    )
    saved = await store.get("owner")
    state = canonical(saved)
    assert saved.plan.first_gap.amount_paise == 400000
    receipt = next(
        item for item in saved.workspace.issues if item.id == f"{saved.facts.records[1].id}:receipt"
    )
    assert "Confirm actual receipt" in receipt.question
    assert state["currentAction"]["kind"] == "contactPayee"
    assert state["currentAction"]["recordIds"] == [saved.facts.records[-1].id]
    assert saved.facts.records[1].reliability == "uncertain"


async def test_explicitly_unavailable_commitments_do_not_force_another_question(discovery, store):
    """Retain the unresolved decision as a limitation when the consumer cannot supply costs."""
    discovery.user_turn = "I cannot list those payments right now. Help with what I have given you."
    result = await discovery.invoke(
        "respond_to_action",
        {"expectedRevision": 3, "actionId": "clarify:coverage", "response": "unavailable"},
        "unavailable",
    )
    assert result.get("saved") is True, result
    state = canonical(await store.get("owner"))
    assert state["dialogue"]["questionOptions"] == []
    assert "Ask one still-needed, decision-relevant follow-up" not in response_guidance(state)
    assert state["outcome"]["readiness"] != "ready"
    assert state["snapshot"]["facts"]["coverage"]["essential"] == "notDiscussed"
