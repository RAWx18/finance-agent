# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import re
from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator
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
    certainty: Status = "exact"

    @model_validator(mode="after")
    def validate_certainty(self) -> "Schedule":
        if self.date is None:
            self.certainty = "unknown"
        elif self.certainty == "unknown":
            raise ValueError("A reported date needs exact or estimate certainty")
        return self


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
    conflicts: list["FactConflict"] = Field(
        default_factory=list, max_length=1000, json_schema_extra={"readOnly": True}
    )


class Facts(Model):
    opening: Money
    reserve_paise: int
    coverage: Coverage
    records: list[Record]
    decision: "Decision" = Field(default_factory=lambda: Decision())
    provider_responses: list["ProviderResponse"] = Field(default_factory=list)
    conflicts: list["FactConflict"] = Field(
        default_factory=list, max_length=1000, json_schema_extra={"readOnly": True}
    )


ConflictField = Literal["opening", "amount", "target", "outstanding", "schedule.date"]


class ConflictValue(Model):
    id: RecordId
    amount_paise: int | None = Field(default=None, ge=0, strict=True)
    date: Annotated[date | None, Field(default=None)]
    status: Literal["exact", "estimate"]

    @model_validator(mode="after")
    def validate_value(self) -> "ConflictValue":
        if (self.amount_paise is None) == (self.date is None):
            raise ValueError("A competing value must contain exactly one concrete money or date")
        return self


class ConflictValueInput(Model):
    id: RecordId
    amount: Rupees | None = None
    date: Annotated[date | None, Field(default=None)]
    status: Literal["exact", "estimate"]

    @model_validator(mode="after")
    def validate_value(self) -> "ConflictValueInput":
        if (self.amount is None) == (self.date is None):
            raise ValueError("A competing value must contain exactly one concrete money or date")
        return self


class ConflictValues[ConflictValueType: (ConflictValueInput, ConflictValue)](Model):
    field: ConflictField
    values: list[ConflictValueType] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def validate_values(self) -> "ConflictValues[ConflictValueType]":
        if any((item.date is not None) != (self.field == "schedule.date") for item in self.values):
            raise ValueError("Competing values must address the same field type")
        if len({item.id for item in self.values}) != len(self.values) or len(
            {item.model_dump_json(exclude={"id"}) for item in self.values}
        ) != len(self.values):
            raise ValueError("Competing value IDs and values must be unique")
        return self


class RecordConflictInput(ConflictValues[ConflictValueInput]):
    field: Literal["amount", "target", "outstanding", "schedule.date"]


class ConflictReport[ConflictValueType: (ConflictValueInput, ConflictValue)](
    ConflictValues[ConflictValueType]
):
    record_id: RecordId | None = None

    @model_validator(mode="after")
    def validate_location(self) -> "ConflictReport[ConflictValueType]":
        if (self.field == "opening") != (self.record_id is None):
            raise ValueError("Opening conflicts have no record ID; other conflicts require one")
        return self


class ConflictInput(ConflictReport[ConflictValueInput]):
    pass


class FactConflict(ConflictReport[ConflictValue]):
    id: str = Field(min_length=1, max_length=200)
    values: list[ConflictValue] = Field(min_length=2, max_length=8)


class ResolveConflict(Model):
    conflict_id: str = Field(min_length=1, max_length=200)
    value: ConflictValueInput


class MergeRecords(Model):
    source_id: RecordId
    target_id: RecordId
    confirmed: bool = Field(strict=True)
    reason: str = Field(min_length=1, max_length=240)

    @model_validator(mode="after")
    def validate_confirmation(self) -> "MergeRecords":
        if not self.confirmed or not self.reason.strip() or self.source_id == self.target_id:
            raise ValueError(
                "Merge requires distinct IDs and explicit justified duplicate confirmation"
            )
        return self


class CoveragePatch(Model):
    income: CoverageStatus | None = None
    essential: CoverageStatus | None = None
    optional: CoverageStatus | None = None
    debt: CoverageStatus | None = None


class SchedulePatch(Model):
    date: Annotated[date | None, Field(default=None)]
    recurrence: Literal["once", "weekly", "fortnightly", "monthly"] | None = None
    certainty: Status | None = None


