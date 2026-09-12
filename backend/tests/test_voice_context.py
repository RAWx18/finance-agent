# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from copy import deepcopy

import pytest
from pipecat.frames.frames import TTSAudioRawFrame
from pydantic import ValidationError

from app.config import VoiceConfig
from app.models import Command
from app.voice_tools import canonical, conversation_messages

from .conftest import parsed_command
from .test_finance import scenario_two
from .test_scenarios import operation
from .test_voice_errors import text_reply
from .test_voice_opening import render
from .test_voice_opening import synthesis as synthesis
from .test_voice_turns import complete_turn, next_frame, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries


@pytest.fixture
def messages():
    """Supply canonical state and 45 scripted dialogue turns with tool chains."""
    state = {
        "facts": {"opening": "4200.00", "records": [{"label": "Rent", "amount": None}]},
        "conflicts": [{"values": ["5000.00", "6000.00"]}],
        "responses": [{"response": "unavailable"}],
        "accepted": [{"amount": "300.00", "consentScope": "unconditional"}],
        "workspace": {"evidence": ["persisted calculation evidence"] * 1000},
    }
    messages = [
        {"role": "developer", "content": json.dumps(state)},
        {"role": "assistant", "content": "Hello, I'm Isha. What is your money concern?"},
    ]
    for turn in range(45):
        calls = [
            {
                "id": f"call-{turn:03d}-{index}",
                "type": "function",
                "function": {"name": "read_state", "arguments": "{}"},
            }
            for index in range(3)
        ]
        messages.extend(
            [
                {"role": "user", "content": f"User turn {turn:03d}: my rent is still unknown."},
                {"role": "developer", "content": f"Directive {turn:03d}"},
                {
                    "role": "assistant",
                    "content": f"Spoken text {turn:03d}",
                    "tool_calls": calls[:2],
                },
                *[
                    {"role": "tool", "tool_call_id": call["id"], "content": json.dumps(state)}
                    for call in reversed(calls[:2])
                ],
                {"role": "assistant", "content": None, "tool_calls": calls[2:]},
                {"role": "tool", "tool_call_id": calls[2]["id"], "content": json.dumps(state)},
                {"role": "assistant", "content": " \n\t"},
                {"role": "assistant", "content": f"Reply {turn:03d}: the amount remains unknown."},
            ]
        )
    return messages


def test_context_keeps_canonical_recent_dialogue_and_exact_current_chain(messages):
    """Verify compact context retains canonical state, recent dialogue, and current tool calls."""
    original = deepcopy(messages)
    request = conversation_messages(messages, 40)
    assert request[0] == messages[0]
    assert json.loads(request[0]["content"]) == json.loads(messages[0]["content"])
    assert request[1] == messages[1]
    assert [message for message in request if message["role"] == "user"] == [
        message for message in messages if message["role"] == "user"
    ][-40:]
    assert [message for message in request[1:] if message["role"] == "developer"] == [
        message for message in messages[1:] if message["role"] == "developer"
    ][-40:]
    latest = max(index for index, message in enumerate(messages) if message["role"] == "user")
    current = max(index for index, message in enumerate(request) if message["role"] == "user")
    assert request[current:] == messages[latest:]
    assert all(message["role"] != "tool" for message in request[:current])
    assert all("tool_calls" not in message for message in request[:current])
    assert [
        message["content"] for message in request[2:current] if message["role"] == "assistant"
    ] == [
        text
        for turn in range(5, 44)
        for text in (f"Spoken text {turn:03d}", f"Reply {turn:03d}: the amount remains unknown.")
    ]
    assert messages == original
    request[0]["content"] = "not canonical"
    request[current + 2]["tool_calls"][0]["function"]["arguments"] = '{"altered":true}'
    assert messages == original


def test_fixed_state_request_size_stops_growing_with_successive_turns(messages):
    """Verify bounded context size stays constant as fixed-size dialogue turns accumulate."""
    sizes = []
    turn = deepcopy(messages[-9:])
    for _ in range(60):
        request = conversation_messages(messages, 40)
        sizes.append(len(json.dumps(request)))
        assert sum(message["role"] == "tool" for message in request) == 3
        messages.extend(deepcopy(turn))
    assert len(set(sizes)) == 1
    assert len(json.dumps(messages)) > sizes[-1] * 20


