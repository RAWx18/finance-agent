# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.facts import conflict_value, merge_facts
from app.models import ConflictValueInput, FactsPatch
from app.voice_tools import VoiceTools

from .conftest import money


def test_conflict_input_converts_rupees_and_preserves_certainty():
    """Verify conflicts convert rupees, preserve certainty, and reject direct paise input."""
    value = ConflictValueInput.model_validate(
        {"id": "rent-7500", "amount": "7500.25", "status": "estimate"}
    )
    assert conflict_value(value).model_dump(mode="json", by_alias=True) == {
        "id": "rent-7500",
        "amountPaise": 750025,
        "date": None,
        "status": "estimate",
        "source": None,
    }
    with pytest.raises(ValidationError) as error:
        ConflictValueInput.model_validate(
            {"id": "rent-7500", "amountPaise": 750025, "status": "exact"}
        )
    assert [(item["loc"], item["type"]) for item in error.value.errors()] == [
        (("amountPaise",), "extra_forbidden")
    ]


@pytest.mark.parametrize("location", ["record", "topLevel"])
@pytest.mark.parametrize("status", ["exact", "estimate"])
async def test_rent_conflict_resolution_preserves_other_facts(store, location, status):
    """Verify rent conflict resolution persists the chosen amount and preserves other facts."""
    await store.create("owner")
    refreshed = []
    tools = VoiceTools(store, "owner", uuid4(), refreshed.append)
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 0,
            "opening": money("20000"),
            "records": [
                {
                    "kind": "essential",
                    "label": "Rent",
                    "amount": money("7000"),
                    "schedule": {
                        "date": "2026-09-15",
                        "recurrence": "monthly",
                        "certainty": "estimate",
                    },
                },
                {
                    "kind": "essential",
                    "label": "Groceries",
                    "amount": money("1000"),
                    "schedule": {"date": "2026-09-16"},
                },
            ],
        },
        "intake",
    )
    assert "code" not in result, result
    baseline = await store.get("owner")
    rent = baseline.facts.records[0]
    report = {
        "field": "amount",
        "values": [
            {"id": "rent-7000", "amount": "7000", "status": "exact"},
            {"id": "rent-7500", "amount": "7500", "status": status},
        ],
    }
    arguments = {"expectedRevision": baseline.revision}
    if location == "record":
        arguments["records"] = [{"id": rent.id, "conflicts": [report]}]
    else:
        arguments["conflicts"] = [{"recordId": rent.id, **report}]
    FactsPatch.model_validate(arguments)
    result = await tools.invoke("update_facts", arguments, "dispute")
    assert "code" not in result, result
    disputed = await store.get("owner")
    conflict = result["snapshot"]["facts"]["conflicts"][0]
    assert {(value["amountPaise"], value["status"]) for value in conflict["values"]} == {
        (700000, "exact"),
        (750000, status),
    }
    assert disputed.facts.records[0].amount.amount_paise is None
    assert disputed.facts.records[0].schedule == rent.schedule
    arguments = {
        "expectedRevision": disputed.revision,
        "resolutions": [
            {
                "conflictId": conflict["id"],
                "value": {"id": "rent-7500", "amount": "7500", "status": "exact"},
            }
        ],
    }
    patch = FactsPatch.model_validate(arguments)
    result = await tools.invoke("update_facts", arguments, "confirm")
    if "code" in result:
        merge_facts(disputed.facts, patch, uuid4())
    assert "code" not in result, result
    saved = await store.get("owner")
    assert saved.revision == disputed.revision + 1
    assert saved.facts.conflicts == []
    assert saved.facts.opening == baseline.facts.opening
    assert saved.facts.records[0].amount.amount_paise == 750000
    assert saved.facts.records[0].amount.status == "exact"
    assert saved.facts.records[0].schedule == rent.schedule
    assert saved.facts.records[1:] == baseline.facts.records[1:]
    assert saved.plan.outflow_paise == 850000
    assert result["snapshot"] == saved.model_dump(mode="json", by_alias=True)
    assert refreshed[-1] == saved
    assert not any(
        item.record_ids == [rent.id] and item.field == "amount"
        for item in saved.plan.decision_assessment.uncertainties
    )
    await store.close()
    await store.open()
    assert await store.get("owner") == saved
