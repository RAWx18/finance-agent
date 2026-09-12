# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from contextlib import asynccontextmanager
from datetime import timedelta
from uuid import uuid4

import pytest

from app.auth import COOKIE
from app.auth_models import Access
from app.google import digest
from app.history import CaptionHistory, History, transcript
from app.store import Problem

from .auth_support import sign_in_async
from .conftest import NOW
from .test_auth import rows
from .test_auth_races import auth_server as auth_server


def human(text="Please help with rent.", timestamp="2026-09-11T06:00:00Z", final=True):
    return {
        "type": "user-transcription",
        "data": {"text": text, "timestamp": timestamp, "user_id": "human", "final": final},
    }


def spoken(segment=1, text="I can help", remaining=" with rent.", status="in-progress"):
    return {
        "type": "bot-output",
        "data": {
            "text": text + remaining,
            "segment_id": segment,
            "will_be_spoken": True,
            "spoken_status": status,
            "spoken_progress": {"accumulated_text": text, "remaining_text": remaining},
        },
    }


@pytest.fixture
async def recording(store):
    snapshot = await store.create("owner")
    history = History(store)
    call_id = uuid4()
    await history.start("owner", call_id, snapshot.session_id)
    return CaptionHistory(history, "owner", call_id)


async def saved(recording):
    listing = await recording.history.list(recording.owner)
    return await recording.history.get(recording.owner, listing.conversations[0].slug)


async def test_durable_order_title_timestamps_and_exact_export(recording, store):
    await recording.capture(spoken(text="Hello.", remaining="", status="completed"))
    store.clock = lambda: NOW + timedelta(seconds=2)
    caption = human("Rent & groceries: 50%_ 'quoted' Straße?", "2026-09-11T06:00:02Z")
    await recording.capture(caption)
    await recording.capture(caption)
    await recording.capture(spoken(2))
    before = await saved(recording)
    store.clock = lambda: NOW + timedelta(seconds=5)
    await recording.capture(spoken(2, "I can help with rent.", "", "completed"))
    await recording.capture(spoken(2, "Replayed unheard alternative.", "", "completed"))
    await recording.history.finish("owner", recording.call_id)
    await store.close()
    await store.open()
    conversation = await saved(recording)
    assert conversation.slug == "conversation-2026-09-11-113000"
    assert conversation.title == "Rent & groceries: 50%_ 'quoted' Straße?"
    assert conversation.message_count == 3
    assert [message.role for message in conversation.messages] == ["assistant", "user", "assistant"]
    assert conversation.messages[-1].created_at == before.messages[-1].created_at
    assert conversation.messages[-1].id == before.messages[-1].id
    assert conversation.ended_at == NOW + timedelta(seconds=5)
    assert conversation.expires_at == (await store.get("owner")).expires_at
    assert transcript(conversation) == (
        "[2026-09-11T06:00:00+00:00] Isha\nHello.\n\n"
        "[2026-09-11T06:00:02+00:00] You\nRent & groceries: 50%_ 'quoted' Straße?\n\n"
        "[2026-09-11T06:00:02+00:00] Isha\nI can help with rent.\n"
    )
    for query in ["RENT", "50%_ 'quoted'", "STRASSE", "2026-09-11", "Sep 11, 2026", "can HELP"]:
        result = await recording.history.list("owner", query)
        assert [item.slug for item in result.conversations] == [conversation.slug]
    for query in ["%", "_", "' OR 1=1 --", "not present"]:
        result = await recording.history.list("owner", query)
        assert bool(result.conversations) == (query in {"%", "_"})


@pytest.mark.parametrize(
    "stop", ["user-started-speaking", "bot-interrupted", "bot-stopped-speaking"]
)
async def test_interrupted_prefix_frozen_and_unheard_segments_never_saved(recording, stop):
    await recording.capture(human(final=False))
    await recording.capture({"type": "bot-llm-text", "data": {"text": "private model text"}})
    await recording.capture({"type": "llm-function-call-stopped", "data": {"result": "private"}})
    await recording.capture(
        {
            "type": "bot-output",
            "data": {
                "text": "unspoken",
                "will_be_spoken": False,
                "spoken_status": "completed",
            },
        }
    )
    await recording.capture(spoken(1, "", "unheard full output", "new"))
    await recording.capture(spoken(2, "", "another unheard output", "new"))
    assert (await saved(recording)).messages == []
    await recording.capture(spoken(1, "Only this", " was emitted."))
    await recording.capture(spoken(1, "Only", " this was emitted."))
    await recording.capture({"type": stop})
    await recording.capture(spoken(1, "Only this was emitted.", "", "completed"))
    await recording.capture(spoken(2, "another unheard output", "", "completed"))
    await recording.capture(human())
    await recording.capture(spoken(3, "A complete response.", "", "completed"))
    conversation = await saved(recording)
    assert [message.text for message in conversation.messages] == [
        "Only this",
        "Please help with rent.",
        "A complete response.",
    ]
    assert [message.interrupted for message in conversation.messages] == [True, False, False]
    assert "Only this\n[Interrupted]" in transcript(conversation)


