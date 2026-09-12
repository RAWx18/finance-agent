# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.models import FactsPatch
from app.voice_tools import VoiceTools

from .conftest import facts, money, parsed_command, record
from .test_decision_priorities import next_action


async def test_provider_retraction_preserves_dues_other_reports_and_replay(store):
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record("rent", "essential", "2000", "2026-09-14", label="Rent"),
                    record("other", "essential", "100", "2026-09-22", label="Rent"),
                ],
                providerResponses=[
                    {
                        "eventId": "rent:2026-09-14",
                        "status": "declined",
                        "reportedOn": "2026-09-11",
                    },
                    {
                        "eventId": "other:2026-09-22",
                        "status": "awaiting",
                        "reportedOn": "2026-09-11",
                    },
                ],
            )
        ),
    )
    assert next_action(baseline.plan).kind == "seekSupport"
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    arguments = {"expectedRevision": 1, "removeProviderResponseIds": ["rent:2026-09-14"]}
    result = await tools.invoke("update_facts", arguments, "retract")
    assert "code" not in result
    corrected = await store.get("owner")
    assert corrected.facts.provider_responses == baseline.facts.provider_responses[1:]
    assert corrected.facts.records == baseline.facts.records
    assert corrected.plan.events == baseline.plan.events
    assert corrected.plan.first_gap.date == date(2026, 9, 14)
    assert corrected.plan.first_gap.amount_paise == 100000
    assert next_action(corrected.plan).kind == "contactPayee"
    assert next_action(corrected.plan).record_ids == ["rent"]
    assert "declined flexibility" not in result["spokenBrief"]
    assert (corrected.revision, corrected.sequence) == (2, 2)
    assert await tools.invoke("update_facts", arguments, "retract") == result
    assert await store.get("owner") == corrected
    repeated = await tools.invoke(
        "update_facts", {**arguments, "expectedRevision": 2}, "already-retracted"
    )
    assert "code" not in repeated
    assert (await store.get("owner")).facts == corrected.facts


@pytest.mark.parametrize(
    "identity", ["rent", "Rent", "rent:*", "rent:2026-09-15", "other:2026-09-14"]
)
async def test_provider_retraction_requires_exact_existing_occurrence(store, identity):
    await store.create("owner")
    baseline = await store.command(
        "owner", parsed_command(facts("1000", [record("rent", "essential", "2000", "2026-09-14")]))
    )
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {"expectedRevision": 1, "opening": money("1500"), "removeProviderResponseIds": [identity]},
        "invalid-retraction",
    )
    assert result["code"] == "invalidFacts"
    assert await store.get("owner") == baseline


async def test_provider_upsert_and_retraction_conflict_is_atomic(store):
    await store.create("owner")
    baseline = await store.command(
        "owner", parsed_command(facts("1000", [record("rent", "essential", "2000", "2026-09-14")]))
    )
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 1,
            "opening": money("1500"),
            "removeProviderResponseIds": ["rent:2026-09-14"],
            "providerResponses": [
                {"eventId": "rent:2026-09-14", "status": "declined", "reportedOn": "2026-09-11"}
            ],
        },
        "conflicting-report",
    )
    assert result["code"] == "invalidFacts"
    assert await store.get("owner") == baseline


def test_provider_retractions_are_optional_and_bounded():
    assert FactsPatch(expected_revision=0).remove_provider_response_ids == []
    with pytest.raises(ValidationError):
        FactsPatch.model_validate(
            {"expectedRevision": 0, "removeProviderResponseIds": ["rent:2026-09-14"] * 1001}
        )


@pytest.mark.parametrize("terms", [{}, {"debtType": "loan"}])
async def test_sparse_income_to_debt_and_cash_correction_commit_together(store, terms):
    await store.create("owner")
    baseline = await store.command(
        "owner", parsed_command(facts("1000", [record("transfer", "income", "2000", "2026-09-12")]))
    )
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 1,
            "opening": money("1500"),
            "records": [{"id": "transfer", "kind": "debt", **terms}],
        },
        "loan-not-income",
    )
    assert "code" not in result
    corrected = await store.get("owner")
    transfer = corrected.facts.records[0]
    assert transfer.id == baseline.facts.records[0].id
    assert transfer.amount == baseline.facts.records[0].amount
    assert transfer.schedule == baseline.facts.records[0].schedule
    assert transfer.reliability is None and transfer.kind == "debt"
    assert transfer.debt_type == terms.get("debtType", "unknown")
    assert transfer.controllability == "unknown"
    assert corrected.facts.coverage.income == corrected.facts.coverage.debt == "reported"
    assert corrected.plan.first_gap.date == date(2026, 9, 12)
    assert corrected.plan.first_gap.amount_paise == 50000
    assert corrected.plan.reliable_income_paise == 0
    assert corrected.facts.opening.amount_paise == 150000
    assert (corrected.revision, corrected.sequence) == (2, 2)


@pytest.mark.parametrize("terms", [{}, {"reliability": "reliable"}])
async def test_sparse_debt_to_income_clears_only_incompatible_carried_fields(store, terms):
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record(
                        "transfer",
                        "debt",
                        "2000",
                        "2026-09-12",
                        debtType="card",
                        target=money("2500"),
                        outstanding=money("7000"),
                        autoDebit=True,
                        controllability="committed",
                    )
                ],
            )
        ),
    )
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 1,
            "opening": money("1500"),
            "records": [{"id": "transfer", "kind": "income", **terms}],
        },
        "income-not-debt",
    )
    assert "code" not in result
    corrected = await store.get("owner")
    transfer = corrected.facts.records[0]
    assert transfer.id == baseline.facts.records[0].id
    assert transfer.amount == baseline.facts.records[0].amount
    assert transfer.schedule == baseline.facts.records[0].schedule
    assert transfer.kind == "income" and transfer.reliability == terms.get("reliability", "unknown")
    assert transfer.target is transfer.outstanding is None
    assert transfer.debt_type is transfer.controllability is None
    assert transfer.auto_debit is False
    assert corrected.facts.opening.amount_paise == 150000
    assert corrected.plan.outflow_paise == 0 and corrected.plan.first_gap is None
    assert corrected.plan.closing_paise == (350000 if terms else 150000)


@pytest.mark.parametrize(
    "kind,contradiction",
    [
        ("debt", {"reliability": "reliable"}),
        ("debt", {"debtType": None}),
        ("income", {"debtType": "loan"}),
        ("income", {"target": money("2500")}),
        ("income", {"outstanding": money("7000")}),
        ("income", {"autoDebit": True}),
        ("income", {"controllability": "controllable"}),
        ("income", {"reliability": None}),
    ],
)
async def test_category_corrections_never_erase_explicit_contradictory_input(
    store, kind, contradiction
):
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [record("transfer", "income" if kind == "debt" else "debt", "2000", "2026-09-12")],
            )
        ),
    )
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 1,
            "opening": money("1500"),
            "records": [{"id": "transfer", "kind": kind, **contradiction}],
        },
        "contradiction",
    )
    assert result["code"] == "invalidFacts"
    assert await store.get("owner") == baseline
