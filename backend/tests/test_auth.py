# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import json
import logging
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

from app.auth import COOKIE, FLOW_COOKIE
from app.config import Environment
from app.google import TOKEN, GoogleUnavailable, digest
from app.main import CallbackLogFilter, create_app
from app.store import owner_hash

from .auth_support import KEY, auth_app, browser_app, sign_in
from .conftest import NOW, ORIGIN, command, facts


async def rows(application, sql, parameters=()):
    """Fetch database rows while holding the application's store lock."""
    store = application.state.store
    async with store.lock, store.connection().execute(sql, parameters) as cursor:
        return list(await cursor.fetchall())


def query(client, sql, parameters=()):
    """Run a locked database query through the synchronous test client's async portal."""
    return client.portal.call(rows, client.app, sql, parameters)


@pytest.fixture
def auth_client(tmp_path, config):
    """Provide an isolated auth client, synthetic Google provider, and mutable clock."""
    now = [NOW]
    application = auth_app(config, Environment(data_dir=tmp_path), lambda: now[0])
    with TestClient(application, base_url=ORIGIN, headers={"Origin": ORIGIN}) as client:
        yield client, application.state.auth.google, now


def begin(client, subject="google-user-one", return_to="/app"):
    """Start a login flow and provide a synthetic authorization code with its state."""
    response = client.post("/api/auth/login", json={"returnTo": return_to})
    assert response.status_code == 200, response.text
    url = response.json()["url"]
    code = client.app.state.auth.google.code(url, subject)
    return {"code": code, "state": parse_qs(urlsplit(url).query)["state"][0]}, response


def callback(client, params):
    """Submit OAuth callback parameters without following the resulting redirect."""
    return client.get("/auth/callback", params=params, follow_redirects=False)


def test_missing_google_setup_starts_healthy_without_anonymous_access(tmp_path, config):
    """Verify missing Google setup preserves health checks but blocks login and anonymous data."""
    with TestClient(
        create_app(config, Environment(data_dir=tmp_path)),
        base_url=ORIGIN,
        headers={"Origin": ORIGIN},
    ) as client:
        assert (
            client.get("/health/live").status_code == client.get("/health/ready").status_code == 200
        )
        assert client.get("/api/auth/settings").json() == {
            "googleAvailable": False,
            "sessionHours": 168,
        }
        response = client.post("/api/auth/login", json={})
        assert response.status_code == 503 and response.json()["code"] == "authUnavailable"
        assert "GOOGLE" not in response.text and "ENCRYPTION" not in response.text
        for path in (
            "/api/auth/session",
            "/api/settings",
            "/api/session",
            "/api/session/events",
            "/api/session/export",
            "/api/session/call",
            "/api/missing",
        ):
            result = client.get(path)
            assert result.status_code == 401 and result.json() == {
                "code": "unauthenticated",
                "message": "Sign in to continue.",
                "snapshot": None,
            }
        assert client.post("/api/session", json={}).status_code == 401
        assert client.post("/api/session/commands", json=command(facts("999"))).status_code == 401
        assert not query(client, "SELECT * FROM sessions")


@pytest.mark.parametrize("key", ["not-a-key", "a" * 44, "é" * 44, KEY + "\n"])
def test_encryption_key_validation(key):
    """Verify malformed encryption values are rejected as invalid Fernet keys."""
    with pytest.raises(ValidationError, match="Fernet key"):
        Environment(auth_encryption_key=SecretStr(key))


def test_empty_auth_environment_values_leave_login_unavailable(tmp_path, config, monkeypatch):
    """Verify empty authentication environment values leave a healthy app with login disabled."""
    for key in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "AUTH_ENCRYPTION_KEY"):
        monkeypatch.setenv(key, "")
    environment = Environment.load().model_copy(update={"data_dir": tmp_path})
    with TestClient(create_app(config, environment), base_url=ORIGIN) as client:
        assert client.get("/health/ready").status_code == 200
        assert client.get("/api/auth/settings").json()["googleAvailable"] is False


def test_google_environment_names_and_secrets_are_separate(monkeypatch):
    """Verify Google environment values load without exposing secrets in repr."""
    for key, value in {
        "GOOGLE_CLIENT_ID": "test-client",
        "GOOGLE_CLIENT_SECRET": "secret-google",
        "AUTH_ENCRYPTION_KEY": KEY,
    }.items():
        monkeypatch.setenv(key, value)
    environment = Environment.load()
    assert environment.google_available
    assert environment.google_client_id == "test-client"
    assert "secret-google" not in repr(environment) and KEY not in repr(environment)


