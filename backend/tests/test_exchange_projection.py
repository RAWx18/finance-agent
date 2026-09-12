# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import timedelta

import pytest

from app.finance import calculate, export_text, normalize
from app.models import FactsInput

from .conftest import NOW, facts, money, parsed_command, record
from .test_exchange_store import exchange_store as exchange_store
from .test_exchange_store import operation


def foreign(amount):
    return {
        "amount": amount,
        "status": "exact",
        "conversion": {"currency": "USD", "fee": "0", "feeStatus": "exact"},
    }


@pytest.mark.parametrize("bill", [False, True])
@pytest.mark.parametrize("available", [False, True])
async def test_opening_evidence_uses_plan_observation(exchange_store, bill, available):
    store, rates, clock = exchange_store
    data = facts(records=[record("bill", "essential", "100", "2026-09-15")] if bill else [])
    data["opening"] = foreign("20")
    request = parsed_command(data)
    saved = await store.command("owner", request)
    receipt = saved.model_dump_json()
    clock.return_value += timedelta(days=1)
    if not available:
        rates.fetch.side_effect = None
        rates.fetch.return_value = None
    refreshed = await store.get("owner")
    opening = 62000 if available else None
    assert refreshed.facts == saved.facts
    assert refreshed.facts.opening.amount_paise == 60000
    results = {item.id: item for item in refreshed.workspace.results}
    contributions = {item.id: item for item in refreshed.workspace.contributions}
    assert results["opening"].amount_paise == contributions["opening"].amount_paise == opening
    assert refreshed.plan.closing_paise == (opening - (10000 if bill else 0) if available else None)
    assert results["closing"].amount_paise == refreshed.plan.closing_paise
    assert results["trough"].amount_paise == refreshed.plan.trough_paise
    assert f"Opening: {'INR 620.00' if available else 'unknown'}" in export_text(refreshed)
    restored, _ = store.load_snapshot(refreshed.model_dump_json(by_alias=True))
    assert restored == refreshed
    assert (await store.command("owner", request)).model_dump_json() == receipt
    assert rates.fetch.await_count == 2


@pytest.mark.parametrize("available", [False, True])
async def test_conditional_income_witness_uses_current_opening(exchange_store, available):
    store, rates, clock = exchange_store
    data = facts(records=[record("income", "income", "100", "2026-09-15", reliability="uncertain")])
    data["opening"] = foreign("20")
    saved = await store.command("owner", parsed_command(data))
    clock.return_value += timedelta(days=1)
    if not available:
        rates.fetch.side_effect = None
        rates.fetch.return_value = None
    refreshed = await store.get("owner")
    results = {item.id: item.amount_paise for item in refreshed.workspace.results}
    assert results["income:reportedDate:closing"] == (72000 if available else None)
    assert results["income:notByHorizon:closing"] == (62000 if available else None)
    assert refreshed.facts == saved.facts


async def test_undated_exclusions_use_current_target(exchange_store):
    store, _, clock = exchange_store
    debt = record("debt", "debt", "10", None, target=foreign("20"), outstanding=foreign("100"))
    debt["amount"] = foreign("10")
    saved = await store.command("owner", parsed_command(facts("1000", [debt])))
    clock.return_value += timedelta(days=1)
    refreshed = await store.get("owner")
    impact = refreshed.plan.undated_impact
    assert impact.items[0].required_paise == 31000
    assert impact.items[0].target_paise == impact.outflow_paise == 62000
    excluded = next(item for item in refreshed.workspace.contributions if item.id == "record:debt")
    assert excluded.amount_paise == 62000
    assert "outstanding INR 3100.00" in export_text(refreshed)
    assert refreshed.facts == saved.facts


@pytest.mark.parametrize("day", [None, "2026-09-15"])
async def test_market_target_crossing_remains_readable(exchange_store, day):
    store, _, clock = exchange_store
    debt = record("debt", "debt", "20", day, target=money("610"))
    debt["amount"] = foreign("20")
    request = parsed_command(facts("615", [debt]))
    saved = await store.command("owner", request)
    clock.return_value += timedelta(days=1)
    refreshed = await store.get("owner")
    assert refreshed.facts == saved.facts
    assert refreshed.plan.projection_partial
    assert any(item.code == "targetBelowRequired" for item in refreshed.plan.issues)
    assert any(
        item.id == "clarify:debt:targetBelowRequired"
        for item in refreshed.plan.decision_assessment.actions
    )
    assert refreshed.plan.planning_facts.records[0].target.amount_paise == 61000
    assert refreshed.plan.planning_facts.records[0].amount.amount_paise == 62000
    if day:
        assert (
            refreshed.plan.events[0].amount_paise
            == refreshed.plan.events[0].required_paise
            == 62000
        )
        assert refreshed.plan.closing_paise == -500
    else:
        assert refreshed.plan.undated_impact.outflow_paise == 62000
        assert refreshed.plan.undated_impact.items[0].target_paise == 61000
        assert refreshed.plan.budget_basis.unresolved_amounts[0].amount.amount_paise == 62000
        assert (
            next(
                item.amount_paise
                for item in refreshed.workspace.contributions
                if item.id == "record:debt"
            )
            == 62000
        )
    assert store.load_snapshot(refreshed.model_dump_json(by_alias=True))[0] == refreshed
    assert await store.command("owner", request) == saved


