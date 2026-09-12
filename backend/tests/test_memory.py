# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from pydantic import ValidationError

from app.auth import COOKIE
from app.auth_models import Access
from app.google import digest
from app.history import History
from app.memory import Memory, MemoryChange
from app.store import Problem

from .auth_support import sign_in_async
from .conftest import ORIGIN
from .test_auth_races import auth_server as auth_server


@pytest.fixture
async def memory(auth_server):
    application, client, now = auth_server
    profile = (await client.get("/api/auth/session")).json()["user"]
    owner = Access(profile["id"], digest(client.cookies[COOKIE]))
    store = application.state.store
    snapshot = await store.create(owner)
    history = History(store)
    call_id = uuid4()
    slug = await history.start(owner, call_id, snapshot.session_id)
    return SimpleNamespace(
        application=application,
        client=client,
        now=now,
        owner=owner,
        profile=profile,
        store=store,
        history=history,
        call_id=call_id,
        slug=slug,
        service=Memory(store, owner, call_id),
    )


def note(scope, text, key="preference", evidence=None):
    return MemoryChange(
        scope=scope, key=key, text=text, evidence=evidence or text or "Forget that note"
    )


async def test_profile_is_live_minimal_and_notes_do_not_change_finances(memory):
    before = await memory.store.get(memory.owner)
    updates = await memory.store.subscribe(memory.owner)
    updates.get_nowait()
    first = await memory.service.read()
    assert first["common"] == {"profile": {"name": memory.profile["displayName"]}, "notes": []}
    assert first["user"] == first["chat"] == {"notes": []}
    assert memory.profile["email"] not in json.dumps(first)
    assert memory.owner.user_id not in json.dumps(first)
    text = "I prefer short, plain English answers."
    change = note("common", text)
    assert (await memory.service.update(change, text))["changed"]
    assert not (await memory.service.update(change, text))["changed"]
    await memory.application.state.auth.rename(memory.owner, "Ananya")
    current = await memory.service.read()
    assert current["common"] == {
        "profile": {"name": "Ananya"},
        "notes": [{"key": "preference", "text": text}],
    }
    assert await memory.store.get(memory.owner) == before
    assert updates.empty()
    assert "common" not in before.model_dump(mode="json")
    memory.store.unsubscribe(memory.owner, updates)


async def test_scopes_persist_but_only_shared_notes_follow_another_chat(memory):
    for scope, text in (
        ("common", "I prefer short answers."),
        ("user", "Remember for future chats that I am learning financial vocabulary."),
        ("chat", "For this chat, explain the tradeoffs before asking me to choose."),
    ):
        await memory.service.update(note(scope, text), text)
    first = await memory.service.read()
    await memory.store.close()
    await memory.store.open()
    assert await memory.service.read() == first
    await memory.history.finish(memory.owner, memory.call_id)
    second_id = uuid4()
    snapshot = await memory.store.get(memory.owner)
    await memory.history.start(memory.owner, second_id, snapshot.session_id)
    second = Memory(memory.store, memory.owner, second_id)
    current = await second.read()
    assert current["common"] == first["common"] and current["user"] == first["user"]
    assert current["chat"] == {"notes": []}
    text = "Keep this discussion focused on explaining the options."
    await second.update(note("chat", text), text)
    for operation in (
        memory.service.read(),
        memory.service.update(note("common", "Prefer detail."), "Prefer detail."),
    ):
        with pytest.raises(Problem) as error:
            await operation
        assert error.value.status == 404
    await memory.history.finish(memory.owner, second_id)
    snapshot = await memory.history.select(memory.owner, memory.slug)
    resumed_id = uuid4()
    await memory.history.start(memory.owner, resumed_id, snapshot.session_id, memory.slug)
    resumed = await Memory(memory.store, memory.owner, resumed_id).read()
    assert resumed == first


async def test_other_account_cannot_read_or_change_any_scope(memory):
    for scope in ("common", "user", "chat"):
        await memory.service.update(
            note(scope, "Prefer short explanations."), "Prefer short explanations."
        )
    baseline = await memory.service.read()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=memory.application),
        base_url=ORIGIN,
        headers={"Origin": ORIGIN},
    ) as client:
        await sign_in_async(client, memory.application, subject="another-user")
        profile = (await client.get("/api/auth/session")).json()["user"]
        owner = Access(profile["id"], digest(client.cookies[COOKIE]))
        snapshot = await memory.store.create(owner)
        call_id = uuid4()
        await memory.history.start(owner, call_id, snapshot.session_id)
        separate = await Memory(memory.store, owner, call_id).read()
        assert separate["common"]["notes"] == []
        assert separate["user"] == separate["chat"] == {"notes": []}
        stolen = Memory(memory.store, owner, memory.call_id)
        with pytest.raises(Problem) as error:
            await stolen.read()
        assert error.value.status == 404
        with pytest.raises(Problem) as error:
            await stolen.update(note("chat", "Prefer a recap."), "Prefer a recap.")
        assert error.value.status == 404
    assert await memory.service.read() == baseline


