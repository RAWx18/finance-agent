# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from copy import deepcopy
from uuid import uuid4

from pipecat.frames.frames import TTSAudioRawFrame

from app.voice_tools import VoiceTools, canonical, response_guidance

from .conftest import facts, money, parsed_command, record
from .test_voice_errors import text_reply
from .test_voice_opening import render
from .test_voice_opening import synthesis as synthesis
from .test_voice_turns import complete_turn, next_frame, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries


async def test_response_evidence_preserves_unknowns_and_uses_the_active_plan(store):
    """Keep unknown cash unknown and use current deterministic amounts without side effects."""
    state = canonical(await store.create("owner"))
    before = deepcopy(state)
    guidance = response_guidance(state)
    assert '"closingPaise":null' in guidance
    assert "include one short plan-specific" not in guidance
    assert state == before

    saved = await store.command(
        "owner",
        parsed_command(facts("6000", [record("rent", "essential", "2000", "2026-09-15")])),
    )
    guidance = response_guidance(canonical(saved))
    assert '"closingPaise":400000' in guidance
    assert '"troughPaise":400000' in guidance
    assert "include one short plan-specific understanding question" in guidance
    assert "do not repeat a check already answered accurately" in guidance
    assert "ask after goodbye" in guidance
    assert await store.get("owner") == saved


async def test_conflict_reply_cannot_use_partial_closing_as_an_affordability_comparison(store):
    """Place conflict limitations next to partial results without selecting a reported value."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    await tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money("10000"),
            "records": [
                {
                    "kind": "essential",
                    "label": "Rent",
                    "schedule": {"date": "2026-09-15"},
                    "conflicts": [
                        {
                            "field": "amount",
                            "values": [
                                {"id": "note", "amount": "4000", "status": "exact"},
                                {"id": "message", "amount": "4500", "status": "exact"},
                            ],
                        }
                    ],
                }
            ],
        },
        "conflicting-rent",
    )
    saved = await store.get("owner")
    guidance = response_guidance(canonical(saved))
    assert '"projectionPartial":true' in guidance
    assert "Do not calculate alternative balances for competing reports" in guidance
    assert "include one short plan-specific" not in guidance
    assert "do not append a second question" in guidance
    assert await store.get("owner") == saved


async def test_actual_posttool_request_uses_corrected_figures_before_synthesis(
    voice, synthesis, store
):
    """Send current evidence through Pipecat after a save without retaining it in history."""
    saved = await store.command(
        "owner",
        parsed_command(
            facts(
                "10000",
                [
                    record("sbi", "debt", "2000", "2026-09-16"),
                    record("hdfc", "debt", "3000", "2026-09-18"),
                    record("rent", "essential", "4500", "2026-09-15"),
                ],
            )
        ),
    )
    voice.pipeline.refresh(saved)
    voice.pipeline.context.add_message(
        {"role": "assistant", "content": "Your lowest balance is five hundred rupees."}
    )
    voice.responses.put_nowait(
        tool_reply(
            "update_facts",
            {"expectedRevision": 1, "records": [{"id": "sbi", "amount": money("2500")}]},
            "identified-sbi",
        )
    )
    voice.responses.put_nowait(text_reply("The corrected payments leave zero rupees."))
    await complete_turn(voice, "SBI is 2500, not 2000; HDFC stays the same.")
    requests = [await asyncio.wait_for(voice.requests.get(), 2) for _ in range(2)]
    corrected = await store.get("owner")
    assert corrected.revision == 2
    assert corrected.plan.trough_paise == corrected.plan.closing_paise == 0
    assert corrected.facts.records[1:] == saved.facts.records[1:]
    assert (
        next(item for item in corrected.workspace.results if item.id == "closing").amount_paise == 0
    )
    guidance = requests[1]["messages"][-1]
    assert guidance["content"] == response_guidance(canonical(corrected))
    assert '"troughPaise":0' in guidance["content"]
    assert '"troughPaise":50000' not in guidance["content"]
    assert guidance not in requests[0]["messages"]
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "The corrected payments leave zero rupees.")
    await next_frame(voice.frames, TTSAudioRawFrame)
    await asyncio.wait_for(synthesis.turns.get(), 2)
    assert guidance not in voice.pipeline.context.get_messages()
    assert await store.get("owner") == corrected
