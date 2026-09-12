# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from pipecat.frames.frames import (
    InputAudioRawFrame,
    InterruptionFrame,
    LLMRunFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.processors.frameworks.rtvi.models import ClientMessage
from pydantic import ValidationError

from app.config import load_config
from app.voice_tools import FinancialWrite

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
            "model_timeout_seconds": 0.5,
            "tts_first_audio_seconds": 0.2,
            "tts_progress_seconds": 0.2,
            "response_retry_delay_seconds": 0.1,
        }
    ],
    indirect=True,
)


async def acknowledge(voice, state):
    """Acknowledge only the offered retry's active and waiting sequence pair."""
    await voice.pipeline.worker.rtvi._call_event_handler(
        "on_client_message",
        ClientMessage(
            msg_id=str(uuid4()),
            type="acknowledge-response-retry",
            data={"sequence": state["sequence"], "retryOf": state["retryOf"]},
        ),
    )


@pytest.mark.parametrize("cause", ["timeout", "connection", 408, 429, 500, 502, 503, 504])
@pytest.mark.parametrize("committed", [False, True])
async def test_transient_response_retries_read_only_after_ack(
    voice, synthesis, store, cause, committed, caplog
):
    """Recover in the same worker after settlement without replaying a financial command."""
    pipeline = voice.pipeline
    pipeline.client_ready.set()
    identity = pipeline.worker, pipeline.task, pipeline.context
    requests = []
    closed = asyncio.Event()

    class Stream(httpx.AsyncByteStream):
        """Keep a partial provider stream open until timeout cancellation."""

        async def __aiter__(self):
            """Emit incomplete text and stall."""
            yield text_reply("Discard this partial answer.").content.replace(
                b"data: [DONE]\n\n", b""
            )
            await asyncio.Event().wait()

        async def aclose(self):
            """Record actual provider-stream settlement."""
            closed.set()

    async def model(request):
        """Return a committed write, one transient fault, then read-only speech."""
        body = json.loads(request.content)
        requests.append(body)
        if committed and len(requests) == 1:
            return tool_reply(
                "update_facts", {"expectedRevision": 0, "opening": money("200")}, "once"
            )
        if len(requests) == int(committed) + 1:
            if cause == "timeout":
                return httpx.Response(
                    200, headers={"content-type": "text/event-stream"}, stream=Stream()
                )
            if cause == "connection":
                raise httpx.ConnectError("private-provider-body", request=request)
            return httpx.Response(cause, json={"error": {"message": "private-provider-body"}})
        assert body["tool_choice"] == "none"
        assert not any(message["role"] == "tool" for message in body["messages"])
        assert "Discard this partial answer" not in json.dumps(body)
        return text_reply("Let's review the next payment.")

    await pipeline.llm._client._client.aclose()
    pipeline.llm._client._client = httpx.AsyncClient(transport=httpx.MockTransport(model))
    await complete_turn(voice, "I have two hundred rupees.")
    waiting = await next_state(voice)
    assert waiting["autoRetry"] is True and waiting["reason"] == "response"
    if cause == "timeout":
        assert closed.is_set()
    baseline = await store.get("owner")
    active = await next_state(voice)
    assert active == {
        "type": "conversation-state",
        "state": "active",
        "reason": "retry",
        "sequence": waiting["sequence"] + 1,
        "retryOf": waiting["sequence"],
    }
    assert pipeline.waiting
    gate = next(item for item in pipeline.processors if type(item).__name__ == "InputGate")
    push = gate.push_frame
    gate.push_frame = AsyncMock(wraps=push)
    await gate.process_frame(
        InputAudioRawFrame(audio=b"\x00\x00", sample_rate=16000, num_channels=1),
        FrameDirection.DOWNSTREAM,
    )
    await gate.process_frame(
        TranscriptionFrame("Do not admit this turn.", "user", ""), FrameDirection.DOWNSTREAM
    )
    gate.push_frame.assert_not_called()
    gate.push_frame = push
    await acknowledge(voice, {**active, "retryOf": active["retryOf"] - 1})
    await pipeline.worker.queue_frame(LLMRunFrame())
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(synthesis.requests.get(), 0.03)
    assert len(requests) == int(committed) + 1
    await acknowledge(voice, active)
    await acknowledge(voice, active)
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "Let's review the next payment.")
    await next_frame(voice.frames, TTSAudioRawFrame)
    await next_frame(voice.frames, TTSTextFrame)
    assert identity == (pipeline.worker, pipeline.task, pipeline.context)
    assert not pipeline.revoked and not pipeline.task.done()
    assert pipeline.metrics["response_retries"] == 1
    assert pipeline.metrics.get("tool_calls", 0) == int(committed)
    assert len(requests) == int(committed) + 2
    assert await store.get("owner") == baseline
    assert "Voice response paused source=GuardedLLM" in caplog.text
    assert "private-provider-body" not in caplog.text


