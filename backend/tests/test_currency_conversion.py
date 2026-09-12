# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import json
from datetime import date
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.facts import facts_input, merge_facts, money_input
from app.finance import calculate, export_text, normalize
from app.finance import money as normalize_money
from app.models import FactsInput, FactsPatch, MoneyInput
from app.voice_tools import VoiceTools

from .conftest import facts, money, record
from .test_finance import project


def foreign(amount="1000", currency="USD", rate="80", fee="2000", **terms):
    return {
        "amount": amount,
        "status": "exact" if amount is not None else "unknown",
        "conversion": {
            "currency": currency,
            "rate": rate,
            "rateStatus": "exact" if rate is not None else "unknown",
            "rateDate": "2026-09-10",
            "fee": fee,
            "feeStatus": "exact" if fee is not None else "unknown",
            **terms,
        },
    }


def income(value):
    return record("work", "income", None, "2026-09-12") | {"amount": value}


def test_exact_conversion_and_multiple_currencies_round_trip(config):
    source = FactsInput.model_validate(
        facts(
            "500",
            [
                income(foreign()),
                record("euro", "income", None, "2026-09-13")
                | {"amount": foreign("100", "EUR", "90", "0")},
                record("salary", "income", "1000", "2026-09-14"),
            ],
        )
    )
    normalized = normalize(source, config)
    plan = calculate(normalized, date(2026, 9, 11), config)
    assert plan.reliable_income_paise == 8800000
    assert plan.closing_paise == 8850000
    event = plan.events[0]
    assert (event.amount_paise, event.amount_status, event.included) == (7800000, "exact", True)
    assert event.source == source.records[0].amount
    assert facts_input(normalized).records[:2] == source.records[:2]
    assert normalize(facts_input(normalized), config) == normalized
    assert money_input(normalized.records[0].amount) == source.records[0].amount
    assert normalized.records[2].amount.source is None


@pytest.mark.parametrize("field", ["rateStatus", "feeStatus", "amount"])
def test_estimated_conversion_is_only_conditional(field):
    value = foreign()
    if field == "amount":
        value["status"] = "estimate"
    else:
        value["conversion"][field] = "estimate"
    plan = project(facts("0", [income(value)]))
    assert plan.reliable_income_paise == 0
    assert plan.uncertain_income_paise == 7800000
    assert plan.events[0].amount_status == "estimate"
    assert plan.income_comparisons[0].metrics.closing_paise == 7800000
    assert plan.income_comparisons[1].metrics.closing_paise == 0


@pytest.mark.parametrize("term", ["rate", "fee"])
def test_unknown_conversion_names_the_missing_term(term):
    value = foreign(**{term: None})
    plan = project(facts("0", [income(value)]))
    assert plan.events[0].amount_paise is None
    assert plan.events[0].source.amount == "1000"
    assert plan.projection_partial and not plan.budget_basis.dated_projection_complete
    question = next(
        item
        for item in plan.decision_assessment.uncertainties
        if item.field == f"amount.conversion.{term}"
    )
    assert term in question.question.lower() and "USD" in question.question
    assert not any(item.id == "work:amount" for item in plan.decision_assessment.uncertainties)


def test_omitted_fee_is_not_zero():
    value = foreign()
    del value["conversion"]["fee"]
    del value["conversion"]["feeStatus"]
    assert project(facts("0", [income(value)])).events[0].amount_paise is None


@pytest.mark.parametrize(
    "amount,rate,fee,expected",
    [
        ("0.01", "0.5", "0", 1),
        ("1", "1.23456789", "0.01", 122),
        ("1", "0.005", "0", 1),
        ("1000", "80", "80000", 0),
    ],
)
def test_decimal_precision_rounds_net_once(amount, rate, fee, expected):
    plan = project(facts("0", [income(foreign(amount, rate=rate, fee=fee))]))
    assert plan.events[0].amount_paise == expected


