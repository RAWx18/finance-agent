# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import timedelta
from uuid import uuid4

import pytest

from app.voice_tools import VoiceTools

from .conftest import money, record


async def test_approximate_outside_obligation_never_becomes_a_fit_claim(store):
    """Verify approximate off-window obligations stay qualified until exact dates settle risk."""
    initial = await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    outside = initial.end_date_exclusive.isoformat()
    tools.user_turn = (
        f"I have 1000 rupees. My monthly rent is 2000, due around {outside}. "
        "Rent is my only unpaid living cost. For the next thirty days, "
        "I have no income, no optional spending and no debts."
    )
    state = await tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money("1000"),
            "coverage": {
                "income": "none",
                "essential": "reviewed",
                "optional": "none",
                "debt": "none",
            },
            "coverageEvidence": {
                "income": "no income",
                "essential": "Rent is my only unpaid living cost",
                "optional": "no optional spending",
                "debt": "no debts",
            },
            "records": [
                {
                    "kind": "essential",
                    "label": "Rent",
                    "amount": money("2000"),
                    "schedule": {"date": outside, "certainty": "estimate", "recurrence": "monthly"},
                }
            ],
        },
        "approximate-rent",
    )
    assert state["activePlan"]["events"] == []
    assert state["activePlan"]["closingPaise"] == 100000
    assert "dated payments fit" not in state["spokenBrief"]
    assert "Rent" in state["outcome"]["summary"]
    assert "estimated date" in state["outcome"]["summary"]
    record_id = state["snapshot"]["facts"]["records"][0]["id"]
    state = await tools.update_facts(
        {
            "expectedRevision": state["snapshot"]["revision"],
            "records": [
                {
                    "id": record_id,
                    "schedule": {
                        "date": (initial.end_date_exclusive - timedelta(days=1)).isoformat(),
                        "certainty": "exact",
                    },
                }
            ],
        },
        "inside-rent",
    )
    assert state["activePlan"]["firstGap"]["amountPaise"] == 100000
    state = await tools.update_facts(
        {
            "expectedRevision": state["snapshot"]["revision"],
            "records": [{"id": record_id, "schedule": {"date": outside, "certainty": "exact"}}],
        },
        "outside-exact-rent",
    )
    assert state["activePlan"]["firstGap"] is None
    assert state["outcome"]["branch"] == "fits"


async def test_estimated_required_payment_keeps_its_basis_after_target_correction(store):
    """Verify card corrections retain the required-payment basis and matching evidence certainty."""
    initial = await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    tools.user_turn = (
        "I have 100 rupees. My card requires about 500, but I plan to pay 2000 "
        f"on {(initial.anchor_date + timedelta(days=3)).isoformat()}. "
        "That card is my only debt. For the next thirty days, I have no income, "
        "no unpaid living costs and no optional spending."
    )
    state = await tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money("100"),
            "coverage": {
                "income": "none",
                "essential": "none",
                "optional": "none",
                "debt": "reviewed",
            },
            "coverageEvidence": {
                "income": "no income",
                "essential": "no unpaid living costs",
                "optional": "no optional spending",
                "debt": "That card is my only debt",
            },
            "records": [
                {
                    "kind": "debt",
                    "label": "Card",
                    "debtType": "card",
                    "amount": money("500", "estimate"),
                    "target": money("2000"),
                    "schedule": {"date": (initial.anchor_date + timedelta(days=3)).isoformat()},
                }
            ],
        },
        "card-target",
    )
    assert "required payment of INR 500.00" in state["currentAction"]["question"]
    assert "estimated amount of INR 2000.00" not in state["currentAction"]["question"]
    assert (
        next(item for item in state["workspace"]["results"] if item["id"] == "closing")["state"]
        == "uncertain"
    )
    record_id = state["snapshot"]["facts"]["records"][0]["id"]
    state = await tools.update_facts(
        {
            "expectedRevision": state["snapshot"]["revision"],
            "records": [{"id": record_id, "target": money(None, "unknown")}],
        },
        "unknown-target",
    )
    assert state["activePlan"]["events"][0]["amountBasis"] == "requiredOnly"
    assert state["activePlan"]["outflowPaise"] == 50000
    assert "required payment of INR 500.00" in state["currentAction"]["question"]
    for identity in ("datedOutflow", "closing", "trough", "firstGap", "peakGap"):
        result = next(item for item in state["workspace"]["results"] if item["id"] == identity)
        assert result["state"] == "estimated"
        assert any("target" in issue for issue in result["issueIds"])
    state = await tools.update_facts(
        {
            "expectedRevision": state["snapshot"]["revision"],
            "records": [{"id": record_id, "amount": money("600")}],
        },
        "confirmed-required",
    )
    assert state["activePlan"]["firstGap"]["amountPaise"] == 50000
    assert (
        next(item for item in state["workspace"]["results"] if item["id"] == "closing")["state"]
        != "estimated"
    )


