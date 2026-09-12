# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import hashlib
import json
import sqlite3
from datetime import timedelta
from unittest.mock import AsyncMock, Mock
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest

from app.auth_models import Access
from app.config import Environment
from app.exchange import ExchangeRate, ExchangeRates
from app.facts import facts_input
from app.main import create_app
from app.models import Command
from app.store import Problem, Store
from app.voice_tools import VoiceTools

from .conftest import NOW, command, facts, parsed_command, record


def foreign(*, fee=None, rate=None):
    return facts(
        "5000",
        [
            {
                **record("foreign", "essential", "20", "2026-09-15"),
                "amount": {
                    "amount": "20",
                    "status": "exact",
                    "conversion": {
                        "currency": "USD",
                        "rate": rate,
                        "rateStatus": "exact" if rate else "unknown",
                        "fee": fee,
                        "feeStatus": "exact" if fee is not None else "unknown",
                    },
                },
            }
        ],
    )


def operation(snapshot, kind, **values):
    return Command.model_validate(
        {
            "commandId": str(uuid4()),
            "expectedRevision": snapshot.revision,
            "operation": {"type": kind, **values},
        }
    )


@pytest.fixture
async def exchange_store(tmp_path, config, monkeypatch):
    clock = Mock(return_value=NOW)
    config = config.model_copy(update={"retention_hours": 96})
    rates = ExchangeRates(
        tmp_path / "exchange.sqlite3", config.exchange, config.timezone, config.currency, clock
    )
    store = Store(tmp_path / "sessions.sqlite3", config, clock, rates=rates)

    async def fetch(currency):
        assert not store.lock.locked()
        assert not store.connection().in_transaction
        return ExchangeRate(
            base=currency,
            quote="INR",
            rate="30" if clock() == NOW else "31",
            date=NOW.date(),
            fetched_at=clock(),
        )

    monkeypatch.setattr(rates, "fetch", AsyncMock(side_effect=fetch))
    await store.open()
    await store.create("owner")
    try:
        yield store, rates, clock
    finally:
        await store.close()


@pytest.mark.parametrize("fee,amount", [(None, 60000), ("0", 60000), ("10", 61000)])
async def test_capture_daily_refresh_and_persistent_cache(exchange_store, fee, amount):
    store, rates, clock = exchange_store
    request = parsed_command(foreign(fee=fee))
    payload = request.model_dump_json(exclude_unset=True)
    saved = await store.command("owner", request)
    assert request.model_dump_json(exclude_unset=True) == payload
    money = saved.facts.records[0].amount
    assert money.amount_paise == saved.plan.outflow_paise == amount
    assert money.status == "estimate"
    assert money.source.conversion.rate == "30"
    assert money.source.conversion.provider == "frankfurter"
    assert saved.plan.events[0].source.conversion.rate == "30"
    queue = await store.subscribe("owner")
    assert queue.get_nowait() == saved
    writes = store.connection().total_changes
    assert await store.get("owner") == saved
    assert store.connection().total_changes == writes
    assert queue.empty()
    await store.close()
    await store.open()
    assert await store.get("owner") == saved
    assert rates.fetch.await_count == 1
    queue = await store.subscribe("owner")
    queue.get_nowait()
    clock.return_value += timedelta(days=1)
    writes = store.connection().total_changes
    snapshots = await asyncio.gather(*(store.get("owner") for _ in range(5)))
    refreshed = snapshots[0]
    assert all(item == refreshed for item in snapshots)
    assert refreshed.facts == saved.facts
    assert refreshed.revision == saved.revision
    assert refreshed.sequence == saved.sequence + 1
    assert refreshed.plan.outflow_paise == amount + 2000
    assert refreshed.plan.events[0].source.conversion.rate == "31"
    assert (
        refreshed.plan.exchange_checked_on
        == clock().astimezone(ZoneInfo(store.config.timezone)).date()
    )
    assert queue.get_nowait() == refreshed and queue.empty()
    assert store.connection().total_changes == writes + 1
    assert rates.fetch.await_count == 2
    with sqlite3.connect(rates.path) as db:
        assert db.execute("SELECT COUNT(*) FROM exchange_rates").fetchone()[0] == 2
    assert await store.command("owner", request) == saved
    assert rates.fetch.await_count == 2


