# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from copy import deepcopy
from datetime import date, timedelta
from uuid import uuid4

import pytest

from app.finance import calculate, export_text, normalize
from app.models import FactsInput
from app.voice_tools import VoiceTools, canonical

from .conftest import NOW, command, facts, money, parsed_command, record
from .test_decisions import september
from .test_finance import project
from .test_scenarios import initialize


def next_action(plan):
    """Find the assessment action selected as the plan's next step."""
    assessment = plan.decision_assessment
    return next(item for item in assessment.actions if item.id == assessment.next_action_id)


@pytest.mark.parametrize("kind", ["optional", "card"])
def test_effective_change_is_the_next_consent_based_action(kind):
    """Verify an effective purchase or card adjustment becomes the next consent-based preview."""
    item = (
        record("purchase", "optional", "200", "2026-09-12")
        if kind == "optional"
        else record("card", "debt", "500", "2026-09-12", debtType="card", target=money("2000"))
    )
    plan = project(facts("100" if kind == "optional" else "1000", [item]))
    action = next_action(plan)
    assert action.kind == "previewChange"
    choice = next(c for c in plan.decision_assessment.choices if c.id == action.choice_id)
    assert choice.metrics.first_gap is None
    assert choice.adjustment_amounts[0].amount_paise == (0 if kind == "optional" else 50000)
    assert plan.first_gap is not None
    assert plan.decision_assessment.next_question_id is None
    assert "consent" in action.question and "2026-09-12" in action.question
    if kind == "card":
        assert "minimum is not payoff" in action.question


def test_effective_unknown_control_precedes_provider_and_coverage():
    """Verify useful controllability clarification precedes provider and coverage questions."""
    data = facts(
        "100",
        [
            record("purchase", "optional", "200", "2026-09-12", controllability="unknown"),
            record("rent", "essential", "300", "2026-09-13"),
        ],
    )
    data["coverage"]["income"] = "notDiscussed"
    plan = project(data)
    assert plan.decision_assessment.next_question_id == "purchase:controllability"
    assert next_action(plan).kind == "clarify"


def test_partial_early_change_names_residual_not_full_solution():
    """Verify partial early relief names the residual shortfall without claiming resolution."""
    plan = project(
        facts(
            "100",
            [
                record("purchase", "optional", "100", "2026-09-12"),
                record("rent", "essential", "300", "2026-09-12"),
            ],
        )
    )
    assert next_action(plan).kind == "previewChange"
    assert "INR 200.00" in next_action(plan).question
    assert "unfunded" in next_action(plan).question
    assert plan.first_gap.amount_paise == 30000


def test_later_uncertain_salary_does_not_displace_unfunded_rent():
    """Verify later uncertain income does not displace an earlier unfunded rent decision."""
    data = september()
    data["records"][3]["reliability"] = "uncertain"
    plan = project(data)
    assert plan.decision_assessment.next_question_id == "provider:rent:2026-09-14"
    uncertainty = next(
        u for u in plan.decision_assessment.uncertainties if u.id == "salary:receipt"
    )
    assert "immediateDecision" not in uncertainty.blocks
    assert "earlier" in uncertainty.reason
    assert "How certain" not in uncertainty.question


def test_minimum_shortfall_precedes_unknown_intended_extra():
    """Verify a required card minimum shortfall takes priority over an unknown intended extra."""
    plan = project(
        facts(
            "100",
            [
                record(
                    "card",
                    "debt",
                    "500",
                    "2026-09-12",
                    debtType="card",
                    target=money(None, "unknown"),
                )
            ],
        )
    )
    assert plan.decision_assessment.next_question_id == "provider:card:2026-09-12"
    assert "INR 400.00" in next_action(plan).question
    assert (
        "immediateDecision"
        not in next(u for u in plan.decision_assessment.uncertainties if u.field == "target").blocks
    )


@pytest.mark.parametrize("status,kind", [("declined", "seekSupport"), ("awaiting", "followUp")])
def test_terminal_provider_state_has_a_bounded_action(status, kind):
    """Verify provider responses yield bounded follow-up or support actions with the real gap."""
    data = facts("0", [record("rent", "essential", "1000", "2026-09-14", label="Rent")])
    data["providerResponses"] = [
        {"eventId": "rent:2026-09-14", "status": status, "reportedOn": "2026-09-11"}
    ]
    plan = project(data)
    action = next_action(plan)
    assert action.kind == kind
    assert action.before_date == date(2026, 9, 14)
    assert "INR 1000.00" in action.question and "unfunded" in action.question
    assert plan.first_gap.amount_paise == 100000
    assert plan.decision_assessment.next_question_id is None
    if status == "declined":
        assert "without a chosen change" in action.question
        assert "hardship" in action.question or "qualified" in action.question


