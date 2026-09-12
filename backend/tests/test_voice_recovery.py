# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from datetime import timedelta
from threading import Event
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from azure.cognitiveservices.speech import CancellationErrorCode
from pipecat.frames.frames import (
    InputAudioRawFrame,
    LLMRunFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSTextFrame,
)

from .conftest import money
from .test_voice_errors import text_reply
from .test_voice_opening import render
from .test_voice_opening import synthesis as synthesis
from .test_voice_turns import complete_turn, next_frame, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries
from .test_voice_waiting import continue_conversation, next_state

pytestmark = pytest.mark.parametrize(
    "voice",
    [
        {
            "speech_timeout_seconds": 0.3,
            "model_timeout_seconds": 0.3,
            "tts_first_audio_seconds": 0.15,
            "tts_progress_seconds": 0.15,
        }
    ],
    indirect=True,
)


@pytest.mark.parametrize("committed", [False, True])
@pytest.mark.parametrize("cause", ["timeout", "connection", "throttle", "service"])
async def test_response_failure_continues_once_without_replaying_writes(
    voice, synthesis, store, committed, cause
):
    """Verify transient response failures resume once without replaying committed writes."""
    pipeline = voice.pipeline
    pipeline.client_ready.set()
    identity = pipeline.context, pipeline.worker, pipeline.task
    closed = asyncio.Event()
    requests = []

    class Stream(httpx.AsyncByteStream):
        """Synthetic response stream that stalls after an unfinished answer."""

        async def __aiter__(self):
            """Yield partial answer text and then wait indefinitely."""
            yield text_reply("Unfinished private answer.").content.replace(b"data: [DONE]\n\n", b"")
            await asyncio.Event().wait()

        async def aclose(self):
            """Signal closure of the stalled synthetic response stream."""
            closed.set()

    async def model(request):
        """Script an optional write, a transient response failure, and a tool-free recovery."""
        body = json.loads(request.content)
        requests.append(body)
        if committed and len(requests) == 1:
            return tool_reply(
                "update_facts", {"expectedRevision": 0, "opening": money("200")}, "saved-once"
            )
        if len(requests) == int(committed) + 1:
            if cause == "timeout":
                return httpx.Response(
                    200, headers={"content-type": "text/event-stream"}, stream=Stream()
                )
            if cause == "connection":
                raise httpx.ConnectError("secret-provider-body", request=request)
            return httpx.Response(
                503 if cause == "service" else 429,
                json={"error": {"message": "secret-provider-body"}},
            )
        assert body["tool_choice"] == "none"
        assert len(requests) == int(committed) + 2
        assert "last completed user turn" in body["messages"][-1]["content"]
        assert not any(message.get("role") == "tool" for message in body["messages"])
        return text_reply("What payment would you like to review next?")

    await pipeline.llm._client._client.aclose()
    pipeline.llm._client._client = httpx.AsyncClient(transport=httpx.MockTransport(model))
    await complete_turn(voice, "I have two hundred rupees.")
    state = await next_state(voice)
    assert state["state"] == "waiting" and state["reason"] == "response"
    if cause == "timeout":
        assert closed.is_set()
    baseline = await store.get("owner")
    assert baseline.revision == int(committed)
    assert not pipeline.revoked and not pipeline.task.done()
    assert identity == (pipeline.context, pipeline.worker, pipeline.task)
    assert pipeline.metrics.get("published_audio", 0) == 0
    assert "Unfinished" not in json.dumps(pipeline.context.get_messages())
    assert any(
        message.get("content") == "I have two hundred rupees."
        for message in pipeline.context.get_messages()
    )
    await pipeline.worker.queue_frame(LLMRunFrame())
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(synthesis.requests.get(), 0.05)
    assert len(requests) == int(committed) + 1
    await continue_conversation(voice, state["sequence"])
    assert (await next_state(voice))["state"] == "active"
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "What payment would you like to review next?")
    await next_frame(voice.frames, TTSAudioRawFrame)
    await next_frame(voice.frames, TTSTextFrame)
    await continue_conversation(voice, state["sequence"])
    assert (await next_state(voice))["state"] == "active"
    assert len(requests) == int(committed) + 2
    assert await store.get("owner") == baseline


