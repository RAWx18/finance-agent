# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from datetime import timedelta
from types import SimpleNamespace

import httpx
import pytest
from pipecat.frames.frames import LLMRunFrame, TTSAudioRawFrame, TTSStoppedFrame

from .conftest import money
from .test_voice_errors import text_reply
from .test_voice_opening import render
from .test_voice_opening import synthesis as synthesis
from .test_voice_turns import complete_turn, next_frame, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries
from .test_voice_waiting import next_state


@pytest.mark.parametrize(
    "voice",
    [
        {
            "speech_timeout_seconds": 0.03,
            "model_timeout_seconds": 0.25,
            "tts_first_audio_seconds": 0.25,
            "tts_progress_seconds": 0.25,
        }
    ],
    indirect=True,
)
@pytest.mark.parametrize("stage", ["model", "synthesis"])
async def test_progressing_response_does_not_pause_and_next_turn_still_works(
    voice, synthesis, store, stage
):
    """Verify progressing model or synthesis output avoids waiting and allows the next turn."""
    voice.pipeline.client_ready.set()
    response = "Your cash is recorded, and we can review the next payment."

    class Stream(httpx.AsyncByteStream):
        """Synthetic completion stream with regularly progressing text chunks."""

        async def __aiter__(self):
            """Yield paced text deltas followed by a completed response."""
            for text in (
                "Your cash ",
                "is recorded, ",
                "and we can ",
                "review the ",
                "next payment.",
            ):
                chunk = json.loads(text_reply(text).text.split("\n", 1)[0][6:])
                chunk["choices"][0]["finish_reason"] = None
                yield f"data: {json.dumps(chunk)}\n\n".encode()
                await asyncio.sleep(0.08)
            yield text_reply("").content

    voice.responses.put_nowait(
        tool_reply("update_facts", {"expectedRevision": 0, "opening": money("200")}, "save")
    )
    voice.responses.put_nowait(
        httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Stream())
        if stage == "model"
        else text_reply(response)
    )
    await complete_turn(voice, "I have two hundred rupees.")
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    if stage == "synthesis":
        for _ in range(6):
            instance.synthesizing.connect.call_args.args[0](
                SimpleNamespace(result=SimpleNamespace(audio_data=b"\x01\x00" * 480))
            )
            await asyncio.sleep(0.08)
            assert not voice.pipeline.waiting, voice.pipeline.metrics
        instance.synthesis_word_boundary.connect.call_args.args[0](
            SimpleNamespace(text=response, audio_offset=0)
        )
        instance.synthesis_completed.connect.call_args.args[0](
            SimpleNamespace(result=SimpleNamespace(audio_duration=timedelta(milliseconds=120)))
        )
    else:
        await render(instance, response)
    await next_frame(voice.frames, TTSAudioRawFrame)
    await next_frame(voice.frames, TTSStoppedFrame)
    await asyncio.wait_for(synthesis.turns.get(), 2)
    assert not voice.pipeline.waiting and not voice.pipeline.revoked
    assert voice.pipeline.metrics.get("response_failures", 0) == 0
    assert voice.pipeline.metrics.get("model_empty", 0) == 0
    baseline = await store.get("owner")
    assert baseline.revision == 1 and baseline.facts.opening.amount_paise == 20000

    voice.responses.put_nowait(tool_reply("read_state", {}, "read"))
    voice.responses.put_nowait(text_reply("Your saved cash is still two hundred rupees."))
    await complete_turn(voice, "What cash did you save?")
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "Your saved cash is still two hundred rupees.")
    await next_frame(voice.frames, TTSStoppedFrame)
    assert not voice.pipeline.waiting and not voice.pipeline.revoked
    assert await store.get("owner") == baseline
    assert voice.pipeline.metrics["tool_calls"] == 2


@pytest.mark.parametrize("voice", [{"speech_timeout_seconds": 0.03}], indirect=True)
async def test_superseded_empty_completion_cannot_pause_current_audio(
    voice, synthesis, monkeypatch
):
    """Verify deferred empty-response handling cannot pause newer audio in the same generation."""
    voice.pipeline.client_ready.set()
    reached, release = asyncio.Event(), asyncio.Event()
    create_task = voice.pipeline.llm.create_task

    def delayed(coroutine, name=None):
        """Delay empty-response tasks while forwarding other task creation."""
        if name != "empty-response":
            return create_task(coroutine, name)

        async def run():
            """Signal deferred task entry and await release before running its coroutine."""
            reached.set()
            await release.wait()
            await coroutine

        return create_task(run(), name)

    monkeypatch.setattr(voice.pipeline.llm, "create_task", delayed)
    voice.responses.put_nowait(tool_reply("read_state", {}, "read"))
    voice.responses.put_nowait(text_reply(""))
    await complete_turn(voice, "Please help me.")
    await asyncio.wait_for(reached.wait(), 2)
    generation = voice.pipeline.generation
    response = "We can work through your next payment."
    voice.responses.put_nowait(text_reply(response))
    await voice.pipeline.worker.queue_frame(LLMRunFrame())
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    instance.synthesizing.connect.call_args.args[0](
        SimpleNamespace(result=SimpleNamespace(audio_data=b"\x01\x00" * 480))
    )
    await next_frame(voice.frames, TTSAudioRawFrame)
    assert voice.pipeline.generation == generation
    release.set()
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(next_state(voice), 0.1)
    assert not voice.pipeline.waiting
    await render(instance, response)
    await next_frame(voice.frames, TTSStoppedFrame)
    assert voice.pipeline.metrics["model_requests"] == 3
    assert voice.pipeline.metrics["tool_calls"] == 1


@pytest.mark.parametrize(
    "voice", [{"speech_timeout_seconds": 0.03, "model_timeout_seconds": 0.5}], indirect=True
)
@pytest.mark.parametrize(
    "delta",
    [{"role": "assistant"}, {"tool_calls": [{"index": 0, "function": {"arguments": ""}}]}],
    ids=["role", "emptyTool"],
)
async def test_keepalive_frames_do_not_hide_a_lost_response(voice, store, delta):
    """Verify nonprogressing keepalive deltas still trigger recoverable response waiting."""
    voice.pipeline.client_ready.set()
    closed = asyncio.Event()

    class Stream(httpx.AsyncByteStream):
        """Synthetic completion stream containing only nonprogressing keepalive deltas."""

        async def __aiter__(self):
            """Emit the supplied empty delta repeatedly without meaningful response progress."""
            chunk = json.loads(text_reply("").text.split("\n", 1)[0][6:])
            chunk["choices"][0].update(delta=delta, finish_reason=None)
            while True:
                yield f"data: {json.dumps(chunk)}\n\n".encode()
                await asyncio.sleep(0.04)

        async def aclose(self):
            """Signal closure of the keepalive-only response stream."""
            closed.set()

    voice.responses.put_nowait(
        httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Stream())
    )
    await complete_turn(voice, "Please help me plan.")
    assert (await next_state(voice))["reason"] == "response"
    await asyncio.wait_for(closed.wait(), 2)
    assert not voice.pipeline.revoked
    assert voice.pipeline.metrics.get("published_audio", 0) == 0
    assert (await store.get("owner")).revision == 0
