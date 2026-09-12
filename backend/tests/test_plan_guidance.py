# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date
from uuid import uuid4

import pytest

from app.decisions import UNAVAILABLE_ACTIONS
from app.finance import calculate, export_text
from app.voice_tools import VoiceTools, canonical

from .conftest import NOW, facts, money, parsed_command, record
from .test_action_responses import response_command
from .test_currency_conversion import foreign
from .test_decision_priorities import next_action
from .test_decisions import september
from .test_finite_schedules import variable


def optional_facts(budget):
    """Build an optional forecast that exceeds cash after a funded rent payment."""
    item = (
        record(
            "leisure",
            "optional",
            "6000",
            "2026-09-12",
            schedule={"date": "2026-09-12", "recurrence": "monthlyBudget"},
        )
        if budget
        else variable("optional", [money("2000"), money("1000")], date="2026-09-15")
        | {"id": "leisure", "label": "leisure"}
    )
    return facts(
        "10000" if budget else "5000",
        [record("rent", "essential", "8000" if budget else "4000", "2026-09-14"), item],
    )


@pytest.mark.parametrize(
    "rent,wages,peak,cut_peak",
    [("1000", "2000", 500000, 100000), ("8000", "9000", 800000, 800000)],
    ids=["peakRelief", "laterGapReliefWithUnchangedPeak"],
)
async def test_later_relief_follows_earlier_help_and_remains_consent_based(
    store, rent, wages, peak, cut_peak
):
    """Offer real later relief after earlier help is unavailable, without applying a cut."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "0",
                [
                    record("rent", "essential", rent, "2026-09-14"),
                    record("wages", "income", wages, "2026-09-15"),
                    record("purchase", "optional", "6000", "2026-09-16"),
                    record("salary", "income", "10000", "2026-09-16"),
                    record("food", "essential", "6000", "2026-09-18"),
                ],
            )
        ),
    )
    assert baseline.plan.first_gap.date == date(2026, 9, 14)
    assert baseline.plan.first_gap.amount_paise == int(rent) * 100
    assert (baseline.plan.peak_gap_paise, baseline.plan.closing_paise) == (peak, -100000)
    action = next_action(baseline.plan)
    assert action.kind in {"contactPayee", "seekSupport"} and action.record_ids == ["rent"]
    choice = next(
        c for c in baseline.plan.decision_assessment.choices if c.kind == "reduceOptional"
    )
    assert choice.metrics.first_gap == baseline.plan.first_gap
    assert (choice.metrics.peak_gap_paise, choice.metrics.closing_paise) == (cut_peak, 500000)
    assert not choice.affects_first_gap
    current = baseline
    deferred = set()
    for _ in range(3):
        action = next_action(current.plan)
        if action.kind not in UNAVAILABLE_ACTIONS:
            break
        assert action.id not in deferred
        deferred.add(action.id)
        current = await store.command("owner", response_command(current, "unavailable"))
    action = next_action(current.plan)
    assert action.kind == "previewChange" and action.choice_id == choice.id
    assert "consent" in action.question and "2026-09-14" in action.question
    assert canonical(current)["currentAction"]["id"] == action.id
    assert action.question in export_text(current)
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "preview_adjustments",
        {
            "expectedRevision": current.revision,
            "adjustments": [{"eventId": "purchase:2026-09-16", "amount": "0"}],
        },
        "preview-later-relief",
    )
    assert "code" not in result
    assert result["activePlan"]["closingPaise"] == -100000
    assert result["snapshot"]["preview"]["plan"]["closingPaise"] == 500000
    assert result["snapshot"]["accepted"] is None
    current = await store.command(
        "owner", response_command(await store.get("owner"), "declined", action.id)
    )
    assert all(a.id != action.id for a in current.plan.decision_assessment.actions)
    assert current.preview is current.accepted is None
    assert current.facts.decision.responses[-1].response == "declined"
    assert current.plan.events == baseline.plan.events
    assert current.facts.model_dump(exclude={"decision"}) == baseline.facts.model_dump(
        exclude={"decision"}
    )


async def test_cuts_after_all_gaps_are_not_promoted_after_help_is_deferred(store):
    """Do not present closing-only savings as relief for earlier funding gaps."""
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(september()))
    current = baseline
    for _ in range(3):
        if next_action(current.plan).kind not in UNAVAILABLE_ACTIONS:
            break
        current = await store.command("owner", response_command(current, "unavailable"))
    assert next_action(current.plan).kind == "reviewOutcome"
    cuts = [c for c in current.plan.decision_assessment.choices if c.kind != "enquire"]
    assert cuts and all(c.later_only for c in cuts)
    assert all(c.metrics.first_gap == baseline.plan.first_gap for c in cuts)
    assert all(c.metrics.peak_gap_paise == baseline.plan.peak_gap_paise for c in cuts)
    assert current.plan.events == baseline.plan.events
    assert current.preview is current.accepted is None


@pytest.mark.parametrize("statuses", [("declined", "awaiting"), ("declined", None), (None, None)])
async def test_grouped_dues_acknowledge_reports_without_allocating_payments(store, statuses):
    """Keep grouped exposure intact while reported provider states produce useful follow-ups."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record("rent", "essential", "6000", "2026-09-15", controllability="committed"),
                    record("loan", "debt", "3000", "2026-09-15"),
                ],
            )
        ),
    )
    reports = [
        {"eventId": f"{identity}:2026-09-15", "status": status, "reportedOn": "2026-09-11"}
        for identity, status in zip(("rent", "loan"), statuses, strict=True)
        if status is not None
    ]
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = (
        await tools.invoke(
            "update_facts",
            {"expectedRevision": baseline.revision, "providerResponses": reports},
            "report-provider-responses",
        )
        if reports
        else canonical(baseline)
    )
    assert "code" not in result
    current = await store.get("owner")
    actions = current.plan.decision_assessment.actions
    if not reports:
        assert len(actions) == 1 and next_action(current.plan).kind == "resolveGroup"
        assert "no payment allocation" in next_action(current.plan).question.lower()
    for report in reports:
        identity = report["eventId"].split(":")[0]
        kind = "followUp" if report["status"] == "awaiting" else "seekSupport"
        action = next(a for a in actions if a.kind == kind and a.record_ids == [identity])
        assert action.before_date == date(2026, 9, 15)
        assert report["status"] in action.question.lower()
        for text in (result["spokenBrief"], export_text(current)):
            assert identity in text and report["status"] in text.lower()
    if statuses == ("declined", None):
        assert any(
            a.kind in {"contactPayee", "resolveGroup"} and "loan" in a.record_ids for a in actions
        )
        assert not any(a.kind == "contactPayee" and "rent" in a.record_ids for a in actions)
    assert current.plan.first_gap == baseline.plan.first_gap
    assert (current.plan.first_gap.amount_paise, current.plan.closing_paise) == (800000, -800000)
    assert current.plan.events == baseline.plan.events
    assert current.facts.records == baseline.facts.records
    assert (
        current.plan.decision_assessment.consequences
        == baseline.plan.decision_assessment.consequences
    )
    assert not any(c.adjustment_amounts for c in current.plan.decision_assessment.choices)
    assert current.preview is current.accepted is None
    assert [r.status for r in current.facts.provider_responses] == [r["status"] for r in reports]
    assert "No payment execution or allocation is performed" in export_text(current)


