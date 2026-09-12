# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date
from uuid import UUID

from pydantic import JsonValue

from .amounts import money_value
from .config import Config
from .decisions import rupees
from .finance import dependency_key, reconcile
from .models import (
    ChangeItem,
    Contribution,
    Event,
    FactsPatch,
    FieldChange,
    Money,
    Plan,
    Snapshot,
    Workspace,
    WorkspaceCard,
    WorkspaceChange,
    WorkspaceQuestion,
    WorkspaceResult,
    WorkspaceRow,
    WorkspaceState,
)


def money_state(money: Money) -> WorkspaceState:
    return (
        "missing"
        if money.amount_paise is None
        else "estimated"
        if money.status == "estimate"
        else "known"
    )


def project(snapshot: Snapshot, config: Config) -> Workspace:
    """Project the current ledger; event balances and metrics come only from reconcile."""
    facts = snapshot.facts
    plan = snapshot.accepted.plan if snapshot.accepted else snapshot.plan
    assessment = plan.decision_assessment
    workspace = Workspace(change=snapshot.latest_change, issues=assessment.uncertainties)
    records = {record.id: record for record in facts.records}
    events = {event.id: event for event in plan.events}
    rejected = [
        {(item.event_id, item.amount_paise, item.dependency_key) for item in proposal.adjustments}
        for proposal in snapshot.rejected_proposals
    ]
    eligible_choices = {
        choice.id: choice
        for choice in assessment.choices
        if not choice.adjustment_amounts
        or {
            (
                item.event_id,
                item.amount_paise,
                dependency_key(records[events[item.event_id].record_id], events[item.event_id]),
            )
            for item in choice.adjustment_amounts
        }
        not in rejected
    }
    workspace.actions = [
        action
        for action in assessment.actions
        if action.choice_id is None or action.choice_id in eligible_choices
    ][: config.workspace_max_actions]
    workspace.choices = list(
        {
            action.choice_id: eligible_choices[action.choice_id]
            for action in workspace.actions
            if action.choice_id in eligible_choices
        }.values()
    )
    for item in assessment.uncertainties:
        action = next(
            (
                action
                for action in workspace.actions
                if (action.kind == "clarify" and action.id == f"clarify:{item.id}")
                or (
                    action.kind == "confirmReceipt" and item.id == f"{action.record_ids[0]}:receipt"
                )
            ),
            None,
        )
        if action is None:
            continue
        workspace.questions.append(
            WorkspaceQuestion(
                id=item.id,
                action_id=action.id,
                fields=[item.field],
                record_ids=item.record_ids,
                why=item.reason,
                resolves=[item.id],
                changes=list(item.changes),
                blocks=list(item.blocks),
                before_date=item.before_date,
                priority=item.priority,
            )
        )
        if len(workspace.questions) == config.workspace_max_questions:
            break
    relevant = bool(
        facts.records
        or facts.opening.amount_paise is not None
        or facts.conflicts
        or facts.reserve_paise
        or any(value != "notDiscussed" for value in facts.coverage.model_dump().values())
    )
    if not relevant:
        return workspace
    workspace.results, workspace.contributions = evidence(snapshot, plan, config)
    for choice in workspace.choices:
        if choice.metrics is None:
            continue
        for identity, amount in (
            ("closing", choice.metrics.closing_paise),
            (
                "firstGap",
                choice.metrics.first_gap.amount_paise
                if choice.metrics.first_gap
                else 0
                if choice.metrics.closing_paise is not None
                else None,
            ),
            ("peakGap", choice.metrics.peak_gap_paise),
            ("reserveShortfall", choice.metrics.reserve_shortfall_paise),
        ):
            baseline = next(item for item in workspace.results if item.id == identity)
            workspace.results.append(
                baseline.model_copy(
                    update={
                        "id": f"choice:{choice.id}:impact:{identity}",
                        "amount_paise": amount - baseline.amount_paise
                        if amount is not None and baseline.amount_paise is not None
                        else None,
                        "date": None,
                        "state": "proposed",
                        "rule": "choiceReconcileMinusActiveResult",
                        "result_ids": [baseline.id],
                        "contribution_ids": [],
                        "excluded_ids": [],
                        "excluded_reasons": {},
                        "witness_event_ids": [],
                        "event_ids": choice.event_ids,
                        "dependencies": [
                            f"workspace.choices.{choice.id}.metrics",
                            f"workspace.choices.{choice.id}.adjustmentAmounts",
                            f"workspace.results.{identity}",
                        ],
                    }
                )
            )
    if snapshot.preview:
        results, contributions = evidence(
            snapshot, snapshot.preview.plan, config, prefix="proposal:"
        )
        workspace.results.extend(results)
        workspace.contributions.extend(contributions)
        for identity in ("datedOutflow", "closing", "firstGap", "peakGap", "reserveShortfall"):
            baseline = next(item for item in workspace.results if item.id == identity)
            proposed = next(item for item in results if item.id == f"proposal:{identity}")
            workspace.results.append(
                proposed.model_copy(
                    update={
                        "id": f"impact:{identity}",
                        "amount_paise": proposed.amount_paise - baseline.amount_paise
                        if proposed.amount_paise is not None and baseline.amount_paise is not None
                        else None,
                        "rule": "proposedMinusActiveResult",
                        "result_ids": [baseline.id, proposed.id],
                        "state": "proposed",
                    }
                )
            )
    opening_conflicts = [item.id for item in facts.conflicts if item.field == "opening"]
    if facts.opening.amount_paise is not None or opening_conflicts or facts.reserve_paise or events:
        workspace.cards.append(
            WorkspaceCard(
                id="cash",
                template="cash",
                section="facts",
                title="Cash & timing",
                state="conflicting"
                if opening_conflicts
                else "unresolved"
                if plan.first_gap or plan.reserve_shortfall_paise
                else money_state(facts.opening),
                rows=[
                    WorkspaceRow(
                        field="opening",
                        label="Cash at the plan start",
                        value=facts.opening.amount_paise,
                        state="conflicting" if opening_conflicts else money_state(facts.opening),
                        references=["facts.opening"],
                    ),
                    WorkspaceRow(
                        field="reserve",
                        label="Reserve floor (not spending)",
                        value=facts.reserve_paise,
                        state="known",
                        references=["facts.reservePaise"],
                    ),
                ],
                issue_ids=opening_conflicts,
                result_ids=["opening"]
                + (["firstGap", "closing", "trough"] if events else [])
                + (["reserveShortfall"] if facts.reserve_paise else []),
                dependencies=["facts.opening", "facts.reservePaise", "facts.conflicts"]
                + (["accepted.plan" if snapshot.accepted else "plan"] if events else []),
            )
        )
    workspace.cards.extend(timeline_cards(snapshot, plan, workspace))
    if snapshot.preview or snapshot.accepted or snapshot.invalidated_assumptions:
        scenarios = [item for item in (snapshot.preview, snapshot.accepted) if item is not None]
        event_ids = list(
            dict.fromkeys(
                [item.event_id for scenario in scenarios for item in scenario.adjustments]
                + [item.event_id for item in snapshot.invalidated_assumptions]
            )
        )
        workspace.cards.append(
            WorkspaceCard(
                id="proposal",
                template="proposal",
                section="decisions",
                title="Plan changes",
                state="proposed"
                if snapshot.preview
                else "unresolved"
                if snapshot.invalidated_assumptions
                else "accepted",
                record_ids=list(
                    dict.fromkeys(
                        [item.record_id for scenario in scenarios for item in scenario.adjustments]
                        + [
                            identity.rsplit(":", 1)[0]
                            for identity in event_ids
                            if identity.rsplit(":", 1)[0] in records
                        ]
                    )
                ),
                event_ids=event_ids,
                result_ids=["firstGap", "peakGap", "closing"]
                + (
                    [
                        "proposal:firstGap",
                        "proposal:peakGap",
                        "proposal:closing",
                        "impact:firstGap",
                        "impact:peakGap",
                        "impact:closing",
                    ]
                    if snapshot.preview
                    else []
                ),
                dependencies=["preview", "accepted", "invalidatedAssumptions"],
            )
        )
    return workspace


