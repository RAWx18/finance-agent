# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
import sqlite3
from copy import deepcopy
from datetime import timedelta
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.facts import facts_input
from app.finance import calculate
from app.models import Command, Decision
from app.store import Problem
from app.voice_tools import VoiceTools, canonical, tool_parameters

from .conftest import NOW, command, facts, money, parsed_command, record
from .test_decision_priorities import next_action
from .test_scenarios import initialize, operation


def response_command(snapshot, response, action_id=None):
    """Build an action response against the active accepted or baseline assessment."""
    plan = snapshot.accepted.plan if snapshot.accepted else snapshot.plan
    return Command.model_validate(
        operation(
            "respondToAction",
            snapshot.revision,
            actionId=action_id or next_action(plan).id,
            response=response,
        )
    )


@pytest.fixture
async def reduction(store):
    """Provide a saved cash-gap scenario with optional spending cuts and a committed rent due."""
    await store.create("owner")
    return await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record("purchase", "optional", "800", "2026-09-12"),
                    record("rent", "essential", "500", "2026-09-14", controllability="committed"),
                    record("trip", "optional", "100", "2026-09-20"),
                ],
            )
        ),
    )


async def test_voice_unavailable_moves_on_without_resolving_unknowns(store):
    """Verify unavailable voice answers advance questions while retaining financial unknowns."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record("rent", "essential", "2000", None),
                    {
                        **record("bill", "essential", "100", "2026-09-12"),
                        "amount": money(None, "unknown"),
                    },
                ],
            )
        ),
    )
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "respond_to_action",
        {
            "expectedRevision": 1,
            "actionId": next_action(baseline.plan).id,
            "response": "unavailable",
        },
        "date-unavailable",
    )
    assert "code" not in result
    assert result["currentAction"]["id"] == "clarify:bill:amount"
    assert result["activeAssessment"]["nextQuestionId"] == "bill:amount"
    assert len(result["actionResponses"]) == 1
    result = await tools.invoke(
        "respond_to_action",
        {
            "expectedRevision": 2,
            "actionId": result["currentAction"]["id"],
            "response": "unavailable",
        },
        "amount-unavailable",
    )
    assert "code" not in result
    current = await store.get("owner")
    assert current.facts.records == baseline.facts.records
    assert current.facts.coverage == baseline.facts.coverage
    assert current.plan.events == baseline.plan.events
    assert current.plan.budget_basis == baseline.plan.budget_basis
    assert not current.plan.budget_basis.dated_projection_complete
    assert current.plan.decision_assessment.next_question_id is None
    assert next_action(current.plan).kind == "reviewOutcome"
    assert current.plan.decision_assessment.outcome.branch == "uncertain"
    assert "fit" not in result["outcome"]["summary"].lower()
    assert "unavailable" in result["spokenBrief"].lower()
    assert len(result["spokenBrief"]) < 2400
    assert {item.id for item in current.plan.decision_assessment.uncertainties} == {
        "rent:schedule.date",
        "bill:amount",
    }
    assert len(current.facts.decision.responses) == 2
    assert (current.revision, current.sequence) == (3, 3)
    assert current.plan == calculate(current.facts, current.anchor_date, store.config)


async def test_unavailable_opening_and_scope_never_confirm_cash_or_completeness(store):
    """Verify unavailable cash and coverage answers leave the outcome qualified and incomplete."""
    snapshot = await store.create("owner")
    assert next_action(snapshot.plan).id == "clarify:opening"
    snapshot = await store.command("owner", response_command(snapshot, "unavailable"))
    assert next_action(snapshot.plan).id == "clarify:income"
    snapshot = await store.command("owner", response_command(snapshot, "unavailable"))
    assert next_action(snapshot.plan).id == "clarify:coverage"
    snapshot = await store.command("owner", response_command(snapshot, "unavailable"))
    assert [response.action_id for response in snapshot.facts.decision.responses] == [
        "clarify:opening",
        "clarify:income",
        "clarify:coverage",
    ]
    assert snapshot.facts.opening.amount_paise is None
    assert set(snapshot.facts.coverage.model_dump().values()) == {"notDiscussed"}
    assert snapshot.facts.records == []
    assert snapshot.plan.closing_paise is None
    assert next_action(snapshot.plan).kind == "reviewOutcome"
    assert snapshot.plan.decision_assessment.next_question_id is None
    assert snapshot.plan.decision_assessment.outcome.readiness == "qualified"
    assert "fit" not in canonical(snapshot)["spokenBrief"].lower()


@pytest.mark.parametrize("kind", ["confirmReceipt", "verifyTerms"])
async def test_unavailable_supported_followup_keeps_its_financial_risk(store, kind):
    """Verify unavailable receipt or terms follow-ups retain their underlying financial risks."""
    await store.create("owner")
    data = (
        facts(
            "2000",
            [
                record("salary", "income", "500", "2026-09-12", reliability="uncertain"),
                record("rent", "essential", "1000", "2026-09-14"),
            ],
        )
        if kind == "confirmReceipt"
        else facts(
            "1000",
            [record("rent", "essential", "2000", "2026-09-14")],
            providerResponses=[
                {
                    "eventId": "rent:2026-09-14",
                    "status": "reportedTerms",
                    "reportedOn": "2026-09-11",
                    "payment": money("500"),
                    "paymentDate": "2026-09-21",
                    "cost": money(None, "unknown"),
                }
            ],
        )
    )
    baseline = await store.command("owner", parsed_command(data))
    assert next_action(baseline.plan).kind == kind
    result = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(result.plan).kind == "reviewOutcome"
    assert result.plan.decision_assessment.next_question_id is None
    assert result.facts.model_dump(exclude={"decision"}) == baseline.facts.model_dump(
        exclude={"decision"}
    )
    assert result.plan.events == baseline.plan.events
    assert result.plan.income_comparisons == baseline.plan.income_comparisons
    assert result.plan.decision_assessment.outcome.readiness == "qualified"
    assert [
        item.model_dump(exclude={"blocks", "priority"})
        for item in result.plan.decision_assessment.uncertainties
    ] == [
        item.model_dump(exclude={"blocks", "priority"})
        for item in baseline.plan.decision_assessment.uncertainties
    ]
    assert all("fullPlan" in item.blocks for item in result.plan.decision_assessment.uncertainties)
    if kind == "verifyTerms":
        assert result.plan.first_gap.amount_paise == 100000
        assert result.plan.decision_assessment.outcome.branch == "gap"
        assert "unfunded" in canonical(result)["spokenBrief"]
    else:
        assert result.plan.reliable_income_paise == 0
        assert result.facts.records[0].reliability == "uncertain"


async def test_decline_selects_contact_without_changing_money_or_controllability(store, reduction):
    """Verify declining a spending cut selects payee contact without altering financial facts."""
    assert next_action(reduction.plan).id == "preview:purchase:2026-09-12"
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    arguments = {
        "expectedRevision": 1,
        "actionId": next_action(reduction.plan).id,
        "response": "declined",
    }
    result = await tools.invoke("respond_to_action", arguments, "no-cut")
    assert "code" not in result
    current = await store.get("owner")
    assert current.facts.model_dump(exclude={"decision"}) == reduction.facts.model_dump(
        exclude={"decision"}
    )
    assert current.plan.events == reduction.plan.events
    assert current.plan.first_gap.amount_paise == 30000
    assert next_action(current.plan).kind == "contactPayee"
    assert next_action(current.plan).record_ids == ["rent"]
    assert all(
        action.id != arguments["actionId"] for action in current.plan.decision_assessment.actions
    )
    assert any(
        option.event_id == "purchase:2026-09-12"
        for option in (await store.options("owner")).options
    )
    response = result["actionResponses"][0]
    assert set(response) == {"actionId", "response", "dependencyKey"}
    assert response["actionId"] == arguments["actionId"] and response["response"] == "declined"
    assert len(response["dependencyKey"]) == 64
    assert current.facts.records[0].controllability == "controllable"
    assert result["currentAction"]["question"] == result["outcome"]["nextStep"]
    assert "declined reductions" in result["spokenBrief"].lower()
    assert tools.written_sequence == current.sequence == current.revision == 2
    assert await tools.invoke("respond_to_action", arguments, "no-cut") == result


async def test_declined_card_minimum_reviews_target_shortfall_without_changing_obligations(store):
    """Verify declining a card minimum comparison reviews the unchanged intended-payment gap."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record(
                        "card", "debt", "500", "2026-09-12", debtType="card", target=money("2000")
                    )
                ],
            )
        ),
    )
    assert next_action(baseline.plan).kind == "previewChange"
    choice = next(
        item
        for item in baseline.plan.decision_assessment.choices
        if item.id == next_action(baseline.plan).choice_id
    )
    assert choice.kind == "cardMinimum"
    assert choice.metrics.first_gap is None and choice.metrics.trough_paise == 50000
    current = await store.command("owner", response_command(baseline, "declined"))
    action = next_action(current.plan)
    assert action.kind == "reviewOutcome"
    assert "INR 1000.00" in action.question and "shortfall" in action.question
    assert "intended payment of INR 2000.00" in action.question
    assert "required minimum of INR 500.00" in action.question
    assert "minimum fits" in action.question and "comparison" in action.question
    assert "declined" in action.question and "unchanged" in action.question
    assert "No payment or agreement is assumed" in action.question
    assert action.choice_id is None
    assert current.plan.first_gap == baseline.plan.first_gap
    assert current.plan.first_gap.amount_paise == current.plan.peak_gap_paise == 100000
    assert current.plan.events == baseline.plan.events
    assert current.plan.decision_assessment.constraints == (
        baseline.plan.decision_assessment.constraints
    )
    assert current.facts.model_dump(exclude={"decision"}) == baseline.facts.model_dump(
        exclude={"decision"}
    )
    assert current.facts.records[0].amount.amount_paise == 50000
    assert current.facts.records[0].target.amount_paise == 200000
    assert current.preview is None and current.accepted is None
    assert len(current.facts.decision.responses) == 1
    assert current.facts.decision.responses[0].action_id == next_action(baseline.plan).id
    assert current.facts.decision.responses[0].response == "declined"
    assert not current.plan.decision_assessment.choices
    assert not any(
        item.kind in {"previewChange", "contactPayee", "verifyTerms", "seekSupport", "resolveGroup"}
        for item in current.plan.decision_assessment.actions
    )
    assert not any(
        item.field == "providerResponses" for item in current.plan.decision_assessment.uncertainties
    )
    result = canonical(current)
    assert result["currentAction"]["question"] == result["outcome"]["nextStep"] == action.question
    assert action.question in result["spokenBrief"]
    assert await store.get("owner") == current


