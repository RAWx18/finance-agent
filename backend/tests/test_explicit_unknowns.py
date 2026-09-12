# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import sqlite3
from datetime import timedelta
from uuid import uuid4, uuid5

import pytest

from app.decisions import action_dependency_key
from app.finance import calculate
from app.models import Command
from app.voice_tools import VoiceTools, canonical

from .conftest import facts, money, parsed_command, record
from .test_decision_priorities import next_action
from .test_scenarios import operation


def update(revision=0, **changes):
    """Build a validated facts-update command with a fresh command identifier."""
    return Command.model_validate(
        {
            "commandId": str(uuid4()),
            "expectedRevision": revision,
            "operation": {
                "type": "updateFacts",
                "changes": {"expectedRevision": revision, **changes},
            },
        }
    )


@pytest.mark.parametrize("schedule", [None, {}, {"recurrence": "once"}, {"certainty": "unknown"}])
async def test_omitted_unknowns_remain_questions(store, schedule):
    """Verify omitted values remain clarification questions rather than unavailable answers."""
    await store.create("owner")
    change = {"kind": "essential", "label": "Bill"}
    if schedule is not None:
        change["schedule"] = schedule
    submitted = update(records=[change])
    snapshot = await store.command("owner", submitted)
    identity = str(uuid5(submitted.command_id, "0"))
    assert snapshot.facts.decision.responses == []
    assert {action.id for action in snapshot.plan.decision_assessment.actions} >= {
        "clarify:opening",
        f"clarify:{identity}:amount",
        f"clarify:{identity}:schedule.date",
    }


