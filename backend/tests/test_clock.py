# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
import sqlite3
from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest

from app.config import Environment
from app.finance import calculate, normalize
from app.main import create_app
from app.models import CallState, Command, Error, FactsInput, Plan
from app.store import Problem
from app.voice import Call, CallManager
from app.voice_pipeline import VoicePipeline
from app.voice_tools import VoiceTools, canonical

from .conftest import NOW, facts, parsed_command, record
from .test_adjustments import adjustment
from .test_scenarios import operation


def test_plan_evaluation_date_is_required_and_does_not_rebase(config, tmp_path):
    data = normalize(
        FactsInput.model_validate(
            facts("100", [record("purchase", "optional", "200", "2026-09-11")])
        ),
        config,
    )
    baseline = calculate(data, NOW.date(), config)
    refreshed = calculate(data, NOW.date(), config, today=date(2026, 9, 12))
    assert baseline.evaluated_on == NOW.date()
    assert refreshed.evaluated_on == date(2026, 9, 12)
    assert refreshed.events == baseline.events
    assert refreshed.closing_paise == baseline.closing_paise == -10000
    assert refreshed.decision_assessment != baseline.decision_assessment
    assert Plan.model_fields["evaluated_on"].is_required()
    schema = create_app(config, Environment(data_dir=tmp_path)).openapi()
    plan = schema["components"]["schemas"]["Plan"]
    assert "evaluatedOn" in plan["required"]
    assert plan["properties"]["evaluatedOn"]["type"] == "string"
    assert plan["properties"]["evaluatedOn"]["format"] == "date"


async def test_clock_refresh_is_once_per_local_date_under_concurrent_reads(store):
    store.config = store.config.model_copy(update={"retention_hours": 72})
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(facts("100")))
    queue = await store.subscribe("owner")
    assert queue.get_nowait() == baseline
    writes = store.connection().total_changes
    store.clock = lambda: NOW + timedelta(hours=12, minutes=29)
    assert await store.get("owner") == baseline
    assert store.connection().total_changes == writes
    assert queue.empty()
    store.clock = lambda: NOW + timedelta(hours=12, minutes=30)
    snapshots = await asyncio.gather(*(store.get("owner") for _ in range(8)))
    refreshed = snapshots[0]
    assert all(snapshot == refreshed for snapshot in snapshots)
    assert refreshed.plan.evaluated_on == date(2026, 9, 12)
    assert (refreshed.revision, refreshed.sequence) == (1, 2)
    assert refreshed.facts == baseline.facts
    assert refreshed.expires_at == baseline.expires_at
    assert queue.get_nowait() == refreshed
    assert queue.empty()
    assert store.connection().total_changes == writes + 1
    store.unsubscribe("owner", queue)
    await store.close()
    await store.open()
    assert await store.get("owner") == refreshed
    assert store.connection().total_changes == 0
    store.clock = lambda: NOW + timedelta(hours=61)
    later = await store.get("owner")
    assert later.plan.evaluated_on == date(2026, 9, 14)
    assert (later.revision, later.sequence) == (1, 3)
    assert await store.get("owner") == later
    assert store.connection().total_changes == 1


async def test_clock_refresh_retains_consent_but_rejects_fresh_past_preview(store):
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(facts("100", [record("purchase", "optional", "200", "2026-09-11")])),
    )
    preview = await store.command(
        "owner",
        Command.model_validate(
            operation("previewAdjustments", adjustments=[adjustment("purchase:2026-09-11")])
        ),
    )
    accepted = await store.command(
        "owner",
        Command.model_validate(operation("acceptPreview", previewId=str(preview.preview.id))),
    )
    request = Command.model_validate(
        operation("previewAdjustments", 2, adjustments=[adjustment("purchase:2026-09-11", "10")])
    )
    preview = await store.command("owner", request)
    store.clock = lambda: NOW + timedelta(hours=18)
    options = await store.options("owner")
    assert options.today == date(2026, 9, 12) and options.options == []
    refreshed = await store.get("owner")
    assert (refreshed.revision, refreshed.sequence) == (2, 5)
    assert refreshed.facts == baseline.facts
    assert refreshed.accepted.adjustments == accepted.accepted.adjustments
    assert refreshed.accepted.id == accepted.accepted.id
    assert refreshed.accepted.created_at == accepted.accepted.created_at
    assert refreshed.accepted.source_revision == accepted.accepted.source_revision
    assert refreshed.accepted.plan.closing_paise == accepted.accepted.plan.closing_paise
    assert refreshed.accepted.reduced_outflow_paise == accepted.accepted.reduced_outflow_paise
    assert refreshed.preview.id == preview.preview.id
    assert refreshed.preview.adjustments == preview.preview.adjustments
    assert refreshed.invalidated_assumptions == preview.invalidated_assumptions == []
    for plan in (refreshed.plan, refreshed.preview.plan, refreshed.accepted.plan):
        assert plan.evaluated_on == date(2026, 9, 12)
    with pytest.raises(Problem) as error:
        await store.command(
            "owner",
            Command.model_validate(
                operation("acceptPreview", 2, previewId=str(refreshed.preview.id))
            ),
        )
    assert error.value.body.code == "stalePreview"
    assert error.value.body.snapshot == refreshed
    writes = store.connection().total_changes
    assert await store.command("owner", request) == preview
    assert await store.get("owner") == refreshed
    assert store.connection().total_changes == writes
    async with store.connection().execute(
        "SELECT result FROM commands WHERE id = ?", (str(request.command_id),)
    ) as cursor:
        assert json.loads((await cursor.fetchone())[0]) == preview.model_dump(
            mode="json", by_alias=True
        )


