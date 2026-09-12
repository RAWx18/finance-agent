# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import hashlib
import json
import socket
from unittest.mock import AsyncMock, Mock

import pytest
from loguru import logger
from openai.types.chat import ChatCompletionChunk
from openai.types.completion_usage import CompletionUsage

from scripts import verify_dialogue


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    """Block network and real model access while supplying synthetic Azure credentials."""
    blocked = Mock(side_effect=AssertionError("Network access is forbidden in offline tests"))
    for name in ("create_connection", "getaddrinfo"):
        monkeypatch.setattr(socket, name, blocked)
    for name in ("connect", "connect_ex"):
        monkeypatch.setattr(socket.socket, name, blocked)
    constructor = Mock(
        side_effect=AssertionError("A real model service must not be constructed"),
        Settings=verify_dialogue.AzureLLMService.Settings,
    )
    monkeypatch.setattr(verify_dialogue, "AzureLLMService", constructor)
    monkeypatch.setattr(
        verify_dialogue,
        "dotenv_values",
        Mock(
            return_value={
                "AZURE_OPENAI_API_KEY": "synthetic-key",
                "AZURE_OPENAI_ENDPOINT": "https://synthetic.openai.azure.com/openai/v1/",
            }
        ),
    )
    monkeypatch.setattr(logger, "disable", Mock())
    return constructor


@pytest.fixture
def model(monkeypatch, offline, config):
    """Provide a mocked chat service using the test configuration."""
    service = Mock(get_chat_completions=AsyncMock(), _client=Mock(close=AsyncMock()))
    offline.side_effect = None
    offline.return_value = service
    monkeypatch.setattr(verify_dialogue, "load_config", Mock(return_value=config))
    return service


@pytest.fixture
def stores(monkeypatch):
    """Track constructed stores and wrap their cleanup calls for assertions."""
    stores = []
    constructor = verify_dialogue.Store

    def create(*args, **kwargs):
        """Construct and track a store with an observable asynchronous close method."""
        store = constructor(*args, **kwargs)
        store.close = AsyncMock(wraps=store.close)
        stores.append(store)
        return store

    monkeypatch.setattr(verify_dialogue, "Store", create)
    return stores


def stream(text="", *, name=None, arguments=None, usage=True):
    """Build a mocked async stream with text, fragmented tool calls, and optional usage."""
    if name:
        arguments = json.dumps(arguments or {})
        midpoint = len(arguments) // 2
        deltas = [
            {
                "content": text,
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "call_",
                        "type": "function",
                        "function": {"name": name[:3], "arguments": arguments[:midpoint]},
                    }
                ],
            },
            {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "synthetic",
                        "function": {"name": name[3:], "arguments": arguments[midpoint:]},
                    }
                ]
            },
        ]
    else:
        deltas = [{"content": text}]
    chunks = [
        ChatCompletionChunk(
            id="synthetic",
            created=0,
            model="synthetic",
            object="chat.completion.chunk",
            choices=[
                {
                    "index": 0,
                    "delta": delta,
                    "finish_reason": ("tool_calls" if name else "stop")
                    if index == len(deltas) - 1
                    else None,
                }
            ],
        )
        for index, delta in enumerate(deltas)
    ]
    if usage:
        chunks.append(
            chunks[-1].model_copy(
                update={
                    "choices": [],
                    "usage": CompletionUsage(
                        prompt_tokens=100, completion_tokens=10, total_tokens=110
                    ),
                }
            )
        )
    result = AsyncMock()
    result.__aenter__.return_value = result
    result.__aiter__.return_value = chunks
    return result


@pytest.mark.parametrize(
    "arguments, code",
    [
        ([], 2),
        (["--help"], 0),
        (["--allow-billable", "--case", "missing"], 2),
    ],
)
def test_cli_rejection_never_invokes_verification(monkeypatch, tmp_path, offline, arguments, code):
    """Verify rejected or help-only CLI requests avoid verification, credentials, and output."""
    verify = Mock(side_effect=AssertionError("Verification must not run"))
    monkeypatch.setattr(verify_dialogue, "verify", verify)
    monkeypatch.setattr(
        "sys.argv", ["verify_dialogue", "--output", str(tmp_path / "evidence.json"), *arguments]
    )
    with pytest.raises(SystemExit) as error:
        verify_dialogue.main()
    assert error.value.code == code
    verify.assert_not_called()
    offline.assert_not_called()
    verify_dialogue.dotenv_values.assert_not_called()
    assert not (tmp_path / "evidence.json").exists()


