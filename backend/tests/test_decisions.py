# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from copy import deepcopy
from datetime import date, timedelta
from uuid import uuid4

import pytest

from app.facts import facts_input
from app.models import Command, Snapshot
from app.voice_tools import VoiceTools, canonical

from .conftest import NOW, command, facts, money, parsed_command, record
from .test_adjustments import adjusted, adjustment
from .test_finance import project
from .test_scenarios import initialize, operation, submit


def september():
    return facts(
        "4000",
        [
            record("food", "essential", "2000", "2026-09-12", label="Food and work travel"),
            record(
                "rent",
                "essential",
                "8000",
                None,
                label="Rent",
                schedule={"date": "2026-09-14", "recurrence": "monthly"},
            ),
            record(
                "emi",
                "debt",
                "6000",
                None,
                label="EMI",
                autoDebit=True,
                schedule={"date": "2026-09-18", "recurrence": "monthly"},
            ),
            record(
                "salary",
                "income",
                "30000",
                None,
                label="Salary",
                schedule={"date": "2026-09-21", "recurrence": "monthly"},
            ),
            record(
                "card",
                "debt",
                "1000",
                "2026-09-24",
                debtType="card",
                target=money("5000"),
                outstanding=money("18000"),
            ),
            record("headphones", "optional", "2000", "2026-09-28"),
        ],
    )


def cuts():
    return [adjustment("headphones:2026-09-28"), adjustment("card:2026-09-24", "1000")]


def test_september_conclusion_and_provider_actions_not_late_cuts():
    plan = project(september())
    assert (plan.outflow_paise, plan.closing_paise) == (2300000, 1100000)
    assert (plan.first_gap.date, plan.first_gap.amount_paise) == (date(2026, 9, 14), 600000)
    assert (plan.peak_gap_date, plan.peak_gap_paise) == (date(2026, 9, 18), 1200000)
    assessment = plan.decision_assessment
    assert assessment.next_question_id == "provider:rent:2026-09-14"
    assert assessment.next_action_id == "contact:rent:2026-09-14"
    assert assessment.outcome.branch == "gap" and assessment.outcome.readiness == "qualified"
    truth = " ".join(assessment.outcome.true_now)
    assert "Rent" in truth and "EMI" in truth and "Salary on 2026-09-21" in truth
    actions = {
        item.record_ids[0]: item for item in assessment.actions if item.kind == "contactPayee"
    }
    for identity, day in [("rent", 14), ("emi", 18)]:
        action = actions[identity]
        assert action.before_date == date(2026, 9, day)
        assert "confirmed" in action.question and "cost" in action.question
        assert "auto-debit" in action.question and "without agreement" in action.question
        assert action.if_declined_consequence_ids == [f"cash:2026-09-{day}"]
    reductions = [item for item in assessment.choices if item.kind != "enquire"]
    assert len(reductions) == 2 and assessment.choices[0].kind == "enquire"
    assert all(
        item.later_only and not item.affects_first_gap and not item.affects_peak_gap
        for item in reductions
    )
    assert all(item.metrics.peak_gap_paise == 1200000 for item in reductions)
    reduced = adjusted(september(), cuts())
    assert (reduced.outflow_paise, reduced.closing_paise) == (1700000, 1700000)
    assert reduced.first_gap == plan.first_gap and reduced.peak_gap_paise == plan.peak_gap_paise


@pytest.mark.parametrize("with_cuts", [False, True])
def test_uncertain_income_joint_branches_use_reported_dates_and_same_kernel(with_cuts):
    data = september()
    data["records"][3]["reliability"] = "uncertain"
    plan = adjusted(data, cuts()) if with_cuts else project(data)
    assert plan.reliable_income_paise == 0
    assert len(plan.income_comparisons) == 2
    arrives, absent = plan.income_comparisons
    assert arrives.conditions[0].event_id == "salary:2026-09-21"
    assert arrives.metrics.closing_paise == (1700000 if with_cuts else 1100000)
    assert arrives.metrics.peak_gap_paise == 1200000
    assert arrives.metrics.first_gap.amount_paise == 600000
    assert absent.metrics.closing_paise == (-1300000 if with_cuts else -1900000)
    assert absent.metrics.peak_gap_paise == (1300000 if with_cuts else 1900000)
    assert absent.metrics.peak_gap_date == date(2026, 9, 24 if with_cuts else 28)
    assert plan.decision_assessment.next_question_id == "provider:rent:2026-09-14"
    assert any(
        item.date == date(2026, 9, 14) and item.kind == "cashExposure"
        for item in plan.decision_assessment.consequences
    )


