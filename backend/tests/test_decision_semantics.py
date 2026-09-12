# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date

import pytest

from app.finance import adjustment_options, normalize
from app.models import FactsInput
from app.voice_tools import canonical

from .conftest import facts, money, parsed_command, record
from .test_decision_priorities import next_action
from .test_finance import project


async def test_cash_to_constraints_to_one_scope_sweep_and_stop(store):
    """Verify planning progresses from cash to constraints and one coverage sweep before review."""
    initial = await store.create("owner")
    assert initial.plan.decision_assessment.next_question_id == "opening"
    data = facts("4000", [], coverage={})
    cash = await store.command("owner", parsed_command(data))
    action = next_action(cash.plan)
    assert action.kind == "clarify"
    assert "payments" in action.question.lower() and "income" in action.question.lower()
    assert "fit" not in cash.plan.decision_assessment.outcome.summary.lower()
    assert "planned payments INR 0.00" not in canonical(cash)["spokenBrief"]

    data["records"] = [record("rent", "essential", "1000", None, label="Rent")]
    data["coverage"] = {"essential": "reported"}
    partial = await store.command("owner", parsed_command(data, 1))
    assert partial.plan.decision_assessment.next_question_id == "rent:schedule.date"
    assert "Rent" in next_action(partial.plan).question
    data["records"][0]["schedule"]["date"] = "2026-09-14"
    complete = await store.command("owner", parsed_command(data, 2))
    assessment = complete.plan.decision_assessment
    assert "INR 3000.00" in assessment.outcome.summary
    assert assessment.next_question_id == "coverage"
    assert len([u for u in assessment.uncertainties if u.kind == "coverage"]) == 1
    assert next_action(complete.plan).kind == "clarify"

    data["coverage"] = {
        "essential": "reviewed",
        "income": "none",
        "optional": "none",
        "debt": "none",
    }
    reviewed = await store.command("owner", parsed_command(data, 3))
    assert reviewed.plan.decision_assessment.next_question_id is None
    assert next_action(reviewed.plan).kind == "reviewOutcome"
    assert reviewed.plan.decision_assessment.outcome.branch == "fits"


def test_explicit_unknown_scope_is_qualified_without_repeated_category_interview():
    """Verify explicit unknown coverage qualifies the outcome without repeated category questions."""
    plan = project(
        facts(
            "4000",
            [],
            coverage=dict.fromkeys(("income", "essential", "optional", "debt"), "unknown"),
        )
    )
    assert plan.decision_assessment.next_question_id is None
    assert plan.decision_assessment.outcome.readiness == "qualified"
    assert len([u for u in plan.decision_assessment.uncertainties if u.kind == "coverage"]) == 1
    assert "fit" not in plan.decision_assessment.outcome.summary.lower()


@pytest.mark.parametrize("control", ["controllable", "unknown"])
@pytest.mark.parametrize(
    "coverage",
    [{}, {"optional": "reviewed", "income": "none", "essential": "none", "debt": "none"}],
)
def test_focused_purchase_checks_other_needs_once_without_cut_or_control_gate(
    config, control, coverage
):
    """Verify funded focused purchases need only a coverage check, not cuts or control questions."""
    data = facts(
        "50000",
        [record("phone", "optional", "5000", "2026-09-20", controllability=control)],
        coverage=coverage,
        decision={
            "intent": "specificDecision",
            "concern": "Can I afford this phone?",
            "focusRecordIds": ["phone"],
        },
    )
    plan = project(data)
    assert next_action(plan).kind == ("reviewOutcome" if coverage else "clarify")
    assert plan.decision_assessment.next_question_id == (None if coverage else "coverage")
    assert not any(a.kind == "previewChange" for a in plan.decision_assessment.actions)
    assert not any(u.field == "controllability" for u in plan.decision_assessment.uncertainties)
    if coverage:
        assert "fit" in plan.decision_assessment.outcome.summary.lower()
        assert "INR 45000.00" in plan.decision_assessment.outcome.summary
    else:
        assert "fit" not in plan.decision_assessment.outcome.summary.lower()
        assert plan.decision_assessment.outcome.readiness == "qualified"
        assert "committed" in next_action(plan).question
        assert "income" not in next_action(plan).question
        assert next_action(plan).question.count("?") == 1
    assert adjustment_options(
        normalize(FactsInput.model_validate(data), config),
        plan.events,
        date(2026, 9, 11),
        date(2026, 10, 11),
        date(2026, 9, 11),
    )


