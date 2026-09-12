# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date

import pytest

from app.decisions import UNAVAILABLE_ACTIONS, action_dependency_key
from app.facts import facts_input
from app.finance import calculate, export_text, normalize, resolve_adjustments
from app.models import AdjustmentInput, Command, FactsInput, ProjectionMetrics
from app.voice_tools import canonical

from .conftest import facts, money, parsed_command, record
from .test_action_responses import response_command
from .test_decision_priorities import next_action
from .test_finance import project
from .test_scenarios import operation


@pytest.mark.parametrize(
    "field,day,values,immediate",
    [
        ("outstanding", "2026-11-01", [10000, 12000], False),
        ("outstanding", "2026-09-12", [10000, 12000], False),
        ("outstanding", "2026-09-12", [0, 12000], True),
        ("amount", "2026-11-01", [2000, 2500], False),
        ("amount", "2026-09-12", [2000, 2500], True),
        ("schedule.date", None, ["2026-09-12", "2026-11-01"], True),
        ("schedule.date", None, ["2026-11-01", "2026-11-02"], False),
    ],
)
def test_conflict_gates_only_dependent_funding(field, day, values, immediate):
    """Verify conflicts block immediate funding only when the decision depends on them."""
    loan = record("loan", "debt", "2000", day)
    if field != "schedule.date":
        loan[field] = money(None, "unknown")
    identity = f"conflict:loan:{field}"
    data = facts(
        "0",
        [record("rent", "essential", "5000", "2026-09-12", controllability="committed"), loan],
        conflicts=[
            {
                "id": identity,
                "recordId": "loan",
                "field": field,
                "values": [
                    {
                        "id": f"value{index}",
                        "status": "exact",
                        **({"date": value} if field == "schedule.date" else {"amountPaise": value}),
                    }
                    for index, value in enumerate(values)
                ],
            }
        ],
    )
    plan = project(data)
    uncertainty = next(u for u in plan.decision_assessment.uncertainties if u.id == identity)
    assert ("immediateDecision" in uncertainty.blocks) == immediate
    assert next_action(plan).id == (
        f"clarify:{identity}"
        if immediate
        else "group:2026-09-12"
        if day == "2026-09-12"
        else "contact:rent:2026-09-12"
    )
    assert plan.decision_assessment.outcome.branch == "conflict"
    assert any(a.id == f"clarify:{identity}" for a in plan.decision_assessment.actions)
    assert plan.first_gap.amount_paise >= 500000


def test_conflicted_opening_cannot_establish_affordability():
    """Verify conflicting opening balances block affordability conclusions."""
    data = facts(
        "0",
        [record("need", "essential", "1000", "2026-09-12")],
        conflicts=[
            {
                "id": "conflict:opening:opening",
                "field": "opening",
                "values": [
                    {"id": "cashA", "status": "exact", "amountPaise": 10000},
                    {"id": "cashB", "status": "exact", "amountPaise": 200000},
                ],
            }
        ],
    )
    data["opening"] = money(None, "unknown")
    plan = project(data)
    assert next_action(plan).id == "clarify:conflict:opening:opening"
    assert plan.closing_paise is None
    assert "cannot yet be established" in plan.decision_assessment.outcome.summary


@pytest.mark.parametrize("label", ["Groceries for week", "Rent", "Essential item"])
@pytest.mark.parametrize("control", ["unknown", "controllable"])
def test_future_essential_need_does_not_invent_a_creditor(label, control):
    """Verify unfunded future essentials seek support without inventing creditor obligations."""
    plan = project(
        facts(
            "100",
            [
                record(
                    "need",
                    "essential",
                    "1000",
                    "2026-09-12",
                    label=label,
                    controllability=control,
                )
            ],
        )
    )
    action = next_action(plan)
    assert action.kind == "seekSupport"
    assert action.id == "contact:need:2026-09-12"
    assert "INR 900.00" in action.question and "essential need" in action.question
    assert "unchanged" in action.question
    assert "Original dues remain" not in action.question
    assert not any(u.field == "providerResponses" for u in plan.decision_assessment.uncertainties)
    assert not plan.decision_assessment.choices
    assert plan.outflow_paise == 100000 and plan.first_gap.amount_paise == 90000
    assert any(c.kind == "essential" for c in plan.decision_assessment.constraints)
    assert "declined" not in plan.decision_assessment.outcome.not_covered


