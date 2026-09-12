# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date
from uuid import uuid4

import pytest
from hypothesis import given
from hypothesis import strategies as st
from pydantic import ValidationError

from app.config import load_config
from app.finance import adjustment_options, calculate, normalize, resolve_adjustments
from app.models import AcceptPreview, AdjustmentInput, FactsInput

from .conftest import facts, money, record
from .test_finance import ANCHOR, project, scenario_two


def adjustment(event_id="optional:2026-09-27", amount="0"):
    """Build an occurrence-specific adjustment input with an exact decimal amount."""
    return {"eventId": event_id, "amount": amount}


def adjusted(data, inputs, config=None, today=ANCHOR):
    """Normalize facts, resolve eligible adjustments, and calculate the resulting plan."""
    config = config or load_config()
    normalized = normalize(FactsInput.model_validate(data), config)
    baseline = calculate(normalized, ANCHOR, config)
    resolved = resolve_adjustments(
        [AdjustmentInput.model_validate(item) for item in inputs],
        adjustment_options(normalized, baseline.events, ANCHOR, date(2026, 10, 11), today),
        config,
    )
    return calculate(
        normalized,
        ANCHOR,
        config,
        adjustments=resolved,
    )


def options(data, today=ANCHOR):
    """Derive eligible adjustment options for the fixed projection horizon and current date."""
    config = load_config()
    normalized = normalize(FactsInput.model_validate(data), config)
    return adjustment_options(
        normalized,
        calculate(normalized, ANCHOR, config).events,
        ANCHOR,
        date(2026, 10, 11),
        today,
    )


def test_late_reduction_preserves_early_gap_and_facts():
    """Verify a late spending cut improves closing cash without erasing the earlier gap."""
    data = scenario_two()
    baseline = project(data)
    result = adjusted(data, [adjustment()])
    assert result.first_gap == baseline.first_gap
    assert result.first_gap.date == date(2026, 9, 13)
    assert result.first_gap.amount_paise == 700000
    assert result.peak_gap_paise == 1600000
    assert result.peak_gap_date == date(2026, 9, 18)
    assert result.closing_paise == 1200000
    assert result.decision_assessment.outcome.branch == "gap"
    assert result.decision_assessment.consequences[0].date == result.first_gap.date
    assert project(data) == baseline


def test_weekly_occurrences_are_independent_and_multiple_selections_are_explicit():
    """Verify weekly spending cuts affect only explicitly selected occurrences."""
    data = facts(
        "1000",
        [
            record(
                "optional",
                "optional",
                "100",
                None,
                schedule={"date": "2026-09-12", "recurrence": "weekly"},
            )
        ],
    )
    result = adjusted(data, [adjustment("optional:2026-09-26", "40")])
    assert [(event.date.isoformat(), event.amount_paise) for event in result.events] == [
        ("2026-09-12", 10000),
        ("2026-09-19", 10000),
        ("2026-09-26", 4000),
        ("2026-10-03", 10000),
        ("2026-10-10", 10000),
    ]
    assert project(data).outflow_paise - result.outflow_paise == 6000
    result = adjusted(
        data, [adjustment("optional:2026-09-26", "40"), adjustment("optional:2026-10-03", "0")]
    )
    assert project(data).outflow_paise - result.outflow_paise == 16000


@pytest.mark.parametrize("amount", ["499.99", "2000", "2000.01", "10000000001"])
def test_card_invalid_minimum_noop_and_limits(amount):
    """Verify card adjustments reject below-minimum, unchanged, and excessive amounts."""
    data = facts(
        "100",
        [record("card", "debt", "500", "2026-09-12", debtType="card", target=money("2000"))],
    )
    with pytest.raises(ValueError):
        adjusted(data, [adjustment("card:2026-09-12", amount)])


def test_card_minimum_and_outstanding_are_not_rewritten():
    """Verify a minimum-payment scenario preserves card facts and warns about residual costs."""
    data = facts(
        "1000",
        [
            record(
                "card",
                "debt",
                "500",
                "2026-09-12",
                debtType="card",
                target=money("2000"),
                outstanding=money("10000"),
            )
        ],
        reserve="800",
    )
    result = adjusted(data, [adjustment("card:2026-09-12", "500")])
    assert result.outflow_paise == 50000 and result.closing_paise == 50000
    assert result.reserve_shortfall_paise == 30000
    assert result.peak_gap_date is None
    assert any("interest and fees" in issue.message for issue in result.issues)
    assert result.decision_assessment.outcome.readiness == "qualified"
    assert data["records"][0]["amount"] == money("500")
    assert data["records"][0]["target"] == money("2000")
    assert data["records"][0]["outstanding"] == money("10000")