async def test_empty_completion_after_committed_tool_retries_read_only(
    voice, synthesis, store, caplog
):
    """Treat a wordless post-tool completion as a transient failure with one read-only retry."""
    pipeline = voice.pipeline
    pipeline.client_ready.set()
    voice.responses.put_nowait(
        tool_reply("update_facts", {"expectedRevision": 0, "opening": money("200")}, "once")
    )
    voice.responses.put_nowait(text_reply(""))
    await complete_turn(voice, "I have two hundred rupees.")
    waiting = await next_state(voice)
    assert waiting["state"] == "waiting" and waiting["autoRetry"] is True
    baseline = await store.get("owner")
    assert baseline.revision == 1
    active = await next_state(voice)
    assert active["reason"] == "retry" and active["retryOf"] == waiting["sequence"]
    voice.responses.put_nowait(text_reply("Your cash of two hundred rupees is saved."))
    await acknowledge(voice, active)
    retry = await asyncio.wait_for(voice.requests.get(), 2)
    while retry["tool_choice"] != "none":
        retry = await asyncio.wait_for(voice.requests.get(), 2)
    assert not any(message["role"] == "tool" for message in retry["messages"])
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "Your cash of two hundred rupees is saved.")
    await next_frame(voice.frames, TTSAudioRawFrame)
    assert not pipeline.waiting and not pipeline.revoked
    assert pipeline.metrics["model_empty"] == 1
    assert pipeline.metrics["response_retries"] == 1
    assert pipeline.metrics["tool_calls"] == 1
    assert await store.get("owner") == baseline
    assert "exception=EmptyResponseError" in caplog.text


@pytest.mark.parametrize("utterance", ["You forgot to ask about my income.", "So ask me."])
async def test_income_omission_apology_retries_as_question_without_writing(
    voice, synthesis, store, utterance, caplog
):
    """Do not publish a statement-only response to an explicit unanswered income question."""
    pipeline = voice.pipeline
    pipeline.client_ready.set()
    await pipeline.tools.update_facts({"expectedRevision": 0, "opening": money("18000")}, "cash")
    baseline = await store.get("owner")
    voice.responses.put_nowait(tool_reply("read_state", {}, "income"))
    voice.responses.put_nowait(text_reply("Sorry, I missed that."))
    await complete_turn(voice, utterance)
    waiting = await next_state(voice)
    assert waiting["autoRetry"] is True
    assert synthesis.requests.empty()
    voice.responses.put_nowait(text_reply("What income do you expect and when?"))
    await acknowledge(voice, await next_state(voice))
    request = await asyncio.wait_for(voice.requests.get(), 2)
    while request["tool_choice"] != "none":
        request = await asyncio.wait_for(voice.requests.get(), 2)
    assert "Ask the still-unanswered income question" in json.dumps(request["messages"])
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "What income do you expect and when?")
    assert "What income" in (await next_frame(voice.frames, TTSTextFrame)).text
    assert not pipeline.revoked and not pipeline.waiting
    assert pipeline.retry_attempts == 1 and pipeline.metrics["tool_calls"] == 1
    assert await store.get("owner") == baseline
    assert "voice.questionMissing" in caplog.text

    voice.responses.put_nowait(tool_reply("read_state", {}, "thanks"))
    voice.responses.put_nowait(text_reply("You're welcome."))
    await complete_turn(voice, "Thank you.")
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "You're welcome.")
    assert "You're welcome" in (await next_frame(voice.frames, TTSTextFrame)).text
    assert not pipeline.income_repair and not pipeline.waiting and not pipeline.revoked
    assert await store.get("owner") == baseline


async def test_synthesis_retries_after_native_stop_without_write_replay(voice, synthesis, store):
    """Retire failed synthesis before a tool-free response attempt can produce audio."""
    voice.pipeline.client_ready.set()
    voice.responses.put_nowait(
        tool_reply("update_facts", {"expectedRevision": 0, "opening": money("200")}, "once")
    )
    voice.responses.put_nowait(text_reply("Your cash is recorded."))
    await complete_turn(voice, "I have two hundred rupees.")
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    waiting = await next_state(voice)
    assert waiting["autoRetry"] is True
    instance.stop_speaking_async.return_value.get.assert_called_once()
    for signal in ("synthesizing", "synthesis_completed", "synthesis_word_boundary"):
        getattr(instance, signal).disconnect_all.assert_called()
    baseline = await store.get("owner")
    voice.responses.put_nowait(text_reply("What payment should we review?"))
    await acknowledge(voice, await next_state(voice))
    retry, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "Stale audio must not escape.")
    await render(retry, "What payment should we review?")
    assert (await next_frame(voice.frames, TTSTextFrame)).text.strip() == (
        "What payment should we review?"
    )
    assert voice.pipeline.metrics["tool_calls"] == 1
    assert await store.get("owner") == baseline


