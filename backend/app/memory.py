# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import re
import unicodedata
from datetime import UTC, timedelta
from typing import Any, Literal
from uuid import UUID

from pydantic import Field, field_validator

from .auth_models import Access
from .history import History
from .models import Model
from .store import Problem, Store


class MemoryChange(Model):
    """Evidence-backed creation, replacement, or deletion of a scoped conversation note."""

    scope: Literal["common", "user", "chat"] = Field(
        description="common: stable preferences about how to communicate, such as reply style "
        "or form of address, not current activities. user: explicitly requested cross-chat "
        "nonfinancial context, such as an ongoing learning goal. chat: this discussion only, "
        "or when lasting relevance was not stated.",
    )
    key: str = Field(
        pattern=r"^[a-z][A-Za-z0-9]{0,39}$",
        description="Stable lowerCamelCase label, e.g. replyStyle. No spaces, underscores or "
        "hyphens. Reuse the exact existing key when replacing or forgetting a note.",
    )
    text: str | None = Field(max_length=500)
    evidence: str = Field(min_length=1, max_length=1000)

    @field_validator("text")
    @classmethod
    def validate_text(cls, value: str | None) -> str | None:
        """Validate and trim note text while allowing explicit deletion."""
        if value is None:
            return None
        if not value.strip() or any(unicodedata.category(char).startswith("C") for char in value):
            raise ValueError("A memory must be a short, nonempty note without control characters")
        return value.strip()


class Memory:
    """Account- and conversation-scoped access to retained nonfinancial notes."""

    def __init__(self, store: Store, owner: Access, call_id: UUID):
        """Bind memory access to the store, authenticated owner, and active call."""
        self.store = store
        self.owner = owner
        self.call_id = call_id

    async def read(self) -> dict[str, Any]:
        """Retrieve the current profile and unexpired notes for the active conversation."""
        store = self.store
        await store.check(self.owner)
        async with store.lock, store.transaction():
            logical_id = await History(store).active(self.owner, self.call_id)
            db = store.connection()
            async with db.execute(
                "SELECT display_name FROM auth_users WHERE id = ?", (self.owner.user_id,)
            ) as cursor:
                profile = await cursor.fetchone()
            assert profile is not None
            shared: dict[str, list[dict[str, str]]] = {}
            for scope in ("common", "user"):
                async with db.execute(
                    "SELECT key, text FROM user_memories WHERE owner = ? AND scope = ? "
                    "AND (expires IS NULL OR expires > ?) ORDER BY updated DESC, key LIMIT ?",
                    (
                        self.owner.user_id,
                        scope,
                        store.clock().astimezone(UTC).isoformat(),
                        store.config.memory.max_notes,
                    ),
                ) as cursor:
                    shared[scope] = [
                        {"key": row[0], "text": row[1]} for row in await cursor.fetchall()
                    ]
            async with db.execute(
                "SELECT key, text FROM chat_memories WHERE call_id = ? "
                "ORDER BY updated DESC, key LIMIT ?",
                (logical_id, store.config.memory.max_notes),
            ) as cursor:
                chat = [{"key": row[0], "text": row[1]} for row in await cursor.fetchall()]
            return {
                "common": {"profile": {"name": profile[0]}, "notes": shared["common"]},
                "user": {"notes": shared["user"]},
                "chat": {"notes": chat},
                "limits": {
                    "notesPerScope": store.config.memory.max_notes,
                    "noteCharacters": store.config.memory.max_note_chars,
                },
            }

    async def update(self, change: MemoryChange, user_turn: str) -> dict[str, Any]:
        """Apply an evidence-backed note change within privacy and retention limits."""
        store = self.store
        evidence = " ".join(change.evidence.casefold().split())
        if not evidence or evidence not in " ".join(user_turn.casefold().split()):
            raise Problem(
                422, "invalidMemory", "Memory needs evidence from the current completed user turn."
            )
        if change.text is not None and (
            len(change.text) > store.config.memory.max_note_chars
            or any(char.isdigit() or unicodedata.category(char) == "Sc" for char in change.text)
            or re.search(
                r"@|https?://|\b(?:password|passcode|otp|pin|token|api key|"
                r"account number|card number|aadhaar|pan number)\b",
                change.text,
                re.IGNORECASE,
            )
        ):
            raise Problem(
                422,
                "invalidMemory",
                "Keep only a short nonfinancial note, without numbers, contacts or credentials.",
            )
        await store.check(self.owner)
        async with store.lock, store.transaction():
            logical_id = await History(store).active(self.owner, self.call_id)
            db = store.connection()
            now = store.clock().astimezone(UTC)
            await db.execute(
                "DELETE FROM user_memories WHERE owner = ? AND expires <= ?",
                (self.owner.user_id, now.isoformat()),
            )
            if change.scope == "chat":
                async with db.execute(
                    "SELECT key, text FROM chat_memories WHERE call_id = ?", (logical_id,)
                ) as cursor:
                    notes: dict[str, str] = {row[0]: row[1] for row in await cursor.fetchall()}
            else:
                async with db.execute(
                    "SELECT key, text FROM user_memories WHERE owner = ? AND scope = ?",
                    (self.owner.user_id, change.scope),
                ) as cursor:
                    notes = {row[0]: row[1] for row in await cursor.fetchall()}
            if (
                change.text is not None
                and change.key not in notes
                and len(notes) >= store.config.memory.max_notes
            ):
                raise Problem(
                    409, "memoryLimit", "This memory scope is full; replace or forget a note."
                )
            changed = notes.get(change.key) != change.text
            if changed and change.scope == "chat":
                if change.text is None:
                    await db.execute(
                        "DELETE FROM chat_memories WHERE call_id = ? AND key = ?",
                        (logical_id, change.key),
                    )
                else:
                    await db.execute(
                        "INSERT INTO chat_memories VALUES (?, ?, ?, ?) "
                        "ON CONFLICT(call_id, key) DO UPDATE SET "
                        "text = excluded.text, updated = excluded.updated",
                        (logical_id, change.key, change.text, now.isoformat()),
                    )
            elif changed:
                if change.text is None:
                    await db.execute(
                        "DELETE FROM user_memories WHERE owner = ? AND scope = ? AND key = ?",
                        (self.owner.user_id, change.scope, change.key),
                    )
                else:
                    await db.execute(
                        "INSERT INTO user_memories VALUES (?, ?, ?, ?, ?, ?) "
                        "ON CONFLICT(owner, scope, key) DO UPDATE SET text = excluded.text, "
                        "updated = excluded.updated, expires = excluded.expires",
                        (
                            self.owner.user_id,
                            change.scope,
                            change.key,
                            change.text,
                            now.isoformat(),
                            (now + timedelta(days=store.config.memory.user_days)).isoformat()
                            if change.scope == "user"
                            else None,
                        ),
                    )
        return {"saved": True, "changed": changed, "scope": change.scope, "key": change.key}
