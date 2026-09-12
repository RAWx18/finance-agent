# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from datetime import timedelta
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest

from app.auth_models import Access
from app.history import History
from app.store import Problem
from app.voice import CallManager, DailyRooms

from .conftest import facts, parsed_command
from .test_voice import PipelineDouble, RoomsDouble, environment
from .test_voice import provider_doubles as provider_doubles


def assert_call_memory(snapshot, baseline):
    assert snapshot.conversation_slug is not None
    assert snapshot.session_id != baseline.session_id
    assert snapshot.revision > baseline.revision and snapshot.sequence > baseline.sequence
    exclude = {"session_id", "conversation_slug", "revision", "sequence", "latest_change"}
    current = snapshot.model_dump(exclude=exclude)
    initial = baseline.model_dump(exclude=exclude)
    current["workspace"].pop("change")
    initial["workspace"].pop("change")
    assert current == initial


@pytest.fixture
async def manager(store, config, tmp_path, provider_doubles):
    await store.create("owner")
    await store.create("other")
    await store.command("owner", parsed_command(facts("1234.56")))
    config = config.model_copy(
        update={
            "voice": config.voice.model_copy(
                update={"startup_seconds": 0.3, "shutdown_seconds": 0.08}
            )
        }
    )
    manager = CallManager(store, config, environment(tmp_path))
    try:
        yield manager
    finally:
        await manager.close()


async def test_delayed_end_cannot_stop_replacement_or_replay_terminal_identity(manager, store):
    baseline = await store.get("owner")
    first = await manager.start("owner", uuid4())
    assert (await manager.end("owner", first.call_id)).cleanup_confirmed
    second = await manager.start("owner", uuid4())
    call = manager.call
    result = await manager.end("owner", first.call_id)
    assert result.call_id == first.call_id and result.cleanup_confirmed
    assert manager.state("owner").call_id == second.call_id
    assert not call.stop.is_set() and not PipelineDouble.instances[-1].closed
    with pytest.raises(Problem) as error:
        await manager.start("owner", first.call_id)
    assert error.value.body.code == "callEnded"
    assert len(RoomsDouble.instances) == 2
    assert (await manager.end("owner", second.call_id)).cleanup_confirmed
    assert_call_memory(await store.get("owner"), baseline)


async def test_cancel_before_start_is_idempotent_and_owner_scoped(manager):
    call_id = uuid4()
    ended = await manager.end("owner", call_id)
    assert await manager.end("owner", call_id) == ended
    with pytest.raises(Problem) as error:
        await manager.start("owner", call_id)
    assert error.value.body.code == "callEnded"
    assert not RoomsDouble.instances
    join = await manager.start("other", call_id)
    assert join.call_id == call_id
    await manager.end("owner", call_id)
    assert not manager.call.stop.is_set()


async def test_end_during_start_validation_prevents_room_admission(manager, store, monkeypatch):
    reached, release = asyncio.Event(), asyncio.Event()
    get = store.get

    async def paused(owner):
        snapshot = await get(owner)
        reached.set()
        await release.wait()
        return snapshot

    monkeypatch.setattr(store, "get", paused)
    call_id = uuid4()
    starting = asyncio.create_task(manager.start("owner", call_id))
    await asyncio.wait_for(reached.wait(), 1)
    assert (await manager.end("owner", call_id)).cleanup_confirmed
    release.set()
    with pytest.raises(Problem) as error:
        await asyncio.wait_for(starting, 1)
    assert error.value.body.code == "callEnded" and not RoomsDouble.instances


@pytest.mark.parametrize("stage", ["create", "token", "join"])
@pytest.mark.parametrize("cancel", ["end", "request"])
async def test_cancelled_setup_deletes_the_predetermined_room(
    manager, store, monkeypatch, stage, cancel
):
    baseline = await store.get("owner")
    reached = asyncio.Event()
    target, name = (PipelineDouble, "start") if stage == "join" else (RoomsDouble, stage)

    async def paused(self, *args):
        reached.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(target, name, paused)
    call_id = uuid4()
    starting = asyncio.create_task(manager.start("owner", call_id))
    await asyncio.wait_for(reached.wait(), 1)
    call = manager.call
    if cancel == "end":
        await asyncio.wait_for(manager.end("owner", call_id), 1)
        with pytest.raises(Problem):
            await asyncio.wait_for(starting, 1)
    else:
        starting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await starting
    await asyncio.wait_for(call.task, 1)
    assert RoomsDouble.instances[0].deleted == [call.room_name]
    assert RoomsDouble.instances[0].closed and PipelineDouble.instances[0].closed
    assert call.state.cleanup_confirmed and not store.listeners
    assert_call_memory(await store.get("owner"), baseline)
    with pytest.raises(Problem) as error:
        await manager.start("owner", call_id)
    assert error.value.body.code == "callEnded"