@pytest.mark.parametrize("opening,ask", [("50000", False), ("1000", True)])
async def test_unneeded_receipt_question_does_not_leak_into_voice(store, opening, ask):
    """Verify undated receipts prompt voice questions only when needed for the purchase."""
    initial = await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    tools.user_turn = (
        f"I have {opening} rupees. Can I buy a phone for 5000 "
        f"on {(initial.anchor_date + timedelta(days=3)).isoformat()}? "
        "A 1000 rupee bonus is certain, but its date is not settled. "
        "That bonus is all my income for the next thirty days. "
        "The phone is my only optional spending. I have no unpaid living costs and no debts."
    )
    state = await tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money(opening),
            "decision": {"intent": "specificDecision", "concern": "Can I buy this phone?"},
            "coverage": {
                "income": "reviewed",
                "essential": "none",
                "optional": "reviewed",
                "debt": "none",
            },
            "coverageEvidence": {
                "income": "That bonus is all my income for the next thirty days",
                "essential": "no unpaid living costs",
                "optional": "The phone is my only optional spending",
                "debt": "no debts",
            },
            "records": [
                {
                    "kind": "optional",
                    "label": "Phone",
                    "amount": money("5000"),
                    "schedule": {"date": (initial.anchor_date + timedelta(days=3)).isoformat()},
                },
                {
                    "kind": "income",
                    "label": "Bonus",
                    "amount": money("1000"),
                    "reliability": "reliable",
                },
            ],
        },
        "phone-and-bonus",
    )
    bonus = state["snapshot"]["facts"]["records"][1]["id"]
    assert any(item["id"] == f"{bonus}:schedule.date" for item in state["workspace"]["issues"])
    assert (
        any(item["id"] == f"{bonus}:schedule.date" for item in state["workspace"]["questions"])
        == ask
    )
    assert state["activePlan"]["reliableIncomePaise"] == 0
    if not ask:
        assert state["dialogue"]["purpose"] == "explainNextStep"
        assert state["currentAction"]["kind"] == "reviewOutcome"
        assert state["activePlan"]["closingPaise"] == 4500000


async def test_mixed_income_multiple_debts_and_corrections_share_one_dated_plan(store):
    """Verify mixed finances and corrections stay consistent across plans, streams, and cards."""
    initial = await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)

    def day(offset):
        """Format an ISO date at the given offset from the session anchor."""
        return (initial.anchor_date + timedelta(days=offset)).isoformat()

    items = [
        record("salary", "income", "10000", day(10)),
        record("side", "income", "1000", day(1), schedule={"date": day(1), "recurrence": "weekly"}),
        record("freelance", "income", "2000", day(5), reliability="uncertain"),
        record(
            "food", "essential", "500", day(0), schedule={"date": day(0), "recurrence": "weekly"}
        ),
        record("rent", "essential", "4000", day(2), controllability="committed"),
        record("loan", "debt", "1000", day(4), autoDebit=True),
        record("otherLoan", "debt", "500", day(4)),
        record("card", "debt", "200", day(6), debtType="card", target=money("1000")),
        record("otherCard", "debt", "300", day(8), debtType="card"),
        record("purchase", "optional", "600", day(12)),
    ]
    tools.user_turn = (
        f"I have 5000 rupees. Salary is 10000 on {day(10)}, and side work pays "
        f"1000 weekly from {day(1)}. Freelance might pay 2000 on {day(5)}. "
        "Those are all my income sources for the next thirty days. "
        f"Food costs 500 weekly from {day(0)}, and rent is 4000 on {day(2)}; "
        "I cannot change the rent. Food and rent are my only unpaid living costs. "
        f"One loan takes 1000 automatically on {day(4)}, and another needs 500 that day. "
        f"One card requires 200 on {day(6)}, but I plan to pay 1000. "
        f"The other card requires 300 on {day(8)}. Those are all my debts. "
        f"I plan a 600 rupee purchase on {day(12)}. That purchase is my only optional spending."
    )
    state = await tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money("5000"),
            "coverage": dict.fromkeys(("income", "essential", "optional", "debt"), "reviewed"),
            "coverageEvidence": {
                "income": "Those are all my income sources for the next thirty days",
                "essential": "Food and rent are my only unpaid living costs",
                "optional": "That purchase is my only optional spending",
                "debt": "Those are all my debts",
            },
            "records": [
                {key: value for key, value in item.items() if key != "id"} for item in items
            ],
        },
        "mixed-income-and-debts",
    )
    assert state["activePlan"]["reliableIncomePaise"] == 1500000
    assert state["activePlan"]["uncertainIncomePaise"] == 200000
    assert state["activePlan"]["outflowPaise"] == 990000
    assert state["activePlan"]["closingPaise"] == 1010000
    assert state["activePlan"]["firstGap"] == {"date": day(6), "amountPaise": 100000}
    assert state["activePlan"]["peakGapPaise"] == 180000
    assert state["activePlan"]["peakGapDate"] == day(8)
    assert len(state["snapshot"]["facts"]["records"]) == 10
    salary = state["snapshot"]["facts"]["records"][0]["id"]
    stream = await store.subscribe("owner")
    await stream.get()
    try:
        state = await tools.update_facts(
            {
                "expectedRevision": state["snapshot"]["revision"],
                "records": [{"id": salary, "schedule": {"date": day(3)}}],
            },
            "salary-earlier",
        )
        snapshot = await stream.get()
        assert state["snapshot"] == snapshot.model_dump(mode="json", by_alias=True)
    finally:
        store.unsubscribe("owner", stream)
    assert state["activePlan"]["firstGap"] is None
    assert state["activePlan"]["closingPaise"] == 1010000
    assert state["activePlan"]["outflowPaise"] == 990000
    assert len(state["snapshot"]["facts"]["records"]) == 10
    assert {item["template"] for item in state["workspace"]["cards"]} >= {"cash", "timeline"}
    timeline = next(item for item in state["workspace"]["cards"] if item["template"] == "timeline")
    assert set(timeline["recordIds"]) == {
        item["id"] for item in state["snapshot"]["facts"]["records"]
    }
    assert {row["field"] for row in timeline["rows"]} == set(timeline["recordIds"])
