# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import calendar
import hashlib
from datetime import date, timedelta

from .amounts import money_value
from .config import Config
from .decisions import assess
from .facts import facts_input
from .models import (
    Adjustment,
    AdjustmentInput,
    AdjustmentOption,
    BudgetBasis,
    Event,
    Facts,
    FactsInput,
    Gap,
    IncomeComparison,
    IncomeCondition,
    Issue,
    Money,
    MoneyInput,
    Plan,
    ProjectionMetrics,
    ProviderResponse,
    Record,
    Snapshot,
    TimingRisk,
    UndatedImpact,
    UndatedItem,
    UnresolvedAmount,
)


def paise(value: str, config: Config) -> int:
    whole, _, fraction = value.partition(".")
    amount = int(whole) * 100 + int(fraction.ljust(2, "0"))
    if amount > config.max_money_paise:
        raise ValueError("Money exceeds the configured per-amount limit")
    return amount


def money(value: MoneyInput, config: Config) -> Money:
    amount, status = money_value(value, config.max_money_paise)
    return Money(
        amount_paise=amount,
        status=status,
        source=value.model_copy(deep=True) if value.conversion is not None else None,
    )


def normalize(source: FactsInput, config: Config) -> Facts:
    if len(source.records) > config.max_records:
        raise ValueError("Too many financial records")
    if len({record.id for record in source.records}) != len(source.records):
        raise ValueError("Record IDs must be unique")
    if not set(source.decision.focus_record_ids) <= {record.id for record in source.records}:
        raise ValueError("Decision focus must reference existing records")
    if not set(source.decision.ambiguous_record_ids) <= {record.id for record in source.records}:
        raise ValueError("Ambiguous correction must reference existing records")
    if len(source.provider_responses) > config.max_occurrences or len(
        {item.event_id for item in source.provider_responses}
    ) != len(source.provider_responses):
        raise ValueError("Provider responses must identify unique occurrences within the limit")
    for kind, status in source.coverage.model_dump().items():
        present = any(record.kind == kind for record in source.records)
        if status == "none" and present:
            raise ValueError(f"{kind} coverage cannot be none while records exist")
        if status == "reviewed" and not present:
            raise ValueError(f"Use none to explicitly confirm no {kind} records")
    records = []
    for source_record in source.records:
        for value in source_record.schedule.amounts:
            money(value, config)
        record = Record(
            **source_record.model_dump(exclude={"amount", "target", "outstanding"}),
            amount=money(source_record.amount, config),
            target=money(source_record.target, config)
            if source_record.target is not None
            else None,
            outstanding=money(source_record.outstanding, config)
            if source_record.outstanding is not None
            else None,
        )
        if (
            record.target is not None
            and record.target.amount_paise is not None
            and record.amount.amount_paise is not None
            and record.target.amount_paise < record.amount.amount_paise
        ):
            raise ValueError("A selected debt target cannot be below its required payment")
        records.append(record)
    return Facts(
        opening=money(source.opening, config),
        reserve_paise=paise(source.reserve, config),
        coverage=source.coverage,
        records=records,
        decision=source.decision,
        conflicts=source.conflicts,
        provider_responses=[
            ProviderResponse(
                **item.model_dump(exclude={"payment", "cost"}),
                payment=money(item.payment, config) if item.payment is not None else None,
                cost=money(item.cost, config) if item.cost is not None else None,
            )
            for item in source.provider_responses
        ],
    )


def debt_balance_conflict(record: Record) -> bool:
    return (
        record.kind == "debt"
        and record.outstanding is not None
        and record.outstanding.status == "exact"
        and record.outstanding.amount_paise == 0
        and (
            (record.amount.amount_paise is not None and record.amount.amount_paise > 0)
            or any(
                value.amount is not None and money_value(value)[0] != 0
                for value in record.schedule.amounts
            )
        )
    )


def dependency_key(record: Record, event: Event) -> str:
    return hashlib.sha256(
        (
            record.model_dump_json(exclude={"label", "outstanding"})
            + str(debt_balance_conflict(record))
            + event.id
        ).encode()
    ).hexdigest()


def adjustment_options(
    facts: Facts, events: list[Event], anchor: date, end: date, today: date
) -> list[AdjustmentOption]:
    records = {record.id: record for record in facts.records}
    options = []
    for event in events:
        record = records[event.record_id]
        selected = record.target if record.target is not None else record.amount
        if (
            not max(anchor, today) <= event.date < end
            or event.overdue
            or not event.included
            or event.auto_debit
            or selected.status != "exact"
            or record.amount.status != "exact"
            or event.amount_paise is None
            or event.amount_paise <= 0
            or debt_balance_conflict(record)
            or record.schedule.certainty != "exact"
            or any(item.record_id == record.id for item in facts.conflicts)
            or record.controllability == "committed"
            or record.schedule.amounts
            or event.amount_basis == "budget"
        ):
            continue
        if record.kind == "optional":
            minimum = 0
        elif (
            record.kind == "debt"
            and record.debt_type == "card"
            and record.schedule.recurrence == "once"
            and record.target is not None
            and record.amount.amount_paise is not None
            and event.amount_paise > record.amount.amount_paise
        ):
            minimum = record.amount.amount_paise
        else:
            continue
        options.append(
            AdjustmentOption(
                event_id=event.id,
                record_id=record.id,
                label=record.label,
                kind="optional" if record.kind == "optional" else "card",
                date=event.date,
                original_paise=event.amount_paise,
                minimum_paise=minimum,
                acceptance_ready=record.controllability == "controllable",
                dependency_key=dependency_key(record, event),
            )
        )
    return options