async def test_original_receipt_precedes_next_day_lookup(exchange_store):
    store, rates, clock = exchange_store
    request = parsed_command(foreign())
    receipt = await store.command("owner", request)
    clock.return_value += timedelta(days=1)
    assert await store.command("owner", request) == receipt
    assert rates.fetch.await_count == 1
    async with store.connection().execute("SELECT result FROM commands") as cursor:
        assert json.loads((await cursor.fetchone())[0]) == receipt.model_dump(
            mode="json", by_alias=True
        )
    conflict = request.model_copy(update={"expected_revision": 1})
    with pytest.raises(Problem, match="different content"):
        await store.command("owner", conflict)
    assert rates.fetch.await_count == 1


async def test_explicit_quote_never_fetches(exchange_store):
    store, rates, clock = exchange_store
    saved = await store.command("owner", parsed_command(foreign(rate="29", fee="0")))
    clock.return_value += timedelta(days=1)
    refreshed = await store.get("owner")
    assert refreshed.facts == saved.facts
    assert refreshed.plan.outflow_paise == 58000
    assert refreshed.facts.records[0].amount.status == "exact"
    rates.fetch.assert_not_awaited()


@pytest.mark.parametrize("kind", ["replaceFacts", "updateFacts"])
@pytest.mark.parametrize("available", [True, False])
async def test_forged_provider_capture_uses_only_server_quote(exchange_store, kind, available):
    store, rates, clock = exchange_store
    if not available:
        rates.fetch.side_effect = None
        rates.fetch.return_value = None
    data = foreign(rate="999", fee="0")
    data["records"][0]["amount"]["conversion"].update(
        provider="frankfurter", fetchedAt=NOW.isoformat(), rateDate=NOW.date().isoformat()
    )
    if kind == "replaceFacts":
        request = parsed_command(data)
    else:
        saved = await store.get("owner")
        data["records"][0].pop("id")
        request = operation(
            saved, kind, changes={"expectedRevision": 0, "records": data["records"]}
        )
    payload = request.model_dump_json(exclude_unset=True)
    saved = await store.command("owner", request)
    money = saved.facts.records[0].amount
    assert saved.revision == 1
    assert money.source.amount == "20"
    assert money.source.conversion.rate == ("30" if available else None)
    assert money.source.conversion.rate_status == ("estimate" if available else "unknown")
    assert money.source.conversion.fetched_at == (NOW if available else None)
    assert money.amount_paise == (60000 if available else None)
    assert request.model_dump_json(exclude_unset=True) == payload
    async with store.connection().execute("SELECT fingerprint, result FROM commands") as cursor:
        fingerprint, result = await cursor.fetchone()
    assert fingerprint == hashlib.sha256(payload.encode()).hexdigest()
    assert json.loads(result) == saved.model_dump(mode="json", by_alias=True)
    clock.return_value += timedelta(days=1)
    assert await store.command("owner", request) == saved
    assert rates.fetch.await_count == 1


@pytest.mark.parametrize("kind", ["replaceFacts", "updateFacts"])
@pytest.mark.parametrize("field", ["fee", "date", "amount"])
async def test_edit_preserves_authenticated_capture(exchange_store, kind, field):
    store, rates, clock = exchange_store
    saved = await store.command("owner", parsed_command(foreign(fee="0")))
    capture = saved.facts.records[0].amount.source.conversion
    clock.return_value += timedelta(days=1)
    data = facts_input(saved.facts).model_dump(mode="json", by_alias=True)
    item = data["records"][0]
    if field == "fee":
        item["amount"]["conversion"].update(fee="10", feeStatus="exact")
    elif field == "date":
        item["schedule"]["date"] = "2026-09-16"
    else:
        item["amount"]["amount"] = "25"
    request = (
        parsed_command(data, revision=saved.revision)
        if kind == "replaceFacts"
        else operation(
            saved,
            kind,
            changes={
                "expectedRevision": saved.revision,
                "records": [
                    {"id": "foreign", "amount": item["amount"], "schedule": item["schedule"]}
                ],
            },
        )
    )
    edited = await store.command("owner", request)
    conversion = edited.facts.records[0].amount.source.conversion
    assert conversion.model_dump(exclude={"fee", "fee_status"}) == capture.model_dump(
        exclude={"fee", "fee_status"}
    )
    assert edited.facts.records[0].amount.amount_paise == (
        61000 if field == "fee" else 75000 if field == "amount" else 60000
    )
    assert edited.plan.events[0].source.conversion.rate == "31"
    assert rates.fetch.await_count == 2


