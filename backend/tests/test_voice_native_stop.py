# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from threading import Event
from types import SimpleNamespace
from uuid import uuid4

import pytest
from azure.cognitiveservices.speech import CancellationErrorCode
from pipecat.frames.frames import (
    OutputTransportMessageUrgentFrame,
    TTSAudioRawFrame,
    TTSTextFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)

from app.speech import SpeechSynthesis

from .test_voice_errors import text_reply
from .test_voice_opening import render
from .test_voice_opening import synthesis as synthesis
from .test_voice_turns import next_frame, recognize, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries

pytestmark = pytest.mark.parametrize(
    "voice",
    [
        {
            "speech_timeout_seconds": 0.3,
            "tts_first_audio_seconds": 2,
            "tts_progress_seconds": 2,
            "shutdown_seconds": 1,
        }
    ],
    indirect=True,
)


def diagnostics(caplog, event):
    """Select persisted-safe diagnostic events by name."""
    return [
        payload
        for record in caplog.records
        if getattr(record, "safe_diagnostic", False)
        and (payload := json.loads(record.getMessage()))["event"] == event
    ]


def queue_reply(voice, reply):
    """Queue the required read-only tool round followed by the spoken reply."""
    voice.responses.put_nowait(tool_reply("read_state", {}, str(uuid4())))
    voice.responses.put_nowait(text_reply(reply))


async def speak_turn(voice, synthesis, utterance, reply):
    """Complete a user turn and return the synthesizer handling the assistant's reply."""
    queue_reply(voice, reply)
    await voice.pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
    await recognize(voice, utterance)
    await voice.pipeline.worker.queue_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
    await asyncio.wait_for(voice.turns.get(), 2)
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    return instance


async def hung_barge_in(voice, synthesis):
    """Interrupt streaming speech while the SDK's native stop hangs like an unreachable service."""
    pipeline = voice.pipeline
    pipeline.client_ready.set()
    instance = await speak_turn(voice, synthesis, "When is rent due?", "Rent is due on Monday.")
    await asyncio.to_thread(
        instance.synthesizing.connect.call_args.args[0],
        SimpleNamespace(result=SimpleNamespace(audio_data=b"\x01\x00" * 480)),
    )
    await next_frame(voice.frames, TTSAudioRawFrame)
    release = Event()
    entered = asyncio.Event()
    loop = asyncio.get_running_loop()

    def stop():
        """Block the native stop until released, signalling entry from its thread."""
        loop.call_soon_threadsafe(entered.set)
        release.wait()

    instance.stop_speaking_async.return_value.get.side_effect = stop
    await pipeline.worker.queue_frame(VADUserStartedSpeakingFrame())
    await asyncio.wait_for(entered.wait(), 2)
    return instance, release


async def test_hung_native_stop_does_not_block_or_end_the_conversation(voice, synthesis, caplog):
    """A barge-in whose SDK stop hangs keeps captions, state, and the next reply flowing."""
    pipeline = voice.pipeline
    tts = next(item for item in pipeline.processors if isinstance(item, SpeechSynthesis))
    instance, release = await hung_barge_in(voice, synthesis)
    try:
        await pipeline.send_state()
        async with asyncio.timeout(0.5):
            while True:
                frame = await voice.frames.get()
                if isinstance(frame, OutputTransportMessageUrgentFrame) and (
                    frame.message.get("data", {}).get("type") == "conversation-state"
                ):
                    break
        queue_reply(voice, "Electricity is due on Friday.")
        await recognize(voice, "Actually, when is electricity due?")
        await pipeline.worker.queue_frame(VADUserStoppedSpeakingFrame(stop_secs=0.2))
        await asyncio.wait_for(voice.turns.get(), 2)
        retry, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
        assert retry is not instance
        await render(instance, "Stale audio must not escape.")
        await render(retry, "Electricity is due on Friday.")
        assert (await next_frame(voice.frames, TTSTextFrame)).text.strip() == (
            "Electricity is due on Friday."
        )
        assert not pipeline.revoked and not pipeline.waiting
        assert tts._native_stop is not None and not tts._native_stop.done()
        voice.failed.assert_not_called()
        assert not diagnostics(caplog, "voice.stopped")
        assert not diagnostics(caplog, "speech.synthesisCleanup")
    finally:
        release.set()
    await asyncio.wait_for(asyncio.shield(tts._native_stop), 2)
    instance.stop_speaking_async.return_value.get.assert_called_once()
    (settled,) = diagnostics(caplog, "speech.synthesisCleanup")
    assert settled["status"] == "completed"
    assert tts._speech_synthesizer is None


async def test_recognition_loss_after_hung_stop_ends_in_error_not_listening(voice, synthesis):
    """Losing recognition after the hung barge-in fails the call instead of leaving it idle."""
    voice.expect_failure = True
    failed = asyncio.Event()
    voice.failed.side_effect = failed.set
    tts = next(item for item in voice.pipeline.processors if isinstance(item, SpeechSynthesis))
    _, release = await hung_barge_in(voice, synthesis)
    try:
        voice.stt._speech_recognizer.canceled.connect.call_args.args[0](
            SimpleNamespace(
                cancellation_details=SimpleNamespace(
                    error_code=CancellationErrorCode.AuthenticationFailure
                )
            )
        )
        await asyncio.wait_for(failed.wait(), 2)
        assert voice.pipeline.revoked
    finally:
        release.set()
    await asyncio.wait_for(asyncio.shield(tts._native_stop), 2)