@pytest.mark.parametrize("basis", ["committed", "autoDebit", "overdue", "provider"])
def test_essential_obligation_keeps_payee_guidance(basis):
    """Verify essential obligations retain agreement-based payee guidance."""
    need = record("need", "essential", "1000", "2026-09-12", label="Groceries for week")
    data = facts("100", [need])
    if basis == "committed":
        need["controllability"] = "committed"
    elif basis == "autoDebit":
        need["autoDebit"] = True
    elif basis == "overdue":
        need["schedule"]["date"] = "2026-09-10"
    else:
        data["providerResponses"] = [
            {
                "eventId": "need:2026-09-12",
                "status": "reportedTerms",
                "reportedOn": "2026-09-11",
            }
        ]
    action = next_action(project(data))
    assert action.kind == ("verifyTerms" if basis == "provider" else "contactPayee")
    assert "agreement" in action.question


async def test_essential_support_deferral_survives_cash_but_reopens_on_commitment(store):
    """Verify support deferrals survive cash edits but reopen when a need becomes committed."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "100",
                [record("need", "essential", "1000", "2026-09-12")],
            )
        ),
    )
    assert next_action(baseline.plan).kind == "seekSupport"
    key = action_dependency_key(baseline.facts, baseline.plan, next_action(baseline.plan).id)
    current = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(current.plan).kind == "reviewOutcome"
    assert current.plan.events == baseline.plan.events
    assert current.facts.provider_responses == []
    assert "declined" not in current.plan.decision_assessment.outcome.not_covered
    source = facts_input(current.facts)
    source.opening.amount = "50"
    current = await store.command("owner", parsed_command(source.model_dump(), current.revision))
    assert current.facts.decision.responses[0].dependency_key == key
    source = facts_input(current.facts)
    source.records[0].controllability = "committed"
    current = await store.command("owner", parsed_command(source.model_dump(), current.revision))
    assert next_action(current.plan).kind == "contactPayee"
    assert current.facts.decision.responses == []
    assert current.facts.records[0].amount.amount_paise == 100000


@pytest.mark.parametrize("early_timing_only", [False, True])
@pytest.mark.parametrize("decline_first", [False, True])
async def test_later_timing_only_cut_remains_optional_after_earlier_deferral(
    store, early_timing_only, decline_first
):
    """Retain optional comparisons without promoting timing-only relief as funded progress."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "0",
                [
                    record("rent", "essential", "6000", "2026-09-14", controllability="committed"),
                    record(
                        "salary", "income", "6000" if early_timing_only else "4000", "2026-09-14"
                    ),
                    record("wages", "income", "10000", "2026-09-15"),
                    record("purchase", "optional", "12000", "2026-09-16"),
                    record("receipt", "income", "10000", "2026-09-16"),
                ],
            )
        ),
    )
    assert next_action(baseline.plan).id == (
        "clarify:schedule:sameDayTiming:2026-09-14"
        if early_timing_only
        else "contact:rent:2026-09-14"
    )
    current = await store.command("owner", response_command(baseline, "unavailable"))
    action = next_action(current.plan)
    assert action.id == "clarify:schedule:sameDayTiming:2026-09-16"
    choice = next(c for c in current.plan.decision_assessment.choices if c.kind == "reduceOptional")
    assert choice.metrics.first_gap == baseline.plan.first_gap
    assert choice.metrics.peak_gap_paise == baseline.plan.peak_gap_paise == 600000
    assert choice.metrics.closing_paise > baseline.plan.closing_paise > 0
    assert choice.metrics.timing_risks == baseline.plan.timing_risks[:1]
    assert len(baseline.plan.timing_risks) == 2
    preview = next(a for a in current.plan.decision_assessment.actions if a.choice_id == choice.id)
    assert "explicit consent" in preview.question
    assert current.plan.events == baseline.plan.events
    assert current.preview is current.accepted is None
    if decline_first:
        current = await store.command("owner", response_command(current, "declined", preview.id))
        assert next_action(current.plan).id == "clarify:schedule:sameDayTiming:2026-09-16"
    current = await store.command("owner", response_command(current, "unavailable"))
    assert next_action(current.plan).id == "review"
    assert (
        any(item.id == preview.id for item in current.plan.decision_assessment.actions)
        is not decline_first
    )
    assert current.plan.events == baseline.plan.events
    assert current.facts.provider_responses == []


