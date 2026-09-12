# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import datetime as dt
import json
import logging
import re
import sqlite3
from collections.abc import Callable
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import aiohttp
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

from .config import ExchangeConfig

logger = logging.getLogger("uvicorn.error.exchange")
MAX_BYTES = 16384


def rate_currencies(value: Any) -> set[str]:
    """Find unquoted or reference-rate currencies without sending monetary data externally."""
    currencies: set[str] = set()
    if isinstance(value, dict):
        conversion = value.get("conversion")
        if isinstance(conversion, dict) and (
            conversion.get("rate") is None or conversion.get("provider") == "frankfurter"
        ):
            currency = conversion.get("currency")
            if isinstance(currency, str) and re.fullmatch(r"[A-Z]{3}", currency):
                currencies.add(currency)
        for item in value.values():
            currencies.update(rate_currencies(item))
    elif isinstance(value, list):
        for item in value:
            currencies.update(rate_currencies(item))
    return currencies


def rate_captures(value: Any) -> set[tuple[Any, ...]]:
    """Identify stored provider quotes independently of amount, fees and owning field."""
    captures: set[tuple[Any, ...]] = set()
    if isinstance(value, dict):
        conversion = value.get("conversion")
        if isinstance(conversion, dict) and conversion.get("provider") == "frankfurter":
            captures.add(
                tuple(
                    conversion.get(field)
                    for field in ("currency", "rate", "rate_status", "rate_date", "fetched_at")
                )
            )
        for item in value.values():
            captures.update(rate_captures(item))
    elif isinstance(value, list):
        for item in value:
            captures.update(rate_captures(item))
    return captures


def apply_rates(
    value: Any,
    rates: dict[str, "ExchangeRate"] | None,
    *,
    capture: bool,
    captures: set[tuple[Any, ...]] | None = None,
) -> Any:
    """Copy reference conversions for capture or planning without replacing reported quotes."""
    if isinstance(value, list):
        return [apply_rates(item, rates, capture=capture, captures=captures) for item in value]
    if not isinstance(value, dict):
        return value
    value = {
        key: apply_rates(item, rates, capture=capture, captures=captures)
        for key, item in value.items()
    }
    conversion = value.get("conversion")
    if isinstance(conversion, dict) and captures is not None:
        if conversion.get("provider") != "frankfurter":
            conversion["fetched_at"] = None
        elif not rate_captures({"conversion": conversion}) <= captures:
            # A caller's provider label is not evidence of a server retrieval.
            conversion["rate"] = None
    if (
        isinstance(conversion, dict)
        and (rates is not None or conversion.get("provider") == "frankfurter")
        and (
            conversion.get("rate") is None
            or not capture
            and conversion.get("provider") == "frankfurter"
        )
    ):
        quote = rates.get(conversion.get("currency", "")) if rates else None
        conversion.update(
            rate=quote.rate if quote else None,
            rate_status="estimate" if quote else "unknown",
            rate_date=quote.date if quote else None,
            provider="frankfurter",
            fetched_at=quote.fetched_at if quote else None,
        )
    return value


async def single_request(
    request: aiohttp.ClientRequest, handler: aiohttp.ClientHandlerType
) -> aiohttp.ClientResponse:
    """Prevent aiohttp's transparent retry of disconnected idempotent requests."""
    try:
        return await handler(request)
    except (aiohttp.ClientOSError, aiohttp.ServerDisconnectedError):
        raise aiohttp.ClientConnectionError("Exchange connection failed") from None


