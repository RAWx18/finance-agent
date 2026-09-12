# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import re
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError, model_validator
from pydantic.alias_generators import to_camel
from pydantic_core import ErrorDetails

from .amounts import money_value
from .exchange import ExchangeRate


class Model(BaseModel):
    """Strict financial payload with camel-case aliases."""

    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


Status = Literal["exact", "estimate", "unknown"]
Recurrence = Literal["once", "daily", "weekly", "fortnightly", "monthly", "monthlyBudget"]
Kind = Literal["income", "essential", "optional", "debt"]
CoverageStatus = Literal["notDiscussed", "reported", "reviewed", "none", "unknown"]
Controllability = Literal["unknown", "controllable", "committed"]
ActionResponseValue = Literal["unavailable", "declined"]
RecordId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
Rupees = Annotated[str, Field(pattern=r"^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$", max_length=16)]
ConversionDirection = Literal["receipt", "payment", "valuation"]


def direct_money(value: Any, direction: ConversionDirection) -> Any:
    """Bind conversion semantics to the owning field before money validation."""
    if isinstance(value, BaseModel):
        value = value.model_dump()
    if not isinstance(value, dict):
        return value
    value = dict(value)
    if value.get("source") is not None:
        value["source"] = direct_money(value["source"], direction)
    if value.get("conversion") is not None:
        conversion = value["conversion"]
        if isinstance(conversion, BaseModel):
            conversion = conversion.model_dump()
        if isinstance(conversion, dict):
            value["conversion"] = {**conversion, "direction": direction}
    return value


def direct_facts(value: Any) -> Any:
    """Bind opening and competing source values before persisted money is rederived."""
    if not isinstance(value, dict):
        return value
    value = dict(value)
    if "opening" in value:
        value["opening"] = direct_money(value["opening"], "receipt")
    if not isinstance(value.get("records", []), list) or not isinstance(
        value.get("conflicts", []), list
    ):
        return value
    records = {}
    for record in value.get("records", []):
        if isinstance(record, BaseModel):
            record = record.model_dump()
        if isinstance(record, dict):
            records[record.get("id")] = record.get("kind")
    conflicts = []
    for conflict in value.get("conflicts", []):
        if isinstance(conflict, BaseModel):
            conflict = conflict.model_dump()
        if not isinstance(conflict, dict) or not isinstance(conflict.get("values"), list):
            conflicts.append(conflict)
            continue
        identity = conflict.get("record_id", conflict.get("recordId"))
        direction: ConversionDirection = (
            "valuation"
            if conflict.get("field") == "outstanding"
            else "receipt"
            if identity is None or records.get(identity) == "income"
            else "payment"
        )
        conflicts.append(
            {
                **conflict,
                "values": [direct_money(item, direction) for item in conflict.get("values", [])],
            }
        )
    if "conflicts" in value:
        value["conflicts"] = conflicts
    return value


class Conversion(Model):
    """Reported foreign-currency conversion terms and certainty."""

    currency: str = Field(pattern=r"^[A-Z]{3}$")
    rate: Annotated[
        str | None,
        Field(pattern=r"^(0|[1-9][0-9]{0,12})(\.[0-9]{1,8})?$", max_length=22),
    ] = None
    rate_status: Status = "unknown"
    rate_date: date | None = None
    fee: Rupees | None = None
    fee_status: Status = "unknown"
    provider: Literal["frankfurter"] | None = Field(
        default=None, json_schema_extra={"readOnly": True}
    )
    fetched_at: datetime | None = Field(default=None, json_schema_extra={"readOnly": True})
    direction: ConversionDirection = Field(
        default="receipt",
        description="Owner-controlled: receipt deducts INR fees, payment adds them, valuation "
        "uses only the rate. Input direction is overridden by the financial field.",
        json_schema_extra={"readOnly": True},
    )

    @model_validator(mode="after")
    def validate_terms(self) -> "Conversion":
        """Validate reported conversion terms and certainty."""
        if self.currency == "INR":
            raise ValueError("Conversion requires a non-INR currency")
        for value, status in ((self.rate, self.rate_status), (self.fee, self.fee_status)):
            if (value is None) != (status == "unknown"):
                raise ValueError("Unknown conversion terms must be null; known terms need status")
        if self.rate is not None and Decimal(self.rate) <= 0:
            raise ValueError("Conversion rate must be positive")
        return self


