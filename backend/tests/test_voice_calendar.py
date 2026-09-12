# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import httpx
import pytest
from pipecat.frames.frames import FunctionCallResultFrame

from app.calendar_context import CALENDAR_GUIDANCE
from app.models import Snapshot
from app.voice_pipeline import RESUME

from .conftest import money
from .test_voice_opening import ready, spoken_opening
from .test_voice_opening import resumed_dialogue as resumed_dialogue
from .test_voice_opening import synthesis as synthesis
from .test_voice_retry import acknowledge
from .test_voice_turns import complete_turn, next_frame, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries
from .test_voice_waiting import next_state

PREFIX = "Authoritative calendar; computed by the application:\n"

pytestmark = pytest.mark.parametrize(
    "voice",
    [{"speech_timeout_seconds": 0.1, "history_turns": 1, "model_timeout_seconds": 10}],
    indirect=True,
)


@pytest.fixture(autouse=True)
def calendar_clock(store, request):
    """Set the clock before session creation and advance it only at explicit boundaries."""
    clock = SimpleNamespace(
        now=datetime.fromisoformat(getattr(request, "param", "2026-09-12T06:00:00+00:00"))
    )
    store.clock = lambda: clock.now
    store.config = store.config.model_copy(update={"timezone": "Asia/Kolkata", "horizon_days": 30})
    return clock


def request_calendar(request):
    """Inspect the actual wire message and its compact canonical planning window."""
    messages = request["messages"]
    calendars = [
        message
        for message in messages
        if isinstance(message.get("content"), str) and message["content"].startswith(PREFIX)
    ]
    assert len(calendars) == 1
    assert calendars[0]["role"] == "developer"
    encoded, guidance = calendars[0]["content"][len(PREFIX) :].split("\n", 1)
    assert guidance == CALENDAR_GUIDANCE
    calendar = json.loads(encoded)
    assert "referenceDate" not in calendar
    canonical = [
        message
        for message in messages
        if isinstance(message.get("content"), str)
        and message["content"].startswith("Canonical application state;")
    ]
    assert len(canonical) == 1
    assert messages.index(canonical[0]) < messages.index(calendars[0])
    state = json.loads(canonical[0]["content"].split("\n", 1)[1])
    snapshot = state["snapshot"]
    assert "workspace" not in snapshot and "plan" not in snapshot
    anchor = date.fromisoformat(snapshot["anchorDate"])
    end = date.fromisoformat(snapshot["endDateExclusive"])
    assert calendar["planningWindow"] == {
        "startInclusive": anchor.isoformat(),
        "endExclusive": end.isoformat(),
        "endInclusive": (end - timedelta(days=1)).isoformat(),
        "calendarDays": 30,
        "isAnchoredToday": anchor.isoformat() == calendar["currentDate"],
    }
    assert end - anchor == timedelta(days=30)
    assert calendar["calendarDays"] == [
        {"date": day.isoformat(), "dayOfWeek": day.strftime("%A")}
        for offset in range(30)
        for day in (anchor + timedelta(days=offset),)
    ]
    assert calendar["timeZone"] == "Asia/Kolkata"
    return calendar, state


