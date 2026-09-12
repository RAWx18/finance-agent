# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import timedelta
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4
from zoneinfo import TZPATH, ZoneInfo, reset_tzpath

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.auth import COOKIE
from app.config import Environment
from app.main import create_app

from .auth_support import auth_app, sign_in
from .conftest import NOW, ORIGIN, command, facts, record
from .test_finance import scenario_two


def test_real_edit_review_export_and_delete(client):
    """Verify session creation, fact editing, export, replay, and deletion through the API."""
    assert client.get("/health/live").json() == {"status": "ok"}
    assert client.get("/health/ready").status_code == 200
    settings = client.get("/api/settings").json()
    assert settings["voiceAvailable"] is False and settings["today"] == "2026-09-11"
    assert client.get("/api/session").status_code == 404
    created = client.post("/api/session", json={})
    assert created.status_code == 200
    assert "set-cookie" not in created.headers
    snapshot = created.json()
    assert snapshot["revision"] == 0 and snapshot["anchorDate"] == "2026-09-11"
    assert client.post("/api/session", json={}).json() == snapshot
    submitted = command(scenario_two())
    changed = client.post("/api/session/commands", json=submitted)
    assert changed.status_code == 200
    snapshot = changed.json()
    assert snapshot["plan"]["closingPaise"] == 1000000
    assert snapshot["revision"] == snapshot["sequence"] == 1
    assert snapshot["facts"]["opening"]["amountPaise"] == 500000
    assert client.get("/api/session").json() == snapshot
    exported = client.get("/api/session/export")
    assert exported.headers["content-type"].startswith("text/plain")
    assert exported.headers["x-content-type-options"] == "nosniff"
    assert "attachment" in exported.headers["content-disposition"]
    assert "INR 10000.00" in exported.text and "2026-09-13, INR 7000.00" in exported.text
    assert "INR 16000.00" in exported.text and "No payments have been executed" in exported.text
    assert client.post("/api/session/commands", json=submitted).json() == snapshot
    assert client.delete("/api/session").json() == {"deleted": True}
    assert COOKIE in client.cookies
    assert client.get("/api/session").status_code == 404
    assert client.delete("/api/session").status_code == 200


def test_stale_draft_and_idempotency_do_not_replace_newer_state(client):
    """Verify stale commands and replayed requests cannot overwrite newer session facts."""
    client.post("/api/session", json={})
    first = command(facts("10"))
    result = client.post("/api/session/commands", json=first).json()
    second = client.post("/api/session/commands", json=command(facts("20"), 1)).json()
    assert second["revision"] == 2
    assert client.post("/api/session/commands", json=first).json() == result
    assert client.get("/api/session").json() == second
    stale = command(facts("999"))
    response = client.post("/api/session/commands", json=stale)
    assert response.status_code == 409 and response.json()["snapshot"] == second
    assert stale["operation"]["facts"]["opening"]["amount"] == "999"
    first["operation"]["facts"]["opening"]["amount"] = "30"
    response = client.post("/api/session/commands", json=first)
    assert response.status_code == 409 and response.json()["code"] == "commandConflict"


def test_sessions_are_cookie_owned_not_session_id(client):
    """Verify authenticated cookies enforce session ownership regardless of supplied IDs."""
    first = client.post("/api/session", json={}).json()
    token = client.cookies[COOKIE]
    client.post("/api/session/commands", json=command(facts("100")))
    client.cookies.clear()
    assert client.get("/api/session", params={"sessionId": first["sessionId"]}).status_code == 401
    sign_in(client, "google-user-two")
    second = client.post("/api/session", json={}).json()
    assert second["sessionId"] != first["sessionId"]
    assert second["facts"]["opening"]["amountPaise"] is None
    client.delete("/api/session")
    client.cookies.clear()
    client.cookies.set(COOKIE, token)
    assert client.get("/api/session").json()["facts"]["opening"]["amountPaise"] == 10000


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": "https://evil.example"},
        {"Origin": "null"},
        {"Host": "evil.example"},
        {"Sec-Fetch-Site": "cross-site"},
        {"Sec-Fetch-Site": "same-site"},
    ],
)
def test_csrf_and_host_rejection(client, headers):
    """Verify unsafe origins, fetch-site metadata, and hosts cannot mutate sessions."""
    assert client.post("/api/session", json={}, headers=headers).status_code == 403
    assert client.delete("/api/session", headers=headers).status_code == 403


