# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date

import pytest

from app.decisions import action_dependency_key

from .conftest import facts, money, parsed_command, record
from .test_action_responses import response_command
from .test_currency_conversion import foreign
from .test_decision_priorities import next_action
from .test_finance import project
from .test_finite_schedules import variable


@pytest.fixture
def later():
    """Build an early rent gap with a separate later shortfall removable by a purchase cut."""
    return facts(
        "0",
        [
            record("rent", "essential", "1000", "2026-09-14", controllability="committed"),
            record("wages", "income", "2000", "2026-09-15"),
            record("purchase", "optional", "6000", "2026-09-16"),
            record("salary", "income", "10000", "2026-09-16"),
            record("food", "essential", "6000", "2026-09-18"),
        ],
    )


@pytest.fixture
def grouped():
    """Build two mandatory same-day dues sharing one unfunded amount."""
    return facts(
        "1000",
        [
            record("rent", "essential", "6000", "2026-09-15", controllability="committed"),
            record("loan", "debt", "3000", "2026-09-15"),
        ],
    )


async def test_later_cut_follows_rent_deferral_before_later_help(store, later):
    """Verify useful later relief follows early rent assistance without applying the proposal."""
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(later))
    assert next_action(baseline.plan).id == "contact:rent:2026-09-14"
    assert baseline.plan.first_gap.amount_paise == 100000
    assert (baseline.plan.peak_gap_paise, baseline.plan.closing_paise) == (500000, -100000)
    current = await store.command("owner", response_command(baseline, "unavailable"))
    action = next_action(current.plan)
    assert action.id == "preview:purchase:2026-09-16"
    choice = next(c for c in current.plan.decision_assessment.choices if c.id == action.choice_id)
    assert choice.adjustment_amounts[0].amount_paise == 0
    assert choice.metrics.first_gap == baseline.plan.first_gap
    assert (choice.metrics.peak_gap_paise, choice.metrics.closing_paise) == (100000, 500000)
    assert "consent" in action.question and "still unfunded on 2026-09-14" in action.question
    assert any(a.id == "contact:food:2026-09-18" for a in current.plan.decision_assessment.actions)
    assert current.plan.events == baseline.plan.events
    assert current.facts.records == baseline.facts.records
    assert current.preview is current.accepted is None


@pytest.mark.parametrize("control", ["controllable", "unknown"])
async def test_all_assistance_unavailable_keeps_later_choice(store, later, control):
    """Verify assistance deferrals leave the reduction or its control prerequisite available."""
    later["records"][2]["controllability"] = control
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(later))
    current = baseline
    for identity in (
        "contact:rent:2026-09-14",
        "clarify:schedule:sameDayTiming:2026-09-16",
        "contact:food:2026-09-18",
    ):
        current = await store.command("owner", response_command(current, "unavailable", identity))
    action = next_action(current.plan)
    assert action.id == (
        "preview:purchase:2026-09-16"
        if control == "controllable"
        else "clarify:purchase:controllability"
    )
    assert action.choice_id == "reduce:purchase:2026-09-16"
    assert len(current.facts.decision.responses) == 3
    assert current.plan.events == baseline.plan.events
    assert current.facts.provider_responses == []
    assert current.preview is current.accepted is None


async def test_declined_later_cut_is_not_reasked_after_assistance_deferrals(store, later):
    """Verify declining later relief suppresses its action, not the original spending facts."""
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(later))
    current = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(current.plan).id == "preview:purchase:2026-09-16"
    current = await store.command("owner", response_command(current, "declined"))
    for identity in ("clarify:schedule:sameDayTiming:2026-09-16", "contact:food:2026-09-18"):
        current = await store.command("owner", response_command(current, "unavailable", identity))
    assert next_action(current.plan).kind == "reviewOutcome"
    assert not current.plan.decision_assessment.choices
    assert current.plan.events == baseline.plan.events
    assert current.facts.records == baseline.facts.records
    assert any(o.event_id == "purchase:2026-09-16" for o in (await store.options("owner")).options)
    assert await store.get("owner") == current


async def test_later_funding_relief_does_not_require_changed_first_or_peak(store, later):
    """Verify an unchanged early peak cannot hide relief for a separate later funding gap."""
    later["records"][0]["amount"] = money("6000")
    later["records"][1]["amount"] = money("7000")
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(later))
    current = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(current.plan).id == "preview:purchase:2026-09-16"
    choice = next(c for c in current.plan.decision_assessment.choices if c.kind == "reduceOptional")
    assert choice.later_only and not choice.affects_first_gap and not choice.affects_peak_gap
    assert choice.metrics.first_gap == baseline.plan.first_gap
    assert choice.metrics.peak_gap_paise == baseline.plan.peak_gap_paise == 600000
    assert (baseline.plan.closing_paise, choice.metrics.closing_paise) == (-100000, 500000)


