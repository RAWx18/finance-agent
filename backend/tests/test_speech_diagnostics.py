# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from azure.cognitiveservices.speech import CancellationErrorCode, CancellationReason, ResultReason

from app.speech import SpeechRecognition, SpeechSynthesis

PRIVATE = "private transcript key token financial payload"


def events(caplog):
    """Read only structured payload-free diagnostic records."""
    assert PRIVATE not in caplog.text
    records = [record for record in caplog.records if getattr(record, "safe_diagnostic", False)]
    assert all(record.exc_info is None and record.stack_info is None for record in records)
    return [json.loads(record.getMessage()) for record in records]


@pytest.fixture
async def recognition():
    """Use local SDK configuration with mocked event delivery and provider operations."""
    stt = SpeechRecognition(api_key="test-only", region="centralindia", phrases=[])
    stt.call_id = uuid4()
    stt.get_event_loop = Mock(return_value=asyncio.get_running_loop())
    stt.delivery = asyncio.get_running_loop().create_future()

    def schedule(coroutine, name):
        task = asyncio.create_task(coroutine)
        stt.delivery.set_result(task)
        return task

    stt.create_task = Mock(side_effect=schedule)
    stt.push_error = AsyncMock()
    stt.push_frame = AsyncMock()
    stt._connect = AsyncMock()
    stt._disconnect = AsyncMock()
    stt._recognition_id = object()
    return stt


@pytest.mark.parametrize("kind", ["canceled", "stopped"])
@pytest.mark.parametrize(
    "code", [CancellationErrorCode.ConnectionFailure, CancellationErrorCode.AuthenticationFailure]
)
async def test_recognition_cancellation_keeps_enum_code_and_call(recognition, caplog, kind, code):
    """SDK cancellation labels survive without cancellation details or transcript content."""
    event = SimpleNamespace(
        cancellation_details=SimpleNamespace(
            error_code=code, reason=CancellationReason.Error, error_details=PRIVATE
        ),
        result=SimpleNamespace(text=PRIVATE),
    )
    recognition._receive(event, kind, recognition._recognition_id)
    await (await asyncio.wait_for(recognition.delivery, 1))
    diagnostic = next(
        item for item in events(caplog) if item["event"] == "speech.recognitionStopped"
    )
    assert diagnostic["call_id"] == str(recognition.call_id)
    assert diagnostic["stage"] == kind and diagnostic["category"] == code.name
    assert diagnostic["reason"] == "Error"
    recognition._disconnect.assert_awaited_once()
    if code == CancellationErrorCode.ConnectionFailure:
        recognition._connect.assert_awaited_once()
        recognition.push_error.assert_not_awaited()
    else:
        recognition.push_error.assert_awaited_once()
        recognition._connect.assert_not_awaited()


async def test_stale_recognition_events_are_ignored(recognition, caplog):
    """Callbacks from retired native sessions do not log or affect the active recognizer."""
    recognition._receive(Mock(name=PRIVATE), "canceled", object())
    await asyncio.sleep(0)
    recognition.create_task.assert_not_called()
    recognition._disconnect.assert_not_awaited()
    recognition.push_error.assert_not_awaited()
    assert not events(caplog)


@pytest.mark.parametrize(
    "text,reason,label",
    [
        (None, ResultReason.RecognizedSpeech, "RecognizedSpeech"),
        (PRIVATE, CancellationReason.Error, "unknown"),
    ],
)
async def test_malformed_recognition_logs_only_expected_enum(
    recognition, caplog, text, reason, label
):
    """Malformed results expose enum labels rather than result representations or text."""
    recognition._receive(
        SimpleNamespace(result=SimpleNamespace(text=text, reason=reason)),
        "recognized",
        recognition._recognition_id,
    )
    await (await asyncio.wait_for(recognition.delivery, 1))
    diagnostic = next(
        item for item in events(caplog) if item["event"] == "speech.recognitionMalformed"
    )
    assert diagnostic["reason"] == label
    assert diagnostic["call_id"] == str(recognition.call_id)
    recognition.push_frame.assert_not_awaited()
    recognition.push_error.assert_awaited_once()


