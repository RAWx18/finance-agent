# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import hashlib
import json
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from .auth_models import Owner
from .models import Coverage, Facts, Model, Money, Snapshot
from .store import Problem, Store
from .workspace import project


class ConversationSummary(Model):
    """Saved conversation metadata and message count."""

    slug: str
    title: str
    started_at: datetime
    ended_at: datetime | None
    expires_at: datetime
    message_count: int


class ConversationMessage(Model):
    """A timestamped conversation message with interruption status."""

    id: str
    role: Literal["user", "assistant"]
    text: str
    created_at: datetime
    interrupted: bool


class SavedConversation(ConversationSummary):
    """A saved conversation with its ordered transcript messages."""

    messages: list[ConversationMessage]


class ConversationList(Model):
    """A collection of saved conversation summaries."""

    conversations: list[ConversationSummary]


class History:
    """Persistent conversations, transcripts, and restorable financial snapshots."""

    def __init__(self, store: Store):
        """Bind conversation history to the shared session store."""
        self.store = store

    def selection(self, snapshot: Snapshot, current: Snapshot, slug: str) -> Snapshot:
        """Prepare a conversation snapshot for selection with fresh session identity."""
        revision = snapshot.revision
        snapshot.session_id = uuid4()
        snapshot.conversation_slug = slug
        snapshot.revision = max(revision, current.revision) + 1
        snapshot.sequence = max(snapshot.sequence, current.sequence) + 1
        # Rebase only a current preview; selection must not revive a stale proposal.
        if snapshot.preview is not None and snapshot.preview.source_revision == revision:
            snapshot.preview.source_revision = snapshot.revision
        snapshot.latest_change = None
        snapshot.workspace = project(snapshot, self.store.config)
        return snapshot

    async def memory(self, key: str, slug: str, current: Snapshot) -> tuple[str, Snapshot]:
        """Load a conversation's attributable financial snapshot or reject unsafe recovery."""
        # Only a captured snapshot or a provably untouched original session can be restored.
        store = self.store
        db = store.connection()
        async with db.execute(
            "SELECT c.call_id, c.session_id, c.started, c.expires, m.snapshot "
            "FROM conversations c LEFT JOIN conversation_memory m "
            "ON m.call_id = c.call_id AND m.owner = c.owner "
            "WHERE c.owner = ? AND c.slug = ? AND c.expires > ?",
            (key, slug, store.clock().astimezone(UTC).isoformat()),
        ) as cursor:
            row = await cursor.fetchone()
        if row is None:
            raise Problem(404, "notFound", "Conversation is unavailable.")
        if row[4] is not None:
            snapshot, _ = store.load_snapshot(
                row[4], today=store.clock().astimezone(ZoneInfo(store.config.timezone)).date()
            )
            if snapshot.conversation_slug != slug or str(snapshot.session_id) != row[1]:
                raise Problem(409, "conversationChanged", "Conversation memory is unavailable.")
            if snapshot.expires_at <= store.clock():
                raise Problem(410, "expired", "Conversation expired.")
            return str(row[0]), snapshot
        async with db.execute("SELECT 1 FROM commands WHERE owner = ? LIMIT 1", (key,)) as cursor:
            receipt = await cursor.fetchone()
        if (
            receipt is not None
            or current.conversation_slug is not None
            or str(current.session_id) != row[1]
            or current.revision != 0
            or current.created_at > datetime.fromisoformat(row[2])
            or current.as_of != current.created_at
            or current.expires_at != datetime.fromisoformat(row[3])
            or current.facts
            != Facts(
                opening=Money(amount_paise=None, status="unknown"),
                reserve_paise=0,
                coverage=Coverage(),
                records=[],
            )
            or current.preview is not None
            or current.accepted is not None
        ):
            raise Problem(
                409,
                "conversationMemoryUnavailable",
                "This saved chat has no attributable financial snapshot. "
                "Its transcript is available, but it cannot safely be continued.",
            )
        snapshot = current.model_copy(deep=True)
        snapshot.conversation_slug = slug
        await db.execute(
            "INSERT INTO conversation_memory VALUES (?, ?, NULL, ?)",
            (row[0], key, snapshot.model_dump_json(by_alias=True)),
        )
        return str(row[0]), snapshot

    async def select(self, owner: Owner, slug: str) -> Snapshot:
        """Restore a saved conversation as the owner's current financial session."""
        store = self.store
        await store.check(owner)
        async with store.lock:
            current = await store.current(owner)
            async with store.transaction():
                key = await store.owner_key(owner)
                logical_id, snapshot = await self.memory(key, slug, current)
                if current.conversation_slug == slug:
                    return current
                snapshot = self.selection(snapshot, current, slug)
                await store.connection().execute(
                    "UPDATE conversations SET session_id = ? WHERE call_id = ? AND owner = ?",
                    (str(snapshot.session_id), logical_id, key),
                )
                await store.save_snapshot(key, snapshot)
            store.publish(key, snapshot)
            return snapshot

    async def start(
        self, owner: Owner, call_id: UUID, session_id: UUID, slug: str | None = None
    ) -> str:
        """Start or resume saved conversation history for an active voice call."""
        store = self.store
        await store.check(owner)
        async with store.lock, store.transaction():
            key = await store.owner_key(owner)
            db = store.connection()
            async with db.execute(
                "SELECT snapshot FROM sessions WHERE owner = ?", (key,)
            ) as cursor:
                row = await cursor.fetchone()
            if row is None:
                raise Problem(404, "notFound", "No current session.")
            snapshot, _ = store.load_snapshot(row[0])
            if snapshot.session_id != session_id:
                raise Problem(409, "sessionChanged", "The financial session has changed.")
            now = store.clock().astimezone(UTC)
            expires = snapshot.expires_at.astimezone(UTC)
            if expires <= now:
                raise Problem(410, "expired", "Session expired.")
            if slug is not None:
                if snapshot.conversation_slug != slug:
                    raise Problem(
                        409, "conversationChanged", "Select this conversation before starting it."
                    )
                logical_id, _ = await self.memory(key, slug, snapshot)
                await db.execute(
                    "UPDATE conversation_memory SET media_call_id = ? WHERE call_id = ?",
                    (str(call_id), logical_id),
                )
                await db.execute(
                    "UPDATE conversations SET ended = NULL WHERE call_id = ?", (logical_id,)
                )
                await store.save_snapshot(key, snapshot)
                return slug
            async with db.execute(
                "SELECT COUNT(*) FROM conversations WHERE owner = ?", (key,)
            ) as cursor:
                count = await cursor.fetchone()
            assert count is not None
            if count[0] >= store.config.history.max_conversations:
                raise Problem(429, "historyLimit", "Conversation storage capacity reached.")
            local = now.astimezone(ZoneInfo(store.config.timezone))
            base = local.strftime("conversation-%Y-%m-%d-%H%M%S")
            slug = base
            suffix = 1
            while True:
                async with db.execute(
                    "SELECT 1 FROM conversations WHERE slug = ?", (slug,)
                ) as cursor:
                    if await cursor.fetchone() is None:
                        break
                suffix += 1
                slug = f"{base}-{suffix}"
            dates = " ".join(
                [
                    now.isoformat(),
                    local.isoformat(),
                    local.strftime("%A %d %B %Y %H:%M %Z %z"),
                    f"{local:%b} {local.day}, {local.year}",
                    f"{local.day} {local:%b} {local.year}",
                ]
            )
            await db.execute(
                "INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
                (
                    str(call_id),
                    key,
                    str(session_id),
                    slug,
                    "Conversation",
                    now.isoformat(),
                    expires.isoformat(),
                    dates,
                ),
            )
            snapshot = self.selection(snapshot, snapshot, slug)
            await db.execute(
                "UPDATE conversations SET session_id = ? WHERE call_id = ?",
                (str(snapshot.session_id), str(call_id)),
            )
            await db.execute(
                "INSERT INTO conversation_memory VALUES (?, ?, ?, ?)",
                (str(call_id), key, str(call_id), snapshot.model_dump_json(by_alias=True)),
            )
            await store.save_snapshot(key, snapshot)
        store.publish(key, snapshot)
        return slug

    async def active(self, owner: Owner, call_id: UUID) -> str:
        """Resolve an active call's conversation under the shared lock and transaction."""
        # Called only under the shared lock and transaction, including the Access recheck.
        key = await self.store.owner_key(owner)
        async with self.store.connection().execute(
            "SELECT c.call_id FROM conversations c JOIN sessions s ON s.owner = c.owner "
            "JOIN conversation_memory m ON m.call_id = c.call_id AND m.owner = c.owner "
            "WHERE c.owner = ? AND m.media_call_id = ? AND c.ended IS NULL "
            "AND c.expires > ? AND c.session_id = json_extract(s.snapshot, '$.sessionId') "
            "AND c.slug = json_extract(s.snapshot, '$.conversationSlug')",
            (key, str(call_id), self.store.clock().astimezone(UTC).isoformat()),
        ) as cursor:
            row = await cursor.fetchone()
            if row is None:
                raise Problem(404, "notFound", "Conversation is unavailable.")
            return str(row[0])

    async def recent(self, owner: Owner, call_id: UUID) -> list[dict[str, str]]:
        """Return recent conversation turns with context for interrupted assistant speech."""
        store = self.store
        await store.check(owner)
        async with store.lock, store.transaction():
            logical_id = await self.active(owner, call_id)
            async with store.connection().execute(
                "SELECT role, text, interrupted FROM conversation_messages "
                "WHERE call_id = ? ORDER BY sequence",
                (logical_id,),
            ) as cursor:
                rows = list(await cursor.fetchall())
            turns = [index for index, row in enumerate(rows) if row[0] == "user"]
            start = (
                turns[-store.config.voice.history_turns]
                if (len(turns) > store.config.voice.history_turns)
                else 0
            )
            messages: list[dict[str, str]] = []
            for role, text, interrupted in rows[start:]:
                messages.append({"role": role, "content": text})
                if role == "assistant" and interrupted:
                    messages.append(
                        {
                            "role": "developer",
                            "content": (
                                "The preceding assistant message is only the portion heard "
                                "before interruption. Do not assume its explanation or question "
                                "was completed."
                            ),
                        }
                    )
            return messages

    async def append(
        self,
        owner: Owner,
        call_id: UUID,
        segment: str,
        role: Literal["user", "assistant"],
        text: str,
        *,
        completed: bool,
        created_at: datetime | None = None,
    ) -> None:
        """Save caption progress while preserving finalized or interrupted speech."""
        if not text.strip():
            return
        store = self.store
        if len(text) > store.config.history.max_caption_chars:
            raise Problem(429, "historyLimit", "Caption storage capacity reached.")
        await store.check(owner)
        async with store.lock, store.transaction():
            logical_id = await self.active(owner, call_id)
            segment = f"{call_id}:{segment}"
            db = store.connection()
            async with db.execute(
                "SELECT text, finalized FROM conversation_messages WHERE call_id = ? "
                "AND segment = ?",
                (logical_id, segment),
            ) as cursor:
                prior = await cursor.fetchone()
            if prior is not None:
                if role == "assistant" and (prior[1] or not text.startswith(prior[0])):
                    return
                await db.execute(
                    "UPDATE conversation_messages SET text = ?, interrupted = ?, finalized = ? "
                    "WHERE call_id = ? AND segment = ?",
                    (text, not completed, completed, logical_id, segment),
                )
                if role == "user":
                    await db.execute(
                        "UPDATE conversations SET title = ? WHERE call_id = ? AND ? = "
                        "(SELECT segment FROM conversation_messages WHERE call_id = ? "
                        "AND role = 'user' ORDER BY sequence LIMIT 1)",
                        (" ".join(text.split())[:80], logical_id, segment, logical_id),
                    )
                return
            async with db.execute(
                "SELECT COUNT(*) FROM conversation_messages WHERE call_id = ?", (logical_id,)
            ) as cursor:
                count = await cursor.fetchone()
            assert count is not None
            if count[0] >= store.config.history.max_messages:
                raise Problem(429, "historyLimit", "Conversation storage capacity reached.")
            if role == "user":
                await db.execute(
                    "UPDATE conversations SET title = ? WHERE call_id = ? AND NOT EXISTS "
                    "(SELECT 1 FROM conversation_messages WHERE call_id = ? AND role = 'user')",
                    (" ".join(text.split())[:80], logical_id, logical_id),
                )
            # An unfinished prefix stays marked even if logout or process death prevents closure.
            await db.execute(
                "INSERT INTO conversation_messages "
                "(call_id, segment, role, text, created, interrupted, finalized) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    logical_id,
                    segment,
                    role,
                    text,
                    (created_at or store.clock()).astimezone(UTC).isoformat(),
                    not completed,
                    completed,
                ),
            )

    async def finish(self, owner: Owner, call_id: UUID, *, end: bool = True) -> None:
        """Finalize stored captions and optionally mark the conversation as ended."""
        store = self.store
        await store.check(owner)
        async with store.lock, store.transaction():
            logical_id = await self.active(owner, call_id)
            await store.connection().execute(
                "UPDATE conversation_messages SET finalized = 1 WHERE call_id = ?",
                (logical_id,),
            )
            if end:
                await store.connection().execute(
                    "UPDATE conversations SET ended = ? WHERE call_id = ?",
                    (store.clock().astimezone(UTC).isoformat(), logical_id),
                )

    async def list(self, owner: Owner, search: str = "") -> ConversationList:
        """List unexpired conversations matching optional title, date, or transcript text."""
        store = self.store
        if len(search) > store.config.history.max_search_chars:
            raise Problem(422, "invalidSearch", "Search is too long.")
        await store.check(owner)
        async with store.lock:
            key = await store.owner_key(owner)
            async with store.connection().execute(
                "SELECT c.slug, c.title, c.started, c.ended, c.expires, "
                "(SELECT COUNT(*) FROM conversation_messages m WHERE m.call_id = c.call_id) "
                "FROM conversations c WHERE c.owner = ? AND c.expires > ? AND "
                "(? = '' OR instr(casefold(c.title), ?) > 0 "
                "OR instr(casefold(c.search_date), ?) > 0 OR EXISTS "
                "(SELECT 1 FROM conversation_messages m WHERE m.call_id = c.call_id "
                "AND instr(casefold(m.text), ?) > 0)) ORDER BY c.started DESC, c.rowid DESC",
                (
                    key,
                    store.clock().astimezone(UTC).isoformat(),
                    *((search.strip().casefold(),) * 4),
                ),
            ) as cursor:
                rows = await cursor.fetchall()
            return ConversationList(
                conversations=[
                    ConversationSummary(
                        slug=row[0],
                        title=row[1],
                        started_at=row[2],
                        ended_at=row[3],
                        expires_at=row[4],
                        message_count=row[5],
                    )
                    for row in rows
                ]
            )

    async def get(self, owner: Owner, slug: str) -> SavedConversation:
        """Retrieve an owner's unexpired conversation and its ordered messages."""
        store = self.store
        await store.check(owner)
        async with store.lock:
            key = await store.owner_key(owner)
            async with store.connection().execute(
                "SELECT call_id, title, started, ended, expires FROM conversations "
                "WHERE owner = ? AND slug = ? AND expires > ?",
                (key, slug, store.clock().astimezone(UTC).isoformat()),
            ) as cursor:
                row = await cursor.fetchone()
            if row is None:
                raise Problem(404, "notFound", "Conversation is unavailable.")
            async with store.connection().execute(
                "SELECT sequence, role, text, created, interrupted FROM conversation_messages "
                "WHERE call_id = ? ORDER BY sequence",
                (row[0],),
            ) as cursor:
                messages = [
                    ConversationMessage(
                        id=str(item[0]),
                        role=item[1],
                        text=item[2],
                        created_at=item[3],
                        interrupted=bool(item[4]),
                    )
                    for item in await cursor.fetchall()
                ]
            return SavedConversation(
                slug=slug,
                title=row[1],
                started_at=row[2],
                ended_at=row[3],
                expires_at=row[4],
                message_count=len(messages),
                messages=messages,
            )


