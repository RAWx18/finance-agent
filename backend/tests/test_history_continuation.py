# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from contextlib import asynccontextmanager
from datetime import timedelta
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from app.auth import COOKIE
from app.auth_models import Access
from app.google import digest
from app.history import CaptionHistory, History, transcript
from app.models import CallState, Command
from app.store import Problem
from app.voice import Call

from .auth_support import sign_in_async
from .conftest import NOW, facts, parsed_command, record
from .test_auth_races import auth_server as auth_server
from .test_call_recovery import manager as manager
from .test_history import human, spoken
from .test_voice import PipelineDouble, RoomsDouble
from .test_voice import provider_doubles as provider_doubles

INTERRUPTION_NOTE = (
    "The preceding assistant message is only the portion heard before interruption. "
    "Do not assume its explanation or question was completed."
)


async def begin(store, history, owner="owner"):
    """Create an owner's session and start a conversation with a fresh call identifier."""
    snapshot = await store.create(owner)
    call_id = uuid4()
    slug = await history.start(owner, call_id, snapshot.session_id)
    return call_id, slug


async def operation(store, values):
    """Submit an operation against the owner's current financial revision."""
    snapshot = await store.get("owner")
    return await store.command(
        "owner",
        Command.model_validate(
            {"commandId": str(uuid4()), "expectedRevision": snapshot.revision, "operation": values}
        ),
    )


async def memory_rows(store):
    """Read saved conversation snapshots keyed by call identifier."""
    async with store.connection().execute(
        "SELECT call_id, snapshot FROM conversation_memory ORDER BY call_id"
    ) as cursor:
        return dict(await cursor.fetchall())


async def test_switch_restores_only_selected_memory_consent_and_pending_preview(store):
    """Verify chat selection restores isolated facts, consent, and previews with fresh revisions."""
    history = History(store)
    call_a, slug_a = await begin(store, history)
    snapshot = await operation(
        store,
        {
            "type": "replaceFacts",
            "facts": facts("1000", [record("trip", "optional", "500", "2026-09-18")]),
        },
    )
    event = (await store.options("owner")).options[0].event_id
    snapshot = await operation(
        store,
        {
            "type": "previewAdjustments",
            "adjustments": [{"eventId": event, "amount": "100"}],
        },
    )
    await operation(
        store,
        {
            "type": "acceptPreview",
            "previewId": str(snapshot.preview.id),
            "confirmed": True,
            "consentScope": "unconditional",
        },
    )
    saved_a = await operation(
        store,
        {
            "type": "previewAdjustments",
            "adjustments": [{"eventId": event, "amount": "50"}],
        },
    )
    await history.finish("owner", call_a)
    call_b, slug_b = await begin(store, history)
    command_b = parsed_command(facts("9000"), (await store.get("owner")).revision)
    saved_b = await store.command("owner", command_b)
    await history.finish("owner", call_b)
    memory = await memory_rows(store)
    queue = await store.subscribe("owner")
    queue.get_nowait()
    restored = await history.select("owner", slug_a)
    assert await queue.get() == restored
    assert restored.conversation_slug == slug_a
    assert restored.session_id not in {saved_a.session_id, saved_b.session_id}
    assert restored.revision > saved_b.revision and restored.sequence > saved_b.sequence
    assert restored.facts == saved_a.facts and restored.plan == saved_a.plan
    assert restored.accepted == saved_a.accepted
    assert restored.preview == saved_a.preview.model_copy(
        update={"source_revision": restored.revision}
    )
    assert restored.anchor_date == saved_a.anchor_date and restored.as_of == saved_a.as_of
    assert restored.expires_at == saved_a.expires_at
    assert restored.latest_change is None and restored.workspace.change is None
    assert (await memory_rows(store))[str(call_b)] == memory[str(call_b)]
    assert await history.select("owner", slug_a) == restored
    assert queue.empty()
    with pytest.raises(Problem) as error:
        await store.command("owner", command_b)
    assert error.value.body.code == "conversationChanged"
    with pytest.raises(Problem) as error:
        await store.command("owner", parsed_command(facts("777"), saved_a.revision))
    assert error.value.body.code == "staleRevision"
    assert await store.get("owner") == restored
    await operation(
        store,
        {
            "type": "acceptPreview",
            "previewId": str(restored.preview.id),
            "confirmed": True,
            "consentScope": "unconditional",
        },
    )
    assert (await store.get("owner")).accepted.adjustments[0].amount_paise == 5000
    assert (await memory_rows(store))[str(call_b)] == memory[str(call_b)]
    store.unsubscribe("owner", queue)
    await store.close()
    await store.open()
    restored_b = await history.select("owner", slug_b)
    assert restored_b.facts == saved_b.facts and restored_b.accepted == saved_b.accepted
    assert restored_b.revision > restored.revision
    with pytest.raises(Problem) as error:
        await store.command("owner", command_b)
    assert error.value.body.code == "conversationChanged"


