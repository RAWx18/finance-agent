# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date
from uuid import uuid4

import pytest

from app.voice_tools import VoiceTools

from .conftest import facts, parsed_command, record
from .test_decision_priorities import next_action
from .test_finance import project


async def test_linked_choice_reproduces_its_metrics_with_retained_assumptions(store):
    await store.create("owner")
    data = facts(
        "100",
        [
            record("a", "optional", "80", "2026-09-12", label="Purchase A"),
            record("b", "optional", "80", "2026-09-13", label="Purchase B"),
            record("rent", "essential", "100", "2026-09-14", label="Rent"),
        ],
    )
    await store.command("owner", parsed_command(data))
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    proposal = await tools.invoke(
        "preview_adjustments",
        {
            "expectedRevision": 1,
            "adjustments": [{"eventId": "a:2026-09-12", "amount": "0"}],
        },
        "first-preview",
    )
    await tools.invoke(
        "accept_preview",
        {
            "expectedRevision": 1,
            "previewId": proposal["snapshot"]["preview"]["id"],
            "confirmed": True,
            "consentScope": "unconditional",
        },
        "first-acceptance",
    )
    current = await store.get("owner")
    plan = current.accepted.plan
    action = next_action(plan)
    choice = next(item for item in plan.decision_assessment.choices if item.id == action.choice_id)
    assert choice.metrics.first_gap is None and choice.metrics.closing_paise == 0
    result = await tools.invoke(
        "preview_adjustments",
        {
            "expectedRevision": 2,
            "adjustments": [
                {
                    "eventId": item.event_id,
                    "amount": f"{item.amount_paise // 100}.{item.amount_paise % 100:02}",
                }
                for item in choice.adjustment_amounts
            ],
        },
        "linked-preview",
    )
    preview = result["snapshot"]["preview"]
    assert preview["plan"]["closingPaise"] == choice.metrics.closing_paise
    assert preview["plan"]["firstGap"] is None
    assert preview["removedAssumptionIds"] == []
    assert {item["eventId"] for item in preview["adjustments"]} == {
        "a:2026-09-12",
        "b:2026-09-13",
    }
    assert result["activePlan"]["closingPaise"] == -8000


@pytest.mark.parametrize("controllability", ["unknown", "controllable"])
def test_future_estimated_purchase_gets_a_future_facing_decision(controllability):
    item = record(
        "purchase",
        "optional",
        "8000",
        "2026-09-20",
        label="Purchase",
        controllability=controllability,
    )
    item["amount"]["status"] = "estimate"
    plan = project(facts("4000", [item]))
    action = next_action(plan)
    assert action.kind == "clarify"
    assert action.before_date == date(2026, 9, 20)
    assert action.record_ids == ["purchase"]
    assert "estimate" in action.question.lower()
    assert "hold off" in action.question.lower()
    assert "elapsed" not in action.question and "retrospective" not in action.question
    assert plan.first_gap.amount_paise == 400000 and plan.closing_paise == -400000
    assert plan.decision_assessment.next_question_id == "purchase:estimate"
    assert not plan.decision_assessment.choices
