# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date

import pytest

from app.finance import export_text
from app.models import Command
from app.store import owner_hash

from .conftest import command, facts, money, parsed_command, record
from .test_adjustments import adjusted, adjustment, options
from .test_finance import project
from .test_scenarios import initialize, operation, submit


def test_unknown_target_keeps_known_minimum_after_correcting_accepted_plan(client):
    data = facts(
        "100",
        [record("card", "debt", "500", "2026-09-12", debtType="card", target=money("1000"))],
    )
    initialize(client, data)
    preview = submit(
        client, "previewAdjustments", adjustments=[adjustment("card:2026-09-12", "500")]
    )
    submit(client, "acceptPreview", previewId=preview["preview"]["id"])
    data["records"][0]["target"] = money(None, "unknown")
    response = client.post("/api/session/commands", json=command(data, 2))
    assert response.status_code == 200
    snapshot = response.json()
    assert snapshot["preview"] is snapshot["accepted"] is None
    assert snapshot["facts"]["records"][0]["target"]["amountPaise"] is None
    plan = snapshot["plan"]
    assert plan["outflowPaise"] == 50000
    assert plan["closingPaise"] == -40000
    assert plan["firstGap"] == {"date": "2026-09-12", "amountPaise": 40000}
    assert plan["projectionPartial"] is True
    assert plan["events"][0]["amountBasis"] == "requiredOnly"
    exported = client.get("/api/session/export").text
    assert "required/minimum only; selected target unknown" in exported
    assert "First gap: none" not in exported


@pytest.mark.parametrize("status", ["exact", "estimate"])
def test_required_amount_is_retained_without_inventing_unknown_target(status):
    item = record("loan", "debt", "500", "2026-09-12", target=money(None, "unknown"))
    item["amount"] = money("500", status)
    plan = project(facts("100", [item]))
    assert plan.outflow_paise == 50000 and plan.peak_gap_paise == 40000
    assert plan.projection_partial
    assert any(issue.code == "requiredOnly" for issue in plan.issues)
    if status == "estimate":
        assert any(issue.code == "estimate" for issue in plan.issues)


def test_reserve_guidance_amount_belongs_to_first_breach_date():
    plan = project(
        facts(
            "1000",
            [
                record("rent", "essential", "600", "2026-09-12"),
                record("food", "essential", "300", "2026-09-18"),
            ],
            reserve="500",
        )
    )
    step = next(
        item for item in plan.decision_assessment.consequences if item.kind == "reserveBreach"
    )
    assert (step.date, step.amount_paise) == (date(2026, 9, 12), 10000)
    assert plan.reserve_shortfall_paise == 40000


def test_opening_reserve_guidance_uses_original_cash_basis_date():
    plan = project(facts("100", reserve="500"))
    step = next(
        item for item in plan.decision_assessment.consequences if item.kind == "reserveBreach"
    )
    assert (step.date, step.amount_paise) == (date(2026, 9, 11), 40000)


def test_zeroed_occurrence_is_not_a_remaining_commitment():
    data = facts(
        "1000",
        [
            record("optional", "optional", "100", "2026-09-12"),
            record("rent", "essential", "700", "2026-09-15"),
        ],
    )
    plan = adjusted(data, [adjustment("optional:2026-09-12")])
    assert plan.events[0].amount_paise == 0
    assert all(
        "optional:2026-09-12" not in item.event_ids for item in plan.decision_assessment.constraints
    )
    assert plan.decision_assessment.constraints[0].event_ids == ["rent:2026-09-15"]


@pytest.mark.parametrize("opening", ["0", "1000"])
def test_overdue_guidance_preserves_original_deadline(opening):
    plan = project(facts(opening, [record("rent", "essential", "100", "2026-09-10")]))
    event = plan.events[0]
    assert event.date == date(2026, 9, 11)
    assert event.original_due_date == date(2026, 9, 10) and event.overdue
    if plan.first_gap:
        action = next(
            item for item in plan.decision_assessment.actions if item.kind == "contactPayee"
        )
        assert action.before_date == date(2026, 9, 10)
        assert "overdue" in action.question and "promptly" in action.question


