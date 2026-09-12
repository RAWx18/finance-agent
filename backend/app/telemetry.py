# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
import logging
import re
import sys
import time
from types import TracebackType
from typing import Any, Literal
from uuid import UUID

import structlog
from structlog.stdlib import BoundLogger
from structlog.typing import EventDict, WrappedLogger

from .diagnostics import CODES, error_details
from .diagnostics import logger as diagnostic_logger

LogFormat = Literal["json", "console"]

# Values under these keys are never useful in a log line and may carry secrets or user speech.
PRIVATE_KEYS = {
    "text",
    "content",
    "transcript",
    "arguments",
    "message",
    "messages",
    "facts",
    "snapshot",
    "apikey",
    "privatekey",
    "errormessage",
    "providermessage",
    "exception",
    "exctext",
    "excinfo",
    "stackinfo",
    "traceback",
    "stacktrace",
}
PRIVATE_SUFFIX = re.compile(
    r"(tokens?|secrets?|passwords?|cookies?|authorization|credentials?|headers?|"
    r"urls?|uris?|query|querystring|body|args|arguments|payload|apikey|privatekey)$"
)
UUID_TEXT = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")
MAX_VALUE_CHARS = 200

handler: logging.Handler | None = None

# Component labels for diagnostic events, keyed by event-name prefix; first match wins.
DIAGNOSTIC_COMPONENTS = {
    "app.": "app",
    "http.": "http",
    "call.": "call",
    "daily.": "daily",
    "voice.": "pipecat",
    "speech.recognition": "stt",
    "speech.synthesis": "tts",
    "store.": "store",
}


def safe_value(value: Any, depth: int = 0) -> Any:
    """Copy structured values without rendering private objects or unbounded containers."""
    if depth >= 12:
        return "[redacted]"
    if isinstance(value, BaseException):
        return error_fields(value)
    if type(value) is dict:
        result = {}
        for key, item in value.items():
            if type(key) is not str:
                continue
            name = re.sub(r"[^a-z0-9]", "", key.lower())
            if name in PRIVATE_KEYS or PRIVATE_SUFFIX.search(name):
                result[key] = "[redacted]"
            elif name == "providerrequestid":
                result[key] = (
                    str(item)
                    if isinstance(item, UUID) or (type(item) is str and UUID_TEXT.fullmatch(item))
                    else "[redacted]"
                )
            elif name in {"code", "errorcode"}:
                result[key] = item if type(item) is str and item in CODES else "[redacted]"
            else:
                result[key] = safe_value(item, depth + 1)
        return result
    if type(value) in {list, tuple}:
        return [safe_value(item, depth + 1) for item in value[:64]]
    if type(value) is str:
        return value[:MAX_VALUE_CHARS] + "…" if len(value) > MAX_VALUE_CHARS else value
    if value is None or type(value) in {bool, int, float}:
        return value
    if isinstance(value, UUID):
        return str(value)
    return "[redacted]"


def sanitize(logger: WrappedLogger, method: str, event_dict: EventDict) -> EventDict:
    """Redact nested payloads without modifying caller-owned values or formatter metadata."""
    fields = {
        key: value for key, value in event_dict.items() if key not in {"_record", "_from_structlog"}
    }
    event_dict.update(safe_value(fields))
    return event_dict


def compact_exception(logger: WrappedLogger, method: str, event_dict: EventDict) -> EventDict:
    """Replace attached tracebacks with payload-free error fields."""
    exc_info = event_dict.pop("exc_info", None)
    event_dict.pop("stack_info", None)
    if exc_info is True:
        exc_info = sys.exc_info()
    error = (
        exc_info[1]
        if isinstance(exc_info, tuple) and len(exc_info) == 3
        else exc_info
        if isinstance(exc_info, BaseException)
        else None
    )
    if isinstance(error, BaseException):
        event_dict.update(error_fields(error))
    return event_dict


def diagnostic_event(logger: WrappedLogger, method: str, event_dict: EventDict) -> EventDict:
    """Unwrap the diagnostic entry point's payload before adding transport metadata."""
    record = event_dict["_record"]
    if record.name == diagnostic_logger.name and getattr(record, "safe_diagnostic", False) is True:
        try:
            payload = json.loads(event_dict["event"])
        except (ValueError, RecursionError):
            payload = None
        if type(payload) is dict and "timestamp" in payload and "event" in payload:
            event_dict.update(payload)
            event_dict["time"] = event_dict.pop("timestamp")
            name = payload["event"] if type(payload["event"]) is str else ""
            component = next(
                (
                    label
                    for prefix, label in DIAGNOSTIC_COMPONENTS.items()
                    if name.startswith(prefix)
                ),
                name.partition(".")[0],
            )
            event_dict.setdefault("component", component)
            # Structlog events use camelCase; alias so one filter follows a call across both.
            for source, alias in (
                ("call_id", "callId"),
                ("session_id", "sessionId"),
                ("request_id", "requestId"),
            ):
                if source in payload:
                    event_dict.setdefault(alias, payload[source])
            return event_dict
    event_dict["event"] = "log.message"
    event_dict.setdefault("component", "server")
    return event_dict


class PrivacyFormatter(structlog.stdlib.ProcessorFormatter):
    """Avoid formatting foreign messages and arguments, including arbitrary object reprs."""

    def format(self, record: logging.LogRecord) -> str:
        record = logging.makeLogRecord(record.__dict__)
        if not (hasattr(record, "_logger") and hasattr(record, "_name")):
            if not (
                record.name == diagnostic_logger.name
                and getattr(record, "safe_diagnostic", False) is True
                and type(record.msg) is str
                and not record.args
            ):
                record.msg = "log.message"
            record.args = ()
        return super().format(record)


