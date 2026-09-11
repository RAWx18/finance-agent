# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
import socket
from datetime import timedelta

import httpx
import pytest
import uvicorn

from app.config import Environment
from app.models import Snapshot
from app.voice_tools import canonical

from .auth_support import auth_app, sign_in_async
from .conftest import NOW, command, facts, record
from .test_adjustments import adjustment
from .test_finance import scenario_two
from .test_scenarios import operation


@pytest.fixture
async def live_server(tmp_path, config):
    started = asyncio.Event()
    now = [NOW]
    config = config.model_copy(update={"heartbeat_seconds": 1, "cleanup_seconds": 1})

    class Server(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets)
            started.set()

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        origin = f"http://127.0.0.1:{listener.getsockname()[1]}"
        application = auth_app(
            config, Environment(data_dir=tmp_path, public_origin=origin), lambda: now[0]
        )
        server = Server(
            uvicorn.Config(application, log_level="error", access_log=False, proxy_headers=False)
        )
        task = asyncio.create_task(server.serve(sockets=[listener]))
        await asyncio.wait_for(started.wait(), 5)
        try:
            async with httpx.AsyncClient(base_url=origin, timeout=5) as client:
                await sign_in_async(client, application)
                yield client, application.state.store, now
        finally:
            server.should_exit = True
            await asyncio.wait_for(task, 5)


async def frame(lines):
    result = []
    while True:
        line = await asyncio.wait_for(anext(lines), 5)
        if not line and result:
            return "\n".join(result)
        result.append(line)


async def test_live_sse_current_reconnect_heartbeat_and_delete(live_server):
    client, store, _ = live_server
    assert (await client.post("/api/session", json={})).status_code == 200
    async with client.stream("GET", "/api/session/events") as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        lines = response.aiter_lines()
        initial = await frame(lines)
        assert "event: snapshot\nid: 0\n" in initial
        assert json.loads(initial.split("data: ")[1])["revision"] == 0
        assert await frame(lines) == ": heartbeat"
        result = await client.post("/api/session/commands", json=command(facts("12.34")))
        assert result.status_code == 200
        changed = await frame(lines)
        assert "event: snapshot\nid: 1\n" in changed
        assert json.loads(changed.split("data: ")[1]) == result.json()
    async with client.stream(
        "GET", "/api/session/events", headers={"Last-Event-ID": "0"}
    ) as response:
        lines = response.aiter_lines()
        assert "id: 1" in await frame(lines)
        assert (await client.delete("/api/session")).status_code == 200
        terminal = await frame(lines)
        assert "event: deleted" in terminal and "opening" not in terminal
        with pytest.raises(StopAsyncIteration):
            await anext(lines)
    assert not store.listeners
    assert (await client.get("/api/session/events")).status_code == 404


async def test_live_expiry_closes_stream_and_cleans_database(live_server):
    client, store, now = live_server
    await client.post("/api/session", json={})
    await client.post("/api/session/commands", json=command(facts("42")))
    async with client.stream("GET", "/api/session/events") as response:
        lines = response.aiter_lines()
        assert "event: snapshot" in await frame(lines)
        now[0] += timedelta(hours=18)
        assert (await client.post("/api/auth/refresh", json={})).status_code == 200
        now[0] += timedelta(hours=6)
        terminal = await frame(lines)
        assert "event: expired" in terminal
        assert "opening" not in terminal
    assert not store.listeners
    async with store.connection().execute("SELECT COUNT(*) FROM commands") as cursor:
        assert (await cursor.fetchone())[0] == 0


