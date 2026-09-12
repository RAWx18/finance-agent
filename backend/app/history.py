# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import hashlib
import json
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from .auth_models import Owner
from .models import Model
from .store import Problem, Store


class ConversationSummary(Model):
    slug: str
    title: str
    started_at: datetime
    ended_at: datetime | None
    expires_at: datetime
    message_count: int


class ConversationMessage(Model):
    id: str
    role: Literal["user", "assistant"]
    text: str
    created_at: datetime
    interrupted: bool


class SavedConversation(ConversationSummary):
    messages: list[ConversationMessage]


class ConversationList(Model):
    conversations: list[ConversationSummary]


class History:
    def __init__(self, store: Store):
        self.store = store

    async def start(self, owner: Owner, call_id: UUID, session_id: UUID) -> None:
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
            snapshot = json.loads(row[0])
            if snapshot["sessionId"] != str(session_id):
                raise Problem(409, "sessionChanged", "The financial session has changed.")
            now = store.clock().astimezone(UTC)
            expires = datetime.fromisoformat(snapshot["expiresAt"]).astimezone(UTC)
            if expires <= now:
                raise Problem(410, "expired", "Session expired.")
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

    async def active(self, owner: Owner, call_id: UUID) -> None:
        # Called only under the shared lock and transaction, including the Access recheck.
        key = await self.store.owner_key(owner)
        async with self.store.connection().execute(
            "SELECT 1 FROM conversations c JOIN sessions s ON s.owner = c.owner "
            "WHERE c.owner = ? AND c.call_id = ? AND c.ended IS NULL "
            "AND c.expires > ? AND c.session_id = json_extract(s.snapshot, '$.sessionId')",
            (key, str(call_id), self.store.clock().astimezone(UTC).isoformat()),
        ) as cursor:
            if await cursor.fetchone() is None:
                raise Problem(404, "notFound", "Conversation is unavailable.")

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
        if not text.strip():
            return
        store = self.store
        if len(text) > store.config.history.max_caption_chars:
            raise Problem(429, "historyLimit", "Caption storage capacity reached.")
        await store.check(owner)
        async with store.lock, store.transaction():
            await self.active(owner, call_id)
            db = store.connection()
            async with db.execute(
                "SELECT text, finalized FROM conversation_messages WHERE call_id = ? "
                "AND segment = ?",
                (str(call_id), segment),
            ) as cursor:
                prior = await cursor.fetchone()
            if prior is not None:
                if role == "assistant" and (prior[1] or not text.startswith(prior[0])):
                    return
                await db.execute(
                    "UPDATE conversation_messages SET text = ?, interrupted = ?, finalized = ? "
                    "WHERE call_id = ? AND segment = ?",
                    (text, not completed, completed, str(call_id), segment),
                )
                if role == "user":
                    await db.execute(
                        "UPDATE conversations SET title = ? WHERE call_id = ? AND ? = "
                        "(SELECT segment FROM conversation_messages WHERE call_id = ? "
                        "AND role = 'user' ORDER BY sequence LIMIT 1)",
                        (" ".join(text.split())[:80], str(call_id), segment, str(call_id)),
                    )
                return
            async with db.execute(
                "SELECT COUNT(*) FROM conversation_messages WHERE call_id = ?", (str(call_id),)
            ) as cursor:
                count = await cursor.fetchone()
            assert count is not None
            if count[0] >= store.config.history.max_messages:
                raise Problem(429, "historyLimit", "Conversation storage capacity reached.")
            if role == "user":
                await db.execute(
                    "UPDATE conversations SET title = ? WHERE call_id = ? AND NOT EXISTS "
                    "(SELECT 1 FROM conversation_messages WHERE call_id = ? AND role = 'user')",
                    (" ".join(text.split())[:80], str(call_id), str(call_id)),
                )
            # An unfinished prefix stays marked even if logout or process death prevents closure.
            await db.execute(
                "INSERT INTO conversation_messages "
                "(call_id, segment, role, text, created, interrupted, finalized) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    str(call_id),
                    segment,
                    role,
                    text,
                    (created_at or store.clock()).astimezone(UTC).isoformat(),
                    not completed,
                    completed,
                ),
            )

    async def finish(self, owner: Owner, call_id: UUID, *, end: bool = True) -> None:
        store = self.store
        await store.check(owner)
        async with store.lock, store.transaction():
            await self.active(owner, call_id)
            await store.connection().execute(
                "UPDATE conversation_messages SET finalized = 1 WHERE call_id = ?",
                (str(call_id),),
            )
            if end:
                await store.connection().execute(
                    "UPDATE conversations SET ended = ? WHERE call_id = ?",
                    (store.clock().astimezone(UTC).isoformat(), str(call_id)),
                )

    async def list(self, owner: Owner, search: str = "") -> ConversationList:
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
    return "\n\n".join(
        f"[{message.created_at.isoformat()}] {'You' if message.role == 'user' else 'Isha'}\n"
        + message.text
        + ("\n[Interrupted]" if message.interrupted else "")
        for message in conversation.messages
    ) + ("\n" if conversation.messages else "")


class CaptionHistory:
    def __init__(self, history: History, owner: Owner, call_id: UUID):
        self.history = history
        self.owner = owner
        self.call_id = call_id
        self.lock = asyncio.Lock()
        self.pending: set[int] = set()
        self.frozen: set[int] = set()

    async def capture(self, event: dict[str, Any]) -> None:
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
