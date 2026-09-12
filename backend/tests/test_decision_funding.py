# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date

import pytest

from app.decisions import action_dependency_key
from app.facts import facts_input
from app.finance import calculate, export_text, normalize
from app.models import Command, FactsInput
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


async def test_loan_target_review_is_not_an_adjustment_or_required_shortfall(store):
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
    loan = record("loan", "debt", "2000", "2026-09-12", target=money("5000"))
    loan.update(fields)
    plan = project(facts("3000", [loan]))
    assert not any("fits at that deadline" in a.question for a in plan.decision_assessment.actions)
    assert all(choice.kind == "enquire" for choice in plan.decision_assessment.choices)
    assert plan.outflow_paise == 500000


@pytest.mark.parametrize("target", [money("2000"), money(None, "unknown")])
def test_required_only_gap_is_not_mislabeled_as_an_intended_extra(target):
    plan = project(facts("1000", [record("loan", "debt", "2000", "2026-09-12", target=target)]))
    action = next_action(plan)
    assert action.kind == "contactPayee"
    assert "not an established shortfall" not in action.question
    assert "INR 1000.00 remains unfunded" in action.question
    assert plan.first_gap.amount_paise == 100000