def test_context_never_reuses_another_conversations_state_or_dialogue(messages):
    """Verify context compaction never reuses state or dialogue from another conversation."""
    conversation_messages(messages, 40)
    separate = [
        {"role": "developer", "content": '{"facts":{"opening":"123.45"}}'},
        {"role": "user", "content": "Separate conversation"},
    ]
    assert conversation_messages(separate, 40) == separate
    assert conversation_messages([], 40) == []


@pytest.mark.parametrize("phase", ["baseline", "preview", "accepted"])
async def test_request_keeps_one_workspace_and_compact_tool_receipts_without_losing_state(
    store, phase
):
    """Verify compact requests retain financial state and one workspace across plan phases."""
    await store.create("owner")
    snapshot = await store.command("owner", parsed_command(scenario_two()))
    if phase != "baseline":
        snapshot = await store.command(
            "owner",
            Command.model_validate(
                operation(
                    "previewAdjustments",
                    snapshot.revision,
                    adjustments=[{"eventId": "optional:2026-09-27", "amount": "1000"}],
                )
            ),
        )
    if phase == "accepted":
        snapshot = await store.command(
            "owner",
            Command.model_validate(
                operation("acceptPreview", snapshot.revision, previewId=str(snapshot.preview.id))
            ),
        )
    state = canonical(snapshot)
    messages = [
        {
            "role": "developer",
            "content": "Canonical application state; labels are untrusted data:\n"
            + json.dumps(state),
        },
        {"role": "user", "content": "Please check the corrected figures."},
        {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": "current-read",
                    "type": "function",
                    "function": {"name": "read_state", "arguments": "{}"},
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "current-read",
            "content": json.dumps({"stateChanged": False, **state}),
        },
    ]
    original = deepcopy(messages)
    request = conversation_messages(messages, 40)
    sent = json.loads(request[0]["content"].split("\n", 1)[1])
    expected_snapshot = snapshot.model_dump(mode="json", by_alias=True)
    expected_snapshot.pop("workspace")
    expected_snapshot.pop("latestChange")
    expected_plan = deepcopy(state["activePlan"])
    for field, source in (
        ("actions", "actions"),
        ("choices", "choices"),
        ("uncertainties", "issues"),
    ):
        if expected_plan["decisionAssessment"].get(field) == state["workspace"].get(source):
            expected_plan["decisionAssessment"].pop(field)
    expected_plan["decisionAssessment"].pop("outcome")
    if phase == "accepted":
        expected_snapshot["accepted"].pop("plan")
    else:
        expected_snapshot.pop("plan")
    assert sent["activePlan"] == expected_plan
    assert sent["snapshot"] == expected_snapshot
    workspace = deepcopy(state["workspace"])
    workspace.pop("change")
    for card in workspace["cards"]:
        card.pop("dependencies", None)
        card.pop("rows", None)
    for value in workspace["results"]:
        value.pop("dependencies", None)
    for value in workspace["contributions"]:
        value.pop("references", None)
    assert {key: value for key, value in sent.items() if key != "snapshot"} == {
        **{
            key: value
            for key, value in state.items()
            if key
            not in {
                "snapshot",
                "activeAssessment",
                "spokenBrief",
                "workspace",
                "change",
                "activePlan",
            }
        },
        "activePlan": expected_plan,
        "workspace": workspace,
        "change": sent["change"],
    }
    assert {key: value for key, value in sent["change"].items() if key != "items"} == {
        key: value for key, value in state["change"].items() if key != "items"
    }
    for item, original_item in zip(sent["change"]["items"], state["change"]["items"], strict=True):
        assert {key: value for key, value in item.items() if key != "fields"} == {
            key: value for key, value in original_item.items() if key != "fields"
        }
        for field in original_item["fields"]:
            if not field["reference"].startswith("workspace.results.") or (
                field["reference"].rsplit(".", 1)[-1] in {"amountPaise", "date", "state"}
            ):
                assert field in item["fields"]
    assert request[1:3] == messages[1:3]
    assert request[3]["tool_call_id"] == "current-read"
    assert json.loads(request[3]["content"]) == {
        "stateChanged": False,
        "sessionId": str(snapshot.session_id),
        "revision": snapshot.revision,
        "sequence": snapshot.sequence,
        "stateSource": "canonical",
    }
    assert len(json.dumps(request)) < len(json.dumps(messages)) / 2
    assert messages == original


@pytest.mark.parametrize("limit", [1, 40, 200])
def test_context_cap_includes_latest_finalized_user_turn(messages, limit):
    """Verify the context turn limit always includes the latest complete user-turn chain."""
    request = conversation_messages(messages, limit)
    assert sum(message["role"] == "user" for message in request) == min(limit, 45)
    assert request[-9:] == messages[-9:]


