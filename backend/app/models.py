# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import re
from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


Status = Literal["exact", "estimate", "unknown"]
Kind = Literal["income", "essential", "optional", "debt"]
CoverageStatus = Literal["notDiscussed", "reported", "reviewed", "none", "unknown"]
Controllability = Literal["unknown", "controllable", "committed"]
ActionResponseValue = Literal["unavailable", "declined"]
RecordId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
Rupees = Annotated[str, Field(pattern=r"^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$", max_length=16)]


class MoneyInput(Model):
    amount: Rupees | None
    status: Status

    @model_validator(mode="after")
    def validate_status(self) -> "MoneyInput":
        if (self.amount is None) != (self.status == "unknown"):
            raise ValueError("Unknown money must be null; exact/estimate money needs an amount")
        return self


class Money(Model):
    amount_paise: int | None
    status: Status


class Schedule(Model):
    date: date | None
    recurrence: Literal["once", "weekly", "fortnightly", "monthly"] = "once"


class RecordBase(Model):
    id: RecordId
    kind: Kind
    label: str = Field(min_length=1, max_length=120)
    schedule: Schedule
    reliability: Literal["reliable", "uncertain", "unknown"] | None = None
    debt_type: Literal["loan", "card", "informal", "unknown"] | None = None
    auto_debit: bool = False
    controllability: Controllability | None = None

    @model_validator(mode="after")
    def validate_record(self) -> "RecordBase":
        if not self.label.strip() or re.search(r"[\x00-\x1f\x7f]", self.label):
            raise ValueError("Label must be nonempty text without control characters")
        if (self.kind == "income") != (self.reliability is not None):
            raise ValueError("Only income requires reliability")
        if (self.kind == "debt") != (self.debt_type is not None):
            raise ValueError("Only debt requires debtType")
        if self.auto_debit and self.kind == "income":
            raise ValueError("Income cannot be an auto-debit")
        if self.kind == "income" and self.controllability is not None:
            raise ValueError("Controllability applies only to outflows")
        if self.kind != "income" and self.controllability is None:
            self.controllability = "unknown"
        return self


class RecordInput(RecordBase):
    amount: MoneyInput
    target: MoneyInput | None = None
    outstanding: MoneyInput | None = None

    @model_validator(mode="after")
    def validate_debt_fields(self) -> "RecordInput":
        if self.kind != "debt" and (self.target is not None or self.outstanding is not None):
            raise ValueError("Target and outstanding apply only to debt")
        return self


class Record(RecordBase):
    amount: Money
    target: Money | None = None
    outstanding: Money | None = None


class Coverage(Model):
    income: CoverageStatus = "notDiscussed"
    essential: CoverageStatus = "notDiscussed"
    optional: CoverageStatus = "notDiscussed"
    debt: CoverageStatus = "notDiscussed"


class FactsInput(Model):
    opening: MoneyInput
    reserve: Rupees = "0"
    coverage: Coverage
    records: list[RecordInput]
    decision: "Decision" = Field(default_factory=lambda: Decision())
    provider_responses: list["ProviderResponseInput"] = Field(default_factory=list)


class Facts(Model):
    opening: Money
    reserve_paise: int
    coverage: Coverage
    records: list[Record]
    decision: "Decision" = Field(default_factory=lambda: Decision())
    provider_responses: list["ProviderResponse"] = Field(default_factory=list)


class ActionResponse(Model):
    action_id: str = Field(min_length=1, max_length=200)
    response: ActionResponseValue
    dependency_key: str = Field(pattern=r"^[a-f0-9]{64}$")


class Decision(Model):
    intent: Literal["plan30Days", "specificDecision"] = "plan30Days"
    concern: str | None = Field(default=None, min_length=1, max_length=2000)
    focus_record_ids: list[RecordId] = Field(default_factory=list, max_length=200)
    response_preference: Literal["standard", "brief"] = "standard"
    responses: list[ActionResponse] = Field(
        default_factory=list, max_length=1000, json_schema_extra={"readOnly": True}
    )

    @model_validator(mode="after")
    def validate_responses(self) -> "Decision":
        if len({item.action_id for item in self.responses}) != len(self.responses):
            raise ValueError("Action responses must identify unique actions")
        return self


