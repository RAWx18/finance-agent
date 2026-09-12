# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date
from uuid import uuid4

import pytest

from app.facts import facts_input
from app.finance import calculate, export_text, resolve_adjustments
from app.models import AdjustmentInput, Command
from app.voice_tools import VoiceTools, canonical

from .conftest import facts, money, parsed_command, record
from .test_action_responses import response_command
from .test_decision_priorities import next_action
from .test_scenarios import operation


def external_facts(kind):
    """Build an exposed rent scenario with the requested external-action prerequisites."""
    data = facts(
        "1000",
        [record("rent", "essential", "2000", "2026-09-14", controllability="committed")],
    )
    if kind == "resolveGroup":
        data["records"].append(record("food", "essential", "100", "2026-09-14"))
    elif kind in {"followUp", "seekSupport"}:
        data["providerResponses"] = [
            {
                "eventId": "rent:2026-09-14",
                "status": "awaiting" if kind == "followUp" else "declined",
                "reportedOn": "2026-09-11",
            }
        ]
    return data


@pytest.mark.parametrize("kind", ["contactPayee", "followUp", "seekSupport", "resolveGroup"])
@pytest.mark.parametrize("through_voice", [False, True])
async def test_external_step_can_be_deferred_without_a_payee_response(store, kind, through_voice):
    """Verify external-step deferrals preserve obligations without inventing payee responses."""
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(external_facts(kind)))
    action = next_action(baseline.plan)
    assert action.kind == kind
    if through_voice:
        tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
        result = await tools.invoke(
            "respond_to_action",
            {
                "expectedRevision": baseline.revision,
                "actionId": action.id,
                "response": "unavailable",
            },
            "cannot-take-step",
        )
        assert "code" not in result
        current = await store.get("owner")
    else:
        command = response_command(baseline, "unavailable")
        current = await store.command("owner", command)
        assert await store.command("owner", command) == current
    assert next_action(current.plan).kind == "reviewOutcome"
    assert current.plan.decision_assessment.next_question_id is None
    assert current.plan.decision_assessment.outcome.branch == "gap"
    assert current.plan.events == baseline.plan.events
    assert current.plan.first_gap == baseline.plan.first_gap
    assert (
        current.plan.decision_assessment.consequences
        == baseline.plan.decision_assessment.consequences
    )
    assert current.facts.model_dump(exclude={"decision"}) == baseline.facts.model_dump(
        exclude={"decision"}
    )
    assert current.facts.decision.responses[0].action_id == action.id
    assert current.facts.decision.responses[0].response == "unavailable"
    assert len(current.facts.decision.responses[0].dependency_key) == 64
    assert current.preview is current.accepted is None
    assert "Deferred steps remain outstanding" in canonical(current)["spokenBrief"]
    if kind in {"followUp", "seekSupport"}:
        assert (
            "awaiting response" if kind == "followUp" else "declined; original due remains"
        ) in (current.plan.decision_assessment.outcome.not_covered)
    assert await store.get("owner") == current


@pytest.mark.parametrize("kind", ["contactPayee", "followUp", "seekSupport", "resolveGroup"])
async def test_external_deferral_reopens_only_after_its_source_changes(store, kind):
    """Verify external deferrals survive cash edits; reopen only on dependent source edits."""
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(external_facts(kind)))
    current = await store.command("owner", response_command(baseline, "unavailable"))
    responses = current.facts.decision.responses[:]
    source = facts_input(current.facts)
    source.opening.amount = "900"
    current = await store.command("owner", parsed_command(source.model_dump(), current.revision))
    assert current.facts.decision.responses == responses
    assert next_action(current.plan).kind == "reviewOutcome"
    source = facts_input(current.facts)
    if kind == "resolveGroup":
        source.records[1].amount.amount = "150"
    elif kind in {"followUp", "seekSupport"}:
        source.provider_responses[0].status = "reportedTerms"
        source.provider_responses[0].payment = source.records[0].amount.model_copy()
    else:
        source.records[0].schedule.date = date(2026, 9, 15)
    current = await store.command("owner", parsed_command(source.model_dump(), current.revision))
    assert current.facts.decision.responses == []
    assert next_action(current.plan).kind == (
        "verifyTerms" if kind in {"followUp", "seekSupport"} else kind
    )


