# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import json
from datetime import date, timedelta
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.facts import facts_input
from app.models import Command
from app.store import Problem, Store
from app.workspace import project

from .conftest import NOW, facts, money, parsed_command, record
from .test_events import frame, live_server  # noqa: F401


def update(revision, **changes):
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


def operation(snapshot, kind, **fields):
    return Command.model_validate(
        {
            "commandId": str(uuid4()),
            "expectedRevision": snapshot.revision,
            "operation": {"type": kind, **fields},
        }
    )


def result(snapshot, identity):
    return next(item for item in snapshot.workspace.results if item.id == identity)


async def salary_state(store):
    await store.create("owner")
    return await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record("salary", "income", "50000", "2026-09-20"),
                    record("rent", "essential", "10000", "2026-09-15"),
                    record("emi", "debt", "3000", "2026-09-17"),
                    record("gym", "optional", "1000", "2026-09-25"),
                ],
                reserve="500",
            )
        ),
    )


async def test_sparse_corrections_update_one_ledger_cards_math_and_changes(store):
    baseline = await salary_state(store)
    command = update(
        1,
        records=[
            {"id": "salary", "amount": money("60000")},
            {"id": "gym", "delete": True},
            {"id": "emi", "schedule": {"date": "2026-09-18"}},
        ],
    )
    corrected = await store.command("owner", command)
    assert [item.id for item in corrected.facts.records] == ["salary", "rent", "emi"]
    assert corrected.facts.records[0].amount.amount_paise == 6000000
    assert corrected.facts.records[2].schedule.date == date(2026, 9, 18)
    assert result(corrected, "closing").amount_paise == 4800000
    assert not any(card.id == "optional" for card in corrected.workspace.cards)
    change = corrected.workspace.change
    fields = [field for item in change.items for field in item.fields]
    assert any(
        field.reference == "facts.records.salary.amount.amountPaise"
        and field.before == 5000000
        and field.after == 6000000
        for field in fields
    )
    assert any(item.id == "result:closing" for item in change.items)
    assert baseline.facts.records[0].amount.amount_paise == 5000000
    assert await store.command("owner", command) == corrected
    assert await store.get("owner") == corrected
    with pytest.raises(Problem, match="Session changed"):
        await store.command("owner", update(1, opening=money("1")))


async def test_conflict_keeps_saved_value_no_duplicate_or_winner_and_explicit_resolution(store):
    baseline = await salary_state(store)
    disputed = await store.command(
        "owner",
        update(
            1,
            conflicts=[
                {
                    "recordId": "salary",
                    "field": "amount",
                    "values": [
                        {"id": "report60", "amount": "60000", "status": "exact"},
                        {"id": "report55", "amount": "55000", "status": "exact"},
                    ],
                }
            ],
        ),
    )
    conflict = disputed.facts.conflicts[0]
    assert len(disputed.facts.records) == len(baseline.facts.records)
    assert {item.amount_paise for item in conflict.values} == {5000000, 5500000, 6000000}
    assert disputed.facts.records[0].amount.amount_paise is None
    assert disputed.facts.records[0].schedule == baseline.facts.records[0].schedule
    assert disputed.plan.reliable_income_paise == 0
    assert disputed.plan.decision_assessment.outcome.branch == "conflict"
    assert disputed.workspace.questions[0].id == conflict.id
    assert len(disputed.workspace.questions) <= store.config.workspace_max_questions
    resolved = await store.command(
        "owner",
        update(
            2,
            resolutions=[
                {
                    "conflictId": conflict.id,
                    "value": {"id": "confirmed", "amount": "60000", "status": "exact"},
                }
            ],
        ),
    )
    assert resolved.facts.conflicts == []
    assert resolved.plan.reliable_income_paise == 6000000
    assert not any(item.id == conflict.id for item in resolved.workspace.questions)
    assert any(
        item.state == "resolved" and item.id == conflict.id for item in resolved.latest_change.items
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"records": [{"id": "salary", "amount": money("90000")}]},
        {"records": [{"id": "salary", "kind": "optional"}]},
        {
            "resolutions": [
                {
                    "conflictId": "missing",
                    "value": {"id": "report", "amount": "0.01", "status": "exact"},
                }
            ]
        },
        {
            "resolutions": [
                {
                    "conflictId": "conflict:salary:amount",
                    "value": {"id": "report", "date": "2026-09-20", "status": "exact"},
                }
            ]
        },
        {
            "conflicts": [
                {
                    "recordId": "missing",
                    "field": "amount",
                    "values": [{"id": "report", "amount": "0.01", "status": "exact"}],
                }
            ]
        },
        {
            "conflicts": [
                {
                    "recordId": "salary",
                    "field": "amount",
                    "values": [{"id": "report60", "amount": "70000", "status": "exact"}],
                }
            ]
        },
    ],
)
async def test_conflict_invalid_edits_are_atomic(store, changes):
    await salary_state(store)
    snapshot = await store.command(
        "owner",
        update(
            1,
            conflicts=[
                {
                    "recordId": "salary",
                    "field": "amount",
                    "values": [{"id": "report60", "amount": "60000", "status": "exact"}],
                }
            ],
        ),
    )
    with pytest.raises(Problem):
        await store.command("owner", update(2, **changes))
    assert await store.get("owner") == snapshot


