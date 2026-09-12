# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
import logging
from datetime import timedelta
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from app.models import Error
from app.store import Problem
from app.voice import Call, CallManager

from .test_voice import PipelineDouble, RoomsDouble, environment
from .test_voice import provider_doubles as provider_doubles


@pytest.fixture
async def manager(store, config, tmp_path, provider_doubles):
    """Yield an owner-scoped call manager with provider doubles and close it afterward."""
    await store.create("owner")
    manager = CallManager(store, config, environment(tmp_path))
    try:
        yield manager
    finally:
        await manager.close()


async def test_successful_catalog_check_is_cached_per_manager(manager, monkeypatch):
    """Verify successful voice checks are cached per manager rather than shared globally."""
    check = AsyncMock()
    monkeypatch.setattr("app.voice.check_voice", check)
    first = await manager.start("owner", uuid4())
    assert (await manager.end("owner", first.call_id)).cleanup_confirmed
    second = await manager.start("owner", uuid4())
    check.assert_awaited_once_with(manager.config, manager.environment)
    assert len(RoomsDouble.instances) == 2
    assert (await manager.end("owner", second.call_id)).cleanup_confirmed
    other = CallManager(manager.store, manager.config, manager.environment)
    try:
        await other.start("owner", uuid4())
        assert check.await_count == 2
    finally:
        await other.close()


async def test_concurrent_preparation_shares_successful_check(manager, monkeypatch):
    """Verify concurrent voice preparation shares one successful catalog check."""
    reached, release = asyncio.Event(), asyncio.Event()

    async def check(*args):
        """Signal simulated catalog check entry and wait for release."""
        reached.set()
        await release.wait()

    check = AsyncMock(side_effect=check)
    monkeypatch.setattr("app.voice.check_voice", check)
    preparing = asyncio.gather(manager.prepare_voice(), manager.prepare_voice())
    try:
        await asyncio.wait_for(reached.wait(), 1)
        release.set()
        await asyncio.wait_for(preparing, 1)
        await manager.start("owner", uuid4())
        check.assert_awaited_once_with(manager.config, manager.environment)
    finally:
        release.set()
        await preparing


async def test_cancelled_catalog_check_is_not_cached(manager, monkeypatch):
    """Verify cancelled catalog checks are retried and allocate no room."""
    reached = asyncio.Event()

    async def check(*args):
        """Signal simulated catalog check entry and block until cancelled."""
        reached.set()
        await asyncio.Event().wait()

    check = AsyncMock(side_effect=check)
    monkeypatch.setattr("app.voice.check_voice", check)
    call_id = uuid4()
    starting = asyncio.create_task(manager.start("owner", call_id))
    try:
        await asyncio.wait_for(reached.wait(), 1)
        assert (await manager.end("owner", call_id)).cleanup_confirmed
        with pytest.raises(Problem):
            await starting
        assert not RoomsDouble.instances and not manager.voice_checked
        check.side_effect = None
        await manager.start("owner", uuid4())
        assert check.await_count == 2
    finally:
        await manager.close()
        await asyncio.gather(starting, return_exceptions=True)


async def test_failed_catalog_check_is_retried_before_room_creation(manager, monkeypatch):
    """Verify failed catalog checks are retried before room allocation."""
    check = AsyncMock(side_effect=[Problem(503, "voiceUnavailable", "Invalid voice."), None])
    monkeypatch.setattr("app.voice.check_voice", check)
    with pytest.raises(Problem, match="Invalid voice"):
        await manager.start("owner", uuid4())
    assert not RoomsDouble.instances
    assert manager.call.state.cleanup_confirmed
    await manager.start("owner", uuid4())
    assert check.await_count == 2 and len(RoomsDouble.instances) == 1


