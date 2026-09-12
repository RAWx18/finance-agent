# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4, uuid5

import httpx
import pytest
from pipecat.frames.frames import (
    ErrorFrame,
    FunctionCallResultFrame,
    InterruptionFrame,
    TTSAudioRawFrame,
    TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection

from app.config import DiagnosticsConfig
from app.diagnostics import diagnostic_sink
from app.models import Action, Workspace, WorkspaceQuestion
from app.speech import SpeechSynthesis
from app.voice_pipeline import VoicePipeline

from .conftest import money
from .test_voice_errors import text_reply
from .test_voice_opening import render
from .test_voice_opening import synthesis as synthesis
from .test_voice_retry import acknowledge
from .test_voice_turns import complete_turn, next_frame, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries

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


def events(caplog, event):
    """Select persisted-safe events, not console telemetry or provider log records."""
    return [
        value
        for record in caplog.records
        if getattr(record, "safe_diagnostic", False)
        and (value := json.loads(record.getMessage()))["event"] == event
    ]


@pytest.fixture
def retained(tmp_path):
    """Keep the real bounded diagnostic sink open throughout the exercised failure."""
    with diagnostic_sink(tmp_path / "diagnostics", DiagnosticsConfig()):
        yield tmp_path / "diagnostics" / "diagnostics.jsonl"


@pytest.mark.parametrize("source", ["task", "stateRefresh"])
async def test_first_terminal_failure_logs_its_source_without_private_content(
    voice, store, monkeypatch, caplog, source, retained
):
    """Expose previously silent failures once without losing saved figures or leaking payloads."""
    voice.expect_failure = True
    stopped = asyncio.Event()
    voice.failed.side_effect = stopped.set
    get = store.get
    saved = await voice.pipeline.tools.update_facts(
        {"expectedRevision": 0, "opening": money("6000")}, "saved"
    )
    baseline = await get("owner")
    if source == "task":

        async def crash():
            """Raise a diagnostic-only synthetic failure with secret-like message content."""
            try:
                raise OSError("private-provider-secret")
            except OSError as error:
                raise RuntimeError("private-token private-financial-text") from error

        task = voice.pipeline.worker.task_manager.create_task(crash(), "private-task-token")
        await task
    else:
        monkeypatch.setattr(
            store, "get", AsyncMock(side_effect=RuntimeError("private-financial-text"))
        )
        await complete_turn(voice, "Please explain my plan.")
    await asyncio.wait_for(stopped.wait(), 2)
    records = [
        record.message for record in caplog.records if record.message.startswith("Voice stopped ")
    ]
    assert len(records) == 1
    assert f"stage={'workerTask' if source == 'task' else 'modelStateRefresh'}" in records[0]
    assert "exception=RuntimeError" in records[0]
    assert "call=" in records[0] and "generation=" in records[0] and "stack=[" in records[0]
    assert "private-token" not in records[0] and "private-financial-text" not in records[0]
    assert "6000" not in records[0]
    assert saved["snapshot"]["facts"]["opening"]["amountPaise"] == 600000
    assert (await get("owner")).facts.opening.amount_paise == 600000
    assert voice.pipeline.revoked
    (diagnostic,) = events(caplog, "voice.stopped")
    assert diagnostic["call_id"] == str(voice.pipeline.call_id)
    assert diagnostic["session_id"] == str(baseline.session_id)
    assert diagnostic["financial_revision"] == baseline.revision
    assert diagnostic["sequence"] == baseline.sequence
    assert diagnostic["generation"] < voice.pipeline.generation
    assert diagnostic["state_sequence"] == voice.pipeline.state_sequence
    assert diagnostic["stage"] == ("workerTask" if source == "task" else "modelStateRefresh")
    assert diagnostic["errors"][0]["type"] == "RuntimeError"
    if source == "task":
        assert diagnostic["errors"][1]["type"] == "OSError"
        assert diagnostic["errors"][1]["relation"] == "cause"
    persisted = retained.read_text()
    assert diagnostic in [json.loads(line) for line in persisted.splitlines()]
    for private in (
        "private-token",
        "private-financial-text",
        "private-provider-secret",
        "private-task-token",
        "600000",
        "Please explain my plan.",
    ):
        assert private not in persisted
        assert private not in caplog.text


async def test_recoverable_response_failure_is_not_logged_as_terminal(
    voice, store, monkeypatch, caplog
):
    """Retain the existing Continue path for a recoverable request timeout."""
    from .test_voice_waiting import next_state

    voice.pipeline.client_ready.set()
    await voice.pipeline.tools.update_facts(
        {"expectedRevision": 0, "opening": money("100")}, "committed"
    )
    saved = await store.get("owner")
    monkeypatch.setattr(
        voice.pipeline.llm, "get_chat_completions", AsyncMock(side_effect=TimeoutError)
    )
    await complete_turn(voice, "Explain the plan.")
    state = await next_state(voice)
    assert state["state"] == "waiting" and state["reason"] == "response"
    assert not voice.pipeline.revoked
    assert not any(record.message.startswith("Voice stopped ") for record in caplog.records)
    assert await store.get("owner") == saved
    (paused,) = events(caplog, "voice.responseFailed")
    assert paused["errors"][0]["type"] == "TimeoutError"
    assert paused["stage"] == "model" and paused["waiting"]
    assert not events(caplog, "voice.stopped")


async def test_failed_recovery_logs_its_first_cause_before_generic_stop(
    voice, store, monkeypatch, caplog
):
    """Differentiate a provider timeout from the failed interruption that forces safe teardown."""
    voice.expect_failure = True
    stopped = asyncio.Event()
    voice.failed.side_effect = stopped.set
    voice.pipeline.client_ready.set()
    await voice.pipeline.tools.update_facts(
        {"expectedRevision": 0, "opening": money("6000")}, "committed"
    )
    saved = await store.get("owner")
    monkeypatch.setattr(
        voice.pipeline.llm, "get_chat_completions", AsyncMock(side_effect=TimeoutError)
    )
    interrupt = SpeechSynthesis._handle_interruption

    async def fail_recovery(service, frame, direction):
        """Fail the recovery interruption, not ordinary user barge-in."""
        if voice.pipeline.waiting:
            raise RuntimeError("private-native-payload")
        await interrupt(service, frame, direction)

    monkeypatch.setattr(SpeechSynthesis, "_handle_interruption", fail_recovery)
    await complete_turn(voice, "Explain the plan.")
    await asyncio.wait_for(stopped.wait(), 2)
    messages = [record.message for record in caplog.records]
    paused = next(
        index for index, message in enumerate(messages) if "Voice response paused" in message
    )
    terminal = next(index for index, message in enumerate(messages) if "Voice stopped " in message)
    assert paused < terminal
    assert "exception=TimeoutError" in messages[paused]
    assert "stage=synthesisInterruption" in messages[terminal]
    assert "exception=RuntimeError" in messages[terminal]
    assert "waiting=True" in messages[terminal]
    assert "private-native-payload" not in messages[terminal]
    assert await store.get("owner") == saved
    (terminal,) = events(caplog, "voice.stopped")
    assert terminal["stage"] == "synthesisInterruption"
    assert terminal["errors"][0]["type"] == "RuntimeError"
    assert events(caplog, "voice.responseFailed")[0]["call_id"] == terminal["call_id"]


async def test_retry_trace_and_publication_retain_decision_context(
    voice, synthesis, store, caplog, retained
):
    """Trace the read-only retry from empty output through publication without recording speech."""
    from .test_voice_waiting import next_state

    pipeline = voice.pipeline
    pipeline.client_ready.set()
    voice.responses.put_nowait(
        tool_reply(
            "update_facts",
            {"expectedRevision": 0, "opening": money("6000")},
            "private-provider-command",
        )
    )
    voice.responses.put_nowait(text_reply(""))
    await complete_turn(voice, "private-utterance six thousand rupees")
    waiting = await next_state(voice)
    offered = await next_state(voice)
    baseline = await store.get("owner")
    reply = "private-answer When is your income expected?"
    voice.responses.put_nowait(text_reply(reply))
    await acknowledge(voice, offered)
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, reply)
    await next_frame(voice.frames, TTSAudioRawFrame)
    await next_frame(voice.frames, TTSTextFrame)
    order = [
        "voice.responseFailed",
        "voice.retryOffered",
        "voice.retryAcknowledged",
        "voice.textPublished",
        "voice.retryCompleted",
        "voice.firstAudio",
    ]
    trace = [
        json.loads(record.getMessage())
        for record in caplog.records
        if getattr(record, "safe_diagnostic", False)
    ]
    positions = [
        next(index for index, event in enumerate(trace) if event["event"] == name) for name in order
    ]
    assert positions == sorted(positions)
    for name in order:
        (event,) = events(caplog, name)
        assert event["call_id"] == str(pipeline.call_id)
        assert event["session_id"] == str(baseline.session_id)
        assert event["financial_revision"] == baseline.revision
        assert event["current_action"] == "clarify"
        assert event["question_scope"] == "income"
    for name in ("voice.retryOffered", "voice.retryAcknowledged", "voice.retryCompleted"):
        (event,) = events(caplog, name)
        assert event["retry_of"] == waiting["sequence"]
        assert event["state_sequence"] == offered["sequence"]
    (published,) = events(caplog, "voice.textPublished")
    assert published["completion_chars"] == len(reply)
    assert published["retry_attempts"] == 1
    assert published["generation"] == pipeline.generation
    (succeeded,) = events(caplog, "voice.toolSucceeded")
    assert succeeded["command_id"] == str(uuid5(pipeline.call_id, "private-provider-command"))
    assert succeeded["saved"] is True and succeeded["tool"] == "update_facts"
    assert len(events(caplog, "voice.modelStarted")) == 3
    assert len(events(caplog, "voice.modelCompleted")) == 3
    (turn,) = events(caplog, "voice.userTurnCompleted")
    assert turn["completed_turns"] == 1
    assert await store.get("owner") == baseline
    for private in ("private-utterance", "private-answer", "private-provider-command", "600000"):
        assert private not in retained.read_text()
    assert not events(caplog, "voice.stopped")


