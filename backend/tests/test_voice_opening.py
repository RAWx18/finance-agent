# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from xml.etree import ElementTree

import pytest
from pipecat.frames.frames import (
    BotStoppedSpeakingFrame,
    InterruptionFrame,
    LLMRunFrame,
    TTSAudioRawFrame,
    TTSStoppedFrame,
    TTSTextFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_response_universal import LLMAssistantAggregator
from pipecat.processors.frame_processor import FrameDirection

from app.voice_pipeline import RESUME, VoicePipeline

from .conftest import money
from .test_voice_errors import text_reply
from .test_voice_turns import complete_turn, next_frame, recognize
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries


def opening_lines(config, resumed=False):
    """Format every configured opening or welcome-back line for the given situation."""
    return {
        line.format(assistant_name=config.voice.assistant_name, horizon_days=config.horizon_days)
        for line in (config.voice.resumptions if resumed else config.voice.openings)
    }


@pytest.fixture
def synthesis(voice, monkeypatch):
    """Supply queued synthesis requests and assistant turns using synthesizer mocks."""
    requests = asyncio.Queue()
    turns = asyncio.Queue()

    def create(**kwargs):
        """Create a synthesizer mock that queues itself with requested SSML."""
        instance = Mock()
        instance.speak_ssml_async.side_effect = lambda ssml: requests.put_nowait((instance, ssml))
        return instance

    monkeypatch.setattr("app.speech.SpeechSynthesizer", create)
    assistant = next(
        item for item in voice.pipeline.processors if isinstance(item, LLMAssistantAggregator)
    )
    assistant.add_event_handler(
        "on_assistant_turn_stopped", lambda _, message: turns.put_nowait(message)
    )
    return SimpleNamespace(requests=requests, turns=turns)


async def render(instance, text):
    """Deliver synthetic audio, word-boundary, and completion callbacks from a thread."""
    for signal, event in (
        (
            instance.synthesizing,
            SimpleNamespace(result=SimpleNamespace(audio_data=b"\x01\x00" * 480)),
        ),
        (instance.synthesis_word_boundary, SimpleNamespace(text=text, audio_offset=0)),
        (
            instance.synthesis_completed,
            SimpleNamespace(result=SimpleNamespace(audio_duration=timedelta(milliseconds=20))),
        ),
    ):
        await asyncio.to_thread(signal.connect.call_args.args[0], event)


async def ready(voice):
    """Dispatch the RTVI client-ready event for the supplied pipeline."""
    await voice.pipeline.worker.rtvi._call_event_handler("on_client_ready")


async def spoken_opening(voice, synthesis, store, *, resumed=False, complete=True):
    """Await the deterministic opening's synthesis request and optionally play it through."""
    instance, ssml = await asyncio.wait_for(synthesis.requests.get(), 2)
    text = "".join(ElementTree.fromstring(ssml).itertext()).strip()
    assert text in opening_lines(store.config, resumed)
    if complete:
        await render(instance, text)
        await next_frame(voice.frames, TTSAudioRawFrame)
        await next_frame(voice.frames, TTSStoppedFrame)
        # The queued transport never reports playback; Azure TTS waits for it before speaking on.
        await voice.pipeline.output.push_frame(BotStoppedSpeakingFrame(), FrameDirection.UPSTREAM)
    return instance, text


@pytest.fixture
def resumed_dialogue(monkeypatch):
    """Seed pipeline construction with a conversation slug and recent scripted dialogue."""
    messages = [
        {"role": "user", "content": "My salary is five lakh. I am worried about rent."},
        {"role": "assistant", "content": "Does your salary arrive before rent is due?"},
        {"role": "user", "content": "It comes after rent. Change that five lakh to six lakh."},
    ]
    initialize = VoicePipeline.__init__

    def resumed(pipeline):
        """Initialize the pipeline and attach copied dialogue for reconnect coverage."""
        initialize(pipeline)
        pipeline.resume_slug = "conversation-2026-09-11-060000"
        pipeline.resume_messages = [dict(message) for message in messages]

    monkeypatch.setattr(VoicePipeline, "__init__", resumed)
    return messages


async def test_reconnect_uses_recent_dialogue_without_reintroducing_or_replaying_writes(
    resumed_dialogue, voice, synthesis, store
):
    """Verify reconnect speaks a welcome back, then continues without introductions or writes."""
    await voice.pipeline.tools.update_facts(
        {"expectedRevision": 0, "opening": money("600000")}, "saved-before-reconnect"
    )
    baseline = await store.get("owner")
    response = "Let's continue with rent before payday."
    voice.responses.put_nowait(text_reply(response))
    await ready(voice)
    _, welcome = await spoken_opening(voice, synthesis, store, resumed=True)
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "none"
    assert all(message in request["messages"] for message in resumed_dialogue)
    assert not any(
        message["content"] in opening_lines(store.config)
        for message in request["messages"]
        if message["role"] == "developer"
    )
    assert {"role": "developer", "content": RESUME} in request["messages"]
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, response)
    await next_frame(voice.frames, TTSAudioRawFrame)
    await next_frame(voice.frames, TTSStoppedFrame)
    await asyncio.wait_for(synthesis.turns.get(), 2)
    assert await store.get("owner") == baseline
    assert voice.pipeline.metrics.get("tool_calls", 0) == 0
    assert voice.pipeline.completed_turns == 2
    assert {"role": "assistant", "content": welcome} in voice.pipeline.context.get_messages()
    await ready(voice)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.05)


