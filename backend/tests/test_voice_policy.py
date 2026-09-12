# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from contextlib import asynccontextmanager
from xml.etree import ElementTree

import httpx
import pytest
from pipecat.frames.frames import (
    FunctionCallCancelFrame,
    FunctionCallResultFrame,
    InterruptionFrame,
    LLMRunFrame,
    TTSAudioRawFrame,
    TTSTextFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)

from .conftest import money
from .test_voice_errors import text_reply
from .test_voice_opening import render
from .test_voice_opening import synthesis as synthesis
from .test_voice_turns import complete_turn, next_frame, recognize, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries
from .test_voice_waiting import continue_conversation, next_state


@pytest.mark.parametrize("voice", [{"max_tool_rounds": 2}], indirect=True)
@pytest.mark.parametrize("write", [False, True], ids=["read", "write"])
async def test_empty_success_waits_for_continue_from_committed_state(
    voice, synthesis, store, write
):
    observed = []

    async def model(request):
        body = json.loads(request.content)
        observed.append(body)
        if len(observed) == 1:
            assert body["tool_choice"] == "required"
            return tool_reply(
                "update_facts" if write else "read_state",
                {"expectedRevision": 0, "opening": money("200")} if write else {},
                "committed",
            )
        if len(observed) == 2:
            assert body["tool_choice"] == "auto"
            assert body["messages"][-1]["role"] == "developer"
            assert "entire completed user turn" in body["messages"][-1]["content"]
            return text_reply("")
        assert len(observed) == 3
        assert body["tool_choice"] == "none"
        assert "Continue" in body["messages"][-1]["content"]
        state = next(
            message["content"]
            for message in body["messages"]
            if message.get("content", "").startswith("Canonical application state;")
        )
        assert json.loads(state.split("\n", 1)[1])["snapshot"] == (
            await store.get("owner")
        ).model_dump(mode="json", by_alias=True)
        assert [m for m in body["messages"] if m["role"] == "tool"] == [
            m for m in observed[1]["messages"] if m["role"] == "tool"
        ]
        return text_reply("Your recorded cash is two hundred." if write else "What is your cash?")

    await voice.pipeline.llm._client._client.aclose()
    voice.pipeline.llm._client._client = httpx.AsyncClient(transport=httpx.MockTransport(model))
    voice.pipeline.client_ready.set()
    context, worker, task = voice.pipeline.context, voice.pipeline.worker, voice.pipeline.task
    await complete_turn(voice, "I have two hundred rupees." if write else "Please help me.")
    result = await next_frame(voice.frames, FunctionCallResultFrame)
    state = await next_state(voice)
    assert state["state"] == "waiting"
    assert state["reason"] == "response"
    baseline = await store.get("owner")
    await voice.pipeline.worker.queue_frame(LLMRunFrame())
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(synthesis.requests.get(), 0.1)
    assert len(observed) == 2 and not voice.pipeline.revoked and not task.done()
    assert baseline.revision == int(write)
    await continue_conversation(voice, state["sequence"])
    assert await next_state(voice) == {
        "type": "conversation-state",
        "state": "active",
        "sequence": state["sequence"] + 1,
    }
    instance, ssml = await asyncio.wait_for(synthesis.requests.get(), 2)
    text = "".join(ElementTree.fromstring(ssml).itertext()).strip()
    assert text == ("Your recorded cash is two hundred." if write else "What is your cash?")
    await render(instance, text)
    await next_frame(voice.frames, TTSAudioRawFrame)
    assert (await next_frame(voice.frames, TTSTextFrame)).text.strip() == text
    async with asyncio.timeout(2):
        while (await synthesis.turns.get()).content.strip() != text:
            pass
    assert result.tool_call_id == "committed"
    assert voice.pipeline.metrics["model_requests"] == 3
    assert voice.pipeline.model_requests == 1 and voice.pipeline.tool_rounds == 0
    assert voice.pipeline.metrics["tool_calls"] == 1
    assert await store.get("owner") == baseline
    assert (voice.pipeline.context, voice.pipeline.worker, voice.pipeline.task) == (
        context,
        worker,
        task,
    )
    assert voice.pipeline.context.get_messages()[-1]["content"].strip() == text
    assert not any(
        "entire completed user turn" in message.get("content", "")
        for message in voice.pipeline.context.get_messages()
    )


