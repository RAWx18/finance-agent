# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import json
import logging
import math
import os
import re
import stat
import sys
from collections import deque
from collections.abc import Generator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from io import TextIOWrapper
from logging.handlers import RotatingFileHandler
from pathlib import Path
from uuid import UUID, uuid4

from .config import DiagnosticsConfig

logger = logging.getLogger("uvicorn.error.diagnostics")
logger.setLevel(logging.INFO)
boot_id = uuid4()
request_id: ContextVar[UUID | None] = ContextVar("diagnostic_request_id", default=None)

# Only code-owned identifiers belong in label fields, never user or provider strings.
LABEL = re.compile(r"[A-Za-z][A-Za-z_.:]{0,63}\Z")
COUNTERS = {
    "generation",
    "sequence",
    "state_sequence",
    "tool_rounds",
    "model_requests",
    "retry_attempts",
    "retry_of",
    "completed_turns",
    "financial_revision",
    "completion_chars",
    "audio_frames",
    "provider_code",
}
FLAGS = {"waiting", "stopping", "revoked", "auto_retry", "saved"}
LABELS = {"stage", "source", "category", "reason", "tool", "question_scope"}
CODES = {
    "accountDeleted",
    "authUnavailable",
    "unauthenticated",
    "sessionExpired",
    "rateLimited",
    "recentSigninRequired",
    "unavailable",
    "internalError",
    "httpError",
    "validationError",
    "invalidHeaders",
    "hostRejected",
    "originRejected",
    "invalidQuery",
    "contentType",
    "invalidLength",
    "payloadLimit",
    "commandConflict",
    "voiceUnavailable",
    "notFound",
    "expired",
    "conversationChanged",
    "sessionLimit",
    "invalidFacts",
    "invalidAdjustments",
    "stalePreview",
    "staleRevision",
    "revisionConflict",
    "callConflict",
    "callLimit",
    "callExpired",
    "callBusy",
    "callEnded",
    "streamLimit",
    "invalidCommand",
    "conflict",
    "rate_limit_exceeded",
    "server_error",
    "insufficient_quota",
    "model_not_found",
    "content_filter",
    "invalid_api_key",
    "authentication_error",
    "timeout",
}
STATES = {
    "ok",
    "started",
    "failed",
    "error",
    "cancelled",
    "timeout",
    "rejected",
    "idle",
    "connecting",
    "active",
    "ending",
    "ended",
    "waiting",
    "completed",
    "unavailable",
}
METRICS = {
    "response_failures",
    "worker_crashes",
    "history_failed",
    "errors",
    "model_stream_text",
    "model_stream_tools",
    "model_stream_empty",
    "model_refusals",
    "model_cancelled",
    "model_failed",
    "model_completed",
    "model_requests",
    "model_text_received",
    "model_ends",
    "model_empty",
    "model_text",
    "stale_model_frames",
    "synthesis_contexts",
    "stale_synthesis_frames",
    "synthesis_audio",
    "stale_output_frames",
    "published_audio",
    "tool_calls",
    "user_starts",
    "user_turns",
    "resumed_replies",
    "waiting",
    "response_retries",
    "continued",
    "model_finish_stop",
    "model_finish_length",
    "model_finish_tool_calls",
    "model_finish_content_filter",
    "model_finish_other",
}
ACTIONS = {
    "clarify",
    "receipt",
    "review",
    "contact",
    "group",
    "response",
    "conditional",
    "preview",
    "opening",
    "reserve",
    "coverage",
    "outcome",
}
VALIDATION_TYPES = {
    "missing",
    "extra_forbidden",
    "json_invalid",
    "value_error",
    "literal_error",
    "union_tag_invalid",
    "union_tag_not_found",
    "model_type",
    "model_attributes_type",
    "string_type",
    "string_too_long",
    "string_too_short",
    "string_pattern_mismatch",
    "int_type",
    "int_parsing",
    "float_type",
    "float_parsing",
    "bool_type",
    "bool_parsing",
    "uuid_type",
    "uuid_parsing",
    "uuid_version",
    "date_type",
    "date_parsing",
    "date_from_datetime_parsing",
    "date_from_datetime_inexact",
    "list_type",
    "dict_type",
    "greater_than",
    "greater_than_equal",
    "less_than",
    "less_than_equal",
    "finite_number",
    "too_long",
    "too_short",
}
# Unknown property names and mapping keys in validation locations are private input too.
VALIDATION_PATHS = {
    "body",
    "query",
    "path",
    "header",
    "commandId",
    "expectedRevision",
    "operation",
    "type",
    "facts",
    "opening",
    "reserve",
    "records",
    "amount",
    "status",
    "id",
    "label",
    "kind",
    "schedule",
    "date",
    "recurrence",
    "coverage",
    "income",
    "essential",
    "optional",
    "debt",
    "callId",
    "conversationSlug",
    "returnTo",
    "search",
    "slug",
    "replaceFacts",
    "updateFacts",
    "previewAdjustments",
    "acceptPreview",
    "discardPreview",
    "rejectPreview",
    "clearAccepted",
    "respondToAction",
}


