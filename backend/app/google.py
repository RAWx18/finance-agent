# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import base64
import hashlib
import hmac
import json
import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlencode

import aiohttp
from joserfc import jws, jwt
from joserfc.errors import JoseError
from joserfc.jwk import KeySet, RSAKey

from .config import AuthConfig, Environment

ISSUER = "https://accounts.google.com"
AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN = "https://oauth2.googleapis.com/token"
USERINFO = "https://openidconnect.googleapis.com/v1/userinfo"
JWKS = "https://www.googleapis.com/oauth2/v3/certs"
REVOKE = "https://oauth2.googleapis.com/revoke"


class GoogleRejected(Exception):
    def __init__(self) -> None:
        super().__init__("Google credential rejected")


class GoogleUnavailable(Exception):
    def __init__(self) -> None:
        super().__init__("Google authentication unavailable")


@dataclass(frozen=True)
class Identity:
    subject: str
    name: str
    email: str


@dataclass(frozen=True)
class Grant:
    identity: Identity
    access_token: str = field(repr=False)
    refresh_token: str | None = field(repr=False)
    expires_at: datetime
    nonce_hash: str = field(repr=False)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def profile(claims: dict[str, Any]) -> Identity:
    subject = claims.get("sub")
    email = claims.get("email")
    name = claims.get("name", "")
    verified = claims.get("email_verified")
    if (
        not isinstance(subject, str)
        or re.fullmatch(r"[\x21-\x7e]{1,255}", subject) is None
        or not isinstance(email, str)
        or len(email) > 254
        or re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) is None
        or any(unicodedata.category(char).startswith("C") for char in email)
        # Google's OIDC documentation also specifies the literal string "true".
        or not (verified is True or (type(verified) is str and verified == "true"))
        or not isinstance(name, str)
        or len(name) > 200
        or any(unicodedata.category(char).startswith("C") for char in name)
    ):
        raise GoogleRejected()
    return Identity(subject, name.strip(), email)


