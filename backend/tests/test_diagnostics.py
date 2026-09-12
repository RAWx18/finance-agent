# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
import logging
import sqlite3
from datetime import datetime
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.auth import AuthProblem
from app.config import DiagnosticsConfig, Environment
from app.diagnostics import DiagnosticFile, diagnostic_sink, logger, record_event, request_id
from app.history import History
from app.main import ServerLogFilter
from app.store import Problem

from .auth_support import auth_app, sign_in
from .conftest import ORIGIN

PRIVATE = "private-transcript-cookie-token-12345.67"


def entries(caplog):
    return [json.loads(record.message) for record in caplog.records if record.name == logger.name]


def persisted(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_exception_graph_is_bounded_and_never_formats_payloads(caplog):
    class PayloadError(Exception):
        def __str__(self):
            raise AssertionError("Exception text must not be rendered")

    try:
        try:
            raise PayloadError(PRIVATE)
        except PayloadError as cause:
            raise Problem(503, "authUnavailable", PRIVATE) from cause
    except Problem as error:
        group = ExceptionGroup(PRIVATE, [error, *[ValueError(PRIVATE) for _ in range(20)]])
    identity = uuid4()
    call = uuid4()
    token = request_id.set(identity)
    try:
        record_event("voice.failure", error=group, call_id=call, stage="workerTask")
    finally:
        request_id.reset(token)
    record_event("voice.failure", error=ValueError(PRIVATE))
    first, second = entries(caplog)
    assert first["request_id"] == str(identity)
    assert first["call_id"] == str(call)
    assert UUID(first["incident_id"]) != UUID(second["incident_id"])
    assert UUID(first["boot_id"]) == UUID(second["boot_id"])
    assert datetime.fromisoformat(first["timestamp"]).utcoffset().total_seconds() == 0
    assert first["severity"] == "error"
    assert len(first["errors"]) <= 8
    assert first["errors"][0]["type"] == "ExceptionGroup"
    problem = next(item for item in first["errors"] if item["type"] == "Problem")
    assert problem["status"] == 503 and problem["code"] == "authUnavailable"
    assert problem["relation"] == "member" and problem["parent"] == 0
    assert any(item["type"] == "PayloadError" for item in first["errors"])
    assert all(len(item["stack"]) <= 6 for item in first["errors"])
    assert all("/" not in frame["file"] for item in first["errors"] for frame in item["stack"])
    assert PRIVATE not in caplog.text
    assert "message" not in first and "locals" not in caplog.text


def test_cyclic_cause_and_deep_stack_remain_bounded(caplog):
    def recurse(depth):
        if depth:
            return recurse(depth - 1)
        raise RuntimeError(PRIVATE)

    try:
        recurse(20)
    except RuntimeError as error:
        error.__cause__ = error
        record_event("app.failure", error=error)
    graph = entries(caplog)[0]["errors"]
    assert len(graph) == 1 and len(graph[0]["stack"]) == 6
    assert all(set(frame) == {"file", "function", "line"} for frame in graph[0]["stack"])
    assert PRIVATE not in caplog.text


def test_fields_are_allowlisted_typed_and_payload_free(caplog):
    identity = uuid4()
    record_event(
        "voice.failure",
        call_id=identity,
        session_id=identity,
        command_id=identity,
        stage="modelCompletionContract",
        source="GuardedLLM",
        category="model",
        reason="emptyResponse",
        status=503,
        code="authUnavailable",
        generation=2,
        sequence=3,
        state_sequence=4,
        waiting=True,
        stopping=False,
        revoked=False,
        tool_rounds=1,
        model_requests=2,
        retry_attempts=1,
        auto_retry=True,
        retry_of=3,
        completed_turns=6,
        financial_revision=7,
        elapsed_seconds=1.23456,
        tool="retry_write",
        saved=None,
        current_action="clarify:" + PRIVATE,
        question_scope="immediateDecision",
        completion_chars=123,
        audio_frames=9,
        metrics={
            "model_requests": 2,
            "published_audio": 4,
            "token": PRIVATE,
            "amount_paise": 1234567,
            "errors": True,
        },
        transcript=PRIVATE,
        audio=PRIVATE,
        cookies={"cookie": PRIVATE},
        token=PRIVATE,
        facts={"opening": 1234567},
        request_id=str(uuid4()),
    )
    value = entries(caplog)[0]
    assert value["session_id"] == value["command_id"] == str(identity)
    assert value["current_action"] == "clarify"
    assert value["metrics"] == {"model_requests": 2, "published_audio": 4}
    assert value["elapsed_seconds"] == 1.235 and value["saved"] is None
    assert value["severity"] == "error"
    assert "request_id" not in value
    record_event(
        PRIVATE,
        stage=PRIVATE,
        code=PRIVATE,
        source={"text": PRIVATE},
        generation=True,
        audio_frames=-1,
        elapsed_seconds=float("nan"),
        session_id=str(identity),
        command_id=str(identity),
        current_action=PRIVATE,
        status=999,
    )
    assert set(entries(caplog)[1]) == {"event", "timestamp", "severity", "incident_id", "boot_id"}
    assert PRIVATE not in caplog.text and "1234567" not in caplog.text


def test_persistent_rotation_reopen_retention_and_permissions(tmp_path):
    config = DiagnosticsConfig(max_bytes=16384, backup_count=2)
    path = tmp_path / "diagnostics.jsonl"
    before = list(logger.handlers)
    with diagnostic_sink(tmp_path, config):
        record_event("app.startup", status="ok")
    with diagnostic_sink(tmp_path, config):
        record_event("app.shutdown", status="ok")
    assert [item["event"] for item in persisted(path)] == ["app.startup", "app.shutdown"]
    path.chmod(0o644)
    with diagnostic_sink(tmp_path, config):
        for sequence in range(500):
            record_event("voice.failure", sequence=sequence)
    files = sorted(tmp_path.iterdir())
    assert {file.name for file in files} == {
        "diagnostics.jsonl",
        "diagnostics.jsonl.1",
        "diagnostics.jsonl.2",
    }
    assert all(file.stat().st_mode & 0o777 == 0o600 for file in files)
    assert all(file.stat().st_size <= config.max_bytes for file in files)
    assert all(persisted(file) for file in files)
    assert logger.handlers == before
    with diagnostic_sink(tmp_path, DiagnosticsConfig(max_bytes=16384, backup_count=1)):
        assert not (tmp_path / "diagnostics.jsonl.2").exists()


def test_sink_preserves_all_severities_under_server_logging(tmp_path, caplog):
    """Persist and propagate diagnostics after Uvicorn resets child logger levels."""
    with (
        caplog.at_level(logging.ERROR, logger="uvicorn.error"),
        caplog.at_level(logging.NOTSET, logger=logger.name),
    ):
        assert logger.getEffectiveLevel() == logging.ERROR
        with diagnostic_sink(tmp_path, DiagnosticsConfig()):
            record_event("app.startup", status="ok")
            record_event("http.failure", status=409)
            record_event("http.failure", status=503)
    rows = persisted(tmp_path / "diagnostics.jsonl")
    assert [row["severity"] for row in rows] == ["info", "warning", "error"]
    assert entries(caplog) == rows


def test_symlink_destinations_are_rejected_without_changing_target(tmp_path, capsys):
    target = tmp_path / "private"
    target.write_text(PRIVATE)
    target.chmod(0o644)
    (tmp_path / "diagnostics.jsonl").symlink_to(target)
    with diagnostic_sink(tmp_path, DiagnosticsConfig()):
        record_event("app.startup")
    assert target.read_text() == PRIVATE and target.stat().st_mode & 0o777 == 0o644
    assert "diagnostics.sinkFailure" in capsys.readouterr().err


@pytest.mark.parametrize("failure", ["startup", "shutdown"])
def test_lifecycle_failure_removes_and_closes_handler(tmp_path, config, monkeypatch, failure):
    application = auth_app(config, Environment(data_dir=tmp_path))
    before = list(logger.handlers)
    error = RuntimeError(PRIVATE)
    monkeypatch.setattr(
        application.state.auth,
        "open" if failure == "startup" else "close",
        AsyncMock(side_effect=error),
    )
    with pytest.raises(RuntimeError) as caught, TestClient(application, base_url=ORIGIN):
        pass
    assert caught.value is error
    assert logger.handlers == before
    path = tmp_path / "diagnostics.jsonl"
    rows = persisted(path)
    assert any("errors" in row for row in rows)
    assert PRIVATE not in path.read_text()
    assert application.state.store.db is None


@pytest.mark.parametrize(
    "error,status,code",
    [
        (sqlite3.OperationalError(PRIVATE), 503, "unavailable"),
        (RuntimeError(PRIVATE), 500, "internalError"),
        (Problem(409, "commandConflict", PRIVATE), 409, "commandConflict"),
    ],
)
def test_api_preserves_responses_and_correlates_trusted_ids(
    tmp_path, config, monkeypatch, caplog, error, status, code
):
    application = auth_app(config, Environment(data_dir=tmp_path))
    with TestClient(application, base_url=ORIGIN, raise_server_exceptions=False) as client:
        sign_in(client)
        caplog.clear()
        monkeypatch.setattr(application.state.store, "get", AsyncMock(side_effect=error))
        supplied = str(uuid4())
        response = client.get("/api/session", headers={"X-Request-ID": supplied})
        assert response.status_code == status and response.json()["code"] == code
        identity = UUID(response.headers["X-Request-ID"])
        assert str(identity) != supplied
        rows = entries(caplog)
        assert len(rows) == 1 and rows[0]["request_id"] == str(identity)
        assert rows[0]["route"] == "/api/session"
        assert rows[0]["errors"][0]["type"] == type(error).__name__
        assert PRIVATE not in caplog.text
        assert any(
            row.get("request_id") == str(identity)
            for row in persisted(tmp_path / "diagnostics.jsonl")
        )


def test_unexpected_exception_still_propagates_to_test_transport(client, monkeypatch):
    error = RuntimeError(PRIVATE)
    monkeypatch.setattr(client.app.state.store, "get", AsyncMock(side_effect=error))
    with pytest.raises(RuntimeError) as caught:
        client.get("/api/session")
    assert caught.value is error


def test_boundary_auth_failure_is_persisted_with_cause(tmp_path, config, monkeypatch, caplog):
    application = auth_app(config, Environment(data_dir=tmp_path))
    try:
        raise RuntimeError(PRIVATE)
    except RuntimeError as cause:
        error = AuthProblem(503, "authUnavailable")
        error.__cause__ = cause
    with TestClient(application, base_url=ORIGIN) as client:
        caplog.clear()
        monkeypatch.setattr(application.state.auth, "identify", AsyncMock(side_effect=error))
        response = client.get("/api/history/" + PRIVATE)
        assert response.status_code == 503
        row = entries(caplog)[0]
        assert row["route"] == "/api/history/{slug}"
        assert row["request_id"] == response.headers["X-Request-ID"]
        assert [item["type"] for item in row["errors"]] == ["AuthProblem", "RuntimeError"]
        assert PRIVATE not in caplog.text


def test_validation_query_and_route_redaction_without_success_noise(client, monkeypatch, caplog):
    caplog.clear()
    assert client.get("/health/live").status_code == 200
    assert client.get("/api/session").status_code == 404
    assert not entries(caplog)
    response = client.post("/api/session", json={PRIVATE: PRIVATE})
    assert response.status_code == 422
    row = entries(caplog)[0]
    assert row["request_id"] == response.headers["X-Request-ID"]
    assert row["validation"] == [{"type": "extra_forbidden", "path": ["body", "*"]}]
    assert client.post("/api/session?token=" + PRIVATE, json={}).status_code == 400
    monkeypatch.setattr(History, "get", AsyncMock(side_effect=RuntimeError(PRIVATE)))
    with pytest.raises(RuntimeError):
        client.get("/api/history/" + PRIVATE)
    assert entries(caplog)[-1]["route"] == "/api/history/{slug}"
    assert PRIVATE not in caplog.text


def test_disk_full_does_not_replace_original_response(client, monkeypatch, caplog, capsys):
    monkeypatch.setattr(
        DiagnosticFile,
        "shouldRollover",
        lambda *args: (_ for _ in ()).throw(OSError(PRIVATE)),
    )
    monkeypatch.setattr(
        client.app.state.store,
        "get",
        AsyncMock(side_effect=sqlite3.OperationalError(PRIVATE)),
    )
    response = client.get("/api/session")
    assert response.status_code == 503 and response.json()["code"] == "unavailable"
    assert UUID(response.headers["X-Request-ID"])
    output = capsys.readouterr().err
    assert "diagnostics.sinkFailure" in output
    assert PRIVATE not in output and PRIVATE not in caplog.text and "Traceback" not in output


def test_unwritable_sink_does_not_prevent_lifespan_or_api_response(
    tmp_path, config, monkeypatch, capsys
):
    def unavailable(handler):
        raise OSError(PRIVATE)

    monkeypatch.setattr(DiagnosticFile, "_open", unavailable)
    application = auth_app(config, Environment(data_dir=tmp_path))
    before = list(logger.handlers)
    with TestClient(application, base_url=ORIGIN, raise_server_exceptions=False) as client:
        sign_in(client)
        monkeypatch.setattr(
            application.state.store, "get", AsyncMock(side_effect=RuntimeError(PRIVATE))
        )
        response = client.get("/api/session")
        assert response.status_code == 500 and response.json()["code"] == "internalError"
        assert UUID(response.headers["X-Request-ID"])
    assert logger.handlers == before
    output = capsys.readouterr().err
    assert "diagnostics.sinkFailure" in output and PRIVATE not in output


def test_uvicorn_duplicate_report_does_not_render_exception_text():
    error = RuntimeError(PRIVATE)
    record = logging.LogRecord(
        "uvicorn.error",
        logging.ERROR,
        __file__,
        1,
        "Exception in ASGI application\n",
        (),
        (RuntimeError, error, None),
    )
    assert ServerLogFilter().filter(record)
    assert PRIVATE not in logging.Formatter().format(record)
    assert record.exc_info is None


@pytest.mark.parametrize(
    "field,value",
    [
        ("max_bytes", 0),
        ("max_bytes", True),
        ("max_bytes", 16777217),
        ("backup_count", 0),
        ("backup_count", True),
        ("backup_count", 11),
    ],
)
def test_diagnostics_configuration_rejects_unbounded_retention(field, value):
    with pytest.raises(ValidationError):
        DiagnosticsConfig.model_validate({field: value})


def test_primary_configuration_owns_diagnostic_defaults(config):
    assert config.diagnostics == DiagnosticsConfig(max_bytes=2097152, backup_count=3)


async def test_cleanup_worker_failure_is_persisted(tmp_path, config, monkeypatch):
    config = config.model_copy(update={"cleanup_seconds": 1})
    application = auth_app(config, Environment(data_dir=tmp_path))
    error = RuntimeError(PRIVATE)
    monkeypatch.setattr(application.state.store, "cleanup", AsyncMock(side_effect=[None, error]))
    before = list(logger.handlers)
    with pytest.raises(RuntimeError) as caught:
        async with application.router.lifespan_context(application):
            await application.state.cleanup_task
    assert caught.value is error and logger.handlers == before
    path = tmp_path / "diagnostics.jsonl"
    rows = [row for row in persisted(path) if row["event"] == "app.cleanupFailure"]
    assert len(rows) == 1 and rows[0]["errors"][0]["type"] == "RuntimeError"
    assert PRIVATE not in path.read_text()


@pytest.mark.parametrize("domain", [False, True])
def test_sse_generator_failure_is_logged_once_and_unsubscribed(client, monkeypatch, caplog, domain):
    client.post("/api/session", json={})
    store = client.app.state.store
    subscribe = store.subscribe
    error = Problem(503, "unavailable", PRIVATE) if domain else RuntimeError(PRIVATE)

    async def fail_after_subscribe(owner):
        queue = await subscribe(owner)
        monkeypatch.setattr(store, "get", AsyncMock(side_effect=error))
        return queue

    monkeypatch.setattr(store, "subscribe", fail_after_subscribe)
    caplog.clear()
    if domain:
        response = client.get("/api/session/events")
        assert response.status_code == 200 and "event: unavailable" in response.text
    else:
        with pytest.raises(RuntimeError):
            client.get("/api/session/events")
    rows = entries(caplog)
    assert len(rows) == 1 and rows[0]["stage"] == "sse"
    assert rows[0]["errors"][0]["type"] == type(error).__name__
    assert rows[0]["route"] == "/api/session/events"
    assert not store.listeners and not store.listener_access
    assert PRIVATE not in caplog.text


async def test_request_context_is_task_local_and_reset(caplog):
    async def emit(identity):
        token = request_id.set(identity)
        try:
            await asyncio.sleep(0)
            record_event("http.failure", status=503)
        finally:
            request_id.reset(token)

    identities = [uuid4(), uuid4()]
    await asyncio.gather(*(emit(identity) for identity in identities))
    assert {row["request_id"] for row in entries(caplog)} == {str(value) for value in identities}
    assert request_id.get() is None


@pytest.mark.parametrize("code", ["callEnded", "callBusy"])
@pytest.mark.parametrize("method", ["POST", "DELETE"])
def test_call_rejection_retains_validated_id_and_code(tmp_path, config, monkeypatch, code, method):
    application = auth_app(config, Environment(data_dir=tmp_path))
    call = uuid4()
    monkeypatch.setattr(
        application.state.calls,
        "start" if method == "POST" else "end",
        AsyncMock(side_effect=Problem(409, code, PRIVATE)),
    )
    with TestClient(application, base_url=ORIGIN) as client:
        sign_in(client)
        response = client.request(method, "/api/session/call", json={"callId": str(call)})
        assert response.status_code == 409
    text = (tmp_path / "diagnostics.jsonl").read_text()
    event = next(
        row
        for row in persisted(tmp_path / "diagnostics.jsonl")
        if row.get("request_id") == response.headers["X-Request-ID"]
    )
    assert event["call_id"] == str(call) and event["code"] == code
    assert event["errors"][0]["code"] == code and PRIVATE not in text
