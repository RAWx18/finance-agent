# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from types import SimpleNamespace

import pytest
from azure.cognitiveservices.speech import CancellationErrorCode
from pipecat.frames.frames import FunctionCallResultFrame

import app.speech
from app.speech import RECOGNITION_RESTARTS

from .test_voice_turns import complete_turn, next_frame, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries

pytestmark = pytest.mark.parametrize("voice", [{"speech_timeout_seconds": 0.3}], indirect=True)


@pytest.fixture(autouse=True)
def failure_signal(voice):
    """Expose pipeline failure as an awaitable event."""
    voice.failed_event = asyncio.Event()
    voice.failed.side_effect = voice.failed_event.set


async def cancel_recognition(voice, code, *, restart: bool):
    """Deliver an SDK cancellation for the live session and await the expected outcome."""
    stt = voice.stt
    factory = app.speech.SpeechRecognizer
    started = asyncio.Event()
    recognizer = factory.return_value
    factory.side_effect = lambda *args, **kwargs: (started.set(), recognizer)[1]
    event = SimpleNamespace(cancellation_details=SimpleNamespace(error_code=code))
    await asyncio.to_thread(stt._receive, event, "canceled", stt._recognition_id)
    if restart:
        await asyncio.wait_for(started.wait(), 2)
        assert stt._recognition_id is not None
    else:
        await asyncio.wait_for(voice.failed_event.wait(), 2)
        assert not started.is_set()
    factory.side_effect = None


async def test_transient_recognition_cancellation_restarts_without_ending_the_call(voice, store):
    """A service-side recognition drop starts a fresh recognizer and the next turn still saves."""
    await cancel_recognition(voice, CancellationErrorCode.ConnectionFailure, restart=True)
    assert voice.stt._restarts == 1 and not voice.pipeline.revoked
    voice.responses.put_nowait(
        tool_reply(
            "update_facts",
            {"expectedRevision": 0, "opening": {"amount": "200", "status": "exact"}},
            "saved",
        )
    )
    await complete_turn(voice, "I have two hundred rupees.")
    assert (await asyncio.wait_for(voice.requests.get(), 2))["tool_choice"] == "required"
    result = await next_frame(voice.frames, FunctionCallResultFrame)
    assert result.result["saved"] is True
    assert (await store.get("owner")).revision == 1
    voice.failed.assert_not_called()


async def test_exhausted_restart_budget_ends_the_call(voice):
    """Repeated service drops beyond the restart budget stop media safely."""
    voice.expect_failure = True
    for _ in range(RECOGNITION_RESTARTS):
        await cancel_recognition(voice, CancellationErrorCode.ServiceUnavailable, restart=True)
    assert voice.stt._restarts == RECOGNITION_RESTARTS and not voice.pipeline.revoked
    await cancel_recognition(voice, CancellationErrorCode.ServiceUnavailable, restart=False)
    assert voice.pipeline.revoked


async def test_authentication_cancellation_is_terminal(voice):
    """An authentication failure never restarts recognition."""
    voice.expect_failure = True
    await cancel_recognition(voice, CancellationErrorCode.AuthenticationFailure, restart=False)
    assert voice.stt._restarts == 0 and voice.pipeline.revoked