async def test_full_replacement_cannot_create_clear_or_overwrite_conflicts(store):
    baseline = await salary_state(store)
    disputed = await store.command(
        "owner",
        update(
            1,
            conflicts=[
                {
                    "recordId": "salary",
                    "field": "amount",
                    "values": [{"id": "report60", "amount": "60000", "status": "exact"}],
                }
            ],
        ),
    )
    with pytest.raises(Problem):
        await store.command("owner", parsed_command(facts_input(baseline.facts), 2))
    replacement = facts_input(disputed.facts)
    replacement.records[0].amount = facts_input(baseline.facts).records[0].amount
    with pytest.raises(Problem):
        await store.command("owner", parsed_command(replacement, 2))
    assert await store.get("owner") == disputed
    deleted = await store.command("owner", update(2, records=[{"id": "salary", "delete": True}]))
    assert deleted.facts.conflicts == []
    assert all(item.id != "salary" for item in deleted.facts.records)


async def test_identical_reports_do_not_create_conflict_and_opening_dispute_has_null_balances(
    store,
):
    await salary_state(store)
    repeated = await store.command(
        "owner",
        update(
            1,
            conflicts=[
                {
                    "recordId": "salary",
                    "field": "amount",
                    "values": [{"id": "same", "amount": "50000", "status": "exact"}],
                }
            ],
        ),
    )
    assert repeated.facts.conflicts == []
    disputed = await store.command(
        "owner",
        update(
            2,
            conflicts=[
                {
                    "field": "opening",
                    "values": [{"id": "other", "amount": "2000", "status": "exact"}],
                }
            ],
        ),
    )
    assert disputed.facts.opening.amount_paise is None
    assert all(event.balance_paise is None for event in disputed.plan.events)
    assert all(
        result(disputed, item).amount_paise is None
        for item in ("opening", "closing", "trough", "firstGap", "peakGap", "reserveShortfall")
    )
    with pytest.raises(Problem):
        await store.command("owner", update(3, opening=money("2000")))


async def test_date_conflict_and_money_conflict_resolve_independently(store):
    await salary_state(store)
    disputed = await store.command(
        "owner",
        update(
            1,
            conflicts=[
                {
                    "recordId": "salary",
                    "field": "amount",
                    "values": [{"id": "amount", "amount": "60000", "status": "exact"}],
                },
                {
                    "recordId": "salary",
                    "field": "schedule.date",
                    "values": [{"id": "date", "date": "2026-09-21", "status": "exact"}],
                },
            ],
        ),
    )
    assert len(disputed.facts.conflicts) == 2
    resolved = await store.command(
        "owner",
        update(
            2,
            resolutions=[
                {
                    "conflictId": "conflict:salary:schedule.date",
                    "value": {"id": "date", "date": "2026-09-21", "status": "exact"},
                }
            ],
        ),
    )
    assert len(resolved.facts.conflicts) == 1
    assert resolved.facts.records[0].schedule.date == date(2026, 9, 21)
    assert resolved.facts.records[0].amount.amount_paise is None


@pytest.mark.parametrize("kind", ["income", "essential"])
async def test_approximate_dates_qualify_outflows_and_never_assure_receipts(store, kind):
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        parsed_command(
            facts(
                "100",
                [
                    record(
                        "item",
                        kind,
                        "200",
                        "2026-09-20",
                        schedule={"date": "2026-09-20", "certainty": "estimate"},
                    )
                ],
            )
        ),
    )
    assert snapshot.plan.projection_partial
    assert snapshot.plan.decision_assessment.outcome.readiness == "qualified"
    assert snapshot.plan.events[0].included is (kind == "essential")
    assert snapshot.plan.reliable_income_paise == 0
    if kind == "income":
        assert snapshot.plan.uncertain_income_paise == 20000
        assert snapshot.plan.income_comparisons
    exact = await store.command(
        "owner",
        update(
            1, records=[{"id": "item", "schedule": {"date": "2026-09-20", "certainty": "exact"}}]
        ),
    )
    assert exact.plan.events[0].included


