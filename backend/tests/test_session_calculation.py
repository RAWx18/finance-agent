# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date, timedelta

import pytest

from app.finance import calculate, normalize
from app.models import FactsInput, Snapshot

from .conftest import NOW, facts, parsed_command, record


async def test_fresh_session_calculates_and_round_trips_unknown_opening(store, config):
    snapshot = await store.create("synthetic")

    assert snapshot.revision == snapshot.sequence == 0
    assert snapshot.anchor_date == date(2026, 9, 11)
    assert snapshot.plan.events == []
    assert snapshot.plan.closing_paise is None
    assert snapshot.plan.peak_gap_paise is None
    assert snapshot.plan.decision_assessment.next_question_id == "opening"
    assert snapshot.plan.decision_assessment.outcome.next_action_id == "clarify:opening"
    assert snapshot.plan == calculate(snapshot.facts, snapshot.anchor_date, config)
    assert Snapshot.model_validate_json(snapshot.model_dump_json()) == snapshot
    assert await store.get("synthetic") == snapshot


@pytest.mark.parametrize("arrival", ["2026-09-12", "2026-09-15"])
def test_receipt_impact_only_prioritizes_income_before_the_exposed_due(config, arrival):
    data = facts(
        "100",
        [
            record("receipt", "income", "1000", arrival, reliability="unknown"),
            record("later", "income", "2000", "2026-09-20", reliability="unknown"),
            record("rent", "essential", "800", "2026-09-14"),
        ],
    )
    plan = calculate(
        normalize(FactsInput.model_validate(data), config),
        date(2026, 9, 11),
        config,
        today=date(2026, 9, 11),
    )

    assert plan.reliable_income_paise == 0
    assert plan.uncertain_income_paise == 300000
    assert plan.outflow_paise == 80000
    assert plan.closing_paise == -70000
    assert plan.first_gap.date == date(2026, 9, 14)
    assert plan.first_gap.amount_paise == plan.peak_gap_paise == 70000
    assert plan.income_comparisons[0].metrics.closing_paise == 230000
    assert plan.income_comparisons[0].metrics.peak_gap_paise == (
        0 if arrival == "2026-09-12" else 70000
    )
    assessment = plan.decision_assessment
    assert assessment.next_question_id == (
        "receipt:receipt" if arrival == "2026-09-12" else "provider:rent:2026-09-14"
    )
    later = next(item for item in assessment.uncertainties if item.id == "later:receipt")
    assert later.blocks == ["fullPlan"]


async def test_session_rollover_uses_today_without_rewriting_dated_balances(store, config):
    await store.create("synthetic")
    saved = await store.command(
        "synthetic",
        parsed_command(
            facts(
                "100",
                [
                    record("purchase", "optional", "200", "2026-09-11"),
                    record("rent", "essential", "300", "2026-09-11"),
                ],
            )
        ),
    )
    assert any(item.kind == "reduceOptional" for item in saved.plan.decision_assessment.choices)
    store.clock = lambda: NOW + timedelta(hours=18)
    current = await store.get("synthetic")

    assert current.anchor_date == saved.anchor_date
    assert current.facts == saved.facts
    assert current.plan.events == saved.plan.events
    assert current.plan.first_gap == saved.plan.first_gap
    assert current.plan.closing_paise == saved.plan.closing_paise == -40000
    assert current.plan.peak_gap_paise == saved.plan.peak_gap_paise == 40000
    assert not any(
        item.kind == "reduceOptional" for item in current.plan.decision_assessment.choices
    )
    action = current.plan.decision_assessment.actions[0]
    assert action.kind == "contactPayee"
    assert "overdue from 2026-09-11" in action.question
    assert current.plan == calculate(
        saved.facts, saved.anchor_date, config, today=date(2026, 9, 12)
    )