@pytest.mark.parametrize(
    "return_to",
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
def test_oidc_login_cookie_pkce_identity_and_no_finance_side_effect(auth_client, return_to):
    """Verify OIDC binds PKCE and cookies, encrypts grants, and creates no financial session."""
    client, google, _ = auth_client
    params, initiated = begin(client, return_to=return_to)
    settings = client.get("/api/auth/settings").json()
    assert settings == {"googleAvailable": True, "sessionHours": 168}
    authorization = parse_qs(urlsplit(initiated.json()["url"]).query)
    assert authorization["scope"] == ["openid profile email"]
    assert authorization["prompt"] == ["select_account consent"]
    assert authorization["access_type"] == ["offline"]
    assert authorization["redirect_uri"] == [ORIGIN + "/auth/callback"]
    cookie = initiated.headers["set-cookie"]
    assert all(value in cookie for value in ("HttpOnly", "SameSite=lax", "Max-Age=300", "Path=/"))
    assert "Domain=" not in cookie and "Secure" not in cookie
    flow = query(
        client, "SELECT state_hash, binding_hash, verifier, nonce_hash, claimed FROM auth_flows"
    )[0]
    assert flow[0] == digest(params["state"])
    assert flow[1] == digest(client.cookies[FLOW_COOKIE])
    assert flow[2] != google.codes[params["code"]][1]["code_challenge"]
    assert flow[3] == digest(authorization["nonce"][0]) and flow[4] == 0
    assert query(client, "SELECT return_to FROM auth_flows") == [(return_to,)]
    response = callback(client, params)
    assert response.status_code == 303 and response.headers["location"] == return_to
    assert all(
        value in response.headers["set-cookie"]
        for value in ("HttpOnly", "SameSite=lax", "Max-Age=604800", "Path=/")
    )
    assert FLOW_COOKIE not in client.cookies
    token = client.cookies[COOKIE]
    session = client.get("/api/auth/session").json()
    assert set(session) == {"user", "expiresAt"}
    assert set(session["user"]) == {"id", "displayName", "googleName", "email"}
    assert str(UUID(session["user"]["id"])) == session["user"]["id"]
    assert session["user"]["id"] != "google-user-one"
    assert datetime.fromisoformat(session["expiresAt"]) == NOW + timedelta(hours=24)
    assert query(client, "SELECT hash FROM auth_sessions") == [(digest(token),)]
    assert not query(client, "SELECT * FROM auth_flows")
    stored = query(client, "SELECT access_token, refresh_token FROM auth_grants")[0]
    assert all(value not in stored for value in (*google.access_tokens, *google.refresh_tokens))
    assert client.get("/api/session").status_code == 404
    assert client.post("/api/auth/refresh", json={}).json() == session
    assert not query(client, "SELECT * FROM sessions")


@pytest.mark.parametrize(
    "return_to",
    [
        "https://attacker.example",
        "//attacker.example",
        "/app?redirect=evil",
        "/",
        "/api/session",
        "/app/../account",
        "/history?redirect=evil",
        "/figures",
        "/login",
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
        "/money?redirect=evil",
        "/money/income?redirect=evil",
        "/money/income#details",
        "/money/../account",
        "/money/%69ncome",
        "/money%2Fincome",
        "//attacker.example/money",
        "/money\\income",
        "/money/income\n",
    ],
)
def test_login_return_target_is_a_fixed_allowlist(auth_client, return_to):
    """Verify unsafe or unsupported return paths fail before creating a login flow."""
    client, google, _ = auth_client
    response = client.post("/api/auth/login", json={"returnTo": return_to})
    assert response.status_code == 422 and response.json()["code"] == "validationError"
    assert not query(client, "SELECT * FROM auth_flows")
    assert FLOW_COOKIE not in client.cookies and not google.requests


@pytest.mark.parametrize("return_to", ["/money/changes", "https://attacker.example/money"])
def test_callback_return_target_cannot_override_the_stored_money_path(auth_client, return_to):
    """Verify callback parameters cannot replace the return path stored during login initiation."""
    client, _, _ = auth_client
    params, _ = begin(client, return_to="/money/income")
    response = callback(client, {**params, "returnTo": return_to})
    assert response.status_code == 303
    assert response.headers["location"] == "/money/income"
    assert client.get("/api/auth/session").status_code == 200


def test_state_binding_consumption_replay_and_failed_login_preserve_current_login(auth_client):
    """Verify failed nonce validation consumes the flow without replacing the current login."""
    client, google, _ = auth_client
    sign_in(client)
    current = client.cookies[COOKIE]
    client.post("/api/session", json={})
    saved = client.post("/api/session/commands", json=command(facts("321"))).json()
    params, _ = begin(client)
    binding = client.cookies[FLOW_COOKIE]
    google.claims["nonce"] = "invalid-nonce"
    response = callback(client, params)
    assert response.headers["location"] == "/login?error=failed"
    assert client.cookies[COOKIE] == current
    assert client.get("/api/session").json() == saved
    google.claims.clear()
    client.cookies.set(FLOW_COOKIE, binding)
    assert callback(client, params).headers["location"] == "/login?error=failed"
    assert not query(client, "SELECT * FROM auth_flows")
    assert client.cookies[COOKIE] == current


def test_stolen_state_without_browser_binding_cannot_consume_victim_flow(auth_client):
    """Verify state without its browser binding cannot consume or exchange a victim's flow."""
    client, google, _ = auth_client
    params, _ = begin(client)
    binding = client.cookies[FLOW_COOKIE]
    client.cookies.clear()
    assert callback(client, params).headers["location"] == "/login?error=failed"
    assert not google.requests
    assert len(query(client, "SELECT * FROM auth_flows")) == 1
    client.cookies.set(FLOW_COOKIE, binding)
    assert callback(client, params).headers["location"] == "/app"


@pytest.mark.parametrize(
    "field", ["state", "code", "error", "error_description", "error_uri", "iss"]
)
def test_duplicate_callback_parameters_are_rejected_without_token_exchange(auth_client, field):
    """Verify duplicate OAuth callback fields are rejected before contacting Google."""
    client, google, _ = auth_client
    params, _ = begin(client)
    pairs = [(key, value) for key, value in params.items() if key != field] + [
        (field, "first"),
        (field, "second"),
    ]
    response = callback(client, pairs)
    assert response.headers["location"] == "/login?error=failed"
    assert not google.requests and COOKIE not in client.cookies


def test_cancelled_expired_and_provider_failed_callbacks_are_safe(auth_client):
    """Verify cancelled, expired, and unavailable login callbacks fail without leaking details."""
    client, google, now = auth_client
    params, _ = begin(client)
    response = callback(
        client,
        {
            "state": params["state"],
            "error": "access_denied",
            "error_description": "private details",
        },
    )
    assert response.headers["location"] == "/login?error=cancelled"
    assert "private" not in response.text
    params, _ = begin(client)
    now[0] += timedelta(seconds=301)
    assert callback(client, params).headers["location"] == "/login?error=expired"
    params, _ = begin(client)
    google.failure = GoogleUnavailable()
    assert callback(client, params).headers["location"] == "/login?error=unavailable"
    assert COOKIE not in client.cookies and not query(client, "SELECT * FROM auth_users")


def test_additional_google_callback_parameters_are_ignored_and_post_is_not_allowed(auth_client):
    """Verify harmless extra Google callback parameters are ignored and POST is not accepted."""
    client, _, _ = auth_client
    params, _ = begin(client)
    assert client.post("/auth/callback", json=params).status_code in {404, 405}
    response = callback(
        client, {**params, "scope": "openid profile email", "authuser": "1", "prompt": "consent"}
    )
    assert response.headers["location"] == "/app"


@pytest.mark.parametrize(
    "cookie", ["", "broken", "x" * 42, "x" * 44, '"' + "x" * 43 + '"', "x" * 5000]
)
def test_malformed_or_long_cookie_is_uniformly_unauthenticated(auth_client, cookie):
    """Verify malformed session cookies produce the same unauthenticated response."""
    client, _, _ = auth_client
    response = client.get("/api/auth/session", headers={"Cookie": COOKIE + "=" + cookie})
    assert response.status_code == 401
    assert response.json() == {
        "code": "unauthenticated",
        "message": "Sign in to continue.",
        "snapshot": None,
    }


def test_duplicate_session_cookies_are_not_accepted(auth_client):
    """Verify duplicate session cookies are rejected within one header or across headers."""
    client, _, _ = auth_client
    sign_in(client)
    token = client.cookies[COOKIE]
    for headers in (
        {"Cookie": f"{COOKIE}={token}; {COOKIE}={token}"},
        [("cookie", f"{COOKIE}={token}"), ("cookie", f"{COOKIE}={token}")],
    ):
        assert client.get("/api/session", headers=headers).status_code == 401


@pytest.mark.parametrize("subject", ["google-user-one", "google-user-two"])
@pytest.mark.parametrize("names", [(COOKIE,), (FLOW_COOKIE,), (COOKIE, FLOW_COOKIE)])
@pytest.mark.parametrize(
    "invalid", ["malformed", "incomplete", "duplicate", "duplicateHeaders", "overlength"]
)
def test_login_recovers_invalid_cookies_without_claiming_finances(
    auth_client, subject, names, invalid
):
    """Verify login replaces invalid cookies without assigning another account's financial data."""
    client, google, _ = auth_client
    sign_in(client)
    token = client.cookies[COOKIE]
    user = client.get("/api/auth/session").json()["user"]
    client.post("/api/session", json={})
    saved = client.post("/api/session/commands", json=command(facts("321"))).json()
    begin(client)
    binding = client.cookies[FLOW_COOKIE]
    values = {COOKIE: token, FLOW_COOKIE: binding}
    parts = []
    for name, value in values.items():
        if name in names:
            if invalid in {"duplicate", "duplicateHeaders"}:
                parts.append(f"{name}={value}")
            else:
                value = {"malformed": "broken", "incomplete": "", "overlength": "x" * 5000}[invalid]
        parts.append(f"{name}={value}")
    headers = (
        [("Cookie", part) for part in parts]
        if invalid == "duplicateHeaders"
        else {"Cookie": "; ".join(parts)}
    )
    preserved = COOKIE not in names and invalid != "overlength"
    for path in ("/api/auth/session", "/api/session", "/api/session/call"):
        response = client.get(path, headers=headers)
        assert response.status_code == (200 if preserved else 401)
        if not preserved:
            assert response.json() == {
                "code": "unauthenticated",
                "message": "Sign in to continue.",
                "snapshot": None,
            }
    response = client.post("/api/auth/login", json={}, headers=headers)
    assert response.status_code == 200
    cleared = {
        header.partition("=")[0]
        for header in response.headers.get_list("set-cookie")
        if "Max-Age=0" in header
    }
    assert cleared == (set(names) if invalid != "overlength" else {COOKIE, FLOW_COOKIE})
    assert client.cookies[FLOW_COOKIE] != binding
    assert client.cookies.get(COOKIE) == (token if preserved else None)
    assert client.get("/api/auth/session").status_code == (200 if preserved else 401)
    flow = query(
        client,
        "SELECT user_id, session_hash FROM auth_flows WHERE binding_hash = ?",
        (digest(client.cookies[FLOW_COOKIE]),),
    )
    assert flow == [(user["id"], digest(token)) if preserved else (None, None)]
    url = response.json()["url"]
    params = {
        "state": parse_qs(urlsplit(url).query)["state"][0],
        "code": google.code(url, subject),
    }
    assert callback(client, params).headers["location"] == "/app"
    assert client.cookies[COOKIE] != token and FLOW_COOKIE not in client.cookies
    current = client.get("/api/auth/session").json()["user"]
    if subject == "google-user-one":
        assert current["id"] == user["id"]
        assert client.get("/api/session").json() == saved
    else:
        assert current["id"] != user["id"]
        assert client.get("/api/session").status_code == 404
        assert (
            client.post("/api/session", json={}).json()["facts"]["opening"]["amountPaise"] is None
        )
        assert (
            json.loads(
                query(client, "SELECT snapshot FROM sessions WHERE owner = ?", (user["id"],))[0][0]
            )
            == saved
        )
    assert client.get("/api/session", headers=headers).status_code == 401


def test_idle_refresh_preserves_identity_without_extending_absolute_limit(auth_client):
    """Verify repeated idle refresh retains identity without extending the seven-day login limit."""
    client, google, now = auth_client
    sign_in(client)
    token = client.cookies[COOKIE]
    user = client.get("/api/auth/session").json()["user"]
    for _ in range(9):
        now[0] += timedelta(hours=18)
        response = client.post("/api/auth/refresh", json={})
        assert response.status_code == 200 and response.json()["user"] == user
        assert client.cookies[COOKIE] == token
        assert datetime.fromisoformat(response.json()["expiresAt"]) <= NOW + timedelta(days=7)
    assert now[0] == NOW + timedelta(hours=162)
    now[0] = NOW + timedelta(days=7)
    assert client.post("/api/auth/refresh", json={}).json()["code"] == "sessionExpired"
    assert client.get("/api/auth/session").status_code == 401
    assert not query(client, "SELECT * FROM sessions")


def test_google_refresh_nonce_survives_a_login_without_a_replacement_refresh_token(auth_client):
    """Verify login without a replacement refresh token retains the grant's refresh nonce."""
    client, google, now = auth_client
    sign_in(client)
    user = client.get("/api/auth/session").json()["user"]
    nonce = query(client, "SELECT nonce_hash FROM auth_grants")[0][0]
    google.offline = False
    google.refresh_id_token = True
    sign_in(client)
    now[0] += timedelta(hours=1)
    response = client.post("/api/auth/refresh", json={})
    assert response.status_code == 200 and response.json()["user"] == user
    assert query(client, "SELECT nonce_hash FROM auth_grants")[0][0] == nonce


def test_idle_and_access_only_expiry_require_signin(auth_client):
    """Verify access-only expiry and idle expiry follow the available Google grant lifetime."""
    client, google, now = auth_client
    google.offline = False
    sign_in(client)
    assert datetime.fromisoformat(
        client.get("/api/auth/session").json()["expiresAt"]
    ) == NOW + timedelta(hours=1)
    params, response = begin(client)
    assert parse_qs(urlsplit(response.json()["url"]).query)["prompt"] == ["select_account consent"]
    google.offline = True
    assert callback(client, params).headers["location"] == "/app"
    assert datetime.fromisoformat(
        client.get("/api/auth/session").json()["expiresAt"]
    ) == NOW + timedelta(hours=24)
    now[0] += timedelta(hours=24)
    assert client.get("/api/auth/session").json()["code"] == "sessionExpired"


def test_access_only_token_cannot_silently_live_for_seven_days(auth_client):
    """Verify access-only login expires with its token and requires a fresh sign-in."""
    client, google, now = auth_client
    google.offline = False
    sign_in(client)
    now[0] += timedelta(hours=1)
    assert client.get("/api/auth/session").json()["code"] == "sessionExpired"
    google.offline = True
    sign_in(client)
    assert client.get("/api/auth/session").status_code == 200


def test_custom_name_survives_google_profile_refresh_and_email_changes(auth_client):
    """Verify a custom display name survives refreshed Google name and email values."""
    client, google, now = auth_client
    sign_in(client)
    original = client.get("/api/auth/session").json()["user"]
    updated = client.patch("/api/account", json={"displayName": "  Custom Name  "})
    assert updated.status_code == 200 and updated.json()["displayName"] == "Custom Name"
    google.accounts["google-user-one"] = {"name": "Google Renamed", "email": "changed@example.com"}
    now[0] += timedelta(seconds=300)
    user = client.post("/api/auth/refresh", json={}).json()["user"]
    assert user == {
        **original,
        "displayName": "Custom Name",
        "googleName": "Google Renamed",
        "email": "changed@example.com",
    }


@pytest.mark.parametrize("name", ["", "  ", "x" * 81, "a\nb", "a\x00b", "a\x7fb", "a\u202eb", 123])
def test_account_name_validation(auth_client, name):
    """Verify profile edits reject invalid display names and attempts to replace account email."""
    client, _, _ = auth_client
    sign_in(client)
    assert client.patch("/api/account", json={"displayName": name}).status_code == 422
    assert (
        client.patch(
            "/api/account", json={"displayName": "Safe", "email": "attacker@example.com"}
        ).status_code
        == 422
    )


def test_provider_rechecks_fail_closed_and_revocation_invalidates_every_login(auth_client):
    """Verify failed rechecks block data after the grace and revocation invalidates logins."""
    client, google, now = auth_client
    sign_in(client)
    first = client.cookies[COOKIE]
    client.post("/api/session", json={})
    financial = client.post("/api/session/commands", json=command(facts("789"))).json()
    client.cookies.clear()
    sign_in(client)
    second = client.cookies[COOKIE]
    assert first != second and len(query(client, "SELECT * FROM auth_sessions")) == 2
    now[0] += timedelta(seconds=299)
    google.failure = GoogleUnavailable()
    assert client.get("/api/session").json() == financial
    # A transient provider outage at the due recheck keeps a still-valid grant serving briefly.
    now[0] += timedelta(seconds=1)
    assert client.get("/api/session").json() == financial
    now[0] += timedelta(seconds=59)
    assert client.get("/api/session").json() == financial
    now[0] += timedelta(seconds=1)
    response = client.get("/api/session/export")
    assert response.status_code == 503 and "789" not in response.text
    assert len(query(client, "SELECT * FROM auth_sessions")) == 2
    google.failure = None
    assert client.get("/api/session").json() == financial
    google.revoked.add("google-user-one")
    now[0] += timedelta(seconds=300)
    assert client.get("/api/session").status_code == 401
    assert not query(client, "SELECT * FROM auth_sessions")
    assert not query(client, "SELECT * FROM auth_grants")
    assert len(query(client, "SELECT * FROM sessions")) == 1
    assert client.get("/api/session", headers={"Cookie": COOKIE + "=" + first}).status_code == 401


def test_expired_token_gets_no_provider_outage_grace(auth_client):
    """Verify an outage grace never serves a grant whose access token has itself expired."""
    client, google, now = auth_client
    sign_in(client)
    client.post("/api/session", json={})
    expires = query(client, "SELECT expires FROM auth_grants")[0][0]
    now[0] = datetime.fromtimestamp(expires, UTC)
    google.failure = GoogleUnavailable()
    response = client.get("/api/session")
    assert response.status_code == 503 and response.json()["code"] == "authUnavailable"
    google.failure = None
    assert client.get("/api/session").status_code == 200


@pytest.mark.parametrize("change", ["invalidGrant", "userinfoSubject", "refreshIdSubject"])
def test_invalid_refresh_and_subject_changes_revoke_login(auth_client, change):
    """Verify invalid grants or changed Google subjects revoke stored sessions and grants."""
    client, google, now = auth_client
    sign_in(client)
    if change == "invalidGrant":
        google.revoked.add("google-user-one")
    elif change == "userinfoSubject":
        google.userinfo_changes["sub"] = "different-google-user"
    else:
        google.refresh_id_token = True
        google.claims["sub"] = "different-google-user"
    now[0] += timedelta(hours=1)
    response = client.post("/api/auth/refresh", json={})
    assert response.status_code == 401
    assert not query(client, "SELECT * FROM auth_sessions")
    assert not query(client, "SELECT * FROM auth_grants")


def test_logout_is_idempotent_current_login_only_and_does_not_delete_finances(auth_client):
    """Verify logout revokes only the current login, clears flows, and preserves financial data."""
    client, _, _ = auth_client
    sign_in(client)
    first = client.cookies[COOKIE]
    client.post("/api/session", json={})
    saved = client.post("/api/session/commands", json=command(facts("100"))).json()
    client.cookies.clear()
    sign_in(client)
    second = client.cookies[COOKIE]
    begin(client)
    assert client.post("/api/auth/logout", json={}).status_code == 204
    assert COOKIE not in client.cookies and FLOW_COOKIE not in client.cookies
    assert not query(client, "SELECT * FROM auth_flows")
    assert client.get("/api/session", headers={"Cookie": COOKIE + "=" + second}).status_code == 401
    assert client.get("/api/session", headers={"Cookie": COOKIE + "=" + first}).json() == saved
    assert client.post("/api/auth/logout", json={}).status_code == 204
    assert (
        client.post(
            "/api/auth/logout", json={}, headers={"Cookie": COOKIE + "=malformed"}
        ).status_code
        == 204
    )


def test_users_with_same_email_are_isolated_and_anonymous_data_is_not_claimed(auth_client):
    """Verify Google subjects isolate finances despite shared email or an anonymous owner cookie."""
    client, google, _ = auth_client
    for subject in ("first", "second"):
        google.accounts[subject] = {"name": "Shared Name", "email": "same@example.com"}
    sign_in(client, "first")
    first_user = client.get("/api/auth/session").json()["user"]
    client.post("/api/session", json={})
    submitted = command(facts("654"))
    saved = client.post("/api/session/commands", json=submitted).json()
    legacy = "a" * 43
    client.portal.call(client.app.state.store.create, owner_hash(legacy))
    client.cookies.clear()
    client.cookies.set("financeOwner", legacy)
    sign_in(client, "second")
    second_user = client.get("/api/auth/session").json()["user"]
    assert first_user["id"] != second_user["id"] and first_user["email"] == second_user["email"]
    assert client.get("/api/session").status_code == 404
    empty = client.post("/api/session", json={}).json()
    assert (
        empty["sessionId"] != saved["sessionId"]
        and empty["facts"]["opening"]["amountPaise"] is None
    )
    submitted["operation"]["facts"]["opening"]["amount"] = "1"
    replay = client.post("/api/session/commands", json=submitted)
    assert replay.status_code == 200 and replay.json()["facts"]["opening"]["amountPaise"] == 100
    assert query(client, "SELECT owner FROM sessions WHERE owner = ?", (owner_hash(legacy),))
    for key in ("owner", "userId", "sessionId"):
        for target in (
            "/api/session",
            "/api/session/options",
            "/api/session/export",
            "/api/session/events",
            "/api/session/call",
        ):
            response = client.get(target, params={key: first_user["id"]})
            assert response.status_code == 400 and first_user["id"] not in response.text


def test_account_delete_requires_confirmation_recent_login_and_erases_all_owned_rows(auth_client):
    """Verify account erasure requires recent sign-in and explicit consent before deleting data."""
    client, _, now = auth_client
    sign_in(client)
    user = client.get("/api/auth/session").json()["user"]
    first = client.cookies[COOKIE]
    client.post("/api/session", json={})
    client.post("/api/session/commands", json=command(facts("987")))
    for body in (
        {},
        {"confirmation": "delete"},
        {"confirmation": True},
        {"confirmation": "DELETE", "userId": user["id"]},
    ):
        assert client.request("DELETE", "/api/account", json=body).status_code == 422
    now[0] += timedelta(seconds=901)
    response = client.request("DELETE", "/api/account", json={"confirmation": "DELETE"})
    assert response.status_code == 428 and response.json()["code"] == "requiresSignin"
    assert query(client, "SELECT * FROM commands")
    sign_in(client, return_to="/account")
    assert client.get("/api/auth/session").json()["user"]["id"] == user["id"]
    second = client.cookies[COOKIE]
    begin(client)
    response = client.request("DELETE", "/api/account", json={"confirmation": "DELETE"})
    assert response.status_code == 200 and response.json() == {"deleted": True}
    assert COOKIE not in client.cookies and FLOW_COOKIE not in client.cookies
    for table in (
        "auth_users",
        "auth_grants",
        "auth_sessions",
        "auth_flows",
        "sessions",
        "commands",
    ):
        assert not query(client, "SELECT * FROM " + table)
    for token in (first, second):
        assert (
            client.get("/api/session/export", headers={"Cookie": COOKIE + "=" + token}).status_code
            == 401
        )
    sign_in(client)
    assert client.get("/api/auth/session").json()["user"]["id"] != user["id"]
    assert client.post("/api/session", json={}).json()["facts"]["opening"]["amountPaise"] is None


def test_csrf_guards_include_auth_and_account_mutations(auth_client):
    """Verify authentication and account mutations require trusted same-origin request metadata."""
    client, _, _ = auth_client
    sign_in(client)
    for headers in (
        {"Origin": "https://evil.example"},
        {"Origin": "null"},
        {"Sec-Fetch-Site": "cross-site"},
        {"Sec-Fetch-Site": "same-site"},
        {"Host": "evil.example"},
    ):
        for method, path, body in (
            ("POST", "/api/auth/login", {}),
            ("POST", "/api/auth/logout", {}),
            ("POST", "/api/auth/refresh", {}),
            ("PATCH", "/api/account", {"displayName": "Malicious"}),
            ("DELETE", "/api/account", {"confirmation": "DELETE"}),
        ):
            assert client.request(method, path, json=body, headers=headers).status_code == 403
    client.headers.pop("Origin")
    assert client.post("/api/auth/logout", json={}).status_code == 403
    assert (
        client.post(
            "/api/auth/logout", json={}, headers={"Sec-Fetch-Site": "same-origin"}
        ).status_code
        == 204
    )


def test_login_and_invalid_credential_limits_ignore_forwarded_ip(auth_client):
    """Verify spoofed forwarded IP values cannot bypass login or invalid-credential rate limits."""
    client, _, now = auth_client
    for index in range(client.app.state.auth.config.login_limit):
        assert (
            client.post(
                "/api/auth/login", json={}, headers={"X-Forwarded-For": f"10.0.0.{index}"}
            ).status_code
            == 200
        )
    response = client.post(
        "/api/auth/login", json={}, headers={"X-Forwarded-For": "different-address"}
    )
    assert response.status_code == 429 and response.headers["Retry-After"] == "60"
    assert len(query(client, "SELECT * FROM auth_flows")) == 1
    now[0] += timedelta(seconds=60)
    for index in range(client.app.state.auth.config.invalid_limit):
        assert (
            client.get(
                "/api/auth/session",
                headers={
                    "Cookie": COOKIE + "=" + str(index).zfill(43),
                    "X-Forwarded-For": str(index),
                },
            ).status_code
            == 401
        )
    assert client.get("/api/auth/session").status_code == 429
    now[0] += timedelta(seconds=60)
    assert client.get("/api/auth/session").status_code == 401


def test_account_mutations_and_login_storage_have_bounded_caps(auth_client, config):
    """Verify profile mutation rates and retained login counts obey configured caps."""
    client, _, _ = auth_client
    sign_in(client)
    for index in range(config.auth.account_limit):
        assert (
            client.patch("/api/account", json={"displayName": "User " + str(index)}).status_code
            == 200
        )
    response = client.patch("/api/account", json={"displayName": "Blocked"})
    assert response.status_code == 429 and "Retry-After" in response.headers
    for _ in range(config.auth.max_logins_per_user + 1):
        client.cookies.clear()
        sign_in(client)
    assert len(query(client, "SELECT * FROM auth_sessions")) == config.auth.max_logins_per_user


def test_callback_tokens_are_excluded_from_access_logs():
    """Verify the access-log filter drops OAuth callbacks but retains health requests."""
    filter = CallbackLogFilter()
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        "",
        1,
        '%s "%s %s HTTP/%s" %d',
        ("127.0.0.1", "GET", "/auth/callback?code=secret&state=secret", "1.1", 303),
        None,
    )
    assert not filter.filter(record)
    record.args = ("127.0.0.1", "GET", "/health/live", "1.1", 200)
    assert filter.filter(record)