@pytest.mark.parametrize("cause", ["first", "progress", "empty", "canceled"])
async def test_synthesis_failure_retires_callbacks_and_preserves_committed_facts(
    voice, synthesis, store, cause
):
    """Verify synthesis failures retire callbacks while retaining facts for safe continuation."""
    voice.pipeline.client_ready.set()
    voice.responses.put_nowait(
        tool_reply("update_facts", {"expectedRevision": 0, "opening": money("200")}, "saved")
    )
    voice.responses.put_nowait(text_reply("Your cash is recorded. What is due next?"))
    observed = []
    output = next(
        item for item in voice.pipeline.processors if type(item).__name__ == "OutputGuard"
    )
    output.add_event_handler("on_after_process_frame", lambda _, frame: observed.append(frame))
    await complete_turn(voice, "I have two hundred rupees.")
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    if cause == "progress":
        instance.synthesizing.connect.call_args.args[0](
            SimpleNamespace(result=SimpleNamespace(audio_data=b"\x01\x00" * 480))
        )
        await next_frame(voice.frames, TTSAudioRawFrame)
    elif cause == "empty":
        instance.synthesis_word_boundary.connect.call_args.args[0](
            SimpleNamespace(text="Unspoken text", audio_offset=0)
        )
        instance.synthesis_completed.connect.call_args.args[0](
            SimpleNamespace(result=SimpleNamespace(audio_duration=timedelta()))
        )
    elif cause == "canceled":
        instance.synthesis_canceled.connect.call_args.args[0](
            SimpleNamespace(
                result=SimpleNamespace(
                    cancellation_details=SimpleNamespace(
                        error_code=CancellationErrorCode.ServiceTimeout
                    )
                )
            )
        )
    state = await next_state(voice)
    assert state["reason"] == "response" and not voice.pipeline.revoked
    assert not voice.pipeline.task.done()
    assert not any(isinstance(frame, TTSTextFrame) for frame in observed)
    if cause != "progress":
        assert not any(isinstance(frame, (TTSStartedFrame, TTSAudioRawFrame)) for frame in observed)
    for name in (
        "synthesizing",
        "synthesis_word_boundary",
        "synthesis_completed",
        "synthesis_canceled",
    ):
        getattr(instance, name).disconnect_all.assert_called()
    instance.stop_speaking_async.assert_called_once()
    baseline = await store.get("owner")
    assert baseline.revision == 1 and baseline.facts.opening.amount_paise == 20000
    voice.responses.put_nowait(text_reply("What payment should we review?"))
    await continue_conversation(voice, state["sequence"])
    await next_state(voice)
    second, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "Obsolete audio and captions must not escape.")
    await render(second, "What payment should we review?")
    assert (await next_frame(voice.frames, TTSTextFrame)).text.strip() == (
        "What payment should we review?"
    )
    assert await store.get("owner") == baseline
    assert voice.pipeline.metrics["tool_calls"] == 1


@pytest.mark.parametrize("kind", ["session_stopped", "canceled", "malformed"])
async def test_stt_loss_fails_only_media_and_ignores_late_callbacks(voice, store, kind):
    """Verify recognition loss revokes media and ignores late callbacks without changing facts."""
    voice.expect_failure = True
    failed = asyncio.Event()
    voice.failed.side_effect = failed.set
    recognizer = voice.stt._speech_recognizer
    baseline = await store.get("owner")
    callback = recognizer.recognized.connect.call_args.args[0]
    if kind == "malformed":
        callback(SimpleNamespace(result=None))
    else:
        getattr(recognizer, kind).connect.call_args.args[0](SimpleNamespace())
    await asyncio.wait_for(failed.wait(), 2)
    assert voice.pipeline.revoked
    callback(SimpleNamespace(result=SimpleNamespace(text="Save 999", reason=None)))
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(next_frame(voice.frames, TranscriptionFrame), 0.05)
    assert await store.get("owner") == baseline and voice.requests.empty()
    assert voice.stt._recognition_id is None


async def test_intentional_recognizer_stop_ignores_empty_and_late_events(voice):
    """Verify intentional recognition shutdown disconnects callbacks without reporting failure."""
    recognizer = voice.stt._speech_recognizer
    callback = recognizer.session_stopped.connect.call_args.args[0]
    await voice.stt._disconnect()
    callback(SimpleNamespace())
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.05)
    voice.failed.assert_not_called()
    for name in ("recognizing", "recognized", "canceled", "session_stopped"):
        getattr(recognizer, name).disconnect_all.assert_called_once()
    recognizer.stop_continuous_recognition_async.return_value.get.assert_called_once()


