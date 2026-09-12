# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import logging
import re
import sqlite3
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, suppress
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    PlainTextResponse,
    RedirectResponse,
    StreamingResponse,
)
from starlette.exceptions import HTTPException
from starlette.routing import Match
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from structlog.contextvars import bind_contextvars, reset_contextvars

from .auth import Auth, AuthProblem
from .auth_models import is_return_path
from .auth_routes import owner
from .auth_routes import router as auth_router
from .config import ROOT, Config, Environment, load_config
from .diagnostics import diagnostic_sink, record_event, request_id
from .finance import export_text
from .google import Google
from .history import ConversationList, History, SavedConversation, transcript
from .models import (
    AdjustmentOptions,
    CallJoin,
    CallRequest,
    CallState,
    Command,
    Deleted,
    Error,
    Health,
    Model,
    Settings,
    Snapshot,
)
from .store import Problem, Store, utc_now
from .telemetry import configure as configure_logging
from .telemetry import get_logger
from .voice import VOICE_UNAVAILABLE, CallManager, unavailable_reason

http_log = get_logger(__name__, "http")

# Locally constructed voice setup reasons that are safe to log; anything else is generic.
VOICE_REASONS = {
    "Daily room service is unavailable.",
    "Daily returned an invalid room.",
    "Daily returned an invalid token.",
    "Voice is shutting down.",
    "Voice setup failed; continue with manual entry.",
    "Configured female English voice is unavailable in this Azure Speech resource; "
    "verify voice.tts_voice, voice.tts_locale, and AZURE_SPEECH_REGION.",
    "Azure Speech voice check failed; verify the resource region and service connectivity.",
}
VOICE_CHECK_STATUS = re.compile(
    r"Azure Speech voice check returned HTTP [1-5][0-9]{2}; "
    r"check the speech key, resource region, and service availability\."
)


def voice_reason(message: str) -> str:
    """Reduce a voice failure message to a known safe reason."""
    if message in VOICE_REASONS or VOICE_CHECK_STATUS.fullmatch(message):
        return message
    return "Voice setup failed."


class CallbackLogFilter(logging.Filter):
    """Exclude authentication callbacks even if access logging is re-enabled externally."""

    def filter(self, record: logging.LogRecord) -> bool:
        return "/auth/callback" not in record.getMessage()