@pytest.mark.parametrize(
    "cash,items,identity,residual",
    [
        pytest.param("100", [], "contact:card:2026-09-12", 40000, id="requiredMinimum"),
        pytest.param(
            "1000",
            [record("rent", "essential", "600", "2026-09-12")],
            "group:2026-09-12",
            10000,
            id="compoundDues",
        ),
        pytest.param(
            "1000",
            [record("rent", "essential", "1000", "2026-09-14")],
            "contact:rent:2026-09-14",
            50000,
            id="laterRequiredDue",
        ),
    ],
)
async def test_declined_card_cut_preserves_required_shortfall_action(
    store, cash, items, identity, residual
):
    """Verify declining a card cut retains the action addressing required-payment shortfalls."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                cash,
                [
                    record(
                        "card", "debt", "500", "2026-09-12", debtType="card", target=money("2000")
                    ),
                    *items,
                ],
            )
        ),
    )
    assert next_action(baseline.plan).id == "preview:card:2026-09-12"
    choice = next(
        item
        for item in baseline.plan.decision_assessment.choices
        if item.id == next_action(baseline.plan).choice_id
    )
    assert choice.metrics.first_gap.amount_paise == residual
    expected = next(
        item for item in baseline.plan.decision_assessment.actions if item.id == identity
    )
    current = await store.command("owner", response_command(baseline, "declined"))
    assert next_action(current.plan) == expected
    assert current.plan.first_gap == baseline.plan.first_gap
    assert current.plan.events == baseline.plan.events
    assert current.facts.records == baseline.facts.records
    assert current.facts.provider_responses == baseline.facts.provider_responses == []
    assert current.facts.decision.responses[0].response == "declined"
    assert current.preview is None and current.accepted is None
    assert not any(item.kind == "cardMinimum" for item in current.plan.decision_assessment.choices)


@pytest.mark.parametrize(
    "opening,items,clarification",
    [
        pytest.param(money("1000", "estimate"), [], None, id="estimatedCash"),
        pytest.param(
            money("1000"),
            [record("bill", "essential", "100", None)],
            "clarify:bill:schedule.date",
            id="unknownDate",
        ),
        pytest.param(
            money("1000"),
            [
                {
                    **record("bill", "essential", "100", "2026-09-12"),
                    "amount": money(None, "unknown"),
                }
            ],
            "clarify:bill:amount",
            id="unknownAmount",
        ),
        pytest.param(
            money("1000"),
            [
                {
                    **record("bill", "essential", "100", "2026-09-12"),
                    "amount": money("100", "estimate"),
                }
            ],
            None,
            id="estimatedDue",
        ),
        pytest.param(
            money("1000"),
            [record("salary", "income", "500", "2026-09-12")],
            None,
            id="partialSameDayReceipt",
        ),
    ],
)
async def test_declined_card_cut_does_not_confirm_funding_with_unresolved_basis(
    store, opening, items, clarification
):
    """Verify declining a card cut cannot imply affordability when funding remains uncertain."""
    await store.create("owner")
    data = facts(
        "1000",
        [
            record("card", "debt", "500", "2026-09-12", debtType="card", target=money("2000")),
            *items,
        ],
    )
    data["opening"] = opening
    baseline = await store.command("owner", parsed_command(data))
    if clarification is not None:
        assert next_action(baseline.plan).id == clarification
        baseline = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(baseline.plan).id == "preview:card:2026-09-12"
    if baseline.plan.timing_risks:
        assert baseline.plan.timing_risks[0].remaining_gap_paise == 50000
    current = await store.command("owner", response_command(baseline, "declined"))
    assert current.plan.decision_assessment.uncertainties
    assert current.plan.decision_assessment.outcome.readiness == "qualified"
    assert not any(
        "minimum fits" in item.question or item.kind == "previewChange"
        for item in current.plan.decision_assessment.actions
    )
    assert current.plan.first_gap == baseline.plan.first_gap
    assert current.plan.events == baseline.plan.events
    assert current.plan.timing_risks == baseline.plan.timing_risks
    assert current.facts.records == baseline.facts.records
    assert current.facts.opening == baseline.facts.opening
    assert current.facts.decision.responses[-1].response == "declined"
    assert current.preview is None and current.accepted is None


async def test_card_timing_deferral_does_not_push_or_apply_a_minimum_cut(store):
    """Verify deferring same-day receipt confirmation reviews risk without offering a card cut."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record(
                        "card", "debt", "500", "2026-09-12", debtType="card", target=money("2000")
                    ),
                    record("salary", "income", "1000", "2026-09-12"),
                ],
            )
        ),
    )
    assert next_action(baseline.plan).id == "clarify:schedule:sameDayTiming:2026-09-12"
    assert next_action(baseline.plan).kind == "confirmReceipt"
    current = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(current.plan).kind == "reviewOutcome"
    assert next_action(current.plan).choice_id is None
    assert "Payment timing is still unconfirmed" in next_action(current.plan).question
    assert current.plan.decision_assessment.next_question_id is None
    assert current.plan.decision_assessment.outcome.readiness == "qualified"
    assert current.plan.events == baseline.plan.events
    assert current.plan.first_gap == baseline.plan.first_gap
    assert current.plan.first_gap.amount_paise == 100000
    assert current.plan.outflow_paise == 200000
    assert current.plan.timing_risks == baseline.plan.timing_risks
    assert current.plan.timing_risks[0].remaining_gap_paise == 0
    assert current.facts.model_dump(exclude={"decision"}) == baseline.facts.model_dump(
        exclude={"decision"}
    )
    assert current.facts.decision.responses[0].action_id == next_action(baseline.plan).id
    assert current.facts.decision.responses[0].response == "unavailable"
    assert len(current.facts.decision.responses) == 1
    assert current.preview is current.accepted is None
    assert not current.workspace.questions
    assert not any(
        "minimum fits" in action.question for action in current.plan.decision_assessment.actions
    )
    assert await store.get("owner") == current


