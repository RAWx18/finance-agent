# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.facts import facts_input, merge_facts
from app.finance import adjustment_options, calculate, export_text, normalize
from app.models import FactsInput, FactsPatch, Schedule, SchedulePatch

from .conftest import facts, money, parsed_command, record
from .test_action_responses import response_command
from .test_decision_priorities import next_action
from .test_finance import ANCHOR, project
from .test_workspace import result, update


def monthly(identity="rent", value="30000", pattern=None, kind="essential", **values):
    """Build an undated monthly record with an optional calendar pattern and field overrides."""
    return {
        **record(
            identity,
            kind,
            value,
            None,
            schedule={"date": None, "recurrence": "monthly", "pattern": pattern},
        ),
        **values,
    }


@pytest.mark.parametrize(
    "pattern",
    [
        {"kind": "dayOfMonth"},
        {"kind": "dayOfMonth", "day": 0},
        {"kind": "dayOfMonth", "day": 32},
        {"kind": "dayOfMonth", "day": True},
        {"kind": "dayOfMonth", "day": "1"},
        {"kind": "monthEnd", "day": 28},
        {"kind": "firstBusinessDay"},
    ],
)
def test_monthly_pattern_validation_is_predictable(pattern):
    """Verify schedules and sparse patches reject invalid monthly calendar patterns."""
    with pytest.raises(ValidationError):
        Schedule(date=None, recurrence="monthly", pattern=pattern)
    with pytest.raises(ValidationError):
        SchedulePatch(pattern=pattern)


@pytest.mark.parametrize(
    "terms",
    [
        {"date": "2026-09-12"},
        {"recurrence": "once"},
        {"recurrence": "weekly"},
        {"recurrence": "monthlyBudget"},
        {"count": 1},
        {"amounts": [money("1000")]},
    ],
)
def test_monthly_pattern_rejects_dates_and_unanchored_finite_sequences(terms):
    """Verify monthly patterns reject explicit dates, other recurrences, and finite sequences."""
    with pytest.raises(ValidationError):
        Schedule.model_validate(
            {"date": None, "recurrence": "monthly", "pattern": {"kind": "monthEnd"}, **terms}
        )


def test_monthly_alone_is_one_qualified_allowance_not_an_assumed_first(config):
    """Verify undated monthly allowances stay separate until a reported pattern supplies timing."""
    data = facts("10000", [monthly()])
    undated = project(data)
    assert undated.events == []
    assert undated.closing_paise == 1000000 and undated.first_gap is None
    impact = undated.undated_impact
    assert (impact.outflow_paise, impact.closing_paise, impact.status) == (
        3000000,
        -2000000,
        "estimate",
    )
    assert "One monthly payment within this 30-day period" in impact.items[0].assumption
    assert "unpaid status and timing need confirmation" in impact.items[0].assumption
    assert "not an upper bound" in impact.qualification
    assert next_action(undated).id == "clarify:rent:schedule.date"
    data["records"][0]["schedule"]["pattern"] = {"kind": "dayOfMonth", "day": 1}
    reported = normalize(FactsInput.model_validate(data), config)
    patterned = calculate(reported, ANCHOR, config)
    assert reported.records[0].schedule.date is None
    assert reported.records[0].schedule.certainty == "unknown"
    assert patterned.undated_impact is None
    assert [(event.date, event.overdue) for event in patterned.events] == [
        (date(2026, 10, 1), False)
    ]
    assert patterned.outflow_paise == 3000000 and patterned.closing_paise == -2000000
    assert patterned.events[0].date_assumption == (
        "Calculated for 2026-10-01 from reported monthly day 1 pattern; timing unconfirmed"
    )
    assert not any(
        item.reason == "missingDate" for item in patterned.budget_basis.unresolved_amounts
    )
    assert not any(
        action.id == "clarify:rent:schedule.date"
        for action in patterned.decision_assessment.actions
    )
    assert patterned.projection_partial and not patterned.budget_basis.dated_projection_complete
    assert "estimates" in patterned.decision_assessment.outcome.summary
    assert calculate(reported, ANCHOR, config) == patterned
    assert facts_input(reported).records[0].schedule.pattern.day == 1


