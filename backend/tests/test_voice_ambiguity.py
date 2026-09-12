# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from uuid import uuid4

import pytest

from app.voice_tools import VoiceTools

from .conftest import money


@pytest.mark.parametrize("label", ["Loan EMI", " loan emi ", "LOAN-EMI", "Ｌｏａｎ ＥＭＩ"])
async def test_repeated_or_conflicting_new_record_is_rejected_atomically(store, label):
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    await tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money("5000"),
            "records": [{"kind": "debt", "label": "Loan EMI", "amount": money("2000")}],
        },
        "reported",
    )
    baseline = await store.get("owner")
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 1,
            "opening": money("6000"),
            "records": [{"kind": "debt", "label": label, "amount": money("2500")}],
        },
        "ambiguous",
    )
    assert result["code"] == "invalidFacts"
    assert "separate" in result["message"]
    assert await store.get("owner") == baseline


async def test_same_turn_repetition_does_not_silently_add_two_payments(store):
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    baseline = await store.get("owner")
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 0,
            "records": [
                {"kind": "debt", "label": "Loan", "amount": money("2000")},
                {"kind": "debt", "label": "Loan", "amount": money("2500")},
            ],
        },
        "conflicting",
    )
    assert result["code"] == "invalidFacts"
    assert await store.get("owner") == baseline


async def test_explicit_separate_debt_and_targeted_unknown_correction_preserve_identity(store):
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 0,
            "opening": money("5000"),
            "records": [
                {"kind": "debt", "label": "Loan", "amount": money("2000")},
                {"kind": "debt", "label": "Loan", "amount": money("2000"), "distinct": True},
                {
                    "kind": "income",
                    "label": "Wages",
                    "amount": money("18000"),
                    "reliability": "uncertain",
                },
            ],
        },
        "separate-loans",
    )
    assert "code" not in result
    baseline = await store.get("owner")
    first, second, wages = baseline.facts.records
    assert first.id != second.id and wages.schedule.date is None
    assert baseline.plan.reliable_income_paise == 0
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 1,
            "records": [{"id": first.id, "amount": money(None, "unknown")}],
        },
        "disputed",
    )
    assert "code" not in result
    disputed = await store.get("owner")
    assert disputed.facts.records[0].amount.amount_paise is None
    assert disputed.facts.records[1:] == baseline.facts.records[1:]
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 2,
            "records": [{"id": first.id, "amount": money("2400"), "label": "Scooter loan"}],
        },
        "clarified",
    )
    assert "code" not in result
    clarified = await store.get("owner")
    assert len(clarified.facts.records) == 3
    assert clarified.facts.records[0].id == first.id
    assert clarified.facts.records[0].amount.amount_paise == 240000
    assert clarified.facts.records[1:] == baseline.facts.records[1:]


async def test_distinct_flag_does_not_authorize_a_correction(store):
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    await tools.update_facts(
        {
            "expectedRevision": 0,
            "records": [
                {"kind": "debt", "label": "Loan", "amount": money("2000")},
            ],
        },
        "reported",
    )
    baseline = await store.get("owner")
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 1,
            "records": [
                {"id": baseline.facts.records[0].id, "distinct": True, "amount": money("3000")},
            ],
        },
        "not-new",
    )
    assert result["code"] == "invalidFacts"
    assert await store.get("owner") == baseline
