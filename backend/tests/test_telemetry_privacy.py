# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import io
import json
import logging
from uuid import uuid4

import pytest
import structlog
from structlog.contextvars import bind_contextvars, clear_contextvars

from app import diagnostics, telemetry
from app.config import DiagnosticsConfig
from app.store import Problem

PRIVATE = "secret financial input 12345.67 private-key"


class ProviderError(Exception):
    def __init__(self, code=PRIVATE, request_id=PRIVATE):
        super().__init__(PRIVATE)
        self.status_code = 429
        self.code = code
        self.request_id = request_id


class Opaque:
    def __str__(self):
        raise AssertionError("Private objects must not be formatted")

    __repr__ = __str__


@pytest.fixture
def logs(monkeypatch):
    root = logging.getLogger()
    handlers = root.handlers[:]
    level = root.level
    config = structlog.get_config().copy()
    handler = telemetry.handler
    stream = io.StringIO()
    monkeypatch.setattr("sys.stderr", stream)
    clear_contextvars()
    telemetry.configure("INFO", "json")
    try:
        yield stream
    finally:
        clear_contextvars()
        if telemetry.handler is not None:
            root.removeHandler(telemetry.handler)
            telemetry.handler.close()
        root.handlers[:] = handlers
        root.setLevel(level)
        telemetry.handler = handler
        structlog.configure(**config)


@pytest.mark.parametrize(
    "error",
    [RuntimeError("secret"), Problem(503, "voiceUnavailable", PRIVATE), ProviderError()],
)
def test_exception_metadata_never_contains_messages_or_unknown_provider_values(error):
    fields = telemetry.error_fields(error)
    assert fields["errorType"] == type(error).__name__
    assert "errorMessage" not in fields and "providerRequestId" not in fields
    assert PRIVATE not in json.dumps(fields) and "secret" not in json.dumps(fields)
    if isinstance(error, Problem):
        assert fields["errorStatus"] == 503 and fields["errorCode"] == "voiceUnavailable"
    if isinstance(error, ProviderError):
        assert fields["errorStatus"] == 429 and "errorCode" not in fields
    assert telemetry.error_fields(None) == {}


def test_exception_graph_uses_diagnostic_metadata(monkeypatch):
    try:
        try:
            raise ValueError(PRIVATE)
        except ValueError as cause:
            raise Problem(503, "voiceUnavailable", PRIVATE) from cause
    except Problem as error:
        problem = error
    group = ExceptionGroup(PRIVATE, [problem, *[RuntimeError(PRIVATE) for _ in range(20)]])
    details = diagnostics.error_details(group)
    calls = []

    def error_details(error):
        calls.append(error)
        return details

    monkeypatch.setattr(telemetry, "error_details", error_details)
    fields = telemetry.error_fields(group)
    assert calls == [group] and fields["errors"] == details
    assert len(fields["errors"]) == 8
    assert all(len(item["stack"]) <= 6 for item in fields["errors"])
    assert PRIVATE not in json.dumps(fields)
    monkeypatch.undo()
    fields = telemetry.error_fields(problem)
    assert fields["errorCause"] == "ValueError"
    assert fields["errorAt"].startswith("test_telemetry_privacy.py:")
    assert fields["errorStack"][-1] == fields["errorAt"]


@pytest.mark.parametrize("identity", [str(uuid4()), uuid4()])
def test_only_uuid_provider_identity_and_known_code_are_retained(identity):
    fields = telemetry.error_fields(ProviderError("rate_limit_exceeded", identity))
    assert fields["providerRequestId"] == str(identity)
    assert fields["errorCode"] == "rate_limit_exceeded"


def test_nested_rendering_redacts_private_fields_without_mutating_inputs(logs):
    keys = [
        "headers",
        "requestHeaders",
        "url",
        "query",
        "query_string",
        "body",
        "args",
        "positional_args",
        "arguments",
        "Api-Key",
        "private_key",
        "Authorization",
        "cookies",
        "access_token",
        "text",
        "content",
        "transcript",
        "messages",
        "facts",
        "snapshot",
        "errorMessage",
        "providerMessage",
        "exc_text",
        "stack_info",
        "traceback",
    ]
    private = {key: PRIVATE for key in keys}
    data = {"nested": [private, ({"durationMs": 12, "providerRequestId": PRIVATE},)]}
    data["opaque"] = Opaque()
    data["error"] = RuntimeError(PRIVATE)
    data["bytes"] = PRIVATE.encode()
    bind_contextvars(context={"body": PRIVATE})
    telemetry.get_logger("app.privacy", "test").info("privacy.checked", data=data)
    rendered = logs.getvalue()
    assert PRIVATE not in rendered
    event = json.loads(rendered)
    assert all(value == "[redacted]" for value in event["data"]["nested"][0].values())
    assert event["data"]["nested"][1][0]["durationMs"] == 12
    assert event["data"]["error"]["errorType"] == "RuntimeError"
    assert event["data"]["opaque"] == event["data"]["bytes"] == "[redacted]"
    assert all(value == PRIVATE for value in private.values())
    assert isinstance(data["opaque"], Opaque)


def test_cyclic_containers_and_exception_causes_are_bounded(logs):
    data = {"body": PRIVATE}
    data["nested"] = data
    error = RuntimeError(PRIVATE)
    error.__cause__ = error
    telemetry.get_logger("app.privacy", "test").error("privacy.checked", data=data, exc_info=error)
    rendered = logs.getvalue()
    assert PRIVATE not in rendered and "Traceback" not in rendered
    assert len(rendered) < 10000
    assert len(json.loads(rendered)["errors"]) == 1


