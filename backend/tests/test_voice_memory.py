# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import httpx
import pytest
from pipecat.frames.frames import InterruptionFrame, TTSAudioRawFrame, TTSStoppedFrame
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregator

from app.memory import Memory
from app.speech import SpeechRecognition
from app.voice_pipeline import VoicePipeline
from app.voice_tools import conversation

from .test_auth_races import auth_server as auth_server
from .test_memory import memory as memory
from .test_memory import note
from .test_voice import environment
from .test_voice_errors import text_reply
from .test_voice_opening import ready, render
from .test_voice_opening import synthesis as synthesis
from .test_voice_turns import complete_turn, next_frame, tool_reply
from .test_voice_turns import voice_boundaries as voice_boundaries


@pytest.fixture
async def voice(memory, voice_boundaries, tmp_path, request):
    """Yield a fresh or resumed memory-enabled pipeline with mocked provider boundaries."""
    memory.store.config = memory.store.config.model_copy(
        update={
            "voice": memory.store.config.voice.model_copy(update={"speech_timeout_seconds": 0.1})
        }
    )
    pipeline = VoicePipeline()
    if getattr(request, "param", False):
        await memory.history.append(
            memory.owner,
            memory.call_id,
            "prior",
            "user",
            "Help me compare my options.",
            completed=True,
        )
        await memory.history.finish(memory.owner, memory.call_id)
        memory.call_id = uuid4()
        snapshot = await memory.store.get(memory.owner)
        await memory.history.start(memory.owner, memory.call_id, snapshot.session_id, memory.slug)
        memory.service = Memory(memory.store, memory.owner, memory.call_id)
        pipeline.resume_slug = memory.slug
        pipeline.resume_messages = await memory.history.recent(memory.owner, memory.call_id)
    failed = Mock()
    try:
        await pipeline.start(
            memory.store,
            memory.owner,
            memory.call_id,
            "https://test.daily.co/room",
            "test-token",
            environment(tmp_path),
            failed,
            lambda: None,
        )
        await asyncio.wait_for(pipeline.started.wait(), 2)
        await pipeline.llm._client._client.aclose()
        pipeline.llm._client._client = httpx.AsyncClient(
            transport=httpx.MockTransport(voice_boundaries.respond)
        )
        aggregator = next(
            item for item in pipeline.processors if isinstance(item, LLMUserAggregator)
        )
        turns = asyncio.Queue()
        aggregator.add_event_handler(
            "on_user_turn_stopped", lambda _, __, message: turns.put_nowait(message)
        )
        yield SimpleNamespace(
            pipeline=pipeline,
            frames=voice_boundaries.frames,
            requests=voice_boundaries.requests,
            responses=voice_boundaries.responses,
            turns=turns,
            turn_timeout=memory.store.config.voice.speech_timeout_seconds,
            stt=next(item for item in pipeline.processors if isinstance(item, SpeechRecognition)),
        )
    finally:
        await pipeline.close()
    failed.assert_not_called()


def remembered(request):
    """Extract the request's single conversational-memory payload."""
    messages = [
        text
        for message in request["messages"]
        if isinstance(text := message.get("content"), str)
        and text.startswith("Conversational memory;")
    ]
    assert len(messages) == 1
    return json.loads(messages[0].split("\n", 1)[1])


@pytest.mark.parametrize("voice", [False, True], indirect=True, ids=["fresh", "resumed"])
async def test_profile_and_scoped_notes_reach_opening_and_refresh_without_context_copies(
    voice, synthesis, memory
):
    """Verify profile and scoped notes reach requests without persisting copies in context."""
    await memory.application.state.auth.rename(memory.owner, "Ananya")
    for scope, text in (
        ("common", "Prefer concise replies."),
        ("user", "Remember that I am learning financial vocabulary."),
        ("chat", "Explain the choices before asking for a decision."),
    ):
        await memory.service.update(note(scope, text), text)
    before = await memory.store.get(memory.owner)
    greeting = "Hello Ananya, what would you like to discuss?"
    voice.responses.put_nowait(text_reply(greeting))
    await ready(voice)
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "none"
    assert remembered(request) == await memory.service.read()
    assert memory.profile["email"] not in json.dumps(request["messages"])
    assert not any(
        message.get("content", "").startswith("Conversational memory;")
        for message in voice.pipeline.context.get_messages()
    )
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, greeting)
    await next_frame(voice.frames, TTSAudioRawFrame)
    await next_frame(voice.frames, TTSStoppedFrame)
    await asyncio.wait_for(synthesis.turns.get(), 2)
    assert await memory.store.get(memory.owner) == before
    await memory.application.state.auth.rename(memory.owner, "Anu")
    await complete_turn(voice, "Let's continue.")
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert remembered(request)["common"]["profile"]["name"] == "Anu"


