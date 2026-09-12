# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.auth import COOKIE
from app.config import Environment
from app.models import CallState, Command, FactsPatch, Model
from app.store import Problem
from app.voice import Call, CallManager, DailyRooms, unavailable_reason
from app.voice_pipeline import VoicePipeline
from app.voice_tools import ReviewRequest, VoiceTools, tool_parameters

from .auth_support import auth_app, sign_in
from .conftest import ORIGIN, money


def environment(tmp_path):
    """Build a temporary environment with dummy voice credentials."""
    return Environment(
        data_dir=tmp_path,
        azure_openai_api_key=SecretStr("test-only-azure"),
        azure_openai_endpoint="https://test-resource.openai.azure.com/",
        daily_api_key=SecretStr("test-only-daily"),
        azure_speech_key=SecretStr("test-only-speech"),
        azure_speech_region="centralindia",
    )


def unavailable_events(caplog):
    """Select structured voice.unavailable records as (stage, reason) pairs."""
    return [
        (record.msg["stage"], record.msg["reason"])
        for record in caplog.records
        if isinstance(record.msg, dict) and record.msg.get("event") == "voice.unavailable"
    ]


async def test_partial_facts_are_atomic_retained_idempotent_and_corrected(store):
    """Verify partial fact writes persist atomically, replay safely, and support corrections."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    patch = {
        "expectedRevision": 0,
        "opening": money("20000"),
        "coverage": {"income": "reported"},
        "records": [
            {
                "kind": "income",
                "label": "Salary",
                "amount": money("10000"),
                "schedule": {"date": "2026-09-15"},
                "reliability": "reliable",
            },
            {
                "kind": "essential",
                "label": "Rent",
                "amount": money("5000"),
                "schedule": {"date": "2026-09-18"},
            },
        ],
    }
    result = await tools.update_facts(patch, "first")
    snapshot = await store.get("owner")
    assert snapshot.revision == 1
    assert snapshot.plan.closing_paise == 2500000
    assert snapshot.facts.coverage.essential == "reported"
    salary, rent = snapshot.facts.records
    assert salary.id != rent.id
    await store.close()
    await store.open()
    assert (await tools.update_facts(patch, "first")) == result
    correction = {"expectedRevision": 1, "records": [{"id": rent.id, "amount": money("6000")}]}
    await tools.update_facts(correction, "correction")
    snapshot = await store.get("owner")
    assert snapshot.facts.records[0] == salary
    assert snapshot.facts.records[1].schedule == rent.schedule
    assert snapshot.plan.closing_paise == 2400000
    stale = await tools.invoke("update_facts", correction, "stale")
    assert stale["code"] == "staleRevision"
    await tools.update_facts(
        {
            "expectedRevision": 2,
            "records": [
                {"id": rent.id, "amount": money(None, "unknown"), "schedule": {"date": None}}
            ],
        },
        "unknown",
    )
    snapshot = await store.get("owner")
    assert snapshot.facts.records[1].amount.amount_paise is None
    assert snapshot.facts.records[1].schedule.date is None
    assert snapshot.facts.opening.amount_paise == 2000000
    invalid = await tools.invoke(
        "update_facts",
        {
            "expectedRevision": 3,
            "opening": money("999"),
            "records": [{"id": "missing", "amount": money("1")}],
        },
        "invalid",
    )
    assert invalid["code"] == "invalidFacts"
    assert (await store.get("owner")).revision == 3
    await tools.update_facts(
        {
            "expectedRevision": 3,
            "records": [{"id": rent.id, "delete": True}],
        },
        "delete",
    )
    assert (await store.get("owner")).facts.records == [salary]


async def test_voice_cash_correction_preserves_independent_consent(store):
    """Verify a cash correction preserves consent for an independent spending adjustment."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    await tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money("1000"),
            "records": [
                {
                    "kind": "optional",
                    "label": "Dining",
                    "controllability": "controllable",
                    "amount": money("500"),
                    "schedule": {"date": "2026-09-18"},
                }
            ],
        },
        "start",
    )
    option = (await store.options("owner")).options[0]
    preview = await store.command(
        "owner",
        Command.model_validate(
            {
                "commandId": str(uuid4()),
                "expectedRevision": 1,
                "operation": {
                    "type": "previewAdjustments",
                    "adjustments": [
                        {
                            "eventId": option.event_id,
                            "amount": "0",
                        }
                    ],
                },
            }
        ),
    )
    await store.command(
        "owner",
        Command.model_validate(
            {
                "commandId": str(uuid4()),
                "expectedRevision": 1,
                "operation": {
                    "type": "acceptPreview",
                    "previewId": str(preview.preview.id),
                    "confirmed": True,
                    "consentScope": "unconditional",
                },
            }
        ),
    )
    await tools.update_facts({"expectedRevision": 2, "opening": money("2000")}, "correct")
    snapshot = await store.get("owner")
    assert snapshot.preview is None and snapshot.accepted is not None
    assert snapshot.plan.closing_paise == 150000
    assert snapshot.accepted.plan.closing_paise == 200000