async def test_live_sse_clock_rollover_persists_once_without_rebasing(live_server):
    client, store, now = live_server
    await client.post("/api/session", json={})
    request = command(facts("100", [record("purchase", "optional", "200", "2026-09-11")]))
    baseline = (await client.post("/api/session/commands", json=request)).json()
    assert (baseline["revision"], baseline["sequence"]) == (1, 1)
    assert baseline["plan"]["decisionAssessment"]["choices"]
    async with client.stream("GET", "/api/session/events") as response:
        lines = response.aiter_lines()
        assert json.loads((await frame(lines)).split("data: ")[1]) == baseline
        now[0] += timedelta(hours=18)
        rollover = await frame(lines)
        assert "event: snapshot\nid: 2\n" in rollover
        refreshed = json.loads(rollover.split("data: ")[1])
        assert (refreshed["revision"], refreshed["sequence"]) == (1, 2)
        assert refreshed["plan"]["evaluatedOn"] == "2026-09-12"
        for field in ("facts", "asOf", "anchorDate", "endDateExclusive", "createdAt", "expiresAt"):
            assert refreshed[field] == baseline[field]
        for field in ("events", "closingPaise", "outflowPaise", "peakGapPaise"):
            assert refreshed["plan"][field] == baseline["plan"][field]
        assessment = refreshed["plan"]["decisionAssessment"]
        assert not assessment["choices"]
        selected = next(a for a in assessment["actions"] if a["id"] == assessment["nextActionId"])
        assert selected["kind"] == "reconcileStatus"
        assert await frame(lines) == ": heartbeat"
    async with client.stream(
        "GET", "/api/session/events", headers={"Last-Event-ID": "2"}
    ) as response:
        assert json.loads((await frame(response.aiter_lines())).split("data: ")[1]) == refreshed
    assert (await client.get("/api/session")).json() == refreshed
    state = canonical(Snapshot.model_validate(refreshed))
    assert state["activeAssessment"] == assessment
    exported = await client.get("/api/session/export")
    assert exported.status_code == 200
    assert selected["question"] in exported.text
    assert (await client.post("/api/session/commands", json=request)).json() == baseline
    assert (await client.get("/api/session")).json() == refreshed
    async with store.connection().execute("SELECT snapshot FROM sessions") as cursor:
        assert json.loads((await cursor.fetchone())[0]) == refreshed
    async with store.connection().execute("SELECT result FROM commands") as cursor:
        assert json.loads((await cursor.fetchone())[0]) == baseline


async def test_live_chunked_body_limit(live_server):
    client, store, _ = live_server

    async def body():
        yield b" " * (store.config.max_request_bytes // 2)
        yield b" " * store.config.max_request_bytes

    response = await client.post(
        "/api/session", content=body(), headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 413 and response.json()["code"] == "payloadLimit"


async def test_live_sse_scenario_commands_publish_full_snapshots(live_server):
    client, _, _ = live_server
    await client.post("/api/session", json={})
    baseline = (await client.post("/api/session/commands", json=command(scenario_two()))).json()
    async with client.stream("GET", "/api/session/events") as response:
        lines = response.aiter_lines()
        assert json.loads((await frame(lines)).split("data: ")[1]) == baseline
        preview = (
            await client.post(
                "/api/session/commands",
                json=operation("previewAdjustments", adjustments=[adjustment()]),
            )
        ).json()
        assert json.loads((await frame(lines)).split("data: ")[1]) == preview
        assert (preview["revision"], preview["sequence"]) == (1, 2)
        accepted = (
            await client.post(
                "/api/session/commands",
                json=operation("acceptPreview", previewId=preview["preview"]["id"]),
            )
        ).json()
        assert json.loads((await frame(lines)).split("data: ")[1]) == accepted
        assert (accepted["revision"], accepted["sequence"]) == (2, 3)
        cleared = (
            await client.post("/api/session/commands", json=operation("clearAccepted", 2))
        ).json()
        assert json.loads((await frame(lines)).split("data: ")[1]) == cleared
        assert (cleared["revision"], cleared["sequence"]) == (3, 4)
        assert cleared["facts"] == baseline["facts"] and cleared["plan"] == baseline["plan"]
    async with client.stream("GET", "/api/session/events") as response:
        assert json.loads((await frame(response.aiter_lines())).split("data: ")[1]) == cleared
