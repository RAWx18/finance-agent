# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from pipecat.frames.frames import LLMRunFrame, TTSAudioRawFrame, TTSStoppedFrame
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregator

from app.history import History
from app.models import Command
from app.speech import SpeechRecognition
from app.voice_pipeline import RESUME

from .conftest import money
from .test_voice_errors import lifecycle as lifecycle
from .test_voice_errors import text_reply
from .test_voice_opening import opening_lines, ready, render, spoken_opening
from .test_voice_opening import synthesis as synthesis
from .test_voice_turns import complete_turn, next_frame, tool_reply
from .test_voice_turns import voice_boundaries as voice_boundaries


@pytest.fixture
async def voice(lifecycle, voice_boundaries, store):
    """Yield a resumed call for one of two saved chats using isolated voice boundaries."""
    store.config = store.config.model_copy(
        update={"voice": store.config.voice.model_copy(update={"speech_timeout_seconds": 0.1})}
    )
    history = History(store)
    slugs = []
    for name, amount in (("rent", "1111"), ("travel", "9999")):
        media_id = uuid4()
        slug = await history.start("owner", media_id, (await store.get("owner")).session_id)
        slugs.append(slug)
        snapshot = await store.get("owner")
        await store.command(
            "owner",
            Command.model_validate(
                {
                    "commandId": str(uuid4()),
                    "expectedRevision": snapshot.revision,
                    "operation": {
                        "type": "updateFacts",
                        "changes": {
                            "expectedRevision": snapshot.revision,
                            "opening": money(amount),
                        },
                    },
                }
            ),
        )
        await history.append(
            "owner", media_id, "user-1", "user", f"Help me with {name}.", completed=True
        )
        await history.append(
            "owner",
            media_id,
            "assistant-1",
            "assistant",
            f"We were discussing {name}",
            completed=False,
        )
        await history.finish("owner", media_id)
    baseline = await lifecycle.manager.select("owner", slugs[0])
    join = await lifecycle.manager.start("owner", uuid4(), slugs[0])
    pipeline = lifecycle.manager.call.pipeline
    await asyncio.wait_for(pipeline.started.wait(), 2)
    pipeline.joined.set()
    await pipeline.llm._client._client.aclose()
    pipeline.llm._client._client = httpx.AsyncClient(
        transport=httpx.MockTransport(voice_boundaries.respond)
    )
    turns = asyncio.Queue()
    aggregator = next(item for item in pipeline.processors if isinstance(item, LLMUserAggregator))
    aggregator.add_event_handler(
        "on_user_turn_stopped", lambda _, __, message: turns.put_nowait(message)
    )
    yield SimpleNamespace(
        pipeline=pipeline,
        frames=voice_boundaries.frames,
        requests=voice_boundaries.requests,
        responses=voice_boundaries.responses,
        stt=next(item for item in pipeline.processors if isinstance(item, SpeechRecognition)),
        turns=turns,
        turn_timeout=store.config.voice.speech_timeout_seconds,
        baseline=baseline,
        slug=join.conversation_slug,
        other_slug=slugs[1],
    )
    await lifecycle.manager.end("owner", join.call_id)


