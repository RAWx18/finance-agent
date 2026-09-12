# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import sqlite3
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
import pytest

from app.auth import COOKIE, FLOW_COOKIE, AuthProblem
from app.auth_models import Access
from app.google import TOKEN, GoogleUnavailable, digest
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
    """Provide a signed-in asynchronous app client with isolated storage and a mutable clock."""
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
    """Initiate login and return synthetic callback parameters for the requested Google subject."""
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
    """Verify requests authorized before logout or deletion cannot commit writes afterward."""
    application, client, _ = auth_server
    store = application.state.store
    await client.post("/api/session", json={})
    owner = (await client.get("/api/auth/session")).json()["user"]["id"]
    check = store.check
    reached, release = asyncio.Event(), asyncio.Event()

    async def paused(access):
        """Pause after authorization so revocation can race with the pending write."""
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
    """Verify logout invalidates a consumed callback still awaiting its token exchange."""
    application, client, _ = auth_server
    params = await begin(client, application)
    google = application.state.auth.google
    request = google.request
    reached, release = asyncio.Event(), asyncio.Event()

    async def paused(method, url, **kwargs):
        """Hold the token exchange until logout has invalidated the pending login."""
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
    """Verify an in-flight callback cannot recreate an account deleted during token exchange."""
    application, client, _ = auth_server
    google = application.state.auth.google
    request = google.request
    reached, release = asyncio.Event(), asyncio.Event()

    async def paused(method, url, **kwargs):
        """Hold token exchange while another browser deletes the account."""
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
    """Verify logout using a prior cookie also revokes its racing replacement login."""
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
    """Verify grant rechecks release the database lock and cannot commit after logout."""
    application, client, now = auth_server
    await client.post("/api/session", json={})
    before = await rows(application, "SELECT version, checked FROM auth_grants")
    google = application.state.auth.google
    check = google.check
    reached, release = asyncio.Event(), asyncio.Event()

    async def paused(grant):
        """Hold the provider grant check so logout can complete during network work."""
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
    """Verify revocation closes active event streams without delivering financial data."""
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
            ("event: accountDeleted" if delete else "event: unauthenticated") in terminal
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
    """Verify a stream heartbeat detects expired login and releases its listener."""
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
    """Verify revocation tears down voice resources and blocks pending tool writes."""
    application, client, _ = auth_server
    store, calls = application.state.store, application.state.calls
    await client.post("/api/session", json={})
    response = await client.post("/api/session/call", json={"callId": str(uuid4())})
    assert response.status_code == 200
    pipeline = PipelineDouble.instances[-1]
    room = RoomsDouble.instances[-1]
    owner = (await client.get("/api/auth/session")).json()["user"]["id"]
    access = Access(owner, digest(client.cookies[COOKIE]))
    tools = VoiceTools(store, access, uuid4(), lambda snapshot: None)
    check = store.check
    reached, release = asyncio.Event(), asyncio.Event()

    async def paused(identity):
        """Pause an authorized voice-tool write until account access is revoked."""
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


@pytest.mark.parametrize("expire", [False, True])
@pytest.mark.parametrize("stage", ["preflight", "room", "token", "pipeline", "join", "result"])
async def test_voice_startup_auth_loss_returns_401_and_closes_resources(
    auth_server, provider_doubles, monkeypatch, stage, expire
):
    """Verify authentication loss at every voice startup stage returns 401 and closes resources."""
    application, client, now = auth_server
    store, calls = application.state.store, application.state.calls
    await client.post("/api/session", json={})
    reached, release = asyncio.Event(), asyncio.Event()
    if stage in {"join", "result"}:
        check = store.check

        async def paused(access):
            """Pause authorization at the selected call-join or response-delivery boundary."""
            await check(access)
            call = calls.call
            if call and (
                stage == "result"
                and call.join.done()
                and asyncio.current_task() is starting
                or stage == "join"
                and asyncio.current_task() is call.task
                and getattr(call.pipeline, "snapshot", None) is not None
            ):
                reached.set()
                await release.wait()

        monkeypatch.setattr(store, "check", paused)
    else:
        target, name = {
            "preflight": ("app.voice", "check_voice"),
            "room": (RoomsDouble, "create"),
            "token": (RoomsDouble, "token"),
            "pipeline": (PipelineDouble, "start"),
        }[stage]
        if stage == "preflight":
            from app.voice import check_voice

            operation = check_voice
        else:
            operation = getattr(target, name)

        async def paused(*args):
            """Pause after the selected provider startup operation has completed."""
            result = await operation(*args)
            reached.set()
            await release.wait()
            return result

        if isinstance(target, str):
            monkeypatch.setattr(target + "." + name, paused)
        else:
            monkeypatch.setattr(target, name, paused)
    starting = asyncio.create_task(client.post("/api/session/call", json={"callId": str(uuid4())}))
    await asyncio.wait_for(reached.wait(), 2)
    call = calls.call
    assert isinstance(call.owner, Access)
    if expire:
        now[0] += timedelta(hours=24)
    else:
        assert (await client.post("/api/auth/logout", json={})).status_code == 204
    release.set()
    response = await asyncio.wait_for(starting, 2)
    assert response.status_code == 401
    assert response.json() == {
        "code": "sessionExpired" if expire else "unauthenticated",
        "message": "Sign in to continue.",
        "snapshot": None,
    }
    assert call.task.done() and call.join.done()
    if stage != "result":
        assert isinstance(call.join.exception(), AuthProblem)
        assert call.join.exception().status == 401
    assert PipelineDouble.instances[-1].closed
    assert all(room.closed and room.deleted == [room.name] for room in RoomsDouble.instances)
    assert not store.listeners and not store.listener_access and calls.call is None
    assert (await client.get("/api/session/call")).status_code == 401
    assert not await rows(application, "SELECT * FROM commands")