class MoneyInput(Model):
    """Reported monetary amount with certainty and optional conversion terms."""

    amount: Rupees | None
    status: Status
    conversion: Conversion | None = None

    @model_validator(mode="after")
    def validate_status(self) -> "MoneyInput":
        """Require the amount's presence to agree with its certainty."""
        if (self.amount is None) != (self.status == "unknown"):
            raise ValueError("Unknown money must be null; exact/estimate money needs an amount")
        return self


class Money(Model):
    """INR amount in paise with certainty and retained foreign source terms."""

    amount_paise: int | None
    status: Status
    source: MoneyInput | None = None

    @model_validator(mode="after")
    def derive_source(self) -> "Money":
        """Derive INR value and certainty from foreign source terms."""
        if self.source is not None:
            if self.source.conversion is None:
                raise ValueError("Money source must contain foreign conversion terms")
            self.amount_paise, self.status = money_value(self.source)
        return self


class MonthlyPattern(Model):
    """Monthly timing rule without a concrete starting date."""

    kind: Literal["dayOfMonth", "monthEnd"]
    day: int | None = Field(default=None, ge=1, le=31, strict=True)

    @model_validator(mode="after")
    def validate_day(self) -> "MonthlyPattern":
        """Require a day only for a day-of-month pattern."""
        if (self.kind == "dayOfMonth") != (self.day is not None):
            raise ValueError("dayOfMonth requires day; monthEnd must not supply a day")
        return self


class Schedule(Model):
    """Payment or spending-forecast timing, certainty, and optional occurrence amounts."""

    end_date: date | None = None
    date: date | None
    recurrence: Recurrence = "once"
    basis: Literal["payment", "allowance"] = Field(
        default="payment",
        description="Use allowance only for reported recurring, uncommitted living spending, "
        "not bills or debt. An ongoing scalar allowance may use the snapshot anchor for "
        "forecast timing while retaining date=null. Finite or varying schedules need an origin.",
    )
    certainty: Status = "exact"
    pattern: MonthlyPattern | None = None
    count: int | None = Field(default=None, ge=1, le=1000, strict=True)
    amounts: list[MoneyInput] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def validate_certainty(self) -> "Schedule":
        """Validate timing certainty and compatible recurrence bounds and amounts."""
        if self.basis == "allowance" and self.recurrence not in {
            "daily",
            "weekly",
            "fortnightly",
            "monthly",
        }:
            raise ValueError("An allowance requires daily, weekly, fortnightly or monthly cadence")
        if self.pattern is not None and (
            self.date is not None
            or self.recurrence != "monthly"
            or self.count is not None
            or self.amounts
        ):
            raise ValueError(
                "A monthly pattern requires date=null, monthly recurrence and no count/amounts"
            )
        if self.date is None:
            self.certainty = "unknown"
        elif self.certainty == "unknown":
            raise ValueError("A reported date needs exact or estimate certainty")
        if self.date is not None and self.end_date is not None and self.end_date < self.date:
            raise ValueError("Schedule endDate cannot precede its starting date")
        if self.amounts and self.count is not None and self.count != len(self.amounts):
            raise ValueError("Schedule count must agree with the per-occurrence amounts length")
        if self.recurrence == "once" and ((self.count or 1) != 1 or len(self.amounts) > 1):
            raise ValueError("A once schedule has only one occurrence")
        if self.recurrence == "monthlyBudget" and self.amounts:
            raise ValueError("A monthlyBudget cannot contain per-occurrence amounts")
        return self


