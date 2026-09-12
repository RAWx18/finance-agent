# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from types import SimpleNamespace

import pytest
from azure.cognitiveservices.speech import CancellationErrorCode, CancellationReason
from pipecat.frames.frames import BotStoppedSpeakingFrame, TTSAudioRawFrame, TTSStoppedFrame
from pipecat.processors.frame_processor import FrameDirection

from .conftest import money
from .test_voice_errors import text_reply
from .test_voice_failure_diagnostics import events
from .test_voice_opening import render
from .test_voice_opening import synthesis as synthesis
from .test_voice_retry import acknowledge
from .test_voice_turns import complete_turn, next_frame, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries
from .test_voice_waiting import next_state

pytestmark = pytest.mark.parametrize(
    "voice",
    [
        {
            "speech_timeout_seconds": 0.3,
            "model_timeout_seconds": 2,
            "tts_first_audio_seconds": 2,
            "tts_progress_seconds": 2,
            "response_retry_delay_seconds": 0.1,
            "response_retry_attempts": 1,
        }
    ],
    indirect=True,
)


async def audio(instance):
    """Deliver nonempty SDK audio from a callback thread."""
    await asyncio.to_thread(
        instance.synthesizing.connect.call_args.args[0],
        SimpleNamespace(result=SimpleNamespace(audio_data=b"\x01\x00" * 480)),
    )


async def cancel(instance, code=CancellationErrorCode.RuntimeError):
    """Deliver the SDK cancellation enum, not a Python exception with a similar name."""
    await asyncio.to_thread(
        instance.synthesis_canceled.connect.call_args.args[0],
        SimpleNamespace(
            result=SimpleNamespace(
                cancellation_details=SimpleNamespace(
                    error_code=code, reason=CancellationReason.Error
                )
            )
        ),
    )


@pytest.fixture
async def runtime(voice, synthesis, store, monkeypatch):
    """Reach real post-tool synthesis and observe classification without replacing it."""
    pipeline = voice.pipeline
    pipeline.client_ready.set()
    voice.expect_failure = True
    outcome = asyncio.Event()
    diagnostic = pipeline.diagnostic

    def observed(event, **values):
        """Signal classification after its real diagnostic has been recorded."""
        diagnostic(event, **values)
        if event in {"voice.responseFailed", "voice.stopped"}:
            outcome.set()

    monkeypatch.setattr(pipeline, "diagnostic", observed)
    voice.responses.put_nowait(
        tool_reply("update_facts", {"expectedRevision": 0, "opening": money("200")}, "once")
    )
    voice.responses.put_nowait(text_reply("Your cash is recorded. What payment is due next?"))
    await complete_turn(voice, "I have two hundred rupees.")
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    requests = [await asyncio.wait_for(voice.requests.get(), 2) for _ in range(2)]
    baseline = await store.get("owner")
    assert baseline.revision == 1 and baseline.facts.opening.amount_paise == 20000
    assert pipeline.metrics["tool_calls"] == 1
    assert pipeline.metrics["model_finish_stop"] == 1
    assert requests[0]["tool_choice"] == "required"
    return SimpleNamespace(
        instance=instance,
        outcome=outcome,
        baseline=baseline,
        identity=(pipeline.call_id, pipeline.worker, pipeline.task, pipeline.context),
    )


