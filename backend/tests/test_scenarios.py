# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
import sqlite3
from datetime import timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.auth import COOKIE
from app.config import Environment
from app.models import Command
from app.store import Problem, owner_hash

from .auth_support import auth_app, sign_in
from .conftest import NOW, ORIGIN, command, facts, money, parsed_command, record
from .test_adjustments import adjustment
from .test_finance import scenario_two


def operation(kind, revision=1, **values):
    if kind == "acceptPreview":
        values = {"confirmed": True, "consentScope": "unconditional", **values}
    return {
        "commandId": str(uuid4()),
        "expectedRevision": revision,
        "operation": {"type": kind, **values},
    }


def submit(client, kind, revision=1, **values):
    response = client.post("/api/session/commands", json=operation(kind, revision, **values))
    assert response.status_code == 200, response.text
    return response.json()


def initialize(client, data=None):
    client.post("/api/session", json={})
    response = client.post("/api/session/commands", json=command(data or scenario_two()))
    assert response.status_code == 200
    return response.json()


def test_options_are_read_only_baseline_owned_and_schema_is_additive(client):
    assert client.get("/api/session/options").status_code == 404
    baseline = initialize(client)
    assert baseline["preview"] is baseline["accepted"] is None
    actual = client.get("/api/session/options").json()
    assert actual["options"][0].pop("acceptanceReady") is True
    assert len(actual["options"][0].pop("dependencyKey")) == 64
    assert actual == {
        "revision": 1,
        "today": "2026-09-11",
        "options": [
            {
                "eventId": "optional:2026-09-27",
                "recordId": "optional",
                "label": "optional",
                "kind": "optional",
                "date": "2026-09-27",
                "originalPaise": 200000,
                "minimumPaise": 0,
            }
        ],
    }
    assert client.get("/api/session").json() == baseline
    schema = client.get("/openapi.json").json()["components"]["schemas"]
    assert schema["Command"]["properties"]["operation"]["discriminator"]["propertyName"] == "type"
    assert set(schema["Command"]["properties"]["operation"]["discriminator"]["mapping"]) == {
        "replaceFacts",
        "previewAdjustments",
        "acceptPreview",
        "discardPreview",
        "clearAccepted",
        "respondToAction",
    }
    assert {"decisionAssessment", "budgetBasis", "incomeComparisons", "peakGapDate"} <= schema[
        "Plan"
    ]["properties"].keys()
    assert not {"nextSteps", "status"} & schema["Plan"]["properties"].keys()


def test_preview_accept_clear_keep_reported_baseline_and_frozen_basis(client):
    baseline = initialize(client)
    preview = submit(client, "previewAdjustments", adjustments=[adjustment()])
    assert (preview["revision"], preview["sequence"]) == (1, 2)
    assert preview["accepted"] is None
    assert preview["preview"]["sourceRevision"] == 1
    assert preview["preview"]["createdAt"] == NOW.isoformat().replace("+00:00", "Z")
    assert preview["preview"]["reducedOutflowPaise"] == 200000
    assert preview["preview"]["plan"]["closingPaise"] == 1200000
    accepted = submit(client, "acceptPreview", previewId=preview["preview"]["id"])
    assert (accepted["revision"], accepted["sequence"]) == (2, 3)
    assert accepted["accepted"]["id"] == preview["preview"]["id"] and accepted["preview"] is None
    assert accepted["accepted"]["adjustments"][0]["acceptedRevision"] == 2
    pending = submit(client, "previewAdjustments", 2, adjustments=[adjustment(amount="1000")])
    cleared = submit(client, "clearAccepted", 2)
    assert (cleared["revision"], cleared["sequence"]) == (3, 5)
    assert cleared["preview"] is cleared["accepted"] is None
    for snapshot in [preview, accepted, pending, cleared]:
        for field in ["facts", "plan", "asOf", "anchorDate", "expiresAt", "createdAt"]:
            assert snapshot[field] == baseline[field]
    assert (
        client.post("/api/session/commands", json=operation("clearAccepted", 3)).json()["code"]
        == "noAccepted"
    )


