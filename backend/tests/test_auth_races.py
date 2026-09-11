# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import sqlite3
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
import pytest

from app.auth import COOKIE, FLOW_COOKIE
from app.auth_models import Access
from app.google import TOKEN, digest
from app.store import Problem
from app.voice_tools import VoiceTools

from .auth_support import auth_app, sign_in_async
from .conftest import NOW, ORIGIN, command, facts, money
from .test_auth import rows
from .test_events import frame
from .test_events import live_server as live_server
from .test_voice import PipelineDouble, RoomsDouble, environment
from .test_voice import provider_doubles as provider_doubles


@pytest.fixture
async def auth_server(config, tmp_path):
    now = [NOW]
    application = auth_app(config, environment(tmp_path), lambda: now[0])
    async with application.router.lifespan_context(application):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url=ORIGIN,
            headers={"Origin": ORIGIN},
        ) as client:
            await sign_in_async(client, application)
            yield application, client, now


async def begin(client, application, subject="google-user-one"):
    response = await client.post("/api/auth/login", json={})
    assert response.status_code == 200
    url = response.json()["url"]
    return {
        "state": parse_qs(urlsplit(url).query)["state"][0],
        "code": application.state.auth.google.code(url, subject),
    }


@pytest.mark.parametrize("logout", [False, True])
@pytest.mark.parametrize("path", ["/api/session", "/api/session/commands"])
async def test_authorized_inflight_requests_cannot_write_after_revocation(
    auth_server, monkeypatch, logout, path
):
    application, client, _ = auth_server
    store = application.state.store
    await client.post("/api/session", json={})
    owner = (await client.get("/api/auth/session")).json()["user"]["id"]
    check = store.check
    reached, release = asyncio.Event(), asyncio.Event()

    async def paused(access):
        await check(access)
        reached.set()
        await release.wait()

    monkeypatch.setattr(store, "check", paused)
    write = asyncio.create_task(
        client.post(path, json=command(facts("123")) if path.endswith("commands") else {})
    )
    await asyncio.wait_for(reached.wait(), 2)
    if logout:
        assert (await client.post("/api/auth/logout", json={})).status_code == 204
    else:
        assert (
            await client.request("DELETE", "/api/account", json={"confirmation": "DELETE"})
        ).status_code == 200
    release.set()
    assert (await write).status_code == 401
    assert not await rows(application, "SELECT * FROM commands")
    if logout:
        assert len(await rows(application, "SELECT * FROM sessions")) == 1
    else:
        assert not await rows(application, "SELECT * FROM sessions")
        with pytest.raises(sqlite3.IntegrityError):
            await store.create(owner)
        assert not await rows(application, "SELECT * FROM auth_users")


async def test_callback_consumed_before_logout_cannot_issue_a_login_afterward(
    auth_server, monkeypatch
):
    application, client, _ = auth_server
    params = await begin(client, application)
    google = application.state.auth.google
    request = google.request
    reached, release = asyncio.Event(), asyncio.Event()

    async def paused(method, url, **kwargs):
        if url == TOKEN:
            reached.set()
            await release.wait()
        return await request(method, url, **kwargs)

    monkeypatch.setattr(google, "request", paused)
    callback = asyncio.create_task(
        client.get("/auth/callback", params=params, follow_redirects=False)
    )
    await asyncio.wait_for(reached.wait(), 2)
    assert (await client.post("/api/auth/logout", json={})).status_code == 204
    release.set()
    response = await callback
    assert response.headers["location"] == "/login?error=failed"
    assert COOKIE not in client.cookies
    assert not await rows(application, "SELECT * FROM auth_sessions")


@pytest.mark.parametrize("anonymous", [False, True])
async def test_callback_started_before_account_deletion_cannot_recreate_identity(
    auth_server, monkeypatch, anonymous
):
    application, client, _ = auth_server
    google = application.state.auth.google
    request = google.request
    reached, release = asyncio.Event(), asyncio.Event()

    async def paused(method, url, **kwargs):
        if url == TOKEN:
            reached.set()
            await release.wait()
        return await request(method, url, **kwargs)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as browser:
        if not anonymous:
            browser.cookies.update(client.cookies)
        params = await begin(browser, application)
        monkeypatch.setattr(google, "request", paused)
        callback = asyncio.create_task(
            browser.get("/auth/callback", params=params, follow_redirects=False)
        )
        await asyncio.wait_for(reached.wait(), 2)
        assert (
            await client.request("DELETE", "/api/account", json={"confirmation": "DELETE"})
        ).status_code == 200
        release.set()
        assert (await callback).headers["location"] == "/login?error=failed"
        assert not await rows(application, "SELECT * FROM auth_users")
        assert not await rows(application, "SELECT * FROM auth_sessions")
        assert not await rows(application, "SELECT * FROM auth_grants")
        browser.cookies.clear()
        await sign_in_async(browser, application)
        assert (await browser.post("/api/session", json={})).json()["facts"]["opening"][
            "amountPaise"
        ] is None