async def test_later_timing_and_closing_improvements_alone_do_not_promote_cut(store, later):
    """Verify improving a later timing peak and closing cash is not genuine funding relief."""
    later["records"][4]["amount"] = money("4000")
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(later))
    current = baseline
    for identity in ("contact:rent:2026-09-14", "clarify:schedule:sameDayTiming:2026-09-16"):
        current = await store.command("owner", response_command(current, "unavailable", identity))
    assert next_action(current.plan).kind == "reviewOutcome"
    choice = next(c for c in current.plan.decision_assessment.choices if c.kind == "reduceOptional")
    assert choice.metrics.first_gap == baseline.plan.first_gap
    assert choice.metrics.peak_gap_paise < baseline.plan.peak_gap_paise
    assert choice.metrics.closing_paise > baseline.plan.closing_paise > 0
    assert current.plan.events == baseline.plan.events


async def test_available_assistance_before_cut_deadline_keeps_priority(store, later):
    """Verify deferring the first due does not bypass a second actionable earlier obligation."""
    later["records"].append(record("loan", "debt", "3000", "2026-09-15"))
    later["coverage"]["debt"] = "reviewed"
    await store.create("owner")
    current = await store.command("owner", parsed_command(later))
    assert next_action(current.plan).id == "contact:rent:2026-09-14"
    current = await store.command("owner", response_command(current, "unavailable"))
    assert next_action(current.plan).id == "contact:loan:2026-09-15"
    current = await store.command("owner", response_command(current, "unavailable"))
    assert next_action(current.plan).id == "preview:purchase:2026-09-16"


async def test_mixed_provider_reports_remain_individual_and_shared_after_deferral(store, grouped):
    """Verify distinct statuses advance without allocating or duplicating the shared gap."""
    grouped["providerResponses"] = [
        {"eventId": "rent:2026-09-15", "status": "declined", "reportedOn": "2026-09-11"},
        {"eventId": "loan:2026-09-15", "status": "awaiting", "reportedOn": "2026-09-11"},
    ]
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(grouped))
    assert {a.id: a.kind for a in baseline.plan.decision_assessment.actions} == {
        "response:rent:2026-09-15": "seekSupport",
        "response:loan:2026-09-15": "followUp",
    }
    for action in baseline.plan.decision_assessment.actions:
        assert "INR 8000.00 shortage is shared across all commitments on 2026-09-15" in (
            action.question
        )
        assert "not allocated" in action.question and "do not add" in action.question
        assert action.consequence_ids == ["cash:2026-09-15"]
    current = baseline
    for _ in range(2):
        current = await store.command("owner", response_command(current, "unavailable"))
    assert next_action(current.plan).kind == "reviewOutcome"
    assert current.plan.events == baseline.plan.events
    assert current.plan.first_gap.amount_paise == 800000
    assert current.facts.provider_responses == baseline.facts.provider_responses
    assert current.preview is current.accepted is None
    assert await store.get("owner") == current


@pytest.mark.parametrize("other_status", [None, "awaiting"])
def test_reported_terms_bypass_group_without_implying_agreement(grouped, other_status):
    """Verify a reported offer prompts verification while original dues remain authoritative."""
    grouped["providerResponses"] = [
        {
            "eventId": "rent:2026-09-15",
            "status": "reportedTerms",
            "reportedOn": "2026-09-11",
            "payment": money("2000"),
            "paymentDate": "2026-09-21",
            "cost": money(None, "unknown"),
        }
    ]
    if other_status:
        grouped["providerResponses"].append(
            {"eventId": "loan:2026-09-15", "status": other_status, "reportedOn": "2026-09-11"}
        )
    plan = project(grouped)
    action = next(a for a in plan.decision_assessment.actions if a.kind == "verifyTerms")
    assert "payment INR 2000.00 (exact, reported)" in action.question
    assert "unknown cost" in action.question and "payment date 2026-09-21" in action.question
    assert "unchanged without agreement" in action.question
    assert {a.kind for a in plan.decision_assessment.actions} == {
        "verifyTerms",
        "followUp" if other_status else "contactPayee",
    }
    assert all("shortage is shared" in a.question for a in plan.decision_assessment.actions)
    assert plan.outflow_paise == 900000 and plan.closing_paise == -800000
    grouped["records"].reverse()
    grouped["providerResponses"].reverse()
    assert project(grouped).decision_assessment == plan.decision_assessment