@pytest.mark.parametrize(
    "terms",
    [
        {"currency": "INR"},
        {"currency": "usd"},
        {"currency": "US"},
        {"currency": "US1"},
        {"rate": "0"},
        {"rate": "-1"},
        {"rate": "1e2"},
        {"rate": "NaN"},
        {"rate": "1.123456789"},
        {"rate": 80},
        {"rateDate": "2026-02-31"},
        {"fee": "-1"},
        {"rateStatus": "unknown"},
        {"feeStatus": "unknown"},
    ],
)
def test_invalid_conversion_schema(terms):
    value = foreign()
    value["conversion"].update(terms)
    with pytest.raises(ValidationError):
        MoneyInput.model_validate(value)


@pytest.mark.parametrize(
    "value",
    [
        foreign("1", fee="81"),
        foreign("10000000000", fee="0"),
        foreign("10000000001", rate=None),
        foreign("1", fee="10000000001", rate=None),
    ],
)
def test_conversion_limits_and_negative_net(value):
    with pytest.raises(ValueError):
        project(facts("0", [income(value)]))


@pytest.mark.parametrize(
    "location", ["opening", "essential", "debt", "target", "outstanding", "payment", "cost"]
)
def test_foreign_money_is_income_only(location):
    data = facts("0", [record("bill", "debt", "100", "2026-09-12")])
    if location == "opening":
        data["opening"] = foreign()
    elif location in {"essential", "debt"}:
        data["records"] = [record("bill", location, None, "2026-09-12") | {"amount": foreign()}]
    elif location in {"target", "outstanding"}:
        data["records"][0][location] = foreign()
    else:
        data["providerResponses"] = [
            {
                "eventId": "bill:2026-09-12",
                "status": "reportedTerms",
                "reportedOn": "2026-09-11",
                location: foreign(),
            }
        ]
    with pytest.raises(ValueError):
        project(data)


async def test_voice_store_sse_source_correction_and_cache_rebuild(store):
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    stream = await store.subscribe("owner")
    stream.get_nowait()
    try:
        state = await tools.update_facts(
            {
                "expectedRevision": 0,
                "opening": money("500"),
                "records": [
                    {key: value for key, value in income(foreign()).items() if key != "id"},
                    {
                        key: value
                        for key, value in record("Rent", "essential", "100", "2026-09-13").items()
                        if key != "id"
                    },
                ],
            },
            "foreign-income",
        )
        snapshot = stream.get_nowait()
        assert state["snapshot"] == snapshot.model_dump(mode="json", by_alias=True)
        identity = snapshot.facts.records[0].id
        state = await tools.update_facts(
            {
                "expectedRevision": 1,
                "records": [
                    {
                        "id": identity,
                        "amount": {
                            "amount": "1000",
                            "status": "exact",
                            "conversion": {"currency": "USD", "rate": "81", "rateStatus": "exact"},
                        },
                    }
                ],
            },
            "rate-correction",
        )
        snapshot = stream.get_nowait()
        assert snapshot.facts.records[0].amount.amount_paise == 7900000
        assert snapshot.facts.records[0].amount.source.conversion.fee == "2000"
        assert snapshot.facts.records[1].amount.amount_paise == 10000
        assert (await store.get("owner")) == snapshot
        assert state["snapshot"] == snapshot.model_dump(mode="json", by_alias=True)
        source = snapshot.facts.records[0].amount.source
        assert source.conversion.rate_date == date(2026, 9, 10)
        payload = snapshot.model_dump(mode="json", by_alias=True)
        payload["facts"]["records"][0]["amount"]["amountPaise"] = 7
        payload["facts"]["records"][0]["amount"]["source"]["conversion"]["fee"] = "3000"
        rebuilt, _ = store.load_snapshot(json.dumps(payload))
        assert rebuilt.facts.records[0].amount.amount_paise == 7800000
        assert rebuilt.plan.reliable_income_paise == 7800000
        rebuilt.facts.records[0].amount.source.conversion.rate = "82"
        plan = calculate(rebuilt.facts, rebuilt.anchor_date, store.config)
        assert plan.reliable_income_paise == 7900000
        text = export_text(snapshot)
        assert all(
            term in text
            for term in ("USD 1000", "rate 81", "INR fee 2000", "2026-09-10", "net INR")
        )
        assert any(item.reason == "currencyConversion" for item in snapshot.workspace.contributions)
    finally:
        store.unsubscribe("owner", stream)