def mixed_reply(name, arguments, call_id):
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        content=text_reply("I saved everything. Here is a premature question.").content.replace(
            b"data: [DONE]\n\n", b""
        )
        + tool_reply(name, arguments, call_id).content,
    )


async def test_empty_response_cannot_pause_a_newer_generation(voice, monkeypatch):
    voice.pipeline.client_ready.set()
    reached, release, interrupted = asyncio.Event(), asyncio.Event(), asyncio.Event()
    create_task = voice.pipeline.llm.create_task

    def delayed(coroutine, name=None):
        if name != "empty-response":
            return create_task(coroutine, name)

        async def run():
            reached.set()
            await release.wait()
            await coroutine

        return create_task(run(), name)

    monkeypatch.setattr(voice.pipeline.llm, "create_task", delayed)
    voice.responses.put_nowait(tool_reply("read_state", {}, "read"))
    voice.responses.put_nowait(text_reply(""))
    await complete_turn(voice, "Please help me.")
    await asyncio.wait_for(reached.wait(), 2)

    async def observed(_, frame):
        if isinstance(frame, InterruptionFrame):
            interrupted.set()

    voice.pipeline.llm.add_event_handler("on_after_process_frame", observed)
    await voice.pipeline.worker.queue_frame(InterruptionFrame())
    await asyncio.wait_for(interrupted.wait(), 2)
    release.set()
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(next_state(voice), 0.1)
    assert not voice.pipeline.waiting and not voice.pipeline.revoked


@pytest.mark.parametrize("voice", [{"max_tool_rounds": 2}], indirect=True)
async def test_each_posttool_request_has_temporary_response_guidance(voice, synthesis, store):
    baseline = await store.get("owner")
    voice.responses.put_nowait(tool_reply("read_state", {}, "first-read"))
    voice.responses.put_nowait(tool_reply("read_state", {}, "second-read"))
    voice.responses.put_nowait(text_reply("What cash do you have available?"))
    await complete_turn(voice, "Please review my situation and tell me what is missing.")
    requests = [await asyncio.wait_for(voice.requests.get(), 2) for _ in range(3)]
    assert [request["tool_choice"] for request in requests] == ["required", "auto", "auto"]
    guidance = requests[1]["messages"][-1]
    assert guidance["role"] == "developer"
    assert "entire completed user turn" in guidance["content"]
    assert "do not repeat committed writes" in guidance["content"]
    assert guidance not in requests[0]["messages"]
    for request in requests[1:]:
        assert request["messages"][-1] == guidance
        assert request["messages"].count(guidance) == 1
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "What cash do you have available?")
    await next_frame(voice.frames, TTSAudioRawFrame)
    await asyncio.wait_for(synthesis.turns.get(), 2)
    assert guidance not in voice.pipeline.context.get_messages()
    assert voice.pipeline.metrics["tool_calls"] == 2
    assert voice.pipeline.metrics["model_requests"] == 3
    assert await store.get("owner") == baseline


