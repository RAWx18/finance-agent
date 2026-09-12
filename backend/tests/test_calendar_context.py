# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import json
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pytest

from app.calendar_context import CALENDAR_GUIDANCE, calendar_context


def test_current_calendar_and_fixed_snapshot_bounds() -> None:
    context = calendar_context(
        datetime(2026, 9, 12, 6, tzinfo=UTC), "Asia/Kolkata", date(2026, 9, 12), date(2026, 10, 12)
    )
    assert context["currentDate"] == "2026-09-12"
    assert context["relativeReferenceDate"] == "2026-09-12"
    assert context["currentDayOfWeek"] == context["referenceDayOfWeek"] == "Saturday"
    assert context["currentDateTime"] == "2026-09-12T11:30:00+05:30"
    assert context["timeZone"] == "Asia/Kolkata"
    assert context["currentMonth"] == {"startInclusive": "2026-09-01", "endInclusive": "2026-09-30"}
    assert context["nextMonth"] == {"startInclusive": "2026-10-01", "endInclusive": "2026-10-31"}
    assert context["planningWindow"] == {
        "startInclusive": "2026-09-12",
        "endExclusive": "2026-10-12",
        "endInclusive": "2026-10-11",
        "calendarDays": 30,
        "isAnchoredToday": True,
    }
    assert len(context["calendarDays"]) == 30
    assert context["calendarDays"][0] == {"date": "2026-09-12", "dayOfWeek": "Saturday"}
    assert context["calendarDays"][-1] == {"date": "2026-10-11", "dayOfWeek": "Sunday"}
    for offset, day in enumerate(context["calendarDays"]):
        expected = date(2026, 9, 12) + timedelta(days=offset)
        assert day == {"date": expected.isoformat(), "dayOfWeek": expected.strftime("%A")}
    assert json.loads(json.dumps(context)) == context


def test_relative_phrases_are_exact_dates_except_next_month() -> None:
    context = calendar_context(
        datetime(2026, 9, 12, tzinfo=UTC), "UTC", date(2026, 9, 12), date(2026, 10, 12)
    )
    relative = context["relativeDates"]
    assert relative["today"] == "2026-09-12"
    assert relative["tomorrow"] == "2026-09-13"
    assert relative["yesterday"] == "2026-09-11"
    assert relative["end of the month"] == relative["month-end"] == "2026-09-30"
    assert relative["four weeks from today"] == "2026-10-10"
    assert relative["next month"] == context["nextMonth"]
    assert len(relative) == 21


@pytest.mark.parametrize("day", range(14, 21))
def test_all_weekdays_including_monday_and_sunday(day: int) -> None:
    now = datetime(2026, 9, day, tzinfo=UTC)
    context = calendar_context(now, "UTC", date(2026, 9, 12), date(2026, 10, 12))
    for weekday in ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"):
        upcoming = date.fromisoformat(context["relativeDates"][f"this {weekday}"])
        future = date.fromisoformat(context["relativeDates"][f"next {weekday}"])
        assert upcoming.strftime("%A") == future.strftime("%A") == weekday
        assert 0 <= (upcoming - now.date()).days < 7
        assert 1 <= (future - now.date()).days <= 7
        assert future == (upcoming + timedelta(days=7) if upcoming == now.date() else upcoming)


@pytest.mark.parametrize(
    ("day", "end", "next_start", "next_end"),
    [
        ("2026-12-31", "2026-12-31", "2027-01-01", "2027-01-31"),
        ("2027-02-01", "2027-02-28", "2027-03-01", "2027-03-31"),
        ("2028-02-01", "2028-02-29", "2028-03-01", "2028-03-31"),
        ("2027-01-31", "2027-01-31", "2027-02-01", "2027-02-28"),
        ("2028-01-31", "2028-01-31", "2028-02-01", "2028-02-29"),
    ],
)
def test_calendar_month_boundaries(day: str, end: str, next_start: str, next_end: str) -> None:
    anchor = date.fromisoformat(day)
    now = datetime.fromisoformat(f"{day}T12:00:00+00:00")
    context = calendar_context(now, "UTC", anchor, anchor + timedelta(days=30))
    assert context["currentMonth"]["startInclusive"] == anchor.replace(day=1).isoformat()
    assert context["currentMonth"]["endInclusive"] == end
    assert context["relativeDates"]["month-end"] == end
    assert context["relativeDates"]["end of the month"] == end
    assert (
        context["relativeDates"]["next month"]
        == context["nextMonth"]
        == {"startInclusive": next_start, "endInclusive": next_end}
    )
    if day == "2026-12-31":
        assert context["relativeDates"]["tomorrow"] == "2027-01-01"
        assert context["relativeDates"]["next Friday"] == "2027-01-01"