def timeline_cards(snapshot: Snapshot, plan: Plan, workspace: Workspace) -> list[WorkspaceCard]:
    facts = snapshot.facts
    records = {record.id: record for record in facts.records}
    cards: list[WorkspaceCard] = []
    next_events: dict[str, Event] = {}
    for event in plan.events:
        if event.amount_basis != "budget":
            selected = next_events.get(event.record_id)
            if selected is None or selected.date < plan.evaluated_on <= event.date:
                next_events[event.record_id] = event
    exposed = next(
        (
            event
            for event in plan.events
            if plan.first_gap
            and event.date == plan.first_gap.date
            and event.kind != "income"
            and event.included
            and event.amount_paise
            and event.balance_paise is not None
            and event.balance_paise < 0
        ),
        None,
    )
    if exposed and exposed.amount_basis != "budget":
        next_events[exposed.record_id] = exposed
    first_payment = next((item for item in next_events.values() if item.kind != "income"), None)
    first_receipt = next((item for item in next_events.values() if item.kind == "income"), None)
    priorities = sorted(
        (item for item in workspace.issues if item.kind != "coverage"),
        key=lambda item: (
            item.kind != "conflict",
            "immediateDecision" not in item.blocks,
            item.priority,
            item.before_date or date.max,
            item.id,
        ),
    )
    corrections = (
        {
            identity
            for item in snapshot.latest_change.items
            if item.state in {"updated", "resolved", "merged"}
            for identity in item.record_ids
            if item.id.startswith(("record:", "merge:", "conflict:"))
        }
        if snapshot.latest_change
        else set()
    )
    ordered_ids = list(
        dict.fromkeys(
            ([exposed.record_id] if exposed else [])
            + sorted(facts.decision.focus_record_ids)[:1]
            + sorted(corrections)[:1]
            + ([first_receipt.record_id] if exposed and first_receipt else [])
            + [
                item.record_id
                for item in next_events.values()
                if item in (first_payment, first_receipt)
            ]
            + sorted(facts.decision.focus_record_ids)
            + sorted(corrections)
            + [identity for item in priorities for identity in sorted(item.record_ids)]
            + sorted(records)
        )
    )
    ordered_ids = [identity for identity in ordered_ids if identity in records]
    if ordered_ids:
        states: list[WorkspaceState] = ["conflicting", "missing", "uncertain", "estimated"]
        rows = []
        for identity in ordered_ids:
            record = records[identity]
            amounts = (
                [money_value(value)[1] for value in record.schedule.amounts]
                if record.schedule.amounts
                else [record.amount.status]
            )
            rows.append(
                WorkspaceRow(
                    field=identity,
                    label=record.label,
                    value=None,
                    state="conflicting"
                    if any(item.record_id == identity for item in facts.conflicts)
                    else "missing"
                    if (record.schedule.date is None and record.schedule.pattern is None)
                    or "unknown" in amounts
                    else "uncertain"
                    if record.kind == "income" and record.reliability != "reliable"
                    else "estimated"
                    if record.schedule.recurrence == "monthlyBudget"
                    or record.schedule.pattern is not None
                    or record.schedule.certainty == "estimate"
                    or "estimate" in amounts
                    else "known",
                    references=[f"facts.records.{identity}"],
                )
            )
        cards.append(
            WorkspaceCard(
                id="timeline",
                template="timeline",
                section="timeline",
                title="Next & commitments",
                state=next(
                    (state for state in states if any(row.state == state for row in rows)),
                    "known",
                ),
                record_ids=ordered_ids,
                event_ids=[
                    next_events[identity].id for identity in ordered_ids if identity in next_events
                ],
                issue_ids=[item.id for item in priorities if item.record_ids],
                rows=rows,
                dependencies=[
                    "facts.records",
                    "facts.conflicts",
                    "facts.decision.focusRecordIds",
                    "latestChange",
                    "workspace.issues",
                    "accepted.plan.events" if snapshot.accepted else "plan.events",
                ],
            )
        )
    visible_ids = set(ordered_ids[:4])
    question = next(
        (
            item
            for item in priorities
            if not (item.record_ids and set(item.record_ids) <= visible_ids)
            and not (
                any(card.id == "cash" for card in workspace.cards)
                and item.field in {"opening", "reserve"}
            )
        ),
        None,
    )
    if question and (records or workspace.cards):
        cards.append(
            WorkspaceCard(
                id="questions",
                template="questions",
                section="issues",
                title="Important uncertainty",
                state="conflicting" if question.kind == "conflict" else "unresolved",
                record_ids=question.record_ids,
                issue_ids=[question.id],
                dependencies=[f"workspace.issues.{question.id}", "facts.conflicts"],
                rows=[
                    WorkspaceRow(
                        field=question.id,
                        label=question.question,
                        value=None,
                        state="conflicting" if question.kind == "conflict" else "unresolved",
                        references=[f"workspace.issues.{question.id}"],
                    )
                ],
            )
        )
    return cards