@pytest.mark.parametrize("target", ["router", "tool"])
async def test_voice_state_reads_keep_locked_auth_guard_after_precheck(
    auth_server, monkeypatch, target
):
    """Verify voice status and tool reads recheck revoked access after their initial precheck."""
    application, client, _ = auth_server
    store = application.state.store
    await client.post("/api/session", json={})
    access = Access(
        (await client.get("/api/auth/session")).json()["user"]["id"], digest(client.cookies[COOKIE])
    )
    check = store.check
    reached, release = asyncio.Event(), asyncio.Event()

    async def paused(identity):
        """Pause a validated access identity before the protected state read."""
        assert isinstance(identity, Access)
        await check(identity)
        reached.set()
        await release.wait()

    monkeypatch.setattr(store, "check", paused)
    tools = VoiceTools(store, access, uuid4(), lambda snapshot: None)
    reading = asyncio.create_task(
        client.get("/api/session/call") if target == "router" else tools.read_state()
    )
    await asyncio.wait_for(reached.wait(), 2)
    assert (await client.post("/api/auth/logout", json={})).status_code == 204
    release.set()
    if target == "router":
        response = await asyncio.wait_for(reading, 2)
        assert response.status_code == 401 and "callId" not in response.text
    else:
        with pytest.raises(AuthProblem) as error:
            await asyncio.wait_for(reading, 2)
        assert error.value.status == 401


async def test_account_delete_does_not_touch_another_user_or_their_pending_login(auth_server):
    """Verify deleting an account preserves another user's finances and pending login flow."""
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
    """Verify concurrent callbacks consume a one-use flow at most once."""
    application, client, _ = auth_server
    params = await begin(client, application)
    results = await asyncio.gather(
        *(client.get("/auth/callback", params=params, follow_redirects=False) for _ in range(2))
    )
    assert sum(response.headers["location"] == "/app" for response in results) == 1
    assert not await rows(application, "SELECT * FROM auth_flows")
    assert len(await rows(application, "SELECT * FROM auth_sessions")) <= 1


async def test_transient_provider_outage_at_recheck_keeps_voice_tools_working(auth_server):
    """Verify a voice tool write during a Google outage at recheck time still commits in grace."""
    application, client, now = auth_server
    store = application.state.store
    google = application.state.auth.google
    await client.post("/api/session", json={})
    access = Access(
        (await client.get("/api/auth/session")).json()["user"]["id"], digest(client.cookies[COOKIE])
    )
    tools = VoiceTools(store, access, uuid4(), lambda snapshot: None)
    tools.user_turn = "I have 200 rupees."
    now[0] += timedelta(seconds=300)
    google.failure = GoogleUnavailable()
    result = await tools.invoke(
        "update_facts", {"expectedRevision": 0, "opening": money("200")}, "during-outage"
    )
    assert result["saved"] is True
    assert (await store.get(access)).facts.opening.amount_paise == 20000
    now[0] += timedelta(seconds=60)
    late = await tools.invoke("read_state", {}, "after-grace")
    assert late["code"] == "authUnavailable"
    google.failure = None
    assert "code" not in await tools.invoke("read_state", {}, "recovered")


async def test_auth_cleanup_keeps_live_finance_and_removes_expired_flows(auth_server):
    """Verify authentication cleanup removes expired flows without deleting live sessions."""
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
    """Verify cancellation after revocation commits still shuts down voice and event streams."""
    application, client, _ = auth_server
    store = application.state.store
    await client.post("/api/session", json={})
    response = await client.post("/api/session/call", json={"callId": str(uuid4())})
    assert response.status_code == 200
    call = application.state.calls.call
    access = call.owner
    queue = await store.subscribe(access)
    queue.get_nowait()
    committed, release = asyncio.Event(), asyncio.Event()
    commit = store.connection().commit

    async def paused_commit():
        """Pause after committing revocation to expose cancellation before cleanup returns."""
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


async def test_clean_end_and_logout_preserve_figures_and_receipts(auth_server, provider_doubles):
    """Verify clean call ending and logout preserve financial facts and command receipts."""
    application, client, _ = auth_server
    await client.post("/api/session", json={})
    submitted = command(facts("1234.56"))
    saved = (await client.post("/api/session/commands", json=submitted)).json()
    receipts = await rows(application, "SELECT * FROM commands")
    first = {"callId": str(uuid4())}
    assert (await client.post("/api/session/call", json=first)).status_code == 200
    current = (await client.get("/api/session")).json()
    assert current["facts"] == saved["facts"] and current["plan"] == saved["plan"]
    ended = await client.request("DELETE", "/api/session/call", json=first)
    assert ended.json()["cleanupConfirmed"] is True
    assert (await client.get("/api/session")).json() == current
    second = {"callId": str(uuid4())}
    assert (await client.post("/api/session/call", json=second)).status_code == 200
    current = (await client.get("/api/session")).json()
    assert current["facts"] == saved["facts"] and current["plan"] == saved["plan"]
    call = application.state.calls.call
    stale = await client.request("DELETE", "/api/session/call", json=first)
    assert stale.json()["callId"] == first["callId"] and not call.stop.is_set()
    assert (await client.get("/api/session/call")).json()["callId"] == second["callId"]
    assert (await client.post("/api/auth/logout", json={})).status_code == 204
    assert call.revoked and call.state.cleanup_confirmed
    assert (await client.post("/api/session/call", json=second)).status_code == 401
    await sign_in_async(client, application)
    assert (await client.get("/api/session")).json() == current
    retry = await client.post("/api/session/commands", json=submitted)
    assert retry.status_code == 409 and retry.json()["code"] == "conversationChanged"
    assert await rows(application, "SELECT * FROM commands") == receipts
