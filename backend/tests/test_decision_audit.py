# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date

import pytest

from app.decisions import action_dependency_key
from app.facts import facts_input
from app.finance import calculate
from app.models import Command, ProjectionMetrics
from app.store import Problem

from .conftest import facts, money, parsed_command, record
from .test_action_responses import response_command
from .test_currency_conversion import foreign
from .test_decision_priorities import next_action
from .test_finance import project
from .test_scenarios import operation


@pytest.mark.parametrize("timing_peak", [True, False])
async def test_later_funding_relief_remains_actionable_after_deadline_deferrals(store, timing_peak):
    """Offer genuine later relief without replacing earlier risks or assuming consent."""
    items = (
        [
            record("rent", "essential", "6000", "2026-09-14"),
            record("salary", "income", "4000", "2026-09-14"),
            record("wages", "income", "10000", "2026-09-15"),
            record("purchase", "optional", "6000", "2026-09-16"),
            record("food", "essential", "7000", "2026-09-18"),
        ]
        if timing_peak
        else [
            record("rent", "essential", "1000", "2026-09-14"),
            record("wages", "income", "2000", "2026-09-15"),
            record("purchase", "optional", "6000", "2026-09-16"),
            record("salary", "income", "10000", "2026-09-16"),
            record("food", "essential", "6000", "2026-09-18"),
        ]
    )
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(facts("0", items)))
    current = baseline
    assert next_action(current.plan).id == "contact:rent:2026-09-14"
    for identity in ("contact:rent:2026-09-14", "contact:food:2026-09-18"):
        current = await store.command("owner", response_command(current, "unavailable", identity))
    action = next_action(current.plan)
    assert action.id == "preview:purchase:2026-09-16"
    assert action.kind == "previewChange" and "explicit consent" in action.question
    assert "still unfunded on 2026-09-14" in action.question
    choice = next(c for c in current.plan.decision_assessment.choices if c.id == action.choice_id)
    assert not choice.affects_first_gap
    assert choice.affects_peak_gap is not timing_peak
    assert choice.later_only is timing_peak
    assert choice.metrics.first_gap == baseline.plan.first_gap
    assert choice.metrics.peak_gap_paise == (600000 if timing_peak else 100000)
    assert choice.metrics.closing_paise == (100000 if timing_peak else 500000)
    assert baseline.plan.peak_gap_paise == (600000 if timing_peak else 500000)
    assert baseline.plan.closing_paise == (-500000 if timing_peak else -100000)
    if timing_peak:
        assert baseline.plan.timing_risks[0].remaining_gap_paise == 200000
    assert current.plan.model_dump(exclude={"decision_assessment"}) == baseline.plan.model_dump(
        exclude={"decision_assessment"}
    )
    assert current.facts.model_dump(exclude={"decision"}) == baseline.facts.model_dump(
        exclude={"decision"}
    )
    assert current.preview is current.accepted is None
    current = await store.command("owner", response_command(current, "declined"))
    assert next_action(current.plan).id == (
        "review" if timing_peak else "clarify:schedule:sameDayTiming:2026-09-16"
    )
    assert all(a.id != action.id for a in current.plan.decision_assessment.actions)
    with pytest.raises(Problem) as error:
        await store.command("owner", response_command(current, "declined", action.id))
    assert error.value.body.code == "invalidActionResponse"
    assert current.plan.events == baseline.plan.events
    assert current.plan == calculate(current.facts, current.anchor_date, store.config)
    assert await store.get("owner") == current