async def test_repeated_failure_exhausts_retry_until_new_completed_turn(voice, synthesis):
    """Automatic attempts never replenish on failure or explicit Continue."""
    voice.pipeline.client_ready.set()

    def failure():
        """Create a fresh transient HTTP response for each attempt."""
        return httpx.Response(503, json={"error": {"message": "unavailable"}})

    voice.responses.put_nowait(failure())
    await complete_turn(voice, "Help me plan.")
    await next_state(voice)
    active = await next_state(voice)
    voice.responses.put_nowait(failure())
    await acknowledge(voice, active)
    waiting = await next_state(voice)
    assert waiting["autoRetry"] is False
    assert not voice.pipeline.revoked and not voice.pipeline.task.done()
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(next_state(voice), 0.15)
    voice.responses.put_nowait(failure())
    await continue_conversation(voice, waiting["sequence"])
    assert (await next_state(voice))["state"] == "active"
    waiting = await next_state(voice)
    assert waiting["autoRetry"] is False and voice.pipeline.retry_attempts == 1
    voice.responses.put_nowait(text_reply("Let's continue."))
    await continue_conversation(voice, waiting["sequence"])
    await next_state(voice)
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "Let's continue.")
    await next_frame(voice.frames, TTSTextFrame)
    voice.responses.put_nowait(failure())
    await complete_turn(voice, "Please consider my rent too.")
    assert (await next_state(voice))["autoRetry"] is True
    assert voice.pipeline.retry_attempts == 0


@pytest.mark.parametrize("change", ["interrupt", "end", "speaking", "continue", "state"])
async def test_delay_owner_cannot_resume_after_supersession(voice, synthesis, store, change):
    """Delay ownership is lost to interruption, End, user speech, Continue, or state changes."""
    pipeline = voice.pipeline
    pipeline.client_ready.set()
    voice.responses.put_nowait(httpx.Response(503, json={"error": {"message": "unavailable"}}))
    await complete_turn(voice, "Help me plan.")
    waiting = await next_state(voice)
    if change == "interrupt":
        await pipeline.worker.queue_frame(InterruptionFrame())
    elif change == "end":
        pipeline.invalidate()
    elif change == "speaking":
        pipeline.user_speaking = True
    elif change == "state":
        await pipeline.tools.update_facts(
            {"expectedRevision": 0, "opening": money("200")}, "external"
        )
    else:
        voice.responses.put_nowait(text_reply("Let's continue."))
        await continue_conversation(voice, waiting["sequence"])
        assert (await next_state(voice))["state"] == "active"
        instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
        await render(instance, "Let's continue.")
    if change not in {"continue", "end"}:
        state = await next_state(voice)
        assert state["state"] == "waiting" and state["autoRetry"] is False
    else:
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(next_state(voice), 0.15)
    assert pipeline.metrics.get("response_retries", 0) == 0


@pytest.mark.parametrize("cause", [400, 401, 403, "quota", "invalid", "required"])
async def test_hard_failures_never_offer_automatic_retry(voice, cause):
    """Auth, bad requests, quota and malformed provider results are terminal."""
    voice.expect_failure = True
    failed = asyncio.Event()
    voice.failed.side_effect = failed.set
    voice.pipeline.client_ready.set()
    voice.responses.put_nowait(
        text_reply("No required tool was produced.")
        if cause == "required"
        else httpx.Response(200, json={"invalid": True})
        if cause == "invalid"
        else httpx.Response(
            429 if cause == "quota" else cause,
            json={"error": {"message": "private", "code": "insufficient_quota"}}
            if cause == "quota"
            else {"error": {"message": "private"}},
        )
    )
    await complete_turn(voice, "Help me plan.")
    await asyncio.wait_for(failed.wait(), 2)
    assert voice.pipeline.revoked and not voice.pipeline.auto_retry
    assert voice.pipeline.metrics.get("response_retries", 0) == 0