def resolve_adjustments(
    inputs: list[AdjustmentInput], options: list[AdjustmentOption], config: Config
) -> list[Adjustment]:
    if not inputs or len(inputs) > config.max_occurrences:
        raise ValueError("Provide between one and max_occurrences adjustments")
    if len({item.event_id for item in inputs}) != len(inputs):
        raise ValueError("Adjustment event IDs must be unique")
    available = {option.event_id: option for option in options}
    adjustments = []
    for item in inputs:
        option = available.get(item.event_id)
        if option is None:
            raise ValueError("Occurrence is not eligible for adjustment; refresh options")
        amount = paise(item.amount, config)
        if not option.minimum_paise <= amount < option.original_paise:
            raise ValueError("Each reduction must be within its minimum and original amount")
        adjustments.append(Adjustment(**option.model_dump(), amount_paise=amount))
    return adjustments


def calculate(
    facts: Facts,
    anchor: date,
    config: Config,
    *,
    adjustments: list[Adjustment] | None = None,
    today: date | None = None,
) -> Plan:
    # Source terms are authoritative, including after persisted-cache or in-memory corrections.
    normalized = normalize(facts_input(facts), config)
    facts.records = normalized.records
    facts.opening = normalized.opening
    records_by_id = {record.id: record for record in facts.records}
    if len(facts.conflicts) > config.max_records * 4 + 1 or len(
        {item.id for item in facts.conflicts}
    ) != len(facts.conflicts):
        raise ValueError("Field conflicts must be unique and within the record limit")
    for conflict in facts.conflicts:
        if conflict.id != f"conflict:{conflict.record_id or 'opening'}:{conflict.field}":
            raise ValueError("Conflict ID must identify its exact field")
        record = records_by_id.get(conflict.record_id or "")
        if conflict.record_id is not None and record is None:
            raise ValueError("Conflict references a missing record")
        if conflict.field in {"target", "outstanding"} and (
            record is None or record.kind != "debt"
        ):
            raise ValueError("Conflict field does not exist on this record")
        for value in conflict.values:
            if value.source is not None:
                if conflict.field != "amount" or record is None or record.kind != "income":
                    raise ValueError("Only income amount conflicts can use currency conversion")
                value.amount_paise, _ = money_value(value.source, config.max_money_paise)
        if any(
            item.amount_paise is not None and item.amount_paise > config.max_money_paise
            for item in conflict.values
        ):
            raise ValueError("Competing amount exceeds the configured money limit")
        disputed = (
            facts.opening
            if record is None
            else record.schedule.date
            if conflict.field == "schedule.date"
            else getattr(record, conflict.field)
        )
        if (
            conflict.field == "schedule.date"
            and (disputed is not None or record is not None and record.schedule.pattern is not None)
        ) or (
            conflict.field != "schedule.date"
            and (not isinstance(disputed, Money) or disputed.amount_paise is not None)
        ):
            raise ValueError("An unresolved disputed field cannot have an authoritative value")
    issues: list[Issue] = []
    events: list[Event] = []
    partial = facts.opening.amount_paise is None

    def issue(
        code: str, message: str, record: Record | None = None, day: date | None = None
    ) -> None:
        issues.append(
            Issue(code=code, message=message, record_id=record.id if record else None, date=day)
        )

    if partial:
        issue("unknownOpening", "Confirm available cash; balances cannot be calculated yet.")
    if facts.opening.status == "estimate":
        issue("estimate", "Opening cash is a reported estimate, not independently verified.")
    for kind, status in facts.coverage.model_dump().items():
        if status not in {"reviewed", "none"}:
            partial = True
            issue(
                "coverageIncomplete", f"Review {kind} coverage; an empty list is not confirmation."
            )
    for record in facts.records:
        selected = record.target if record.target is not None else record.amount
        variable = bool(record.schedule.amounts)
        budget = record.schedule.recurrence == "monthlyBudget"
        if (
            record.schedule.certainty == "exact"
            and record.schedule.date is not None
            and record.schedule.date >= anchor + timedelta(days=config.horizon_days)
        ):
            continue
        if (
            selected.amount_paise == 0
            and record.amount.amount_paise == 0
            and (record.schedule.date is None)
        ):
            continue
        if not variable and (selected.amount_paise is None or record.amount.amount_paise is None):
            partial = True
            issue("unknownAmount", "Confirm the required and selected amounts.", record)
        if not variable and (selected.status == "estimate" or record.amount.status == "estimate"):
            issue(
                "estimate", "This value is a reported estimate, not independently verified.", record
            )
        if record.schedule.certainty == "estimate":
            partial = True
            issue(
                "uncertainDate",
                "The reported budget start is approximate; spending may begin earlier, "
                "including within this horizon. Confirm when the budget should start."
                if budget
                else "The reported date is approximate; earlier obligations remain possible "
                "and receipts are not assured.",
                record,
            )
        if record.reliability in {"uncertain", "unknown"}:
            issue(
                "uncertainIncome" if record.reliability == "uncertain" else "unconfirmedIncome",
                "Uncertain income is displayed but excluded from assurance."
                if record.reliability == "uncertain"
                else "Income reliability is not confirmed; this receipt is excluded from balances.",
                record,
            )
            if record.reliability == "unknown":
                partial = True
        if record.debt_type == "unknown":
            issue(
                "unknownDebtType", "Confirm whether this is a loan, card or informal debt.", record
            )
        if debt_balance_conflict(record):
            issue(
                "debtBalanceConflict",
                "Outstanding was reported as zero while a payment is still due. Confirm "
                "whether these figures refer to the same balance and date before relying "
                "on the plan or comparing a card reduction.",
                record,
            )
        required_only = selected.amount_paise is None and record.amount.amount_paise is not None
        if required_only:
            selected = record.amount
            issue(
                "requiredOnly",
                "Only the reported required/minimum amount is included; the higher selected "
                "target is unknown. This is a partial projection, not an assumed target.",
                record,
            )
        due = record.schedule.date
        pattern = record.schedule.pattern
        if due is None:
            partial = True
            if pattern is None:
                issue(
                    "unknownDate",
                    "Confirm the next unpaid/future date; no date is assumed.",
                    record,
                )
                continue
            issue(
                "monthlyPattern",
                "Dates calculated from the reported monthly pattern are estimates; timing "
                "is unconfirmed. No arrears are inferred and income is not assured.",
                record,
            )
        if budget:
            issue(
                "monthlyBudget",
                "Calendar-month spending budget spread evenly by actual month length; daily "
                "amounts and timing are forecasts, not contractual bills or executed payments.",
                record,
            )
        occurrences: list[tuple[date, date, int]] = []
        count = len(record.schedule.amounts) if variable else record.schedule.count
        end_date = record.schedule.end_date

        def active(
            day: date, index: int, count: int | None = count, end_date: date | None = end_date
        ) -> bool:
            return (count is None or index < count) and (end_date is None or day <= end_date)

        if pattern is not None:
            months = {
                (day.year, day.month)
                for day in (
                    anchor + timedelta(days=offset) for offset in range(config.horizon_days)
                )
                if end_date is None or day <= end_date
            }
            for year, month in sorted(months):
                month_days = calendar.monthrange(year, month)[1]
                month_day = pattern.day if pattern.day is not None else month_days
                if month_day > month_days:
                    if active(date(year, month, month_days), 0):
                        issue(
                            "missingMonthDay",
                            f"No day {month_day} in {year}-{month:02} for {record.label}; "
                            "confirm the due date. Month-end is not assumed.",
                            record,
                            max(anchor, date(year, month, 1)),
                        )
                    continue
                day = date(year, month, month_day)
                if anchor <= day < anchor + timedelta(days=config.horizon_days) and active(day, 0):
                    occurrences.append((day, day, 0))
        if due is not None and due < anchor and not budget:
            if record.kind == "income":
                partial = True
                issue(
                    "pastIncome",
                    f"Is {record.label} from {due} already in opening cash? Reconcile the cash "
                    "basis and remove the past receipt, or report its actual pending date; "
                    "it is not counted as future income.",
                    record,
                    anchor,
                )
            else:
                occurrences.append((anchor, due, 0))
                if record.schedule.recurrence != "once" and count != 1:
                    partial = True
                    issue(
                        "overdueRecurrence",
                        f"One overdue {record.label} item is carried; confirm the dates and "
                        "amounts of other unpaid installments.",
                        record,
                        anchor,
                    )
        if due is not None and record.schedule.recurrence == "monthly":
            months = {
                (day.year, day.month)
                for day in (
                    anchor + timedelta(days=offset) for offset in range(config.horizon_days)
                )
                if (day.year, day.month) >= (due.year, due.month)
            }
            for year, month in sorted(months):
                index = (year - due.year) * 12 + month - due.month
                if due.day > calendar.monthrange(year, month)[1] and active(
                    date(year, month, calendar.monthrange(year, month)[1]), index
                ):
                    partial = True
                    issue(
                        "missingMonthDay",
                        f"No day {due.day} in {year}-{month:02} for {record.label}; "
                        "confirm the due date.",
                        record,
                        max(anchor, date(year, month, 1)),
                    )
        for offset in range(config.horizon_days):
            if due is None:
                break
            day = anchor + timedelta(days=offset)
            if day < due:
                continue
            distance = (day - due).days
            recurrence = record.schedule.recurrence
            index = (
                (day.year - due.year) * 12 + day.month - due.month
                if recurrence in {"monthly", "monthlyBudget"}
                else distance // {"once": 1, "daily": 1, "weekly": 7, "fortnightly": 14}[recurrence]
            )
            if (
                (recurrence == "once" and day == due)
                or (recurrence == "weekly" and distance % 7 == 0)
                or (recurrence == "fortnightly" and distance % 14 == 0)
                or (recurrence == "monthly" and day.day == due.day)
                or recurrence in {"daily", "monthlyBudget"}
            ) and active(day, index):
                occurrences.append((day, day, index))
        for day, original, index in occurrences:
            required = money(record.schedule.amounts[index], config) if variable else record.amount
            counted = required if variable or required_only else selected
            if variable and counted.amount_paise is None:
                partial = True
                issue(
                    "unknownAmount",
                    "Confirm this occurrence's amount and conversion terms.",
                    record,
                    day,
                )
            if variable and counted.status == "estimate":
                issue("estimate", "This occurrence amount is a reported estimate.", record, day)
            if budget:
                amount = counted.amount_paise
                if amount is not None:
                    daily, remainder = divmod(amount, calendar.monthrange(day.year, day.month)[1])
                    amount = daily + int(day.day <= remainder)
                counted = Money(
                    amount_paise=amount, status="estimate" if amount is not None else "unknown"
                )
            events.append(
                Event(
                    id=f"{record.id}:{original.isoformat()}",
                    record_id=record.id,
                    label=record.label,
                    kind=record.kind,
                    date=day,
                    original_due_date=original,
                    date_assumption=(
                        f"Calculated for {day} from reported monthly "
                        + (f"day {pattern.day}" if pattern.kind == "dayOfMonth" else "month-end")
                        + " pattern; timing unconfirmed"
                    )
                    if pattern is not None
                    else None,
                    amount_paise=counted.amount_paise,
                    amount_status=counted.status,
                    required_paise=None
                    if budget or record.kind != "debt"
                    else required.amount_paise,
                    required_status="unknown"
                    if budget or record.kind != "debt"
                    else required.status,
                    source=counted.source,
                    schedule_index=index if variable or budget or count is not None else None,
                    amount_basis="budget"
                    if budget
                    else "requiredOnly"
                    if required_only
                    else "reported",
                    included=counted.amount_paise is not None
                    and (
                        record.kind != "income"
                        or (
                            record.reliability == "reliable"
                            and counted.status == "exact"
                            and record.schedule.certainty == "exact"
                            and pattern is None
                        )
                    ),
                    overdue=original < anchor,
                    auto_debit=record.auto_debit,
                    balance_paise=None,
                )
            )
        if len(events) > config.max_occurrences:
            raise ValueError("Too many expanded occurrences")
    events.sort(
        key=lambda event: (
            event.date,
            event.kind == "income",
            event.kind,
            event.label.casefold(),
            event.id,
        )
    )
    if adjustments is not None:
        # Eligibility is checked on preview/accept; saved assumptions retain their occurrences.
        events_by_id = {event.id: event for event in events}
        if len({item.event_id for item in adjustments}) != len(adjustments):
            raise ValueError("Recorded assumptions must have unique occurrence IDs")
        for item in adjustments:
            event = events_by_id.get(item.event_id)
            if (
                event is None
                or event.record_id != item.record_id
                or event.date != item.date
                or event.amount_paise != item.original_paise
                or not 0 <= item.minimum_paise <= item.amount_paise < item.original_paise
                or event.amount_basis == "budget"
                or records_by_id[event.record_id].schedule.amounts
            ):
                raise ValueError("Recorded assumption does not match its reported occurrence")
            event.amount_paise = item.amount_paise
            event.amount_basis = "assumed"
            event.amount_status = "estimate"
            if item.kind == "card":
                issue(
                    "cardMinimum",
                    "A card minimum is not payoff; interest and fees may still apply. "
                    "Verify the statement and changeable payment before acting.",
                    next(record for record in facts.records if record.id == item.record_id),
                )
    metrics, timing_issues = reconcile(events, facts, anchor, config)
    issues.extend(timing_issues)
    unresolved = []
    for record in facts.records:
        if record.schedule.date is not None and not any(
            event.record_id == record.id for event in events
        ):
            continue
        selected = record.target if record.target is not None else record.amount
        variable = bool(record.schedule.amounts)
        if selected.amount_paise == 0 and record.amount.amount_paise == 0:
            continue
        for reason, missing in (
            (
                "missingDate",
                record.schedule.date is None and record.schedule.pattern is None,
            ),
            (
                "missingAmount",
                any(event.record_id == record.id and event.amount_paise is None for event in events)
                if variable and record.schedule.date is not None
                else any(
                    money(value, config).amount_paise is None for value in record.schedule.amounts
                )
                if variable
                else record.amount.amount_paise is None,
            ),
            ("unknownTarget", record.target is not None and record.target.amount_paise is None),
        ):
            if missing:
                unresolved.append(
                    UnresolvedAmount(
                        record_id=record.id,
                        reason=reason,
                        amount=selected if selected.amount_paise is not None else record.amount,
                        recurrence=record.schedule.recurrence,
                    )
                )
    undated_items = []
    unknown_ids = []
    for record in sorted(facts.records, key=lambda item: item.id):
        if (
            record.kind == "income"
            or record.schedule.date is not None
            or record.schedule.pattern is not None
            or record.schedule.end_date is not None
            and record.schedule.end_date < anchor
        ):
            continue
        selected = record.target if record.target is not None else record.amount
        if selected.amount_paise == 0 and record.amount.amount_paise == 0:
            continue
        required_only = selected.amount_paise is None and record.amount.amount_paise is not None
        if required_only:
            selected = record.amount
        computable = (
            record.schedule.recurrence in {"once", "monthly"}
            and not record.schedule.amounts
            and record.schedule.count is None
        )
        assumption = (
            f"One monthly payment within this {config.horizon_days}-day period; unpaid status "
            "and timing need confirmation. This is one occurrence, not a limit on payments."
            if computable and record.schedule.recurrence == "monthly"
            else f"If this unpaid payment falls within these {config.horizon_days} days."
            if computable
            else "Occurrence count within this period is unknown without a start date; "
            "variable or unanchored sequences are excluded from the allowance."
        )
        if required_only:
            assumption += " Uses only the required/minimum; the higher intended target is unknown."
        elif record.target is not None:
            assumption += " Uses the intended target, not an additional payment."
        if record.amount.amount_paise is None and not record.schedule.amounts:
            assumption += (
                " Required/minimum payment is unknown; the intended target is not a guarantee."
                if record.kind == "debt"
                else " Payment amount is unknown."
            )
        if (
            not computable
            or record.amount.amount_paise is None
            or record.target is not None
            and record.target.amount_paise is None
        ):
            unknown_ids.append(record.id)
        undated_items.append(
            UndatedItem(
                record_id=record.id,
                label=record.label,
                amount_paise=selected.amount_paise if computable else None,
                status=selected.status if computable else "unknown",
                recurrence=record.schedule.recurrence,
                amount_basis="requiredOnly" if required_only else "reported",
                required_paise=record.amount.amount_paise if record.kind == "debt" else None,
                target_paise=record.target.amount_paise if record.target is not None else None,
                assumption=assumption,
            )
        )
    undated_impact = None
    if undated_items:
        allowance = sum(item.amount_paise or 0 for item in undated_items)
        closing = metrics.closing_paise - allowance if metrics.closing_paise is not None else None
        if max(allowance + metrics.outflow_paise, abs(closing or 0)) > config.max_total_paise:
            raise ValueError("Projection exceeds the configured aggregate money limit")
        undated_impact = UndatedImpact(
            items=undated_items,
            outflow_paise=allowance,
            closing_paise=closing,
            status="unknown" if unknown_ids or closing is None else "estimate",
            unknown_record_ids=unknown_ids,
            qualification="What-if only: undated income is excluded. Unknown amounts, additional "
            "occurrences and unreported payments may increase the need; this is not an upper "
            "bound or proof of on-time affordability. No dates, consent or payments are assumed.",
        )
    plan = Plan(
        **metrics.model_dump(),
        evaluated_on=today or anchor,
        projection_partial=partial,
        events=events,
        issues=issues,
        undated_impact=undated_impact,
        budget_basis=BudgetBasis(
            dated_projection_complete=not unresolved
            and facts.opening.amount_paise is not None
            and not any(
                item.code
                in {
                    "missingMonthDay",
                    "overdueRecurrence",
                    "pastIncome",
                    "uncertainDate",
                    "monthlyPattern",
                }
                for item in issues
            ),
            unresolved_amounts=unresolved,
        ),
    )
    conditional = [
        event
        for event in events
        if event.kind == "income" and not event.included and event.amount_paise is not None
    ]
    if conditional:
        for arrival in ("reportedDate", "notByHorizon"):
            branch = [
                event.model_copy(update={"included": arrival == "reportedDate"})
                if event in conditional
                else event.model_copy()
                for event in events
            ]
            comparison, _ = reconcile(branch, facts, anchor, config)
            plan.income_comparisons.append(
                IncomeComparison(
                    id=f"income:{arrival}",
                    conditions=[
                        IncomeCondition(event_id=event.id, arrival=arrival) for event in conditional
                    ],
                    metrics=comparison,
                )
            )
    options = (
        adjustment_options(
            facts, events, anchor, anchor + timedelta(days=config.horizon_days), today or anchor
        )
        if plan.peak_gap_paise or plan.reserve_shortfall_paise
        else []
    )
    amounts = {option.event_id: option.minimum_paise for option in options}
    for event in events:
        record = records_by_id[event.record_id]
        if (
            plan.peak_gap_paise
            and record.debt_type == "loan"
            and record.target is not None
            and event.amount_status == event.required_status == "exact"
            and event.required_paise is not None
            and event.amount_paise is not None
            and event.amount_paise > event.required_paise
            and event.included
            and event.date >= max(anchor, today or anchor)
            and not event.overdue
            and not event.auto_debit
            and record.controllability == "controllable"
            and record.schedule.certainty == "exact"
            and not debt_balance_conflict(record)
            and not any(item.record_id == record.id for item in facts.conflicts)
        ):
            # A required-only loan comparison is not an eligible adjustment.
            amounts[event.id] = event.required_paise
    impacts = {}
    for identity, amount in amounts.items():
        branch = [
            event.model_copy(update={"amount_paise": amount})
            if event.id == identity
            else event.model_copy()
            for event in events
        ]
        impacts[identity], _ = reconcile(branch, facts, anchor, config)
    minimums: dict[date, dict[str, int]] = {}
    for option in options:
        if option.kind == "card" and option.acceptance_ready:
            minimums.setdefault(option.date, {})[option.event_id] = option.minimum_paise
    minimum_impacts = {}
    for day, amounts in minimums.items():
        if len(amounts) < 2:
            continue
        branch = [
            event.model_copy(update={"amount_paise": amounts[event.id]})
            if event.id in amounts
            else event.model_copy()
            for event in events
        ]
        minimum_impacts[day], _ = reconcile(branch, facts, anchor, config)
    receipt_impacts = {}
    for receipt in conditional:
        branch = [
            event.model_copy(update={"included": True})
            if event.id == receipt.id
            else event.model_copy()
            for event in events
        ]
        receipt_impacts[receipt.id], _ = reconcile(branch, facts, anchor, config)
    plan.decision_assessment = assess(
        facts,
        plan,
        anchor,
        options,
        impacts,
        receipt_impacts,
        minimum_impacts,
        today=today or anchor,
    )
    return plan