async def test_unavailable_response_ledger_is_chat_local_without_replay(store):
    """Verify selecting a chat restores its unavailable responses without replaying commands."""
    history = History(store)
    call_a, slug_a = await begin(store, history)
    saved_a = await operation(
        store,
        {
            "type": "respondToAction",
            "actionId": "clarify:opening",
            "response": "unavailable",
        },
    )
    await history.finish("owner", call_a)
    call_b, _ = await begin(store, history)
    await operation(store, {"type": "replaceFacts", "facts": facts("456")})
    await history.finish("owner", call_b)
    async with store.connection().execute("SELECT COUNT(*) FROM commands") as cursor:
        count = await cursor.fetchone()
    restored = await history.select("owner", slug_a)
    assert restored.facts.decision.responses == saved_a.facts.decision.responses
    assert restored.facts.opening.amount_paise is None
    async with store.connection().execute("SELECT COUNT(*) FROM commands") as cursor:
        assert await cursor.fetchone() == count


async def test_reconnect_appends_segment_collisions_and_rejects_old_callbacks(store):
    """Verify reconnects isolate reused caption segments and reject callbacks from prior calls."""
    history = History(store)
    first, slug = await begin(store, history)
    captions = CaptionHistory(history, "owner", first)
    await captions.capture(human("A's actual question"))
    await captions.capture(spoken(text="Only heard", remaining=" never spoken"))
    await history.finish("owner", first)
    saved = await history.get("owner", slug)
    snapshot = await store.get("owner")
    second = uuid4()
    assert await history.start("owner", second, snapshot.session_id, slug) == slug
    assert await store.get("owner") == snapshot
    assert await history.recent("owner", second) == [
        {"role": "user", "content": "A's actual question"},
        {"role": "assistant", "content": "Only heard"},
        {"role": "developer", "content": INTERRUPTION_NOTE},
    ]
    captions = CaptionHistory(history, "owner", second)
    await captions.capture(human("Another question", timestamp="2026-09-11T06:00:00Z"))
    await captions.capture(spoken(text="Fresh answer", remaining="", status="completed"))
    for write in (
        history.finish("owner", first),
        history.append("owner", first, "assistant-1", "assistant", "stale", completed=True),
    ):
        with pytest.raises(Problem) as error:
            await write
        assert error.value.status == 404
    conversation = await history.get("owner", slug)
    assert conversation.ended_at is None
    assert conversation.messages[:2] == saved.messages
    assert [message.text for message in conversation.messages] == [
        "A's actual question",
        "Only heard",
        "Another question",
        "Fresh answer",
    ]
    assert len({message.id for message in conversation.messages}) == 4
    assert len((await history.list("owner")).conversations) == 1