@pytest.mark.parametrize("missing", ["date", "amount"])
@pytest.mark.parametrize("terms", [{}, {"controllability": "committed"}, {"autoDebit": True}])
def test_unresolved_purchase_is_named_before_any_fit_claim(missing, terms):
    """Verify missing purchase amounts or dates are named before any affordability claim."""
    item = record("purchase", "optional", "8000", "2026-09-20", label="Purchase", **terms)
    if missing == "date":
        item["schedule"]["date"] = None
    else:
        item["amount"] = money(None, "unknown")
    plan = project(facts("4000", [item]))
    action = next_action(plan)
    assert action.kind == "clarify" and action.record_ids == ["purchase"]
    assert ("When" if missing == "date" else "amount") in action.question
    summary = plan.decision_assessment.outcome.summary
    assert "Purchase" in summary and missing in summary.lower()
    assert "fit" not in summary.lower()
    assert not plan.budget_basis.dated_projection_complete
    if missing == "date":
        assert "planned payments INR 0.00" not in plan.decision_assessment.outcome.covered
        if terms:
            assert any(
                c.kind == ("autoDebit" if terms.get("autoDebit") else "committed")
                for c in plan.decision_assessment.constraints
            )


def test_later_same_day_receipt_does_not_displace_earlier_rent():
    """Verify later same-day receipt risks do not displace an earlier rent shortfall."""
    plan = project(
        facts(
            "100",
            [
                record("rent", "essential", "200", "2026-09-14", label="Rent"),
                record("bill", "essential", "100", "2026-10-01"),
                record("salary", "income", "1000", "2026-10-01"),
            ],
        )
    )
    assert next_action(plan).record_ids == ["rent"]
    assert next_action(plan).before_date == date(2026, 9, 14)
    timing = next(i for i in plan.issues if i.code == "sameDayTiming")
    assert timing.date == date(2026, 10, 1)
    uncertainty = next(u for u in plan.decision_assessment.uncertainties if "sameDayTiming" in u.id)
    assert uncertainty.before_date == timing.date
    assert set(uncertainty.record_ids) == {"bill", "salary"}
    assert "immediateDecision" not in uncertainty.blocks


@pytest.mark.parametrize("kind", ["essential", "optional", "income"])
def test_missing_month_occurrence_qualifies_basis_without_inventing_rollover(kind):
    """Verify missing monthly occurrence dates qualify the projection without invented rollover."""
    plan = project(
        facts(
            "1000",
            [
                record(
                    "monthly",
                    kind,
                    "100",
                    None,
                    label="Monthly item",
                    schedule={"date": "2026-01-31", "recurrence": "monthly"},
                )
            ],
        ),
        date(2026, 2, 11),
    )
    assert not plan.budget_basis.dated_projection_complete
    assert all(e.original_due_date == date(2026, 1, 31) for e in plan.events)
    issue = next(i for i in plan.issues if i.code == "missingMonthDay")
    assert issue.date == date(2026, 2, 11)
    assert any(
        u.record_ids == ["monthly"] and "missingMonthDay" in u.id
        for u in plan.decision_assessment.uncertainties
    )
    assert "Monthly item" in plan.decision_assessment.outcome.summary
    assert "fit" not in plan.decision_assessment.outcome.summary.lower()


def test_past_income_requires_cash_basis_reconciliation_not_ready_assurance():
    """Verify past income prompts opening-cash reconciliation without inflating projected cash."""
    plan = project(facts("100", [record("salary", "income", "1000", "2026-09-10", label="Salary")]))
    assert plan.closing_paise == 10000 and plan.reliable_income_paise == 0
    assert plan.decision_assessment.outcome.readiness == "qualified"
    assert next_action(plan).record_ids == ["salary"]
    assert "opening cash" in next_action(plan).question
    assert "Salary" in plan.decision_assessment.outcome.summary


