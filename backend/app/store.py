# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from uuid import uuid4, uuid5
from zoneinfo import ZoneInfo

import aiosqlite
from pydantic import TypeAdapter, ValidationError

from .auth_models import Access, Owner
from .config import Config
from .decisions import UNAVAILABLE_ACTIONS, action_dependency_key
from .facts import merge_facts
from .finance import adjustment_options, calculate, dependency_key, normalize, resolve_adjustments
from .models import (
    AcceptPreview,
    ActionResponse,
    Adjustment,
    AdjustmentInput,
    AdjustmentOptions,
    ClearAccepted,
    Command,
    Coverage,
    Decision,
    DiscardPreview,
    Error,
    Facts,
    FactsPatch,
    InvalidatedAssumption,
    Money,
    PreviewAdjustments,
    RejectedProposal,
    RejectPreview,
    ReplaceFacts,
    RespondToAction,
    Scenario,
    Snapshot,
    UpdateFacts,
)
from .workspace import change_set, project


class Problem(Exception):
    def __init__(self, status: int, code: str, message: str, snapshot: Snapshot | None = None):
        self.status = status
        self.body = Error(code=code, message=message, snapshot=snapshot)
        super().__init__(message)


def utc_now() -> datetime:
    return datetime.now(UTC)


def owner_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Store:
    def __init__(self, path: Path, config: Config, clock: Callable[[], datetime] = utc_now):
        self.path = path
        self.config = config
        self.clock = clock
        self.lock = asyncio.Lock()
        self.listeners: dict[str, set[asyncio.Queue[Snapshot | Error]]] = {}
        self.listener_access: dict[asyncio.Queue[Snapshot | Error], Access] = {}
        self.authorize: Callable[[Access], Awaitable[None]] | None = None
        self.authorize_locked: Callable[[Access], Awaitable[None]] | None = None
        self.db: aiosqlite.Connection | None = None

    async def open(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = await aiosqlite.connect(self.path)
        await self.db.executescript(
            """
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS sessions (
                owner TEXT PRIMARY KEY,
                expires TEXT NOT NULL,
                snapshot TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS commands (
                owner TEXT NOT NULL REFERENCES sessions(owner) ON DELETE CASCADE,
                id TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                result TEXT NOT NULL,
                PRIMARY KEY (owner, id)
            );
            CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
            CREATE TABLE IF NOT EXISTS conversations (
                call_id TEXT PRIMARY KEY,
                owner TEXT NOT NULL REFERENCES sessions(owner) ON DELETE CASCADE,
                session_id TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                started TEXT NOT NULL,
                ended TEXT,
                expires TEXT NOT NULL,
                search_date TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS conversation_owner ON conversations(owner, started);
            CREATE TABLE IF NOT EXISTS conversation_messages (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                call_id TEXT NOT NULL REFERENCES conversations(call_id) ON DELETE CASCADE,
                segment TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                text TEXT NOT NULL,
                created TEXT NOT NULL,
                interrupted INTEGER NOT NULL,
                finalized INTEGER NOT NULL,
                UNIQUE(call_id, segment)
            );
        """
        )
        await self.db.create_function("casefold", 1, str.casefold, deterministic=True)
        await self.db.commit()

    async def close(self) -> None:
        async with self.lock:
            for owner in list(self.listeners):
                self.publish(owner, Error(code="unavailable", message="Server is shutting down."))
            if self.db is not None:
                await self.db.close()
                self.db = None

    def connection(self) -> aiosqlite.Connection:
        if self.db is None:
            raise Problem(503, "unavailable", "Storage is unavailable.")
        return self.db

    async def check(self, owner: Owner) -> None:
        if isinstance(owner, Access):
            if self.authorize is None:
                raise Problem(401, "unauthenticated", "Sign in to continue.")
            await self.authorize(owner)

    async def owner_key(self, owner: Owner) -> str:
        # Network and voice callers retain Access through every lock and transaction boundary.
        if isinstance(owner, Access):
            if self.authorize_locked is None:
                raise Problem(401, "unauthenticated", "Sign in to continue.")
            await self.authorize_locked(owner)
            return owner.user_id
        return owner

    def revoke(self, user_id: str, session_hash: str | None = None) -> None:
        for queue in tuple(self.listeners.get(user_id, ())):
            access = self.listener_access.get(queue)
            if session_hash is None or (access and access.session_hash == session_hash):
                if queue.full():
                    queue.get_nowait()
                queue.put_nowait(Error(code="unauthenticated", message="Sign in to continue."))
                self.unsubscribe(user_id, queue)

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        db = self.connection()
        await db.execute("BEGIN IMMEDIATE")
        try:
            yield
            await db.commit()
        except BaseException:
            await db.rollback()
            raise

    def publish(self, owner: str, value: Snapshot | Error) -> None:
        for queue in self.listeners.get(owner, set()):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(value)
        if isinstance(value, Error):
            for queue in self.listeners.get(owner, ()):
                self.listener_access.pop(queue, None)
            self.listeners.pop(owner, None)

    async def remove(self, owner: str, code: str, access: Owner | None = None) -> None:
        db = self.connection()
        async with self.transaction():
            if access is not None:
                await self.owner_key(access)
            await db.execute("DELETE FROM sessions WHERE owner = ?", (owner,))
        self.publish(owner, Error(code=code, message=f"Session {code}."))

    def load_snapshot(self, text: str, *, today: date | None = None) -> tuple[Snapshot, bool]:
        try:
            payload = json.loads(text)
            if not isinstance(payload, dict):
                raise ValueError("Snapshot must be an object")
            facts = Facts.model_validate(payload["facts"])
            anchor = TypeAdapter(date).validate_python(payload["anchorDate"])
            cached_plan = payload.get("plan", {})
            if not isinstance(cached_plan, dict):
                raise ValueError("Cached projection must be an object")
            rebuild = "evaluatedOn" not in cached_plan
            evaluated_on = (
                anchor if rebuild else TypeAdapter(date).validate_python(cached_plan["evaluatedOn"])
            )
            # Stored projections are caches, never inputs to current schema validation.
            payload.pop("workspace", None)
            plan = calculate(facts, anchor, self.config, today=today or evaluated_on)
            payload["plan"] = plan
            for field in ("preview", "accepted"):
                scenario = payload.get(field)
                if scenario is None:
                    continue
                if not isinstance(scenario, dict):
                    raise ValueError("Scenario must be an object")
                adjustments = TypeAdapter(list[Adjustment]).validate_python(scenario["adjustments"])
                scenario["plan"] = calculate(
                    facts, anchor, self.config, adjustments=adjustments, today=today or evaluated_on
                )
                scenario["reducedOutflowPaise"] = (
                    plan.outflow_paise - scenario["plan"].outflow_paise
                )
            snapshot = Snapshot.model_validate(payload)
            snapshot.workspace = project(snapshot, self.config)
            if snapshot.expires_at.utcoffset() is None:
                raise ValueError("Session expiry must include a timezone")
            return snapshot, rebuild
        except (ValueError, KeyError, TypeError):
            raise Problem(
                500, "invalidStoredState", "Stored session state is invalid; unable to load it."
            ) from None

    async def current(self, owner: Owner) -> Snapshot:
        access = owner
        owner = await self.owner_key(owner)
        async with self.connection().execute(
            "SELECT snapshot FROM sessions WHERE owner = ?", (owner,)
        ) as cursor:
            row = await cursor.fetchone()
        if row is None:
            raise Problem(404, "notFound", "No current session.")
        snapshot, rebuild = self.load_snapshot(row[0])
        now = self.clock()
        if snapshot.expires_at <= now:
            await self.remove(owner, "expired")
            raise Problem(410, "expired", "Session expired; start a fresh session.")
        today = now.astimezone(ZoneInfo(self.config.timezone)).date()
        if rebuild or snapshot.plan.evaluated_on != today:
            snapshot, _ = self.load_snapshot(row[0], today=today)
            snapshot.sequence += 1
            async with self.transaction():
                await self.owner_key(access)
                await self.connection().execute(
                    "UPDATE sessions SET snapshot = ? WHERE owner = ?",
                    (snapshot.model_dump_json(by_alias=True), owner),
                )
            self.publish(owner, snapshot)
        return snapshot

    async def get(self, owner: Owner) -> Snapshot:
        await self.check(owner)
        async with self.lock:
            return await self.current(owner)

    async def options(self, owner: Owner) -> AdjustmentOptions:
        await self.check(owner)
        async with self.lock:
            snapshot = await self.current(owner)
            today = self.clock().astimezone(ZoneInfo(self.config.timezone)).date()
            return AdjustmentOptions(
                revision=snapshot.revision,
                today=today,
                options=adjustment_options(
                    snapshot.facts,
                    snapshot.plan.events,
                    snapshot.anchor_date,
                    snapshot.end_date_exclusive,
                    today,
                ),
            )

    async def create(self, owner: Owner) -> Snapshot:
        await self.check(owner)
        access = owner
        async with self.lock:
            owner = await self.owner_key(owner)
            db = self.connection()
            try:
                return await self.current(access)
            except Problem as error:
                if error.status != 404:
                    raise
            await self.cleanup_locked()
            async with db.execute("SELECT COUNT(*) FROM sessions") as cursor:
                row = await cursor.fetchone()
            if row is not None and row[0] >= self.config.max_sessions:
                raise Problem(429, "sessionLimit", "Session capacity reached; try later.")
            now = self.clock()
            anchor = now.astimezone(ZoneInfo(self.config.timezone)).date()
            facts = Facts(
                opening=Money(amount_paise=None, status="unknown"),
                reserve_paise=0,
                coverage=Coverage(),
                records=[],
            )
            snapshot = Snapshot(
                session_id=uuid4(),
                revision=0,
                sequence=0,
                created_at=now,
                as_of=now,
                expires_at=now + timedelta(hours=self.config.retention_hours),
                anchor_date=anchor,
                end_date_exclusive=anchor + timedelta(days=self.config.horizon_days),
                facts=facts,
                plan=calculate(facts, anchor, self.config),
            )
            snapshot.workspace = project(snapshot, self.config)
            async with self.transaction():
                await self.owner_key(access)
                await db.execute(
                    "INSERT INTO sessions VALUES (?, ?, ?)",
                    (
                        owner,
                        snapshot.expires_at.isoformat(),
                        snapshot.model_dump_json(by_alias=True),
                    ),
                )
            return snapshot

    async def command(self, owner: Owner, command: Command) -> Snapshot:
        await self.check(owner)
        access = owner
        changes: FactsPatch | None = None
        if isinstance(command.operation, UpdateFacts):
            changes = command.operation.changes
            if changes.expected_revision != command.expected_revision:
                raise Problem(422, "invalidFacts", "Fact changes require the advertised revision")
        payload = command.model_dump_json(exclude_unset=True)
        fingerprint = hashlib.sha256(payload.encode()).hexdigest()
        async with self.lock:
            owner = await self.owner_key(owner)
            db = self.connection()
            snapshot = await self.current(access)
            async with db.execute(
                "SELECT fingerprint, result FROM commands WHERE owner = ? AND id = ?",
                (owner, str(command.command_id)),
            ) as cursor:
                row = await cursor.fetchone()
            if row is not None:
                if row[0] != fingerprint:
                    raise Problem(
                        409, "commandConflict", "Command ID was used for different content."
                    )
                snapshot, _ = self.load_snapshot(row[1])
                return snapshot
            if snapshot.revision != command.expected_revision:
                raise Problem(
                    409,
                    "staleRevision",
                    "Session changed; preserve your draft and review current facts.",
                    snapshot,
                )
            async with db.execute(
                "SELECT COUNT(*) FROM commands WHERE owner = ?", (owner,)
            ) as cursor:
                row = await cursor.fetchone()
            if row is not None and row[0] >= self.config.max_commands:
                raise Problem(
                    429,
                    "commandLimit",
                    "Session edit limit reached; export and start a fresh session.",
                )
            operation = command.operation
            before = snapshot.model_copy(deep=True)
            now = self.clock()
            today = now.astimezone(ZoneInfo(self.config.timezone)).date()
            if isinstance(operation, ReplaceFacts | UpdateFacts):
                try:
                    if changes is not None and not set(changes.remove_provider_response_ids) <= (
                        {event.id for event in snapshot.plan.events if event.kind != "income"}
                        | {item.event_id for item in snapshot.facts.provider_responses}
                    ):
                        raise ValueError("Retract only exact existing obligation occurrence IDs")
                    source = (
                        merge_facts(snapshot.facts, changes, command.command_id)
                        if changes is not None
                        else operation.facts
                        if isinstance(operation, ReplaceFacts)
                        else None
                    )
                    if source is None:
                        raise ValueError("Fact changes are required")
                    if isinstance(operation, ReplaceFacts):
                        if source.conflicts != snapshot.facts.conflicts:
                            raise ValueError(
                                "Conflicts are server-managed; "
                                "use updateFacts to dispute or resolve"
                            )
                        source_records = {item.id: item for item in source.records}
                        saved_records = {item.id: item for item in snapshot.facts.records}
                        for conflict in snapshot.facts.conflicts:
                            if conflict.field == "opening":
                                if source.opening.amount is not None:
                                    raise ValueError("Resolve the opening conflict explicitly")
                            elif conflict.record_id not in source_records:
                                raise ValueError("Delete a disputed item by exact updateFacts ID")
                            elif (
                                source_records[conflict.record_id].kind
                                != saved_records[conflict.record_id].kind
                            ):
                                raise ValueError(
                                    "Resolve the conflict before changing the record kind"
                                )
                    if (
                        "responses" in source.decision.model_fields_set
                        and source.decision.responses != snapshot.facts.decision.responses
                    ):
                        raise ValueError("Action responses are server-managed; use respondToAction")
                    facts = normalize(source, self.config)
                    facts.decision = facts.decision.model_copy(
                        update={"responses": snapshot.facts.decision.responses}
                    )
                    plan = calculate(facts, snapshot.anchor_date, self.config, today=today)
                except ValidationError as error:
                    raise Problem(
                        422, "invalidFacts", "Incomplete or invalid financial fields; clarify them."
                    ) from error
                except ValueError as error:
                    raise Problem(422, "invalidFacts", str(error)) from error
                records = {record.id: record for record in facts.records}
                events = {event.id: event for event in plan.events}
                previous = {item.event_id: item for item in snapshot.facts.provider_responses}
                responses = []
                invalidated = []
                supplied = (
                    {item.event_id for item in changes.provider_responses} if changes else set()
                )
                for response in facts.provider_responses:
                    event = events.get(response.event_id)
                    prior = previous.get(response.event_id)
                    fresh = (
                        response.event_id in supplied
                        or prior is None
                        or (
                            response.model_dump(exclude={"dependency_key"})
                            != prior.model_dump(exclude={"dependency_key"})
                        )
                    )
                    if response.reported_on > today:
                        raise Problem(
                            422, "invalidFacts", "Provider report cannot be future-dated."
                        )
                    if event is None or event.kind == "income":
                        if prior is not None and not fresh:
                            invalidated.append(
                                InvalidatedAssumption(
                                    event_id=response.event_id,
                                    reason="Provider report no longer matches a due occurrence; "
                                    "confirm the applicable obligation before relying on it.",
                                )
                            )
                            continue
                        raise Problem(
                            422, "invalidFacts", "Provider response needs a due occurrence."
                        )
                    key = dependency_key(records[event.record_id], event)
                    if prior is not None and prior.dependency_key != key and not fresh:
                        invalidated.append(
                            InvalidatedAssumption(
                                event_id=response.event_id,
                                reason="Carried provider report refers to changed terms; "
                                "confirm a fresh report about the corrected obligation.",
                            )
                        )
                        continue
                    response.dependency_key = key
                    responses.append(response)
                facts.provider_responses = responses
                plan = calculate(facts, snapshot.anchor_date, self.config, today=today)
                available = {
                    item.event_id: item
                    for item in adjustment_options(
                        facts,
                        plan.events,
                        snapshot.anchor_date,
                        snapshot.end_date_exclusive,
                        snapshot.anchor_date,
                    )
                }
                accepted = snapshot.accepted
                if accepted is not None:
                    retained = []
                    for item in accepted.adjustments:
                        option = available.get(item.event_id)
                        if (
                            option is None
                            or option.dependency_key != item.dependency_key
                            or not option.acceptance_ready
                            or not option.minimum_paise <= item.amount_paise < option.original_paise
                        ):
                            invalidated.append(
                                InvalidatedAssumption(
                                    event_id=item.event_id,
                                    reason="Occurrence date, amount, minimum, controllability or "
                                    "obligation terms changed; confirm a fresh proposal.",
                                )
                            )
                        else:
                            retained.append(item.model_copy(update={"label": option.label}))
                    if retained:
                        accepted = accepted.model_copy(update={"adjustments": retained})
                        accepted.plan = calculate(
                            facts,
                            snapshot.anchor_date,
                            self.config,
                            adjustments=retained,
                            today=today,
                        )
                        accepted.reduced_outflow_paise = (
                            plan.outflow_paise - accepted.plan.outflow_paise
                        )
                    else:
                        accepted = None
                facts.decision.responses = [
                    item
                    for item in facts.decision.responses
                    if item.dependency_key
                    == action_dependency_key(
                        facts, accepted.plan if accepted else plan, item.action_id
                    )
                ]
                if changes is not None:
                    unknowns: set[str] = set()
                    if changes.opening is not None and changes.opening.status == "unknown":
                        unknowns.add("clarify:opening")
                    for index, change in enumerate(changes.records):
                        identity = change.id or str(uuid5(command.command_id, str(index)))
                        if change.delete or identity in facts.decision.ambiguous_record_ids:
                            continue
                        for field in ("amount", "target", "outstanding"):
                            value = getattr(change, field)
                            if value is not None and value.status == "unknown":
                                unknowns.add(f"clarify:{identity}:{field}")
                        if (
                            change.schedule is not None
                            and "date" in change.schedule.model_fields_set
                            and change.schedule.date is None
                        ):
                            unknowns.add(f"clarify:{identity}:schedule.date")
                    # Only supplied unknowns answering actual questions enter the response ledger.
                    active_plan = accepted.plan if accepted else plan
                    for clarification in active_plan.decision_assessment.actions:
                        if clarification.kind != "clarify" or clarification.id not in unknowns:
                            continue
                        response_key = action_dependency_key(facts, active_plan, clarification.id)
                        if response_key is not None:
                            facts.decision.responses.append(
                                ActionResponse(
                                    action_id=clarification.id,
                                    response="unavailable",
                                    dependency_key=response_key,
                                )
                            )
                    try:
                        facts.decision = Decision.model_validate(facts.decision.model_dump())
                    except ValidationError as error:
                        raise Problem(
                            422, "invalidFacts", "Action response limit reached."
                        ) from error
                if facts.decision.responses != snapshot.facts.decision.responses:
                    plan = calculate(facts, snapshot.anchor_date, self.config, today=today)
                    if accepted is not None:
                        accepted.plan = calculate(
                            facts,
                            snapshot.anchor_date,
                            self.config,
                            adjustments=accepted.adjustments,
                            today=today,
                        )
                snapshot = snapshot.model_copy(
                    update={
                        "facts": facts,
                        "plan": plan,
                        "preview": None,
                        "accepted": accepted,
                        "invalidated_assumptions": invalidated,
                    }
                )
                snapshot.rejected_proposals = [
                    proposal
                    for proposal in snapshot.rejected_proposals
                    if all(
                        item.event_id in events
                        and item.record_id in records
                        and dependency_key(records[item.record_id], events[item.event_id])
                        == item.dependency_key
                        for item in proposal.adjustments
                    )
                ]
            elif isinstance(operation, RespondToAction):
                plan = snapshot.accepted.plan if snapshot.accepted else snapshot.plan
                assessment = plan.decision_assessment
                action = next(
                    (item for item in snapshot.workspace.actions if item.id == operation.action_id),
                    None,
                )
                choice = next(
                    (item for item in assessment.choices if action and item.id == action.choice_id),
                    None,
                )
                response_key = action_dependency_key(snapshot.facts, plan, operation.action_id)
                if (
                    action is None
                    or response_key is None
                    or not (
                        (
                            operation.response == "unavailable"
                            and action.kind in UNAVAILABLE_ACTIONS
                            and (action.choice_id is None or choice is not None)
                        )
                        or (
                            operation.response == "declined"
                            and action.kind == "previewChange"
                            and choice is not None
                            and choice.kind in {"reduceOptional", "cardMinimum"}
                            and choice.adjustment_amounts
                        )
                    )
                ):
                    raise Problem(
                        422,
                        "invalidActionResponse",
                        "Response must address a current supported workspace action.",
                        snapshot,
                    )
                if (
                    snapshot.preview is not None
                    and choice is not None
                    and choice.adjustment_amounts
                ):
                    accepted_amounts = (
                        {item.event_id: item.amount_paise for item in snapshot.accepted.adjustments}
                        if snapshot.accepted
                        else {}
                    )
                    pending_changes = {
                        item.event_id
                        for item in snapshot.preview.adjustments
                        if accepted_amounts.get(item.event_id) != item.amount_paise
                    } | set(snapshot.preview.removed_assumption_ids)
                    if pending_changes.intersection(choice.event_ids):
                        if {
                            item.event_id: item.amount_paise
                            for item in snapshot.preview.adjustments
                        } != {
                            item.event_id: item.amount_paise for item in choice.adjustment_amounts
                        }:
                            raise Problem(
                                409,
                                "stalePreview",
                                "Pending proposal differs from this choice; "
                                "review or discard it before responding.",
                                snapshot,
                            )
                        if operation.response == "declined":
                            snapshot.preview = None
                try:
                    snapshot.facts.decision = Decision.model_validate(
                        {
                            **snapshot.facts.decision.model_dump(),
                            "responses": [
                                item
                                for item in snapshot.facts.decision.responses
                                if item.action_id != action.id
                            ]
                            + [
                                ActionResponse(
                                    action_id=action.id,
                                    response=operation.response,
                                    dependency_key=response_key,
                                )
                            ],
                        }
                    )
                except ValidationError as error:
                    raise Problem(
                        422, "invalidActionResponse", "Action response limit reached."
                    ) from error
                snapshot.plan = calculate(
                    snapshot.facts, snapshot.anchor_date, self.config, today=today
                )
                for scenario in (snapshot.accepted, snapshot.preview):
                    if scenario is not None:
                        scenario.plan = calculate(
                            snapshot.facts,
                            snapshot.anchor_date,
                            self.config,
                            adjustments=scenario.adjustments,
                            today=today,
                        )
                if (
                    snapshot.preview is not None
                    and snapshot.preview.source_revision == snapshot.revision
                ):
                    snapshot.preview.source_revision += 1
            elif isinstance(operation, PreviewAdjustments):
                try:
                    adjustments = self.resolve_proposal(snapshot, operation.adjustments, today)
                    plan = calculate(
                        snapshot.facts,
                        snapshot.anchor_date,
                        self.config,
                        adjustments=adjustments,
                        today=today,
                    )
                except ValueError as error:
                    raise Problem(422, "invalidAdjustments", str(error), snapshot) from error
                snapshot.preview = Scenario(
                    id=uuid4(),
                    source_revision=snapshot.revision,
                    created_at=now,
                    adjustments=adjustments,
                    plan=plan,
                    reduced_outflow_paise=snapshot.plan.outflow_paise - plan.outflow_paise,
                    removed_assumption_ids=[
                        item.event_id
                        for item in snapshot.accepted.adjustments
                        if item.event_id not in {selection.event_id for selection in adjustments}
                    ]
                    if snapshot.accepted
                    else [],
                )
            elif isinstance(operation, AcceptPreview | DiscardPreview | RejectPreview):
                preview = snapshot.preview
                if preview is None or preview.id != operation.preview_id:
                    raise Problem(
                        409, "stalePreview", "Preview is no longer current; review again.", snapshot
                    )
                if isinstance(operation, AcceptPreview):
                    if preview.source_revision != snapshot.revision:
                        raise Problem(
                            409, "stalePreview", "Preview facts revision is stale.", snapshot
                        )
                    try:
                        resolved = self.resolve_proposal(
                            snapshot,
                            [
                                AdjustmentInput(
                                    event_id=item.event_id,
                                    amount=f"{item.amount_paise // 100}."
                                    f"{item.amount_paise % 100:02}",
                                )
                                for item in preview.adjustments
                            ],
                            today,
                        )
                        if resolved != preview.adjustments:
                            raise ValueError("Preview assumptions no longer match the baseline")
                        if not all(item.acceptance_ready for item in resolved):
                            raise ValueError("Confirm controllability in facts before acceptance")
                    except ValueError as error:
                        raise Problem(409, "stalePreview", str(error), snapshot) from error
                    snapshot.accepted = preview.model_copy(
                        update={
                            "adjustments": [
                                item.model_copy(
                                    update={
                                        "accepted_revision": item.accepted_revision
                                        or snapshot.revision + 1
                                    }
                                )
                                for item in preview.adjustments
                            ]
                        }
                    )
                    snapshot.invalidated_assumptions = []
                elif isinstance(operation, RejectPreview):
                    if len(snapshot.rejected_proposals) >= self.config.max_commands:
                        raise Problem(
                            422, "decisionLimit", "Rejected proposal limit reached", snapshot
                        )
                    snapshot.rejected_proposals.append(
                        RejectedProposal(id=preview.id, adjustments=preview.adjustments)
                    )
                    active = snapshot.accepted.plan if snapshot.accepted else snapshot.plan
                    amounts = {item.event_id: item.amount_paise for item in preview.adjustments}
                    for action in active.decision_assessment.actions:
                        choice = next(
                            (
                                item
                                for item in active.decision_assessment.choices
                                if item.id == action.choice_id
                            ),
                            None,
                        )
                        response_key = action_dependency_key(snapshot.facts, active, action.id)
                        if (
                            choice
                            and response_key
                            and {
                                item.event_id: item.amount_paise
                                for item in choice.adjustment_amounts
                            }
                            == amounts
                        ):
                            snapshot.facts.decision.responses = [
                                item
                                for item in snapshot.facts.decision.responses
                                if item.action_id != action.id
                            ] + [
                                ActionResponse(
                                    action_id=action.id,
                                    response="declined",
                                    dependency_key=response_key,
                                )
                            ]
                    snapshot.plan = calculate(
                        snapshot.facts, snapshot.anchor_date, self.config, today=today
                    )
                    if snapshot.accepted:
                        snapshot.accepted.plan = calculate(
                            snapshot.facts,
                            snapshot.anchor_date,
                            self.config,
                            adjustments=snapshot.accepted.adjustments,
                            today=today,
                        )
                snapshot.preview = None
            elif isinstance(operation, ClearAccepted):
                if snapshot.accepted is None:
                    raise Problem(409, "noAccepted", "There is no accepted scenario.", snapshot)
                snapshot.accepted = None
                snapshot.preview = None
            snapshot = snapshot.model_copy(
                update={
                    "revision": snapshot.revision
                    + (not isinstance(operation, PreviewAdjustments | DiscardPreview)),
                    "sequence": snapshot.sequence + 1,
                }
            )
            snapshot.workspace = project(snapshot, self.config)
            snapshot.latest_change = change_set(
                before, snapshot, command.command_id, operation.type, changes
            )
            snapshot.workspace.change = snapshot.latest_change
            result = snapshot.model_dump_json(by_alias=True)
            async with self.transaction():
                await self.owner_key(access)
                await db.execute(
                    "UPDATE sessions SET snapshot = ? WHERE owner = ?", (result, owner)
                )
                await db.execute(
                    "INSERT INTO commands VALUES (?, ?, ?, ?)",
                    (owner, str(command.command_id), fingerprint, result),
                )
            self.publish(owner, snapshot)
            return snapshot

    def resolve_proposal(
        self, snapshot: Snapshot, inputs: list[AdjustmentInput], today: date
    ) -> list[Adjustment]:
        retained = (
            {item.event_id: item for item in snapshot.accepted.adjustments}
            if (snapshot.accepted is not None)
            else {}
        )
        options = adjustment_options(
            snapshot.facts,
            snapshot.plan.events,
            snapshot.anchor_date,
            snapshot.end_date_exclusive,
            snapshot.anchor_date,
        )
        resolved = resolve_adjustments(inputs, options, self.config)
        if any(
            {(item.event_id, item.amount_paise, item.dependency_key) for item in resolved}
            == {
                (item.event_id, item.amount_paise, item.dependency_key)
                for item in proposal.adjustments
            }
            for proposal in snapshot.rejected_proposals
        ):
            raise ValueError(
                "This proposal was explicitly rejected; "
                "do not suggest it again without changed facts"
            )
        for item in resolved:
            prior = retained.get(item.event_id)
            unchanged = (
                prior is not None
                and item.amount_paise == prior.amount_paise
                and item.dependency_key == prior.dependency_key
            )
            if item.date < today and not unchanged:
                raise ValueError("Past occurrences cannot receive fresh adjustment consent")
            if unchanged and prior is not None:
                item.accepted_revision = prior.accepted_revision
        return resolved

    async def delete(self, owner: Owner) -> None:
        await self.check(owner)
        async with self.lock:
            try:
                await self.current(owner)
            except Problem as error:
                if error.status not in {404, 410}:
                    raise
                return
            await self.remove(await self.owner_key(owner), "deleted", owner)

    async def cleanup_locked(self) -> None:
        async with self.connection().execute(
            "SELECT owner FROM sessions WHERE expires <= ?", (self.clock().isoformat(),)
        ) as cursor:
            rows = await cursor.fetchall()
        for row in rows:
            await self.remove(row[0], "expired")

    async def cleanup(self) -> None:
        async with self.lock:
            await self.cleanup_locked()

    async def subscribe(self, owner: Owner) -> asyncio.Queue[Snapshot | Error]:
        await self.check(owner)
        async with self.lock:
            snapshot = await self.current(owner)
            access = owner
            owner = await self.owner_key(owner)
            if (
                sum(map(len, self.listeners.values())) >= self.config.max_event_streams
                or len(self.listeners.get(owner, set())) >= self.config.max_streams_per_session
            ):
                raise Problem(429, "streamLimit", "Too many event streams.")
            queue: asyncio.Queue[Snapshot | Error] = asyncio.Queue(maxsize=1)
            self.listeners.setdefault(owner, set()).add(queue)
            if isinstance(access, Access):
                self.listener_access[queue] = access
            queue.put_nowait(snapshot)
            return queue

    def unsubscribe(self, owner: Owner, queue: asyncio.Queue[Snapshot | Error]) -> None:
        owner = owner.user_id if isinstance(owner, Access) else owner
        self.listener_access.pop(queue, None)
        listeners = self.listeners.get(owner)
        if listeners is not None:
            listeners.discard(queue)
            if not listeners:
                del self.listeners[owner]

    async def ready(self) -> None:
        async with self.lock:
            async with self.connection().execute("SELECT 1") as cursor:
                await cursor.fetchone()