def test_source_target_validation_stays_strict(config):
    with pytest.raises(ValueError, match="below its required"):
        normalize(
            FactsInput.model_validate(
                facts("0", [record("debt", "debt", "620", None, target=money("610"))])
            ),
            config,
        )


async def test_projection_is_pure_and_none_differs_from_failed_observation(exchange_store):
    store, _, _ = exchange_store
    data = facts()
    data["opening"] = foreign("20")
    saved = await store.command("owner", parsed_command(data))
    historical = saved.facts.model_dump_json()
    captured = calculate(saved.facts, NOW.date(), store.config)
    unavailable = calculate(saved.facts, NOW.date(), store.config, exchange_rates={})
    assert captured.closing_paise == 60000
    assert unavailable.closing_paise is None
    assert saved.facts.model_dump_json() == historical


@pytest.mark.parametrize("available", [False, True])
async def test_current_money_includes_all_records_and_variable_occurrences(
    exchange_store, available
):
    store, rates, clock = exchange_store
    debt = record("debt", "debt", "10", None, target=foreign("20"), outstanding=foreign("100"))
    debt["amount"] = foreign("10")
    variable = record(
        "variable",
        "essential",
        None,
        None,
        schedule={"date": None, "recurrence": "monthly", "amounts": [foreign("10"), foreign("20")]},
    )
    variable["amount"] = money(None, "unknown")
    outside = record("outside", "optional", "5", "2027-01-01")
    outside["amount"] = foreign("5")
    saved = await store.command("owner", parsed_command(facts("1000", [debt, variable, outside])))
    clock.return_value += timedelta(days=1)
    if not available:
        rates.fetch.side_effect = None
        rates.fetch.return_value = None
    refreshed = await store.get("owner")
    records = {item.id: item for item in refreshed.plan.planning_facts.records}
    assert records["debt"].amount.amount_paise == (31000 if available else None)
    assert records["debt"].target.amount_paise == (62000 if available else None)
    assert records["debt"].outstanding.amount_paise == (310000 if available else None)
    assert records["outside"].amount.amount_paise == (15500 if available else None)
    assert [item.amount_paise for item in refreshed.plan.occurrence_amounts["variable"]] == (
        [31000, 62000] if available else [None, None]
    )
    assert refreshed.facts == saved.facts
    assert "index 0: calculated " + ("INR 310.00" if available else "unknown") in export_text(
        refreshed
    )


async def test_accepted_and_preview_evidence_keep_event_adjustments(exchange_store):
    store, _, clock = exchange_store
    data = facts(records=[record("outing", "optional", "700", "2026-09-15")])
    data["opening"] = foreign("20")
    saved = await store.command("owner", parsed_command(data))
    preview = await store.command(
        "owner",
        operation(
            saved,
            "previewAdjustments",
            adjustments=[{"eventId": "outing:2026-09-15", "amount": "100"}],
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
            adjustments=[{"eventId": "outing:2026-09-15", "amount": "200"}],
        ),
    )
    clock.return_value += timedelta(days=1)
    refreshed = await store.get("owner")
    results = {item.id: item.amount_paise for item in refreshed.workspace.results}
    assert results["opening"] == 62000
    assert results["closing"] == 52000
    assert results["proposal:closing"] == 42000
    assert results["impact:closing"] == -10000
    assert refreshed.accepted.plan.events[0].amount_paise == 10000
    assert refreshed.preview.plan.events[0].amount_paise == 20000
    assert refreshed.accepted.plan.planning_facts.records[0].amount.amount_paise == 70000
    assert refreshed.facts == saved.facts
    assert refreshed.preview.id == preview.preview.id


@pytest.mark.parametrize("fee", [None, "0", "10"])
async def test_reference_qualification_only_marks_unknown_fees(exchange_store, fee):
    store, _, _ = exchange_store
    item = record("payment", "essential", "20", "2026-09-15")
    item["amount"] = foreign("20")
    item["amount"]["conversion"].update(fee=fee, feeStatus="unknown" if fee is None else "exact")
    saved = await store.command("owner", parsed_command(facts("1000", [item])))
    message = next(issue.message for issue in saved.plan.issues if issue.code == "referenceRate")
    assert ("fees" in message) == (fee is None)
    assert saved.plan.outflow_paise == (61000 if fee == "10" else 60000)


@pytest.mark.parametrize("opening", [True, False])
async def test_unavailable_provider_is_not_a_missing_user_rate(exchange_store, opening):
    store, rates, _ = exchange_store
    rates.fetch.side_effect = None
    rates.fetch.return_value = None
    data = facts("1000", [] if opening else [record("bill", "essential", "20", "2026-09-15")])
    if opening:
        data["opening"] = foreign("20")
    else:
        data["records"][0]["amount"] = foreign("20")
    saved = await store.command("owner", parsed_command(data))
    assessment = saved.plan.decision_assessment
    assert not any("conversion" in item.id.lower() for item in assessment.actions)
    assert not any(item.id == "clarify:opening" for item in assessment.actions)
    assert any(
        "Frankfurter conversion is unavailable" in item.reason
        for item in assessment.uncertainties
    )