class ProviderResponseBase(Model):
    event_id: str
    status: Literal["awaiting", "declined", "reportedTerms"]
    reported_on: date
    payment_date: date | None = None


class ProviderResponseInput(ProviderResponseBase):
    payment: MoneyInput | None = None
    cost: MoneyInput | None = None


class ProviderResponse(ProviderResponseBase):
    payment: Money | None = None
    cost: Money | None = None
    dependency_key: str = ""


class ReplaceFacts(Model):
    type: Literal["replaceFacts"]
    facts: FactsInput


class AdjustmentInput(Model):
    event_id: str
    amount: Rupees


class PreviewAdjustments(Model):
    type: Literal["previewAdjustments"]
    adjustments: list[AdjustmentInput]


class AcceptPreview(Model):
    type: Literal["acceptPreview"]
    preview_id: UUID
    confirmed: bool = Field(strict=True)
    consent_scope: Literal["unconditional"]

    @model_validator(mode="after")
    def validate_confirmation(self) -> "AcceptPreview":
        if not self.confirmed:
            raise ValueError("Acceptance requires explicit unconditional confirmation")
        return self


class DiscardPreview(Model):
    type: Literal["discardPreview"]
    preview_id: UUID


class ClearAccepted(Model):
    type: Literal["clearAccepted"]


class RespondToAction(Model):
    type: Literal["respondToAction"]
    action_id: str = Field(min_length=1, max_length=200)
    response: ActionResponseValue


class Command(Model):
    command_id: UUID
    expected_revision: int = Field(ge=0, strict=True)
    operation: Annotated[
        ReplaceFacts
        | PreviewAdjustments
        | AcceptPreview
        | DiscardPreview
        | ClearAccepted
        | RespondToAction,
        Field(discriminator="type"),
    ]


class Issue(Model):
    code: str
    message: str
    record_id: str | None = None
    date: Annotated[date | None, Field(default=None)]


class Event(Model):
    id: str
    record_id: str
    label: str
    kind: Kind
    original_due_date: date
    date: date
    amount_paise: int | None
    amount_basis: Literal["reported", "requiredOnly", "assumed"] = "reported"
    included: bool
    overdue: bool
    auto_debit: bool
    balance_paise: int | None


class Gap(Model):
    date: date
    amount_paise: int


class ProjectionMetrics(Model):
    reliable_income_paise: int
    uncertain_income_paise: int
    outflow_paise: int
    closing_paise: int | None
    trough_paise: int | None
    first_gap: Gap | None
    peak_gap_paise: int | None
    reserve_shortfall_paise: int | None
    peak_gap_date: date | None = None


class UnresolvedAmount(Model):
    record_id: str
    reason: Literal["missingDate", "missingAmount", "unknownTarget"]
    amount: Money
    recurrence: Literal["once", "weekly", "fortnightly", "monthly"]


class BudgetBasis(Model):
    dated_projection_complete: bool
    unresolved_amounts: list[UnresolvedAmount]


class Uncertainty(Model):
    id: str
    kind: Literal["missing", "uncertain", "conflict", "coverage"]
    record_ids: list[str]
    field: str
    question: str
    changes: list[Literal["what", "when", "affordability"]]
    blocks: list[Literal["immediateDecision", "fullPlan"]]
    priority: int
    reason: str
    before_date: date | None = None


class Constraint(Model):
    id: str
    kind: Literal["essential", "minimumDue", "autoDebit", "committed", "reserve"]
    event_ids: list[str]
    date: date | None
    amount_paise: int | None


class Consequence(Model):
    id: str
    kind: Literal["cashExposure", "reserveBreach", "conditionalIncome"]
    event_ids: list[str]
    date: date | None
    amount_paise: int | None
    comparison_id: str | None = None


class AdjustmentAmount(Model):
    event_id: str
    amount_paise: int


class Choice(Model):
    id: str
    kind: Literal["reduceOptional", "cardMinimum", "enquire"]
    event_ids: list[str]
    prerequisite_ids: list[str]
    adjustment_amounts: list[AdjustmentAmount]
    consequence_ids: list[str]
    affects_first_gap: bool = False
    affects_peak_gap: bool = False
    later_only: bool = False
    metrics: ProjectionMetrics | None = None


