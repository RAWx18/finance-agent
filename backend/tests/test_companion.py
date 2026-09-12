# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from app.voice_tools import canonical
from app.workspace import project

from .conftest import facts, money, parsed_command, record
from .test_workspace import operation, result, update


async def test_progressive_cards_keep_first_gap_despite_positive_closing(store):
    """Verify progressive cards retain an early gap despite positive closing cash."""
    empty = await store.create("owner")
    assert empty.plan.decision_assessment.outcome is not None
    assert empty.workspace.cards == []
    cash = await store.command("owner", update(0, opening=money("100")))
    assert [(card.id, card.title) for card in cash.workspace.cards] == [
        ("cash", "Cash & timing"),
        ("questions", "Important uncertainty"),
    ]
    assert cash.workspace.cards[-1].issue_ids == ["income"]
    assert cash.facts.coverage.income == "notDiscussed"
    assert cash.workspace.questions[0].action_id == "clarify:income"
    dated = await store.command(
        "owner",
        parsed_command(
            facts(
                "100",
                [
                    record("rent", "essential", "200", "2026-09-15"),
                    record("salary", "income", "1000", "2026-09-20"),
                ],
            ),
            cash.revision,
        ),
    )
    assert [(card.id, card.template, card.title) for card in dated.workspace.cards] == [
        ("cash", "cash", "Cash & timing"),
        ("timeline", "timeline", "Next & commitments"),
    ]
    assert dated.workspace.cards[0].state == "unresolved"
    assert dated.workspace.cards[0].result_ids == ["opening", "firstGap", "closing", "trough"]
    assert result(dated, "firstGap").amount_paise == 10000
    assert result(dated, "closing").amount_paise == 90000
    assert canonical(dated)["dialogue"]["sharedCardIds"] == ["cash", "timeline"]
    assert project(dated, store.config) == dated.workspace
    shuffled = dated.model_copy(deep=True)
    shuffled.facts.records.reverse()
    assert project(shuffled, store.config).cards == dated.workspace.cards


async def test_four_patterns_one_hidden_uncertainty_and_all_records_for_expansion(store):
    """Verify four card patterns expose one key uncertainty while retaining expandable records."""
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        parsed_command(
            facts(
                "100",
                [
                    record("salary", "income", "1000", "2026-09-20"),
                    record("rent", "essential", "200", "2026-09-15"),
                    record("gym", "optional", "50", "2026-09-25"),
                ]
                + [record(identity, "debt", "10", None) for identity in ("d", "b", "c")],
            )
        ),
    )
    timeline = next(card for card in snapshot.workspace.cards if card.id == "timeline")
    assert timeline.record_ids == ["rent", "salary", "b", "c", "d", "gym"]
    assert timeline.event_ids == ["rent:2026-09-15", "salary:2026-09-20", "gym:2026-09-25"]
    question = next(card for card in snapshot.workspace.cards if card.id == "questions")
    assert question.title == "Important uncertainty"
    assert question.record_ids == ["d"] and len(question.issue_ids) == 1
    assert question.issue_ids[0] in {item.id for item in snapshot.workspace.issues}
    assert not any(identity.startswith("coverage") for identity in question.issue_ids)
    proposal = await store.command(
        "owner",
        operation(
            snapshot,
            "previewAdjustments",
            adjustments=[{"eventId": "gym:2026-09-25", "amount": "0"}],
        ),
    )
    assert [card.id for card in proposal.workspace.cards] == [
        "cash",
        "timeline",
        "questions",
        "proposal",
    ]
    assert proposal.workspace.cards[-1].title == "Plan changes"
    assert proposal.workspace.cards[-1].state == "proposed"
    assert proposal.workspace.questions == snapshot.workspace.questions
    assert proposal.workspace.issues == snapshot.workspace.issues
    assert proposal.workspace.actions == snapshot.workspace.actions
    assert proposal.workspace.choices == snapshot.workspace.choices
    assert project(proposal, store.config) == proposal.workspace


