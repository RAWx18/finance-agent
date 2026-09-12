# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from app.voice_tools import canonical
from app.workspace import project

from .conftest import facts, money, parsed_command, record
from .test_workspace import update


async def test_known_commitments_follow_dates_not_record_ids(store):
    """Keep nearer known bills visible regardless of their generated identifiers."""
    await store.create("owner")
    saved = await store.command(
        "owner",
        parsed_command(
            facts(
                "100000",
                [
                    record(identity, "essential", "1000", day)
                    for identity, day in (
                        ("z", "2026-09-13"),
                        ("y", "2026-09-14"),
                        ("x", "2026-09-15"),
                        ("a", "2026-09-20"),
                        ("b", "2026-09-21"),
                        ("c", "2026-09-22"),
                    )
                ],
            )
        ),
    )
    timeline = next(card for card in saved.workspace.cards if card.id == "timeline")
    assert timeline.record_ids == ["z", "y", "x", "a", "b", "c"]
    assert saved.plan.closing_paise == 9400000 and saved.plan.first_gap is None
    shuffled = saved.model_copy(deep=True)
    shuffled.facts.records.reverse()
    assert project(shuffled, store.config).cards == saved.workspace.cards
    corrected = await store.command(
        "owner", update(saved.revision, records=[{"id": "c", "amount": money("2000")}])
    )
    timeline = next(card for card in corrected.workspace.cards if card.id == "timeline")
    assert timeline.record_ids[:4] == ["c", "z", "y", "x"]
    assert corrected.plan.closing_paise == 9300000


async def test_visible_record_does_not_hide_unconfirmed_changeability(store):
    """Expose the actual blocking detail even when its amount and date are visible."""
    await store.create("owner")
    saved = await store.command(
        "owner",
        parsed_command(
            facts(
                "1000",
                [record("outings", "optional", "2000", "2026-09-14", controllability="unknown")],
            )
        ),
    )
    assert [card.id for card in saved.workspace.cards] == ["cash", "timeline", "questions"]
    question = saved.workspace.cards[-1]
    assert question.issue_ids == ["outings:controllability"]
    assert question.record_ids == ["outings"]
    assert canonical(saved)["dialogue"]["questionOptions"][0]["id"] == question.issue_ids[0]
    confirmed = await store.command(
        "owner",
        update(saved.revision, records=[{"id": "outings", "controllability": "controllable"}]),
    )
    assert [card.id for card in confirmed.workspace.cards] == ["cash", "timeline"]
    assert confirmed.plan.events == saved.plan.events
    assert confirmed.workspace.actions[0].kind == "previewChange"
    assert confirmed.preview is confirmed.accepted is None


async def test_visible_unknown_scalar_amount_and_date_are_not_repeated(store):
    """Keep ordinary missing amount and date indicators on their existing editable row."""
    await store.create("owner")
    saved = await store.command(
        "owner", update(0, opening=money("1000"), records=[{"kind": "essential", "label": "Rent"}])
    )
    rent = saved.facts.records[0]
    assert rent.amount.amount_paise is None and rent.schedule.date is None
    assert {issue.field for issue in saved.workspace.issues if rent.id in issue.record_ids} == {
        "amount",
        "schedule.date",
    }
    assert [q.fields for q in saved.workspace.questions if rent.id in q.record_ids] == [
        ["schedule.date"]
    ]
    assert [card.id for card in saved.workspace.cards] == ["cash", "timeline", "questions"]
    assert saved.workspace.cards[1].record_ids == [rent.id]
    assert saved.workspace.cards[1].rows[0].state == "missing"
    assert saved.workspace.cards[-1].issue_ids == ["income"]
    dated = await store.command(
        "owner",
        update(saved.revision, records=[{"id": rent.id, "schedule": {"date": "2026-09-14"}}]),
    )
    assert [q.fields for q in dated.workspace.questions if rent.id in q.record_ids] == [["amount"]]
    assert dated.facts.records[0].amount.amount_paise is None
    assert dated.workspace.cards[1].rows[0].state == "missing"
    assert dated.workspace.cards[-1].issue_ids == ["income"]
