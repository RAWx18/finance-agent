# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import logging
from contextlib import contextmanager

import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    InterimTranscriptionFrame,
    InterruptionFrame,
    LLMContextFrame,
    STTMetadataFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMUserAggregator,
    LLMUserAggregatorParams,
)
from pipecat.tests.utils import SleepFrame, run_test
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from app.voice_turns import ContinuationUserTurnStopStrategy


@contextmanager
def turn_clock():
    loop = asyncio.get_running_loop()
    now = loop.time()
    select = loop._selector.select

    def poll(timeout=None):
        nonlocal now
        ready = select(0)
        # Advance real asyncio deadlines only after runnable work and I/O have drained.
        if not ready and timeout is not None:
            now += max(0, timeout)
        return ready

    with pytest.MonkeyPatch.context() as patch:

        def start():
            nonlocal now
            now = loop.time()
            patch.setattr(loop, "time", lambda: now)
            patch.setattr(loop._selector, "select", poll)

        # Startup imports and executor shutdown require the wall clock.
        yield start


def final(text, *, finalized=True):
    return TranscriptionFrame(text=text, user_id="owner", timestamp="", finalized=finalized)


def interim(text):
    return InterimTranscriptionFrame(text=text, user_id="owner", timestamp="")


def speech(config, text):
    return [
        VADUserStartedSpeakingFrame(start_secs=config.voice.vad_start_seconds),
        SleepFrame(sleep=0.05),
        final(text),
        SleepFrame(sleep=0.05),
        VADUserStoppedSpeakingFrame(stop_secs=config.voice.vad_stop_seconds),
    ]


async def play(config, frames, *, latency=1.8):
    events = {"starts": [], "stops": [], "idle": [], "frames": []}
    began = asyncio.get_running_loop().time()

    class TimedFrames(list):
        def __iter__(self):
            nonlocal began
            start_clock()
            began = asyncio.get_running_loop().time()
            return super().__iter__()

    class ObservedStopStrategy(ContinuationUserTurnStopStrategy):
        async def process_frame(self, frame):
            if isinstance(
                frame,
                (
                    TranscriptionFrame,
                    InterimTranscriptionFrame,
                    VADUserStartedSpeakingFrame,
                    VADUserStoppedSpeakingFrame,
                ),
            ):
                events["frames"].append(
                    (
                        asyncio.get_running_loop().time() - began,
                        type(frame).__name__,
                        getattr(frame, "text", ""),
                    )
                )
            return await super().process_frame(frame)

    context = LLMContext()
    strategy = ObservedStopStrategy(
        user_speech_timeout=config.voice.speech_timeout_seconds,
        wait_for_transcript=True,
    )
    user = LLMUserAggregator(
        context,
        params=LLMUserAggregatorParams(
            user_idle_timeout=config.voice.inactive_seconds,
            user_turn_strategies=UserTurnStrategies(stop=[strategy]),
        ),
    )
    user.add_event_handler(
        "on_user_turn_started",
        lambda *_: events["starts"].append(asyncio.get_running_loop().time() - began),
    )
    user.add_event_handler(
        "on_user_turn_stopped",
        lambda *_: events["stops"].append(asyncio.get_running_loop().time() - began),
    )
    user.add_event_handler("on_user_turn_idle", lambda *_: events["idle"].append(True))
    with turn_clock() as start_clock:
        down, up = await run_test(
            user,
            frames_to_send=TimedFrames(
                [STTMetadataFrame(service_name="synthetic", ttfs_p99_latency=latency), *frames]
            ),
        )
    logging.getLogger(__name__).info("Voice frame and turn timestamps: %s", events)
    assert not events["idle"]
    assert strategy._user_speech_timeout_task is None
    assert strategy._stt_timeout_task is None
    return context.get_messages(), events, down, up


@pytest.mark.parametrize("filler_vad", [False, True], ids=["missing-filler-vad", "separate-vad"])
async def test_cash_filler_rent_is_one_turn(config, filler_vad):
    assert config.voice.speech_timeout_seconds == 2.6
    assert config.voice.vad_stop_seconds == 0.2
    assert config.voice.vad_start_seconds == 0.1
    assert config.voice.inactive_seconds == 60
    messages, events, down, _ = await play(
        config,
        [
            *speech(config, "Cash is four thousand."),
            SleepFrame(sleep=1.2),
            *(speech(config, "Um.") if filler_vad else [final("Um.")]),
            SleepFrame(sleep=2.0),
            *speech(config, "Rent is five thousand."),
            SleepFrame(sleep=config.voice.speech_timeout_seconds + 0.2),
        ],
    )
    assert messages == [
        {"role": "user", "content": "Cash is four thousand. Um. Rent is five thousand."}
    ]
    assert len(events["starts"]) == len(events["stops"]) == 1
    assert sum(isinstance(frame, LLMContextFrame) for frame in down) == 1
    vad_stops = [
        timestamp
        for timestamp, kind, _ in events["frames"]
        if kind == "VADUserStoppedSpeakingFrame"
    ]
    transcripts = [
        timestamp for timestamp, kind, _ in events["frames"] if kind == "TranscriptionFrame"
    ]
    assert transcripts[1] - vad_stops[0] == pytest.approx(1.25 if filler_vad else 1.2)
    assert transcripts[2] - transcripts[1] == pytest.approx(2.1 if filler_vad else 2.05)
    assert events["stops"][0] - vad_stops[-1] == pytest.approx(config.voice.speech_timeout_seconds)