async def test_ambiguous_create_timeout_still_deletes_name(manager, monkeypatch):
    async def timed_out(self, name, expires):
        raise TimeoutError

    monkeypatch.setattr(RoomsDouble, "create", timed_out)
    with pytest.raises(Problem):
        await asyncio.wait_for(manager.start("owner", uuid4()), 1)
    assert RoomsDouble.instances[0].deleted == [manager.call.room_name]
    assert manager.call.state.cleanup_confirmed


async def test_duplicate_start_waits_for_one_join_and_reuses_active_credentials(
    manager, monkeypatch
):
    reached, release = asyncio.Event(), asyncio.Event()
    create = RoomsDouble.create

    async def paused(self, *args):
        reached.set()
        await release.wait()
        return await create(self, *args)

    monkeypatch.setattr(RoomsDouble, "create", paused)
    call_id = uuid4()
    first = asyncio.create_task(manager.start("owner", call_id))
    await asyncio.wait_for(reached.wait(), 1)
    second = asyncio.create_task(manager.start("owner", call_id))
    release.set()
    joins = await asyncio.wait_for(asyncio.gather(first, second), 1)
    assert joins[0] == joins[1] == await manager.start("owner", call_id)
    assert len(RoomsDouble.instances) == len(PipelineDouble.instances) == 1
    assert len(RoomsDouble.instances[0].tokens) == 2
    await manager.end("owner", call_id)
    await manager.end("owner", call_id)
    assert RoomsDouble.instances[0].deleted == [manager.call.room_name]
    with pytest.raises(Problem):
        await manager.start("owner", call_id)


async def test_history_hang_cannot_skip_media_cleanup(manager, store, monkeypatch):
    baseline = await store.get("owner")

    async def blocked(*args):
        await asyncio.Event().wait()

    finish = AsyncMock(side_effect=blocked)
    monkeypatch.setattr(History, "finish", finish)
    join = await manager.start("owner", uuid4())
    await asyncio.wait_for(manager.end("owner", join.call_id), 1)
    await asyncio.wait_for(manager.call.task, 1)
    assert manager.call.state.cleanup_confirmed and manager.call.state.status == "ended"
    assert RoomsDouble.instances[0].deleted == [manager.call.room_name]
    assert RoomsDouble.instances[0].closed and PipelineDouble.instances[0].closed
    assert_call_memory(await store.get("owner"), baseline)
    finish.assert_awaited_once()


@pytest.mark.parametrize("resource", ["pipeline", "delete", "close"])
@pytest.mark.parametrize("failure", ["error", "timeout", "systemExit"])
async def test_unconfirmed_cleanup_blocks_replacement_until_explicit_retry(
    manager, store, monkeypatch, resource, failure
):
    baseline = await store.get("owner")
    join = await manager.start("owner", uuid4())
    call = manager.call
    target, name = (PipelineDouble, "close") if resource == "pipeline" else (RoomsDouble, resource)
    operation = getattr(target, name)

    async def failed(*args):
        if failure == "timeout":
            await asyncio.Event().wait()
        if failure == "systemExit":
            raise SystemExit("private cleanup failure")
        raise RuntimeError("private cleanup failure")

    monkeypatch.setattr(target, name, failed)
    await asyncio.wait_for(manager.end("owner", join.call_id), 1)
    await asyncio.wait_for(call.task, 1)
    assert not call.state.cleanup_confirmed
    assert call.state.status == "error"
    assert "private" not in manager.state("owner").model_dump_json()
    with pytest.raises(Problem) as error:
        await manager.start("owner", uuid4())
    assert error.value.body.code == "callBusy"
    with pytest.raises(Problem) as error:
        await manager.start("owner", join.call_id)
    assert error.value.body.code == "callEnded"
    monkeypatch.setattr(target, name, operation)
    await asyncio.wait_for(manager.end("owner", join.call_id), 1)
    await asyncio.wait_for(call.teardown, 1)
    assert call.state.cleanup_confirmed
    assert len(PipelineDouble.instances) == 1
    assert sum(len(room.tokens) for room in RoomsDouble.instances) == 2
    assert_call_memory(await store.get("owner"), baseline)
    replacement = await manager.start("owner", uuid4())
    assert replacement.call_id != join.call_id


