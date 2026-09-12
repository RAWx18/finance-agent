# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date

import pytest

from app.facts import facts_input

from .conftest import facts, money, parsed_command, record
from .test_action_responses import response_command
from .test_currency_conversion import foreign
from .test_decision_priorities import next_action
from .test_finance import project


@pytest.mark.parametrize("reverse", [False, True])
def test_dependency_uses_earlier_protected_deadline_not_labels_or_input_order(reverse):
    """Verify protected deadlines rank questions, regardless of labels or input order."""
    items = [
        record("urgent", "essential", "1000", "2026-09-12", label="Z need"),
        record("later", "debt", "1000", "2026-09-20", label="A loan"),
    ]
    for item in items:
        item["amount"] = money(None, "unknown")
    if reverse:
        items.reverse()
        items[0]["label"], items[1]["label"] = items[1]["label"], items[0]["label"]
    plan = project(facts("100", items))
    assert plan.decision_assessment.next_question_id == "urgent:amount"
    assert next_action(plan).before_date == date(2026, 9, 12)


@pytest.mark.parametrize("reverse", [False, True])
def test_receipt_dependency_uses_reconciled_relief_not_name_or_receipt_order(reverse):
    """Verify receipt questions prioritize funding relief rather than labels or receipt order."""
    items = [
        record("small", "income", "100", "2026-09-12", label="A wages", reliability="unknown"),
        record("large", "income", "1000", "2026-09-13", label="Z wages", reliability="unknown"),
        record("rent", "essential", "800", "2026-09-14"),
    ]
    if reverse:
        items.reverse()
        items[1]["label"], items[2]["label"] = items[2]["label"], items[1]["label"]
    plan = project(facts("0", items))
    assert plan.decision_assessment.next_question_id == "large:receipt"
    assert next_action(plan).before_date == date(2026, 9, 14)
    assert plan.first_gap.amount_paise == 80000
    assert plan.reliable_income_paise == 0


def test_blocking_conflict_precedes_receipt_and_usable_cash():
    """Verify blocking debt conflicts precede receipt and opening-cash questions."""
    data = facts(
        "0",
        [
            record("salary", "income", "1000", "2026-09-12", reliability="unknown"),
            record("loan", "debt", "800", "2026-09-14", outstanding=money("0")),
        ],
    )
    assert project(data).decision_assessment.next_question_id == "loan:debtBalanceConflict"
    data["opening"] = money(None, "unknown")
    assert project(data).decision_assessment.next_question_id == "loan:debtBalanceConflict"
    data["records"][1]["outstanding"] = money("800")
    assert project(data).decision_assessment.next_question_id == "opening"


def test_undated_requirement_has_no_invented_due_date():
    """Verify undated requirements prompt for dates without inventing deadlines or gaps."""
    plan = project(
        facts(
            "100",
            [record("rent", "essential", "200", None), record("salary", "income", "500", None)],
        )
    )
    assert next_action(plan).id == "clarify:rent:schedule.date"
    assert next_action(plan).before_date is None
    assert next_action(plan).question == "When is rent due?"
    assert plan.first_gap is None
    assert plan.decision_assessment.constraints[0].date is None


def test_known_income_amount_missing_date_asks_availability_date_not_amount():
    """Verify known income with no date prompts for availability rather than its amount."""
    plan = project(
        facts(
            "0",
            [
                record("salary", "income", "1000", None),
                record("rent", "essential", "800", "2026-09-14"),
            ],
        )
    )
    assert next_action(plan).id == "clarify:salary:schedule.date"
    assert next_action(plan).question == "When will salary be available to use?"
    assert "salary:amount" not in {u.id for u in plan.decision_assessment.uncertainties}


@pytest.mark.parametrize("reliability", ["uncertain", "unknown"])
def test_late_income_availability_cannot_displace_earlier_gap(reliability):
    """Verify late income uncertainty does not displace an earlier essential shortfall."""
    plan = project(
        facts(
            "100",
            [
                record("rent", "essential", "500", "2026-09-12"),
                record("salary", "income", "10000", "2026-09-20", reliability=reliability),
            ],
        )
    )
    assert next_action(plan).id == "contact:rent:2026-09-12"


@pytest.mark.parametrize("field", ["amount", "target"])
def test_required_minimum_and_intended_payment_have_distinct_questions(field):
    """Verify card questions distinguish the required minimum from the intended payment."""
    card = record("card", "debt", "500", "2026-09-12", debtType="card", target=money("1000"))
    card[field] = money(None, "unknown")
    action = next_action(project(facts("2000", [card])))
    assert action.id == f"clarify:card:{field}"
    assert "required" in action.question
    assert "extra" in action.question if field == "amount" else "INR 500.00" in action.question


