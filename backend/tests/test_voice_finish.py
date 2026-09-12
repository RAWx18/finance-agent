# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio

from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    FunctionCallResultFrame,
    TTSAudioRawFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)

from .test_voice_errors import text_reply
from .test_voice_opening import render
from .test_voice_opening import synthesis as synthesis
from .test_voice_turns import next_frame, recognize, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries
from .test_voice_waiting import active as active
from .test_voice_waiting import config as config
from .test_voice_waiting import next_state


async def test_end_conversation_closes_the_call_after_the_goodbye_has_played(
    active, synthesis, store
):
    """Verify the finish tool pauses the call with a finished reason only once the goodbye ends."""
    pipeline = active.pipeline
    baseline = await store.get("owner")
    active.responses.put_nowait(tool_reply("end_conversation", {}, "bye"))
    active.responses.put_nowait(text_reply("Goodbye, take care."))
    await pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
    await asyncio.wait_for(active.started.wait(), 2)
    await recognize(active, "No thanks, that is all. Bye.")
    await pipeline.worker.queue_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
    request = await asyncio.wait_for(
        active.requests.get(), store.config.voice.speech_timeout_seconds + 1
    )
    assert any(tool["function"]["name"] == "end_conversation" for tool in request["tools"])
    result = await next_frame(active.frames, FunctionCallResultFrame)
    assert result.tool_call_id == "bye"
    assert result.result["ending"] is True
    assert pipeline.tools is not None and pipeline.tools.ending
    assert not pipeline.waiting
    await asyncio.wait_for(active.requests.get(), 2)
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "Goodbye, take care.")
    await next_frame(active.frames, TTSAudioRawFrame)
    sequence = pipeline.state_sequence
    await pipeline.worker.queue_frames([BotStartedSpeakingFrame(), BotStoppedSpeakingFrame()])
    assert await next_state(active) == {
        "type": "conversation-state",
        "state": "waiting",
        "sequence": sequence + 1,
        "reason": "finished",
        "autoRetry": False,
    }
    assert pipeline.waiting and pipeline.wait_reason == "finished"
    assert not pipeline.tools.ending
    assert pipeline.metrics["finished"] == 1
    assert await store.get("owner") == baseline