async def test_noncooperative_close_is_not_duplicated_or_misreported(manager, monkeypatch):
    release = asyncio.Event()
    entered = 0

    async def blocked(self):
        nonlocal entered
        entered += 1
        while not release.is_set():
            try:
                await release.wait()
            except asyncio.CancelledError:
                pass
        self.closed = True

    monkeypatch.setattr(PipelineDouble, "close", blocked)
    join = await manager.start("owner", uuid4())
    call = manager.call
    try:
        await asyncio.wait_for(manager.end("owner", join.call_id), 1)
        await asyncio.wait_for(call.task, 1)
        assert not call.state.cleanup_confirmed
        assert RoomsDouble.instances[0].deleted == [call.room_name]
        assert all(
            item.ended_at is not None
            for item in (await History(manager.store).list("owner")).conversations
        )
        await asyncio.wait_for(manager.end("owner", join.call_id), 1)
        await asyncio.wait_for(call.teardown, 1)
        assert not call.state.cleanup_confirmed and entered == 1
        with pytest.raises(Problem):
            await manager.start("owner", uuid4())
    finally:
        release.set()
        await asyncio.wait_for(call.operations["pipeline"], 1)
    assert (await manager.end("owner", join.call_id)).cleanup_confirmed
    assert entered == 1


async def test_repeated_setup_task_cancellation_cannot_cancel_teardown(manager, monkeypatch):
    reached, release = asyncio.Event(), asyncio.Event()
    delete = RoomsDouble.delete

    async def paused(self, name):
        reached.set()
        await release.wait()
        await delete(self, name)

    monkeypatch.setattr(RoomsDouble, "delete", paused)
    join = await manager.start("owner", uuid4())
    call = manager.call
    ending = asyncio.create_task(manager.end("owner", join.call_id))
    await asyncio.wait_for(reached.wait(), 1)
    call.task.cancel()
    release.set()
    await asyncio.wait_for(ending, 1)
    await asyncio.wait_for(call.teardown, 1)
    assert call.state.cleanup_confirmed and RoomsDouble.instances[0].closed


async def test_setup_system_exit_is_contained_and_primary_reason_survives_cleanup(
    manager, monkeypatch
):
    monkeypatch.setattr(PipelineDouble, "start", AsyncMock(side_effect=SystemExit("private")))
    monkeypatch.setattr(RoomsDouble, "delete", AsyncMock(side_effect=RuntimeError("private")))
    with pytest.raises(Problem) as error:
        await asyncio.wait_for(manager.start("owner", uuid4()), 1)
    assert error.value.body.code == "voiceUnavailable" and "private" not in str(error.value)
    assert not manager.call.state.cleanup_confirmed
    assert RoomsDouble.instances[0].closed


async def test_primary_provider_problem_survives_teardown_failure(manager, monkeypatch):
    monkeypatch.setattr(
        RoomsDouble,
        "token",
        AsyncMock(side_effect=Problem(503, "voiceUnavailable", "Daily returned an invalid token.")),
    )
    monkeypatch.setattr(RoomsDouble, "delete", AsyncMock(side_effect=RuntimeError("private")))
    with pytest.raises(Problem, match="Daily returned an invalid token"):
        await asyncio.wait_for(manager.start("owner", uuid4()), 1)
    assert manager.call.state.message == "Daily returned an invalid token."
    assert not manager.call.state.cleanup_confirmed and RoomsDouble.instances[0].closed


async def test_call_expiry_preserves_figures_and_never_refreshes_tokens(manager, store):
    baseline = await store.get("owner")
    manager.config = manager.config.model_copy(
        update={"voice": manager.config.voice.model_copy(update={"call_seconds": 0.03})}
    )
    join = await manager.start("owner", uuid4())
    PipelineDouble.instances[0].ready_event.set()
    await asyncio.wait_for(manager.call.task, 1)
    state = manager.state("owner")
    assert state.status == "ended" and state.cleanup_confirmed
    assert "expired" in state.message
    assert len(RoomsDouble.instances) == 1 and len(RoomsDouble.instances[0].tokens) == 2
    assert_call_memory(await store.get("owner"), baseline)
    with pytest.raises(Problem):
        await manager.start("owner", join.call_id)


async def test_retry_cannot_return_expired_credentials_before_timer_runs(manager, store):
    join = await manager.start("owner", uuid4())
    store.clock = lambda: join.expires_at + timedelta(seconds=1)
    with pytest.raises(Problem) as error:
        await manager.start("owner", join.call_id)
    assert error.value.body.code == "callEnded"
    await asyncio.wait_for(manager.call.task, 1)
    assert manager.call.state.cleanup_confirmed
    assert len(RoomsDouble.instances) == 1 and len(RoomsDouble.instances[0].tokens) == 2


