# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from copy import deepcopy
from datetime import timedelta
from unittest.mock import AsyncMock
from uuid import uuid4
from xml.etree import ElementTree

import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    FunctionCallResultFrame,
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    InterruptionFrame,
    LLMRunFrame,
    OutputTransportMessageUrgentFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregator
from pipecat.processors.frameworks.rtvi.models import ClientMessage
from pipecat.services.llm_service import FunctionCallParams
from pipecat.turns.user_idle_controller import UserIdleController

from app.config import load_config
from app.store import Problem
from app.voice_tools import VoiceTools

from .conftest import money
from .test_voice_errors import text_reply
from .test_voice_opening import ready, render
from .test_voice_opening import synthesis as synthesis
from .test_voice_turns import next_frame, recognize, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries


@pytest.fixture
def config(request):
    config = load_config()
    if hasattr(request, "param"):
        config = config.model_copy(
            update={"voice": config.voice.model_copy(update={"inactive_seconds": request.param})}
        )
    return config


async def next_state(voice):
    async with asyncio.timeout(2):
        while True:
            frame = await voice.frames.get()
            if isinstance(frame, OutputTransportMessageUrgentFrame):
                message = frame.message
                if (
                    message.get("type") == "server-message"
                    and message.get("data", {}).get("type") == "conversation-state"
                ):
                    return message["data"]


async def continue_conversation(voice, sequence):
    await voice.pipeline.worker.rtvi._call_event_handler(
        "on_client_message",
        ClientMessage(
            msg_id=str(uuid4()), type="continue-conversation", data={"sequence": sequence}
        ),
    )


async def enter_waiting(voice):
    sequence = voice.pipeline.state_sequence
    await voice.pipeline.worker.queue_frames([BotStartedSpeakingFrame(), BotStoppedSpeakingFrame()])
    state = await next_state(voice)
    assert state == {"type": "conversation-state", "state": "waiting", "sequence": sequence + 1}
    assert voice.pipeline.waiting
    return state["sequence"]


@pytest.fixture
async def active(voice, store, synthesis):
    user = next(item for item in voice.pipeline.processors if isinstance(item, LLMUserAggregator))
    assert isinstance(user._user_idle_controller, UserIdleController)
    voice.responses.put_nowait(tool_reply("read_state", {}, "initial-state"))
    voice.responses.put_nowait(text_reply("What is your available cash?"))
    await voice.pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
    await asyncio.wait_for(voice.started.wait(), 2)
    await recognize(voice, "I want to review my cash flow.")
    await voice.pipeline.worker.queue_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
    await asyncio.wait_for(voice.requests.get(), store.config.voice.speech_timeout_seconds + 1)
    await next_frame(voice.frames, FunctionCallResultFrame)
    await asyncio.wait_for(voice.requests.get(), 2)
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "What is your available cash?")
    await next_frame(voice.frames, TTSAudioRawFrame)
    await asyncio.wait_for(synthesis.turns.get(), 2)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.1)
    await voice.pipeline.worker.rtvi._call_event_handler("on_client_ready")
    assert await next_state(voice) == {
        "type": "conversation-state",
        "state": "active",
        "sequence": 1,
    }
    voice.started.clear()
    return voice


def test_conversation_timing_defaults_are_independent(config):
    assert config.voice.speech_timeout_seconds == 2.6
    assert config.voice.vad_start_seconds == 0.1
    assert config.voice.vad_stop_seconds == 0.2
    assert config.voice.vad_confidence == config.voice.vad_min_volume == 0.5
    assert config.voice.inactive_seconds == 60
    assert config.voice.call_seconds == 1800


