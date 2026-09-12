# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import logging
import re
import sqlite3
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, suppress
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit
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
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .auth import Auth, AuthProblem
from .auth_models import is_return_path
from .auth_routes import owner
from .auth_routes import router as auth_router
from .config import ROOT, Config, Environment, load_config
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
from .voice import VOICE_UNAVAILABLE, CallManager, unavailable_reason

logger = logging.getLogger(__name__)


class CallbackLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return "/auth/callback" not in record.getMessage()


callback_log_filter = CallbackLogFilter()
logging.getLogger("uvicorn.access").addFilter(callback_log_filter)


class Boundary:
    def __init__(self, app: ASGIApp, config: Config, environment: Environment, auth: Auth):
        self.app = app
        self.config = config
        self.environment = environment
        self.auth = auth

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope["headers"]
        }

        async def secured_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", []).extend(
                    [
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

        async def reject(status: int, code: str, message: str) -> None:
            await JSONResponse({"code": code, "message": message}, status_code=status)(
                scope, receive, secured_send
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
                await JSONResponse(
                    error.body.model_dump(mode="json", by_alias=True),
                    status_code=error.status,
                    headers={"Retry-After": str(error.retry_after)}
                    if isinstance(error, AuthProblem) and error.retry_after
                    else None,
                )(scope, receive, secured_send)
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
                    nonlocal delivered
                    if not delivered:
                        delivered = True
                        return {"type": "http.request", "body": bytes(body), "more_body": False}
                    return await receive()

                await self.app(scope, body_receive, secured_send)
                return
        await self.app(scope, receive, secured_send)


def create_app(
    config: Config | None = None,
    environment: Environment | None = None,
    clock: Callable[[], datetime] = utc_now,
    static_dir: Path | None = None,
    google: Google | None = None,
) -> FastAPI:
    config = config if config is not None else load_config()
    environment = environment if environment is not None else Environment.load()
    store = Store(environment.data_dir / "sessions.sqlite3", config, clock)
    history = History(store)
    auth = Auth(store, environment, google)
    calls = CallManager(store, config, environment, auth)
    auth.on_revoke = calls.invalidate
    static_dir = (static_dir if static_dir is not None else ROOT / "frontend" / "dist").resolve()

    async def cleanup() -> None:
        while True:
            await asyncio.sleep(config.cleanup_seconds)
            await store.cleanup()
            await auth.cleanup()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        if reason := unavailable_reason(config, environment):
            logger.warning("Voice unavailable at startup: %s", reason)
        else:
            from .voice_pipeline import prepare_runtime

            await asyncio.to_thread(prepare_runtime)
        await store.open()
        await auth.open()
        await store.cleanup()
        await auth.cleanup()
        task = asyncio.create_task(cleanup())
        application.state.cleanup_task = task
        try:
            yield
        finally:
            task.cancel()
            try:
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
        if error.body.code == "commandConflict":
            logger.warning("authCommandConflict")
            try:
                auth.limit("conflict", owner(request).user_id, config.auth.invalid_limit)
            except AuthProblem as limited:
                error = limited
        body = error.body.model_dump(mode="json", by_alias=True)
        if error.body.code == "voiceUnavailable":
            reason = unavailable_reason(config, environment)
            # Only locally constructed reasons and bounded HTTP statuses are safe to log.
            if reason is None:
                reason = error.body.message
                if reason not in {
                    "Daily room service is unavailable.",
                    "Daily returned an invalid room.",
                    "Daily returned an invalid token.",
                    "Voice is shutting down.",
                    "Voice setup failed; continue with manual entry.",
                    "Configured female English voice is unavailable in this Azure Speech resource; "
                    "verify voice.tts_voice, voice.tts_locale, and AZURE_SPEECH_REGION.",
                    "Azure Speech voice check failed; "
                    "verify the resource region and service connectivity.",
                } and not re.fullmatch(
                    r"Azure Speech voice check returned HTTP [1-5][0-9]{2}; "
                    r"check the speech key, resource region, and service availability\.",
                    reason,
                ):
                    reason = "Voice setup failed."
            logger.warning("Voice unavailable: %s", reason)
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
        return JSONResponse(
            {
                "code": "validationError",
                "message": "Invalid request fields or values; consult the API schema.",
            },
            status_code=422,
        )

    @application.exception_handler(HTTPException)
    async def http_handler(request: Request, error: HTTPException) -> JSONResponse:
        return JSONResponse(
            {"code": "httpError", "message": "Resource or method unavailable."},
            status_code=error.status_code,
        )

    @application.exception_handler(sqlite3.Error)
    async def storage_handler(request: Request, error: sqlite3.Error) -> JSONResponse:
        return JSONResponse(
            {
                "code": "unavailable",
                "message": "Storage is unavailable; retry the same command ID.",
            },
            status_code=503,
        )

    @application.exception_handler(Exception)
    async def unexpected_handler(request: Request, error: Exception) -> JSONResponse:
        return JSONResponse(
            {"code": "internalError", "message": "Request failed; retry the same command ID."},
            status_code=500,
        )

    @application.get("/api/settings", response_model=Settings)
    async def settings() -> Settings:
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
        return await store.create(owner(request))

    @application.get("/api/history", response_model=ConversationList)
    async def history_list(request: Request, search: str = "") -> ConversationList:
        return await history.list(owner(request), search)

    @application.get("/api/history/{slug}", response_model=SavedConversation)
    async def history_detail(request: Request, slug: str) -> SavedConversation:
        return await history.get(owner(request), slug)

    @application.get(
        "/api/history/{slug}/transcript",
        response_class=PlainTextResponse,
        response_model=str,
    )
    async def history_transcript(request: Request, slug: str) -> PlainTextResponse:
        conversation = await history.get(owner(request), slug)
        return PlainTextResponse(
            transcript(conversation),
            headers={"Content-Disposition": f'attachment; filename="{conversation.slug}.txt"'},
        )

    @application.get("/api/session", response_model=Snapshot)
    async def current(request: Request) -> Snapshot:
        return await store.get(owner(request))

    @application.get("/api/session/options", response_model=AdjustmentOptions)
    async def options(request: Request) -> AdjustmentOptions:
        return await store.options(owner(request))

    @application.get("/api/session/call", response_model=CallState)
    async def call_state(request: Request) -> CallState:
        key = owner(request)
        await store.get(key)
        return calls.state(key)

    @application.post("/api/session/call", response_model=CallJoin)
    async def join_call(request: Request, body: CallRequest) -> CallJoin:
        return await calls.start(owner(request), body.call_id)

    @application.delete("/api/session/call", response_model=CallState)
    async def end_call(request: Request, body: CallRequest) -> CallState:
        return await calls.end(owner(request), body.call_id)

    @application.post("/api/session/commands", response_model=Snapshot)
    async def command(request: Request, body: Command) -> Snapshot:
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
        key = owner(request)
        queue = await store.subscribe(key)

        async def stream() -> AsyncIterator[str]:
            sequence = -1
            try:
                while True:
                    try:
                        value = await asyncio.wait_for(queue.get(), config.heartbeat_seconds)
                    except TimeoutError:
                        try:
                            value = await store.get(key)
                        except Problem as error:
                            yield (
                                f"event: {error.body.code}\n"
                                f"data: {error.body.model_dump_json(by_alias=True)}\n\n"
                            )
                            return
                        if value.sequence == sequence:
                            yield ": heartbeat\n\n"
                            continue
                    if isinstance(value, Error):
                        try:
                            await auth.check(key)
                        except Problem as error:
                            value = error.body
                        yield (
                            f"event: {value.code}\ndata: {value.model_dump_json(by_alias=True)}\n\n"
                        )
                        return
                    try:
                        value = await store.get(key)
                    except Problem as error:
                        yield (
                            f"event: {error.body.code}\n"
                            f"data: {error.body.model_dump_json(by_alias=True)}\n\n"
                        )
                        return
                    if value.sequence <= sequence:
                        continue
                    sequence = value.sequence
                    yield (
                        f"event: snapshot\nid: {sequence}\n"
                        f"data: {value.model_dump_json(by_alias=True)}\n\n"
                    )
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
        return PlainTextResponse(
            export_text(await store.get(owner(request))),
            headers={"Content-Disposition": 'attachment; filename="cashflow.txt"'},
        )

    @application.delete("/api/session", response_model=Deleted)
    async def delete(request: Request, body: Model | None = None) -> Deleted:
        key = owner(request)
        state = calls.state(key)
        if state.call_id is not None:
            await calls.end(key, state.call_id)
        await store.delete(key)
        return Deleted()

    @application.get("/health/live", response_model=Health)
    async def live() -> Health:
        return Health(status="ok")

    @application.get("/health/ready", response_model=Health)
    async def ready() -> Health:
        if application.state.cleanup_task.done():
            raise Problem(503, "unavailable", "Session cleanup is unavailable.")
        await store.ready()
        return Health(status="ok")

    @application.get("/{path:path}", response_model=None, include_in_schema=False)
    async def frontend(path: str, request: Request) -> FileResponse | RedirectResponse:
        if path == "api" or path.startswith(("api/", "health/", "auth/")):
            raise Problem(404, "notFound", "Resource not found.")
        protected = is_return_path("/" + path)
        if path.partition("/")[0] in {"money", "history"} and not protected:
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