@pytest.mark.parametrize("field", ["rate", "rateStatus", "rateDate", "fetchedAt", "currency"])
async def test_tampered_capture_is_not_preserved(exchange_store, field):
    store, rates, clock = exchange_store
    saved = await store.command("owner", parsed_command(foreign(fee="0")))
    data = facts_input(saved.facts).model_dump(mode="json", by_alias=True)
    conversion = data["records"][0]["amount"]["conversion"]
    conversion[field] = {
        "rate": "999",
        "rateStatus": "exact",
        "rateDate": "2026-09-10",
        "fetchedAt": (NOW - timedelta(days=1)).isoformat(),
        "currency": "EUR",
    }[field]
    clock.return_value += timedelta(days=1)
    edited = await store.command("owner", parsed_command(data, revision=saved.revision))
    conversion = edited.facts.records[0].amount.source.conversion
    assert conversion.rate == "31"
    assert conversion.rate_status == "estimate"
    assert conversion.rate_date == NOW.date()
    assert conversion.fetched_at == clock()
    assert edited.facts.records[0].amount.amount_paise == 62000


async def test_manual_quote_clears_provider_metadata(exchange_store):
    store, rates, _ = exchange_store
    saved = await store.command("owner", parsed_command(foreign(fee="0")))
    edited = await store.command(
        "owner",
        operation(
            saved,
            "updateFacts",
            changes={
                "expectedRevision": saved.revision,
                "records": [
                    {
                        "id": "foreign",
                        "amount": {
                            "amount": "20",
                            "status": "exact",
                            "conversion": {"currency": "USD", "rate": "29", "rateStatus": "exact"},
                        },
                    }
                ],
            },
        ),
    )
    conversion = edited.facts.records[0].amount.source.conversion
    assert conversion.provider is None and conversion.fetched_at is None
    assert conversion.rate == "29"
    assert edited.facts.records[0].amount.amount_paise == 58000
    assert edited.plan.events[0].amount_paise == 58000
    assert rates.fetch.await_count == 1


async def test_manual_quote_cannot_supply_retrieval_timestamp(exchange_store):
    store, rates, _ = exchange_store
    data = foreign(rate="29", fee="0")
    data["records"][0]["amount"]["conversion"]["fetchedAt"] = NOW.isoformat()
    saved = await store.command("owner", parsed_command(data))
    conversion = saved.facts.records[0].amount.source.conversion
    assert conversion.provider is None and conversion.fetched_at is None
    assert conversion.rate == "29"
    assert saved.plan.outflow_paise == 58000
    rates.fetch.assert_not_awaited()


@pytest.mark.parametrize(
    "location", ["opening", "target", "outstanding", "amounts", "payment", "cost"]
)
async def test_nested_money_cannot_forge_provider_capture(exchange_store, location):
    store, rates, _ = exchange_store
    data = facts("0", [record("bill", "debt", "100", "2026-09-15")])
    money = foreign(rate="999", fee="0")["records"][0]["amount"]
    money["conversion"].update(provider="frankfurter", fetchedAt=NOW.isoformat())
    if location == "opening":
        data["opening"] = money
    elif location in {"payment", "cost"}:
        data["providerResponses"] = [
            {
                "eventId": "bill:2026-09-15",
                "status": "reportedTerms",
                "reportedOn": NOW.date().isoformat(),
                location: money,
            }
        ]
    elif location == "amounts":
        data["records"][0]["amount"] = {"amount": None, "status": "unknown"}
        data["records"][0]["schedule"].update(recurrence="daily", amounts=[money])
    else:
        data["records"][0][location] = money
    saved = await store.command("owner", parsed_command(data))
    source = (
        saved.facts.opening.source
        if location == "opening"
        else getattr(saved.facts.provider_responses[0], location).source
        if location in {"payment", "cost"}
        else saved.facts.records[0].schedule.amounts[0]
        if location == "amounts"
        else getattr(saved.facts.records[0], location).source
    )
    assert source.amount == "20"
    assert source.conversion.rate == "30"
    assert source.conversion.rate_status == "estimate"
    assert source.conversion.fetched_at == NOW
    assert rates.fetch.await_count == 1