async def test_recent_context_is_bounded_by_actual_user_turns(store):
    """Verify recent context retains only the configured user turns and marks interrupted speech."""
    store.config = store.config.model_copy(
        update={
            "voice": store.config.voice.model_copy(update={"history_turns": 2}),
        }
    )
    history = History(store)
    call_id, _ = await begin(store, history)
    await history.append(
        "owner", call_id, "greeting", "assistant", "An interrupted greeting", completed=False
    )
    for index in range(4):
        await history.append(
            "owner", call_id, f"u{index}", "user", f"question {index}", completed=True
        )
        await history.append(
            "owner", call_id, f"a{index}", "assistant", f"heard {index}", completed=index == 2
        )
    assert await history.recent("owner", call_id) == [
        {"role": "user", "content": "question 2"},
        {"role": "assistant", "content": "heard 2"},
        {"role": "user", "content": "question 3"},
        {"role": "assistant", "content": "heard 3"},
        {"role": "developer", "content": INTERRUPTION_NOTE},
    ]


@pytest.mark.parametrize("role", ["user", "assistant"])
@pytest.mark.parametrize("completed", [False, True])
async def test_recent_context_only_annotates_interrupted_assistant(store, role, completed):
    """Verify interruption notes annotate only assistant context without changing saved messages."""
    history = History(store)
    call_id, slug = await begin(store, history)
    text = "  Only this…\nwas heard  "
    await history.append("owner", call_id, "segment", role, text, completed=completed)
    saved = await history.get("owner", slug)
    exported = transcript(saved)
    assert saved.messages[0].text == text
    assert saved.messages[0].interrupted is not completed
    expected = [{"role": role, "content": text}]
    if role == "assistant" and not completed:
        expected.append({"role": "developer", "content": INTERRUPTION_NOTE})
    assert await history.recent("owner", call_id) == expected
    assert await history.recent("owner", call_id) == expected
    assert await history.get("owner", slug) == saved
    assert transcript(await history.get("owner", slug)) == exported
    assert INTERRUPTION_NOTE not in exported


@pytest.mark.parametrize("turns", [0, 1, 2])
async def test_recent_context_retains_interrupted_greeting_within_turn_limit(store, turns):
    """Verify an interrupted greeting remains in recent context while within the user turn limit."""
    store.config = store.config.model_copy(
        update={"voice": store.config.voice.model_copy(update={"history_turns": 2})}
    )
    history = History(store)
    call_id, _ = await begin(store, history)
    await history.append(
        "owner", call_id, "greeting", "assistant", "Before we start", completed=False
    )
    for index in range(turns):
        await history.append(
            "owner", call_id, f"u{index}", "user", f"question {index}", completed=True
        )
    assert await history.recent("owner", call_id) == [
        {"role": "assistant", "content": "Before we start"},
        {"role": "developer", "content": INTERRUPTION_NOTE},
        *[{"role": "user", "content": f"question {index}"} for index in range(turns)],
    ]


@pytest.mark.parametrize("owner", ["owner", "other"])
async def test_recent_context_interruption_is_scoped_to_selected_chat(store, owner):
    """Verify resumed context and interruption notes remain isolated to the selected chat."""
    history = History(store)
    first, slug_a = await begin(store, history)
    await history.append("owner", first, "a", "assistant", "A's heard prefix", completed=False)
    await history.finish("owner", first)
    second, slug_b = await begin(store, history, owner)
    await history.append(owner, second, "a", "assistant", "B's heard prefix", completed=False)
    await history.append(owner, second, "u", "user", "B's correction", completed=False)
    assert await history.recent(owner, second) == [
        {"role": "assistant", "content": "B's heard prefix"},
        {"role": "developer", "content": INTERRUPTION_NOTE},
        {"role": "user", "content": "B's correction"},
    ]
    await history.finish(owner, second)
    saved_a = await history.get("owner", slug_a)
    saved_b = await history.get(owner, slug_b)
    snapshot = await history.select("owner", slug_a)
    resumed = uuid4()
    await history.start("owner", resumed, snapshot.session_id, slug_a)
    assert await history.recent("owner", resumed) == [
        {"role": "assistant", "content": "A's heard prefix"},
        {"role": "developer", "content": INTERRUPTION_NOTE},
    ]
    assert (await history.get("owner", slug_a)).messages == saved_a.messages
    assert await history.get(owner, slug_b) == saved_b


