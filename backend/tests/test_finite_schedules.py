# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import calendar
from datetime import date, timedelta
from uuid import uuid4

import pytest

from app.facts import merge_facts
from app.finance import adjustment_options, calculate, export_text, normalize
from app.models import FactsInput, FactsPatch, MoneyInput, SchedulePatch
from app.voice_tools import VoiceTools

from .conftest import facts, money, record
from .test_currency_conversion import foreign
from .test_finance import project


def scheduled(kind="income", recurrence="weekly", amount="1000", **schedule):
    """Build a recurring record with overridable schedule terms."""
    return record(
        "item",
        kind,
        amount,
        None,
        schedule={
            "date": "2026-09-12",
            "recurrence": recurrence,
            **schedule,
        },
    )


def variable(kind="income", amounts=None, **schedule):
    """Build a recurring record with explicit per-occurrence amounts and an unknown scalar."""
    return scheduled(
        kind,
        amount=None,
        amounts=[
            {"conversion": None, **value}
            for value in (amounts or [money("1000"), money("1500"), money("800")])
        ],
        **schedule,
    ) | {"amount": money(None, "unknown")}


@pytest.mark.parametrize(
    "schedule,expected",
    [
        ({"count": 2}, ["2026-09-12", "2026-09-19"]),
        ({"endDate": "2026-09-19"}, ["2026-09-12", "2026-09-19"]),
        ({"count": 4, "endDate": "2026-09-18"}, ["2026-09-12"]),
        ({"count": 1}, ["2026-09-12"]),
    ],
)
def test_finite_weekly_receipts_stop_at_either_bound(schedule, expected):
    """Verify finite weekly receipts stop at the earliest count or end-date bound."""
    plan = project(facts("0", [scheduled(**schedule)]))
    assert [event.date.isoformat() for event in plan.events] == expected
    assert plan.reliable_income_paise == 100000 * len(expected)


def test_variable_occurrences_are_not_scalar_duplicates():
    """Verify variable schedules preserve each occurrence's amount and index in complete projections."""
    plan = project(facts("0", [variable()]))
    assert [event.amount_paise for event in plan.events] == [100000, 150000, 80000]
    assert [event.schedule_index for event in plan.events] == [0, 1, 2]
    assert plan.reliable_income_paise == 330000
    assert not plan.projection_partial
    assert not plan.budget_basis.unresolved_amounts


@pytest.mark.parametrize("kind", ["income", "essential", "optional", "debt"])
def test_variable_amount_status_is_per_occurrence(kind, config):
    """Verify each variable occurrence retains its own exact, estimated, or unknown amount status."""
    item = variable(kind, [money("100"), money("200", "estimate"), money(None, "unknown")])
    data = facts("0", [item])
    plan = project(data)
    assert [event.amount_status for event in plan.events] == ["exact", "estimate", "unknown"]
    assert plan.projection_partial and not plan.budget_basis.dated_projection_complete
    assert not plan.events[2].included
    if kind == "income":
        assert plan.reliable_income_paise == 10000
        assert plan.uncertain_income_paise == 20000
        assert plan.income_comparisons[0].metrics.reliable_income_paise == 30000
    else:
        assert plan.outflow_paise == 30000
    if kind == "debt":
        assert [event.required_paise for event in plan.events] == [10000, 20000, None]
        assert [event.required_status for event in plan.events] == ["exact", "estimate", "unknown"]
        assert {constraint.amount_paise for constraint in plan.decision_assessment.constraints} == {
            10000,
            20000,
            None,
        }
    assert not adjustment_options(
        normalize(FactsInput.model_validate(data), config),
        plan.events,
        date(2026, 9, 11),
        date(2026, 10, 11),
        date(2026, 9, 11),
    )


