# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from azure.cognitiveservices.speech import CancellationErrorCode
from pipecat.frames.frames import LLMRunFrame
from pipecat.transports.daily.transport import DailyInputTransport

from app.history import History
from app.speech import SpeechRecognition, SpeechSynthesis
from app.store import Problem
from app.voice import DailyRooms
from app.voice_pipeline import VoicePipeline

from .test_call_recovery import manager as manager
from .test_voice import PipelineDouble, RoomsDouble, environment
from .test_voice import provider_doubles as provider_doubles
from .test_voice_errors import lifecycle as lifecycle
from .test_voice_errors import text_reply
from .test_voice_turns import voice_boundaries as voice_boundaries


@pytest.mark.parametrize("service", [SpeechRecognition, SpeechSynthesis])
async def test_failed_native_stop_can_confirm_a_subsequent_stop(service):
    """Retry a settled native failure without treating the failed operation as confirmation."""
    provider = Mock()
    if service is SpeechRecognition:
        adapter = service(api_key="test-only", region="centralindia", phrases=[])
        adapter._speech_recognizer = provider
        adapter._audio_stream = Mock()
        stop = provider.stop_continuous_recognition_async
        operation = adapter._disconnect
    else:
        adapter = service(api_key="test-only", region="centralindia")
        adapter._speech_synthesizer = provider
        adapter._retire_synthesis = Mock()
        stop = provider.stop_speaking_async
        operation = adapter._stop_synthesis
    stop.return_value.get.side_effect = [RuntimeError("native stop failed"), None]
    with pytest.raises(RuntimeError, match="native stop failed"):
        await operation()
    failed = adapter._native_stop
    await adapter.cleanup()
    assert adapter._native_stop is not failed
    assert adapter._native_stop.done() and adapter._native_stop.exception() is None
    await adapter.cleanup()
    assert stop.call_count == 2


async def test_failed_recognition_start_does_not_poison_a_confirmed_stop():
    """Settle failed startup before confirming a successful native shutdown."""
    adapter = SpeechRecognition(api_key="test-only", region="centralindia", phrases=[])
    provider, stream = Mock(), Mock()
    adapter._speech_recognizer = provider
    adapter._audio_stream = stream
    adapter._native_start = asyncio.create_task(AsyncMock(side_effect=RuntimeError("start"))())
    await asyncio.gather(adapter._native_start, return_exceptions=True)
    await adapter.cleanup()
    await adapter.cleanup()
    provider.stop_continuous_recognition_async.assert_called_once()
    stream.close.assert_called_once()
    assert adapter._speech_recognizer is None and adapter._audio_stream is None


@pytest.mark.parametrize("stage", ["flush", "runner"])
async def test_historical_pipeline_failure_does_not_poison_resource_cleanup(stage):
    """Require resource release even when a previously completed worker operation failed."""
    pipeline = VoicePipeline()

    async def failed():
        """Simulate a completed runtime failure, not a resource-release failure."""
        raise RuntimeError("runtime failed")

    failure = asyncio.create_task(failed())
    await asyncio.gather(failure, return_exceptions=True)
    processor = SimpleNamespace(cleanup=AsyncMock())
    pipeline.processors = [processor]
    pipeline.llm = SimpleNamespace(_client=SimpleNamespace(close=AsyncMock()))
    pipeline.worker = SimpleNamespace(cancel=AsyncMock())
    if stage == "flush":
        pipeline.flush = failure
        pipeline.task = asyncio.create_task(asyncio.Event().wait())
        pipeline.worker.cancel.side_effect = lambda: pipeline.task.cancel()
    else:
        pipeline.task = failure
    try:
        await pipeline.close()
        await pipeline.close()
        assert pipeline.task.done()
        processor.cleanup.assert_awaited()
        pipeline.llm._client.close.assert_awaited()
    finally:
        if not pipeline.task.done():
            pipeline.task.cancel()
        await asyncio.gather(pipeline.task, return_exceptions=True)


async def test_resource_cleanup_failure_still_prevents_confirmation():
    """Never infer cleanup from a stopped worker when a processor still fails to release."""
    pipeline = VoicePipeline()
    pipeline.processors = [SimpleNamespace(cleanup=AsyncMock(side_effect=RuntimeError("failed")))]
    for _ in range(2):
        with pytest.raises(RuntimeError, match="Voice resource cleanup failed"):
            await pipeline.close()


async def test_native_stop_settling_at_timeout_is_reconciled():
    """Confirm actual native completion even when its acknowledgement meets the deadline."""
    pipeline = VoicePipeline()
    adapter = SpeechSynthesis(api_key="test-only", region="centralindia")
    adapter._native_stop = asyncio.create_task(AsyncMock()())
    await adapter._native_stop
    adapter.cleanup = AsyncMock(side_effect=[TimeoutError(), None])
    pipeline.processors = [adapter]
    await pipeline.close()
    assert adapter.cleanup.await_count == 2


async def test_daily_release_counter_cannot_hide_an_unreleased_native_client():
    """Require actual Daily native release even when the shared cleanup wrapper returns."""
    pipeline = VoicePipeline()
    transport = object.__new__(DailyInputTransport)
    transport._client = SimpleNamespace(_client=Mock())
    transport.cleanup = AsyncMock()
    pipeline.processors = [transport]
    with pytest.raises(RuntimeError, match="Daily client release unconfirmed"):
        await pipeline.close()
    transport._client._client = None
    await pipeline.close()


