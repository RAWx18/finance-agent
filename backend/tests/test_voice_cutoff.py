# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio

import pytest
from pipecat.frames.frames import (
    BotStoppedSpeakingFrame,
    TTSAudioRawFrame,
    TTSStoppedFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregator
from pipecat.processors.frame_processor import FrameDirection

from app.voice_pipeline import RESUME_REPLY

from .conftest import money
from .test_voice_errors import text_reply
from .test_voice_opening import ready, render, spoken_opening
from .test_voice_opening import synthesis as synthesis
from .test_voice_turns import complete_turn, next_frame, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries

pytestmark = pytest.mark.parametrize(
    "voice", [{"speech_timeout_seconds": 0.3, "model_timeout_seconds": 5}], indirect=True
)


async def wordless_turn(voice):
    """Start and stop a user turn with speech activity but no recognized words."""
    user = next(item for item in voice.pipeline.processors if isinstance(item, LLMUserAggregator))
    # Pipecat's turn controller force-closes a wordless turn; shorten its backstop for the test.
    user._user_turn_controller._user_turn_stop_timeout = 0.3
    voice.started.clear()
    await voice.pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
    await asyncio.wait_for(voice.started.wait(), 2)
    await voice.pipeline.worker.queue_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
    turn = await asyncio.wait_for(voice.turns.get(), 5)
    assert not (turn.content or "").strip()


async def test_wordless_barge_in_resumes_a_reply_cut_off_mid_generation(voice, synthesis, store):
    """A wordless interruption during generation reruns the reply instead of going silent."""
    voice.pipeline.client_ready.set()
    voice.responses.put_nowait(
        tool_reply("update_facts", {"expectedRevision": 0, "opening": money("200")}, "saved")
    )
    await complete_turn(voice, "I have two hundred rupees.")
    assert (await asyncio.wait_for(voice.requests.get(), 2))["tool_choice"] == "required"
    # The second request stays pending on the provider until the barge-in cancels it.
    assert (await asyncio.wait_for(voice.requests.get(), 2))["tool_choice"] == "auto"
    response = "Your cash is saved. What is your next bill?"
    voice.responses.put_nowait(text_reply(response))
    await wordless_turn(voice)
    resumed = await asyncio.wait_for(voice.requests.get(), 2)
    assert resumed["tool_choice"] == "auto"
    assert {"role": "developer", "content": RESUME_REPLY} in resumed["messages"]
    assert [m["content"] for m in resumed["messages"] if m["role"] == "user"] == [
        "I have two hundred rupees."
    ]
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, response)
    await next_frame(voice.frames, TTSAudioRawFrame)
    assert voice.pipeline.metrics["resumed_replies"] == 1
    assert voice.pipeline.metrics["model_requests"] == 3
    assert voice.pipeline.metrics["tool_calls"] == 1
    assert not voice.pipeline.waiting and not voice.pipeline.revoked
    assert (await store.get("owner")).revision == 1
    voice.responses.put_nowait(tool_reply("read_state", {}, "next-read"))
    await complete_turn(voice, "Rent is two thousand.")
    following = await asyncio.wait_for(voice.requests.get(), 2)
    assert following["tool_choice"] == "required"
    assert not any(message.get("content") == RESUME_REPLY for message in following["messages"])


async def test_wordless_barge_in_after_a_finished_reply_stays_quiet(voice, synthesis, store):
    """A wordless sound after the assistant finished speaking does not trigger another reply."""
    voice.pipeline.client_ready.set()
    voice.responses.put_nowait(tool_reply("read_state", {}, "read"))
    response = "What is your next payment?"
    voice.responses.put_nowait(text_reply(response))
    await complete_turn(voice, "Please help me.")
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, response)
    await next_frame(voice.frames, TTSAudioRawFrame)
    await next_frame(voice.frames, TTSStoppedFrame)
    finished = asyncio.Event()

    async def observed(_, frame):
        """Signal once the bot-stopped frame has passed through the model service."""
        if isinstance(frame, BotStoppedSpeakingFrame):
            finished.set()

    voice.pipeline.llm.add_event_handler("on_after_process_frame", observed)
    await voice.pipeline.output.push_frame(BotStoppedSpeakingFrame(), FrameDirection.UPSTREAM)
    await asyncio.wait_for(finished.wait(), 2)
    assert not voice.pipeline.replying
    for _ in range(2):
        await asyncio.wait_for(voice.requests.get(), 2)
    await wordless_turn(voice)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.3)
    assert "resumed_replies" not in voice.pipeline.metrics
    assert voice.pipeline.metrics["model_requests"] == 2
    assert not voice.pipeline.waiting and not voice.pipeline.revoked
    assert (await store.get("owner")).revision == 0


async def test_wordless_barge_in_during_the_greeting_replays_the_opening(voice, synthesis, store):
    """A wordless sound that cuts off the greeting speaks the opening again without the model."""
    await ready(voice)
    await spoken_opening(voice, synthesis, store, complete=False)
    assert voice.pipeline.opening == "queued"
    await wordless_turn(voice)
    await spoken_opening(voice, synthesis, store)
    assert voice.pipeline.metrics["resumed_replies"] == 1
    assert voice.pipeline.metrics["openings"] == 2
    assert voice.pipeline.metrics.get("model_requests", 0) == 0
    assert voice.pipeline.metrics.get("tool_calls", 0) == 0
    assert not voice.pipeline.revoked and (await store.get("owner")).revision == 0
    assert voice.pipeline.metrics.get("tool_calls", 0) == 0
    assert not voice.pipeline.revoked and (await store.get("owner")).revision == 0