async def test_logout_of_prior_cookie_also_revokes_racing_replacement(auth_server):
    application, client, _ = auth_server
    token = client.cookies[COOKIE]
    params = await begin(client, application)
    binding = client.cookies[FLOW_COOKIE]
    assert (await client.get("/auth/callback", params=params, follow_redirects=False)).headers[
        "location"
    ] == "/app"
    replacement = client.cookies[COOKIE]
    assert replacement != token
    response = await client.post(
        "/api/auth/logout",
        json={},
        headers={"Cookie": f"{COOKIE}={token}; {FLOW_COOKIE}={binding}"},
    )
    assert response.status_code == 204
    assert (
        await client.get("/api/auth/session", headers={"Cookie": COOKIE + "=" + replacement})
    ).status_code == 401
    assert not await rows(application, "SELECT * FROM auth_sessions")


async def test_refresh_network_io_releases_db_and_cannot_commit_after_logout(
    auth_server, monkeypatch
):
    application, client, now = auth_server
    await client.post("/api/session", json={})
    before = await rows(application, "SELECT version, checked FROM auth_grants")
    google = application.state.auth.google
    check = google.check
    reached, release = asyncio.Event(), asyncio.Event()

    async def paused(grant):
        reached.set()
        await release.wait()
        return await check(grant)

    monkeypatch.setattr(google, "check", paused)
    now[0] += timedelta(seconds=300)
    refreshing = asyncio.create_task(client.post("/api/auth/refresh", json={}))
    await asyncio.wait_for(reached.wait(), 2)
    assert not application.state.store.lock.locked()
    response = await asyncio.wait_for(client.post("/api/auth/logout", json={}), 2)
    assert response.status_code == 204
    release.set()
    assert (await refreshing).status_code == 401
    assert await rows(application, "SELECT version, checked FROM auth_grants") == before
    assert len(await rows(application, "SELECT * FROM sessions")) == 1


@pytest.mark.parametrize("delete", [False, True])
async def test_logout_and_account_delete_close_existing_sse_without_financial_delivery(
    live_server, delete
):
    client, store, _ = live_server
    await client.post("/api/session", json={})
    await client.post("/api/session/commands", json=command(facts("12345")))
    token = client.cookies[COOKIE]
    async with client.stream("GET", "/api/session/events") as response:
        lines = response.aiter_lines()
        assert "event: snapshot" in await frame(lines)
        if delete:
            assert (
                await client.request("DELETE", "/api/account", json={"confirmation": "DELETE"})
            ).status_code == 200
        else:
            assert (await client.post("/api/auth/logout", json={})).status_code == 204
        terminal = await frame(lines)
        assert (
            "event: unauthenticated" in terminal
            and "12345" not in terminal
            and "opening" not in terminal
        )
        with pytest.raises(StopAsyncIteration):
            await anext(lines)
    assert not store.listeners and not store.listener_access
    assert (
        await client.get("/api/session/export", headers={"Cookie": COOKIE + "=" + token})
    ).status_code == 401


async def test_expired_sse_login_closes_on_heartbeat(live_server):
    client, store, now = live_server
    await client.post("/api/session", json={})
    async with client.stream("GET", "/api/session/events") as response:
        lines = response.aiter_lines()
        assert "event: snapshot" in await frame(lines)
        now[0] += timedelta(days=7)
        terminal = await frame(lines)
        assert "opening" not in terminal
        assert "unauthenticated" in terminal or "sessionExpired" in terminal
        with pytest.raises(StopAsyncIteration):
            await anext(lines)
    assert not store.listeners