def test_variable_foreign_receipts_convert_each_currency():
    """Verify variable foreign receipts convert each occurrence using its own currency metadata."""
    plan = project(facts("0", [variable(amounts=[foreign(), foreign("100", "EUR", "90", "0")])]))
    assert plan.reliable_income_paise == 8700000
    assert [event.source.conversion.currency for event in plan.events] == ["USD", "EUR"]


@pytest.mark.parametrize("kind", ["income", "debt"])
def test_overdue_sequence_index_does_not_shift(kind):
    """Verify overdue and omitted past occurrences do not shift later sequence amounts or indexes."""
    item = variable(kind, date="2026-09-01")
    plan = project(facts("0", [item]), anchor=date(2026, 9, 12))
    if kind == "debt":
        assert plan.events[0].overdue
        assert plan.events[0].amount_paise == 100000
        assert plan.events[0].schedule_index == 0
    assert plan.events[-1].date == date(2026, 9, 15)
    assert plan.events[-1].amount_paise == 80000
    assert plan.events[-1].schedule_index == 2
    assert all(event.amount_paise != 150000 for event in plan.events)


def test_invalid_month_day_remains_unresolved_without_shifting_sequence():
    """Verify invalid monthly dates stay unresolved without shifting later occurrence amounts."""
    item = variable(date="2028-01-31", recurrence="monthly")
    plan = project(facts("0", [item]), anchor=date(2028, 2, 1))
    assert plan.events == []
    assert any(issue.code == "missingMonthDay" for issue in plan.issues)
    plan = project(facts("0", [item]), anchor=date(2028, 3, 1))
    assert not plan.events
    plan = project(facts("0", [item]), anchor=date(2028, 3, 2))
    assert plan.events[0].schedule_index == 2
    assert plan.events[0].amount_paise == 80000


@pytest.mark.parametrize(
    "schedule",
    [
        {"count": 0},
        {"count": True},
        {"count": 1001},
        {"endDate": "2026-09-11"},
        {"recurrence": "once", "count": 2},
        {"amounts": None},
        {"amounts": [money("1"), money("2")], "count": 3},
        {"recurrence": "once", "amounts": [money("1"), money("2")]},
        {"amounts": [money("1")] * 201},
    ],
)
def test_invalid_schedule_combinations(schedule):
    """Verify invalid count, end-date, recurrence, and amount-sequence combinations are rejected."""
    with pytest.raises(ValueError):
        project(facts("0", [scheduled(**schedule)]))


def test_patch_omitted_null_and_empty_semantics():
    """Verify schedule patches distinguish omitted fields, nullable bounds, and empty amount lists."""
    assert SchedulePatch().model_dump(exclude_unset=True) == {}
    patch = SchedulePatch.model_validate({"endDate": None, "count": None, "amounts": []})
    assert patch.model_dump(exclude_unset=True) == {"end_date": None, "count": None, "amounts": []}
    with pytest.raises(ValueError):
        SchedulePatch.model_validate({"amounts": None})


@pytest.mark.parametrize("kind", ["income", "debt"])
def test_budget_kind_guards(kind):
    """Verify monthly-budget schedules reject income and debt categories."""
    with pytest.raises(ValueError):
        project(facts("0", [scheduled(kind, "monthlyBudget")]))


@pytest.mark.parametrize(
    "item",
    [
        scheduled("essential", "monthlyBudget") | {"autoDebit": True},
        scheduled("optional", "monthlyBudget", amounts=[money("1")]),
        variable("debt") | {"target": money("5000")},
        variable() | {"amount": money("1000")},
        variable("optional", [foreign()]),
    ],
)
def test_ambiguous_or_incompatible_amounts_are_rejected(item):
    """Verify ambiguous scalar, variable, budget, target, and currency combinations are rejected."""
    with pytest.raises(ValueError):
        project(facts("0", [item]))


