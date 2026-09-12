# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import date
from uuid import uuid4

import pytest

from app.facts import facts_input, merge_facts
from app.finance import calculate, normalize
from app.models import Facts, FactsInput, FactsPatch, Money

from .conftest import facts, record
from .test_currency_conversion import foreign


@pytest.mark.parametrize("kind", ["income", "essential", "optional", "debt"])
@pytest.mark.parametrize("currency", ["USD", "EUR", "GBP"])
def test_unknown_monthly_fx_then_correct_quote(kind, currency, config):
    """Quotes remain unknown until terms are supplied, then follow the owning cash direction."""
    data = facts(
        "10000",
        [
            record("item", kind, "0", "2026-09-12")
            | {
                "amount": foreign("50", currency, None, None),
                "schedule": {"date": "2026-09-12", "recurrence": "monthly"},
            }
        ],
    )
    saved = normalize(FactsInput.model_validate(data), config)
    plan = calculate(saved, date(2026, 9, 11), config)
    assert saved.records[0].amount.source.amount == "50"
    assert saved.records[0].amount.amount_paise is None
    assert plan.events[0].amount_paise is None and not plan.events[0].included
    assert plan.projection_partial
    assert any(issue.code == "unknownConversion" for issue in plan.issues)
    changes = FactsPatch.model_validate(
        {
            "expectedRevision": 0,
            "records": [
                {
                    "id": "item",
                    "amount": foreign("50", currency, "80", "10", direction="valuation"),
                }
            ],
        }
    )
    saved = normalize(merge_facts(saved, changes, uuid4()), config)
    expected = 399000 if kind == "income" else 401000
    assert saved.records[0].amount.amount_paise == expected
    assert calculate(saved, date(2026, 9, 11), config).events[0].amount_paise == expected
    payload = saved.model_dump(mode="json", by_alias=True)
    payload["records"][0]["amount"]["amountPaise"] = 1
    payload["records"][0]["amount"]["source"]["conversion"]["direction"] = "valuation"
    saved = Facts.model_validate(payload)
    assert saved.records[0].amount.amount_paise == expected
    assert Money.model_validate(saved.records[0].amount.model_dump()).amount_paise == expected
    assert normalize(facts_input(saved), config) == saved


@pytest.mark.parametrize("field", ["amount", "target", "outstanding"])
def test_debt_fields_and_conflicts_use_independent_quotes(field, config):
    """Debt payments include their own fee once; outstanding is a rate-only valuation."""
    data = facts(
        "10000",
        [
            record("card", "debt", "1", "2026-09-12")
            | {
                field: foreign("50", "GBP", "80", "10"),
            }
        ],
    )
    saved = normalize(FactsInput.model_validate(data), config)
    assert getattr(saved.records[0], field).amount_paise == (
        400000 if field == "outstanding" else 401000
    )
    patch = FactsPatch.model_validate(
        {
            "expectedRevision": 0,
            "conflicts": [
                {
                    "recordId": "card",
                    "field": field,
                    "values": [{"id": "quote", **foreign("60", "EUR", "80", "10")}],
                }
            ],
        }
    )
    saved = normalize(merge_facts(saved, patch, uuid4()), config)
    value = next(item for item in saved.conflicts[0].values if item.id == "quote")
    assert value.amount_paise == (480000 if field == "outstanding" else 481000)
    calculate(saved, date(2026, 9, 11), config)
    payload = saved.model_dump(mode="json", by_alias=True)
    for value in payload["conflicts"][0]["values"]:
        value["source"]["conversion"]["direction"] = "receipt"
    saved = Facts.model_validate(payload)
    assert saved.conflicts[0].values[-1].amount_paise == (
        480000 if field == "outstanding" else 481000
    )
    patch = FactsPatch.model_validate(
        {
            "expectedRevision": 0,
            "resolutions": [
                {
                    "conflictId": saved.conflicts[0].id,
                    "value": {"id": "quote", **foreign("60", "EUR", "80", "10")},
                }
            ],
        }
    )
    saved = normalize(merge_facts(saved, patch, uuid4()), config)
    assert not saved.conflicts
    assert getattr(saved.records[0], field).source.conversion.currency == "EUR"
    assert getattr(saved.records[0], field).amount_paise == (
        480000 if field == "outstanding" else 481000
    )


def test_target_replaces_minimum_and_outstanding_never_becomes_payment(config):
    """Independent debt fees must not be added across required, target and balance fields."""
    saved = normalize(
        FactsInput.model_validate(
            facts(
                "10000",
                [
                    record("card", "debt", "0", "2026-09-12")
                    | {
                        "amount": foreign("20", rate="80", fee="10"),
                        "target": foreign("50", rate="80", fee="10"),
                        "outstanding": foreign("100", rate="80", fee="10"),
                    },
                ],
            )
        ),
        config,
    )
    plan = calculate(saved, date(2026, 9, 11), config)
    assert plan.outflow_paise == 401000
    assert plan.events[0].required_paise == 161000
    assert saved.records[0].outstanding.amount_paise == 800000