@pytest.mark.parametrize("write", [False, True], ids=["read", "write"])
@pytest.mark.parametrize("text", ["", " \n\t"])
@pytest.mark.parametrize("voice", [{"max_tool_rounds": 1}], indirect=True)
async def test_repeated_empty_continue_resets_budgets_without_repeating_tools(
    voice, store, write, text
):
    voice.pipeline.client_ready.set()
    voice.responses.put_nowait(
        tool_reply(
            "update_facts" if write else "read_state",
            {"expectedRevision": 0, "opening": money("200")} if write else {},
            "accepted-once",
        )
    )
    voice.responses.put_nowait(text_reply(text))
    await complete_turn(voice, "I have two hundred rupees." if write else "Help me.")
    assert (await asyncio.wait_for(voice.requests.get(), 2))["tool_choice"] == "required"
    assert (await asyncio.wait_for(voice.requests.get(), 2))["tool_choice"] == "auto"
    state = await next_state(voice)
    baseline = await store.get("owner")
    for index in range(1, 5):
        assert state["state"] == "waiting"
        await voice.pipeline.worker.queue_frame(LLMRunFrame())
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(voice.requests.get(), 0.1)
        assert not voice.pipeline.revoked and not voice.pipeline.task.done()
        voice.responses.put_nowait(text_reply(text))
        await continue_conversation(voice, state["sequence"])
        assert (await next_state(voice))["state"] == "active"
        assert (await asyncio.wait_for(voice.requests.get(), 2))["tool_choice"] == "none"
        state = await next_state(voice)
        assert voice.pipeline.metrics["model_requests"] == 2 + index
        assert voice.pipeline.metrics["model_empty"] == 1 + index
        assert voice.pipeline.model_requests <= 1 and voice.pipeline.tool_rounds == 0
        assert voice.pipeline.metrics.get("model_empty_retries", 0) == 0
        assert voice.pipeline.metrics["tool_calls"] == 1
        assert voice.pipeline.completed_turns == 1
        assert await store.get("owner") == baseline
    assert baseline.revision == int(write)
    voice.synthesizer.speak_ssml_async.assert_not_called()


@pytest.mark.parametrize("cause", ["http", "refusal", "content_filter", "length", "unfinished"])
async def test_failed_or_blocked_response_is_never_regenerated(voice, store, cause):
    voice.expect_failure = True
    failed = asyncio.Event()
    voice.failed.side_effect = failed.set
    voice.responses.put_nowait(
        tool_reply("update_facts", {"expectedRevision": 0, "opening": money("200")}, "saved")
    )
    if cause == "http":
        reply = httpx.Response(500, json={"error": {"message": "Provider unavailable"}})
    elif cause == "unfinished":
        reply = httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content="data: [DONE]\n\n"
        )
    else:
        chunk = json.loads(text_reply("").text.split("\n", 1)[0][6:])
        choice = chunk["choices"][0]
        if cause == "refusal":
            choice["delta"] = {"refusal": "Unable to comply"}
        else:
            choice["finish_reason"] = cause
        reply = httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=text_reply("Do not publish this partial answer.").content.replace(
                b"data: [DONE]\n\n", b""
            )
            + f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n".encode(),
        )
    voice.responses.put_nowait(reply)
    await complete_turn(voice, "I have two hundred rupees.")
    await asyncio.wait_for(failed.wait(), 2)
    assert voice.pipeline.revoked and voice.pipeline.metrics["model_requests"] == 2
    assert voice.pipeline.metrics.get("model_empty_retries", 0) == 0
    assert voice.pipeline.metrics["tool_calls"] == 1
    assert (await store.get("owner")).revision == 1
    voice.synthesizer.speak_ssml_async.assert_not_called()


async def test_continue_rejects_provider_tool_calls_even_with_text(voice, store):
    voice.pipeline.client_ready.set()
    voice.expect_failure = True
    failed = asyncio.Event()
    voice.failed.side_effect = failed.set
    voice.responses.put_nowait(
        tool_reply("update_facts", {"expectedRevision": 0, "opening": money("200")}, "saved")
    )
    voice.responses.put_nowait(text_reply(""))
    voice.responses.put_nowait(
        mixed_reply("update_facts", {"expectedRevision": 1, "opening": money("999")}, "repeat")
    )
    await complete_turn(voice, "I have two hundred rupees.")
    state = await next_state(voice)
    await continue_conversation(voice, state["sequence"])
    await asyncio.wait_for(failed.wait(), 2)
    assert voice.pipeline.metrics["model_requests"] == 3
    assert voice.pipeline.metrics["tool_calls"] == 1
    assert voice.pipeline.tool_rounds == 0
    snapshot = await store.get("owner")
    assert snapshot.revision == 1 and snapshot.facts.opening.amount_paise == 20000
    voice.synthesizer.speak_ssml_async.assert_not_called()


