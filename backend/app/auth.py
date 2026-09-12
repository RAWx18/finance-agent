# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import logging
import math
import re
import secrets
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime
from uuid import UUID, uuid4

from cryptography.fernet import Fernet, InvalidToken
from fastapi import Request

from .auth_models import Access, AuthSession, ReturnPath, User, is_return_path
from .config import Environment
from .google import ISSUER, Google, GoogleRejected, GoogleUnavailable, Grant, Identity, digest
from .store import Problem, Store

COOKIE = "financeSession"
FLOW_COOKIE = "financeLogin"
logger = logging.getLogger(__name__)


class AuthProblem(Problem):
    """Authentication failure with a public message and optional retry delay."""

    def __init__(self, status: int, code: str, retry_after: int | None = None):
        """Set the public error message and retry delay for an authentication failure."""
        message = (
            "Sign in to continue."
            if status in {401, 428}
            else "Too many requests; try again shortly."
            if status == 429
            else "Sign-in is temporarily unavailable. Please try again shortly."
        )
        super().__init__(status, code, message)
        self.retry_after = retry_after


class Auth:
    """Google sign-in, session authorization, and account lifecycle management."""

    def __init__(self, store: Store, environment: Environment, google: Google | None = None):
        """Initialize authentication services and register store authorization checks."""
        self.store = store
        self.config = store.config.auth
        self.environment = environment
        self.google = google or Google(self.config, environment, lambda: store.clock())
        self.cipher = (
            Fernet(environment.auth_encryption_key.get_secret_value().encode())
            if environment.auth_encryption_key
            else None
        )
        self.rates: dict[tuple[str, str], tuple[float, int]] = {}
        self.check_lock = asyncio.Lock()
        self.on_revoke: Callable[[str, str | None], None] | None = None
        store.authorize = self.check
        store.authorize_locked = self.guard_locked

    def now(self) -> float:
        """Return the current authentication time as a Unix timestamp."""
        return self.store.clock().timestamp()

    async def open(self) -> None:
        """Prepare authentication storage and open the Google client."""
        await self.store.connection().executescript(
            """
            PRAGMA secure_delete = ON;
            CREATE TABLE IF NOT EXISTS auth_generation (
                id INTEGER PRIMARY KEY CHECK(id = 1), value INTEGER NOT NULL
            );
            INSERT OR IGNORE INTO auth_generation VALUES (1, 0);
            CREATE TABLE IF NOT EXISTS auth_users (
                id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
                display_name TEXT NOT NULL, google_name TEXT NOT NULL, email TEXT NOT NULL,
                generation INTEGER NOT NULL, UNIQUE(issuer, subject)
            );
            CREATE TABLE IF NOT EXISTS user_memories (
                owner TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
                scope TEXT NOT NULL CHECK(scope IN ('common', 'user')),
                key TEXT NOT NULL,
                text TEXT NOT NULL,
                updated TEXT NOT NULL,
                expires TEXT,
                PRIMARY KEY(owner, scope, key)
            );
            CREATE TABLE IF NOT EXISTS auth_grants (
                user_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
                access_token TEXT NOT NULL, refresh_token TEXT, expires REAL NOT NULL,
                checked REAL NOT NULL, nonce_hash TEXT NOT NULL, version INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS auth_sessions (
                hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
                created REAL NOT NULL, expires REAL NOT NULL, idle_expires REAL NOT NULL,
                binding_hash TEXT NOT NULL UNIQUE, previous_hash TEXT
            );
            CREATE INDEX IF NOT EXISTS auth_session_user ON auth_sessions(user_id);
            CREATE INDEX IF NOT EXISTS auth_session_expiry ON auth_sessions(expires);
            CREATE TABLE IF NOT EXISTS auth_flows (
                state_hash TEXT PRIMARY KEY, binding_hash TEXT NOT NULL UNIQUE,
                verifier TEXT NOT NULL, nonce_hash TEXT NOT NULL, return_to TEXT NOT NULL,
                expires REAL NOT NULL, claimed INTEGER NOT NULL DEFAULT 0,
                user_id TEXT REFERENCES auth_users(id) ON DELETE CASCADE,
                session_hash TEXT REFERENCES auth_sessions(hash) ON DELETE CASCADE,
                generation INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS auth_flow_expiry ON auth_flows(expires);
            CREATE TRIGGER IF NOT EXISTS auth_finance_owner BEFORE INSERT ON sessions
            WHEN length(NEW.owner) = 36
                 AND NOT EXISTS (SELECT 1 FROM auth_users WHERE id = NEW.owner)
            BEGIN SELECT RAISE(ABORT, 'Owner unavailable'); END;
            CREATE TRIGGER IF NOT EXISTS auth_delete_finances AFTER DELETE ON auth_users
            BEGIN DELETE FROM sessions WHERE owner = OLD.id; END;
            """
        )
        await self.store.connection().commit()
        await self.google.open()

    async def close(self) -> None:
        """Close the Google client and clear request rate counters."""
        await self.google.close()
        self.rates.clear()

    def limit(self, kind: str, key: str, maximum: int) -> None:
        """Count a request and reject it when its rate limit is exceeded."""
        now = self.now()
        bucket = (kind, digest(key))
        start, count = self.rates.get(bucket, (now, 0))
        if not 0 <= now - start < self.config.rate_window_seconds:
            start, count = now, 0
        if bucket not in self.rates:
            self.rates = {
                item: value
                for item, value in self.rates.items()
                if 0 <= now - value[0] < self.config.rate_window_seconds
            }
            if len(self.rates) >= self.config.max_rate_keys:
                raise AuthProblem(429, "rateLimited", self.config.rate_window_seconds)
        if count >= maximum:
            if count == maximum:
                logger.warning("authRateLimited")
                self.rates[bucket] = (start, count + 1)
            raise AuthProblem(
                429, "rateLimited", max(1, math.ceil(start + self.config.rate_window_seconds - now))
            )
        self.rates[bucket] = (start, count + 1)

    def address(self, request: Request) -> str:
        """Return the client address or an unknown-address marker."""
        return request.client.host if request.client else "unknown"

    def cookie_name(self, name: str) -> str:
        """Choose the authentication cookie name for the public origin's security level."""
        return "__Host-" + name if self.environment.public_origin.startswith("https:") else name

    def cookie(self, request: Request, name: str) -> str | None:
        """Read an authentication cookie, rejecting oversized or ambiguous values."""
        name = self.cookie_name(name)
        headers = request.headers.getlist("cookie")
        if sum(len(value) for value in headers) > self.config.max_cookie_bytes:
            raise AuthProblem(401, "unauthenticated")
        values = [
            part.strip().partition("=")[2]
            for header in headers
            for part in header.split(";")
            if part.strip().partition("=")[0] == name
        ]
        if not values:
            return None
        if len(values) != 1 or re.fullmatch(r"[A-Za-z0-9_-]{43}", values[0]) is None:
            raise AuthProblem(401, "unauthenticated")
        return values[0]

    async def identify(self, request: Request) -> Access:
        """Authenticate the request's session cookie and rate-limit invalid credentials."""
        try:
            token = self.cookie(request, COOKIE)
            if token is None:
                raise AuthProblem(401, "unauthenticated")
            async with self.store.lock:
                async with self.store.connection().execute(
                    "SELECT user_id FROM auth_sessions WHERE hash = ?", (digest(token),)
                ) as cursor:
                    row = await cursor.fetchone()
            if row is None:
                raise AuthProblem(401, "unauthenticated")
            access = Access(str(row[0]), digest(token))
            await self.check(access)
            return access
        except Problem as error:
            if error.status == 401:
                self.limit("invalid", self.address(request), self.config.invalid_limit)
            raise

    async def row_locked(self, access: Access) -> sqlite3.Row:
        """Load valid session credentials while the caller holds the store lock."""
        async with self.store.connection().execute(
            "SELECT u.*, s.hash, s.created, s.expires AS absolute_expires, s.idle_expires, "
            "g.access_token, g.refresh_token, g.expires AS token_expires, "
            "g.checked, g.nonce_hash, g.version FROM auth_sessions s "
            "JOIN auth_users u ON u.id = s.user_id JOIN auth_grants g ON g.user_id = u.id "
            "WHERE s.hash = ? AND s.user_id = ?",
            (access.session_hash, access.user_id),
        ) as cursor:
            cursor.row_factory = sqlite3.Row
            row = await cursor.fetchone()
        if row is None:
            self.revoke(access.user_id, access.session_hash)
            raise AuthProblem(401, "unauthenticated")
        if min(row["absolute_expires"], row["idle_expires"]) <= self.now() or (
            row["refresh_token"] is None and row["token_expires"] <= self.now()
        ):
            self.revoke(access.user_id, access.session_hash)
            raise AuthProblem(401, "sessionExpired")
        return row

    def due(self, row: sqlite3.Row) -> bool:
        """Determine whether Google credentials require revalidation."""
        return bool(
            row["checked"] + self.config.recheck_seconds <= self.now()
            or row["token_expires"] <= self.now()
        )

    def overdue(self, row: sqlite3.Row) -> bool:
        """Determine whether an unverified grant may no longer be served."""
        # A due recheck that Google could not answer keeps a still-valid token usable briefly.
        return bool(
            row["checked"] + self.config.recheck_seconds + self.config.recheck_grace_seconds
            <= self.now()
            or row["token_expires"] <= self.now()
        )

    async def guard_locked(self, access: Access) -> None:
        """Require a valid, recently checked session while the store lock is held."""
        row = await self.row_locked(access)
        if not self.environment.google_available or self.overdue(row):
            raise AuthProblem(503, "authUnavailable")

    def encrypt(self, value: str) -> str:
        """Encrypt a credential for storage, requiring an available encryption key."""
        if self.cipher is None:
            raise AuthProblem(503, "authUnavailable")
        return self.cipher.encrypt(value.encode()).decode()

    def decrypt(self, value: str) -> str:
        """Decrypt a stored credential or report authentication unavailability."""
        if self.cipher is None:
            raise AuthProblem(503, "authUnavailable")
        try:
            return self.cipher.decrypt(value.encode()).decode()
        except (InvalidToken, UnicodeError):
            raise AuthProblem(503, "authUnavailable") from None

    def revoke(self, user_id: str, session_hash: str | None = None) -> None:
        """Revoke live access for a user's sessions and notify the revocation handler."""
        # Live connections fail closed before the transaction's cancellable commit.
        self.store.revoke(user_id, session_hash)
        if self.on_revoke is not None:
            self.on_revoke(user_id, session_hash)

    async def check(self, access: Access) -> None:
        """Authorize a session, revalidating Google credentials when required."""
        async with self.store.lock:
            row = await self.row_locked(access)
            if not self.environment.google_available:
                raise AuthProblem(503, "authUnavailable")
            if not self.due(row):
                return
        try:
            async with asyncio.timeout(self.config.provider_timeout_seconds * 3):
                async with self.check_lock:
                    async with self.store.lock:
                        row = await self.row_locked(access)
                        if not self.due(row):
                            return
                        grant = Grant(
                            Identity(row["subject"], row["google_name"], row["email"]),
                            self.decrypt(row["access_token"]),
                            self.decrypt(row["refresh_token"]) if row["refresh_token"] else None,
                            datetime.fromtimestamp(row["token_expires"], UTC),
                            row["nonce_hash"],
                        )
                    try:
                        grant = await self.google.check(grant)
                    except GoogleRejected:
                        async with self.store.lock:
                            current = await self.row_locked(access)
                            # A stale provider rejection must not revoke a newer grant.
                            if current["version"] == row["version"]:
                                async with self.store.transaction():
                                    await self.store.connection().execute(
                                        "DELETE FROM auth_sessions WHERE user_id = ?",
                                        (access.user_id,),
                                    )
                                    await self.store.connection().execute(
                                        "DELETE FROM auth_grants WHERE user_id = ?",
                                        (access.user_id,),
                                    )
                                    self.revoke(access.user_id)
                                logger.warning("authCredentialRevoked")
                            else:
                                await self.guard_locked(access)
                                return
                        raise AuthProblem(401, "unauthenticated") from None
                    async with self.store.lock:
                        current = await self.row_locked(access)
                        if current["version"] == row["version"]:
                            async with self.store.transaction():
                                await self.store.connection().execute(
                                    "UPDATE auth_grants SET access_token = ?, refresh_token = ?, "
                                    "expires = ?, checked = ?, version = version + 1 "
                                    "WHERE user_id = ?",
                                    (
                                        self.encrypt(grant.access_token),
                                        self.encrypt(grant.refresh_token)
                                        if grant.refresh_token
                                        else None,
                                        grant.expires_at.timestamp(),
                                        self.now(),
                                        access.user_id,
                                    ),
                                )
                                await self.store.connection().execute(
                                    "UPDATE auth_users SET google_name = ?, email = ? WHERE id = ?",
                                    (grant.identity.name, grant.identity.email, access.user_id),
                                )
                        await self.guard_locked(access)
        except (GoogleUnavailable, TimeoutError):
            logger.warning("authProviderUnavailable")
            async with self.store.lock:
                if self.overdue(await self.row_locked(access)):
                    raise AuthProblem(503, "authUnavailable") from None

    def session_value(self, row: sqlite3.Row) -> AuthSession:
        """Build the public user session with its effective expiration time."""
        expires = min(row["absolute_expires"], row["idle_expires"])
        if row["refresh_token"] is None:
            expires = min(expires, row["token_expires"])
        return AuthSession(
            user=User(
                id=UUID(row["id"]),
                display_name=row["display_name"],
                google_name=row["google_name"],
                email=row["email"],
            ),
            expires_at=datetime.fromtimestamp(expires, UTC),
        )

    async def session(self, access: Access, *, refresh: bool = False) -> AuthSession:
        """Return an authorized session, optionally extending its idle expiration."""
        await self.check(access)
        async with self.store.lock:
            await self.guard_locked(access)
            if refresh:
                async with self.store.transaction():
                    await self.store.connection().execute(
                        "UPDATE auth_sessions SET idle_expires = MIN(expires, ?) WHERE hash = ?",
                        (self.now() + self.config.idle_hours * 3600, access.session_hash),
                    )
            return self.session_value(await self.row_locked(access))

    async def begin(
        self, return_to: ReturnPath, token: str | None, previous_flow: str | None
    ) -> tuple[str, str]:
        """Start a bound Google login flow and return its URL and browser token."""
        if not self.environment.google_available:
            raise AuthProblem(503, "authUnavailable")
        state, binding, nonce, verifier = (secrets.token_urlsafe(32) for _ in range(4))
        async with self.store.lock:
            db = self.store.connection()
            async with db.execute(
                "SELECT s.user_id, s.hash, g.refresh_token FROM auth_sessions s "
                "JOIN auth_grants g ON g.user_id = s.user_id "
                "WHERE s.hash = ? AND s.expires > ? AND s.idle_expires > ?",
                (digest(token) if token else "", self.now(), self.now()),
            ) as cursor:
                current = await cursor.fetchone()
            async with self.store.transaction():
                await db.execute(
                    "DELETE FROM auth_flows WHERE expires <= ? OR binding_hash = ?",
                    (self.now(), digest(previous_flow) if previous_flow else ""),
                )
                async with db.execute("SELECT COUNT(*) FROM auth_flows") as cursor:
                    count = await cursor.fetchone()
                if count and count[0] >= self.config.max_flows:
                    raise AuthProblem(429, "rateLimited", self.config.oauth_seconds)
                await db.execute(
                    "INSERT INTO auth_flows (state_hash, binding_hash, verifier, nonce_hash, "
                    "return_to, expires, user_id, session_hash, generation) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT value FROM auth_generation))",
                    (
                        digest(state),
                        digest(binding),
                        self.encrypt(verifier),
                        digest(nonce),
                        return_to,
                        self.now() + self.config.oauth_seconds,
                        current[0] if current else None,
                        current[1] if current else None,
                    ),
                )
        # A retained Google grant must not bypass consent when the app has no signed-in session.
        return self.google.authorization_url(
            state, nonce, verifier, consent=current is None or not current[2]
        ), binding

    async def consume(self, state: str, binding: str) -> sqlite3.Row:
        """Claim an unexpired login flow matching its state and browser binding."""
        async with self.store.lock:
            db = self.store.connection()
            async with self.store.transaction():
                async with db.execute(
                    "SELECT * FROM auth_flows WHERE state_hash = ? AND binding_hash = ? "
                    "AND claimed = 0",
                    (digest(state), digest(binding)),
                ) as cursor:
                    cursor.row_factory = sqlite3.Row
                    row = await cursor.fetchone()
                if row is None:
                    raise AuthProblem(401, "unauthenticated")
                if row["expires"] <= self.now():
                    raise AuthProblem(401, "sessionExpired")
                await db.execute(
                    "UPDATE auth_flows SET claimed = 1 WHERE state_hash = ?", (digest(state),)
                )
                return row

    async def discard(self, binding: str | None) -> None:
        """Delete the pending login flow for a supplied browser binding."""
        if binding:
            async with self.store.lock, self.store.transaction():
                await self.store.connection().execute(
                    "DELETE FROM auth_flows WHERE binding_hash = ?", (digest(binding),)
                )

    async def complete(self, flow: sqlite3.Row, grant: Grant) -> tuple[str, ReturnPath]:
        """Complete a claimed login and return its session token and safe redirect path."""
        token = secrets.token_urlsafe(32)
        revoked: list[tuple[str, str]] = []
        async with self.store.lock:
            db = self.store.connection()
            async with self.store.transaction():
                async with db.execute(
                    "DELETE FROM auth_flows WHERE state_hash = ? AND binding_hash = ? "
                    "AND claimed = 1 AND expires > ? RETURNING state_hash",
                    (flow["state_hash"], flow["binding_hash"], self.now()),
                ) as cursor:
                    if await cursor.fetchone() is None:
                        raise AuthProblem(401, "unauthenticated")
                async with db.execute(
                    "SELECT id, generation FROM auth_users WHERE issuer = ? AND subject = ?",
                    (ISSUER, grant.identity.subject),
                ) as cursor:
                    user = await cursor.fetchone()
                async with db.execute("SELECT value FROM auth_generation") as cursor:
                    generation = await cursor.fetchone()
                assert generation is not None
                # An epoch prevents a pre-deletion callback from recreating an erased identity.
                if (user is None and flow["generation"] != generation[0]) or (
                    user and user[1] > flow["generation"]
                ):
                    raise AuthProblem(401, "unauthenticated")
                user_id = str(user[0]) if user else str(uuid4())
                if user is None:
                    async with db.execute("SELECT COUNT(*) FROM auth_users") as cursor:
                        count = await cursor.fetchone()
                    if count and count[0] >= self.config.max_users:
                        raise AuthProblem(503, "authUnavailable")
                    await db.execute(
                        "INSERT INTO auth_users VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            user_id,
                            ISSUER,
                            grant.identity.subject,
                            grant.identity.name[:80] or "Google user",
                            grant.identity.name,
                            grant.identity.email,
                            generation[0],
                        ),
                    )
                else:
                    await db.execute(
                        "UPDATE auth_users SET google_name = ?, email = ? WHERE id = ?",
                        (grant.identity.name, grant.identity.email, user_id),
                    )
                async with db.execute(
                    "SELECT refresh_token, nonce_hash FROM auth_grants WHERE user_id = ?",
                    (user_id,),
                ) as cursor:
                    prior = await cursor.fetchone()
                refresh_token = (
                    self.encrypt(grant.refresh_token)
                    if grant.refresh_token
                    else (prior[0] if prior else None)
                )
                await db.execute(
                    "INSERT INTO auth_grants VALUES (?, ?, ?, ?, ?, ?, 1) "
                    "ON CONFLICT(user_id) DO UPDATE SET access_token = excluded.access_token, "
                    "refresh_token = excluded.refresh_token, expires = excluded.expires, "
                    "checked = excluded.checked, nonce_hash = excluded.nonce_hash, "
                    "version = auth_grants.version + 1",
                    (
                        user_id,
                        self.encrypt(grant.access_token),
                        refresh_token,
                        grant.expires_at.timestamp(),
                        self.now(),
                        # Keep the nonce paired with the retained refresh token.
                        prior[1]
                        if not grant.refresh_token and prior and prior[0]
                        else grant.nonce_hash,
                    ),
                )
                if flow["session_hash"]:
                    await db.execute(
                        "DELETE FROM auth_sessions WHERE hash = ?", (flow["session_hash"],)
                    )
                    revoked.append((flow["user_id"], flow["session_hash"]))
                async with db.execute(
                    "SELECT hash FROM auth_sessions WHERE user_id = ? ORDER BY created DESC, hash",
                    (user_id,),
                ) as cursor:
                    logins = await cursor.fetchall()
                for login in list(logins)[self.config.max_logins_per_user - 1 :]:
                    await db.execute("DELETE FROM auth_sessions WHERE hash = ?", (login[0],))
                    revoked.append((user_id, login[0]))
                await db.execute(
                    "INSERT INTO auth_sessions VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        digest(token),
                        user_id,
                        self.now(),
                        self.now() + self.config.session_hours * 3600,
                        self.now() + self.config.idle_hours * 3600,
                        flow["binding_hash"],
                        flow["session_hash"],
                    ),
                )
                for owner, session_hash in revoked:
                    self.revoke(owner, session_hash)
        return_to: ReturnPath = flow["return_to"]
        if not is_return_path(return_to):
            return_to = "/app"
        return token, return_to

    async def logout(self, token: str | None, binding: str | None) -> None:
        """Revoke sessions and pending logins associated with the browser credentials."""
        async with self.store.lock:
            db = self.store.connection()
            async with self.store.transaction():
                await db.execute(
                    "DELETE FROM auth_flows WHERE binding_hash = ?",
                    (digest(binding) if binding else "",),
                )
                async with db.execute(
                    "DELETE FROM auth_sessions WHERE hash = ? OR previous_hash = ? "
                    "OR binding_hash = ? RETURNING user_id, hash",
                    (
                        digest(token) if token else "",
                        digest(token) if token else "",
                        digest(binding) if binding else "",
                    ),
                ) as cursor:
                    rows = await cursor.fetchall()
                for row in rows:
                    self.revoke(row[0], row[1])

    async def rename(self, access: Access, name: str) -> User:
        """Change the authenticated user's display name and return their profile."""
        await self.check(access)
        async with self.store.lock, self.store.transaction():
            await self.guard_locked(access)
            await self.store.connection().execute(
                "UPDATE auth_users SET display_name = ? WHERE id = ?", (name, access.user_id)
            )
            return self.session_value(await self.row_locked(access)).user

    async def delete(self, access: Access) -> str | None:
        """Delete a recently authenticated account and return its revocable Google token."""
        await self.check(access)
        async with self.store.lock:
            db = self.store.connection()
            async with self.store.transaction():
                await self.guard_locked(access)
                row = await self.row_locked(access)
                if row["created"] + self.config.recent_signin_seconds < self.now():
                    raise AuthProblem(428, "requiresSignin")
                token = self.decrypt(row["refresh_token"] or row["access_token"])
                await db.execute("DELETE FROM auth_users WHERE id = ?", (access.user_id,))
                await db.execute("UPDATE auth_generation SET value = value + 1")
                self.revoke(access.user_id)
            try:
                await db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except sqlite3.Error:
                logger.warning("authDeletionCheckpointFailed")
        return token

    async def cleanup(self) -> None:
        """Delete expired login flows, memories, and sessions, revoking live access."""
        async with self.store.lock:
            db = self.store.connection()
            async with self.store.transaction():
                await db.execute("DELETE FROM auth_flows WHERE expires <= ?", (self.now(),))
                await db.execute(
                    "DELETE FROM user_memories WHERE expires <= ?",
                    (self.store.clock().astimezone(UTC).isoformat(),),
                )
                async with db.execute(
                    "DELETE FROM auth_sessions WHERE expires <= ? OR idle_expires <= ? "
                    "RETURNING user_id, hash",
                    (self.now(), self.now()),
                ) as cursor:
                    rows = await cursor.fetchall()
                for row in rows:
                    self.revoke(row[0], row[1])