class RecordBase(Model):
    """Shared identity, timing, and obligations of a financial record."""

    id: RecordId
    kind: Kind
    label: str = Field(min_length=1, max_length=120)
    schedule: Schedule
    reliability: Literal["reliable", "uncertain", "unknown"] | None = None
    debt_type: Literal["loan", "card", "informal", "unknown"] | None = None
    auto_debit: bool = False
    controllability: Controllability | None = None

    @model_validator(mode="before")
    @classmethod
    def direct_amounts(cls, value: Any) -> Any:
        """Apply record-owned conversion semantics to scalar and occurrence money."""
        if not isinstance(value, dict):
            return value
        value = dict(value)
        direction: ConversionDirection = "receipt" if value.get("kind") == "income" else "payment"
        for field in ("amount", "target", "outstanding"):
            if field in value:
                value[field] = direct_money(
                    value[field], "valuation" if field == "outstanding" else direction
                )
        if value.get("schedule") is not None:
            schedule = value["schedule"]
            if isinstance(schedule, BaseModel):
                schedule = schedule.model_dump()
            if isinstance(schedule, dict) and isinstance(schedule.get("amounts"), list):
                value["schedule"] = {
                    **schedule,
                    "amounts": [direct_money(item, direction) for item in schedule["amounts"]],
                }
        return value

    @model_validator(mode="after")
    def validate_record(self) -> "RecordBase":
        """Validate record details against income and outflow requirements."""
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
        if self.schedule.recurrence == "monthlyBudget" and (
            self.kind not in {"essential", "optional"} or self.auto_debit
        ):
            raise ValueError("monthlyBudget is only non-auto-debit essential or optional spending")
        if self.schedule.basis == "allowance" and (
            self.kind not in {"essential", "optional"}
            or self.auto_debit
            or self.controllability == "committed"
        ):
            raise ValueError(
                "An allowance is only uncommitted, non-auto-debit essential or optional spending"
            )
        return self


class RecordInput(RecordBase):
    """Reported financial record with payment and debt amounts."""

    amount: MoneyInput
    target: MoneyInput | None = None
    outstanding: MoneyInput | None = None

    @model_validator(mode="after")
    def validate_debt_fields(self) -> "RecordInput":
        """Validate debt amounts, currency eligibility, and variable payments."""
        if self.kind != "debt" and (self.target is not None or self.outstanding is not None):
            raise ValueError("Target and outstanding apply only to debt")
        if self.schedule.amounts:
            if self.amount.amount is not None or self.amount.conversion is not None:
                raise ValueError("Variable amounts cannot also have a scalar amount")
            if self.target is not None:
                raise ValueError("Variable required payments cannot have a scalar debt target")
        return self


class Record(RecordBase):
    """Financial record with payment and debt amounts expressed in paise."""

    amount: Money
    target: Money | None = None
    outstanding: Money | None = None


class Coverage(Model):
    """Discussion coverage of income, spending, and debts."""

    income: CoverageStatus = "notDiscussed"
    essential: CoverageStatus = "notDiscussed"
    optional: CoverageStatus = "notDiscussed"
    debt: CoverageStatus = "notDiscussed"


class FactsInput(Model):
    """Reported cash, records, and decision context for a financial plan."""

    opening: MoneyInput
    reserve: Rupees = "0"
    coverage: Coverage
    records: list[RecordInput]
    decision: "Decision" = Field(default_factory=lambda: Decision())
    provider_responses: list["ProviderResponseInput"] = Field(default_factory=list)
    conflicts: list["FactConflict"] = Field(
        default_factory=list, max_length=1000, json_schema_extra={"readOnly": True}
    )

    @model_validator(mode="before")
    @classmethod
    def direct_opening(cls, value: Any) -> Any:
        """Bind opening cash and conflicts to their owning financial fields."""
        return direct_facts(value)


class Facts(Model):
    """Canonical financial facts, decision context, and unresolved conflicts."""

    opening: Money
    reserve_paise: int
    coverage: Coverage
    records: list[Record]
    decision: "Decision" = Field(default_factory=lambda: Decision())
    provider_responses: list["ProviderResponse"] = Field(default_factory=list)
    conflicts: list["FactConflict"] = Field(
        default_factory=list, max_length=1000, json_schema_extra={"readOnly": True}
    )

    @model_validator(mode="before")
    @classmethod
    def direct_opening(cls, value: Any) -> Any:
        """Rebind persisted opening cash and conflicts before deriving INR."""
        return direct_facts(value)


ConflictField = Literal["opening", "amount", "target", "outstanding", "schedule.date"]