@pytest.mark.parametrize("kind,index", [("essential", 1), ("debt", 1), ("essential", 0)])
async def test_unknown_occurrence_uses_its_own_deadline_and_deferral_dependency(store, kind, index):
    """Preserve known money and bind clarification to the missing occurrence's date."""
    amounts = [money("100"), money("100")]
    amounts[index] = money(None, "unknown")
    item = variable(kind, amounts) | {"id": "food", "label": "food"}
    await store.create("owner")
    baseline = await store.command(
        "owner", parsed_command(facts("100", [item, record("loan", "debt", "500", "2026-09-14")]))
    )
    action = next(
        a for a in baseline.plan.decision_assessment.actions if a.id == "clarify:food:amount"
    )
    assert action.before_date == date(2026, 9, 12 + 7 * index)
    assert action.before_date.isoformat() in action.question
    assert next_action(baseline.plan).record_ids == (["loan"] if index else ["food"])
    events = [e for e in baseline.plan.events if e.record_id == "food"]
    assert [e.amount_paise for e in events] == ([10000, None] if index else [None, 10000])
    assert [e.schedule_index for e in events] == [0, 1]
    if kind == "debt":
        assert [e.required_paise for e in events] == [10000, None]
    assert (baseline.plan.outflow_paise, baseline.plan.closing_paise) == (60000, -50000)
    current = await store.command("owner", response_command(baseline, "unavailable", action.id))
    assert current.plan.events == baseline.plan.events
    assert all(a.id != action.id for a in current.plan.decision_assessment.actions)
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {"expectedRevision": current.revision, "opening": money("90")},
        "cash-correction",
    )
    assert "code" not in result
    assert result["actionResponses"][0]["actionId"] == action.id
    assert all(a["id"] != action.id for a in result["activeAssessment"]["actions"])
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": result["snapshot"]["revision"],
            "records": [{"id": "food", "schedule": {"date": "2026-09-13"}}],
        },
        "occurrence-correction",
    )
    assert "code" not in result and result["actionResponses"] == []
    current = await store.get("owner")
    action = next(a for a in current.plan.decision_assessment.actions if a.id == action.id)
    assert action.before_date == date(2026, 9, 13 + 7 * index)
    assert result["activePlan"]["outflowPaise"] == 60000


