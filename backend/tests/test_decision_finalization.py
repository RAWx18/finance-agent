# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import json
from datetime import UTC, datetime
from uuid import uuid4

import pytest

from app.voice_tools import TOOL_DEFINITIONS, VoiceTools, canonical, response_guidance

from .conftest import facts, money, parsed_command, record

CONCERN = "Can I afford the outing on 17 September without missing payments?"
COMMITMENTS = [
    {
        "kind": "optional",
        "label": "Outing",
        "amount": money("2500"),
        "schedule": {"date": "2026-09-17"},
        "controllability": "controllable",
    },
    {
        "kind": "essential",
        "label": "Rent",
        "amount": money("10000"),
        "schedule": {"date": "2026-09-15", "recurrence": "monthly"},
    },
    {
        "kind": "essential",
        "label": "Groceries",
        "amount": money("1000"),
        "schedule": {"recurrence": "weekly", "basis": "allowance"},
    },
    {
        "kind": "essential",
        "label": "Electricity",
        "amount": money("1500", "estimate"),
        "schedule": {"date": "2026-09-16"},
    },
    {
        "kind": "debt",
        "label": "Bike EMI",
        "amount": money("3000"),
        "schedule": {"date": "2026-09-18", "recurrence": "monthly"},
        "debtType": "loan",
    },
    {
        "kind": "debt",
        "label": "Credit card",
        "amount": money("3000"),
        "schedule": {"date": "2026-09-24"},
        "debtType": "card",
    },
]
INCOME = [
    {
        "kind": "income",
        "label": "Freelance",
        "amount": money("4000", "estimate"),
        "schedule": {"date": "2026-09-20", "certainty": "estimate"},
        "reliability": "uncertain",
    },
    {
        "kind": "income",
        "label": "Salary",
        "amount": money("30000"),
        "schedule": {"date": "2026-09-25", "certainty": "estimate", "recurrence": "monthly"},
        "reliability": "reliable",
    },
]


def evidence(state):
    """Read the JSON evidence block from the spoken-reply guidance."""
    guidance = response_guidance(state)
    block = next(line for line in guidance.splitlines() if line.startswith("{"))
    return guidance, json.loads(block)


@pytest.fixture
async def outing(store):
    """Replay the reported outing conversation: cash, commitments, focus, then income."""
    store.clock = lambda: datetime(2026, 9, 13, 6, tzinfo=UTC)
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    tools.user_turn = CONCERN + " I have 18000 rupees."
    await tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money("18000"),
            "decision": {"intent": "specificDecision", "concern": CONCERN},
        },
        "concern",
    )
    tools.user_turn = (
        "Outing 2500 on 17 September. Rent 10000 on 15 September monthly. Groceries 1000 weekly. "
        "Electricity 1200 to 1500 on 16 September. Bike EMI 3000 on 18 September monthly. "
        "Credit card 3000 on 24 September."
    )
    await tools.update_facts({"expectedRevision": 1, "records": COMMITMENTS}, "commitments")
    saved = await store.get("owner")
    focus = next(item.id for item in saved.facts.records if item.label == "Outing")
    await tools.update_facts({"expectedRevision": 2, "decision": {"focusRecordIds": [focus]}}, "f")
    tools.user_turn = (
        "Freelance about 4000 around 20 September, not sure it comes. "
        "Salary 30000 around 25 September."
    )
    await tools.update_facts({"expectedRevision": 3, "records": INCOME}, "income")
    return tools


async def test_settled_facts_are_not_asked_again_and_the_answer_comes_first(outing, store):
    """Keep approximate dates and uncertain receipts as qualifications, not repeated questions."""
    saved = await store.get("owner")
    state = canonical(saved)
    labels = {item.id: item.label for item in saved.facts.records}
    assert saved.plan.first_gap.amount_paise == 100000
    assert saved.plan.peak_gap_paise == 400000
    assert state["outcome"]["planReady"] is True
    assert state["outcome"]["headline"].startswith(
        "No, not safely: even without Outing, Credit card on 2026-09-24 would still be "
        "INR 1500.00 short."
    )
    assert state["dialogue"]["stage"] == "plan"
    assert state["dialogue"]["questionOptions"] == []
    asked = {labels[item.record_ids[0]]: item.fields[0] for item in saved.workspace.questions}
    assert asked == {"Freelance": "reliability"}
    assert not any(item.id.endswith(":uncertainDate") for item in saved.workspace.questions)
    assert all(action.kind != "clarify" for action in saved.plan.decision_assessment.actions), [
        action.id for action in saved.plan.decision_assessment.actions
    ]
    reasoning = state["dialogue"]["enoughInformation"]
    assert reasoning["goal"] == CONCERN
    assert reasoning["cashKnown"] and reasoning["incomeEstablished"]
    assert reasoning["commitments"] == 6
    assert reasoning["recurring"] == [
        "Rent: monthly",
        "Groceries: weekly",
        "Bike EMI: monthly",
        "Salary: monthly",
    ]
    assert reasoning["materialUnknowns"] == []
    assert reasoning["unknownsCanChangeRecommendation"] is False
    assert reasoning["settledQualifications"] == ["Freelance: reliability"]
    guidance, evidenced = evidence(state)
    assert evidenced["stage"] == "plan"
    assert evidenced["enoughInformation"] == reasoning
    assert "answer it directly first" in guidance
    assert "Would you like me to explain any part of the plan?" in guidance
    assert "Ask one still-needed, decision-relevant follow-up" not in guidance


