# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from unittest.mock import AsyncMock
from uuid import uuid4

from pipecat.frames.frames import (
    AggregatedTextProgressFrame,
    BotStoppedSpeakingFrame,
    InterimTranscriptionFrame,
    LLMTextFrame,
    OutputTransportMessageUrgentFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
)
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.frame_processor import FrameDirection
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams

from app.history import CaptionHistory, History

from .test_history import saved
from .test_voice_errors import lifecycle as lifecycle
from .test_voice_turns import next_frame, recognize
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries


async def test_running_pipeline_archives_real_final_stt_event(voice, store):
    """Verify the running pipeline archives final transcription text but not interim captions."""
    history = History(store)
    call_id = uuid4()
    await history.start("owner", call_id, (await store.get("owner")).session_id)
    captions = CaptionHistory(history, "owner", call_id)
    voice.pipeline.history = captions
    await recognize(voice, "An interim phrase", final=False)
    await recognize(voice, "Please help with my upcoming rent.")
    async with asyncio.timeout(2):
        while True:
            frame = await next_frame(voice.frames, OutputTransportMessageUrgentFrame)
            if frame.message.get("type") == "user-transcription" and frame.message["data"]["final"]:
                break
    conversation = await saved(captions)
    assert conversation.message_count == 1
    assert conversation.messages[0].text == frame.message["data"]["text"]
    assert conversation.messages[0].role == "user"


async def test_real_rtvi_observer_and_public_output_save_only_transport_captions(voice, store):
    """Verify RTVI archives final user text and heard output with interrupted prefixes frozen."""
    history = History(store)
    call_id = uuid4()
    await history.start("owner", call_id, (await store.get("owner")).session_id)
    captions = CaptionHistory(history, "owner", call_id)
    voice.pipeline.history = captions
    rtvi = voice.pipeline.worker.rtvi
    observer = rtvi.create_rtvi_observer()
    output = BaseOutputTransport(TransportParams())

    async def observe(frame, source=output):
        """Deliver a downstream frame to the RTVI observer from the selected source."""
        await observer.on_push_frame(
            FramePushed(
                source=source,
                destination=rtvi,
                frame=frame,
                direction=FrameDirection.DOWNSTREAM,
                timestamp=0,
            )
        )

    try:
        await observe(InterimTranscriptionFrame("Not final", "human", "time"))
        await observe(LLMTextFrame("Canonical/tool/model material must never be saved"))
        final = TranscriptionFrame("How do I manage rent?", "human", "2026-09-11T06:00:00Z")
        await observe(final)
        await observe(final)
        progress = AggregatedTextProgressFrame(
            segment_id=41,
            context_id="internal-provider-context",
            text="Let's look at rent.",
            aggregated_by="sentence",
            accumulated_text="Let's look",
            remaining_text=" at rent.",
        )
        await observe(progress, voice.stt)
        assert (await saved(captions)).message_count == 1
        await observe(progress)
        await observe(UserStartedSpeakingFrame())
        await observe(
            AggregatedTextProgressFrame(
                segment_id=41,
                context_id="internal-provider-context",
                text="Let's look at rent.",
                aggregated_by="sentence",
                accumulated_text="Let's look at rent.",
                remaining_text="",
            )
        )
        await observe(
            AggregatedTextProgressFrame(
                segment_id=42,
                context_id="another-context",
                text="A complete response.",
                aggregated_by="sentence",
                accumulated_text="A complete response.",
                remaining_text="",
            )
        )
        await observe(BotStoppedSpeakingFrame())
        conversation = await saved(captions)
        assert [message.text for message in conversation.messages] == [
            "How do I manage rent?",
            "Let's look",
            "A complete response.",
        ]
        assert [message.interrupted for message in conversation.messages] == [False, True, False]
        assert conversation.title == "How do I manage rent?"
        assert voice.pipeline.context.get_messages()[0]["role"] == "developer"
    finally:
        await observer.cleanup()
        await output.cleanup()


async def test_caption_storage_failure_uses_real_pipeline_fail_safe(voice, store, monkeypatch):
    """Verify caption storage failure revokes the pipeline, clears context, and reports failure."""
    history = History(store)
    call_id = uuid4()
    await history.start("owner", call_id, (await store.get("owner")).session_id)
    voice.pipeline.history = CaptionHistory(history, "owner", call_id)
    monkeypatch.setattr(history, "append", AsyncMock(side_effect=OSError("private storage detail")))
    voice.expect_failure = True
    rtvi = voice.pipeline.worker.rtvi
    observer = rtvi.create_rtvi_observer()
    try:
        await observer.on_push_frame(
            FramePushed(
                source=voice.stt,
                destination=rtvi,
                frame=TranscriptionFrame("Hello", "human", "2026-09-11T06:00:00Z"),
                direction=FrameDirection.DOWNSTREAM,
                timestamp=0,
            )
        )
        assert voice.pipeline.revoked
        assert not voice.pipeline.context.get_messages()
        assert voice.pipeline.metrics["history_failed"] == 1
        voice.failed.assert_called_once()
        assert (await saved(voice.pipeline.history)).messages == []
    finally:
        await observer.cleanup()


async def test_two_actual_calls_have_distinct_durable_chats(lifecycle, store):
    """Verify separate managed calls create distinct ended conversations that survive reopening."""
    manager = lifecycle.manager
    first = await manager.start("owner", uuid4())
    await manager.end("owner", first.call_id)
    second = await manager.start("owner", uuid4())
    await manager.end("owner", second.call_id)
    assert first.call_id != second.call_id
    history = History(store)
    conversations = (await history.list("owner")).conversations
    assert len(conversations) == 2
    assert len({item.slug for item in conversations}) == 2
    assert conversations[0].slug.endswith("-2")
    assert all(item.ended_at is not None and item.message_count == 0 for item in conversations)
    await store.close()
    await store.open()
    assert (await history.list("owner")).conversations == conversations