@pytest.mark.parametrize("budget", ["tools", "model", "required", "tokens"])
async def test_response_budget_pauses_with_model_source(
    voice, synthesis, caplog, budget, monkeypatch
):
    """Local budget failures remain distinguishable from provider synthesis failures."""
    voice.pipeline.client_ready.set()
    if budget == "tools":
        for index in range(7):
            voice.responses.put_nowait(tool_reply("read_state", {}, f"read-{index}"))
    elif budget == "tokens":
        voice.responses.put_nowait(
            httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                content=text_reply("Truncated explanation must not be spoken.").content.replace(
                    b'"finish_reason": "stop"', b'"finish_reason": "length"'
                ),
            )
        )
    elif budget == "required":
        voice.responses.put_nowait(text_reply("No required tool was produced."))
        request = voice.pipeline.llm.get_chat_completions

        async def exhausted(context):
            """Model a required repair response at the final admitted tool round."""
            voice.pipeline.tool_rounds = 6
            return await request(context)

        monkeypatch.setattr(voice.pipeline.llm, "get_chat_completions", exhausted)
    else:
        voice.responses.put_nowait(tool_reply("read_state", {}, "initial"))
        voice.responses.put_nowait(text_reply("Let's review your plan."))
    await complete_turn(voice, "Help me plan.")
    if budget == "model":
        instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
        await render(instance, "Let's review your plan.")
        await next_frame(voice.frames, TTSTextFrame)
        voice.pipeline.model_requests = 7
        await voice.pipeline.worker.queue_frame(LLMRunFrame())
    waiting = await next_state(voice)
    assert waiting["autoRetry"] is True and not voice.pipeline.revoked
    assert "source=GuardedLLM exception=ResponseBudgetError" in caplog.text
    if budget == "required":
        monkeypatch.setattr(voice.pipeline.llm, "get_chat_completions", request)
    voice.responses.put_nowait(text_reply("Let's continue with the saved facts."))
    await acknowledge(voice, await next_state(voice))
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "Let's continue with the saved facts.")
    await next_frame(voice.frames, TTSTextFrame)
    assert voice.pipeline.model_requests == 1 and voice.pipeline.tool_rounds == 0


@pytest.mark.parametrize("change", ["generation", "speaking", "end", "headroom"])
async def test_active_offer_ack_cannot_revive_superseded_attempt(voice, change):
    """Recheck generation, speech, lifetime and revocation when the client acknowledges."""
    pipeline = voice.pipeline
    pipeline.client_ready.set()
    voice.responses.put_nowait(httpx.Response(503, json={"error": {"message": "unavailable"}}))
    await complete_turn(voice, "Help me plan.")
    await next_state(voice)
    active = await next_state(voice)
    if change == "generation":
        pipeline.generation += 1
    elif change == "speaking":
        pipeline.user_speaking = True
    elif change == "end":
        pipeline.invalidate()
    else:
        pipeline.created_at -= 3600
    await acknowledge(voice, active)
    assert pipeline.metrics.get("response_retries", 0) == 0
    assert pipeline.waiting
    if change != "end":
        waiting = await next_state(voice)
        assert waiting["state"] == "waiting" and waiting["autoRetry"] is False


@pytest.mark.parametrize("attempts", [-1, 3, True])
def test_retry_configuration_rejects_unbounded_attempts(voice, attempts):
    """Retry limits are strictly integral and capped at two."""
    config = load_config().voice
    with pytest.raises(ValidationError):
        type(config).model_validate({**config.model_dump(), "response_retry_attempts": attempts})


async def test_unconfirmed_write_is_retained_but_never_replayed(voice, synthesis, store):
    """Read-only retries expose unresolved write status without dispatching a new command."""
    pipeline = voice.pipeline
    pipeline.client_ready.set()
    voice.responses.put_nowait(httpx.Response(503, json={"error": {"message": "unavailable"}}))
    await complete_turn(voice, "Save my available cash.")
    await next_state(voice)
    write = FinancialWrite(
        "update_facts",
        "unconfirmed-command",
        {"opening": money("200")},
        "Save my available cash.",
        status="unconfirmed",
    )
    pipeline.tools.writes["unconfirmed-command"] = write
    pipeline.tools.last_write = "unconfirmed-command"
    baseline = await store.get("owner")
    voice.responses.put_nowait(text_reply("That save is unconfirmed."))
    await acknowledge(voice, await next_state(voice))
    await asyncio.wait_for(voice.requests.get(), 2)
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request["tool_choice"] == "none"
    assert '"status": "unconfirmed"' in "\n".join(
        message.get("content", "")
        for message in request["messages"]
        if message["role"] == "developer"
    )
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "That save is unconfirmed.")
    await next_frame(voice.frames, TTSTextFrame)
    assert pipeline.tools.writes["unconfirmed-command"] is write
    assert write.status == "unconfirmed"
    assert pipeline.metrics.get("tool_calls", 0) == 0
    assert await store.get("owner") == baseline
