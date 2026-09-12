# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import httpx
import pytest
from pipecat.frames.frames import (
    ErrorFrame,
    FunctionCallResultFrame,
    InterruptionFrame,
    LLMRunFrame,
    TTSAudioRawFrame,
)
from pipecat.processors.frame_processor import FrameDirection

from app.models import CallState
from app.store import Problem
from app.voice import Call, CallManager
from app.voice_tools import VoiceTools

from .conftest import money
from .test_auth_races import auth_server as auth_server
from .test_voice import environment
from .test_voice_turns import complete_turn, next_frame, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries


def text_reply(text):
    chunk = {
        "id": "completion",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "finance-chat_1.2",
        "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": "stop"}],
    }
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        content=f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n",
    )


@pytest.mark.parametrize("cause", ["interruption", "correction", "revocation"])
async def test_delayed_sdk_audio_cannot_enter_the_next_synthesis(voice, store, monkeypatch, cause):
    requests = asyncio.Queue()

    def synthesizer(**kwargs):
        instance = Mock()
        instance.speak_ssml_async.side_effect = lambda text: requests.put_nowait(instance)
        return instance

    monkeypatch.setattr("app.speech.SpeechSynthesizer", synthesizer, raising=False)
    voice.synthesizer.speak_ssml_async.side_effect = lambda text: requests.put_nowait(
        voice.synthesizer
    )
    voice.responses.put_nowait(tool_reply("read_state", {}, "before-speech"))
    voice.responses.put_nowait(text_reply("Please confirm the opening cash."))
    await complete_turn(voice, "Where should I start?")
    first = await asyncio.wait_for(requests.get(), 2)
    callback = first.synthesizing.connect.call_args.args[0]
    await asyncio.to_thread(
        callback, SimpleNamespace(result=SimpleNamespace(audio_data=b"\x01\x00" * 480))
    )
    assert (await next_frame(voice.frames, TTSAudioRawFrame)).audio == b"\x01\x00" * 480
    if cause == "correction":
        tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
        await tools.update_facts({"expectedRevision": 0, "opening": money("200")}, "correct")
        voice.pipeline.refresh(await store.get("owner"))
        await asyncio.to_thread(
            callback, SimpleNamespace(result=SimpleNamespace(audio_data=b"\x02\x00" * 480))
        )
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(next_frame(voice.frames, TTSAudioRawFrame), 0.05)
        await voice.pipeline.interrupt()
    elif cause == "revocation":
        voice.pipeline.invalidate()
        await asyncio.to_thread(
            callback, SimpleNamespace(result=SimpleNamespace(audio_data=b"\x02\x00" * 480))
        )
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(next_frame(voice.frames, TTSAudioRawFrame), 0.05)
        return
    else:
        await voice.pipeline.worker.queue_frame(InterruptionFrame())
    await next_frame(voice.frames, InterruptionFrame)
    voice.responses.put_nowait(tool_reply("read_state", {}, "after-interruption"))
    voice.responses.put_nowait(text_reply("Please confirm the corrected opening cash."))
    await complete_turn(voice, "Use my corrected cash.")
    second = await asyncio.wait_for(requests.get(), 2)
    await asyncio.to_thread(
        callback, SimpleNamespace(result=SimpleNamespace(audio_data=b"\x02\x00" * 480))
    )
    callback = second.synthesizing.connect.call_args.args[0]
    await asyncio.to_thread(
        callback, SimpleNamespace(result=SimpleNamespace(audio_data=b"\x03\x00" * 480))
    )
    assert (await next_frame(voice.frames, TTSAudioRawFrame)).audio == b"\x03\x00" * 480


@pytest.mark.parametrize("trigger", ["timer", "coalescedEvents"])
async def test_timer_uses_latest_snapshot_and_does_not_regress(voice, store, tmp_path, trigger):
    pipeline = voice.pipeline
    manager = CallManager(
        store,
        store.config.model_copy(update={"heartbeat_seconds": 0.01}),
        environment(tmp_path),
    )
    call_id = uuid4()
    call = Call(
        "owner",
        call_id,
        CallState(call_id=call_id, status="active"),
        asyncio.get_running_loop().create_future(),
    )
    queue = await store.subscribe("owner") if trigger == "coalescedEvents" else asyncio.Queue()
    baseline = await store.get("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    await tools.update_facts({"expectedRevision": 0, "opening": money("100")}, "one")
    await tools.update_facts({"expectedRevision": 1, "opening": money("200")}, "two")
    now = store.clock()
    store.clock = lambda: now + timedelta(hours=13)
    watcher = asyncio.create_task(manager.watch(call, pipeline, queue))
    try:
        await next_frame(voice.frames, InterruptionFrame)
        current = await store.get("owner")
        assert current.sequence == 3 and current.revision == 2
        assert pipeline.sequence == current.sequence
        pipeline.refresh(baseline)
        assert pipeline.sequence == current.sequence
        assert json.loads(pipeline.context.get_messages()[0]["content"].split("\n", 1)[1])[
            "snapshot"
        ] == current.model_dump(mode="json", by_alias=True)
    finally:
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)
        store.unsubscribe("owner", queue)


