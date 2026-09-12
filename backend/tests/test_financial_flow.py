# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date, timedelta

import pytest

from app.finance import export_text
from app.voice_tools import canonical
from app.workspace import project as workspace

from .conftest import NOW, facts, money, parsed_command, record
from .test_action_responses import response_command
from .test_decision_priorities import next_action
from .test_finance import project
from .test_workspace import result, update


@pytest.mark.parametrize(
    "salary,remaining,closing", [("10000", 0, 400000), ("4000", 200000, -200000)]
)
@pytest.mark.parametrize("automatic", [False, True])
def test_same_day_risk_keeps_conservative_money_and_explains_remaining_gap(
    salary, remaining, closing, automatic
):
    """Verify same-day guidance distinguishes receipt timing exposure from residual funding gaps."""
    plan = project(
        facts(
            "0",
            [
                record("salary", "income", salary, "2026-09-14", label="Salary"),
                record(
                    "rent", "essential", "6000", "2026-09-14", label="Rent", autoDebit=automatic
                ),
            ],
        )
    )
    assert plan.first_gap.amount_paise == 600000
    assert plan.closing_paise == closing
    assert plan.model_dump(mode="json", by_alias=True)["timingRisks"] == [
        {"date": "2026-09-14", "exposurePaise": 600000, "remainingGapPaise": remaining}
    ]
    outcome = plan.decision_assessment.outcome
    assert "Rent" in outcome.summary and "2026-09-14" in outcome.summary
    if remaining:
        assert "INR 2000.00" in outcome.summary and "after" in outcome.summary
        assert next_action(plan).kind in {"seekSupport", "contactPayee"}
    else:
        assert "timing" in outcome.summary.lower()
        assert "shortfall" not in outcome.summary.lower()
        assert next_action(plan).kind == "confirmReceipt"
        assert plan.decision_assessment.next_question_id is None
        assert "before" in next_action(plan).question
    if automatic:
        assert any(issue.code == "autoDebitRisk" for issue in plan.issues)
        assert "auto" in next_action(plan).question.lower()
    assert outcome.next_step == next_action(plan).question
    assert all(
        word not in " ".join((outcome.summary, outcome.next_step, outcome.conditions)).lower()
        for word in ("modeled", "payee", "coverage", "sameDayTiming")
    )


@pytest.mark.parametrize(
    "day,reliability,opening,first_gap",
    [
        ("2026-09-13", "reliable", "0", None),
        ("2026-09-15", "reliable", "0", 600000),
        ("2026-09-14", "uncertain", "0", 600000),
        ("2026-09-14", "unknown", "0", 600000),
        ("2026-09-14", "reliable", "6000", None),
    ],
)
def test_no_timing_risk_without_counted_same_day_receipt_and_exposure(
    day, reliability, opening, first_gap
):
    """Verify timing risks require counted same-day receipts and exposed outflows."""
    plan = project(
        facts(
            opening,
            [
                record("salary", "income", "10000", day, reliability=reliability),
                record("rent", "essential", "6000", "2026-09-14"),
            ],
        )
    )
    assert plan.timing_risks == []
    assert (plan.first_gap.amount_paise if plan.first_gap else None) == first_gap
    if reliability == "unknown":
        assert plan.decision_assessment.next_question_id == "salary:receipt"
    if reliability == "uncertain":
        assert plan.decision_assessment.next_question_id != "salary:receipt"
        assert plan.income_comparisons[0].metrics.timing_risks[0].remaining_gap_paise == 0
        assert plan.income_comparisons[1].metrics.timing_risks == []