async def test_merge_needs_compatible_duplicate_confirmation_and_preserves_debt_fields(store):
    await store.create("owner")
    initial = await store.command(
        "owner",
        parsed_command(
            facts(
                "0",
                [
                    record(
                        "a",
                        "debt",
                        "100",
                        "2026-09-20",
                        debtType="card",
                        target=money("200"),
                        outstanding=money("1000"),
                    ),
                    record(
                        "b",
                        "debt",
                        "100",
                        "2026-09-20",
                        debtType="card",
                        target=money("200"),
                        outstanding=money("1000"),
                    ),
                ],
            )
        ),
    )
    merged = await store.command(
        "owner",
        update(
            1,
            merges=[
                {
                    "sourceId": "b",
                    "targetId": "a",
                    "confirmed": True,
                    "reason": "Same card statement entered twice",
                }
            ],
        ),
    )
    assert merged.facts.records == initial.facts.records[:1]
    assert merged.plan.outflow_paise == 20000
    assert any(item.state == "merged" for item in merged.latest_change.items)


@pytest.mark.parametrize(
    "difference",
    [
        {"amount": money("101")},
        {"schedule": {"date": "2026-09-21"}},
        {"kind": "essential", "debtType": None},
    ],
)
async def test_incompatible_merge_is_rejected_without_summing_or_guessing(store, difference):
    await store.create("owner")
    initial = await store.command(
        "owner",
        parsed_command(
            facts(
                "0",
                [
                    record("a", "debt", "100", "2026-09-20"),
                    {**record("b", "debt", "100", "2026-09-20"), **difference},
                ],
            )
        ),
    )
    with pytest.raises(Problem):
        await store.command(
            "owner",
            update(
                1,
                merges=[
                    {"sourceId": "b", "targetId": "a", "confirmed": True, "reason": "duplicate"}
                ],
            ),
        )
    assert await store.get("owner") == initial


async def test_empty_intake_no_placeholder_cards_cash_only_is_qualified_and_coverage_not_assumed(
    store,
):
    empty = await store.create("owner")
    assert empty.workspace.cards == []
    snapshot = await store.command("owner", update(0, opening=money("5000")))
    assert [card.id for card in snapshot.workspace.cards] == ["cash"]
    assert snapshot.plan.decision_assessment.outcome.readiness == "qualified"
    assert len(snapshot.workspace.questions) <= 3
    assert len(snapshot.workspace.actions) <= store.config.workspace_max_actions


async def test_evidence_uses_same_day_max_earliest_and_peak_not_sum(store):
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        parsed_command(
            facts(
                "100",
                [
                    record("rent", "essential", "200", "2026-09-15"),
                    record("emi", "debt", "300", "2026-09-15"),
                    record("salary", "income", "1000", "2026-09-20"),
                ],
                reserve="50",
            )
        ),
    )
    assert result(snapshot, "firstGap").amount_paise == 40000
    assert result(snapshot, "firstGap").date == date(2026, 9, 15)
    assert result(snapshot, "peakGap").amount_paise == 40000
    assert result(snapshot, "closing").amount_paise == 60000
    assert result(snapshot, "reserveShortfall").amount_paise == 5000
    assert "NotSum" in result(snapshot, "peakGap").rule
    assert "sameDayOutflowBeforeIncome" in result(snapshot, "firstGap").assumptions
    contributions = {item.id: item for item in snapshot.workspace.contributions}
    assert contributions["event:rent:2026-09-15"].references
    assert all(
        identity in contributions
        for item in snapshot.workspace.results
        for identity in item.contribution_ids + item.excluded_ids
    )


async def test_later_cut_preserves_early_gap_and_correction_invalidates_assumptions(
    store,
):
    baseline = await salary_state(store)
    proposal = await store.command(
        "owner",
        operation(
            baseline,
            "previewAdjustments",
            adjustments=[{"eventId": "gym:2026-09-25", "amount": "0"}],
        ),
    )
    assert (
        result(proposal, "proposal:firstGap").amount_paise
        == result(proposal, "firstGap").amount_paise
    )
    assert (
        result(proposal, "proposal:peakGap").amount_paise
        == result(proposal, "peakGap").amount_paise
    )
    accepted = await store.command(
        "owner",
        operation(
            proposal,
            "acceptPreview",
            previewId=str(proposal.preview.id),
            confirmed=True,
            consentScope="unconditional",
        ),
    )
    assert accepted.facts == baseline.facts
    assert any(
        card.id == "proposal" and card.state == "accepted" for card in accepted.workspace.cards
    )
    corrected = await store.command(
        "owner", update(accepted.revision, records=[{"id": "gym", "amount": money("900")}])
    )
    assert corrected.accepted is None
    assert corrected.invalidated_assumptions[0].event_id == "gym:2026-09-25"
    assert corrected.facts.records[-1].amount.amount_paise == 90000
    assert any(
        card.id == "proposal" and card.state == "unresolved" for card in corrected.workspace.cards
    )