def reconcile(
    events: list[Event], facts: Facts, anchor: date, config: Config
) -> tuple[ProjectionMetrics, list[Issue]]:
    """Reconcile dated requirements; negative balances never imply payment execution."""
    issues: list[Issue] = []
    balance = facts.opening.amount_paise
    trough = balance
    first_gap = (
        Gap(date=anchor, amount_paise=-balance) if balance is not None and balance < 0 else None
    )
    reliable = uncertain = outflow = 0
    receipts = {
        event.date
        for event in events
        if event.kind == "income" and event.included and event.amount_paise
    }
    timing_exposure: dict[date, int] = {}
    day_balances: dict[date, int] = {}
    deficit_dates: set[date] = set()
    for event in events:
        if event.amount_paise is not None:
            if event.kind == "income":
                if event.included:
                    reliable += event.amount_paise
                else:
                    uncertain += event.amount_paise
            else:
                outflow += event.amount_paise
        if event.included and event.amount_paise is not None and balance is not None:
            balance += event.amount_paise if event.kind == "income" else -event.amount_paise
            trough = min(trough if trough is not None else balance, balance)
            if balance < 0:
                if first_gap is None:
                    first_gap = Gap(date=event.date, amount_paise=-balance)
                elif event.date == first_gap.date:
                    first_gap.amount_paise = max(first_gap.amount_paise, -balance)
                if event.kind != "income":
                    deficit_dates.add(event.date)
                    if event.date in receipts and event.amount_paise:
                        timing_exposure[event.date] = max(
                            timing_exposure.get(event.date, 0), -balance
                        )
            day_balances[event.date] = balance
        event.balance_paise = balance
        if max(reliable, uncertain, outflow, abs(balance or 0)) > config.max_total_paise:
            raise ValueError("Projection exceeds the configured aggregate money limit")
    for event in events:
        if event.auto_debit and event.date in deficit_dates:
            issues.append(
                Issue(
                    code="autoDebitRisk",
                    record_id=event.record_id,
                    date=event.date,
                    message=f"On {event.date}, projected cash is insufficient. Whether this "
                    "automatic debit clears depends on transaction timing.",
                )
            )
    for day in sorted(timing_exposure):
        issues.append(
            Issue(
                code="sameDayTiming",
                date=day,
                message=f"On {day}, payments are counted before money arriving that day. "
                "Check that money is available before paying; automatic debits may still fail.",
            )
        )
    peak = None if trough is None else max(0, -trough)
    reserve_shortfall = None if trough is None else max(0, facts.reserve_paise - max(0, trough))
    if reserve_shortfall:
        issues.append(
            Issue(
                code="reserveShortfall",
                message="The reserve floor is not maintained; this is distinct from a cash gap.",
            )
        )
    return ProjectionMetrics(
        reliable_income_paise=reliable,
        uncertain_income_paise=uncertain,
        outflow_paise=outflow,
        closing_paise=balance,
        trough_paise=trough,
        first_gap=first_gap,
        peak_gap_paise=peak,
        reserve_shortfall_paise=reserve_shortfall,
        peak_gap_date=next((event.date for event in events if event.balance_paise == trough), None)
        if peak
        else None,
        timing_risks=[
            TimingRisk(
                date=day,
                exposure_paise=timing_exposure[day],
                remaining_gap_paise=max(0, -day_balances[day]),
            )
            for day in sorted(timing_exposure)
        ],
    ), issues