@pytest.mark.parametrize("term", ["rate", "fee"])
async def test_later_unknown_fx_terms_do_not_preempt_a_known_loan_gap(store, term):
    """Unknown conversion terms belong to their receipt occurrence, not the first receipt."""
    item = variable("income", [money("100"), foreign("20", **{term: None})])
    await store.create("owner")
    current = await store.command(
        "owner", parsed_command(facts("100", [item, record("loan", "debt", "500", "2026-09-14")]))
    )
    question = next(
        q
        for q in current.plan.decision_assessment.uncertainties
        if q.field == f"amount.conversion.{term}"
    )
    assert question.before_date == date(2026, 9, 19)
    assert "2026-09-19" in question.question and "USD" in question.question
    assert "immediateDecision" not in question.blocks
    assert next_action(current.plan).record_ids == ["loan"]
    assert current.plan.reliable_income_paise == 10000
    assert current.plan.first_gap.amount_paise == 30000
    receipt = next(
        e for e in current.plan.events if e.record_id == "item" and e.schedule_index == 1
    )
    assert receipt.amount_paise is None and not receipt.included
    assert receipt.source.amount == "20"


@pytest.mark.parametrize("budget", [True, False], ids=["monthlyBudget", "variableOptional"])
async def test_optional_forecast_guidance_defers_and_reopens_only_on_source_revision(store, budget):
    """Ask about discretionary revisions without enabling adjustments or assuming consent."""
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(optional_facts(budget)))
    action = next_action(baseline.plan)
    assert action.kind == "clarify" and action.record_ids == ["leisure"]
    assert NOW.date() <= action.before_date <= baseline.plan.first_gap.date
    assert "?" in action.question and "leisure" in action.question
    assert any(
        word in action.question.lower() for word in ("hold off", "revise", "smaller", "reduce")
    )
    assert "INR 0.00" not in action.question
    assert action.choice_id is None
    assert not baseline.plan.decision_assessment.choices
    assert not (await store.options("owner")).options
    assert baseline.preview is baseline.accepted is None
    result = canonical(baseline)
    assert result["currentAction"]["id"] == action.id
    assert action.question in export_text(baseline)
    assert "not spendable cash" in result["outcome"]["covered"]
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "respond_to_action",
        {"expectedRevision": baseline.revision, "actionId": action.id, "response": "unavailable"},
        "cannot-revise-spending",
    )
    assert "code" not in result
    current = await store.get("owner")
    assert next_action(current.plan).kind == "reviewOutcome"
    assert current.facts.decision.responses[0].response == "unavailable"
    assert current.plan.events == baseline.plan.events
    assert current.facts.records == baseline.facts.records
    assert await store.get("owner") == current
    result = await tools.invoke(
        "update_facts",
        {"expectedRevision": current.revision, "opening": money("9999" if budget else "4999")},
        "independent-correction",
    )
    assert "code" not in result
    assert result["currentAction"]["kind"] == "reviewOutcome"
    assert len(result["actionResponses"]) == 1
    patch = (
        {"amount": money("5500")}
        if budget
        else {
            "schedule": {
                "amounts": [
                    {"conversion": None, **money("2100")},
                    {"conversion": None, **money("1000")},
                ]
            }
        }
    )
    result = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": result["snapshot"]["revision"],
            "records": [{"id": "leisure", **patch}],
        },
        "explicit-spending-revision",
    )
    assert "code" not in result and result["actionResponses"] == []
    assert result["currentAction"]["kind"] == "clarify"
    assert result["currentAction"]["recordIds"] == ["leisure"]
    current = await store.get("owner")
    assert current.plan.outflow_paise != baseline.plan.outflow_paise
    assert result["activePlan"] == current.plan.model_dump(mode="json", by_alias=True)
    assert current.preview is current.accepted is None
    assert not (await store.options("owner")).options