async def test_recognition_startup_cause_survives_failed_native_cleanup(monkeypatch, caplog):
    """Startup cause is persisted before a secondary native shutdown exception escapes."""
    stt = SpeechRecognition(api_key="test-only", region="centralindia", phrases=[])
    stt.call_id = uuid4()
    recognizer = Mock()
    failure = RuntimeError(PRIVATE)
    failure.__cause__ = OSError(PRIVATE)
    recognizer.start_continuous_recognition_async.return_value.get.side_effect = failure
    recognizer.stop_continuous_recognition_async.return_value.get.side_effect = ValueError(PRIVATE)
    monkeypatch.setattr("app.speech.SpeechRecognizer", Mock(return_value=recognizer))
    monkeypatch.setattr("app.speech.PhraseListGrammar.from_recognizer", Mock())
    monkeypatch.setattr("app.speech.PushAudioInputStream", Mock())
    monkeypatch.setattr("app.speech.AudioConfig", Mock())
    with pytest.raises(ValueError):
        await stt._connect()
    records = events(caplog)
    startup = next(
        item
        for item in records
        if item["event"] == "speech.recognitionStart" and item["status"] == "failed"
    )
    cleanup = next(item for item in records if item["event"] == "speech.recognitionCleanup")
    assert records.index(startup) < records.index(cleanup)
    assert [error["type"] for error in startup["errors"]] == ["RuntimeError", "OSError"]
    assert cleanup["errors"][0]["type"] == "ValueError"
    assert startup["call_id"] == cleanup["call_id"] == str(stt.call_id)
    assert stt._native_stop.done() and stt._speech_recognizer is recognizer


@pytest.fixture
async def synthesis(monkeypatch):
    """Replace native synthesis with local signals and mock frame publication."""
    synthesizer = Mock()
    monkeypatch.setattr("app.speech.SpeechSynthesizer", Mock(return_value=synthesizer))
    tts = SpeechSynthesis(api_key="test-only", region="centralindia", sample_rate=24000)
    tts.call_id = uuid4()
    tts.get_event_loop = Mock(return_value=asyncio.get_running_loop())
    tts.push_error_frame = AsyncMock()
    tts.start_tts_usage_metrics = AsyncMock()
    return tts, synthesizer


@pytest.mark.parametrize(
    "code,reason,category",
    [
        (CancellationErrorCode.ServiceTimeout, CancellationReason.Error, "recoverable"),
        (CancellationErrorCode.NoError, CancellationReason.CancelledByUser, "recoverable"),
        (CancellationErrorCode.AuthenticationFailure, CancellationReason.Error, "permanent"),
        (Mock(name=PRIVATE), Mock(name=PRIVATE), "permanent"),
    ],
)
async def test_synthesis_cancellation_classification(synthesis, caplog, code, reason, category):
    """Classify cancellation without trusting arbitrary enum-like objects or provider details."""
    tts, synthesizer = synthesis
    event = SimpleNamespace(
        result=SimpleNamespace(
            cancellation_details=SimpleNamespace(
                error_code=code, reason=reason, error_details=PRIVATE
            )
        )
    )
    synthesizer.speak_ssml_async.side_effect = lambda _: (
        synthesizer.synthesis_canceled.connect.call_args.args[0](event)
    )
    assert not [frame async for frame in tts.run_tts(PRIVATE, PRIVATE)]
    records = events(caplog)
    cancelled = next(item for item in records if item["event"] == "speech.synthesisCancelled")
    failure = next(item for item in records if item["event"] == "speech.synthesisFailed")
    assert cancelled["category"] == (
        code.name if isinstance(code, CancellationErrorCode) else "unknown"
    )
    assert cancelled["reason"] == (
        reason.name if isinstance(reason, CancellationReason) else "unknown"
    )
    assert failure["category"] == category
    assert cancelled["call_id"] == failure["call_id"] == str(tts.call_id)
    assert bool(tts.push_error_frame.call_args.kwargs.get("force_treat_as_permanent")) == (
        category == "permanent"
    )
    await tts.cleanup()
    synthesizer.stop_speaking_async.assert_called_once()


@pytest.mark.parametrize("failure", ["malformed", "exception", "timeout"])
async def test_synthesis_failure_payloads_never_enter_diagnostics(synthesis, caplog, failure):
    """Malformed audio, deadlines and SDK exceptions retain only operational evidence."""
    tts, synthesizer = synthesis
    if failure == "malformed":
        synthesizer.speak_ssml_async.side_effect = lambda _: (
            synthesizer.synthesizing.connect.call_args.args[0](
                SimpleNamespace(result=SimpleNamespace(audio_data=PRIVATE))
            )
        )
    elif failure == "exception":
        synthesizer.speak_ssml_async.side_effect = RuntimeError(PRIVATE)
    else:
        tts.config = tts.config.model_copy(update={"tts_first_audio_seconds": 0.01})
    assert not [frame async for frame in tts.run_tts(PRIVATE, PRIVATE)]
    diagnostic = next(item for item in events(caplog) if item["event"] == "speech.synthesisFailed")
    assert diagnostic["call_id"] == str(tts.call_id)
    assert diagnostic["stage"] == ("audio" if failure == "malformed" else "firstAudio")
    assert diagnostic["category"] == ("recoverable" if failure == "timeout" else "permanent")