def test_replacement_never_stacks_and_discard_preserves_acceptance(client):
    initialize(client)
    preview = submit(client, "previewAdjustments", adjustments=[adjustment()])
    accepted = submit(client, "acceptPreview", previewId=preview["preview"]["id"])
    assert client.get("/api/session/options").json()["options"][0]["originalPaise"] == 200000
    pending = submit(client, "previewAdjustments", 2, adjustments=[adjustment(amount="500")])
    replacement = submit(client, "previewAdjustments", 2, adjustments=[adjustment(amount="1000")])
    assert replacement["accepted"] == accepted["accepted"]
    assert replacement["preview"]["reducedOutflowPaise"] == 100000
    assert replacement["preview"]["plan"]["closingPaise"] == 1100000
    for kind in ["acceptPreview", "discardPreview"]:
        response = client.post(
            "/api/session/commands", json=operation(kind, 2, previewId=pending["preview"]["id"])
        )
        assert response.status_code == 409 and response.json()["code"] == "stalePreview"
        assert response.json()["snapshot"] == replacement
    discarded = submit(client, "discardPreview", 2, previewId=replacement["preview"]["id"])
    assert discarded["revision"] == 2 and discarded["sequence"] == replacement["sequence"] + 1
    assert discarded["accepted"] == accepted["accepted"] and discarded["preview"] is None
    pending = submit(client, "previewAdjustments", 2, adjustments=[adjustment(amount="1000")])
    replacement = submit(client, "acceptPreview", 2, previewId=pending["preview"]["id"])
    assert replacement["accepted"]["reducedOutflowPaise"] == 100000
    assert replacement["accepted"]["sourceRevision"] == 2


def test_corrections_invalidate_both_scenarios_and_retries_do_not_restore_them(client):
    initialize(client)
    preview_command = operation("previewAdjustments", adjustments=[adjustment()])
    preview = client.post("/api/session/commands", json=preview_command).json()
    accept_command = operation("acceptPreview", previewId=preview["preview"]["id"])
    accepted = client.post("/api/session/commands", json=accept_command).json()
    submit(client, "previewAdjustments", 2, adjustments=[adjustment(amount="1000")])
    corrected = client.post("/api/session/commands", json=command(facts("99"), 2)).json()
    assert corrected["preview"] is corrected["accepted"] is None
    assert corrected["revision"] == 3
    for request, original in [(preview_command, preview), (accept_command, accepted)]:
        assert client.post("/api/session/commands", json=request).json() == original
        assert client.get("/api/session").json() == corrected
    response = client.post(
        "/api/session/commands",
        json=operation("acceptPreview", 2, previewId=preview["preview"]["id"]),
    )
    assert response.status_code == 409 and response.json()["code"] == "staleRevision"
    response = client.post(
        "/api/session/commands",
        json=operation("acceptPreview", 3, previewId=preview["preview"]["id"]),
    )
    assert response.status_code == 409 and response.json()["code"] == "stalePreview"


def test_cross_owner_and_unknown_preview_ids_cannot_be_accepted(client):
    initialize(client)
    preview = submit(client, "previewAdjustments", adjustments=[adjustment()])
    client.cookies.clear()
    sign_in(client, "google-user-two")
    own = initialize(client)
    for preview_id in [preview["preview"]["id"], str(uuid4())]:
        response = client.post(
            "/api/session/commands", json=operation("acceptPreview", previewId=preview_id)
        )
        assert response.status_code == 409 and response.json()["code"] == "stalePreview"
        assert response.json()["snapshot"] == own
    assert client.get("/api/session").json() == own


@pytest.mark.parametrize(
    "inputs",
    [
        [],
        [adjustment(), adjustment()],
        [adjustment(amount="2000")],
        [adjustment("missing")],
        [adjustment(amount="0.001")],
        [adjustment(amount=0.5)],
        [{**adjustment(), "confirmed": False}],
        [{**adjustment(), "confirmed": "true"}],
        [{**adjustment(), "minimumPaise": 0}],
        [{"eventId": "optional:2026-09-27"}],
    ],
)
def test_invalid_api_adjustments_are_atomic(client, inputs):
    baseline = initialize(client)
    response = client.post(
        "/api/session/commands", json=operation("previewAdjustments", adjustments=inputs)
    )
    assert response.status_code == 422
    assert client.get("/api/session").json() == baseline