@pytest.mark.parametrize("output", ["json", "console"])
@pytest.mark.parametrize("foreign", [False, True])
def test_rendered_exception_groups_and_causes_never_leak(logs, monkeypatch, output, foreign):
    monkeypatch.setattr("sys.stderr", logs)
    telemetry.configure("INFO", output)
    try:
        try:
            raise RuntimeError(PRIVATE)
        except RuntimeError as cause:
            raise ExceptionGroup(PRIVATE, [Problem(503, "voiceUnavailable", PRIVATE)]) from cause
    except ExceptionGroup:
        if foreign:
            logging.getLogger("privacy.provider").exception("Provider failed: %s", PRIVATE)
        else:
            telemetry.get_logger("app.privacy", "test").exception("privacy.failed")
    rendered = logs.getvalue()
    assert PRIVATE not in rendered and "Traceback" not in rendered
    assert "ExceptionGroup" in rendered and "RuntimeError" in rendered and "Problem" in rendered
    if output == "json":
        assert json.loads(rendered)["errorCause"] == "RuntimeError"


def test_foreign_messages_args_and_cached_tracebacks_are_not_formatted(logs):
    formatter = telemetry.handler.formatter
    record = logging.LogRecord("privacy.provider", logging.ERROR, __file__, 1, Opaque(), (), None)
    record.exc_text = PRIVATE
    record.stack_info = PRIVATE
    rendered = formatter.format(record)
    assert PRIVATE not in rendered and json.loads(rendered)["event"] == "log.message"
    assert isinstance(record.msg, Opaque) and record.exc_text == PRIVATE
    record.msg = "Provider failed: %s"
    record.args = (Opaque(),)
    assert json.loads(formatter.format(record))["event"] == "log.message"


def test_safe_diagnostic_json_is_structured_complete_and_file_unchanged(logs, tmp_path):
    identity = uuid4()
    with diagnostics.diagnostic_sink(tmp_path, DiagnosticsConfig()):
        try:
            raise Problem(503, "voiceUnavailable", PRIVATE)
        except Problem as error:
            diagnostics.record_event(
                "voice.failure",
                error=error,
                call_id=identity,
                stage="modelCompletion",
                metrics={"model_requests": 10, "model_failed": 1},
            )
    rendered = logs.getvalue()
    persisted = (tmp_path / "diagnostics.jsonl").read_text()
    assert len(persisted) > 200
    assert PRIVATE not in rendered and PRIVATE not in persisted
    event = json.loads(rendered)
    payload = json.loads(persisted)
    assert event["event"] == "voice.failure"
    assert event["time"] == payload.pop("timestamp")
    assert "timestamp" not in event and "…" not in rendered
    assert all(event[key] == value for key, value in payload.items())
    assert event["call_id"] == str(identity)


@pytest.mark.parametrize(
    ("name", "component"),
    [
        ("speech.synthesisFailed", "tts"),
        ("speech.recognitionStopped", "stt"),
        ("voice.stopped", "pipecat"),
        ("call.cleanupFailed", "call"),
        ("http.failure", "http"),
        ("daily.requestFailed", "daily"),
    ],
)
def test_diagnostics_carry_component_and_camel_case_correlation_aliases(logs, name, component):
    """Diagnostic records join the structlog stream with the same filterable labels."""
    call = uuid4()
    token = diagnostics.request_id.set(uuid4())
    try:
        diagnostics.record_event(name, call_id=call, session_id=call, status="failed")
    finally:
        diagnostics.request_id.reset(token)
    event = json.loads(logs.getvalue())
    assert event["component"] == component
    assert event["callId"] == event["sessionId"] == str(call)
    assert event["requestId"] == event["request_id"]


@pytest.mark.parametrize("message", [PRIVATE, "{invalid", "[]", '{"event":"' + PRIVATE + '"}'])
def test_untrusted_or_malformed_diagnostics_do_not_bypass_redaction(logs, message):
    logging.getLogger("privacy.provider").info(message, extra={"safe_diagnostic": True})
    assert PRIVATE not in logs.getvalue()
    assert json.loads(logs.getvalue())["event"] == "log.message"
    if message in {"{invalid", "[]"}:
        diagnostics.logger.info(message, extra={"safe_diagnostic": True})
        assert json.loads(logs.getvalue().splitlines()[-1])["event"] == "log.message"


def test_logging_sink_failure_does_not_dump_raw_record(logs, monkeypatch):
    class BrokenStream:
        def write(self, text):
            raise OSError(PRIVATE)

        def flush(self):
            pass

    monkeypatch.setattr("sys.stderr", logs)
    telemetry.handler.setStream(BrokenStream())
    logging.getLogger("privacy.provider").error(PRIVATE, extra={"body": PRIVATE})
    assert PRIVATE not in logs.getvalue() and "Traceback" not in logs.getvalue()
    assert json.loads(logs.getvalue())["event"] == "telemetry.sinkFailure"


async def test_span_preserves_propagation_cancellation_and_single_finish(logs):
    log = telemetry.get_logger("app.privacy", "test")
    error = RuntimeError(PRIVATE)
    with pytest.raises(RuntimeError) as caught:
        with telemetry.Span(log, "privacy.operation"):
            raise error
    assert caught.value is error
    async with telemetry.Span(log, "privacy.operation"):
        await asyncio.sleep(0)
    span = telemetry.Span(log, "privacy.operation").begin()
    span.finish(asyncio.CancelledError(PRIVATE))
    span.finish()
    events = [json.loads(line) for line in logs.getvalue().splitlines()]
    assert [event["status"] for event in events] == [
        "started",
        "failed",
        "started",
        "ok",
        "started",
        "cancelled",
    ]
    assert events[-1]["level"] == "info" and events[-1]["durationMs"] >= 0
    assert PRIVATE not in logs.getvalue()
