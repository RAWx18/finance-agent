# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from contextlib import asynccontextmanager, suppress
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import httpx
import pytest
from azure.cognitiveservices.speech import ResultReason
from pipecat.frames.frames import (
    FunctionCallCancelFrame,
    FunctionCallResultFrame,
    InterruptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregator
from pipecat.processors.frame_processor import FrameDirection
from pipecat.tests.utils import QueuedFrameProcessor

from app.models import CallState
from app.speech import SpeechRecognition
from app.voice import Call, CallManager
from app.voice_pipeline import VoicePipeline
from app.voice_tools import VoiceTools

from .conftest import money
from .test_voice import environment


def tool_reply(name, arguments, call_id, following=()):
    chunk = {
        "id": "test-completion",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "finance-chat_1.2",
        "choices": [
            {
                "index": 0,
                "delta": {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
    }
    content = f"data: {json.dumps(chunk)}\n\n"
    for index, (name, arguments, call_id) in enumerate(following, 1):
        chunk["choices"][0]["delta"]["tool_calls"] = [
            {
                "index": index,
                "id": call_id,
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(arguments)},
            }
        ]
        content += f"data: {json.dumps(chunk)}\n\n"
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        content=content + "data: [DONE]\n\n",
    )


async def next_frame(queue, frame_type):
    async with asyncio.timeout(2):
        while True:
            frame = await queue.get()
            if isinstance(frame, frame_type):
                return frame


async def recognize(voice, text, *, final=True):
    event = SimpleNamespace(
        result=SimpleNamespace(
            text=text,
            reason=ResultReason.RecognizedSpeech if final else ResultReason.RecognizingSpeech,
            language="en-IN",
        )
    )
    callback = voice.stt._on_handle_recognized if final else voice.stt._on_handle_recognizing
    await asyncio.to_thread(callback, event)


async def complete_turn(voice, text):
    await recognize(voice, text)
    # Policy tests await asynchronous callbacks; dedicated turn tests own timing assertions.
    return await asyncio.wait_for(voice.turns.get(), voice.turn_timeout + 10)


@pytest.fixture
def voice_boundaries(monkeypatch):
    frames = asyncio.Queue()
    requests = asyncio.Queue()
    responses = asyncio.Queue()
    transport = Mock()
    transport.input.return_value = QueuedFrameProcessor(
        queue=asyncio.Queue(), queue_direction=FrameDirection.UPSTREAM
    )
    transport.output.return_value = QueuedFrameProcessor(
        queue=frames, queue_direction=FrameDirection.DOWNSTREAM
    )
    # Only transport and remote provider boundaries are isolated.
    transport_factory = Mock(return_value=transport)
    monkeypatch.setattr("pipecat.transports.daily.transport.DailyTransport", transport_factory)
    monkeypatch.setattr("app.speech.SpeechRecognizer", Mock())
    monkeypatch.setattr("app.speech.PhraseListGrammar.from_recognizer", Mock())
    synthesizer = Mock()
    synthesizer.speak_ssml_async.side_effect = AssertionError("No live synthesis in frame tests")
    monkeypatch.setattr(
        "pipecat.services.azure.tts.SpeechSynthesizer", Mock(return_value=synthesizer)
    )
    monkeypatch.setattr("app.speech.SpeechSynthesizer", Mock(return_value=synthesizer))

    class PendingStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            await asyncio.Event().wait()
            yield b""

    def respond(request):
        assert request.url.path == "/openai/v1/chat/completions"
        body = json.loads(request.content)
        requests.put_nowait(body)
        return (
            responses.get_nowait()
            if not responses.empty()
            else tool_reply("read_state", {}, str(uuid4()))
            if body.get("tool_choice") == "required"
            else httpx.Response(
                200, headers={"content-type": "text/event-stream"}, stream=PendingStream()
            )
        )

    return SimpleNamespace(
        frames=frames,
        requests=requests,
        responses=responses,
        transport=transport,
        transport_factory=transport_factory,
        synthesizer=synthesizer,
        respond=respond,
    )


@pytest.fixture
async def voice(store, tmp_path, voice_boundaries, request):
    store.config = store.config.model_copy(
        update={"voice": store.config.voice.model_copy(update=getattr(request, "param", {}))}
    )
    await store.create("owner")
    pipeline = VoicePipeline()
    failed = Mock()
    try:
        await pipeline.start(
            store,
            "owner",
            uuid4(),
            "https://test.daily.co/room",
            "test-token",
            environment(tmp_path),
            failed,
            lambda: None,
        )
        await asyncio.wait_for(pipeline.started.wait(), 2)
        client = pipeline.llm._client
        await client._client.aclose()
        client._client = httpx.AsyncClient(transport=httpx.MockTransport(voice_boundaries.respond))
        user = next(item for item in pipeline.processors if isinstance(item, LLMUserAggregator))
        started = asyncio.Event()
        turns = asyncio.Queue()
        user.add_event_handler("on_user_turn_started", lambda *_: started.set())
        user.add_event_handler(
            "on_user_turn_stopped", lambda _, __, message: turns.put_nowait(message)
        )
        session = SimpleNamespace(
            pipeline=pipeline,
            frames=voice_boundaries.frames,
            requests=voice_boundaries.requests,
            responses=voice_boundaries.responses,
            started=started,
            turns=turns,
            turn_timeout=store.config.voice.speech_timeout_seconds,
            stt=next(item for item in pipeline.processors if isinstance(item, SpeechRecognition)),
            synthesizer=voice_boundaries.synthesizer,
            failed=failed,
            expect_failure=False,
        )
        yield session
    finally:
        await pipeline.close()
    if not session.expect_failure:
        failed.assert_not_called()


async def test_azure_request_disables_parallel_generation_not_tool_cancellation(voice):
    await complete_turn(voice, "Please help me get started.")
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert request.get("parallel_tool_calls") is False
    assert request["tool_choice"] == "required"
    assert voice.pipeline.llm._run_in_parallel is False
    assert all(item.cancel_on_interruption for item in voice.pipeline.llm._functions.values())
    assert {tool["function"]["name"] for tool in request["tools"]} == set(
        voice.pipeline.llm._functions
    )


async def test_finalized_segments_cannot_save_a_correction_while_user_is_speaking(voice, store):
    await voice.pipeline.tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money("4200"),
            "records": [
                {
                    "kind": "essential",
                    "label": "Rent",
                    "amount": money("5000"),
                    "schedule": {"date": "2026-09-14"},
                }
            ],
        },
        "baseline",
    )
    baseline = await store.get("owner")
    rent = baseline.facts.records[0]
    await voice.pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
    await asyncio.wait_for(voice.started.wait(), 2)
    await recognize(voice, "Rent is six thousand rupees.")
    await recognize(voice, "Correction.")
    await recognize(voice, "The rent amount and date", final=False)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(
            voice.requests.get(), store.config.voice.speech_timeout_seconds + 0.1
        )
    assert await store.get("owner") == baseline
    assert voice.pipeline.user_speaking
    voice.responses.put_nowait(
        tool_reply(
            "update_facts",
            {
                "expectedRevision": 1,
                "records": [
                    {"id": rent.id, "amount": money(None, "unknown"), "schedule": {"date": None}},
                    {"kind": "income", "label": "Wages", "amount": money("18000")},
                ],
            },
            "completed-correction",
        )
    )
    await recognize(
        voice, "The rent amount and date are unknown. Wages are eighteen thousand rupees."
    )
    await voice.pipeline.worker.queue_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), store.config.voice.speech_timeout_seconds / 3)
    request = await asyncio.wait_for(voice.requests.get(), 2)
    assert [message["content"] for message in request["messages"] if message["role"] == "user"] == [
        "Rent is six thousand rupees. Correction. "
        "The rent amount and date are unknown. Wages are eighteen thousand rupees."
    ]
    result = await next_frame(voice.frames, FunctionCallResultFrame)
    assert result.tool_call_id == "completed-correction"
    corrected = await store.get("owner")
    assert corrected.revision == 2
    assert corrected.facts.opening == baseline.facts.opening
    assert [record.id for record in corrected.facts.records].count(rent.id) == 1
    rent, wages = corrected.facts.records
    assert rent.amount.amount_paise is None and rent.schedule.date is None
    assert wages.amount.amount_paise == 1800000 and wages.schedule.date is None
    assert wages.reliability == "unknown" and corrected.plan.reliable_income_paise == 0
    assert corrected.plan.projection_partial