@pytest.mark.parametrize("cause", ["task", "processor", "timeout", "runner"])
async def test_unexpected_framework_failures_revoke_output(voice, store, monkeypatch, cause):
    """Verify unexpected task, processor, timeout, and runner failures revoke output."""
    voice.expect_failure = True
    failed = asyncio.Event()
    voice.failed.side_effect = failed.set
    baseline = await store.get("owner")
    if cause == "task":

        async def crash():
            """Raise a simulated background worker failure with private details."""
            raise RuntimeError("private-worker-body")

        task = voice.pipeline.worker.task_manager.create_task(crash(), "failing-worker")
        await task
    elif cause == "processor":
        gate = next(
            item for item in voice.pipeline.processors if type(item).__name__ == "InputGate"
        )
        monkeypatch.setattr(gate, "process_frame", AsyncMock(side_effect=RuntimeError("private")))
        await gate.queue_frame(
            InputAudioRawFrame(audio=b"\x00\x00", sample_rate=16000, num_channels=1)
        )
    elif cause == "timeout":
        await voice.pipeline.worker._call_event_handler("on_pipeline_timeout", LLMRunFrame())
    else:
        voice.pipeline.task.cancel()
    await asyncio.wait_for(failed.wait(), 2)
    assert voice.pipeline.revoked and not voice.pipeline.context.get_messages()
    assert await store.get("owner") == baseline


async def test_native_shutdown_deadline_retires_recognizer_first(voice):
    """Verify native shutdown deadlines retire recognition before the shared stop finishes."""
    recognizer = voice.stt._speech_recognizer
    voice.stt.config = voice.stt.config.model_copy(update={"shutdown_seconds": 0.02})
    release = Event()
    entered = asyncio.Event()
    loop = asyncio.get_running_loop()

    def blocked():
        """Signal native shutdown entry from its thread and wait for release."""
        loop.call_soon_threadsafe(entered.set)
        release.wait()

    recognizer.stop_continuous_recognition_async.return_value.get.side_effect = blocked
    try:
        with pytest.raises(TimeoutError):
            await voice.stt._disconnect()
        await asyncio.wait_for(entered.wait(), 2)
        task = voice.stt._native_stop
        assert not task.done()
        assert voice.stt._recognition_id is None
        assert voice.stt._speech_recognizer is recognizer
        for _ in range(2):
            with pytest.raises(TimeoutError):
                await voice.stt._disconnect()
            assert voice.stt._native_stop is task and not task.done()
        recognizer.session_stopped.disconnect_all.assert_called_once()
        recognizer.stop_continuous_recognition_async.return_value.get.assert_called_once()
    finally:
        release.set()
        if voice.stt._native_stop is not None:
            await asyncio.wait_for(asyncio.shield(voice.stt._native_stop), 2)
    await voice.stt._disconnect()
    assert voice.stt._speech_recognizer is None and voice.stt._audio_stream is None


@pytest.mark.parametrize("status", [400, 401, 403, 404])
async def test_nontransient_model_failures_are_terminal(voice, store, status):
    """Verify nontransient model HTTP failures revoke the pipeline without retrying."""
    voice.expect_failure = True
    failed = asyncio.Event()
    voice.failed.side_effect = failed.set
    voice.responses.put_nowait(
        httpx.Response(status, json={"error": {"message": "private-provider-body"}})
    )
    await complete_turn(voice, "Please help me.")
    await asyncio.wait_for(failed.wait(), 2)
    assert voice.pipeline.revoked and not voice.pipeline.waiting
    assert (await store.get("owner")).revision == 0
    assert voice.pipeline.metrics["model_requests"] == 1


async def test_unknown_pipeline_timeout_is_not_a_provider_recovery(voice):
    """Verify an unclassified pipeline timeout is terminal rather than recoverable waiting."""
    voice.expect_failure = True
    failed = asyncio.Event()
    voice.failed.side_effect = failed.set
    await voice.pipeline.llm.push_error(error_msg="private", exception=TimeoutError())
    await asyncio.wait_for(failed.wait(), 2)
    assert voice.pipeline.revoked and not voice.pipeline.waiting
