# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.models import Command
from app.store import Problem, owner_hash

from .conftest import facts, parsed_command, record
from .test_adjustments import adjustment
from .test_finance import scenario_two
from .test_scenarios import initialize, operation, submit


@pytest.mark.parametrize("sequence", [-1, True, "1", 1.5])
def test_expected_sequence_requires_nonnegative_integer(sequence):
    """Reject malformed concurrency tokens rather than coercing them."""
    with pytest.raises(ValidationError):
        Command.model_validate(
            {
                **operation("previewAdjustments", adjustments=[adjustment()]),
                "expectedSequence": sequence,
            }
        )


@pytest.mark.parametrize("supplied", [False, True])
def test_absent_or_null_sequence_preserves_unconditional_clients(client, supplied):
    """Sequence checks are opt-in without weakening preview identity checks."""
    initialize(client)
    submit(client, "previewAdjustments", adjustments=[adjustment()])
    payload = operation("previewAdjustments", adjustments=[adjustment(amount="500")])
    if supplied:
        payload["expectedSequence"] = None
    response = client.post("/api/session/commands", json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["preview"]["adjustments"][0]["amountPaise"] == 50000


async def test_stale_preview_does_not_persist_or_publish_and_receipt_wins(store):
    """Same-revision stale tabs cannot replace previews or invalidate original receipts."""
    owner = owner_hash("proposal")
    await store.create(owner)
    baseline = await store.command(owner, parsed_command(scenario_two()))
    submitted = Command.model_validate(
        {
            **operation("previewAdjustments", adjustments=[adjustment()]),
            "expectedSequence": baseline.sequence,
        }
    )
    receipt = await store.command(owner, submitted)
    current = await store.command(
        owner,
        Command.model_validate(
            {
                **operation("previewAdjustments", adjustments=[adjustment(amount="500")]),
                "expectedSequence": receipt.sequence,
            }
        ),
    )
    assert current.revision == baseline.revision
    assert current.sequence == receipt.sequence + 1
    assert current.facts == baseline.facts and current.accepted is None
    queue = await store.subscribe(owner)
    queue.get_nowait()
    db = store.connection()
    writes = db.total_changes
    stale = submitted.model_copy(update={"command_id": uuid4()})
    with pytest.raises(Problem) as error:
        await store.command(owner, stale)
    assert error.value.status == 409 and error.value.body.code == "stalePreview"
    assert error.value.body.snapshot == current
    assert await store.command(owner, submitted) == receipt
    assert await store.get(owner) == current
    assert db.total_changes == writes and queue.empty()
    async with db.execute(
        "SELECT COUNT(*) FROM commands WHERE id = ?", (str(stale.command_id),)
    ) as cursor:
        assert (await cursor.fetchone())[0] == 0
    store.unsubscribe(owner, queue)


async def test_sequence_rechecked_after_unlocked_observation(store, monkeypatch):
    """A command losing the second lock acquisition cannot overwrite its winning peer."""
    owner = owner_hash("proposal")
    await store.create(owner)
    baseline = await store.command(owner, parsed_command(scenario_two()))
    waiting, release = asyncio.Event(), asyncio.Event()

    async def observe(currencies):
        """Pause only the first command at the unlocked observation boundary."""
        if not waiting.is_set():
            waiting.set()
            await release.wait()
        return None

    monkeypatch.setattr(store, "observe_rates", observe)
    payload = {
        **operation("previewAdjustments", adjustments=[adjustment()]),
        "expectedSequence": baseline.sequence,
    }
    pending = asyncio.create_task(store.command(owner, Command.model_validate(payload)))
    try:
        await asyncio.wait_for(waiting.wait(), timeout=5)
        current = await store.command(
            owner, Command.model_validate({**payload, "commandId": str(uuid4())})
        )
    finally:
        release.set()
    with pytest.raises(Problem) as error:
        await pending
    assert error.value.status == 409 and error.value.body.code == "stalePreview"
    assert error.value.body.snapshot == current
    assert await store.get(owner) == current


def test_api_sequence_conflict_returns_current_snapshot_and_options_context(client):
    """Wire tokens identify canonical options even when only the preview changes."""
    baseline = initialize(client)
    options = client.get("/api/session/options").json()
    assert options["sessionId"] == baseline["sessionId"]
    assert options["sequence"] == baseline["sequence"]
    assert options["revision"] == baseline["revision"]
    payload = {
        **operation("previewAdjustments", adjustments=[adjustment()]),
        "expectedSequence": options["sequence"],
    }
    response = client.post("/api/session/commands", json=payload)
    assert response.status_code == 200, response.text
    current = response.json()
    assert current["revision"] == baseline["revision"]
    response = client.post("/api/session/commands", json={**payload, "commandId": str(uuid4())})
    assert response.status_code == 409
    assert response.json()["code"] == "stalePreview"
    assert response.json()["snapshot"] == current
    assert client.get("/api/session").json() == current
    options = client.get("/api/session/options").json()
    assert options["sessionId"] == current["sessionId"]
    assert options["sequence"] == current["sequence"]
    assert options["revision"] == baseline["revision"]


@pytest.mark.parametrize("kind", ["acceptPreview", "rejectPreview", "discardPreview"])
def test_current_preview_identity_and_sequence_guards(client, kind):
    """Consent and dismissal need the current identity even with a matching sequence."""
    initialize(client)
    prior = submit(client, "previewAdjustments", adjustments=[adjustment()])
    current = submit(client, "previewAdjustments", adjustments=[adjustment(amount="500")])
    for identity, sequence in (
        (prior["preview"]["id"], current["sequence"]),
        (current["preview"]["id"], prior["sequence"]),
    ):
        response = client.post(
            "/api/session/commands",
            json={
                **operation(kind, previewId=identity),
                "expectedSequence": sequence,
            },
        )
        assert response.status_code == 409
        assert response.json()["code"] == "stalePreview"
        assert response.json()["snapshot"] == current
        assert client.get("/api/session").json() == current
    response = client.post(
        "/api/session/commands",
        json={
            **operation(kind, previewId=current["preview"]["id"]),
            "expectedSequence": current["sequence"],
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["preview"] is None
    if kind == "acceptPreview":
        assert response.json()["accepted"]["id"] == current["preview"]["id"]
    if kind == "rejectPreview":
        assert response.json()["rejectedProposals"][-1]["id"] == current["preview"]["id"]


async def test_declined_exact_set_has_distinct_code_without_persistence(store):
    """Exact refusals remain blocked while different eligible amounts can be previewed."""
    owner = owner_hash("proposal")
    await store.create(owner)
    await store.command(owner, parsed_command(scenario_two()))
    preview = await store.command(
        owner, Command.model_validate(operation("previewAdjustments", adjustments=[adjustment()]))
    )
    current = await store.command(
        owner,
        Command.model_validate(operation("rejectPreview", previewId=str(preview.preview.id))),
    )
    writes = store.connection().total_changes
    with pytest.raises(Problem) as error:
        await store.command(
            owner,
            Command.model_validate(
                {
                    **operation("previewAdjustments", current.revision, adjustments=[adjustment()]),
                    "expectedSequence": current.sequence,
                }
            ),
        )
    assert error.value.status == 422 and error.value.body.code == "proposalRejected"
    assert error.value.body.snapshot == current
    assert await store.get(owner) == current
    assert store.connection().total_changes == writes
    result = await store.command(
        owner,
        Command.model_validate(
            operation(
                "previewAdjustments", current.revision, adjustments=[adjustment(amount="500")]
            )
        ),
    )
    assert result.preview.adjustments[0].amount_paise == 50000


def test_api_rejection_code_is_distinct_from_ineligibility(client):
    """The API distinguishes explicit refusal from protected adjustment validation."""
    initialize(client, facts("1000", [record("optional", "optional", "100", "2026-09-27")]))
    preview = submit(client, "previewAdjustments", adjustments=[adjustment()])
    current = submit(client, "rejectPreview", previewId=preview["preview"]["id"])
    for inputs, code in (
        ([adjustment()], "proposalRejected"),
        ([adjustment("missing:2026-09-27")], "invalidAdjustments"),
        ([adjustment(amount="100")], "invalidAdjustments"),
    ):
        response = client.post(
            "/api/session/commands",
            json={
                **operation("previewAdjustments", current["revision"], adjustments=inputs),
                "expectedSequence": current["sequence"],
            },
        )
        assert response.status_code == 422
        assert response.json()["code"] == code
        assert response.json()["snapshot"] == current
        assert client.get("/api/session").json() == current
