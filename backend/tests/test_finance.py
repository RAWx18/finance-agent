# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from copy import deepcopy
from datetime import date

import pytest
from hypothesis import given
from hypothesis import strategies as st
from pydantic import ValidationError

from app.config import load_config
from app.finance import calculate, normalize
from app.models import FactsInput

from .conftest import facts, money, record

ANCHOR = date(2026, 9, 11)


def project(data, anchor=ANCHOR, config=None):
    config = config or load_config()
    return calculate(normalize(FactsInput.model_validate(data), config), anchor, config)


def scenario_two():
    return facts(
        "5000",
        [
            record("income", "income", "30000", "2026-09-21"),
            record("rent", "essential", "12000", "2026-09-13"),
            record("emi", "debt", "6000", "2026-09-16"),
            record("food", "essential", "3000", "2026-09-18"),
            record("card", "debt", "2000", "2026-09-26", debtType="card"),
            record("optional", "optional", "2000", "2026-09-27"),
        ],
    )


def test_golden_covered():
    plan = project(
        facts(
            "12000",
            [
                record("income", "income", "20000", "2026-09-20"),
                record("food", "essential", "3000", "2026-09-12"),
                record("rent", "essential", "8000", "2026-09-15"),
                record("emi", "debt", "4000", "2026-09-22"),
                record("card", "debt", "1000", "2026-09-25", debtType="card"),
                record("optional", "optional", "2000", "2026-09-26"),
            ],
        )
    )
    assert (plan.closing_paise, plan.trough_paise, plan.peak_gap_paise) == (1400000, 100000, 0)
    assert plan.decision_assessment.outcome.branch == "fits"


def test_early_gap_survives_later_correction_and_deletion():
    data = scenario_two()
    plan = project(data)
    assert plan.closing_paise == 1000000
    assert plan.first_gap.date == date(2026, 9, 13)
    assert plan.first_gap.amount_paise == 700000
    assert plan.peak_gap_paise == 1600000
    assert min(plan.events, key=lambda event: event.balance_paise).date == date(2026, 9, 18)
    data["records"][0]["amount"] = money("35000")
    corrected = project(data)
    assert corrected.closing_paise == 1500000
    assert corrected.first_gap == plan.first_gap
    assert corrected.peak_gap_paise == plan.peak_gap_paise
    data = scenario_two()
    data["records"].pop()
    data["coverage"]["optional"] = "none"
    reduced = project(data)
    assert reduced.closing_paise == 1200000
    assert reduced.first_gap == plan.first_gap
    assert reduced.peak_gap_paise == plan.peak_gap_paise


def test_removing_optional_is_not_a_complete_solution():
    records = [
        record("salary", "income", "8000", "2026-09-12"),
        record("food", "essential", "7000", "2026-09-13"),
        record("loan", "debt", "5000", "2026-09-14"),
        record("optional", "optional", "1000", "2026-09-15"),
    ]
    assert project(facts("2000", records)).closing_paise == -300000
    assert project(facts("2000", records[:-1])).closing_paise == -200000


def test_no_allocation_or_partial_payment_claim():
    data = facts(
        "1000",
        [
            record("salary", "income", "1000", "2026-09-20"),
            record("rent", "essential", "1800", "2026-09-25"),
            record("emi", "debt", "400", "2026-09-15"),
        ],
    )
    plan = project(data)
    assert plan.closing_paise == -20000
    assert plan.outflow_paise == 220000
    assert "allocations" not in plan.model_dump()
    data["records"][2]["autoDebit"] = True
    assert project(data).outflow_paise == 220000
    data["opening"] = money("0")
    assert "autoDebitRisk" in {issue.code for issue in project(data).issues}


def test_same_day_conservative_order():
    plan = project(
        facts(
            "0",
            [
                record("salary", "income", "10000", "2026-09-20"),
                record("rent", "essential", "6000", "2026-09-20"),
            ],
        )
    )
    assert (plan.closing_paise, plan.peak_gap_paise) == (400000, 600000)
    assert plan.events[0].kind == "essential"
    assert "sameDayTiming" in {issue.code for issue in plan.issues}
    assert plan.decision_assessment.outcome.readiness == "qualified"


def test_full_card_target_includes_minimum_and_leaves_outstanding():
    data = facts(
        "12000",
        [
            record(
                "card",
                "debt",
                "500",
                "2026-09-20",
                debtType="card",
                target=money("10000"),
                outstanding=money("25000"),
            )
        ],
    )
    normalized = normalize(FactsInput.model_validate(data), load_config())
    plan = calculate(normalized, ANCHOR, load_config())
    assert plan.outflow_paise == 1000000
    assert plan.closing_paise == 200000
    assert normalized.records[0].outstanding.amount_paise == 2500000
    data["records"][0]["target"] = money("400")
    with pytest.raises(ValueError, match="below"):
        project(data)


@pytest.mark.parametrize("field", ["opening", "amount", "date"])
def test_unknowns_are_not_zero(field):
    data = facts("500", [record("rent", "essential", "200", "2026-09-12")])
    if field == "opening":
        data["opening"] = money(None, "unknown")
    elif field == "amount":
        data["records"][0]["amount"] = money(None, "unknown")
    else:
        data["records"][0]["schedule"]["date"] = None
    plan = project(data)
    assert plan.decision_assessment.outcome.readiness == "qualified"
    assert plan.projection_partial
    if field == "opening":
        assert plan.closing_paise is None and plan.peak_gap_paise is None
        assert plan.outflow_paise == 20000
    else:
        assert plan.closing_paise == 50000