def test_day_rollover_rejects_acceptance_without_expiring_the_cash_basis(tmp_path, config):
    now = [NOW]
    with TestClient(
        auth_app(config, Environment(data_dir=tmp_path), lambda: now[0]), base_url=ORIGIN
    ) as client:
        sign_in(client)
        initialize(client, facts("100", [record("optional", "optional", "100", "2026-09-11")]))
        preview = submit(
            client, "previewAdjustments", adjustments=[adjustment("optional:2026-09-11")]
        )
        now[0] += timedelta(hours=18)
        assert client.get("/api/session/options").json() == {
            "revision": 1,
            "today": "2026-09-12",
            "options": [],
        }
        response = client.post(
            "/api/session/commands",
            json=operation("acceptPreview", previewId=preview["preview"]["id"]),
        )
        assert response.status_code == 409 and response.json()["code"] == "stalePreview"
        refreshed = response.json()["snapshot"]
        assert refreshed["sequence"] == preview["sequence"] + 1
        assert refreshed["revision"] == preview["revision"]
        assert refreshed["facts"] == preview["facts"]
        assert refreshed["anchorDate"] == preview["anchorDate"]
        assert refreshed["preview"]["id"] == preview["preview"]["id"]
        assert refreshed["plan"]["evaluatedOn"] == "2026-09-12"
        assert refreshed["preview"]["plan"]["evaluatedOn"] == "2026-09-12"
        assert client.get("/api/session").json() == refreshed
        assert (
            submit(client, "discardPreview", previewId=preview["preview"]["id"])["preview"] is None
        )


def test_saved_outcomes_and_idempotency_survive_restart(tmp_path, config):
    environment = Environment(data_dir=tmp_path)
    application = auth_app(config, environment, lambda: NOW)
    with TestClient(application, base_url=ORIGIN) as client:
        sign_in(client)
        initialize(client)
        preview = submit(client, "previewAdjustments", adjustments=[adjustment()])
        accepted = submit(client, "acceptPreview", previewId=preview["preview"]["id"])
        request = operation("previewAdjustments", 2, adjustments=[adjustment(amount="1000")])
        pending = client.post("/api/session/commands", json=request).json()
        cookie = client.cookies[COOKIE]
    with TestClient(
        auth_app(config, environment, lambda: NOW, google=application.state.auth.google),
        base_url=ORIGIN,
        headers={"Origin": ORIGIN},
    ) as client:
        client.cookies.set(COOKIE, cookie, domain="localhost.local", path="/")
        assert client.get("/api/session").json() == pending
        assert pending["accepted"] == accepted["accepted"]
        assert client.post("/api/session/commands", json=request).json() == pending
        assert "INR 2000.00 -> INR 0.00" in client.get("/api/session/export").text


def test_export_only_accepted_assumptions_and_original_details(client):
    data = scenario_two()
    data["records"][4]["amount"] = money("500")
    data["records"][4]["target"] = money("2000")
    data["records"][4]["outstanding"] = money("10000")
    data["records"].append(record("outside", "essential", "123", "2026-10-20"))
    initialize(client, data)
    baseline = client.get("/api/session/export").text
    preview = submit(
        client,
        "previewAdjustments",
        adjustments=[adjustment(), adjustment("card:2026-09-26", "500")],
    )
    assert client.get("/api/session/export").text == baseline
    submit(client, "acceptPreview", previewId=preview["preview"]["id"])
    text = client.get("/api/session/export").text
    for expected in [
        "Accepted planning assumptions",
        "reduced planned outflow: INR 3500.00",
        "2026-09-27 | optional [optional] | INR 2000.00 -> INR 0.00",
        "2026-09-26 | card [card] | INR 2000.00 -> INR 500.00",
        "Reported baseline: first gap 2026-09-13, INR 7000.00",
        "Accepted: first gap 2026-09-13, INR 7000.00",
        "peak gap INR 16000.00 on 2026-09-18",
        "closing INR 13500.00",
        "outstanding INR 10000.00",
        "unchanged",
        "minimum is not payoff",
        "interest and fees",
        "outside [outside]",
        "2026-10-20",
        "INR 123.00",
        "No payments have been executed",
        "No payment execution or allocation",
    ]:
        assert expected in text
    assert "No allocations or payment recommendations" not in text
    assert "money saved" not in text
    submit(client, "previewAdjustments", 2, adjustments=[adjustment(amount="777")])
    assert client.get("/api/session/export").text == text
    submit(client, "clearAccepted", 2)
    text = client.get("/api/session/export").text
    assert "Reported baseline only" in text
    assert "reduced planned outflow" not in text and " -> " not in text