@pytest.mark.parametrize("reliability,status", [("unknown", "exact"), ("reliable", "estimate")])
def test_amount_exactness_is_independent_from_assured_arrival(reliability, status):
    data = facts("0", [record("salary", "income", "30000", "2026-09-21", reliability=reliability)])
    data["records"][0]["amount"]["status"] = status
    plan = project(data)
    assert plan.reliable_income_paise == 0 and plan.closing_paise == 0
    assert plan.income_comparisons[0].metrics.closing_paise == 3000000
    assert plan.decision_assessment.outcome.readiness == "qualified"


def test_undated_rent_is_next_question_not_coverage_and_never_spendable():
    data = facts(
        "4000",
        [record("rent", "essential", "8000", None), record("salary", "income", "30000", None)],
    )
    data["coverage"]["optional"] = "notDiscussed"
    plan = project(data)
    assert plan.decision_assessment.next_question_id == "rent:schedule.date"
    assert not plan.budget_basis.dated_projection_complete
    assert {
        item.record_id: item.amount.amount_paise for item in plan.budget_basis.unresolved_amounts
    } == {"rent": 800000, "salary": 3000000}
    assert not plan.income_comparisons
    assert "prevent any available-to-spend" in " ".join(plan.decision_assessment.outcome.true_now)
    assert plan.decision_assessment.outcome.readiness == "qualified"


def test_unknown_amount_and_target_stay_explicit_without_erasing_minimum():
    data = facts(
        "100",
        [
            record(
                "card", "debt", "500", "2026-09-12", debtType="card", target=money(None, "unknown")
            ),
            record("food", "essential", "1", "2026-09-13"),
        ],
    )
    data["records"][1]["amount"] = money(None, "unknown")
    plan = project(data)
    assert plan.outflow_paise == 50000 and plan.first_gap.amount_paise == 40000
    assert {item.reason for item in plan.budget_basis.unresolved_amounts} == {
        "unknownTarget",
        "missingAmount",
    }
    assert not plan.budget_basis.dated_projection_complete


def test_same_day_consequences_group_obligations_not_arbitrary_payment_allocation():
    items = [
        record("a", "essential", "300", "2026-09-12"),
        record("z", "debt", "400", "2026-09-12", autoDebit=True),
    ]
    before = project(facts("500", items))
    items[0]["id"], items[1]["id"] = "z", "a"
    after = project(facts("500", items))
    assert before.decision_assessment.consequences == after.decision_assessment.consequences
    consequence = before.decision_assessment.consequences[0]
    assert consequence.event_ids == ["a:2026-09-12", "z:2026-09-12"]
    assert consequence.amount_paise == 20000
    same_day = project(
        facts(
            "0",
            [
                record("salary", "income", "10000", "2026-09-14"),
                record("rent", "essential", "6000", "2026-09-14"),
            ],
        )
    )
    assert same_day.closing_paise == 400000 and same_day.peak_gap_paise == 600000
    assert same_day.decision_assessment.outcome.branch == "gap"


def test_zero_outstanding_blocks_only_dependent_choice_and_payment_stays_due():
    data = september()
    data["records"][4]["outstanding"] = money("0")
    plan = project(data)
    assert plan.outflow_paise == 2300000
    assert plan.decision_assessment.next_question_id == "provider:rent:2026-09-14"
    conflict = next(
        item
        for item in plan.decision_assessment.uncertainties
        if item.id == "card:debtBalanceConflict"
    )
    assert conflict.blocks == ["fullPlan"]
    assert conflict.priority > next(
        item.priority
        for item in plan.decision_assessment.uncertainties
        if item.id == "provider:rent:2026-09-14"
    )
    assert not any(item.kind == "cardMinimum" for item in plan.decision_assessment.choices)
    assert any(item.kind == "reduceOptional" for item in plan.decision_assessment.choices)


