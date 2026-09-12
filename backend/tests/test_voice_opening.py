# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from xml.etree import ElementTree

import pytest
from pipecat.frames.frames import (
    InterruptionFrame,
    LLMRunFrame,
    TTSAudioRawFrame,
    TTSStoppedFrame,
    TTSTextFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_response_universal import LLMAssistantAggregator

from app.voice_pipeline import RESUME, VoicePipeline
from app.voice_tools import introduction

from .conftest import money
from .test_voice_errors import text_reply
from .test_voice_turns import complete_turn, next_frame, recognize, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries


@pytest.fixture
def synthesis(voice, monkeypatch):
    requests = asyncio.Queue()
    turns = asyncio.Queue()

    def create(**kwargs):
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
    await voice.pipeline.worker.rtvi._call_event_handler("on_client_ready")


@pytest.fixture
def resumed_dialogue(monkeypatch):
    messages = [
        {"role": "user", "content": "My salary is five lakh. I am worried about rent."},
        {"role": "assistant", "content": "Does your salary arrive before rent is due?"},
        {"role": "user", "content": "It comes after rent. Change that five lakh to six lakh."},
    ]
    initialize = VoicePipeline.__init__

    def resumed(pipeline):
        initialize(pipeline)
        pipeline.resume_slug = "conversation-2026-09-11-060000"
        pipeline.resume_messages = [dict(message) for message in messages]

    monkeypatch.setattr(VoicePipeline, "__init__", resumed)
    return messages


async def test_reconnect_uses_recent_dialogue_without_reintroducing_or_replaying_writes(
    resumed_dialogue, voice, synthesis, store
):
    await voice.pipeline.tools.update_facts(
        {"expectedRevision": 0, "opening": money("600000")}, "saved-before-reconnect"
    )
    baseline = await store.get("owner")
    response = "Yeah, let's continue with rent before payday."
    voice.responses.put_nowait(text_reply(response))
    await ready(voice)
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "none"
    assert all(message in request["messages"] for message in resumed_dialogue)
    assert {"role": "developer", "content": introduction(store.config)} not in request["messages"]
    assert {"role": "developer", "content": RESUME} in request["messages"]
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, response)
    await next_frame(voice.frames, TTSAudioRawFrame)
    await next_frame(voice.frames, TTSStoppedFrame)
    await asyncio.wait_for(synthesis.turns.get(), 2)
    assert await store.get("owner") == baseline
    assert voice.pipeline.metrics.get("tool_calls", 0) == 0
    assert voice.pipeline.completed_turns == 2
    await ready(voice)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.05)


@pytest.mark.parametrize(
    "voice",
    [
        {},
        {
            "assistant_name": "Mira",
            "introduction": "Hello, I'm {assistant_name}. Tell me your concern.",
        },
    ],
    indirect=True,
)
async def test_model_opening_reaches_synthesis_transport_and_history_once(
    voice, synthesis, store, voice_boundaries
):
    baseline = await store.get("owner")
    assert f"You are {store.config.voice.assistant_name}," in (
        voice.pipeline.llm._settings.system_instruction
    )
    greeting = (
        f"Hello from {store.config.voice.assistant_name}, what money concern is on your mind?"
    )
    voice.responses.put_nowait(text_reply(greeting))
    await ready(voice)
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "none"
    assert not any(message["role"] == "user" for message in request["messages"])
    assert {"role": "developer", "content": introduction(store.config)} in request["messages"]
    instance, ssml = await asyncio.wait_for(synthesis.requests.get(), 2)
    text = "".join(ElementTree.fromstring(ssml).itertext())
    assert text == greeting and text != introduction(store.config)
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
    assert voice.pipeline.metrics["model_requests"] == 1
    assert voice.pipeline.completed_turns == 0
    assert voice.pipeline.opening == "delivered"


async def test_user_first_preempts_opening_even_after_the_turn_finishes(voice, synthesis, store):
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


async def test_interrupted_intro_drops_late_audio_and_does_not_resume(voice, synthesis):
    voice.responses.put_nowait(text_reply("Hello, what would you like to work through?"))
    await ready(voice)
    await asyncio.wait_for(voice.requests.get(), 2)
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await voice.pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
    await asyncio.wait_for(voice.started.wait(), 2)
    await next_frame(voice.frames, InterruptionFrame)
    await render(instance, "An interrupted introduction must not resume.")
    await ready(voice)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(next_frame(voice.frames, TTSAudioRawFrame), 0.1)
    assert synthesis.requests.empty() and voice.requests.empty()
    assert voice.pipeline.opening == "preempted" and voice.pipeline.user_speaking