async def test_same_chat_media_reconnect_supplies_context_before_start(manager, store, monkeypatch):
    """Verify reconnect supplies saved dialogue before startup without duplicating history."""
    first = await manager.start("owner", uuid4())
    assert PipelineDouble.instances[-1].resume_messages == []
    assert PipelineDouble.instances[-1].resume_slug is None
    captions = manager.call.pipeline.history
    await captions.capture(human("Remember my rent question."))
    await captions.capture(spoken(text="We were discussing", remaining=" unheard tail"))
    await manager.end("owner", first.call_id)
    snapshot = await store.get("owner")
    history = History(store)
    saved = await history.get("owner", first.conversation_slug)
    start = PipelineDouble.start

    async def observed(pipeline, *args):
        """Assert resume context and unchanged finances before starting the pipeline double."""
        assert pipeline.resume_slug == first.conversation_slug
        assert pipeline.resume_messages == [
            {"role": "user", "content": "Remember my rent question."},
            {"role": "assistant", "content": "We were discussing"},
            {"role": "developer", "content": INTERRUPTION_NOTE},
        ]
        assert await store.get("owner") == snapshot
        await start(pipeline, *args)

    monkeypatch.setattr(PipelineDouble, "start", observed)
    second = await manager.start("owner", uuid4(), first.conversation_slug)
    assert second.call_id != first.call_id and second.conversation_slug == first.conversation_slug
    assert manager.state("owner").conversation_slug == first.conversation_slug
    assert (await history.get("owner", first.conversation_slug)).messages == saved.messages
    assert len((await history.list("owner")).conversations) == 1
    await manager.end("owner", first.call_id)
    assert not manager.call.stop.is_set()
    await manager.end("owner", second.call_id)


async def test_selected_a_pipeline_receives_neither_b_dialogue_nor_b_finances(manager, store):
    """Verify resuming a selected chat supplies only its saved dialogue and financial snapshot."""
    first = await manager.start("owner", uuid4())
    await manager.call.pipeline.history.capture(human("A's rent question"))
    saved_a = await store.command(
        "owner", parsed_command(facts("111"), (await store.get("owner")).revision)
    )
    await manager.end("owner", first.call_id)
    second = await manager.start("owner", uuid4())
    await manager.call.pipeline.history.capture(human("B's unrelated question"))
    await store.command("owner", parsed_command(facts("999"), (await store.get("owner")).revision))
    await manager.end("owner", second.call_id)
    selected = await manager.select("owner", first.conversation_slug)
    third = await manager.start("owner", uuid4(), first.conversation_slug)
    pipeline = PipelineDouble.instances[-1]
    assert pipeline.resume_messages == [{"role": "user", "content": "A's rent question"}]
    assert pipeline.snapshot == selected and pipeline.snapshot.facts == saved_a.facts
    assert third.conversation_slug == first.conversation_slug != second.conversation_slug
    assert len((await History(store).list("owner")).conversations) == 2
    await manager.end("owner", third.call_id)


@pytest.mark.parametrize("owner", ["owner", "other"])
@pytest.mark.parametrize("status", ["connecting", "active", "ending", "error"])
async def test_selection_blocked_by_any_live_or_unclean_call(manager, store, owner, status):
    """Verify any live or unclean call blocks chat selection without changing the snapshot."""
    history = History(store)
    call_id, slug = await begin(store, history)
    await history.finish("owner", call_id)
    snapshot = await store.get("owner")
    manager.call = Call(
        owner,
        uuid4(),
        CallState(status=status, cleanup_confirmed=status != "error"),
        asyncio.get_running_loop().create_future(),
    )
    try:
        with pytest.raises(Problem) as error:
            await manager.select("owner", slug)
        assert error.value.body.code == "callBusy"
        assert await store.get("owner") == snapshot
    finally:
        manager.call = None


async def test_cross_chat_start_is_rejected_before_any_provider_setup(manager, store):
    """Verify starting an unselected chat fails before creating provider resources."""
    history = History(store)
    first, slug_a = await begin(store, history)
    await history.finish("owner", first)
    second, _ = await begin(store, history)
    await history.finish("owner", second)
    snapshot = await store.get("owner")
    with pytest.raises(Problem) as error:
        await manager.start("owner", uuid4(), slug_a)
    assert error.value.body.code == "conversationChanged"
    assert await store.get("owner") == snapshot
    assert not RoomsDouble.instances


