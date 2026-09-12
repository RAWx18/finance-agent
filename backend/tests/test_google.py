# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from datetime import timedelta

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from joserfc import jwt
from joserfc.jwk import OctKey, RSAKey

from app.config import Environment
from app.google import (
    ISSUER,
    JWKS,
    TOKEN,
    USERINFO,
    Google,
    GoogleRejected,
    GoogleUnavailable,
    digest,
)

from .auth_support import RSA, GoogleDouble, auth_environment
from .conftest import NOW


@pytest.fixture
def google(config, tmp_path):
    """Provide a Google authentication double with test configuration and a frozen clock."""
    return GoogleDouble(config.auth, auth_environment(Environment(data_dir=tmp_path)), lambda: NOW)


def claims(google, **values):
    """Build valid Google identity-token claims with optional field overrides."""
    return {
        "iss": ISSUER,
        "aud": google.environment.google_client_id,
        "sub": "google-subject",
        "iat": int(NOW.timestamp()),
        "exp": int(NOW.timestamp()) + 3600,
        "nonce": "test-nonce",
        "email": "user@example.com",
        "email_verified": True,
        "name": "Google Name",
        **values,
    }


def signed(google, **values):
    """Sign Google identity-token claims with the test RSA key."""
    return jwt.encode({"alg": "RS256", "kid": RSA.kid}, claims(google, **values), RSA)


@pytest.mark.parametrize("issuer", [ISSUER, "accounts.google.com"])
@pytest.mark.parametrize("verified", [True, "true"])
async def test_actual_rsa_signature_and_documented_google_claims(google, issuer, verified):
    """Verify RSA-signed tokens accept documented Google issuer and verified-email forms."""
    identity = await google.verify(
        signed(google, iss=issuer, email_verified=verified), digest("test-nonce")
    )
    assert identity.subject == "google-subject"
    assert identity.name == "Google Name" and identity.email == "user@example.com"
    assert google.requests == [("GET", JWKS)]


@pytest.mark.parametrize(
    "values",
    [
        {"iss": "https://attacker.example"},
        {"iss": [ISSUER]},
        {"iss": None},
        {"aud": "different-client"},
        {"aud": []},
        {"aud": ["different-client"]},
        {"aud": 7},
        {"aud": ["test-client.apps.googleusercontent.com", "other"]},
        {"azp": "other"},
        {"azp": None},
        {"azp": []},
        {"exp": int(NOW.timestamp())},
        {"exp": int(NOW.timestamp()) - 1},
        {"exp": "9999999999"},
        {"exp": True},
        {"iat": int(NOW.timestamp()) + 60},
        {"iat": -1},
        {"iat": False},
        {"iat": None},
        {"iat": int(NOW.timestamp()) + 3600},
        {"sub": ""},
        {"sub": "x" * 256},
        {"sub": "invalid\nsubject"},
        {"sub": "nonasciié"},
        {"sub": 123},
        {"nonce": "wrong"},
        {"nonce": None},
        {"email": "bad"},
        {"email": "a\n@example.com"},
        {"email": None},
        {"email_verified": False},
        {"email_verified": "false"},
        {"email_verified": "True"},
        {"email_verified": 1},
        {"email_verified": None},
        {"name": "a\x00b"},
        {"name": "x" * 201},
        {"name": []},
    ],
)
async def test_signed_but_invalid_claims_never_authenticate(google, values):
    """Verify signed tokens with invalid identity, audience, time, or nonce claims are rejected."""
    with pytest.raises(GoogleRejected):
        await google.verify(signed(google, **values), digest("test-nonce"))


@pytest.mark.parametrize(
    "name", ["iss", "aud", "sub", "iat", "exp", "nonce", "email", "email_verified"]
)
async def test_required_id_token_claims(google, name):
    """Verify identity tokens reject each missing required claim."""
    payload = claims(google)
    del payload[name]
    token = jwt.encode({"alg": "RS256", "kid": RSA.kid}, payload, RSA)
    with pytest.raises(GoogleRejected):
        await google.verify(token, digest("test-nonce"))


async def test_multiple_audiences_require_matching_authorized_party(google):
    """Verify multiple token audiences are accepted with a matching authorized party."""
    token = signed(
        google,
        aud=[google.environment.google_client_id, "other"],
        azp=google.environment.google_client_id,
    )
    assert (await google.verify(token, digest("test-nonce"))).subject == "google-subject"


async def test_wrong_key_none_and_hmac_algorithms_are_rejected(google):
    """Verify wrong-key, HMAC, unsigned, malformed, and oversized tokens are rejected."""
    attacker = RSAKey.generate_key(2048, {"kid": RSA.kid})
    forged = jwt.encode({"alg": "RS256", "kid": RSA.kid}, claims(google), attacker)
    hmac = jwt.encode({"alg": "HS256", "kid": RSA.kid}, claims(google), OctKey.generate_key(256))
    unsigned = signed(google).rsplit(".", 1)[0] + "."
    for token in (forged, hmac, unsigned, "not-a-jwt", "x" * 16385):
        with pytest.raises(GoogleRejected):
            await google.verify(token, digest("test-nonce"))


@pytest.mark.parametrize("name", ["jku", "x5u", "jwk", "x5c"])
async def test_embedded_key_sources_cannot_change_trusted_endpoints(google, name):
    """Verify embedded token key sources are rejected before any endpoint request."""
    value = (
        RSA.as_dict(private=False)
        if name == "jwk"
        else ["dGVzdA=="]
        if name == "x5c"
        else "https://attacker.example"
    )
    token = jwt.encode({"alg": "RS256", "kid": RSA.kid, name: value}, claims(google), RSA)
    with pytest.raises(GoogleRejected):
        await google.verify(token, digest("test-nonce"))
    assert not google.requests


