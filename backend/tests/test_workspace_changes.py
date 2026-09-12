# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from app.models import Command, FactsPatch, UpdateFacts

from .conftest import facts, money, parsed_command, record


async def test_change_references_cover_fact_and_dependent_cards_without_rekeying(store):
    await store.create("owner")
    baseline = await store.command(
        "owner",
        parsed_command(
            facts(
                "5000",
                [
                    record("salary", "income", "50000", "2026-09-20"),
                    record("rent", "essential", "15000", "2026-09-15"),
                ],
            )
        ),
    )
    command = parsed_command(facts(), baseline.revision)
    corrected = await store.command(
        "owner",
        Command(
            command_id=command.command_id,
            expected_revision=baseline.revision,
            operation=UpdateFacts(
                type="updateFacts",
                changes=FactsPatch.model_validate(
                    {
                        "expectedRevision": baseline.revision,
                        "records": [{"id": "salary", "amount": money("60000")}],
                    }
                ),
            ),
        ),
    )
    assert [item.id for item in corrected.workspace.cards] == [
        item.id for item in baseline.workspace.cards
    ]
    changed = {card_id for item in corrected.workspace.change.items for card_id in item.card_ids}
    assert changed == {"cash", "timeline"}
    assert corrected.plan.first_gap == baseline.plan.first_gap
    assert corrected.plan.closing_paise == baseline.plan.closing_paise + 1000000
    assert await store.get("owner") == corrected


async def test_later_receipt_has_one_active_contribution_even_with_conditional_comparisons(store):
    await store.create("owner")
    snapshot = await store.command(
        "owner",
        parsed_command(
            facts(
                "5000",
                [
                    record("rent", "essential", "15000", "2026-09-15"),
                    record("salary", "income", "50000", "2026-09-20", reliability="uncertain"),
                ],
            )
        ),
    )
    gap = next(item for item in snapshot.workspace.results if item.id == "firstGap")
    active = set(gap.contribution_ids + gap.excluded_ids)
    assert (
        len([item for item in snapshot.workspace.contributions if item.record_id == "salary"]) == 3
    )
    assert [
        item.id
        for item in snapshot.workspace.contributions
        if item.record_id == "salary" and item.id in active
    ] == ["event:salary:2026-09-20"]
    assert gap.excluded_reasons["event:salary:2026-09-20"] == "conditionalReceipt"