@pytest.mark.parametrize("pause", [1.2, 2.0])
async def test_pauses_filler_and_interims_remain_one_turn_until_speech_timer(voice, store, pause):
    baseline = await store.get("owner")
    await voice.pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
    await asyncio.wait_for(voice.started.wait(), 2)
    await recognize(voice, "Rent is five thousand.")
    await voice.pipeline.worker.queue_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), pause)
    assert voice.pipeline.metrics.get("user_turns", 0) == 0
    await voice.pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
    await recognize(voice, "Um.")
    await recognize(voice, "No, the rent is", final=False)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(
            voice.requests.get(), store.config.voice.speech_timeout_seconds + 0.1
        )
    await recognize(voice, "No, the rent is six thousand.")
    voice.responses.put_nowait(tool_reply("read_state", {}, "completed-turn"))
    await voice.pipeline.worker.queue_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 2.0)
    request = await asyncio.wait_for(
        voice.requests.get(), store.config.voice.speech_timeout_seconds + 1
    )
    assert [item["content"] for item in request["messages"] if item["role"] == "user"] == [
        "Rent is five thousand. Um. No, the rent is six thousand."
    ]
    result = await next_frame(voice.frames, FunctionCallResultFrame)
    assert result.tool_call_id == "completed-turn"
    assert result.result["snapshot"] == baseline.model_dump(mode="json", by_alias=True)
    assert voice.pipeline.metrics["user_turns"] == 1
    assert await store.get("owner") == baseline


async def test_short_no_interrupts_before_turn_completion(voice, store):
    await voice.pipeline.worker.queue_frame(BotStartedSpeakingFrame())
    await next_frame(voice.frames, BotStartedSpeakingFrame)
    await voice.pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
    await asyncio.wait_for(voice.started.wait(), 1)
    await recognize(voice, "No.")
    await asyncio.wait_for(next_frame(voice.frames, InterruptionFrame), 1)
    assert voice.pipeline.user_speaking
    assert voice.pipeline.metrics["user_starts"] == 1
    assert voice.requests.empty()
    await voice.pipeline.worker.queue_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
    request = await asyncio.wait_for(
        voice.requests.get(), store.config.voice.speech_timeout_seconds + 1
    )
    assert [item["content"] for item in request["messages"] if item["role"] == "user"] == ["No."]


async def test_ordered_speaking_frames_clear_stale_flag_before_llm_context(active):
    pipeline = active.pipeline
    await pipeline.worker.queue_frame(UserStartedSpeakingFrame())
    await next_frame(active.frames, UserStartedSpeakingFrame)
    assert pipeline.user_speaking
    pipeline.user_speaking = True
    await pipeline.worker.queue_frames([UserStoppedSpeakingFrame(), LLMRunFrame()])
    request = await asyncio.wait_for(active.requests.get(), 2)
    assert not pipeline.user_speaking
    assert pipeline.metrics["model_requests"] == 3
    assert any(item["role"] == "developer" for item in request["messages"])