@pytest.mark.parametrize(
    ("calendar_clock", "current_date", "weekday", "month_end", "tomorrow"),
    [
        ("2026-09-12T06:00:00+00:00", "2026-09-12", "Saturday", "2026-09-30", "2026-09-13"),
        ("2026-09-12T18:29:00+00:00", "2026-09-13", "Sunday", "2026-09-30", "2026-09-13"),
        ("2026-12-31T18:29:00+00:00", "2027-01-01", "Friday", "2026-12-31", "2027-01-01"),
        ("2028-02-28T18:29:00+00:00", "2028-02-29", "Tuesday", "2028-02-29", "2028-02-29"),
    ],
    indirect=["calendar_clock"],
    ids=["same-day-time", "midnight", "new-year", "leap-day"],
)
async def test_each_request_refreshes_clock_but_preserves_turn_and_window(
    voice, store, monkeypatch, calendar_clock, current_date, weekday, month_end, tomorrow
):
    """Advance between a real read_state request and its post-tool model continuation."""
    baseline = await store.get("owner")
    started = calendar_clock.now
    read_state = voice.pipeline.tools.read_state

    async def read():
        """Advance after the real read so clock freshness cannot come from its snapshot."""
        result = await read_state()
        if calendar_clock.now == started:
            calendar_clock.now += timedelta(minutes=2)
        return result

    monkeypatch.setattr(voice.pipeline.tools, "read_state", read)
    await complete_turn(voice, "What date is today and when is tomorrow?")
    first = await asyncio.wait_for(voice.requests.get(), 2)
    result = await next_frame(voice.frames, FunctionCallResultFrame)
    second = await asyncio.wait_for(voice.requests.get(), 2)
    before, _ = request_calendar(first)
    after, state = request_calendar(second)
    assert first["tool_choice"] == "required"
    assert result.function_name == "read_state"
    assert (
        next(
            tool["function"]["parameters"]
            for tool in first["tools"]
            if tool["function"]["name"] == "read_state"
        )["type"]
        == "object"
    )
    snapshot = Snapshot.model_validate(result.result["snapshot"])
    assert snapshot == baseline
    assert snapshot.revision == baseline.revision
    assert snapshot.facts == baseline.facts
    assert snapshot.anchor_date == baseline.anchor_date
    assert snapshot.end_date_exclusive == baseline.end_date_exclusive
    current = await store.get("owner")
    assert current.revision == baseline.revision
    assert current.facts == baseline.facts
    assert current.sequence == baseline.sequence + int(current_date != before["currentDate"])
    assert before["currentDate"] == baseline.anchor_date.isoformat()
    assert before["currentDayOfWeek"] == baseline.anchor_date.strftime("%A")
    assert (
        before["currentDateTime"] == started.astimezone(ZoneInfo(store.config.timezone)).isoformat()
    )
    assert (
        after["currentDateTime"]
        == calendar_clock.now.astimezone(ZoneInfo(store.config.timezone)).isoformat()
    )
    assert after["currentDateTime"] != before["currentDateTime"]
    assert after["currentDate"] == current_date
    assert state["activePlan"]["evaluatedOn"] == current_date
    assert after["currentDayOfWeek"] == weekday
    assert after["relativeReferenceDate"] == before["currentDate"]
    assert after["referenceDayOfWeek"] == before["currentDayOfWeek"]
    assert after["relativeDates"] == before["relativeDates"]
    assert after["relativeDates"]["today"] == before["currentDate"]
    assert after["relativeDates"]["tomorrow"] == tomorrow
    assert after["relativeDates"]["month-end"] == month_end
    assert after["calendarDays"] == before["calendarDays"]
    assert voice.pipeline.tools.user_turn_at == started
    receipt = next(message for message in second["messages"] if message["role"] == "tool")
    assert json.loads(receipt["content"])["stateSource"] == "canonical"
    assert state["snapshot"]["revision"] == baseline.revision

    await complete_turn(voice, "What day is today now?")
    third = await asyncio.wait_for(voice.requests.get(), 2)
    latest, _ = request_calendar(third)
    assert latest["relativeReferenceDate"] == latest["currentDate"] == current_date
    assert latest["relativeDates"]["today"] == current_date
    assert voice.pipeline.tools.user_turn_at == calendar_clock.now
    assert [message["content"] for message in third["messages"] if message["role"] == "user"] == [
        "What day is today now?"
    ]
    assert not any(message["role"] == "tool" for message in third["messages"])
    request_calendar(await asyncio.wait_for(voice.requests.get(), 2))
    assert not any(
        isinstance(message.get("content"), str) and message["content"].startswith(PREFIX)
        for message in voice.pipeline.context.get_messages()
    )


async def test_provider_retry_with_tools_none_has_fresh_calendar(voice, store, calendar_clock):
    """A settled provider failure retries read-only with a new clock and the same turn date."""
    voice.pipeline.client_ready.set()
    baseline = await store.get("owner")
    voice.responses.put_nowait(tool_reply("read_state", {}, "before-retry"))
    voice.responses.put_nowait(
        httpx.Response(503, json={"error": {"message": "synthetic provider unavailable"}})
    )
    await complete_turn(voice, "What date should we use for this plan?")
    first = await asyncio.wait_for(voice.requests.get(), 2)
    await next_frame(voice.frames, FunctionCallResultFrame)
    request_calendar(await asyncio.wait_for(voice.requests.get(), 2))
    waiting = await next_state(voice)
    assert waiting["autoRetry"] is True
    active = await next_state(voice)
    assert active["reason"] == "retry" and active["retryOf"] == waiting["sequence"]
    calendar_clock.now += timedelta(minutes=3)
    await acknowledge(voice, active)
    retry = await asyncio.wait_for(voice.requests.get(), 2)
    before, _ = request_calendar(first)
    after, _ = request_calendar(retry)
    assert retry["tool_choice"] == "none"
    assert not any(message["role"] == "tool" for message in retry["messages"])
    assert after["currentDateTime"] == "2026-09-12T11:33:00+05:30"
    assert after["relativeDates"] == before["relativeDates"]
    assert after["planningWindow"] == before["planningWindow"]
    assert voice.pipeline.metrics["tool_calls"] == 1
    assert voice.pipeline.metrics["response_retries"] == 1
    assert await store.get("owner") == baseline