async def test_delayed_start_cannot_borrow_a_different_selected_workspace(
    manager, store, monkeypatch
):
    """Verify a delayed call start fails if another chat becomes selected before setup."""
    history = History(store)
    first, slug_a = await begin(store, history)
    await history.finish("owner", first)
    second, slug_b = await begin(store, history)
    await history.finish("owner", second)
    await manager.select("owner", slug_a)
    reached, release = asyncio.Event(), asyncio.Event()
    get = store.get

    async def paused(owner):
        """Hold a fetched snapshot while the selected conversation changes."""
        snapshot = await get(owner)
        reached.set()
        await release.wait()
        return snapshot

    monkeypatch.setattr(store, "get", paused)
    pending = asyncio.create_task(manager.start("owner", uuid4(), slug_a))
    await asyncio.wait_for(reached.wait(), 1)
    await manager.select("owner", slug_b)
    release.set()
    with pytest.raises(Problem) as error:
        await pending
    assert error.value.body.code == "sessionChanged"
    assert not RoomsDouble.instances
    assert (await store.get("owner")).conversation_slug == slug_b


async def test_date_rebuild_updates_only_selected_memory_and_command_failure_rolls_back(
    store, monkeypatch
):
    """Verify date rebuilds stay chat-local and failed commands or selections roll back memory."""
    history = History(store)
    first, slug_a = await begin(store, history)
    await history.finish("owner", first)
    second, _ = await begin(store, history)
    await history.finish("owner", second)
    before = await memory_rows(store)
    store.clock = lambda: NOW + timedelta(hours=13)
    snapshot = await store.get("owner")
    after = await memory_rows(store)
    assert after[str(first)] == before[str(first)]
    assert after[str(second)] != before[str(second)]
    assert snapshot.plan.evaluated_on > snapshot.anchor_date
    transaction = store.transaction

    @asynccontextmanager
    async def failed():
        """Raise before commit to exercise atomic rollback of snapshot and conversation memory."""
        async with transaction():
            yield
            raise OSError("write failure")

    monkeypatch.setattr(store, "transaction", failed)
    with pytest.raises(OSError):
        await store.command("owner", parsed_command(facts("999"), snapshot.revision))
    assert await store.get("owner") == snapshot
    assert await memory_rows(store) == after
    with pytest.raises(OSError):
        await history.select("owner", slug_a)
    assert await store.get("owner") == snapshot
    assert await memory_rows(store) == after
    monkeypatch.setattr(store, "transaction", transaction)
    restored = await history.select("owner", slug_a)
    assert restored.plan.evaluated_on == snapshot.plan.evaluated_on
    assert restored.as_of == snapshot.as_of and restored.anchor_date == snapshot.anchor_date
    assert await store.get("owner") == restored
    assert (await memory_rows(store))[str(second)] == after[str(second)]


async def test_continue_api_ownership_selection_sse_and_revocation(auth_server, monkeypatch):
    """Verify continuation publishes selected state once and enforces ownership and revocation."""
    application, client, _ = auth_server
    store = application.state.store
    await client.post("/api/session", json={})
    access = Access(
        (await client.get("/api/auth/session")).json()["user"]["id"], digest(client.cookies[COOKIE])
    )
    history = History(store)
    call_a, slug_a = await begin(store, history, access)
    saved_a = await store.command(
        access, parsed_command(facts("111"), (await store.get(access)).revision)
    )
    await history.finish(access, call_a)
    call_b, _ = await begin(store, history, access)
    await store.command(access, parsed_command(facts("999"), (await store.get(access)).revision))
    await history.finish(access, call_b)
    queue = await store.subscribe(access)
    queue.get_nowait()
    path = f"/api/history/{slug_a}/continue"
    selected = await client.post(path, json={})
    assert selected.status_code == 200
    snapshot = await queue.get()
    assert selected.json() == snapshot.model_dump(mode="json", by_alias=True)
    assert snapshot.facts == saved_a.facts and snapshot.conversation_slug == slug_a
    assert (await client.post(path, json={})).json() == selected.json()
    assert queue.empty()
    assert (await client.post(path, json={"unexpected": True})).status_code == 422
    reached, release = asyncio.Event(), asyncio.Event()
    check = store.check

    async def paused(owner):
        """Hold continuation after access validation until logout revokes the session."""
        await check(owner)
        reached.set()
        await release.wait()

    monkeypatch.setattr(store, "check", paused)
    pending = asyncio.create_task(client.post(path, json={}))
    await asyncio.wait_for(reached.wait(), 1)
    assert (await client.post("/api/auth/logout", json={})).status_code == 204
    release.set()
    assert (await pending).status_code == 401
    monkeypatch.setattr(store, "check", check)
    await sign_in_async(client, application, "google-user-two")
    await client.post("/api/session", json={})
    assert (await client.post(path, json={})).status_code == 404
    await client.post("/api/auth/logout", json={})
    assert (await client.post(path, json={})).status_code == 401