async def test_done_signal_and_refused_compromise_move_to_the_plan(outing, store):
    """Record the done signal and the refusal once; neither reopens a compromise question."""
    saved = await store.get("owner")
    outing.user_turn = "This is all I have got."
    result = await outing.update_facts(
        {
            "expectedRevision": saved.revision,
            "decision": {"scopeChecked": True},
            "scopeEvidence": "This is all I have got.",
        },
        "done",
    )
    assert result.get("saved") is True, result
    saved = await store.get("owner")
    state = canonical(saved)
    assert saved.facts.decision.scope_checked is True
    assert state["dialogue"]["stage"] == "plan"
    assert state["dialogue"]["enoughInformation"]["userSaidComplete"] is True
    preview = state["currentAction"]
    assert preview["kind"] == "previewChange"
    outing.user_turn = "No, the outing is all or nothing. I won't reduce it."
    result = await outing.invoke(
        "respond_to_action",
        {"expectedRevision": saved.revision, "actionId": preview["id"], "response": "declined"},
        "declined",
    )
    assert result.get("saved") is True, result
    saved = await store.get("owner")
    state = canonical(saved)
    assert [item.response for item in saved.facts.decision.responses] == ["declined"]
    assert state["outcome"]["planReady"] is True
    assert state["dialogue"]["stage"] == "plan"
    assert all(action["id"] != preview["id"] for action in state["workspace"]["actions"])
    assert not any(action["kind"] == "previewChange" for action in state["workspace"]["actions"])
    assert "Say so if you want that in the plan" not in state["outcome"]["action"]
    assert state["outcome"]["headline"].startswith("No, not safely")
    assert "do not re-offer a reduction they refused" in response_guidance(state)


async def test_done_signal_completes_readiness_when_only_estimates_remain(store):
    """Stop confirming the consumer's own estimates once they say they have given everything."""
    data = facts(
        "3000",
        [
            record("rent", "essential", "2500", "2026-09-15", controllability="committed"),
            {
                **record("dinner", "optional", "1200", "2026-09-14"),
                "amount": money("1200", "estimate"),
            },
        ],
        decision={"intent": "specificDecision", "concern": "Can I still do the dinner?"},
    )
    await store.create("owner")
    saved = await store.command("owner", parsed_command(data))
    assert saved.plan.first_gap is not None
    before = canonical(saved)
    assert before["outcome"]["planReady"] is False
    assert before["dialogue"]["stage"] == "collect"
    assert before["dialogue"]["questionOptions"][0]["id"] == "dinner:estimate"
    data["decision"]["scopeChecked"] = True
    settled = await store.command("owner", parsed_command(data, 1))
    after = canonical(settled)
    assert after["outcome"]["planReady"] is True
    assert after["dialogue"]["stage"] == "plan"
    assert after["dialogue"]["questionOptions"] == []
    assert "dinner:estimate" in after["outcome"]["uncertain"]
    assert after["dialogue"]["enoughInformation"]["settledQualifications"] == []
    assert after["currentAction"]["kind"] != "clarify"


async def test_end_conversation_marks_the_call_for_closing_after_the_goodbye(store):
    """Expose one explicit finish tool that flags the call without touching financial state."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    assert "end_conversation" in {name for name, _, _ in TOOL_DEFINITIONS}
    assert tools.ending is False
    before = await store.get("owner")
    result = await tools.invoke("end_conversation", {}, "bye")
    assert result == {
        "ending": True,
        "message": "Say a one-sentence goodbye. The call ends after this reply; do not ask "
        "anything.",
    }
    assert tools.ending is True
    assert await store.get("owner") == before