@pytest.mark.parametrize(
    "kind", ["previewAdjustments", "acceptPreview", "discardPreview", "clearAccepted"]
)
async def test_scenario_transactions_rollback_and_do_not_publish(store, kind):
    owner = owner_hash("scenario")
    await store.create(owner)
    await store.command(owner, parsed_command(scenario_two()))
    preview = await store.command(
        owner, Command.model_validate(operation("previewAdjustments", adjustments=[adjustment()]))
    )
    if kind == "clearAccepted":
        await store.command(
            owner,
            Command.model_validate(operation("acceptPreview", previewId=str(preview.preview.id))),
        )
    before = await store.get(owner)
    queue = await store.subscribe(owner)
    queue.get_nowait()
    values = (
        {"adjustments": [adjustment(amount="500")]}
        if kind == "previewAdjustments"
        else {}
        if kind == "clearAccepted"
        else {"previewId": str(preview.preview.id)}
    )
    request = Command.model_validate(operation(kind, before.revision, **values))
    db = store.connection()
    await db.execute(
        "CREATE TRIGGER fail_scenario BEFORE INSERT ON commands "
        "BEGIN SELECT RAISE(ABORT, 'test'); END"
    )
    await db.commit()
    with pytest.raises(sqlite3.IntegrityError):
        await store.command(owner, request)
    assert await store.get(owner) == before
    assert queue.empty() and not db.in_transaction
    await db.execute("DROP TRIGGER fail_scenario")
    await db.commit()
    result = await store.command(owner, request)
    assert await queue.get() == result
    assert await store.command(owner, request) == result
    assert queue.empty()


@pytest.mark.parametrize("action", ["delete", "expire"])
async def test_scenarios_expire_and_delete_with_session_and_command_results(store, action):
    owner = owner_hash("retention")
    await store.create(owner)
    await store.command(owner, parsed_command(scenario_two()))
    preview = await store.command(
        owner, Command.model_validate(operation("previewAdjustments", adjustments=[adjustment()]))
    )
    await store.command(
        owner, Command.model_validate(operation("acceptPreview", previewId=str(preview.preview.id)))
    )
    await store.command(
        owner,
        Command.model_validate(
            operation("previewAdjustments", 2, adjustments=[adjustment(amount="100")])
        ),
    )
    if action == "delete":
        await store.delete(owner)
    else:
        store.clock = lambda: NOW + timedelta(hours=24)
        await store.cleanup()
    for table in ["sessions", "commands"]:
        async with store.connection().execute(f"SELECT COUNT(*) FROM {table}") as cursor:
            assert (await cursor.fetchone())[0] == 0
    with pytest.raises(Problem):
        await store.get(owner)


async def test_retained_baseline_derived_fields_are_canonical_on_read_without_writes(store):
    owner = owner_hash("retained")
    await store.create(owner)
    expected = await store.command(owner, parsed_command(scenario_two()))
    retained = expected.model_dump(mode="json", by_alias=True)
    for field in ["preview", "accepted"]:
        del retained[field]
    retained["plan"]["decisionAssessment"] = {}
    retained["plan"]["peakGapDate"] = None
    text = json.dumps(retained)
    await store.connection().execute(
        "UPDATE sessions SET snapshot = ? WHERE owner = ?", (text, owner)
    )
    await store.connection().commit()
    assert await store.get(owner) == expected
    async with store.connection().execute(
        "SELECT snapshot FROM sessions WHERE owner = ?", (owner,)
    ) as cursor:
        assert (await cursor.fetchone())[0] == text


async def test_concurrent_acceptance_is_serialized_and_replay_never_publishes(store):
    owner = owner_hash("concurrent")
    await store.create(owner)
    await store.command(owner, parsed_command(scenario_two()))
    request = Command.model_validate(operation("previewAdjustments", adjustments=[adjustment()]))
    preview = await store.command(owner, request)
    commands = [
        Command.model_validate(operation("acceptPreview", previewId=str(preview.preview.id)))
        for _ in range(2)
    ]
    outcomes = await asyncio.gather(
        *(store.command(owner, item) for item in commands), return_exceptions=True
    )
    assert sum(isinstance(item, Problem) for item in outcomes) == 1
    current = await store.get(owner)
    assert current.revision == 2 and current.sequence == 3
    corrected = await store.command(owner, parsed_command(facts("42"), 2))
    queue = await store.subscribe(owner)
    queue.get_nowait()
    assert await store.command(owner, request) == preview
    assert queue.empty() and await store.get(owner) == corrected