class Google:
    def __init__(
        self, config: AuthConfig, environment: Environment, clock: Callable[[], datetime]
    ) -> None:
        self.config = config
        self.environment = environment
        self.clock = clock
        self.http: aiohttp.ClientSession | None = None
        self.keys: KeySet | None = None
        self.key_ids: set[str] = set()
        self.keys_until = 0.0
        self.rotation_after = 0.0
        self.cache_seconds = config.jwks_cache_seconds
        self.key_lock = asyncio.Lock()

    async def open(self) -> None:
        if self.environment.google_available:
            self.http = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self.config.provider_timeout_seconds),
                connector=aiohttp.TCPConnector(limit=self.config.provider_connections),
                trust_env=False,
            )

    async def close(self) -> None:
        if self.http is not None:
            await self.http.close()
            self.http = None

    def authorization_url(self, state: str, nonce: str, verifier: str, consent: bool) -> str:
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        return (
            AUTHORIZE
            + "?"
            + urlencode(
                {
                    "client_id": self.environment.google_client_id,
                    "redirect_uri": self.environment.public_origin + "/auth/callback",
                    "response_type": "code",
                    "scope": "openid profile email",
                    "access_type": "offline",
                    "prompt": "select_account consent" if consent else "select_account",
                    "state": state,
                    "nonce": nonce,
                    "code_challenge": challenge.rstrip(b"=").decode(),
                    "code_challenge_method": "S256",
                }
            )
        )

    async def request(
        self,
        method: str,
        url: str,
        *,
        data: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        # Endpoints are pinned to verified Google discovery metadata, never token headers.
        if url not in {TOKEN, USERINFO, JWKS, REVOKE} or self.http is None:
            raise GoogleUnavailable()
        try:
            async with self.http.request(
                method, url, data=data, headers=headers, allow_redirects=False
            ) as response:
                content = bytearray()
                async for chunk in response.content.iter_chunked(4096):
                    content.extend(chunk)
                    if len(content) > self.config.provider_max_bytes:
                        raise GoogleUnavailable()
                if url == REVOKE and response.status == 200:
                    return {}
                if url == USERINFO and response.status in {401, 403}:
                    raise GoogleRejected()
                payload = json.loads(content)
                if not isinstance(payload, dict):
                    raise GoogleUnavailable()
                if (
                    url == TOKEN
                    and response.status == 400
                    and payload.get("error") == "invalid_grant"
                ):
                    raise GoogleRejected()
                if response.status != 200:
                    raise GoogleUnavailable()
                if url == JWKS:
                    age = re.search(
                        r"(?:^|[, ])max-age=(\d+)", response.headers.get("Cache-Control", "")
                    )
                    self.cache_seconds = min(
                        self.config.jwks_cache_seconds,
                        int(age[1]) if age else self.config.jwks_cache_seconds,
                    )
                return payload
        except (aiohttp.ClientError, TimeoutError, ValueError, UnicodeError):
            raise GoogleUnavailable() from None

    async def key_set(self, kid: str) -> KeySet:
        async with self.key_lock:
            now = self.clock().timestamp()
            if self.keys is not None and now < self.keys_until:
                if kid in self.key_ids:
                    return self.keys
                if now < self.rotation_after:
                    raise GoogleRejected()
                self.rotation_after = now + self.config.jwks_refresh_seconds
            payload = await self.request("GET", JWKS)
            keys = payload.get("keys")
            if not isinstance(keys, list) or not 1 <= len(keys) <= 10:
                raise GoogleUnavailable()
            ids = set()
            for key in keys:
                if (
                    not isinstance(key, dict)
                    or key.get("kty") != "RSA"
                    or key.get("alg", "RS256") != "RS256"
                    or key.get("use", "sig") != "sig"
                    or "d" in key
                    or not isinstance(key.get("kid"), str)
                    or not 1 <= len(key["kid"]) <= 128
                    or key["kid"] in ids
                ):
                    raise GoogleUnavailable()
                ids.add(key["kid"])
            try:
                self.keys = KeySet([RSAKey.import_key(key) for key in keys])
            except (JoseError, ValueError, TypeError):
                raise GoogleUnavailable() from None
            self.key_ids = ids
            self.keys_until = now + self.cache_seconds
            if kid not in self.key_ids:
                raise GoogleRejected()
            return self.keys

    async def verify(self, value: str, nonce_hash: str, *, subject: str | None = None) -> Identity:
        try:
            if not isinstance(value, str) or not 1 <= len(value) <= 16384:
                raise GoogleRejected()
            header = jws.extract_compact(value.encode()).headers()
            kid = header.get("kid")
            if (
                header.get("alg") != "RS256"
                or not isinstance(kid, str)
                or not 1 <= len(kid) <= 128
                or any(name in header for name in ("jku", "jwk", "x5u", "x5c"))
            ):
                raise GoogleRejected()
            token = jwt.decode(value, await self.key_set(kid), algorithms=["RS256"])
            claims = token.claims
            now = self.clock().timestamp()
            if (
                claims.get("iss") not in {ISSUER, "accounts.google.com"}
                or type(claims.get("exp")) is not int
                or type(claims.get("iat")) is not int
                or claims["exp"] <= now
                or claims["iat"] < 0
                or claims["iat"] >= claims["exp"]
            ):
                raise GoogleRejected()
            jwt.JWTClaimsRegistry(
                now=int(now),
                leeway=self.config.clock_skew_seconds,
                iss={"essential": True, "values": [ISSUER, "accounts.google.com"]},
                aud={"essential": True, "value": self.environment.google_client_id},
                exp={"essential": True},
                iat={"essential": True},
                sub={"essential": True},
            ).validate(claims)
            audience = claims["aud"]
            if not isinstance(audience, str) and not (
                isinstance(audience, list)
                and 1 <= len(audience) <= 8
                and all(isinstance(item, str) and 1 <= len(item) <= 255 for item in audience)
                and len(set(audience)) == len(audience)
            ):
                raise GoogleRejected()
            if (isinstance(audience, list) and len(audience) > 1) or "azp" in claims:
                if claims.get("azp") != self.environment.google_client_id:
                    raise GoogleRejected()
            if subject is None or "nonce" in claims:
                nonce = claims.get("nonce")
                if not isinstance(nonce, str) or not hmac.compare_digest(digest(nonce), nonce_hash):
                    raise GoogleRejected()
            identity = profile(claims)
            if subject is not None and identity.subject != subject:
                raise GoogleRejected()
            return identity
        except (JoseError, ValueError, TypeError, KeyError, UnicodeError):
            raise GoogleRejected() from None

    def token_fields(self, payload: dict[str, Any]) -> tuple[str, str | None, datetime]:
        access = payload.get("access_token")
        refresh = payload.get("refresh_token")
        expires = payload.get("expires_in")
        if (
            not isinstance(payload.get("token_type"), str)
            or payload["token_type"].lower() != "bearer"
            or not isinstance(access, str)
            or re.fullmatch(r"[\x21-\x7e]{1,8192}", access) is None
            or (
                refresh is not None
                and (
                    not isinstance(refresh, str)
                    or re.fullmatch(r"[\x21-\x7e]{1,8192}", refresh) is None
                )
            )
            or type(expires) is not int
            or not 1 <= expires <= 86400
        ):
            raise GoogleRejected()
        return access, refresh, self.clock() + timedelta(seconds=expires)

    def client_fields(self) -> dict[str, str]:
        if not self.environment.google_available or self.environment.google_client_secret is None:
            raise GoogleUnavailable()
        return {
            "client_id": self.environment.google_client_id,
            "client_secret": self.environment.google_client_secret.get_secret_value(),
        }

    async def exchange(self, code: str, verifier: str, nonce_hash: str) -> Grant:
        payload = await self.request(
            "POST",
            TOKEN,
            data={
                **self.client_fields(),
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": verifier,
                "redirect_uri": self.environment.public_origin + "/auth/callback",
            },
        )
        access, refresh, expires = self.token_fields(payload)
        identity = await self.verify(payload.get("id_token", ""), nonce_hash)
        return Grant(identity, access, refresh, expires, nonce_hash)

    async def check(self, grant: Grant) -> Grant:
        if grant.expires_at <= self.clock() + timedelta(seconds=self.config.clock_skew_seconds):
            if grant.refresh_token is None:
                raise GoogleRejected()
            payload = await self.request(
                "POST",
                TOKEN,
                data={
                    **self.client_fields(),
                    "grant_type": "refresh_token",
                    "refresh_token": grant.refresh_token,
                },
            )
            access, refresh, expires = self.token_fields(payload)
            if "id_token" in payload:
                await self.verify(
                    payload["id_token"], grant.nonce_hash, subject=grant.identity.subject
                )
            grant = replace(
                grant,
                access_token=access,
                refresh_token=refresh or grant.refresh_token,
                expires_at=expires,
            )
        claims = await self.request(
            "GET", USERINFO, headers={"Authorization": "Bearer " + grant.access_token}
        )
        identity = profile(claims)
        if identity.subject != grant.identity.subject:
            raise GoogleRejected()
        return replace(grant, identity=identity)

    async def revoke(self, token: str) -> None:
        await self.request("POST", REVOKE, data={"token": token})