@pytest.mark.parametrize(
    "selected", [[], *[[case] for case in verify_dialogue.CASES], ["understanding", "timing"]]
)
def test_cli_passes_valid_cases_and_output(monkeypatch, tmp_path, offline, selected):
    """Verify valid CLI arguments forward the selected cases and output path to verification."""
    verify = AsyncMock()
    output = tmp_path / "evidence.json"
    monkeypatch.setattr(verify_dialogue, "verify", verify)
    monkeypatch.setattr(
        "sys.argv",
        [
            "verify_dialogue",
            "--allow-billable",
            "--output",
            str(output),
            *[argument for case in selected for argument in ("--case", case)],
        ],
    )
    verify_dialogue.main()
    verify.assert_awaited_once_with(output, selected or list(verify_dialogue.CASES))
    offline.assert_not_called()
    verify_dialogue.dotenv_values.assert_not_called()


async def test_missing_credentials_prevent_service_and_store_creation(
    monkeypatch, tmp_path, offline, stores
):
    """Verify missing Azure credentials prevent both model service and store creation."""
    monkeypatch.setattr(verify_dialogue, "dotenv_values", Mock(return_value={}))
    with pytest.raises(RuntimeError, match="Azure configuration missing"):
        await verify_dialogue.verify(tmp_path / "evidence.json", ["enough"])
    offline.assert_not_called()
    assert stores == []


async def test_cases_use_explicit_financial_input_and_isolated_state(
    tmp_path, model, stores, offline, config, capsys
):
    """Verify isolated financial state, reported usage and resource cleanup."""
    changes = {
        "enough": {"expectedRevision": 0, "opening": {"amount": "6000", "status": "exact"}},
        "unknown": {"expectedRevision": 0, "opening": {"amount": "10000", "status": "exact"}},
    }
    responses = []
    for case in changes:
        for index in range(len(verify_dialogue.CASES[case])):
            responses.extend(
                [
                    stream(
                        "Not spoken with a tool.",
                        name="read_state" if index else "update_facts",
                        arguments={} if index else changes[case],
                    ),
                    stream("Synthetic assistant reply."),
                ]
            )
    model.get_chat_completions.side_effect = responses
    output = tmp_path / "nested" / "evidence.json"
    await verify_dialogue.verify(output, list(changes))

    evidence = json.loads(output.read_text())
    assert evidence["status"] == "completed"
    assert evidence["requests"] == 10
    assert evidence["usage"] == {
        "reportedRequests": 10,
        "promptTokens": 1000,
        "completionTokens": 100,
        "totalTokens": 1100,
    }
    assert (
        evidence["promptSha256"]
        == hashlib.sha256(verify_dialogue.conversation(config).encode()).hexdigest()
    )
    assert evidence["anchor"] == "2026-09-12"
    assert evidence["model"] == config.voice.model
    rows = evidence["turns"]
    assert [(row["case"], row["turn"], row["user"]) for row in rows] == [
        (case, index + 1, text)
        for case in changes
        for index, text in enumerate(verify_dialogue.CASES[case])
    ]
    for row in rows:
        assert row["status"] == "completed"
        assert row["assistant"] == "Synthetic assistant reply."
        snapshot = row["canonical"]["snapshot"]
        assert snapshot["revision"] == 1
        assert snapshot["facts"]["opening"]["amountPaise"] == (
            600000 if row["case"] == "enough" else 1000000
        )
        assert snapshot["facts"]["records"] == []
        if row["turn"] == 1:
            assert row["tools"] == [
                {
                    "name": "update_facts",
                    "arguments": changes[row["case"]],
                    "code": None,
                }
            ]
    assert (
        rows[0]["canonical"]["snapshot"]["sessionId"]
        != rows[2]["canonical"]["snapshot"]["sessionId"]
    )
    requests = model.get_chat_completions.await_args_list
    for index, row in enumerate(rows):
        request = requests[index * 2].args[0]
        assert request.tool_choice == "required"
        assert request.get_messages()[-1] == {"role": "user", "content": row["user"]}
        following = requests[index * 2 + 1].args[0]
        assert following.tool_choice == "auto"
        assert following.get_messages()[-1] == {
            "role": "developer",
            "content": verify_dialogue.AFTER_TOOLS,
        }
        if row["turn"] == 1:
            assert len(request.get_messages()) == 2
            state = json.loads(request.get_messages()[0]["content"].split("\n", 1)[1])
            assert state["snapshot"]["revision"] == 0
            assert state["snapshot"]["facts"]["opening"]["amountPaise"] is None
    assert len(stores) == 1
    stores[0].close.assert_awaited_once()
    assert stores[0].db is None
    assert not stores[0].path.parent.exists()
    model._client.close.assert_awaited_once()
    assert model._client.max_retries == 0
    assert model._client.timeout == config.voice.model_timeout_seconds
    assert offline.call_args.kwargs["retry_on_timeout"] is False
    settings = offline.call_args.kwargs["settings"]
    assert settings.system_instruction == verify_dialogue.conversation(config)
    assert settings.extra["store"] is False
    assert settings.extra["parallel_tool_calls"] is False
    assert settings.max_completion_tokens == config.voice.max_completion_tokens
    for response in responses:
        response.__aexit__.assert_awaited_once()
    assert len(capsys.readouterr().out.splitlines()) == len(rows)
    assert "synthetic-key" not in output.read_text()