async def test_attempt_capacity_never_evicts_live_cancellation(manager):
    manager.config = manager.config.model_copy(update={"max_commands": 1})
    call_id = uuid4()
    await manager.end("owner", call_id)
    with pytest.raises(Problem) as error:
        await manager.end("owner", uuid4())
    assert error.value.body.code == "callLimit"
    with pytest.raises(Problem) as error:
        await manager.start("owner", call_id)
    assert error.value.body.code == "callEnded" and not RoomsDouble.instances
    other = await manager.start("other", uuid4())
    assert other.call_id != call_id
    assert ("owner", call_id) in manager.attempts


async def test_attempt_budget_is_user_scoped_and_reclaimed_on_login_revocation(manager):
    manager.config = manager.config.model_copy(update={"max_commands": 1})
    first, second = Access("user", "first-login"), Access("user", "second-login")
    other = Access("other", "other-login")
    first_id, other_id = uuid4(), uuid4()
    await manager.end(first, first_id)
    with pytest.raises(Problem, match="Call identity capacity"):
        await manager.end(second, uuid4())
    await manager.end(other, other_id)
    manager.invalidate(first.user_id, first.session_hash)
    assert (first, first_id) not in manager.attempts
    assert (other, other_id) in manager.attempts
    second_id = uuid4()
    await manager.end(second, second_id)
    manager.invalidate(second.user_id)
    assert (second, second_id) not in manager.attempts
    assert (other, other_id) in manager.attempts


@pytest.mark.parametrize("body", [None, [], "private token", {}, {"url": 12}])
async def test_daily_malformed_room_is_a_sanitized_problem(tmp_path, monkeypatch, caplog, body):
    rooms = DailyRooms(environment(tmp_path), 1)
    monkeypatch.setattr(rooms, "request", AsyncMock(return_value=body))
    try:
        with pytest.raises(Problem, match="Daily returned an invalid room"):
            await rooms.create("room", 123)
        assert "private token" not in caplog.text
    finally:
        await rooms.close()


@pytest.mark.parametrize(
    "url",
    [
        "https://test.daily.co/wrong",
        "https://evil.example/room",
        "https://test.daily.co.evil.example/room",
        "https://.daily.co/room",
        "https://test.daily.co:bad/room",
        "https://user:secret@test.daily.co/room",
        "https://test.daily.co/room?token=secret",
        "https://test.daily.co/room#secret",
        "https://test.daily.co/\nroom",
        "https://[invalid/room",
    ],
)
async def test_daily_room_url_matches_private_tenant_and_name(tmp_path, monkeypatch, url):
    rooms = DailyRooms(environment(tmp_path), 1)
    monkeypatch.setattr(
        rooms,
        "request",
        AsyncMock(return_value={"name": "room", "privacy": "private", "url": url}),
    )
    try:
        with pytest.raises(Problem, match="Daily returned an invalid room"):
            await rooms.create("room", 123)
    finally:
        await rooms.close()


@pytest.mark.parametrize("privacy", [None, "public"])
async def test_daily_room_must_confirm_private_access(tmp_path, monkeypatch, privacy):
    rooms = DailyRooms(environment(tmp_path), 1)
    monkeypatch.setattr(
        rooms,
        "request",
        AsyncMock(
            return_value={"name": "room", "privacy": privacy, "url": "https://test.daily.co/room"}
        ),
    )
    try:
        with pytest.raises(Problem):
            await rooms.create("room", 123)
    finally:
        await rooms.close()


@pytest.mark.parametrize("body", [None, [], "private token", {}, {"token": ""}, {"token": "  "}])
async def test_daily_malformed_token_is_a_sanitized_problem(tmp_path, monkeypatch, caplog, body):
    rooms = DailyRooms(environment(tmp_path), 1)
    monkeypatch.setattr(rooms, "request", AsyncMock(return_value=body))
    try:
        with pytest.raises(Problem, match="Daily returned an invalid token"):
            await rooms.token("room", 123, uuid4())
        assert "private token" not in caplog.text
    finally:
        await rooms.close()


async def test_daily_invalid_json_logs_status_and_type_not_response(tmp_path, monkeypatch, caplog):
    rooms = DailyRooms(environment(tmp_path), 1)
    response = AsyncMock()
    response.status = 200
    response.json.side_effect = ValueError("private token")
    request = AsyncMock()
    request.__aenter__.return_value = response
    monkeypatch.setattr(rooms.http, "request", Mock(return_value=request))
    try:
        with pytest.raises(Problem, match="Daily room service is unavailable"):
            await rooms.create("room", 123)
        assert "HTTP 200 (ValueError)" in caplog.text and "private token" not in caplog.text
    finally:
        await rooms.close()