@pytest.mark.parametrize(
    "voice",
    [
        {},
        {
            "assistant_name": "Mira",
            "openings": ["Hello, I'm {assistant_name}. Tell me your concern."],
        },
    ],
    indirect=True,
)
async def test_configured_opening_reaches_synthesis_transport_and_history_once(
    voice, synthesis, store, voice_boundaries
):
    """Verify the configured opening reaches synthesis, transport, and history without the model."""
    baseline = await store.get("owner")
    assert f"You are {store.config.voice.assistant_name}," in (
        voice.pipeline.llm._settings.system_instruction
    )
    await ready(voice)
    instance, text = await spoken_opening(voice, synthesis, store, complete=False)
    assert store.config.voice.assistant_name in text
    assert voice_boundaries.transport_factory.call_args.args[2] == store.config.voice.assistant_name
    await render(instance, text)
    assert (await next_frame(voice.frames, TTSAudioRawFrame)).audio == b"\x01\x00" * 480
    assert (await next_frame(voice.frames, TTSTextFrame)).text.strip() == text
    await next_frame(voice.frames, TTSStoppedFrame)
    await asyncio.wait_for(synthesis.turns.get(), 2)
    assert any(
        message.get("role") == "assistant" and message.get("content", "").strip() == text
        for message in voice.pipeline.context.get_messages()
    )
    await ready(voice)
    await voice.pipeline.worker.queue_frame(LLMRunFrame())
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.1)
    assert synthesis.requests.empty()
    assert await store.get("owner") == baseline
    assert voice.pipeline.metrics.get("tool_calls", 0) == 0
    assert voice.pipeline.metrics.get("model_requests", 0) == 0
    assert voice.pipeline.metrics["openings"] == 1
    assert voice.pipeline.completed_turns == 0
    assert voice.pipeline.opening == "delivered"


async def test_user_first_preempts_opening_even_after_the_turn_finishes(voice, synthesis, store):
    """Verify user-first speech permanently preempts the call opening."""
    await voice.pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
    await asyncio.wait_for(voice.started.wait(), 2)
    await ready(voice)
    await recognize(voice, "I need help with rent.")
    await voice.pipeline.worker.queue_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
    request = await asyncio.wait_for(voice.requests.get(), voice.turn_timeout + 2)
    assert request["tool_choice"] == "required"
    await ready(voice)
    assert synthesis.requests.empty() and voice.pipeline.opening == "preempted"
    assert (await store.get("owner")).revision == 0


async def test_interrupted_intro_drops_late_audio_and_does_not_resume(voice, synthesis, store):
    """Verify an interrupted opening drops late audio and never resumes after user speech."""
    await ready(voice)
    instance, text = await spoken_opening(voice, synthesis, store, complete=False)
    await voice.pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
    await asyncio.wait_for(voice.started.wait(), 2)
    await next_frame(voice.frames, InterruptionFrame)
    await render(instance, text)
    await ready(voice)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(next_frame(voice.frames, TTSAudioRawFrame), 0.1)
    assert synthesis.requests.empty() and voice.requests.empty()
    assert voice.pipeline.opening == "preempted" and voice.pipeline.user_speaking


async def test_external_refresh_replaces_an_unheard_opening_without_waiting_for_user(
    voice, synthesis, store
):
    """Verify external refresh replaces an unheard opening without waiting for user input."""
    await ready(voice)
    await spoken_opening(voice, synthesis, store, complete=False)
    await voice.pipeline.tools.update_facts(
        {"expectedRevision": 0, "opening": money("100")}, "external"
    )
    await voice.pipeline.interrupt()
    await spoken_opening(voice, synthesis, store)
    await ready(voice)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.1)
    assert synthesis.requests.empty() and voice.pipeline.completed_turns == 0
    assert voice.pipeline.metrics["openings"] == 2 and voice.pipeline.opening == "delivered"
    assert (await store.get("owner")).revision == 1


async def test_external_refresh_does_not_replay_an_opening_already_heard(voice, synthesis, store):
    """Verify external refresh does not replay an opening once audio has been delivered."""
    await ready(voice)
    instance, _ = await spoken_opening(voice, synthesis, store, complete=False)
    await asyncio.to_thread(
        instance.synthesizing.connect.call_args.args[0],
        SimpleNamespace(result=SimpleNamespace(audio_data=b"\x01\x00" * 480)),
    )
    await next_frame(voice.frames, TTSAudioRawFrame)
    await voice.pipeline.tools.update_facts(
        {"expectedRevision": 0, "opening": money("100")}, "external"
    )
    await voice.pipeline.interrupt()
    await ready(voice)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.05)
    assert synthesis.requests.empty() and voice.pipeline.metrics["openings"] == 1


async def test_opening_guidance_cannot_restart_introduction_after_first_user_turn(
    voice, synthesis, store
):
    """Verify first-user-turn requests retain the spoken greeting and add no opening guidance."""
    await ready(voice)
    _, greeting = await spoken_opening(voice, synthesis, store)
    await asyncio.wait_for(synthesis.turns.get(), 2)
    await complete_turn(voice, "My rent is due before payday.")
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "required"
    assert not any(
        message.get("role") == "developer" and message.get("content") in opening_lines(store.config)
        for message in request["messages"]
    )
    assert any(
        message.get("role") == "assistant" and message.get("content", "").strip() == greeting
        for message in request["messages"]
    )


async def test_resume_guidance_does_not_repeat_on_the_next_user_response(voice):
    """Verify continuation guidance is removed from the next user-turn request."""
    voice.pipeline.context.add_message(
        {
            "role": "developer",
            "content": "The user chose Continue after a quiet pause. Keep existing facts.",
        }
    )
    await complete_turn(voice, "I can confirm my available cash is two thousand.")
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "required"
    assert not any(
        message.get("role") == "developer"
        and message.get("content", "").startswith("The user chose Continue after a quiet pause.")
        for message in request["messages"]
    )
