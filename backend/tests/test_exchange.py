# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
import sqlite3
from datetime import UTC, date, datetime, timedelta
from unittest.mock import AsyncMock, Mock

import aiohttp
import pytest
from pydantic import ValidationError

from app.config import ExchangeConfig, load_config
from app.exchange import MAX_BYTES, ExchangeRate, ExchangeRates

NOW = datetime(2026, 9, 13, 12, tzinfo=UTC)
BODY = b'{"date":"2026-09-11","base":"USD","quote":"INR","rate":88.123456785}'


class Response:
    def __init__(self, body=BODY, status=200):
        self.body = body
        self.status = status
        self.content = self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def iter_chunked(self, size):
        for offset in range(0, len(self.body), min(size, 1024)):
            yield self.body[offset : offset + min(size, 1024)]


@pytest.fixture(autouse=True)
def http(monkeypatch):
    http = Mock(return_value=Response())
    http.original = aiohttp.ClientSession.get
    monkeypatch.setattr(aiohttp.ClientSession, "get", http)
    return http


@pytest.fixture
def clock():
    return Mock(return_value=NOW)


@pytest.fixture
async def rates(tmp_path, clock):
    rates = ExchangeRates(
        tmp_path / "exchange.sqlite3", ExchangeConfig(), "Asia/Kolkata", "INR", clock
    )
    await rates.open()
    try:
        yield rates
    finally:
        await rates.close()


async def test_success_precision_aliases_and_reopen(rates, http, clock):
    result = await rates.get("USD")
    assert result == ExchangeRate(
        base="USD", quote="INR", rate="88.12345679", date=date(2026, 9, 11), fetched_at=NOW
    )
    assert result.model_dump(by_alias=True)["fetchedAt"] == NOW
    http.assert_called_once_with(
        "https://api.frankfurter.dev/v2/rate/USD/INR", allow_redirects=False
    )
    clock.return_value += timedelta(hours=1)
    assert await rates.get("USD") == result
    await rates.close()
    reopened = ExchangeRates(rates.path, rates.config, "Asia/Kolkata", "INR", clock)
    await reopened.open()
    try:
        assert await reopened.get("USD") == result
        http.assert_called_once()
        with sqlite3.connect(rates.path) as db:
            assert db.execute("SELECT * FROM exchange_rates").fetchone() == (
                "USD",
                "INR",
                "2026-09-13",
                NOW.isoformat(),
                "88.12345679",
                "2026-09-11",
            )
    finally:
        await reopened.close()


async def test_concurrent_get_deduplicates(rates, http, monkeypatch):
    entered = asyncio.Event()
    release = asyncio.Event()
    fetch = rates.fetch

    async def blocked(source):
        entered.set()
        await release.wait()
        return await fetch(source)

    monkeypatch.setattr(rates, "fetch", blocked)
    tasks = [asyncio.create_task(rates.get("USD")) for _ in range(12)]
    await entered.wait()
    release.set()
    results = await asyncio.gather(*tasks)
    assert results[0] is not None and all(result == results[0] for result in results)
    http.assert_called_once()


async def test_timezone_boundary_refreshes_even_with_same_reference_date(rates, http, clock):
    clock.return_value = datetime(2026, 9, 13, 18, 29, 59, tzinfo=UTC)
    first = await rates.get("USD")
    clock.return_value += timedelta(seconds=1)
    second = await rates.get("USD")
    assert first is not None and second is not None
    assert first.date == second.date == date(2026, 9, 11)
    assert first.fetched_at != second.fetched_at
    assert second.fetched_at == clock.return_value
    assert http.call_count == 2


async def test_failure_persists_no_same_day_retry_or_stale_fallback(rates, http, clock):
    assert await rates.get("USD") is not None
    clock.return_value += timedelta(days=1)
    http.return_value = Response(status=404)
    assert await rates.get("USD") is None
    await rates.close()
    await rates.open()
    http.return_value = Response()
    assert await rates.get("USD") is None
    assert http.call_count == 2
    clock.return_value += timedelta(days=1)
    assert await rates.get("USD") is not None
    assert http.call_count == 3


async def test_pending_reservation_survives_cancellation_and_reopen(rates, monkeypatch, http):
    entered = asyncio.Event()
    fetch = rates.fetch

    async def blocked(source):
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(rates, "fetch", blocked)
    task = asyncio.create_task(rates.get("USD"))
    await entered.wait()
    with sqlite3.connect(rates.path) as db:
        assert db.execute("SELECT rate, date FROM exchange_rates").fetchone() == (None, None)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await rates.close()
    await rates.open()
    monkeypatch.setattr(rates, "fetch", fetch)
    assert await rates.get("USD") is None
    http.assert_not_called()