async def test_close_freezes_partial_and_rejects_late_writes(recording):
    await recording.capture(spoken())
    await recording.history.finish("owner", recording.call_id)
    with pytest.raises(Problem, match="unavailable"):
        await recording.capture(spoken(1, "I can help with rent.", "", "completed"))
    conversation = await saved(recording)
    assert conversation.messages[0].interrupted
    assert conversation.messages[0].text == "I can help"


@pytest.mark.parametrize("terminal", ["delete", "expiry"])
async def test_session_cascade_and_stale_plan_callback(recording, store, terminal):
    await recording.capture(human())
    conversation = await saved(recording)
    prior = await store.get("owner")
    if terminal == "delete":
        await store.delete("owner")
    else:
        store.clock = lambda: prior.expires_at
        assert not (await recording.history.list("owner")).conversations
        with pytest.raises(Problem):
            await recording.capture(human("Too late"))
        await store.cleanup()
    async with store.connection().execute("SELECT * FROM conversation_messages") as cursor:
        assert not await cursor.fetchall()
    await store.create("owner")
    with pytest.raises(Problem, match="unavailable"):
        await recording.capture(human("Cannot enter the replacement plan"))
    with pytest.raises(Problem):
        await recording.history.start("owner", uuid4(), prior.session_id)
    with pytest.raises(Problem):
        await recording.history.get("owner", conversation.slug)


async def test_limits_are_failures_not_silent_truncation(recording, store):
    store.config = store.config.model_copy(
        update={
            "history": store.config.history.model_copy(
                update={
                    "max_conversations": 1,
                    "max_messages": 1,
                    "max_caption_chars": 40,
                    "max_search_chars": 3,
                },
            )
        }
    )
    with pytest.raises(Problem):
        await recording.capture(human("x" * 41))
    await recording.capture(human())
    with pytest.raises(Problem):
        await recording.capture(spoken())
    with pytest.raises(Problem):
        await recording.history.start("owner", uuid4(), (await store.get("owner")).session_id)
    with pytest.raises(Problem):
        await recording.history.list("owner", "long")
    assert (await saved(recording)).message_count == 1


async def test_api_ownership_queries_download_and_signout(auth_server):
    application, client, _ = auth_server
    store = application.state.store
    assert (await client.get("/api/history")).json() == {"conversations": []}
    snapshot = await client.post("/api/session", json={})
    access = Access(
        (await client.get("/api/auth/session")).json()["user"]["id"], digest(client.cookies[COOKIE])
    )
    history = History(store)
    call_id = uuid4()
    await history.start(access, call_id, (await store.get(access)).session_id)
    captions = CaptionHistory(history, access, call_id)
    await captions.capture(human("Where is my rent?"))
    conversation = await saved(captions)
    path = "/api/history/" + conversation.slug
    assert snapshot.status_code == 200
    assert (await client.get(path)).json() == conversation.model_dump(mode="json", by_alias=True)
    download = await client.get(path + "/transcript")
    assert download.text == transcript(conversation)
    assert download.headers["content-disposition"] == (
        f'attachment; filename="{conversation.slug}.txt"'
    )
    assert download.headers["content-type"].startswith("text/plain")
    assert download.headers["cache-control"] == "no-store"
    assert (await client.get("/api/history", params={"search": "RENT?"})).json()["conversations"]
    for endpoint in [
        "/api/session?search=x",
        path + "?search=x",
        path + "/transcript?search=x",
        "/api/history?unknown=x",
        "/api/history?search=x&search=y",
    ]:
        assert (await client.get(endpoint)).status_code == 400
    assert (await client.get("/api/history", params={"search": "x" * 201})).status_code == 422
    assert (await client.post("/api/history", json={})).status_code == 405
    await client.post("/api/auth/logout", json={})
    for endpoint in ["/api/history", path, path + "/transcript"]:
        assert (await client.get(endpoint)).status_code == 401
    with pytest.raises(Problem):
        await history.get(access, conversation.slug)
    await sign_in_async(client, application, "google-user-two")
    assert (await client.get("/api/history")).json() == {"conversations": []}
    assert (await client.get(path)).status_code == 404
    assert (await client.get(path + "/transcript")).status_code == 404
    await client.post("/api/auth/logout", json={})
    await sign_in_async(client, application)
    assert (await client.get(path)).json()["messages"][0]["text"] == "Where is my rent?"


