# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest

from app.models import Command
from app.voice_pipeline import VoicePipeline
from app.voice_tools import VoiceTools

from .conftest import money


async def test_partial_turn_records_unknown_fields_without_losing_supplied_facts(store):
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 0,
            "opening": money("4200"),
            "records": [
                {"kind": "essential", "label": "Rent", "amount": money("6000")},
                {"kind": "income", "label": "Wages", "amount": money("18000")},
                {"kind": "debt", "label": "Payment", "schedule": {"date": "2026-09-20"}},
            ],
        },
        "first-turn",
    )
    assert "code" not in result
    snapshot = await store.get("owner")
    rent, wages, debt = snapshot.facts.records
    assert snapshot.facts.opening.amount_paise == 420000
    assert rent.schedule.date is None
    assert wages.reliability == "unknown"
    assert debt.debt_type == "unknown"
    assert debt.amount.amount_paise is None
    assert snapshot.plan.projection_partial
    assert all(
        value not in {"reviewed", "none"} for value in snapshot.facts.coverage.model_dump().values()
    )
    await tools.update_facts(
        {
            "expectedRevision": 1,
            "records": [
                {"id": wages.id, "schedule": {"date": "2026-09-13"}},
                {"id": rent.id, "schedule": {"date": "2026-09-14"}},
            ],
        },
        "dates",
    )
    snapshot = await store.get("owner")
    assert snapshot.plan.reliable_income_paise == 0
    assert snapshot.plan.first_gap.amount_paise == 180000
    await tools.update_facts(
        {"expectedRevision": 2, "records": [{"id": wages.id, "reliability": "reliable"}]},
        "certainty",
    )
    assert (await store.get("owner")).plan.first_gap is None


async def test_voice_change_requires_category_review_after_prior_confirmation(store):
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    await tools.update_facts(
        {"expectedRevision": 0, "coverage": {"optional": "none"}},
        "none",
    )
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 1,
            "records": [{"kind": "optional", "label": "Trip", "amount": money("2000")}],
        },
        "remembered",
    )
    assert "code" not in result
    assert (await store.get("owner")).facts.coverage.optional == "reported"


async def test_review_uses_the_accepted_plan_not_the_baseline(store):
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    await tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money("1000"),
            "coverage": {
                "income": "none",
                "essential": "none",
                "debt": "none",
                "optional": "reviewed",
            },
            "records": [
                {
                    "kind": "optional",
                    "label": "Trip",
                    "controllability": "controllable",
                    "amount": money("2000"),
                    "schedule": {"date": "2026-09-18"},
                },
            ],
        },
        "baseline",
    )
    option = (await store.options("owner")).options[0]
    preview = await store.command(
        "owner",
        Command.model_validate(
            {
                "commandId": str(uuid4()),
                "expectedRevision": 1,
                "operation": {
                    "type": "previewAdjustments",
                    "adjustments": [{"eventId": option.event_id, "amount": "500"}],
                },
            }
        ),
    )
    await store.command(
        "owner",
        Command.model_validate(
            {
                "commandId": str(uuid4()),
                "expectedRevision": 1,
                "operation": {
                    "type": "acceptPreview",
                    "previewId": str(preview.preview.id),
                    "confirmed": True,
                    "consentScope": "unconditional",
                },
            }
        ),
    )
    result = await tools.invoke("review_plan", {"expectedRevision": 2}, "review")
    assert "code" not in result
    assert result["outcome"]["branch"] == "fits"
    assert result["snapshot"]["accepted"]["plan"]["peakGapPaise"] == 0


@pytest.mark.parametrize("user_speaking", [False, True])
async def test_external_correction_resumes_speech_without_talking_over_user(user_speaking):
    from pipecat.frames.frames import LLMRunFrame

    pipeline = VoicePipeline()
    pipeline.started.set()
    pipeline.client_ready.set()
    pipeline.user_speaking = user_speaking
    pipeline.context = Mock()
    pipeline.worker = SimpleNamespace(
        rtvi=SimpleNamespace(interrupt_bot=AsyncMock()), queue_frame=AsyncMock()
    )
    await pipeline.interrupt()
    pipeline.worker.rtvi.interrupt_bot.assert_awaited_once()
    pipeline.context.add_message.assert_called_once()
    if user_speaking:
        pipeline.worker.queue_frame.assert_not_awaited()
    else:
        assert isinstance(pipeline.worker.queue_frame.call_args.args[0], LLMRunFrame)