class PrivacyHandler(logging.StreamHandler[Any]):
    """Report stderr failures without logging's raw-record and traceback fallback."""

    def handleError(self, record: logging.LogRecord) -> None:
        try:
            sys.stderr.write('{"event":"telemetry.sinkFailure","level":"warning"}\n')
        except Exception:
            pass


def configure(level: str = "INFO", output: LogFormat | None = None) -> LogFormat:
    """Route application and server logs through one structured stderr handler."""
    global handler
    output = output or ("console" if sys.stderr.isatty() else "json")
    shared: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.MaybeTimeStamper(fmt="iso", utc=True, key="time"),
        compact_exception,
        sanitize,
    ]
    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=BoundLogger,
        cache_logger_on_first_use=False,
    )
    renderer: Any = (
        structlog.processors.JSONRenderer(sort_keys=True)
        if output == "json"
        else structlog.dev.ConsoleRenderer(
            colors=True, pad_event_to=28, timestamp_key="time", sort_keys=False
        )
    )
    root = logging.getLogger()
    for attached in root.handlers[:]:
        if attached is handler or isinstance(attached, PrivacyHandler):
            root.removeHandler(attached)
    handler = PrivacyHandler(sys.stderr)
    handler.setFormatter(
        PrivacyFormatter(
            processors=[structlog.stdlib.ProcessorFormatter.remove_processors_meta, renderer],
            foreign_pre_chain=[diagnostic_event, *shared],
            keep_exc_info=False,
            keep_stack_info=False,
        )
    )
    root.addHandler(handler)
    root.setLevel(level.upper())
    # Uvicorn's own handlers would duplicate output; http.request supersedes its access log.
    for name in ("uvicorn", "uvicorn.error"):
        server = logging.getLogger(name)
        server.handlers.clear()
        server.setLevel(logging.NOTSET)
        server.propagate = True
    logging.getLogger("uvicorn.access").disabled = True
    # HTTP client access messages include complete URLs, including authentication queries.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    return output


def get_logger(name: str, component: str) -> BoundLogger:
    """Return a logger for a module, labelled with the component it observes."""
    # Module-level loggers are created before configure() runs; the lazy proxy defers
    # binding until first use so every line reaches the configured handler.
    logger: BoundLogger = structlog.get_logger(name, component=component)
    return logger


def error_fields(error: BaseException | None) -> dict[str, Any]:
    """Describe an exception by type, status, code, origin and cause without payloads."""
    if error is None:
        return {}
    details = error_details(error)
    root = details[0]
    fields: dict[str, Any] = {"errorType": root["type"], "errors": details}
    for source, target in (("status", "errorStatus"), ("code", "errorCode")):
        if source in root:
            fields[target] = root[source]
    request_id = getattr(error, "request_id", None)
    if isinstance(request_id, UUID) or (
        type(request_id) is str and UUID_TEXT.fullmatch(request_id)
    ):
        fields["providerRequestId"] = str(request_id)
    for item in details[1:]:
        if item["parent"] == 0 and item["relation"] in {"cause", "context"}:
            fields["errorCause"] = item["type"]
            break
    frames = root["stack"]
    if isinstance(frames, list) and frames:
        fields["errorStack"] = [
            f"{frame['file']}:{frame['function']}:{frame['line']}" for frame in frames[-5:]
        ]
        fields["errorAt"] = fields["errorStack"][-1]
    return fields


def failure_status(error: BaseException) -> str:
    """Classify how an operation ended: rejected, timeout, cancelled or failed."""
    if isinstance(error, asyncio.CancelledError):
        return "cancelled"
    if isinstance(error, TimeoutError):
        return "timeout"
    status = getattr(error, "status", None)
    return "rejected" if isinstance(status, int) and status < 500 else "failed"


class Span:
    """Timed operation that logs its start and its outcome with duration and error details."""

    def __init__(self, log: BoundLogger, event: str, **fields: Any) -> None:
        """Bind correlation fields to one operation and start its clock."""
        self.log = log.bind(**fields)
        self.event = event
        self.started = time.monotonic()
        self.finished = False

    def begin(self) -> "Span":
        """Log that the operation started."""
        self.log.info(self.event, status="started")
        return self

    def finish(
        self, error: BaseException | None = None, *, status: str | None = None, **fields: Any
    ) -> None:
        """Log the outcome once; cancellations are expected and stay informational."""
        if self.finished:
            return
        self.finished = True
        duration = round((time.monotonic() - self.started) * 1000, 1)
        if error is None:
            self.log.info(self.event, status=status or "ok", durationMs=duration, **fields)
            return
        status = status or failure_status(error)
        method = self.log.info if status == "cancelled" else self.log.warning
        method(self.event, status=status, durationMs=duration, **error_fields(error), **fields)

    def __enter__(self) -> "Span":
        """Start the operation."""
        return self.begin()

    def __exit__(
        self,
        kind: type[BaseException] | None,
        error: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        """Record the outcome and propagate any exception."""
        self.finish(error)

    async def __aenter__(self) -> "Span":
        """Start the operation."""
        return self.begin()

    async def __aexit__(
        self,
        kind: type[BaseException] | None,
        error: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        """Record the outcome and propagate any exception."""
        self.finish(error)