@pytest.mark.parametrize("status", ["awaiting", "declined", "reportedTerms"])
def test_provider_reports_preserve_original_obligations_and_scoped_invalidation(client, status):
    baseline = initialize(client, september())
    data = september()
    data["providerResponses"] = [
        {
            "eventId": "rent:2026-09-14",
            "status": status,
            "reportedOn": "2026-09-11",
            "payment": money("2000"),
            "paymentDate": "2026-09-22",
            "cost": None,
        }
    ]
    response = client.post("/api/session/commands", json=command(data, 1))
    assert response.status_code == 200
    snapshot = response.json()
    assert snapshot["plan"]["events"] == baseline["plan"]["events"]
    assert snapshot["plan"]["firstGap"] == baseline["plan"]["firstGap"]
    saved = snapshot["facts"]["providerResponses"][0]
    assert saved["cost"] is None and len(saved["dependencyKey"]) == 64
    assessment = snapshot["plan"]["decisionAssessment"]
    if status != "reportedTerms":
        assert not any(
            item["recordIds"] == ["rent"] and item["kind"] == "contactPayee"
            for item in assessment["actions"]
        )
        assert assessment["nextQuestionId"] == "provider:emi:2026-09-18"
    else:
        assert any(
            item["kind"] == "verifyTerms" and "unknown cost" in item["question"]
            for item in assessment["actions"]
        )
    data["records"][3]["schedule"]["date"] = "2026-09-20"
    preserved = client.post("/api/session/commands", json=command(data, 2)).json()
    assert preserved["facts"]["providerResponses"] == snapshot["facts"]["providerResponses"]
    data["records"][1]["amount"] = money("8500")
    invalidated = client.post("/api/session/commands", json=command(data, 3)).json()
    assert invalidated["facts"]["providerResponses"] == []
    assert invalidated["plan"]["decisionAssessment"]["nextQuestionId"] == "provider:rent:2026-09-14"


@pytest.mark.parametrize("change", ["salary", "minimum", "autoDebit", "controllability", "date"])
def test_corrections_preserve_independent_acceptance_and_emit_invalidations(client, change):
    initialize(client, september())
    proposed = submit(client, "previewAdjustments", adjustments=cuts())
    accepted = submit(client, "acceptPreview", previewId=proposed["preview"]["id"])
    submit(client, "previewAdjustments", 2, adjustments=cuts())
    data = september()
    if change == "salary":
        data["records"][3]["schedule"]["date"] = "2026-09-13"
    elif change == "minimum":
        data["records"][4]["amount"] = money("1500")
    elif change == "autoDebit":
        data["records"][4]["autoDebit"] = True
    elif change == "controllability":
        data["records"][4]["controllability"] = "committed"
    else:
        data["records"][4]["schedule"]["date"] = "2026-09-25"
    response = client.post("/api/session/commands", json=command(data, 2))
    assert response.status_code == 200
    corrected = response.json()
    assert corrected["preview"] is None and corrected["accepted"] is not None
    assert corrected["anchorDate"] == accepted["anchorDate"]
    if change == "salary":
        assert corrected["invalidatedAssumptions"] == []
        assert corrected["accepted"]["adjustments"] == accepted["accepted"]["adjustments"]
        assert corrected["plan"]["firstGap"] is None
        assert corrected["plan"]["troughPaise"] == 200000
        assert corrected["accepted"]["plan"]["closingPaise"] == 1700000
        assert corrected["accepted"]["plan"]["decisionAssessment"]["outcome"]["branch"] == "fits"
    else:
        assert [item["eventId"] for item in corrected["accepted"]["adjustments"]] == [
            "headphones:2026-09-28"
        ]
        assert corrected["invalidatedAssumptions"][0]["eventId"] == "card:2026-09-24"
    assert client.get("/api/session").json() == corrected


def test_unknown_controllability_is_only_a_hypothesis_and_conditional_consent_rejected(client):
    data = september()
    data["records"][5]["controllability"] = "unknown"
    initialize(client, data)
    snapshot = submit(client, "previewAdjustments", adjustments=[cuts()[0]])
    proposal = snapshot["preview"]
    assert not proposal["adjustments"][0]["acceptanceReady"]
    response = client.post(
        "/api/session/commands", json=operation("acceptPreview", previewId=proposal["id"])
    )
    assert response.status_code == 409
    assert client.get("/api/session").json() == snapshot
    for consent in (
        {"confirmed": False},
        {"consentScope": "ifSalaryArrives"},
        {"confirmed": "true"},
    ):
        response = client.post(
            "/api/session/commands",
            json=operation("acceptPreview", previewId=proposal["id"], **consent),
        )
        assert response.status_code == 422