def test_json_validation_and_size_boundary(client, config):
    """Verify invalid media types, oversized bodies, and malformed facts fail without leaks."""
    assert client.post("/api/session", content="{}").status_code == 415
    assert client.post("/api/session", json={"extra": 1}).status_code == 422
    assert (
        client.post(
            "/api/session", content="x", headers={"Content-Type": "application/json"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/session",
            content=" " * (config.max_request_bytes + 1),
            headers={"Content-Type": "application/json"},
        ).status_code
        == 413
    )
    client.post("/api/session", json={}, headers={"Origin": ORIGIN})
    invalid = command(facts("1.001"))
    response = client.post("/api/session/commands", json=invalid)
    assert response.status_code == 422 and "1.001" not in response.text
    assert set(response.json()) == {"code", "message"}
    assert client.get("/api/session").json()["revision"] == 0


def test_expiry_anchor_and_restart(tmp_path, config):
    """Verify day refresh and restart preserve session state until its fixed expiry."""
    now = [NOW]
    environment = Environment(data_dir=tmp_path)
    application = auth_app(config, environment, lambda: now[0])
    with TestClient(application, base_url=ORIGIN) as client:
        sign_in(client)
        snapshot = client.post("/api/session", json={}).json()
        token = client.cookies[COOKIE]
        submitted = command(facts("123.45"))
        result = client.post("/api/session/commands", json=submitted).json()
        now[0] += timedelta(hours=18)
        assert client.get("/api/settings").json()["today"] == "2026-09-12"
        refreshed = client.get("/api/session").json()
        assert refreshed["anchorDate"] == snapshot["anchorDate"]
        assert refreshed["revision"] == result["revision"]
        assert refreshed["sequence"] == result["sequence"] + 1
        assert refreshed["plan"]["evaluatedOn"] == "2026-09-12"
        assert refreshed["facts"] == result["facts"]
        assert client.post("/api/auth/refresh", json={}).status_code == 200
    with TestClient(
        auth_app(config, environment, lambda: now[0], google=application.state.auth.google),
        base_url=ORIGIN,
        headers={"Origin": ORIGIN},
    ) as client:
        client.cookies.set(COOKIE, token, domain="localhost.local", path="/")
        assert client.get("/api/session").json() == refreshed
        assert client.post("/api/session/commands", json=submitted).json() == result
        now[0] = NOW + timedelta(hours=24)
        assert client.get("/api/session").status_code == 410
        assert client.get("/api/session").status_code == 404
        fresh = client.post("/api/session", json={}).json()
        assert fresh["sessionId"] != snapshot["sessionId"]
        assert fresh["facts"]["opening"]["amountPaise"] is None
        assert client.cookies[COOKIE] == token


def test_secure_cookie_and_config_errors(tmp_path, config):
    """Verify staging cookies are secure and invalid deployment or finance settings fail."""
    environment = Environment(
        data_dir=tmp_path, app_env="staging", public_origin="https://finance.example"
    )
    with TestClient(auth_app(config, environment), base_url="https://finance.example") as client:
        assert "Secure" in sign_in(client).headers["set-cookie"]
        assert "Secure" in client.post("/api/auth/logout", json={}).headers["set-cookie"]
    for origin in (
        "ftp://localhost",
        "http://localhost/path",
        "http://user:pass@localhost",
        "http://localhost:bad",
    ):
        with pytest.raises(ValidationError):
            Environment(public_origin=origin)
    with pytest.raises(ValidationError):
        Environment(app_env="staging")
    for field, value in (("currency", "USD"), ("timezone", "UTC"), ("horizon_days", 31)):
        with pytest.raises(ValidationError):
            type(config).model_validate({**config.model_dump(), field: value})


def test_static_spa_paths_and_api_never_fall_back(tmp_path, config):
    """Verify protected SPA redirects and unknown routes never expose fallback files."""
    static = tmp_path / "dist"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html><title>Finance</title>")
    (tmp_path / "private.txt").write_text("private")
    with TestClient(
        create_app(config, Environment(data_dir=tmp_path / "data"), static_dir=static),
        base_url=ORIGIN,
    ) as client:
        assert client.get("/", follow_redirects=False).headers["location"] == "/login"
        assert client.get("/login").status_code == 200
        assert client.get("/review").status_code == 404
        for path in (
            "/app",
            "/money",
            "/money/income",
            "/money/spending",
            "/money/debts",
            "/money/upcoming",
            "/money/changes",
            "/account",
            "/history",
        ):
            response = client.get(path, follow_redirects=False)
            assert response.status_code == 303
            assert response.headers["location"] == f"/login?returnTo={path}"
        assert client.get("/api/missing").status_code == 401
        assert client.get("/api/session/call").status_code == 401
        for path in (
            "/health/missing",
            "/missing.js",
            "/%2e%2e/private.txt",
        ):
            assert client.get(path).status_code == 404
        assert "frame-ancestors 'none'" in client.get("/").headers["content-security-policy"]


@pytest.mark.parametrize(
    "path",
    [
        "/app",
        "/money",
        "/money/income",
        "/money/spending",
        "/money/debts",
        "/money/upcoming",
        "/money/changes",
        "/account",
        "/history",
    ],
)
def test_protected_spa_signin_roundtrip_and_expiry(tmp_path, config, path):
    """Verify protected pages retain their return path through sign-in and idle expiry."""
    static = tmp_path / "dist"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html><title>Finance</title>")
    now = [NOW]
    application = auth_app(
        config, Environment(data_dir=tmp_path / "data"), lambda: now[0], static_dir=static
    )
    with TestClient(application, base_url=ORIGIN) as client:
        for headers in ({}, {"Cookie": COOKIE + "=malformed"}):
            response = client.get(path, headers=headers, follow_redirects=False)
            assert response.status_code == 303
            assert response.headers["location"] == f"/login?returnTo={path}"
        response = client.get(response.headers["location"])
        assert response.status_code == 200
        assert response.text == (static / "index.html").read_text()
        return_to = parse_qs(urlsplit(str(response.url)).query)["returnTo"][0]
        assert return_to == path
        response = sign_in(client, return_to=return_to)
        response = client.get(response.headers["location"], follow_redirects=False)
        assert response.status_code == 200
        assert response.text == (static / "index.html").read_text()
        assert response.headers["cache-control"] == "no-store"
        assert client.get("/", follow_redirects=False).headers["location"] == "/app"
        assert client.get("/login", follow_redirects=False).status_code == 200
        now[0] += timedelta(hours=config.auth.idle_hours + 1)
        response = client.get(path, follow_redirects=False)
        assert response.status_code == 303
        assert response.headers["location"] == f"/login?returnTo={path}"


@pytest.mark.parametrize("authenticated", [False, True])
@pytest.mark.parametrize(
    "path",
    [
        "/money/",
        "/money/unknown",
        "/money/income/",
        "/money/income/details",
        "/money/incomes",
        "/money//income",
        "/money/Income",
        "/Money",
        "/moneyish",
        "/money-income",
        "/figures",
    ],
)
def test_unknown_money_spa_paths_never_serve_html(tmp_path, config, path, authenticated):
    """Verify unknown money routes return not-found errors regardless of authentication."""
    static = tmp_path / "dist"
    (static / "money").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html><title>Finance</title>")
    (static / "money" / "unknown").write_text("Not a route")
    application = auth_app(
        config, Environment(data_dir=tmp_path / "data"), lambda: NOW, static_dir=static
    )
    with TestClient(application, base_url=ORIGIN) as client:
        if authenticated:
            sign_in(client)
        response = client.get(path, follow_redirects=False)
        assert response.status_code == 404
        assert response.json()["code"] == "notFound"
        assert "location" not in response.headers


def test_export_labels_cannot_be_html_or_header_injection(client):
    """Verify exports containing script-like labels remain non-sniffable text attachments."""
    client.post("/api/session", json={})
    data = facts("0", [record("label", "essential", "1", None, label="<script>alert(1)</script>")])
    assert client.post("/api/session/commands", json=command(data)).status_code == 200
    response = client.get("/api/session/export")
    assert response.headers["content-type"].startswith("text/plain")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "attachment" in response.headers["content-disposition"]


def test_schema_and_import_have_no_database_side_effect(tmp_path, config):
    """Verify app and schema construction avoid storage writes and expose strict contracts."""
    data_dir = tmp_path / "absent"
    application = create_app(config, Environment(data_dir=data_dir))
    assert not data_dir.exists()
    schema = application.openapi()
    assert not data_dir.exists()
    assert "commandId" in schema["components"]["schemas"]["Command"]["properties"]
    assert schema["components"]["schemas"]["Command"]["additionalProperties"] is False
    assert "snapshot" in schema["components"]["schemas"]["Error"]["properties"]
    assert set(schema["paths"]["/api/session/call"]) == {"get", "post", "delete"}
    for method in ("post", "delete"):
        body = schema["paths"]["/api/session/call"][method]["requestBody"]
        assert body["required"] is True
        assert body["content"]["application/json"]["schema"] == {
            "$ref": "#/components/schemas/CallRequest"
        }
    request = schema["components"]["schemas"]["CallRequest"]
    assert request["required"] == ["callId"]
    assert request["properties"]["callId"]["format"] == "uuid"
    assert request["additionalProperties"] is False
    assert {"voiceStartupSeconds", "voiceShutdownSeconds"} <= set(
        schema["components"]["schemas"]["Settings"]["required"]
    )


def test_call_identity_and_deadline_contract(client, config):
    """Verify call requests enforce identity, expose deadlines, and retain ended-call state."""
    client.post("/api/session", json={})
    for method in ("POST", "DELETE"):
        for body in ({}, {"callId": "invalid"}, {"callId": str(uuid4()), "extra": True}):
            assert client.request(method, "/api/session/call", json=body).status_code == 422
    assert client.delete("/api/session/call").status_code == 415
    settings = client.get("/api/settings").json()
    assert settings["voiceStartupSeconds"] == config.voice.startup_seconds
    assert settings["voiceShutdownSeconds"] == config.voice.shutdown_seconds
    body = {"callId": str(uuid4())}
    response = client.request("DELETE", "/api/session/call", json=body)
    assert response.json() == {
        **body,
        "conversationSlug": None,
        "status": "ended",
        "cleanupConfirmed": True,
        "message": None,
    }
    assert client.request("DELETE", "/api/session/call", json=body).json() == response.json()
    assert client.post("/api/session/call", json=body).json()["code"] == "callEnded"


def test_timezone_works_without_system_zoneinfo():
    """Verify Kolkata timezone resolution works without a system zoneinfo search path."""
    reset_tzpath([])
    try:
        assert NOW.astimezone(ZoneInfo.no_cache("Asia/Kolkata")).utcoffset() == timedelta(
            hours=5, minutes=30
        )
    finally:
        reset_tzpath(TZPATH)