async def test_tokens_overlap_and_join_waits_for_construction_not_readiness(manager, monkeypatch):
    """Verify token requests overlap and joins wait for construction rather than readiness."""
    both, release, constructing, constructed = (asyncio.Event() for _ in range(4))
    tokens = []
    start = PipelineDouble.start

    async def token(self, name, expires, user):
        """Record concurrent token requests and return indexed dummy credentials on release."""
        index = len(tokens)
        tokens.append((name, expires, user))
        if len(tokens) == 2:
            both.set()
        await release.wait()
        return f"credential-{index}"

    async def construct(self, *args):
        """Check the bot token and defer fake pipeline construction until released."""
        assert args[4] == "credential-1"
        constructing.set()
        await constructed.wait()
        await start(self, *args)

    monkeypatch.setattr(RoomsDouble, "token", token)
    monkeypatch.setattr(PipelineDouble, "start", construct)
    starting = asyncio.create_task(manager.start("owner", uuid4()))
    try:
        await asyncio.wait_for(both.wait(), 1)
        assert tokens[0][:2] == tokens[1][:2] and tokens[0][2] != tokens[1][2]
        assert not starting.done() and not manager.call.join.done()
        release.set()
        await asyncio.wait_for(constructing.wait(), 1)
        assert not manager.call.join.done()
        constructed.set()
        join = await asyncio.wait_for(starting, 1)
        assert join.token == "credential-0"
        assert manager.state("owner").status == "connecting"
        assert not PipelineDouble.instances[0].ready_event.is_set()
    finally:
        release.set()
        constructed.set()
        await manager.close()
        await asyncio.gather(starting, return_exceptions=True)


@pytest.mark.parametrize("failure", ["provider", "end", "request", "timeout"])
async def test_token_requests_settle_before_room_deletion(manager, monkeypatch, failure):
    """Verify token tasks settle before room deletion for each startup failure path."""
    both, cancelled, release, settled = (asyncio.Event() for _ in range(4))
    requests = []
    delete = RoomsDouble.delete
    if failure == "timeout":
        manager.config = manager.config.model_copy(
            update={"voice": manager.config.voice.model_copy(update={"startup_seconds": 0.05})}
        )

    async def token(self, *args):
        """Coordinate token requests with simulated failure and deferred cancellation cleanup."""
        index = len(requests)
        requests.append(asyncio.current_task())
        if len(requests) == 2:
            both.set()
        await both.wait()
        if index == 0 and failure == "provider":
            raise Problem(503, "voiceUnavailable", "Daily returned an invalid token.")
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
            await release.wait()
            settled.set()

    async def delete_room(self, name):
        """Require token tasks to finish before recording the fake room deletion."""
        assert settled.is_set() and all(task.done() for task in requests)
        await delete(self, name)

    monkeypatch.setattr(RoomsDouble, "token", token)
    monkeypatch.setattr(RoomsDouble, "delete", delete_room)
    call_id = uuid4()
    starting = asyncio.create_task(manager.start("owner", call_id))
    ending = None
    try:
        await asyncio.wait_for(both.wait(), 1)
        if failure == "end":
            ending = asyncio.create_task(manager.end("owner", call_id))
        elif failure == "request":
            starting.cancel()
        await asyncio.wait_for(cancelled.wait(), 1)
        assert not RoomsDouble.instances[0].deleted
        release.set()
        if failure == "request":
            with pytest.raises(asyncio.CancelledError):
                await starting
        else:
            with pytest.raises(Problem) as error:
                await asyncio.wait_for(starting, 1)
            if failure == "provider":
                assert error.value.body.message == "Daily returned an invalid token."
        await asyncio.wait_for(manager.call.task, 1)
        assert manager.call.state.cleanup_confirmed
        assert RoomsDouble.instances[0].deleted == [manager.call.room_name]
        assert RoomsDouble.instances[0].closed and PipelineDouble.instances[0].closed
        assert not manager.store.listeners
    finally:
        release.set()
        if ending is not None:
            await ending
        await manager.close()
        await asyncio.gather(starting, return_exceptions=True)