@pytest.mark.parametrize("budget", [True, False], ids=["monthlyBudget", "variableOptional"])
@pytest.mark.parametrize(
    "exposure", ["reserve", "historicalOnly", "historicalAndFuture", "outOfScope"]
)
async def test_optional_forecast_guidance_uses_future_exposure_and_preserves_priorities(
    store, budget, exposure
):
    """Use future cash or reserve risk without replacing an earlier necessary action."""
    data = optional_facts(budget)
    if exposure == "reserve":
        data["opening"] = money("20000" if budget else "8000")
        data["reserve"] = "10000" if budget else "2000"
    else:
        data["records"][1]["schedule"]["date"] = "2026-09-15"
        data = facts(
            "0",
            [
                record("rent", "essential", "8000", "2026-09-12"),
                record(
                    "wages",
                    "income",
                    "20000" if exposure == "historicalOnly" else "10000",
                    "2026-09-13",
                ),
                data["records"][1],
            ],
        )
        if exposure == "outOfScope":
            data["decision"] = {"intent": "specificDecision", "focusRecordIds": ["rent"]}
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(data))
    plan = calculate(baseline.facts, baseline.anchor_date, store.config, today=date(2026, 9, 14))
    guidance = [
        action
        for action in plan.decision_assessment.actions
        if action.kind == "clarify" and action.record_ids == ["leisure"]
    ]
    assert bool(guidance) == (exposure in {"reserve", "historicalAndFuture"})
    if exposure == "reserve":
        assert plan.first_gap is None and plan.reserve_shortfall_paise > 0
        assert next_action(plan) == guidance[0]
    else:
        assert plan.first_gap.date == date(2026, 9, 12)
        assert plan.peak_gap_paise == 800000
        assert next_action(plan).record_ids == ["rent"]
    assert plan.events == baseline.plan.events
    assert not any(choice.adjustment_amounts for choice in plan.decision_assessment.choices)


@pytest.mark.parametrize(
    "budget,restriction",
    [
        (True, "essential"),
        (True, "committed"),
        (True, "unknown"),
        (True, "past"),
        (False, "essential"),
        (False, "committed"),
        (False, "unknown"),
        (False, "autoDebit"),
        (False, "past"),
    ],
)
async def test_protected_or_retrospective_forecasts_do_not_offer_spending_revisions(
    store, budget, restriction
):
    """Do not turn protected needs or retrospective spending into discretionary cuts."""
    data = optional_facts(budget)
    item = data["records"][1]
    if restriction == "essential":
        item["kind"] = "essential"
        data["coverage"]["optional"] = "none"
    elif restriction in {"committed", "unknown"}:
        item["controllability"] = restriction
    elif restriction == "autoDebit":
        item["autoDebit"] = True
    if restriction == "past":
        store.config = store.config.model_copy(update={"retention_hours": 24 * 40})
    await store.create("owner")
    baseline = await store.command("owner", parsed_command(data))
    if restriction == "past":
        store.clock = lambda: NOW.replace(month=10, day=12)
    current = await store.get("owner")
    assert not any(
        a.kind in {"clarify", "previewChange"} and "leisure" in a.record_ids
        for a in current.plan.decision_assessment.actions
    )
    assert not any(c.adjustment_amounts for c in current.plan.decision_assessment.choices)
    assert not (await store.options("owner")).options
    assert current.plan.events == baseline.plan.events
    assert current.facts.records == baseline.facts.records
    assert current.preview is current.accepted is None