@pytest.mark.parametrize("delete", [False, True])
async def test_voice_ends_and_pending_tools_cannot_mutate_after_revocation(
    auth_server, provider_doubles, monkeypatch, delete
):
    application, client, _ = auth_server
    store, calls = application.state.store, application.state.calls
    await client.post("/api/session", json={})
    response = await client.post("/api/session/call", json={})
    assert response.status_code == 200
    pipeline = PipelineDouble.instances[-1]
    room = RoomsDouble.instances[-1]
    owner = (await client.get("/api/auth/session")).json()["user"]["id"]
    access = Access(owner, digest(client.cookies[COOKIE]))
    tools = VoiceTools(store, access, uuid4(), lambda snapshot: None)
    check = store.check
    reached, release = asyncio.Event(), asyncio.Event()

    async def paused(identity):
        await check(identity)
        reached.set()
        await release.wait()

    monkeypatch.setattr(store, "check", paused)
    writing = asyncio.create_task(
        tools.update_facts({"expectedRevision": 0, "opening": money("999")}, "pending")
    )
    await asyncio.wait_for(reached.wait(), 2)
    if delete:
        response = await client.request("DELETE", "/api/account", json={"confirmation": "DELETE"})
        assert response.status_code == 200
    else:
        assert (await client.post("/api/auth/logout", json={})).status_code == 204
    release.set()
    with pytest.raises(Problem) as error:
        await writing
    assert error.value.status == 401
    assert pipeline.closed and pipeline.snapshot is None and pipeline.tools is None
    assert room.closed and room.deleted == [room.name]
    assert calls.call is None and not store.listeners
    assert not await rows(application, "SELECT * FROM commands")


async def test_account_delete_does_not_touch_another_user_or_their_pending_login(auth_server):
    application, client, _ = auth_server
    await client.post("/api/session", json={})
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as other:
        await sign_in_async(other, application, "google-user-two")
        await other.post("/api/session", json={})
        saved = (await other.post("/api/session/commands", json=command(facts("246")))).json()
        params = await begin(other, application, "google-user-two")
        assert (
            await client.request("DELETE", "/api/account", json={"confirmation": "DELETE"})
        ).status_code == 200
        assert (await other.get("/auth/callback", params=params, follow_redirects=False)).headers[
            "location"
        ] == "/app"
        assert (await other.get("/api/session")).json() == saved
        assert len(await rows(application, "SELECT * FROM sessions")) == 1
        assert len(await rows(application, "SELECT * FROM commands")) == 1


async def test_one_use_flow_is_atomic_across_concurrent_callbacks(auth_server):
    application, client, _ = auth_server
    params = await begin(client, application)
    results = await asyncio.gather(
        *(client.get("/auth/callback", params=params, follow_redirects=False) for _ in range(2))
    )
    assert sum(response.headers["location"] == "/app" for response in results) == 1
    assert not await rows(application, "SELECT * FROM auth_flows")
    assert len(await rows(application, "SELECT * FROM auth_sessions")) <= 1


async def test_auth_cleanup_keeps_live_finance_and_removes_expired_flows(auth_server):
    application, client, now = auth_server
    await client.post("/api/session", json={})
    await begin(client, application)
    now[0] += timedelta(seconds=301)
    await application.state.auth.cleanup()
    assert not await rows(application, "SELECT * FROM auth_flows")
    assert len(await rows(application, "SELECT * FROM auth_sessions")) == 1
    assert len(await rows(application, "SELECT * FROM sessions")) == 1


@pytest.mark.parametrize("delete", [False, True])
async def test_cancelled_commit_cannot_leave_revoked_voice_or_streams_live(
    auth_server, provider_doubles, monkeypatch, delete
):
    application, client, _ = auth_server
    store = application.state.store
    await client.post("/api/session", json={})
    assert (await client.post("/api/session/call", json={})).status_code == 200
    call = application.state.calls.call
    access = call.owner
    queue = await store.subscribe(access)
    queue.get_nowait()
    committed, release = asyncio.Event(), asyncio.Event()
    commit = store.connection().commit

    async def paused_commit():
        await commit()
        committed.set()
        await release.wait()

    monkeypatch.setattr(store.connection(), "commit", paused_commit)
    operation = (
        client.request("DELETE", "/api/account", json={"confirmation": "DELETE"})
        if delete
        else client.post("/api/auth/logout", json={})
    )
    task = asyncio.create_task(operation)
    await asyncio.wait_for(committed.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    release.set()
    assert queue.get_nowait().code == "unauthenticated"
    assert call.revoked and PipelineDouble.instances[-1].snapshot is None
    await asyncio.wait_for(call.task, 2)
    assert application.state.calls.call is None
    assert (await client.get("/api/auth/session")).status_code == 401