async def test_review_is_deterministic_readonly_and_rejects_stale_revision(store):
    """Verify review leaves facts unchanged and returns current state for stale revisions."""
    await store.create("owner")
    refreshed = []
    tools = VoiceTools(store, "owner", uuid4(), refreshed.append)
    baseline = await store.get("owner")
    await tools.invoke("read_state", {}, "read")
    result = await tools.invoke("review_plan", {"expectedRevision": 0}, "plan")
    assert result["activeAssessment"]["nextQuestionId"] == "opening"
    assert await store.get("owner") == baseline
    await tools.update_facts({"expectedRevision": 0, "opening": money("100")}, "external")
    result = await tools.review_plan({"expectedRevision": 0})
    assert result["stateChanged"] and "review" not in result
    assert result["snapshot"]["revision"] == 1


def test_http_setup_guards_contract_and_csp(client):
    """Verify call setup guards, public unavailability responses, and voice CSP directives."""
    assert client.post("/api/session/call", json={"callId": str(uuid4())}).status_code == 404
    settings = client.get("/api/settings").json()
    assert settings["voiceAvailable"] is False
    assert settings["voiceUnavailableReason"] == (
        "Conversations are temporarily unavailable. Please try again shortly."
    )
    client.post("/api/session", json={})
    assert client.get("/api/session/call").json() == {
        "callId": None,
        "conversationSlug": None,
        "status": "idle",
        "cleanupConfirmed": True,
        "message": None,
    }
    assert client.post("/api/session/call", json={"sessionId": str(uuid4())}).status_code == 422
    response = client.post("/api/session/call", json={"callId": str(uuid4())})
    assert response.status_code == 503
    assert response.json() == {
        "code": "voiceUnavailable",
        "message": settings["voiceUnavailableReason"],
        "snapshot": None,
    }
    body = {"callId": str(uuid4())}
    assert client.request("DELETE", "/api/session/call", json=body).json()["status"] == "ended"
    assert client.request("DELETE", "/api/session/call", json=body).json()["status"] == "ended"
    csp = client.get("/api/settings").headers["content-security-policy"]
    assert "worker-src 'self' blob:" in csp
    assert "wss://*.daily.co" in csp and " wss:;" not in csp
    assert "unsafe-eval" not in csp


def test_missing_setup_diagnostics_stay_internal(config, tmp_path, caplog):
    """Verify missing voice configuration is logged without exposing diagnostics to clients."""
    env = Environment(data_dir=tmp_path)
    reason = unavailable_reason(config, env)
    assert reason == (
        "Missing setup: AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, "
        "DAILY_API_KEY, AZURE_SPEECH_KEY, AZURE_SPEECH_REGION."
    )
    with TestClient(auth_app(config, env), base_url=ORIGIN) as client:
        assert unavailable_events(caplog) == [("startup", reason)]
        caplog.clear()
        sign_in(client)
        settings = client.get("/api/settings").json()
        assert unavailable_events(caplog) == []
        client.post("/api/session", json={})
        response = client.post("/api/session/call", json={"callId": str(uuid4())})
        assert response.json()["message"] == settings["voiceUnavailableReason"]
        assert reason not in response.text
        assert unavailable_events(caplog) == [("callStart", reason)]