class ConflictValue(Model):
    """Concrete competing date or paise amount with reported certainty."""

    id: RecordId
    amount_paise: int | None = Field(default=None, ge=0, strict=True)
    date: Annotated[date | None, Field(default=None)]
    status: Literal["exact", "estimate"]
    source: MoneyInput | None = None

    @model_validator(mode="after")
    def validate_value(self) -> "ConflictValue":
        """Require one competing money value or date and validate foreign sources."""
        if self.source is not None:
            if (
                self.source.conversion is None
                or self.source.amount is None
                or self.source.status == "unknown"
            ):
                raise ValueError("A foreign competing value needs a concrete source amount")
            self.amount_paise, _ = money_value(self.source)
            self.status = self.source.status
        if (self.amount_paise is None and self.source is None) == (self.date is None):
            raise ValueError("A competing value must contain exactly one concrete money or date")
        return self


class ConflictValueInput(Model):
    """Reported competing amount or date with certainty and conversion terms."""

    id: RecordId
    amount: Rupees | None = None
    date: Annotated[date | None, Field(default=None)]
    status: Literal["exact", "estimate"]
    conversion: Conversion | None = None

    @model_validator(mode="after")
    def validate_value(self) -> "ConflictValueInput":
        """Require one competing amount or date and money-only conversion terms."""
        if (self.amount is None) == (self.date is None):
            raise ValueError("A competing value must contain exactly one concrete money or date")
        if self.conversion is not None and self.amount is None:
            raise ValueError("Currency conversion applies only to competing money values")
        return self


class ConflictValues[ConflictValueType: (ConflictValueInput, ConflictValue)](Model):
    """Distinct competing values for one financial field."""

    field: ConflictField
    values: list[ConflictValueType] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def validate_values(self) -> "ConflictValues[ConflictValueType]":
        """Require unique competing values and IDs matching the field's type."""
        if any((item.date is not None) != (self.field == "schedule.date") for item in self.values):
            raise ValueError("Competing values must address the same field type")
        if len({item.id for item in self.values}) != len(self.values) or len(
            {item.model_dump_json(exclude={"id"}) for item in self.values}
        ) != len(self.values):
            raise ValueError("Competing value IDs and values must be unique")
        return self


class RecordConflictInput(ConflictValues[ConflictValueInput]):
    """Reported competing values for a record's amount, debt, or date field."""

    field: Literal["amount", "target", "outstanding", "schedule.date"]


class ConflictReport[ConflictValueType: (ConflictValueInput, ConflictValue)](
    ConflictValues[ConflictValueType]
):
    """Competing financial values located at opening cash or a record field."""

    record_id: RecordId | None = None

    @model_validator(mode="after")
    def validate_location(self) -> "ConflictReport[ConflictValueType]":
        """Require a record ID for every conflict except opening cash."""
        if (self.field == "opening") != (self.record_id is None):
            raise ValueError("Opening conflicts have no record ID; other conflicts require one")
        return self


class ConflictInput(ConflictReport[ConflictValueInput]):
    """Reported financial conflict with user-supplied competing values."""

    pass


class FactConflict(ConflictReport[ConflictValue]):
    """Identified unresolved conflict between canonical financial values."""

    id: str = Field(min_length=1, max_length=200)
    values: list[ConflictValue] = Field(min_length=2, max_length=8)


class ResolveConflict(Model):
    """Chosen value for resolving an identified financial conflict."""

    conflict_id: str = Field(min_length=1, max_length=200)
    value: ConflictValueInput


class MergeRecords(Model):
    """Explicitly confirmed duplicate-record merge with supporting reason."""

    source_id: RecordId
    target_id: RecordId
    confirmed: bool = Field(strict=True)
    reason: str = Field(min_length=1, max_length=240)

    @model_validator(mode="after")
    def validate_confirmation(self) -> "MergeRecords":
        """Require justified confirmation to merge two distinct record IDs."""
        if not self.confirmed or not self.reason.strip() or self.source_id == self.target_id:
            raise ValueError(
                "Merge requires distinct IDs and explicit justified duplicate confirmation"
            )
        return self