async def test_rejection_is_not_discard_and_matching_proposal_is_not_resuggested(store):
    baseline = await salary_state(store)
    inputs = [{"eventId": "gym:2026-09-25", "amount": "0"}]
    preview = await store.command(
        "owner", operation(baseline, "previewAdjustments", adjustments=inputs)
    )
    discarded = await store.command(
        "owner", operation(preview, "discardPreview", previewId=str(preview.preview.id))
    )
    assert not discarded.rejected_proposals
    preview = await store.command(
        "owner", operation(discarded, "previewAdjustments", adjustments=inputs)
    )
    rejected = await store.command(
        "owner", operation(preview, "rejectPreview", previewId=str(preview.preview.id))
    )
    assert rejected.facts.records == baseline.facts.records
    assert rejected.preview is None and rejected.accepted is None
    assert rejected.rejected_proposals
    assert any(item.state == "rejected" for item in rejected.latest_change.items)
    assert not any(choice.event_ids == ["gym:2026-09-25"] for choice in rejected.workspace.choices)
    with pytest.raises(Problem, match="explicitly rejected"):
        await store.command("owner", operation(rejected, "previewAdjustments", adjustments=inputs))


async def test_workspace_and_latest_change_rehydrate_without_trusting_cached_cards(store):
    await salary_state(store)
    corrected = await store.command(
        "owner", update(1, records=[{"id": "salary", "amount": money("60000")}])
    )
    payload = corrected.model_dump(mode="json", by_alias=True)
    payload["workspace"] = {"forged": True}
    loaded, _ = store.load_snapshot(json.dumps(payload))
    assert loaded.workspace == corrected.workspace
    store.clock = lambda: NOW + timedelta(hours=18)
    refreshed = await store.get("owner")
    assert refreshed.latest_change == corrected.latest_change
    assert refreshed.workspace.change == corrected.workspace.change
    restart = Store(store.path, store.config, store.clock)
    await restart.open()
    try:
        assert (await restart.get("owner")).workspace == refreshed.workspace
    finally:
        await restart.close()


async def test_http_and_sse_receive_identical_workspace_for_shared_update(live_server):  # noqa: F811
    client, _, _ = live_server
    await client.post("/api/session", json={})
    async with client.stream("GET", "/api/session/events") as response:
        lines = response.aiter_lines()
        assert json.loads((await frame(lines)).split("data: ")[1])["workspace"]["cards"] == []
        request = update(
            0,
            opening=money("1000"),
            records=[
                {
                    "kind": "income",
                    "label": "Salary",
                    "amount": money("50000"),
                    "schedule": {"date": "2026-09-20"},
                    "reliability": "reliable",
                }
            ],
        )
        changed = await client.post(
            "/api/session/commands",
            json=request.model_dump(mode="json", by_alias=True, exclude_unset=True),
        )
        assert changed.status_code == 200
        assert json.loads((await frame(lines)).split("data: ")[1]) == changed.json()
        assert (await client.get("/api/session")).json()["workspace"] == changed.json()["workspace"]


@pytest.mark.parametrize(
    "changes",
    [
        {"merges": [{"sourceId": "a", "targetId": "b", "confirmed": False, "reason": "same"}]},
        {
            "conflicts": [
                {
                    "recordId": "a",
                    "field": "amount",
                    "values": [
                        {"id": "one", "amount": "0.01", "status": "exact"},
                        {"id": "two", "amount": "0.01", "status": "exact"},
                    ],
                }
            ]
        },
        {
            "conflicts": [
                {"field": "opening", "values": [{"id": "one", "amount": "-1", "status": "exact"}]}
            ]
        },
        {
            "conflicts": [
                {
                    "recordId": "a",
                    "field": "amount",
                    "values": [{"id": "one", "date": "2026-09-20", "status": "exact"}],
                }
            ]
        },
    ],
)
def test_lifecycle_schema_rejects_unconfirmed_or_invalid_values(changes):
    with pytest.raises(ValidationError):
        update(0, **changes)