@pytest.mark.parametrize("vad", [True, False])
async def test_split_correction_rearms_turn_stop_including_transcript_only_turns(voice, store, vad):
    if vad:
        await voice.pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
        await asyncio.wait_for(voice.started.wait(), 2)
    await recognize(voice, "Correction.")
    if vad:
        await voice.pipeline.worker.queue_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(voice.requests.get(), store.config.voice.speech_timeout_seconds / 3)
    if vad:
        await voice.pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
    await recognize(voice, "The amount is unknown.")
    if vad:
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(
                voice.requests.get(), store.config.voice.speech_timeout_seconds + 0.1
            )
        await voice.pipeline.worker.queue_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
    request = await asyncio.wait_for(
        voice.requests.get(), store.config.voice.speech_timeout_seconds + 1
    )
    assert [message["content"] for message in request["messages"] if message["role"] == "user"] == [
        "Correction. The amount is unknown."
    ]
    assert (await store.get("owner")).revision == 0


@pytest.mark.parametrize("committed", [False, True])
async def test_interrupted_real_tool_runner_can_read_ambiguous_write_outcome(
    voice, store, monkeypatch, committed
):
    transaction = store.transaction
    reached = asyncio.Event()
    release = asyncio.Event()

    @asynccontextmanager
    async def paused_transaction():
        async with transaction():
            yield
            if not committed:
                reached.set()
                await release.wait()
        if committed:
            reached.set()
            await release.wait()

    monkeypatch.setattr(store, "transaction", paused_transaction)
    voice.responses.put_nowait(
        tool_reply(
            "update_facts", {"expectedRevision": 0, "opening": money("100")}, "interrupted-write"
        )
    )
    await complete_turn(voice, "I have one hundred rupees.")
    await asyncio.wait_for(voice.requests.get(), 2)
    await asyncio.wait_for(reached.wait(), 2)
    await voice.pipeline.worker.queue_frame(InterruptionFrame())
    cancelled = await next_frame(voice.frames, FunctionCallCancelFrame)
    assert cancelled.tool_call_id == "interrupted-write"
    monkeypatch.setattr(store, "transaction", transaction)
    voice.responses.put_nowait(tool_reply("read_state", {}, "reconcile"))
    await complete_turn(voice, "Did that save?")
    await asyncio.wait_for(voice.requests.get(), 2)
    result = await next_frame(voice.frames, FunctionCallResultFrame)
    assert result.tool_call_id == "reconcile"
    snapshot = await store.get("owner")
    assert snapshot.revision == int(committed)
    assert snapshot.facts.opening.amount_paise == (10000 if committed else None)
    assert result.result["snapshot"] == snapshot.model_dump(mode="json", by_alias=True)
    assert voice.pipeline.sequence == snapshot.sequence
    assert not voice.pipeline.llm._sequential_runner_task.done()


