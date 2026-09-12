# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import json
import sqlite3
import traceback
from contextlib import closing
from datetime import timedelta

import pytest
from pydantic import ValidationError

from app.models import Command, Snapshot
from app.store import Problem, owner_hash

from .conftest import NOW, command, facts, parsed_command, record
from .test_adjustments import adjustment
from .test_scenarios import operation


@pytest.fixture
async def cached_session(store):
    """Seed accepted and pending scenarios with invalid cached projections in state and receipts."""
    owner = owner_hash("synthetic-cache-test")
    await store.create(owner)
    await store.command(
        owner,
        parsed_command(facts("100", [record("optional", "optional", "50", "2026-09-11")])),
    )
    preview = await store.command(
        owner,
        Command.model_validate(
            operation("previewAdjustments", adjustments=[adjustment("optional:2026-09-11")])
        ),
    )
    await store.command(
        owner,
        Command.model_validate(operation("acceptPreview", previewId=str(preview.preview.id))),
    )
    request = Command.model_validate(
        operation("previewAdjustments", 2, adjustments=[adjustment("optional:2026-09-11", "10")])
    )
    snapshot = await store.command(owner, request)
    payload = snapshot.model_dump(mode="json", by_alias=True)
    for value in (payload, payload["preview"], payload["accepted"]):
        value["plan"]["status"] = "covered"
        del value["plan"]["budgetBasis"]
        value["plan"]["outflowPaise"] = 999999
    payload["preview"]["reducedOutflowPaise"] = -999999
    payload["accepted"]["reducedOutflowPaise"] = -999999
    text = json.dumps(payload)
    with pytest.raises(ValidationError):
        Snapshot.model_validate_json(text)
    await store.connection().execute(
        "UPDATE sessions SET snapshot = ? WHERE owner = ?", (text, owner)
    )
    await store.connection().execute(
        "UPDATE commands SET result = ? WHERE owner = ? AND id = ?",
        (text, owner, str(request.command_id)),
    )
    await store.connection().commit()
    return owner, snapshot, request, text


async def test_cached_projections_reload_without_writes_or_new_consent(store, cached_session):
    """Verify cached projections rebuild on reads and replays without writes or altered consent."""
    owner, expected, request, text = cached_session
    store.clock = lambda: NOW + timedelta(hours=2)
    await store.close()
    await store.open()
    queue = await store.subscribe(owner)
    assert queue.get_nowait() == expected
    writes = store.connection().total_changes
    for _ in range(2):
        assert await store.get(owner) == expected
        assert await store.command(owner, request) == expected
        assert (await store.options(owner)).revision == expected.revision
    assert queue.empty()
    assert store.connection().total_changes == writes
    assert expected.as_of == expected.created_at == NOW
    assert (expected.revision, expected.sequence) == (2, 4)
    assert expected.plan.outflow_paise == 5000
    assert expected.preview.plan.outflow_paise == 1000
    assert expected.accepted.plan.outflow_paise == 0
    assert expected.accepted.adjustments[0].accepted_revision == 2
    async with store.connection().execute(
        "SELECT snapshot FROM sessions WHERE owner = ?", (owner,)
    ) as cursor:
        assert (await cursor.fetchone())[0] == text
    async with store.connection().execute(
        "SELECT result FROM commands WHERE owner = ? AND id = ?", (owner, str(request.command_id))
    ) as cursor:
        assert (await cursor.fetchone())[0] == text


async def test_cached_replay_uses_its_own_facts_without_restoring_state(store, cached_session):
    """Verify replay uses its own facts without restoring, publishing, or rewriting state."""
    owner, expected, request, _ = cached_session
    current = await store.command(owner, parsed_command(facts("200"), 2))
    queue = await store.subscribe(owner)
    queue.get_nowait()
    writes = store.connection().total_changes
    assert await store.command(owner, request) == expected
    assert await store.get(owner) == current
    assert queue.empty()
    assert store.connection().total_changes == writes


async def test_missing_cached_date_rebuilds_once_without_changing_financial_state(
    store, cached_session
):
    """Verify missing cached dates trigger one persisted rebuild without financial changes."""
    owner, expected, request, text = cached_session
    payload = json.loads(text)
    for value in (payload, payload["preview"], payload["accepted"]):
        del value["plan"]["evaluatedOn"]
    text = json.dumps(payload)
    await store.connection().execute(
        "UPDATE sessions SET snapshot = ? WHERE owner = ?", (text, owner)
    )
    await store.connection().execute(
        "UPDATE commands SET result = ? WHERE owner = ? AND id = ?",
        (text, owner, str(request.command_id)),
    )
    await store.connection().commit()
    writes = store.connection().total_changes
    recovered = await store.get(owner)
    assert recovered == expected.model_copy(update={"sequence": expected.sequence + 1})
    assert recovered.facts == expected.facts
    assert recovered.accepted.adjustments == expected.accepted.adjustments
    assert recovered.preview.id == expected.preview.id
    assert recovered.as_of == expected.as_of and recovered.expires_at == expected.expires_at
    assert store.connection().total_changes == writes + 1
    assert await store.command(owner, request) == expected
    assert await store.get(owner) == recovered
    assert store.connection().total_changes == writes + 1
    async with store.connection().execute(
        "SELECT result FROM commands WHERE owner = ? AND id = ?", (owner, str(request.command_id))
    ) as cursor:
        assert (await cursor.fetchone())[0] == text
    await store.close()
    await store.open()
    assert await store.get(owner) == recovered
    assert store.connection().total_changes == 0