async def test_duplicate_record_updates_or_oversized_conflicts_do_not_commit(store):
    baseline = await salary_state(store)
    for changes in (
        {
            "records": [
                {"id": "salary", "amount": money("60000")},
                {"id": "salary", "amount": money("70000")},
            ]
        },
        {
            "conflicts": [
                {
                    "recordId": "salary",
                    "field": "amount",
                    "values": [
                        {
                            "id": "large",
                            "amount": str(store.config.max_money_paise // 100 + 1),
                            "status": "exact",
                        }
                    ],
                }
            ]
        },
        {
            "merges": [
                {
                    "sourceId": "missing",
                    "targetId": "salary",
                    "confirmed": True,
                    "reason": "same receipt",
                }
            ]
        },
    ):
        with pytest.raises(Problem):
            await store.command("owner", update(1, **changes))
        assert await store.get("owner") == baseline


async def test_rehydration_rejects_orphan_conflict_metadata(store):
    await salary_state(store)
    disputed = await store.command(
        "owner",
        update(
            1,
            conflicts=[
                {
                    "recordId": "salary",
                    "field": "amount",
                    "values": [{"id": "other", "amount": "60000", "status": "exact"}],
                }
            ],
        ),
    )
    payload = disputed.model_dump(mode="json", by_alias=True)
    payload["facts"]["records"] = [
        item for item in payload["facts"]["records"] if item["id"] != "salary"
    ]
    with pytest.raises(Problem) as error:
        store.load_snapshot(json.dumps(payload))
    assert error.value.body.code == "invalidStoredState"


async def test_merge_fills_only_unknown_fields_and_never_moves_consent(store):
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "0",
                [
                    record("a", "optional", "100", "2026-09-20"),
                    {
                        **record("b", "optional", "100", "2026-09-20"),
                        "amount": money(None, "unknown"),
                    },
                ],
            )
        ),
    )
    preview = await store.command(
        "owner",
        operation(
            baseline, "previewAdjustments", adjustments=[{"eventId": "a:2026-09-20", "amount": "0"}]
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
    merged = await store.command(
        "owner",
        update(
            accepted.revision,
            merges=[
                {
                    "sourceId": "a",
                    "targetId": "b",
                    "confirmed": True,
                    "reason": "Same gym membership",
                }
            ],
        ),
    )
    assert merged.accepted is None
    assert merged.facts.records[0].id == "b"
    assert merged.facts.records[0].amount.amount_paise == 10000
    assert merged.plan.outflow_paise == 10000
    assert merged.invalidated_assumptions[0].event_id == "a:2026-09-20"


async def test_unrelated_cash_correction_retains_consent_and_clear_keeps_facts(store):
    baseline = await salary_state(store)
    preview = await store.command(
        "owner",
        operation(
            baseline,
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
    corrected = await store.command("owner", update(accepted.revision, opening=money("2000")))
    assert corrected.accepted.adjustments == accepted.accepted.adjustments
    assert corrected.invalidated_assumptions == []
    assert not any(item.state == "invalidated" for item in corrected.latest_change.items)
    cleared = await store.command("owner", operation(corrected, "clearAccepted"))
    assert cleared.accepted is None
    assert cleared.facts == corrected.facts


async def test_sparse_date_and_conflict_bounds_and_proposal_evidence(store):
    baseline = await salary_state(store)
    preview = await store.command(
        "owner",
        operation(
            baseline,
            "previewAdjustments",
            adjustments=[{"eventId": "gym:2026-09-25", "amount": "0"}],
        ),
    )
    assert result(preview, "impact:firstGap").amount_paise == 0
    assert result(preview, "impact:closing").amount_paise == 100000
    assert result(preview, "impact:closing").result_ids == ["closing", "proposal:closing"]
    assert "salary:2026-09-20" not in result(preview, "firstGap").event_ids
    contributions = {
        item.event_id: item for item in baseline.workspace.contributions if item.event_id
    }
    assert all(
        contributions[event.id].balance_paise == event.balance_paise
        for event in baseline.plan.events
    )
    unknown = await store.command(
        "owner", update(baseline.revision, records=[{"id": "salary", "schedule": {"date": None}}])
    )
    assert unknown.facts.records[0].schedule.certainty == "unknown"
    exact = await store.command(
        "owner",
        update(unknown.revision, records=[{"id": "salary", "schedule": {"date": "2026-09-20"}}]),
    )
    assert exact.facts.records[0].schedule.certainty == "exact"


async def test_replayed_sparse_command_rebuilds_workspace_after_restart(store):
    await store.create("owner")
    request = update(0, opening=money("1000"))
    saved = await store.command("owner", request)
    restart = Store(store.path, store.config, store.clock)
    await restart.open()
    try:
        assert await restart.command("owner", request) == saved
        request.operation.changes.opening.amount = "2000"
        with pytest.raises(Problem) as error:
            await restart.command("owner", request)
        assert error.value.body.code == "commandConflict"
        assert await restart.get("owner") == saved
    finally:
        await restart.close()


async def test_approximate_outflow_outside_horizon_cannot_assert_no_earlier_obligation(store):
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record(
                        "rent",
                        "essential",
                        "2000",
                        "2026-10-12",
                        schedule={"date": "2026-10-12", "certainty": "estimate"},
                    )
                ],
            )
        ),
    )
    assert snapshot.plan.events == []
    assert snapshot.plan.projection_partial
    assert not snapshot.plan.budget_basis.dated_projection_complete
    assert snapshot.plan.decision_assessment.outcome.readiness == "qualified"
    assert any(item.code == "uncertainDate" for item in snapshot.plan.issues)