@pytest.mark.parametrize("available", [True, False])
async def test_conflict_and_resolution_cannot_forge_provider_capture(exchange_store, available):
    store, rates, _ = exchange_store
    if not available:
        rates.fetch.side_effect = None
        rates.fetch.return_value = None
    saved = await store.command("owner", parsed_command(foreign(rate="29", fee="0")))
    value = foreign(rate="999", fee="0")["records"][0]["amount"]
    value["id"] = "disputed"
    value["conversion"].update(provider="frankfurter", fetchedAt=NOW.isoformat())
    disputed = await store.command(
        "owner",
        operation(
            saved,
            "updateFacts",
            changes={
                "expectedRevision": saved.revision,
                "conflicts": [{"recordId": "foreign", "field": "amount", "values": [value]}],
            },
        ),
    )
    candidate = disputed.facts.conflicts[0].values[-1]
    assert candidate.source.amount == "20"
    assert candidate.source.conversion.rate == ("30" if available else None)
    assert candidate.amount_paise == (60000 if available else None)
    value["id"] = "resolved"
    resolved = await store.command(
        "owner",
        operation(
            disputed,
            "updateFacts",
            changes={
                "expectedRevision": disputed.revision,
                "resolutions": [{"conflictId": disputed.facts.conflicts[0].id, "value": value}],
            },
        ),
    )
    assert not resolved.facts.conflicts
    assert resolved.facts.records[0].amount.source.conversion.rate == ("30" if available else None)
    assert resolved.facts.records[0].amount.amount_paise == (60000 if available else None)


async def test_forged_capture_without_exchange_adapter_is_unknown(store):
    await store.create("owner")
    data = foreign(rate="999", fee="0")
    data["records"][0]["amount"]["conversion"].update(
        provider="frankfurter", fetchedAt=NOW.isoformat()
    )
    saved = await store.command("owner", parsed_command(data))
    assert saved.revision == 1
    assert saved.facts.records[0].amount.source.amount == "20"
    assert saved.facts.records[0].amount.source.conversion.rate is None
    assert saved.facts.records[0].amount.amount_paise is None


async def test_voice_tool_cannot_forge_provider_capture(exchange_store):
    store, rates, _ = exchange_store
    refresh = Mock()
    tools = VoiceTools(store, "owner", uuid4(), refresh)
    tools.user_turn = "I owe 20 dollars on September 15."
    item = foreign(rate="999", fee="0")["records"][0]
    item.pop("id")
    item["amount"]["conversion"].update(provider="frankfurter", fetchedAt=NOW.isoformat())
    result = await tools.update_facts({"expectedRevision": 0, "records": [item]}, "forged")
    assert result["saved"] is True
    saved = refresh.call_args.args[0]
    assert saved.facts.records[0].amount.source.conversion.rate == "30"
    assert saved.facts.records[0].amount.amount_paise == 60000
    assert rates.fetch.await_count == 1


async def test_failed_provider_preserves_original_and_recovers_next_day(exchange_store):
    store, rates, clock = exchange_store
    fetch = rates.fetch.side_effect
    rates.fetch.side_effect = None
    rates.fetch.return_value = None
    request = parsed_command(foreign())
    saved = await store.command("owner", request)
    assert saved.facts.records[0].amount.amount_paise is None
    assert saved.facts.records[0].amount.source.amount == "20"
    assert saved.plan.exchange_rates == {}
    assert saved.plan.events[0].amount_paise is None
    assert await store.get("owner") == saved
    await store.close()
    await store.open()
    assert await store.get("owner") == saved
    assert rates.fetch.await_count == 1
    queue = await store.subscribe("owner")
    queue.get_nowait()
    rates.fetch.side_effect = fetch
    clock.return_value += timedelta(days=1)
    refreshed = await store.get("owner")
    assert refreshed.facts.records[0].amount.amount_paise == 62000
    assert refreshed.facts.records[0].amount.source.conversion.rate == "31"
    assert refreshed.revision == saved.revision
    assert refreshed.sequence == saved.sequence + 1
    assert refreshed.as_of == saved.as_of
    assert refreshed.latest_change == saved.latest_change
    assert queue.get_nowait() == refreshed and queue.empty()
    writes = store.connection().total_changes
    assert await store.get("owner") == refreshed
    assert store.connection().total_changes == writes
    assert queue.empty()
    assert await store.command("owner", request) == saved
    assert rates.fetch.await_count == 2