async def test_clarification_then_correction_keeps_current_thirty_day_outcome(store):
    """Verify date clarification and cash edits retain record identity and current outcomes."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 0,
            "opening": money("6000"),
            "records": [{"kind": "essential", "label": "Rent", "amount": money("2000")}],
        },
        "unclear-date",
    )
    assert "code" not in result
    saved = await store.get("owner")
    rent = saved.facts.records[0]
    assert saved.facts.decision.responses == []
    assert any(
        question.action_id == f"clarify:{rent.id}:schedule.date"
        for question in saved.workspace.questions
    )
    date = (saved.anchor_date + timedelta(days=3)).isoformat()
    await tools.update_facts(
        {
            "expectedRevision": saved.revision,
            "records": [{"id": rent.id, "schedule": {"date": date, "certainty": "exact"}}],
            "coverage": {
                "income": "none",
                "essential": "reviewed",
                "debt": "none",
                "optional": "none",
            },
        },
        "clarified-date",
    )
    saved = await store.get("owner")
    assert saved.plan.closing_paise == 400000 and not saved.plan.projection_partial
    await tools.update_facts(
        {"expectedRevision": saved.revision, "opening": money("6500")}, "cash-correction"
    )
    saved = await store.get("owner")
    review = await tools.review_plan({"expectedRevision": saved.revision})
    assert saved.plan.closing_paise == 450000 and len(saved.facts.records) == 1
    assert saved.facts.records[0].id == rent.id
    assert saved.plan.decision_assessment.outcome.readiness == "ready"
    assert review["outcome"]["branch"] == "fits"
    assert review["snapshot"] == saved.model_dump(mode="json", by_alias=True)


async def test_explicit_unknowns_save_all_matching_answers_in_one_revision(store):
    """Verify explicit unknowns save matching unavailable answers atomically in one revision."""
    await store.create("owner")
    queue = await store.subscribe("owner")
    queue.get_nowait()
    submitted = update(
        opening=money(None, "unknown"),
        records=[
            {
                "kind": "debt",
                "label": "Card",
                "debtType": "card",
                "amount": money(None, "unknown"),
                "target": money(None, "unknown"),
                "outstanding": money(None, "unknown"),
                "schedule": {"date": None},
            }
        ],
    )
    snapshot = await store.command("owner", submitted)
    identity = str(uuid5(submitted.command_id, "0"))
    assert {response.action_id for response in snapshot.facts.decision.responses} == {
        "clarify:opening",
        f"clarify:{identity}:amount",
        f"clarify:{identity}:target",
        f"clarify:{identity}:schedule.date",
    }
    assert all(
        response.response == "unavailable"
        and response.dependency_key
        == action_dependency_key(snapshot.facts, snapshot.plan, response.action_id)
        for response in snapshot.facts.decision.responses
    )
    assert next_action(snapshot.plan).id == "clarify:coverage"
    assert snapshot.facts.opening.amount_paise is None
    assert snapshot.facts.records[0].amount.amount_paise is None
    assert snapshot.facts.records[0].schedule.date is None
    assert not snapshot.plan.budget_basis.dated_projection_complete
    assert snapshot.facts.coverage.debt == "reported"
    assert snapshot.facts.coverage.essential == "notDiscussed"
    assert snapshot.revision == snapshot.sequence == 1
    assert queue.get_nowait() == snapshot and queue.empty()
    assert await store.command("owner", submitted) == snapshot
    assert await store.get("owner") == snapshot
    assert queue.empty()
    assert snapshot.plan == calculate(snapshot.facts, snapshot.anchor_date, store.config)


@pytest.mark.parametrize("known_cash", [False, True])
async def test_long_turn_remembers_bill_date_even_behind_opening(store, known_cash):
    """Verify a long turn retains an unavailable bill date even when opening cash takes priority."""
    await store.create("owner")
    if known_cash:
        await store.command("owner", update(opening=money("5000")))
    submitted = update(
        int(known_cash),
        records=[
            {key: value for key, value in item.items() if key != "id"}
            for item in [
                record("Rent", "essential", "7000", "2026-09-15"),
                record("Wages", "income", "18000", "2026-09-20", reliability="uncertain"),
                record("Electricity bill", "essential", "1200", None),
                record("Scooter EMI", "debt", "2000", "2026-09-17"),
                record("Appliance EMI", "debt", "2000", "2026-09-17"),
            ]
        ],
    )
    snapshot = await store.command("owner", submitted)
    identity = str(uuid5(submitted.command_id, "2"))
    assert [response.action_id for response in snapshot.facts.decision.responses] == [
        f"clarify:{identity}:schedule.date"
    ]
    if not known_cash:
        assert next_action(snapshot.plan).id == "clarify:opening"
        snapshot = await store.command("owner", update(1, opening=money("5000")))
    assert next_action(snapshot.plan).kind == "seekSupport"
    assert snapshot.plan.first_gap.amount_paise == 200000
    assert snapshot.plan.peak_gap_paise == 600000
    assert snapshot.plan.reliable_income_paise == 0
    assert len(snapshot.facts.records) == 5
    assert snapshot.facts.coverage.essential == "reported"
    assert snapshot.facts.coverage.optional == "notDiscussed"
    assert snapshot.facts.records[2].id == identity
    assert snapshot.facts.records[2].schedule.date is None
    assert not snapshot.plan.budget_basis.dated_projection_complete
    assert any(
        item.id == f"{identity}:schedule.date"
        for item in snapshot.plan.decision_assessment.uncertainties
    )
    result = canonical(snapshot)
    assert result["currentAction"]["id"] == snapshot.plan.decision_assessment.next_action_id
    assert next_action(snapshot.plan) in snapshot.workspace.actions
    assert result["currentAction"]["question"] == result["outcome"]["nextStep"]
    assert result["actionResponses"][0]["actionId"] == f"clarify:{identity}:schedule.date"
    card = next(card for card in snapshot.workspace.cards if identity in card.record_ids)
    row = next(row for row in card.rows if row.field == identity)
    assert row.state == "missing" and row.references == [f"facts.records.{identity}"]
    assert f"{identity}:schedule.date" in card.issue_ids
    assert all(
        question.action_id != f"clarify:{identity}:schedule.date"
        for question in snapshot.workspace.questions
    )


async def test_exact_id_unknown_amount_allows_qualified_next_step(store):
    """Verify an explicit unknown amount records its answer and advances to qualified review."""
    await store.create("owner")
    baseline = await store.command(
        "owner", parsed_command(facts("1000", [record("bill", "essential", "100", "2026-09-15")]))
    )
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {"expectedRevision": 1, "records": [{"id": "bill", "amount": money(None, "unknown")}]},
        "unknown-amount",
    )
    assert "code" not in result
    snapshot = await store.get("owner")
    assert snapshot.revision == snapshot.sequence == baseline.revision + 1
    assert tools.written_sequence == snapshot.sequence
    assert result["actionResponses"][0]["actionId"] == "clarify:bill:amount"
    assert result["currentAction"]["kind"] == "reviewOutcome"
    assert result["outcome"]["readiness"] == "qualified"
    assert snapshot.facts.coverage == baseline.facts.coverage
    assert snapshot.facts.records[0].amount.amount_paise is None
    assert snapshot.plan == calculate(snapshot.facts, snapshot.anchor_date, store.config)


async def test_date_dependency_correction_reopens_only_affected_question(store):
    """Verify recurrence edits reopen date questions while unrelated label edits retain answers."""
    await store.create("owner")
    submitted = update(records=[{"kind": "essential", "label": "Bill", "schedule": {"date": None}}])
    snapshot = await store.command("owner", submitted)
    identity = snapshot.facts.records[0].id
    snapshot = await store.command("owner", update(1, records=[{"id": identity, "label": "Power"}]))
    assert len(snapshot.facts.decision.responses) == 1
    snapshot = await store.command(
        "owner", update(2, records=[{"id": identity, "schedule": {"recurrence": "monthly"}}])
    )
    assert snapshot.facts.decision.responses == []
    assert f"clarify:{identity}:schedule.date" in {
        action.id for action in snapshot.plan.decision_assessment.actions
    }


@pytest.mark.parametrize("field", ["schedule.date", "amount"])
async def test_competing_values_are_not_unavailable_answers(store, field):
    """Verify competing values keep conflict questions open rather than marking them unavailable."""
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        update(
            records=[
                {
                    "kind": "essential",
                    "label": "Bill",
                    "amount": money(None, "unknown"),
                    "schedule": {"date": None},
                    "conflicts": [
                        {
                            "field": field,
                            "values": [
                                {"id": "first", "date": "2026-09-15", "status": "exact"},
                                {"id": "second", "date": "2026-09-17", "status": "exact"},
                            ]
                            if field == "schedule.date"
                            else [
                                {"id": "first", "amount": "1200", "status": "exact"},
                                {"id": "second", "amount": "1400", "status": "exact"},
                            ],
                        }
                    ],
                }
            ]
        ),
    )
    identity = snapshot.facts.records[0].id
    assert [response.action_id for response in snapshot.facts.decision.responses] == [
        f"clarify:{identity}:{'amount' if field == 'schedule.date' else 'schedule.date'}"
    ]
    assert f"clarify:{snapshot.facts.conflicts[0].id}" in {
        action.id for action in snapshot.plan.decision_assessment.actions
    }
    assert len(snapshot.facts.conflicts[0].values) == 2


async def test_ambiguous_record_candidates_are_not_unavailable_answers(store):
    """Verify ambiguous record IDs need clarification without saving unavailable answers."""
    await store.create("owner")
    await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [record("first", "debt", "100", None), record("second", "debt", "100", None)],
            )
        ),
    )
    snapshot = await store.command(
        "owner",
        update(
            1,
            records=[{"id": "first", "schedule": {"date": None}}],
            decision={"ambiguousRecordIds": ["first", "second"]},
        ),
    )
    assert snapshot.facts.decision.responses == []
    assert next_action(snapshot.plan).id == "clarify:recordIdentity"


async def test_explicit_unknown_transaction_failure_rolls_back_facts_and_answers(store):
    """Verify failed unknown-value transactions roll back facts, answers, and notifications."""
    baseline = await store.create("owner")
    queue = await store.subscribe("owner")
    queue.get_nowait()
    db = store.connection()
    await db.execute(
        "CREATE TRIGGER fail_command BEFORE INSERT ON commands "
        "BEGIN SELECT RAISE(ABORT, 'test failure'); END"
    )
    await db.commit()
    submitted = update(opening=money(None, "unknown"))
    with pytest.raises(sqlite3.IntegrityError):
        await store.command("owner", submitted)
    assert await store.get("owner") == baseline
    assert queue.empty() and not db.in_transaction
    await db.execute("DROP TRIGGER fail_command")
    await db.commit()
    snapshot = await store.command("owner", submitted)
    assert snapshot.revision == snapshot.sequence == 1
    assert [response.action_id for response in snapshot.facts.decision.responses] == [
        "clarify:opening"
    ]


async def test_estimates_never_become_unavailable_answers(store):
    """Verify estimated cash, amounts, and dates remain estimates, not unavailable answers."""
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        update(
            opening=money("1000", "estimate"),
            records=[
                {
                    "kind": "essential",
                    "label": "Bill",
                    "amount": money("100", "estimate"),
                    "schedule": {"date": "2026-09-15", "certainty": "estimate"},
                }
            ],
        ),
    )
    assert snapshot.facts.decision.responses == []
    assert snapshot.facts.opening.status == "estimate"
    assert snapshot.facts.records[0].amount.status == "estimate"
    assert snapshot.facts.records[0].schedule.certainty == "estimate"
    assert any(action.kind == "clarify" for action in snapshot.plan.decision_assessment.actions)


async def test_reanswered_unknown_replaces_dependency_without_duplicate_or_stale_plan(store):
    """Verify reanswered unknowns replace dependency keys with no duplicates or stale plans."""
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        update(records=[{"kind": "essential", "label": "Bill", "schedule": {"date": None}}]),
    )
    response = snapshot.facts.decision.responses[0]
    snapshot = await store.command(
        "owner",
        update(
            1,
            records=[
                {
                    "id": snapshot.facts.records[0].id,
                    "schedule": {"date": None, "recurrence": "monthly"},
                }
            ],
        ),
    )
    assert len(snapshot.facts.decision.responses) == 1
    assert snapshot.facts.decision.responses[0].action_id == response.action_id
    assert snapshot.facts.decision.responses[0].dependency_key != response.dependency_key
    assert all(
        action.id != response.action_id for action in snapshot.plan.decision_assessment.actions
    )
    assert snapshot.plan == calculate(snapshot.facts, snapshot.anchor_date, store.config)
    assert await store.get("owner") == snapshot


async def test_explicit_unknown_recalculates_retained_accepted_plan(store):
    """Verify unknown cash recalculates baseline and accepted plans while retaining consent."""
    await store.create("owner")
    await store.command(
        "owner",
        parsed_command(facts("1000", [record("trip", "optional", "100", "2026-09-15")])),
    )
    snapshot = await store.command(
        "owner",
        Command.model_validate(
            operation(
                "previewAdjustments",
                1,
                adjustments=[{"eventId": "trip:2026-09-15", "amount": "50"}],
            )
        ),
    )
    snapshot = await store.command(
        "owner",
        Command.model_validate(
            operation("acceptPreview", snapshot.revision, previewId=str(snapshot.preview.id))
        ),
    )
    adjustments = snapshot.accepted.adjustments
    snapshot = await store.command(
        "owner", update(snapshot.revision, opening=money(None, "unknown"))
    )
    assert (snapshot.revision, snapshot.sequence) == (3, 4)
    assert snapshot.accepted.adjustments == adjustments
    for plan in (snapshot.plan, snapshot.accepted.plan):
        assert plan.closing_paise is None
        assert next_action(plan).kind == "reviewOutcome"
        assert all(action.id != "clarify:opening" for action in plan.decision_assessment.actions)
    assert snapshot.accepted.plan == calculate(
        snapshot.facts, snapshot.anchor_date, store.config, adjustments=adjustments
    )
    assert canonical(snapshot)["currentAction"]["id"] == next_action(snapshot.accepted.plan).id
    assert await store.get("owner") == snapshot
