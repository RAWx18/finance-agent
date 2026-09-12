# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from pipecat.frames.frames import (
    Frame,
    InterimTranscriptionFrame,
    TranscriptionFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.turns.types import ProcessFrameResult
from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import (
    SpeechTimeoutUserTurnStopStrategy,
)


class ContinuationUserTurnStopStrategy(  # type: ignore[no-untyped-call]
    SpeechTimeoutUserTurnStopStrategy
):
    """Measure the continuation window from recognition activity as well as VAD stop."""

    _awaiting_vad_final = False

    async def process_frame(self, frame: Frame) -> ProcessFrameResult:
        """Extend the speech timer for recognition activity beyond the expected VAD final."""
        if isinstance(frame, VADUserStoppedSpeakingFrame):
            self._awaiting_vad_final = not self._transcript_finalized
        if (
            isinstance(frame, (TranscriptionFrame, InterimTranscriptionFrame))
            and frame.text.strip()
            and not self._vad_user_speaking
        ):
            # The expected final confirms earlier speech; it does not start another pause.
            if not (
                isinstance(frame, TranscriptionFrame)
                and frame.finalized
                and self._vad_stopped
                and self._awaiting_vad_final
            ):
                await self._restart_user_speech_timer()  # type: ignore[no-untyped-call]
            if isinstance(frame, TranscriptionFrame):
                self._awaiting_vad_final = False
        return await super().process_frame(frame)
