# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import json
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from app.models import FactsPatch
from app.voice_tools import TOOL_DEFINITIONS, VoiceTools, canonical, conversation, tool_parameters

from .conftest import facts, money, parsed_command, record


async def test_voice_and_consumers_share_one_workspace_for_multi_fact_corrections(store):
    """Verify multi-fact voice corrections publish the same workspace to all consumers."""
    initial = await store.create("owner")
    assert initial.workspace.cards == []
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    await tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money("5000"),
            "decision": {"concern": "I need to cover my rent before salary arrives."},
            "records": [
                {
                    "kind": "income",
                    "label": "Salary",
                    "amount": money("50000"),
                    "schedule": {"date": "2026-09-20"},
                    "reliability": "reliable",
                },
                {
                    "kind": "essential",
                    "label": "Rent",
                    "amount": money("15000"),
                    "schedule": {"date": "2026-09-15"},
                },
                {
                    "kind": "optional",
                    "label": "Gym",
                    "amount": money("1000"),
                    "schedule": {"date": "2026-09-25"},
                },
                {
                    "kind": "debt",
                    "label": "EMI",
                    "amount": money("3000"),
                    "debtType": "loan",
                    "schedule": {"date": None},
                },
            ],
        },
        "completed-intake",
    )
    baseline = await store.get("owner")
    salary, _, gym, emi = baseline.facts.records
    stream = await store.subscribe("owner")
    await stream.get()
    response = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": baseline.revision,
            "records": [
                {"id": salary.id, "amount": money("60000")},
                {"id": gym.id, "delete": True},
                {"id": emi.id, "schedule": {"date": "2026-09-18"}},
            ],
        },
        "completed-correction",
    )
    current = await store.get("owner")
    assert await stream.get() == current
    store.unsubscribe("owner", stream)
    assert response["snapshot"] == current.model_dump(mode="json", by_alias=True)
    assert response["workspace"] == response["snapshot"]["workspace"]
    assert response["workspace"] == canonical(current)["workspace"]
    assert current.plan.closing_paise == 4700000
    assert current.plan.first_gap.amount_paise == 1000000
    assert current.plan.peak_gap_paise == 1300000
    assert "optional" not in response["dialogue"]["sharedCardIds"]
    fields = [field for item in current.workspace.change.items for field in item.fields]
    assert any(
        field.reference.endswith("amount.amountPaise") and field.after == 6000000
        for field in fields
    )
    assert any(field.reference == "workspace.results.closing.amountPaise" for field in fields)