async def test_deferring_one_payee_moves_to_another_exposed_commitment(store):
    """Verify deferring one exposed obligation advances to another without changing the gap."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record("rent", "essential", "2000", "2026-09-14"),
                    record("emi", "debt", "500", "2026-09-16"),
                ],
            )
        ),
    )
    assert next_action(baseline.plan).record_ids == ["rent"]
    current = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(current.plan).record_ids == ["emi"]
    assert current.plan.first_gap == baseline.plan.first_gap
    assert current.facts.provider_responses == []


@pytest.mark.parametrize(
    "rent_status,loan_status",
    [("declined", "awaiting"), ("reportedTerms", "awaiting"), ("declined", None), (None, None)],
)
async def test_same_day_provider_replies_select_supported_individual_actions(
    store, rent_status, loan_status
):
    """Verify grouped funding exposure retains each saved reply without allocating payments."""
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
                providerResponses=[
                    {
                        "eventId": f"{identity}:2026-09-15",
                        "status": status,
                        "reportedOn": "2026-09-11",
                        **(
                            {
                                "payment": money("500"),
                                "paymentDate": "2026-09-21",
                                "cost": money("0"),
                            }
                            if status == "reportedTerms"
                            else {}
                        ),
                    }
                    for identity, status in (("rent", rent_status), ("loan", loan_status))
                    if status is not None
                ],
            )
        ),
    )
    assert baseline.plan.first_gap.amount_paise == 800000
    consequence = baseline.plan.decision_assessment.consequences[0]
    assert consequence.event_ids == ["loan:2026-09-15", "rent:2026-09-15"]
    assert consequence.amount_paise == 800000
    if rent_status is loan_status is None:
        action = next_action(baseline.plan)
        assert action.kind == "resolveGroup"
        assert set(action.record_ids) == {"rent", "loan"}
        assert "INR 8000.00" in action.question
        assert "no payment allocation is assumed" in action.question
        return
    assert next_action(baseline.plan).kind != "resolveGroup"
    expected = {
        "rent": "verifyTerms" if rent_status == "reportedTerms" else "seekSupport",
        "loan": "followUp" if loan_status == "awaiting" else "contactPayee",
    }
    current = baseline
    for _ in range(2):
        action = next_action(current.plan)
        identity = action.record_ids[0]
        assert action.kind == expected.pop(identity)
        assert action.consequence_ids == [consequence.id]
        assert "INR 8000.00" in action.question
        assert "shared across all commitments" in action.question
        assert f"not allocated to {identity}" in action.question
        assert "do not add it to other item shortfalls" in action.question
        if identity == "rent":
            assert ("reported terms" if rent_status == "reportedTerms" else "declined") in (
                action.question
            )
            if rent_status == "reportedTerms":
                assert "payment INR 500.00" in action.question
                assert "cost INR 0.00" in action.question
                assert "2026-09-21" in action.question
        elif loan_status:
            assert "awaiting" in action.question
        current = await store.command("owner", response_command(current, "unavailable"))
        assert current.plan.first_gap == baseline.plan.first_gap
        assert current.plan.events == baseline.plan.events
        assert current.plan.decision_assessment.consequences == [consequence]
        assert current.facts.model_dump(exclude={"decision"}) == baseline.facts.model_dump(
            exclude={"decision"}
        )
        assert current.preview is current.accepted is None
    assert not expected
    assert next_action(current.plan).kind == "reviewOutcome"
    assert await store.get("owner") == current


@pytest.mark.parametrize("cash", ["1000", "400"])
async def test_declined_card_targets_explain_combined_minimums_without_applying_them(store, cash):
    """Verify declined card reductions explain funded combined minimums without applying them."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                cash,
                [
                    record(name, "debt", "200", "2026-09-12", debtType="card", target=money("1000"))
                    for name in ("cardA", "cardB")
                ],
            )
        ),
    )
    options = (await store.options("owner")).options
    adjustments = resolve_adjustments(
        [AdjustmentInput(event_id=item.event_id, amount="200") for item in options],
        options,
        store.config,
    )
    comparison = calculate(
        baseline.facts, baseline.anchor_date, store.config, adjustments=adjustments
    )
    assert comparison.first_gap is None and comparison.outflow_paise == 40000
    current = baseline
    for _ in range(2):
        assert next_action(current.plan).kind == "previewChange"
        current = await store.command("owner", response_command(current, "declined"))
    action = next_action(current.plan)
    assert action.kind == "reviewOutcome"
    assert set(action.record_ids) == {"cardA", "cardB"}
    assert action.before_date == date(2026, 9, 12)
    assert "combined required minimum of INR 400.00" in action.question
    assert "intended payments of INR 2000.00" in action.question
    assert "minimums fit at that deadline" in action.question
    assert "declined" in action.question and "unchanged" in action.question
    assert "No payment or agreement is assumed" in action.question
    assert current.facts.records == baseline.facts.records
    assert current.plan.events == baseline.plan.events
    assert current.plan.first_gap == baseline.plan.first_gap
    assert len(current.facts.decision.responses) == 2
    assert current.preview is current.accepted is None
    assert action.question in canonical(current)["spokenBrief"]
    assert action.question in export_text(current)


