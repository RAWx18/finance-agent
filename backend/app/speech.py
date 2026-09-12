# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import re
from collections.abc import AsyncGenerator
from time import monotonic
from typing import Any
from uuid import UUID
from xml.sax.saxutils import escape, quoteattr

from azure.cognitiveservices.speech import (  # type: ignore[import-untyped]
    CancellationErrorCode,
    CancellationReason,
    PhraseListGrammar,
    ResultReason,
    SpeechRecognizer,
    SpeechSynthesizer,
)
from azure.cognitiveservices.speech.audio import (  # type: ignore[import-untyped]
    AudioConfig,
    AudioStreamFormat,
    PushAudioInputStream,
)
from pipecat.frames.frames import (
    CancelFrame,
    ErrorFrame,
    Frame,
    InterimTranscriptionFrame,
    InterruptionFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.azure.stt import AzureSTTService
from pipecat.services.azure.tts import AzureTTSService
from pipecat.services.stt_service import STTService
from pipecat.services.tts_service import TTSService
from pipecat.utils.time import time_now_iso8601
from pipecat.utils.types import assert_given

from .config import VoiceConfig, load_config
from .diagnostics import record_event


class SynthesisFailure(Exception):
    """A failed request that permits an explicit, non-replaying continuation."""


# Service-side interruptions that a fresh recognizer normally survives; credential, request
# and quota rejections are excluded so they still stop the call.
RECOVERABLE_RECOGNITION = frozenset(
    {
        CancellationErrorCode.NoError,
        CancellationErrorCode.ConnectionFailure,
        CancellationErrorCode.ServiceTimeout,
        CancellationErrorCode.ServiceError,
        CancellationErrorCode.ServiceUnavailable,
        CancellationErrorCode.RuntimeError,
    }
)
RECOGNITION_RESTARTS = 3


class SpeechRecognition(AzureSTTService):
    """Azure recognition with session-bound callbacks and bounded native lifecycle operations."""

    _speech_recognizer: Any
    _settings: Any
    call_id: UUID | None = None

    def __init__(
        self, *, phrases: list[str], config: VoiceConfig | None = None, **kwargs: Any
    ) -> None:
        """Initialize phrase hints, voice configuration, and native recognition task tracking."""
        super().__init__(**kwargs)
        self.phrases = phrases
        self.config = config or load_config().voice
        self._recognition_id: object | None = None
        self._native_start: asyncio.Task[Any] | None = None
        self._native_stop: asyncio.Task[None] | None = None
        self._restarts = 0
        self._closing = False

    def _receive(self, event: Any, kind: str, identity: object | None) -> None:
        """Dispatch an SDK recognition event onto the service event loop."""
        loop = self.get_event_loop()

        async def deliver() -> None:
            """Validate an active recognition event and publish its transcript or failure."""
            if identity is None or identity is not self._recognition_id:
                return
            if kind in {"canceled", "stopped"}:
                self._recognition_id = None
                details = getattr(event, "cancellation_details", None)
                code = getattr(details, "error_code", CancellationErrorCode.NoError)
                reason = getattr(details, "reason", getattr(event, "reason", None))
                record_event(
                    "speech.recognitionStopped",
                    call_id=self.call_id,
                    status="unavailable",
                    stage=kind,
                    category=code.name if isinstance(code, CancellationErrorCode) else "unknown",
                    reason=reason.name if isinstance(reason, CancellationReason) else "unknown",
                    retry_attempts=self._restarts,
                )
                await self._disconnect()
                if (
                    self._closing
                    or code not in RECOVERABLE_RECOGNITION
                    or self._restarts >= RECOGNITION_RESTARTS
                ):
                    await self.push_error(
                        error_msg="Speech recognition disconnected.",
                        force_treat_as_permanent=True,
                    )
                    return
                self._restarts += 1
                await self._connect()
                return
            result = getattr(event, "result", None)
            text = getattr(result, "text", None)
            reason = getattr(result, "reason", None)
            if not isinstance(text, str) or reason not in {
                ResultReason.RecognizedSpeech,
                ResultReason.RecognizingSpeech,
                ResultReason.NoMatch,
            }:
                record_event(
                    "speech.recognitionMalformed",
                    call_id=self.call_id,
                    status="failed",
                    stage="result",
                    reason=reason.name if isinstance(reason, ResultReason) else "unknown",
                    category="invalidText" if not isinstance(text, str) else "invalidReason",
                )
                self._recognition_id = None
                await self.push_error(
                    error_msg="Invalid speech recognition result.", force_treat_as_permanent=True
                )
                await self._disconnect()
                return
            if not text.strip() or reason == ResultReason.NoMatch:
                return
            final = kind == "recognized"
            frame = (TranscriptionFrame if final else InterimTranscriptionFrame)(
                text=text,
                user_id=self._user_id,
                timestamp=time_now_iso8601(),
                language=self._settings.language,
                result=event,
                **({"finalized": True} if final else {}),
            )
            if final:
                await self._handle_transcription(text, True, self._settings.language)
                await self.emit_stt_usage_metrics()  # type: ignore[no-untyped-call]
            # Disconnect can run during usage reporting, so recheck identity before delivery.
            if identity is self._recognition_id:
                await self.push_frame(frame)

        def schedule() -> None:
            """Schedule delivery only while the event's recognition session remains current."""
            if identity is not None and identity is self._recognition_id:
                self.create_task(deliver(), "recognition-event")

        if not loop.is_closed():
            loop.call_soon_threadsafe(schedule)

    def _on_handle_recognized(self, event: Any) -> None:
        """Dispatch a final transcript for the current recognition session."""
        self._receive(event, "recognized", self._recognition_id)

    def _on_handle_recognizing(self, event: Any) -> None:
        """Dispatch an interim transcript for the current recognition session."""
        self._receive(event, "recognizing", self._recognition_id)

    async def _connect(self) -> None:
        """Start continuous Azure recognition with phrase hints and bounded startup."""
        if self._native_stop is not None:
            await self._disconnect()
        if self._audio_stream:
            return
        self._native_start = self._native_stop = None
        started = monotonic()
        record_event("speech.recognitionStart", call_id=self.call_id, status="started")
        try:
            self._audio_stream = PushAudioInputStream(
                AudioStreamFormat(samples_per_second=self.sample_rate, channels=1)
            )
            self._speech_recognizer = SpeechRecognizer(
                speech_config=self._speech_config,
                audio_config=AudioConfig(stream=self._audio_stream),
            )
            identity = self._recognition_id = object()
            for name, kind in (
                ("recognizing", "recognizing"),
                ("recognized", "recognized"),
                ("canceled", "canceled"),
                ("session_stopped", "stopped"),
            ):
                getattr(self._speech_recognizer, name).connect(
                    lambda event, kind=kind: self._receive(event, kind, identity)
                )
            # Vocabulary biases recognition, never authoritative financial state.
            grammar = PhraseListGrammar.from_recognizer(self._speech_recognizer)
            for phrase in self.phrases:
                grammar.addPhrase(phrase)
            grammar.setWeight(1.0)
            recognizer = self._speech_recognizer
            self._native_start = asyncio.create_task(
                asyncio.to_thread(lambda: recognizer.start_continuous_recognition_async().get())
            )
            async with asyncio.timeout(self.config.startup_seconds):
                await asyncio.shield(self._native_start)
            record_event(
                "speech.recognitionStart",
                call_id=self.call_id,
                status="completed",
                elapsed_seconds=monotonic() - started,
            )
        except asyncio.CancelledError as error:
            record_event(
                "speech.recognitionStart",
                call_id=self.call_id,
                error=error,
                status="cancelled",
                stage="startup",
                elapsed_seconds=monotonic() - started,
            )
            await self._disconnect()
            raise
        except Exception as error:
            record_event(
                "speech.recognitionStart",
                call_id=self.call_id,
                error=error,
                status="timeout" if isinstance(error, TimeoutError) else "failed",
                stage="startup",
                elapsed_seconds=monotonic() - started,
            )
            await self._disconnect()
            await self.push_error(
                error_msg="Azure speech recognition could not start.", force_treat_as_permanent=True
            )

    async def _disconnect(self) -> None:
        """Retire recognition callbacks and stop native resources after any pending startup."""
        self._recognition_id = None
        if (
            self._native_stop is not None
            and self._native_stop.done()
            and not self._native_stop.cancelled()
            and self._native_stop.exception() is not None
        ):
            self._native_stop = None
        recognizer, stream = self._speech_recognizer, self._audio_stream
        if self._native_stop is None and (recognizer is not None or stream is not None):
            if recognizer is not None:
                for name in ("recognizing", "recognized", "canceled", "session_stopped"):
                    getattr(recognizer, name).disconnect_all()

            async def stop() -> None:
                """Settle startup before stopping recognition and closing its stream."""
                try:
                    if self._native_start is not None:
                        await asyncio.shield(
                            asyncio.gather(self._native_start, return_exceptions=True)
                        )
                finally:
                    # Stop cannot overtake a start still queued or running in the executor.
                    if recognizer is not None:
                        await asyncio.to_thread(
                            lambda: recognizer.stop_continuous_recognition_async().get()
                        )
                    if stream is not None:
                        stream.close()

            def stopped(task: asyncio.Task[None]) -> None:
                """Report native release even when the shutdown wait has already expired."""
                error = None if task.cancelled() else task.exception()
                record_event(
                    "speech.recognitionCleanup",
                    call_id=self.call_id,
                    error=error,
                    stage="nativeStop",
                    status="cancelled" if task.cancelled() else "failed" if error else "completed",
                )

            self._native_stop = asyncio.create_task(stop())
            self._native_stop.add_done_callback(stopped)
        if self._native_stop is not None:
            async with asyncio.timeout(self.config.shutdown_seconds):
                await asyncio.shield(self._native_stop)
            self._speech_recognizer = self._audio_stream = None

    async def cleanup(self) -> None:
        """Retire recognition events and clean up service and native resources."""
        self._closing = True
        self._recognition_id = None
        try:
            await STTService.cleanup(self)  # type: ignore[no-untyped-call]
        finally:
            await self._disconnect()


class SpeechSynthesis(AzureTTSService):
    """Azure speech streaming with request-bound callbacks and progress deadlines."""

    _speech_synthesizer: Any
    call_id: UUID | None = None

    def __init__(self, *, config: VoiceConfig | None = None, **kwargs: Any) -> None:
        """Configure synthesis deadlines and initialize native shutdown tracking."""
        self.config = config or load_config().voice
        # Provider deadlines must expire before Pipecat can retire a pending context.
        kwargs["stop_frame_timeout_s"] = (
            max(self.config.tts_first_audio_seconds, self.config.tts_progress_seconds)
            + self.config.shutdown_seconds
        )
        super().__init__(**kwargs)
        self._retire_synthesis: Any = None
        # Settles every released synthesizer in order; a failed stop is retried at the next release.
        self._native_stop: asyncio.Task[None] | None = None

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        """Stream request-scoped Azure audio and word timings with bounded progress waits."""
        self._release_synthesis()
        # Each SDK request owns its callbacks; late events cannot enter another utterance.
        synthesizer = SpeechSynthesizer(speech_config=self._speech_config, audio_config=None)
        self._speech_synthesizer = synthesizer
        active = True
        loop = self.get_event_loop()
        events: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()

        def bind(kind: str) -> Any:
            """Create a thread-safe SDK callback for one synthesis event kind."""

            def deliver(event: Any) -> None:
                """Enqueue a synthesis event only while its request remains active."""
                if active:
                    events.put_nowait((kind, event))

            def receive(event: Any) -> None:
                """Schedule synthesis event delivery on the service event loop."""
                if not loop.is_closed():
                    loop.call_soon_threadsafe(deliver, event)

            return receive

        signals = (
            (synthesizer.synthesizing, "audio"),
            (synthesizer.synthesis_completed, "completed"),
            (synthesizer.synthesis_canceled, "canceled"),
            (synthesizer.synthesis_word_boundary, "word"),
        )
        for signal, kind in signals:
            signal.connect(bind(kind))

        def retire() -> None:
            """Deactivate the synthesis request and detach all of its SDK callbacks."""
            nonlocal active
            if not active:
                return
            active = False
            for signal, _ in signals:
                signal.disconnect_all()

        self._retire_synthesis = retire
        complete = False
        audio = False
        chunks = 0
        words: list[tuple[str, float]] = []
        stage = "firstAudio"
        started = monotonic()
        deadline = loop.time() + self.config.tts_first_audio_seconds
        try:
            synthesizer.speak_ssml_async(self._construct_ssml(text))
            await self.start_tts_usage_metrics(text)
            while active:
                async with asyncio.timeout_at(deadline):
                    kind, event = await events.get()
                if not active:
                    break
                stage = kind
                if kind == "audio":
                    chunk = event.result.audio_data
                    if not isinstance(chunk, bytes):
                        raise ValueError("Invalid synthesis audio")
                    if not chunk:
                        continue
                    audio = True
                    chunks += 1
                    deadline = loop.time() + self.config.tts_progress_seconds
                    yield TTSAudioRawFrame(
                        audio=chunk,
                        sample_rate=self.sample_rate,
                        num_channels=1,
                        context_id=context_id,
                    )
                elif kind == "word":
                    word, offset = event.text, event.audio_offset / 10_000_000
                    if not isinstance(word, str) or offset < 0:
                        raise ValueError("Invalid synthesis word")
                    if words and self._is_punctuation_only(word):
                        words[-1] = (words[-1][0] + word, words[-1][1])
                    elif word:
                        words.append((word, self._cumulative_audio_offset + offset))
                elif kind == "canceled":
                    details = event.result.cancellation_details
                    code = details.error_code
                    reason = getattr(details, "reason", None)
                    # Only the numeric websocket close code leaves the SDK message.
                    close = re.search(
                        r"\bError code: (\d{3,4})\b",
                        str(getattr(details, "error_details", "")),
                    )
                    record_event(
                        "speech.synthesisCancelled",
                        call_id=self.call_id,
                        status="unavailable",
                        stage="streaming" if audio else "firstAudio",
                        category=code.name
                        if isinstance(code, CancellationErrorCode)
                        else "unknown",
                        reason=reason.name if isinstance(reason, CancellationReason) else "unknown",
                        elapsed_seconds=monotonic() - started,
                        audio_frames=chunks,
                        provider_code=int(close.group(1)) if close else None,
                    )
                    if (
                        code
                        in {
                            CancellationErrorCode.ConnectionFailure,
                            CancellationErrorCode.ServiceTimeout,
                            CancellationErrorCode.ServiceError,
                            CancellationErrorCode.ServiceUnavailable,
                            CancellationErrorCode.TooManyRequests,
                        }
                        or (
                            code == CancellationErrorCode.NoError
                            and reason == CancellationReason.CancelledByUser
                        )
                        or (
                            # An accepted stream can fail inside the SDK without a broken processor.
                            audio and code == CancellationErrorCode.RuntimeError
                        )
                    ):
                        raise SynthesisFailure("Speech generation unavailable")
                    raise RuntimeError("Speech synthesis rejected")
                elif kind == "completed":
                    if not audio:
                        raise SynthesisFailure("Speech generation produced no audio")
                    await self.add_word_timestamps(words, context_id)
                    self._cumulative_audio_offset += event.result.audio_duration.total_seconds()
                    complete = True
                    break
                if audio and len(words) > 1:
                    await self.add_word_timestamps(words[:-1], context_id)
                    words[:] = words[-1:]
                stage = "progress" if audio else "firstAudio"
        except (TimeoutError, SynthesisFailure) as error:
            record_event(
                "speech.synthesisFailed",
                call_id=self.call_id,
                error=error,
                status="timeout" if isinstance(error, TimeoutError) else "unavailable",
                category="recoverable",
                stage=stage,
                elapsed_seconds=monotonic() - started,
            )
            retire()
            await self.push_error_frame(
                ErrorFrame(
                    error="Speech response unavailable.",
                    exception=SynthesisFailure(type(error).__name__),
                )
            )
        except Exception as error:
            record_event(
                "speech.synthesisFailed",
                call_id=self.call_id,
                error=error,
                status="failed",
                category="permanent",
                stage=stage,
                elapsed_seconds=monotonic() - started,
            )
            retire()
            await self.push_error_frame(
                ErrorFrame(error="Speech synthesis failed.", exception=error),
                force_treat_as_permanent=True,
            )
        finally:
            if active:
                retire()
            if not complete:
                self._release_synthesis()
            elif self._speech_synthesizer is synthesizer:
                self._speech_synthesizer = None
                self._retire_synthesis = None

    def _release_synthesis(self) -> None:
        """Retire request callbacks and start native shutdown without blocking frame processing."""
        retire = self._retire_synthesis
        if retire is None:
            return
        retire()
        self._retire_synthesis = None
        synthesizer, previous = self._speech_synthesizer, self._native_stop

        async def stop() -> None:
            """Stop this synthesizer once earlier native stops have settled."""
            if previous is not None:
                await asyncio.shield(asyncio.gather(previous, return_exceptions=True))
            await asyncio.to_thread(lambda: synthesizer.stop_speaking_async().get())

        def stopped(task: asyncio.Task[None]) -> None:
            """Report native release; an unconfirmed stop is retried at the next release."""
            error = None if task.cancelled() else task.exception()
            record_event(
                "speech.synthesisCleanup",
                call_id=self.call_id,
                error=error,
                stage="nativeStop",
                status="cancelled" if task.cancelled() else "failed" if error else "completed",
            )
            if self._speech_synthesizer is not synthesizer:
                return
            if error is None and not task.cancelled():
                self._speech_synthesizer = None
            else:
                self._retire_synthesis = retire

        self._native_stop = asyncio.create_task(stop())
        self._native_stop.add_done_callback(stopped)

    async def _stop_synthesis(self) -> None:
        """Release the current request and await bounded native shutdown to confirm cleanup."""
        self._release_synthesis()
        task = self._native_stop
        if task is not None:
            # A timeout cannot stop the SDK thread; later cleanup must still await it.
            async with asyncio.timeout(self.config.shutdown_seconds):
                await asyncio.shield(task)

    async def _handle_interruption(
        self, frame: InterruptionFrame, direction: FrameDirection
    ) -> None:
        """Interrupt synthesis and reset speech state; native shutdown settles in the background."""
        self._release_synthesis()
        await TTSService._handle_interruption(self, frame, direction)
        self._reset_state()  # type: ignore[no-untyped-call]

    async def cancel(self, frame: CancelFrame) -> None:
        """Cancel speech processing and ensure native synthesis stops."""
        if self._retire_synthesis is not None:
            self._retire_synthesis()
        try:
            await super().cancel(frame)
        finally:
            await self._stop_synthesis()

    async def cleanup(self) -> None:
        """Release service resources and settle native synthesis shutdown."""
        if self._retire_synthesis is not None:
            self._retire_synthesis()
        try:
            await super().cleanup()  # type: ignore[no-untyped-call]
        finally:
            await self._stop_synthesis()

    def _construct_ssml(self, text: str) -> str:
        """Escape spoken text and construct locale-specific SSML for the configured voice."""
        locale = quoteattr(str(assert_given(self._settings.language)))
        voice = quoteattr(str(assert_given(self._settings.voice)))
        # DragonHD accepts language selection, not prosody or mstts:silence controls.
        return (
            f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
            f"xml:lang={locale}><voice name={voice}><lang xml:lang={locale}>"
            f"{escape(text)}</lang></voice></speak>"
        )