def test_uncertain_estimated_and_incomplete_coverage():
    data = facts("0", [record("maybe", "income", "1000", "2026-09-12", reliability="uncertain")])
    plan = project(data)
    assert plan.reliable_income_paise == 0 and plan.uncertain_income_paise == 100000
    assert not plan.events[0].included and plan.decision_assessment.outcome.readiness == "qualified"
    data["opening"] = money("0", "estimate")
    assert "estimate" in {issue.code for issue in project(data).issues}
    data["coverage"]["debt"] = "notDiscussed"
    assert project(data).projection_partial


def test_horizon_overdue_and_past_income():
    data = facts(
        "100",
        [
            record("overdue", "essential", "1", "2026-09-01"),
            record("past", "income", "99999", "2026-09-10"),
            record("start", "essential", "2", "2026-09-11"),
            record("end", "essential", "3", "2026-10-10"),
            record("outside", "essential", "5", "2026-10-11"),
        ],
    )
    plan = project(data)
    assert plan.closing_paise == 9400
    assert len(plan.events) == 3
    overdue = next(event for event in plan.events if event.record_id == "overdue")
    assert overdue.date == ANCHOR and overdue.original_due_date == date(2026, 9, 1)
    assert overdue.overdue
    assert "pastIncome" in {issue.code for issue in plan.issues}


@pytest.mark.parametrize(
    ("recurrence", "count"), [("weekly", 5), ("fortnightly", 3), ("monthly", 1)]
)
def test_explicit_recurrence(recurrence, count):
    plan = project(
        facts(
            "100",
            [
                record(
                    "expense",
                    "essential",
                    "1",
                    None,
                    schedule={"date": "2026-09-11", "recurrence": recurrence},
                )
            ],
        )
    )
    assert len(plan.events) == count and plan.outflow_paise == count * 100


def test_missing_month_day_and_overdue_recurrence_are_not_guessed():
    data = facts(
        "1000",
        [
            record(
                "rent",
                "essential",
                "100",
                None,
                schedule={"date": "2026-01-31", "recurrence": "monthly"},
            )
        ],
    )
    plan = project(data, date(2026, 2, 11))
    assert len(plan.events) == 1
    assert plan.events[0].original_due_date == date(2026, 1, 31)
    assert {"missingMonthDay", "overdueRecurrence"} <= {issue.code for issue in plan.issues}
    assert plan.projection_partial


def test_reserve_is_floor_not_expense():
    plan = project(facts("100", reserve="200"))
    assert plan.closing_paise == 10000 and plan.outflow_paise == 0
    assert plan.peak_gap_paise == 0 and plan.reserve_shortfall_paise == 10000


@pytest.mark.parametrize(
    "amount", [1, 1.25, "-1", "1.001", "1e3", "01", "1,000", "NaN", " 2", "2.", ".5"]
)
def test_money_rejects_ambiguous_or_inexact_input(amount):
    with pytest.raises(ValidationError):
        project(facts(amount))


@given(st.integers(min_value=0, max_value=10000000), st.integers(min_value=0, max_value=99))
def test_decimal_precision_is_exact(whole, fractional):
    assert project(facts(f"{whole}.{fractional:02}")).closing_paise == whole * 100 + fractional


@given(st.integers(min_value=0, max_value=50000))
def test_late_edit_cannot_change_earlier_balances(amount):
    data = scenario_two()
    before = project(data)
    changed = deepcopy(data)
    changed["records"][-1]["amount"] = money(str(amount))
    after = project(changed)
    assert before.events[:-1] == after.events[:-1]


def test_limits_duplicates_and_coverage_validation(config):
    with pytest.raises(ValueError, match="per-amount"):
        project(facts("10000000001"))
    data = facts("100", [record("a", "debt", "1", "2026-09-12")])
    data["records"].append(deepcopy(data["records"][0]))
    with pytest.raises(ValueError, match="unique"):
        project(data)
    data["records"][1]["id"] = "b"
    plan = project(data)
    assert plan.outflow_paise == 200
    assert "possibleDuplicate" not in {issue.code for issue in plan.issues}
    with pytest.raises(ValueError, match="records"):
        project(data, config=config.model_copy(update={"max_records": 1}))
    with pytest.raises(ValueError, match="occurrences"):
        project(data, config=config.model_copy(update={"max_occurrences": 1}))
    data["coverage"]["debt"] = "none"
    with pytest.raises(ValueError, match="coverage"):
        project(data)


@pytest.mark.parametrize(
    "data",
    [
        {**facts("0"), "opening": money("1", "unknown")},
        {**facts("0"), "opening": money(None, "exact")},
        facts("0", [record("bad", "income", "1", None, reliability=None)]),
        facts("0", [record("bad", "essential", "1", None, target=money("1"))]),
        facts("0", [record("bad", "essential", "1", None, label="\nunsafe")]),
    ],
)
def test_invalid_semantic_input(data):
    with pytest.raises(ValidationError):
        project(data)