async def test_preview_caps_retries_and_options_do_not_consume_commands(store):
    owner = owner_hash("caps")
    await store.create(owner)
    await store.command(owner, parsed_command(scenario_two()))
    store.config = store.config.model_copy(update={"max_commands": 2})
    request = Command.model_validate(operation("previewAdjustments", adjustments=[adjustment()]))
    preview = await store.command(owner, request)
    assert await store.command(owner, request) == preview
    assert (await store.options(owner)).revision == 1
    with pytest.raises(Problem) as error:
        await store.command(
            owner,
            Command.model_validate(operation("acceptPreview", previewId=str(preview.preview.id))),
        )
    assert error.value.body.code == "commandLimit"
    assert await store.get(owner) == preview


async def test_options_wait_for_the_serialized_boundary(store):
    owner = owner_hash("options-lock")
    await store.create(owner)
    started = asyncio.Event()

    async def read_options():
        started.set()
        return await store.options(owner)

    async with store.lock:
        task = asyncio.create_task(read_options())
        await started.wait()
        assert not task.done()
    assert (await task).revision == 0


async def test_acceptance_rejects_mismatched_source_revision(store):
    owner = owner_hash("source")
    await store.create(owner)
    await store.command(owner, parsed_command(scenario_two()))
    snapshot = await store.command(
        owner, Command.model_validate(operation("previewAdjustments", adjustments=[adjustment()]))
    )
    snapshot.preview.source_revision = 0
    await store.connection().execute(
        "UPDATE sessions SET snapshot = ? WHERE owner = ?",
        (snapshot.model_dump_json(by_alias=True), owner),
    )
    await store.connection().commit()
    with pytest.raises(Problem) as error:
        await store.command(
            owner,
            Command.model_validate(operation("acceptPreview", previewId=str(snapshot.preview.id))),
        )
    assert error.value.body.code == "stalePreview"
    assert await store.get(owner) == snapshot


def test_card_api_acceptance_preserves_minimum_outstanding_and_reserve(client):
    baseline = initialize(
        client,
        facts(
            "1000",
            [
                record(
                    "card",
                    "debt",
                    "500",
                    "2026-09-12",
                    debtType="card",
                    target=money("2000"),
                    outstanding=money("10000"),
                )
            ],
            reserve="800",
        ),
    )
    option = client.get("/api/session/options").json()["options"][0]
    assert (option["kind"], option["originalPaise"], option["minimumPaise"]) == (
        "card",
        200000,
        50000,
    )
    preview = submit(
        client, "previewAdjustments", adjustments=[adjustment("card:2026-09-12", "500")]
    )
    accepted = submit(client, "acceptPreview", previewId=preview["preview"]["id"])
    assert accepted["facts"] == baseline["facts"] and accepted["plan"] == baseline["plan"]
    assert accepted["accepted"]["plan"]["reserveShortfallPaise"] == 30000
    assert accepted["accepted"]["plan"]["peakGapPaise"] == 0
    assert accepted["accepted"]["adjustments"] == [
        {**option, "amountPaise": 50000, "acceptedRevision": 2}
    ]


async def test_cancelled_preview_does_not_save_or_publish(store, monkeypatch):
    owner = owner_hash("cancel")
    await store.create(owner)
    baseline = await store.command(owner, parsed_command(scenario_two()))
    queue = await store.subscribe(owner)
    queue.get_nowait()
    db = store.connection()
    execute = db.execute

    def cancel(sql, parameters=None):
        result = execute(sql, parameters)
        if sql.startswith("UPDATE sessions"):

            async def interrupt():
                await result
                raise asyncio.CancelledError

            return interrupt()
        return result

    request = Command.model_validate(operation("previewAdjustments", adjustments=[adjustment()]))
    with monkeypatch.context() as patch:
        patch.setattr(db, "execute", cancel)
        with pytest.raises(asyncio.CancelledError):
            await store.command(owner, request)
    assert await store.get(owner) == baseline
    assert queue.empty() and not db.in_transaction
    assert (await store.command(owner, request)).preview is not None