@pytest.mark.parametrize(
    "path", ["/api/session", "/api/session/export", "/api/session/options", "/api/session/call"]
)
def test_returning_browser_recovers_missing_cached_date_with_same_cookie(client, path):
    """Verify returning browsers recover missing cached dates with the same session identity."""
    client.post("/api/session", json={})
    original = client.post(
        "/api/session/commands",
        json=command(facts("4000", [record("rent", "essential", "8000", None)])),
    ).json()
    payload = json.loads(json.dumps(original))
    del payload["plan"]["evaluatedOn"]
    with closing(sqlite3.connect(client.app.state.store.path)) as db:
        db.execute("UPDATE sessions SET snapshot = ?", (json.dumps(payload),))
        db.commit()
    response = client.get(path)
    assert response.status_code == 200
    recovered = client.get("/api/session").json()
    assert recovered["sessionId"] == original["sessionId"]
    assert recovered["facts"] == original["facts"]
    assert recovered["revision"] == original["revision"]
    assert recovered["sequence"] == original["sequence"] + 1
    assert recovered["plan"] == original["plan"]
    assert client.post("/api/session", json={}).json() == recovered
    assert client.get("/health/ready").status_code == 200


@pytest.mark.parametrize(
    "field,value",
    [
        ("facts", {"privateFinancialInput": "private-financial-value"}),
        ("facts.opening.status", "private-financial-value"),
        ("anchorDate", "private-financial-value"),
        ("plan.evaluatedOn", "private-financial-value"),
        ("plan.evaluatedOn", None),
        ("expiresAt", "2026-09-12T06:00:00"),
        ("sessionId", "private-financial-value"),
        ("futureMetadata", "private-financial-value"),
        ("accepted", "private-financial-value"),
        ("accepted.adjustments", [{"eventId": "private-financial-value"}]),
        ("accepted.futureConsent", "private-financial-value"),
    ],
)
async def test_invalid_authoritative_state_is_sanitized_and_retained(
    store, cached_session, field, value
):
    """Verify invalid source state is retained with sanitized errors and no snapshot exposure."""
    owner, _, _, text = cached_session
    payload = json.loads(text)
    target = payload
    for part in field.split(".")[:-1]:
        target = target[part]
    target[field.split(".")[-1]] = value
    text = json.dumps(payload)
    await store.connection().execute(
        "UPDATE sessions SET snapshot = ? WHERE owner = ?", (text, owner)
    )
    await store.connection().commit()
    writes = store.connection().total_changes
    with pytest.raises(Problem) as error:
        await store.get(owner)
    assert error.value.status == 500
    assert error.value.body.code == "invalidStoredState"
    assert error.value.body.snapshot is None
    assert "private-financial-value" not in error.value.body.model_dump_json()
    assert "private-financial-value" not in "".join(traceback.format_exception(error.value))
    assert store.connection().total_changes == writes
    async with store.connection().execute(
        "SELECT snapshot FROM sessions WHERE owner = ?", (owner,)
    ) as cursor:
        assert (await cursor.fetchone())[0] == text


@pytest.mark.parametrize("text", ["[]", '{"facts":', "{}"])
async def test_invalid_stored_json_is_sanitized(store, text):
    """Verify malformed or incomplete stored JSON reports an invalid-state error."""
    owner = owner_hash("synthetic-invalid-json")
    await store.create(owner)
    await store.connection().execute(
        "UPDATE sessions SET snapshot = ? WHERE owner = ?", (text, owner)
    )
    await store.connection().commit()
    with pytest.raises(Problem) as error:
        await store.get(owner)
    assert error.value.body.code == "invalidStoredState"


async def test_inconsistent_saved_assumptions_fail_without_dropping_them(store, cached_session):
    """Verify inconsistent accepted adjustments fail without discarding their stored data."""
    owner, _, _, text = cached_session
    payload = json.loads(text)
    payload["accepted"]["adjustments"][0]["amountPaise"] = 6000
    text = json.dumps(payload)
    await store.connection().execute(
        "UPDATE sessions SET snapshot = ? WHERE owner = ?", (text, owner)
    )
    await store.connection().commit()
    with pytest.raises(Problem) as error:
        await store.get(owner)
    assert error.value.body.code == "invalidStoredState"
    async with store.connection().execute(
        "SELECT snapshot FROM sessions WHERE owner = ?", (owner,)
    ) as cursor:
        assert (await cursor.fetchone())[0] == text


async def test_invalid_replay_does_not_return_or_overwrite_current_state(store, cached_session):
    """Verify invalid receipts produce sanitized errors without changing current state."""
    owner, _, request, text = cached_session
    current = await store.command(owner, parsed_command(facts("200"), 2))
    payload = json.loads(text)
    payload["facts"]["opening"]["status"] = "private-financial-value"
    await store.connection().execute(
        "UPDATE commands SET result = ? WHERE owner = ? AND id = ?",
        (json.dumps(payload), owner, str(request.command_id)),
    )
    await store.connection().commit()
    writes = store.connection().total_changes
    with pytest.raises(Problem) as error:
        await store.command(owner, request)
    assert error.value.body.code == "invalidStoredState"
    assert "private-financial-value" not in "".join(traceback.format_exception(error.value))
    assert await store.get(owner) == current
    assert store.connection().total_changes == writes


async def test_expiry_still_applies_with_obsolete_cached_projections(store, cached_session):
    """Verify expired sessions are rejected and deleted despite obsolete cached projections."""
    owner, _, _, _ = cached_session
    store.clock = lambda: NOW + timedelta(hours=24)
    with pytest.raises(Problem) as error:
        await store.get(owner)
    assert error.value.status == 410
    assert error.value.body.code == "expired"
    async with store.connection().execute("SELECT COUNT(*) FROM sessions") as cursor:
        assert (await cursor.fetchone())[0] == 0