async def test_one_completed_turn_can_create_disputed_income_and_other_clear_facts(store):
    """Verify one turn saves disputed income alongside clear facts for later resolution."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    arguments = {
        "expectedRevision": 0,
        "opening": money("5000"),
        "records": [
            {
                "kind": "income",
                "label": "Salary",
                "reliability": "reliable",
                "schedule": {"date": "2026-09-20"},
                "conflicts": [
                    {
                        "field": "amount",
                        "values": [
                            {"id": "salary50", "amount": "50000", "status": "exact"},
                            {"id": "salary60", "amount": "60000", "status": "exact"},
                        ],
                    }
                ],
            },
            {
                "kind": "essential",
                "label": "Rent",
                "amount": money("15000"),
                "schedule": {"date": "2026-09-15"},
            },
        ],
    }
    response = await tools.invoke("update_facts", arguments, "disputed-intake")
    assert "code" not in response
    assert await tools.invoke("update_facts", arguments, "disputed-intake") == response
    disputed = await store.get("owner")
    assert len(disputed.facts.records) == 2
    assert disputed.facts.records[0].amount.amount_paise is None
    assert disputed.plan.reliable_income_paise == 0
    conflict = disputed.facts.conflicts[0]
    assert conflict.id in {item.id for item in disputed.workspace.questions}
    resolved = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": disputed.revision,
            "resolutions": [
                {
                    "conflictId": conflict.id,
                    "value": {"id": "salary60", "amount": "60000", "status": "exact"},
                },
            ],
        },
        "explicit-resolution",
    )
    assert not resolved["snapshot"]["facts"]["conflicts"]
    assert len(resolved["snapshot"]["facts"]["records"]) == 2
    results = {item["id"]: item for item in resolved["workspace"]["results"]}
    assert results["closing"]["amountPaise"] == 5000000
    assert results["firstGap"]["amountPaise"] == 1000000
    salary_event = f"event:{disputed.facts.records[0].id}:2026-09-20"
    assert salary_event not in results["firstGap"]["contributionIds"]
    assert results["firstGap"]["excludedReasons"][salary_event] == "afterResultPoint"
    assert results["firstGap"]["witnessEventIds"]


async def test_question_choice_is_bounded_and_unavailable_is_not_repeated(store):
    """Verify bounded question choices stop offering unavailable details without hiding issues."""
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record("rent", "essential", "15000", None),
                    record("emi", "debt", "3000", None),
                ],
            )
        ),
    )
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    offered = canonical(snapshot)
    questions = offered["dialogue"]["questionOptions"]
    assert len(questions) == 2
    assert "question" not in offered["dialogue"]
    question = questions[1]
    assert question["actionId"] != offered["currentAction"]["id"]
    response = await tools.invoke(
        "respond_to_action",
        {
            "expectedRevision": snapshot.revision,
            "actionId": question["actionId"],
            "response": "unavailable",
        },
        "explicit-cannot-check",
    )
    assert "code" not in response
    assert question["id"] not in {item["id"] for item in response["workspace"]["questions"]}
    assert question["id"] in {item["id"] for item in response["workspace"]["issues"]}
    assert response["snapshot"]["facts"]["records"][1]["schedule"]["date"] is None
    assert response["outcome"]["readiness"] == "qualified"


async def test_later_intake_questions_do_not_displace_help_for_the_current_gap(store):
    """Verify immediate gap guidance takes priority over later intake questions."""
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record("rent", "essential", "2000", "2026-09-12"),
                    record("trip", "optional", "500", None),
                ],
                # Undiscussed income is asked before any cut; the later intake here is other costs.
                coverage={"income": "none"},
                decision={"concern": "Rent is due before payday."},
            )
        ),
    )
    state = canonical(snapshot)
    assert state["currentAction"]["kind"] == "seekSupport"
    assert snapshot.workspace.questions
    assert state["dialogue"]["purpose"] == "explainNextStep"
    assert state["dialogue"]["questionOptions"] == []
    assert (
        state["workspace"]["questions"]
        == snapshot.workspace.model_dump(mode="json", by_alias=True)["questions"]
    )
    assert state["outcome"]["branch"] == "gap"
    assert state["outcome"]["readiness"] == "qualified"


async def test_read_workspace_is_single_snapshot_not_an_unbounded_options_fetch(store, monkeypatch):
    """Verify reading voice state returns a bounded workspace without scanning options."""
    await store.create("owner")
    monkeypatch.setattr(store, "options", AsyncMock(side_effect=AssertionError("No option scan")))
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    state = await tools.invoke("read_state", {}, "read")
    assert state["workspace"]["cards"] == []
    assert len(state["workspace"]["actions"]) <= store.config.workspace_max_actions
    assert "options" not in state
    assert "formatted" not in state
    store.options.assert_not_awaited()


async def test_repeated_facts_read_keeps_original_goal_and_revision(store):
    """Verify reading repeated facts preserves the saved goal and revision."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "5000",
                [record("rent", "essential", "7000", "2026-09-15")],
                decision={
                    "concern": "Help me cover rent before payday.",
                    "focusRecordIds": ["rent"],
                },
            )
        ),
    )
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke("read_state", {}, "repeated-amounts")
    assert result["snapshot"]["facts"]["decision"]["concern"] == baseline.facts.decision.concern
    assert await store.get("owner") == baseline


async def test_tool_failure_logs_type_without_private_arguments(store, monkeypatch, caplog):
    """Verify tool failures log their type without exposing private exception details."""
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    monkeypatch.setattr(
        store, "get", AsyncMock(side_effect=RuntimeError("private amount or token"))
    )
    result = await tools.invoke("read_state", {}, "failed-read")
    assert result["code"] == "voiceUnavailable"
    assert "tool=read_state exception=RuntimeError" in caplog.text
    assert "private amount or token" not in caplog.text
    assert "private amount or token" not in json.dumps(result)