class RecordPatch(Model):
    id: RecordId | None = None
    delete: bool = False
    distinct: bool = False
    kind: Kind | None = None
    label: str | None = Field(default=None, min_length=1, max_length=120)
    amount: MoneyInput | None = None
    schedule: SchedulePatch | None = None
    reliability: Literal["reliable", "uncertain", "unknown"] | None = None
    debt_type: Literal["loan", "card", "informal", "unknown"] | None = None
    auto_debit: bool | None = None
    controllability: Controllability | None = None
    target: MoneyInput | None = None
    outstanding: MoneyInput | None = None
    conflicts: list[RecordConflictInput] = Field(default_factory=list, max_length=4)


class DecisionPatch(Model):
    intent: Literal["plan30Days", "specificDecision"] | None = None
    concern: str | None = Field(default=None, min_length=1, max_length=2000)
    focus_record_ids: list[RecordId] | None = Field(default=None, max_length=200)
    ambiguous_record_ids: list[RecordId] | None = Field(default=None, max_length=200)
    response_preference: Literal["standard", "brief"] | None = None


class FactsPatch(Model):
    expected_revision: int = Field(ge=0, strict=True)
    opening: MoneyInput | None = None
    reserve: Rupees | None = None
    coverage: CoveragePatch | None = None
    records: list[RecordPatch] = Field(default_factory=list, max_length=500)
    decision: DecisionPatch | None = None
    provider_responses: list["ProviderResponseInput"] = Field(default_factory=list, max_length=1000)
    remove_provider_response_ids: list[str] = Field(default_factory=list, max_length=1000)
    conflicts: list[ConflictInput] = Field(default_factory=list, max_length=1000)
    resolutions: list[ResolveConflict] = Field(default_factory=list, max_length=1000)
    merges: list[MergeRecords] = Field(default_factory=list, max_length=250)

    @model_validator(mode="after")
    def validate_changes(self) -> "FactsPatch":
        ids = [item.event_id for item in self.provider_responses]
        removed = self.remove_provider_response_ids
        if (
            set(removed) & set(ids)
            or len(set(ids)) != len(ids)
            or len(set(removed)) != len(removed)
        ):
            raise ValueError(
                "Provider changes must be unique and cannot supply and retract together"
            )
        return self


class ActionResponse(Model):
    action_id: str = Field(min_length=1, max_length=200)
    response: ActionResponseValue
    dependency_key: str = Field(pattern=r"^[a-f0-9]{64}$")


class Decision(Model):
    intent: Literal["plan30Days", "specificDecision"] = "plan30Days"
    concern: str | None = Field(default=None, min_length=1, max_length=2000)
    focus_record_ids: list[RecordId] = Field(default_factory=list, max_length=200)
    ambiguous_record_ids: list[RecordId] = Field(default_factory=list, max_length=200)
    response_preference: Literal["standard", "brief"] = "standard"
    responses: list[ActionResponse] = Field(
        default_factory=list, max_length=1000, json_schema_extra={"readOnly": True}
    )

    @model_validator(mode="after")
    def validate_responses(self) -> "Decision":
        if self.ambiguous_record_ids and (
            len(self.ambiguous_record_ids) < 2
            or len(set(self.ambiguous_record_ids)) != len(self.ambiguous_record_ids)
        ):
            raise ValueError("An ambiguous correction must identify at least two distinct records")
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


class UpdateFacts(Model):
    type: Literal["updateFacts"]
    changes: FactsPatch


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


class RejectPreview(Model):
    type: Literal["rejectPreview"]
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
        | UpdateFacts
        | PreviewAdjustments
        | AcceptPreview
        | DiscardPreview
        | RejectPreview
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
    workspace: "Workspace" = Field(
        default_factory=lambda: Workspace(), json_schema_extra={"readOnly": True}
    )
    latest_change: "WorkspaceChange | None" = Field(
        default=None, json_schema_extra={"readOnly": True}
    )
    rejected_proposals: list["RejectedProposal"] = Field(
        default_factory=list, max_length=1000, json_schema_extra={"readOnly": True}
    )


WorkspaceState = Literal[
    "known",
    "estimated",
    "uncertain",
    "missing",
    "conflicting",
    "proposed",
    "accepted",
    "unresolved",
]


class WorkspaceRow(Model):
    field: str
    label: str
    value: JsonValue
    state: WorkspaceState
    references: list[str] = Field(default_factory=list)