@pytest.mark.parametrize("reply", ["text", "tool"])
async def test_cancelled_completion_cannot_speak_or_save_after_external_correction(
    voice, store, reply
):
    reached = asyncio.Event()
    delivered = asyncio.Event()

    class DelayedStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            reached.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                response = (
                    text_reply("Obsolete financial advice must not be spoken.")
                    if reply == "text"
                    else tool_reply(
                        "update_facts",
                        {"expectedRevision": 1, "opening": money("999")},
                        "obsolete-save",
                    )
                )
                delivered.set()
                yield response.content

    voice.responses.put_nowait(
        httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=DelayedStream(),
        )
    )
    await complete_turn(voice, "I have one hundred rupees.")
    await asyncio.wait_for(reached.wait(), 2)
    await voice.requests.get()
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    await tools.update_facts({"expectedRevision": 0, "opening": money("200")}, "correction")
    snapshot = await store.get("owner")
    voice.pipeline.refresh(snapshot)
    voice.pipeline.client_ready.set()
    await voice.pipeline.interrupt()
    await asyncio.wait_for(delivered.wait(), 2)
    request = await asyncio.wait_for(voice.requests.get(), 2)
    state = next(
        message["content"]
        for message in request["messages"]
        if message.get("content", "").startswith("Canonical application state;")
    )
    assert json.loads(state.split("\n", 1)[1])["snapshot"] == snapshot.model_dump(
        mode="json", by_alias=True
    )
    result = await next_frame(voice.frames, FunctionCallResultFrame)
    assert result.function_name == "read_state" and result.tool_call_id != "obsolete-save"
    assert result.result["snapshot"] == snapshot.model_dump(mode="json", by_alias=True)
    assert await store.get("owner") == snapshot
    voice.synthesizer.speak_ssml_async.assert_not_called()


@pytest.mark.parametrize("committed", [False, True])
async def test_revocation_during_real_save_never_delivers_a_result(
    voice, store, monkeypatch, committed
):
    transaction = store.transaction
    reached = asyncio.Event()
    release = asyncio.Event()
    settled = asyncio.Event()

    @asynccontextmanager
    async def paused_transaction():
        async with transaction():
            yield
            if not committed:
                reached.set()
                await release.wait()
        if committed:
            reached.set()
            await release.wait()
        settled.set()

    monkeypatch.setattr(store, "transaction", paused_transaction)
    voice.responses.put_nowait(
        tool_reply("update_facts", {"expectedRevision": 0, "opening": money("100")}, "save")
    )
    await complete_turn(voice, "I have one hundred rupees.")
    await asyncio.wait_for(reached.wait(), 2)
    voice.pipeline.invalidate()
    release.set()
    await asyncio.wait_for(settled.wait(), 2)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(next_frame(voice.frames, FunctionCallResultFrame), 0.05)
    assert not voice.pipeline.context.get_messages()
    assert (await store.get("owner")).facts.opening.amount_paise == 10000
    voice.synthesizer.speak_ssml_async.assert_not_called()


async def test_pipeline_error_is_sanitized_and_revokes_output(voice):
    voice.expect_failure = True
    errors = asyncio.Queue()

    async def error_received(worker, frame):
        errors.put_nowait(frame)

    voice.pipeline.worker.add_event_handler("on_pipeline_error", error_received)
    error = ErrorFrame(
        error="private-financial-value token=secret",
        exception=RuntimeError("private-provider-body"),
    )
    await voice.stt.push_frame(error, FrameDirection.UPSTREAM)
    frame = await asyncio.wait_for(errors.get(), 2)
    assert frame.error == "Voice provider unavailable; use manual entry."
    assert frame.exception is None
    assert voice.pipeline.revoked and not voice.pipeline.context.get_messages()
    voice.failed.assert_called()
    await voice.pipeline.worker.queue_frame(LLMRunFrame())
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.05)


@pytest.fixture
async def lifecycle(store, tmp_path, monkeypatch, voice_boundaries):
    await store.create("owner")
    rooms = SimpleNamespace(
        create=AsyncMock(return_value="https://test.daily.co/owned-room"),
        token=AsyncMock(return_value="test-token"),
        delete=AsyncMock(),
        close=AsyncMock(),
    )
    monkeypatch.setattr("app.voice.check_voice", AsyncMock())
    monkeypatch.setattr("app.voice.DailyRooms", Mock(return_value=rooms))
    manager = CallManager(
        store,
        store.config.model_copy(update={"heartbeat_seconds": 0.01}),
        environment(tmp_path),
    )
    try:
        yield SimpleNamespace(manager=manager, rooms=rooms, transport=voice_boundaries.transport)
    finally:
        await manager.close()