async def test_failed_refresh_never_uses_historical_quote(exchange_store):
    store, rates, clock = exchange_store
    saved = await store.command("owner", parsed_command(foreign()))
    clock.return_value += timedelta(days=1)
    rates.fetch.side_effect = None
    rates.fetch.return_value = None
    refreshed = await store.get("owner")
    assert refreshed.facts == saved.facts
    assert refreshed.facts.records[0].amount.amount_paise == 60000
    assert refreshed.plan.exchange_rates == {}
    assert refreshed.plan.events[0].amount_paise is None
    assert refreshed.plan.events[0].source.conversion.rate is None
    assert await store.get("owner") == refreshed
    assert rates.fetch.await_count == 2


async def test_rebuild_replays_stored_observations_without_provider(exchange_store):
    store, rates, clock = exchange_store
    saved = await store.command("owner", parsed_command(foreign()))
    clock.return_value += timedelta(days=1)
    refreshed = await store.get("owner")
    payload = refreshed.model_dump(mode="json", by_alias=True)
    payload["plan"].pop("events")
    restored, _ = store.load_snapshot(json.dumps(payload))
    assert restored == refreshed
    assert restored.facts == saved.facts
    rates.fetch.assert_awaited()
    assert rates.fetch.await_count == 2


async def test_cache_write_failure_does_not_abort_financial_command(exchange_store):
    store, rates, _ = exchange_store
    with sqlite3.connect(rates.path) as db:
        db.execute(
            "CREATE TRIGGER reject_quote BEFORE UPDATE ON exchange_rates "
            "BEGIN SELECT RAISE(FAIL, 'private database information'); END"
        )
    saved = await store.command("owner", parsed_command(foreign()))
    assert saved.revision == 1
    assert saved.facts.records[0].amount.source.amount == "20"
    assert saved.plan.exchange_rates == {}
    assert await store.get("owner") == saved
    assert rates.fetch.await_count == 1


async def test_open_failure_disables_only_exchange(tmp_path, config, monkeypatch, caplog):
    application = create_app(config, Environment(data_dir=tmp_path), clock=lambda: NOW)
    store = application.state.store
    rates = store.rates
    assert rates.path == tmp_path / "exchange.sqlite3"
    monkeypatch.setattr(
        rates, "open", AsyncMock(side_effect=sqlite3.OperationalError("private path"))
    )
    monkeypatch.setattr(rates, "get", AsyncMock())
    await store.open()
    try:
        await store.create("owner")
        saved = await store.command("owner", parsed_command(foreign()))
        assert saved.revision == 1 and saved.plan.exchange_rates == {}
        assert saved.facts.records[0].amount.source.amount == "20"
        rates.get.assert_not_awaited()
        assert "OperationalError" in caplog.text and "private path" not in caplog.text
    finally:
        await store.close()


async def test_concurrent_command_rechecks_revision_and_receipt(exchange_store):
    store, rates, _ = exchange_store
    entered, release = asyncio.Event(), asyncio.Event()
    fetch = rates.fetch.side_effect

    async def blocked(currency):
        entered.set()
        await release.wait()
        return await fetch(currency)

    rates.fetch.side_effect = blocked
    request = parsed_command(foreign())
    pending = asyncio.create_task(store.command("owner", request))
    await asyncio.wait_for(entered.wait(), 2)
    other = await asyncio.wait_for(store.command("owner", parsed_command(facts("123"))), 2)
    release.set()
    with pytest.raises(Problem) as error:
        await pending
    assert error.value.body.code == "staleRevision"
    assert (await store.get("owner")).facts == other.facts
    request = parsed_command(foreign(), revision=other.revision)
    results = await asyncio.gather(*(store.command("owner", request) for _ in range(5)))
    assert all(item == results[0] for item in results)
    assert results[0].revision == other.revision + 1
    assert rates.fetch.await_count == 1


