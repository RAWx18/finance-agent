# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import hashlib
import json
from datetime import date
from itertools import groupby

from .models import (
    Action,
    AdjustmentAmount,
    AdjustmentOption,
    Choice,
    Consequence,
    Constraint,
    DecisionAssessment,
    Facts,
    Outcome,
    Plan,
    ProjectionMetrics,
    Uncertainty,
)

UNAVAILABLE_ACTIONS = frozenset(
    {
        "clarify",
        "confirmReceipt",
        "verifyTerms",
        "contactPayee",
        "followUp",
        "seekSupport",
        "resolveGroup",
    }
)


def rupees(amount: int | None) -> str:
    if amount is None:
        return "unknown"
    return f"INR {'-' if amount < 0 else ''}{abs(amount) // 100}.{abs(amount) % 100:02}"


def action_dependency_key(facts: Facts, plan: Plan, action_id: str) -> str | None:
    """Bind a response to its source question or occurrence, not presentation or plan totals."""
    prefix, _, identity = action_id.partition(":")
    values: dict[str, object] = {"actionId": action_id}
    records = {record.id: record for record in facts.records}
    if prefix == "clarify" and identity == "opening":
        values["opening"] = facts.opening.model_dump(mode="json")
    elif prefix == "clarify" and identity == "coverage":
        values["coverage"] = {
            kind: {
                "status": status,
                "records": sorted(record.id for record in facts.records if record.kind == kind),
            }
            for kind, status in facts.coverage.model_dump().items()
            if status not in {"reviewed", "none"}
        }
    elif prefix in {"preview", "contact", "response"}:
        event = next((item for item in plan.events if item.id == identity), None)
        if event is None or event.kind == "income":
            return None
        record = records[event.record_id]
        values["occurrence"] = event.model_dump(
            mode="json", include={"id", "kind", "original_due_date", "date", "amount_paise"}
        )
        values["record"] = record.model_dump(
            mode="json",
            include={"id", "kind", "amount", "target", "debt_type", "auto_debit"}
            | ({"controllability"} if prefix == "preview" else set()),
        )
        values["debtConflict"] = any(
            issue.code == "debtBalanceConflict" and issue.record_id == record.id
            for issue in plan.issues
        )
        if prefix in {"contact", "response"}:
            values["providerResponse"] = [
                item.model_dump(mode="json", exclude={"dependency_key"})
                for item in facts.provider_responses
                if item.event_id == identity
            ]
    elif prefix == "group":
        events = sorted(
            (
                event
                for event in plan.events
                if str(event.date) == identity
                and event.kind != "income"
                and event.amount_paise != 0
                and (
                    event.kind in {"essential", "debt"}
                    or event.auto_debit
                    or records[event.record_id].controllability == "committed"
                )
            ),
            key=lambda event: event.id,
        )
        if len(events) < 2:
            return None
        values["occurrences"] = [
            event.model_dump(
                mode="json", include={"id", "kind", "original_due_date", "date", "amount_paise"}
            )
            for event in events
        ]
        values["records"] = [
            records[event.record_id].model_dump(
                mode="json",
                include={
                    "id",
                    "kind",
                    "amount",
                    "target",
                    "debt_type",
                    "auto_debit",
                    "controllability",
                },
            )
            for event in events
        ]
        values["providerResponses"] = [
            item.model_dump(mode="json", exclude={"dependency_key"})
            for item in sorted(facts.provider_responses, key=lambda item: item.event_id)
            if item.event_id in {event.id for event in events}
        ]
        values["debtConflicts"] = sorted(
            issue.record_id
            for issue in plan.issues
            if issue.code == "debtBalanceConflict"
            and issue.record_id in {event.record_id for event in events}
        )
    elif prefix in {"clarify", "receipt"}:
        record_id, _, field = identity.partition(":")
        field = "receipt" if prefix == "receipt" else field.partition(":")[0]
        fields = {
            "schedule.date": {"schedule"},
            "amount": {"amount", "target", "schedule"},
            "target": {"amount", "target", "schedule"},
            "estimate": {"amount", "target", "schedule"},
            "receipt": {"amount", "schedule", "reliability"},
            "controllability": {
                "amount",
                "target",
                "schedule",
                "controllability",
                "auto_debit",
                "debt_type",
            },
            "debtBalanceConflict": {"amount", "target", "outstanding", "schedule", "debt_type"},
            "overdueRecurrence": {"amount", "schedule"},
            "missingMonthDay": {"schedule"},
            "pastIncome": {"amount", "schedule", "reliability"},
            "sameDayTiming": {"amount", "target", "schedule", "reliability", "auto_debit"},
        }.get(field)
        if fields is None:
            return None
        identities = (
            {
                event.record_id
                for event in plan.events
                if str(event.date) == identity.rsplit(":", 1)[-1]
            }
            if field == "sameDayTiming" and record_id == "schedule"
            else {record_id}
        )
        if not identities or not identities <= records.keys():
            return None
        values["records"] = [
            records[item].model_dump(mode="json", include={"id", "kind"} | fields)
            for item in sorted(identities)
        ]
        if field == "pastIncome":
            values["opening"] = facts.opening.model_dump(mode="json")
    else:
        return None
    return hashlib.sha256(
        json.dumps(values, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def assess(
    facts: Facts,
    plan: Plan,
    anchor: date,
    options: list[AdjustmentOption],
    impacts: dict[str, ProjectionMetrics],
    receipt_impacts: dict[str, ProjectionMetrics],
    minimum_impacts: dict[date, ProjectionMetrics],
    *,
    today: date,
) -> DecisionAssessment:
    assessment = DecisionAssessment()
    records = {record.id: record for record in facts.records}
    responses = {response.event_id: response for response in facts.provider_responses}
    answered = {
        item.action_id: item.response
        for item in facts.decision.responses
        if item.dependency_key == action_dependency_key(facts, plan, item.action_id)
    }
    focus = set(facts.decision.focus_record_ids)
    dues = [event for event in plan.events if event.kind != "income" and event.amount_paise != 0]
    deadline = (
        plan.first_gap.date
        if plan.first_gap
        else min((event.date for event in dues if event.date >= today), default=today)
    )
    questions: dict[str, str] = {}
    dependencies: list[Action] = []
    changes: list[Action] = []
    change_order: dict[str, tuple[int, bool]] = {}
    enquiries: list[Action] = []
    followups: list[Action] = []
    deferred: list[Action] = []

    def semantic(action: Action) -> tuple[date, bool, list[tuple[str, str]]]:
        return (
            action.before_date or today,
            not bool(focus & set(action.record_ids)),
            sorted(
                (records[identity].kind, records[identity].label.casefold())
                for identity in action.record_ids
            ),
        )

    def labels(identities: list[str]) -> str:
        names = [records[identity].label for identity in identities]
        return ", ".join(names[:2]) + (
            f" and {len(names) - 2} other items" if len(names) > 2 else ""
        )

    def question(
        identity: str,
        field: str,
        text: str,
        record_ids: list[str],
        reason: str,
        *,
        day: date | None = None,
        kind: str = "missing",
        immediate: bool = False,
        ask: bool = True,
    ) -> Action:
        assessment.uncertainties.append(
            Uncertainty(
                id=identity,
                kind=kind,
                record_ids=record_ids,
                field=field,
                question=text,
                changes=["when", "affordability"]
                if field in {"schedule.date", "schedule", "reliability"}
                else ["what", "when", "affordability"]
                if field == "providerResponses"
                else ["what", "affordability"],
                blocks=["immediateDecision", "fullPlan"] if immediate else ["fullPlan"],
                priority=0,
                reason=reason,
                before_date=day,
            )
        )
        action = Action(
            id=f"clarify:{identity}",
            kind="clarify",
            record_ids=record_ids,
            before_date=day,
            question=text,
            consequence_ids=[],
            if_declined_consequence_ids=[],
        )
        if ask:
            assessment.actions.append(action)
            questions[action.id] = identity
            if immediate:
                dependencies.append(action)
        return action

    if facts.opening.status != "exact":
        question(
            "opening",
            "opening",
            "What cash was available at the original cash basis?",
            [],
            "Unknown opening cash prevents a funded comparison."
            if facts.opening.amount_paise is None
            else "Conclusions use the reported cash estimate; no error range is assumed.",
            kind="missing" if facts.opening.amount_paise is None else "uncertain",
            immediate=facts.opening.amount_paise is None,
            ask=facts.opening.amount_paise is None,
        )
    for unresolved in plan.budget_basis.unresolved_amounts:
        record = records[unresolved.record_id]
        day = record.schedule.date
        required = (
            record.kind in {"essential", "debt"}
            or record.auto_debit
            or record.controllability == "committed"
        )
        field = (
            "schedule.date"
            if unresolved.reason == "missingDate"
            else ("target" if unresolved.reason == "unknownTarget" else "amount")
        )
        if field == "schedule.date" and required:
            assessment.constraints.append(
                Constraint(
                    id=f"{record.id}:undated",
                    kind="essential"
                    if record.kind == "essential"
                    else "minimumDue"
                    if record.kind == "debt"
                    else "autoDebit"
                    if record.auto_debit
                    else "committed",
                    event_ids=[],
                    date=None,
                    amount_paise=record.amount.amount_paise,
                )
            )
        minimum_short = bool(
            plan.first_gap and field == "target" and record.amount.amount_paise is not None
        )
        immediate = (
            (day is None or day <= deadline)
            and not minimum_short
            and (required or record.kind == "income" or record.id in focus)
        )
        action = question(
            f"{record.id}:{field}",
            field,
            f"When is {record.label} next due or expected?"
            if field == "schedule.date"
            else f"What is the {'intended payment' if field == 'target' else 'amount'} "
            f"for {record.label}?",
            [record.id],
            "The required minimum already has a shortfall; intended extras cannot remove it."
            if minimum_short
            else "This unplaced or incomplete obligation can change the next funding decision."
            if immediate
            else "This qualifies later spending, not the earlier required deadline.",
            day=day,
            immediate=immediate,
        )
        if (
            not immediate
            and not minimum_short
            and (
                facts.decision.intent == "plan30Days"
                or required
                or record.kind == "income"
                or record.id in focus
            )
        ):
            deferred.append(action)
    for record in facts.records:
        events = [
            event
            for event in plan.events
            if event.record_id == record.id and event.amount_paise != 0
        ]
        if not events:
            continue
        selected = record.target if record.target is not None else record.amount
        if (
            record.kind == "income"
            and selected.amount_paise
            and (record.reliability != "reliable" or selected.status != "exact")
        ):
            effective = [
                event
                for event in events
                if event.id in receipt_impacts
                and receipt_impacts[event.id].first_gap != plan.first_gap
                and event.date <= deadline
            ]
            relevant_due = next(
                (event.date for event in dues if event.date >= max(today, events[0].date)), None
            )
            unknown = record.reliability == "unknown"
            text = (
                f"Will {record.label}, {rupees(selected.amount_paise)}, be available before "
                f"the payment deadline {relevant_due or deadline}?"
                if unknown
                else f"{record.label} is explicitly uncertain. Confirm actual receipt before "
                f"committing payments on {relevant_due or events[0].date}; do not count it yet."
            )
            question(
                f"{record.id}:receipt",
                "reliability",
                text,
                [record.id],
                "Including this receipt changes the first exposed deadline; availability is a "
                "funding dependency."
                if effective
                else "Including this receipt cannot fund the earlier deadline; it qualifies later "
                "commitments only.",
                day=relevant_due or events[0].date,
                kind="uncertain",
                immediate=bool(effective) and unknown,
                ask=unknown,
            )
            if not unknown and relevant_due is not None:
                action = Action(
                    id=f"receipt:{record.id}",
                    kind="confirmReceipt",
                    record_ids=[record.id],
                    before_date=relevant_due,
                    question=text,
                    consequence_ids=[],
                    if_declined_consequence_ids=[],
                )
                assessment.actions.append(action)
                followups.append(action)
        elif selected.status == "estimate" or record.amount.status == "estimate":
            exposed = bool(
                plan.first_gap and any(today <= event.date <= deadline for event in events)
            )
            question(
                f"{record.id}:estimate",
                "amount",
                f"{record.label} is estimated at {rupees(selected.amount_paise)} on "
                f"{events[0].date}. Could you hold off before committing, or confirm a smaller "
                "planned amount? The estimate stays in the plan until you report a decision."
                if exposed and record.kind == "optional"
                else f"Can you confirm {record.label}'s estimated amount of "
                f"{rupees(selected.amount_paise)} before its exposed deadline?"
                if exposed
                else f"{record.label} uses a reported estimate of {rupees(selected.amount_paise)}.",
                [record.id],
                "This estimate contributes to the imminent shortfall; a confirmed amount or "
                "a controllable spending decision can change affordability."
                if exposed
                else "Use a qualified conclusion at the reported estimate; no invented "
                "range or exactness gate. Revisit if the amount changes.",
                day=events[0].date,
                kind="uncertain",
                immediate=exposed,
                ask=exposed,
            )
    for issue in plan.issues:
        if issue.code not in {
            "debtBalanceConflict",
            "overdueRecurrence",
            "missingMonthDay",
            "sameDayTiming",
            "pastIncome",
        }:
            continue
        affected = records.get(issue.record_id or "")
        if (
            issue.code == "debtBalanceConflict"
            and affected is not None
            and not any(event.record_id == affected.id for event in dues)
        ):
            continue
        day = issue.date or (affected.schedule.date if affected else None)
        record_ids = (
            [affected.id]
            if affected
            else list(dict.fromkeys(event.record_id for event in plan.events if event.date == day))
        )
        immediate = day is None or day <= deadline
        action = question(
            f"{issue.record_id or 'schedule'}:{issue.code}"
            + (f":{day}" if issue.code in {"sameDayTiming", "missingMonthDay"} else ""),
            "debtTerms"
            if issue.code == "debtBalanceConflict"
            else "opening"
            if issue.code == "pastIncome"
            else "schedule",
            "Do the zero outstanding and required payment describe the same account and "
            "date, and is the payment still due?"
            if issue.code == "debtBalanceConflict"
            else issue.message,
            record_ids,
            "This affects the exposed obligation or receipt order."
            if immediate
            else "This affects a later obligation, not the earlier exposed deadline.",
            day=day,
            immediate=immediate,
            kind="conflict" if issue.code == "debtBalanceConflict" else "uncertain",
        )
        if not immediate:
            deferred.append(action)
    for day, grouped in groupby(plan.events, key=lambda event: event.date):
        events = list(grouped)
        due = [event for event in events if event.kind != "income" and event.amount_paise != 0]
        for event in due:
            record = records[event.record_id]
            kinds = []
            if record.kind == "essential":
                kinds.append("essential")
            if record.kind == "debt":
                kinds.append("minimumDue")
            if event.auto_debit:
                kinds.append("autoDebit")
            if record.controllability == "committed":
                kinds.append("committed")
            for kind in kinds:
                assessment.constraints.append(
                    Constraint(
                        id=f"{event.id}:{kind}",
                        kind=kind,
                        event_ids=[event.id],
                        date=day,
                        amount_paise=record.amount.amount_paise
                        if kind == "minimumDue"
                        else event.amount_paise,
                    )
                )
        exposure = max(
            (max(0, -event.balance_paise) for event in due if event.balance_paise is not None),
            default=0,
        )
        if not exposure:
            continue
        consequence_id = f"cash:{day}"
        assessment.consequences.append(
            Consequence(
                id=consequence_id,
                kind="cashExposure",
                event_ids=sorted(event.id for event in due),
                date=day,
                amount_paise=exposure,
            )
        )
        targets = [
            option
            for option in options
            if option.date == day and option.kind == "card" and option.acceptance_ready
        ]
        minimum = minimum_impacts.get(day)
        if (
            minimum is not None
            and not plan.projection_partial
            and plan.budget_basis.dated_projection_complete
            and not assessment.uncertainties
            and (minimum.first_gap is None or minimum.first_gap.date > day)
            and all(answered.get(f"preview:{option.event_id}") == "declined" for option in targets)
        ):
            action = Action(
                id=f"review:{day}",
                kind="reviewOutcome",
                record_ids=[option.record_id for option in targets],
                before_date=day,
                question=f"{rupees(exposure)} remains a shortfall against "
                f"{labels([option.record_id for option in targets])}'s intended payments of "
                f"{rupees(sum(option.original_paise for option in targets))} on {day}, not their "
                "combined required minimum of "
                f"{rupees(sum(option.minimum_paise for option in targets))}. "
                "The required minimums fit at that deadline in the modeled comparison with other "
                "reported commitments unchanged. You declined the minimum-only reductions; "
                "intended payments and required minimums stay unchanged. "
                "No payment or payee agreement is assumed.",
                consequence_ids=[consequence_id],
                if_declined_consequence_ids=[],
            )
            assessment.actions.append(action)
            deferred.append(action)
            continue
        mandatory = [
            event
            for event in due
            if (
                event.kind in {"essential", "debt"}
                or event.auto_debit
                or records[event.record_id].controllability == "committed"
            )
            and not any(
                option.event_id == event.id
                and option.kind == "card"
                and option.acceptance_ready
                and exposure <= option.original_paise - option.minimum_paise
                for option in options
            )
        ]
        if len(mandatory) > 1 and not focus.intersection(event.record_id for event in mandatory):
            text = (
                f"Resolve {labels([event.record_id for event in mandatory])} together on {day}: "
                f"{rupees(exposure)} remains unfunded across this date's commitments. Protect "
                "essential needs and confirm auto-debit control and consequences before deciding "
                "what can change; no payment allocation is assumed."
            )
            action = Action(
                id=f"group:{day}",
                kind="resolveGroup",
                record_ids=[event.record_id for event in mandatory],
                before_date=day,
                question=text,
                consequence_ids=[consequence_id],
                if_declined_consequence_ids=[consequence_id],
            )
            assessment.actions.append(action)
            enquiries.append(action)
            continue
        for event in mandatory:
            record = records[event.record_id]
            response = responses.get(event.id)
            if response is not None and response.status in {"awaiting", "declined"}:
                text = (
                    f"Follow up with {record.label} before {event.original_due_date}; the response "
                    f"is awaiting. {rupees(exposure)} remains unfunded; original dues stay due."
                    if response.status == "awaiting"
                    else f"{record.label} declined flexibility for {event.original_due_date}; "
                    f"{rupees(exposure)} remains unfunded without a chosen change. "
                    "Confirm consequences and the payee's hardship process or seek "
                    "qualified debt/support advice; no approval or new loan is assumed."
                )
                action = Action(
                    id=f"response:{event.id}",
                    kind="followUp" if response.status == "awaiting" else "seekSupport",
                    record_ids=[record.id],
                    before_date=event.original_due_date,
                    question=text,
                    consequence_ids=[consequence_id],
                    if_declined_consequence_ids=[consequence_id],
                )
                assessment.actions.append(action)
                followups.append(action)
                continue
            text = (
                f"{record.label} on {event.original_due_date}: "
                f"{rupees(exposure)} remains unfunded. "
                "What flexibility has actually been confirmed? Ask the payee for the payment "
                "amount, date, cost, acceptance requirements and auto-debit implications. "
                "Original dues remain without agreement; cash exposure is before any chosen "
                "spending change."
            )
            if event.overdue or event.original_due_date < today:
                text = (
                    f"{record.label} is overdue from {event.original_due_date}; contact promptly. "
                    + text
                )
            if response is not None:
                terms = "; ".join(
                    f"{name} {rupees(value.amount_paise)} ({value.status}, reported)"
                    if value is not None and value.amount_paise is not None
                    else f"unknown {name}"
                    for name, value in (("payment", response.payment), ("cost", response.cost))
                )
                text = (
                    f"Verify reported terms for {record.label} due {event.original_due_date}: "
                    f"{terms}; payment date {response.payment_date or 'unknown'}. "
                    "Confirm applicability, acceptance requirements and auto-debit implications; "
                    f"{rupees(exposure)} "
                    "remains unfunded under original dues, unchanged without agreement."
                )
            action = question(
                f"provider:{event.id}",
                "providerResponses",
                text,
                [record.id],
                "Changing the required payment needs confirmed terms; a separate spending "
                "reduction is not a payee agreement.",
                day=event.original_due_date,
                kind="uncertain",
            )
            del questions[action.id]
            action.id = f"contact:{event.id}"
            action.kind = "verifyTerms" if response else "contactPayee"
            action.choice_id = f"enquire:{event.id}"
            action.consequence_ids = [consequence_id]
            action.if_declined_consequence_ids = [consequence_id]
            questions[action.id] = f"provider:{event.id}"
            enquiries.append(action)
            assessment.choices.append(
                Choice(
                    id=action.choice_id,
                    kind="enquire",
                    event_ids=[event.id],
                    prerequisite_ids=[],
                    adjustment_amounts=[],
                    consequence_ids=[consequence_id],
                )
            )
    if facts.reserve_paise:
        assessment.constraints.append(
            Constraint(
                id="reserve",
                kind="reserve",
                event_ids=[],
                date=None,
                amount_paise=facts.reserve_paise,
            )
        )
    if plan.reserve_shortfall_paise:
        points = [(anchor, facts.opening.amount_paise)] + [
            (event.date, event.balance_paise) for event in plan.events
        ]
        day = next(
            day for day, balance in points if balance is not None and balance < facts.reserve_paise
        )
        assessment.consequences.append(
            Consequence(
                id="reserve:breach",
                kind="reserveBreach",
                event_ids=[],
                date=day,
                amount_paise=max(
                    facts.reserve_paise - max(0, balance)
                    for point_day, balance in points
                    if point_day == day and balance is not None
                ),
            )
        )
    for comparison in plan.income_comparisons:
        assessment.consequences.append(
            Consequence(
                id=f"conditional:{comparison.id}",
                kind="conditionalIncome",
                event_ids=[item.event_id for item in comparison.conditions],
                date=comparison.metrics.peak_gap_date,
                amount_paise=comparison.metrics.peak_gap_paise,
                comparison_id=comparison.id,
            )
        )
    for option in options:
        impact = impacts[option.event_id]
        first = plan.first_gap is not None and impact.first_gap != plan.first_gap
        peak = impact.peak_gap_paise != plan.peak_gap_paise
        useful = (
            first
            if plan.first_gap
            else impact.reserve_shortfall_paise != plan.reserve_shortfall_paise
        )
        prerequisites = []
        if not option.acceptance_ready:
            action = question(
                f"{option.record_id}:controllability",
                "controllability",
                f"Is {option.label}, {rupees(option.original_paise)} on {option.date}, actually "
                "changeable and uncommitted?",
                [option.record_id],
                "This reduction improves the first gap; confirm control before consent."
                if first
                else "Control qualifies this later or discretionary reduction; it cannot "
                "repair an earlier gap.",
                day=option.date,
            )
            prerequisites.append(f"{option.record_id}:controllability")
        else:
            residual = (
                f"{rupees(impact.first_gap.amount_paise)} still unfunded on "
                f"{impact.first_gap.date}; "
                if impact.first_gap
                else "no cash gap in this comparison; "
            )
            action = Action(
                id=f"preview:{option.event_id}",
                kind="previewChange",
                record_ids=[option.record_id],
                before_date=option.date,
                question=f"Preview reducing {option.label} on {option.date} from "
                f"{rupees(option.original_paise)} to {rupees(option.minimum_paise)}: {residual}"
                "facts stay unchanged and applying the proposal requires your explicit consent."
                + (
                    " The card minimum is not payoff; interest and fees may still apply."
                    if option.kind == "card"
                    else ""
                ),
                consequence_ids=[
                    item.id for item in assessment.consequences if item.kind == "cashExposure"
                ],
                if_declined_consequence_ids=[],
            )
            assessment.actions.append(action)
        action.choice_id = f"reduce:{option.event_id}"
        assessment.choices.append(
            Choice(
                id=action.choice_id,
                kind="reduceOptional" if option.kind == "optional" else "cardMinimum",
                event_ids=[option.event_id],
                prerequisite_ids=prerequisites,
                adjustment_amounts=[
                    AdjustmentAmount(event_id=event.id, amount_paise=event.amount_paise)
                    for event in plan.events
                    if event.amount_basis == "assumed"
                    and event.amount_paise is not None
                    and event.id != option.event_id
                ]
                + [AdjustmentAmount(event_id=option.event_id, amount_paise=option.minimum_paise)],
                consequence_ids=[
                    item.id for item in assessment.consequences if item.kind == "cashExposure"
                ],
                affects_first_gap=first,
                affects_peak_gap=peak,
                later_only=plan.first_gap is not None and not first and not peak,
                metrics=impact,
            )
        )
        if useful:
            changes.append(action)
            change_order[action.id] = (
                impact.first_gap.amount_paise
                if impact.first_gap and impact.first_gap.date <= deadline
                else 0,
                not option.acceptance_ready,
            )
    scope = {
        kind: status
        for kind, status in facts.coverage.model_dump().items()
        if status not in {"reviewed", "none"}
    }
    coverage = None
    if scope:
        ask = facts.decision.intent == "plan30Days" and any(
            status in {"notDiscussed", "reported"} for status in scope.values()
        )
        action = question(
            "coverage",
            "coverage",
            "What payments, essential spending and expected income need to be covered over "
            "the next 30 days? Start with the next payment or receipt, its amount and date."
            if not facts.records
            else "Before closing this 30-day plan, is anything else missing: payments, income, "
            "essential spending or planned purchases? Confirm what is complete, absent or "
            "still unknown in the remaining scope (" + ", ".join(scope) + ").",
            [],
            "Unreported items are not zero. One scope check qualifies the whole-period "
            "conclusion without blocking a useful immediate decision.",
            kind="coverage",
            ask=ask,
        )
        if ask:
            coverage = action

    pending = [action for action in followups if action.kind in {"followUp", "seekSupport"}]
    deferred_steps = [
        action
        for action in assessment.actions
        if action.kind in UNAVAILABLE_ACTIONS - {"clarify", "confirmReceipt"}
        and answered.get(action.id) == "unavailable"
    ]
    blocked = {
        action.id
        for action in assessment.actions
        if (action.kind in UNAVAILABLE_ACTIONS and answered.get(action.id) == "unavailable")
        or (action.kind == "previewChange" and answered.get(action.id) == "declined")
    }
    assessment.actions = [action for action in assessment.actions if action.id not in blocked]
    available_choices = {action.choice_id for action in assessment.actions}
    assessment.choices = [choice for choice in assessment.choices if choice.id in available_choices]
    if coverage is not None and coverage.id in blocked:
        coverage = None

    # Facts gate only their dependent deadline; modeled relief precedes negotiations.
    for candidates in (dependencies, changes, enquiries, followups, deferred):
        candidates[:] = [action for action in candidates if action.id not in blocked]
        candidates.sort(key=semantic)
    changes.sort(key=lambda action: (change_order[action.id], semantic(action)))
    if facts.opening.amount_paise is None:
        dependencies.sort(key=lambda action: action.id != "clarify:opening")
    selected_action = next(
        (items[0] for items in (dependencies, changes, enquiries, followups, deferred) if items),
        coverage,
    )
    if selected_action is None:
        target = (
            next(
                (
                    option
                    for option in options
                    if option.kind == "card"
                    and option.acceptance_ready
                    and option.date == deadline
                    and answered.get(f"preview:{option.event_id}") == "declined"
                    and (
                        (gap := impacts[option.event_id].first_gap) is None
                        or gap.date > option.date
                    )
                ),
                None,
            )
            if plan.first_gap
            and plan.budget_basis.dated_projection_complete
            and not assessment.uncertainties
            else None
        )
        elapsed = bool(plan.peak_gap_paise and not any(event.date >= today for event in dues))
        selected_action = Action(
            id="reconcile" if elapsed else "review",
            kind="reconcileStatus" if elapsed else "reviewOutcome",
            record_ids=[target.record_id] if target else [],
            before_date=target.date if target else today if elapsed else None,
            question=f"{rupees(plan.first_gap.amount_paise)} remains a shortfall against "
            f"{target.label}'s intended payment of {rupees(target.original_paise)} on "
            f"{target.date}, not its required minimum of {rupees(target.minimum_paise)}. "
            "The required minimum fits at that deadline in the modeled comparison with other "
            "reported commitments unchanged. You declined the minimum-only reduction; the "
            "intended payment and required minimum stay unchanged. "
            "No payment or payee agreement is assumed."
            if target and plan.first_gap
            else "Confirm which elapsed commitments remain unpaid and the current cash "
            "position before starting a fresh plan; no retrospective reduction is available."
            if elapsed
            else "No further funded change is established for the remaining shortfall; keep "
            "original commitments and unresolved risks explicit. Revisit when information or "
            "your choices change."
            if plan.peak_gap_paise
            else "Use this qualified comparison for the reported commitments; revisit before "
            "committing unreported spending or if amounts or dates change.",
            consequence_ids=[item.id for item in assessment.consequences],
            if_declined_consequence_ids=[],
        )
        assessment.actions.append(selected_action)
    assessment.next_action_id = selected_action.id
    assessment.next_question_id = questions.get(selected_action.id)
    assessment.actions = [selected_action] + sorted(
        (action for action in assessment.actions if action is not selected_action), key=semantic
    )
    action_order = {action.id: index for index, action in enumerate(assessment.actions)}
    question_order = {
        identity: action_order[action_id]
        for action_id, identity in questions.items()
        if action_id in action_order
    }
    assessment.uncertainties.sort(
        key=lambda item: (
            question_order.get(item.id, len(action_order)),
            item.before_date or today,
            sorted(
                (records[identity].kind, records[identity].label.casefold())
                for identity in item.record_ids
            ),
        )
    )
    for index, uncertainty in enumerate(assessment.uncertainties):
        uncertainty.priority = index
        if uncertainty.id == assessment.next_question_id:
            uncertainty.blocks = ["immediateDecision", "fullPlan"]
    choice_order = {
        action.choice_id: index
        for index, action in enumerate(assessment.actions)
        if action.choice_id
    }
    assessment.choices.sort(key=lambda item: choice_order[item.id])

    qualified = bool(assessment.uncertainties or assessment.consequences or plan.projection_partial)
    incomplete = list(
        dict.fromkeys(
            f"{records[item.record_id].label} "
            + (
                "(date)"
                if item.reason == "missingDate"
                else "(intended payment amount)"
                if item.reason == "unknownTarget"
                else "(amount)"
            )
            for item in plan.budget_basis.unresolved_amounts
        )
    )
    incomplete.extend(
        f"{records[item.record_id].label} "
        f"({'opening cash basis' if item.code == 'pastIncome' else 'recurrence dates'})"
        for item in plan.issues
        if item.code in {"missingMonthDay", "overdueRecurrence", "pastIncome"}
        and item.record_id in records
    )
    if plan.first_gap:
        summary = (
            f"First shortfall {rupees(plan.first_gap.amount_paise)} on {plan.first_gap.date}; "
            f"peak cumulative shortfall {rupees(plan.peak_gap_paise)} on {plan.peak_gap_date}. "
            "These are not amounts to add together."
        )
    elif plan.closing_paise is None:
        summary = "Available opening cash is unknown, so funding cannot yet be established."
    elif incomplete:
        summary = (
            "Unresolved "
            + "; ".join(incomplete[:2])
            + (f" and {len(incomplete) - 2} other details" if len(incomplete) > 2 else "")
            + "; full-period affordability cannot yet be established."
        )
    elif scope and not plan.events:
        summary = (
            "Payments and income coverage is unconfirmed; opening cash alone does not "
            "establish what the next 30 days can cover."
        )
    else:
        summary = (
            "For reported commitments, dated payments fit with a minimum cash cushion of "
            f"{rupees(plan.trough_paise)}; this is conditional on reported amounts and timing"
            + (" and does not cover unconfirmed scope." if scope else ".")
        )
    covered = (
        f"Reported opening cash is {rupees(facts.opening.amount_paise)}; payments and receipts "
        "have not been fully placed, so no available-to-spend amount is established."
        if not plan.events and (scope or not plan.budget_basis.dated_projection_complete)
        else f"Reported opening cash {rupees(facts.opening.amount_paise)} and reliable receipts "
        f"{rupees(plan.reliable_income_paise)} are compared with planned payments "
        f"{rupees(plan.outflow_paise)}; closing {rupees(plan.closing_paise)} is not spendable cash."
    )
    if plan.budget_basis.dated_projection_complete and plan.trough_paise is not None:
        covered += (
            f" Modeled headroom above the reserve floor is "
            f"{rupees(max(0, plan.trough_paise - facts.reserve_paise))} at the lowest balance; "
            "this is not permission for unreported spending."
            if plan.trough_paise >= facts.reserve_paise and (plan.events or not scope)
            else ""
        )
    risks = [item for item in assessment.consequences if item.kind == "cashExposure"]
    critical_risks = [
        item
        for item in risks
        if item.date in {plan.first_gap.date if plan.first_gap else None, plan.peak_gap_date}
    ]
    exposed_ids = list(
        dict.fromkeys(
            event.record_id
            for event in dues
            if any(event.id in item.event_ids for item in critical_risks)
        )
    )
    not_covered = (
        f"{labels(exposed_ids)} face unfunded commitments; no payment allocation or execution "
        "is assumed."
        if exposed_ids
        else "No known cash shortage is modeled; unreported costs and actual payment execution "
        "are not established."
    )
    if plan.reserve_shortfall_paise:
        not_covered += (
            f" Reserve floor shortfall {rupees(plan.reserve_shortfall_paise)} is separate."
        )
    if pending:
        not_covered += " " + " ".join(
            f"{labels(action.record_ids)}: "
            f"{'awaiting response' if action.kind == 'followUp' else 'declined'}; "
            "original due remains."
            for action in pending[:2]
        )
    conditions = "Reported facts and accepted assumptions are not completed payments or approvals."
    if "unavailable" in answered.values():
        conditions += " Unavailable details remain unknown, not confirmation of funds or coverage."
    if deferred_steps:
        conditions += (
            " Deferred steps remain outstanding for "
            + labels(
                list(
                    dict.fromkeys(
                        identity for action in deferred_steps for identity in action.record_ids
                    )
                )
            )
            + "; no payee response or completed action is implied."
        )
    if "declined" in answered.values():
        conditions += (
            " Declined reductions are not applied; controllability and dues stay unchanged."
        )
    if any(item.kind == "coverage" for item in assessment.uncertainties):
        conditions += " Category coverage is incomplete."
    if any(
        item.field in {"amount", "opening"} and item.kind == "uncertain"
        for item in assessment.uncertainties
    ):
        conditions += " Reported estimates qualify the result; no error range is assumed."
    if not plan.budget_basis.dated_projection_complete:
        conditions += " Unresolved amounts or dates prevent any available-to-spend conclusion."
    if plan.income_comparisons:
        conditions += " Uncertain receipts are excluded; arrival comparisons are conditional."
    later = next(
        (
            event
            for event in plan.events
            if event.kind == "income"
            and event.amount_paise
            and plan.first_gap
            and event.date > plan.first_gap.date
        ),
        None,
    )
    if later:
        conditions += f" {later.label} on {later.date} cannot fund the earlier deadline."
    if any(choice.later_only for choice in assessment.choices):
        conditions += " Later reductions do not solve the first or peak gap."
    if any(choice.kind == "cardMinimum" for choice in assessment.choices) or any(
        issue.code == "cardMinimum" for issue in plan.issues
    ):
        conditions += " Card minimum is not payoff; interest and fees may still apply."
    assessment.outcome = Outcome(
        branch="conflict"
        if any(item.kind == "conflict" for item in assessment.uncertainties)
        else "gap"
        if plan.peak_gap_paise
        else "uncertain"
        if qualified
        else "fits",
        readiness="qualified" if qualified else "ready",
        summary=summary,
        covered=covered,
        not_covered=not_covered,
        next_step=selected_action.question,
        conditions=conditions,
        true_now=[summary, covered, not_covered, conditions],
        risk_ids=[item.id for item in assessment.consequences],
        choice_ids=[item.id for item in assessment.choices],
        next_action_id=selected_action.id,
        uncertain=[item.id for item in assessment.uncertainties],
        revisit="Recalculate after a receipt correction, changed obligation or provider response; "
        "confirm receipt before the next dependent payment. "
        "Accepted assumptions are not completed actions.",
    )
    return assessment