@pytest.mark.parametrize("control", ["controllable", "unknown"])
async def test_closing_only_cut_never_becomes_the_next_recommendation(store, control):
    """Keep a funded later purchase out of recommendations even after urgent steps are deferred."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "0",
                [
                    record("rent", "essential", "1000", "2026-09-14"),
                    record("salary", "income", "10000", "2026-09-15"),
                    record("purchase", "optional", "6000", "2026-09-16", controllability=control),
                    record("food", "essential", "1000", "2026-09-18"),
                ],
            )
        ),
    )
    assert next_action(baseline.plan).id == "contact:rent:2026-09-14"
    choice = next(
        c for c in baseline.plan.decision_assessment.choices if c.kind == "reduceOptional"
    )
    assert choice.metrics.closing_paise > baseline.plan.closing_paise > 0
    assert choice.metrics.first_gap == baseline.plan.first_gap
    assert choice.metrics.peak_gap_paise == baseline.plan.peak_gap_paise
    current = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(current.plan).id == "review"
    assert current.plan.events == baseline.plan.events


async def test_later_relief_choice_carries_all_accepted_assumptions(store):
    """Reproduce a later-relief comparison from its complete consent-based adjustment bundle."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "0",
                [
                    record("rent", "essential", "6000", "2026-09-14"),
                    record("salary", "income", "4000", "2026-09-14"),
                    record("wages", "income", "10000", "2026-09-15"),
                    record("purchase", "optional", "6000", "2026-09-16"),
                    record("food", "essential", "7000", "2026-09-18"),
                    record("trip", "optional", "500", "2026-09-20"),
                ],
            )
        ),
    )
    current = await store.command(
        "owner",
        Command.model_validate(
            operation(
                "previewAdjustments",
                adjustments=[{"eventId": "trip:2026-09-20", "amount": "0"}],
            )
        ),
    )
    current = await store.command(
        "owner",
        Command.model_validate(operation("acceptPreview", previewId=str(current.preview.id))),
    )
    for identity in ("contact:rent:2026-09-14", "contact:food:2026-09-18"):
        current = await store.command("owner", response_command(current, "unavailable", identity))
    action = next_action(current.accepted.plan)
    assert action.id == "preview:purchase:2026-09-16"
    choice = next(
        c for c in current.accepted.plan.decision_assessment.choices if c.id == action.choice_id
    )
    assert {a.event_id: a.amount_paise for a in choice.adjustment_amounts} == {
        "trip:2026-09-20": 0,
        "purchase:2026-09-16": 0,
    }
    preview = await store.command(
        "owner",
        Command.model_validate(
            operation(
                "previewAdjustments",
                current.revision,
                adjustments=[
                    {"eventId": a.event_id, "amount": "0"} for a in choice.adjustment_amounts
                ],
            )
        ),
    )
    assert (
        ProjectionMetrics.model_validate(
            {name: getattr(preview.preview.plan, name) for name in ProjectionMetrics.model_fields}
        )
        == choice.metrics
    )
    assert preview.preview.removed_assumption_ids == []
    assert preview.accepted == current.accepted
    assert preview.facts.records == baseline.facts.records


@pytest.mark.parametrize("status", ["declined", "awaiting", "reportedTerms"])
@pytest.mark.parametrize("partial", [False, True])
def test_reported_same_day_obligations_use_per_event_actions(status, partial):
    """Keep aggregate exposure while honoring all or some reported same-day responses."""
    data = facts(
        "1000",
        [
            record("rent", "essential", "6000", "2026-09-15", controllability="committed"),
            record("loan", "debt", "3000", "2026-09-15"),
        ],
    )
    baseline = project(data)
    assert next_action(baseline).id == "group:2026-09-15"
    assert "no payment allocation is assumed" in next_action(baseline).question
    data["providerResponses"] = [
        {"eventId": "rent:2026-09-15", "status": status, "reportedOn": "2026-09-11"},
        *(
            []
            if partial
            else [{"eventId": "loan:2026-09-15", "status": "awaiting", "reportedOn": "2026-09-11"}]
        ),
    ]
    plan = project(data)
    actions = {a.record_ids[0]: a for a in plan.decision_assessment.actions}
    assert set(actions) == {"rent", "loan"}
    assert (
        actions["rent"].kind
        == {
            "declined": "seekSupport",
            "awaiting": "followUp",
            "reportedTerms": "verifyTerms",
        }[status]
    )
    assert actions["loan"].kind == ("contactPayee" if partial else "followUp")
    for action in actions.values():
        assert action.consequence_ids == ["cash:2026-09-15"]
        assert "INR 8000.00" in action.question
        assert action.before_date == date(2026, 9, 15)
    assert plan.model_dump(exclude={"decision_assessment"}) == baseline.model_dump(
        exclude={"decision_assessment"}
    )
    assert plan.decision_assessment.consequences == baseline.decision_assessment.consequences
    assert plan.decision_assessment.constraints == baseline.decision_assessment.constraints