async def test_variable_foreign_receipt_and_monthly_budget_keep_occurrence_identity(store):
    """Verify timeline cards retain foreign-income occurrence identity and budget estimates."""
    await store.create("owner")
    foreign = {
        "amount": "200",
        "status": "exact",
        "conversion": {
            "currency": "USD",
            "rate": "80",
            "rateStatus": "estimate",
            "rateDate": "2026-09-10",
            "fee": "10",
            "feeStatus": "exact",
        },
    }
    snapshot = await store.command(
        "owner",
        parsed_command(
            facts(
                "100",
                [
                    record(
                        "budget",
                        "essential",
                        "3000",
                        "2026-09-01",
                        schedule={"date": "2026-09-01", "recurrence": "monthlyBudget"},
                    ),
                    record("rent", "essential", "200", "2026-09-13"),
                    record(
                        "wages",
                        "income",
                        None,
                        "2026-09-04",
                        schedule={
                            "date": "2026-09-04",
                            "recurrence": "weekly",
                            "amounts": [money("100"), foreign],
                        },
                    )
                    | {"amount": money(None, "unknown")},
                ],
            )
        ),
    )
    timeline = next(card for card in snapshot.workspace.cards if card.id == "timeline")
    assert timeline.record_ids == ["wages", "rent", "budget"]
    assert timeline.record_ids.count("budget") == 1
    assert timeline.event_ids == ["wages:2026-09-11", "rent:2026-09-13"]
    assert all(
        row.state == "estimated" for row in timeline.rows if row.field in {"wages", "budget"}
    )
    event = next(item for item in snapshot.plan.events if item.id == timeline.event_ids[0])
    assert event.schedule_index == 1
    assert event.source.model_dump(mode="json", by_alias=True) == {
        **foreign,
        "conversion": {
            **foreign["conversion"],
            "provider": None,
            "fetchedAt": None,
            "direction": "receipt",
        },
    }
    assert event.amount_paise == 1599000 and event.included
    assert event.amount_status == "estimate"
    assert next(item for item in snapshot.facts.records if item.id == "wages").reliability == (
        "reliable"
    )
    assert len([item for item in snapshot.plan.events if item.record_id == "budget"]) == 30
    assert any(item.reason == "monthlyBudget" for item in snapshot.workspace.contributions)
    assert snapshot.plan.budget_basis == (await store.get("owner")).plan.budget_basis


async def test_undated_records_do_not_invent_cash_and_coverage_alone_has_no_card(store):
    """Verify partial records do not invent cash and a reserve reveals an unknown-cash card."""
    await store.create("owner")
    coverage = await store.command("owner", update(0, coverage={"income": "unknown"}))
    assert coverage.workspace.cards == []
    partial = await store.command(
        "owner", update(1, records=[{"kind": "essential", "label": "Rent"}])
    )
    assert "cash" not in [card.id for card in partial.workspace.cards]
    timeline = partial.workspace.cards[0]
    assert timeline.id == "timeline" and timeline.event_ids == []
    assert timeline.rows[0].state == "missing"
    assert partial.facts.opening.amount_paise is None
    reserved = await store.command("owner", update(2, reserve="50"))
    assert reserved.workspace.cards[0].id == "cash"
    assert reserved.workspace.cards[0].result_ids == ["opening", "reserveShortfall"]
    assert reserved.workspace.cards[0].rows[0].value is None


async def test_proposal_merges_acceptance_preview_and_invalidated_timing(store):
    """Verify one proposal card combines accepted, invalidated, and pending spending changes."""
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        parsed_command(
            facts(
                "100",
                [
                    record("gym", "optional", "50", "2026-09-25"),
                    record("trip", "optional", "50", "2026-09-26"),
                ],
            )
        ),
    )
    preview = await store.command(
        "owner",
        operation(
            snapshot,
            "previewAdjustments",
            adjustments=[{"eventId": "gym:2026-09-25", "amount": "0"}],
        ),
    )
    accepted = await store.command(
        "owner",
        operation(
            preview,
            "acceptPreview",
            previewId=str(preview.preview.id),
            confirmed=True,
            consentScope="unconditional",
        ),
    )
    assert accepted.workspace.cards[-1].state == "accepted"
    changes = {identity for item in accepted.latest_change.items for identity in item.card_ids}
    assert "timeline" in changes
    invalidated = await store.command(
        "owner",
        update(accepted.revision, records=[{"id": "gym", "schedule": {"date": "2026-09-27"}}]),
    )
    card = invalidated.workspace.cards[-1]
    assert card.id == "proposal" and card.state == "unresolved"
    assert card.record_ids == ["gym"] and card.event_ids == ["gym:2026-09-25"]
    preview = await store.command(
        "owner",
        operation(
            invalidated,
            "previewAdjustments",
            adjustments=[{"eventId": "trip:2026-09-26", "amount": "0"}],
        ),
    )
    card = preview.workspace.cards[-1]
    assert card.id == "proposal" and card.state == "proposed"
    assert card.record_ids == ["trip", "gym"]
    assert card.event_ids == ["trip:2026-09-26", "gym:2026-09-25"]
    assert len([item for item in preview.workspace.cards if item.section == "decisions"]) == 1