@pytest.mark.parametrize("cause", ["interruption", "waiting", "correction"])
async def test_empty_pause_blocks_queued_inference_after_state_changes(voice, store, cause):
    voice.pipeline.client_ready.set()
    voice.responses.put_nowait(tool_reply("read_state", {}, "read"))
    voice.responses.put_nowait(text_reply(""))
    await complete_turn(voice, "Please help me.")
    assert (await next_state(voice))["state"] == "waiting"
    if cause == "interruption":
        interrupted = asyncio.Event()

        async def after_interruption(_, frame):
            if isinstance(frame, InterruptionFrame):
                interrupted.set()

        voice.pipeline.llm.add_event_handler("on_after_process_frame", after_interruption)
        await voice.pipeline.worker.queue_frame(InterruptionFrame())
        await next_frame(voice.frames, InterruptionFrame)
        await asyncio.wait_for(interrupted.wait(), 2)
    elif cause == "waiting":
        voice.pipeline.waiting = True
    else:
        await voice.pipeline.tools.update_facts(
            {"expectedRevision": 0, "opening": money("200")}, "external"
        )
    await voice.pipeline.worker.queue_frame(LLMRunFrame())
    assert voice.requests.qsize() == 2
    await voice.requests.get()
    await voice.requests.get()
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.1)
    assert voice.pipeline.metrics["model_requests"] == 2
    assert voice.pipeline.metrics.get("model_empty_retries", 0) == 0
    assert voice.pipeline.metrics["tool_calls"] == 1
    assert (await store.get("owner")).revision == int(cause == "correction")
    voice.synthesizer.speak_ssml_async.assert_not_called()


@pytest.mark.parametrize("reply", ["text", "tool"])
async def test_interrupted_continue_discards_late_provider_output(voice, store, reply):
    voice.pipeline.client_ready.set()
    reached = asyncio.Event()
    closed = asyncio.Event()

    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            reached.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                yield (
                    text_reply("I accepted the same facts again.")
                    if reply == "text"
                    else tool_reply(
                        "update_facts", {"expectedRevision": 1, "opening": money("999")}, "late"
                    )
                ).content

        async def aclose(self):
            closed.set()

    voice.responses.put_nowait(
        tool_reply("update_facts", {"expectedRevision": 0, "opening": money("200")}, "saved")
    )
    voice.responses.put_nowait(text_reply(""))
    voice.responses.put_nowait(
        httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Stream())
    )
    await complete_turn(voice, "I have two hundred rupees.")
    state = await next_state(voice)
    await continue_conversation(voice, state["sequence"])
    assert (await next_state(voice))["state"] == "active"
    await asyncio.wait_for(reached.wait(), 2)
    await voice.pipeline.worker.queue_frame(InterruptionFrame())
    await next_frame(voice.frames, InterruptionFrame)
    await asyncio.wait_for(closed.wait(), 2)
    assert voice.pipeline.metrics["model_requests"] == 3
    assert voice.pipeline.metrics["tool_calls"] == 1
    assert (await store.get("owner")).revision == 1
    assert "accepted the same facts" not in json.dumps(voice.pipeline.context.get_messages())
    voice.synthesizer.speak_ssml_async.assert_not_called()