@pytest.mark.parametrize("outcome", ["exhausted", "speaking", "end", "ackState"])
async def test_retry_exhaustion_and_aborts_have_controlled_reasons(voice, store, caplog, outcome):
    """Each bounded retry exit is attributable without making another provider request."""
    from .test_voice_waiting import next_state

    pipeline = voice.pipeline
    pipeline.client_ready.set()
    voice.responses.put_nowait(httpx.Response(503, json={"error": {"message": "private-secret"}}))
    await complete_turn(voice, "private-question")
    await next_state(voice)
    if outcome == "speaking":
        pipeline.user_speaking = True
        await next_state(voice)
    elif outcome == "end":
        pipeline.invalidate()
    else:
        offered = await next_state(voice)
        if outcome == "ackState":
            await pipeline.tools.update_facts(
                {"expectedRevision": 0, "opening": money("100")}, "external"
            )
        else:
            voice.responses.put_nowait(
                httpx.Response(503, json={"error": {"message": "private-secret"}})
            )
        await acknowledge(voice, offered)
        await next_state(voice)
    (event,) = events(
        caplog, "voice.retryExhausted" if outcome == "exhausted" else "voice.retryAborted"
    )
    assert (
        event["reason"]
        == {
            "exhausted": "attemptLimit",
            "speaking": "userSpeaking",
            "end": "revoked",
            "ackState": "generationChanged",
        }[outcome]
    )
    assert not events(caplog, "voice.retryCompleted")
    assert not events(caplog, "voice.stopped")