class CoveragePatch(Model):
    """Partial changes to financial discussion coverage."""

    income: CoverageStatus | None = None
    essential: CoverageStatus | None = None
    optional: CoverageStatus | None = None
    debt: CoverageStatus | None = None


class SchedulePatch(Model):
    """Partial changes to schedule basis, timing, recurrence, and occurrence amounts."""

    end_date: date | None = None
    date: Annotated[date | None, Field(default=None)]
    recurrence: Recurrence | None = None
    basis: Literal["payment", "allowance"] | None = None
    certainty: Status | None = None
    pattern: MonthlyPattern | None = None
    count: int | None = Field(default=None, ge=1, le=1000, strict=True)
    amounts: list[MoneyInput] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def validate_pattern(self) -> "SchedulePatch":
        """Reject monthly patterns combined with concrete dates or finite sequences."""
        if self.pattern is not None and (
            self.date is not None
            or self.recurrence not in {None, "monthly"}
            or self.count is not None
            or self.amounts
            or self.certainty not in {None, "unknown"}
        ):
            raise ValueError(
                "A monthly pattern cannot also supply a date, certainty or finite sequence"
            )
        return self


class RecordPatch(Model):
    """Financial record creation, correction, deletion, or conflict report."""

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
    """Partial changes to decision intent, record focus, and response preference."""

    intent: Literal["plan30Days", "specificDecision"] | None = None
    concern: str | None = Field(default=None, min_length=1, max_length=2000)
    focus_record_ids: list[RecordId] | None = Field(default=None, max_length=200)
    ambiguous_record_ids: list[RecordId] | None = Field(default=None, max_length=200)
    response_preference: Literal["standard", "brief"] | None = None
    scope_checked: bool | None = None


class FactsPatch(Model):
    """Revision-bound changes to financial facts, responses, and conflicts."""

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
        """Reject duplicate or contradictory provider response changes."""
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
    """Declined or unavailable action response bound to its financial dependencies."""

    action_id: str = Field(min_length=1, max_length=200)
    response: ActionResponseValue
    dependency_key: str = Field(pattern=r"^[a-f0-9]{64}$")


class Decision(Model):
    """Planning intent, focused records, response preference, and action responses."""

    intent: Literal["plan30Days", "specificDecision"] = "plan30Days"
    concern: str | None = Field(default=None, min_length=1, max_length=2000)
    focus_record_ids: list[RecordId] = Field(default_factory=list, max_length=200)
    ambiguous_record_ids: list[RecordId] = Field(default_factory=list, max_length=200)
    response_preference: Literal["standard", "brief"] = "standard"
    scope_checked: bool = False
    responses: list[ActionResponse] = Field(
        default_factory=list, max_length=1000, json_schema_extra={"readOnly": True}
    )

    @model_validator(mode="after")
    def validate_responses(self) -> "Decision":
        """Require distinct ambiguous records and unique action responses."""
        if self.ambiguous_record_ids and (
            len(self.ambiguous_record_ids) < 2
            or len(set(self.ambiguous_record_ids)) != len(self.ambiguous_record_ids)
        ):
            raise ValueError("An ambiguous correction must identify at least two distinct records")
        if len({item.action_id for item in self.responses}) != len(self.responses):
            raise ValueError("Action responses must identify unique actions")
        return self


class ProviderResponseBase(Model):
    """Reported provider response status and payment timing for an event."""

    event_id: str
    status: Literal["awaiting", "declined", "reportedTerms"]
    reported_on: date
    payment_date: date | None = None

    @model_validator(mode="before")
    @classmethod
    def direct_payments(cls, value: Any) -> Any:
        """Provider payment and cost quotes represent cash outflows."""
        if isinstance(value, dict):
            return {
                key: direct_money(item, "payment") if key in {"payment", "cost"} else item
                for key, item in value.items()
            }
        return value


class ProviderResponseInput(ProviderResponseBase):
    """Reported provider response with payment and cost source amounts."""

    payment: MoneyInput | None = None
    cost: MoneyInput | None = None


class ProviderResponse(ProviderResponseBase):
    """Canonical provider response bound to its financial dependencies."""

    payment: Money | None = None
    cost: Money | None = None
    dependency_key: str = ""