async def test_first_gap_witness_precedes_same_day_income_and_opening_can_be_trough(store):
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        parsed_command(
            facts(
                "100",
                [
                    record("rent", "essential", "200", "2026-09-15"),
                    record("salary", "income", "300", "2026-09-15"),
                ],
            )
        ),
    )
    assert result(snapshot, "firstGap").witness_event_ids == ["rent:2026-09-15"]
    assert result(snapshot, "closing").amount_paise == 20000
    snapshot = await store.command("owner", update(1, records=[{"id": "rent", "delete": True}]))
    assert result(snapshot, "trough").date == snapshot.anchor_date
    assert result(snapshot, "trough").witness_event_ids == []


async def test_questions_are_live_bounded_and_unavailable_conflicts_remain_visible(store):
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        update(
            0,
            opening=money("100", "estimate"),
            records=[
                {
                    "kind": "essential",
                    "label": f"Bill {index}",
                    "schedule": {"date": "2026-09-20"},
                    "conflicts": [
                        {
                            "field": "amount",
                            "values": [
                                {"id": "a", "amount": "100", "status": "exact"},
                                {"id": "b", "amount": "200", "status": "estimate"},
                            ],
                        }
                    ],
                }
                for index in range(5)
            ],
        ),
    )
    assert len(snapshot.workspace.questions) == 3
    assert "opening" in {item.id for item in snapshot.workspace.issues}
    assert "opening" not in {item.id for item in snapshot.workspace.questions}
    conflicts = {item.id for item in snapshot.facts.conflicts}
    assert conflicts <= {item.id for item in snapshot.workspace.issues}
    assert conflicts <= {
        identity for card in snapshot.workspace.cards for identity in card.issue_ids
    }
    action_ids = {item.id for item in snapshot.workspace.actions}
    assert all(item.action_id in action_ids for item in snapshot.workspace.questions)
    question = snapshot.workspace.questions[1]
    assert question.action_id != snapshot.plan.decision_assessment.next_action_id
    answered = await store.command(
        "owner",
        operation(
            snapshot,
            "respondToAction",
            actionId=question.action_id,
            response="unavailable",
        ),
    )
    assert question.id not in {item.id for item in answered.workspace.questions}
    assert question.id in {item.id for item in answered.workspace.issues}
    assert conflicts <= {
        identity for card in answered.workspace.cards for identity in card.issue_ids
    }
    with pytest.raises(Problem) as error:
        await store.command(
            "owner",
            operation(
                answered,
                "respondToAction",
                actionId=question.action_id,
                response="unavailable",
            ),
        )
    assert error.value.body.code == "invalidActionResponse"
    with pytest.raises(Problem) as error:
        await store.command(
            "owner",
            operation(
                snapshot,
                "respondToAction",
                actionId=question.action_id,
                response="unavailable",
            ),
        )
    assert error.value.body.code == "staleRevision"


async def test_response_rejects_action_outside_current_workspace_bound(store):
    store.config = store.config.model_copy(update={"workspace_max_actions": 1})
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        parsed_command(
            facts(
                "100",
                [
                    record("a", "essential", "100", None),
                    record("b", "essential", "200", None),
                ],
            )
        ),
    )
    hidden = snapshot.plan.decision_assessment.actions[1]
    assert hidden.id not in {item.id for item in snapshot.workspace.actions}
    with pytest.raises(Problem) as error:
        await store.command(
            "owner",
            operation(
                snapshot,
                "respondToAction",
                actionId=hidden.id,
                response="unavailable",
            ),
        )
    assert error.value.body.code == "invalidActionResponse"
    assert await store.get("owner") == snapshot


