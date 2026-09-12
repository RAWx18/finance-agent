# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from azure.cognitiveservices.speech import CancellationErrorCode, CancellationReason

from app.speech import SpeechSynthesis, SynthesisFailure


@pytest.mark.parametrize(
    "code,reason,recoverable",
    [
        (CancellationErrorCode.ServiceError, CancellationReason.Error, True),
        (CancellationErrorCode.ServiceTimeout, CancellationReason.Error, True),
        (CancellationErrorCode.NoError, CancellationReason.CancelledByUser, True),
        (CancellationErrorCode.AuthenticationFailure, CancellationReason.Error, False),
        (CancellationErrorCode.Forbidden, CancellationReason.Error, False),
        (CancellationErrorCode.BadRequest, CancellationReason.Error, False),
        (CancellationErrorCode.RuntimeError, CancellationReason.Error, False),
    ],
)
async def test_synthesis_cancellation_keeps_safe_provider_diagnostics(
    monkeypatch, caplog, code, reason, recoverable
):
    """Classify SDK cancellation without turning service errors into anonymous fatal errors."""
    provider = Mock()
    monkeypatch.setattr("app.speech.SpeechSynthesizer", Mock(return_value=provider))
    speech = SpeechSynthesis(api_key="synthetic", region="centralindia", sample_rate=24000)
    speech.get_event_loop = Mock(return_value=asyncio.get_running_loop())
    speech.push_error_frame = AsyncMock()

    def cancel(_):
        """Deliver a synthetic SDK cancellation with deliberately private diagnostic text."""
        provider.synthesis_canceled.connect.call_args.args[0](
            SimpleNamespace(
                result=SimpleNamespace(
                    cancellation_details=SimpleNamespace(
                        error_code=code, reason=reason, error_details="private-token-and-utterance"
                    )
                )
            )
        )

    provider.speak_ssml_async.side_effect = cancel
    assert [frame async for frame in speech.run_tts("Private financial text.", "test")] == []
    speech.push_error_frame.assert_awaited_once()
    call = speech.push_error_frame.call_args
    assert isinstance(call.args[0].exception, SynthesisFailure) == recoverable
    assert call.kwargs.get("force_treat_as_permanent", False) == (not recoverable)
    assert f"code={code.name}" in caplog.text
    assert f"reason={reason.name}" in caplog.text
    assert "private-token-and-utterance" not in caplog.text
    assert "Private financial text" not in caplog.text
    provider.stop_speaking_async.assert_called_once()


@pytest.mark.parametrize("kind", ["audio", "canceled"])
async def test_queued_synthesis_event_cannot_escape_local_retirement(monkeypatch, kind):
    """Reject callbacks queued just before interruption retires their request."""
    requested = asyncio.Event()
    provider = Mock()
    provider.speak_ssml_async.side_effect = lambda _: requested.set()
    monkeypatch.setattr("app.speech.SpeechSynthesizer", Mock(return_value=provider))
    speech = SpeechSynthesis(api_key="synthetic", region="centralindia", sample_rate=24000)
    speech.get_event_loop = Mock(return_value=asyncio.get_running_loop())
    speech.push_error_frame = AsyncMock()
    stream = speech.run_tts("Interrupted text.", "test")
    pending = asyncio.create_task(anext(stream, None))
    try:
        await asyncio.wait_for(requested.wait(), 1)
        event = SimpleNamespace(
            result=SimpleNamespace(
                audio_data=b"\x01\x00",
                cancellation_details=SimpleNamespace(
                    error_code=CancellationErrorCode.NoError,
                    reason=CancellationReason.CancelledByUser,
                ),
            )
        )
        signal = provider.synthesizing if kind == "audio" else provider.synthesis_canceled
        signal.connect.call_args.args[0](event)
        asyncio.get_running_loop().call_soon(speech._retire_synthesis)
        assert await asyncio.wait_for(pending, 1) is None
        speech.push_error_frame.assert_not_awaited()
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        await stream.aclose()
        await speech.cleanup()