@pytest.mark.parametrize("kind", ["income", "essential", "optional", "debt"])
def test_finite_occurrence_quotes_and_fee_larger_than_outflow(kind, config):
    """Every occurrence is converted separately without duplicating the scalar amount."""
    saved = normalize(
        FactsInput.model_validate(
            facts(
                "10000",
                [
                    record("item", kind, "0", "2026-09-12")
                    | {
                        "amount": {"amount": None, "status": "unknown"},
                        "schedule": {
                            "date": "2026-09-12",
                            "recurrence": "weekly",
                            "amounts": [
                                foreign("50", "USD", "80", "10"),
                                foreign("20", "EUR", None, None),
                            ],
                        },
                    },
                ],
            )
        ),
        config,
    )
    plan = calculate(saved, date(2026, 9, 11), config)
    assert [event.amount_paise for event in plan.events] == [
        399000 if kind == "income" else 401000,
        None,
    ]
    assert all(event.source is not None for event in plan.events)
    assert not plan.events[1].included
    assert normalize(facts_input(saved), config) == saved
    if kind != "income":
        data = facts_input(saved).model_dump()
        data["records"][0]["schedule"]["amounts"][0] = foreign("1", rate="1", fee="10")
        saved = normalize(FactsInput.model_validate(data), config)
        assert calculate(saved, date(2026, 9, 11), config).events[0].amount_paise == 1100


def test_opening_and_provider_sparse_corrections_keep_source(config):
    """Amount-only and rate-only edits retain currency, date, fee and certainty."""
    saved = normalize(
        FactsInput.model_validate(
            facts("0", [])
            | {
                "opening": foreign("50", rate="80", fee="10"),
                "providerResponses": [
                    {
                        "eventId": "quote",
                        "status": "reportedTerms",
                        "reportedOn": "2026-09-11",
                        "payment": foreign("50", rate="80", fee="10"),
                    }
                ],
            }
        ),
        config,
    )
    patch = FactsPatch.model_validate(
        {
            "expectedRevision": 0,
            "opening": {"amount": "60", "status": "exact"},
            "providerResponses": [
                {
                    "eventId": "quote",
                    "status": "reportedTerms",
                    "reportedOn": "2026-09-11",
                    "payment": {"amount": "60", "status": "exact"},
                }
            ],
        }
    )
    saved = normalize(merge_facts(saved, patch, uuid4()), config)
    assert saved.opening.amount_paise == 479000
    assert saved.provider_responses[0].payment.amount_paise == 481000
    assert saved.provider_responses[0].payment.source.conversion.rate_date == date(2026, 9, 10)
    patch = FactsPatch.model_validate(
        {
            "expectedRevision": 0,
            "opening": {
                "amount": "60",
                "status": "exact",
                "conversion": {"currency": "USD", "rate": "81", "rateStatus": "exact"},
            },
        }
    )
    saved = normalize(merge_facts(saved, patch, uuid4()), config)
    assert saved.opening.amount_paise == 485000
    assert saved.opening.source.conversion.fee == "10"
    assert saved.opening.source.conversion.rate_date == date(2026, 9, 10)


def test_outstanding_valuation_does_not_invent_transaction_fee(config):
    """A balance valuation needs a rate, but is not an exchange transaction."""
    saved = normalize(
        FactsInput.model_validate(
            facts(
                "0",
                [
                    record("card", "debt", "0", "2026-09-12")
                    | {
                        "outstanding": foreign("20", "EUR", "80", None, rateDate=None),
                    },
                ],
            )
        ),
        config,
    )
    value = saved.records[0].outstanding
    assert value.amount_paise == 160000 and value.status == "exact"
    assert value.source.conversion.fee is None and value.source.conversion.fee_status == "unknown"
    assert value.source.conversion.rate_date is None


@pytest.mark.parametrize("kind", ["income", "essential", "optional", "debt"])
def test_bare_foreign_amount_retains_unknown_terms(kind, config):
    """A source-currency amount alone is usable evidence, not an implicit exchange quote."""
    saved = normalize(
        FactsInput.model_validate(
            facts(
                "0",
                [
                    record("item", kind, "0", "2026-09-12")
                    | {
                        "amount": {
                            "amount": "20",
                            "status": "exact",
                            "conversion": {"currency": "USD"},
                        },
                    },
                ],
            )
        ),
        config,
    )
    value = saved.records[0].amount
    assert value.amount_paise is None and value.status == "unknown"
    assert value.source.amount == "20" and value.source.status == "exact"
    assert value.source.conversion.rate is None and value.source.conversion.fee is None
    assert value.source.conversion.rate_status == value.source.conversion.fee_status == "unknown"
    assert value.source.conversion.rate_date is None
