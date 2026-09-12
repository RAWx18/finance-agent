# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date

import pytest

from app.voice_tools import canonical

from .conftest import facts, money, parsed_command, record
from .test_action_responses import response_command
from .test_decision_priorities import next_action
from .test_finance import project


async def test_later_funded_cut_survives_an_unchanged_larger_early_gap(store):
    """Keep useful later relief without claiming the earlier gap is resolved."""
    await store.create("owner")
    saved = await store.command(
        "owner",
        parsed_command(
            facts(
                "0",
                [
                    record("rent", "essential", "6000", "2026-09-14", controllability="committed"),
                    record("salary", "income", "4000", "2026-09-14"),
                    record("wages", "income", "10000", "2026-09-15"),
                    record("purchase", "optional", "6000", "2026-09-16"),
                    record("food", "essential", "7000", "2026-09-18"),
                ],
            )
        ),
    )
    baseline = saved.plan.model_copy(deep=True)
    assert next_action(saved.plan).id == "contact:rent:2026-09-14"
    assert baseline.closing_paise == -500000
    assert baseline.first_gap.amount_paise == baseline.peak_gap_paise == 600000
    for _ in range(2):
        if next_action(saved.plan).kind == "previewChange":
            break
        saved = await store.command("owner", response_command(saved, "unavailable"))
    action = next_action(saved.plan)
    assert action.id == "preview:purchase:2026-09-16"
    choice = next(
        item for item in saved.plan.decision_assessment.choices if item.id == action.choice_id
    )
    assert choice.metrics.closing_paise == 100000
    assert choice.metrics.first_gap == baseline.first_gap
    assert choice.metrics.peak_gap_paise == baseline.peak_gap_paise
    assert "still unfunded" in action.question
    assert "INR 6000.00 needed before same-day income" in action.question
    assert "INR 2000.00 still unfunded on 2026-09-14 after included income" in action.question
    assert saved.plan.events == baseline.events
    assert saved.preview is saved.accepted is None
    assert action.id == canonical(saved)["currentAction"]["id"]


@pytest.mark.parametrize("missing_index", [0, 1])
def test_unknown_occurrence_uses_its_own_deadline(missing_index):
    """A later missing amount cannot displace an earlier known unpaid loan."""
    amounts = [money("100"), money("100")]
    amounts[missing_index] = money(None, "unknown")
    plan = project(
        facts(
            "100",
            [
                record(
                    "food",
                    "essential",
                    None,
                    "2026-09-12",
                    schedule={"date": "2026-09-12", "recurrence": "weekly", "amounts": amounts},
                )
                | {"amount": money(None, "unknown")},
                record("loan", "debt", "500", "2026-09-14"),
            ],
        )
    )
    issue = next(
        item for item in plan.decision_assessment.uncertainties if item.id == "food:amount"
    )
    assert issue.before_date == date(2026, 9, 12 if missing_index == 0 else 19)
    assert ("immediateDecision" in issue.blocks) == (missing_index == 0)
    assert next_action(plan).id == (
        "clarify:food:amount" if missing_index == 0 else "contact:loan:2026-09-14"
    )


def test_same_day_group_keeps_each_reported_provider_response():
    """Shared exposure must respect declined and awaiting reports without allocating payments."""
    plan = project(
        facts(
            "1000",
            [
                record("rent", "essential", "6000", "2026-09-15", controllability="committed"),
                record("loan", "debt", "3000", "2026-09-15"),
            ],
            providerResponses=[
                {"eventId": "rent:2026-09-15", "status": "declined", "reportedOn": "2026-09-11"},
                {"eventId": "loan:2026-09-15", "status": "awaiting", "reportedOn": "2026-09-11"},
            ],
        )
    )
    actions = {item.id: item for item in plan.decision_assessment.actions}
    assert "response:rent:2026-09-15" in actions
    assert "response:loan:2026-09-15" in actions
    assert actions["response:rent:2026-09-15"].kind == "seekSupport"
    assert actions["response:loan:2026-09-15"].kind == "followUp"
    assert "declined" in actions["response:rent:2026-09-15"].question
    assert "awaiting" in actions["response:loan:2026-09-15"].question
    assert plan.first_gap.amount_paise == 800000
    assert plan.outflow_paise == 900000