@pytest.mark.parametrize("status", ["unknown", "none"])
def test_focused_purchase_stops_after_explicit_needs_answer_without_income_inventory(status):
    """Verify explicit needs answers end focused purchase queries without income inventory."""
    data = facts(
        "50000",
        [record("phone", "optional", "5000", "2026-09-20")],
        coverage={"optional": "reviewed", "essential": status, "debt": status},
        decision={"intent": "specificDecision", "focusRecordIds": ["phone"]},
    )
    plan = project(data)
    assert next_action(plan).kind == "reviewOutcome"
    assert plan.decision_assessment.next_question_id is None
    if status == "unknown":
        assert "fit" not in plan.decision_assessment.outcome.summary
        assert plan.decision_assessment.outcome.branch == "uncertain"


def test_funded_focused_purchase_does_not_interview_unneeded_income():
    """Verify a funded focused purchase can reach review despite an irrelevant income date."""
    data = facts(
        "50000",
        [
            record("phone", "optional", "5000", "2026-09-20"),
            record("bonus", "income", "1000", None),
        ],
        decision={"intent": "specificDecision", "focusRecordIds": ["phone"]},
    )
    plan = project(data)
    assert next_action(plan).kind == "reviewOutcome"
    assert plan.decision_assessment.outcome.readiness == "qualified"
    assert any(u.id == "bonus:schedule.date" for u in plan.decision_assessment.uncertainties)


def test_known_urgent_gap_gets_help_before_scope_check():
    """Verify a known urgent shortfall receives actionable help before scope clarification."""
    plan = project(
        facts(
            "100",
            [record("rent", "essential", "500", "2026-09-12")],
            coverage={},
            decision={"intent": "specificDecision", "focusRecordIds": ["rent"]},
        )
    )
    assert next_action(plan).id == "contact:rent:2026-09-12"
    assert "INR 400.00" in next_action(plan).question


def test_opening_and_scope_questions_do_not_expose_internal_category_states():
    """Verify cash and scope questions use plain language rather than internal category states."""
    data = facts("0", [], coverage={})
    data["opening"] = money(None, "unknown")
    text = next_action(project(data)).question
    assert "available" in text and "original cash basis" not in text
    data["opening"] = money("500")
    data["records"] = [record("food", "essential", "100", "2026-09-12")]
    text = next_action(project(data)).question
    assert "anything else" in text
    assert not any(word in text for word in ("scope", "absent", "complete", "notDiscussed"))


@pytest.mark.parametrize("reverse", [False, True])
def test_protection_depends_on_commitment_not_kind_or_label_inventory(reverse):
    """Verify commitment protects an undated requirement regardless of category or label order."""
    items = [
        record("required", "optional", "1000", None, controllability="committed", label="Z item"),
        record("small", "essential", "100", None, label="A item"),
        record("income", "income", "10000", None),
    ]
    if reverse:
        items.reverse()
        items[1]["label"], items[2]["label"] = items[2]["label"], items[1]["label"]
    plan = project(facts("100", items))
    assert next_action(plan).id == "clarify:required:schedule.date"
    assert next_action(plan).before_date is None
    assert plan.events == [] and plan.first_gap is None
    assert plan.reliable_income_paise == 0
    assert any(
        constraint.id == "required:undated"
        and constraint.kind == "committed"
        and constraint.amount_paise == 100000
        for constraint in plan.decision_assessment.constraints
    )


@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("basis", ["committed", "autoDebit", "essential", "debt"])
def test_undated_protection_uses_required_amounts_not_targets(reverse, basis):
    """Verify undated protected needs rank by required amounts, not targets or input order."""
    items = [
        record(
            "required",
            basis if basis in {"essential", "debt"} else "optional",
            "1000",
            None,
            label="Z requirement",
            **({"controllability": "committed"} if basis == "committed" else {}),
            **({"autoDebit": True} if basis == "autoDebit" else {}),
        ),
        record("small", "essential", "100", None, label="A need"),
        record("card", "debt", "50", None, debtType="card", target=money("10000")),
        record("purchase", "optional", "20000", None),
        record("salary", "income", "30000", None),
        record("bill", "essential", "25", "2026-09-12"),
    ]
    if reverse:
        items.reverse()
    plan = project(facts("100", items))
    assert next_action(plan).id == "clarify:required:schedule.date"
    assert next_action(plan).before_date is None
    assert plan.first_gap is None and plan.outflow_paise == 2500
    assert plan.closing_paise == 7500 and plan.reliable_income_paise == 0
    assert not plan.budget_basis.dated_projection_complete
    assert (
        "what-if, not proof payments can be made on time"
        in plan.decision_assessment.outcome.summary
    )
    assert plan.undated_impact.closing_paise < 0