def sink_warning() -> None:
    """Report diagnostic loss without echoing filesystem paths or exception details."""
    try:
        sys.stderr.write('{"event":"diagnostics.sinkFailure","severity":"warning"}\n')
    except Exception:
        pass


def safe_fields(fields: dict[str, object]) -> dict[str, object]:
    """Select bounded operational metadata without coercing arbitrary values to strings."""
    result: dict[str, object] = {}
    for key, value in fields.items():
        if key in COUNTERS and type(value) is int and 0 <= value <= 10**12:
            result[key] = value
        elif key in FLAGS and (type(value) is bool or value is None):
            result[key] = value
        elif key in {"session_id", "command_id"} and isinstance(value, UUID):
            result[key] = str(value)
        elif key in LABELS and type(value) is str and LABEL.fullmatch(value):
            result[key] = value
        elif key == "code" and type(value) is str and value in CODES:
            result[key] = value
        elif key == "status" and (
            (type(value) is int and 100 <= value <= 599) or (type(value) is str and value in STATES)
        ):
            result[key] = value
        elif key == "elapsed_seconds" and type(value) in {int, float}:
            if isinstance(value, (int, float)) and 0 <= value <= 86400 and math.isfinite(value):
                result[key] = round(value, 3)
        elif key == "current_action" and type(value) is str:
            prefix = value.partition(":")[0]
            if prefix in ACTIONS:
                result[key] = prefix
        elif key == "metrics" and type(value) is dict:
            result[key] = {
                name: count
                for name, count in value.items()
                if type(name) is str
                and name in METRICS
                and type(count) is int
                and 0 <= count <= 10**12
            }
        elif (
            key == "method"
            and type(value) is str
            and value in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
        ):
            result[key] = value
        elif key == "route" and type(value) is str and len(value) <= 120:
            if re.fullmatch(r"/[A-Za-z/{}_:]*", value):
                result[key] = value
        elif key == "validation" and type(value) is list:
            issues = []
            for issue in value[:12]:
                if type(issue) is not dict:
                    continue
                kind = issue.get("type")
                location = issue.get("loc")
                if not isinstance(location, (list, tuple)):
                    continue
                issues.append(
                    {
                        "type": kind if type(kind) is str and kind in VALIDATION_TYPES else "other",
                        "path": [
                            part if type(part) is str and part in VALIDATION_PATHS else "*"
                            for part in location[:12]
                        ],
                    }
                )
            result[key] = issues
    return result


def error_details(error: BaseException) -> list[dict[str, object]]:
    """Capture bounded exception topology and code locations, never messages or source lines."""
    pending: deque[tuple[BaseException, int | None, str]] = deque([(error, None, "root")])
    seen: set[int] = set()
    details: list[dict[str, object]] = []
    while pending and len(details) < 8:
        current, parent, relation = pending.popleft()
        if id(current) in seen:
            continue
        seen.add(id(current))
        name = type(current).__name__
        item: dict[str, object] = {
            "type": name if re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]{0,79}", name) else "Exception",
            "parent": parent,
            "relation": relation,
        }
        for attribute in ("status", "status_code"):
            status = getattr(current, attribute, None)
            if type(status) is int and 100 <= status <= 599:
                item["status"] = status
                break
        code = getattr(getattr(current, "body", None), "code", None)
        if code is None:
            code = getattr(current, "code", None)
        if type(code) is str and code in CODES:
            item["code"] = code
        frames: deque[dict[str, object]] = deque(maxlen=6)
        trace = current.__traceback__
        while trace is not None:
            filename = Path(trace.tb_frame.f_code.co_filename).name
            function = trace.tb_frame.f_code.co_name
            frames.append(
                {
                    "file": filename
                    if re.fullmatch(r"[A-Za-z_][A-Za-z_0-9.]{0,95}", filename)
                    else "unknown",
                    "function": function
                    if re.fullmatch(r"[A-Za-z_<][A-Za-z_0-9<>]{0,95}", function)
                    else "unknown",
                    "line": trace.tb_lineno,
                }
            )
            trace = trace.tb_next
        item["stack"] = list(frames)
        index = len(details)
        details.append(item)
        cause = current.__cause__ or current.__context__
        if cause is not None:
            pending.appendleft((cause, index, "cause" if current.__cause__ else "context"))
        if isinstance(current, BaseExceptionGroup):
            pending.extend((child, index, "member") for child in current.exceptions[:8])
    return details