async def test_loan_target_review_is_not_an_adjustment_or_required_shortfall(store):
    """Verify loan target reviews distinguish intended extras from required payments."""
    await store.create("owner")
    current = await store.command(
        "owner",
        parsed_command(
            facts(
                "3000",
                [record("loan", "debt", "2000", "2026-09-12", target=money("5000"))],
            )
        ),
    )
    action = next_action(current.plan)
    assert action.kind == "reviewOutcome"
    assert "intended payment of INR 5000.00" in action.question
    assert "required payment of INR 2000.00" in action.question
    assert "fits at that deadline" in action.question
    assert "unchanged" in action.question
    assert current.plan.first_gap.amount_paise == 200000
    assert current.facts.records[0].target.amount_paise == 500000
    assert not (await store.options("owner")).options
    assert not current.plan.decision_assessment.choices
    assert action in current.workspace.actions
    assert action.question in canonical(current)["spokenBrief"]
    assert action.question in export_text(current)
    assert current.preview is current.accepted is None
    current = await store.command(
        "owner",
        Command.model_validate(
            operation(
                "updateFacts",
                current.revision,
                changes={
                    "expectedRevision": current.revision,
                    "records": [{"id": "loan", "target": money("2000")}],
                },
            )
        ),
    )
    assert current.plan.first_gap is None
    assert current.plan.outflow_paise == 200000


@pytest.mark.parametrize("timing", ["earlier", "sameDay", "later", "minimumGap"])
def test_loan_comparison_preserves_other_gaps(config, timing):
    """Verify required-payment comparisons retain other funding gaps and deadline priorities."""
    items = [record("loan", "debt", "2000", "2026-09-14", target=money("5000"))]
    cash = "3000"
    if timing == "earlier":
        items += [record("rent", "essential", "4000", "2026-09-12", controllability="committed")]
    elif timing == "sameDay":
        cash = "1000"
        items += [record("salary", "income", "3000", "2026-09-14")]
    elif timing == "later":
        items += [record("rent", "essential", "4000", "2026-09-16", controllability="committed")]
    else:
        cash = "1000"
    source = normalize(FactsInput.model_validate(facts(cash, items)), config)
    plan = calculate(source, date(2026, 9, 11), config)
    minimum = source.model_copy(deep=True)
    minimum.records[0].target = minimum.records[0].amount.model_copy()
    comparison = calculate(minimum, date(2026, 9, 11), config)
    action = next(a for a in plan.decision_assessment.actions if a.record_ids == ["loan"])
    assert f"INR {comparison.first_gap.amount_paise // 100}.00" in action.question
    assert str(comparison.first_gap.date) in action.question
    assert ("fits at that deadline" in action.question) == (timing == "later")
    assert next_action(plan).record_ids == (
        ["rent"] if timing in {"earlier", "later"} else ["loan"]
    )
    if timing == "sameDay":
        assert next_action(plan).kind == "contactPayee"
        assert "INR 1000.00 remains unfunded" in action.question
        assert plan.first_gap.amount_paise == 400000
        assert plan.timing_risks[0].remaining_gap_paise == 100000
        assert comparison.first_gap.amount_paise == 100000
        assert comparison.timing_risks[0].remaining_gap_paise == 0
        assert not any(item.kind == "confirmReceipt" for item in plan.decision_assessment.actions)
    assert source.records[0].target.amount_paise == 500000
    assert plan.outflow_paise == (900000 if timing in {"earlier", "later"} else 500000)