class ExchangeRate(BaseModel):
    """A provider reference rate and the original retrieval timestamp."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True)

    base: str = Field(pattern=r"^[A-Z]{3}$", strict=True)
    quote: str = Field(pattern=r"^[A-Z]{3}$", strict=True)
    rate: str = Field(pattern=r"^(0|[1-9][0-9]{0,12})(\.[0-9]{1,8})?$", max_length=22, strict=True)
    date: dt.date
    fetched_at: dt.datetime

    @field_validator("rate")
    @classmethod
    def validate_rate(cls, value: str) -> str:
        if not Decimal(value).is_finite() or Decimal(value) <= 0:
            raise ValueError("Exchange rate must be positive and finite")
        return value

    @field_validator("fetched_at")
    @classmethod
    def validate_timestamp(cls, value: dt.datetime) -> dt.datetime:
        if value.utcoffset() is None:
            raise ValueError("Exchange timestamp must include a timezone")
        return value


class ExchangeRates:
    """Persist one provider attempt per currency pair and local calendar day."""

    def __init__(
        self,
        path: Path,
        config: ExchangeConfig,
        timezone: str,
        currency: str,
        clock: Callable[[], dt.datetime],
    ) -> None:
        if currency != "INR":
            raise ValueError("Exchange target currency must be INR")
        self.path = path
        self.config = config
        self.timezone = ZoneInfo(timezone)
        self.currency = currency
        self.clock = clock
        self.lock = asyncio.Lock()
        self.db: sqlite3.Connection | None = None

    async def open(self) -> None:
        """Open the dedicated database; infrastructure failures abort startup."""
        async with self.lock:
            if self.db is not None:
                return
            # Autocommit makes reservations durable without a cancellation checkpoint.
            db = sqlite3.connect(self.path, isolation_level=None, timeout=0)
            try:
                db.execute(
                    """CREATE TABLE IF NOT EXISTS exchange_rates (
                        base TEXT NOT NULL,
                        quote TEXT NOT NULL,
                        day TEXT NOT NULL,
                        fetched_at TEXT NOT NULL,
                        rate TEXT,
                        date TEXT,
                        PRIMARY KEY (base, quote, day)
                    )"""
                )
            except sqlite3.Error:
                db.close()
                raise
            self.db = db

    async def close(self) -> None:
        async with self.lock:
            if self.db is not None:
                self.db.close()
                self.db = None

    async def get(self, source: str) -> ExchangeRate | None:
        """Return only today's successful lookup, never a prior-day fallback."""
        if re.fullmatch(r"[A-Z]{3}", source) is None or source == self.currency:
            return None
        async with self.lock:
            if self.db is None:
                return None
            fetched_at = self.clock()
            day = fetched_at.astimezone(self.timezone).date()
            result: ExchangeRate | None
            try:
                reserved = (
                    self.db.execute(
                        """INSERT OR IGNORE INTO exchange_rates (base, quote, day, fetched_at)
                       VALUES (?, ?, ?, ?)""",
                        (source, self.currency, day.isoformat(), fetched_at.isoformat()),
                    ).rowcount
                    == 1
                )
                if not reserved:
                    row = self.db.execute(
                        """SELECT rate, date, fetched_at FROM exchange_rates
                           WHERE base = ? AND quote = ? AND day = ?""",
                        (source, self.currency, day.isoformat()),
                    ).fetchone()
                    if row is None or row[0] is None or row[1] is None:
                        return None
                    result = ExchangeRate(
                        base=source,
                        quote=self.currency,
                        rate=row[0],
                        date=row[1],
                        fetched_at=row[2],
                    )
                else:
                    result = await self.fetch(source)
                    if result is None:
                        return None
                if (
                    result.base != source
                    or result.quote != self.currency
                    or result.fetched_at.astimezone(self.timezone).date() != day
                    or result.date > day
                ):
                    logger.warning("Exchange lookup rejected code=cacheValidation")
                    return None
                if reserved:
                    self.db.execute(
                        """UPDATE exchange_rates SET rate = ?, date = ?, fetched_at = ?
                           WHERE base = ? AND quote = ? AND day = ?""",
                        (
                            result.rate,
                            result.date.isoformat(),
                            result.fetched_at.isoformat(),
                            source,
                            self.currency,
                            day.isoformat(),
                        ),
                    )
                if self.clock().astimezone(self.timezone).date() != day:
                    return None
                return result
            except (sqlite3.Error, ValueError) as error:
                logger.warning("Exchange lookup failed type=%s", type(error).__name__)
                return None

    async def fetch(self, source: str) -> ExchangeRate | None:
        """Fetch and validate one bounded Frankfurter v2 response without retries."""
        if re.fullmatch(r"[A-Z]{3}", source) is None or source == self.currency:
            return None
        fetched_at = self.clock()
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self.config.timeout_seconds),
                trust_env=False,
                middlewares=(single_request,),
            ) as session:
                async with session.get(
                    f"https://api.frankfurter.dev/v2/rate/{source}/{self.currency}",
                    allow_redirects=False,
                ) as response:
                    if response.status != 200:
                        logger.warning("Exchange provider rejected status=%s", response.status)
                        return None
                    body = bytearray()
                    async for chunk in response.content.iter_chunked(MAX_BYTES + 1):
                        body.extend(chunk)
                        if len(body) > MAX_BYTES:
                            logger.warning("Exchange provider rejected code=payloadLimit")
                            return None
            payload = json.loads(body, parse_float=Decimal, parse_int=Decimal)
            if (
                not isinstance(payload, dict)
                or payload.get("base") != source
                or payload.get("quote") != self.currency
                or not isinstance(payload.get("date"), str)
                or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", payload["date"]) is None
                or not isinstance(payload.get("rate"), Decimal)
            ):
                raise ValueError("Invalid provider fields")
            reference = dt.date.fromisoformat(payload["date"])
            if reference > fetched_at.astimezone(self.timezone).date():
                raise ValueError("Future provider reference date")
            rate = payload["rate"]
            if not rate.is_finite() or rate <= 0:
                raise ValueError("Invalid provider rate")
            with localcontext() as context:
                context.prec = 30
                rate = rate.quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)
            return ExchangeRate(
                base=source,
                quote=self.currency,
                rate=format(rate, "f"),
                date=reference,
                fetched_at=fetched_at,
            )
        except (
            aiohttp.ClientError,
            TimeoutError,
            ValueError,
            InvalidOperation,
            RecursionError,
        ) as error:
            logger.warning("Exchange provider failed type=%s", type(error).__name__)
            return None