@pytest.mark.parametrize("method", ["get", "command"])
async def test_session_replacement_during_fetch_is_rejected(exchange_store, method):
    store, rates, _ = exchange_store
    if method == "get":
        store.rates_available = False
        await store.command("owner", parsed_command(foreign()))
        store.rates_available = True
    entered, release = asyncio.Event(), asyncio.Event()
    fetch = rates.fetch.side_effect

    async def blocked(currency):
        entered.set()
        await release.wait()
        return await fetch(currency)

    rates.fetch.side_effect = blocked
    pending = asyncio.create_task(
        store.get("owner") if method == "get" else store.command("owner", parsed_command(foreign()))
    )
    await asyncio.wait_for(entered.wait(), 2)
    await store.delete("owner")
    replacement = await store.create("owner")
    release.set()
    with pytest.raises(Problem) as error:
        await pending
    assert error.value.body.code == "conversationChanged"
    assert (await store.get("owner")).facts == replacement.facts


async def test_late_observation_is_dropped_at_financial_lock(exchange_store, monkeypatch):
    store, rates, clock = exchange_store
    get = rates.get

    async def late(currency):
        quote = await get(currency)
        clock.return_value += timedelta(days=1)
        return quote

    monkeypatch.setattr(rates, "get", late)
    saved = await store.command("owner", parsed_command(foreign()))
    assert saved.plan.exchange_rates == {}
    assert saved.plan.events[0].amount_paise is None
    assert saved.facts.records[0].amount.source.conversion.rate is None


async def test_preview_and_accepted_share_refreshed_context(exchange_store):
    store, rates, clock = exchange_store
    data = foreign()
    data["records"].append(record("outing", "optional", "100", "2026-09-15"))
    data["coverage"]["optional"] = "reviewed"
    saved = await store.command("owner", parsed_command(data))
    preview = await store.command(
        "owner",
        operation(
            saved,
            "previewAdjustments",
            adjustments=[{"eventId": "outing:2026-09-15", "amount": "0"}],
        ),
    )
    accepted = await store.command(
        "owner",
        operation(
            preview,
            "acceptPreview",
            previewId=str(preview.preview.id),
            confirmed=True,
            consentScope="unconditional",
        ),
    )
    preview = await store.command(
        "owner",
        operation(
            accepted,
            "previewAdjustments",
            adjustments=[{"eventId": "outing:2026-09-15", "amount": "50"}],
        ),
    )
    clock.return_value += timedelta(days=1)
    refreshed = await store.get("owner")
    assert refreshed.facts == saved.facts
    assert refreshed.accepted.adjustments == accepted.accepted.adjustments
    assert refreshed.preview.id == preview.preview.id
    assert refreshed.plan.outflow_paise == 72000
    assert refreshed.accepted.plan.outflow_paise == 62000
    assert refreshed.preview.plan.outflow_paise == 67000
    for plan in (refreshed.plan, refreshed.accepted.plan, refreshed.preview.plan):
        assert plan.exchange_rates["USD"].rate == "31"
        assert plan.exchange_checked_on == refreshed.plan.exchange_checked_on
    assert rates.fetch.await_count == 2
    rejected = await store.command(
        "owner", operation(refreshed, "rejectPreview", previewId=str(refreshed.preview.id))
    )
    assert rejected.preview is None
    assert rejected.plan.exchange_rates == rejected.accepted.plan.exchange_rates
    assert rejected.plan.exchange_rates["USD"].rate == "31"


async def test_action_response_uses_current_observations(exchange_store):
    store, rates, clock = exchange_store
    data = foreign()
    data["opening"] = {"amount": None, "status": "unknown"}
    saved = await store.command("owner", parsed_command(data))
    clock.return_value += timedelta(days=1)
    response = await store.command(
        "owner",
        operation(saved, "respondToAction", actionId="clarify:opening", response="unavailable"),
    )
    assert response.plan.exchange_rates["USD"].rate == "31"
    assert response.plan.outflow_paise == 62000
    assert response.facts.records == saved.facts.records
    assert response.facts.decision.responses[0].action_id == "clarify:opening"
    assert rates.fetch.await_count == 2


async def test_voice_sparse_correction_preserves_capture_and_refreshes_plan(exchange_store):
    store, rates, clock = exchange_store
    await store.command("owner", parsed_command(foreign()))
    refresh = Mock()
    tools = VoiceTools(store, "owner", uuid4(), refresh)
    clock.return_value += timedelta(days=1)
    tools.user_turn = "The expense is 25 dollars."
    result = await tools.update_facts(
        {
            "expectedRevision": 1,
            "records": [{"id": "foreign", "amount": {"amount": "25", "status": "exact"}}],
        },
        "correction",
    )
    assert result["saved"] is True
    saved = refresh.call_args.args[0]
    assert saved.facts.records[0].amount.amount_paise == 75000
    assert saved.facts.records[0].amount.source.conversion.rate == "30"
    assert saved.plan.events[0].amount_paise == 77500
    assert saved.plan.events[0].source.conversion.rate == "31"
    await tools.read_state()
    assert refresh.call_args.args[0] == saved
    assert rates.fetch.await_count == 2


