# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date, timedelta
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.facts import merge_facts
from app.finance import adjustment_options, calculate, dependency_key, normalize
from app.models import Command, FactsInput, FactsPatch, Schedule, SchedulePatch

from .conftest import facts, money, parsed_command, record
from .test_finance import project

ANCHOR = date(2026, 9, 12)


def allowance(recurrence="weekly", amount="100", kind="essential", **schedule):
    """Build reported recurring spending with no contractual start date."""
    return record(
        "food",
        kind,
        amount,
        None,
        schedule={"date": None, "recurrence": recurrence, "basis": "allowance", **schedule},
    ) | {"amount": money(amount, "unknown" if amount is None else "exact")}


@pytest.mark.parametrize(
    "recurrence,offsets",
    [
        ("daily", list(range(30))),
        ("weekly", [0, 7, 14, 21, 28]),
        ("fortnightly", [0, 14, 28]),
        ("monthly", [0]),
    ],
)
def test_ongoing_allowance_uses_snapshot_anchor_without_rewriting_source(
    recurrence, offsets, config
):
    """Forecast cadence inside the exclusive horizon without inventing retained dates."""
    source = normalize(FactsInput.model_validate(facts("10000", [allowance(recurrence)])), config)
    retained = source.model_dump()
    plan = calculate(source, ANCHOR, config)
    assert [event.date for event in plan.events] == [ANCHOR + timedelta(days=n) for n in offsets]
    assert plan.outflow_paise == len(offsets) * 10000
    assert plan.closing_paise == 1000000 - plan.outflow_paise
    assert all(
        event.amount_paise == 10000
        and event.amount_status == "estimate"
        and event.amount_basis == "budget"
        and event.included
        and not event.overdue
        and "2026-09-12" in event.date_assumption
        and "forecast" in event.date_assumption.lower()
        and "not a payment due date" in event.date_assumption
        for event in plan.events
    )
    assert source.model_dump() == retained
    assert source.records[0].schedule.date is None
    assert source.records[0].schedule.certainty == "unknown"
    assert source.records[0].amount.status == "exact"
    assert plan.undated_impact is None
    assert plan.budget_basis.unresolved_amounts == []
    assert not any(issue.code == "unknownDate" for issue in plan.issues)
    repeated = calculate(source, ANCHOR, config, today=ANCHOR + timedelta(days=1))
    assert repeated.events == plan.events


def test_basis_schema_default_and_sparse_patch_are_explicit():
    """Keep payments as the default and distinguish omitted allowance corrections."""
    assert Schedule(date=None, recurrence="monthly").basis == "payment"
    assert SchedulePatch().model_dump(exclude_unset=True) == {}
    patch = SchedulePatch.model_validate({"basis": "allowance"})
    assert patch.model_dump(exclude_unset=True) == {"basis": "allowance"}
    schema = Schedule.model_json_schema()["properties"]["basis"]
    assert schema["enum"] == ["payment", "allowance"]
    assert schema["default"] == "payment"
    with pytest.raises(ValidationError):
        Schedule(date=None, basis="budget")


@pytest.mark.parametrize("recurrence", ["once", "monthlyBudget"])
def test_allowance_rejects_non_cadence_recurrences(recurrence):
    """Keep one-off payments and calendar-month distribution separate from allowances."""
    with pytest.raises(ValidationError, match="allowance"):
        project(facts("1000", [allowance(recurrence)]), ANCHOR)


@pytest.mark.parametrize(
    "kind,terms",
    [
        ("income", {}),
        ("debt", {}),
        ("essential", {"autoDebit": True}),
        ("optional", {"autoDebit": True}),
        ("essential", {"controllability": "committed"}),
        ("optional", {"controllability": "committed"}),
    ],
)
def test_allowance_cannot_represent_contractual_obligations(kind, terms):
    """Reject allowances for receipts, debt, automatic debits, or committed spending."""
    with pytest.raises(ValidationError, match="allowance"):
        project(facts("1000", [{**allowance(kind=kind), **terms}]), ANCHOR)