async def test_combined_minimums_do_not_hide_an_unfunded_required_payment(store):
    """Verify combined-minimum guidance claims no fit while required payments are unfunded."""
    await store.create("owner")
    current = await store.command(
        "owner",
        parsed_command(
            facts(
                "300",
                [
                    record(name, "debt", "200", "2026-09-12", debtType="card", target=money("1000"))
                    for name in ("cardA", "cardB")
                ],
            )
        ),
    )
    for _ in range(2):
        assert next_action(current.plan).kind == "previewChange"
        current = await store.command("owner", response_command(current, "declined"))
    assert next_action(current.plan).kind == "resolveGroup"
    assert "minimums fit" not in canonical(current)["spokenBrief"]
    assert current.plan.first_gap.amount_paise == 170000


@pytest.mark.parametrize(
    "cost,text",
    [
        (money("0"), "cost INR 0.00 (exact, reported)"),
        (money("125.50"), "cost INR 125.50 (exact, reported)"),
        (money("25", "estimate"), "cost INR 25.00 (estimate, reported)"),
        (money(None, "unknown"), "unknown cost"),
        (None, "unknown cost"),
    ],
)
async def test_reported_terms_distinguish_known_zero_estimated_and_unknown_costs(store, cost, text):
    """Verify reported-term guidance distinguishes exact zero, estimated, and unknown costs."""
    await store.create("owner")
    current = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [record("rent", "essential", "2000", "2026-09-14")],
                providerResponses=[
                    {
                        "eventId": "rent:2026-09-14",
                        "status": "reportedTerms",
                        "reportedOn": "2026-09-11",
                        "paymentDate": "2026-09-21",
                        "payment": money("500"),
                        "cost": cost,
                    }
                ],
            )
        ),
    )
    action = next_action(current.plan)
    assert action.kind == "verifyTerms"
    assert "payment INR 500.00" in action.question and "2026-09-21" in action.question
    assert text in action.question
    if cost is not None and cost["status"] != "unknown":
        assert "unknown cost" not in action.question
    assert "acceptance requirements" in action.question and "auto-debit" in action.question
    assert current.plan.first_gap.amount_paise == 100000
    assert current.facts.records[0].amount.amount_paise == 200000
    assert current.preview is current.accepted is None
    assert action.question in canonical(current)["spokenBrief"]


@pytest.mark.parametrize("through_voice", [False, True])
async def test_renaming_an_accepted_item_updates_all_labels_but_not_consent(store, through_voice):
    """Verify renaming an accepted item refreshes all labels but keeps consent and metrics."""
    await store.create("owner")
    await store.command(
        "owner",
        parsed_command(
            facts(
                "2000",
                [record("purchase", "optional", "1000", "2026-09-12", label="Headphones")],
            )
        ),
    )
    preview = await store.command(
        "owner",
        Command.model_validate(
            operation(
                "previewAdjustments",
                adjustments=[{"eventId": "purchase:2026-09-12", "amount": "500"}],
            )
        ),
    )
    accepted = await store.command(
        "owner",
        Command.model_validate(operation("acceptPreview", previewId=str(preview.preview.id))),
    )
    if through_voice:
        tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
        result = await tools.invoke(
            "update_facts",
            {
                "expectedRevision": accepted.revision,
                "records": [{"id": "purchase", "label": "Speakers"}],
            },
            "rename-purchase",
        )
        assert "code" not in result
        current = await store.get("owner")
    else:
        source = facts_input(accepted.facts)
        source.records[0].label = "Speakers"
        current = await store.command(
            "owner", parsed_command(source.model_dump(), accepted.revision)
        )
    assert current.accepted.id == accepted.accepted.id
    assert current.accepted.adjustments[0].label == "Speakers"
    assert current.accepted.adjustments[0].model_dump(exclude={"label"}) == (
        accepted.accepted.adjustments[0].model_dump(exclude={"label"})
    )
    assert current.facts.records[0].label == current.accepted.plan.events[0].label == "Speakers"
    assert current.accepted.plan.closing_paise == accepted.accepted.plan.closing_paise
    assert current.invalidated_assumptions == []
    assert "Headphones" not in export_text(current)
    await store.close()
    await store.open()
    assert await store.get("owner") == current