def export_text(snapshot: Snapshot) -> str:
    def rupees(amount: int | None) -> str:
        if amount is None:
            return "unknown"
        return f"INR {'-' if amount < 0 else ''}{abs(amount) // 100}.{abs(amount) % 100:02}"

    def source_details(source: MoneyInput) -> str:
        conversion = source.conversion
        if conversion is None:
            return f"INR {source.amount or 'unknown'} ({source.status}, reported)"
        return (
            f"source {conversion.currency} {source.amount or 'unknown'} ({source.status}); "
            f"INR per {conversion.currency} rate {conversion.rate or 'unknown'} "
            f"({conversion.rate_status}), rate date {conversion.rate_date or 'unknown'}; "
            f"INR fee {conversion.fee if conversion.fee is not None else 'unknown'} "
            f"({conversion.fee_status}); net INR is derived, not an additional receipt"
        )

    def amount_details(record: Record) -> str:
        selected = record.target if record.target is not None else record.amount
        text = f"{rupees(selected.amount_paise)} ({selected.status}, reported)"
        if record.schedule.amounts:
            text = "varies by occurrence: " + "; ".join(
                f"index {index}: {source_details(value)}"
                for index, value in enumerate(record.schedule.amounts)
            )
        elif selected.source is not None:
            text = (
                f"net {rupees(selected.amount_paise)} ({selected.status}, derived); "
                + source_details(selected.source)
            )
        if record.schedule.recurrence == "monthlyBudget":
            text += (
                "; calendar-month budget distributed evenly by actual month length; "
                "integer remainder assigned to earliest month days; "
                "estimated daily timing, not bills"
            )
        if record.target is not None:
            text = (
                f"selected target {text}; required/minimum {rupees(record.amount.amount_paise)} "
                f"({record.amount.status}, reported)"
            )
        if record.outstanding is not None:
            text += (
                f"; outstanding {rupees(record.outstanding.amount_paise)} "
                f"({record.outstanding.status}, reported; unchanged)"
            )
        return text

    plan = snapshot.accepted.plan if snapshot.accepted is not None else snapshot.plan
    assessment = plan.decision_assessment
    records = {record.id: record for record in snapshot.facts.records}
    outcome = assessment.outcome
    relevant_actions = [
        action for action in assessment.actions if action.id == assessment.next_action_id
    ]
    relevant_actions.extend(
        action
        for action in assessment.actions
        if action.id != assessment.next_action_id
        and action.kind
        in {"contactPayee", "verifyTerms", "followUp", "seekSupport", "resolveGroup"}
    )
    rows = [
        "30-day cashflow review — not a payment instruction",
        "Decision and next actions:",
        *(outcome.true_now if outcome else []),
        *(
            f"- {action.before_date or 'Review'} | {action.question}"
            for action in relevant_actions[:2]
        ),
        *(
            f"Conditional {comparison.id} (joint assumption): closing "
            f"{rupees(comparison.metrics.closing_paise)}; peak cumulative gap "
            f"{rupees(comparison.metrics.peak_gap_paise)} "
            f"on {comparison.metrics.peak_gap_date}."
            for comparison in plan.income_comparisons
        ),
        outcome.revisit if outcome else "Revisit when reported facts change.",
        "Supporting report:",
        f"Cash basis: {snapshot.as_of.isoformat()} (fixed; revision {snapshot.revision})",
        f"Local dates: {snapshot.anchor_date} to "
        f"{snapshot.end_date_exclusive - timedelta(days=1)} inclusive; "
        "Asia/Kolkata.",
        "Opening edits correct cash at this original basis, not today's account balance. "
        "Start a fresh projection for a current cash position.",
        "Income received and costs paid before the cash basis belong in opening cash, "
        "not in projected receipts or costs.",
        f"Outlook: {assessment.outcome.branch if assessment.outcome else 'uncertain'}; "
        "known projection "
        f"{'is partial' if plan.projection_partial else 'uses reviewed coverage'}.",
        f"Opening: {rupees(snapshot.facts.opening.amount_paise)} "
        f"({snapshot.facts.opening.status}, reported).",
        f"Reliable dated receipts: {rupees(plan.reliable_income_paise)}.",
        "Uncertain dated receipts (excluded, not treated as confirmed zero): "
        f"{rupees(plan.uncertain_income_paise)}.",
        f"Known planned outflows: {rupees(plan.outflow_paise)}.",
        f"Closing = opening + reliable receipts - planned outflows: {rupees(plan.closing_paise)}.",
        *(
            qualification
            for result in snapshot.workspace.results
            if result.id == "closing"
            for qualification in result.qualifications
        ),
        f"Trough: {rupees(plan.trough_paise)}; "
        f"peak cumulative cash gap: {rupees(plan.peak_gap_paise)}.",
        f"Reserve floor (not an expense): {rupees(snapshot.facts.reserve_paise)}; "
        f"reserve shortfall: {rupees(plan.reserve_shortfall_paise)}.",
        f"First gap: {plan.first_gap.date}, {rupees(plan.first_gap.amount_paise)}."
        if plan.first_gap
        else "First gap: unknown."
        if plan.closing_paise is None
        else "First gap: none in known projection.",
        "Same-day debits precede receipts. No payment execution or allocation is performed.",
        *(
            f"Timing exposure on {risk.date}: {rupees(risk.exposure_paise)} before same-day "
            f"receipts; remaining funding gap after included receipts: "
            f"{rupees(risk.remaining_gap_paise)}. Actual payment timing is not confirmed."
            for risk in plan.timing_risks
        ),
        "Closing is a dated requirements remainder, never an available-to-spend claim.",
    ]
    if snapshot.accepted is not None:
        rows.append("Accepted planning assumptions (reported facts remain unchanged):")
        for item in snapshot.accepted.adjustments:
            rows.append(
                f"- {item.date} | {item.label} [{item.record_id}] | "
                f"{rupees(item.original_paise)} -> {rupees(item.amount_paise)}; "
                + (
                    "confirmed controllable/uncommitted occurrence"
                    if item.kind == "optional"
                    else f"checked minimum {rupees(item.minimum_paise)} and changeable payment; "
                    "minimum is not payoff; interest and fees may still apply"
                )
            )
        rows.append("reduced planned outflow: " + rupees(snapshot.accepted.reduced_outflow_paise))
        for label, projection in (("Reported baseline", snapshot.plan), ("Accepted", plan)):
            gap = (
                f"{projection.first_gap.date}, {rupees(projection.first_gap.amount_paise)}"
                if projection.first_gap
                else "unknown"
                if projection.closing_paise is None
                else "none in known projection"
            )
            rows.append(
                f"{label}: first gap {gap}; peak gap {rupees(projection.peak_gap_paise)} "
                f"on {projection.peak_gap_date or 'no known gap date'}; reserve shortfall "
                f"{rupees(projection.reserve_shortfall_paise)}; closing "
                f"{rupees(projection.closing_paise)}; "
                f"partial: {'yes' if projection.projection_partial else 'no'}."
            )
    else:
        rows.append("Reported baseline only; no accepted planning assumptions.")
    if plan.undated_impact is not None:
        impact = plan.undated_impact
        rows.extend(
            [
                f"Undated payment what-if: allowance {rupees(impact.outflow_paise)}; "
                f"dated closing minus allowance {rupees(impact.closing_paise)} ({impact.status}).",
                impact.qualification,
                *(
                    f"- {item.label} [{item.record_id}]: {rupees(item.amount_paise)} "
                    f"({item.status}, {item.amount_basis}); {item.assumption}"
                    for item in impact.items
                ),
            ]
        )
    rows.append("Dated rows:")
    for event in plan.events:
        basis = (
            "required/minimum only; selected target unknown"
            if event.amount_basis == "requiredOnly"
            else "accepted planning assumption"
            if event.amount_basis == "assumed"
            else "monthly budget daily forecast; assumed timing, not a contractual due"
            if event.amount_basis == "budget"
            else "reported amount"
        )
        rows.append(
            f"{event.date} | {event.kind} | {event.label} [{event.record_id}] | "
            f"reported: {amount_details(records[event.record_id])} | "
            f"planned occurrence {rupees(event.amount_paise)} ({event.amount_status}; {basis}) | "
            f"schedule index {event.schedule_index}; "
            f"required {rupees(event.required_paise)} ({event.required_status}) | "
            + (source_details(event.source) + " | " if event.source is not None else "")
            + (
                f"estimated date: {event.date_assumption} | "
                if event.date_assumption
                else f"due {event.original_due_date} | "
            )
            + f"{'included' if event.included else 'excluded/unknown'} | "
            f"{'auto-debit' if event.auto_debit else 'reported schedule'} | "
            f"balance {rupees(event.balance_paise)}"
        )
    rows.append("Reported records (including those outside the projection):")
    for record in snapshot.facts.records:
        rows.append(
            f"{record.label} [{record.id}] | {record.kind} | {amount_details(record)} | "
            f"date {record.schedule.date or 'unknown'}; {record.schedule.recurrence}; "
            f"end inclusive {record.schedule.end_date or 'unbounded'}; "
            f"count {record.schedule.count or (len(record.schedule.amounts) or 'unbounded')}; "
            f"auto-debit {'yes' if record.auto_debit else 'no'}; "
            f"reliability {record.reliability or 'not applicable'}"
        )
        if record.schedule.pattern is not None:
            pattern = record.schedule.pattern
            rows.append(
                "Reported monthly pattern: "
                + (f"day {pattern.day}" if pattern.kind == "dayOfMonth" else "month-end")
                + "; next date unknown; calculated occurrences have estimated timing."
            )
        elif record.schedule.date is None:
            rows.append(
                f"Unresolved date | {record.kind} | {record.label} [{record.id}] | "
                f"{amount_details(record)} | excluded from dated projection pending its date"
            )
    rows.append("Uncertainty and verification:")
    for conflict in snapshot.facts.conflicts:
        rows.append(f"Conflict {conflict.id}:")
        rows.extend(
            f"- {value.id}: "
            + (
                source_details(value.source)
                if value.source is not None
                else str(value.date)
                if value.date is not None
                else f"{rupees(value.amount_paise)} ({value.status})"
            )
            for value in conflict.values
        )
    for issue in plan.issues:
        label = (
            f"{records[issue.record_id].label} [{issue.record_id}]: "
            if issue.record_id in records
            else ""
        )
        rows.append(f"- {label}{issue.message}")
    for invalidated in snapshot.invalidated_assumptions:
        rows.append(f"Invalidated assumption {invalidated.event_id}: {invalidated.reason}")
    rows.append(
        "No payments have been executed; outstanding balances are informational and unchanged."
    )
    return "\n".join(rows) + "\n"
