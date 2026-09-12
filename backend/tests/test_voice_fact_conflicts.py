# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.decisions import action_dependency_key
from app.facts import facts_input, merge_facts
from app.finance import normalize
from app.models import Command, Decision, FactsInput, FactsPatch
from app.voice_tools import VoiceTools, canonical

from .conftest import facts, money, parsed_command, record
from .test_action_responses import response_command
from .test_decision_priorities import next_action
from .test_finance import project
from .test_scenarios import operation


def loans():
    """Build two similarly named loans and a focused optional purchase decision."""
    return facts(
        "50000",
        [
            record("first", "debt", "2000", "2026-09-14", label="Loan"),
            record("second", "debt", "3000", "2026-09-20", label="Loan"),
            record("phone", "optional", "5000", "2026-09-21"),
        ],
        decision={
            "intent": "specificDecision",
            "focusRecordIds": ["phone"],
            "concern": "Can I buy the phone?",
            "responsePreference": "brief",
        },
    )


@pytest.mark.parametrize("identities", [["first"], ["first", "first"]])
def test_ambiguous_candidates_require_multiple_distinct_ids(identities):
    """Verify ambiguous record candidates require at least two distinct identities."""
    with pytest.raises(ValidationError, match="at least two distinct"):
        Decision(ambiguous_record_ids=identities)


def test_normalize_rejects_unknown_ambiguous_candidate(config):
    """Verify normalization rejects ambiguous candidates absent from the facts."""
    data = loans()
    data["decision"]["ambiguousRecordIds"] = ["first", "missing"]
    with pytest.raises(ValueError, match="Ambiguous correction must reference existing records"):
        normalize(FactsInput.model_validate(data), config)


async def test_ambiguous_target_persists_cards_and_qualified_stop_then_targeted_clear(store):
    """Verify ambiguous targets persist until explicitly cleared with a targeted correction."""
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(loans()))
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {"expectedRevision": 1, "decision": {"ambiguousRecordIds": ["first", "second"]}},
        "ambiguous-loan",
    )
    assert "code" not in result
    saved = await store.get("owner")
    assert saved.facts.records == baseline.facts.records
    assert saved.plan.events == baseline.plan.events
    assert result["snapshot"]["facts"]["decision"]["ambiguousRecordIds"] == ["first", "second"]
    assert result["activeAssessment"]["nextQuestionId"] == "recordIdentity"
    issue = next(
        u for u in saved.plan.decision_assessment.uncertainties if u.id == "recordIdentity"
    )
    assert issue.kind == "conflict" and issue.field == "recordIdentity"
    assert issue.blocks == ["immediateDecision", "fullPlan"]
    assert issue.question.startswith("Which") and issue.question.count("?") == 1
    assert "2026-09-14" in issue.question and "2026-09-20" in issue.question
    assert saved.plan.decision_assessment.outcome.branch == "conflict"
    assert "fit" not in saved.plan.decision_assessment.outcome.summary.lower()

    await store.close()
    await store.open()
    assert await store.get("owner") == saved
    unavailable = await store.command("owner", response_command(saved, "unavailable"))
    assert next_action(unavailable.plan).kind == "reviewOutcome"
    assert unavailable.plan.decision_assessment.outcome.branch == "conflict"
    assert unavailable.plan.decision_assessment.outcome.readiness == "qualified"
    assert "fit" not in canonical(unavailable)["outcome"]["summary"]

    unrelated = await tools.invoke(
        "update_facts", {"expectedRevision": 3, "opening": money("51000")}, "cash-correction"
    )
    assert "code" not in unrelated
    assert unrelated["snapshot"]["facts"]["decision"]["ambiguousRecordIds"] == ["first", "second"]
    assert unrelated["currentAction"]["kind"] == "reviewOutcome"
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 4,
            "decision": {"ambiguousRecordIds": []},
            "records": [{"id": "first", "amount": money("2400")}],
        },
        "identified-loan",
    )
    assert "code" not in result
    corrected = await store.get("owner")
    assert corrected.facts.records[0].amount.amount_paise == 240000
    assert corrected.facts.records[1:] == baseline.facts.records[1:]
    assert corrected.facts.decision.ambiguous_record_ids == []
    assert corrected.facts.decision.focus_record_ids == ["phone"]
    assert corrected.facts.decision.concern == baseline.facts.decision.concern
    assert corrected.facts.decision.response_preference == "brief"
    assert corrected.plan.outflow_paise == 1040000
    assert not any(
        u.field == "recordIdentity" for u in corrected.plan.decision_assessment.uncertainties
    )
    assert corrected.plan.decision_assessment.outcome.branch == "fits"


@pytest.mark.parametrize("change", ["amount", "date", "candidates"])
def test_ambiguous_question_dependency_tracks_candidate_values_and_set(config, change):
    """Verify ambiguity dependencies track candidate values and membership, not labels or order."""
    data = loans()
    data["decision"]["ambiguousRecordIds"] = ["first", "second"]
    source = normalize(FactsInput.model_validate(data), config)
    key = action_dependency_key(source, project(data), "clarify:recordIdentity")
    data["decision"]["ambiguousRecordIds"].reverse()
    data["records"][0]["label"] = "Vehicle loan"
    assert (
        action_dependency_key(
            normalize(FactsInput.model_validate(data), config),
            project(data),
            "clarify:recordIdentity",
        )
        == key
    )
    if change == "amount":
        data["records"][0]["amount"] = money("2400")
    elif change == "date":
        data["records"][0]["schedule"]["date"] = "2026-09-15"
    else:
        data["decision"]["ambiguousRecordIds"] = ["first", "phone"]
    assert (
        action_dependency_key(
            normalize(FactsInput.model_validate(data), config),
            project(data),
            "clarify:recordIdentity",
        )
        != key
    )