def test_irrelevant_details_do_not_drive_questions_and_brief_never_overrides_risk():
    data = september()
    data["records"].extend(
        [
            record("later", "optional", "1", "2026-10-11"),
            record("zero", "optional", "0", None),
        ]
    )
    data["records"][-2]["amount"] = money(None, "unknown")
    data["decision"] = {
        "intent": "specificDecision",
        "concern": "Keep this simple",
        "focusRecordIds": ["emi"],
        "responsePreference": "brief",
    }
    plan = project(data)
    assert plan.decision_assessment.next_question_id == "provider:rent:2026-09-14"
    assert plan.decision_assessment.outcome.branch == "gap"
    assert not any(
        set(item.record_ids) & {"zero", "later"} for item in plan.decision_assessment.uncertainties
    )
    assert plan.budget_basis.dated_projection_complete
    data["records"][3]["schedule"]["date"] = "2026-09-13"
    data["decision"]["intent"] = "plan30Days"
    fit = project(data)
    assert fit.decision_assessment.outcome.branch == "fits"
    assert fit.decision_assessment.next_question_id is None
    assert not fit.decision_assessment.choices


async def test_voice_full_proposal_path_corrections_and_canonical_schema(store):
    await store.create("owner")
    await store.command("owner", parsed_command(september()))
    refreshed = []
    tools = VoiceTools(store, "owner", uuid4(), refreshed.append)
    preview = await tools.invoke(
        "preview_adjustments", {"expectedRevision": 1, "adjustments": cuts()}, "preview"
    )
    assert preview["snapshot"]["accepted"] is None
    assert preview["activePlan"]["outflowPaise"] == 2300000
    preview_id = preview["snapshot"]["preview"]["id"]
    accepted = await tools.invoke(
        "accept_preview",
        {
            "expectedRevision": 1,
            "previewId": preview_id,
            "confirmed": True,
            "consentScope": "unconditional",
        },
        "accept",
    )
    assert accepted["activePlan"]["outflowPaise"] == 1700000
    corrected = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 2,
            "records": [{"id": "salary", "schedule": {"date": "2026-09-13"}}],
            "decision": {
                "intent": "specificDecision",
                "concern": "Will rent fit?",
                "focusRecordIds": ["rent"],
            },
        },
        "correction",
    )
    assert corrected["snapshot"]["facts"]["coverage"]["income"] == "reviewed"
    assert corrected["activePlan"]["firstGap"] is None
    assert len(corrected["snapshot"]["accepted"]["adjustments"]) == 2
    review = await tools.invoke("review_plan", {"expectedRevision": 3}, "review")
    assert review["outcome"] == corrected["outcome"]
    assert Snapshot.model_validate(review["snapshot"]) == await store.get("owner")
    original = await store.get("owner")
    assert facts_input(original.facts).decision == original.facts.decision
    assert canonical(original)["activeAssessment"] == review["activeAssessment"]
    preview = await tools.invoke(
        "preview_adjustments", {"expectedRevision": 3, "adjustments": cuts()}, "second"
    )
    discarded = await tools.invoke(
        "discard_preview",
        {"expectedRevision": 3, "previewId": preview["snapshot"]["preview"]["id"]},
        "discard",
    )
    assert discarded["snapshot"]["preview"] is None
    assert discarded["snapshot"]["accepted"] is not None
    cleared = await tools.invoke("clear_accepted", {"expectedRevision": 3}, "clear")
    assert cleared["snapshot"]["accepted"] is None
    assert cleared["activePlan"]["closingPaise"] == 1100000


async def test_voice_provider_and_decision_deep_merge_and_membership_coverage(store):
    await store.create("owner")
    await store.command("owner", parsed_command(september()))
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    first = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 1,
            "decision": {
                "intent": "specificDecision",
                "concern": "Rent first",
                "focusRecordIds": ["rent"],
            },
            "providerResponses": [
                {"eventId": "rent:2026-09-14", "status": "declined", "reportedOn": "2026-09-11"}
            ],
        },
        "report",
    )
    assert "code" not in first
    second = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 2,
            "decision": {"responsePreference": "brief"},
            "records": [{"id": "salary", "amount": money("31000")}],
        },
        "amount",
    )
    assert second["snapshot"]["facts"]["decision"]["concern"] == "Rent first"
    assert (
        second["snapshot"]["facts"]["providerResponses"]
        == first["snapshot"]["facts"]["providerResponses"]
    )
    assert second["snapshot"]["facts"]["coverage"]["income"] == "reviewed"
    third = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 3,
            "records": [{"kind": "income", "label": "Bonus", "amount": money("100")}],
        },
        "member",
    )
    assert third["snapshot"]["facts"]["coverage"]["income"] == "reported"
    assert (
        third["snapshot"]["facts"]["providerResponses"]
        == first["snapshot"]["facts"]["providerResponses"]
    )