@pytest.mark.parametrize("delete", [False, True])
async def test_logout_or_account_deletion_wins_waiting_caption_transaction(
    auth_server, monkeypatch, delete
):
    application, client, _ = auth_server
    store = application.state.store
    await client.post("/api/session", json={})
    access = Access(
        (await client.get("/api/auth/session")).json()["user"]["id"], digest(client.cookies[COOKIE])
    )
    history = History(store)
    call_id = uuid4()
    await history.start(access, call_id, (await store.get(access)).session_id)
    captions = CaptionHistory(history, access, call_id)
    await captions.capture(human("Saved before revocation"))
    reached, release = asyncio.Event(), asyncio.Event()
    check = store.check

    async def paused(owner):
        await check(owner)
        reached.set()
        await release.wait()

    monkeypatch.setattr(store, "check", paused)
    write = asyncio.create_task(captions.capture(spoken()))
    await asyncio.wait_for(reached.wait(), 2)
    if delete:
        response = await client.request("DELETE", "/api/account", json={"confirmation": "DELETE"})
    else:
        response = await client.post("/api/auth/logout", json={})
    assert response.status_code in {200, 204}
    release.set()
    with pytest.raises(Problem) as error:
        await write
    assert error.value.status == 401
    assert len(await rows(application, "SELECT * FROM conversations")) == (0 if delete else 1)
    messages = await rows(application, "SELECT * FROM conversation_messages")
    assert len(messages) == (0 if delete else 1)


async def test_same_human_segment_updates_without_changing_order_time_or_slug(recording, store):
    await recording.capture(human("First wording"))
    before = await saved(recording)
    store.clock = lambda: NOW + timedelta(seconds=4)
    await recording.capture(human("Corrected wording"))
    await recording.capture(human("Second segment", "2026-09-11T06:00:03Z"))
    await recording.capture(human("Opaque timestamp", "sdk-opaque-value"))
    conversation = await saved(recording)
    assert conversation.slug == before.slug
    assert conversation.title == "Corrected wording"
    assert conversation.message_count == 3
    assert conversation.messages[0].id == before.messages[0].id
    assert conversation.messages[0].created_at == NOW
    assert conversation.messages[1].created_at == NOW + timedelta(seconds=3)
    assert conversation.messages[2].created_at == NOW + timedelta(seconds=4)


async def test_cancelled_caption_transaction_rolls_back_and_can_be_replayed(recording, monkeypatch):
    store = recording.history.store
    transaction = store.transaction
    reached = asyncio.Event()

    @asynccontextmanager
    async def paused():
        async with transaction():
            yield
            reached.set()
            await asyncio.Event().wait()

    monkeypatch.setattr(store, "transaction", paused)
    write = asyncio.create_task(recording.capture(human()))
    await asyncio.wait_for(reached.wait(), 2)
    write.cancel()
    with pytest.raises(asyncio.CancelledError):
        await write
    assert (await saved(recording)).messages == []
    monkeypatch.setattr(store, "transaction", transaction)
    await recording.capture(human())
    assert (await saved(recording)).message_count == 1


@pytest.mark.parametrize("route", ["list", "detail", "transcript"])
async def test_waiting_history_read_cannot_outlive_logout(auth_server, monkeypatch, route):
    application, client, _ = auth_server
    store = application.state.store
    await client.post("/api/session", json={})
    access = Access(
        (await client.get("/api/auth/session")).json()["user"]["id"], digest(client.cookies[COOKIE])
    )
    history = History(store)
    call_id = uuid4()
    await history.start(access, call_id, (await store.get(access)).session_id)
    captions = CaptionHistory(history, access, call_id)
    await captions.capture(human())
    slug = (await saved(captions)).slug
    path = "/api/history" + ("" if route == "list" else "/" + slug)
    if route == "transcript":
        path += "/transcript"
    reached, release = asyncio.Event(), asyncio.Event()
    check = store.check

    async def paused(owner):
        await check(owner)
        reached.set()
        await release.wait()

    monkeypatch.setattr(store, "check", paused)
    read = asyncio.create_task(client.get(path))
    await asyncio.wait_for(reached.wait(), 2)
    assert (await client.post("/api/auth/logout", json={})).status_code == 204
    release.set()
    response = await read
    assert response.status_code == 401
    assert "Please help with rent." not in response.text