@pytest.mark.parametrize("count", [None, 1])
def test_known_one_off_allowance_is_unchanged_by_explicit_single_count(count):
    """Verify an undated one-off allowance is unchanged by an explicit count of one."""
    payment = record(
        "bill",
        "essential",
        "30000",
        None,
        schedule={"date": None, "recurrence": "once", "count": count},
    )
    plan = project(facts("10000", [payment]))
    assert plan.events == [] and plan.first_gap is None
    assert plan.closing_paise == 1000000
    assert plan.undated_impact.outflow_paise == 3000000
    assert plan.undated_impact.closing_paise == -2000000
    assert plan.undated_impact.unknown_record_ids == []
    assert plan.undated_impact.items[0].amount_paise == 3000000


@pytest.mark.parametrize(
    "anchor,pattern,expected,missing",
    [
        (date(2027, 2, 1), {"kind": "dayOfMonth", "day": 31}, [], True),
        (date(2028, 2, 1), {"kind": "dayOfMonth", "day": 31}, [], True),
        (date(2027, 2, 1), {"kind": "dayOfMonth", "day": 29}, [], True),
        (date(2028, 2, 1), {"kind": "dayOfMonth", "day": 29}, [date(2028, 2, 29)], False),
        (date(2027, 2, 1), {"kind": "monthEnd"}, [date(2027, 2, 28)], False),
        (date(2028, 2, 1), {"kind": "monthEnd"}, [date(2028, 2, 29)], False),
        (date(2027, 1, 31), {"kind": "monthEnd"}, [date(2027, 1, 31), date(2027, 2, 28)], False),
    ],
)
def test_pattern_calendar_has_no_clamped_day_or_invented_arrears(
    anchor, pattern, expected, missing
):
    """Verify monthly patterns honor calendar days and leap years without invented arrears."""
    plan = project(facts("100000", [monthly(pattern=pattern)]), anchor)
    assert [event.date for event in plan.events] == expected
    assert all(not event.overdue and event.date_assumption for event in plan.events)
    assert any(issue.code == "missingMonthDay" for issue in plan.issues) == missing
    assert plan.undated_impact is None
    if not missing:
        assert plan.decision_assessment.next_question_id is None


@pytest.mark.parametrize("end,expected", [("2027-02-27", 1), ("2027-02-28", 2), ("2027-01-30", 0)])
def test_pattern_end_date_clips_inclusively(end, expected):
    """Verify monthly pattern occurrences are clipped inclusively at the end date."""
    payment = monthly(pattern={"kind": "monthEnd"})
    payment["schedule"]["endDate"] = end
    plan = project(facts("100000", [payment]), date(2027, 1, 31))
    assert len(plan.events) == expected
    assert plan.outflow_paise == expected * 3000000


def test_month_end_salary_counts_with_assumed_timing_and_a_without_salary_comparison():
    """Verify reliable month-end salary funds dated rent while the headline names the assumption."""
    plan = project(
        facts(
            "1000",
            [
                monthly("salary", "30000", {"kind": "monthEnd"}, "income"),
                record("rent", "essential", "20000", "2026-10-01"),
            ],
        )
    )
    salary = next(event for event in plan.events if event.record_id == "salary")
    assert salary.date == date(2026, 9, 30) and salary.included
    assert salary.amount_status == "exact" and "month-end" in salary.date_assumption
    assert plan.reliable_income_paise == 3000000 and plan.uncertain_income_paise == 0
    assert plan.closing_paise == 1100000 and plan.first_gap is None
    without = plan.income_comparisons[0]
    assert without.id == "income:withoutAssumed"
    assert without.conditions[0].arrival == "notByHorizon"
    assert without.metrics.closing_paise == -1900000
    assert without.metrics.first_gap.date == date(2026, 10, 1)
    outcome = plan.decision_assessment.outcome
    assert outcome.headline.startswith("Your dated payments fit")
    assert "salary is counted on its usual day" in outcome.top_caveat
    assert outcome.secondary == "Without salary, rent on 2026-10-01 would be INR 19000.00 short."
    assert next_action(plan).kind == "confirmReceipt"
    assert (
        "Check it has actually arrived before paying rent on 2026-10-01"
        in next_action(plan).question
    )
    assert not any(
        item.id == "salary:schedule.date" for item in plan.decision_assessment.uncertainties
    )