async def test_exact_same_day_witness_contributions_and_exclusion_reasons(store):
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        parsed_command(
            facts(
                "0",
                [
                    record("emi", "debt", "6000", "2026-09-15"),
                    record("salary", "income", "10000", "2026-09-15"),
                    record("bonus", "income", "100", "2026-09-16", reliability="uncertain"),
                    record("rent", "essential", "100", None),
                    record("future", "essential", "100", "2026-10-20"),
                ],
                reserve="500",
            )
        ),
    )
    for identity in ("firstGap", "peakGap", "trough", "reserveShortfall"):
        trace = result(snapshot, identity)
        assert trace.contribution_ids == ["opening", "event:emi:2026-09-15"]
        assert trace.witness_event_ids == ["emi:2026-09-15"]
        assert trace.excluded_reasons == {
            "event:salary:2026-09-15": "afterResultPoint",
            "event:bonus:2026-09-16": "conditionalReceipt",
            "record:rent": "unknownDate",
            "record:future": "outsideHorizon",
        }
    assert result(snapshot, "firstGap").amount_paise == 600000
    assert result(snapshot, "peakGap").amount_paise == 600000
    assert result(snapshot, "closing").amount_paise == 400000
    assert result(snapshot, "closing").contribution_ids == [
        "opening",
        "event:emi:2026-09-15",
        "event:salary:2026-09-15",
    ]
    assert result(snapshot, "opening").state == "known"
    assert result(snapshot, "closing").state == "uncertain"
    conditional = result(snapshot, "income:reportedDate:firstGap")
    assert conditional.event_ids == ["emi:2026-09-15"]
    assert (
        conditional.excluded_reasons["income:reportedDate:event:salary:2026-09-15"]
        == "afterResultPoint"
    )
    assert all(
        set(item.excluded_ids) == item.excluded_reasons.keys()
        for item in snapshot.workspace.results
    )


async def test_opening_trough_trace_and_estimated_result_certainty(store):
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        parsed_command(
            {
                **facts(
                    "100",
                    [
                        record("salary", "income", "1000", "2026-09-15"),
                    ],
                    reserve="200",
                ),
                "opening": money("100", "estimate"),
            }
        ),
    )
    for identity in ("trough", "reserveShortfall"):
        assert result(snapshot, identity).contribution_ids == ["opening"]
        assert result(snapshot, identity).witness_event_ids == []
        assert result(snapshot, identity).excluded_reasons == {
            "event:salary:2026-09-15": "afterResultPoint"
        }
    assert result(snapshot, "opening").state == "estimated"
    assert result(snapshot, "closing").state == "estimated"


async def test_nested_new_partial_conflict_is_atomic_and_preserves_certainty(store):
    await store.create("owner")
    request = update(
        0,
        opening=money("1000"),
        records=[
            {
                "kind": "income",
                "label": "Salary",
                "amount": money(None, "unknown"),
                "schedule": {"date": "2026-09-20", "certainty": "estimate"},
                "reliability": "reliable",
                "conflicts": [
                    {
                        "field": "amount",
                        "values": [
                            {"id": "salary50", "amount": "50000.01", "status": "estimate"},
                            {"id": "salary60", "amount": "60000", "status": "exact"},
                        ],
                    }
                ],
            },
            {
                "kind": "essential",
                "label": "Rent",
                "amount": money("10000"),
                "schedule": {"date": "2026-09-15"},
            },
        ],
    )
    snapshot = await store.command("owner", request)
    assert await store.command("owner", request) == snapshot
    assert len(snapshot.facts.records) == 2
    salary = snapshot.facts.records[0]
    conflict = snapshot.facts.conflicts[0]
    assert conflict.record_id == salary.id
    assert salary.amount.status == "unknown" and salary.amount.amount_paise is None
    assert salary.schedule.date == date(2026, 9, 20)
    assert {item.amount_paise for item in conflict.values} == {5000001, 6000000}
    assert snapshot.plan.reliable_income_paise == 0
    assert snapshot.plan.outflow_paise == 1000000
    resolved = await store.command(
        "owner",
        update(
            1,
            records=[{"id": salary.id, "schedule": {"date": "2026-09-21"}}],
            resolutions=[
                {
                    "conflictId": conflict.id,
                    "value": {
                        "id": "salary50",
                        "amount": "50000.01",
                        "status": "estimate",
                    },
                }
            ],
        ),
    )
    assert resolved.facts.records[0].amount.status == "estimate"
    assert resolved.facts.records[0].amount.amount_paise == 5000001
    assert resolved.facts.records[0].schedule.date == date(2026, 9, 21)
    assert resolved.plan.reliable_income_paise == 0
    assert resolved.plan.uncertain_income_paise == 5000001
    assert await store.get("owner") == resolved