async def test_clock_refresh_failed_write_does_not_publish_and_can_retry(store, monkeypatch):
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(facts("100")))
    queue = await store.subscribe("owner")
    queue.get_nowait()
    store.clock = lambda: NOW + timedelta(hours=18)
    execute = store.connection().execute

    def fail(sql, parameters=None):
        if sql.startswith("UPDATE sessions"):
            raise sqlite3.OperationalError("Synthetic write failure")
        return execute(sql, parameters)

    with monkeypatch.context() as patch:
        patch.setattr(store.connection(), "execute", fail)
        with pytest.raises(sqlite3.OperationalError):
            await store.get("owner")
    assert queue.empty()
    async with execute("SELECT snapshot FROM sessions") as cursor:
        assert json.loads((await cursor.fetchone())[0]) == baseline.model_dump(
            mode="json", by_alias=True
        )
    refreshed = await store.get("owner")
    assert refreshed.sequence == baseline.sequence + 1
    assert queue.get_nowait() == refreshed
    assert queue.empty()


async def test_expiry_takes_precedence_over_clock_refresh(store):
    await store.create("owner")
    queue = await store.subscribe("owner")
    queue.get_nowait()
    store.clock = lambda: NOW + timedelta(hours=24)
    with pytest.raises(Problem) as error:
        await store.get("owner")
    assert error.value.body.code == "expired"
    assert isinstance(queue.get_nowait(), Error)
    assert queue.empty()
    async with store.connection().execute("SELECT COUNT(*) FROM sessions") as cursor:
        assert (await cursor.fetchone())[0] == 0


async def test_voice_only_watch_refreshes_from_store_queue_and_interrupts(store, tmp_path):
    store.config = store.config.model_copy(update={"heartbeat_seconds": 1})
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(facts("100", [record("purchase", "optional", "200", "2026-09-11")])),
    )
    queue = await store.subscribe("owner")
    assert queue.get_nowait() == baseline
    call_id = uuid4()
    call = Call("owner", call_id, CallState(), asyncio.get_running_loop().create_future())
    manager = CallManager(store, store.config, Environment(data_dir=tmp_path))
    interrupted = asyncio.Event()
    messages = [{}]
    pipeline = VoicePipeline()
    pipeline.context = Mock(get_messages=Mock(return_value=messages))
    pipeline.tools = VoiceTools(store, "owner", call_id, pipeline.refresh)
    pipeline.tools.written_sequence = baseline.sequence
    pipeline.refresh(baseline)
    pipeline.refresh = Mock(wraps=pipeline.refresh)
    pipeline.worker = SimpleNamespace(
        rtvi=SimpleNamespace(interrupt_bot=AsyncMock(side_effect=interrupted.set))
    )
    pipeline.started.set()
    task = asyncio.create_task(manager.watch(call, pipeline, queue))
    store.clock = lambda: NOW + timedelta(hours=18)
    try:
        await asyncio.wait_for(interrupted.wait(), 5)
        refreshed = await store.get("owner")
        assert (refreshed.revision, refreshed.sequence) == (1, 2)
        pipeline.refresh.assert_called_once_with(refreshed)
        pipeline.worker.rtvi.interrupt_bot.assert_awaited_once()
        assert pipeline.sequence == refreshed.sequence
        assert queue.empty()
        state = json.loads(messages[0]["content"].split("\n", 1)[1])
        assert state == canonical(refreshed)
        assert not state["activeAssessment"]["choices"]
        assert not call.stop.is_set()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        store.unsubscribe("owner", queue)