async def test_external_refresh_replaces_an_unheard_opening_without_waiting_for_user(
    voice, synthesis, store
):
    voice.responses.put_nowait(text_reply("Hello, what money concern is on your mind?"))
    await ready(voice)
    await asyncio.wait_for(voice.requests.get(), 2)
    await asyncio.wait_for(synthesis.requests.get(), 2)
    await voice.pipeline.tools.update_facts(
        {"expectedRevision": 0, "opening": money("100")}, "external"
    )
    voice.responses.put_nowait(text_reply("Hi, I'm Isha; what's worrying you about money?"))
    await voice.pipeline.interrupt()
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "none"
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "Hi, I'm Isha; what's worrying you about money?")
    await next_frame(voice.frames, TTSAudioRawFrame)
    await next_frame(voice.frames, TTSStoppedFrame)
    await ready(voice)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.1)
    assert synthesis.requests.empty() and voice.pipeline.completed_turns == 0
    assert (await store.get("owner")).revision == 1


async def test_external_refresh_does_not_replay_an_opening_already_heard(voice, synthesis):
    voice.responses.put_nowait(text_reply("Hello, what money concern is on your mind?"))
    await ready(voice)
    await asyncio.wait_for(voice.requests.get(), 2)
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
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
    assert synthesis.requests.empty()


async def test_first_request_refresh_still_completes_one_opening(voice, synthesis, monkeypatch):
    with monkeypatch.context() as patch:
        patch.setattr(voice.pipeline.tools, "refresh", lambda snapshot: None)
        await voice.pipeline.tools.update_facts(
            {"expectedRevision": 0, "opening": money("100")}, "external"
        )
    greeting = "Hi, I'm Isha; what's worrying you about money?"
    voice.responses.put_nowait(text_reply(greeting))
    await ready(voice)
    assert (await asyncio.wait_for(voice.requests.get(), 2))["tool_choice"] == "none"
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, greeting)
    await next_frame(voice.frames, TTSAudioRawFrame)
    await next_frame(voice.frames, TTSStoppedFrame)
    assert voice.pipeline.opening == "delivered"
    await voice.pipeline.worker.queue_frame(LLMRunFrame())
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.05)


@pytest.mark.parametrize("tool", ["read_state", "update_facts"])
async def test_opening_rejects_provider_tools_without_speech_or_write(voice, store, tool):
    baseline = await store.get("owner")
    voice.expect_failure = True
    failed = asyncio.Event()
    voice.failed.side_effect = failed.set
    voice.responses.put_nowait(
        tool_reply(
            tool,
            {} if tool == "read_state" else {"expectedRevision": 0, "opening": money("999")},
            "opening-tool",
        )
    )
    await ready(voice)
    assert (await asyncio.wait_for(voice.requests.get(), 2))["tool_choice"] == "none"
    await asyncio.wait_for(failed.wait(), 2)
    assert voice.pipeline.revoked and not voice.pipeline.context.get_messages()
    assert voice.pipeline.metrics.get("tool_calls", 0) == 0
    assert await store.get("owner") == baseline
    voice.synthesizer.speak_ssml_async.assert_not_called()


async def test_opening_guidance_cannot_restart_introduction_after_first_user_turn(
    voice, synthesis, store
):
    greeting = "Hello, what would you like help with?"
    voice.responses.put_nowait(text_reply(greeting))
    await ready(voice)
    await asyncio.wait_for(voice.requests.get(), 2)
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, greeting)
    await next_frame(voice.frames, TTSStoppedFrame)
    await asyncio.wait_for(synthesis.turns.get(), 2)
    await complete_turn(voice, "My rent is due before payday.")
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "required"
    assert not any(
        message.get("role") == "developer" and message.get("content") == introduction(store.config)
        for message in request["messages"]
    )
    assert any(
        message.get("role") == "assistant" and message.get("content", "").strip() == greeting
        for message in request["messages"]
    )


async def test_resume_guidance_does_not_repeat_on_the_next_user_response(voice):
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
