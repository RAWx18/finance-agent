# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import logging
import re
from contextlib import suppress

from fastapi import APIRouter, Request, Response
from fastapi.responses import RedirectResponse

from .auth import COOKIE, FLOW_COOKIE, Auth, AuthProblem
from .auth_models import (
    Access,
    AccountDelete,
    AccountDeleted,
    AccountUpdate,
    AuthModel,
    AuthSession,
    AuthSettings,
    LoginRequest,
    LoginURL,
    User,
)
from .google import GoogleRejected, GoogleUnavailable
from .store import Problem
from .voice import CallManager

logger = logging.getLogger(__name__)


def owner(request: Request) -> Access:
    access = getattr(request.state, "access", None)
    if not isinstance(access, Access):
        raise AuthProblem(401, "unauthenticated")
    return access


def router(auth: Auth, calls: CallManager) -> APIRouter:
    routes = APIRouter()
    secure = auth.environment.public_origin.startswith("https:")

    def clear(response: Response, *, session: bool = False) -> None:
        for name in (COOKIE, FLOW_COOKIE) if session else (FLOW_COOKIE,):
            response.delete_cookie(
                auth.cookie_name(name), path="/", httponly=True, secure=secure, samesite="lax"
            )

    @routes.get("/api/auth/settings", response_model=AuthSettings)
    async def settings() -> AuthSettings:
        return AuthSettings(
            google_available=auth.environment.google_available,
            session_hours=auth.config.session_hours,
        )

    @routes.post("/api/auth/login", response_model=LoginURL)
    async def login(request: Request, response: Response, body: LoginRequest) -> LoginURL:
        url, binding = await auth.begin(
            body.return_to, auth.cookie(request, COOKIE), auth.cookie(request, FLOW_COOKIE)
        )
        response.set_cookie(
            auth.cookie_name(FLOW_COOKIE),
            binding,
            max_age=auth.config.oauth_seconds,
            httponly=True,
            secure=secure,
            samesite="lax",
            path="/",
        )
        return LoginURL(url=url)

    @routes.get("/auth/callback", response_model=None, include_in_schema=False)
    async def callback(request: Request) -> RedirectResponse:
        binding = None
        flow = None
        failure = "failed"
        try:
            auth.limit("callback", auth.address(request), auth.config.invalid_limit)
            binding = auth.cookie(request, FLOW_COOKIE)
            params = request.query_params
            if (
                len(request.scope.get("query_string", b"")) > auth.config.provider_max_bytes
                or any(
                    len(params.getlist(key)) > 1
                    for key in ("state", "code", "error", "error_description", "error_uri", "iss")
                )
                or not binding
                or re.fullmatch(r"[A-Za-z0-9_-]{43}", params.get("state", "")) is None
                or ("code" in params and "error" in params)
                or params.get("iss", "https://accounts.google.com")
                not in {"https://accounts.google.com", "accounts.google.com"}
            ):
                raise AuthProblem(401, "unauthenticated")
            flow = await auth.consume(params["state"], binding)
            if "error" in params:
                failure = "cancelled" if params["error"] == "access_denied" else "failed"
                raise AuthProblem(401, "unauthenticated")
            code = params.get("code", "")
            if re.fullmatch(r"[\x21-\x7e]{1,4096}", code) is None:
                raise AuthProblem(401, "unauthenticated")
            if not auth.environment.google_available:
                raise AuthProblem(503, "authUnavailable")
            async with asyncio.timeout(auth.config.provider_timeout_seconds * 3):
                grant = await auth.google.exchange(
                    code, auth.decrypt(flow["verifier"]), flow["nonce_hash"]
                )
            token, return_to = await auth.complete(flow, grant)
            response = RedirectResponse(return_to, status_code=303)
            response.set_cookie(
                auth.cookie_name(COOKIE),
                token,
                max_age=auth.config.session_hours * 3600,
                httponly=True,
                secure=secure,
                samesite="lax",
                path="/",
            )
            clear(response)
            await calls.settle_revoked()
            return response
        except (GoogleUnavailable, TimeoutError):
            failure = "unavailable"
        except GoogleRejected:
            failure = "failed"
        except Problem as error:
            if error.status == 503:
                failure = "unavailable"
            elif error.body.code == "sessionExpired":
                failure = "expired"
        finally:
            if flow is not None:
                await auth.discard(binding)
        logger.warning("authCallbackRejected")
        response = RedirectResponse("/login?error=" + failure, status_code=303)
        clear(response)
        return response

    @routes.get("/api/auth/session", response_model=AuthSession)
    async def session(request: Request) -> AuthSession:
        return await auth.session(owner(request))

    @routes.post("/api/auth/refresh", response_model=AuthSession)
    async def refresh(request: Request, body: AuthModel) -> AuthSession:
        return await auth.session(owner(request), refresh=True)

    @routes.post("/api/auth/logout", status_code=204)
    async def logout(request: Request, body: AuthModel) -> Response:
        cookies: list[str | None] = []
        for name in (COOKIE, FLOW_COOKIE):
            try:
                cookies.append(auth.cookie(request, name))
            except AuthProblem:
                cookies.append(None)
        await auth.logout(*cookies)
        response = Response(status_code=204)
        clear(response, session=True)
        await calls.settle_revoked()
        return response

    @routes.patch("/api/account", response_model=User)
    async def account(request: Request, body: AccountUpdate) -> User:
        return await auth.rename(owner(request), body.display_name)

    @routes.delete("/api/account", response_model=AccountDeleted)
    async def delete(request: Request, response: Response, body: AccountDelete) -> AccountDeleted:
        token = await auth.delete(owner(request))
        clear(response, session=True)
        await calls.settle_revoked()
        if token:
            with suppress(GoogleRejected, GoogleUnavailable, TimeoutError):
                async with asyncio.timeout(auth.config.provider_timeout_seconds):
                    await auth.google.revoke(token)
        return AccountDeleted()

    return routes