class ServerLogFilter(logging.Filter):
    """Keep Uvicorn's duplicate ASGI reports from rendering private exception messages."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str) and record.msg.startswith("Exception in ASGI application"):
            record.msg = "ASGI request failed; consult correlated diagnostics."
            record.args = ()
            record.exc_info = None
            record.exc_text = None
        return True


logging.getLogger("uvicorn.error").addFilter(ServerLogFilter())
logging.getLogger("uvicorn.access").addFilter(CallbackLogFilter())
# Access logs contain raw history slugs and authentication query parameters.
logging.getLogger("uvicorn.access").disabled = True


def route_template(scope: Scope) -> str | None:
    """Resolve the registered route pattern so logs never carry slugs or identifiers."""
    route = getattr(scope.get("route"), "path", None)
    if route is None:
        for candidate in scope["app"].routes:
            match, _ = candidate.matches(scope)
            if match is Match.FULL:
                route = getattr(candidate, "path", None)
                break
    return route if isinstance(route, str) else None


def request_failure(
    scope: Scope, status: int, *, error: BaseException | None = None, **fields: object
) -> None:
    """Record each relevant HTTP failure once using only its registered route template."""
    if status < 500 and (
        status < 400
        or status == 404
        or (
            scope["method"] not in {"POST", "PUT", "PATCH", "DELETE"}
            and status not in {409, 410, 428, 429}
        )
    ):
        return
    state = scope.setdefault("state", {})
    if state.get("diagnostic_failure"):
        return
    state["diagnostic_failure"] = True
    token = request_id.set(state.get("diagnostic_request_id"))
    try:
        record_event(
            "http.failure",
            error=error,
            call_id=state.get("diagnostic_call_id"),
            status=status,
            method=scope["method"],
            route=route_template(scope),
            **fields,
        )
    finally:
        request_id.reset(token)


class Boundary:
    """HTTP boundary enforcing request security, authorization, and payload limits."""

    def __init__(self, app: ASGIApp, config: Config, environment: Environment, auth: Auth):
        """Bind the application to its request-security settings and authentication service."""
        self.app = app
        self.config = config
        self.environment = environment
        self.auth = auth

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Correlate each request, attach security headers, and log API request outcomes."""
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope["headers"]
        }
        identity = uuid4()
        scope.setdefault("state", {})["diagnostic_request_id"] = identity
        token = request_id.set(identity)
        context = bind_contextvars(requestId=str(identity))
        started = time.monotonic()
        status: int | None = None
        # Health probes and static assets are noise; API and auth traffic is the trace of interest.
        traced = scope["path"].startswith(("/api/", "/auth/"))

        async def secured_send(message: Message) -> None:
            """Attach browser security headers before forwarding response messages."""
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message["headers"] = [
                    (key, value)
                    for key, value in message.get("headers", [])
                    if key.lower() != b"x-request-id"
                ]
                message["headers"].extend(
                    [
                        (b"x-request-id", str(identity).encode()),
                        (b"x-content-type-options", b"nosniff"),
                        (b"referrer-policy", b"no-referrer"),
                        (b"cache-control", b"no-store"),
                        (
                            b"content-security-policy",
                            b"default-src 'self'; script-src 'self' blob: https://*.daily.co "
                            b"https://*.dailywebrtc.com https://*.dailywebrtc.net; "
                            b"style-src 'self'; connect-src 'self' https://*.daily.co "
                            b"https://*.dailywebrtc.com https://*.dailywebrtc.net "
                            b"https://prod-ks.pluot.blue wss://*.daily.co "
                            b"wss://*.dailywebrtc.com wss://*.dailywebrtc.net; "
                            b"worker-src 'self' blob:; media-src 'self' blob:; "
                            b"img-src 'self' data:; object-src 'none'; "
                            b"base-uri 'none'; frame-ancestors 'none'",
                        ),
                    ]
                )
            await send(message)

        try:
            await self.dispatch(scope, receive, secured_send, headers)
        except Exception as error:
            request_failure(
                scope,
                500,
                error=error,
                elapsed_seconds=time.monotonic() - started,
            )
            raise
        else:
            if status is not None:
                request_failure(scope, status, elapsed_seconds=time.monotonic() - started)
            if traced:
                (http_log.warning if status is not None and status >= 500 else http_log.info)(
                    "http.request",
                    method=scope["method"],
                    route=route_template(scope),
                    status=status,
                    durationMs=round((time.monotonic() - started) * 1000, 1),
                )
        finally:
            request_id.reset(token)
            reset_contextvars(**context)

    async def dispatch(
        self, scope: Scope, receive: Receive, send: Send, headers: dict[str, str]
    ) -> None:
        """Enforce HTTP request restrictions before forwarding to the application."""

        async def reject(status: int, code: str, message: str) -> None:
            """Send a structured request rejection with security headers."""
            request_failure(scope, status, code=code)
            await JSONResponse({"code": code, "message": message}, status_code=status)(
                scope, receive, send
            )

        path = scope["path"]
        if path.startswith("/api/") or path == "/auth/callback":
            if any(
                sum(key.lower() == name for key, _ in scope["headers"]) > 1
                for name in (
                    b"host",
                    b"origin",
                    b"content-type",
                    b"content-length",
                    b"sec-fetch-site",
                )
            ):
                await reject(400, "invalidHeaders", "Ambiguous request headers are not accepted.")
                return
            if (
                headers.get("host", "").lower()
                != urlsplit(self.environment.public_origin).netloc.lower()
            ):
                await reject(403, "hostRejected", "Use the configured public origin.")
                return
        if path.startswith("/api/"):
            if (
                headers.get("origin", self.environment.public_origin)
                != self.environment.public_origin
            ):
                await reject(403, "originRejected", "Cross-origin requests are not allowed.")
                return
            if headers.get("sec-fetch-site", "same-origin") not in {"same-origin", "none"}:
                await reject(403, "originRejected", "Cross-site requests are not allowed.")
                return
            mutation = scope["method"] in {"POST", "PUT", "PATCH", "DELETE"}
            if mutation and not (
                headers.get("origin") == self.environment.public_origin
                or headers.get("sec-fetch-site") == "same-origin"
            ):
                await reject(403, "originRejected", "A same-origin request is required.")
                return
            request = Request(scope)
            try:
                if path == "/api/auth/login":
                    self.auth.limit(
                        "login", self.auth.address(request), self.config.auth.login_limit
                    )
                elif path == "/api/auth/logout":
                    self.auth.limit(
                        "logout", self.auth.address(request), self.config.auth.account_limit
                    )
                elif path != "/api/auth/settings":
                    access = await self.auth.identify(request)
                    request.state.access = access
                    if mutation:
                        kind, maximum = (
                            ("account", self.config.auth.account_limit)
                            if path == "/api/account"
                            else ("voice", self.config.auth.voice_limit)
                            if path == "/api/session/call" and scope["method"] == "POST"
                            else ("mutation", self.config.auth.mutation_limit)
                        )
                        self.auth.limit(kind, access.user_id, maximum)
                if scope.get("query_string"):
                    if not (
                        path == "/api/history"
                        and scope["method"] == "GET"
                        and len(scope["query_string"])
                        <= self.config.history.max_search_chars * 12 + 7
                        and len(request.query_params.multi_items()) == 1
                        and set(request.query_params) == {"search"}
                    ):
                        await reject(400, "invalidQuery", "Query parameters are not accepted.")
                        return
            except Problem as error:
                request_failure(scope, error.status, error=error, code=error.body.code)
                await JSONResponse(
                    error.body.model_dump(mode="json", by_alias=True),
                    status_code=error.status,
                    headers={"Retry-After": str(error.retry_after)}
                    if isinstance(error, AuthProblem) and error.retry_after
                    else None,
                )(scope, receive, send)
                return
            if mutation:
                content_type = headers.get("content-type", "").split(";")[0].strip().lower()
                empty_allowed = scope["method"] == "DELETE" and path not in {
                    "/api/account",
                    "/api/session/call",
                }
                if content_type != "application/json" and not empty_allowed:
                    await reject(415, "contentType", "Use Content-Type: application/json.")
                    return
                try:
                    length = int(headers.get("content-length", "0"))
                    if length < 0:
                        raise ValueError
                except ValueError:
                    await reject(400, "invalidLength", "Invalid content length.")
                    return
                if length > self.config.max_request_bytes:
                    await reject(413, "payloadLimit", "Request exceeds the configured size limit.")
                    return
                body = bytearray()
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    body.extend(message.get("body", b""))
                    if len(body) > self.config.max_request_bytes:
                        await reject(
                            413, "payloadLimit", "Request exceeds the configured size limit."
                        )
                        return
                    if not message.get("more_body", False):
                        break
                if body and content_type != "application/json":
                    await reject(415, "contentType", "Use Content-Type: application/json.")
                    return
                delivered = False

                async def body_receive() -> Message:
                    """Deliver the validated request body once, then receive further messages."""
                    nonlocal delivered
                    if not delivered:
                        delivered = True
                        return {"type": "http.request", "body": bytes(body), "more_body": False}
                    return await receive()

                await self.app(scope, body_receive, send)
                return
        await self.app(scope, receive, send)


