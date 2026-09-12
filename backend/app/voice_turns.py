# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from pipecat.frames.frames import Frame, InterimTranscriptionFrame, TranscriptionFrame
from pipecat.turns.types import ProcessFrameResult
from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import (
    SpeechTimeoutUserTurnStopStrategy,
)


class ContinuationUserTurnStopStrategy(  # type: ignore[no-untyped-call]
    SpeechTimeoutUserTurnStopStrategy
):
    """Measure the continuation window from recognition activity as well as VAD stop."""

    async def process_frame(self, frame: Frame) -> ProcessFrameResult:
        if (
            isinstance(frame, (TranscriptionFrame, InterimTranscriptionFrame))
            and frame.text.strip()
            and not self._vad_user_speaking
        ):
            # Rearm before upstream can stop on a late final; leave its STT safety wait intact.
            await self._restart_user_speech_timer()  # type: ignore[no-untyped-call]
        return await super().process_frame(frame)