@pytest.mark.parametrize("kind", ["essential", "debt"])
@pytest.mark.parametrize("recurrence", ["daily", "weekly", "fortnightly", "monthly"])
def test_payment_without_date_is_never_derived(kind, recurrence):
    """Leave undated rent and loan payments unresolved regardless of their cadence."""
    item = record("rent" if kind == "essential" else "loan", kind, "100", None)
    item["schedule"]["recurrence"] = recurrence
    plan = project(facts("1000", [item]), ANCHOR)
    assert plan.events == []
    assert any(issue.code == "unknownDate" for issue in plan.issues)
    assert [item.reason for item in plan.budget_basis.unresolved_amounts] == ["missingDate"]


@pytest.mark.parametrize(
    "schedule",
    [{"count": 1}, {"count": 3}, {"amounts": [money("100"), money("200")]}],
)
def test_unanchored_finite_allowance_requires_a_known_origin(schedule):
    """Do not restart a finite count or assign ordered amounts to an invented origin."""
    item = allowance(amount=None if "amounts" in schedule else "100", **schedule)
    plan = project(facts("1000", [item]), ANCHOR)
    assert plan.events == []
    assert any(issue.code == "unknownDate" for issue in plan.issues)
    assert plan.undated_impact.items[0].amount_paise is None
    assert any(item.reason == "missingDate" for item in plan.budget_basis.unresolved_amounts)


@pytest.mark.parametrize("recurrence", ["daily", "weekly", "fortnightly", "monthly"])
def test_explicit_allowance_origin_is_respected(recurrence):
    """Start a forecast on the reported origin, not at the earlier snapshot anchor."""
    plan = project(facts("1000", [allowance(recurrence, date="2026-09-15", count=2)]), ANCHOR)
    assert plan.events[0].date == date(2026, 9, 15)
    assert plan.events[0].schedule_index == 0
    assert len(plan.events) == (1 if recurrence == "monthly" else 2)
    assert all("reported start 2026-09-15" in event.date_assumption for event in plan.events)


def test_known_variable_origin_keeps_indices_without_inventing_arrears():
    """Clip past forecast periods without overdue debt or shifting ordered amounts."""
    item = allowance(
        amount=None,
        date="2026-09-01",
        amounts=[money("100"), money("200"), money("300"), money(None, "unknown")],
    )
    plan = project(facts("1000", [item]), ANCHOR)
    assert [(event.date, event.schedule_index, event.amount_paise) for event in plan.events] == [
        (date(2026, 9, 15), 2, 30000),
        (date(2026, 9, 22), 3, None),
    ]
    assert [event.amount_status for event in plan.events] == ["estimate", "unknown"]
    assert not plan.events[-1].included
    assert not any(event.overdue for event in plan.events)
    assert not any(issue.code == "overdueRecurrence" for issue in plan.issues)
    assert [item.reason for item in plan.budget_basis.unresolved_amounts] == ["missingAmount"]


@pytest.mark.parametrize(
    "anchor,origin,expected,index",
    [
        (date(2027, 1, 31), None, [date(2027, 1, 31), date(2027, 2, 28)], [None, None]),
        (date(2028, 1, 31), None, [date(2028, 1, 31), date(2028, 2, 29)], [None, None]),
        (date(2027, 2, 1), "2027-01-31", [date(2027, 2, 28)], [1]),
        (date(2028, 2, 1), "2028-01-31", [date(2028, 2, 29)], [1]),
        (date(2027, 3, 2), "2027-01-31", [date(2027, 3, 31)], [2]),
    ],
)
def test_monthly_forecast_clamps_short_months_without_drifting_origin(
    anchor, origin, expected, index
):
    """Use calendar month ends only for forecast occurrences and keep the original phase."""
    item = allowance("monthly", date=origin, **({"count": 3} if origin else {}))
    plan = project(facts("1000", [item]), anchor)
    assert [event.date for event in plan.events] == expected
    assert [event.schedule_index for event in plan.events] == index
    assert not any(issue.code == "missingMonthDay" for issue in plan.issues)
    assert all("short months" in event.date_assumption for event in plan.events)


def test_reported_monthly_payment_day_is_not_clamped():
    """Preserve the contractual missing-month-day guard for an explicit payment date."""
    item = record("rent", "essential", "100", "2027-01-31")
    item["schedule"].update(recurrence="monthly", count=2)
    plan = project(facts("1000", [item]), date(2027, 2, 1))
    assert not any(event.original_due_date == date(2027, 2, 28) for event in plan.events)
    assert any(issue.code == "missingMonthDay" for issue in plan.issues)