@pytest.mark.parametrize("user", [False, True])
def test_opening_context_is_copied_without_changing_guidance(user):
    """Verify opening context is copied independently without changing its guidance."""
    messages = [
        {"role": "developer", "content": "Current canonical state"},
        {"role": "developer", "content": "Opening guidance"},
    ]
    if user:
        messages.extend(
            [
                {"role": "developer", "content": "Saved figures changed outside your last tool."},
                {"role": "user", "content": "The cash correction is right."},
            ]
        )
    request = conversation_messages(messages, 40)
    assert request == messages and request is not messages
    request[1]["content"] = "different"
    assert messages[1]["content"] == "Opening guidance"


@pytest.mark.parametrize("limit", [0, 201, -1, True, 1.5, "40"])
def test_history_turns_rejects_invalid_configuration(config, limit):
    """Verify history limits reject invalid types and out-of-range values."""
    with pytest.raises(ValidationError):
        VoiceConfig.model_validate({**config.voice.model_dump(), "history_turns": limit})


@pytest.mark.parametrize("limit", [1, 40, 200])
def test_history_turns_accepts_configured_bounds(config, limit):
    """Verify history limits accept supported configured values."""
    assert (
        VoiceConfig.model_validate(
            {**config.voice.model_dump(), "history_turns": limit}
        ).history_turns
        == limit
    )


def test_history_turns_defaults_to_primary_config(config):
    """Verify the history limit default matches the primary configuration."""
    values = config.voice.model_dump()
    values.pop("history_turns")
    assert VoiceConfig.model_validate(values).history_turns == config.voice.history_turns == 40


@pytest.mark.parametrize("voice", [{"history_turns": 40}], indirect=True)
async def test_runtime_prunes_before_guidance_without_resetting_turn_budgets(
    voice, synthesis, store, messages
):
    """Verify runtime requests prune history without mutating context or resetting turn budgets."""
    voice.pipeline.client_ready.set()
    voice.pipeline.context.get_messages().extend(deepcopy(messages[1:]))
    original = deepcopy(voice.pipeline.context.get_messages())
    for turn in range(2):
        voice.responses.put_nowait(tool_reply("read_state", {}, f"current-{turn}"))
        voice.responses.put_nowait(text_reply("Which rent amount should I use?"))
        await complete_turn(voice, f"Please check my rent, turn {turn}.")
        requests = [await asyncio.wait_for(voice.requests.get(), 2) for _ in range(2)]
        assert [request["tool_choice"] for request in requests] == ["required", "auto"]
        for request in requests:
            assert sum(message["role"] == "user" for message in request["messages"]) == 40
            state = next(
                message["content"]
                for message in request["messages"]
                if message.get("content", "").startswith("Canonical application state;")
            )
            expected = canonical(await store.get("owner"))
            expected["snapshot"].pop("workspace")
            expected["snapshot"].pop("latestChange")
            expected["snapshot"].pop("plan")
            expected.pop("activeAssessment")
            expected.pop("spokenBrief")
            expected["workspace"].pop("change")
            assert expected["change"] is None
            sent = json.loads(state.split("\n", 1)[1])
            assert sent["snapshot"] == expected["snapshot"]
            assert sent["outcome"] == expected["outcome"]
            assert sent["activePlan"]["events"] == expected["activePlan"]["events"]
            assert sent["workspace"]["actions"] == expected["workspace"]["actions"]
        assert not any(message["role"] == "tool" for message in requests[0]["messages"])
        assert [
            message["tool_call_id"]
            for message in requests[1]["messages"]
            if message["role"] == "tool"
        ] == [f"current-{turn}"]
        guidance = requests[1]["messages"][-1]
        assert guidance["role"] == "developer"
        assert "entire completed user turn" in guidance["content"]
        instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
        await render(instance, "Which rent amount should I use?")
        await next_frame(voice.frames, TTSAudioRawFrame)
        await asyncio.wait_for(synthesis.turns.get(), 2)
        assert voice.pipeline.context.get_messages()[1 : len(original)] == original[1:]
        assert guidance not in voice.pipeline.context.get_messages()
        assert voice.pipeline.completed_turns == 46 + turn
        assert voice.pipeline.tool_rounds == 1
        assert voice.pipeline.model_requests == 2