@pytest.mark.parametrize("kind", ["income", "essential"])
async def test_publication_context_scope_uses_selected_records_not_alternative_questions(
    voice, store, caplog, kind
):
    """A record clarification exposes only its category, never the record identity or label."""
    await voice.pipeline.tools.update_facts(
        {
            "expectedRevision": 0,
            "records": [{"kind": kind, "label": "private-label", "amount": money(None, "unknown")}],
        },
        "record",
    )
    snapshot = await store.get("owner")
    identity = snapshot.facts.records[0].id
    action = Action(
        id="clarify:" + identity,
        kind="clarify",
        record_ids=[identity],
        before_date=None,
        question="private-question",
        consequence_ids=[],
        if_declined_consequence_ids=[],
    )
    question = WorkspaceQuestion(
        id=identity,
        action_id=action.id,
        fields=["amount"],
        record_ids=[identity],
        why="private-reason",
        resolves=[],
        changes=[],
        blocks=["immediateDecision"],
        before_date=None,
        priority=1,
    )
    alternative = question.model_copy(
        update={
            "id": "income",
            "action_id": "clarify:income",
            "record_ids": [],
            "fields": ["income"],
        }
    )
    snapshot = snapshot.model_copy(
        update={"workspace": Workspace(actions=[action], questions=[alternative, question])}
    )
    voice.pipeline.refresh(snapshot)
    voice.pipeline.diagnostic("voice.textPublished", completion_chars=42)
    (event,) = events(caplog, "voice.textPublished")
    assert event["current_action"] == "clarify" and event["question_scope"] == kind
    assert identity not in json.dumps(event)
    assert "private-" not in json.dumps(event)


