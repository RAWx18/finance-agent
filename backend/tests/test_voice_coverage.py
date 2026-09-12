# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from copy import deepcopy
from uuid import uuid4

import pytest

from app.models import Command
from app.voice_tools import TOOL_DEFINITIONS, VoiceTools, tool_parameters

from .conftest import money


@pytest.mark.parametrize("status", ["none", "reviewed"])
@pytest.mark.parametrize("evidence", [None, "", "I have no income."])
async def test_unsupported_scope_rejects_the_whole_voice_write(store, status, evidence):
    """An unmentioned category cannot become complete without current-turn evidence."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    tools.user_turn = "My rent is 30000 monthly. I have 10000. Other costs are not listed."
    before = await store.get("owner")
    arguments = {
        "expectedRevision": 0,
        "opening": money("10000"),
        "records": [{"kind": "essential", "label": "Rent", "amount": money("30000")}],
        "coverage": {"income": status},
    }
    if evidence is not None:
        arguments["coverageEvidence"] = {"income": evidence}
    stream = await store.subscribe("owner")
    await stream.get()
    try:
        result = await tools.invoke("update_facts", arguments, "unsupported")
        assert result.get("code") == "invalidFacts"
        assert "coverageEvidence.income" in result["message"]
        assert await store.get("owner") == before
        assert stream.empty()

        arguments.pop("coverageEvidence", None)
        arguments.pop("coverage")
        result = await tools.invoke("update_facts", arguments, "clear-facts")
        assert result["saved"] is True
        saved = await store.get("owner")
        assert saved.revision == 1
        assert saved.facts.opening.amount_paise == 1000000
        assert saved.facts.coverage.income == "notDiscussed"
        assert saved.facts.coverage.essential == "reported"
        assert saved.facts.records[0].schedule.date is None
        assert stream.get_nowait() == saved
    finally:
        store.unsubscribe("owner", stream)


async def test_explicit_scope_and_missing_date_commit_atomically_and_retry_once(store):
    """Complete category lists do not imply known dates or create persisted evidence fields."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    tools.user_turn = (
        "I have 6000. Rent is 2000, but I don't know its date. "
        "That is all my spending. No income or debts."
    )
    arguments = {
        "expectedRevision": 0,
        "opening": money("6000"),
        "records": [{"kind": "essential", "label": "Rent", "amount": money("2000")}],
        "coverage": {"income": "none", "essential": "reviewed", "optional": "none", "debt": "none"},
        "coverageEvidence": {
            "income": "NO INCOME OR DEBTS.",
            "essential": "That is all my spending.",
            "optional": "That is all my spending.",
            "debt": "No  income\n or debts.",
        },
    }
    original = deepcopy(arguments)
    result = await tools.invoke("update_facts", arguments, "intake")
    assert result.get("saved") is True, result
    assert arguments == original
    assert await tools.invoke("update_facts", arguments, "intake") == result
    saved = await store.get("owner")
    assert saved.revision == saved.sequence == 1
    assert saved.facts.coverage.model_dump() == arguments["coverage"]
    assert saved.facts.records[0].schedule.date is None
    assert saved.plan.projection_partial
    assert saved.plan.undated_impact.closing_paise == 400000
    assert "coverageEvidence" not in saved.model_dump_json(by_alias=True)

    tools.user_turn = "Rent is due September 15, 2026."
    correction = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 1,
            "records": [{"id": saved.facts.records[0].id, "schedule": {"date": "2026-09-15"}}],
        },
        "date",
    )
    assert correction["saved"] is True
    saved = await store.get("owner")
    assert saved.revision == 2
    assert saved.facts.coverage.model_dump() == arguments["coverage"]
    assert saved.plan.closing_paise == 400000
    assert saved.plan.decision_assessment.outcome.readiness == "ready"
    assert (
        next(item for item in saved.workspace.results if item.id == "closing").amount_paise
        == 400000
    )


async def test_scope_evidence_is_bound_to_the_current_completed_turn(store):
    """A quote from earlier speech cannot authorize category closure after interruption."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    arguments = {
        "expectedRevision": 0,
        "coverage": {"income": "none"},
        "coverageEvidence": {"income": "No income."},
    }
    for text in ("", "Actually, I do have income."):
        tools.user_turn = text
        result = await tools.invoke("update_facts", arguments, "stale")
        assert result.get("code") == "invalidFacts"
        assert (await store.get("owner")).revision == 0
    tools.user_turn = "No income."
    assert (await tools.invoke("update_facts", arguments, "current"))["saved"] is True


async def test_manual_scope_commands_do_not_require_voice_evidence(store):
    """Manual financial commands retain their existing public contract."""
    await store.create("owner")
    saved = await store.command(
        "owner",
        Command.model_validate(
            {
                "commandId": str(uuid4()),
                "expectedRevision": 0,
                "operation": {
                    "type": "updateFacts",
                    "changes": {"expectedRevision": 0, "coverage": {"income": "none"}},
                },
            }
        ),
    )
    assert saved.facts.coverage.income == "none"


def test_voice_schema_advertises_per_category_evidence():
    """The model receives the same evidence contract enforced by the voice write boundary."""
    model = next(model for name, model, _ in TOOL_DEFINITIONS if name == "update_facts")
    assert "coverageEvidence" in tool_parameters(model)["properties"]