async def test_shared_database_reservation_prevents_second_instance_request(rates, clock, http):
    other = ExchangeRates(rates.path, rates.config, "Asia/Kolkata", "INR", clock)
    await other.open()
    try:
        first, second = await asyncio.gather(rates.get("USD"), other.get("USD"))
        assert first is not None
        assert second is None or second == first
        assert await other.get("USD") == first
        http.assert_called_once()
    finally:
        await other.close()


async def test_reservation_database_failure_prevents_http(rates, http):
    with sqlite3.connect(rates.path) as db:
        db.execute("BEGIN EXCLUSIVE")
        assert await rates.get("USD") is None
        http.assert_not_called()
        db.rollback()
    assert await rates.get("USD") is not None


async def test_success_write_failure_stays_reserved(rates, http, monkeypatch):
    fetch = rates.fetch
    with sqlite3.connect(rates.path) as db:
        db.execute(
            "CREATE TRIGGER reject_update BEFORE UPDATE ON exchange_rates "
            "BEGIN SELECT RAISE(FAIL, 'private database details'); END"
        )
    assert await rates.get("USD") is None
    monkeypatch.setattr(rates, "fetch", AsyncMock(wraps=fetch))
    assert await rates.get("USD") is None
    rates.fetch.assert_not_called()
    http.assert_called_once()


async def test_open_infrastructure_failure_is_fatal(tmp_path, clock, http):
    rates = ExchangeRates(
        tmp_path / "missing" / "cache.db", ExchangeConfig(), "Asia/Kolkata", "INR", clock
    )
    with pytest.raises(sqlite3.OperationalError):
        await rates.open()
    assert await rates.get("USD") is None
    await rates.close()
    http.assert_not_called()


@pytest.mark.parametrize("source", ["INR", "usd", "USD/INR", "US", "USDD", "USD\n", "USD?x=y"])
async def test_invalid_or_domestic_currency_never_requests(rates, http, source):
    assert await rates.get(source) is None
    assert await rates.fetch(source) is None
    http.assert_not_called()


async def test_pairs_have_separate_daily_reservations(rates, http):
    assert await rates.get("USD") is not None
    http.return_value = Response(BODY.replace(b"USD", b"EUR"))
    assert (await rates.get("EUR")).base == "EUR"
    assert (await rates.get("USD")).base == "USD"
    assert http.call_count == 2


@pytest.mark.parametrize("status", [301, 302, 307, 308, 400, 404, 429, 500, 503])
async def test_http_errors_are_negative_cached_without_payload_logs(rates, http, caplog, status):
    http.return_value = Response(b"private payload", status)
    assert await rates.get("USD") is None
    assert await rates.get("USD") is None
    http.assert_called_once()
    assert f"status={status}" in caplog.text
    assert "private payload" not in caplog.text


@pytest.mark.parametrize(
    "error", [TimeoutError, aiohttp.ClientConnectionError, aiohttp.ClientPayloadError]
)
async def test_network_errors_are_negative_cached_and_logs_are_safe(rates, http, caplog, error):
    http.side_effect = error("private payload")
    assert await rates.get("USD") is None
    assert await rates.get("USD") is None
    http.assert_called_once()
    assert f"type={error.__name__}" in caplog.text
    assert "private payload" not in caplog.text


async def test_http_cancellation_propagates_and_consumes_day(rates, http):
    http.side_effect = asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        await rates.get("USD")
    http.side_effect = None
    assert await rates.get("USD") is None
    http.assert_called_once()


@pytest.mark.parametrize("error", [aiohttp.ClientOSError, aiohttp.ServerDisconnectedError])
async def test_aiohttp_disconnect_does_not_retry_transport(rates, http, monkeypatch, error):
    monkeypatch.setattr(aiohttp.ClientSession, "get", http.original)
    connect = AsyncMock(return_value=Mock())
    send = AsyncMock(side_effect=error("private transport details"))
    monkeypatch.setattr(aiohttp.TCPConnector, "connect", connect)
    monkeypatch.setattr(aiohttp.ClientRequest, "send", send)
    assert await rates.get("USD") is None
    assert await rates.get("USD") is None
    connect.assert_awaited_once()
    send.assert_awaited_once()