async def test_read_only_timing_guidance_can_be_deferred_without_confirming_order(store):
    """Verify deferring receipt guidance preserves timing risk without confirming payment order."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "0",
                [
                    record("salary", "income", "10000", "2026-09-14"),
                    record("rent", "essential", "6000", "2026-09-14"),
                ],
            )
        ),
    )
    assert next_action(baseline.plan).kind == "confirmReceipt"
    assert baseline.workspace.questions == []
    assert canonical(baseline)["dialogue"]["questionOptions"] == []
    assert canonical(baseline)["dialogue"]["purpose"] == "explainNextStep"
    deferred = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(deferred.plan).kind == "reviewOutcome"
    assert deferred.plan.decision_assessment.next_question_id is None
    assert deferred.plan.events == baseline.plan.events
    assert deferred.plan.timing_risks == baseline.plan.timing_risks
    assert deferred.facts.records == baseline.facts.records
    assert deferred.facts.opening == baseline.facts.opening
    assert deferred.facts.coverage == baseline.facts.coverage
    assert deferred.accepted is None and deferred.preview is None
    assert deferred.workspace.questions == []
    assert canonical(deferred)["dialogue"]["questionOptions"] == []
    assert "timing" in deferred.plan.decision_assessment.outcome.summary.lower()
    assert "shortfall" not in next_action(deferred.plan).question
    assert await store.get("owner") == deferred


async def test_named_undated_exclusion_is_replaced_by_real_dated_gap(store):
    """Verify supplying an excluded obligation's date replaces its qualification with a real gap."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "10000",
                [
                    record("food", "essential", "1000", "2026-09-12", label="Food"),
                    record("rent", "essential", "33000", None, label="Rent and utilities"),
                ],
            )
        ),
    )
    assert baseline.plan.closing_paise == 900000 and baseline.plan.first_gap is None
    closing = result(baseline, "closing")
    assert closing.qualifications == ["Excludes Rent and utilities (INR 33000.00): date unknown."]
    assert closing.model_dump(by_alias=True)["qualifications"] == closing.qualifications
    assert closing.qualifications[0] in export_text(baseline)
    assert result(baseline, "opening").qualifications == []
    assert "INR 9000.00" in baseline.plan.decision_assessment.outcome.summary
    assert next_action(baseline.plan).id == "clarify:rent:schedule.date"
    dated = await store.command(
        "owner",
        update(baseline.revision, records=[{"id": "rent", "schedule": {"date": "2026-09-14"}}]),
    )
    assert dated.plan.first_gap.date == date(2026, 9, 14)
    assert dated.plan.first_gap.amount_paise == 2400000
    assert dated.plan.closing_paise == -2400000
    assert not result(dated, "closing").qualifications
    assert dated.facts.records[1].id == "rent"


async def test_focus_and_current_correction_remain_visible_with_first_exposed_need(store):
    """Verify timeline priority retains the first exposed need, decision focus, and corrected record."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [
                    record("a", "essential", "100", "2026-09-12"),
                    record("b", "essential", "2000", "2026-09-14", label="Rent"),
                    record("c", "income", "10000", "2026-09-20"),
                    record("d", "debt", "100", "2026-09-21"),
                    record("z", "optional", "100", "2026-09-22", label="Gym"),
                ],
                decision={"intent": "specificDecision", "focusRecordIds": ["z"]},
            )
        ),
    )
    timeline = next(card for card in baseline.workspace.cards if card.id == "timeline")
    assert {"b", "z"} <= set(timeline.record_ids[:4])
    assert timeline.record_ids[0] == "b"
    corrected = await store.command(
        "owner", update(baseline.revision, records=[{"id": "d", "amount": money("200")}])
    )
    timeline = next(card for card in corrected.workspace.cards if card.id == "timeline")
    assert {"b", "z", "d"} <= set(timeline.record_ids[:4])
    assert timeline.record_ids[0] == "b"
    assert [row.field for row in timeline.rows] == timeline.record_ids
    assert set(timeline.record_ids) == {"a", "b", "c", "d", "z"}
    assert workspace(corrected, store.config) == corrected.workspace
    shuffled = corrected.model_copy(deep=True)
    shuffled.facts.records.reverse()
    assert workspace(shuffled, store.config) == corrected.workspace
    assert await store.get("owner") == corrected
    assert {card.template for card in corrected.workspace.cards} <= {
        "cash",
        "timeline",
        "questions",
        "proposal",
    }
    assert timeline.record_ids[:4] == ["b", "z", "d", "c"]
    store.clock = lambda: NOW + timedelta(hours=18)
    refreshed = await store.get("owner")
    assert next(card for card in refreshed.workspace.cards if card.id == "timeline") == timeline
    assert workspace(refreshed, store.config) == refreshed.workspace
    assert await store.get("owner") == refreshed


def test_positive_closing_does_not_hide_earlier_need_or_assume_grocery_creditor():
    """Verify positive closing cash does not hide earlier grocery needs or invent a creditor."""
    plan = project(
        facts(
            "5000",
            [
                record("food", "essential", "12000", "2026-09-14", label="Groceries"),
                record("salary", "income", "25000", "2026-09-20", label="Salary"),
            ],
        )
    )
    assert plan.closing_paise == 1800000 and plan.first_gap.amount_paise == 700000
    outcome = plan.decision_assessment.outcome
    assert "Groceries" in outcome.summary and "2026-09-14" in outcome.summary
    assert "INR 7000.00" in outcome.summary
    assert next_action(plan).kind == "seekSupport"
    assert len(outcome.next_step) < 330
    assert len(outcome.conditions) < 420
    assert all(word not in outcome.next_step.lower() for word in ("creditor", "refusal", "payee"))
    assert "cannot fund the earlier deadline" in outcome.conditions
    assert plan.outflow_paise == 1200000


@pytest.mark.parametrize("automatic", [False, True])
async def test_residual_support_deferral_never_turns_into_a_timing_question(store, automatic):
    """Verify deferring residual-gap support preserves the gap without reasking receipt timing."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "0",
                [
                    record("salary", "income", "4000", "2026-09-14"),
                    record("rent", "essential", "6000", "2026-09-14", autoDebit=automatic),
                ],
            )
        ),
    )
    assert next_action(baseline.plan).kind == ("contactPayee" if automatic else "seekSupport")
    assert "INR 2000.00" in next_action(baseline.plan).question
    deferred = await store.command("owner", response_command(baseline, "unavailable"))
    assert next_action(deferred.plan).kind == "reviewOutcome"
    assert not any("sameDayTiming" in question.id for question in deferred.workspace.questions)
    assert "INR 2000.00" in deferred.plan.decision_assessment.outcome.summary
    assert deferred.plan.events == baseline.plan.events
    assert deferred.plan.timing_risks == baseline.plan.timing_risks
    assert deferred.facts.provider_responses == []
    assert deferred.facts.coverage == baseline.facts.coverage