@pytest.mark.parametrize("field", ["amount", "schedule.date"])
async def test_saved_estimates_survive_report_and_resolution_with_unrelated_edits(store, field):
    await store.create("owner")
    await store.command(
        "owner",
        parsed_command(
            facts(
                "100",
                [
                    {
                        **record(
                            "rent",
                            "essential",
                            "200",
                            "2026-09-15",
                            schedule={"date": "2026-09-15", "certainty": "estimate"},
                        ),
                        "amount": money("200", "estimate"),
                    }
                ],
            )
        ),
    )
    candidate = {
        "id": "other",
        "status": "exact",
        **({"amount": "300"} if field == "amount" else {"date": "2026-09-16"}),
    }
    disputed = await store.command(
        "owner",
        update(
            1,
            records=[
                {
                    "id": "rent",
                    "label": "Home rent",
                    "conflicts": [
                        {"field": field, "values": [candidate]},
                    ],
                }
            ],
        ),
    )
    saved = disputed.facts.conflicts[0].values[0]
    assert saved.status == "estimate"
    value = {
        "id": saved.id,
        "status": saved.status,
        **({"amount": "200"} if field == "amount" else {"date": "2026-09-15"}),
    }
    for incorrect in (
        candidate | {"amount": "301"} if field == "amount" else candidate | {"date": "2026-09-17"},
    ):
        with pytest.raises(Problem):
            await store.command(
                "owner",
                update(
                    2,
                    resolutions=[
                        {
                            "conflictId": disputed.facts.conflicts[0].id,
                            "value": incorrect,
                        }
                    ],
                ),
            )
        assert await store.get("owner") == disputed
    resolved = await store.command(
        "owner",
        update(
            2,
            records=[{"id": "rent", "label": "House rent"}],
            resolutions=[{"conflictId": disputed.facts.conflicts[0].id, "value": value}],
        ),
    )
    assert resolved.facts.records[0].amount.status == "estimate"
    assert resolved.facts.records[0].schedule.certainty == "estimate"


@pytest.mark.parametrize(
    "field,value",
    [
        ("amount", {"amount": None, "status": "unknown"}),
        ("amount", {"amount": "100", "status": "unknown"}),
        ("amount", {"amountPaise": 10000, "status": "exact"}),
        ("schedule.date", {"date": None, "status": "exact"}),
    ],
)
def test_conflict_inputs_require_concrete_rupees_or_date_with_certainty(field, value):
    with pytest.raises(ValidationError):
        update(
            0,
            records=[
                {
                    "kind": "essential",
                    "label": "Rent",
                    "conflicts": [
                        {"field": field, "values": [{"id": "report", **value}]},
                    ],
                }
            ],
        )


async def test_same_field_overlap_rejected_but_other_field_report_is_atomic(store):
    baseline = await salary_state(store)
    report = {
        "recordId": "salary",
        "field": "amount",
        "values": [
            {"id": "other", "amount": "60000", "status": "exact"},
        ],
    }
    with pytest.raises(Problem):
        await store.command(
            "owner",
            update(
                1,
                records=[{"id": "salary", "amount": money("55000")}],
                conflicts=[report],
            ),
        )
    assert await store.get("owner") == baseline
    disputed = await store.command(
        "owner",
        update(
            1,
            records=[{"id": "salary", "schedule": {"date": "2026-09-21"}}],
            conflicts=[report],
        ),
    )
    assert disputed.facts.records[0].schedule.date == date(2026, 9, 21)
    assert disputed.facts.records[0].amount.amount_paise is None
    assert {item.amount_paise for item in disputed.facts.conflicts[0].values} == {5000000, 6000000}


async def test_rejected_choice_uses_terms_dependencies_not_amount_only(store):
    baseline = await salary_state(store)
    preview = await store.command(
        "owner",
        operation(
            baseline,
            "previewAdjustments",
            adjustments=[{"eventId": "gym:2026-09-25", "amount": "0"}],
        ),
    )
    rejected = await store.command(
        "owner", operation(preview, "rejectPreview", previewId=str(preview.preview.id))
    )
    unchanged = await store.command(
        "owner", update(rejected.revision, records=[{"id": "gym", "label": "Fitness"}])
    )
    assert unchanged.rejected_proposals
    assert not any(choice.event_ids == ["gym:2026-09-25"] for choice in unchanged.workspace.choices)
    changed = await store.command(
        "owner",
        update(
            unchanged.revision,
            records=[
                {"id": "gym", "schedule": {"recurrence": "monthly"}},
            ],
        ),
    )
    assert not changed.rejected_proposals
    assert any(choice.event_ids == ["gym:2026-09-25"] for choice in changed.workspace.choices)
    carried = changed.model_copy(update={"rejected_proposals": rejected.rejected_proposals})
    assert any(
        choice.event_ids == ["gym:2026-09-25"] for choice in project(carried, store.config).choices
    )
    impact = next(
        item
        for item in changed.workspace.results
        if item.id.startswith("choice:") and item.id.endswith(":impact:firstGap")
    )
    assert impact.amount_paise == 0
    assert any("adjustmentAmounts" in ref for ref in impact.dependencies)