@pytest.mark.parametrize("status", [200, 301, 401, 403, 429, 500])
def test_http_preflight_failure_keeps_only_safe_operator_diagnostics(
    config, tmp_path, monkeypatch, caplog, status
):
    """Verify simulated voice preflight failures expose only safe public and log messages."""
    response = AsyncMock()
    response.status = status
    response.json.return_value = []
    request = AsyncMock()
    request.__aenter__.return_value = response
    http = Mock()
    http.get.return_value = request
    session = AsyncMock()
    session.__aenter__.return_value = http
    monkeypatch.setattr("app.voice.aiohttp.ClientSession", Mock(return_value=session))
    rooms = Mock(side_effect=AssertionError("Room creation must not run"))
    monkeypatch.setattr("app.voice.DailyRooms", rooms)
    reason = (
        "Configured female English voice is unavailable in this Azure Speech resource; "
        "verify voice.tts_voice, voice.tts_locale, and AZURE_SPEECH_REGION."
        if status == 200
        else f"Azure Speech voice check returned HTTP {status}; "
        "check the speech key, resource region, and service availability."
    )
    application = auth_app(config, environment(tmp_path))
    with TestClient(application, base_url=ORIGIN) as client:
        assert unavailable_events(caplog) == []
        sign_in(client)
        baseline = client.post("/api/session", json={}).json()
        result = client.post("/api/session/call", json={"callId": str(uuid4())})
        assert result.status_code == 503
        assert result.json() == {
            "code": "voiceUnavailable",
            "message": "Conversations are temporarily unavailable. Please try again shortly.",
            "snapshot": None,
        }
        call = application.state.calls.call
        state = call.state.model_copy()
        assert state.status == "error" and state.message == reason
        for method in ("GET", "DELETE", "GET"):
            result = client.request(
                method,
                "/api/session/call",
                **({"json": {"callId": str(call.id)}} if method == "DELETE" else {}),
            )
            assert result.status_code == 200
            assert result.json() == {
                "callId": str(call.id),
                "conversationSlug": state.conversation_slug,
                "status": "error",
                "cleanupConfirmed": True,
                "message": "Conversations are temporarily unavailable. Please try again shortly.",
            }
            assert call.state == state
        assert unavailable_events(caplog) == [("callStart", reason)]
        current = client.get("/api/session").json()
        assert current["sessionId"] != baseline["sessionId"]
        assert current == {
            **baseline,
            "sessionId": current["sessionId"],
            "conversationSlug": state.conversation_slug,
            "revision": baseline["revision"] + 1,
            "sequence": baseline["sequence"] + 1,
        }
        assert all(
            record.exc_info is None and record.stack_info is None for record in caplog.records
        )
        assert "test-only" not in caplog.text and "https://" not in caplog.text
        if status == 200:
            response.json.assert_awaited_once()
        else:
            response.json.assert_not_awaited()
        rooms.assert_not_called()


@pytest.mark.parametrize("status", ["idle", "connecting", "active", "ending", "ended", "error"])
async def test_call_state_is_a_public_copy(store, config, tmp_path, status):
    """Verify public call state is sanitized, independently mutable, and owner-scoped."""
    manager = CallManager(store, config, environment(tmp_path))
    state = CallState(call_id=uuid4(), status=status, message="Internal diagnostic")
    manager.call = Call("owner", state.call_id, state, asyncio.get_running_loop().create_future())
    public = manager.state("owner")
    assert public is not state
    assert public.call_id == state.call_id and public.status == status
    assert public.message == (
        "Conversations are temporarily unavailable. Please try again shortly."
        if status == "error"
        else state.message
    )
    public.message = "Consumer mutation"
    assert manager.call.state is state and state.message == "Internal diagnostic"
    assert manager.state("other") == CallState()
    assert (await manager.end("other", state.call_id)) == CallState(
        call_id=state.call_id, status="ended"
    )
    assert not manager.call.stop.is_set()