def evidence(
    snapshot: Snapshot,
    plan: Plan,
    config: Config,
    prefix: str = "",
    projection_ref: str | None = None,
) -> tuple[list[WorkspaceResult], list[Contribution]]:
    facts = snapshot.facts
    projection_ref = projection_ref or (
        "preview.plan" if prefix else "accepted.plan" if snapshot.accepted else "plan"
    )
    records = {record.id: record for record in facts.records}
    events = {event.id: event for event in plan.events}
    contributions = [
        Contribution(
            id=f"{prefix}opening",
            record_id=None,
            event_id=None,
            amount_paise=facts.opening.amount_paise,
            included=facts.opening.amount_paise is not None,
            reason="reportedOpening"
            if facts.opening.amount_paise is not None
            else "unknownOpening",
            references=["facts.opening"],
            date=snapshot.anchor_date,
        )
    ]
    for event in plan.events:
        record = records[event.record_id]
        amount_field = (
            f"schedule.amounts.{event.schedule_index}"
            if record.schedule.amounts
            else "target"
            if record.target and event.amount_basis != "requiredOnly"
            else "amount"
        )
        contributions.append(
            Contribution(
                id=f"{prefix}event:{event.id}",
                record_id=event.record_id,
                event_id=event.id,
                amount_paise=event.amount_paise,
                balance_paise=event.balance_paise,
                included=event.included,
                reason="acceptedAssumption"
                if event.amount_basis == "assumed" and projection_ref != "preview.plan"
                else "proposedAssumption"
                if event.amount_basis == "assumed"
                else "unknownAmount"
                if event.amount_paise is None
                else "conditionalReceipt"
                if not event.included and event.kind == "income"
                else "monthlyPattern"
                if event.date_assumption is not None
                else "monthlyBudget"
                if event.amount_basis == "budget"
                else "currencyConversion"
                if event.source is not None
                else "variableAmounts"
                if record.schedule.amounts
                else "approximateOutflowDate"
                if record.schedule.certainty != "exact"
                else event.amount_basis,
                date=event.date,
                references=([f"{projection_ref}.events.{event.id}.source"] if event.source else [])
                + (
                    [
                        f"facts.records.{record.id}.{amount_field}",
                        f"facts.records.{record.id}.schedule",
                        f"facts.records.{record.id}.reliability",
                        f"{projection_ref}.events.{event.id}",
                    ]
                    if record.kind == "income"
                    else [
                        f"facts.records.{record.id}.{amount_field}",
                        f"facts.records.{record.id}.schedule",
                        f"{projection_ref}.events.{event.id}",
                    ]
                ),
            )
        )
    event_records = {event.record_id for event in plan.events}
    for record in sorted(facts.records, key=lambda item: item.id):
        if record.id not in event_records:
            contributions.append(
                Contribution(
                    id=f"{prefix}record:{record.id}",
                    record_id=record.id,
                    event_id=None,
                    amount_paise=record.target.amount_paise
                    if record.target is not None and record.target.amount_paise is not None
                    else record.amount.amount_paise,
                    date=record.schedule.date,
                    included=False,
                    reason="monthlyPatternOutsideWindow"
                    if record.schedule.pattern is not None
                    else "unknownDate"
                    if record.schedule.date is None
                    else "pastReceipt"
                    if record.schedule.date < snapshot.anchor_date and record.kind == "income"
                    else "approximateDateOutsideWindow"
                    if record.schedule.certainty == "estimate"
                    else "outsideHorizon",
                    references=[f"facts.records.{record.id}"],
                )
            )
    issues = [item.id for item in plan.decision_assessment.uncertainties]
    assumptions = [
        "sameDayOutflowBeforeIncome",
        "closingIsNotSpendable",
        "unreportedFactsNotZero",
        "noPaymentExecution",
    ]
    if any(event.amount_basis == "assumed" for event in plan.events):
        assumptions.append(
            "proposedAdjustments" if projection_ref == "preview.plan" else "acceptedAdjustments"
        )
    if any(event.amount_basis == "budget" for event in plan.events):
        assumptions.append("monthlyBudgetEvenDailyForecastActualMonthLength")
    if any(event.date_assumption for event in plan.events):
        assumptions.append("reportedMonthlyPatternEstimatedDatesNoArrears")
    if any(event.source is not None for event in plan.events):
        assumptions.append("currencyConversionReportedRateAndFeeOnly")
    trough_date = (
        None
        if plan.trough_paise is None
        else snapshot.anchor_date
        if plan.trough_paise == facts.opening.amount_paise
        else next(event.date for event in plan.events if event.balance_paise == plan.trough_paise)
    )
    specs: list[tuple[str, int | None, date | None, str]] = [
        ("opening", facts.opening.amount_paise, snapshot.anchor_date, "reportedAvailableOpening"),
        ("reliableIncome", plan.reliable_income_paise, None, "sumIncludedDatedReceipts"),
        ("uncertainIncome", plan.uncertain_income_paise, None, "sumExcludedKnownDatedReceipts"),
        ("datedOutflow", plan.outflow_paise, None, "sumKnownDatedOutflow"),
        (
            "closing",
            plan.closing_paise,
            snapshot.end_date_exclusive,
            "openingPlusIncludedIncomeMinusIncludedOutflow",
        ),
        (
            "trough",
            plan.trough_paise,
            trough_date,
            "minimumOpeningAndEventBalances",
        ),
        (
            "firstGap",
            plan.first_gap.amount_paise
            if plan.first_gap
            else 0
            if plan.closing_paise is not None
            else None,
            plan.first_gap.date if plan.first_gap else None,
            "maximumDeficitOnEarliestNegativeDate",
        ),
        ("peakGap", plan.peak_gap_paise, plan.peak_gap_date, "maxZeroMinusTroughNotSumOfGaps"),
        (
            "reserveShortfall",
            plan.reserve_shortfall_paise,
            trough_date if plan.reserve_shortfall_paise else None,
            "maxZeroReserveMinusMaxZeroTrough",
        ),
    ]
    results = []
    for identity, amount, day, rule in specs:
        selected = (
            contributions
            if identity not in {"opening", "reliableIncome", "uncertainIncome", "datedOutflow"}
            else [item for item in contributions if item.record_id is None]
            if identity == "opening"
            else [
                item
                for item in contributions
                if item.record_id is not None
                and (records[item.record_id].kind == "income") == (identity != "datedOutflow")
            ]
        )
        record_ids = list(dict.fromkeys(item.record_id for item in selected if item.record_id))
        result_issues = (
            [
                item.id
                for item in plan.decision_assessment.uncertainties
                if set(item.record_ids).intersection(record_ids)
                or item.kind == "coverage"
                and any(
                    status not in {"reviewed", "none"}
                    and (kind == "income") == (identity != "datedOutflow")
                    for kind, status in facts.coverage.model_dump().items()
                )
            ]
            if identity in {"reliableIncome", "uncertainIncome", "datedOutflow"}
            else issues
        )
        included = [
            item
            for item in selected
            if item.event_id is not None
            and item.amount_paise is not None
            and (not item.included if identity == "uncertainIncome" else item.included)
            or item.record_id is None
            and item.included
        ]
        witness = next(
            (
                event.id
                for event in plan.events
                if event.balance_paise is not None
                and (
                    identity == "firstGap"
                    and plan.first_gap is not None
                    and event.date == day
                    and event.balance_paise == -plan.first_gap.amount_paise
                    or identity in {"peakGap", "trough", "reserveShortfall"}
                    and event.balance_paise == plan.trough_paise
                    and plan.trough_paise != facts.opening.amount_paise
                )
            ),
            None,
        )
        point = None
        if identity in {"firstGap", "peakGap", "trough", "reserveShortfall"} and amount is not None:
            if witness:
                point = next(
                    index for index, item in enumerate(contributions) if item.event_id == witness
                )
            elif identity != "firstGap" or plan.first_gap is not None:
                point = 0
        if point is not None:
            included = [item for item in included if item in contributions[: point + 1]]
        excluded = [item for item in selected if item not in included]
        estimated = facts.opening.status == "estimate" and any(
            item.record_id is None for item in included
        )
        estimated = estimated or any(
            item.event_id is not None
            and (
                events[item.event_id].amount_status == "estimate"
                or events[item.event_id].date_assumption is not None
                or records[events[item.event_id].record_id].schedule.certainty == "estimate"
            )
            for item in included
        )
        excluded_reasons = {
            item.id: "countedReliableIncome"
            if identity == "uncertainIncome" and item.included
            else "afterResultPoint"
            if item.included
            else item.reason
            for item in excluded
        }
        qualifications = []
        for item in selected:
            source = records.get(item.record_id or "")
            occurrence = events.get(item.event_id or "")
            label = source.label if source else "opening cash"
            amount_text = f" ({rupees(item.amount_paise)})" if item.amount_paise is not None else ""
            if source and source.target is not None and source.target.amount_paise is None:
                if item.amount_paise is not None:
                    amount_text = f" (required/minimum {rupees(item.amount_paise)})"
            if source and occurrence is None and source.schedule.recurrence != "once":
                amount_text += (
                    " per calendar month"
                    if source.schedule.recurrence == "monthlyBudget"
                    else " per occurrence"
                )
            reason = excluded_reasons.get(item.id)
            if occurrence and occurrence.date_assumption:
                qualifications.append(f"{label}: {occurrence.date_assumption}.")
            if reason:
                if (
                    occurrence is not None
                    and occurrence.amount_status == "estimate"
                    or source is not None
                    and occurrence is None
                    and (
                        source.target
                        if source.target and source.target.amount_paise is not None
                        else source.amount
                    ).status
                    == "estimate"
                ):
                    amount_text += " (estimate)"
                description = {
                    "unknownDate": "date unknown",
                    "unknownAmount": "amount unknown",
                    "unknownOpening": "amount unknown",
                    "conditionalReceipt": "receipt not assured",
                    "pastReceipt": "past receipt not confirmed in opening cash",
                    "approximateDateOutsideWindow": "approximate date outside this period",
                    "monthlyPatternOutsideWindow": "monthly pattern has no occurrence here",
                    "outsideHorizon": "outside this period",
                    "afterResultPoint": "after this balance point",
                    "countedReliableIncome": "counted as reliable income instead",
                }.get(reason)
                if description:
                    qualifications.append(f"Excludes {label}{amount_text}: {description}.")
                continue
            if occurrence and occurrence.amount_basis == "requiredOnly":
                qualifications.append(
                    f"Includes only {label}'s required/minimum payment "
                    f"({rupees(occurrence.amount_paise)}); intended payment amount unknown."
                )
            elif occurrence and source and source.kind == "debt":
                if occurrence.required_paise is None:
                    qualifications.append(
                        f"Uses {label}'s intended payment{amount_text}; required/minimum unknown."
                    )
                elif occurrence.required_status == "estimate":
                    qualifications.append(
                        f"{label}'s required/minimum payment is estimated at "
                        f"{rupees(occurrence.required_paise)}."
                    )
            if occurrence and occurrence.amount_basis == "budget":
                qualifications.append(
                    f"Uses {label}{amount_text} per day: estimated share of a monthly budget, "
                    "not a bill."
                )
            elif occurrence and occurrence.amount_basis == "assumed":
                qualifications.append(
                    f"Uses {'proposed' if projection_ref == 'preview.plan' else 'accepted'} "
                    f"{label}{amount_text} on {occurrence.date}: not a completed payment."
                )
            elif (occurrence and occurrence.amount_status == "estimate") or (
                source is None and facts.opening.status == "estimate"
            ):
                qualifications.append(f"Uses estimated {label}{amount_text}.")
            if occurrence and source and source.schedule.certainty == "estimate":
                qualifications.append(f"Uses an approximate date for {label}: {occurrence.date}.")
        results.append(
            WorkspaceResult(
                id=f"{prefix}{identity}",
                amount_paise=amount,
                date=day,
                state="conflicting"
                if identity == "opening"
                and any(item.field == "opening" for item in facts.conflicts)
                else money_state(facts.opening)
                if identity == "opening"
                else "missing"
                if amount is None
                else "estimated"
                if estimated
                else "uncertain"
                if result_issues
                or plan.projection_partial
                and identity not in {"reliableIncome", "uncertainIncome", "datedOutflow"}
                else "known",
                rule=rule,
                contribution_ids=[item.id for item in included],
                excluded_ids=[item.id for item in excluded],
                excluded_reasons=excluded_reasons,
                qualifications=list(dict.fromkeys(qualifications)),
                event_ids=[item.event_id for item in included if item.event_id],
                witness_event_ids=[witness] if witness else [],
                record_ids=record_ids,
                issue_ids=[item.id for item in facts.conflicts if item.field == "opening"]
                if identity == "opening"
                else result_issues,
                dependencies=[
                    "facts.opening",
                    "facts.coverage",
                    "facts.conflicts",
                    "facts.reservePaise",
                ]
                + (
                    ["preview.adjustments"]
                    if projection_ref == "preview.plan"
                    else ["accepted.adjustments"]
                    if snapshot.accepted
                    else []
                ),
                assumptions=assumptions,
                from_date=snapshot.anchor_date,
                until_date_exclusive=snapshot.end_date_exclusive,
            )
        )
    if plan.undated_impact is not None:
        impact = plan.undated_impact
        for entry in impact.items:
            contributions.append(
                Contribution(
                    id=f"{prefix}undated:{entry.record_id}",
                    record_id=entry.record_id,
                    event_id=None,
                    amount_paise=entry.amount_paise,
                    included=entry.amount_paise is not None,
                    reason="undatedWhatIf"
                    if entry.amount_paise is not None
                    else "unknownOccurrenceAmount",
                    references=[
                        f"facts.records.{entry.record_id}",
                        f"{projection_ref}.undatedImpact.items.{entry.record_id}",
                    ],
                )
            )
        for identity, amount, rule in (
            ("undatedOutflow", impact.outflow_paise, "sumOneUndatedPaymentAllowancePerItem"),
            ("undatedClosing", impact.closing_paise, "datedClosingMinusUndatedAllowance"),
        ):
            results.append(
                WorkspaceResult(
                    id=f"{prefix}{identity}",
                    from_date=snapshot.anchor_date,
                    until_date_exclusive=snapshot.end_date_exclusive,
                    amount_paise=amount,
                    state="missing"
                    if amount is None
                    else "uncertain"
                    if impact.unknown_record_ids
                    else "estimated",
                    rule=rule,
                    result_ids=[f"{prefix}closing"] if identity == "undatedClosing" else [],
                    contribution_ids=[
                        f"{prefix}undated:{item.record_id}"
                        for item in impact.items
                        if item.amount_paise is not None
                    ],
                    excluded_ids=[
                        f"{prefix}undated:{item.record_id}"
                        for item in impact.items
                        if item.amount_paise is None
                    ],
                    excluded_reasons={
                        f"{prefix}undated:{item.record_id}": "unknownOccurrenceAmount"
                        for item in impact.items
                        if item.amount_paise is None
                    },
                    qualifications=[impact.qualification]
                    + [f"{item.label}: {item.assumption}" for item in impact.items],
                    event_ids=[],
                    record_ids=[item.record_id for item in impact.items],
                    issue_ids=[
                        item.id
                        for item in plan.decision_assessment.uncertainties
                        if any(
                            identity in {entry.record_id for entry in impact.items}
                            for identity in item.record_ids
                        )
                    ],
                    dependencies=[f"{projection_ref}.undatedImpact"],
                    assumptions=["undatedPaymentWhatIfNotAccepted", "noPaymentExecution"],
                )
            )
    for comparison in plan.income_comparisons:
        conditional_ids = {
            item.event_id for item in comparison.conditions if item.arrival == "reportedDate"
        }
        branch = [
            event.model_copy(update={"included": True})
            if event.id in conditional_ids
            else event.model_copy()
            for event in plan.events
        ]
        reconcile(branch, facts, snapshot.anchor_date, config)
        conditional_results, conditional_contributions = evidence(
            snapshot,
            plan.model_copy(
                update={
                    **comparison.metrics.model_dump(),
                    "events": branch,
                    "first_gap": comparison.metrics.first_gap,
                    "income_comparisons": [],
                    "undated_impact": None,
                }
            ),
            config,
            prefix=f"{prefix}{comparison.id}:",
            projection_ref=projection_ref,
        )
        for result in conditional_results:
            if result.id.rsplit(":", 1)[-1] not in {"closing", "firstGap", "peakGap"}:
                continue
            result.state = "uncertain"
            result.rule = f"conditionalReconcile:{result.id.rsplit(':', 1)[-1]}"
            result.dependencies.append(f"{projection_ref}.incomeComparisons.{comparison.id}")
            result.assumptions.extend(
                f"{condition.event_id}:{condition.arrival}" for condition in comparison.conditions
            )
            results.append(result)
        contributions.extend(conditional_contributions)
    return results, contributions