@pytest.mark.parametrize("year,month", [(2026, 9), (2026, 10), (2026, 2), (2028, 2)])
def test_monthly_budget_totals_use_actual_calendar_month(year, month):
    """Verify monthly budgets distribute exact totals across the actual calendar month's days."""
    start = date(year, month, 1)
    days = calendar.monthrange(year, month)[1]
    item = scheduled("essential", "monthlyBudget", amount="3000", date=str(start), count=1)
    plan = project(facts("10000", [item]), anchor=start)
    events = list(plan.events)
    if days == 31:
        events += project(facts("10000", [item]), anchor=start + timedelta(days=30)).events
    assert len(events) == days
    assert sum(event.amount_paise for event in events) == 300000
    daily, remainder = divmod(300000, days)
    assert [event.amount_paise for event in events] == [
        daily + int(index < remainder) for index in range(days)
    ]
    assert all(
        event.amount_basis == "budget" and event.amount_status == "estimate" for event in events
    )
    assert all(not event.overdue and event.required_paise is None for event in events)


def test_budget_clips_without_redistribution_or_overdue_month():
    """Verify clipped monthly budgets retain daily allocations without overdue carry-forward."""
    item = scheduled(
        "essential",
        "monthlyBudget",
        amount="3000",
        date="2026-09-12",
        endDate="2026-10-03",
        count=2,
    )
    plan = project(facts("10000", [item]), anchor=date(2026, 9, 15))
    assert len(plan.events) == 19
    assert plan.outflow_paise == 16 * 10000 + 3 * 9678
    assert plan.events[0].date == date(2026, 9, 15)
    assert plan.events[-1].date == date(2026, 10, 3)
    assert plan.events[-1].schedule_index == 1
    assert not any(issue.code == "overdueRecurrence" for issue in plan.issues)


@pytest.mark.parametrize("start", ["2026-09-01", "2026-09-12"])
def test_budget_early_gap_survives_positive_closing(start):
    """Verify monthly budgets expose early gaps despite positive closing cash without inventing bills."""
    item = scheduled("essential", "monthlyBudget", amount="3000", date=start)
    plan = project(
        facts("500", [item, record("pay", "income", "3000", "2026-09-20")]),
        anchor=date(2026, 9, 12),
    )
    assert plan.first_gap.date == date(2026, 9, 17)
    assert plan.first_gap.amount_paise == 10000
    assert plan.closing_paise > 0
    assert not any(
        action.kind in {"contactPayee", "verifyTerms", "previewChange"}
        for action in plan.decision_assessment.actions
    )
    assert all(
        "confirm" not in item.question.lower()
        for item in plan.decision_assessment.uncertainties
        if item.id == "item:monthlyBudget"
    )


def test_missing_budget_start_and_amount_remain_useful_questions():
    """Verify missing monthly-budget starts and amounts produce useful clarification questions."""
    item = scheduled("essential", "monthlyBudget", amount=None, date=None)
    item["amount"] = money(None, "unknown")
    plan = project(facts("0", [item]))
    assert plan.projection_partial and plan.events == []
    questions = " ".join(item.question for item in plan.decision_assessment.uncertainties)
    assert "budget" in questions and "start" in questions


@pytest.mark.parametrize("start", ["2026-10-10", "2026-10-11"])
@pytest.mark.parametrize("certainty", ["exact", "estimate"])
def test_budget_start_certainty_qualifies_even_without_occurrences(start, certainty):
    """Verify estimated budget starts qualify outcomes even when no occurrences enter the horizon."""
    item = scheduled("essential", "monthlyBudget", amount="3100", date=start, certainty=certainty)
    plan = project(facts("100", [item]))
    outcome = plan.decision_assessment.outcome
    assert len(plan.events) == int(start == "2026-10-10")
    assert plan.outflow_paise == 10000 * len(plan.events)
    assert plan.closing_paise == 10000 - plan.outflow_paise
    assert plan.first_gap is None
    assert all(event.amount_status == "estimate" for event in plan.events)
    assert plan.projection_partial == (certainty == "estimate")
    assert plan.budget_basis.dated_projection_complete == (certainty == "exact")
    if certainty == "estimate":
        issue = next(issue for issue in plan.issues if issue.code == "uncertainDate")
        assert issue.record_id == "item" and "budget start is approximate" in issue.message
        assert "item:uncertainDate" in outcome.uncertain
        assert "Check item (estimated date) before relying on that balance" in outcome.summary
        assert outcome.readiness == "qualified"
    else:
        assert not any(issue.code == "uncertainDate" for issue in plan.issues)
    if certainty == "estimate" or plan.events:
        assert (outcome.branch, outcome.readiness) == ("uncertain", "qualified")
        assert "Monthly budgets use estimated daily spending" in outcome.conditions
    else:
        assert (outcome.branch, outcome.readiness) == ("fits", "ready")