@pytest.mark.parametrize(
    "utterance,patch",
    [
        (
            "Rent is five thousand due September fourteenth. I cannot pay it.",
            {
                "records": [
                    {
                        "kind": "essential",
                        "label": "Rent",
                        "amount": money("5000"),
                        "schedule": {"date": "2026-09-14"},
                    }
                ]
            },
        ),
        (
            "I have two thousand, rent is five thousand on the fourteenth, "
            "and wages are ten thousand on the fifteenth.",
            {
                "opening": money("2000"),
                "records": [
                    {
                        "kind": "essential",
                        "label": "Rent",
                        "amount": money("5000"),
                        "schedule": {"date": "2026-09-14"},
                    },
                    {
                        "kind": "income",
                        "label": "Wages",
                        "amount": money("10000"),
                        "schedule": {"date": "2026-09-15"},
                        "reliability": "reliable",
                    },
                ],
            },
        ),
        (
            "Rent is due September fourteenth but I do not know the amount.",
            {
                "records": [
                    {
                        "kind": "essential",
                        "label": "Rent",
                        "amount": money(None, "unknown"),
                        "schedule": {"date": "2026-09-14"},
                    }
                ]
            },
        ),
        ("I have one hundred. Correction, I have two hundred.", {"opening": money("200")}),
        ("I don't know where to start.", None),
    ],
    ids=["direct-problem", "multiple-facts", "uncertain-amount", "correction", "doesnt-know"],
)
async def test_scripted_first_turn_commits_before_canonical_followup_and_speech(
    voice, synthesis, store, utterance, patch
):
    observed = []
    answers = []
    answered = asyncio.Event()

    async def model(request):
        body = json.loads(request.content)
        observed.append(body)
        if len(observed) == 1:
            assert body["tool_choice"] == "required"
            assert [m["content"] for m in body["messages"] if m["role"] == "user"] == [utterance]
            return mixed_reply(
                "read_state" if patch is None else "update_facts",
                {} if patch is None else {"expectedRevision": 0, **patch},
                "first-turn",
            )
        assert body["tool_choice"] == "auto"
        result = json.loads(next(m["content"] for m in body["messages"] if m["role"] == "tool"))
        assert result["snapshot"] == (await store.get("owner")).model_dump(
            mode="json", by_alias=True
        )
        assert result["snapshot"]["revision"] == int(patch is not None)
        assert "premature question" not in json.dumps(body)
        questions = result["dialogue"]["questionOptions"]
        assert questions == result["workspace"]["questions"]
        answers.append(
            "What can you tell me about " + questions[0]["fields"][0] + "?"
            if questions
            else "The unconfirmed details remain open; we can revisit them when you know."
        )
        answered.set()
        return text_reply(answers[-1])

    await voice.pipeline.llm._client._client.aclose()
    voice.pipeline.llm._client._client = httpx.AsyncClient(transport=httpx.MockTransport(model))
    await complete_turn(voice, utterance)
    result = await next_frame(voice.frames, FunctionCallResultFrame)
    assert result.tool_call_id == "first-turn"
    spoken = []
    await asyncio.wait_for(answered.wait(), 2)
    question = answers[0]
    while " ".join(spoken) != question:
        instance, ssml = await asyncio.wait_for(synthesis.requests.get(), 2)
        text = "".join(ElementTree.fromstring(ssml).itertext()).strip()
        spoken.append(text)
        assert question.startswith(" ".join(spoken))
        await render(instance, text)
        await next_frame(voice.frames, TTSAudioRawFrame)
        assert (await next_frame(voice.frames, TTSTextFrame)).text.strip() == text
    assert len(observed) == 2 and voice.pipeline.metrics["tool_calls"] == 1
    assert (await store.get("owner")).revision == int(patch is not None)
    async with asyncio.timeout(2):
        while (await synthesis.turns.get()).content.strip() != question:
            pass
    assert "premature question" not in json.dumps(voice.pipeline.context.get_messages())


async def test_invalid_tool_result_supplies_current_state_for_clarification(
    voice, synthesis, store
):
    voice.responses.put_nowait(
        tool_reply("update_facts", {"expectedRevision": 0, "opening": "bad"}, "invalid")
    )
    voice.responses.put_nowait(text_reply("How much cash do you have?"))
    await complete_turn(voice, "I am not sure how much cash I have.")
    first = await asyncio.wait_for(voice.requests.get(), 2)
    result = await next_frame(voice.frames, FunctionCallResultFrame)
    followup = await asyncio.wait_for(voice.requests.get(), 2)
    assert first["tool_choice"] == "required" and followup["tool_choice"] == "auto"
    assert result.result["code"] == "invalidFacts" and result.result["saved"] is False
    assert result.result["currentState"]["snapshot"] == (await store.get("owner")).model_dump(
        mode="json", by_alias=True
    )
    assert (await store.get("owner")).revision == 0
    voice.synthesizer.speak_ssml_async.assert_not_called()