@pytest.mark.parametrize(
    "message",
    [
        "Daily room service is unavailable.",
        "Daily returned an invalid room.",
        "Daily returned an invalid token.",
        "Voice is shutting down.",
        "Voice setup failed; continue with manual entry.",
        "Configured female English voice is unavailable in this Azure Speech resource; "
        "verify voice.tts_voice, voice.tts_locale, and AZURE_SPEECH_REGION.",
        "Azure Speech voice check failed; verify the resource region and service connectivity.",
        "https://private.example/?token=secret\nAZURE_OPENAI_API_KEY=secret",
        "Azure Speech voice check returned HTTP 401; "
        "check the speech key, resource region, and service availability. token=secret",
        "Daily returned an invalid token. secret",
        "Missing setup: secret.",
    ],
)
def test_http_voice_error_logs_only_known_reasons(config, tmp_path, monkeypatch, caplog, message):
    """Verify voice errors log only recognized safe reasons and return a generic message."""
    application = auth_app(config, environment(tmp_path))
    error = Problem(503, "voiceUnavailable", message)
    monkeypatch.setattr(application.state.calls, "start", AsyncMock(side_effect=error))
    with TestClient(application, base_url=ORIGIN) as client:
        sign_in(client)
        client.post("/api/session", json={})
        response = client.post("/api/session/call", json={"callId": str(uuid4())})
        assert response.status_code == 503
        assert response.json() == {
            "code": "voiceUnavailable",
            "message": "Conversations are temporarily unavailable. Please try again shortly.",
            "snapshot": None,
        }
        assert error.body.message == message
        assert unavailable_events(caplog) == [
            ("callStart", "Voice setup failed." if "secret" in message else message)
        ]
        assert "secret" not in caplog.text


def test_http_other_problem_body_is_unchanged(config, tmp_path, monkeypatch, caplog):
    """Verify non-voice problem responses retain their body without voice diagnostics."""
    application = auth_app(config, environment(tmp_path))
    error = Problem(409, "callBusy", "A voice call is already running.")
    monkeypatch.setattr(application.state.calls, "start", AsyncMock(side_effect=error))
    with TestClient(application, base_url=ORIGIN) as client:
        sign_in(client)
        client.post("/api/session", json={})
        response = client.post("/api/session/call", json={"callId": str(uuid4())})
        assert response.status_code == error.status
        assert response.json() == error.body.model_dump(mode="json", by_alias=True)
        assert unavailable_events(caplog) == []


class RoomsDouble:
    """Room service fake with token failure injection and cleanup tracking."""

    instances = []
    fail_token = 0

    def __init__(self, *args):
        """Initialize room operation records and register this fake instance."""
        self.tokens = []
        self.deleted = []
        self.closed = False
        self.instances.append(self)

    async def create(self, name, expires):
        """Remember the room name and return a synthetic Daily URL."""
        self.name = name
        return "https://test.daily.co/" + name

    async def token(self, name, expires, user):
        """Record a token request and return a dummy token or the configured failure."""
        self.tokens.append((name, expires, user))
        if len(self.tokens) == self.fail_token:
            raise RuntimeError("private-provider-details")
        return "test-token-" + str(len(self.tokens))

    async def delete(self, name):
        """Record the requested room deletion without contacting a service."""
        self.deleted.append(name)

    async def close(self):
        """Mark the room service fake as closed."""
        self.closed = True


class PipelineDouble:
    """Voice pipeline fake with controllable readiness and lifecycle tracking."""

    instances = []
    fail_start = False

    def __init__(self):
        """Initialize pipeline signals, sequence tracking, and fake tool state."""
        self.ready_event = asyncio.Event()
        self.sequence = -1
        self.closed = False
        self.tools = SimpleNamespace(written_sequence=-1)
        self.interrupted = asyncio.Event()
        self.instances.append(self)

    async def start(self, *args):
        """Load the owner's snapshot unless a simulated startup failure is enabled."""
        if self.fail_start:
            raise RuntimeError("private-pipeline-details")
        self.refresh(await args[0].get(args[1]))

    async def ready(self):
        """Wait for the test to signal pipeline readiness."""
        await self.ready_event.wait()

    def refresh(self, value):
        """Retain the supplied snapshot and its sequence."""
        self.snapshot = value
        self.sequence = value.sequence

    async def interrupt(self):
        """Signal that an interruption was requested."""
        self.interrupted.set()

    def invalidate(self):
        """Clear the fake pipeline's snapshot and tools."""
        self.snapshot = None
        self.tools = None

    async def close(self):
        """Mark the pipeline fake as closed."""
        self.closed = True