def test_login_tokens_are_never_returned_in_session_or_errors(auth_client, caplog):
    """Verify session responses and captured logs omit application and Google tokens."""
    client, google, _ = auth_client
    sign_in(client)
    response = client.get("/api/auth/session")
    for secret in (client.cookies[COOKIE], *google.access_tokens, *google.refresh_tokens):
        assert secret not in response.text and secret not in caplog.text
    assert google.requests.count(("POST", TOKEN)) == 1


def test_session_and_encrypted_google_grant_survive_process_and_browser_restart(tmp_path, config):
    """Verify persisted login cookies and encrypted grants restore identity after app restart."""
    now = [NOW]
    environment = Environment(data_dir=tmp_path)
    application = auth_app(config, environment, lambda: now[0])
    with TestClient(application, base_url=ORIGIN) as client:
        sign_in(client)
        token = client.cookies[COOKIE]
        user = client.get("/api/auth/session").json()["user"]
    now[0] += timedelta(hours=2)
    with TestClient(
        auth_app(config, environment, lambda: now[0], google=application.state.auth.google),
        base_url=ORIGIN,
    ) as client:
        client.cookies.set(COOKIE, token)
        response = client.get("/api/auth/session")
        assert response.status_code == 200 and response.json()["user"] == user
        assert not query(client, "SELECT * FROM sessions")
        assert len(application.state.auth.google.requests) > 2