@pytest.mark.parametrize("text", ["You can definitely afford it.", ""])
async def test_required_tool_violation_fails_closed_without_speech_or_write(voice, store, text):
    voice.expect_failure = True
    failed = asyncio.Event()
    voice.failed.side_effect = failed.set
    voice.responses.put_nowait(text_reply(text))
    await complete_turn(voice, "Can I afford rent?")
    await asyncio.wait_for(failed.wait(), 2)
    assert voice.pipeline.revoked and (await store.get("owner")).revision == 0
    voice.synthesizer.speak_ssml_async.assert_not_called()
    assert voice.pipeline.metrics["model_requests"] == 1


@pytest.mark.parametrize("voice", [{"max_tool_rounds": 2}], indirect=True)
async def test_runaway_tools_stop_at_configured_budget(voice, store):
    voice.expect_failure = True
    failed = asyncio.Event()
    voice.failed.side_effect = failed.set
    for index in range(4):
        voice.responses.put_nowait(tool_reply("read_state", {}, str(index)))
    await complete_turn(voice, "Please help me plan.")
    await asyncio.wait_for(failed.wait(), 2)
    assert voice.pipeline.metrics["model_requests"] == 3
    assert voice.pipeline.metrics["tool_calls"] == 2
    assert voice.pipeline.tool_rounds == 2
    assert (await store.get("owner")).revision == 0
    voice.synthesizer.speak_ssml_async.assert_not_called()


@pytest.mark.parametrize("voice", [{"model_timeout_seconds": 0.05}], indirect=True)
async def test_full_stream_timeout_discards_partial_text_and_closes_stream(voice, store):
    closed = asyncio.Event()
    voice.pipeline.client_ready.set()

    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield text_reply("You can afford it.").content.replace(b"data: [DONE]\n\n", b"")
            await asyncio.Event().wait()

        async def aclose(self):
            closed.set()

    voice.responses.put_nowait(
        httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Stream())
    )
    await complete_turn(voice, "Can I afford rent?")
    assert (await next_state(voice))["reason"] == "response"
    await asyncio.wait_for(closed.wait(), 2)
    assert voice.pipeline.waiting and not voice.pipeline.revoked
    assert voice.pipeline.llm._client.timeout == 0.05
    assert voice.pipeline.metrics["model_requests"] == 1
    assert (await store.get("owner")).revision == 0
    voice.synthesizer.speak_ssml_async.assert_not_called()


async def test_deferred_save_cannot_release_buffered_question_on_interruption(
    voice, store, monkeypatch
):
    reached = asyncio.Event()
    transaction = store.transaction

    @asynccontextmanager
    async def deferred():
        async with transaction():
            yield
            reached.set()
            await asyncio.Event().wait()

    monkeypatch.setattr(store, "transaction", deferred)
    voice.responses.put_nowait(
        mixed_reply("update_facts", {"expectedRevision": 0, "opening": money("100")}, "deferred")
    )
    await complete_turn(voice, "I have one hundred rupees.")
    await asyncio.wait_for(reached.wait(), 2)
    voice.synthesizer.speak_ssml_async.assert_not_called()
    await voice.pipeline.worker.queue_frame(InterruptionFrame())
    assert (await next_frame(voice.frames, FunctionCallCancelFrame)).tool_call_id == "deferred"
    monkeypatch.setattr(store, "transaction", transaction)
    assert (await store.get("owner")).revision == 0
    assert "premature question" not in json.dumps(voice.pipeline.context.get_messages())
    voice.synthesizer.speak_ssml_async.assert_not_called()


@pytest.mark.parametrize("voice", [{"speech_timeout_seconds": 1.2}], indirect=True)
async def test_final_segments_inside_speech_floor_form_one_completed_narrative(voice):
    await voice.pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
    await asyncio.wait_for(voice.started.wait(), 2)
    await recognize(voice, "I have two thousand rupees.")
    await voice.pipeline.worker.queue_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.8)
    await voice.pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
    await recognize(voice, "Rent is five thousand on September fourteenth.")
    await voice.pipeline.worker.queue_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), 0.8)
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert [m["content"] for m in request["messages"] if m["role"] == "user"] == [
        "I have two thousand rupees. Rent is five thousand on September fourteenth."
    ]
    assert voice.pipeline.completed_turns == 1