async def test_sdk_runtime_after_audio_recovers_read_only_and_next_turn_can_write(
    voice, synthesis, store, runtime, caplog
):
    """Keep a committed turn's SDK streaming fault inside the same ACK-gated call."""
    pipeline = voice.pipeline
    await audio(runtime.instance)
    assert (await next_frame(voice.frames, TTSAudioRawFrame)).audio == b"\x01\x00" * 480
    await cancel(runtime.instance)
    await asyncio.wait_for(runtime.outcome.wait(), 2)
    (cancelled,) = events(caplog, "speech.synthesisCancelled")
    assert cancelled["category"] == "RuntimeError" and cancelled["reason"] == "Error"
    assert cancelled["stage"] == "streaming"
    assert not pipeline.revoked, "SDK RuntimeError after published audio must not stop the call"
    voice.failed.assert_not_called()
    waiting = await next_state(voice)
    assert waiting["state"] == "waiting" and waiting["reason"] == "response"
    assert waiting["autoRetry"] is True
    offered = await next_state(voice)
    assert offered["reason"] == "retry" and offered["retryOf"] == waiting["sequence"]
    assert pipeline.waiting and voice.requests.empty() and synthesis.requests.empty()
    for signal in (
        "synthesizing",
        "synthesis_completed",
        "synthesis_canceled",
        "synthesis_word_boundary",
    ):
        getattr(runtime.instance, signal).disconnect_all.assert_called()
    runtime.instance.stop_speaking_async.return_value.get.assert_called_once()

    await acknowledge(voice, {**offered, "retryOf": offered["retryOf"] - 1})
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.03)
    reply = "What payment should we review?"
    voice.responses.put_nowait(text_reply(reply))
    await acknowledge(voice, offered)
    await acknowledge(voice, offered)
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "none"
    assert not any(message["role"] == "tool" for message in request["messages"])
    assert not any(message.get("tool_calls") for message in request["messages"])
    retry, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    assert retry is not runtime.instance
    published = pipeline.metrics.get("published_audio", 0)
    await render(runtime.instance, "Retired speech must not enter the retry.")
    await cancel(runtime.instance, CancellationErrorCode.AuthenticationFailure)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(next_frame(voice.frames, TTSAudioRawFrame), 0.03)
    assert pipeline.metrics.get("published_audio", 0) == published
    assert pipeline.metrics["response_failures"] == 1
    assert not pipeline.revoked
    await render(retry, reply)
    await next_frame(voice.frames, TTSAudioRawFrame)
    await next_frame(voice.frames, TTSStoppedFrame)
    await asyncio.wait_for(synthesis.turns.get(), 2)
    await pipeline.output.push_frame(BotStoppedSpeakingFrame(), FrameDirection.UPSTREAM)
    assert await store.get("owner") == runtime.baseline
    assert pipeline.metrics["tool_calls"] == 1 and pipeline.metrics["response_retries"] == 1
    assert voice.requests.empty() and synthesis.requests.empty()

    voice.responses.put_nowait(
        tool_reply("update_facts", {"expectedRevision": 1, "opening": money("300")}, "next-turn")
    )
    voice.responses.put_nowait(text_reply("Your corrected cash is recorded."))
    await complete_turn(voice, "Correction, my cash is three hundred rupees.")
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "required"
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "Your corrected cash is recorded.")
    await next_frame(voice.frames, TTSAudioRawFrame)
    await next_frame(voice.frames, TTSStoppedFrame)
    saved = await store.get("owner")
    assert saved.revision == 2 and saved.facts.opening.amount_paise == 30000
    assert pipeline.metrics["tool_calls"] == 2
    assert runtime.identity == (pipeline.call_id, pipeline.worker, pipeline.task, pipeline.context)
    assert not pipeline.waiting and not pipeline.revoked and not pipeline.task.done()
    voice.failed.assert_not_called()
    (failure,) = events(caplog, "voice.responseFailed")
    assert failure["stage"] == "synthesis" and failure["source"] == "GuardedSpeech"
    assert failure["financial_revision"] == 1
    assert not events(caplog, "voice.stopped")
    assert "Retired speech" not in json.dumps(pipeline.context.get_messages())