async def test_selected_chat_catchup_is_readonly_and_never_replays_history(voice, synthesis, store):
    """Verify selected-chat catch-up uses only its dialogue without writes or history replay."""
    before = await History(store).get("owner", voice.slug)
    voice.responses.put_nowait(text_reply("We were discussing rent; when is it due?"))
    await voice.pipeline.worker.queue_frame(LLMRunFrame())
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.05)
    await ready(voice)
    _, welcome = await spoken_opening(voice, synthesis, store, resumed=True)
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "none"
    messages = request["messages"]
    assert {"role": "developer", "content": RESUME} in messages
    assert not any(
        message["content"] in opening_lines(store.config)
        for message in messages
        if message["role"] == "developer"
    )
    assert {"role": "user", "content": "Help me with rent."} in messages
    assert {"role": "assistant", "content": "We were discussing rent"} in messages
    assert "Help me with travel." not in json.dumps(messages)
    assert not any(message["role"] == "tool" for message in messages)
    canonical = next(
        message["content"]
        for message in messages
        if message["content"].startswith("Canonical application state;")
    )
    assert json.loads(canonical.split("\n", 1)[1])["snapshot"]["facts"]["opening"] == (
        voice.baseline.facts.opening.model_dump(mode="json", by_alias=True)
    )
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "We were discussing rent; when is it due?")
    await next_frame(voice.frames, TTSAudioRawFrame)
    await next_frame(voice.frames, TTSStoppedFrame)
    await asyncio.wait_for(synthesis.turns.get(), 2)
    assert await store.get("owner") == voice.baseline
    assert (await History(store).get("owner", voice.slug)).messages == before.messages
    assert voice.pipeline.metrics.get("tool_calls", 0) == 0
    await ready(voice)
    await voice.pipeline.worker.queue_frame(LLMRunFrame())
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.05)


async def test_resumed_opening_rejects_financial_tool_replay(voice, synthesis, store):
    """Verify resumed catch-up rejects scripted financial tool replay without changing facts."""
    voice.responses.put_nowait(
        tool_reply(
            "update_facts",
            {"expectedRevision": voice.baseline.revision, "opening": money("7777")},
            "replayed-write",
        )
    )
    await ready(voice)
    await spoken_opening(voice, synthesis, store, complete=False, resumed=True)
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "none"
    await asyncio.wait_for(voice.pipeline.task, 2)
    assert voice.pipeline.revoked and voice.pipeline.metrics.get("tool_calls", 0) == 0
    assert await store.get("owner") == voice.baseline


async def test_fresh_user_turn_can_correct_a_without_changing_b(voice, synthesis, store):
    """Verify a fresh user correction changes only the selected conversation's saved facts."""
    voice.responses.put_nowait(text_reply("We were discussing rent; what is next?"))
    await ready(voice)
    await spoken_opening(voice, synthesis, store, resumed=True)
    await asyncio.wait_for(voice.requests.get(), 2)
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "We were discussing rent; what is next?")
    await next_frame(voice.frames, TTSStoppedFrame)
    await asyncio.wait_for(synthesis.turns.get(), 2)
    voice.responses.put_nowait(
        tool_reply(
            "update_facts",
            {"expectedRevision": voice.baseline.revision, "opening": money("2222")},
            "current-correction",
        )
    )
    voice.responses.put_nowait(
        text_reply("Your available cash is two thousand two hundred twenty two.")
    )
    await complete_turn(
        voice, "Correction, my available cash is two thousand two hundred twenty two."
    )
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "required"
    assert {"role": "developer", "content": RESUME} not in request["messages"]
    assert "Help me with travel." not in json.dumps(request["messages"])
    await asyncio.wait_for(synthesis.requests.get(), 2)
    current = await store.get("owner")
    assert current.revision == voice.baseline.revision + 1
    assert current.facts.opening.amount_paise == 222200
    assert current.conversation_slug == voice.slug
    assert voice.pipeline.metrics["tool_calls"] == 1
    assert voice.pipeline.saved_turns == 1 and voice.pipeline.completed_turns == 2
    async with store.lock:
        _, other = await History(store).memory("owner", voice.other_slug, current)
    assert other.facts.opening.amount_paise == 999900


async def test_user_first_after_reconnect_preempts_catchup(voice, synthesis):
    """Verify user-first input after reconnect preempts catch-up guidance and speech."""
    voice.responses.put_nowait(tool_reply("read_state", {}, "current-question"))
    await complete_turn(voice, "Before we continue, what do you have saved?")
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "required"
    assert {"role": "developer", "content": RESUME} not in request["messages"]
    await ready(voice)
    assert voice.pipeline.opening == "preempted"
    assert synthesis.requests.empty()