@pytest.mark.parametrize(
    "opening,identity",
    [
        (money("400"), "contact:card:2026-09-12"),
        (money(None, "unknown"), "clarify:opening"),
    ],
)
async def test_declined_card_review_reassesses_corrected_cash_without_reoffering_cut(
    store, opening, identity
):
    """Verify corrected cash reassesses a declined card comparison without offering it again."""
    await store.create("owner")
    data = facts(
        "1000",
        [record("card", "debt", "500", "2026-09-12", debtType="card", target=money("2000"))],
    )
    baseline = await store.command("owner", parsed_command(data))
    declined = await store.command("owner", response_command(baseline, "declined"))
    assert "minimum fits" in next_action(declined.plan).question
    data["opening"] = opening
    current = await store.command("owner", parsed_command(data, declined.revision))
    assert next_action(current.plan).id == identity
    assert current.facts.records == declined.facts.records
    assert current.facts.decision.responses == declined.facts.decision.responses
    assert not any(
        "minimum fits" in item.question or item.kind == "previewChange"
        for item in current.plan.decision_assessment.actions
    )
    assert current.plan == calculate(current.facts, current.anchor_date, store.config)


async def test_declined_only_future_choice_has_qualified_outcome_not_elapsed_cash_question(store):
    """Verify declining the sole future cut reviews the gap without asking about elapsed cash."""
    await store.create("owner")
    baseline = await store.command(
        "owner", parsed_command(facts("100", [record("purchase", "optional", "200", "2026-09-12")]))
    )
    current = await store.command("owner", response_command(baseline, "declined"))
    assert next_action(current.plan).kind == "reviewOutcome"
    assert current.plan.decision_assessment.outcome.branch == "gap"
    assert "elapsed" not in next_action(current.plan).question
    assert current.plan.first_gap == baseline.plan.first_gap


