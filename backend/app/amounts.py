# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from decimal import ROUND_HALF_UP, Decimal, localcontext
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import MoneyInput, Status


def money_value(value: "MoneyInput", limit: int | None = None) -> tuple[int | None, "Status"]:
    """Derive INR once using owner-bound direction, without guessing rates or fees."""
    with localcontext() as context:
        context.prec = 60
        amount = None if value.amount is None else Decimal(value.amount) * 100
        conversion = value.conversion
        fee = (
            Decimal(conversion.fee) * 100
            if conversion is not None and conversion.fee is not None
            else None
        )
        if limit is not None and any(item > limit for item in (amount, fee) if item is not None):
            raise ValueError("Money exceeds the configured per-amount limit")
        if conversion is None:
            return (None if amount is None else int(amount)), value.status
        if (
            amount is None
            or conversion.rate is None
            or (
                conversion.direction != "valuation"
                and fee is None
                and conversion.provider != "frankfurter"
            )
        ):
            return None, "unknown"
        # The fee is in INR paise, so the exchange rate applies only to the source amount.
        net = amount * Decimal(conversion.rate)
        if conversion.direction != "valuation":
            if fee is not None:
                net += fee if conversion.direction == "payment" else -fee
        if net < 0:
            raise ValueError("Conversion fee exceeds the converted receipt; net INR is negative")
        if limit is not None and net > limit:
            raise ValueError("Converted money exceeds the configured per-amount limit")
        status: Status = (
            "exact"
            if conversion.provider != "frankfurter"
            and value.status == conversion.rate_status == "exact"
            and (conversion.direction == "valuation" or conversion.fee_status == "exact")
            else "estimate"
        )
        return int(net.quantize(Decimal(1), rounding=ROUND_HALF_UP)), status