async def test_voice_store_budget_variable_corrections_and_sse(store):
    """Verify voice schedule corrections persist, publish snapshots, and reject budget payee reports."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    stream = await store.subscribe("owner")
    stream.get_nowait()
    try:
        items = [
            variable(),
            scheduled("essential", "monthlyBudget", amount="3000"),
            record("rent", "essential", "100", "2026-09-13"),
        ]
        state = await tools.update_facts(
            {
                "expectedRevision": 0,
                "opening": money("500"),
                "records": [
                    {key: value for key, value in item.items() if key not in {"id", "amount"}}
                    if index == 0
                    else {key: value for key, value in item.items() if key != "id"}
                    for index, item in enumerate(items)
                ],
            },
            "finite-budget",
        )
        snapshot = stream.get_nowait()
        assert state["snapshot"] == snapshot.model_dump(mode="json", by_alias=True)
        identity, budget_id = [record.id for record in snapshot.facts.records[:2]]
        assert snapshot.facts.records[0].amount.status == "unknown"
        state = await tools.update_facts(
            {
                "expectedRevision": 1,
                "records": [
                    {
                        "id": identity,
                        "schedule": {
                            "amounts": [
                                {**money(amount), "conversion": None}
                                for amount in ("1200", "1500", "800")
                            ],
                            "date": "2026-09-13",
                        },
                    },
                    {"id": budget_id, "amount": money("3300"), "schedule": {"count": 1}},
                ],
            },
            "correct-finite-budget",
        )
        snapshot = stream.get_nowait()
        assert state["snapshot"] == snapshot.model_dump(mode="json", by_alias=True)
        assert len(snapshot.facts.records) == 3
        assert snapshot.facts.records[2].amount.amount_paise == 10000
        assert snapshot.plan.reliable_income_paise == 350000
        assert (await store.get("owner")) == snapshot
        assert {item.reason for item in snapshot.workspace.contributions} >= {
            "monthlyBudget",
            "variableAmounts",
        }
        closing = next(item for item in snapshot.workspace.results if item.id == "closing")
        assert closing.state == "estimated"
        text = export_text(snapshot)
        assert all(
            term in text
            for term in ("calendar-month budget", "varies by occurrence", "count 3", "count 1")
        )
        event = next(event for event in snapshot.plan.events if event.record_id == budget_id)
        invalid = await tools.invoke(
            "update_facts",
            {
                "expectedRevision": 2,
                "providerResponses": [
                    {"eventId": event.id, "status": "awaiting", "reportedOn": "2026-09-11"}
                ],
            },
            "not-a-bill",
        )
        assert invalid["code"] == "invalidFacts"
        assert (await store.get("owner")).revision == 2
        state = await tools.update_facts(
            {
                "expectedRevision": 2,
                "records": [
                    {
                        "id": identity,
                        "amount": money("1000"),
                        "schedule": {"amounts": [], "count": 2},
                    }
                ],
            },
            "scalar-again",
        )
        assert state["activePlan"]["reliableIncomePaise"] == 200000
    finally:
        store.unsubscribe("owner", stream)


def test_variable_whole_currency_entries_and_clearing_bounds(config):
    """Verify variable currency entries retain metadata and clearing a sequence requires a scalar."""
    saved = normalize(
        FactsInput.model_validate(
            facts(
                "0",
                [
                    variable(
                        amounts=[foreign(), foreign("100", "EUR", "90", "0")],
                        count=2,
                        endDate="2026-09-19",
                    ),
                ],
            )
        ),
        config,
    )
    patch = FactsPatch.model_validate(
        {
            "expectedRevision": 0,
            "records": [
                {
                    "id": "item",
                    "schedule": {
                        "amounts": [foreign("1100"), foreign("200", "EUR", "90", "0")],
                        "endDate": None,
                        "count": None,
                    },
                }
            ],
        }
    )
    corrected = normalize(merge_facts(saved, patch, uuid4()), config)
    schedule = corrected.records[0].schedule
    assert [value.conversion.currency for value in schedule.amounts] == ["USD", "EUR"]
    assert schedule.count is None and schedule.end_date is None
    assert schedule.amounts[0].conversion.fee == "2000"
    with pytest.raises(ValueError, match="explicit scalar"):
        merge_facts(
            corrected,
            FactsPatch.model_validate(
                {
                    "expectedRevision": 0,
                    "records": [{"id": "item", "schedule": {"amounts": []}}],
                }
            ),
            uuid4(),
        )


@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize(
    "terms",
    [
        {"count": 2},
        {"endDate": "2026-09-19"},
        {"amounts": [foreign(), foreign("100", "EUR", "90", "0")]},
        {
            "amounts": [foreign(), foreign("100", "EUR", "90", "0")],
            "count": 2,
            "endDate": "2026-09-19",
        },
    ],
)
def test_merge_preserves_undated_finite_and_variable_terms(config, reverse, terms):
    """Verify record merges preserve finite bounds and variable amounts while supplying a known date."""
    source = variable(date=None, **terms) if "amounts" in terms else scheduled(date=None, **terms)
    target = scheduled() | {"id": "dated"}
    if "amounts" in terms:
        target["amount"] = money(None, "unknown")
    saved = normalize(FactsInput.model_validate(facts("0", [source, target])), config)
    patch = FactsPatch.model_validate(
        {
            "expectedRevision": 0,
            "merges": [
                {
                    "sourceId": "dated" if reverse else "item",
                    "targetId": "item" if reverse else "dated",
                    "confirmed": True,
                    "reason": "Same receipt reported twice",
                }
            ],
        }
    )
    merged = normalize(merge_facts(saved, patch, uuid4()), config)
    assert len(merged.records) == 1
    schedule = merged.records[0].schedule
    assert schedule.date == date(2026, 9, 12) and schedule.certainty == "exact"
    assert schedule.count == terms.get("count")
    assert schedule.end_date == saved.records[0].schedule.end_date
    assert schedule.amounts == saved.records[0].schedule.amounts
    plan = calculate(merged, date(2026, 9, 11), config)
    assert [event.date for event in plan.events] == [date(2026, 9, 12), date(2026, 9, 19)]
    assert plan.reliable_income_paise == (8700000 if "amounts" in terms else 200000)


@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize(
    "source,target",
    [
        (scheduled(date=None, count=2), scheduled(count=3)),
        (
            scheduled(date=None, endDate="2026-09-19"),
            scheduled(endDate="2026-09-20"),
        ),
        (variable(date=None), variable(amounts=[money("1000"), money("2000"), money("800")])),
        (variable(date=None, amounts=[foreign()]), variable(amounts=[foreign(currency="EUR")])),
        (variable(date=None), scheduled()),
        (scheduled(date=None), variable()),
        (
            scheduled(date=None, count=2) | {"amount": money(None, "unknown")},
            variable(),
        ),
        (scheduled(date=None, endDate="2026-09-11"), scheduled()),
        (variable(date=None), scheduled() | {"amount": foreign(None)}),
    ],
)
def test_merge_rejects_conflicting_schedule_terms_in_either_direction(
    config, reverse, source, target
):
    """Verify conflicting schedule merges fail in either direction without mutating source facts."""
    saved = normalize(
        FactsInput.model_validate(facts("0", [source, target | {"id": "dated"}])), config
    )
    before = saved.model_copy(deep=True)
    patch = FactsPatch.model_validate(
        {
            "expectedRevision": 0,
            "merges": [
                {
                    "sourceId": "dated" if reverse else "item",
                    "targetId": "item" if reverse else "dated",
                    "confirmed": True,
                    "reason": "Same receipt reported twice",
                }
            ],
        }
    )
    with pytest.raises(ValueError):
        merge_facts(saved, patch, uuid4())
    assert saved == before


@pytest.mark.parametrize(
    "amounts,expected",
    [
        ([foreign("200", "EUR", "90", "0")], 1800000),
        ([foreign("200", "EUR", "90", "0"), foreign("1100")], 10400000),
        ([foreign("200", "EUR", "90", "0"), {**money("150"), "conversion": None}], 1815000),
        ([{**money("150"), "conversion": None}], 15000),
        ([foreign(fee=None)], 0),
    ],
)
def test_sequence_replacement_never_inherits_currency_by_index(config, amounts, expected):
    """Verify replacement sequences use explicit currency metadata rather than inheriting by index."""
    saved = normalize(
        FactsInput.model_validate(
            facts("0", [variable(amounts=[foreign(), foreign("100", "EUR", "90", "0")])])
        ),
        config,
    )
    patch = FactsPatch.model_validate(
        {
            "expectedRevision": 0,
            "records": [{"id": "item", "schedule": {"amounts": amounts}}],
        }
    )
    corrected = normalize(merge_facts(saved, patch, uuid4()), config)
    assert corrected.records[0].schedule.amounts == [
        MoneyInput.model_validate(value) for value in amounts
    ]
    plan = calculate(corrected, date(2026, 9, 11), config)
    assert plan.reliable_income_paise == expected
    assert plan.closing_paise == expected
    for event, value in zip(plan.events, corrected.records[0].schedule.amounts, strict=True):
        assert event.source == (value if value.conversion is not None else None)
    if (amounts[0].get("conversion") or {}).get("feeStatus") == "unknown":
        assert plan.events[0].amount_paise is None and not plan.events[0].included


@pytest.mark.parametrize(
    "amounts",
    [
        [money("200")],
        [money("200"), money("1100")],
        [{**money("150"), "conversion": None}, money("200")],
        [{**money("200"), "conversion": {"currency": "EUR"}}],
    ],
)
async def test_sequence_replacement_requires_explicit_source_metadata_atomically(store, amounts):
    """Verify ambiguous replacement currency metadata rejects the complete update atomically."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    item = variable(amounts=[foreign(), foreign("100", "EUR", "90", "0")])
    state = await tools.update_facts(
        {
            "expectedRevision": 0,
            "records": [{key: value for key, value in item.items() if key != "id"}],
        },
        "source-sequence",
    )
    saved = await store.get("owner")
    identity = state["snapshot"]["facts"]["records"][0]["id"]
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 1,
            "opening": money("500"),
            "records": [{"id": identity, "schedule": {"amounts": amounts}}],
        },
        "ambiguous-sequence",
    )
    assert result["code"] == "invalidFacts"
    assert await store.get("owner") == saved


@pytest.mark.parametrize("recurrence,days", [("daily", [12, 13, 14]), ("fortnightly", [12, 26])])
def test_other_finite_cadences(recurrence, days):
    """Verify finite daily and fortnightly schedules preserve expected dates and sequence indexes."""
    plan = project(facts("0", [scheduled(recurrence=recurrence, count=len(days))]))
    assert [event.date.day for event in plan.events] == days
    assert [event.schedule_index for event in plan.events] == list(range(len(days)))