class ReplaceFacts(Model):
    """Command operation replacing the full reported financial facts."""

    type: Literal["replaceFacts"]
    facts: FactsInput


class UpdateFacts(Model):
    """Command operation applying fact changes with optional human-edit provenance."""

    type: Literal["updateFacts"]
    changes: FactsPatch
    source: Literal["humanCardEdit"] | None = None


class AdjustmentInput(Model):
    """Proposed event payment amount reported in INR."""

    event_id: str
    amount: Rupees


class PreviewAdjustments(Model):
    """Command operation previewing proposed payment adjustments."""

    type: Literal["previewAdjustments"]
    adjustments: list[AdjustmentInput]


class AcceptPreview(Model):
    """Command operation accepting a preview with explicit unconditional consent."""

    type: Literal["acceptPreview"]
    preview_id: UUID
    confirmed: bool = Field(strict=True)
    consent_scope: Literal["unconditional"]

    @model_validator(mode="after")
    def validate_confirmation(self) -> "AcceptPreview":
        """Require explicit confirmation before accepting a preview."""
        if not self.confirmed:
            raise ValueError("Acceptance requires explicit unconditional confirmation")
        return self


class DiscardPreview(Model):
    """Command operation discarding a preview without rejecting its proposal."""

    type: Literal["discardPreview"]
    preview_id: UUID


class RejectPreview(Model):
    """Command operation recording rejection of a proposed preview."""

    type: Literal["rejectPreview"]
    preview_id: UUID


class ClearAccepted(Model):
    """Command operation clearing accepted payment adjustments."""

    type: Literal["clearAccepted"]


class RespondToAction(Model):
    """Command operation recording a declined or unavailable action response."""

    type: Literal["respondToAction"]
    action_id: str = Field(min_length=1, max_length=200)
    response: ActionResponseValue


class Command(Model):
    """Identified financial operation bound to an expected session revision."""

    command_id: UUID
    expected_revision: int = Field(ge=0, strict=True)
    expected_sequence: int | None = Field(default=None, ge=0, strict=True)
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
    """Financial planning issue with optional record and date context."""

    code: str
    message: str
    record_id: str | None = None
    date: Annotated[date | None, Field(default=None)]


class Event(Model):
    """Projected income or payment occurrence with assumptions and cash balance."""

    id: str
    record_id: str
    label: str
    kind: Kind
    original_due_date: date
    date: date
    date_assumption: str | None = None
    amount_paise: int | None
    amount_basis: Literal["reported", "requiredOnly", "requiredFloor", "assumed", "budget"] = (
        "reported"
    )
    amount_status: Status = "exact"
    required_paise: int | None = None
    required_status: Status = "unknown"
    source: MoneyInput | None = None
    schedule_index: int | None = None
    included: bool
    overdue: bool
    auto_debit: bool
    balance_paise: int | None


class Gap(Model):
    """Dated cash shortfall expressed in paise."""

    date: date
    amount_paise: int


class TimingRisk(Model):
    """Dated pre-receipt cash exposure and remaining funding gap."""

    date: date
    exposure_paise: int
    remaining_gap_paise: int


class ProjectionMetrics(Model):
    """Cash-flow totals, balance extrema, shortfalls, and timing risks."""

    reliable_income_paise: int
    uncertain_income_paise: int
    outflow_paise: int
    closing_paise: int | None
    trough_paise: int | None
    first_gap: Gap | None
    peak_gap_paise: int | None
    reserve_shortfall_paise: int | None
    peak_gap_date: date | None = None
    timing_risks: list[TimingRisk] = Field(default_factory=list)


class UnresolvedAmount(Model):
    """Financial amount lacking a date, amount, or debt target for projection."""

    record_id: str
    reason: Literal["missingDate", "missingAmount", "unknownTarget"]
    amount: Money
    recurrence: Recurrence


class BudgetBasis(Model):
    """Completeness of the dated projection and its unresolved amounts."""

    dated_projection_complete: bool
    unresolved_amounts: list[UnresolvedAmount]