class WorkspaceCard(Model):
    id: str
    template: Literal[
        "cash",
        "income",
        "essential",
        "optional",
        "loans",
        "creditCards",
        "questions",
        "timeline",
        "gap",
        "proposal",
        "assumptions",
        "invalidation",
        "outcome",
    ]
    section: Literal["facts", "issues", "timeline", "decisions", "outcome"]
    title: str
    state: WorkspaceState
    rows: list[WorkspaceRow] = Field(default_factory=list)
    record_ids: list[str] = Field(default_factory=list)
    event_ids: list[str] = Field(default_factory=list)
    issue_ids: list[str] = Field(default_factory=list)
    result_ids: list[str] = Field(default_factory=list)
    dependencies: list[str] = Field(default_factory=list)


class WorkspaceQuestion(Model):
    id: str
    action_id: str | None
    fields: list[str]
    record_ids: list[str]
    why: str
    resolves: list[str]
    changes: list[str]
    blocks: list[str]
    before_date: date | None
    priority: int


class Contribution(Model):
    id: str
    record_id: str | None
    event_id: str | None
    amount_paise: int | None
    balance_paise: int | None = None
    date: Annotated[date | None, Field(default=None)]
    included: bool
    reason: str
    references: list[str]


class WorkspaceResult(Model):
    id: str
    from_date: date
    until_date_exclusive: date
    amount_paise: int | None
    date: Annotated[date | None, Field(default=None)]
    state: WorkspaceState
    rule: str
    result_ids: list[str] = Field(default_factory=list)
    contribution_ids: list[str]
    excluded_ids: list[str]
    excluded_reasons: dict[str, str] = Field(default_factory=dict)
    event_ids: list[str]
    witness_event_ids: list[str] = Field(default_factory=list)
    record_ids: list[str]
    issue_ids: list[str]
    dependencies: list[str]
    assumptions: list[str]


class FieldChange(Model):
    reference: str
    before: JsonValue
    after: JsonValue


class ChangeItem(Model):
    id: str
    state: Literal[
        "created",
        "updated",
        "deleted",
        "resolved",
        "merged",
        "proposed",
        "accepted",
        "rejected",
        "invalidated",
        "discarded",
    ]
    fields: list[FieldChange] = Field(default_factory=list)
    record_ids: list[str] = Field(default_factory=list)
    result_ids: list[str] = Field(default_factory=list)
    card_ids: list[str] = Field(default_factory=list)


class WorkspaceChange(Model):
    id: UUID
    revision: int
    items: list[ChangeItem]


class RejectedProposal(Model):
    id: UUID
    adjustments: list[Adjustment]


class Workspace(Model):
    cards: list[WorkspaceCard] = Field(default_factory=list)
    questions: list[WorkspaceQuestion] = Field(default_factory=list)
    issues: list[Uncertainty] = Field(default_factory=list)
    results: list[WorkspaceResult] = Field(default_factory=list)
    contributions: list[Contribution] = Field(default_factory=list)
    actions: list[Action] = Field(default_factory=list)
    choices: list[Choice] = Field(default_factory=list)
    change: WorkspaceChange | None = None


class InvalidatedAssumption(Model):
    event_id: str
    reason: str


class Error(Model):
    code: str
    message: str
    snapshot: Snapshot | None = None


class Settings(Model):
    assistant_name: str
    currency: Literal["INR"]
    timezone: Literal["Asia/Kolkata"]
    today: date
    horizon_days: int
    retention_hours: int
    max_records: int
    max_money_paise: int
    max_request_bytes: int
    recurrence: list[str]
    voice_startup_seconds: float
    voice_shutdown_seconds: float
    voice_available: bool = False
    voice_unavailable_reason: str | None = None
    opening_basis: str = "Enter available cash and only unpaid or future items."


class CallRequest(Model):
    call_id: UUID


class CallJoin(Model):
    call_id: UUID
    url: str
    token: str = Field(repr=False)
    expires_at: datetime


class CallState(Model):
    call_id: UUID | None = None
    status: Literal["idle", "connecting", "active", "ending", "ended", "error"] = "idle"
    cleanup_confirmed: bool = True
    message: str | None = None


class Health(Model):
    status: Literal["ok", "unavailable"]


class Deleted(Model):
    deleted: Literal[True] = True