@pytest.mark.parametrize("purchase_day", ["2026-09-14", "2026-09-15"])
async def test_timing_risk_keeps_a_cut_that_funds_later_essentials_after_deferrals(
    store, purchase_day
):
    """Verify effective optional cuts remain available after timing and support deferrals."""
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "0",
                [
                    record("rent", "essential", "1000", "2026-09-14"),
                    record("salary", "income", "10000", "2026-09-14"),
                    record("purchase", "optional", "6000", purchase_day),
                    record("food", "essential", "5000", "2026-09-16"),
                ],
            )
        ),
    )
    assert next_action(baseline.plan).id == f"preview:purchase:{purchase_day}"
    assert baseline.plan.closing_paise == -200000
    choice = next(
        item for item in baseline.plan.decision_assessment.choices if item.kind == "reduceOptional"
    )
    assert choice.metrics.closing_paise == 400000
    assert choice.metrics.first_gap.amount_paise == 100000
    current = baseline
    for action_id in ("clarify:schedule:sameDayTiming:2026-09-14", "contact:food:2026-09-16"):
        current = await store.command("owner", response_command(current, "unavailable", action_id))
        assert next_action(current.plan).id == f"preview:purchase:{purchase_day}"
        assert current.facts.records == baseline.facts.records
        assert current.accepted is None and current.preview is None
    declined = await store.command("owner", response_command(current, "declined"))
    assert next_action(declined.plan).kind == "reviewOutcome"
    assert declined.facts.records == baseline.facts.records


def test_optional_cut_after_first_funding_gap_does_not_displace_earlier_help():
    """Verify a late optional cut does not displace earlier receipt confirmation."""
    plan = project(
        facts(
            "0",
            [
                record("rent", "essential", "6000", "2026-09-14"),
                record("salary", "income", "10000", "2026-09-14"),
                record("food", "essential", "5000", "2026-09-16"),
                record("trip", "optional", "1500", "2026-09-17"),
            ],
        )
    )
    assert next_action(plan).kind == "confirmReceipt"
    assert plan.closing_paise == -250000


def test_timing_only_does_not_push_an_optional_cut_but_later_funding_need_is_named():
    """Verify timing-only exposure avoids forced cuts while later essential funding needs stay named."""
    data = facts(
        "0",
        [
            record("salary", "income", "10000", "2026-09-14"),
            record("purchase", "optional", "6000", "2026-09-14"),
        ],
    )
    timing = project(data)
    assert next_action(timing).kind == "confirmReceipt"
    assert timing.first_gap.amount_paise == 600000
    data["records"].append(record("food", "essential", "5000", "2026-09-16"))
    data["coverage"]["essential"] = "reviewed"
    later = project(data)
    assert later.first_gap == timing.first_gap
    assert "INR 1000.00" in later.decision_assessment.outcome.summary
    assert "2026-09-16" in later.decision_assessment.outcome.summary
    assert any(
        action.kind == "seekSupport" and action.record_ids == ["food"]
        for action in later.decision_assessment.actions
    )
    data["records"].reverse()
    assert project(data).timing_risks == later.timing_risks
    assert project(data).decision_assessment == later.decision_assessment


