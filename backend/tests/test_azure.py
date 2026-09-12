# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from pydantic import SecretStr, ValidationError

from app.config import Environment
from app.store import Problem
from app.voice import CallManager
from app.voice_pipeline import VoicePipeline
from app.voice_tools import VoiceTools

from .test_voice import environment


@pytest.mark.parametrize(
    "host", ["test-resource.openai.azure.com", "test-resource.services.ai.azure.com"]
)
@pytest.mark.parametrize("path", ["", "/", "/openai/v1", "/openai/v1/"])
@pytest.mark.parametrize("port", ["", ":443"])
def test_azure_endpoint_normalizes_only_supported_v1_urls(host, path, port):
    env = Environment(azure_openai_endpoint=f"https://{host}{port}{path}")
    assert env.azure_openai_endpoint == f"https://{host}/openai/v1/"


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://api.openai.com/v1",
        "https://example.com",
        "http://test.openai.azure.com",
        "https://openai.azure.com",
        "https://services.ai.azure.com",
        "https://test.openai.azure.com.evil.example",
        "https://evil.example/test.openai.azure.com",
        "https://test.openai.azure.com@evil.example",
        "https://user@test.openai.azure.com",
        "https://user:password@test.openai.azure.com",
        "https://test.openai.azure.com?api-version=2025-04-01-preview",
        "https://test.openai.azure.com?",
        "https://test.openai.azure.com#fragment",
        "https://test.openai.azure.com#",
        "https://test.openai.azure.com:80",
        "https://test.openai.azure.com:444",
        "https://test.openai.azure.com:",
        "https://test.openai.azure.com/v1",
        "https://test.openai.azure.com/openai/deployments/chat",
        "https://test.openai.azure.com/openai/v1//",
        "https://test.openai.azure.com/openai/v1/../v1",
        "https://test.openai.azure.com./openai/v1",
        "https://nested.test.openai.azure.com",
        "https://-test.openai.azure.com",
        "https://test-.openai.azure.com",
        "https://test_resource.openai.azure.com",
        "https://test%2eopenai.azure.com",
        "https://test.openai.azure.com\\@evil.example",
        " https://test.openai.azure.com",
        "https://test.openai.azure.com\n",
        "https://test.openai.azure.com/\topenai/v1",
        " ",
    ],
)
def test_azure_endpoint_rejects_unsafe_or_dated_destinations(endpoint):
    with pytest.raises(ValidationError, match="AZURE_OPENAI_ENDPOINT"):
        Environment(azure_openai_endpoint=endpoint)


@pytest.mark.parametrize("deployment", ["gpt-5.6-terra", "finance-chat_1.2", "A" * 64])
def test_deployment_is_configured_as_a_resource_name(config, deployment):
    voice = type(config.voice).model_validate({**config.voice.model_dump(), "model": deployment})
    assert voice.model == deployment


@pytest.mark.parametrize(
    "deployment", ["", "A" * 65, "chat/name", "chat name", " ", "chat\n", "chat?x", "£"]
)
def test_deployment_rejects_invalid_names(config, deployment):
    with pytest.raises(ValidationError):
        type(config.voice).model_validate({**config.voice.model_dump(), "model": deployment})


def test_azure_environment_loads_explicit_names_and_hides_key(monkeypatch):
    for name in (
        "APP_ENV",
        "PUBLIC_ORIGIN",
        "DATA_DIR",
        "DAILY_API_KEY",
        "AZURE_SPEECH_KEY",
        "AZURE_SPEECH_REGION",
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_DEPLOYMENT",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-direct-key-must-not-be-used")
    assert Environment.load().missing_azure_openai() == [
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_ENDPOINT",
    ]
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "synthetic-azure-key")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://test.services.ai.azure.com")
    monkeypatch.setenv("AZURE_OPENAI_DEPLOYMENT", "finance-chat_1.2")
    env = Environment.load()
    assert env.azure_openai_endpoint == "https://test.services.ai.azure.com/openai/v1/"
    assert "azure_openai_deployment" not in Environment.model_fields
    assert isinstance(env.azure_openai_api_key, SecretStr)
    assert env.azure_openai_api_key.get_secret_value() == "synthetic-azure-key"
    assert "synthetic-azure-key" not in repr(env) + env.model_dump_json()
    assert not env.missing_azure_openai()


@pytest.mark.parametrize("key", [None, "", " \t"])
def test_blank_azure_key_is_missing(key):
    env = Environment.model_validate({"azure_openai_api_key": key})
    assert "AZURE_OPENAI_API_KEY" in env.missing_azure_openai()


@pytest.mark.parametrize("name", ["azure_openai_api_key", "azure_openai_endpoint"])
async def test_missing_azure_setup_blocks_call_and_pipeline_before_provider_construction(
    store,
    config,
    tmp_path,
    monkeypatch,
    name,
):
    await store.create("owner")
    env = Environment.model_validate({**environment(tmp_path).model_dump(), name: ""})
    preflight, rooms = AsyncMock(), Mock()
    monkeypatch.setattr("app.voice.check_voice", preflight)
    monkeypatch.setattr("app.voice.DailyRooms", rooms)
    manager = CallManager(store, config, env)
    pipeline = VoicePipeline()
    try:
        with pytest.raises(Problem, match=f"Missing setup: {name.upper()}."):
            await manager.start("owner")
        with pytest.raises(Problem, match=f"Missing setup: {name.upper()}."):
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
        assert pipeline.llm is None and pipeline.tools is None
        assert pipeline.processors == []
        assert manager.call is None
        preflight.assert_not_awaited()
        rooms.assert_not_called()
    finally:
        await pipeline.close()
        await manager.close()


async def test_financial_review_needs_no_provider_deployment(store):
    snapshot = await store.create("owner")
    refresh = Mock()
    tools = VoiceTools(store, "owner", uuid4(), refresh)
    result = await tools.review_plan({"expectedRevision": snapshot.revision})
    assert result["stateChanged"] is False
    assert result["activeAssessment"]["nextQuestionId"] == "opening"
    assert result["outcome"]["readiness"] == "qualified"
    refresh.assert_called_once_with(snapshot)