async def test_session_deadline_and_environment_policy(rates, http, monkeypatch):
    session = aiohttp.ClientSession
    sessions = []

    def create(**kwargs):
        assert kwargs["timeout"].total == rates.config.timeout_seconds
        assert kwargs["trust_env"] is False
        sessions.append(session(**kwargs))
        return sessions[-1]

    monkeypatch.setattr(aiohttp, "ClientSession", create)
    assert await rates.get("USD") is not None
    assert len(sessions) == 1 and sessions[0].closed
    http.assert_called_once()


@pytest.mark.parametrize(
    "body",
    [
        b"not json private payload",
        b"[]",
        b"null",
        b"{}",
        b"\xff",
        BODY.replace(b"USD", b"EUR"),
        BODY.replace(b"INR", b"USD"),
        BODY.replace(b"2026-09-11", b"2026-09-14"),
        BODY.replace(b"2026-09-11", b"2026-02-30"),
        BODY.replace(b"2026-09-11", b"20260911"),
        BODY.replace(b"2026-09-11", b"2026-09-11T00:00:00Z"),
        *[
            BODY.replace(b"88.123456785", value)
            for value in (
                b"0",
                b"-1",
                b"NaN",
                b"Infinity",
                b"-Infinity",
                b"1e999999",
                b"1e-99999",
                b"0.000000004",
                b"true",
                b"null",
                b'"88.1"',
                b"10000000000000",
                b"[]",
                b"{}",
            )
        ],
        b" " * (MAX_BYTES + 1) + BODY,
        b"[" * 2000 + b"0" + b"]" * 2000,
    ],
)
async def test_malformed_provider_responses_are_negative_cached(rates, http, caplog, body):
    http.return_value = Response(body)
    assert await rates.get("USD") is None
    assert await rates.get("USD") is None
    http.assert_called_once()
    assert "private payload" not in caplog.text


@pytest.mark.parametrize(
    "rate,expected", [(b"1", "1.00000000"), (b"1e-8", "0.00000001"), (b"0.000000005", "0.00000001")]
)
async def test_numeric_rates_are_rounded_to_eight_places(rates, http, rate, expected):
    http.return_value = Response(BODY.replace(b"88.123456785", rate))
    assert (await rates.get("USD")).rate == expected


async def test_payload_at_limit_is_accepted(rates, http):
    http.return_value = Response(BODY + b" " * (MAX_BYTES - len(BODY)))
    assert await rates.get("USD") is not None


async def test_midnight_during_fetch_never_returns_yesterdays_rate(rates, http, monkeypatch, clock):
    fetch = rates.fetch

    async def crossing(source):
        result = await fetch(source)
        clock.return_value += timedelta(days=1)
        return result

    monkeypatch.setattr(rates, "fetch", crossing)
    assert await rates.get("USD") is None
    monkeypatch.setattr(rates, "fetch", fetch)
    assert await rates.get("USD") is not None
    assert http.call_count == 2


async def test_corrupt_cached_data_fails_closed_without_http(rates, http):
    assert await rates.get("USD") is not None
    with sqlite3.connect(rates.path) as db:
        db.execute("UPDATE exchange_rates SET rate = 'NaN'")
    assert await rates.get("USD") is None
    http.assert_called_once()


def test_config_and_target_validation(tmp_path, clock):
    assert ExchangeConfig().timeout_seconds == load_config().exchange.timeout_seconds == 5
    with pytest.raises(ValueError):
        ExchangeRates(tmp_path / "cache.db", ExchangeConfig(), "Asia/Kolkata", "USD", clock)
    for timeout in (0, -1, float("nan"), float("inf")):
        with pytest.raises(ValidationError):
            ExchangeConfig(timeout_seconds=timeout)


@pytest.mark.parametrize(
    "rate", ["0", "-1", "NaN", "Infinity", "1.123456789", "1e2", "10000000000000"]
)
def test_rate_model_rejects_invalid_decimal_strings(rate):
    with pytest.raises(ValidationError):
        ExchangeRate(base="USD", quote="INR", rate=rate, date=NOW.date(), fetched_at=NOW)


def test_rate_model_accepts_camel_alias_and_requires_aware_timestamp():
    payload = {
        "base": "USD",
        "quote": "INR",
        "rate": "88",
        "date": "2026-09-11",
        "fetchedAt": NOW.isoformat(),
    }
    assert ExchangeRate.model_validate_json(json.dumps(payload)).fetched_at == NOW
    payload["fetchedAt"] = "2026-09-13T12:00:00"
    with pytest.raises(ValidationError):
        ExchangeRate.model_validate(payload)
