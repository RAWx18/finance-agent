# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from decimal import ROUND_HALF_UP, Decimal, localcontext
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import MoneyInput, Status


def money_value(value: "MoneyInput", limit: int | None = None) -> tuple[int | None, "Status"]:
    """Derive net INR once from reported terms, without guessing missing fees or rates."""
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
        if amount is None or conversion.rate is None or fee is None:
            return None, "unknown"
        net = amount * Decimal(conversion.rate) - fee
        if net < 0:
            raise ValueError("Conversion fee exceeds the converted income; net INR is negative")
        if limit is not None and net > limit:
            raise ValueError("Converted income exceeds the configured per-amount limit")
        status: Status = (
            "exact"
            if value.status == conversion.rate_status == conversion.fee_status == "exact"
            else "estimate"
        )
        return int(net.quantize(Decimal(1), rounding=ROUND_HALF_UP)), status