async def test_loan_same_day_deferral_keeps_target_gap_until_explicit_correction(store):
    """Verify deferring a loan action preserves its target gap until the target is corrected."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record("loan", "debt", "2000", "2026-09-14", target=money("5000")),
                    record("salary", "income", "3000", "2026-09-14"),
                ],
            )
        ),
    )
    assert next_action(baseline.plan).id == "contact:loan:2026-09-14"
    assert not (await store.options("owner")).options
    deferred = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(deferred.plan).kind == "reviewOutcome"
    assert deferred.plan.decision_assessment.next_question_id is None
    assert deferred.plan.events == baseline.plan.events
    assert deferred.plan.timing_risks == baseline.plan.timing_risks
    assert deferred.plan.first_gap == baseline.plan.first_gap
    assert deferred.facts.model_dump(exclude={"decision"}) == baseline.facts.model_dump(
        exclude={"decision"}
    )
    assert deferred.facts.decision.responses[0].action_id == next_action(baseline.plan).id
    assert deferred.facts.decision.responses[0].response == "unavailable"
    assert deferred.preview is deferred.accepted is None
    assert "INR 1000.00 is still unfunded" in deferred.plan.decision_assessment.outcome.summary
    assert not any(
        action.kind in {"confirmReceipt", "previewChange"}
        or "fits at that deadline" in action.question
        for action in deferred.plan.decision_assessment.actions
    )
    assert not deferred.workspace.questions
    assert await store.get("owner") == deferred

    source = facts_input(deferred.facts)
    source.records[0].target = source.records[0].amount.model_copy()
    corrected = await store.command("owner", parsed_command(source.model_dump(), deferred.revision))
    assert next_action(corrected.plan).id == "clarify:schedule:sameDayTiming:2026-09-14"
    assert next_action(corrected.plan).kind == "confirmReceipt"
    assert next_action(corrected.plan).record_ids == ["loan", "salary"]
    assert corrected.plan.decision_assessment.next_question_id is None
    assert corrected.plan.outflow_paise == 200000
    assert corrected.plan.first_gap.amount_paise == 100000
    assert corrected.plan.timing_risks[0].remaining_gap_paise == 0
    assert corrected.facts.decision.responses == []
    assert corrected.facts.provider_responses == []
    assert corrected.preview is corrected.accepted is None
    assert "fits at that deadline" not in next_action(corrected.plan).question


@pytest.mark.parametrize(
    "fields",
    [
        {"autoDebit": True},
        {"controllability": "committed"},
        {"controllability": "unknown"},
        {"amount": money("2000", "estimate")},
        {"target": money("5000", "estimate")},
    ],
)
def test_loan_minimum_fit_requires_confirmed_control_and_amounts(fields):
    """Verify loan minimum-fit guidance requires confirmed control and exact amounts."""
    loan = record("loan", "debt", "2000", "2026-09-12", target=money("5000"))
    loan.update(fields)
    plan = project(facts("3000", [loan]))
    assert not any("fits at that deadline" in a.question for a in plan.decision_assessment.actions)
    assert all(choice.kind == "enquire" for choice in plan.decision_assessment.choices)
    assert plan.outflow_paise == 500000


@pytest.mark.parametrize("target", [money("2000"), money(None, "unknown")])
def test_required_only_gap_is_not_mislabeled_as_an_intended_extra(target):
    """Verify required-payment gaps are described as unfunded obligations, not optional extras."""
    plan = project(facts("1000", [record("loan", "debt", "2000", "2026-09-12", target=target)]))
    action = next_action(plan)
    assert action.kind == "contactPayee"
    assert "not an established shortfall" not in action.question
    assert "INR 1000.00 remains unfunded" in action.question
    assert plan.first_gap.amount_paise == 100000


@pytest.mark.parametrize("timing_peak", [False, True], ids=["laterPeak", "unchangedTimingPeak"])
async def test_later_funding_cut_is_reachable_without_resolving_earlier_gap(store, timing_peak):
    """Verify later funding relief stays selectable after earlier obligations are deferred."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "0",
                [
                    record(
                        "rent",
                        "essential",
                        "6000" if timing_peak else "1000",
                        "2026-09-14",
                        controllability="committed",
                    ),
                    record("wages", "income", "10000" if timing_peak else "2000", "2026-09-15"),
                    record("purchase", "optional", "6000", "2026-09-16"),
                    record(
                        "salary",
                        "income",
                        "4000" if timing_peak else "10000",
                        "2026-09-14" if timing_peak else "2026-09-16",
                    ),
                    record("food", "essential", "7000" if timing_peak else "6000", "2026-09-18"),
                ],
            )
        ),
    )
    plan = baseline.plan
    choice = next(c for c in plan.decision_assessment.choices if c.kind == "reduceOptional")
    comparison = calculate(
        baseline.facts,
        baseline.anchor_date,
        store.config,
        adjustments=resolve_adjustments(
            [AdjustmentInput(event_id="purchase:2026-09-16", amount="0")],
            (await store.options("owner")).options,
            store.config,
        ),
    )
    assert choice.metrics.model_dump() == comparison.model_dump(
        include=set(ProjectionMetrics.model_fields)
    )
    assert choice.metrics.first_gap == plan.first_gap
    assert not choice.affects_first_gap
    assert plan.first_gap.date == date(2026, 9, 14)
    assert plan.first_gap.amount_paise == (600000 if timing_peak else 100000)
    assert plan.peak_gap_paise == (600000 if timing_peak else 500000)
    assert plan.closing_paise == (-500000 if timing_peak else -100000)
    assert comparison.peak_gap_paise == (600000 if timing_peak else 100000)
    assert comparison.closing_paise == (100000 if timing_peak else 500000)
    assert choice.affects_peak_gap == (not timing_peak)
    if timing_peak:
        assert plan.timing_risks[0].remaining_gap_paise == 200000
        assert comparison.timing_risks == plan.timing_risks
    assert next_action(plan).id == "contact:rent:2026-09-14"
    current = baseline
    for _ in range(len(plan.decision_assessment.actions)):
        action = next_action(current.plan)
        if action.kind not in UNAVAILABLE_ACTIONS:
            break
        current = await store.command("owner", response_command(current, "unavailable"))
    action = next_action(current.plan)
    assert action.id == "preview:purchase:2026-09-16"
    assert action.kind == "previewChange"
    assert "still unfunded on 2026-09-14" in action.question
    assert "explicit consent" in action.question
    assert "No further funded change" not in current.plan.decision_assessment.outcome.next_step
    assert current.plan.first_gap == plan.first_gap
    assert current.plan.events == plan.events
    assert current.facts.model_dump(exclude={"decision"}) == baseline.facts.model_dump(
        exclude={"decision"}
    )
    assert current.preview is current.accepted is None
    current = await store.command("owner", response_command(current, "declined"))
    assert not any(a.id == action.id for a in current.plan.decision_assessment.actions)
    assert current.plan.events == plan.events


@pytest.mark.parametrize("later_gap", [False, True])
@pytest.mark.parametrize(
    "intent,focus",
    [("plan30Days", []), ("specificDecision", ["rent"]), ("specificDecision", ["purchase"])],
)
async def test_later_cut_selection_requires_relevant_funding_relief(
    store, later_gap, intent, focus
):
    """Verify unrelated cuts are not pushed solely for a higher closing balance."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "0",
                [
                    record("rent", "essential", "1000", "2026-09-14"),
                    record("wages", "income", "10000", "2026-09-15"),
                    record("purchase", "optional", "6000", "2026-09-16"),
                    record("food", "essential", "4000" if later_gap else "1000", "2026-09-18"),
                ],
                decision={"intent": intent, "focusRecordIds": focus},
            )
        ),
    )
    current = baseline
    for _ in range(len(baseline.plan.decision_assessment.actions)):
        action = next_action(current.plan)
        if action.kind not in UNAVAILABLE_ACTIONS:
            break
        current = await store.command("owner", response_command(current, "unavailable"))
    assert next_action(current.plan).kind == (
        "previewChange"
        if later_gap and (intent == "plan30Days" or focus == ["purchase"])
        else "reviewOutcome"
    )
    assert current.plan.events == baseline.plan.events