async def test_real_tool_callbacks_serialize_writes_and_reads(voice, store, monkeypatch):
    transaction = store.transaction
    reached = asyncio.Event()
    release = asyncio.Event()

    @asynccontextmanager
    async def paused_transaction():
        async with transaction():
            yield
            reached.set()
            await release.wait()

    monkeypatch.setattr(store, "transaction", paused_transaction)
    invoke = AsyncMock(wraps=voice.pipeline.tools.invoke)
    monkeypatch.setattr(voice.pipeline.tools, "invoke", invoke)
    voice.responses.put_nowait(
        tool_reply(
            "update_facts",
            {"expectedRevision": 0, "opening": money("100")},
            "write",
            following=[("read_state", {}, "read")],
        )
    )
    await complete_turn(voice, "I have one hundred rupees.")
    await asyncio.wait_for(reached.wait(), 2)
    assert invoke.await_count == 1
    release.set()
    written = await next_frame(voice.frames, FunctionCallResultFrame)
    read = await next_frame(voice.frames, FunctionCallResultFrame)
    assert [written.tool_call_id, read.tool_call_id] == ["write", "read"]
    assert written.result["snapshot"] == read.result["snapshot"]
    assert read.result["snapshot"]["revision"] == 1
    assert read.result["snapshot"]["facts"]["opening"]["amountPaise"] == 10000