@pytest.mark.parametrize("terms", [{"count": 2}, {"amounts": [money("100"), money("200")]}])
def test_finite_monthly_question_asks_for_origin_not_an_unsupported_pattern(terms):
    """Verify an unanchored finite monthly sequence asks for its first due date without guessing."""
    payment = monthly(value=None if "amounts" in terms else "100")
    if "amounts" in terms:
        payment["amount"] = money(None, "unknown")
    payment["schedule"].update(terms)
    plan = project(facts("1000", [payment]))
    assert next_action(plan).question == "When is the first of those rent payments due?"
    assert plan.events == []
    assert plan.undated_impact.items[0].amount_paise is None


async def test_known_undated_rent_is_separate_and_date_correction_moves_it_once(store):
    """Verify dating rent moves it from a separate what-if into the dated plan exactly once."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "10000",
                [
                    record("food", "essential", "1000", "2026-09-12"),
                    record("rent", "essential", "33000", None, label="Rent"),
                ],
            )
        ),
    )
    plan = baseline.plan
    assert (plan.closing_paise, plan.trough_paise, plan.outflow_paise) == (900000, 900000, 100000)
    assert plan.first_gap is None and plan.peak_gap_paise == 0
    assert plan.undated_impact.closing_paise == -2400000
    assert plan.undated_impact.outflow_paise == 3300000
    assert "Rent" in plan.decision_assessment.outcome.summary
    assert "INR 9000.00" in plan.decision_assessment.outcome.summary
    assert "INR -24000.00" in plan.decision_assessment.outcome.summary
    assert "INR 24000.00 more would be needed" in plan.decision_assessment.outcome.summary
    assert result(baseline, "undatedClosing").amount_paise == -2400000
    assert result(baseline, "undatedClosing").result_ids == ["closing"]
    assert "undated:rent" not in result(baseline, "closing").contribution_ids
    assert "what-if" in export_text(baseline).lower()
    assert baseline.accepted is None and baseline.preview is None
    assert baseline.facts.decision.responses == []
    change = update(baseline.revision, records=[{"id": "rent", "schedule": {"date": "2026-09-14"}}])
    corrected = await store.command("owner", change)
    assert await store.command("owner", change) == corrected
    assert corrected.plan.undated_impact is None
    assert len([event for event in corrected.plan.events if event.record_id == "rent"]) == 1
    assert corrected.plan.closing_paise == -2400000
    assert corrected.plan.first_gap.amount_paise == 2400000
    assert not any(item.id.startswith("undated") for item in corrected.workspace.results)


@pytest.mark.parametrize("opening", [money("10000"), money(None, "unknown")])
def test_unknown_minimum_and_target_remain_unknown_not_a_guarantee(opening):
    """Verify undated debt allowances preserve unknown minimums, targets, and opening cash."""
    data = facts(
        records=[
            record("card", "debt", "500", None, target=money(None, "unknown")),
            {
                **record("loan", "debt", "0", None, target=money("2000")),
                "amount": money(None, "unknown"),
            },
        ]
    )
    data["opening"] = opening
    plan = project(data)
    impact = plan.undated_impact
    assert impact.outflow_paise == 250000
    assert impact.closing_paise == (750000 if opening["amount"] else None)
    assert impact.unknown_record_ids == ["card", "loan"] and impact.status == "unknown"
    assert impact.items[0].amount_basis == "requiredOnly"
    assert impact.items[0].required_paise == 50000 and impact.items[0].target_paise is None
    assert "higher intended target is unknown" in impact.items[0].assumption
    assert impact.items[1].required_paise is None and impact.items[1].target_paise == 200000
    assert "not a guarantee" in impact.items[1].assumption
    assert "payments fit" not in plan.decision_assessment.outcome.summary


@pytest.mark.parametrize(
    "recurrence,terms",
    [
        ("daily", {}),
        ("weekly", {}),
        ("fortnightly", {}),
        ("monthlyBudget", {}),
        ("monthly", {"count": 2}),
        ("monthly", {"amounts": [money("100"), money("200")]}),
    ],
)
def test_unanchored_sequence_is_not_a_guessed_period_total(recurrence, terms):
    """Verify unanchored recurring sequences retain unknown amounts rather than guessed totals."""
    payment = record(
        "food",
        "essential",
        "100",
        None,
        schedule={
            "date": None,
            "recurrence": recurrence,
            **terms,
        },
    )
    if "amounts" in terms:
        payment["amount"] = money(None, "unknown")
    plan = project(facts("10000", [payment]))
    impact = plan.undated_impact
    assert impact.items[0].amount_paise is None and impact.items[0].status == "unknown"
    assert impact.unknown_record_ids == ["food"] and impact.outflow_paise == 0
    assert impact.closing_paise == 1000000
    assert "Occurrence count" in impact.items[0].assumption
    assert plan.events == []


def test_allowance_excludes_income_dated_and_pattern_items_and_preserves_estimates():
    """Verify allowances retain estimates and exclude income, dated, and patterned records."""
    plan = project(
        facts(
            "10000",
            [
                monthly("rent", "1000", amount=money("1000", "estimate")),
                monthly("salary", "30000", kind="income"),
                record("future", "essential", "50000", "2026-11-01"),
                monthly("patterned", "200", {"kind": "dayOfMonth", "day": 1}),
            ],
        )
    )
    assert [item.record_id for item in plan.undated_impact.items] == ["rent"]
    assert plan.undated_impact.items[0].status == "estimate"
    assert plan.undated_impact.outflow_paise == 100000
    assert plan.undated_impact.closing_paise == 880000
    assert "undated income is excluded" in plan.undated_impact.qualification


async def test_pattern_patch_roundtrip_no_unknown_answer_and_estimated_evidence(store):
    """Verify pattern patches retain qualified evidence without inventing answers or consent."""
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(facts("50000", [monthly()])))
    change = update(
        baseline.revision,
        records=[
            {
                "id": "rent",
                "schedule": {"date": None, "pattern": {"kind": "dayOfMonth", "day": 1}},
            }
        ],
    )
    patterned = await store.command("owner", change)
    assert await store.command("owner", change) == patterned
    assert patterned.facts.records[0].schedule.date is None
    assert patterned.facts.decision.responses == []
    assert patterned.preview is None and patterned.accepted is None
    assert result(patterned, "closing").state == "estimated"
    assert result(patterned, "datedOutflow").state == "estimated"
    assert any("timing unconfirmed" in text for text in result(patterned, "closing").qualifications)
    assert not any(
        item.id in {"record:rent", "undated:rent"} for item in patterned.workspace.contributions
    )
    assert patterned.workspace.questions == []
    assert next_action(patterned.plan).kind == "reviewOutcome"
    repeated = await store.command(
        "owner",
        update(
            patterned.revision,
            records=[
                {
                    "id": "rent",
                    "schedule": {"pattern": {"kind": "dayOfMonth", "day": 1}},
                }
            ],
        ),
    )
    assert repeated.facts == patterned.facts and repeated.plan == patterned.plan
    explicit = await store.command(
        "owner",
        update(
            repeated.revision,
            records=[
                {
                    "id": "rent",
                    "schedule": {"date": "2026-09-16"},
                }
            ],
        ),
    )
    assert explicit.facts.records[0].schedule.pattern is None
    assert explicit.plan.events[0].date_assumption is None
    restored = await store.command(
        "owner",
        update(
            explicit.revision,
            records=[
                {
                    "id": "rent",
                    "schedule": {"pattern": {"kind": "monthEnd"}},
                }
            ],
        ),
    )
    assert restored.facts.records[0].schedule.date is None
    assert facts_input(restored.facts).records[0].schedule.pattern.kind == "monthEnd"
    cleared = await store.command(
        "owner",
        update(
            restored.revision,
            records=[
                {
                    "id": "rent",
                    "schedule": {"pattern": None},
                }
            ],
        ),
    )
    assert cleared.plan.events == [] and cleared.plan.undated_impact.outflow_paise == 3000000
    assert cleared.facts.decision.responses == []


async def test_unavailable_date_does_not_repeat_or_turn_into_consent(store):
    """Verify unavailable dates suppress repeat questions without changing facts or consent."""
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(facts("10000", [monthly()])))
    deferred = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(deferred.plan).kind == "reviewOutcome"
    assert not deferred.workspace.questions
    assert deferred.plan.undated_impact == baseline.plan.undated_impact
    assert deferred.accepted is None and deferred.preview is None
    assert deferred.facts.records == baseline.facts.records
    assert await store.get("owner") == deferred


def test_pattern_cannot_bypass_unresolved_date_conflict(config):
    """Verify setting or clearing a pattern cannot bypass an unresolved schedule date conflict."""
    source = normalize(FactsInput.model_validate(facts("1000", [monthly()])), config)
    disputed = normalize(
        merge_facts(
            source,
            FactsPatch.model_validate(
                {
                    "expectedRevision": 0,
                    "conflicts": [
                        {
                            "recordId": "rent",
                            "field": "schedule.date",
                            "values": [
                                {"id": "one", "date": "2026-09-15", "status": "exact"},
                                {"id": "two", "date": "2026-09-20", "status": "exact"},
                            ],
                        }
                    ],
                }
            ),
            uuid4(),
        ),
        config,
    )
    for pattern in ({"kind": "monthEnd"}, None):
        with pytest.raises(ValueError, match="Resolve the exact field conflict"):
            merge_facts(
                disputed,
                FactsPatch.model_validate(
                    {
                        "expectedRevision": 0,
                        "records": [{"id": "rent", "schedule": {"pattern": pattern}}],
                    }
                ),
                uuid4(),
            )
    disputed.records[0].schedule = Schedule(
        date=None, recurrence="monthly", pattern={"kind": "monthEnd"}
    )
    with pytest.raises(ValueError, match="unresolved disputed field"):
        calculate(disputed, ANCHOR, config)


def test_pattern_optional_is_not_adjustable_and_allowance_totals_are_bounded(config):
    """Verify patterned optional payments cannot be adjusted and allowances obey limits."""
    data = facts("0", [monthly("purchase", "30000", {"kind": "dayOfMonth", "day": 1}, "optional")])
    source = normalize(FactsInput.model_validate(data), config)
    plan = calculate(source, ANCHOR, config)
    assert adjustment_options(source, plan.events, ANCHOR, date(2026, 10, 11), ANCHOR) == []
    assert plan.decision_assessment.choices == []
    with pytest.raises(ValueError, match="aggregate money limit"):
        project(
            facts("0", [monthly()]), config=config.model_copy(update={"max_total_paise": 1000000})
        )


def test_first_dated_gap_stays_first_even_with_large_undated_allowance():
    """Verify a large undated allowance preserves the first dated gap and its summary priority."""
    plan = project(
        facts(
            "1000",
            [
                record("food", "essential", "2000", "2026-09-12"),
                monthly(),
            ],
        )
    )
    assert plan.first_gap.date == date(2026, 9, 12)
    assert plan.first_gap.amount_paise == 100000 and plan.peak_gap_paise == 100000
    assert plan.undated_impact.closing_paise == -3100000
    assert plan.decision_assessment.outcome.summary.startswith("food: first shortfall INR 1000.00")


def test_wire_schema_exposes_only_separate_scenario_and_source_pattern_metadata():
    """Verify wire data separates undated scenarios from patterns and retains unknown dates."""
    plan = project(facts("10000", [monthly()]))
    assert plan.model_dump(mode="json", by_alias=True)["undatedImpact"] == {
        "items": [
            {
                "recordId": "rent",
                "label": "rent",
                "amountPaise": 3000000,
                "status": "exact",
                "recurrence": "monthly",
                "amountBasis": "reported",
                "requiredPaise": None,
                "targetPaise": None,
                "assumption": "One monthly payment within this 30-day period; unpaid status "
                "and timing need confirmation. This is one occurrence, not a limit on payments.",
            }
        ],
        "outflowPaise": 3000000,
        "closingPaise": -2000000,
        "status": "estimate",
        "unknownRecordIds": [],
        "qualification": plan.undated_impact.qualification,
    }
    schedule = Schedule(date=None, recurrence="monthly", pattern={"kind": "monthEnd"})
    assert schedule.model_dump(mode="json", by_alias=True)["pattern"] == {
        "kind": "monthEnd",
        "day": None,
    }
    assert schedule.certainty == "unknown" and schedule.date is None
    assert "periodScope" not in Schedule.model_json_schema(by_alias=True)["properties"]