@pytest.mark.parametrize(
    "patch",
    [
        {"opening": money("1100")},
        {"reserve": "100"},
        {"records": [{"id": "purchase", "label": "A renamed purchase"}]},
        {"records": [{"id": "trip", "amount": money("150")}]},
        {"decision": {"responsePreference": "brief", "concern": "Rent first"}},
    ],
)
async def test_decline_survives_unrelated_facts_and_label_edits(store, reduction, patch):
    """Verify unrelated fact, preference, and label edits retain a declined action response."""
    declined = await store.command("owner", response_command(reduction, "declined"))
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke("update_facts", {"expectedRevision": 2, **patch}, "unrelated")
    assert "code" not in result
    current = await store.get("owner")
    assert current.facts.decision.responses == declined.facts.decision.responses
    assert next_action(current.plan).id != next_action(reduction.plan).id


@pytest.mark.parametrize(
    "patch",
    [
        {"amount": money("700")},
        {"schedule": {"date": "2026-09-13"}},
        {"controllability": "unknown"},
        {"kind": "essential"},
        {"delete": True},
    ],
)
async def test_relevant_choice_correction_reconsiders_only_matching_response(
    store, reduction, patch
):
    """Verify correcting a declined choice's dependencies clears its response for reassessment."""
    await store.command("owner", response_command(reduction, "declined"))
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts", {"expectedRevision": 2, "records": [{"id": "purchase", **patch}]}, "correct"
    )
    assert "code" not in result
    current = await store.get("owner")
    assert current.facts.decision.responses == []
    if "amount" in patch or "schedule" in patch:
        assert next_action(current.plan).kind == "previewChange"
    if "controllability" in patch:
        assert current.plan.decision_assessment.next_question_id == "purchase:controllability"


