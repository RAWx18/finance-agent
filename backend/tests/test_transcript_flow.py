# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from datetime import UTC, datetime
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from app.voice_tools import VoiceTools, canonical

from .conftest import money
from .test_voice_errors import text_reply
from .test_voice_opening import render
from .test_voice_opening import synthesis as synthesis
from .test_voice_turns import complete_turn, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries


async def test_transcript_cash_correction_discovers_income_before_costs(store):
    """The supplied concern and bank balance do not establish future income."""
    store.clock = lambda: datetime(2026, 9, 13, 6, tzinfo=UTC)
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    await tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money("20000", "estimate"),
            "decision": {
                "intent": "specificDecision",
                "concern": (
                    "Bills before payday; keep the outing without cutting food or missing payments."
                ),
            },
        },
        "cash",
    )
    await tools.update_facts({"expectedRevision": 1, "opening": money("18000")}, "correction")
    state = await tools.read_state()
    assert state["currentAction"]["id"] == "clarify:income"
    assert state["dialogue"]["questionOptions"][0]["fields"] == ["coverage.income"]
    assert not state["outcome"]["planReady"]
    before = await store.get("owner")
    tools.user_turn = "You did not ask about my income. So ask me."
    result = await tools.invoke("read_state", {}, "missed-income")
    assert result["currentAction"]["id"] == "clarify:income"
    assert await store.get("owner") == before


async def test_foreign_subscription_is_saved_then_converted_without_duplicate(store):
    """Keep the transcript's USD 20 obligation even before its INR charge can be calculated."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 0,
            "opening": money("18000"),
            "records": [
                {
                    "kind": "essential",
                    "label": "Work subscription",
                    "amount": {
                        "amount": "20",
                        "status": "exact",
                        "conversion": {"currency": "USD"},
                    },
                    "schedule": {"date": "2026-10-05", "recurrence": "monthly"},
                    "autoDebit": True,
                },
            ],
        },
        "subscription",
    )
    assert result["saved"] is True
    saved = await store.get("owner")
    subscription = saved.facts.records[0]
    assert subscription.amount.amount_paise is None
    assert subscription.amount.source.amount == "20"
    assert subscription.amount.source.conversion.currency == "USD"
    assert subscription.amount.source.conversion.rate is None
    assert saved.plan.outflow_paise == 0
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 1,
            "records": [
                {
                    "id": subscription.id,
                    "amount": {
                        "amount": "20",
                        "status": "exact",
                        "conversion": {
                            "currency": "USD",
                            "rate": "80",
                            "rateStatus": "exact",
                            "fee": "10",
                            "feeStatus": "exact",
                        },
                    },
                },
            ],
        },
        "quoted-rate",
    )
    assert result["saved"] is True
    corrected = await store.get("owner")
    assert len(corrected.facts.records) == 1
    assert corrected.facts.records[0].id == subscription.id
    assert corrected.facts.records[0].amount.amount_paise == 161000
    assert corrected.plan.outflow_paise == 161000
    assert corrected.plan.closing_paise == 1639000


@pytest.mark.parametrize(
    "repeat", ["Add it again.", "My rent is still 10000 on the fifteenth; please put it in."]
)
async def test_rephrased_failed_item_retries_exact_payload_and_call_continues(
    voice,
    synthesis,
    store,
    monkeypatch,
    repeat,
):
    """Retry references survive rephrased input without replacing the original money or date."""
    operation = store.command
    monkeypatch.setattr(store, "command", AsyncMock(side_effect=RuntimeError("storage")))
    voice.responses.put_nowait(
        tool_reply(
            "update_facts",
            {
                "expectedRevision": 0,
                "opening": money("18000"),
                "records": [
                    {
                        "kind": "essential",
                        "label": "Rent",
                        "amount": money("10000"),
                        "schedule": {"date": "2026-09-15", "recurrence": "monthly"},
                    }
                ],
            },
            "rent",
        )
    )
    voice.responses.put_nowait(text_reply("That save is not confirmed."))
    await complete_turn(voice, "I have 18000 and my rent is 10000 on September 15 every month.")
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "That save is not confirmed.")
    await asyncio.wait_for(synthesis.turns.get(), 2)
    pending = voice.pipeline.tools.write_context()["unresolved"][0]
    monkeypatch.setattr(store, "command", operation)
    voice.responses.put_nowait(tool_reply("retry_write", {"writeId": pending["writeId"]}, "retry"))
    voice.responses.put_nowait(text_reply("The rent is saved. What income is coming in?"))
    await complete_turn(voice, repeat)
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "The rent is saved. What income is coming in?")
    await asyncio.wait_for(synthesis.turns.get(), 2)
    state = canonical(await store.get("owner"))
    assert state["snapshot"]["revision"] == 1
    assert len(state["snapshot"]["facts"]["records"]) == 1
    assert state["currentAction"]["id"] == "clarify:income"
    assert not voice.pipeline.revoked and not voice.pipeline.task.done()