@pytest.fixture
def provider_doubles(monkeypatch):
    """Replace room, pipeline, and voice preflight boundaries with local doubles."""
    RoomsDouble.instances = []
    PipelineDouble.instances = []
    monkeypatch.setattr("app.voice.DailyRooms", RoomsDouble)
    monkeypatch.setattr("app.voice.VoicePipeline", PipelineDouble)
    monkeypatch.setattr("app.voice.check_voice", AsyncMock())


async def test_lifecycle_ownership_correction_deletion(store, config, tmp_path, provider_doubles):
    """Verify call ownership, external correction interruption, and deletion cleanup."""
    store.clock = lambda: datetime.now(UTC)
    await store.create("owner")
    await store.create("other")
    manager = CallManager(store, config, environment(tmp_path))
    join = await manager.start("owner", uuid4())
    assert set(join.model_dump(by_alias=True)) == {
        "callId",
        "conversationSlug",
        "url",
        "token",
        "expiresAt",
    }
    assert manager.state("owner").status == "connecting"
    assert manager.state("other").status == "idle"
    assert (await manager.end("other", uuid4())).status == "ended"
    with pytest.raises(Exception, match="already running"):
        await manager.start("other", uuid4())
    pipeline = PipelineDouble.instances[-1]
    rooms = RoomsDouble.instances[-1]
    assert rooms.tokens[0][2] != rooms.tokens[1][2]
    assert join.token == "test-token-1"
    pipeline.ready_event.set()
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    await tools.update_facts(
        {"expectedRevision": (await store.get("owner")).revision, "opening": money("100")},
        "external",
    )
    await asyncio.wait_for(pipeline.interrupted.wait(), 2)
    assert manager.state("owner").status == "active"
    await store.delete("owner")
    await asyncio.wait_for(manager.call.task, 2)
    assert manager.state("owner").status == "ended"
    assert rooms.deleted == [rooms.name] and rooms.closed and pipeline.closed
    assert not store.listeners
    await manager.close()


@pytest.mark.parametrize("failure", ["token", "pipeline"])
async def test_partial_setup_failure_releases_room(
    store,
    config,
    tmp_path,
    provider_doubles,
    monkeypatch,
    failure,
):
    """Verify token or pipeline setup failure releases all allocated call resources."""
    store.clock = lambda: datetime.now(UTC)
    await store.create("owner")
    if failure == "token":
        monkeypatch.setattr(RoomsDouble, "fail_token", 2)
    else:
        monkeypatch.setattr(PipelineDouble, "fail_start", True)
    manager = CallManager(store, config, environment(tmp_path))
    with pytest.raises(Exception, match="Voice setup failed"):
        await manager.start("owner", uuid4())
    rooms = RoomsDouble.instances[-1]
    assert rooms.closed and rooms.deleted == [rooms.name]
    assert PipelineDouble.instances[-1].closed
    assert manager.state("owner").status == "error"
    assert "private" not in manager.state("owner").model_dump_json()
    assert not store.listeners
    await manager.close()


def test_http_enabled_ownership_shutdown(config, tmp_path, provider_doubles):
    """Verify enabled call routes enforce ownership and close resources on session deletion."""
    env = environment(tmp_path)
    assert unavailable_reason(config, env) is None
    assert "test-only" not in repr(env)
    application = auth_app(config, env)
    with TestClient(application, base_url=ORIGIN) as client:
        sign_in(client)
        settings = client.get("/api/settings").json()
        assert settings["voiceAvailable"] and settings["voiceUnavailableReason"] is None
        client.post("/api/session", json={})
        assert client.post("/api/session/call", json={"callId": str(uuid4())}).status_code == 200
        cookie = client.cookies.get(COOKIE)
        client.cookies.clear()
        sign_in(client, "google-user-two")
        client.post("/api/session", json={})
        assert client.get("/api/session/call").json()["status"] == "idle"
        assert (
            client.request("DELETE", "/api/session/call", json={"callId": str(uuid4())}).json()[
                "status"
            ]
            == "ended"
        )
        client.cookies.clear()
        client.cookies.set(COOKIE, cookie)
        assert client.delete("/api/session").status_code == 200
    assert RoomsDouble.instances[-1].closed and PipelineDouble.instances[-1].closed