class Action(Model):
    id: str
    kind: Literal[
        "clarify",
        "contactPayee",
        "verifyTerms",
        "reviewOutcome",
        "previewChange",
        "followUp",
        "seekSupport",
        "resolveGroup",
        "confirmReceipt",
        "reconcileStatus",
    ]
    choice_id: str | None = None
    record_ids: list[str]
    before_date: date | None
    question: str
    consequence_ids: list[str]
    if_declined_consequence_ids: list[str]


class Outcome(Model):
    branch: Literal["fits", "uncertain", "gap", "conflict"]
    readiness: Literal["ready", "qualified"]
    summary: str
    covered: str
    not_covered: str
    next_step: str
    conditions: str
    true_now: list[str]
    risk_ids: list[str]
    choice_ids: list[str]
    next_action_id: str | None
    uncertain: list[str]
    revisit: str


class DecisionAssessment(Model):
    uncertainties: list[Uncertainty] = Field(default_factory=list)
    constraints: list[Constraint] = Field(default_factory=list)
    consequences: list[Consequence] = Field(default_factory=list)
    choices: list[Choice] = Field(default_factory=list)
    actions: list[Action] = Field(default_factory=list)
    next_question_id: str | None = None
    next_action_id: str | None = None
    outcome: Outcome | None = None


class IncomeCondition(Model):
    event_id: str
    arrival: Literal["reportedDate", "notByHorizon"]


class IncomeComparison(Model):
    id: str
    conditions: list[IncomeCondition]
    metrics: ProjectionMetrics


class Plan(ProjectionMetrics):
    evaluated_on: date
    projection_partial: bool
    events: list[Event]
    issues: list[Issue]
    budget_basis: BudgetBasis
    decision_assessment: DecisionAssessment = Field(default_factory=DecisionAssessment)
    income_comparisons: list[IncomeComparison] = Field(default_factory=list)


class AdjustmentOption(Model):
    event_id: str
    record_id: str
    label: str
    kind: Literal["optional", "card"]
    date: date
    original_paise: int
    minimum_paise: int
    acceptance_ready: bool
    dependency_key: str


class AdjustmentOptions(Model):
    revision: int
    today: date
    options: list[AdjustmentOption]


class Adjustment(AdjustmentOption):
    amount_paise: int
    accepted_revision: int | None = None


class Scenario(Model):
    id: UUID
    source_revision: int
    created_at: datetime
    adjustments: list[Adjustment]
    plan: Plan
    reduced_outflow_paise: int
    removed_assumption_ids: list[str] = Field(default_factory=list)


class Snapshot(Model):
    session_id: UUID
    revision: int
    sequence: int
    created_at: datetime
    as_of: datetime
    expires_at: datetime
    anchor_date: date
    end_date_exclusive: date
    currency: Literal["INR"] = "INR"
    facts: Facts
    plan: Plan
    preview: Scenario | None = None
    accepted: Scenario | None = None
    invalidated_assumptions: list["InvalidatedAssumption"] = Field(default_factory=list)


class InvalidatedAssumption(Model):
    event_id: str
    reason: str


class Error(Model):
    code: str
    message: str
    snapshot: Snapshot | None = None


class Settings(Model):
    currency: Literal["INR"]
    timezone: Literal["Asia/Kolkata"]
    today: date
    horizon_days: int
    retention_hours: int
    max_records: int
    max_money_paise: int
    max_request_bytes: int
    recurrence: list[str]
    voice_available: bool = False
    voice_unavailable_reason: str | None = None
    opening_basis: str = "Enter available cash and only unpaid or future items."


class CallJoin(Model):
    call_id: UUID
    url: str
    token: str = Field(repr=False)
    expires_at: datetime


class CallState(Model):
    call_id: UUID | None = None
    status: Literal["idle", "connecting", "active", "ended", "error"] = "idle"
    message: str | None = None


class Health(Model):
    status: Literal["ok", "unavailable"]


class Deleted(Model):
    deleted: Literal[True] = True
