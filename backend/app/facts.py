# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import hashlib
import unicodedata
from typing import Any
from uuid import UUID, uuid5

from .amounts import money_value
from .models import (
    ConflictInput,
    ConflictValue,
    ConflictValueInput,
    ConversionDirection,
    Decision,
    FactConflict,
    Facts,
    FactsInput,
    FactsPatch,
    Money,
    MoneyInput,
    ProviderResponseInput,
    RecordInput,
    direct_money,
)


def money_input(value: Money) -> MoneyInput:
    """Convert stored money to editable input while retaining its original currency terms."""
    if value.source is not None:
        return value.source.model_copy(deep=True)
    amount = value.amount_paise
    return MoneyInput(
        amount=None if amount is None else f"{amount // 100}.{amount % 100:02}",
        status=value.status,
    )


def facts_input(facts: Facts) -> FactsInput:
    """Convert stored financial facts and provider responses to editable input."""
    return FactsInput(
        opening=money_input(facts.opening),
        reserve=f"{facts.reserve_paise // 100}.{facts.reserve_paise % 100:02}",
        coverage=facts.coverage,
        decision=facts.decision,
        conflicts=facts.conflicts,
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


def conflict_value(
    value: ConflictValueInput, direction: ConversionDirection = "receipt"
) -> ConflictValue:
    """Normalize a disputed amount or date while retaining supplied conversion terms."""
    source = (
        MoneyInput.model_validate(
            direct_money(
                {
                    "amount": value.amount,
                    "status": value.status,
                    "conversion": value.conversion,
                },
                direction,
            )
        )
        if value.amount is not None
        else None
    )
    return ConflictValue(
        id=value.id,
        amount_paise=money_value(source)[0] if source is not None else None,
        date=value.date,
        status=value.status,
        source=source if value.conversion is not None else None,
    )


def merge_money(value: dict[str, Any], saved: dict[str, Any]) -> dict[str, Any]:
    """Preserve unspecified conversion terms in a partial money correction."""
    if "conversion" not in value and saved.get("conversion") is not None:
        value["conversion"] = saved["conversion"]
    elif (
        isinstance(value.get("conversion"), dict)
        and isinstance(saved.get("conversion"), dict)
        and value["conversion"]["currency"] == saved["conversion"]["currency"]
    ):
        if (
            value["conversion"].get("rate") is not None
            and value["conversion"].get("provider") != "frankfurter"
        ):
            value["conversion"] = {**value["conversion"], "provider": None, "fetched_at": None}
        value["conversion"] = {**saved["conversion"], **value["conversion"]}
    return value


def normalized_label(label: str) -> str:
    """Compare labels case-, width- and punctuation-insensitively."""
    return "".join(
        char for char in unicodedata.normalize("NFKC", label).casefold() if char.isalnum()
    )


def correction_targets(facts: Facts, patch: FactsPatch, command_id: UUID) -> list[str]:
    """Identify each record change: exact id, unique same-label existing record, or new id."""
    existing = {record.id for record in facts.records}
    targets = []
    for index, change in enumerate(patch.records):
        if change.id is not None and change.id in existing:
            targets.append(change.id)
            continue
        if change.id is None and (change.delete or change.distinct or not change.label):
            targets.append(str(uuid5(command_id, str(index))))
            continue
        # A repeated or rephrased item is a correction of the one record it names, so a
        # consumer never has to know record identifiers or the word correction.
        matches = [
            record.id
            for record in facts.records
            if change.label is not None
            and normalized_label(record.label) == normalized_label(change.label)
            and (change.kind is None or record.kind == change.kind)
        ]
        if len(matches) == 1:
            targets.append(matches[0])
        elif change.id is not None:
            raise ValueError("Correction target does not exist; read current state")
        elif len(matches) > 1:
            raise ValueError(
                "More than one record has that name. Use the exact ID of the one that changed, "
                "or ask which item the user means."
            )
        else:
            targets.append(str(uuid5(command_id, str(index))))
    return targets


def merge_facts(facts: Facts, patch: FactsPatch, command_id: UUID) -> FactsInput:
    """Apply fact corrections, conflicts, resolutions, and validated record merges."""
    data = facts_input(facts).model_dump()
    supplied = patch.model_dump(
        exclude_unset=True,
        exclude={"expected_revision", "records", "conflicts", "resolutions", "merges"},
    )
    targets = correction_targets(facts, patch, command_id)
    edits: set[tuple[str | None, str]] = set()
    if "opening" in supplied:
        edits.add((None, "opening"))
    for record_id, change in zip(targets, patch.records, strict=True):
        correction = record_id in {record.id for record in facts.records}
        for field in ("amount", "target", "outstanding"):
            value = getattr(change, field)
            if field in change.model_fields_set and not (
                not correction and value is not None and value.status == "unknown"
            ):
                edits.add((record_id, field))
        if change.schedule and "amounts" in change.schedule.model_fields_set:
            edits.add((record_id, "amount"))
        if change.schedule and {"date", "certainty", "pattern"} & change.schedule.model_fields_set:
            if correction or change.schedule.date is not None or change.schedule.pattern:
                edits.add((record_id, "schedule.date"))
        if change.kind is not None and any(
            record.id == record_id and record.kind != change.kind for record in facts.records
        ):
            edits.update(
                (record_id, field) for field in ("amount", "target", "outstanding", "schedule.date")
            )
    for conflict in facts.conflicts:
        if (conflict.record_id, conflict.field) in edits:
            raise ValueError("Resolve the exact field conflict before editing its disputed field")
    coverage = supplied.pop("coverage", {})
    if coverage is None:
        raise ValueError("Supply individual coverage fields, not null coverage")
    decision = supplied.pop("decision", {})
    if decision is None:
        raise ValueError("Supply individual decision fields, not null decision")
    if any(
        key in decision and decision[key] != data["decision"][key] for key in ("intent", "concern")
    ):
        data["decision"]["scope_checked"] = False
    data["decision"] = Decision.model_validate({**data["decision"], **decision}).model_dump()
    responses = {item["event_id"]: item for item in data["provider_responses"]}
    for identity in supplied.pop("remove_provider_response_ids", []):
        responses.pop(identity, None)
    for response in supplied.pop("provider_responses", []):
        saved = responses.get(response["event_id"], {})
        for field in ("payment", "cost"):
            if isinstance(response.get(field), dict) and isinstance(saved.get(field), dict):
                response[field] = merge_money(response[field], saved[field])
        responses[response["event_id"]] = response
    data["provider_responses"] = list(responses.values())
    if isinstance(supplied.get("opening"), dict):
        supplied["opening"] = merge_money(supplied["opening"], data["opening"])
    data.update(supplied)
    records = {record["id"]: record for record in data["records"]}
    seen: set[str] = set()
    reports = list(patch.conflicts)
    for record_id, change in zip(targets, patch.records, strict=True):
        if record_id in seen:
            raise ValueError("A record may be changed only once per operation")
        seen.add(record_id)
        if change.id is not None and record_id not in records:
            raise ValueError("Correction target does not exist; read current state")
        if change.distinct and (change.id is not None or change.delete):
            raise ValueError("Distinct confirmation applies only to a separate new record")
        values = change.model_dump(
            exclude_unset=True, exclude={"id", "delete", "distinct", "conflicts"}
        )
        if change.id != record_id and record_id in records:
            # Resolved by name: the saved spelling stays the card's stable label.
            values.pop("label", None)
        reports.extend(
            ConflictInput(record_id=record_id, field=item.field, values=item.values)
            for item in change.conflicts
        )
        if record_id not in records and change.label and not change.distinct:
            label = normalized_label(change.label)
            if any(
                record["kind"] == change.kind and normalized_label(record["label"]) == label
                for record in records.values()
            ):
                raise ValueError(
                    "A similarly named record was already added in this operation. Report one "
                    "item once; use distinct only if the user confirmed a separate new item."
                )
        membership_change = (
            record_id not in records
            or change.delete
            or (change.kind is not None and change.kind != records[record_id]["kind"])
        )
        if record_id in records and membership_change:
            data["coverage"][records[record_id]["kind"]] = "reported"
        if change.delete:
            if change.id is None or values or change.conflicts:
                raise ValueError("Deletion needs only an existing id and delete=true")
            if record_id in data["decision"]["ambiguous_record_ids"]:
                raise ValueError(
                    "Deleting an ambiguous candidate requires explicitly replacing or clearing "
                    "decision.ambiguousRecordIds in the same correction"
                )
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
            if values["schedule"].get("pattern") is not None:
                values["schedule"]["date"] = None
                values["schedule"]["certainty"] = "unknown"
            elif values["schedule"].get("date") is not None:
                values["schedule"]["pattern"] = None
            if "amounts" in values["schedule"]:
                if values["schedule"]["amounts"]:
                    for value in values["schedule"]["amounts"]:
                        if "conversion" not in value or (
                            isinstance(value["conversion"], dict)
                            and not {
                                "currency",
                                "rate",
                                "rate_status",
                                "rate_date",
                                "fee",
                                "fee_status",
                            }
                            <= value["conversion"].keys()
                        ):
                            raise ValueError(
                                "Each schedule amounts entry replaces a whole MoneyInput: "
                                "supply conversion=null for INR or all foreign conversion fields "
                                "with explicit null/unknown terms where needed"
                            )
                    if "amount" not in values:
                        values["amount"] = {"amount": None, "status": "unknown", "conversion": None}
                elif record.get("schedule", {}).get("amounts") and "amount" not in values:
                    raise ValueError("Clearing variable amounts requires an explicit scalar amount")
            # A concrete date alone does not establish exact timing for an estimated schedule.
            if "date" in values["schedule"] and "certainty" not in values["schedule"]:
                values["schedule"]["certainty"] = (
                    "unknown"
                    if values["schedule"]["date"] is None
                    else "estimate"
                    if record.get("schedule", {}).get("certainty") == "estimate"
                    else "exact"
                )
            values["schedule"] = {**record.get("schedule", {}), **values["schedule"]}
        for field in ("amount", "target", "outstanding"):
            if isinstance(values.get(field), dict) and isinstance(record.get(field), dict):
                values[field] = merge_money(values[field], record[field])
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
    conflicts = {
        item.id: item
        for item in facts.conflicts
        if item.record_id is None or item.record_id in records
    }
    touched: set[tuple[str | None, str]] = set()
    for report in reports:
        key = (report.record_id, report.field)
        if key in touched or key in edits:
            raise ValueError("Do not dispute and edit the same field in one operation")
        touched.add(key)
        identity = f"conflict:{report.record_id or 'opening'}:{report.field}"
        prior = conflicts.get(identity)
        if report.record_id is not None and report.record_id not in records:
            raise ValueError("Conflict must reference an existing record")
        if (
            report.field in {"target", "outstanding"}
            and records[report.record_id]["kind"] != "debt"
        ):
            raise ValueError("Only debt has target or outstanding fields")
        if report.record_id is not None and records[report.record_id]["schedule"].get("amounts"):
            if report.field == "amount":
                raise ValueError(
                    "Correct variable amounts with a full schedule amounts replacement, "
                    "not scalar conflicts"
                )
        direction: ConversionDirection = (
            "valuation"
            if report.field == "outstanding"
            else "receipt"
            if report.record_id is None or records[report.record_id]["kind"] == "income"
            else "payment"
        )
        alternatives = list(prior.values) if prior else []
        if not prior:
            saved = (
                data["opening"]
                if report.field == "opening"
                else records[report.record_id]["schedule"]["date"]
                if report.field == "schedule.date"
                else records[report.record_id].get(report.field)
            )
            if saved is not None and (
                report.field == "schedule.date" or saved["amount"] is not None
            ):
                saved_id = "saved-" + hashlib.sha256(str(saved).encode()).hexdigest()[:16]
                alternatives.append(
                    conflict_value(
                        ConflictValueInput(
                            id=saved_id,
                            date=saved if report.field == "schedule.date" else None,
                            amount=None if report.field == "schedule.date" else saved["amount"],
                            conversion=None
                            if report.field == "schedule.date"
                            else saved.get("conversion"),
                            status=records[report.record_id]["schedule"]["certainty"]
                            if report.field == "schedule.date"
                            else saved["status"],
                        ),
                        direction,
                    )
                )
        for candidate in report.values:
            value = conflict_value(candidate, direction)
            matching_id = next((item for item in alternatives if item.id == value.id), None)
            if matching_id is not None and matching_id != value:
                raise ValueError("Competing value ID already identifies another value")
            if not any(
                item.model_dump(exclude={"id"}) == value.model_dump(exclude={"id"})
                for item in alternatives
            ):
                alternatives.append(value)
        if len(alternatives) < 2:
            if not prior and (
                saved is None or (report.field != "schedule.date" and saved["amount"] is None)
            ):
                raise ValueError("A conflict needs at least two concrete competing values")
            continue
        conflict = FactConflict(
            id=identity, record_id=report.record_id, field=report.field, values=alternatives
        )
        conflicts[identity] = conflict
        set_conflict_value(data, records, conflict, None)
    resolved: set[str] = set()
    for resolution in patch.resolutions:
        resolving = conflicts.get(resolution.conflict_id)
        if (
            resolving is None
            or resolving.id in resolved
            or (resolving.record_id, resolving.field) in touched
        ):
            raise ValueError("Resolve each existing conflict exactly once")
        if (resolving.record_id, resolving.field) in edits:
            raise ValueError("Do not resolve and edit the same disputed field")
        value = conflict_value(
            resolution.value,
            (
                "valuation"
                if resolving.field == "outstanding"
                else "receipt"
                if resolving.record_id is None or records[resolving.record_id]["kind"] == "income"
                else "payment"
            ),
        )
        if (value.date is not None) != (resolving.field == "schedule.date"):
            raise ValueError("Resolution must address the disputed field type")
        matching_id = next((item for item in resolving.values if item.id == value.id), None)
        if matching_id is not None and (
            matching_id.amount_paise,
            matching_id.date,
            matching_id.source.model_dump(exclude={"status"}) if matching_id.source else None,
        ) != (
            value.amount_paise,
            value.date,
            value.source.model_dump(exclude={"status"}) if value.source else None,
        ):
            raise ValueError("Competing value ID already identifies another value")
        set_conflict_value(data, records, resolving, value)
        resolved.add(resolving.id)
        del conflicts[resolving.id]
    merged: set[str] = set()
    for merge in patch.merges:
        ids = {merge.source_id, merge.target_id}
        if (
            not ids <= records.keys()
            or ids & (seen | merged)
            or any(item.record_id in ids for item in facts.conflicts)
            or any(identity in ids for identity, _ in touched)
        ):
            raise ValueError(
                "Merge requires untouched existing records without unresolved conflicts"
            )
        source, target = records[merge.source_id], records[merge.target_id]
        if source["kind"] != target["kind"]:
            raise ValueError("Only records of the same kind can be merged")
        if source["schedule"]["recurrence"] != target["schedule"]["recurrence"]:
            raise ValueError("Clarify differing recurrence before merging")
        if source["schedule"]["pattern"] != target["schedule"]["pattern"]:
            raise ValueError("Clarify differing monthly patterns before merging")
        if (source["schedule"]["amounts"] or target["schedule"]["amounts"]) and any(
            item["amount"]["amount"] is not None
            or item["amount"].get("conversion") is not None
            or item.get("target") is not None
            for item in (source, target)
        ):
            raise ValueError("Clarify scalar and variable amounts before merging")
        for field in ("amount", "target", "outstanding"):
            left, right = source.get(field), target.get(field)
            if left is None or left["amount"] is None:
                continue
            if right is None or right["amount"] is None:
                target[field] = left
            elif left != right:
                raise ValueError("Clarify differing money values or certainty before merging")
        for field in ("end_date", "count", "amounts"):
            left, right = source["schedule"][field], target["schedule"][field]
            if left is None or left == []:
                continue
            if right is None or right == []:
                target["schedule"][field] = left
            elif left != right:
                raise ValueError(
                    "Clarify differing finite or variable schedule terms before merging"
                )
        if source["schedule"]["date"] is not None:
            if target["schedule"]["date"] is None:
                for field in ("date", "certainty"):
                    target["schedule"][field] = source["schedule"][field]
            elif any(
                source["schedule"][field] != target["schedule"][field]
                for field in ("date", "certainty")
            ):
                raise ValueError("Clarify differing dates or certainty before merging")
        for field in ("reliability", "debt_type", "controllability", "auto_debit"):
            left, right = source.get(field), target.get(field)
            if left in (None, "unknown"):
                continue
            if right in (None, "unknown"):
                target[field] = left
            elif left != right:
                raise ValueError("Clarify differing obligation terms before merging")
        for field in ("focus_record_ids", "ambiguous_record_ids"):
            data["decision"][field] = list(
                dict.fromkeys(
                    merge.target_id if item == merge.source_id else item
                    for item in data["decision"][field]
                )
            )
        if len(data["decision"]["ambiguous_record_ids"]) == 1:
            data["decision"]["ambiguous_record_ids"] = []
        del records[merge.source_id]
        merged.update(ids)
    data["conflicts"] = list(conflicts.values())
    data["records"] = list(records.values())
    data["decision"]["focus_record_ids"] = [
        identity for identity in data["decision"]["focus_record_ids"] if identity in records
    ]
    return FactsInput.model_validate(data)


def set_conflict_value(
    data: dict[str, Any],
    records: dict[str, Any],
    conflict: FactConflict,
    value: ConflictValue | None,
) -> None:
    """Assign a resolved field value or mark an unresolved disputed field as unknown."""
    if conflict.field == "schedule.date":
        records[conflict.record_id or ""]["schedule"].update(
            date=value.date if value else None,
            certainty=value.status if value else "unknown",
            pattern=None,
        )
        return
    amount = value.amount_paise if value else None
    money = {
        "amount": None if amount is None else f"{amount // 100}.{amount % 100:02}",
        "status": value.status if value else "unknown",
    }
    if value is not None and value.source is not None:
        money = value.source.model_dump()
    if conflict.field == "opening":
        data["opening"] = money
    else:
        records[conflict.record_id or ""][conflict.field] = money