class Uncertainty(Model):
    """Prioritized financial uncertainty and the decisions it blocks or changes."""

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
    """Protected payment or reserve requirement affecting financial choices."""

    id: str
    kind: Literal["essential", "minimumDue", "autoDebit", "committed", "reserve"]
    event_ids: list[str]
    date: date | None
    amount_paise: int | None


class Consequence(Model):
    """Cash exposure, reserve breach, or conditional-income risk linked to events."""

    id: str
    kind: Literal["cashExposure", "reserveBreach", "conditionalIncome"]
    event_ids: list[str]
    date: date | None
    amount_paise: int | None
    comparison_id: str | None = None


class AdjustmentAmount(Model):
    """Event payment adjustment expressed in paise."""

    event_id: str
    amount_paise: int


class Choice(Model):
    """Financial choice with prerequisites, adjustments, and projected consequences."""

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
    """Suggested financial next step with timing and consequence references."""

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
    """Qualified financial conclusion with coverage, next step, and revisit guidance."""

    branch: Literal["fits", "uncertain", "gap", "conflict"]
    readiness: Literal["ready", "qualified"]
    plan_ready: bool = False
    headline: str = Field(
        description="One plain sentence: what happens to the consumer's money and when."
    )
    action: str = Field(description="The single dated step to take now, or that none is needed.")
    top_caveat: str = Field(
        description="The one assumption most likely to change the headline if it is wrong."
    )
    secondary: str | None = Field(
        default=None,
        description="Result without assumed-timing income, when such income is counted.",
    )
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
    """Financial decision evidence, available choices, next steps, and outcome."""

    uncertainties: list[Uncertainty] = Field(default_factory=list)
    constraints: list[Constraint] = Field(default_factory=list)
    consequences: list[Consequence] = Field(default_factory=list)
    choices: list[Choice] = Field(default_factory=list)
    actions: list[Action] = Field(default_factory=list)
    next_question_id: str | None = None
    next_action_id: str | None = None
    outcome: Outcome | None = None


class IncomeCondition(Model):
    """Assumed income arrival timing for a conditional projection."""

    event_id: str
    arrival: Literal["reportedDate", "notByHorizon"]


class IncomeComparison(Model):
    """Projected cash metrics under specified income arrival conditions."""

    id: str
    conditions: list[IncomeCondition]
    metrics: ProjectionMetrics


class UndatedItem(Model):
    """Undated payment with reported amounts, recurrence, and a planning assumption."""

    record_id: str
    label: str
    amount_paise: int | None
    status: Status
    recurrence: Recurrence
    amount_basis: Literal["reported", "requiredOnly", "requiredFloor"]
    required_paise: int | None = None
    target_paise: int | None = None
    assumption: str


class UndatedImpact(Model):
    """Qualified cash impact of undated payments outside the dated projection."""

    items: list[UndatedItem]
    outflow_paise: int
    closing_paise: int | None
    status: Literal["estimate", "unknown"]
    unknown_record_ids: list[str]
    qualification: str


class Plan(ProjectionMetrics):
    """Evaluated cash-flow projection with events, qualifications, and decision guidance."""

    evaluated_on: date
    planning_facts: Facts
    occurrence_amounts: dict[str, list[Money]] = Field(default_factory=dict)
    exchange_rates: dict[str, ExchangeRate] = Field(default_factory=dict)
    exchange_checked_on: date | None = None
    projection_partial: bool
    events: list[Event]
    issues: list[Issue]
    budget_basis: BudgetBasis
    undated_impact: UndatedImpact | None = None
    decision_assessment: DecisionAssessment = Field(default_factory=DecisionAssessment)
    income_comparisons: list[IncomeComparison] = Field(default_factory=list)


class AdjustmentOption(Model):
    """Eligible payment adjustment with amount limits and acceptance dependencies."""

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
    """Available payment adjustments bound to a canonical session snapshot."""

    session_id: UUID
    revision: int
    sequence: int
    today: date
    options: list[AdjustmentOption]


class Adjustment(AdjustmentOption):
    """Selected payment adjustment with its optional acceptance revision."""

    amount_paise: int
    accepted_revision: int | None = None