@pytest.mark.parametrize("config", [0.05], indirect=True)
class TestWaiting:
    @pytest.mark.parametrize("cause", ["empty", "inactivity"])
    async def test_continue_before_any_user_turn_preserves_call_context_and_fresh_state(
        self, voice, synthesis, store, cause
    ):
        pipeline = voice.pipeline
        context, worker, task = pipeline.context, pipeline.worker, pipeline.task
        voice.responses.put_nowait(text_reply("" if cause == "empty" else "Hello, how can I help?"))
        await ready(voice)
        assert (await next_state(voice))["state"] == "active"
        assert (await asyncio.wait_for(voice.requests.get(), 2))["tool_choice"] == "none"
        if cause == "inactivity":
            instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
            await render(instance, "Hello, how can I help?")
            await next_frame(voice.frames, TTSAudioRawFrame)
            await asyncio.wait_for(synthesis.turns.get(), 2)
            sequence = await enter_waiting(voice)
        else:
            state = await next_state(voice)
            assert state["state"] == "waiting"
            sequence = state["sequence"]
        messages = deepcopy(context.get_messages())
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(voice.requests.get(), 0.15)
        external = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
        await external.update_facts({"expectedRevision": 0, "opening": money("250")}, "edit")
        baseline = await store.get("owner")
        voice.responses.put_nowait(text_reply("With two hundred fifty recorded, what is due next?"))
        await continue_conversation(voice, sequence)
        assert await next_state(voice) == {
            "type": "conversation-state",
            "state": "active",
            "sequence": sequence + 1,
        }
        request = await asyncio.wait_for(voice.requests.get(), 2)
        assert request["tool_choice"] == "none"
        assert not any(message["role"] == "user" for message in request["messages"])
        assert all(message in request["messages"] for message in messages[1:])
        state = next(
            message["content"]
            for message in request["messages"]
            if message.get("content", "").startswith("Canonical application state;")
        )
        assert json.loads(state.split("\n", 1)[1])["snapshot"] == baseline.model_dump(
            mode="json", by_alias=True
        )
        instance, ssml = await asyncio.wait_for(synthesis.requests.get(), 2)
        text = "".join(ElementTree.fromstring(ssml).itertext()).strip()
        assert text == "With two hundred fifty recorded, what is due next?"
        await render(instance, text)
        await next_frame(voice.frames, TTSAudioRawFrame)
        async with asyncio.timeout(2):
            while (await synthesis.turns.get()).content.strip() != text:
                pass
        for duplicate in (sequence, sequence + 1):
            await continue_conversation(voice, duplicate)
            assert (await next_state(voice))["state"] == "active"
        await pipeline.worker.queue_frame(LLMRunFrame())
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(voice.requests.get(), 0.15)
        assert (pipeline.context, pipeline.worker, pipeline.task) == (context, worker, task)
        assert pipeline.completed_turns == 0 and pipeline.model_requests == 1
        assert pipeline.metrics["model_requests"] == 2
        assert pipeline.metrics["continued"] == 1 and pipeline.metrics.get("tool_calls", 0) == 0
        assert not pipeline.revoked and not task.done()
        assert await store.get("owner") == baseline

    @pytest.mark.parametrize("cause", ["end", "revoke"])
    async def test_ending_recovery_suppresses_late_sdk_audio_and_continue(
        self, voice, synthesis, store, cause
    ):
        pipeline = voice.pipeline
        pipeline.client_ready.set()
        sequence = await enter_waiting(voice)
        baseline = await store.get("owner")
        voice.responses.put_nowait(text_reply("Welcome back, what payment is due next?"))
        await continue_conversation(voice, sequence)
        await next_state(voice)
        await asyncio.wait_for(voice.requests.get(), 2)
        instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
        if cause == "end":
            await pipeline.close()
            assert pipeline.task.done()
        else:
            pipeline.invalidate()
        await render(instance, "Late recovery audio must not escape.")
        await continue_conversation(voice, pipeline.state_sequence)
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(next_frame(voice.frames, TTSAudioRawFrame), 0.15)
        assert pipeline.revoked and not pipeline.context.get_messages()
        assert pipeline.metrics.get("published_audio", 0) == 0
        assert pipeline.metrics["model_requests"] == 1 and voice.requests.empty()
        assert await store.get("owner") == baseline

    async def test_idle_before_any_user_input_keeps_the_call_open(self, voice, store):
        baseline = await store.get("owner")
        voice.pipeline.client_ready.set()
        await enter_waiting(voice)
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(voice.requests.get(), 0.15)
        assert voice.pipeline.metrics.get("user_starts", 0) == 0
        assert voice.pipeline.metrics.get("model_requests", 0) == 0
        assert voice.pipeline.metrics.get("published_audio", 0) == 0
        assert not voice.pipeline.task.done()
        assert not voice.pipeline.revoked
        assert await store.get("owner") == baseline
        voice.synthesizer.speak_ssml_async.assert_not_called()

    async def test_idle_after_bot_output_waits_without_input_output_or_call_end(
        self, active, store
    ):
        baseline = await store.get("owner")
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(next_state(active), 0.15)
        sequence = await enter_waiting(active)
        assert active.pipeline.metrics["waiting"] == 1
        assert active.pipeline.state_sequence == sequence
        assert active.pipeline.metrics["model_requests"] == 2
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(active.requests.get(), 0.15)
        assert not active.pipeline.task.done()
        assert not active.pipeline.revoked
        assert await store.get("owner") == baseline
        active.synthesizer.speak_ssml_async.assert_not_called()

    async def test_continue_keeps_context_and_refreshes_external_edits_once(
        self, active, store, monkeypatch, synthesis
    ):
        pipeline = active.pipeline
        context, worker, runner = pipeline.context, pipeline.worker, pipeline.runner
        context.add_message({"role": "user", "content": "My wages arrive on Friday."})
        sequence = await enter_waiting(active)
        queue = AsyncMock(wraps=worker.queue_frame)
        monkeypatch.setattr(worker, "queue_frame", queue)
        external = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
        await external.update_facts({"expectedRevision": 0, "opening": money("250")}, "edit")
        baseline = await store.get("owner")
        active.responses.put_nowait(text_reply("Your recorded cash is two hundred fifty."))
        await continue_conversation(active, sequence)
        assert await next_state(active) == {
            "type": "conversation-state",
            "state": "active",
            "sequence": sequence + 1,
        }
        request = await asyncio.wait_for(active.requests.get(), 2)
        assert request["tool_choice"] == "none"
        assert (pipeline.context, pipeline.worker, pipeline.runner) == (context, worker, runner)
        assert not pipeline.waiting
        assert pipeline.metrics["continued"] == 1
        state = next(
            item["content"]
            for item in request["messages"]
            if item.get("content", "").startswith("Canonical application state;")
        )
        assert json.loads(state.split("\n", 1)[1])["snapshot"] == baseline.model_dump(
            mode="json", by_alias=True
        )
        assert {"role": "user", "content": "My wages arrive on Friday."} in request["messages"]
        instance, ssml = await asyncio.wait_for(synthesis.requests.get(), 2)
        text = "".join(ElementTree.fromstring(ssml).itertext()).strip()
        assert text == "Your recorded cash is two hundred fifty."
        await render(instance, text)
        await next_frame(active.frames, TTSAudioRawFrame)
        await asyncio.wait_for(synthesis.turns.get(), 2)
        for duplicate in (sequence, sequence + 1):
            await continue_conversation(active, duplicate)
            assert await next_state(active) == {
                "type": "conversation-state",
                "state": "active",
                "sequence": sequence + 1,
            }
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(active.requests.get(), 0.15)
        assert pipeline.metrics["continued"] == 1
        assert sum(isinstance(call.args[0], LLMRunFrame) for call in queue.await_args_list) == 1
        assert pipeline.metrics["model_requests"] == 3
        assert pipeline.model_requests == 1 and pipeline.tool_rounds == 0
        assert pipeline.metrics["tool_calls"] == 1
        assert await store.get("owner") == baseline

    async def test_stale_continue_returns_waiting_without_running_model(self, active):
        sequence = await enter_waiting(active)
        await continue_conversation(active, sequence - 1)
        assert await next_state(active) == {
            "type": "conversation-state",
            "state": "waiting",
            "sequence": sequence,
        }
        assert active.pipeline.waiting
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(active.requests.get(), 0.15)
        assert active.pipeline.metrics.get("continued", 0) == 0

    async def test_waiting_blocks_queued_input_context_and_registered_tools(
        self, active, store, monkeypatch
    ):
        await enter_waiting(active)
        pipeline = active.pipeline
        baseline = await store.get("owner")
        messages = deepcopy(pipeline.context.get_messages())
        gate = next(item for item in pipeline.processors if type(item).__name__ == "InputGate")
        forwarded = AsyncMock(wraps=gate.push_frame)
        monkeypatch.setattr(gate, "push_frame", forwarded)
        frames = [
            InputAudioRawFrame(audio=b"\x00\x00" * 320, sample_rate=16000, num_channels=1),
            InterimTranscriptionFrame(text="Set cash", user_id="owner", timestamp=""),
            TranscriptionFrame(text="Set cash to 999.", user_id="owner", timestamp=""),
        ]
        for frame in frames:
            await gate.queue_frame(frame)
        await recognize(active, "Queued recognition must not change facts.")
        await pipeline.worker.queue_frame(LLMRunFrame())
        result = AsyncMock()
        await pipeline.llm._functions["update_facts"].handler(
            FunctionCallParams(
                function_name="update_facts",
                tool_call_id="queued-write",
                arguments={"expectedRevision": 0, "opening": money("999")},
                llm=pipeline.llm,
                pipeline_worker=pipeline.worker,
                context=pipeline.context,
                result_callback=result,
            )
        )
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(active.requests.get(), 0.15)
        assert all(call.args[0] not in frames for call in forwarded.await_args_list)
        result.assert_not_awaited()
        assert pipeline.metrics["tool_calls"] == 1
        assert pipeline.context.get_messages() == messages
        assert await store.get("owner") == baseline

    async def test_revoked_continue_cannot_resume_or_restore_context(self, active, store):
        sequence = await enter_waiting(active)
        baseline = await store.get("owner")
        active.pipeline.invalidate()
        await continue_conversation(active, sequence)
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(next_state(active), 0.15)
        assert active.requests.empty()
        assert active.pipeline.waiting and active.pipeline.revoked
        assert not active.pipeline.context.get_messages()
        assert active.pipeline.state_sequence == sequence
        assert await store.get("owner") == baseline

    async def test_expired_session_fails_closed_on_continue(self, active, store):
        sequence = await enter_waiting(active)
        baseline = await store.get("owner")
        store.clock = lambda: baseline.expires_at + timedelta(seconds=1)
        active.expect_failure = True
        await continue_conversation(active, sequence)
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(next_state(active), 0.15)
        active.failed.assert_called_once()
        assert active.pipeline.revoked and active.pipeline.waiting
        assert not active.pipeline.context.get_messages()
        assert active.requests.empty()
        with pytest.raises(Problem) as error:
            await store.get("owner")
        assert error.value.body.code == "notFound"

    async def test_delayed_audio_metadata_is_rejected_after_wait_and_continue(self, active):
        generation = active.pipeline.generation
        published = active.pipeline.metrics["published_audio"]
        sequence = await enter_waiting(active)
        await continue_conversation(active, sequence)
        await next_state(active)
        await asyncio.wait_for(active.requests.get(), 2)
        guard = next(
            item for item in active.pipeline.processors if type(item).__name__ == "OutputGuard"
        )
        frame = TTSAudioRawFrame(audio=b"\x01\x00" * 480, sample_rate=24000, num_channels=1)
        frame.metadata["voice_generation"] = generation
        await guard.queue_frame(frame)
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(next_frame(active.frames, TTSAudioRawFrame), 0.15)
        assert active.pipeline.metrics["stale_output_frames"] == 1
        assert active.pipeline.metrics["published_audio"] == published

    @pytest.mark.parametrize("busy", ["user", "bot"])
    async def test_idle_controller_suppresses_timer_during_speaking(self, active, busy):
        await active.pipeline.worker.queue_frame(BotStoppedSpeakingFrame())
        if busy == "user":
            await active.pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
            await asyncio.wait_for(active.started.wait(), 2)
            await active.pipeline.worker.queue_frame(BotStoppedSpeakingFrame())
        else:
            await active.pipeline.worker.queue_frame(BotStartedSpeakingFrame())
            await next_frame(active.frames, BotStartedSpeakingFrame)
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(next_state(active), 0.15)
        assert not active.pipeline.waiting
        assert active.pipeline.metrics.get("waiting", 0) == 0
        if busy == "user":
            await active.pipeline.worker.queue_frame(UserStoppedSpeakingFrame())
        await active.pipeline.worker.queue_frame(BotStoppedSpeakingFrame())
        assert (await next_state(active))["state"] == "waiting"

    async def test_idle_controller_does_not_fire_while_real_tool_runner_is_busy(
        self, active, store, monkeypatch
    ):
        reached, release = asyncio.Event(), asyncio.Event()
        read = active.pipeline.tools.read_state

        async def paused_read():
            reached.set()
            await release.wait()
            return await read()

        monkeypatch.setattr(active.pipeline.tools, "read_state", paused_read)
        baseline = await store.get("owner")
        active.responses.put_nowait(tool_reply("read_state", {}, "slow-read"))
        await active.pipeline.worker.queue_frame(LLMRunFrame())
        await asyncio.wait_for(active.requests.get(), 2)
        try:
            await asyncio.wait_for(reached.wait(), 2)
            await active.pipeline.worker.queue_frames(
                [BotStartedSpeakingFrame(), BotStoppedSpeakingFrame()]
            )
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(next_state(active), 0.15)
            assert not active.pipeline.waiting
        finally:
            release.set()
        result = await next_frame(active.frames, FunctionCallResultFrame)
        assert result.tool_call_id == "slow-read"
        assert result.result["snapshot"] == baseline.model_dump(mode="json", by_alias=True)
        await active.pipeline.worker.queue_frame(BotStoppedSpeakingFrame())
        assert (await next_state(active))["state"] == "waiting"
        assert await store.get("owner") == baseline