async def test_explicit_proposal_rejection_is_not_discard_or_execution(store):
    """Verify explicit proposal rejection records refusal without executing adjustments."""
    await store.create("owner")
    await store.command(
        "owner",
        parsed_command(
            facts(
                "100",
                [
                    record("gym", "optional", "200", "2026-09-20"),
                ],
            )
        ),
    )
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    preview = await tools.invoke(
        "preview_adjustments",
        {"expectedRevision": 1, "adjustments": [{"eventId": "gym:2026-09-20", "amount": "0"}]},
        "hypothesis",
    )
    rejected = await tools.invoke(
        "reject_preview",
        {"expectedRevision": 1, "previewId": preview["snapshot"]["preview"]["id"]},
        "consumer-refusal",
    )
    assert "code" not in rejected
    assert rejected["snapshot"]["preview"] is None
    assert rejected["snapshot"]["accepted"] is None
    assert rejected["snapshot"]["facts"]["records"][0]["amount"]["amountPaise"] == 20000
    assert rejected["snapshot"]["rejectedProposals"]
    assert any(item["state"] == "rejected" for item in rejected["workspace"]["change"]["items"])


@pytest.mark.parametrize(
    "arguments",
    [
        {"expectedRevision": 0, "workspace": {"cards": []}},
        {"expectedRevision": 0, "plan": {"closingPaise": 1000000}},
        {"expectedRevision": 0, "opening": {"amountPaise": 1000000, "status": "exact"}},
        {"expectedRevision": 0, "decision": {"responses": []}},
    ],
)
async def test_model_cannot_write_authoritative_results_or_server_owned_decisions(store, arguments):
    """Verify tool inputs cannot overwrite authoritative results or server-owned decisions."""
    before = await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    response = await tools.invoke("update_facts", arguments, "invalid-authority")
    assert response["code"] == "invalidFacts"
    assert await store.get("owner") == before


def test_tool_contract_and_scope_separate_interpretation_from_financial_authority(config):
    """Verify tool schemas and guidance separate interpretation from financial authority."""
    schema = tool_parameters(FactsPatch)
    assert "$ref" not in json.dumps(schema)
    assert "amountPaise" not in json.dumps(schema)
    assert {"conflicts", "resolutions", "merges"} <= schema["properties"].keys()
    assert "conflicts" in schema["properties"]["records"]["items"]["properties"]
    names = {name for name, _, _ in TOOL_DEFINITIONS}
    assert {"reject_preview", "discard_preview", "update_facts", "review_plan"} <= names
    assert not names & {"calculate", "pay", "transfer", "set_total", "approve_loan"}
    prompt = conversation(config)
    assert "workspace.questions" in prompt and "workspace.results" in prompt
    assert "consumer sees workspace.cards" in prompt
    assert "financial engine identifies what matters" in prompt


async def test_omitted_date_certainty_never_promotes_an_estimate(store):
    """Verify date edits preserve estimated certainty until explicitly confirmed exact."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    response = await tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money("1000"),
            "records": [
                {
                    "kind": "income",
                    "label": "Salary",
                    "amount": money("10000"),
                    "reliability": "reliable",
                    "schedule": {"date": "2026-09-20", "certainty": "estimate"},
                },
            ],
        },
        "estimated-date",
    )
    record_id = response["snapshot"]["facts"]["records"][0]["id"]
    moved = await tools.update_facts(
        {
            "expectedRevision": 1,
            "records": [
                {"id": record_id, "schedule": {"date": "2026-09-21"}},
            ],
        },
        "date-without-certainty",
    )
    assert moved["snapshot"]["facts"]["records"][0]["schedule"]["certainty"] == "estimate"
    assert moved["activePlan"]["reliableIncomePaise"] == 1000000
    assert moved["activePlan"]["incomeComparisons"][0]["id"] == "income:withoutAssumed"
    confirmed = await tools.update_facts(
        {
            "expectedRevision": 2,
            "records": [
                {"id": record_id, "schedule": {"certainty": "exact"}},
            ],
        },
        "confirmed-date",
    )
    assert confirmed["activePlan"]["reliableIncomePaise"] == 1000000
    assert confirmed["activePlan"]["incomeComparisons"] == []