async def test_unreported_group_is_permutation_independent_and_stays_deferred(store, grouped):
    """Verify absent reports retain one grouped action that does not split after deferral."""
    plan = project(grouped)
    assert next_action(plan).kind == "resolveGroup"
    grouped["records"].reverse()
    assert project(grouped).decision_assessment == plan.decision_assessment
    grouped["records"][0]["id"], grouped["records"][1]["id"] = "rent", "loan"
    assert next_action(project(grouped)).question == next_action(plan).question
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(grouped))
    current = await store.command("owner", response_command(baseline, "unavailable"))
    assert [a.kind for a in current.plan.decision_assessment.actions] == ["reviewOutcome"]
    assert current.plan.events == baseline.plan.events
    assert current.facts.provider_responses == []
    assert await store.get("owner") == current


@pytest.mark.parametrize("first_unknown", [False, True])
async def test_variable_unknown_uses_its_occurrence_not_the_known_first_amount(
    store, first_unknown
):
    """Verify only an unknown occurrence before the loan deadline is an immediate dependency."""
    amounts = [money("100"), money(None, "unknown")]
    if first_unknown:
        amounts.reverse()
    food = variable("essential", amounts) | {"id": "food", "label": "food"}
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(facts("100", [food, record("loan", "debt", "500", "2026-09-14")])),
    )
    action = next(
        a for a in baseline.plan.decision_assessment.actions if a.id == "clarify:food:amount"
    )
    assert action.before_date == date(2026, 9, 12 if first_unknown else 19)
    assert f"food on {action.before_date}" in action.question
    assert next_action(baseline.plan).id == (
        action.id if first_unknown else "contact:loan:2026-09-14"
    )
    assert baseline.plan.first_gap.date == date(2026, 9, 14)
    assert baseline.plan.first_gap.amount_paise == (40000 if first_unknown else 50000)
    key = action_dependency_key(baseline.facts, baseline.plan, action.id)
    current = await store.command("owner", response_command(baseline, "unavailable", action.id))
    assert current.facts.decision.responses[0].dependency_key == key
    assert all(a.id != action.id for a in current.plan.decision_assessment.actions)
    assert current.plan.model_dump(exclude={"decision_assessment"}) == baseline.plan.model_dump(
        exclude={"decision_assessment"}
    )


@pytest.mark.parametrize(
    "start,amounts,end,expected,indices",
    [
        ("2026-09-12", ["100", None, None], "2026-09-19", "2026-09-19", [0, 1]),
        ("2026-08-22", ["100", None, "100", None, None], None, "2026-09-12", [0, 3, 4]),
    ],
)
def test_clipped_unknown_occurrences_use_earliest_projected_date(
    start, amounts, end, expected, indices
):
    """Verify omitted and end-clipped unknowns cannot date the surviving amount question."""
    food = variable(
        "essential",
        [money(value, "unknown" if value is None else "exact") for value in amounts],
        date=start,
        endDate=end,
    )
    plan = project(facts("100", [food]))
    question = next(u for u in plan.decision_assessment.uncertainties if u.id == "item:amount")
    assert question.before_date.isoformat() == expected
    assert f"item on {expected}" in question.question
    assert [event.schedule_index for event in plan.events] == indices
    assert plan.events[0].amount_paise == 10000
    assert all(event.amount_paise is None for event in plan.events[1:])
    assert plan.outflow_paise == 10000 and plan.first_gap is None


@pytest.mark.parametrize("term", ["rate", "fee"])
async def test_variable_conversion_question_tracks_only_its_unknown_occurrence(store, term):
    """Verify missing conversion terms refer to their source occurrence and advance after a due."""
    receipt = variable(
        amounts=[
            money("100"),
            foreign("10", **{term: None}),
            foreign("10", **{"fee" if term == "rate" else "rate": None}),
        ]
    )
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(facts("0", [receipt, record("loan", "debt", "500", "2026-09-14")])),
    )
    assert next_action(baseline.plan).id == "contact:loan:2026-09-14"
    questions = [
        u for u in baseline.plan.decision_assessment.uncertainties if "conversion" in u.field
    ]
    assert {u.id: u.before_date for u in questions} == {
        f"item:conversion{term.title()}": date(2026, 9, 19),
        f"item:conversion{'Fee' if term == 'rate' else 'Rate'}": date(2026, 9, 26),
    }
    assert all(f"item on {u.before_date}" in u.question for u in questions)
    assert all("immediateDecision" not in u.blocks for u in questions)
    current = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(current.plan).id == f"clarify:item:conversion{term.title()}"
    assert next_action(current.plan).before_date == date(2026, 9, 19)
    assert current.plan.model_dump(exclude={"decision_assessment"}) == baseline.plan.model_dump(
        exclude={"decision_assessment"}
    )
