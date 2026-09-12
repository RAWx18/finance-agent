# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from uuid import uuid4

import pytest

from app.voice_tools import VoiceTools

from .conftest import facts, money, parsed_command, record


async def test_invalid_capture_explains_argument_paths_without_saving_or_echoing_input(store):
    """Verify invalid captures expose safe field errors and allow a corrected save."""
    baseline = await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {"expectedRevision": 0, "opening": {"amount": "private-invalid-value", "status": "exact"}},
        "invalid-capture",
    )
    assert result["code"] == "invalidFacts"
    assert result["message"].startswith("No changes saved.")
    assert result["fields"] == [
        {
            "path": "opening.amount",
            "reason": "string_too_long",
            "hint": "String should have at most 16 characters",
        }
    ]
    assert "private-invalid-value" not in str(result)
    assert await store.get("owner") == baseline
    repaired = await tools.invoke(
        "update_facts",
        {"expectedRevision": 0, "opening": {"amount": "10000", "status": "exact"}},
        "repaired-capture",
    )
    assert "code" not in repaired
    assert repaired["saved"] is True
    assert repaired["snapshot"]["facts"]["opening"]["amountPaise"] == 1000000
    assert repaired["snapshot"]["revision"] == 1


async def test_domain_validation_does_not_expose_internal_error_or_choose_an_identity(store):
    """Verify invalid record corrections preserve state without exposing internal errors."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {"expectedRevision": 0, "records": [{"id": "nonexistent", "label": "Wrong bill"}]},
        "unidentified-correction",
    )
    assert result["code"] == "invalidFacts"
    assert "nonexistent" not in str(result.get("snapshot"))
    assert (await store.get("owner")).revision == 0


@pytest.mark.parametrize("status", [False, True])
async def test_nested_money_repair_preserves_obligation_and_unknown_scope(store, status):
    """Reject nested money with precise repair guidance without changing the payment or scope."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "20000",
                [
                    record(
                        "loan",
                        "debt",
                        "10000",
                        "2026-09-15",
                        outstanding=money("500000"),
                    )
                ],
                coverage={
                    "income": "notDiscussed",
                    "essential": "notDiscussed",
                    "optional": "notDiscussed",
                    "debt": "reported",
                },
            )
        ),
    )
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": baseline.revision,
            "records": [
                {
                    "id": "loan",
                    "outstanding": {
                        "amount": money("600000"),
                        **({"status": "exact"} if status else {}),
                    },
                }
            ],
        },
        "nested-correction",
    )
    assert result["code"] == "invalidFacts"
    assert result["fields"][0] == {
        "path": "records.0.outstanding.amount",
        "reason": "string_type",
        "hint": "Use a decimal string or null for amount; put status beside amount, not inside it.",
    }
    if not status:
        assert result["fields"][1]["hint"] == "Field required"
    assert "600000" not in str(result)
    await tools.invoke("read_state", {}, "read-after-rejection")
    assert await store.get("owner") == baseline
    repaired = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": baseline.revision,
            "records": [{"id": "loan", "outstanding": money("600000")}],
        },
        "repaired-correction",
    )
    assert repaired["saved"]
    current = await store.get("owner")
    assert current.revision == baseline.revision + 1
    assert current.facts.records[0].outstanding.amount_paise == 60000000
    assert current.facts.records[0].amount == baseline.facts.records[0].amount
    assert current.facts.coverage == baseline.facts.coverage
    assert current.plan.events == baseline.plan.events
    assert current.plan.closing_paise == baseline.plan.closing_paise


async def test_unexpected_value_error_keeps_private_details_out_of_repair_hint(store, monkeypatch):
    """Unexpected failures must not expose arbitrary exception messages as repair instructions."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)

    async def fail(owner):
        """Simulate an unexpected failure carrying private implementation details."""
        raise ValueError("private-storage-value")

    monkeypatch.setattr(store, "get", fail)
    result = await tools.invoke("read_state", {}, "private-failure")
    assert result["code"] == "invalidFacts"
    assert result["fields"] == []
    assert "private-storage-value" not in str(result)


SALARY_TURN = "My salary of 30000 comes on the 25th of September and it's monthly."


async def test_schema_validator_rejection_names_the_rule_and_repair_commits(store):
    """A model-validator rejection must state its rule so the retained write can be repaired."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    tools.user_turn = SALARY_TURN
    salary = {
        "kind": "income",
        "label": "Salary",
        "amount": {"amount": "30000", "status": "exact"},
        "reliability": "reliable",
    }
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 0,
            "records": [
                {
                    **salary,
                    "schedule": {
                        "date": "2026-09-25",
                        "recurrence": "monthly",
                        "pattern": {"kind": "dayOfMonth", "day": 25},
                    },
                }
            ],
        },
        "salary-pattern",
    )
    assert result["saved"] is False
    assert result["code"] == "invalidFacts"
    assert result["fields"] == [
        {
            "path": "records.0.schedule",
            "reason": "value_error",
            "hint": "A monthly pattern cannot also supply a date, certainty or finite sequence",
        }
    ]
    assert result["financialWrite"]["status"] == "rejected"
    assert (await store.get("owner")).revision == 0
    repaired = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 0,
            "records": [{**salary, "schedule": {"date": "2026-09-25", "recurrence": "monthly"}}],
            "retryWriteId": result["financialWrite"]["writeId"],
        },
        "salary-repaired",
    )
    assert repaired["saved"] is True
    assert repaired["financialWrite"]["status"] == "committed"
    assert repaired["financialWrite"]["receipt"]["revision"] == 1
    current = await store.get("owner")
    assert current.revision == 1
    assert repaired["snapshot"]["revision"] == 1
    assert [record.label for record in current.facts.records] == ["Salary"]
    assert current.plan.reliable_income_paise == 3000000


async def test_merged_record_rejection_names_the_rule_without_saving(store):
    """A rejection found only after merging into saved facts must still name the violated rule."""
    baseline = await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    tools.user_turn = SALARY_TURN
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 0,
            "records": [
                {
                    "kind": "income",
                    "label": "Salary",
                    "amount": {"amount": "30000", "status": "exact"},
                    "schedule": {"date": "2026-09-25", "recurrence": "monthly"},
                    "reliability": "reliable",
                    "controllability": "committed",
                }
            ],
        },
        "salary-controllability",
    )
    assert result["saved"] is False
    assert result["code"] == "invalidFacts"
    assert result["message"] == (
        "Invalid financial fields; no changes saved. "
        "records.0: Controllability applies only to outflows"
    )
    assert "30000" not in result["message"]
    assert await store.get("owner") == baseline