def test_fit_reports_minimum_cushion_and_reserve_headroom_conditionally():
    """Verify fit guidance reports conditional minimum cash cushion and reserve headroom."""
    plan = project(
        facts(
            "6000",
            [
                record("food", "essential", "2000", "2026-09-12"),
                record("salary", "income", "10000", "2026-09-20"),
                record("rent", "essential", "5000", "2026-09-21"),
            ],
            reserve="1000",
        )
    )
    outcome = plan.decision_assessment.outcome
    assert "INR 4000.00" in outcome.summary and "cushion" in outcome.summary
    assert "INR 3000.00" in outcome.covered and "reserve" in outcome.covered
    assert "reported" in outcome.summary.lower()
    assert "not spendable" in outcome.covered
    assert len(outcome.true_now) <= 5


def test_declined_payee_does_not_deny_existing_effective_cut():
    """Verify a declined payee response does not suppress an effective optional cut."""
    data = facts(
        "1000",
        [
            record("purchase", "optional", "800", "2026-09-12"),
            record("rent", "essential", "500", "2026-09-14"),
        ],
        providerResponses=[
            {"eventId": "rent:2026-09-14", "status": "declined", "reportedOn": "2026-09-11"}
        ],
    )
    plan = project(data)
    assert next_action(plan).kind == "previewChange"
    assert (
        next(
            c for c in plan.decision_assessment.choices if c.id == next_action(plan).choice_id
        ).metrics.first_gap
        is None
    )
    followup = next(a for a in plan.decision_assessment.actions if a.kind == "seekSupport")
    assert "no modeled funded option" not in followup.question
    assert "without a chosen change" in followup.question
    assert plan.first_gap.amount_paise == 30000


def test_funded_card_minimum_does_not_generate_invalid_lender_contact():
    """Verify a funded card minimum prompts a preview rather than unnecessary lender contact."""
    plan = project(
        facts(
            "1000",
            [record("card", "debt", "500", "2026-09-12", debtType="card", target=money("2000"))],
        )
    )
    assert next_action(plan).kind == "previewChange"
    assert not any(
        a.kind in {"contactPayee", "verifyTerms", "seekSupport", "resolveGroup"}
        for a in plan.decision_assessment.actions
    )
    assert not any(u.field == "providerResponses" for u in plan.decision_assessment.uncertainties)
    assert plan.first_gap.amount_paise == 100000


@pytest.mark.parametrize(
    "opening,fields,identity",
    [
        (money("1000"), {"autoDebit": True}, "contact:card:2026-09-12"),
        (money("1000"), {"controllability": "unknown"}, "clarify:card:controllability"),
        (money("1000"), {"amount": money("500", "estimate")}, "clarify:card:estimate"),
        (money("1000"), {"target": money("2000", "estimate")}, "clarify:card:estimate"),
        (money("1000"), {"amount": money(None, "unknown")}, "clarify:card:amount"),
        (money("1000"), {"target": money(None, "unknown")}, "clarify:card:target"),
        (money(None, "unknown"), {}, "clarify:opening"),
        (
            money("1000"),
            {"schedule": {"date": None, "recurrence": "once"}},
            "clarify:card:schedule.date",
        ),
    ],
)
def test_card_control_and_unknown_terms_keep_the_engine_dependency(opening, fields, identity):
    """Verify unresolved card terms retain their dependency action instead of offering a preview."""
    data = facts(
        "1000",
        [record("card", "debt", "500", "2026-09-12", debtType="card", target=money("2000"))],
    )
    data["opening"] = opening
    data["records"][0].update(fields)
    plan = project(data)
    assert next_action(plan).id == identity
    assert not any(
        item.kind == "previewChange" or "minimum fits" in item.question
        for item in plan.decision_assessment.actions
    )
