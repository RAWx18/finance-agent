# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
import logging
import re

import pytest
import structlog
from structlog.contextvars import bind_contextvars, clear_contextvars, get_contextvars

from app import telemetry
from app.store import Problem
from app.telemetry import Span, configure, error_fields, failure_status, get_logger, sanitize


class ProviderError(Exception):
    """Provider-style exception carrying status, code, and request identity."""

    def __init__(self) -> None:
        super().__init__("Error code: 429 - {'error': 'private provider body'}")
        self.status_code = 429
        self.code = "rate_limit_exceeded"
        self.request_id = "req_123"


def events(capsys) -> list[dict]:
    """Parse JSON log lines written to stderr, reporting any non-JSON output verbatim."""
    captured = capsys.readouterr()
    assert captured.out == ""
    text = captured.err
    try:
        return [json.loads(line) for line in text.splitlines() if line]
    except ValueError:
        raise AssertionError("Non-JSON log output:\n" + text) from None


def test_sanitize_redacts_private_keys_and_bounds_values():
    """Secrets, speech, and payload-like keys are redacted; long values are truncated."""
    event = sanitize(
        None,
        "info",
        {
            "event": "x",
            "roomToken": "private token",
            "apiKey": "private key",
            "Authorization": "Bearer private",
            "transcript": "private speech",
            "text": "private text",
            "arguments": {"amount": "1"},
            "context": "kept",
            "note": "a" * 300,
        },
    )
    assert event["roomToken"] == event["apiKey"] == event["Authorization"] == "[redacted]"
    assert event["transcript"] == event["text"] == event["arguments"] == "[redacted]"
    assert event["context"] == "kept"
    assert len(event["note"]) == 201 and event["note"].endswith("…")


def test_error_fields_describe_problems_causes_and_provider_errors():
    """Errors expose type, status, code, origin, and cause without exception messages."""
    try:
        try:
            json.loads("not json")
        except ValueError as cause:
            raise Problem(503, "voiceUnavailable", "Daily room service is unavailable.") from cause
    except Problem as error:
        fields = error_fields(error)
    assert fields["errorType"] == "Problem"
    assert fields["errorStatus"] == 503
    assert fields["errorCode"] == "voiceUnavailable"
    assert "errorMessage" not in fields
    assert "Daily room service is unavailable." not in json.dumps(fields)
    assert "not json" not in json.dumps(fields)
    assert fields["errorCause"] == "JSONDecodeError"
    assert fields["errorAt"].startswith("test_telemetry.py:")
    assert fields["errorStack"][-1] == fields["errorAt"]
    assert 2 <= len(fields["errors"]) <= 8
    root, cause = fields["errors"][:2]
    assert root["type"] == "Problem" and root["relation"] == "root" and root["parent"] is None
    assert root["status"] == 503 and root["code"] == "voiceUnavailable"
    assert cause["type"] == "JSONDecodeError"
    assert cause["relation"] == "cause" and cause["parent"] == 0
    for detail in fields["errors"]:
        assert set(detail) <= {"type", "parent", "relation", "status", "code", "stack"}
        assert 0 < len(detail["stack"]) <= 6
        for frame in detail["stack"]:
            assert set(frame) == {"file", "function", "line"}
            assert "/" not in frame["file"] and frame["line"] > 0
    frame = root["stack"][-1]
    assert fields["errorAt"] == f"{frame['file']}:{frame['function']}:{frame['line']}"

    provider = error_fields(ProviderError())
    assert provider == {
        "errorType": "ProviderError",
        "errorStatus": 429,
        "errorCode": "rate_limit_exceeded",
        "errors": [
            {
                "type": "ProviderError",
                "parent": None,
                "relation": "root",
                "status": 429,
                "code": "rate_limit_exceeded",
                "stack": [],
            }
        ],
    }
    assert "private" not in json.dumps(provider) and "req_123" not in json.dumps(provider)
    assert error_fields(RuntimeError("Voice worker exited")) == {
        "errorType": "RuntimeError",
        "errors": [{"type": "RuntimeError", "parent": None, "relation": "root", "stack": []}],
    }
    assert error_fields(None) == {}


