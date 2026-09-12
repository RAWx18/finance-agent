# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import sqlite3
from urllib.parse import parse_qs, urlsplit

import pytest

from app.auth import COOKIE, FLOW_COOKIE
from app.google import GoogleUnavailable

from .auth_support import sign_in
from .conftest import command, facts
from .test_auth import auth_client as auth_client
from .test_auth import begin, callback, query


@pytest.mark.parametrize("revoke_unavailable", [False, True])
def test_deleted_account_requires_consent_and_cancel_does_not_recreate_it(
    auth_client, revoke_unavailable
):
    """Verify deletion requires fresh consent and cancellation leaves the account absent."""
    client, google, _ = auth_client
    sign_in(client)
    user = client.get("/api/auth/session").json()["user"]
    token = client.cookies[COOKIE]
    assert client.patch("/api/account", json={"displayName": "Private profile"}).status_code == 200
    assert client.post("/api/session", json={}).status_code == 200
    assert client.post("/api/session/commands", json=command(facts("98765"))).status_code == 200
    if revoke_unavailable:
        google.failure = GoogleUnavailable()
    deleted = client.request("DELETE", "/api/account", json={"confirmation": "DELETE"})
    google.failure = None
    assert deleted.status_code == 200
    assert COOKIE not in client.cookies and FLOW_COOKIE not in client.cookies
    for table in ("auth_users", "auth_sessions", "auth_grants", "sessions", "commands"):
        assert not query(client, f"SELECT * FROM {table}")
    assert (
        client.get("/api/auth/session", headers={"Cookie": f"{COOKIE}={token}"}).status_code == 401
    )

    params, response = begin(client)
    authorization = parse_qs(urlsplit(response.json()["url"]).query)
    assert authorization["prompt"] == ["select_account consent"]
    assert "login_hint" not in authorization
    # A provider session alone is not an application login, even if revocation was unavailable.
    assert client.get("/api/auth/session").status_code == 401
    assert client.get("/api/session").status_code == 401
    assert not query(client, "SELECT * FROM auth_users")
    requests = list(google.requests)
    cancelled = callback(client, {"state": params["state"], "error": "access_denied"})
    assert cancelled.headers["location"] == "/login?error=cancelled"
    assert google.requests == requests
    assert COOKIE not in client.cookies and FLOW_COOKIE not in client.cookies
    assert callback(client, params).headers["location"] == "/login?error=failed"
    assert not query(client, "SELECT * FROM auth_flows")
    assert not query(client, "SELECT * FROM auth_users")
    assert client.get("/api/auth/session").status_code == 401

    params, response = begin(client)
    assert parse_qs(urlsplit(response.json()["url"]).query)["prompt"] == ["select_account consent"]
    assert callback(client, params).headers["location"] == "/app"
    created = client.get("/api/auth/session").json()["user"]
    assert created["id"] != user["id"]
    assert created["email"] == user["email"]
    assert created["displayName"] == user["googleName"]
    assert client.get("/api/session").status_code == 404
    assert client.get("/api/history").json() == {"conversations": []}
    assert client.post("/api/session", json={}).json()["facts"]["opening"]["amountPaise"] is None


def test_signed_in_reauthentication_with_a_grant_only_selects_an_account(auth_client):
    """Verify reauthentication with a grant requests account selection and preserves login."""
    client, _, _ = auth_client
    sign_in(client)
    params, response = begin(client)
    assert parse_qs(urlsplit(response.json()["url"]).query)["prompt"] == ["select_account"]
    user = client.get("/api/auth/session").json()["user"]
    assert (
        callback(client, {"state": params["state"], "error": "access_denied"}).headers["location"]
        == "/login?error=cancelled"
    )
    assert client.get("/api/auth/session").json()["user"] == user


def test_committed_deletion_still_clears_cookies_if_checkpoint_fails(auth_client, monkeypatch):
    """Verify committed account deletion clears cookies despite a failed SQLite checkpoint."""
    client, _, _ = auth_client
    sign_in(client)
    assert client.post("/api/session", json={}).status_code == 200
    db = client.app.state.store.connection()
    execute = db.execute

    def checkpoint(sql, *args, **kwargs):
        """Fail only the WAL truncation checkpoint while delegating other database statements."""
        if sql == "PRAGMA wal_checkpoint(TRUNCATE)":
            raise sqlite3.OperationalError("Checkpoint unavailable")
        return execute(sql, *args, **kwargs)

    monkeypatch.setattr(db, "execute", checkpoint)
    response = client.request("DELETE", "/api/account", json={"confirmation": "DELETE"})
    assert response.status_code == 200 and response.json() == {"deleted": True}
    assert COOKIE not in client.cookies and FLOW_COOKIE not in client.cookies
    assert not query(client, "SELECT * FROM auth_users")
    assert not query(client, "SELECT * FROM sessions")
    assert client.get("/api/auth/session").status_code == 401