async def test_foreign_conflicts_keep_original_units_and_resolution(store):
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    state = await tools.update_facts(
        {
            "expectedRevision": 0,
            "records": [
                {key: value for key, value in income(foreign(rate=None)).items() if key != "id"}
            ],
        },
        "source",
    )
    identity = state["snapshot"]["facts"]["records"][0]["id"]
    alternative = {"id": "euro", **foreign("900", "EUR", None, None), "status": "estimate"}
    state = await tools.update_facts(
        {
            "expectedRevision": 1,
            "conflicts": [{"recordId": identity, "field": "amount", "values": [alternative]}],
        },
        "conflicting-currency",
    )
    conflict = state["snapshot"]["facts"]["conflicts"][0]
    assert len(conflict["values"]) == 2
    assert {value["source"]["conversion"]["currency"] for value in conflict["values"]} == {
        "USD",
        "EUR",
    }
    assert all(value["amountPaise"] is None for value in conflict["values"])
    state = await tools.update_facts(
        {
            "expectedRevision": 2,
            "resolutions": [
                {"conflictId": conflict["id"], "value": {**alternative, "status": "exact"}}
            ],
        },
        "choose-source",
    )
    assert state["snapshot"]["facts"]["conflicts"] == []
    assert state["activePlan"]["events"][0]["source"]["conversion"]["currency"] == "EUR"
    value = (await store.get("owner")).facts.records[0].amount
    assert value.source.amount == "900" and value.source.status == "exact"
    assert value.amount_paise is None and value.status == "unknown"
    assert (
        value.source.conversion.model_dump(mode="json", by_alias=True) == alternative["conversion"]
    )


@pytest.mark.parametrize("status,confirmed", [("estimate", "exact"), ("exact", "estimate")])
@pytest.mark.parametrize("rate_status", ["exact", "estimate"])
def test_foreign_resolution_changes_only_source_certainty(config, status, confirmed, rate_status):
    saved = normalize(FactsInput.model_validate(facts("0", [income(foreign())])), config)
    alternative = {
        "id": "euro",
        **foreign("900", "EUR", "90", "0", rateStatus=rate_status),
        "status": status,
    }
    disputed = normalize(
        merge_facts(
            saved,
            FactsPatch.model_validate(
                {
                    "expectedRevision": 0,
                    "conflicts": [{"recordId": "work", "field": "amount", "values": [alternative]}],
                }
            ),
            uuid4(),
        ),
        config,
    )
    resolved = normalize(
        merge_facts(
            disputed,
            FactsPatch.model_validate(
                {
                    "expectedRevision": 0,
                    "resolutions": [
                        {
                            "conflictId": disputed.conflicts[0].id,
                            "value": {**alternative, "status": confirmed},
                        }
                    ],
                }
            ),
            uuid4(),
        ),
        config,
    )
    expected = MoneyInput.model_validate(
        {key: value for key, value in alternative.items() if key != "id"} | {"status": confirmed}
    )
    assert resolved.conflicts == []
    assert resolved.records[0].amount.source == expected
    assert resolved.records[0].amount.amount_paise == 8100000
    plan = calculate(resolved, date(2026, 9, 11), config)
    exact = confirmed == rate_status == "exact"
    assert plan.events[0].source == expected
    assert plan.events[0].amount_status == ("exact" if exact else "estimate")
    assert plan.events[0].included == exact
    assert plan.reliable_income_paise == (8100000 if exact else 0)
    assert plan.uncertain_income_paise == (0 if exact else 8100000)
    assert plan.closing_paise == plan.reliable_income_paise