async def test_resumed_dialogue_gets_one_current_calendar(
    resumed_dialogue, voice, synthesis, store, calendar_clock
):
    """The actual reconnect opening grounds retained dialogue without persisting calendar text."""
    baseline = await store.get("owner")
    calendar_clock.now += timedelta(hours=18)
    await voice.pipeline.tools.read_state()
    await ready(voice)
    await spoken_opening(voice, synthesis, store, resumed=True)
    request = await asyncio.wait_for(voice.requests.get(), 2)
    calendar, state = request_calendar(request)
    assert request["tool_choice"] == "none"
    assert {"role": "developer", "content": RESUME} in request["messages"]
    assert resumed_dialogue[-1] in request["messages"]
    assert not any(message["role"] == "tool" for message in request["messages"])
    assert calendar["currentDate"] == calendar["relativeReferenceDate"] == "2026-09-13"
    assert calendar["currentDateTime"] == "2026-09-13T05:30:00+05:30"
    assert calendar["planningWindow"]["startInclusive"] == "2026-09-12"
    assert calendar["planningWindow"]["isAnchoredToday"] is False
    assert state["snapshot"]["revision"] == baseline.revision
    assert voice.pipeline.tools.user_turn_at is None
    assert voice.pipeline.metrics.get("tool_calls", 0) == 0
    assert not any(
        isinstance(message.get("content"), str) and message["content"].startswith(PREFIX)
        for message in voice.pipeline.context.get_messages()
    )


@pytest.mark.parametrize(
    ("schedule", "dates"),
    [
        (
            {"recurrence": "weekly", "basis": "allowance"},
            ["2026-09-12", "2026-09-19", "2026-09-26", "2026-10-03", "2026-10-10"],
        ),
        (
            {"recurrence": "daily", "basis": "allowance"},
            [(date(2026, 9, 12) + timedelta(days=offset)).isoformat() for offset in range(30)],
        ),
        (
            {"recurrence": "monthly", "pattern": {"kind": "dayOfMonth", "day": 1}},
            ["2026-10-01"],
        ),
        ({"recurrence": "monthly", "pattern": {"kind": "monthEnd"}}, ["2026-09-30"]),
    ],
    ids=["weekly-five", "daily-thirty", "month-start", "month-end"],
)
async def test_tool_state_emits_engine_dates_inside_calendar(voice, store, schedule, dates):
    """Seed reported cadence, not model-expanded dates, and inspect real post-tool requests."""
    saved = await voice.pipeline.tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money("100000"),
            "records": [
                {
                    "kind": "essential",
                    "label": "Groceries",
                    "amount": money("2000"),
                    "schedule": schedule,
                }
            ],
        },
        "groceries",
    )
    assert saved["saved"] is True
    baseline = Snapshot.model_validate(saved["snapshot"])
    await complete_turn(voice, "Explain the saved grocery schedule without changing it.")
    request_calendar(await asyncio.wait_for(voice.requests.get(), 2))
    result = await next_frame(voice.frames, FunctionCallResultFrame)
    request = await asyncio.wait_for(voice.requests.get(), 2)
    calendar, state = request_calendar(request)
    assert result.function_name == "read_state"
    assert Snapshot.model_validate(result.result["snapshot"]) == baseline
    assert [event["date"] for event in result.result["activePlan"]["events"]] == dates
    assert [event["date"] for event in state["activePlan"]["events"]] == dates
    assert state["activePlan"]["outflowPaise"] == 200000 * len(dates)
    assert len(state["snapshot"]["facts"]["records"]) == 1
    source = state["snapshot"]["facts"]["records"][0]["schedule"]
    assert source["date"] is None
    assert source["count"] is None and source["amounts"] == []
    assert source["recurrence"] == schedule["recurrence"]
    assert all(event["dateAssumption"] for event in state["activePlan"]["events"])
    assert set(dates) <= {day["date"] for day in calendar["calendarDays"]}
    assert calendar["planningWindow"]["endExclusive"] == "2026-10-12"
    assert calendar["planningWindow"]["endInclusive"] == "2026-10-11"
    assert "2026-10-12" not in dates
    assert "engine owns recurrence expansion; do not ask for each occurrence" in CALENDAR_GUIDANCE
    guidance = next(
        message["content"]
        for message in request["messages"]
        if isinstance(message.get("content"), str) and '"periodThrough"' in message["content"]
    )
    summary = json.loads(next(line for line in guidance.splitlines() if line.startswith("{")))
    assert summary["periodStart"] == "2026-09-12"
    assert summary["periodThrough"] == "2026-10-11"
    if schedule.get("basis") == "allowance":
        assert summary["recurringAllowances"] == [
            {
                "label": "Groceries",
                "recurrence": schedule["recurrence"],
                "dates": dates,
                "occurrences": len(dates),
            }
        ]
    assert await store.get("owner") == baseline
