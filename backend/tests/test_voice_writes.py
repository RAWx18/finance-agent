# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from copy import deepcopy
from unittest.mock import AsyncMock, Mock
from uuid import uuid4, uuid5

import pytest
from pipecat.frames.frames import FunctionCallResultFrame, TTSTextFrame

from app.voice_tools import VoiceTools

from .conftest import facts, money, parsed_command
from .test_voice_errors import text_reply
from .test_voice_opening import render
from .test_voice_opening import synthesis as synthesis
from .test_voice_turns import complete_turn, next_frame, tool_reply
from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries


@pytest.fixture
async def writes(store):
    """Create isolated financial tools with one explicitly reported bill to save."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    tools.user_turn = "I have 6000 rupees. Rent is 2000 due September 15."
    arguments = {
        "expectedRevision": 0,
        "opening": money("6000"),
        "records": [
            {
                "kind": "essential",
                "label": "Rent",
                "amount": money("2000"),
                "schedule": {"date": "2026-09-15"},
            }
        ],
    }
    return tools, arguments


@pytest.mark.parametrize("committed", [False, True])
async def test_explicit_retry_reuses_the_original_command_after_failure(
    writes, store, monkeypatch, committed
):
    """A failed or lost acknowledgement cannot turn add-again into a duplicate financial item."""
    tools, arguments = writes
    intended = deepcopy(arguments)
    command = store.command
    calls = []
    events = await store.subscribe("owner")
    await events.get()

    async def unreliable(owner, request, **kwargs):
        """Fail once before or after the transactional command, then permit exact retries."""
        calls.append(request.model_dump_json(exclude_unset=True))
        if len(calls) == 1:
            if committed:
                await command(owner, request, **kwargs)
            raise RuntimeError("private storage error")
        return await command(owner, request, **kwargs)

    monkeypatch.setattr(store, "command", unreliable)
    result = await tools.invoke("update_facts", arguments, "original")
    assert result["saved"] is None
    assert result["financialWrite"]["status"] == "unconfirmed"
    assert "private" not in str(result)
    write_id = result["financialWrite"]["writeId"]
    assert tools.write_context()["unresolved"][0]["arguments"] == intended
    assert (await store.get("owner")).revision == int(committed)
    await tools.invoke("read_state", {}, "read")
    assert tools.write_context()["unresolved"][0]["writeId"] == write_id
    tools.user_turn = "Add it again."
    result = await tools.invoke("retry_write", {"writeId": write_id}, "retry")
    assert result["saved"] is True
    assert result["financialWrite"]["status"] == "committed"
    snapshot = await store.get("owner")
    assert snapshot.revision == 1 and len(snapshot.facts.records) == 1
    assert snapshot.facts.records[0].amount.amount_paise == 200000
    assert snapshot.workspace.cards and snapshot.plan.closing_paise == 400000
    assert tools.write_context()["unresolved"] == []
    result = await tools.invoke("retry_write", {"writeId": write_id}, "duplicate-retry")
    assert result["saved"] is True
    assert await store.get("owner") == snapshot
    assert len(set(calls)) == 1
    assert arguments == intended
    published = []
    while not events.empty():
        published.append(events.get_nowait())
    assert [item.revision for item in published] == [1]
    assert published[0].workspace == snapshot.workspace
    store.unsubscribe("owner", events)


async def test_repeated_failure_retains_intent_without_claiming_memory_is_saved(
    writes, store, monkeypatch
):
    """Repeated errors leave a retryable unresolved write and no authoritative fact."""
    tools, arguments = writes
    monkeypatch.setattr(store, "command", AsyncMock(side_effect=RuntimeError("unavailable")))
    result = await tools.invoke("update_facts", arguments, "original")
    write_id = result["financialWrite"]["writeId"]
    for index in range(2):
        tools.user_turn = "Please add it again."
        result = await tools.invoke("retry_write", {"writeId": write_id}, f"retry-{index}")
        assert result["saved"] is None
        assert result["financialWrite"]["status"] == "unconfirmed"
        assert result["code"] == "financialWriteUnconfirmed"
        assert tools.write_context()["unresolved"][0]["arguments"] == arguments
    assert (await store.get("owner")).facts.records == []
    assert store.command.await_count == 3


async def test_commit_is_not_relabelled_failed_when_refresh_fails(writes, store, monkeypatch):
    """Record the receipt before a failed current-state refresh can obscure the commit."""
    tools, arguments = writes
    command, get = store.command, store.get

    async def commit(owner, request, **kwargs):
        """Commit successfully, then make the next current-state read fail."""
        result = await command(owner, request, **kwargs)
        monkeypatch.setattr(store, "get", AsyncMock(side_effect=RuntimeError("refresh failed")))
        return result

    monkeypatch.setattr(store, "command", commit)
    result = await tools.invoke("update_facts", arguments, "original")
    assert result["saved"] is True
    assert result["financialWrite"]["status"] == "committed"
    assert result["refreshPending"] is True
    monkeypatch.setattr(store, "get", get)
    assert (await store.get("owner")).revision == 1


async def test_retry_does_not_revalidate_original_evidence_against_add_again(
    writes, store, monkeypatch
):
    """Replay validated scope evidence without pretending a retry utterance supplied new facts."""
    tools, arguments = writes
    tools.user_turn += " No debts."
    arguments["coverage"] = {"debt": "none"}
    arguments["coverageEvidence"] = {"debt": "No debts."}
    command = store.command
    monkeypatch.setattr(store, "command", AsyncMock(side_effect=RuntimeError("failed")))
    result = await tools.invoke("update_facts", arguments, "original")
    monkeypatch.setattr(store, "command", command)
    tools.user_turn = "Add it again."
    result = await tools.invoke(
        "retry_write", {"writeId": result["financialWrite"]["writeId"]}, "retry"
    )
    assert result["saved"] is True
    assert (await store.get("owner")).facts.coverage.debt == "none"


async def test_retry_never_rebases_over_an_intervening_edit(writes, store, monkeypatch):
    """Keep the original revision so a retry cannot silently overwrite a newer correction."""
    tools, arguments = writes
    command = store.command
    monkeypatch.setattr(store, "command", AsyncMock(side_effect=RuntimeError("failed")))
    result = await tools.invoke("update_facts", arguments, "original")
    monkeypatch.setattr(store, "command", command)
    saved = await store.command("owner", parsed_command(facts("9000")))
    tools.user_turn = "Retry the save."
    result = await tools.invoke(
        "retry_write", {"writeId": result["financialWrite"]["writeId"]}, "retry"
    )
    assert result["code"] == "staleRevision"
    assert result["saved"] is not True
    assert await store.get("owner") == saved


async def test_cancelled_write_is_retained_for_explicit_retry(writes, store, monkeypatch):
    """Cancellation has no receipt and must not erase the exact retry identity."""
    tools, arguments = writes
    entered = asyncio.Event()
    command = store.command

    async def pending(*args, **kwargs):
        """Hold the financial operation until interruption cancels it."""
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(store, "command", pending)
    task = asyncio.create_task(tools.invoke("update_facts", arguments, "original"))
    await asyncio.wait_for(entered.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    write_id = tools.write_context()["unresolved"][0]["writeId"]
    monkeypatch.setattr(store, "command", command)
    tools.user_turn = "Retry that save."
    assert (await tools.invoke("retry_write", {"writeId": write_id}, "retry"))["saved"]
    assert len((await store.get("owner")).facts.records) == 1


@pytest.mark.parametrize("committed", [False, True])
async def test_interrupted_write_repeats_exactly_within_the_same_turn(
    writes, store, monkeypatch, committed
):
    """A write cancelled by barge-in may run again in the same turn without duplicating facts."""
    tools, arguments = writes
    entered = asyncio.Event()
    command = store.command

    async def pending(owner, request, **kwargs):
        """Optionally commit, then hold the operation until interruption cancels it."""
        if committed:
            await command(owner, request, **kwargs)
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(store, "command", pending)
    task = asyncio.create_task(tools.invoke("update_facts", arguments, "original"))
    await asyncio.wait_for(entered.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert tools.write_context()["unresolved"][0]["status"] == "unconfirmed"
    monkeypatch.setattr(store, "command", command)
    result = await tools.invoke("update_facts", arguments, "same-turn-model-id")
    assert result["saved"] is True and result["financialWrite"]["status"] == "committed"
    snapshot = await store.get("owner")
    assert snapshot.revision == 1 and len(snapshot.facts.records) == 1
    assert tools.write_context()["unresolved"] == []


@pytest.mark.parametrize(
    "turn,amount,flagged",
    [
        ("My cash is ₹6,500 and rent is 2000 due 16 September.", "6500", False),
        ("My available cash is ₹6500.", "60500", True),
        ("I have 6 lakh rupees.", "600000", False),
        ("I have six lakh rupees.", "600000", False),
    ],
    ids=["digitsMatch", "digitsDiffer", "lakhMultiplier", "noDigitsHeard"],
)
async def test_amounts_absent_from_heard_digits_are_saved_but_flagged(
    writes, store, turn, amount, flagged
):
    """A doubtful amount commits with an explicit read-back request, never as a silent fact."""
    tools, _ = writes
    tools.user_turn = turn
    result = await tools.invoke(
        "update_facts", {"expectedRevision": 0, "opening": money(amount)}, "heard"
    )
    assert result["saved"] is True
    assert (await store.get("owner")).facts.opening.amount_paise == int(amount) * 100
    if flagged:
        assert result["unverifiedAmounts"] == [amount]
        assert amount in result["amountCheck"] and "confirm" in result["amountCheck"]
    else:
        assert "unverifiedAmounts" not in result and "amountCheck" not in result


async def test_rebuilt_model_call_after_lost_acknowledgement_reuses_original_identity(
    writes, store, monkeypatch
):
    """A new model tool-call ID and current revision cannot duplicate an unconfirmed creation."""
    tools, arguments = writes
    command = store.command
    requests = []

    async def lose_ack(owner, request, **kwargs):
        """Commit once but lose its first acknowledgement."""
        requests.append(request.model_dump_json(exclude_unset=True))
        result = await command(owner, request, **kwargs)
        if len(requests) == 1:
            raise RuntimeError("lost acknowledgement")
        return result

    monkeypatch.setattr(store, "command", lose_ack)
    await tools.invoke("update_facts", arguments, "original")
    tools.user_turn = "Add it again."
    result = await tools.invoke("update_facts", {**arguments, "expectedRevision": 1}, "fresh-id")
    assert result["saved"] is True
    assert requests[0] == requests[1]
    assert (await store.get("owner")).revision == 1
    assert len((await store.get("owner")).facts.records) == 1


async def test_retry_cannot_apply_an_old_intent_to_a_replacement_session(
    writes, store, monkeypatch
):
    """Bind even uncommitted commands to the original financial workspace under the store lock."""
    tools, arguments = writes
    command = store.command
    monkeypatch.setattr(store, "command", AsyncMock(side_effect=RuntimeError("failed")))
    result = await tools.invoke("update_facts", arguments, "original")
    monkeypatch.setattr(store, "command", command)
    await store.delete("owner")
    replacement = await store.create("owner")
    tools.user_turn = "Retry that save."
    result = await tools.invoke(
        "retry_write", {"writeId": result["financialWrite"]["writeId"]}, "retry"
    )
    assert result["code"] == "conversationChanged" and result["saved"] is False
    assert await store.get("owner") == replacement


async def test_rejected_shape_retains_source_for_repair_without_claiming_saved(writes, store):
    """Repair a rejected request by reference without inferring or replacing its user facts."""
    tools, arguments = writes
    malformed = {**arguments, "opening": {"amount": money("6000"), "status": "exact"}}
    result = await tools.invoke("update_facts", malformed, "malformed")
    assert result["saved"] is False
    assert result["financialWrite"]["status"] == "rejected"
    write_id = result["financialWrite"]["writeId"]
    assert tools.write_context()["unresolved"][0]["arguments"] == malformed
    tools.user_turn = "Please add it again."
    failed = await tools.invoke("retry_write", {"writeId": write_id}, "retry")
    assert failed["saved"] is False and (await store.get("owner")).revision == 0
    result = await tools.invoke("update_facts", {**arguments, "retryWriteId": write_id}, "repaired")
    assert result["saved"] is True
    assert result["financialWrite"]["writeId"] == write_id
    assert tools.write_context()["unresolved"] == []
    assert len((await store.get("owner")).facts.records) == 1


async def test_unknown_retry_identity_never_reconstructs_a_write(writes, store, monkeypatch):
    """An unretained write ID cannot borrow another intent or invoke the store."""
    tools, _ = writes
    operation = AsyncMock()
    monkeypatch.setattr(store, "command", operation)
    result = await tools.invoke("retry_write", {"writeId": str(uuid4())}, "retry")
    assert result["saved"] is False and result["code"] == "writeNotFound"
    operation.assert_not_awaited()


async def test_conversational_memory_success_cannot_confirm_a_failed_financial_write(
    writes, store, monkeypatch
):
    """A successful nonfinancial memory receipt must not resolve financial write status."""
    tools, arguments = writes
    monkeypatch.setattr(store, "command", AsyncMock(side_effect=RuntimeError("failed")))
    failed = await tools.invoke("update_facts", arguments, "original")
    tools.memory = Mock(update=AsyncMock(return_value={"saved": True}))
    tools.user_turn = "Keep it brief."
    memory = await tools.invoke(
        "update_memory",
        {
            "scope": "chat",
            "key": "replyStyle",
            "text": "Keep it brief.",
            "evidence": "Keep it brief.",
        },
        "preference",
    )
    assert memory["saved"] is True and "financialWrite" not in memory
    assert tools.write_context()["unresolved"][0]["writeId"] == failed["financialWrite"]["writeId"]
    assert tools.write_context()["unresolved"][0]["status"] == "unconfirmed"
    assert (await store.get("owner")).facts.records == []


async def test_unconfirmed_write_cannot_automatically_loop_with_new_tool_ids(
    writes, store, monkeypatch
):
    """A repeated model request is not a new user authorization to retry a failed write."""
    tools, arguments = writes
    operation = AsyncMock(side_effect=RuntimeError("failed"))
    monkeypatch.setattr(store, "command", operation)
    result = await tools.invoke("update_facts", arguments, "original")
    retry = await tools.invoke(
        "retry_write", {"writeId": result["financialWrite"]["writeId"]}, "loop"
    )
    assert retry["code"] == "writeAwaitingRetry"
    assert retry["saved"] is None
    repeat = await tools.invoke("update_facts", arguments, "another-model-id")
    assert repeat["code"] == "writeAwaitingRetry"
    operation.assert_awaited_once()


async def test_tool_deadline_returns_unconfirmed_intent_for_explicit_retry(
    writes, store, monkeypatch
):
    """A write deadline reports its retained identity rather than an unstructured cancellation."""
    tools, arguments = writes
    store.config = store.config.model_copy(
        update={"voice": store.config.voice.model_copy(update={"tool_timeout_seconds": 0.02})}
    )

    async def pending(*args, **kwargs):
        """Suspend storage until the application deadline cancels the operation."""
        await asyncio.Event().wait()

    monkeypatch.setattr(store, "command", pending)
    result = await asyncio.wait_for(tools.invoke("update_facts", arguments, "timed-out"), 1)
    assert result["code"] == "financialWriteUnconfirmed" and result["saved"] is None
    assert tools.write_context()["unresolved"][0]["arguments"] == arguments


@pytest.mark.parametrize("fails_again", [False, True])
async def test_actual_pipeline_retries_after_add_again_with_original_write_context(
    voice, synthesis, store, monkeypatch, fails_again
):
    """Preserve failed intent through Pipecat turns without terminating media on save failure."""
    command = store.command
    attempts = []

    async def unreliable(owner, request, **kwargs):
        """Inject only storage acknowledgement failures, keeping actual financial transactions."""
        attempts.append(request.model_dump_json(exclude_unset=True))
        if len(attempts) <= (2 if fails_again else 1):
            raise RuntimeError("private failure")
        return await command(owner, request, **kwargs)

    monkeypatch.setattr(store, "command", unreliable)
    arguments = {
        "expectedRevision": 0,
        "opening": money("6000"),
        "records": [{"kind": "essential", "label": "Rent", "amount": money("2000")}],
    }
    voice.responses.put_nowait(tool_reply("update_facts", arguments, "rent-write"))
    voice.responses.put_nowait(text_reply("I could not confirm that financial save."))
    await complete_turn(voice, "I have 6000 rupees and rent costs 2000.")
    receipt = await next_frame(voice.frames, FunctionCallResultFrame)
    assert receipt.result["saved"] is None
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, "I could not confirm that financial save.")
    await next_frame(voice.frames, TTSTextFrame)
    await asyncio.wait_for(synthesis.turns.get(), 2)
    assert not voice.pipeline.revoked
    assert (await store.get("owner")).facts.records == []
    while not voice.requests.empty():
        voice.requests.get_nowait()
    write_id = str(uuid5(voice.pipeline.tools.call_id, "rent-write"))
    voice.responses.put_nowait(tool_reply("retry_write", {"writeId": write_id}, "retry-rent"))
    spoken = "The save is still unconfirmed." if fails_again else "Your rent is saved in the plan."
    voice.responses.put_nowait(text_reply(spoken))
    await complete_turn(voice, "Add it again.")
    request = await asyncio.wait_for(voice.requests.get(), 2)
    context = next(
        message["content"]
        for message in request["messages"]
        if isinstance(message.get("content"), str)
        and message["content"].startswith("Financial write status is separate")
    )
    status = json.loads(context.split("\n", 1)[1])
    assert status["unresolved"][0]["writeId"] == write_id
    assert status["unresolved"][0]["arguments"] == arguments
    assert not any(message.get("role") == "tool" for message in request["messages"])
    receipt = await next_frame(voice.frames, FunctionCallResultFrame)
    assert receipt.function_name == "retry_write"
    assert receipt.result["saved"] is (None if fails_again else True)
    instance, _ = await asyncio.wait_for(synthesis.requests.get(), 2)
    await render(instance, spoken)
    assert (await next_frame(voice.frames, TTSTextFrame)).text.strip() == spoken
    saved = await store.get("owner")
    assert saved.revision == int(not fails_again)
    assert len(saved.facts.records) == int(not fails_again)
    if not fails_again:
        assert saved.workspace.cards and saved.plan.undated_impact.outflow_paise == 200000
    assert len(attempts) == 2 and attempts[0] == attempts[1]
    assert not voice.pipeline.revoked