async def test_first_audio_is_logged_once_per_current_generation(voice, caplog):
    """Repeated frames and stale generations do not produce frame-rate diagnostic traffic."""
    guard = next(item for item in voice.pipeline.processors if type(item).__name__ == "OutputGuard")
    for _ in range(2):
        for _ in range(3):
            frame = TTSAudioRawFrame(audio=b"\x00\x00", sample_rate=24000, num_channels=1)
            frame.metadata["voice_generation"] = voice.pipeline.generation
            await guard.process_frame(frame, FrameDirection.DOWNSTREAM)
        voice.pipeline.generation += 1
    await guard.process_frame(frame, FrameDirection.DOWNSTREAM)
    audio = events(caplog, "voice.firstAudio")
    assert len(audio) == 2
    assert audio[1]["generation"] == audio[0]["generation"] + 1
    assert [item["audio_frames"] for item in audio] == [1, 4]


async def test_caption_failure_is_warned_once_without_ending_call(voice, caplog):
    """Nonfatal caption failures stay nonfatal and retain a safe error cause once."""
    voice.pipeline.history = SimpleNamespace(
        capture=AsyncMock(side_effect=OSError("private-caption"))
    )
    model = SimpleNamespace(model_dump=lambda **_: {"text": "private-caption"})
    # The failed capture precedes serialization; isolate only the transport serialization boundary.
    from pipecat.processors.frameworks.rtvi import RTVIProcessor

    with patch.object(RTVIProcessor, "push_transport_message", AsyncMock()):
        for _ in range(2):
            await voice.pipeline.worker.rtvi.push_transport_message(model)
    (event,) = events(caplog, "voice.captionFailed")
    assert event["severity"] == "warning"
    assert event["errors"][0]["type"] == "OSError"
    assert voice.pipeline.metrics["history_failed"] == 2
    assert not voice.pipeline.revoked
    assert "private-caption" not in caplog.text


@pytest.mark.parametrize("event", ["on_participant_left", "on_left"])
async def test_transport_departure_never_logs_provider_reason(
    voice, voice_boundaries, caplog, event
):
    """Unexpected transport loss is diagnosed without changing the shutdown callback policy."""
    callback = next(
        call.args[1]
        for call in voice_boundaries.transport.add_event_handler.call_args_list
        if call.args[0] == event
    )
    if event == "on_participant_left":
        await callback(None, {"name": "private-participant"}, "private-provider-reason")
        assert voice.pipeline.stopping
    else:
        voice.expect_failure = True
        await callback(None)
        assert voice.pipeline.revoked
    (record,) = events(caplog, "voice.transportLeft")
    assert record["call_id"] == str(voice.pipeline.call_id)
    assert record["reason"] == (
        "participantLeft" if event == "on_participant_left" else "unexpectedDeparture"
    )
    assert "private-provider-reason" not in caplog.text
    assert "private-participant" not in caplog.text


async def test_native_cleanup_error_retains_call_session_and_cause(voice, caplog):
    """Cleanup diagnostics remain correlated after tools and live context are released."""
    pipeline = VoicePipeline()
    pipeline.call_id, pipeline.session_id = uuid4(), uuid4()
    pipeline.financial_revision = 4
    error = RuntimeError("private-native")
    error.__cause__ = OSError("private-provider")
    pipeline.processors = [SimpleNamespace(cleanup=AsyncMock(side_effect=error))]
    with pytest.raises(RuntimeError, match="Voice resource cleanup failed"):
        await pipeline.close()
    (event,) = events(caplog, "voice.cleanupFailed")
    assert event["call_id"] == str(pipeline.call_id)
    assert event["session_id"] == str(pipeline.session_id)
    assert event["financial_revision"] == 4
    assert [item["type"] for item in event["errors"]] == ["RuntimeError", "OSError"]
    assert "private-native" not in caplog.text and "private-provider" not in caplog.text