async def test_lifecycle_timings_are_monotonic_and_logs_are_safe(manager, monkeypatch, caplog):
    """Verify lifecycle timings are ordered and logs exclude private call details."""
    caplog.set_level(logging.INFO, logger="uvicorn.error.diagnostics")
    active = asyncio.Event()
    mark = Call.mark

    def measured(self, stage):
        """Record a lifecycle stage and signal readiness when it is reached."""
        mark(self, stage)
        if stage == "ready":
            active.set()

    async def watch(*args):
        """Wait for active call state and request shutdown."""
        await active.wait()
        assert manager.call.state.status == "active"
        manager.stop(manager.call)

    monkeypatch.setattr(Call, "mark", measured)
    monkeypatch.setattr(manager, "watch", watch)
    join = await manager.start("owner", uuid4())
    call = manager.call
    assert "ready" not in call.timings
    manager.store.clock = lambda: join.expires_at - timedelta(seconds=1)
    PipelineDouble.instances[0].ready_event.set()
    await asyncio.wait_for(call.task, 1)
    stages = [
        "setupStarted",
        "voiceCheckStarted",
        "voiceCheckComplete",
        "roomCreateStarted",
        "roomCreateComplete",
        "tokensStarted",
        "tokensComplete",
        "pipelineConstructionStarted",
        "pipelineConstructionComplete",
        "joinSupplied",
        "readinessStarted",
        "ready",
        "shutdownRequested",
        "shutdownStarted",
        "shutdownComplete",
    ]
    values = [call.timings[stage] for stage in stages]
    assert values == sorted(values) and values[0] >= 0
    for operation in ("pipeline", "history", "roomDelete", "roomClose"):
        assert call.timings[f"{operation}Started"] <= call.timings[f"{operation}Complete"]
        assert call.timings[f"{operation}Complete"] <= call.timings["shutdownComplete"]
    assert call.state.cleanup_confirmed
    messages = [record for record in caplog.records if getattr(record, "safe_diagnostic", False)]
    events = [json.loads(record.getMessage()) for record in messages]
    measured = {event["stage"]: event for event in events if event["event"] == "call.stage"}
    assert set(measured) == set(call.timings)
    assert all(
        measured[stage]["elapsed_seconds"] == round(elapsed, 3)
        for stage, elapsed in call.timings.items()
    )
    assert all(record.exc_info is None and record.stack_info is None for record in messages)
    assert all(event["call_id"] == str(call.id) for event in events)
    for private in ("owner", "test-only", "test-token", "https://", call.room_name):
        assert private not in caplog.text
    assert set(join.model_dump(by_alias=True)) == {
        "callId",
        "conversationSlug",
        "url",
        "token",
        "expiresAt",
    }


async def test_shutdown_timings_distinguish_failure_from_confirmed_retry(manager, monkeypatch):
    """Verify shutdown timings distinguish failed cleanup from a confirmed retry."""
    join = await manager.start("owner", uuid4())
    call = manager.call
    close = PipelineDouble.close
    monkeypatch.setattr(PipelineDouble, "close", AsyncMock(side_effect=RuntimeError("private")))
    await manager.end("owner", join.call_id)
    await asyncio.wait_for(call.task, 1)
    assert not call.state.cleanup_confirmed
    assert "shutdownComplete" not in call.timings and "pipelineComplete" not in call.timings
    assert call.timings["pipelineStarted"] <= call.timings["pipelineFailed"]
    assert call.timings["pipelineFailed"] <= call.timings["shutdownUnconfirmed"]
    requested = call.timings["shutdownRequested"]
    monkeypatch.setattr(PipelineDouble, "close", close)
    await manager.end("owner", join.call_id)
    await asyncio.wait_for(call.teardown, 1)
    assert call.state.cleanup_confirmed and call.timings["shutdownRequested"] == requested
    assert call.timings["shutdownUnconfirmed"] <= call.timings["shutdownStarted"]
    assert call.timings["pipelineStarted"] <= call.timings["pipelineComplete"]
    assert call.timings["pipelineComplete"] <= call.timings["shutdownComplete"]


async def test_startup_cause_precedes_cleanup_failure(manager, monkeypatch, caplog):
    """Keep the original failure's sanitized chain when cleanup fails independently."""

    async def check():
        try:
            raise OSError("private provider payload")
        except OSError as error:
            raise Problem(503, "voiceUnavailable", "private startup payload") from error

    monkeypatch.setattr(manager, "prepare_voice", check)
    monkeypatch.setattr(
        PipelineDouble, "close", AsyncMock(side_effect=ValueError("private cleanup payload"))
    )
    with pytest.raises(Problem):
        await manager.start("owner", uuid4())
    events = [
        json.loads(record.getMessage())
        for record in caplog.records
        if getattr(record, "safe_diagnostic", False)
    ]
    failure = next(event for event in events if event["event"] == "call.failed")
    cleanup = next(event for event in events if event["event"] == "call.cleanupFailed")
    assert events.index(failure) < events.index(cleanup)
    assert failure["stage"] == "voiceCheckStarted"
    assert failure["status"] == 503 and failure["code"] == "voiceUnavailable"
    assert [error["type"] for error in failure["errors"]] == ["Problem", "OSError"]
    assert cleanup["source"] == "pipeline" and cleanup["errors"][0]["type"] == "ValueError"
    assert failure["call_id"] == cleanup["call_id"] == str(manager.call.id)
    assert "private" not in caplog.text


