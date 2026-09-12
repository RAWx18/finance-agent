# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date
from uuid import UUID

from pydantic import JsonValue

from .config import Config
from .finance import dependency_key, reconcile
from .models import (
    ChangeItem,
    Contribution,
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
                if action.id == f"clarify:{item.id}"
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
    if (
        facts.opening.amount_paise is not None
        or any(item.field == "opening" for item in facts.conflicts)
        or facts.reserve_paise
    ):
        workspace.cards.append(
            WorkspaceCard(
                id="cash",
                template="cash",
                section="facts",
                title="Available opening cash",
                state="conflicting"
                if any(item.field == "opening" for item in facts.conflicts)
                else money_state(facts.opening),
                rows=[
                    WorkspaceRow(
                        field="opening",
                        label="Cash at the plan start",
                        value=facts.opening.amount_paise,
                        state="conflicting"
                        if any(item.field == "opening" for item in facts.conflicts)
                        else money_state(facts.opening),
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
                dependencies=["facts.opening", "facts.reservePaise"],
                result_ids=["opening", "reserveShortfall"],
            )
        )
    groups: dict[str, WorkspaceCard] = {}
    for record in facts.records:
        template = (
            "creditCards"
            if record.debt_type == "card"
            else "loans"
            if record.kind == "debt"
            else record.kind
        )
        if template not in groups:
            groups[template] = WorkspaceCard.model_validate(
                {
                    "id": template,
                    "template": template,
                    "section": "facts",
                    "title": {
                        "income": "Expected income",
                        "essential": "Essential spending",
                        "optional": "Optional spending",
                        "loans": "Loan payments",
                        "creditCards": "Credit card payments",
                    }[template],
                    "state": "known",
                }
            )
        card = groups[template]
        card.record_ids.append(record.id)
        reference = f"facts.records.{record.id}"
        card.dependencies.append(reference)
        conflicts = [item for item in facts.conflicts if item.record_id == record.id]
        for field, money in (
            ("amount", record.amount),
            ("target", record.target),
            ("outstanding", record.outstanding),
        ):
            if money is None:
                continue
            state = (
                "conflicting"
                if any(item.field == field for item in conflicts)
                else money_state(money)
            )
            card.rows.append(
                WorkspaceRow(
                    field=f"{record.id}.{field}",
                    label=f"{record.label} · "
                    + (
                        "required/minimum payment"
                        if field == "amount" and record.kind == "debt"
                        else field
                    ),
                    value=money.amount_paise,
                    state=state,
                    references=[f"{reference}.{field}"],
                )
            )
        card.rows.append(
            WorkspaceRow(
                field=f"{record.id}.schedule",
                label=f"{record.label} · timing",
                value=record.schedule.model_dump(mode="json", by_alias=True),
                state="conflicting"
                if any(item.field == "schedule.date" for item in conflicts)
                else "missing"
                if record.schedule.date is None
                else "estimated"
                if record.schedule.certainty == "estimate"
                else "known",
                references=[f"{reference}.schedule"],
            )
        )
        if record.kind == "income":
            card.rows.append(
                WorkspaceRow(
                    field=f"{record.id}.reliability",
                    label=f"{record.label} · receipt certainty",
                    value=record.reliability,
                    state="known" if record.reliability == "reliable" else "uncertain",
                    references=[f"{reference}.reliability"],
                )
            )
        card.event_ids.extend(event.id for event in plan.events if event.record_id == record.id)
        card.issue_ids.extend(
            item.id for item in assessment.uncertainties if record.id in item.record_ids
        )
        card.result_ids = (
            ["reliableIncome", "uncertainIncome"] if record.kind == "income" else ["datedOutflow"]
        )
    states: list[WorkspaceState] = ["conflicting", "missing", "uncertain", "estimated"]
    for card in groups.values():
        card.state = next(
            (state for state in states if any(row.state == state for row in card.rows)),
            "known",
        )
        workspace.cards.append(card)
    for conflict in facts.conflicts:
        card = next(
            card
            for card in workspace.cards
            if (conflict.record_id in card.record_ids if conflict.record_id else card.id == "cash")
        )
        card.issue_ids = list(dict.fromkeys([*card.issue_ids, conflict.id]))
        card.rows.append(
            WorkspaceRow(
                field=conflict.id,
                label="Competing reported values",
                value=conflict.model_dump(mode="json", by_alias=True),
                state="conflicting",
                references=[f"facts.conflicts.{conflict.id}"],
            )
        )
    if workspace.questions:
        workspace.cards.append(
            WorkspaceCard(
                id="questions",
                template="questions",
                section="issues",
                title="Information that changes the plan",
                state="conflicting" if facts.conflicts else "unresolved",
                issue_ids=[item.id for item in workspace.questions],
                record_ids=list(
                    dict.fromkeys(
                        identity for item in workspace.questions for identity in item.record_ids
                    )
                ),
                dependencies=["workspace.questions", "facts.conflicts"],
                rows=[
                    WorkspaceRow(
                        field=item.id,
                        label="Needed information",
                        value=item.model_dump(mode="json", by_alias=True),
                        state="conflicting"
                        if any(conflict.id == item.id for conflict in facts.conflicts)
                        else "unresolved",
                        references=[f"workspace.questions.{item.id}"],
                    )
                    for item in workspace.questions
                ],
            )
        )
    if plan.events:
        workspace.cards.append(
            WorkspaceCard(
                id="timeline",
                template="timeline",
                section="timeline",
                title="Dated cash requirements",
                state="uncertain" if plan.projection_partial else "known",
                event_ids=[event.id for event in plan.events],
                record_ids=list(dict.fromkeys(event.record_id for event in plan.events)),
                result_ids=["closing", "trough", "firstGap", "peakGap"],
                dependencies=["accepted.plan.events" if snapshot.accepted else "plan.events"],
                rows=[
                    WorkspaceRow(
                        field="ordering",
                        label="Same-day order",
                        value="Outflows before income; balances are requirements, "
                        "not executed payments.",
                        state="known",
                        references=[],
                    )
                ],
            )
        )
    if plan.peak_gap_paise or plan.reserve_shortfall_paise:
        workspace.cards.append(
            WorkspaceCard(
                id="gap",
                template="gap",
                section="issues",
                title="Cash gap and timing risk",
                state="unresolved",
                result_ids=["firstGap", "peakGap", "reserveShortfall"],
                event_ids=[
                    event.id
                    for event in plan.events
                    if event.balance_paise is not None and event.balance_paise < 0
                ],
                issue_ids=[item.id for item in assessment.consequences],
                dependencies=[
                    "workspace.results.firstGap",
                    "workspace.results.peakGap",
                    "workspace.results.reserveShortfall",
                ],
            )
        )
    for scenario, identity, scenario_template, title, state in (
        (snapshot.preview, "proposal", "proposal", "Proposed planning change", "proposed"),
        (
            snapshot.accepted,
            "assumptions",
            "assumptions",
            "Accepted planning assumptions · no payments executed",
            "accepted",
        ),
    ):
        if scenario is None:
            continue
        workspace.cards.append(
            WorkspaceCard.model_validate(
                {
                    "id": identity,
                    "template": scenario_template,
                    "section": "decisions",
                    "title": title,
                    "state": state,
                    "record_ids": list(
                        dict.fromkeys(item.record_id for item in scenario.adjustments)
                    ),
                    "event_ids": [item.event_id for item in scenario.adjustments],
                    "result_ids": [
                        f"{'proposal:' if state == 'proposed' else ''}{metric}"
                        for metric in ("firstGap", "peakGap", "closing")
                    ],
                    "dependencies": ["preview" if state == "proposed" else "accepted"],
                    "rows": [
                        WorkspaceRow(
                            field=str(scenario.id),
                            label="Planning assumptions",
                            value=scenario.model_dump(mode="json", by_alias=True, exclude={"plan"}),
                            state=state,
                            references=["preview" if state == "proposed" else "accepted"],
                        )
                    ],
                }
            )
        )
    if snapshot.invalidated_assumptions:
        workspace.cards.append(
            WorkspaceCard(
                id="invalidation",
                template="invalidation",
                section="decisions",
                title="Assumptions need confirmation again",
                state="unresolved",
                event_ids=[item.event_id for item in snapshot.invalidated_assumptions],
                dependencies=["invalidatedAssumptions"],
                rows=[
                    WorkspaceRow(
                        field=item.event_id,
                        label="Invalidated assumption",
                        value=item.reason,
                        state="unresolved",
                        references=[f"invalidatedAssumptions.{item.event_id}"],
                    )
                    for item in snapshot.invalidated_assumptions
                ],
            )
        )
    if assessment.outcome:
        workspace.cards.append(
            WorkspaceCard(
                id="outcome",
                template="outcome",
                section="outcome",
                title="Qualified outlook"
                if assessment.outcome.readiness == "qualified"
                else "Reviewed outlook",
                state="unresolved" if assessment.outcome.readiness == "qualified" else "known",
                result_ids=["closing", "trough", "firstGap", "peakGap", "reserveShortfall"],
                issue_ids=[item.id for item in assessment.uncertainties],
                dependencies=["facts.coverage", "workspace.results", "accepted"],
                rows=[
                    WorkspaceRow(
                        field="outcome",
                        label="Current conclusion",
                        value=assessment.outcome.model_dump(mode="json", by_alias=True),
                        state="unresolved"
                        if assessment.outcome.readiness == "qualified"
                        else "known",
                        references=[
                            "accepted.plan.decisionAssessment.outcome"
                            if snapshot.accepted
                            else "plan.decisionAssessment.outcome"
                        ],
                    )
                ],
            )
        )
    return workspace


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
            "target" if record.target and event.amount_basis != "requiredOnly" else "amount"
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
                else "approximateOutflowDate"
                if record.schedule.certainty != "exact"
                else event.amount_basis,
                date=event.date,
                references=[
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
                ],
            )
        )
    event_records = {event.record_id for event in plan.events}
    for record in facts.records:
        if record.id not in event_records:
            contributions.append(
                Contribution(
                    id=f"{prefix}record:{record.id}",
                    record_id=record.id,
                    event_id=None,
                    amount_paise=(record.target or record.amount).amount_paise,
                    date=record.schedule.date,
                    included=False,
                    reason="unknownDate"
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
            item.record_id is not None
            and (
                (records[item.record_id].target or records[item.record_id].amount).status
                == "estimate"
                or records[item.record_id].schedule.certainty == "estimate"
            )
            for item in included
        )
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
                if issues or plan.projection_partial
                else "known",
                rule=rule,
                contribution_ids=[item.id for item in included],
                excluded_ids=[item.id for item in excluded],
                excluded_reasons={
                    item.id: "countedReliableIncome"
                    if identity == "uncertainIncome" and item.included
                    else "afterResultPoint"
                    if item.included
                    else item.reason
                    for item in excluded
                },
                event_ids=[item.event_id for item in included if item.event_id],
                witness_event_ids=[witness] if witness else [],
                record_ids=list(
                    dict.fromkeys(item.record_id for item in selected if item.record_id)
                ),
                issue_ids=[item.id for item in facts.conflicts if item.field == "opening"]
                if identity == "opening"
                else issues,
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
    old_cards = {item.id: item for item in before.workspace.cards}
    changed_records = {record_id for item in items for record_id in item.record_ids}
    card_ids = [
        item.id
        for item in after.workspace.cards
        if old_cards.get(item.id) != item
        or changed_records.intersection(item.record_ids)
        or set(result_ids).intersection(item.result_ids)
    ] + [
        item.id
        for item in before.workspace.cards
        if item.id not in {card.id for card in after.workspace.cards}
    ]
    for item in items:
        if not item.result_ids:
            item.result_ids = result_ids
        item.card_ids = card_ids
    return (
        WorkspaceChange(id=identity, revision=after.revision, items=items)
        if items
        else before.latest_change
    )


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