async def test_candidate_correction_without_explicit_clear_reopens_unavailable_question(store):
    """Verify candidate corrections reopen identity questions unless ambiguity is cleared."""
    await store.create("owner")
    data = loans()
    data["decision"]["ambiguousRecordIds"] = ["first", "second"]
    saved = await store.command("owner", parsed_command(data))
    unavailable = await store.command("owner", response_command(saved, "unavailable"))
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": unavailable.revision,
            "records": [{"id": "first", "amount": money("2400")}],
        },
        "amount-only",
    )
    assert "code" not in result
    assert result["activeAssessment"]["nextQuestionId"] == "recordIdentity"
    assert result["snapshot"]["facts"]["decision"]["ambiguousRecordIds"] == ["first", "second"]


def test_candidate_deletion_requires_explicit_conflict_replacement_or_clear(config):
    """Verify deleting an ambiguous candidate requires explicit conflict replacement or clearing."""
    data = loans()
    data["decision"]["ambiguousRecordIds"] = ["first", "second"]
    source = normalize(FactsInput.model_validate(data), config)
    patch = {"expectedRevision": 0, "records": [{"id": "first", "delete": True}]}
    with pytest.raises(ValueError, match="explicitly replacing or clearing"):
        merge_facts(source, FactsPatch.model_validate(patch), uuid4())
    patch["decision"] = {"ambiguousRecordIds": []}
    result = normalize(merge_facts(source, FactsPatch.model_validate(patch), uuid4()), config)
    assert result.decision.ambiguous_record_ids == []
    assert {item.id for item in result.records} == {"second", "phone"}
    assert facts_input(source).decision.ambiguous_record_ids == ["first", "second"]


async def test_ambiguous_write_and_clear_preserve_independent_consent(store):
    """Verify reporting and clearing loan ambiguity preserve independent purchase consent."""
    await store.create("owner")
    await store.command("owner", parsed_command(loans()))
    preview = await store.command(
        "owner",
        Command.model_validate(
            operation(
                "previewAdjustments",
                1,
                adjustments=[{"eventId": "phone:2026-09-21", "amount": "0"}],
            )
        ),
    )
    accepted = await store.command(
        "owner",
        Command.model_validate(operation("acceptPreview", 1, previewId=str(preview.preview.id))),
    )
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    await tools.update_facts(
        {"expectedRevision": 2, "decision": {"ambiguousRecordIds": ["first", "second"]}},
        "unidentified",
    )
    disputed = await store.get("owner")
    assert disputed.accepted.adjustments == accepted.accepted.adjustments
    assert disputed.accepted.plan.decision_assessment.outcome.branch == "conflict"
    await tools.update_facts(
        {
            "expectedRevision": 3,
            "decision": {"ambiguousRecordIds": []},
            "records": [{"id": "first", "amount": money("2400")}],
        },
        "identified",
    )
    corrected = await store.get("owner")
    assert corrected.accepted.adjustments == accepted.accepted.adjustments
    assert corrected.accepted.plan.outflow_paise == 540000


def test_explicit_clear_preserves_other_unknowns_and_untargeted_dates(config):
    """Verify clearing identity ambiguity preserves unrelated unknowns and untargeted records."""
    data = loans()
    data["decision"]["ambiguousRecordIds"] = ["first", "second"]
    data["records"][2]["schedule"]["date"] = None
    source = normalize(FactsInput.model_validate(data), config)
    result = merge_facts(
        source,
        FactsPatch.model_validate(
            {
                "expectedRevision": 0,
                "decision": {"ambiguousRecordIds": []},
                "records": [{"id": "second", "amount": money("3500")}],
            }
        ),
        uuid4(),
    )
    plan = project(result.model_dump(mode="json", by_alias=True))
    # Cash covers every payment, so the unknown date stays a recorded uncertainty, not a question.
    assert [item.id for item in plan.decision_assessment.uncertainties] == ["phone:schedule.date"]
    assert plan.decision_assessment.next_question_id is None
    assert plan.decision_assessment.outcome.branch == "uncertain"
    assert normalize(result, config).records[0] == source.records[0]
    assert normalize(result, config).records[2] == source.records[2]


async def test_unavailable_focused_scope_is_not_reopened_by_unneeded_income(store):
    """Verify unneeded income does not reopen an unavailable focused-scope question."""
    await store.create("owner")
    data = loans()
    # Undiscussed income is asked first by design; this test targets the other categories.
    data["coverage"] = {"income": "none"}
    saved = await store.command("owner", parsed_command(data))
    assert next_action(saved.plan).id == "clarify:coverage"
    unavailable = await store.command("owner", response_command(saved, "unavailable"))
    assert next_action(unavailable.plan).kind == "reviewOutcome"
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 2,
            "coverage": {"income": "unknown"},
            "records": [{"kind": "income", "label": "Bonus", "amount": money("1000")}],
        },
        "unneeded-income",
    )
    assert "code" not in result
    assert result["currentAction"]["kind"] == "reviewOutcome"
    assert result["activeAssessment"]["nextQuestionId"] is None
    assert result["outcome"]["readiness"] == "qualified"
    assert "fit" not in result["outcome"]["summary"]