def test_api_command_and_reads_share_exchange_flow(client, monkeypatch):
    store = client.app.state.store
    clock = Mock(return_value=NOW)
    store.clock = store.rates.clock = clock
    client.app.state.auth.google.clock = clock

    async def fetch(currency):
        assert not store.lock.locked()
        return ExchangeRate(
            base=currency,
            quote="INR",
            rate="30" if clock() == NOW else "31",
            date=NOW.date(),
            fetched_at=clock(),
        )

    monkeypatch.setattr(store.rates, "fetch", AsyncMock(side_effect=fetch))
    assert client.post("/api/session", json={}).status_code == 200
    request = command(foreign())
    response = client.post("/api/session/commands", json=request)
    assert response.status_code == 200
    saved = response.json()
    clock.return_value += timedelta(hours=18)
    response = client.get("/api/session")
    assert response.status_code == 200
    refreshed = response.json()
    assert refreshed["facts"] == saved["facts"]
    assert refreshed["plan"]["outflowPaise"] == 62000
    assert refreshed["revision"] == saved["revision"]
    assert refreshed["sequence"] == saved["sequence"] + 1
    assert client.post("/api/session/commands", json=request).json() == saved
    assert store.rates.fetch.await_count == 2


async def test_authorization_is_rechecked_after_provider_wait(exchange_store):
    store, rates, _ = exchange_store
    store.authorize = AsyncMock()
    store.authorize_locked = AsyncMock()
    entered, release = asyncio.Event(), asyncio.Event()
    fetch = rates.fetch.side_effect

    async def blocked(currency):
        entered.set()
        await release.wait()
        return await fetch(currency)

    rates.fetch.side_effect = blocked
    pending = asyncio.create_task(
        store.command(Access("owner", "session"), parsed_command(foreign()))
    )
    await asyncio.wait_for(entered.wait(), 2)
    store.authorize_locked.side_effect = Problem(401, "unauthenticated", "Sign in to continue.")
    release.set()
    with pytest.raises(Problem) as error:
        await pending
    assert error.value.status == 401
    assert (await store.get("owner")).revision == 0


async def test_quote_lookup_exception_preserves_financial_write(
    exchange_store, monkeypatch, caplog
):
    store, rates, _ = exchange_store
    monkeypatch.setattr(
        rates, "get", AsyncMock(side_effect=RuntimeError("private provider details"))
    )
    saved = await store.command("owner", parsed_command(foreign()))
    assert saved.revision == 1
    assert saved.facts.records[0].amount.source.amount == "20"
    assert saved.plan.events[0].amount_paise is None
    assert "RuntimeError" in caplog.text and "private provider details" not in caplog.text


async def test_refresh_rollback_does_not_publish_or_mutate_facts(exchange_store):
    store, rates, clock = exchange_store
    saved = await store.command("owner", parsed_command(foreign()))
    queue = await store.subscribe("owner")
    queue.get_nowait()
    await store.connection().execute(
        "CREATE TEMP TRIGGER reject_snapshot BEFORE UPDATE ON sessions "
        "BEGIN SELECT RAISE(FAIL, 'write failed'); END"
    )
    await store.connection().commit()
    clock.return_value += timedelta(days=1)
    with pytest.raises(sqlite3.IntegrityError):
        await store.get("owner")
    assert queue.empty()
    async with store.connection().execute("SELECT snapshot FROM sessions") as cursor:
        assert json.loads((await cursor.fetchone())[0]) == saved.model_dump(
            mode="json", by_alias=True
        )
    await store.connection().execute("DROP TRIGGER reject_snapshot")
    await store.connection().commit()
    refreshed = await store.get("owner")
    assert refreshed.sequence == saved.sequence + 1
    assert refreshed.facts == saved.facts
    assert refreshed.plan.outflow_paise == 62000
    assert queue.get_nowait() == refreshed and queue.empty()
    assert rates.fetch.await_count == 2