async def test_historical_accepted_occurrence_retains_consent_not_fresh_retroactive_edit(store):
    await store.create("owner")
    data = facts("1000", [record("optional", "optional", "100", "2026-09-11")])
    await store.command("owner", parsed_command(data))
    preview = await store.command(
        "owner",
        Command.model_validate(
            operation("previewAdjustments", adjustments=[adjustment("optional:2026-09-11")])
        ),
    )
    accepted = await store.command(
        "owner",
        Command.model_validate(operation("acceptPreview", previewId=str(preview.preview.id))),
    )
    store.clock = lambda: NOW + timedelta(hours=18)
    data["opening"] = money("2000")
    corrected = await store.command("owner", parsed_command(data, 2))
    assert corrected.accepted.adjustments == accepted.accepted.adjustments
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    repeated = await tools.invoke(
        "preview_adjustments",
        {"expectedRevision": 3, "adjustments": [adjustment("optional:2026-09-11")]},
        "retain",
    )
    assert "code" not in repeated
    result = await tools.invoke(
        "accept_preview",
        {
            "expectedRevision": 3,
            "previewId": repeated["snapshot"]["preview"]["id"],
            "confirmed": True,
            "consentScope": "unconditional",
        },
        "accept",
    )
    assert result["snapshot"]["accepted"]["adjustments"][0]["acceptedRevision"] == 2
    invalid = await tools.invoke(
        "preview_adjustments",
        {"expectedRevision": 4, "adjustments": [adjustment("optional:2026-09-11", "50")]},
        "retroactive",
    )
    assert invalid["code"] == "invalidAdjustments"


def test_decision_focus_references_are_validated_atomically(client):
    baseline = initialize(client, september())
    data = deepcopy(september())
    data["decision"] = {"focusRecordIds": ["missing"]}
    response = client.post("/api/session/commands", json=command(data, 1))
    assert response.status_code == 422 and client.get("/api/session").json() == baseline


def test_proposal_explicitly_exposes_removal_of_retained_assumptions(client):
    initialize(client, september())
    preview = submit(client, "previewAdjustments", adjustments=cuts())
    accepted = submit(client, "acceptPreview", previewId=preview["preview"]["id"])
    replacement = submit(client, "previewAdjustments", 2, adjustments=[cuts()[0]])
    assert replacement["preview"]["removedAssumptionIds"] == ["card:2026-09-24"]
    assert replacement["accepted"] == accepted["accepted"]
    result = submit(client, "acceptPreview", 2, previewId=replacement["preview"]["id"])
    assert result["accepted"]["plan"]["closingPaise"] == 1300000


def test_supported_reductions_expose_first_gap_vs_peak_vs_later_impacts():
    data = facts(
        "100",
        [
            record("optional", "optional", "200", "2026-09-12"),
            record("rent", "essential", "300", "2026-09-15"),
        ],
    )
    plan = project(data)
    cut = next(item for item in plan.decision_assessment.choices if item.kind == "reduceOptional")
    assert cut.affects_first_gap and cut.affects_peak_gap and not cut.later_only
    assert cut.metrics.first_gap.date == date(2026, 9, 15)
    assert cut.metrics.peak_gap_paise == 20000
    assert not cut.prerequisite_ids
    data["records"][0]["schedule"]["date"] = "2026-09-16"
    plan = project(data)
    cut = next(item for item in plan.decision_assessment.choices if item.kind == "reduceOptional")
    assert not cut.affects_first_gap and cut.affects_peak_gap and not cut.later_only


@pytest.mark.parametrize(
    "responses",
    [
        [{"eventId": "missing", "status": "declined", "reportedOn": "2026-09-11"}],
        [{"eventId": "salary:2026-09-21", "status": "awaiting", "reportedOn": "2026-09-11"}],
        [{"eventId": "rent:2026-09-14", "status": "declined", "reportedOn": "2026-09-12"}],
        [{"eventId": "rent:2026-09-14", "status": "declined", "reportedOn": "2026-09-11"}] * 2,
    ],
)
def test_invalid_provider_evidence_is_atomic(client, responses):
    baseline = initialize(client, september())
    data = september()
    data["providerResponses"] = responses
    response = client.post("/api/session/commands", json=command(data, 1))
    assert response.status_code == 422
    assert client.get("/api/session").json() == baseline