async def test_unavailable_record_response_survives_unrelated_cash_then_corrects(store):
    """Verify deferred income confirmation survives cash edits but clears on reliability edits."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record("salary", "income", "1000", "2026-09-12", reliability="unknown"),
                    record("rent", "essential", "2000", "2026-09-14", controllability="committed"),
                ],
            )
        ),
    )
    assert next_action(baseline.plan).id == "clarify:salary:receipt"
    unavailable = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(unavailable.plan).kind == "contactPayee"
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts", {"expectedRevision": 2, "opening": money("1200")}, "cash"
    )
    assert result["actionResponses"] == canonical(unavailable)["actionResponses"]
    result = await tools.invoke(
        "update_facts",
        {"expectedRevision": 3, "records": [{"id": "salary", "reliability": "reliable"}]},
        "receipt-correction",
    )
    assert "code" not in result and result["actionResponses"] == []
    assert result["activePlan"]["firstGap"] is None
    assert result["activePlan"]["reliableIncomePaise"] == 100000


async def test_preference_survives_temporary_headroom_and_manual_conversion(store, reduction):
    """Verify a declined cut survives manual round-trips, temporary headroom, and store restart."""
    declined = await store.command("owner", response_command(reduction, "declined"))
    manual = facts_input(declined.facts)
    assert manual.decision.responses == declined.facts.decision.responses
    data = manual.model_dump(mode="json", by_alias=True)
    del data["decision"]["responses"]
    data["opening"] = money("5000")
    headroom = await store.command("owner", parsed_command(data, 2))
    assert headroom.facts.decision.responses == declined.facts.decision.responses
    assert next_action(headroom.plan).kind == "reviewOutcome"
    data["opening"] = money("1000")
    returned = await store.command("owner", parsed_command(data, 3))
    assert returned.facts.decision.responses == declined.facts.decision.responses
    assert next_action(returned.plan).kind == "contactPayee"
    await store.close()
    await store.open()
    assert await store.get("owner") == returned


async def test_decline_clears_matching_preview_but_discard_does_not_decline(store, reduction):
    """Verify declining clears the matching preview while discarding alone records no refusal."""
    request = Command.model_validate(
        operation(
            "previewAdjustments", adjustments=[{"eventId": "purchase:2026-09-12", "amount": "0"}]
        )
    )
    preview = await store.command("owner", request)
    discarded = await store.command(
        "owner",
        Command.model_validate(operation("discardPreview", previewId=str(preview.preview.id))),
    )
    assert discarded.facts.decision.responses == []
    assert next_action(discarded.plan).id == next_action(reduction.plan).id
    preview = await store.command(
        "owner",
        Command.model_validate(
            operation(
                "previewAdjustments",
                adjustments=[{"eventId": "purchase:2026-09-12", "amount": "0"}],
            )
        ),
    )
    declined = await store.command("owner", response_command(preview, "declined"))
    assert declined.preview is None
    assert declined.revision == 2 and declined.sequence == 5
    with pytest.raises(Problem) as error:
        await store.command(
            "owner",
            Command.model_validate(
                operation("acceptPreview", 2, previewId=str(preview.preview.id))
            ),
        )
    assert error.value.body.code == "stalePreview"
    assert await store.command("owner", request) != declined
    assert await store.get("owner") == declined


@pytest.mark.parametrize(
    "adjustments",
    [
        [{"eventId": "purchase:2026-09-12", "amount": "500"}],
        [
            {"eventId": "purchase:2026-09-12", "amount": "0"},
            {"eventId": "trip:2026-09-20", "amount": "0"},
        ],
    ],
)
async def test_decline_rejects_overlapping_incompatible_pending_proposal(
    store, reduction, adjustments
):
    """Verify a decline cannot overwrite an overlapping incompatible pending preview."""
    preview = await store.command(
        "owner", Command.model_validate(operation("previewAdjustments", adjustments=adjustments))
    )
    with pytest.raises(Problem) as error:
        await store.command("owner", response_command(preview, "declined"))
    assert error.value.body.code == "stalePreview"
    assert await store.get("owner") == preview


async def test_decline_preserves_accepted_assumptions_and_unrelated_pending_preview(
    store, reduction
):
    """Verify declining a cut preserves accepted assumptions and an unrelated pending preview."""
    preview = await store.command(
        "owner",
        Command.model_validate(
            operation(
                "previewAdjustments", adjustments=[{"eventId": "trip:2026-09-20", "amount": "0"}]
            )
        ),
    )
    accepted = await store.command(
        "owner",
        Command.model_validate(operation("acceptPreview", previewId=str(preview.preview.id))),
    )
    pending = await store.command(
        "owner",
        Command.model_validate(
            operation(
                "previewAdjustments",
                2,
                adjustments=[{"eventId": "trip:2026-09-20", "amount": "50"}],
            )
        ),
    )
    result = await store.command("owner", response_command(pending, "declined"))
    assert result.accepted.model_dump(exclude={"plan"}) == accepted.accepted.model_dump(
        exclude={"plan"}
    )
    assert result.accepted.plan.events == accepted.accepted.plan.events
    assert result.accepted.plan.first_gap == accepted.accepted.plan.first_gap
    assert next_action(result.accepted.plan).kind == "contactPayee"
    assert result.preview.id == pending.preview.id
    assert result.preview.adjustments == pending.preview.adjustments
    assert result.preview.plan.events == pending.preview.plan.events
    assert result.preview.source_revision == result.revision == 3
    assert result.invalidated_assumptions == []
    accepted = await store.command(
        "owner",
        Command.model_validate(operation("acceptPreview", 3, previewId=str(result.preview.id))),
    )
    assert accepted.accepted.adjustments[0].amount_paise == 5000
    assert accepted.facts.decision.responses == result.facts.decision.responses


@pytest.mark.parametrize(
    "identity,response",
    [
        ("unknown", "declined"),
        ("contact:rent:2026-09-14", "declined"),
        ("preview:purchase:2026-09-12", "unavailable"),
    ],
)
async def test_action_response_requires_current_typed_action(store, reduction, identity, response):
    """Verify unknown action IDs and incompatible responses fail without changing state."""
    with pytest.raises(Problem) as error:
        await store.command("owner", response_command(reduction, response, identity))
    assert error.value.body.code == "invalidActionResponse"
    assert await store.get("owner") == reduction


@pytest.mark.parametrize(
    "identity,response",
    [
        ("contact:rent:2026-09-14", "unavailable"),
        ("preview:trip:2026-09-20", "declined"),
    ],
)
async def test_nonselected_displayable_action_accepts_eligible_response(
    store, reduction, identity, response
):
    """Verify eligible responses can dismiss displayed actions that are not selected next."""
    assert identity != reduction.plan.decision_assessment.next_action_id
    assert identity in {item.id for item in reduction.workspace.actions}
    saved = await store.command("owner", response_command(reduction, response, identity))
    assert any(
        item.action_id == identity and item.response == response
        for item in saved.facts.decision.responses
    )
    assert saved.facts.records == reduction.facts.records
    assert identity not in {item.id for item in saved.workspace.actions}


@pytest.mark.parametrize(
    "fields",
    [
        {"response": "accepted"},
        {"actionId": None},
        {"response": None},
        {"dependencyKey": "a" * 64},
        {"expectedRevision": True},
    ],
)
async def test_voice_response_rejects_invalid_or_client_chosen_fields(store, reduction, fields):
    """Verify voice responses reject invalid values and client-supplied dependency keys."""
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "respond_to_action",
        {
            "expectedRevision": 1,
            "actionId": next_action(reduction.plan).id,
            "response": "declined",
            **fields,
        },
        "invalid",
    )
    assert result["code"] == "invalidFacts"
    assert await store.get("owner") == reduction


async def test_refusal_revision_idempotency_conflicts_and_correction_replay(store, reduction):
    """Verify refusal commands enforce revisions and replay without undoing later corrections."""
    request = response_command(reduction, "declined")
    queue = await store.subscribe("owner")
    queue.get_nowait()
    results = await asyncio.gather(*(store.command("owner", request) for _ in range(3)))
    declined = results[0]
    assert all(result == declined for result in results)
    assert queue.get_nowait() == declined and queue.empty()
    assert (declined.revision, declined.sequence) == (2, 2)
    with pytest.raises(Problem) as error:
        await store.command("owner", response_command(reduction, "declined"))
    assert error.value.body.code == "staleRevision"
    conflict = request.model_copy(deep=True)
    conflict.operation.response = "unavailable"
    with pytest.raises(Problem) as error:
        await store.command("owner", conflict)
    assert error.value.body.code == "commandConflict"
    data = facts_input(declined.facts).model_dump(mode="json", by_alias=True)
    data["records"][0]["amount"] = money("700")
    current = await store.command("owner", parsed_command(data, 2))
    assert current.facts.decision.responses == []
    assert next_action(current.plan).kind == "previewChange"
    assert queue.get_nowait() == current
    assert await store.command("owner", request) == declined
    assert await store.get("owner") == current and queue.empty()


async def test_response_transaction_failure_rolls_back_and_does_not_publish(store, reduction):
    """Verify failed response transactions roll back without publishing and remain retryable."""
    queue = await store.subscribe("owner")
    queue.get_nowait()
    request = response_command(reduction, "declined")
    db = store.connection()
    await db.execute(
        "CREATE TRIGGER fail_response BEFORE INSERT ON commands "
        "BEGIN SELECT RAISE(ABORT, 'test failure'); END"
    )
    await db.commit()
    with pytest.raises(sqlite3.IntegrityError):
        await store.command("owner", request)
    assert await store.get("owner") == reduction
    assert queue.empty() and not db.in_transaction
    await db.execute("DROP TRIGGER fail_response")
    await db.commit()
    result = await store.command("owner", request)
    assert queue.get_nowait() == result


async def test_clock_changed_active_action_cannot_receive_stale_decline(store):
    """Verify a day change prevents declining an action that is no longer current."""
    await store.create("owner")
    initial = await store.command(
        "owner", parsed_command(facts("100", [record("purchase", "optional", "200", "2026-09-11")]))
    )
    request = response_command(initial, "declined")
    store.clock = lambda: NOW + timedelta(hours=18)
    with pytest.raises(Problem) as error:
        await store.command("owner", request)
    assert error.value.body.code == "invalidActionResponse"
    current = await store.get("owner")
    assert current.revision == initial.revision and current.sequence == initial.sequence + 1
    assert current.facts.decision.responses == []


def test_public_command_and_server_owned_responses_round_trip_without_manual_loss(client):
    """Verify manual edits retain server-owned responses and reject forged dependency keys."""
    baseline = initialize(
        client, facts("100", [record("purchase", "optional", "200", "2026-09-12")])
    )
    action = baseline["plan"]["decisionAssessment"]["nextActionId"]
    request = operation("respondToAction", actionId=action, response="declined")
    response = client.post("/api/session/commands", json=request)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["revision"] == saved["sequence"] == 2
    data = facts(
        "150",
        [record("purchase", "optional", "200", "2026-09-12")],
        decision=saved["facts"]["decision"],
    )
    echoed = client.post("/api/session/commands", json=command(data, 2))
    assert echoed.status_code == 200
    current = echoed.json()
    assert current["facts"]["decision"]["responses"] == saved["facts"]["decision"]["responses"]
    forged = deepcopy(data)
    forged["decision"]["responses"][0]["dependencyKey"] = "0" * 64
    assert client.post("/api/session/commands", json=command(forged, 3)).status_code == 422
    assert client.get("/api/session").json() == current
    assert client.post("/api/session/commands", json=request).json() == saved
    assert client.get("/api/session").json() == current


def test_response_schema_is_additive_strict_and_server_key_is_not_a_tool_argument():
    """Verify action response tool schemas require typed fields and exclude dependency keys."""
    from app.voice_tools import ActionResponseRequest

    assert Decision().responses == []
    schema = tool_parameters(ActionResponseRequest)
    assert set(schema["properties"]) == {"expectedRevision", "actionId", "response"}
    assert set(schema["required"]) == set(schema["properties"])
    assert schema["properties"]["response"]["enum"] == ["unavailable", "declined"]
    assert "$ref" not in json.dumps(schema)
    with pytest.raises(ValidationError):
        ActionResponseRequest.model_validate(
            {
                "expectedRevision": 0,
                "actionId": "review",
                "response": "declined",
                "dependencyKey": "x",
            }
        )


@pytest.mark.parametrize(
    "kind,response",
    [
        ("clarify", "declined"),
        ("contactPayee", "declined"),
        ("followUp", "declined"),
        ("seekSupport", "declined"),
        ("verifyTerms", "declined"),
        ("resolveGroup", "declined"),
        ("reviewOutcome", "unavailable"),
    ],
)
async def test_selected_action_still_requires_compatible_response_semantics(store, kind, response):
    """Verify selecting an action does not permit a response incompatible with its kind."""
    await store.create("owner")
    data = facts(
        "1000",
        [record("rent", "essential", "2000", "2026-09-14", controllability="committed")],
    )
    if kind == "clarify":
        data["opening"] = money(None, "unknown")
    elif kind == "reviewOutcome":
        data["opening"] = money("5000")
    elif kind == "resolveGroup":
        data["records"].append(record("food", "essential", "100", "2026-09-14"))
    elif kind in {"followUp", "seekSupport", "verifyTerms"}:
        data["providerResponses"] = [
            {
                "eventId": "rent:2026-09-14",
                "status": {
                    "followUp": "awaiting",
                    "seekSupport": "declined",
                    "verifyTerms": "reportedTerms",
                }[kind],
                "reportedOn": "2026-09-11",
            }
        ]
    baseline = await store.command("owner", parsed_command(data))
    assert next_action(baseline.plan).kind == kind
    with pytest.raises(Problem) as error:
        await store.command("owner", response_command(baseline, response))
    assert error.value.body.code == "invalidActionResponse"
    assert await store.get("owner") == baseline


async def test_response_uses_accepted_assessment_not_inactive_baseline(store, reduction):
    """Verify responses target the accepted assessment rather than inactive baseline actions."""
    preview = await store.command(
        "owner",
        Command.model_validate(
            operation(
                "previewAdjustments",
                adjustments=[{"eventId": "purchase:2026-09-12", "amount": "0"}],
            )
        ),
    )
    accepted = await store.command(
        "owner",
        Command.model_validate(operation("acceptPreview", previewId=str(preview.preview.id))),
    )
    assert next_action(accepted.accepted.plan).kind == "reviewOutcome"
    assert next_action(accepted.plan).kind == "previewChange"
    with pytest.raises(Problem) as error:
        await store.command(
            "owner", response_command(accepted, "declined", next_action(accepted.plan).id)
        )
    assert error.value.body.code == "invalidActionResponse"
    assert await store.get("owner") == accepted


@pytest.mark.parametrize(
    "field,amount,retained",
    [
        ("amount", "600", False),
        ("target", "1800", False),
        ("outstanding", "7000", True),
    ],
)
async def test_card_response_depends_on_minimum_and_target_not_informational_balance(
    store, field, amount, retained
):
    """Verify card minimum and target edits invalidate refusals but outstanding balance does not."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record(
                        "card", "debt", "500", "2026-09-12", debtType="card", target=money("2000")
                    )
                ],
            )
        ),
    )
    declined = await store.command("owner", response_command(baseline, "declined"))
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {"expectedRevision": 2, "records": [{"id": "card", field: money(amount)}]},
        "card-correction",
    )
    assert "code" not in result
    current = await store.get("owner")
    assert current.facts.decision.responses == (
        declined.facts.decision.responses if retained else []
    )
    assert next_action(current.plan).kind == ("reviewOutcome" if retained else "previewChange")