async def test_daily_private_scoped_tokens_without_network(config, tmp_path, monkeypatch):
    """Verify mocked Daily requests use private rooms and scoped audio-only tokens."""
    rooms = DailyRooms(environment(tmp_path), 2)
    request = AsyncMock(
        side_effect=[
            {"name": "room", "url": "https://test.daily.co/room", "privacy": "private"},
            {"token": "browser"},
        ]
    )
    monkeypatch.setattr(rooms, "request", request)
    try:
        assert await rooms.create("room", 123) == "https://test.daily.co/room"
        assert await rooms.token("room", 123, uuid4()) == "browser"
        body = request.call_args_list[0].args[2]
        assert body["privacy"] == "private"
        assert body["properties"]["eject_at_room_exp"]
        assert body["properties"]["start_video_off"] is True
        assert body["properties"]["permissions"] == {"canSend": ["audio"], "canAdmin": False}
        properties = request.call_args_list[1].args[2]["properties"]
        assert properties["room_name"] == "room" and properties["exp"] == 123
        assert properties["is_owner"] is False and properties["eject_at_token_exp"]
        assert properties["permissions"] == {"canSend": ["audio"], "canAdmin": False}
        assert len(properties["user_id"]) <= 36
    finally:
        await rooms.close()


@pytest.mark.parametrize(
    "host", ["test-resource.openai.azure.com", "test-resource.services.ai.azure.com"]
)
async def test_installed_pipecat_construction_and_azure_tool_schema(
    store,
    tmp_path,
    monkeypatch,
    host,
):
    """Verify pipeline construction and Azure request schemas with isolated provider calls."""
    from openai import AsyncAzureOpenAI, AsyncOpenAI
    from pipecat.adapters.services.open_ai_adapter import OpenAILLMAdapter
    from pipecat.pipeline.worker import PipelineWorker
    from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregator
    from pipecat.services.azure.llm import AzureLLMService
    from pipecat.workers.runner import WorkerRunner

    from app.speech import SpeechRecognition, SpeechSynthesis

    await store.create("owner")
    # Only runner execution is isolated: no transport, STT, LLM or TTS provider request.
    monkeypatch.setattr(WorkerRunner, "run", AsyncMock())
    pipeline = VoicePipeline()
    env = Environment.model_validate(
        {**environment(tmp_path).model_dump(), "azure_openai_endpoint": f"https://{host}"}
    )
    try:
        await pipeline.start(
            store,
            "owner",
            uuid4(),
            "https://test.daily.co/test",
            "test-token",
            env,
            lambda: None,
            lambda: None,
        )
        assert isinstance(pipeline.worker, PipelineWorker)
        assert isinstance(pipeline.llm, AzureLLMService)
        assert pipeline.llm._use_v1_api is True
        assert pipeline.llm._settings.model == store.config.voice.model
        assert pipeline.llm._client.timeout == store.config.voice.model_timeout_seconds
        assert pipeline.llm._client.max_retries == 0
        for client in (pipeline.llm._client,):
            assert isinstance(client, AsyncOpenAI)
            assert not isinstance(client, AsyncAzureOpenAI)
            assert str(client.base_url) == f"https://{host}/openai/v1/"
            assert "api-version" not in client.default_query
        assert "Starting cash is not income" in pipeline.llm._settings.system_instruction
        assert pipeline.llm._run_in_parallel is False
        assert pipeline.llm._settings.extra["store"] is False
        assert pipeline.llm._settings.extra["reasoning_effort"] == "none"
        stt = next(item for item in pipeline.processors if isinstance(item, SpeechRecognition))
        tts = next(item for item in pipeline.processors if isinstance(item, SpeechSynthesis))
        assert stt._speech_config.speech_recognition_language == "en-IN"
        assert stt.phrases == store.config.voice.stt_phrases
        assert tts._settings.voice == store.config.voice.tts_voice
        assert tts._settings.language == "en-IN" and tts._settings.force_locale
        user = next(item for item in pipeline.processors if isinstance(item, LLMUserAggregator))
        assert user._params.vad_analyzer.params.model_dump() == {
            "confidence": store.config.voice.vad_confidence,
            "start_secs": store.config.voice.vad_start_seconds,
            "stop_secs": store.config.voice.vad_stop_seconds,
            "min_volume": store.config.voice.vad_min_volume,
        }
        stop = user._params.user_turn_strategies.stop[0]
        assert stop.wait_for_transcript
        assert stop._user_speech_timeout == store.config.voice.speech_timeout_seconds
        expected_tools = {
            "read_state",
            "update_facts",
            "review_plan",
            "respond_to_action",
            "preview_adjustments",
            "accept_preview",
            "reject_preview",
            "discard_preview",
            "clear_accepted",
        }
        assert set(pipeline.llm._functions) == expected_tools
        params = OpenAILLMAdapter().get_llm_invocation_params(
            pipeline.context,
            convert_developer_to_user=False,
        )
        assert {tool["function"]["name"] for tool in params["tools"]} == expected_tools
        assert "$ref" not in json.dumps(params["tools"])
        for model in (Model, FactsPatch, ReviewRequest):
            assert "$ref" not in json.dumps(tool_parameters(model))
        assert not pipeline.client_ready.is_set() and not pipeline.started.is_set()

        requests = []

        def respond(request):
            """Check the Azure wire request and supply an empty completion stream."""
            assert request.url.host == host
            assert request.url.scheme == "https"
            assert not request.url.query
            assert request.headers["authorization"] == "Bearer test-only-azure"
            assert set(request.extensions["timeout"].values()) == {
                store.config.voice.model_timeout_seconds
            }
            body = json.loads(request.content)
            assert body["model"] == store.config.voice.model
            assert body["max_completion_tokens"] == store.config.voice.max_completion_tokens
            assert body["store"] is False
            requests.append(request.url.path)
            if request.url.path == "/openai/v1/chat/completions":
                assert body["reasoning_effort"] == "none"
                assert {tool["function"]["name"] for tool in body["tools"]} == expected_tools
                assert body["stream"] is True
                return httpx.Response(
                    200,
                    headers={"content-type": "text/event-stream"},
                    content="data: [DONE]\n\n",
                )
            raise AssertionError("Deterministic review must not call a provider")

        for client in (pipeline.llm._client,):
            await client._client.aclose()
            client._client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        # Probe the SDK wire schema; live turn guards are exercised with pipeline frames.
        stream = await AzureLLMService.get_chat_completions(pipeline.llm, pipeline.context)
        async with stream:
            assert [chunk async for chunk in stream] == []
        baseline = await store.get("owner")
        result = await pipeline.tools.review_plan({"expectedRevision": 0})
        assert result["activeAssessment"]["nextQuestionId"] == "opening"
        assert await store.get("owner") == baseline
        assert requests == ["/openai/v1/chat/completions"]
    finally:
        if pipeline.task is not None:
            await pipeline.task
        await pipeline.close()