def test_same_day_action_is_semantically_invariant_to_identifiers():
    """Verify swapping record identifiers leaves same-day group guidance unchanged."""
    items = [
        record("a", "essential", "300", "2026-09-12", label="Food"),
        record("z", "debt", "400", "2026-09-12", label="EMI", autoDebit=True),
    ]
    before = next_action(project(facts("500", items)))
    items[0]["id"], items[1]["id"] = "z", "a"
    after = next_action(project(facts("500", items)))
    assert before.kind == after.kind == "resolveGroup"
    assert before.question == after.question
    for text in ("Food", "EMI", "INR 200.00", "essential", "auto-debit", "allocation"):
        assert text in before.question


def test_separate_same_name_obligations_do_not_repeat_duplicate_question():
    """Verify same-name obligations on separate dates do not trigger duplicate questions."""
    plan = project(
        facts(
            "10000",
            [
                record("home", "essential", "1000", "2026-09-14", label="Rent"),
                record("office", "essential", "1000", "2026-10-01", label="Rent"),
            ],
        )
    )
    assert plan.outflow_paise == 200000
    assert not any(
        u.id.endswith("possibleDuplicate") for u in plan.decision_assessment.uncertainties
    )
    assert plan.decision_assessment.next_question_id is None


def test_estimate_with_headroom_qualifies_without_exactness_gate():
    """Verify affordable estimates qualify the outcome without blocking on exact amounts."""
    data = facts("10000", [record("food", "essential", "100", "2026-09-12")])
    data["records"][0]["amount"]["status"] = "estimate"
    plan = project(data)
    assert plan.decision_assessment.next_question_id is None
    assert next_action(plan).kind == "reviewOutcome"
    assert plan.decision_assessment.outcome.readiness == "qualified"
    assert "estimate" in plan.decision_assessment.outcome.conditions.lower()


def test_unknown_income_receipt_changes_relevant_deadline_but_uncertain_is_not_reasked():
    """Verify unknown receipts need clarification; uncertain ones get confirmation actions."""
    data = facts(
        "0",
        [
            record("salary", "income", "1000", "2026-09-12", reliability="unknown"),
            record("rent", "essential", "800", "2026-09-14"),
        ],
    )
    assert project(data).decision_assessment.next_question_id == "salary:receipt"
    data["records"][0]["reliability"] = "uncertain"
    plan = project(data)
    assert plan.decision_assessment.next_question_id != "salary:receipt"
    assert any(
        a.kind == "confirmReceipt" and a.before_date == date(2026, 9, 14)
        for a in plan.decision_assessment.actions
    )


async def test_clock_rollover_removes_fresh_choices_without_rebasing_cash(store, config):
    """Verify day rollover retires fresh choices without rebasing cash or the original gap."""
    await store.create("owner")
    data = facts("100", [record("purchase", "optional", "200", "2026-09-11")])
    saved = await store.command("owner", parsed_command(data))
    assert next_action(saved.plan).kind == "previewChange"
    store.clock = lambda: NOW + timedelta(hours=18)
    current = await store.get("owner")
    assert (
        current.anchor_date == saved.anchor_date and current.plan.first_gap == saved.plan.first_gap
    )
    assert not current.plan.decision_assessment.choices
    assert not any(
        u.field == "controllability" for u in current.plan.decision_assessment.uncertainties
    )
    pure = calculate(
        normalize(FactsInput.model_validate(data), config),
        saved.anchor_date,
        config,
        today=date(2026, 9, 12),
    )
    assert pure == current.plan
    data["opening"] = money("150")
    edited = await store.command("owner", parsed_command(data, 1))
    assert not edited.plan.decision_assessment.choices


async def test_voice_correction_and_explicit_provider_report_are_one_fresh_fact(store):
    """Verify a voice correction retains its explicitly supplied fresh provider response."""
    await store.create("owner")
    data = september()
    data["providerResponses"] = [
        {"eventId": "rent:2026-09-14", "status": "awaiting", "reportedOn": "2026-09-11"}
    ]
    await store.command("owner", parsed_command(data))
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 1,
            "records": [{"id": "rent", "amount": money("8500")}],
            "providerResponses": [
                {"eventId": "rent:2026-09-14", "status": "declined", "reportedOn": "2026-09-11"}
            ],
        },
        "correction-and-report",
    )
    assert result["snapshot"]["facts"]["providerResponses"][0]["status"] == "declined"
    assert result["activePlan"]["firstGap"]["amountPaise"] == 650000
    assert result["activeAssessment"]["nextQuestionId"] != "provider:rent:2026-09-14"


@pytest.mark.parametrize("fresh", [False, True])
def test_manual_report_freshness_and_visible_stale_invalidation(client, fresh):
    """Verify manual corrections retain fresh provider reports and visibly invalidate stale ones."""
    data = september()
    data["providerResponses"] = [
        {"eventId": "rent:2026-09-14", "status": "awaiting", "reportedOn": "2026-09-11"}
    ]
    initialize(client, data)
    data = deepcopy(data)
    data["records"][1]["amount"] = money("8500")
    if fresh:
        data["providerResponses"][0]["status"] = "declined"
    response = client.post("/api/session/commands", json=command(data, 1))
    assert response.status_code == 200
    snapshot = response.json()
    if fresh:
        assert snapshot["facts"]["providerResponses"][0]["status"] == "declined"
    else:
        assert snapshot["facts"]["providerResponses"] == []
        assert any(
            "provider" in item["reason"].lower() for item in snapshot["invalidatedAssumptions"]
        )