async def test_bounded_key_cache_rotation_and_unknown_key_retries(google):
    """Verify key caches support rotation, bound unknown-key retries, and refresh expiry."""
    await google.verify(signed(google), digest("test-nonce"))
    await google.verify(signed(google), digest("test-nonce"))
    assert google.requests == [("GET", JWKS)]
    key = RSAKey.generate_key(2048, {"kid": "rotated-key", "alg": "RS256"})
    google.public_keys = [key.as_dict(private=False)]
    token = jwt.encode({"alg": "RS256", "kid": key.kid}, claims(google), key)
    assert (await google.verify(token, digest("test-nonce"))).subject == "google-subject"
    for _ in range(10):
        with pytest.raises(GoogleRejected):
            await google.verify(signed(google), digest("test-nonce"))
    assert google.requests == [("GET", JWKS)] * 2
    google.clock = lambda: NOW + timedelta(seconds=google.config.jwks_cache_seconds + 1)
    with pytest.raises(GoogleRejected):
        await google.verify(token, digest("test-nonce"))
    assert google.requests == [("GET", JWKS)] * 3


@pytest.mark.parametrize(
    "keys", [[], [{}], [{"kty": "oct", "kid": "test-rsa"}], [RSA.as_dict(private=False)] * 11]
)
async def test_invalid_or_oversized_key_sets_fail_closed(google, keys):
    """Verify invalid or oversized public key sets fail closed as provider unavailability."""
    google.public_keys = keys
    with pytest.raises(GoogleUnavailable):
        await google.verify(signed(google), digest("test-nonce"))


@pytest.mark.parametrize(
    "status,payload,error",
    [
        (
            400,
            {"error": "invalid_grant", "error_description": "secret-provider-body"},
            GoogleRejected,
        ),
        (401, {"error": "invalid_client"}, GoogleUnavailable),
        (503, {"private": "secret-provider-body"}, GoogleUnavailable),
        (200, ["invalid-object"], GoogleUnavailable),
    ],
)
async def test_real_provider_http_error_mapping(
    config, tmp_path, monkeypatch, status, payload, error
):
    """Verify provider HTTP errors map to safe authentication exceptions without leaking bodies."""
    async def respond(request):
        """Return the configured synthetic provider payload and HTTP status."""
        return web.json_response(payload, status=status)

    application = web.Application()
    application.router.add_post("/token", respond)
    google = Google(config.auth, auth_environment(Environment(data_dir=tmp_path)), lambda: NOW)
    async with TestServer(application) as server:
        await google.open()
        request = google.http.request
        monkeypatch.setattr(
            google.http,
            "request",
            lambda method, url, **kwargs: request(method, server.make_url("/token"), **kwargs),
        )
        try:
            with pytest.raises(error) as result:
                await google.request("POST", TOKEN, data={"code": "test-only"})
            assert "secret-provider-body" not in str(result.value)
        finally:
            await google.close()


async def test_real_http_size_limit_redirects_and_timeout(config, tmp_path, monkeypatch):
    """Verify oversize replies, redirects, and timeouts fail closed; never follow redirects."""
    reached = asyncio.Event()
    release = asyncio.Event()

    async def oversized(request):
        """Return a response one byte above the configured provider limit."""
        return web.Response(body=b"x" * (config.auth.provider_max_bytes + 1))

    async def redirect(request):
        """Return a redirect to a route that must not be reached."""
        return web.Response(status=302, headers={"Location": "/private"}, text="{}")

    async def delayed(request):
        """Signal arrival and hold the response until the test releases it."""
        reached.set()
        await release.wait()
        return web.json_response({})

    async def private(request):
        """Fail if the client follows the synthetic redirect."""
        raise AssertionError("Redirects must never be followed")

    application = web.Application()
    for path, handler in (
        ("/size", oversized),
        ("/redirect", redirect),
        ("/delayed", delayed),
        ("/private", private),
    ):
        application.router.add_get(path, handler)
    google = Google(config.auth, auth_environment(Environment(data_dir=tmp_path)), lambda: NOW)
    async with TestServer(application) as server:
        google.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=0.1))
        request = google.http.request
        try:
            for path in ("/size", "/redirect", "/delayed"):
                monkeypatch.setattr(
                    google.http,
                    "request",
                    lambda method, url, path=path, **kwargs: request(
                        method, server.make_url(path), **kwargs
                    ),
                )
                with pytest.raises(GoogleUnavailable):
                    await google.request("GET", USERINFO)
            assert reached.is_set()
        finally:
            release.set()
            await google.close()


@pytest.mark.parametrize("status", [401, 403])
async def test_non_json_userinfo_rejection_invalidates_credentials(
    config, tmp_path, monkeypatch, status
):
    """Verify empty non-JSON userinfo authorization failures reject credentials."""
    async def rejected(request):
        """Return an empty authorization-failure response with the configured status."""
        return web.Response(status=status, text="")

    application = web.Application()
    application.router.add_get("/userinfo", rejected)
    google = Google(config.auth, auth_environment(Environment(data_dir=tmp_path)), lambda: NOW)
    async with TestServer(application) as server:
        await google.open()
        request = google.http.request
        monkeypatch.setattr(
            google.http,
            "request",
            lambda method, url, **kwargs: request(method, server.make_url("/userinfo"), **kwargs),
        )
        try:
            with pytest.raises(GoogleRejected):
                await google.request("GET", USERINFO)
        finally:
            await google.close()