@pytest.mark.parametrize(
    "item",
    [
        record("item", "essential", "100", "2026-09-12"),
        record("item", "income", "100", "2026-09-12", reliability="uncertain"),
        record("item", "debt", "100", "2026-09-12", target=money("200")),
        record("item", "debt", "100", "2026-09-12", debtType="informal", target=money("200")),
        record("item", "optional", "100", "2026-09-12", autoDebit=True),
        record("item", "optional", "100", "2026-09-10"),
        record("item", "optional", "100", "2026-10-11"),
        record("item", "optional", "100", None),
        record("item", "optional", "0", "2026-09-12"),
        {
            **record("item", "optional", "100", "2026-09-12"),
            "amount": money(None, "unknown"),
        },
        {
            **record("item", "optional", "100", "2026-09-12"),
            "amount": money("100", "estimate"),
        },
        record("item", "debt", "100", "2026-09-12", debtType="card"),
        record("item", "debt", "100", "2026-09-12", debtType="card", target=money("100")),
        record(
            "item", "debt", "100", "2026-09-12", debtType="card", target=money("200", "estimate")
        ),
        record("item", "debt", "100", "2026-09-12", debtType="card", target=money(None, "unknown")),
        {
            **record("item", "debt", "100", "2026-09-12", debtType="card", target=money("200")),
            "amount": money("100", "estimate"),
        },
        record(
            "item",
            "debt",
            "100",
            "2026-09-12",
            debtType="card",
            target=money("200"),
            autoDebit=True,
        ),
        record(
            "item",
            "debt",
            "100",
            None,
            debtType="card",
            target=money("200"),
            schedule={"date": "2026-09-12", "recurrence": "weekly"},
        ),
        record(
            "item",
            "debt",
            "100",
            None,
            debtType="card",
            target=money("200"),
            schedule={"date": "2026-09-12", "recurrence": "monthly"},
        ),
    ],
)
def test_ineligible_occurrences_cannot_be_overridden(item):
    """Verify unsupported, uncertain, automatic, or out-of-window dues cannot be adjusted."""
    data = facts("1000", [item])
    assert options(data) == []
    with pytest.raises(ValueError, match="not eligible"):
        adjusted(data, [adjustment("item:2026-09-12", "0")])


@pytest.mark.parametrize("amount", [0, 1.25, "1.001", "-1", "1e2", "01", ".5", "NaN"])
def test_adjustment_money_is_exact_decimal_string(amount):
    """Verify adjustment amounts reject non-string and noncanonical decimal values."""
    with pytest.raises(ValidationError):
        AdjustmentInput.model_validate(adjustment(amount=amount))


@pytest.mark.parametrize("confirmed", [False, "true", 1, None])
def test_acceptance_requires_strict_explicit_consent(confirmed):
    """Verify preview acceptance requires a literal true consent value."""
    with pytest.raises(ValidationError):
        AcceptPreview.model_validate(
            {
                "type": "acceptPreview",
                "previewId": str(uuid4()),
                "confirmed": confirmed,
                "consentScope": "unconditional",
            }
        )


@pytest.mark.parametrize(
    "inputs", [[], [adjustment(), adjustment()], [adjustment(amount="2000")], [adjustment("bad")]]
)
def test_empty_duplicate_noop_and_unknown_inputs(inputs):
    """Verify adjustment resolution rejects empty, duplicate, unchanged, and unknown inputs."""
    with pytest.raises(ValueError):
        adjusted(scenario_two(), inputs)


def test_adjustment_count_and_current_date_eligibility(config):
    """Verify adjustment count limits and exclusion of occurrences before the current date."""
    inputs = [
        AdjustmentInput.model_validate(adjustment()),
        AdjustmentInput.model_validate(adjustment("x")),
    ]
    with pytest.raises(ValueError, match="max_occurrences"):
        resolve_adjustments(inputs, [], config.model_copy(update={"max_occurrences": 1}))
    assert options(scenario_two(), today=date(2026, 9, 28)) == []