async def test_tool_retry_records_original_command_identity(voice, store, caplog):
    """A retry tool reports the retained command UUID, not its new provider call identity."""
    result = await voice.pipeline.tools.invoke(
        "update_facts", {"expectedRevision": 0, "opening": money("100")}, "original"
    )
    identity = result["financialWrite"]["writeId"]
    baseline = await store.get("owner")
    voice.responses.put_nowait(tool_reply("retry_write", {"writeId": identity}, "private-retry"))
    await complete_turn(voice, "private-retry-request")
    await next_frame(voice.frames, FunctionCallResultFrame)
    for name in ("voice.toolStarted", "voice.toolSucceeded"):
        (event,) = events(caplog, name)
        assert event["command_id"] == identity
        assert event["tool"] == "retry_write"
        assert event["call_id"] == str(voice.pipeline.call_id)
        assert event["financial_revision"] == baseline.revision
    assert events(caplog, "voice.toolSucceeded")[0]["saved"] is True
    assert await store.get("owner") == baseline


@pytest.mark.parametrize("failure", ["exception", "result"])
async def test_tool_failures_record_only_safe_verdicts(voice, monkeypatch, caplog, failure):
    """Tool exceptions and structured rejections remain distinct, correlated failure outcomes."""
    if failure == "exception":
        voice.expect_failure = True
        stopped = asyncio.Event()
        voice.failed.side_effect = stopped.set
        invoke = AsyncMock(side_effect=ExceptionGroup("private-group", [OSError("private-cause")]))
    else:
        invoke = AsyncMock(
            return_value={"code": "invalidFacts", "saved": False, "message": "private-tool-result"}
        )
    monkeypatch.setattr(voice.pipeline.tools, "invoke", invoke)
    voice.responses.put_nowait(tool_reply("read_state", {}, "private-tool-call"))
    await complete_turn(voice, "private-tool-question")
    if failure == "exception":
        await asyncio.wait_for(stopped.wait(), 2)
    else:
        await next_frame(voice.frames, FunctionCallResultFrame)
    (event,) = events(caplog, "voice.toolFailed")
    assert event["tool"] == "read_state" and event["status"] == "failed"
    assert event["call_id"] == str(voice.pipeline.call_id)
    if failure == "exception":
        assert [item["type"] for item in event["errors"]] == ["ExceptionGroup", "OSError"]
        assert events(caplog, "voice.stopped")[0]["stage"] == "toolCallback"
    else:
        assert event["code"] == "invalidFacts" and event["saved"] is False
        assert not events(caplog, "voice.stopped")
    assert "private-" not in json.dumps(event)


async def test_interrupted_retry_cannot_complete_on_an_unrelated_reply(voice, caplog):
    """An accepted retry loses its diagnostic ownership when the user interrupts it."""
    from .test_voice_waiting import next_state

    voice.pipeline.client_ready.set()
    voice.responses.put_nowait(httpx.Response(503, json={"error": {"message": "unavailable"}}))
    await complete_turn(voice, "private-question")
    await next_state(voice)
    offered = await next_state(voice)
    await acknowledge(voice, offered)
    while (await asyncio.wait_for(voice.requests.get(), 2))["tool_choice"] != "none":
        pass
    processed = asyncio.Event()
    voice.pipeline.llm.add_event_handler(
        "on_after_process_frame",
        lambda _, frame: processed.set() if isinstance(frame, InterruptionFrame) else None,
    )
    await voice.pipeline.worker.queue_frame(InterruptionFrame())
    await asyncio.wait_for(processed.wait(), 2)
    (aborted,) = events(caplog, "voice.retryAborted")
    assert aborted["reason"] == "interrupted"
    assert aborted["retry_of"] == offered["retryOf"]
    assert voice.pipeline.retry_trace is None
    assert not events(caplog, "voice.retryCompleted")


async def test_terminal_processor_error_retains_source_without_provider_payload(voice, caplog):
    """A terminal frame without an exception still identifies its failing processor."""
    voice.expect_failure = True
    await voice.pipeline.worker.rtvi.process_frame(
        ErrorFrame("private-provider-payload", processor=voice.stt),
        FrameDirection.DOWNSTREAM,
    )
    (event,) = events(caplog, "voice.stopped")
    assert event["stage"] == "processorError"
    assert event["source"] == "SpeechRecognition"
    assert "private-provider-payload" not in caplog.text