async def test_compact_outcome_export_and_spoken_preference_share_one_next_step(store):
    """Verify compact outcomes, exports, and brief speech share the same next step."""
    await store.create("owner")
    data = september()
    data["records"].extend(
        record(f"cost{i}", "essential", "100", f"2026-09-{day:02}")
        for i, day in enumerate(range(22, 30))
    )
    snapshot = await store.command("owner", parsed_command(data))
    outcome = snapshot.plan.decision_assessment.outcome
    for value in (
        outcome.summary,
        outcome.covered,
        outcome.not_covered,
        outcome.next_step,
        outcome.conditions,
    ):
        assert value and len(value) < 1200
    assert len(outcome.true_now) <= 5
    assert "2026-09-14" in outcome.summary and "6000.00" in outcome.summary
    assert "2026-09-18" in outcome.summary and "12000.00" in outcome.summary
    standard = canonical(snapshot)["spokenBrief"]
    data["decision"] = {"responsePreference": "brief"}
    brief = await store.command("owner", parsed_command(data, 1))
    spoken = canonical(brief)["spokenBrief"]
    assert len(spoken) < len(standard)
    assert outcome.summary in spoken and outcome.next_step in spoken
    assert len(spoken) < 2400
    intro = export_text(brief).split("Supporting report:")[0]
    assert outcome.next_step in intro
    assert intro.count("What flexibility") <= 2
    assert len(intro) < 4000


def test_ready_first_gap_solution_precedes_smaller_cut_or_unknown_control():
    """Verify a ready first-gap solution outranks smaller cuts and unknown controllability."""
    data = facts(
        "100",
        [
            record("small", "optional", "100", "2026-09-12", label="A small purchase"),
            record("large", "optional", "500", "2026-09-12", label="Z large purchase"),
        ],
    )
    action = next_action(project(data))
    assert action.choice_id == "reduce:large:2026-09-12"
    data["records"][0]["controllability"] = "unknown"
    assert next_action(project(data)).choice_id == "reduce:large:2026-09-12"


async def test_voice_explicit_same_status_on_corrected_terms_is_fresh_but_omission_is_not(store):
    """Verify explicit provider reconfirmation survives voice edits; omitted reports expire."""
    await store.create("owner")
    data = september()
    data["providerResponses"] = [
        {"eventId": "rent:2026-09-14", "status": "declined", "reportedOn": "2026-09-11"}
    ]
    await store.command("owner", parsed_command(data))
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 1,
            "records": [{"id": "rent", "amount": money("8500")}],
            "providerResponses": data["providerResponses"],
        },
        "explicit-reconfirmation",
    )
    assert result["snapshot"]["facts"]["providerResponses"][0]["status"] == "declined"
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 2,
            "records": [{"id": "rent", "amount": money("9000")}],
        },
        "correction-only",
    )
    assert result["snapshot"]["facts"]["providerResponses"] == []
    assert result["snapshot"]["invalidatedAssumptions"]


def test_no_past_controllability_question_after_midnight(config):
    """Verify elapsed purchases need status reconciliation, not controllability questions."""
    data = facts(
        "100", [record("purchase", "optional", "200", "2026-09-11", controllability="unknown")]
    )
    normalized = normalize(FactsInput.model_validate(data), config)
    assert calculate(normalized, date(2026, 9, 11), config).decision_assessment.next_question_id
    plan = calculate(normalized, date(2026, 9, 11), config, today=date(2026, 9, 12))
    assert plan.decision_assessment.next_question_id is None
    assert next_action(plan).kind == "reconcileStatus"


async def test_linked_card_action_executes_real_preview_and_requires_explicit_acceptance(store):
    """Verify linked card previews require explicit acceptance and preserve the recorded target."""
    await store.create("owner")
    data = facts(
        "1000", [record("card", "debt", "500", "2026-09-12", debtType="card", target=money("2000"))]
    )
    saved = await store.command("owner", parsed_command(data))
    action = next_action(saved.plan)
    choice = next(c for c in saved.plan.decision_assessment.choices if c.id == action.choice_id)
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "preview_adjustments",
        {
            "expectedRevision": 1,
            "adjustments": [
                {"eventId": item.event_id, "amount": f"{item.amount_paise // 100}.00"}
                for item in choice.adjustment_amounts
            ],
        },
        "preview-choice",
    )
    assert result["snapshot"]["accepted"] is None
    assert result["activePlan"]["firstGap"]["amountPaise"] == 100000
    assert result["snapshot"]["preview"]["plan"]["firstGap"] is None
    result = await tools.invoke(
        "accept_preview",
        {
            "expectedRevision": 1,
            "previewId": result["snapshot"]["preview"]["id"],
            "confirmed": True,
            "consentScope": "unconditional",
        },
        "confirm-choice",
    )
    assert result["activePlan"]["closingPaise"] == 50000
    assert result["snapshot"]["facts"]["records"][0]["target"]["amountPaise"] == 200000