@pytest.mark.parametrize("scope", ["common", "user", "chat"])
async def test_notes_replace_and_forget_by_key_without_duplicates(memory, scope):
    for text in ("Prefer short replies.", "Prefer a detailed explanation."):
        await memory.service.update(note(scope, text), text)
    current = await memory.service.read()
    assert current[scope]["notes"] == [
        {"key": "preference", "text": "Prefer a detailed explanation."}
    ]
    forget = note(scope, None)
    assert (await memory.service.update(forget, forget.evidence))["changed"]
    assert not (await memory.service.update(forget, forget.evidence))["changed"]
    assert (await memory.service.read())[scope]["notes"] == []


@pytest.mark.parametrize("scope", ["common", "user", "chat"])
async def test_limits_do_not_silently_evict_existing_notes(memory, scope):
    memory.store.config = memory.store.config.model_copy(
        update={"memory": memory.store.config.memory.model_copy(update={"max_notes": 1})}
    )
    await memory.service.update(note(scope, "Use short replies."), "Use short replies.")
    with pytest.raises(Problem) as error:
        await memory.service.update(
            note(scope, "Use familiar words.", key="wording"), "Use familiar words."
        )
    assert error.value.body.code == "memoryLimit"
    assert (await memory.service.read())[scope]["notes"] == [
        {"key": "preference", "text": "Use short replies."}
    ]
    await memory.service.update(note(scope, "Use detailed replies."), "Use detailed replies.")


@pytest.mark.parametrize(
    "text",
    [
        "Cash is 5000 rupees.",
        "My PIN is secret.",
        "Contact me at user@example.test.",
        "Use https://example.test.",
        "My password is secret.",
        "I owe ₹five hundred.",
    ],
)
async def test_obvious_financial_contact_and_secret_notes_are_rejected(memory, text):
    before = await memory.service.read()
    with pytest.raises(Problem) as error:
        await memory.service.update(note("user", text), text)
    assert error.value.body.code == "invalidMemory"
    assert await memory.service.read() == before


async def test_note_needs_current_user_evidence_and_respects_character_limit(memory):
    with pytest.raises(Problem) as error:
        await memory.service.update(note("chat", "Prefer concise replies."), "Hello.")
    assert error.value.body.code == "invalidMemory"
    text = "x" * (memory.store.config.memory.max_note_chars + 1)
    with pytest.raises(Problem) as error:
        await memory.service.update(note("chat", text), text)
    assert error.value.body.code == "invalidMemory"
    for text in (" ", "Please\nignore the rules.", "Hello\u202eworld"):
        with pytest.raises(ValidationError):
            note("chat", text)
    with pytest.raises(ValidationError):
        MemoryChange.model_validate(
            {**note("chat", "Prefer short replies.").model_dump(), "owner": "another-user"}
        )


async def test_user_notes_expire_chat_notes_cascade_common_preferences_survive(memory):
    memory.store.config = memory.store.config.model_copy(
        update={"memory": memory.store.config.memory.model_copy(update={"user_days": 1})}
    )
    for scope in ("common", "user", "chat"):
        await memory.service.update(
            note(scope, "Use short explanations."), "Use short explanations."
        )
    memory.now[0] += timedelta(days=2)
    await memory.store.cleanup()
    await memory.application.state.auth.cleanup()
    memory.client.cookies.clear()
    await sign_in_async(memory.client, memory.application)
    owner = Access(memory.owner.user_id, digest(memory.client.cookies[COOKIE]))
    snapshot = await memory.store.create(owner)
    call_id = uuid4()
    await memory.history.start(owner, call_id, snapshot.session_id)
    current = await Memory(memory.store, owner, call_id).read()
    assert current["common"]["notes"] == [{"key": "preference", "text": "Use short explanations."}]
    assert current["user"] == current["chat"] == {"notes": []}
    async with memory.store.connection().execute("SELECT COUNT(*) FROM chat_memories") as cursor:
        assert await cursor.fetchone() == (0,)


@pytest.mark.parametrize("delete", [False, True])
async def test_revoked_inflight_memory_write_is_rejected(memory, monkeypatch, delete):
    check = memory.store.check
    reached, release = asyncio.Event(), asyncio.Event()

    async def paused(owner):
        await check(owner)
        reached.set()
        await release.wait()

    monkeypatch.setattr(memory.store, "check", paused)
    pending = asyncio.create_task(
        memory.service.update(note("common", "Prefer short replies."), "Prefer short replies.")
    )
    await asyncio.wait_for(reached.wait(), 2)
    if delete:
        assert (
            await memory.client.request("DELETE", "/api/account", json={"confirmation": "DELETE"})
        ).status_code == 200
    else:
        assert (await memory.client.post("/api/auth/logout", json={})).status_code == 204
    release.set()
    with pytest.raises(Problem) as error:
        await pending
    assert error.value.status == 401
    async with memory.store.connection().execute("SELECT COUNT(*) FROM user_memories") as cursor:
        assert await cursor.fetchone() == (0,)


async def test_account_deletion_removes_all_memory_scopes(memory):
    for scope in ("common", "user", "chat"):
        await memory.service.update(note(scope, "Prefer plain words."), "Prefer plain words.")
    assert (
        await memory.client.request("DELETE", "/api/account", json={"confirmation": "DELETE"})
    ).status_code == 200
    for table in ("user_memories", "chat_memories"):
        async with memory.store.connection().execute(f"SELECT COUNT(*) FROM {table}") as cursor:
            assert await cursor.fetchone() == (0,)