async def test_watcher_distinguishes_own_write_from_external_correction(
    voice, store, tmp_path, monkeypatch
):
    pipeline = voice.pipeline
    manager = CallManager(store, store.config, environment(tmp_path))
    call_id = uuid4()
    call = Call(
        "owner",
        call_id,
        CallState(call_id=call_id, status="active"),
        asyncio.get_running_loop().create_future(),
    )
    queue = await store.subscribe("owner")
    refreshed = asyncio.Queue()
    refresh = pipeline.refresh

    def observed_refresh(snapshot):
        refresh(snapshot)
        refreshed.put_nowait(snapshot)

    monkeypatch.setattr(pipeline, "refresh", observed_refresh)
    interrupted = asyncio.Event()
    interrupt_pipeline = pipeline.interrupt

    async def completed_interrupt():
        await interrupt_pipeline()
        interrupted.set()

    interrupt = AsyncMock(side_effect=completed_interrupt)
    monkeypatch.setattr(pipeline, "interrupt", interrupt)
    watcher = asyncio.create_task(manager.watch(call, pipeline, queue))
    try:
        await pipeline.tools.update_facts({"expectedRevision": 0, "opening": money("100")}, "own")
        own = await asyncio.wait_for(refreshed.get(), 2)
        assert own.sequence == pipeline.tools.written_sequence == 1
        interrupt.assert_not_awaited()
        await pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
        await asyncio.wait_for(voice.started.wait(), 2)
        pipeline.client_ready.set()
        external = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
        await external.update_facts({"expectedRevision": 1, "opening": money("200")}, "external")
        current = await asyncio.wait_for(refreshed.get(), 2)
        assert current.sequence == 2
        await asyncio.wait_for(interrupted.wait(), 2)
        interrupt.assert_awaited_once()
        stale = await pipeline.tools.review_plan({"expectedRevision": 1})
        assert stale["stateChanged"] and stale["snapshot"]["revision"] == 2
        assert "review" not in stale
        pipeline.refresh(own)
        assert pipeline.sequence == 2
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(voice.requests.get(), store.config.voice.speech_timeout_seconds)
        await recognize(voice, "The cash correction is right.")
        await pipeline.worker.queue_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
        request = await asyncio.wait_for(
            voice.requests.get(), store.config.voice.speech_timeout_seconds + 1
        )
        state = next(
            message["content"]
            for message in request["messages"]
            if message["content"].startswith("Canonical application state;")
        )
        assert json.loads(state.split("\n", 1)[1])["snapshot"] == current.model_dump(
            mode="json", by_alias=True
        )
        assert any("Saved figures changed" in message["content"] for message in request["messages"])
        assert await store.get("owner") == current
    finally:
        watcher.cancel()
        with suppress(asyncio.CancelledError):
            await watcher
        store.unsubscribe("owner", queue)