async def test_cash_stops_before_filler_beyond_continuation_deadline(config):
    messages, events, down, _ = await play(
        config,
        [
            *speech(config, "Cash is four thousand."),
            SleepFrame(sleep=config.voice.speech_timeout_seconds + 0.2),
            *speech(config, "Um."),
            SleepFrame(sleep=2.0),
            *speech(config, "Rent is five thousand."),
            SleepFrame(sleep=config.voice.speech_timeout_seconds + 0.2),
        ],
    )
    assert messages == [
        {"role": "user", "content": "Cash is four thousand."},
        {"role": "user", "content": "Um. Rent is five thousand."},
    ]
    assert len(events["starts"]) == len(events["stops"]) == 2
    assert sum(isinstance(frame, LLMContextFrame) for frame in down) == 2
    filler_start = next(
        timestamp
        for timestamp, kind, _ in events["frames"]
        if kind == "VADUserStartedSpeakingFrame" and timestamp > events["stops"][0]
    )
    assert filler_start - events["stops"][0] == pytest.approx(0.2)


async def test_interims_cross_deadline_without_entering_context(config):
    messages, events, down, _ = await play(
        config,
        [
            *speech(config, "Cash is four thousand."),
            SleepFrame(sleep=1.2),
            interim("Rent is nine"),
            SleepFrame(sleep=1.2),
            interim("Rent is ninety thousand"),
            SleepFrame(sleep=1.2),
            final("Rent is five thousand."),
            SleepFrame(sleep=config.voice.speech_timeout_seconds + 0.2),
        ],
    )
    assert messages == [
        {"role": "user", "content": "Cash is four thousand. Rent is five thousand."}
    ]
    assert len(events["starts"]) == len(events["stops"]) == 1
    assert events["stops"][0] - events["frames"][-1][0] == pytest.approx(
        config.voice.speech_timeout_seconds
    )
    assert sum(isinstance(frame, LLMContextFrame) for frame in down) == 1


@pytest.mark.parametrize("text", ["No.", "Stop."])
@pytest.mark.parametrize("vad", [False, True], ids=["transcript-start", "vad-start"])
async def test_short_interruptions_start_immediately(config, text, vad):
    messages, events, down, up = await play(
        config,
        [
            BotStartedSpeakingFrame(),
            *(speech(config, text) if vad else [final(text)]),
            SleepFrame(sleep=config.voice.speech_timeout_seconds + 0.2),
        ],
    )
    assert messages == [{"role": "user", "content": text}]
    assert len(events["starts"]) == len(events["stops"]) == 1
    assert events["starts"][0] < 0.5
    assert events["stops"][0] - events["frames"][-1][0] == pytest.approx(
        config.voice.speech_timeout_seconds
    )
    for frames in (down, up):
        assert sum(isinstance(frame, InterruptionFrame) for frame in frames) == 1


@pytest.mark.parametrize("finalized", [False, True])
async def test_stt_safety_is_independent_of_continuation(config, finalized):
    messages, events, _, _ = await play(
        config,
        [
            VADUserStartedSpeakingFrame(start_secs=config.voice.vad_start_seconds),
            SleepFrame(sleep=0.05),
            final("Cash is four thousand.", finalized=finalized),
            SleepFrame(sleep=0.05),
            VADUserStoppedSpeakingFrame(stop_secs=config.voice.vad_stop_seconds),
            SleepFrame(sleep=0.5),
            interim("Rent is"),
            SleepFrame(sleep=0.5),
            final("Rent is five thousand.", finalized=finalized),
            SleepFrame(sleep=3.5),
        ],
        latency=4.5,
    )
    assert messages == [
        {"role": "user", "content": "Cash is four thousand. Rent is five thousand."}
    ]
    assert len(events["stops"]) == 1
    if finalized:
        assert 3.3 <= events["stops"][0] < 4.3
    else:
        assert events["stops"][0] == pytest.approx(4.4)


async def test_late_first_final_rearms_before_upstream_can_stop(config):
    messages, events, _, _ = await play(
        config,
        [
            VADUserStartedSpeakingFrame(start_secs=config.voice.vad_start_seconds),
            SleepFrame(sleep=0.05),
            VADUserStoppedSpeakingFrame(stop_secs=config.voice.vad_stop_seconds),
            SleepFrame(sleep=config.voice.speech_timeout_seconds + 0.2),
            final("Cash is four thousand."),
            SleepFrame(sleep=config.voice.speech_timeout_seconds + 0.2),
        ],
    )
    assert messages == [{"role": "user", "content": "Cash is four thousand."}]
    assert len(events["stops"]) == 1
    assert events["stops"][0] == pytest.approx(2 * config.voice.speech_timeout_seconds + 0.25)


@pytest.mark.parametrize("recognition", [final, interim])
async def test_empty_recognition_does_not_extend_prior_vad_deadline(config, recognition):
    messages, events, _, _ = await play(
        config,
        [
            *speech(config, "Cash is four thousand."),
            SleepFrame(sleep=1.2),
            recognition("  "),
            SleepFrame(sleep=config.voice.speech_timeout_seconds - 1.2 + 0.2),
        ],
    )
    assert messages == [{"role": "user", "content": "Cash is four thousand."}]
    assert len(events["stops"]) == 1
    assert events["stops"][0] == pytest.approx(config.voice.speech_timeout_seconds + 0.1)


async def test_interim_only_never_becomes_a_final_user_message(config):
    messages, events, down, _ = await play(
        config,
        [
            VADUserStartedSpeakingFrame(start_secs=config.voice.vad_start_seconds),
            SleepFrame(sleep=0.05),
            VADUserStoppedSpeakingFrame(stop_secs=config.voice.vad_stop_seconds),
            interim("Cash is ninety thousand"),
            SleepFrame(sleep=config.voice.speech_timeout_seconds + 0.2),
        ],
    )
    assert messages == []
    assert events["stops"] == []
    assert not any(isinstance(frame, LLMContextFrame) for frame in down)