def test_zero_outstanding_requires_reconciliation_before_card_reduction():
    data = facts(
        "3000",
        [
            record(
                "card",
                "debt",
                "500",
                "2026-09-12",
                debtType="card",
                target=money("2000"),
                outstanding=money("0"),
            )
        ],
    )
    plan = project(data)
    assert any(issue.code == "debtBalanceConflict" for issue in plan.issues)
    assert plan.decision_assessment.outcome.branch == "conflict" and options(data) == []
    assert plan.outflow_paise == 200000
    assert plan.decision_assessment.next_question_id == "card:debtBalanceConflict"
    with pytest.raises(ValueError, match="not eligible"):
        adjusted(data, [adjustment("card:2026-09-12", "500")])


async def test_retained_baseline_recalculates_known_obligations_before_comparing(store):
    owner = owner_hash("retained-minimum")
    await store.create(owner)
    optional = record("optional", "optional", "50", "2026-09-13")
    data = facts(
        "100",
        [
            record(
                "card", "debt", "500", "2026-09-12", debtType="card", target=money(None, "unknown")
            ),
            optional,
        ],
    )
    snapshot = await store.command(owner, parsed_command(data))
    snapshot.plan = project(facts("100", [optional]))
    retained = snapshot.model_dump_json(by_alias=True)
    await store.connection().execute(
        "UPDATE sessions SET snapshot = ? WHERE owner = ?", (retained, owner)
    )
    await store.connection().commit()
    current = await store.get(owner)
    assert current.plan.outflow_paise == 55000
    assert current.revision == snapshot.revision and current.as_of == snapshot.as_of
    async with store.connection().execute(
        "SELECT snapshot FROM sessions WHERE owner = ?", (owner,)
    ) as cursor:
        assert (await cursor.fetchone())[0] == retained
    preview = await store.command(
        owner,
        Command.model_validate(
            operation("previewAdjustments", adjustments=[adjustment("optional:2026-09-13")])
        ),
    )
    assert preview.preview.reduced_outflow_paise == 5000
    assert preview.preview.plan.outflow_paise == 50000


@pytest.mark.parametrize("scenario_field", ["preview", "accepted"])
async def test_retained_scenarios_use_the_same_corrected_calculation(store, scenario_field):
    owner = owner_hash("retained-scenario")
    await store.create(owner)
    data = facts(
        "100",
        [
            record(
                "card", "debt", "500", "2026-09-12", debtType="card", target=money(None, "unknown")
            ),
            record("optional", "optional", "100", "2026-09-13"),
        ],
    )
    await store.command(owner, parsed_command(data))
    snapshot = await store.command(
        owner,
        Command.model_validate(
            operation("previewAdjustments", adjustments=[adjustment("optional:2026-09-13")])
        ),
    )
    if scenario_field == "accepted":
        snapshot = await store.command(
            owner,
            Command.model_validate(operation("acceptPreview", previewId=str(snapshot.preview.id))),
        )
    scenario = getattr(snapshot, scenario_field)
    scenario.plan = project(facts("100"))
    scenario.reduced_outflow_paise = 99999
    retained = snapshot.model_dump_json(by_alias=True)
    await store.connection().execute(
        "UPDATE sessions SET snapshot = ? WHERE owner = ?", (retained, owner)
    )
    await store.connection().commit()
    current = await store.get(owner)
    scenario = getattr(current, scenario_field)
    assert scenario.plan.outflow_paise == 50000 and scenario.plan.closing_paise == -40000
    assert scenario.reduced_outflow_paise == 10000
    assert current.revision == snapshot.revision and current.sequence == snapshot.sequence
    async with store.connection().execute(
        "SELECT snapshot FROM sessions WHERE owner = ?", (owner,)
    ) as cursor:
        assert (await cursor.fetchone())[0] == retained
    if scenario_field == "preview":
        assert "Accepted planning assumptions" not in export_text(current)
        current = await store.command(
            owner,
            Command.model_validate(operation("acceptPreview", previewId=str(scenario.id))),
        )
    exported = export_text(current)
    assert "required/minimum only; selected target unknown" in exported
    assert "planned outflows: INR -400.00" in exported
    assert "First gap: 2026-09-12, INR 400.00" in exported