def record_event(
    event: str,
    *,
    error: BaseException | None = None,
    call_id: UUID | None = None,
    **fields: object,
) -> None:
    """Emit payload-free JSON; callers must supply code-owned event and label identifiers."""
    try:
        status = fields.get("status")
        severity = (
            "warning"
            if error is not None
            or (type(status) is int and status >= 400)
            or (type(status) is str and status in {"failed", "error", "unavailable", "timeout"})
            else "info"
        )
        if (type(status) is int and status >= 500) or (error is not None and status is None):
            severity = "error"
        payload: dict[str, object] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "event": event if type(event) is str and LABEL.fullmatch(event) else "diagnostic",
            "severity": severity,
            "incident_id": str(uuid4()),
            "boot_id": str(boot_id),
            **safe_fields(fields),
        }
        if request_id.get() is not None:
            payload["request_id"] = str(request_id.get())
        if isinstance(call_id, UUID):
            payload["call_id"] = str(call_id)
        if error is not None:
            payload["errors"] = error_details(error)
        logger.log(
            {"info": logging.INFO, "warning": logging.WARNING, "error": logging.ERROR}[severity],
            json.dumps(payload, separators=(",", ":"), allow_nan=False),
            extra={"safe_diagnostic": True},
        )
    except Exception:
        sink_warning()


class DiagnosticFile(RotatingFileHandler):
    """Private, bounded append-only diagnostic sink with non-throwing failure reporting."""

    def _open(self) -> TextIOWrapper:
        descriptor = os.open(
            self.baseFilename,
            os.O_WRONLY
            | os.O_APPEND
            | os.O_CREAT
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_NONBLOCK", 0),
            0o600,
        )
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode) or os.fstat(descriptor).st_nlink != 1:
                raise OSError("Unsafe diagnostic destination")
            os.fchmod(descriptor, 0o600)
            return os.fdopen(descriptor, "a", encoding="utf-8")
        except BaseException:
            os.close(descriptor)
            raise

    def emit(self, record: logging.LogRecord) -> None:
        """Persist only records produced by the sanitized diagnostic entry point."""
        if getattr(record, "safe_diagnostic", False):
            super().emit(record)

    def handleError(self, record: logging.LogRecord) -> None:
        """Never let logging's default traceback printer expose a failed record."""
        sink_warning()


@contextmanager
def diagnostic_sink(directory: Path, config: DiagnosticsConfig) -> Generator[None]:
    """Own the file handler for exactly one application lifespan, including failed startup."""
    # Uvicorn resets child levels; diagnostic retention is independent of server verbosity.
    logger.setLevel(logging.INFO)
    handler: DiagnosticFile | None = None
    try:
        try:
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / "diagnostics.jsonl"
            for index in range(11):
                backup = path if index == 0 else path.with_suffix(f".jsonl.{index}")
                if backup.is_symlink():
                    raise OSError("Unsafe diagnostic destination")
                if backup.exists():
                    descriptor = os.open(
                        backup,
                        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0),
                    )
                    try:
                        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                            raise OSError("Unsafe diagnostic destination")
                        if os.fstat(descriptor).st_nlink != 1:
                            raise OSError("Unsafe diagnostic destination")
                        os.fchmod(descriptor, 0o600)
                    finally:
                        os.close(descriptor)
                    if index > config.backup_count:
                        backup.unlink()
            handler = DiagnosticFile(
                path, maxBytes=config.max_bytes, backupCount=config.backup_count, encoding="utf-8"
            )
            handler.setFormatter(logging.Formatter("%(message)s"))
            logger.addHandler(handler)
        except Exception:
            sink_warning()
        yield
    finally:
        if handler is not None:
            logger.removeHandler(handler)
            try:
                handler.close()
            except Exception:
                sink_warning()