class Scenario(Model):
    """Payment-adjustment scenario with its source revision and resulting plan."""

    id: UUID
    source_revision: int
    created_at: datetime
    adjustments: list[Adjustment]
    plan: Plan
    reduced_outflow_paise: int
    removed_assumption_ids: list[str] = Field(default_factory=list)


class Snapshot(Model):
    """Versioned financial session state with facts, plans, consent, and workspace."""

    session_id: UUID
    conversation_slug: str | None = None
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
    """Labeled workspace field with value, certainty state, and evidence references."""

    field: str
    label: str
    value: JsonValue
    state: WorkspaceState
    references: list[str] = Field(default_factory=list)


class WorkspaceCard(Model):
    """Financial workspace card with rows, state, and supporting record references."""

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
    """Prioritized financial clarification with affected fields and decision impact."""

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
    """Record or event contribution explaining a financial result."""

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
    """Traceable financial result with contributions, exclusions, and assumptions."""

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
    qualifications: list[str] = Field(default_factory=list)
    event_ids: list[str]
    witness_event_ids: list[str] = Field(default_factory=list)
    record_ids: list[str]
    issue_ids: list[str]
    dependencies: list[str]
    assumptions: list[str]


class FieldChange(Model):
    """Before-and-after values for a referenced workspace field."""

    reference: str
    before: JsonValue
    after: JsonValue


class ChangeItem(Model):
    """Workspace change state with affected fields, records, results, and cards."""

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


class ChangeSource(Model):
    """Actor and timestamp provenance for a human card edit."""

    kind: Literal["humanCardEdit"]
    actor_id: str
    at: datetime


class WorkspaceChange(Model):
    """Revision-associated workspace changes with optional edit provenance."""

    id: UUID
    revision: int
    items: list[ChangeItem]
    source: ChangeSource | None = None


class RejectedProposal(Model):
    """Identified payment-adjustment proposal rejected by the user."""

    id: UUID
    adjustments: list[Adjustment]


class Workspace(Model):
    """Financial cards, questions, evidence, choices, and changes for presentation."""

    cards: list[WorkspaceCard] = Field(default_factory=list)
    questions: list[WorkspaceQuestion] = Field(default_factory=list)
    issues: list[Uncertainty] = Field(default_factory=list)
    results: list[WorkspaceResult] = Field(default_factory=list)
    contributions: list[Contribution] = Field(default_factory=list)
    actions: list[Action] = Field(default_factory=list)
    choices: list[Choice] = Field(default_factory=list)
    change: WorkspaceChange | None = None


class InvalidatedAssumption(Model):
    """Event adjustment assumption invalidated for a stated reason."""

    event_id: str
    reason: str


class Error(Model):
    """API error details with optional current financial state."""

    code: str
    message: str
    snapshot: Snapshot | None = None


def validation_reason(item: ErrorDetails) -> str:
    """Return a field error's reason; validator messages are static and never echo input."""
    return item["msg"].removeprefix("Value error, ").removeprefix("Assertion failed, ")


def validation_detail(error: ValidationError) -> str:
    """Summarize up to three field errors as path and reason."""
    return "; ".join(
        ".".join(str(part) for part in item["loc"]) + ": " + validation_reason(item)
        for item in error.errors(include_input=False, include_context=False)[:3]
    )


class Settings(Model):
    """Public planning limits, date context, and voice availability settings."""

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
    """Voice call request with optional saved-conversation selection."""

    call_id: UUID
    conversation_slug: str | None = Field(
        default=None, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$", max_length=119
    )


class CallJoin(Model):
    """Voice call connection credentials and expiry for a selected conversation."""

    call_id: UUID
    conversation_slug: str
    url: str
    token: str = Field(repr=False)
    expires_at: datetime


class CallState(Model):
    """Voice call lifecycle status and media cleanup confirmation."""

    call_id: UUID | None = None
    conversation_slug: str | None = None
    status: Literal["idle", "connecting", "active", "ending", "ended", "error"] = "idle"
    cleanup_confirmed: bool = True
    message: str | None = None


class Health(Model):
    """Service availability status for health checks."""

    status: Literal["ok", "unavailable"]


class Deleted(Model):
    """Successful resource deletion acknowledgement."""

    deleted: Literal[True] = True