def transcript(conversation: SavedConversation) -> str:
    """Render a plain-text transcript with speakers, timestamps, and interruptions."""
    return "\n\n".join(
        f"[{message.created_at.isoformat()}] {'You' if message.role == 'user' else 'Isha'}\n"
        + message.text
        + ("\n[Interrupted]" if message.interrupted else "")
        for message in conversation.messages
    ) + ("\n" if conversation.messages else "")


class CaptionHistory:
    """Voice caption capture for one call, preserving only speech heard by the user."""

    def __init__(self, history: History, owner: Owner, call_id: UUID):
        """Bind caption capture to a call and initialize speech-segment tracking."""
        self.history = history
        self.owner = owner
        self.call_id = call_id
        self.lock = asyncio.Lock()
        self.pending: set[int] = set()
        self.frozen: set[int] = set()

    async def capture(self, event: dict[str, Any]) -> None:
        """Persist final user transcripts and heard assistant speech from voice events."""
        async with self.lock:
            kind = event.get("type")
            data = event.get("data", {})
            if kind in {"user-started-speaking", "bot-interrupted", "bot-stopped-speaking"}:
                self.frozen.update(self.pending)
                self.pending.clear()
                await self.history.finish(self.owner, self.call_id, end=False)
            elif kind == "user-transcription" and data.get("final") is True:
                text = data["text"]
                identity = json.dumps([data["user_id"], data["timestamp"]])
                try:
                    created_at: datetime | None = datetime.fromisoformat(data["timestamp"])
                    if created_at is not None and created_at.utcoffset() is None:
                        created_at = None
                except ValueError:
                    created_at = None
                await self.history.append(
                    self.owner,
                    self.call_id,
                    "user-" + hashlib.sha256(identity.encode()).hexdigest(),
                    "user",
                    text,
                    completed=True,
                    created_at=created_at,
                )
            elif kind == "bot-output" and data.get("will_be_spoken") is True:
                segment = data.get("segment_id")
                if not isinstance(segment, int) or segment in self.frozen:
                    return
                status = data.get("spoken_status")
                if status == "new":
                    self.pending.add(segment)
                    return
                if status not in {"in-progress", "completed"}:
                    return
                progress = data.get("spoken_progress") or {}
                text = progress.get("accumulated_text", "")
                await self.history.append(
                    self.owner,
                    self.call_id,
                    f"assistant-{segment}",
                    "assistant",
                    text,
                    completed=status == "completed",
                )
                if status == "completed":
                    self.pending.discard(segment)
                    self.frozen.add(segment)
                else:
                    self.pending.add(segment)