@pytest.mark.parametrize("intent", ["plan30Days", "specificDecision"])
def test_unknown_outflow_scope_never_gives_positive_assurance_with_dated_records(intent):
    """Verify unknown outflow coverage prevents affordability assurance despite dated records."""
    plan = project(
        facts(
            "50000",
            [record("phone", "optional", "5000", "2026-09-20")],
            coverage={
                "optional": "reviewed",
                "income": "none",
                "essential": "unknown",
                "debt": "unknown",
            },
            decision={"intent": intent, "focusRecordIds": ["phone"]},
        )
    )
    assert next_action(plan).kind == "reviewOutcome"
    assert plan.decision_assessment.outcome.readiness == "qualified"
    assert "fit" not in plan.decision_assessment.outcome.summary
    assert (
        "Check remaining living costs and required payments"
        in plan.decision_assessment.outcome.summary
    )


@pytest.mark.parametrize("field", ["amount", "rate", "fee"])
async def test_finite_unknown_questions_advance_only_with_their_source_correction(store, field):
    """Keep one dated question per field and preserve later unknown sources through deferrals."""
    amounts = [money("100")] + [
        money(None, "unknown") if field == "amount" else foreign(**{field: None}) for _ in range(3)
    ]
    item = record(
        "work",
        "income",
        None,
        None,
        schedule={"date": "2026-09-12", "recurrence": "weekly", "amounts": amounts},
    ) | {"amount": money(None, "unknown")}
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(facts("100", [item, record("loan", "debt", "500", "2026-09-14")])),
    )
    identity = f"work:{'amount' if field == 'amount' else 'conversion' + field.title()}"
    current = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(current.plan).id == f"clarify:{identity}"
    assert next_action(current.plan).before_date == date(2026, 9, 19)
    assert str(date(2026, 9, 19)) in next_action(current.plan).question
    assert [
        u.id for u in current.plan.decision_assessment.uncertainties if u.record_ids == ["work"]
    ] == [identity]
    current = await store.command("owner", response_command(current, "unavailable"))
    assert next_action(current.plan).id == "review"
    assert current.plan.events == baseline.plan.events
    source = facts_input(current.facts).model_dump(mode="json", by_alias=True)
    source["records"][0]["schedule"]["amounts"][1] = (
        money("100") if field == "amount" else foreign()
    )
    current = await store.command("owner", parsed_command(source, current.revision))
    assert next_action(current.plan).id == f"clarify:{identity}"
    assert next_action(current.plan).before_date == date(2026, 9, 26)
    assert "2026-09-26" in next_action(current.plan).question
    assert len([u for u in current.plan.decision_assessment.uncertainties if u.id == identity]) == 1
    assert (
        facts_input(current.facts).records[0].schedule.amounts[2:]
        == facts_input(baseline.facts).records[0].schedule.amounts[2:]
    )
    assert [
        e.model_dump(exclude={"balance_paise"})
        for e in current.plan.events
        if e.record_id == "work"
    ][2:] == [
        e.model_dump(exclude={"balance_paise"})
        for e in baseline.plan.events
        if e.record_id == "work"
    ][2:]
    receipt = next(
        e for e in current.plan.events if e.record_id == "work" and e.schedule_index == 1
    )
    assert current.plan.closing_paise == baseline.plan.closing_paise + receipt.amount_paise
    assert current.preview is current.accepted is None


async def test_later_missing_occurrence_precedes_a_later_purchase_cut(store):
    """Ask the next dated missing amount after deferral before offering a still later reduction."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "100",
                [
                    record(
                        "food",
                        "essential",
                        None,
                        None,
                        schedule={
                            "date": "2026-09-12",
                            "recurrence": "weekly",
                            "amounts": [money("100"), money(None, "unknown")],
                        },
                    )
                    | {"amount": money(None, "unknown")},
                    record("loan", "debt", "500", "2026-09-14"),
                    record("purchase", "optional", "1000", "2026-09-20"),
                    record("rent", "essential", "1000", "2026-09-22"),
                ],
            )
        ),
    )
    assert next_action(baseline.plan).id == "contact:loan:2026-09-14"
    current = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(current.plan).id == "clarify:food:amount"
    assert next_action(current.plan).before_date == date(2026, 9, 19)
    current = await store.command("owner", response_command(current, "unavailable"))
    assert next_action(current.plan).id == "contact:food:2026-09-19"
    current = await store.command("owner", response_command(current, "unavailable"))
    assert next_action(current.plan).id == "preview:purchase:2026-09-20"
    assert current.plan.events == baseline.plan.events
    assert current.preview is current.accepted is None