@pytest.mark.parametrize(
    "recurrence,expected",
    [("once", 1), ("daily", 30), ("weekly", 5), ("fortnightly", 3), ("monthly", 1)],
)
def test_reported_payment_cadences_keep_exact_amount_and_timing(recurrence, expected):
    """Preserve all existing payment cadences when the allowance basis is absent."""
    item = record("payment", "essential", "100", str(ANCHOR))
    item["schedule"]["recurrence"] = recurrence
    plan = project(facts("10000", [item]), ANCHOR)
    assert len(plan.events) == expected
    assert all(
        event.amount_paise == 10000
        and event.amount_status == "exact"
        and event.amount_basis == "reported"
        and event.date_assumption is None
        for event in plan.events
    )


def test_monthly_budget_remains_calendar_prorated_not_a_full_occurrence_allowance():
    """Keep the sixth cadence's existing actual-month daily distribution unchanged."""
    item = record("food", "essential", "3100", str(ANCHOR))
    item["schedule"]["recurrence"] = "monthlyBudget"
    plan = project(facts("10000", [item]), ANCHOR)
    assert len(plan.events) == 30
    assert plan.outflow_paise == 19 * 10333 + 11 * 10000
    assert all(event.amount_basis == "budget" for event in plan.events)
    assert not any(event.date_assumption for event in plan.events)


def test_reported_allowance_pattern_is_not_replaced_by_snapshot_anchor():
    """Honor a reported monthly pattern rather than deriving a competing start date."""
    plan = project(
        facts("1000", [allowance("monthly", pattern={"kind": "dayOfMonth", "day": 1})]),
        ANCHOR,
    )
    assert [event.date for event in plan.events] == [date(2026, 10, 1)]
    assert "reported monthly day 1 pattern" in plan.events[0].date_assumption
    assert plan.undated_impact is None


@pytest.mark.parametrize("end,expected", [("2026-09-11", 0), ("2026-09-18", 1), ("2026-09-19", 2)])
def test_allowance_end_date_is_inclusive_even_without_source_start(end, expected):
    """End bounds clip forecasts without creating undated duplicates or missing-date prompts."""
    plan = project(facts("1000", [allowance(endDate=end)]), ANCHOR)
    assert len(plan.events) == expected
    assert plan.undated_impact is None
    assert plan.budget_basis.unresolved_amounts == []
    assert not any(issue.code == "unknownDate" for issue in plan.issues)


def test_allowance_unknown_amount_stays_unknown_without_missing_date():
    """A cadence can supply estimated timing without inventing missing spending amounts."""
    plan = project(facts("1000", [allowance(amount=None)]), ANCHOR)
    assert len(plan.events) == 5
    assert all(event.amount_paise is None and not event.included for event in plan.events)
    assert [item.reason for item in plan.budget_basis.unresolved_amounts] == ["missingAmount"]
    assert plan.undated_impact is None


def test_forecast_bounds_and_cut_ineligibility_use_existing_guards(config):
    """Keep aggregate and occurrence limits and exclude forecast spending from automatic cuts."""
    source = normalize(
        FactsInput.model_validate(facts("0", [allowance(kind="optional", date=str(ANCHOR))])),
        config,
    )
    plan = calculate(source, ANCHOR, config)
    assert (
        adjustment_options(source, plan.events, ANCHOR, ANCHOR + timedelta(days=30), ANCHOR) == []
    )
    with pytest.raises(ValueError, match="Too many expanded occurrences"):
        calculate(source, ANCHOR, config.model_copy(update={"max_occurrences": 4}))
    with pytest.raises(ValueError, match="aggregate money limit"):
        calculate(source, ANCHOR, config.model_copy(update={"max_total_paise": 49999}))