def create_app(
    config: Config | None = None,
    environment: Environment | None = None,
    clock: Callable[[], datetime] = utc_now,
    static_dir: Path | None = None,
    google: Google | None = None,
) -> FastAPI:
    """Build the cashflow application with shared services, routes, and lifecycle hooks."""
    config = config if config is not None else load_config()
    environment = environment if environment is not None else Environment.load()
    store = Store(environment.data_dir / "sessions.sqlite3", config, clock)
    history = History(store)
    auth = Auth(store, environment, google)
    calls = CallManager(store, config, environment, auth)
    auth.on_revoke = calls.invalidate
    static_dir = (static_dir if static_dir is not None else ROOT / "frontend" / "dist").resolve()

    async def cleanup() -> None:
        """Periodically expire stored financial and authentication data."""
        try:
            while True:
                await asyncio.sleep(config.cleanup_seconds)
                await store.cleanup()
                await auth.cleanup()
        except Exception as error:
            record_event("app.cleanupFailure", error=error, stage="cleanup")
            raise

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        """Start application services and release them when the application shuts down."""
        configure_logging(environment.log_level, environment.log_format)
        with diagnostic_sink(environment.data_dir, config.diagnostics):
            task: asyncio.Task[None] | None = None
            stage = "startup"
            record_event("app.startup", status="started")
            try:
                if (reason := unavailable_reason(config, environment)) is None:
                    from .voice_pipeline import prepare_runtime

                    await asyncio.to_thread(prepare_runtime)
                else:
                    record_event("app.voiceUnavailable", status="unavailable")
                    http_log.warning("voice.unavailable", stage="startup", reason=reason)
                await store.open()
                await auth.open()
                await store.cleanup()
                await auth.cleanup()
                task = asyncio.create_task(cleanup())
                application.state.cleanup_task = task
                record_event("app.startup", status="ok")
                stage = "runtime"
                yield
            except BaseException as error:
                record_event("app.lifecycleFailure", error=error, stage=stage)
                raise
            finally:
                record_event("app.shutdown", status="started")
                try:
                    try:
                        if task is not None:
                            task.cancel()
                            with suppress(asyncio.CancelledError):
                                await task
                    finally:
                        try:
                            await calls.close()
                        finally:
                            try:
                                await auth.close()
                            finally:
                                await store.close()
                except BaseException as error:
                    record_event("app.shutdown", error=error, status="failed")
                    raise
                else:
                    record_event("app.shutdown", status="ok")

    application = FastAPI(
        title="30-day cashflow foundation",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        responses={
            status: {"model": Error}
            for status in (400, 401, 403, 404, 409, 410, 413, 415, 422, 428, 429, 500, 503)
        },
    )
    application.state.store = store
    application.state.auth = auth
    application.state.calls = calls
    application.add_middleware(Boundary, config=config, environment=environment, auth=auth)
    application.include_router(auth_router(auth, calls))

    @application.exception_handler(Problem)
    async def problem_handler(request: Request, error: Problem) -> JSONResponse:
        """Render domain failures with public-safe messages and applicable rate limits."""
        if error.body.code == "commandConflict":
            try:
                auth.limit("conflict", owner(request).user_id, config.auth.invalid_limit)
            except AuthProblem as limited:
                error = limited
        body = error.body.model_dump(mode="json", by_alias=True)
        request_failure(request.scope, error.status, error=error, code=error.body.code)
        if error.body.code == "voiceUnavailable":
            http_log.warning(
                "voice.unavailable",
                stage="callStart",
                reason=unavailable_reason(config, environment) or voice_reason(error.body.message),
            )
            body["message"] = VOICE_UNAVAILABLE
        return JSONResponse(
            body,
            status_code=error.status,
            headers={"Retry-After": str(error.retry_after)}
            if isinstance(error, AuthProblem) and error.retry_after
            else None,
        )

    @application.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, error: RequestValidationError) -> JSONResponse:
        """Return a public validation error without exposing submitted field values."""
        request_failure(
            request.scope,
            422,
            error=error,
            code="validationError",
            validation=error.errors(),
        )
        return JSONResponse(
            {
                "code": "validationError",
                "message": "Invalid request fields or values; consult the API schema.",
            },
            status_code=422,
        )

    @application.exception_handler(HTTPException)
    async def http_handler(request: Request, error: HTTPException) -> JSONResponse:
        """Return a generic resource or method error with the original HTTP status."""
        request_failure(request.scope, error.status_code, error=error, code="httpError")
        return JSONResponse(
            {"code": "httpError", "message": "Resource or method unavailable."},
            status_code=error.status_code,
        )

    @application.exception_handler(sqlite3.Error)
    async def storage_handler(request: Request, error: sqlite3.Error) -> JSONResponse:
        """Report storage unavailability with safe command-retry guidance."""
        request_failure(request.scope, 503, error=error, code="unavailable")
        return JSONResponse(
            {
                "code": "unavailable",
                "message": "Storage is unavailable; retry the same command ID.",
            },
            status_code=503,
        )

    @application.exception_handler(Exception)
    async def unexpected_handler(request: Request, error: Exception) -> JSONResponse:
        """Return a generic internal failure without disclosing exception details."""
        request_failure(request.scope, 500, error=error, code="internalError")
        return JSONResponse(
            {"code": "internalError", "message": "Request failed; retry the same command ID."},
            status_code=500,
            headers={"X-Request-ID": str(request.state.diagnostic_request_id)},
        )

    @application.get("/api/settings", response_model=Settings)
    async def settings() -> Settings:
        """Return public cashflow limits, local date, and voice availability settings."""
        reason = unavailable_reason(config, environment)
        return Settings(
            assistant_name=config.voice.assistant_name,
            currency=config.currency,
            timezone=config.timezone,
            today=clock().astimezone(ZoneInfo(config.timezone)).date(),
            horizon_days=config.horizon_days,
            retention_hours=config.retention_hours,
            max_records=config.max_records,
            max_money_paise=config.max_money_paise,
            max_request_bytes=config.max_request_bytes,
            recurrence=["once", "daily", "weekly", "fortnightly", "monthly", "monthlyBudget"],
            voice_startup_seconds=config.voice.startup_seconds,
            voice_shutdown_seconds=config.voice.shutdown_seconds,
            voice_available=reason is None,
            voice_unavailable_reason=VOICE_UNAVAILABLE if reason is not None else None,
        )

    @application.post("/api/session", response_model=Snapshot)
    async def start(request: Request, body: Model) -> Snapshot:
        """Create a financial session for the authenticated owner."""
        return await store.create(owner(request))

    @application.get("/api/history", response_model=ConversationList)
    async def history_list(request: Request, search: str = "") -> ConversationList:
        """List the owner's saved conversations with optional text search."""
        return await history.list(owner(request), search)

    @application.get("/api/history/{slug}", response_model=SavedConversation)
    async def history_detail(request: Request, slug: str) -> SavedConversation:
        """Return a saved conversation and its transcript messages."""
        return await history.get(owner(request), slug)

    @application.post("/api/history/{slug}/continue", response_model=Snapshot)
    async def history_continue(request: Request, slug: str, body: Model) -> Snapshot:
        """Select a saved conversation for continued financial planning."""
        return await calls.select(owner(request), slug)

    @application.get(
        "/api/history/{slug}/transcript",
        response_class=PlainTextResponse,
        response_model=str,
    )
    async def history_transcript(request: Request, slug: str) -> PlainTextResponse:
        """Download a saved conversation as a plain-text transcript."""
        conversation = await history.get(owner(request), slug)
        return PlainTextResponse(
            transcript(conversation),
            headers={"Content-Disposition": f'attachment; filename="{conversation.slug}.txt"'},
        )

    @application.get("/api/session", response_model=Snapshot)
    async def current(request: Request) -> Snapshot:
        """Return the authenticated owner's current financial snapshot."""
        return await store.get(owner(request))

    @application.get("/api/session/options", response_model=AdjustmentOptions)
    async def options(request: Request) -> AdjustmentOptions:
        """Return available adjustments for the current financial session."""
        return await store.options(owner(request))

    @application.get("/api/session/call", response_model=CallState)
    async def call_state(request: Request) -> CallState:
        """Return voice-call status after verifying the owner's financial session."""
        key = owner(request)
        await store.get(key)
        return calls.state(key)

    @application.post("/api/session/call", response_model=CallJoin)
    async def join_call(request: Request, body: CallRequest) -> CallJoin:
        """Start or join the requested voice conversation."""
        request.state.diagnostic_call_id = body.call_id
        return await calls.start(owner(request), body.call_id, body.conversation_slug)

    @application.delete("/api/session/call", response_model=CallState)
    async def end_call(request: Request, body: CallRequest) -> CallState:
        """End the requested voice call and return its resulting state."""
        request.state.diagnostic_call_id = body.call_id
        return await calls.end(owner(request), body.call_id)

    @application.post("/api/session/commands", response_model=Snapshot)
    async def command(request: Request, body: Command) -> Snapshot:
        """Apply a financial command and return the resulting session snapshot."""
        return await store.command(owner(request), body)

    @application.get(
        "/api/session/events",
        response_model=None,
        responses={
            200: {
                "content": {"text/event-stream": {"schema": {"type": "string"}}},
                "description": "snapshot events contain Snapshot JSON; id is sequence. "
                "Terminal session events contain Error JSON.",
            }
        },
    )
    async def events(request: Request) -> StreamingResponse:
        """Subscribe the owner to financial snapshots and terminal session events."""
        key = owner(request)
        queue = await store.subscribe(key)

        async def stream() -> AsyncIterator[str]:
            """Yield authorized snapshot events, heartbeats, and terminal session failures."""
            sequence = -1
            started = time.monotonic()

            async def terminal(value: Error) -> str:
                """Render a terminal event, distinguishing account deletion from sign-out."""
                if value.code in {"unauthenticated", "sessionExpired"}:
                    async with (
                        store.lock,
                        store.connection().execute(
                            "SELECT 1 FROM auth_users WHERE id = ?", (key.user_id,)
                        ) as cursor,
                    ):
                        if await cursor.fetchone() is None:
                            value = Error(code="accountDeleted", message="Account deleted.")
                if value.code in {"unavailable", "authUnavailable", "internalError"}:
                    request_failure(request.scope, 503, code=value.code, stage="sse")
                return f"event: {value.code}\ndata: {value.model_dump_json(by_alias=True)}\n\n"

            try:
                while True:
                    try:
                        value = await asyncio.wait_for(queue.get(), config.heartbeat_seconds)
                    except TimeoutError:
                        try:
                            value = await store.get(key)
                        except Problem as error:
                            request_failure(
                                request.scope,
                                error.status,
                                error=error,
                                code=error.body.code,
                                stage="sse",
                            )
                            yield await terminal(error.body)
                            return
                        if value.sequence == sequence:
                            yield ": heartbeat\n\n"
                            continue
                    if isinstance(value, Error):
                        try:
                            await auth.check(key)
                        except Problem as error:
                            request_failure(
                                request.scope,
                                error.status,
                                error=error,
                                code=error.body.code,
                                stage="sse",
                            )
                            value = error.body
                        yield await terminal(value)
                        return
                    try:
                        value = await store.get(key)
                    except Problem as error:
                        request_failure(
                            request.scope,
                            error.status,
                            error=error,
                            code=error.body.code,
                            stage="sse",
                        )
                        yield await terminal(error.body)
                        return
                    if value.sequence <= sequence:
                        continue
                    sequence = value.sequence
                    yield (
                        f"event: snapshot\nid: {sequence}\n"
                        f"data: {value.model_dump_json(by_alias=True)}\n\n"
                    )
            except Exception as error:
                request_failure(
                    request.scope,
                    500,
                    error=error,
                    stage="sse",
                    elapsed_seconds=time.monotonic() - started,
                )
                raise
            finally:
                store.unsubscribe(key, queue)

        return StreamingResponse(
            stream(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"}
        )

    @application.get(
        "/api/session/export",
        response_class=PlainTextResponse,
        response_model=str,
        responses={200: {"content": {"text/plain": {"schema": {"type": "string"}}}}},
    )
    async def export(request: Request) -> PlainTextResponse:
        """Download the current cashflow snapshot as a plain-text report."""
        return PlainTextResponse(
            export_text(await store.get(owner(request))),
            headers={"Content-Disposition": 'attachment; filename="cashflow.txt"'},
        )

    @application.delete("/api/session", response_model=Deleted)
    async def delete(request: Request, body: Model | None = None) -> Deleted:
        """End any active call and delete the owner's financial session."""
        key = owner(request)
        state = calls.state(key)
        if state.call_id is not None:
            await calls.end(key, state.call_id)
        await store.delete(key)
        return Deleted()

    @application.get("/health/live", response_model=Health)
    async def live() -> Health:
        """Report that the application can serve requests."""
        return Health(status="ok")

    @application.get("/health/ready", response_model=Health)
    async def ready() -> Health:
        """Verify that session cleanup and persistent storage are available."""
        if application.state.cleanup_task.done():
            raise Problem(503, "unavailable", "Session cleanup is unavailable.")
        await store.ready()
        return Health(status="ok")

    @application.get("/{path:path}", response_model=None, include_in_schema=False)
    async def frontend(path: str, request: Request) -> FileResponse | RedirectResponse:
        """Serve frontend assets and protected pages with sign-in redirects where needed."""
        if path == "api" or path.startswith(("api/", "health/", "auth/")):
            raise Problem(404, "notFound", "Resource not found.")
        protected = is_return_path("/" + path)
        if path.partition("/")[0] in {"app", "money", "history"} and not protected:
            raise Problem(404, "notFound", "Resource not found.")
        if not path or protected:
            try:
                await auth.identify(request)
            except Problem as error:
                if error.status != 401:
                    raise
                return RedirectResponse(
                    "/login" + ("?returnTo=/" + path if path else ""), status_code=303
                )
            if not path:
                return RedirectResponse("/app", status_code=303)
        target = (static_dir / path).resolve()
        if not target.is_relative_to(static_dir):
            raise Problem(404, "notFound", "Resource not found.")
        if target.is_file():
            return FileResponse(target)
        if (path == "login" or protected) and (static_dir / "index.html").is_file():
            return FileResponse(static_dir / "index.html")
        raise Problem(404, "notFound", "Frontend build is unavailable or resource does not exist.")

    return application


app = create_app()