async def test_repeated_streaming_runtime_fault_exhausts_retry_without_replaying_write(
    voice, synthesis, store, runtime, caplog
):
    """One automatic retry may pause again, but cannot loop or revoke the call."""
    pipeline = voice.pipeline
    for attempt in range(2):
        await audio(runtime.instance)
        await next_frame(voice.frames, TTSAudioRawFrame)
        runtime.outcome.clear()
        await cancel(runtime.instance)
        await asyncio.wait_for(runtime.outcome.wait(), 2)
        assert not pipeline.revoked, "Streaming SDK faults must use bounded response recovery"
        waiting = await next_state(voice)
        assert waiting["reason"] == "response" and waiting["state"] == "waiting"
        assert waiting["autoRetry"] is (attempt == 0)
        if attempt == 0:
            offered = await next_state(voice)
            voice.responses.put_nowait(text_reply("What payment should we review?"))
            await acknowledge(voice, offered)
            request = await asyncio.wait_for(voice.requests.get(), 2)
            assert request["tool_choice"] == "none"
            runtime.instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.2)
    assert synthesis.requests.empty() and pipeline.waiting
    assert pipeline.metrics["response_retries"] == 1
    assert pipeline.metrics["response_failures"] == 2 and pipeline.metrics["tool_calls"] == 1
    assert await store.get("owner") == runtime.baseline
    assert runtime.identity == (pipeline.call_id, pipeline.worker, pipeline.task, pipeline.context)
    assert not pipeline.task.done()
    voice.failed.assert_not_called()
    assert not events(caplog, "voice.stopped")
    assert events(caplog, "voice.retryExhausted")[-1]["reason"] == "attemptLimit"


@pytest.mark.parametrize(
    "cause", ["runtimeBeforeAudio", "authentication", "badRequest", "pythonRuntime"]
)
async def test_permanent_synthesis_fault_stays_fatal_and_names_its_source(
    voice, synthesis, store, runtime, caplog, cause
):
    """Setup, auth, request, and native Python faults must not inherit streaming recovery."""
    pipeline = voice.pipeline
    if cause != "runtimeBeforeAudio":
        await audio(runtime.instance)
        await next_frame(voice.frames, TTSAudioRawFrame)
    else:
        await asyncio.to_thread(
            runtime.instance.synthesizing.connect.call_args.args[0],
            SimpleNamespace(result=SimpleNamespace(audio_data=b"")),
        )
        await asyncio.to_thread(
            runtime.instance.synthesis_word_boundary.connect.call_args.args[0],
            SimpleNamespace(text="Unheard word", audio_offset=0),
        )
    if cause == "pythonRuntime":

        class NativeResult:
            """Represent a Python binding failure rather than an SDK cancellation enum."""

            @property
            def audio_data(self):
                """Raise while the real synthesis generator consumes its next audio event."""
                raise RuntimeError("private-native-detail")

        await asyncio.to_thread(
            runtime.instance.synthesizing.connect.call_args.args[0],
            SimpleNamespace(result=NativeResult()),
        )
    else:
        await cancel(
            runtime.instance,
            {
                "runtimeBeforeAudio": CancellationErrorCode.RuntimeError,
                "authentication": CancellationErrorCode.AuthenticationFailure,
                "badRequest": CancellationErrorCode.BadRequest,
            }[cause],
        )
    await asyncio.wait_for(runtime.outcome.wait(), 2)
    assert pipeline.revoked and not pipeline.waiting
    voice.failed.assert_called_once()
    assert pipeline.metrics.get("response_retries", 0) == 0
    assert pipeline.metrics.get("response_failures", 0) == 0
    assert voice.requests.empty() and synthesis.requests.empty()
    assert await store.get("owner") == runtime.baseline
    assert not events(caplog, "voice.responseFailed")
    if cause == "runtimeBeforeAudio":
        assert pipeline.metrics.get("published_audio", 0) == 0
        assert events(caplog, "speech.synthesisCancelled")[0]["stage"] == "firstAudio"
    (stopped,) = events(caplog, "voice.stopped")
    assert stopped["stage"] == "synthesis", stopped
    assert stopped["source"] == "GuardedSpeech"
    assert stopped["call_id"] == str(pipeline.call_id)
    assert stopped["financial_revision"] == 1
    assert stopped["errors"][0]["type"] == "RuntimeError"
    assert "private-native-detail" not in caplog.text