@pytest.mark.parametrize(
    "replacement",
    [
        foreign("901", "EUR", "90", "0"),
        foreign("900", "EUR", "91", "0"),
        foreign("1800", "EUR", "45", "0"),
        foreign("900", "USD", "90", "0"),
        foreign("900", "EUR", "90", "1"),
        foreign("900", "EUR", "90", "0", rateStatus="estimate"),
        foreign("900", "EUR", "90", "0", feeStatus="estimate"),
        foreign("900", "EUR", "90", "0", rateDate="2026-09-11"),
        {**money("81000"), "conversion": None},
    ],
)
def test_foreign_resolution_reused_id_rejects_changed_source_terms(config, replacement):
    saved = normalize(FactsInput.model_validate(facts("0", [income(foreign())])), config)
    disputed = normalize(
        merge_facts(
            saved,
            FactsPatch.model_validate(
                {
                    "expectedRevision": 0,
                    "conflicts": [
                        {
                            "recordId": "work",
                            "field": "amount",
                            "values": [
                                {
                                    "id": "euro",
                                    **foreign("900", "EUR", "90", "0"),
                                    "status": "estimate",
                                }
                            ],
                        }
                    ],
                }
            ),
            uuid4(),
        ),
        config,
    )
    before = disputed.model_copy(deep=True)
    with pytest.raises(ValueError, match="Competing value ID"):
        merge_facts(
            disputed,
            FactsPatch.model_validate(
                {
                    "expectedRevision": 0,
                    "resolutions": [
                        {
                            "conflictId": disputed.conflicts[0].id,
                            "value": {"id": "euro", **replacement},
                        }
                    ],
                }
            ),
            uuid4(),
        )
    assert disputed == before


async def test_conversion_correction_reopens_answer_without_reasking_source(store):
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    state = await tools.update_facts(
        {
            "expectedRevision": 0,
            "opening": money("0"),
            "records": [
                {key: value for key, value in income(foreign(fee=None)).items() if key != "id"}
            ],
        },
        "unknown-fee",
    )
    identity = state["snapshot"]["facts"]["records"][0]["id"]
    assert any(
        item["actionId"] == f"clarify:{identity}:conversionFee" for item in state["actionResponses"]
    )
    state = await tools.update_facts(
        {
            "expectedRevision": 1,
            "records": [{"id": identity, "amount": money("1100")}],
        },
        "source-amount-correction",
    )
    assert state["snapshot"]["facts"]["records"][0]["amount"]["source"]["conversion"]["fee"] is None
    assert not any(
        item["actionId"] == f"clarify:{identity}:conversionFee" for item in state["actionResponses"]
    )
    assert any(
        item["fields"] == ["amount.conversion.fee"] for item in state["workspace"]["questions"]
    )


def test_currency_change_does_not_reuse_another_currency_rate(config):
    saved = normalize(FactsInput.model_validate(facts("0", [income(foreign())])), config)
    patch = FactsPatch.model_validate(
        {
            "expectedRevision": 0,
            "records": [
                {
                    "id": "work",
                    "amount": {
                        "amount": "1000",
                        "status": "exact",
                        "conversion": {"currency": "EUR"},
                    },
                }
            ],
        }
    )
    corrected = normalize(merge_facts(saved, patch, uuid4()), config)
    value = corrected.records[0].amount
    assert value.amount_paise is None and value.status == "unknown"
    assert value.source.conversion.currency == "EUR"
    assert value.source.conversion.rate is None and value.source.conversion.fee is None
    assert value.source.conversion.rate_date is None


def test_converted_limit_boundary_and_tiny_rates(config):
    value = MoneyInput.model_validate(
        foreign("1", rate=str(config.max_money_paise // 100), fee="0")
    )
    assert normalize_money(value, config).amount_paise == config.max_money_paise
    value = MoneyInput.model_validate(foreign("1", rate="0.00000001", fee="0"))
    assert normalize_money(value, config).amount_paise == 0