async def test_expired_memory_and_capacity_cannot_create_duplicate_reconnect(store):
    """Verify reconnect reuses history capacity while expiry prevents selecting saved memory."""
    history = History(store)
    first, slug = await begin(store, history)
    await history.finish("owner", first)
    store.config = store.config.model_copy(
        update={
            "history": store.config.history.model_copy(update={"max_conversations": 1}),
        }
    )
    snapshot = await store.get("owner")
    await history.start("owner", uuid4(), snapshot.session_id, slug)
    assert len((await history.list("owner")).conversations) == 1
    with pytest.raises(Problem) as error:
        await history.start("owner", uuid4(), snapshot.session_id)
    assert error.value.body.code == "historyLimit"
    store.clock = lambda: snapshot.expires_at
    with pytest.raises(Problem):
        await history.select("owner", slug)
    assert not (await history.list("owner")).conversations


@pytest.mark.parametrize("edited", [False, True])
async def test_uncaptured_history_restores_only_provable_initial_state(store, edited):
    """Verify history without captured memory restores only a provable unedited initial state."""
    snapshot = await store.create("owner")
    if edited:
        snapshot = await store.command("owner", parsed_command(facts("111")))
    slug = "conversation-before-memory"
    async with store.lock, store.transaction():
        await store.connection().execute(
            "INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(uuid4()),
                "owner",
                str(snapshot.session_id),
                slug,
                "Earlier chat",
                NOW.isoformat(),
                NOW.isoformat(),
                snapshot.expires_at.isoformat(),
                "",
            ),
        )
    if edited:
        snapshot = await store.command("owner", parsed_command(facts("999"), snapshot.revision))
        with pytest.raises(Problem) as error:
            await History(store).select("owner", slug)
        assert error.value.body.code == "conversationMemoryUnavailable"
        assert await store.get("owner") == snapshot
        assert await memory_rows(store) == {}
    else:
        restored = await History(store).select("owner", slug)
        assert restored.facts == snapshot.facts
        assert restored.conversation_slug == slug
        assert restored.as_of == snapshot.as_of and restored.anchor_date == snapshot.anchor_date


async def test_join_route_passes_slug_and_delete_ignores_it(auth_server, monkeypatch):
    """Verify call start forwards the chat slug while deletion uses only the call ID."""
    application, client, _ = auth_server
    calls = application.state.calls
    end = AsyncMock(return_value=CallState(status="ended"))
    start = AsyncMock(side_effect=Problem(409, "conversationChanged", "Select this chat."))
    monkeypatch.setattr(calls, "start", start)
    monkeypatch.setattr(calls, "end", end)
    call_id = uuid4()
    body = {"callId": str(call_id), "conversationSlug": "conversation-a"}
    assert (await client.post("/api/session/call", json=body)).status_code == 409
    assert start.call_args.args[1:] == (call_id, "conversation-a")
    assert (await client.request("DELETE", "/api/session/call", json=body)).status_code == 200
    assert end.call_args.args[1:] == (call_id,)