async def test_combined_minimum_review_does_not_hide_later_required_shortfall(store):
    """Verify funded combined-minimum reviews do not displace later required-payment shortfalls."""
    await store.create("owner")
    current = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record(name, "debt", "200", "2026-09-12", debtType="card", target=money("1000"))
                    for name in ("cardA", "cardB")
                ]
                + [record("rent", "essential", "800", "2026-09-15")],
            )
        ),
    )
    for _ in range(2):
        assert next_action(current.plan).kind == "previewChange"
        current = await store.command("owner", response_command(current, "declined"))
    assert next_action(current.plan).record_ids == ["rent"]
    reviews = [
        action
        for action in current.plan.decision_assessment.actions
        if action.kind == "reviewOutcome"
    ]
    assert len(reviews) == 1 and reviews[0].before_date == date(2026, 9, 12)
    assert "minimums fit at that deadline" in reviews[0].question
    assert current.plan.first_gap.amount_paise == 100000
    assert current.plan.peak_gap_paise == 180000
    current = await store.command("owner", response_command(current, "unavailable"))
    assert next_action(current.plan) == reviews[0]
    assert "rent" in canonical(current)["spokenBrief"]


@pytest.mark.parametrize("correction", ["estimate", "undated", "autoDebit", "earlierDue"])
async def test_joint_minimum_claim_requires_complete_dated_basis(store, correction):
    """Verify incomplete or constrained funding bases suppress combined-minimum fit claims."""
    await store.create("owner")
    current = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record(name, "debt", "200", "2026-09-12", debtType="card", target=money("1000"))
                    for name in ("cardA", "cardB")
                ],
            )
        ),
    )
    for _ in range(2):
        current = await store.command("owner", response_command(current, "declined"))
    source = facts_input(current.facts).model_dump(mode="json", by_alias=True)
    if correction == "estimate":
        source["opening"] = money("1000", "estimate")
    elif correction == "autoDebit":
        source["records"][1]["autoDebit"] = True
    else:
        source["records"].append(
            record("rent", "essential", "1200", None if correction == "undated" else "2026-09-11")
        )
        source["coverage"]["essential"] = "reviewed"
    current = await store.command("owner", parsed_command(source, current.revision))
    assert "minimums fit" not in canonical(current)["spokenBrief"]
    assert not any(
        action.id == "review:2026-09-12" for action in current.plan.decision_assessment.actions
    )


async def test_group_replies_precede_a_later_unreported_obligation(store):
    """Follow shared exposed commitments by deadline without hiding their saved replies."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record("rent", "essential", "6000", "2026-09-15", controllability="committed"),
                    record("loan", "debt", "3000", "2026-09-15"),
                    record("bill", "debt", "100", "2026-09-18"),
                ],
                providerResponses=[
                    {
                        "eventId": "rent:2026-09-15",
                        "status": "declined",
                        "reportedOn": "2026-09-11",
                    },
                    {
                        "eventId": "loan:2026-09-15",
                        "status": "awaiting",
                        "reportedOn": "2026-09-11",
                    },
                ],
            )
        ),
    )
    current = baseline
    for identity in ("loan", "rent"):
        action = next_action(current.plan)
        assert action.id == f"response:{identity}:2026-09-15"
        assert "INR 8000.00" in action.question
        assert "shared across all commitments" in action.question
        assert action.consequence_ids == ["cash:2026-09-15"]
        current = await store.command("owner", response_command(current, "unavailable"))
    assert next_action(current.plan).id == "contact:bill:2026-09-18"
    assert current.plan.events == baseline.plan.events
    assert current.facts.provider_responses == baseline.facts.provider_responses
    assert current.preview is current.accepted is None