def test_https_canonical_origin_uses_host_only_prefixed_cookies(tmp_path, config):
    """Verify canonical HTTPS origins use secure host-prefixed session cookies without a domain."""
    environment = Environment(
        data_dir=tmp_path, app_env="staging", public_origin="HTTPS://FINANCE.EXAMPLE:443"
    )
    assert environment.public_origin == "https://finance.example"
    application = auth_app(config, environment, lambda: NOW)
    with TestClient(application, base_url=environment.public_origin) as client:
        response = sign_in(client)
        cookie = response.headers["set-cookie"]
        assert "__Host-financeSession=" in cookie and "Secure" in cookie and "Domain=" not in cookie
        assert COOKIE not in client.cookies and "__Host-financeSession" in client.cookies
        assert client.get("/api/auth/session").status_code == 200
        assert client.post("/api/auth/logout", json={}).status_code == 204
        assert "__Host-financeSession" not in client.cookies


@pytest.mark.parametrize(
    "name", ["Host", "Origin", "Sec-Fetch-Site", "Content-Type", "Content-Length"]
)
def test_duplicate_security_headers_are_rejected(auth_client, name):
    """Verify duplicate security-relevant headers are rejected as invalid request metadata."""
    client, _, _ = auth_client
    response = client.post("/api/auth/login", json={}, headers=[(name, ORIGIN), (name, ORIGIN)])
    assert response.status_code == 400 and response.json()["code"] == "invalidHeaders"