def test_current_time_refresh_does_not_move_continued_plan() -> None:
    now = datetime(2026, 9, 13, 6, tzinfo=UTC)
    context = calendar_context(now, "Asia/Kolkata", date(2026, 9, 12), date(2026, 10, 12))
    later = calendar_context(
        now + timedelta(seconds=1), "Asia/Kolkata", date(2026, 9, 12), date(2026, 10, 12)
    )
    assert context["currentDate"] == "2026-09-13"
    assert context["planningWindow"]["startInclusive"] == "2026-09-12"
    assert context["planningWindow"]["endExclusive"] == "2026-10-12"
    assert context["planningWindow"]["isAnchoredToday"] is False
    assert later.pop("currentDateTime") == "2026-09-13T11:30:01+05:30"
    assert context.pop("currentDateTime") == "2026-09-13T11:30:00+05:30"
    assert later == context


def test_reference_turn_preserves_intent_across_local_midnight_and_month() -> None:
    context = calendar_context(
        datetime(2026, 9, 30, 18, 31, tzinfo=UTC),
        "Asia/Kolkata",
        date(2026, 9, 12),
        date(2026, 10, 12),
        reference_time=datetime(2026, 9, 30, 18, 29, tzinfo=UTC),
    )
    assert context["currentDate"] == "2026-10-01"
    assert context["currentDayOfWeek"] == "Thursday"
    assert context["relativeReferenceDate"] == "2026-09-30"
    assert context["referenceDayOfWeek"] == "Wednesday"
    assert context["relativeDates"]["today"] == "2026-09-30"
    assert context["relativeDates"]["tomorrow"] == "2026-10-01"
    assert context["relativeDates"]["this Wednesday"] == "2026-09-30"
    assert context["relativeDates"]["next Wednesday"] == "2026-10-07"
    assert context["relativeDates"]["month-end"] == "2026-09-30"
    assert context["relativeDates"]["next month"] == context["currentMonth"]
    assert context["nextMonth"]["startInclusive"] == "2026-11-01"


def test_calendar_days_follow_supplied_bounds_across_daylight_saving() -> None:
    now = datetime(2026, 3, 8, 7, tzinfo=UTC)
    context = calendar_context(now, "America/New_York", date(2026, 3, 7), date(2026, 3, 10))
    assert context["currentDateTime"] == "2026-03-08T03:00:00-04:00"
    assert context["planningWindow"]["calendarDays"] == 3
    assert context["calendarDays"] == [
        {"date": "2026-03-07", "dayOfWeek": "Saturday"},
        {"date": "2026-03-08", "dayOfWeek": "Sunday"},
        {"date": "2026-03-09", "dayOfWeek": "Monday"},
    ]
    assert context["relativeDates"]["tomorrow"] == "2026-03-09"


@pytest.mark.parametrize("field", ["now", "reference_time"])
def test_naive_clocks_are_rejected(field: str) -> None:
    aware = datetime(2026, 9, 12, tzinfo=ZoneInfo("Asia/Kolkata"))
    with pytest.raises(ValueError, match=f"{field} must be timezone-aware"):
        calendar_context(
            aware.replace(tzinfo=None) if field == "now" else aware,
            "Asia/Kolkata",
            date(2026, 9, 12),
            date(2026, 10, 12),
            reference_time=aware.replace(tzinfo=None) if field == "reference_time" else None,
        )


@pytest.mark.parametrize("days", [-1, 0, 31])
def test_window_is_bounded_without_silently_truncating(days: int) -> None:
    anchor = date(2026, 9, 12)
    with pytest.raises(ValueError, match="1 to 30 calendar days"):
        calendar_context(
            datetime(2026, 9, 12, tzinfo=UTC), "UTC", anchor, anchor + timedelta(days=days)
        )


def test_unknown_timezone_is_rejected() -> None:
    with pytest.raises(ZoneInfoNotFoundError):
        calendar_context(
            datetime(2026, 9, 12, tzinfo=UTC),
            "Invalid/Timezone",
            date(2026, 9, 12),
            date(2026, 10, 12),
        )


def test_guidance_preserves_engine_ownership_and_weekday_ambiguity() -> None:
    assert "engine owns recurrence expansion" in CALENDAR_GUIDANCE
    assert "rather than silently adding seven days" in CALENDAR_GUIDANCE
    assert "never move the supplied planning window" in CALENDAR_GUIDANCE
    assert "omit date" in CALENDAR_GUIDANCE
    assert "inclusive endDate" in CALENDAR_GUIDANCE
    assert "Never clamp a nonexistent contractual day" in CALENDAR_GUIDANCE
    assert "event.dateAssumption" in CALENDAR_GUIDANCE