@pytest.mark.parametrize("confirmed", [True, False])
async def test_ambiguous_daily_delete_checks_the_same_room(tmp_path, monkeypatch, confirmed):
    """Confirm a lost DELETE through an idempotent retry, never through a timeout alone."""
    rooms = DailyRooms(environment(tmp_path), 1)
    response = AsyncMock()
    response.status = 404 if confirmed else 503
    request = AsyncMock()
    request.__aenter__.side_effect = [TimeoutError(), response]
    monkeypatch.setattr(rooms.http, "request", Mock(return_value=request))
    try:
        if confirmed:
            await rooms.delete("owned-room")
        else:
            with pytest.raises(Problem):
                await rooms.delete("owned-room")
        assert rooms.http.request.call_count == 2
        assert all(
            item.args == ("DELETE", "https://api.daily.co/v1/rooms/owned-room")
            for item in rooms.http.request.call_args_list
        )
    finally:
        await rooms.close()


async def test_speech_failure_and_failed_stop_can_end_and_reconnect(lifecycle, voice_boundaries):
    """Release actual Pipecat processors after a terminal synthesis and transient stop failure."""
    import httpx

    manager = lifecycle.manager
    first = await manager.start("owner", uuid4())
    call = manager.call
    pipeline = call.pipeline
    await asyncio.wait_for(pipeline.started.wait(), 2)
    baseline = await manager.store.get("owner")
    history = History(manager.store)
    await history.append(
        "owner", first.call_id, "saved", "user", "Keep my saved plan.", completed=True
    )
    provider = voice_boundaries.synthesizer
    provider.stop_speaking_async.return_value.get.side_effect = [RuntimeError("stop failed"), None]

    def rejected(_):
        """Report a terminal SDK rejection without contacting the provider."""
        provider.synthesis_canceled.connect.call_args.args[0](
            SimpleNamespace(
                result=SimpleNamespace(
                    cancellation_details=SimpleNamespace(
                        error_code=CancellationErrorCode.AuthenticationFailure
                    )
                )
            )
        )

    provider.speak_ssml_async.side_effect = rejected
    await pipeline.llm._client._client.aclose()
    pipeline.llm._client._client = httpx.AsyncClient(
        transport=httpx.MockTransport(voice_boundaries.respond)
    )
    voice_boundaries.responses.put_nowait(text_reply("Let us review your plan."))
    pipeline.client_ready.set()
    pipeline.initiative = "opening"
    await pipeline.worker.queue_frame(LLMRunFrame())
    await asyncio.wait_for(call.task, 3)
    state = manager.state("owner")
    assert state.status == "error" and state.cleanup_confirmed
    assert pipeline.task.done() and pipeline.llm._client.is_closed()
    assert provider.stop_speaking_async.call_count == 2
    assert await manager.store.get("owner") == baseline
    assert (await history.get("owner", first.conversation_slug)).messages[0].text == (
        "Keep my saved plan."
    )
    lifecycle.rooms.delete.assert_awaited_once_with(call.room_name)
    assert (await manager.end("owner", first.call_id)).cleanup_confirmed
    second = await manager.start("owner", uuid4(), first.conversation_slug)
    assert second.call_id != first.call_id and second.conversation_slug == first.conversation_slug


@pytest.mark.parametrize("resource", ["pipeline", "delete"])
async def test_late_cleanup_acknowledgement_reconciles_without_another_end(
    manager, store, monkeypatch, resource
):
    """Keep late media cleanup tracked and admit a new call only after actual release."""
    release, entered = asyncio.Event(), asyncio.Event()
    target, name = (PipelineDouble, "close") if resource == "pipeline" else (RoomsDouble, "delete")
    operation = getattr(target, name)

    async def delayed(self, *args):
        """Hold a resource release past the response deadline without losing its result."""
        entered.set()
        await release.wait()
        await operation(self, *args)

    monkeypatch.setattr(target, name, delayed)
    first = await manager.start("owner", uuid4())
    baseline = await store.get("owner")
    history = History(store)
    await history.append(
        "owner", first.call_id, "saved", "user", "Saved conversation.", completed=True
    )
    call = manager.call
    try:
        state = await manager.end("owner", first.call_id)
        await asyncio.wait_for(entered.wait(), 1)
        await asyncio.wait_for(call.task, 1)
        assert not state.cleanup_confirmed
        with pytest.raises(Problem, match="already running or ending"):
            await manager.start("owner", uuid4())
        if resource == "delete":
            assert not RoomsDouble.instances[0].closed
        release.set()
        await asyncio.wait_for(asyncio.gather(*call.operations.values()), 1)
        assert manager.state("owner").cleanup_confirmed
        assert RoomsDouble.instances[0].deleted == [call.room_name]
        assert RoomsDouble.instances[0].closed and PipelineDouble.instances[0].closed
        assert await store.get("owner") == baseline
        saved = await history.get("owner", first.conversation_slug)
        assert saved.messages[0].text == "Saved conversation."
        second = await manager.start("owner", uuid4(), first.conversation_slug)
        assert second.call_id != first.call_id
        assert second.conversation_slug == first.conversation_slug
        assert (await manager.end("owner", first.call_id)).cleanup_confirmed
        assert not manager.call.stop.is_set()
    finally:
        release.set()
        await manager.end("owner", manager.call.id)