async def test_memory_tool_saves_and_forgets_current_preference_without_financial_write(
    voice, synthesis, memory
):
    """Verify memory tools save and forget current preferences without financial writes."""
    before = await memory.store.get(memory.owner)
    user = "I prefer short, plain English replies."
    change = note("common", "Prefers short, plain English replies.", evidence=user)
    voice.responses.put_nowait(tool_reply("update_memory", change.model_dump(), "remember"))
    voice.responses.put_nowait(text_reply("I'll keep my replies short and clear."))
    await complete_turn(voice, user)
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "required"
    assert remembered(request)["common"]["notes"] == []
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "auto"
    assert remembered(request)["common"]["notes"] == [{"key": change.key, "text": change.text}]
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "I'll keep my replies short and clear.")
    await next_frame(voice.frames, TTSStoppedFrame)
    await asyncio.wait_for(synthesis.turns.get(), 2)
    assert await memory.store.get(memory.owner) == before
    assert voice.pipeline.tools.written_sequence == -1
    assert voice.pipeline.metrics["tool_calls"] == 1
    change = note("common", None, evidence="Forget my saved reply preference.")
    voice.responses.put_nowait(tool_reply("update_memory", change.model_dump(), "forget"))
    voice.responses.put_nowait(text_reply("I have forgotten that preference."))
    await complete_turn(voice, change.evidence)
    await asyncio.wait_for(voice.requests.get(), 2)
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert remembered(request)["common"]["notes"] == []
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "I have forgotten that preference.")
    await next_frame(voice.frames, TTSStoppedFrame)
    assert await memory.store.get(memory.owner) == before


async def test_memory_key_validation_can_recover_without_financial_writes(voice, synthesis, memory):
    """Verify memory-key validation permits a corrected retry without financial writes."""
    before = await memory.store.get(memory.owner)
    user = "Please remember that I prefer short, plain English replies."
    change = note(
        "common", "Prefers short, plain English replies.", key="replyStyle", evidence=user
    )
    voice.responses.put_nowait(
        tool_reply("update_memory", {**change.model_dump(), "key": "reply_style"}, "invalid")
    )
    voice.responses.put_nowait(tool_reply("update_memory", change.model_dump(), "remember"))
    voice.responses.put_nowait(text_reply("I'll remember to keep my replies short and clear."))
    await complete_turn(voice, user)
    requests = [await asyncio.wait_for(voice.requests.get(), 2) for _ in range(3)]
    assert [request["tool_choice"] for request in requests] == ["required", "auto", "auto"]
    schema = next(
        tool["function"]
        for tool in requests[0]["tools"]
        if tool["function"]["name"] == "update_memory"
    )
    assert "lowerCamelCase" in schema["parameters"]["properties"]["key"]["description"]
    result = next(message for message in requests[1]["messages"] if message["role"] == "tool")
    assert "lowerCamelCase" in json.loads(result["content"])["message"]
    assert remembered(requests[1])["common"]["notes"] == []
    assert remembered(requests[2])["common"]["notes"] == [{"key": change.key, "text": change.text}]
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "I'll remember to keep my replies short and clear.")
    await next_frame(voice.frames, TTSStoppedFrame)
    assert await memory.store.get(memory.owner) == before
    assert voice.pipeline.tools.written_sequence == -1


async def test_historical_user_text_does_not_authorize_new_memory(voice, synthesis, memory):
    """Verify historical user text cannot authorize a memory write for the current turn."""
    historical = "I prefer long explanations."
    voice.pipeline.context.add_message({"role": "user", "content": historical})
    change = note("common", historical)
    voice.responses.put_nowait(tool_reply("update_memory", change.model_dump(), "replay"))
    voice.responses.put_nowait(text_reply("What would you like to discuss?"))
    await complete_turn(voice, "Hello.")
    await asyncio.wait_for(voice.requests.get(), 2)
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert remembered(request)["common"]["notes"] == []
    result = next(message for message in request["messages"] if message["role"] == "tool")
    assert json.loads(result["content"])["code"] == "invalidMemory"
    assert (await memory.service.read())["common"]["notes"] == []
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "What would you like to discuss?")
    await next_frame(voice.frames, TTSStoppedFrame)


async def test_interruption_discards_current_memory_authorization(voice, memory):
    """Verify interruption clears current-turn evidence and rejects late memory writes."""
    voice.pipeline.tools.user_turn = "I prefer short replies."
    await voice.pipeline.worker.queue_frame(InterruptionFrame())
    await next_frame(voice.frames, InterruptionFrame)
    assert voice.pipeline.tools.user_turn == ""
    change = note("common", "I prefer short replies.")
    result = await voice.pipeline.tools.invoke("update_memory", change.model_dump(), "late")
    assert result["code"] == "invalidMemory"
    assert (await memory.service.read())["common"]["notes"] == []


def test_memory_policy_is_conversational_not_financial_authority(config):
    """Verify memory guidance limits authority to explicit conversational preferences."""
    prompt = conversation(config)
    for rule in (
        "common.profile.name",
        "not in every reply",
        "user.notes",
        "chat.notes",
        "explicitly asks",
        "never an assistant message or restored history",
        "Do not copy old facts",
        "Set text:null",
        "Do not evade",
    ):
        assert rule in prompt