def test_failure_status_classifies_outcomes():
    """Cancellation, timeouts, client rejections, and server failures are distinct."""
    assert failure_status(asyncio.CancelledError()) == "cancelled"
    assert failure_status(TimeoutError()) == "timeout"
    assert failure_status(Problem(409, "staleRevision", "Session changed.")) == "rejected"
    assert failure_status(Problem(503, "unavailable", "Storage is unavailable.")) == "failed"
    assert failure_status(RuntimeError()) == "failed"


@pytest.fixture
def logs(capsys):
    """Restore logging state before capture closes; configure streams in the test call phase."""
    states = [
        (logger, logger.handlers[:], logger.level, logger.propagate, logger.disabled)
        for logger in (
            logging.getLogger(),
            logging.getLogger("uvicorn"),
            logging.getLogger("uvicorn.error"),
            logging.getLogger("uvicorn.access"),
        )
    ]
    config = structlog.get_config().copy()
    configured = structlog.is_configured()
    handler = telemetry.handler
    context = get_contextvars()
    clear_contextvars()
    try:
        yield capsys
    finally:
        if telemetry.handler is not None and telemetry.handler is not handler:
            logging.getLogger().removeHandler(telemetry.handler)
            telemetry.handler.close()
        for logger, handlers, level, propagate, disabled in states:
            logger.handlers[:] = handlers
            logger.setLevel(level)
            logger.propagate = propagate
            logger.disabled = disabled
        telemetry.handler = handler
        if configured:
            structlog.configure(**config)
        else:
            structlog.reset_defaults()
        clear_contextvars()
        bind_contextvars(**context)


def test_json_lines_carry_level_time_component_and_bound_context(logs):
    """Every line is one JSON object with severity, timestamp, component, and correlation IDs."""
    assert configure("INFO", "json") == "json"
    bind_contextvars(requestId="req-1", callId="call-1")
    get_logger("app.test", "call").bind(sessionId="s-1").warning("call.failed", stage="setup")
    (line,) = events(logs)
    assert line["event"] == "call.failed"
    assert line["level"] == "warning"
    assert line["component"] == "call"
    assert line["logger"] == "app.test"
    assert line["requestId"] == "req-1" and line["callId"] == "call-1"
    assert line["sessionId"] == "s-1" and line["stage"] == "setup"
    assert line["time"].endswith("Z")


@pytest.mark.parametrize("level", ["INFO", "WARNING", "ERROR"])
def test_server_loggers_inherit_application_level(logs, level):
    """Application verbosity takes precedence over Uvicorn's prior configuration."""
    for name in ("uvicorn", "uvicorn.error"):
        logging.getLogger(name).setLevel(logging.CRITICAL)
    configure(level, "json")
    for name in ("uvicorn", "uvicorn.error"):
        server = logging.getLogger(name)
        assert server.getEffectiveLevel() == logging.getLevelName(level)
        server.log(logging.getLevelName(level), "Server lifecycle event")
    assert [line["logger"] for line in events(logs)] == ["uvicorn", "uvicorn.error"]