@pytest.mark.parametrize("voice", [{"max_tool_rounds": 1}], indirect=True)
async def test_budgets_reset_only_for_completed_turn_or_external_refresh(voice, synthesis, store):
    async def finish():
        instance, ssml = await asyncio.wait_for(synthesis.requests.get(), 2)
        text = "".join(ElementTree.fromstring(ssml).itertext()).strip()
        await render(instance, text)
        async with asyncio.timeout(2):
            while (await synthesis.turns.get()).content.strip() != text:
                pass

    voice.responses.put_nowait(
        tool_reply("update_facts", {"expectedRevision": 0, "opening": money("100")}, "save")
    )
    voice.responses.put_nowait(text_reply("What would you like to clarify?"))
    await complete_turn(voice, "I have one hundred rupees.")
    assert (await next_frame(voice.frames, FunctionCallResultFrame)).tool_call_id == "save"
    await asyncio.wait_for(voice.requests.get(), 2)
    await asyncio.wait_for(voice.requests.get(), 2)
    assert voice.pipeline.tool_rounds == 1 and voice.pipeline.model_requests == 2
    await finish()
    voice.responses.put_nowait(tool_reply("read_state", {}, "explain"))
    voice.responses.put_nowait(text_reply("What is your next payment?"))
    await complete_turn(voice, "Can you explain my next step?")
    await next_frame(voice.frames, FunctionCallResultFrame)
    assert (await asyncio.wait_for(voice.requests.get(), 2))["tool_choice"] == "required"
    await asyncio.wait_for(voice.requests.get(), 2)
    assert voice.pipeline.tool_rounds == 1 and voice.pipeline.model_requests == 2
    await finish()
    voice.pipeline.client_ready.set()
    await voice.pipeline.tools.update_facts(
        {"expectedRevision": 1, "opening": money("200")}, "external"
    )
    voice.responses.put_nowait(tool_reply("read_state", {}, "external-state"))
    voice.responses.put_nowait(text_reply("Your recorded cash is two hundred."))
    await voice.pipeline.interrupt()
    await next_frame(voice.frames, FunctionCallResultFrame)
    assert (await asyncio.wait_for(voice.requests.get(), 2))["tool_choice"] == "required"
    await asyncio.wait_for(voice.requests.get(), 2)
    assert voice.pipeline.tool_rounds == 1 and voice.pipeline.model_requests == 2
    assert (await store.get("owner")).revision == 2
    await finish()


@pytest.mark.parametrize("voice", [{"tool_timeout_seconds": 0.05}], indirect=True)
async def test_tool_timeout_cancels_write_and_reconciles_before_any_guidance(
    voice, synthesis, store, monkeypatch
):
    invoke = voice.pipeline.tools.invoke

    async def delayed(name, arguments, call_id):
        if name == "update_facts":
            await asyncio.Event().wait()
        return await invoke(name, arguments, call_id)

    monkeypatch.setattr(voice.pipeline.tools, "invoke", delayed)
    voice.responses.put_nowait(
        mixed_reply("update_facts", {"expectedRevision": 0, "opening": money("100")}, "timeout")
    )
    voice.responses.put_nowait(tool_reply("read_state", {}, "reconcile-timeout"))
    voice.responses.put_nowait(text_reply("Please confirm your cash."))
    await complete_turn(voice, "I have one hundred rupees.")
    assert (await next_frame(voice.frames, FunctionCallCancelFrame)).tool_call_id == "timeout"
    result = await next_frame(voice.frames, FunctionCallResultFrame)
    assert result.tool_call_id == "reconcile-timeout"
    assert result.result["snapshot"] == (await store.get("owner")).model_dump(
        mode="json", by_alias=True
    )
    assert (await store.get("owner")).revision == 0
    assert voice.pipeline.tool_rounds == 2
    voice.synthesizer.speak_ssml_async.assert_not_called()
