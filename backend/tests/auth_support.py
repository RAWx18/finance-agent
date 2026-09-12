# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import base64
import hashlib
import secrets
from urllib.parse import parse_qs, urlencode, urlsplit

from cryptography.fernet import Fernet
from joserfc import jwt
from joserfc.jwk import RSAKey
from pydantic import SecretStr

from app.config import AuthConfig, Environment, load_config
from app.google import ISSUER, JWKS, REVOKE, TOKEN, USERINFO, Google, GoogleRejected
from app.main import create_app
from app.store import utc_now

KEY = Fernet.generate_key().decode()
RSA = RSAKey.generate_key(2048, {"kid": "test-rsa", "use": "sig", "alg": "RS256"})


class GoogleDouble(Google):
    """Simulate Google OAuth grants, signed identities, and failures for authentication tests."""

    def __init__(self, config, environment, clock):
        """Initialize isolated authorization codes, tokens, accounts, and failure controls."""
        super().__init__(config, environment, clock)
        self.codes = {}
        self.access_tokens = {}
        self.refresh_tokens = {}
        self.accounts = {}
        self.revoked = set()
        self.requests = []
        self.claims = {}
        self.token_changes = {}
        self.signing_key = RSA
        self.public_keys = [RSA.as_dict(private=False)]
        self.offline = True
        self.refresh_id_token = False
        self.userinfo_changes = {}
        self.failure = None

    async def open(self):
        """Leave HTTP resources unopened for the in-memory Google double."""
        pass

    async def close(self):
        """Complete shutdown without HTTP resources to release."""
        pass

    def code(self, url, subject="google-user-one"):
        """Validate authorization parameters and register a code for the synthetic account."""
        params = {key: value[0] for key, value in parse_qs(urlsplit(url).query).items()}
        assert params["scope"] == "openid profile email"
        assert params["code_challenge_method"] == "S256"
        assert params["client_id"] == self.environment.google_client_id
        code = secrets.token_urlsafe(32)
        self.codes[code] = (subject, params)
        self.accounts.setdefault(
            subject, {"name": "Test Google User", "email": subject + "@example.com"}
        )
        return code

    async def request(self, method, url, *, data=None, headers=None):
        """Record and simulate Google key, token, user-info, and revocation requests."""
        self.requests.append((method, url))
        if self.failure is not None:
            raise self.failure
        if url == JWKS:
            return {"keys": self.public_keys}
        if url == REVOKE:
            token = data["token"]
            grant = self.refresh_tokens.get(token) or self.access_tokens.get(token)
            if grant:
                self.revoked.add(grant[0])
            return {}
        if url == USERINFO:
            token = headers["Authorization"].removeprefix("Bearer ")
            subject, nonce = self.access_tokens[token]
            if subject in self.revoked:
                raise GoogleRejected()
            return {
                "sub": subject,
                "email_verified": True,
                **self.accounts[subject],
                **self.userinfo_changes,
            }
        assert url == TOKEN and method == "POST"
        assert data["client_id"] == self.environment.google_client_id
        assert data["client_secret"] == self.environment.google_client_secret.get_secret_value()
        refreshing = data["grant_type"] == "refresh_token"
        if refreshing:
            subject, nonce = self.refresh_tokens[data["refresh_token"]]
            if subject in self.revoked:
                raise GoogleRejected()
        else:
            subject, params = self.codes.pop(data["code"])
            challenge = (
                base64.urlsafe_b64encode(hashlib.sha256(data["code_verifier"].encode()).digest())
                .rstrip(b"=")
                .decode()
            )
            assert challenge == params["code_challenge"]
            assert data["redirect_uri"] == params["redirect_uri"]
            nonce = params["nonce"]
        access = secrets.token_urlsafe(32)
        self.access_tokens[access] = (subject, nonce)
        payload = {"access_token": access, "token_type": "Bearer", "expires_in": 3600}
        if self.offline:
            refresh = secrets.token_urlsafe(32)
            self.refresh_tokens[refresh] = (subject, nonce)
            payload["refresh_token"] = refresh
        if not refreshing or self.refresh_id_token:
            payload["id_token"] = jwt.encode(
                {"alg": "RS256", "kid": self.signing_key.kid},
                {
                    "iss": ISSUER,
                    "aud": self.environment.google_client_id,
                    "sub": subject,
                    "iat": int(self.clock().timestamp()),
                    "exp": int(self.clock().timestamp()) + 3600,
                    "nonce": nonce,
                    "email_verified": True,
                    **self.accounts[subject],
                    **self.claims,
                },
                self.signing_key,
            )
        return {**payload, **self.token_changes}


class BrowserGoogle(GoogleDouble):
    """Bypass Google's UI with a local callback for browser authentication tests."""

    def authorization_url(self, state, nonce, verifier, consent):
        """Return a local callback URL containing a synthetic authorization code."""
        code = self.code(super().authorization_url(state, nonce, verifier, consent))
        return (
            self.environment.public_origin
            + "/auth/callback?"
            + urlencode({"state": state, "code": code})
        )


def browser_app():
    """Build an authenticated browser-test app with synthetic Google and shared-IP limits."""
    config = load_config()
    # Browser contexts share one server and loopback IP across the suite.
    config = config.model_copy(
        update={
            "auth": AuthConfig.model_validate(
                {**config.auth.model_dump(), "rate_window_seconds": 1, "login_limit": 100}
            )
        }
    )
    environment = auth_environment(Environment.load())
    return create_app(config, environment, google=BrowserGoogle(config.auth, environment, utc_now))


def auth_environment(environment):
    """Supply synthetic Google credentials and an encryption key for authentication tests."""
    return Environment.model_validate(
        {
            **environment.model_dump(),
            "google_client_id": "test-client.apps.googleusercontent.com",
            "google_client_secret": SecretStr("test-only-google"),
            "auth_encryption_key": SecretStr(KEY),
        }
    )


def auth_app(config, environment, clock=utc_now, static_dir=None, google=None):
    """Build an app with test authentication credentials and an injectable Google double."""
    environment = auth_environment(environment)
    google = google or GoogleDouble(config.auth, environment, clock)
    return create_app(config, environment, clock, static_dir, google)


def sign_in(client, subject="google-user-one", return_to="/app"):
    """Complete synthetic Google sign-in and assert the requested return redirect."""
    client.headers["Origin"] = str(client.base_url).rstrip("/")
    response = client.post("/api/auth/login", json={"returnTo": return_to})
    assert response.status_code == 200, response.text
    url = response.json()["url"]
    code = client.app.state.auth.google.code(url, subject)
    response = client.get(
        "/auth/callback",
        params={"state": parse_qs(urlsplit(url).query)["state"][0], "code": code},
        headers={"Sec-Fetch-Site": "cross-site", "Origin": ISSUER},
        follow_redirects=False,
    )
    assert response.status_code == 303 and response.headers["location"] == return_to, (
        response.headers
    )
    return response


async def sign_in_async(client, application, subject="google-user-one"):
    """Authenticate an asynchronous client through the synthetic Google callback."""
    client.headers["Origin"] = str(client.base_url).rstrip("/")
    response = await client.post("/api/auth/login", json={})
    assert response.status_code == 200, response.text
    url = response.json()["url"]
    code = application.state.auth.google.code(url, subject)
    response = await client.get(
        "/auth/callback",
        params={"state": parse_qs(urlsplit(url).query)["state"][0], "code": code},
        headers={"Sec-Fetch-Site": "cross-site", "Origin": ISSUER},
        follow_redirects=False,
    )
    assert response.status_code == 303 and response.headers["location"] == "/app", response.headers
    return response