def test_foreign_records_and_tracebacks_are_compacted(logs):
    """Standard-library records, including server exceptions, render as payload-free JSON."""
    configure("INFO", "json")
    bind_contextvars(requestId="req-1", callId="call-1")
    server = logging.getLogger("uvicorn.error")
    server.info("Application startup complete.")
    try:
        raise ValueError("private payload detail")
    except ValueError:
        server.error("Exception in ASGI application", exc_info=True)
        logging.getLogger("app.provider").exception("Provider failed: %s", "private payload detail")
    startup, duplicate, failure = events(logs)
    assert startup["event"] == duplicate["event"] == failure["event"] == "log.message"
    assert startup["level"] == "info" and duplicate["level"] == failure["level"] == "error"
    assert startup["logger"] == duplicate["logger"] == "uvicorn.error"
    assert failure["logger"] == "app.provider"
    assert "errors" not in duplicate and "errorType" not in duplicate
    assert failure["errorType"] == "ValueError"
    assert failure["errorAt"].startswith("test_telemetry.py:")
    assert failure["errorStack"][-1] == failure["errorAt"]
    (detail,) = failure["errors"]
    assert set(detail) == {"type", "parent", "relation", "stack"}
    assert detail["type"] == "ValueError" and detail["parent"] is None
    assert detail["relation"] == "root"
    (frame,) = detail["stack"]
    assert set(frame) == {"file", "function", "line"}
    assert failure["errorAt"] == f"{frame['file']}:{frame['function']}:{frame['line']}"
    for line in (startup, duplicate, failure):
        assert line["requestId"] == "req-1" and line["callId"] == "call-1"
        assert line["time"].endswith("Z")
        assert not {"exception", "errorMessage", "exc_info", "exc_text", "stack_info"} & line.keys()
        assert "Traceback" not in json.dumps(line)
        assert "private payload detail" not in json.dumps(line)
        assert "Application startup complete." not in json.dumps(line)
        assert "Provider failed" not in json.dumps(line)
    assert logging.getLogger("uvicorn.access").disabled


def test_console_format_is_colored_and_readable(logs):
    """Console output uses ANSI colors and keeps the event and fields on one line."""
    assert configure("INFO", "console") == "console"
    get_logger("app.test", "tool").info("tool.call", tool="read_state", durationMs=1.5)
    captured = logs.readouterr()
    assert captured.out == ""
    assert "\x1b[" in captured.err
    (line,) = re.sub(r"\x1b\[[0-9;]*m", "", captured.err).splitlines()
    assert "tool.call" in line and "tool=read_state" in line
    assert "component=tool" in line and "durationMs=1.5" in line and "info" in line


async def test_span_logs_start_and_outcome_with_duration(logs):
    """Spans log started, then ok or a classified failure with error fields and duration."""
    configure("INFO", "json")
    bind_contextvars(requestId="req-1", callId="call-1")
    log = get_logger("app.test", "daily")
    async with Span(log, "daily.request", method="POST"):
        await asyncio.sleep(0)
    with pytest.raises(Problem):
        with Span(log, "daily.request", method="DELETE"):
            raise Problem(503, "voiceUnavailable", "Daily room service is unavailable.")
    span = Span(log, "tool.call", tool="read_state").begin()
    span.finish(asyncio.CancelledError())
    span.finish()
    lines = events(logs)
    assert [line["status"] for line in lines] == [
        "started",
        "ok",
        "started",
        "failed",
        "started",
        "cancelled",
    ]
    assert all(line["method"] == "POST" for line in lines[:2])
    assert all(line["method"] == "DELETE" for line in lines[2:4])
    assert all(line["tool"] == "read_state" for line in lines[4:])
    assert all(line["event"] == "daily.request" for line in lines[:4])
    assert all(line["event"] == "tool.call" for line in lines[4:])
    assert all(line["durationMs"] >= 0 for line in lines[1::2])
    assert all("durationMs" not in line for line in lines[::2])
    assert all(line["requestId"] == "req-1" and line["callId"] == "call-1" for line in lines)
    assert lines[1]["durationMs"] >= 0 and lines[1]["level"] == "info"
    assert lines[3]["level"] == "warning" and lines[3]["errorCode"] == "voiceUnavailable"
    assert lines[3]["errorType"] == "Problem" and lines[3]["errorStatus"] == 503
    assert lines[3]["errors"][0]["type"] == "Problem"
    assert lines[3]["errorAt"].startswith("test_telemetry.py:")
    assert lines[3]["errorStack"][-1] == lines[3]["errorAt"]
    assert lines[5]["level"] == "info" and lines[5]["errorType"] == "CancelledError"
    assert lines[5]["errors"] == [
        {"type": "CancelledError", "parent": None, "relation": "root", "stack": []}
    ]
    assert all("errorMessage" not in line for line in lines)
    assert "Daily room service is unavailable." not in json.dumps(lines)