def test_non_ascii_cookie_bytes_fail_as_credentials_not_server_errors(auth_client):
    """Verify non-ASCII cookies return an uncached authentication failure, not a server error."""
    client, _, _ = auth_client
    response = client.get("/api/auth/session", headers=[(b"cookie", b"financeSession=\xff")])
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("path", ["/api/session", "/api/session/call"])
def test_delete_body_cannot_smuggle_an_owner_or_exceed_request_limit(auth_client, path, config):
    """Verify deletion rejects owner fields, unsupported media types, and oversized bodies."""
    client, _, _ = auth_client
    sign_in(client)
    client.post("/api/session", json={})
    assert client.request("DELETE", path, json={"owner": "someone-else"}).status_code == 422
    assert client.request("DELETE", path, content="x").status_code == 415
    response = client.request(
        "DELETE",
        path,
        content=" " * (config.max_request_bytes + 1),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 413
    assert client.get("/api/session").status_code == 200


def test_account_deletion_transaction_failure_preserves_every_owned_row(auth_client):
    """Verify failed erasure transactions preserve the account, grants, sessions, and commands."""
    client, _, _ = auth_client
    sign_in(client)
    client.post("/api/session", json={})
    saved = client.post("/api/session/commands", json=command(facts("543"))).json()
    query(
        client,
        "CREATE TRIGGER reject_erasure BEFORE DELETE ON sessions "
        "BEGIN SELECT RAISE(ABORT, 'test-only'); END",
    )
    response = client.request("DELETE", "/api/account", json={"confirmation": "DELETE"})
    assert response.status_code == 503
    assert client.get("/api/session").json() == saved
    assert client.get("/api/auth/session").status_code == 200
    for table in ("auth_users", "auth_sessions", "auth_grants", "sessions", "commands"):
        assert len(query(client, "SELECT * FROM " + table)) == 1


def test_unavailable_google_grant_revocation_does_not_undo_local_erasure(auth_client, monkeypatch):
    """Verify failed Google revocation does not undo committed local account erasure."""
    client, google, _ = auth_client
    sign_in(client)
    client.post("/api/session", json={})
    attempts = []

    async def revoke(token):
        """Record a revocation attempt and simulate an unavailable Google provider."""
        attempts.append(True)
        raise GoogleUnavailable()

    monkeypatch.setattr(google, "revoke", revoke)
    assert client.request("DELETE", "/api/account", json={"confirmation": "DELETE"}).json() == {
        "deleted": True
    }
    assert attempts == [True]
    assert not query(client, "SELECT * FROM auth_users")
    assert not query(client, "SELECT * FROM sessions")


def test_flow_and_rate_key_storage_are_bounded_without_eviction_bypass(auth_client):
    """Verify flow and rate-key caps reject excess entries until expiry instead of evicting them."""
    client, _, now = auth_client
    auth = client.app.state.auth
    auth.config = auth.config.model_copy(update={"max_flows": 2})
    for _ in range(2):
        client.cookies.clear()
        assert client.post("/api/auth/login", json={}).status_code == 200
    client.cookies.clear()
    response = client.post("/api/auth/login", json={})
    assert response.status_code == 429 and response.headers["Retry-After"] == "300"
    assert len(query(client, "SELECT * FROM auth_flows")) == 2
    now[0] += timedelta(seconds=301)
    assert client.post("/api/auth/login", json={}).status_code == 200
    assert len(query(client, "SELECT * FROM auth_flows")) == 1
    auth.rates.clear()
    auth.config = auth.config.model_copy(update={"max_rate_keys": 1})
    assert client.get("/api/auth/session").status_code == 401
    assert client.post("/api/auth/login", json={}).status_code == 429
    assert len(auth.rates) == 1
    now[0] += timedelta(seconds=60)
    assert client.post("/api/auth/login", json={}).status_code == 200
    assert len(auth.rates) == 1


def test_voice_start_attempts_and_command_conflicts_are_rate_limited(auth_client):
    """Verify repeated voice-start failures and command conflicts exhaust their rate limits."""
    client, _, _ = auth_client
    sign_in(client)
    client.post("/api/session", json={})
    auth = client.app.state.auth
    for _ in range(auth.config.voice_limit):
        assert client.post("/api/session/call", json={"callId": str(uuid4())}).status_code == 503
    assert client.post("/api/session/call", json={"callId": str(uuid4())}).status_code == 429
    submitted = command(facts("1"))
    assert client.post("/api/session/commands", json=submitted).status_code == 200
    submitted["operation"]["facts"]["opening"]["amount"] = "2"
    for _ in range(auth.config.invalid_limit):
        assert client.post("/api/session/commands", json=submitted).status_code == 409
    response = client.post("/api/session/commands", json=submitted)
    assert response.status_code == 429 and "Retry-After" in response.headers
    assert client.get("/api/session").json()["facts"]["opening"]["amountPaise"] == 100


def test_auth_openapi_types_have_no_dangling_schema_references(auth_client):
    """Verify authentication schemas resolve references and keep identity fields out of facts."""
    client, _, _ = auth_client
    schema = client.app.openapi()

    def check(value):
        """Recursively resolve local schema references and fail on missing targets."""
        if isinstance(value, dict):
            if "$ref" in value:
                target = schema
                assert value["$ref"].startswith("#/")
                for part in value["$ref"][2:].split("/"):
                    target = target[part]
            for child in value.values():
                check(child)
        elif isinstance(value, list):
            for child in value:
                check(child)

    check(schema)
    models = schema["components"]["schemas"]
    assert set(models["AuthSession"]["properties"]) == {"user", "expiresAt"}
    assert set(models["User"]["properties"]) == {"id", "displayName", "googleName", "email"}
    assert set(models["AuthSettings"]["properties"]) == {"googleAvailable", "sessionHours"}
    assert models["AccountDelete"]["properties"]["confirmation"]["const"] == "DELETE"
    return_paths = models["LoginRequest"]["properties"]["returnTo"]["anyOf"]
    assert return_paths[0]["enum"] == [
        "/app",
        "/money",
        "/money/income",
        "/money/spending",
        "/money/debts",
        "/money/upcoming",
        "/money/changes",
        "/account",
        "/history",
    ]
    assert return_paths[1] == {
        "type": "string",
        "maxLength": 128,
        "pattern": "^/(?:history|app)/[a-z0-9]+(?:-[a-z0-9]+)*$",
    }
    assert models["Facts"]["additionalProperties"] is False
    assert not {"user", "userId", "email", "googleSubject"} & set(models["Facts"]["properties"])


def test_browser_harness_runs_the_real_callback_without_a_debug_login_route(tmp_path, monkeypatch):
    """Verify the browser harness authenticates through OAuth callbacks without a debug route."""
    monkeypatch.setenv("PUBLIC_ORIGIN", ORIGIN)
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    with TestClient(browser_app(), base_url=ORIGIN, headers={"Origin": ORIGIN}) as client:
        assert client.get("/api/auth/session").status_code == 401
        response = client.post("/api/auth/login", json={"returnTo": "/account"})
        assert response.status_code == 200
        target = response.json()["url"]
        assert urlsplit(target).path == "/auth/callback"
        response = client.get(target, follow_redirects=False)
        assert response.status_code == 303 and response.headers["location"] == "/account"
        assert client.get("/api/auth/session").status_code == 200
        assert len(query(client, "SELECT * FROM auth_users")) == 1
        assert not query(client, "SELECT * FROM auth_flows")
        assert client.get("/api/debug/login").status_code == 404