def test_calculation_requires_matching_recorded_occurrences(config):
    """Verify calculation rejects duplicate or tampered resolved occurrence adjustments."""
    data = scenario_two()
    normalized = normalize(FactsInput.model_validate(data), config)
    resolved = resolve_adjustments(
        [AdjustmentInput.model_validate(adjustment())], options(data), config
    )
    with pytest.raises(ValueError, match="unique occurrence"):
        calculate(normalized, ANCHOR, config, adjustments=resolved * 2)
    for values in ({"event_id": "missing"}, {"original_paise": 1}, {"amount_paise": -1}):
        with pytest.raises(ValueError, match="does not match"):
            calculate(
                normalized, ANCHOR, config, adjustments=[resolved[0].model_copy(update=values)]
            )


def test_partial_estimates_and_uncertain_income_survive_reductions():
    """Verify reductions retain uncertainty, incomplete coverage, and the earliest gap."""
    data = scenario_two()
    data["records"][1]["controllability"] = "committed"
    data["coverage"]["debt"] = "notDiscussed"
    data["opening"] = money("5000", "estimate")
    data["records"][0]["reliability"] = "uncertain"
    result = adjusted(data, [adjustment()])
    assert result.decision_assessment.outcome.readiness == "qualified" and result.projection_partial
    assert result.first_gap.date == date(2026, 9, 13)
    assert {issue.code for issue in result.issues} >= {"estimate", "uncertainIncome"}
    assert result.decision_assessment.outcome.branch == "gap"
    assert result.decision_assessment.next_question_id == "provider:rent:2026-09-13"
    assert "estimates" in result.decision_assessment.outcome.conditions


def test_consequences_group_competing_obligations_without_id_ranking():
    """Verify same-day obligations share gap consequences independently of record IDs."""
    items = [
        record("a", "debt", "400", "2026-09-15", autoDebit=True),
        record("z", "essential", "300", "2026-09-15"),
    ]
    before = project(facts("500", items, reserve="100"))
    items[0]["id"], items[1]["id"] = "z", "a"
    after = project(facts("500", items, reserve="100"))
    assert before.decision_assessment.consequences == after.decision_assessment.consequences
    consequence = before.decision_assessment.consequences[0]
    assert consequence.event_ids == ["a:2026-09-15", "z:2026-09-15"]
    assert consequence.amount_paise == 20000
    assert consequence.date == date(2026, 9, 15)
    assert before.peak_gap_date == date(2026, 9, 15)


def test_decision_clarifies_missing_cash_and_peak_uses_earliest_tie():
    """Verify missing cash prompts clarification and tied peak gaps use the earliest date."""
    data = facts("0")
    data["opening"] = money(None, "unknown")
    assert project(data).decision_assessment.next_question_id == "opening"
    plan = project(
        facts(
            "0",
            [
                record("out", "essential", "100", "2026-09-12"),
                record("in", "income", "100", "2026-09-13"),
                record("out2", "essential", "100", "2026-09-14"),
            ],
        )
    )
    assert plan.peak_gap_date == date(2026, 9, 12)
    assert project(facts("100")).peak_gap_date is None


@given(st.integers(0, 199999))
def test_reductions_are_monotone_and_do_not_rewrite_earlier_balances(amount):
    """Verify reductions improve closing cash without worsening gaps or earlier balances."""
    data = scenario_two()
    before = project(data)
    after = adjusted(data, [adjustment(amount=f"{amount // 100}.{amount % 100:02}")])
    assert before.events[:-1] == after.events[:-1]
    assert after.closing_paise - before.closing_paise == 200000 - amount
    assert after.peak_gap_paise <= before.peak_gap_paise
    assert after.reserve_shortfall_paise <= before.reserve_shortfall_paise


@given(st.integers(0, 9999), st.integers(0, 20000))
def test_early_reduction_never_worsens_trajectory(amount, opening):
    """Verify early spending cuts never lower event balances or increase funding shortfalls."""
    data = facts(
        f"{opening // 100}.{opening % 100:02}",
        [
            record("optional", "optional", "100", "2026-09-12"),
            record("rent", "essential", "100", "2026-09-15"),
        ],
        reserve="100",
    )
    before = project(data)
    after = adjusted(
        data, [adjustment("optional:2026-09-12", f"{amount // 100}.{amount % 100:02}")]
    )
    assert all(
        a.balance_paise >= b.balance_paise for a, b in zip(after.events, before.events, strict=True)
    )
    assert after.peak_gap_paise <= before.peak_gap_paise
    assert after.reserve_shortfall_paise <= before.reserve_shortfall_paise