@pytest.mark.parametrize(
    "terminal", ["end", "leave", "provider", "store", "cancelledRunner", "readiness"]
)
async def test_real_runner_terminal_paths_release_the_owned_room(lifecycle, store, terminal):
    manager = lifecycle.manager
    if terminal == "readiness":
        manager.config = manager.config.model_copy(
            update={"voice": manager.config.voice.model_copy(update={"startup_seconds": 0.2})}
        )
    await manager.start("owner", uuid4())
    call = manager.call
    pipeline = call.pipeline
    await asyncio.wait_for(pipeline.started.wait(), 2)
    if terminal == "end":
        await manager.end("owner", call.id)
    elif terminal == "leave":
        handler = next(
            call.args[1]
            for call in lifecycle.transport.add_event_handler.call_args_list
            if call.args[0] == "on_participant_left"
        )
        await handler(lifecycle.transport, {}, "left")
    elif terminal == "provider":
        await pipeline.llm.push_error(error_msg="private-provider-details")
    elif terminal == "store":
        await store.connection().close()
    elif terminal == "cancelledRunner":
        pipeline.task.cancel()
    await asyncio.wait_for(call.task, 2)
    assert manager.state("owner").status == (
        "error" if terminal in {"provider", "store", "readiness", "cancelledRunner"} else "ended"
    )
    assert "private" not in manager.state("owner").model_dump_json()
    lifecycle.rooms.delete.assert_awaited_once_with(call.room_name)
    lifecycle.rooms.close.assert_awaited_once()
    assert pipeline.revoked and pipeline.task.done() and pipeline.llm._client.is_closed()
    assert not store.listeners


async def test_end_during_provider_startup_never_returns_a_join(lifecycle, monkeypatch):
    reached = asyncio.Event()
    closing = asyncio.Event()
    release = asyncio.Event()

    async def token(*args):
        reached.set()
        await asyncio.Event().wait()

    async def delete(*args):
        closing.set()
        await release.wait()

    lifecycle.rooms.token.side_effect = token
    lifecycle.rooms.delete.side_effect = delete
    manager = lifecycle.manager
    call_id = uuid4()
    start = asyncio.create_task(manager.start("owner", call_id))
    await asyncio.wait_for(reached.wait(), 2)
    end = asyncio.create_task(manager.end("owner", call_id))
    await asyncio.wait_for(closing.wait(), 2)
    repeated = asyncio.create_task(manager.end("owner", call_id))
    release.set()
    await asyncio.wait_for(asyncio.gather(end, repeated), 2)
    with pytest.raises(Problem, match="Voice setup failed"):
        await start
    lifecycle.rooms.delete.assert_awaited_once()
    lifecycle.rooms.close.assert_awaited_once()
    assert manager.state("owner").status == "ended"
    assert manager.call.pipeline is None


@pytest.mark.parametrize("cleanup", ["delete", "close"])
async def test_room_cleanup_deadline_preserves_primary_setup_failure(lifecycle, cleanup):
    manager = lifecycle.manager
    manager.config = manager.config.model_copy(
        update={"voice": manager.config.voice.model_copy(update={"shutdown_seconds": 0.05})}
    )
    lifecycle.rooms.token.side_effect = Problem(503, "voiceUnavailable", "Primary setup failure")

    async def blocked(*args):
        await asyncio.Event().wait()

    getattr(lifecycle.rooms, cleanup).side_effect = blocked
    with pytest.raises(Problem, match="Primary setup failure"):
        await asyncio.wait_for(manager.start("owner", uuid4()), 1)
    assert manager.call.state.message == "Primary setup failure"
    assert manager.state("owner").message == (
        "Conversations are temporarily unavailable. Please try again shortly."
    )
    lifecycle.rooms.delete.assert_awaited_once()
    lifecycle.rooms.close.assert_awaited_once()
    assert manager.call.task.done()


@pytest.mark.parametrize("terminal", ["logout", "expiry"])
async def test_real_authorization_loss_stops_the_runner(
    auth_server, voice_boundaries, monkeypatch, terminal
):
    application, client, now = auth_server
    manager = application.state.calls
    manager.config = manager.config.model_copy(update={"heartbeat_seconds": 0.01})
    rooms = SimpleNamespace(
        create=AsyncMock(return_value="https://test.daily.co/owned-room"),
        token=AsyncMock(return_value="test-token"),
        delete=AsyncMock(),
        close=AsyncMock(),
    )
    monkeypatch.setattr("app.voice.check_voice", AsyncMock())
    monkeypatch.setattr("app.voice.DailyRooms", Mock(return_value=rooms))
    assert (await client.post("/api/session", json={})).status_code == 200
    response = await client.post("/api/session/call", json={"callId": str(uuid4())})
    assert response.status_code == 200
    call = manager.call
    pipeline = call.pipeline
    await asyncio.wait_for(pipeline.started.wait(), 2)
    if terminal == "logout":
        assert (await client.post("/api/auth/logout", json={})).status_code == 204
    else:
        now[0] += timedelta(hours=24)
    await asyncio.wait_for(call.task, 2)
    assert manager.call is None and pipeline.revoked
    assert not pipeline.context.get_messages()
    assert pipeline.task.done() and pipeline.llm._client.is_closed()
    rooms.delete.assert_awaited_once_with(call.room_name)
    rooms.close.assert_awaited_once()
    assert (await client.get("/api/session/call")).status_code == 401
    assert not application.state.store.listeners