async def test_unavailable_controllability_never_becomes_committed_spending(store):
    """Verify unavailable spending-control answers preserve unknown controllability and the gap."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record("purchase", "optional", "800", "2026-09-12", controllability="unknown"),
                    record("rent", "essential", "500", "2026-09-14", controllability="committed"),
                ],
            )
        ),
    )
    assert next_action(baseline.plan).id == "clarify:purchase:controllability"
    current = await store.command("owner", response_command(baseline, "unavailable"))
    assert current.facts.records == baseline.facts.records
    assert current.facts.records[0].controllability == "unknown"
    assert next_action(current.plan).kind == "contactPayee"
    assert current.plan.first_gap == baseline.plan.first_gap
    assert any(
        item.field == "controllability" for item in current.plan.decision_assessment.uncertainties
    )


async def test_provider_retraction_reactivates_contact_after_unavailable_terms(store):
    """Verify retracting terms clears their deferred response and restores payee contact."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [record("rent", "essential", "2000", "2026-09-14", controllability="committed")],
                providerResponses=[
                    {
                        "eventId": "rent:2026-09-14",
                        "status": "reportedTerms",
                        "reportedOn": "2026-09-11",
                    }
                ],
            )
        ),
    )
    assert next_action(baseline.plan).kind == "verifyTerms"
    await store.command("owner", response_command(baseline, "unavailable"))
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {"expectedRevision": 2, "removeProviderResponseIds": ["rent:2026-09-14"]},
        "no-reported-terms",
    )
    assert "code" not in result and result["actionResponses"] == []
    assert result["currentAction"]["kind"] == "contactPayee"
    assert result["snapshot"]["facts"]["providerResponses"] == []
    assert result["activePlan"]["firstGap"]["amountPaise"] == 100000


async def test_corrected_response_dependencies_publish_consistent_baseline_and_accepted(
    store, reduction
):
    """Verify fact corrections publish baseline and accepted plans consistent with retained cuts."""
    await store.command("owner", response_command(reduction, "declined"))
    preview = await store.command(
        "owner",
        Command.model_validate(
            operation(
                "previewAdjustments",
                2,
                adjustments=[{"eventId": "purchase:2026-09-12", "amount": "400"}],
            )
        ),
    )
    accepted = await store.command(
        "owner",
        Command.model_validate(operation("acceptPreview", 2, previewId=str(preview.preview.id))),
    )
    data = facts_input(accepted.facts).model_dump(mode="json", by_alias=True)
    data["opening"] = money("1100")
    queue = await store.subscribe("owner")
    queue.get_nowait()
    current = await store.command("owner", parsed_command(data, 3))
    assert current.accepted.adjustments == accepted.accepted.adjustments
    assert current.facts.records == accepted.facts.records
    assert current.plan == calculate(current.facts, current.anchor_date, store.config)
    assert current.accepted.plan == calculate(
        current.facts, current.anchor_date, store.config, adjustments=current.accepted.adjustments
    )
    assert queue.get_nowait() == current == await store.get("owner")