async def test_group_deferral_reopens_only_affected_provider_dependencies(store):
    """Reopen response-aware actions after a group report while retaining unrelated deferrals."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record("rent", "essential", "6000", "2026-09-15", controllability="committed"),
                    record("loan", "debt", "3000", "2026-09-15"),
                ],
            )
        ),
    )
    current = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(current.plan).id == "review"
    key = action_dependency_key(current.facts, current.plan, "group:2026-09-15")
    source = facts_input(current.facts).model_dump(mode="json", by_alias=True)
    source["providerResponses"] = [
        {"eventId": "rent:2026-09-15", "status": "declined", "reportedOn": "2026-09-11"},
        {"eventId": "loan:2026-09-15", "status": "awaiting", "reportedOn": "2026-09-11"},
    ]
    current = await store.command("owner", parsed_command(source, current.revision))
    assert action_dependency_key(current.facts, current.plan, "group:2026-09-15") != key
    assert not current.facts.decision.responses
    assert next_action(current.plan).kind in {"followUp", "seekSupport"}
    current = await store.command(
        "owner", response_command(current, "unavailable", "response:loan:2026-09-15")
    )
    assert next_action(current.plan).id == "response:rent:2026-09-15"
    source = facts_input(current.facts).model_dump(mode="json", by_alias=True)
    source["opening"] = money("900")
    current = await store.command("owner", parsed_command(source, current.revision))
    assert all(a.id != "response:loan:2026-09-15" for a in current.plan.decision_assessment.actions)
    source = facts_input(current.facts).model_dump(mode="json", by_alias=True)
    source["providerResponses"][1]["status"] = "reportedTerms"
    current = await store.command("owner", parsed_command(source, current.revision))
    assert next_action(current.plan).id == "contact:loan:2026-09-15"
    assert next_action(current.plan).kind == "verifyTerms"
    assert current.facts.records == baseline.facts.records
    assert current.plan.outflow_paise == baseline.plan.outflow_paise == 900000
    assert current.preview is current.accepted is None


@pytest.mark.parametrize("kind", ["essential", "debt", "income"])
def test_missing_finite_amount_uses_unknown_occurrence_not_known_start(kind):
    """Date and phrase missing amounts for their own occurrence without blocking earlier dues."""
    item = record(
        "item",
        kind,
        None,
        None,
        schedule={
            "date": "2026-09-12",
            "recurrence": "weekly",
            "amounts": [money("100"), money(None, "unknown")],
        },
    )
    item["amount"] = money(None, "unknown")
    plan = project(facts("100", [item, record("loan", "debt", "500", "2026-09-14")]))
    uncertainty = next(u for u in plan.decision_assessment.uncertainties if u.id == "item:amount")
    assert uncertainty.before_date == date(2026, 9, 19)
    assert "2026-09-19" in uncertainty.question and "2026-09-12" not in uncertainty.question
    assert "immediateDecision" not in uncertainty.blocks
    assert next_action(plan).id == "contact:loan:2026-09-14"
    assert [
        (e.date, e.amount_paise, e.schedule_index) for e in plan.events if e.record_id == "item"
    ] == [
        (date(2026, 9, 12), 10000, 0),
        (date(2026, 9, 19), None, 1),
    ]
    assert plan.outflow_paise == (50000 if kind == "income" else 60000)
    assert plan.closing_paise == (-30000 if kind == "income" else -50000)


def test_finite_conversion_questions_use_the_occurrence_missing_each_term():
    """Keep rate, fee, and source-amount questions tied to their respective dated receipts."""
    item = record(
        "work",
        "income",
        None,
        None,
        schedule={
            "date": "2026-09-12",
            "recurrence": "weekly",
            "amounts": [
                money("100"),
                foreign(rate=None),
                foreign(fee=None),
                money(None, "unknown"),
            ],
        },
    )
    item["amount"] = money(None, "unknown")
    plan = project(facts("100", [item, record("loan", "debt", "500", "2026-09-14")]))
    questions = {u.id: u for u in plan.decision_assessment.uncertainties}
    for identity, day in (
        ("conversionRate", date(2026, 9, 19)),
        ("conversionFee", date(2026, 9, 26)),
        ("amount", date(2026, 10, 3)),
    ):
        question = questions[f"work:{identity}"]
        assert question.before_date == day and str(day) in question.question
        assert "immediateDecision" not in question.blocks
    assert next_action(plan).id == "contact:loan:2026-09-14"
    assert [(e.schedule_index, e.amount_paise) for e in plan.events if e.record_id == "work"] == [
        (0, 10000),
        (1, None),
        (2, None),
        (3, None),
    ]
    assert plan.reliable_income_paise == 10000 and plan.closing_paise == -30000


@pytest.mark.parametrize("day", [None, "2026-09-19"])
def test_scalar_unknown_amount_does_not_invent_a_deadline(day):
    """Retain unknown dates and ordinary scalar deadlines without fabricating occurrences."""
    item = record("food", "essential", None, day)
    item["amount"] = money(None, "unknown")
    plan = project(facts("100", [item, record("loan", "debt", "500", "2026-09-14")]))
    question = next(u for u in plan.decision_assessment.uncertainties if u.id == "food:amount")
    assert question.before_date == (date(2026, 9, 19) if day else None)
    assert next_action(plan).id == ("contact:loan:2026-09-14" if day else "clarify:food:amount")
    assert plan.closing_paise == -40000 and plan.outflow_paise == 50000