@pytest.mark.parametrize("stage", ["begin", "body"])
async def test_cancelled_voice_write_rolls_back_and_same_id_can_be_retried(
    store, monkeypatch, stage
):
    """Verify cancelled fact writes roll back and permit idempotent retries."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    transaction = store.transaction
    db = store.connection()
    execute = db._execute
    reached = asyncio.Event()
    release = asyncio.Event()

    async def paused_execute(function, *args, **kwargs):
        """Execute the database operation and pause after beginning a transaction."""
        result = await execute(function, *args, **kwargs)
        if args and args[0] == "BEGIN IMMEDIATE":
            reached.set()
            await release.wait()
        return result

    @asynccontextmanager
    async def paused_transaction():
        """Yield the real transaction and pause before it commits."""
        async with transaction():
            yield
            reached.set()
            await release.wait()

    if stage == "begin":
        monkeypatch.setattr(db, "_execute", paused_execute)
    else:
        monkeypatch.setattr(store, "transaction", paused_transaction)
    patch = {
        "expectedRevision": 0,
        "opening": money("100"),
        "records": [
            {
                "kind": "essential",
                "label": "Bill",
                "amount": money("40"),
                "schedule": {"date": "2026-09-15"},
            }
        ],
    }
    task = asyncio.create_task(tools.update_facts(patch, "cancelled"))
    await asyncio.wait_for(reached.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    monkeypatch.setattr(db, "_execute", execute)
    monkeypatch.setattr(store, "transaction", transaction)
    assert (await store.get("owner")).revision == 0
    result = await tools.update_facts(patch, "cancelled")
    assert result["snapshot"]["revision"] == 1
    assert len(result["snapshot"]["facts"]["records"]) == 1
    assert await tools.update_facts(patch, "cancelled") == result
    assert not db.in_transaction


@pytest.mark.parametrize("terminal", ["readiness", "expiry", "shutdown", "provider"])
async def test_call_deadlines_and_runtime_failure(
    store,
    config,
    tmp_path,
    provider_doubles,
    monkeypatch,
    terminal,
):
    """Verify readiness, expiry, shutdown, and simulated provider failure clean up calls."""
    store.clock = lambda: datetime.now(UTC)
    await store.create("owner")
    config = config.model_copy(
        update={
            "voice": config.voice.model_copy(
                update={
                    "startup_seconds": 0.05,
                    "call_seconds": 0.1,
                }
            )
        }
    )
    manager = CallManager(store, config, environment(tmp_path))
    if terminal == "provider":

        async def start(self, *args):
            """Load the snapshot and immediately signal a simulated pipeline failure."""
            self.refresh(await args[0].get(args[1]))
            args[-2]()

        monkeypatch.setattr(PipelineDouble, "start", start)
    if terminal == "provider":
        with pytest.raises(Problem):
            await manager.start("owner", uuid4())
    else:
        await manager.start("owner", uuid4())
    if terminal == "expiry":
        PipelineDouble.instances[-1].ready_event.set()
    if terminal == "shutdown":
        await manager.close()
    await asyncio.wait_for(manager.call.task, 2)
    assert manager.state("owner").status == (
        "error" if terminal in {"readiness", "provider"} else "ended"
    )
    assert PipelineDouble.instances[-1].closed
    rooms = RoomsDouble.instances[-1]
    assert rooms.deleted == [rooms.name] and rooms.closed
    assert not store.listeners


async def test_cancel_during_room_token_setup(
    store,
    config,
    tmp_path,
    provider_doubles,
    monkeypatch,
):
    """Verify ending a call during token setup aborts the join and releases resources."""
    store.clock = lambda: datetime.now(UTC)
    await store.create("owner")
    reached = asyncio.Event()
    release = asyncio.Event()

    async def token(self, *args):
        """Signal token setup entry and wait for explicit release."""
        reached.set()
        await release.wait()

    monkeypatch.setattr(RoomsDouble, "token", token)
    manager = CallManager(store, config, environment(tmp_path))
    call_id = uuid4()
    start = asyncio.create_task(manager.start("owner", call_id))
    await asyncio.wait_for(reached.wait(), 2)
    await asyncio.wait_for(manager.end("owner", call_id), 2)
    with pytest.raises(Exception, match="Voice setup failed"):
        await start
    rooms = RoomsDouble.instances[-1]
    assert rooms.deleted == [rooms.name] and rooms.closed
    assert PipelineDouble.instances[-1].closed


async def test_cancelled_http_start_releases_resources(
    store,
    config,
    tmp_path,
    provider_doubles,
    monkeypatch,
):
    """Verify cancellation of call startup closes the room and pipeline doubles."""
    store.clock = lambda: datetime.now(UTC)
    await store.create("owner")
    reached = asyncio.Event()

    async def token(self, *args):
        """Signal token setup entry and remain blocked until cancellation."""
        reached.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(RoomsDouble, "token", token)
    manager = CallManager(store, config, environment(tmp_path))
    start = asyncio.create_task(manager.start("owner", uuid4()))
    await asyncio.wait_for(reached.wait(), 2)
    start.cancel()
    with suppress(asyncio.CancelledError):
        await start
    await asyncio.wait_for(manager.call.task, 2)
    assert RoomsDouble.instances[-1].closed and PipelineDouble.instances[-1].closed