def change_set(
    before: Snapshot, after: Snapshot, identity: UUID, operation: str, patch: FactsPatch | None
) -> WorkspaceChange | None:
    items: list[ChangeItem] = []
    previous = {
        record.id: record.model_dump(mode="json", by_alias=True) for record in before.facts.records
    }
    current = {
        record.id: record.model_dump(mode="json", by_alias=True) for record in after.facts.records
    }
    for record_id in sorted(previous.keys() | current.keys()):
        fields = field_changes(
            f"facts.records.{record_id}", previous.get(record_id), current.get(record_id)
        )
        if fields:
            items.append(
                ChangeItem(
                    id=f"record:{record_id}",
                    state="created"
                    if record_id not in previous
                    else "deleted"
                    if record_id not in current
                    else "updated",
                    fields=fields,
                    record_ids=[record_id],
                )
            )
    for field in (
        "opening",
        "reservePaise",
        "coverage",
        "decision",
        "providerResponses",
    ):
        fields = field_changes(
            f"facts.{field}",
            before.facts.model_dump(mode="json", by_alias=True)[field],
            after.facts.model_dump(mode="json", by_alias=True)[field],
        )
        if fields:
            items.append(ChangeItem(id=f"facts:{field}", state="updated", fields=fields))
    prior_conflicts = {item.id: item for item in before.facts.conflicts}
    current_conflicts = {item.id: item for item in after.facts.conflicts}
    for conflict_id in sorted(prior_conflicts.keys() | current_conflicts.keys()):
        if patch and any(item.conflict_id == conflict_id for item in patch.resolutions):
            continue
        prior_conflict = prior_conflicts.get(conflict_id)
        current_conflict = current_conflicts.get(conflict_id)
        fields = field_changes(
            f"facts.conflicts.{conflict_id}",
            prior_conflict.model_dump(mode="json", by_alias=True) if prior_conflict else None,
            current_conflict.model_dump(mode="json", by_alias=True) if current_conflict else None,
        )
        if fields:
            items.append(
                ChangeItem(
                    id=conflict_id,
                    state="created"
                    if prior_conflict is None
                    else "deleted"
                    if current_conflict is None
                    else "updated",
                    fields=fields,
                )
            )
    if patch:
        items.extend(
            ChangeItem(
                id=f"merge:{item.source_id}:{item.target_id}",
                state="merged",
                record_ids=[item.source_id, item.target_id],
                fields=[
                    FieldChange(reference="duplicateConfirmation", before=None, after=item.reason)
                ],
            )
            for item in patch.merges
        )
        items.extend(
            ChangeItem(
                id=item.conflict_id,
                state="resolved",
                fields=[
                    FieldChange(
                        reference=item.conflict_id,
                        before=next(
                            (
                                conflict.model_dump(mode="json", by_alias=True)
                                for conflict in before.facts.conflicts
                                if conflict.id == item.conflict_id
                            ),
                            None,
                        ),
                        after=item.value.model_dump(mode="json", by_alias=True),
                    )
                ],
            )
            for item in patch.resolutions
        )
    for field in ("preview", "accepted", "invalidated_assumptions"):
        prior_value = before.model_dump(
            mode="json", include={field}, exclude={"preview": {"plan"}, "accepted": {"plan"}}
        )[field]
        current_value = after.model_dump(
            mode="json", include={field}, exclude={"preview": {"plan"}, "accepted": {"plan"}}
        )[field]
        fields = field_changes(
            field,
            prior_value,
            current_value,
        )
        if fields:
            state = (
                "rejected"
                if operation == "rejectPreview"
                else "discarded"
                if operation == "discardPreview"
                else "accepted"
                if operation == "acceptPreview"
                else "proposed"
                if operation == "previewAdjustments"
                else "invalidated"
                if current_value is None or field == "invalidated_assumptions"
                else "updated"
            )
            items.append(ChangeItem.model_validate({"id": field, "state": state, "fields": fields}))
    old_results = {item.id: item for item in before.workspace.results}
    result_ids = [item.id for item in after.workspace.results if old_results.get(item.id) != item]
    result_ids.extend(
        identity
        for identity in old_results
        if identity not in {item.id for item in after.workspace.results}
    )
    for result_id in result_ids:
        current_result = next(
            (item for item in after.workspace.results if item.id == result_id), None
        )
        prior_result = old_results.get(result_id)
        items.append(
            ChangeItem(
                id=f"result:{result_id}",
                state="updated"
                if prior_result and current_result
                else "created"
                if current_result
                else "deleted",
                fields=field_changes(
                    f"workspace.results.{result_id}",
                    prior_result.model_dump(mode="json", by_alias=True) if prior_result else None,
                    current_result.model_dump(mode="json", by_alias=True)
                    if current_result
                    else None,
                ),
                result_ids=[result_id],
            )
        )
    change = (
        WorkspaceChange(id=identity, revision=after.revision, items=items)
        if items
        else before.latest_change
    )
    # The store computes changes after results; publish relevance using this command's facts.
    after.latest_change = change
    plan = after.accepted.plan if after.accepted else after.plan
    cards = timeline_cards(after, plan, after.workspace)
    after.workspace.cards = (
        [card for card in after.workspace.cards if card.id == "cash"]
        + cards
        + [card for card in after.workspace.cards if card.id == "proposal"]
    )
    old_cards = {item.id: item for item in before.workspace.cards}
    prior_events = {
        item.id: item for item in (before.accepted.plan if before.accepted else before.plan).events
    }
    current_events = {
        item.id: item for item in (after.accepted.plan if after.accepted else after.plan).events
    }
    changed_records = {record_id for item in items for record_id in item.record_ids}
    card_ids = [
        item.id
        for item in after.workspace.cards
        if old_cards.get(item.id) != item
        or changed_records.intersection(item.record_ids)
        or set(result_ids).intersection(item.result_ids)
        or any(
            prior_events.get(identity) != current_events.get(identity)
            for identity in item.event_ids
        )
        or item.id == "proposal"
        and any(change.id in {"preview", "accepted", "invalidated_assumptions"} for change in items)
    ] + [
        item.id
        for item in before.workspace.cards
        if item.id not in {card.id for card in after.workspace.cards}
    ]
    for item in items:
        if not item.result_ids:
            item.result_ids = result_ids
        item.card_ids = card_ids
    return change


def field_changes(reference: str, before: JsonValue, after: JsonValue) -> list[FieldChange]:
    if before == after:
        return []
    if isinstance(before, dict) and isinstance(after, dict):
        return [
            change
            for key in sorted(before.keys() | after.keys())
            for change in field_changes(f"{reference}.{key}", before.get(key), after.get(key))
        ]
    return [FieldChange(reference=reference, before=before, after=after)]
