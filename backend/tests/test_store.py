# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import sqlite3
from datetime import timedelta

import pytest

from app.models import Error
from app.store import Problem, owner_hash

from .conftest import NOW, facts, parsed_command


async def test_serialized_concurrent_edits_and_replay(store):
    owner = owner_hash("a")
    await store.create(owner)
    commands = [parsed_command(facts("10")), parsed_command(facts("20"))]
    outcomes = await asyncio.gather(
        *(store.command(owner, command) for command in commands), return_exceptions=True
    )
    assert sum(isinstance(outcome, Problem) for outcome in outcomes) == 1
    conflict = next(outcome for outcome in outcomes if isinstance(outcome, Problem))
    assert conflict.status == 409 and conflict.body.code == "staleRevision"
    snapshot = await store.get(owner)
    assert snapshot.revision == snapshot.sequence == 1
    winner = commands[
        next(index for index, outcome in enumerate(outcomes) if not isinstance(outcome, Problem))
    ]
    results = await asyncio.gather(*(store.command(owner, winner) for _ in range(5)))
    assert all(result == snapshot for result in results)


async def test_transaction_failure_rolls_back_state_and_record(store):
    owner = owner_hash("a")
    initial = await store.create(owner)
    await store.connection().execute(
        "CREATE TRIGGER fail_command BEFORE INSERT ON commands "
        "BEGIN SELECT RAISE(ABORT, 'test failure'); END"
    )
    await store.connection().commit()
    submitted = parsed_command(facts("10"))
    with pytest.raises(sqlite3.IntegrityError):
        await store.command(owner, submitted)
    assert await store.get(owner) == initial
    await store.connection().execute("DROP TRIGGER fail_command")
    await store.connection().commit()
    assert (await store.command(owner, submitted)).revision == 1


async def test_queues_are_latest_only_reconnect_current_and_delete_terminal(store):
    owner = owner_hash("a")
    await store.create(owner)
    queue = await store.subscribe(owner)
    assert queue.maxsize == 1
    for revision in range(10):
        await store.command(owner, parsed_command(facts(str(revision)), revision))
    assert queue.qsize() == 1
    assert (await queue.get()).sequence == 10
    store.unsubscribe(owner, queue)
    queue = await store.subscribe(owner)
    assert (await queue.get()).sequence == 10
    await store.delete(owner)
    assert (await queue.get()).code == "deleted"
    assert owner not in store.listeners
    async with store.connection().execute("SELECT COUNT(*) FROM commands") as cursor:
        assert (await cursor.fetchone())[0] == 0
    with pytest.raises(Problem, match="No current"):
        await store.subscribe(owner)


async def test_expiry_cleanup_removes_commands_and_closes_streams(store):
    owner = owner_hash("a")
    await store.create(owner)
    await store.command(owner, parsed_command(facts("0")))
    queue = await store.subscribe(owner)
    store.clock = lambda: NOW + timedelta(hours=24)
    await store.cleanup()
    value = await queue.get()
    assert isinstance(value, Error) and value.code == "expired"
    async with store.connection().execute("SELECT COUNT(*) FROM commands") as cursor:
        assert (await cursor.fetchone())[0] == 0
    with pytest.raises(Problem) as error:
        await store.get(owner)
    assert error.value.status == 404


async def test_caps_and_owner_hash_persistence(store):
    store.config = store.config.model_copy(
        update={
            "max_sessions": 1,
            "max_commands": 1,
            "max_streams_per_session": 1,
            "max_event_streams": 1,
        }
    )
    owner = owner_hash("not-a-persisted-cookie")
    await store.create(owner)
    with pytest.raises(Problem) as error:
        await store.create(owner_hash("b"))
    assert error.value.body.code == "sessionLimit"
    submitted = parsed_command(facts("1"))
    await store.command(owner, submitted)
    await store.command(owner, submitted)
    with pytest.raises(Problem) as error:
        await store.command(owner, parsed_command(facts("2"), 1))
    assert error.value.body.code == "commandLimit"
    queue = await store.subscribe(owner)
    with pytest.raises(Problem) as error:
        await store.subscribe(owner)
    assert error.value.body.code == "streamLimit"
    store.unsubscribe(owner, queue)
    async with store.connection().execute("SELECT owner FROM sessions") as cursor:
        assert (await cursor.fetchone())[0] == owner


async def test_failed_create_and_delete_release_transaction(store):
    owner = owner_hash("a")
    db = store.connection()
    await db.execute(
        "CREATE TRIGGER fail_create BEFORE INSERT ON sessions "
        "BEGIN SELECT RAISE(ABORT, 'test failure'); END"
    )
    await db.commit()
    with pytest.raises(sqlite3.IntegrityError):
        await store.create(owner)
    assert not db.in_transaction
    await db.execute("DROP TRIGGER fail_create")
    await db.commit()
    snapshot = await store.create(owner)
    await db.execute(
        "CREATE TRIGGER fail_delete BEFORE DELETE ON sessions "
        "BEGIN SELECT RAISE(ABORT, 'test failure'); END"
    )
    await db.commit()
    with pytest.raises(sqlite3.IntegrityError):
        await store.delete(owner)
    assert not db.in_transaction
    assert await store.get(owner) == snapshot
    await db.execute("DROP TRIGGER fail_delete")
    await db.commit()
    await store.delete(owner)


async def test_cancelled_command_rolls_back_and_does_not_publish(store, monkeypatch):
    owner = owner_hash("a")
    snapshot = await store.create(owner)
    queue = await store.subscribe(owner)
    queue.get_nowait()
    db = store.connection()
    execute = db.execute

    def interrupted_execute(sql, parameters=None):
        result = execute(sql, parameters)
        if sql.startswith("UPDATE sessions"):

            async def interrupt():
                await result
                raise asyncio.CancelledError

            return interrupt()
        return result

    submitted = parsed_command(facts("42"))
    with monkeypatch.context() as patch:
        patch.setattr(db, "execute", interrupted_execute)
        with pytest.raises(asyncio.CancelledError):
            await store.command(owner, submitted)
    assert await store.get(owner) == snapshot
    assert queue.empty() and not db.in_transaction
    assert (await store.command(owner, submitted)).revision == 1