async def test_timing_replays_only_the_heard_prefix(tmp_path, model):
    """Verify interrupted dialogue replays only the heard prefix and counts reported usage."""
    reply = "One two three four five six seven eight nine ten eleven twelve."
    model.get_chat_completions.side_effect = [
        response
        for _ in verify_dialogue.CASES["timing"]
        for response in (stream(name="read_state"), stream(reply, usage=False))
    ]
    output = tmp_path / "evidence.json"
    await verify_dialogue.verify(output, ["timing"])
    evidence = json.loads(output.read_text())
    rows = evidence["turns"]
    assert rows[1]["assistant"] == reply
    assert rows[2]["heardPrefix"] == " ".join(reply.split()[:10])
    request = model.get_chat_completions.await_args_list[4].args[0]
    assert request.get_messages()[-2] == {"role": "assistant", "content": rows[2]["heardPrefix"]}
    assert request.get_messages()[-1]["content"] == verify_dialogue.CASES["timing"][2]
    assert evidence["requests"] == 8
    assert evidence["usage"]["reportedRequests"] == 4


async def test_request_cap_stops_before_request_41_and_retains_partial_evidence(
    tmp_path, model, stores
):
    """Verify the forty-request limit preserves partial evidence and closes resources."""

    def respond(request):
        """Return tool calls twice before each synthetic spoken reply."""
        if model.get_chat_completions.await_count % 3:
            return stream(name="read_state")
        return stream(
            "Synthetic response with enough words for the interrupted timing turn replay."
        )

    model.get_chat_completions.side_effect = respond
    output = tmp_path / "evidence.json"
    with pytest.raises(RuntimeError, match="Forty-request evaluation budget exhausted"):
        await verify_dialogue.verify(output, list(verify_dialogue.CASES))
    evidence = json.loads(output.read_text())
    assert model.get_chat_completions.await_count == evidence["requests"] == 40
    assert evidence["status"] == "incomplete"
    assert evidence["usage"]["reportedRequests"] == 40
    assert sum(row["status"] == "completed" for row in evidence["turns"]) == 13
    assert evidence["turns"][-1]["status"] == "incomplete"
    assert evidence["turns"][-1]["assistant"] == ""
    stores[0].close.assert_awaited_once()
    assert not stores[0].path.parent.exists()
    model._client.close.assert_awaited_once()


@pytest.mark.parametrize("failure", ["empty", "provider", "cancelled", "toolBudget"])
async def test_failures_close_resources_and_write_evidence(
    tmp_path, model, stores, config, failure
):
    """Verify failure evidence survives empty replies, errors, cancellation and tool limits."""
    if failure == "empty":
        response = stream(" ")
        model.get_chat_completions.return_value = response
        error, message = RuntimeError, "Empty model response"
    elif failure == "toolBudget":
        model.get_chat_completions.side_effect = lambda request: stream(name="read_state")
        error, message = RuntimeError, "Per-turn tool budget exhausted"
    else:
        error = asyncio.CancelledError if failure == "cancelled" else RuntimeError
        message = "Synthetic failure"
        model.get_chat_completions.side_effect = error(message)
    output = tmp_path / "nested" / "evidence.json"
    with pytest.raises(error, match=message):
        await verify_dialogue.verify(output, ["enough"])
    evidence = json.loads(output.read_text())
    assert evidence["status"] == "incomplete"
    assert evidence["requests"] == (
        config.voice.max_tool_rounds + 1 if failure == "toolBudget" else 1
    )
    assert len(evidence["turns"]) == 1
    assert evidence["turns"][0]["user"] == verify_dialogue.CASES["enough"][0]
    assert evidence["turns"][0]["assistant"] == ""
    assert "canonical" not in evidence["turns"][0]
    stores[0].close.assert_awaited_once()
    assert stores[0].db is None
    assert not stores[0].path.parent.exists()
    model._client.close.assert_awaited_once()
    if failure == "empty":
        response.__aexit__.assert_awaited_once()


async def test_evidence_survives_client_cleanup_failure(tmp_path, model):
    """Verify incomplete dialogue evidence survives a model-client cleanup failure."""
    model.get_chat_completions.side_effect = RuntimeError("Synthetic provider failure")
    model._client.close.side_effect = RuntimeError("Synthetic cleanup failure")
    output = tmp_path / "evidence.json"
    with pytest.raises(RuntimeError, match="Synthetic cleanup failure"):
        await verify_dialogue.verify(output, ["enough"])
    model._client.close.assert_awaited_once()
    evidence = json.loads(output.read_text())
    assert evidence["status"] == "incomplete"
    assert evidence["requests"] == 1
    assert evidence["turns"][0]["user"] == verify_dialogue.CASES["enough"][0]