def test_sparse_amount_and_date_corrections_preserve_forecast_terms(config):
    """Merge sparse edits without changing basis, boundaries, record identity, or source timing."""
    source = normalize(
        FactsInput.model_validate(facts("1000", [allowance(endDate="2026-10-10")])), config
    )
    before = calculate(source, ANCHOR, config)
    changed = normalize(
        merge_facts(
            source,
            FactsPatch.model_validate(
                {"expectedRevision": 0, "records": [{"id": "food", "amount": money("150")}]}
            ),
            uuid4(),
        ),
        config,
    )
    assert changed.records[0].schedule == source.records[0].schedule
    dated = normalize(
        merge_facts(
            changed,
            FactsPatch.model_validate(
                {
                    "expectedRevision": 1,
                    "records": [{"id": "food", "schedule": {"date": "2026-09-14"}}],
                }
            ),
            uuid4(),
        ),
        config,
    )
    after = calculate(dated, ANCHOR, config)
    assert dated.records[0].schedule.basis == "allowance"
    assert dated.records[0].schedule.end_date == date(2026, 10, 10)
    assert dated.records[0].amount.amount_paise == 15000
    assert after.events[0].date == date(2026, 9, 14)
    assert after.undated_impact is None
    assert dependency_key(source.records[0], before.events[0]) != dependency_key(
        dated.records[0], after.events[0]
    )
    assert source.records[0].schedule.date is None


def test_sparse_basis_correction_derives_once_and_can_restore_undated_payment(config):
    """Treat payment versus allowance as a real correction without replacing the record."""
    item = record("food", "essential", "100", None)
    item["schedule"]["recurrence"] = "weekly"
    source = normalize(FactsInput.model_validate(facts("1000", [item])), config)
    for basis, count in (("allowance", 5), ("payment", 0)):
        source = normalize(
            merge_facts(
                source,
                FactsPatch.model_validate(
                    {
                        "expectedRevision": 0,
                        "records": [{"id": "food", "schedule": {"basis": basis}}],
                    }
                ),
                uuid4(),
            ),
            config,
        )
        plan = calculate(source, ANCHOR, config)
        assert len(source.records) == 1 and source.records[0].schedule.date is None
        assert len(plan.events) == count
        assert (plan.undated_impact is None) == (basis == "allowance")


def test_disputed_allowance_origin_is_not_replaced_with_an_assumed_start(config):
    """Preserve a date conflict until a reported resolution selects its actual origin."""
    source = normalize(
        FactsInput.model_validate(facts("1000", [allowance(date="2026-09-15")])), config
    )
    disputed = normalize(
        merge_facts(
            source,
            FactsPatch.model_validate(
                {
                    "expectedRevision": 0,
                    "conflicts": [
                        {
                            "recordId": "food",
                            "field": "schedule.date",
                            "values": [
                                {"id": "a", "date": "2026-09-15", "status": "exact"},
                                {"id": "b", "date": "2026-09-18", "status": "exact"},
                            ],
                        }
                    ],
                }
            ),
            uuid4(),
        ),
        config,
    )
    plan = calculate(disputed, ANCHOR, config)
    assert plan.events == []
    assert len(disputed.conflicts) == 1 and disputed.records[0].schedule.date is None


async def test_store_forecast_correction_publishes_and_reloads_without_duplicate_spend(store):
    """Persist source-only facts and publish corrected forecasts through the real store path."""
    await store.create("owner")
    stream = await store.subscribe("owner")
    stream.get_nowait()
    try:
        saved = await store.command("owner", parsed_command(facts("1000", [allowance()])))
        assert stream.get_nowait() == saved
        assert saved.plan.outflow_paise == 50000
        assert saved.facts.records[0].schedule.date is None
        assert saved.preview is None and saved.accepted is None
        change = Command.model_validate(
            {
                "commandId": str(uuid4()),
                "expectedRevision": saved.revision,
                "operation": {
                    "type": "updateFacts",
                    "changes": {
                        "expectedRevision": saved.revision,
                        "records": [{"id": "food", "schedule": {"date": "2026-09-14"}}],
                    },
                },
            }
        )
        corrected = await store.command("owner", change)
        assert stream.get_nowait() == corrected
        assert await store.command("owner", change) == corrected
        assert await store.get("owner") == corrected
        assert corrected.facts.records[0].schedule.basis == "allowance"
        assert corrected.plan.outflow_paise == 40000
        assert corrected.plan.undated_impact is None
        assert len(corrected.facts.records) == 1
        assert corrected.facts.decision.responses == []
    finally:
        store.unsubscribe("owner", stream)