async def test_qualifications_keep_minimum_estimate_and_result_sources_separate(store):
    """Verify result qualifications distinguish card minimums, estimates, and excluded obligations."""
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        parsed_command(
            facts(
                "10000",
                [
                    record(
                        "card",
                        "debt",
                        "500",
                        "2026-09-14",
                        label="Card",
                        debtType="card",
                        target=money(None, "unknown"),
                    ),
                    record("food", "essential", "1000", "2026-09-15", label="Food")
                    | {"amount": money("1000", "estimate")},
                    record("salary", "income", "2000", "2026-09-20", label="Salary"),
                    record("rent", "essential", "33000", None, label="Rent and utilities"),
                ],
            )
        ),
    )
    closing = result(snapshot, "closing")
    assert closing.amount_paise == 1050000
    assert closing.state == "estimated"
    assert closing.qualifications == [
        "Includes only Card's required/minimum payment (INR 500.00); "
        "intended payment amount unknown.",
        "Uses estimated Food (INR 1000.00).",
        "Excludes Rent and utilities (INR 33000.00): date unknown.",
    ]
    assert result(snapshot, "opening").qualifications == []
    assert result(snapshot, "reliableIncome").qualifications == []
    assert result(snapshot, "opening").state == "known"
    assert result(snapshot, "reliableIncome").state == "known"
    assert result(snapshot, "reliableIncome").issue_ids == []
    assert all(
        "Rent" not in qualification and "Card" not in qualification
        for qualification in result(snapshot, "uncertainIncome").qualifications
    )
    assert "Salary" not in " ".join(result(snapshot, "datedOutflow").qualifications)
    shuffled = snapshot.model_copy(deep=True)
    shuffled.facts.records.reverse()
    assert workspace(shuffled, store.config) == snapshot.workspace


async def test_qualifications_follow_exact_gap_witness_and_conditional_branch(store):
    """Verify qualifications follow the exact gap witness and conditional income branch."""
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        parsed_command(
            facts(
                "0",
                [
                    record("salary", "income", "10000", "2026-09-14", label="Salary"),
                    record("rent", "essential", "6000", "2026-09-14", label="Rent"),
                    record(
                        "bonus",
                        "income",
                        "2000",
                        "2026-09-15",
                        label="Bonus",
                        reliability="uncertain",
                    ),
                ],
            )
        ),
    )
    gap = result(snapshot, "firstGap")
    assert gap.witness_event_ids == ["rent:2026-09-14"]
    assert gap.qualifications == [
        "Excludes Salary (INR 10000.00): after this balance point.",
        "Excludes Bonus (INR 2000.00): receipt not assured.",
    ]
    assert result(snapshot, "closing").qualifications == [
        "Excludes Bonus (INR 2000.00): receipt not assured."
    ]
    arrived = result(snapshot, "income:reportedDate:closing")
    assert arrived.amount_paise == 600000 and arrived.state == "uncertain"
    assert arrived.qualifications == []
    assert result(snapshot, "income:notByHorizon:closing").qualifications == (
        result(snapshot, "closing").qualifications
    )


async def test_exposed_recurrence_shows_its_actual_occurrence_not_first_funded_one(store):
    """Verify recurring timeline rows show the exposed occurrence rather than the first funded one."""
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        parsed_command(
            facts(
                "1500",
                [
                    record(
                        "food",
                        "essential",
                        "1000",
                        "2026-09-12",
                        label="Food",
                        schedule={"date": "2026-09-12", "recurrence": "weekly", "count": 2},
                    ),
                    record("salary", "income", "10000", "2026-09-20"),
                ],
            )
        ),
    )
    timeline = next(card for card in snapshot.workspace.cards if card.id == "timeline")
    assert timeline.record_ids == ["food", "salary"]
    assert timeline.event_ids == ["food:2026-09-19", "salary:2026-09-20"]
    assert snapshot.plan.first_gap.date == date(2026, 9, 19)
    assert snapshot.plan.first_gap.amount_paise == 50000
    occurrence = next(event for event in snapshot.plan.events if event.id == timeline.event_ids[0])
    assert occurrence.schedule_index == 1 and occurrence.amount_paise == 100000
    assert occurrence.original_due_date == date(2026, 9, 19)
    assert workspace(snapshot, store.config) == snapshot.workspace


async def test_funded_recurring_card_moves_to_today_without_claiming_earlier_payment(store):
    """Verify funded recurring timeline cards advance to today without changing prior projections."""
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        parsed_command(
            facts(
                "10000",
                [
                    record(
                        "food",
                        "essential",
                        "100",
                        "2026-09-11",
                        schedule={"date": "2026-09-11", "recurrence": "daily"},
                    )
                ],
            )
        ),
    )
    before = snapshot.plan.model_dump()
    snapshot.plan.evaluated_on = date(2026, 9, 12)
    projected = workspace(snapshot, store.config)
    timeline = next(card for card in projected.cards if card.id == "timeline")
    assert timeline.event_ids == ["food:2026-09-12"]
    assert snapshot.plan.events[0].date == date(2026, 9, 11)
    assert snapshot.plan.closing_paise == before["closing_paise"]
    assert snapshot.plan.model_dump(exclude={"evaluated_on"}) == {
        key: value for key, value in before.items() if key != "evaluated_on"
    }
