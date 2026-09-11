# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import datetime
from typing import Literal
from uuid import UUID, uuid5

from pydantic import Field, model_validator

from .models import (
    Controllability,
    CoverageStatus,
    Decision,
    Facts,
    FactsInput,
    Kind,
    Model,
    Money,
    MoneyInput,
    ProviderResponseInput,
    RecordId,
    RecordInput,
    Rupees,
)


class CoveragePatch(Model):
    income: CoverageStatus | None = None
    essential: CoverageStatus | None = None
    optional: CoverageStatus | None = None
    debt: CoverageStatus | None = None


class SchedulePatch(Model):
    date: datetime.date | None = None
    recurrence: Literal["once", "weekly", "fortnightly", "monthly"] | None = None


class RecordPatch(Model):
    id: RecordId | None = None
    delete: bool = False
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


class DecisionPatch(Model):
    intent: Literal["plan30Days", "specificDecision"] | None = None
    concern: str | None = Field(default=None, min_length=1, max_length=2000)
    focus_record_ids: list[RecordId] | None = None
    response_preference: Literal["standard", "brief"] | None = None


class FactsPatch(Model):
    expected_revision: int = Field(ge=0, strict=True)
    opening: MoneyInput | None = None
    reserve: Rupees | None = None
    coverage: CoveragePatch | None = None
    records: list[RecordPatch] = Field(default_factory=list, max_length=500)
    decision: DecisionPatch | None = None
    provider_responses: list[ProviderResponseInput] = Field(default_factory=list, max_length=1000)
    remove_provider_response_ids: list[str] = Field(default_factory=list, max_length=1000)

    @model_validator(mode="after")
    def validate_provider_changes(self) -> "FactsPatch":
        if set(self.remove_provider_response_ids) & {
            item.event_id for item in self.provider_responses
        }:
            raise ValueError("A provider response cannot be supplied and retracted together")
        return self


def money_input(value: Money) -> MoneyInput:
    amount = value.amount_paise
    return MoneyInput(
        amount=None if amount is None else f"{amount // 100}.{amount % 100:02}",
        status=value.status,
    )


def facts_input(facts: Facts) -> FactsInput:
    return FactsInput(
        opening=money_input(facts.opening),
        reserve=f"{facts.reserve_paise // 100}.{facts.reserve_paise % 100:02}",
        coverage=facts.coverage,
        decision=facts.decision,
        provider_responses=[
            ProviderResponseInput(
                **item.model_dump(exclude={"payment", "cost", "dependency_key"}),
                payment=money_input(item.payment) if item.payment is not None else None,
                cost=money_input(item.cost) if item.cost is not None else None,
            )
            for item in facts.provider_responses
        ],
        records=[
            RecordInput.model_validate(
                {
                    **record.model_dump(exclude={"amount", "target", "outstanding"}),
                    "amount": money_input(record.amount),
                    "target": money_input(record.target) if record.target is not None else None,
                    "outstanding": (
                        money_input(record.outstanding) if record.outstanding is not None else None
                    ),
                }
            )
            for record in facts.records
        ],
    )


def merge_facts(facts: Facts, patch: FactsPatch, command_id: UUID) -> FactsInput:
    data = facts_input(facts).model_dump()
    supplied = patch.model_dump(exclude_unset=True, exclude={"expected_revision", "records"})
    coverage = supplied.pop("coverage", {})
    if coverage is None:
        raise ValueError("Supply individual coverage fields, not null coverage")
    decision = supplied.pop("decision", {})
    if decision is None:
        raise ValueError("Supply individual decision fields, not null decision")
    data["decision"] = Decision.model_validate({**data["decision"], **decision}).model_dump()
    responses = {item["event_id"]: item for item in data["provider_responses"]}
    for identity in supplied.pop("remove_provider_response_ids", []):
        responses.pop(identity, None)
    for response in supplied.pop("provider_responses", []):
        responses[response["event_id"]] = response
    data["provider_responses"] = list(responses.values())
    data.update(supplied)
    records = {record["id"]: record for record in data["records"]}
    seen: set[str] = set()
    for index, change in enumerate(patch.records):
        record_id = change.id or str(uuid5(command_id, str(index)))
        if record_id in seen:
            raise ValueError("A record may be changed only once per tool call")
        seen.add(record_id)
        if change.id is not None and record_id not in records:
            raise ValueError("Correction target does not exist; read current state")
        values = change.model_dump(exclude_unset=True, exclude={"id", "delete"})
        membership_change = (
            record_id not in records
            or change.delete
            or (change.kind is not None and change.kind != records[record_id]["kind"])
        )
        if record_id in records and membership_change:
            data["coverage"][records[record_id]["kind"]] = "reported"
        if change.delete:
            if change.id is None or values:
                raise ValueError("Deletion needs only an existing id and delete=true")
            del records[record_id]
            continue
        record = records.get(
            record_id,
            {
                "id": record_id,
                "amount": {"amount": None, "status": "unknown"},
                "schedule": {"date": None},
            },
        )
        if "schedule" in values and isinstance(values["schedule"], dict):
            values["schedule"] = {**record.get("schedule", {}), **values["schedule"]}
        if change.kind is not None and change.kind != record.get("kind"):
            incompatible = (
                {"reliability"} if change.kind != "income" else {"auto_debit", "controllability"}
            )
            if change.kind != "debt":
                incompatible.update({"debt_type", "target", "outstanding"})
            for field in incompatible - values.keys():
                record.pop(field, None)
        record.update(values)
        if (
            record.get("kind") == "income"
            and "reliability" not in values
            and not record.get("reliability")
        ):
            record["reliability"] = "unknown"
        if (
            record.get("kind") == "debt"
            and "debt_type" not in values
            and not record.get("debt_type")
        ):
            record["debt_type"] = "unknown"
        if record.get("kind") is not None and membership_change:
            data["coverage"][record["kind"]] = "reported"
        records[record_id] = record
    data["coverage"].update(coverage)
    data["records"] = list(records.values())
    data["decision"]["focus_record_ids"] = [
        identity for identity in data["decision"]["focus_record_ids"] if identity in records
    ]
    return FactsInput.model_validate(data)
