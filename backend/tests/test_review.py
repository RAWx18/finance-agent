# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import timedelta

from app.store import owner_hash

from .conftest import NOW, command, facts, money, parsed_command, record
from .test_finance import project


def test_auto_debit_risk_does_not_depend_on_record_ids():
    """Verify same-day auto-debit warnings do not depend on record identifier ordering."""
    records = [
        record("a", "debt", "400", "2026-09-15", autoDebit=True, label="Loan"),
        record("z", "essential", "300", "2026-09-15", label="Food"),
    ]
    plan = project(facts("500", records))
    records[0]["id"], records[1]["id"] = "z", "a"
    reordered = project(facts("500", records))
    warnings = [issue.message for issue in plan.issues if issue.code == "autoDebitRisk"]
    assert len(warnings) == 1
    assert warnings == [
        issue.message for issue in reordered.issues if issue.code == "autoDebitRisk"
    ]
    assert "2026-09-15" in warnings[0] and "timing" in warnings[0]


def test_first_day_gap_does_not_depend_on_record_ids():
    """Verify first-day and peak gaps do not depend on same-day record identifier ordering."""
    records = [
        record("a", "essential", "100", "2026-09-15"),
        record("z", "debt", "200", "2026-09-15"),
        record("later", "essential", "50", "2026-09-16"),
    ]
    plan = project(facts("0", records))
    records[0]["id"], records[1]["id"] = "z", "a"
    reordered = project(facts("0", records))
    assert plan.first_gap == reordered.first_gap
    assert plan.first_gap.amount_paise == 30000
    assert plan.peak_gap_paise == reordered.peak_gap_paise == 35000


def test_export_preserves_record_amounts_and_uncertainty(client):
    """Verify exports retain estimates, undated amounts, and distinct card minimums and targets."""
    client.post("/api/session", json={})
    data = facts(
        "10000",
        [
            record("rent", "essential", "3000", "2026-09-15", label="Rent"),
            record("food", "essential", "2000", "2026-09-16", label="Food"),
            record("power", "essential", "1500", None, label="Electricity"),
            record(
                "card",
                "debt",
                "500",
                "2026-09-18",
                label="Card",
                debtType="card",
                target=money("1000"),
                outstanding=money("25000"),
            ),
        ],
    )
    data["records"][1]["amount"] = money("2000", "estimate")
    assert client.post("/api/session/commands", json=command(data)).status_code == 200
    text = client.get("/api/session/export").text
    food = next(line for line in text.splitlines() if "Food [food]" in line)
    assert "INR 2000.00" in food and "estimate" in food
    power = next(line for line in text.splitlines() if "Unresolved date" in line)
    assert "Electricity" in power and "INR 1500.00" in power and "excluded" in power
    card = next(line for line in text.splitlines() if "Card [card]" in line)
    assert "target" in card and "INR 1000.00" in card and "INR 500.00" in card
    assert any("Food [food]" in line and "reported estimate" in line for line in text.splitlines())


async def test_unrelated_edit_does_not_refresh_financial_basis(store):
    """Verify an unrelated edit advances revision without refreshing the cash basis or expiry."""
    owner = owner_hash("basis-test")
    initial = await store.create(owner)
    await store.command(owner, parsed_command(facts("5000")))
    store.clock = lambda: NOW + timedelta(hours=18)
    result = await store.command(owner, parsed_command(facts("5000"), 1))
    assert result.as_of == initial.as_of
    assert result.anchor_date == initial.anchor_date
    assert result.expires_at == initial.expires_at
    assert result.revision == 2
