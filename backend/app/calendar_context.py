# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from calendar import monthrange
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

CALENDAR_GUIDANCE = """The OS clock is authoritative over stale history or snapshot timestamps.
Current date is not the plan anchor in continued plans; never move the supplied planning window.
Resolve relative phrases against relativeReferenceDate (the user-turn date), using mapped ISO
strings for explicit dates. 'This <weekday>' means upcoming, including today; 'next <weekday>'
means strictly future. If the user contrasts this/next or the intended week is unclear, ask
which date rather than silently adding seven days. 'Next month' is a range, not an exact day.
Daily = 1 day, weekly = 7 days, fortnightly = 14 days; monthly = a calendar month, not four weeks.
The financial engine owns recurrence expansion; do not ask for each occurrence.
For ongoing recurring living costs without a reported origin, use allowance and omit date:
the engine forecasts from the plan anchor, which is not a reported date. Bills, auto-debits,
debts and income need an actual start date or a reported monthly pattern.
Respect occurrence counts and inclusive endDate. monthlyBudget is calendar-budget allocation,
not normal monthly recurrence. Never clamp a nonexistent contractual day such as February 31.
An event.dateAssumption marks a forecast, not an exact reported date."""

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def month_bounds(day: date) -> dict[str, str]:
    """Return inclusive ISO bounds for a calendar month."""
    return {
        "startInclusive": day.replace(day=1).isoformat(),
        "endInclusive": day.replace(day=monthrange(day.year, day.month)[1]).isoformat(),
    }


def calendar_context(
    now: datetime,
    timezone: str,
    anchor_date: date,
    end_date_exclusive: date,
    *,
    reference_time: datetime | None = None,
) -> dict[str, Any]:
    """Ground calendar language without rebasing the supplied financial snapshot."""
    if now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    if reference_time is not None and reference_time.utcoffset() is None:
        raise ValueError("reference_time must be timezone-aware")
    days = (end_date_exclusive - anchor_date).days
    if not 1 <= days <= 30:
        raise ValueError("planning window must contain 1 to 30 calendar days")
    zone = ZoneInfo(timezone)
    current = now.astimezone(zone)
    today = current.date()
    reference = (reference_time if reference_time is not None else now).astimezone(zone).date()
    month_end = reference.replace(day=monthrange(reference.year, reference.month)[1])
    relative: dict[str, Any] = {
        "today": reference.isoformat(),
        "tomorrow": (reference + timedelta(days=1)).isoformat(),
        "yesterday": (reference - timedelta(days=1)).isoformat(),
        "end of the month": month_end.isoformat(),
        "month-end": month_end.isoformat(),
        "next month": month_bounds(month_end + timedelta(days=1)),
        "four weeks from today": (reference + timedelta(days=28)).isoformat(),
    }
    for index, weekday in enumerate(WEEKDAYS):
        offset = (index - reference.weekday()) % 7
        relative[f"this {weekday}"] = (reference + timedelta(days=offset)).isoformat()
        relative[f"next {weekday}"] = (reference + timedelta(days=offset or 7)).isoformat()
    return {
        "currentDate": today.isoformat(),
        "currentDayOfWeek": WEEKDAYS[today.weekday()],
        "currentDateTime": current.isoformat(),
        "timeZone": timezone,
        "currentMonth": month_bounds(today),
        "nextMonth": month_bounds(
            today.replace(day=monthrange(today.year, today.month)[1]) + timedelta(days=1)
        ),
        "planningWindow": {
            "startInclusive": anchor_date.isoformat(),
            "endExclusive": end_date_exclusive.isoformat(),
            "endInclusive": (end_date_exclusive - timedelta(days=1)).isoformat(),
            "calendarDays": days,
            "isAnchoredToday": anchor_date == today,
        },
        "relativeReferenceDate": reference.isoformat(),
        "referenceDayOfWeek": WEEKDAYS[reference.weekday()],
        "relativeDates": relative,
        "calendarDays": [
            {"date": day.isoformat(), "dayOfWeek": WEEKDAYS[day.weekday()]}
            for offset in range(days)
            for day in (anchor_date + timedelta(days=offset),)
        ],
    }