async def test_watcher_failure_records_status_and_cause(manager, monkeypatch, caplog):
    """Watcher failures retain code, status and stack topology without provider messages."""

    async def watch(*args):
        try:
            raise OSError("private provider payload")
        except OSError as error:
            raise Problem(503, "authUnavailable", "private watcher payload") from error

    monkeypatch.setattr(manager, "watch", watch)
    await manager.start("owner", uuid4())
    await asyncio.wait_for(manager.call.task, 1)
    events = [
        json.loads(record.getMessage())
        for record in caplog.records
        if getattr(record, "safe_diagnostic", False)
    ]
    failure = next(event for event in events if event["event"] == "call.watchFailed")
    assert failure["call_id"] == str(manager.call.id)
    assert failure["stage"] == "readinessStarted"
    assert failure["errors"][0]["status"] == 503
    assert failure["errors"][0]["code"] == "authUnavailable"
    assert [error["type"] for error in failure["errors"]] == ["Problem", "OSError"]
    assert (
        next(event for event in events if event["event"] == "call.stopped")["reason"]
        == "watcherFailure"
    )
    assert "private" not in caplog.text


@pytest.mark.parametrize("code", ["accountDeleted", "privateSnapshotCode"])
async def test_terminal_snapshot_logs_only_controlled_code(manager, caplog, code):
    """Terminal snapshots cannot turn private codes or messages into log labels."""
    await manager.start("owner", uuid4())
    call = manager.call
    queue = asyncio.Queue()
    queue.put_nowait(Error(code=code, message="private snapshot payload"))
    await manager.watch(call, call.pipeline, queue)
    await asyncio.wait_for(call.task, 1)
    events = [
        json.loads(record.getMessage())
        for record in caplog.records
        if getattr(record, "safe_diagnostic", False)
    ]
    event = next(event for event in events if event["event"] == "call.watchStopped")
    assert event["call_id"] == str(call.id) and event["reason"] == "terminalSnapshot"
    assert event.get("code") == (code if code == "accountDeleted" else None)
    assert "private" not in caplog.text


async def test_late_cleanup_confirmation_retains_resource_trail(manager, monkeypatch, caplog):
    """An unsettled native resource is confirmed only after its owned cleanup completes."""
    release = asyncio.Event()
    monkeypatch.setattr(PipelineDouble, "close", AsyncMock(side_effect=release.wait))
    manager.config = manager.config.model_copy(
        update={"voice": manager.config.voice.model_copy(update={"shutdown_seconds": 0.02})}
    )
    try:
        join = await manager.start("owner", uuid4())
        await manager.end("owner", join.call_id)
        await asyncio.wait_for(manager.call.task, 1)
        assert not manager.call.state.cleanup_confirmed
        task = manager.call.operations["pipeline"]
        assert not task.done()
        release.set()
        await asyncio.wait_for(task, 1)
        manager.reconcile(manager.call)
        events = [
            json.loads(record.getMessage())
            for record in caplog.records
            if getattr(record, "safe_diagnostic", False)
        ]
        pending = next(event for event in events if event["event"] == "call.cleanupUnconfirmed")
        confirmed = next(event for event in events if event["event"] == "call.cleanupConfirmed")
        assert events.index(pending) < events.index(confirmed)
        assert confirmed["reason"] == "lateRelease"
        assert confirmed["call_id"] == pending["call_id"] == str(join.call_id)
        assert manager.call.state.cleanup_confirmed
    finally:
        release.set()


@pytest.mark.parametrize("termination", ["normalEnd", "endRequested", "providerFailure"])
async def test_stop_diagnostics_distinguish_orderly_and_failed_end(
    manager, monkeypatch, caplog, termination
):
    """End signals keep code-owned reasons separate from unexpected provider stops."""
    callbacks = {}
    start = PipelineDouble.start

    async def construct(self, *args):
        callbacks.update(providerFailure=args[-2], normalEnd=args[-1])
        await start(self, *args)

    monkeypatch.setattr(PipelineDouble, "start", construct)
    join = await manager.start("owner", uuid4())
    if termination == "endRequested":
        await manager.end("owner", join.call_id)
    else:
        callbacks[termination]()
    await asyncio.wait_for(manager.call.task, 1)
    events = [
        json.loads(record.getMessage())
        for record in caplog.records
        if getattr(record, "safe_diagnostic", False)
    ]
    event = next(event for event in events if event["event"] == "call.stopped")
    assert event["reason"] == termination
    assert event["category"] == (
        "unexpectedStop" if termination == "providerFailure" else "normalEnd"
    )
    assert event["call_id"] == str(join.call_id)
