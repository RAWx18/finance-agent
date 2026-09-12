# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from uuid import uuid4

from app.voice_tools import VoiceTools


async def test_invalid_capture_explains_argument_paths_without_saving_or_echoing_input(store):
    """Verify invalid captures expose safe field errors and allow a corrected save."""
    baseline = await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {"expectedRevision": 0, "opening": {"amount": "private-invalid-value", "status": "exact"}},
        "invalid-capture",
    )
    assert result["code"] == "invalidFacts"
    assert result["message"].startswith("No changes saved.")
    assert result["fields"] == [{"path": "opening.amount", "reason": "string_too_long"}]
    assert "private-invalid-value" not in str(result)
    assert await store.get("owner") == baseline
    repaired = await tools.invoke(
        "update_facts",
        {"expectedRevision": 0, "opening": {"amount": "10000", "status": "exact"}},
        "repaired-capture",
    )
    assert "code" not in repaired
    assert repaired["saved"] is True
    assert repaired["snapshot"]["facts"]["opening"]["amountPaise"] == 1000000
    assert repaired["snapshot"]["revision"] == 1


async def test_domain_validation_does_not_expose_internal_error_or_choose_an_identity(store):
    """Verify invalid record corrections preserve state without exposing internal errors."""
    await store.create("owner")
    tools = VoiceTools(store, "owner", uuid4(), lambda snapshot: None)
    result = await tools.invoke(
        "update_facts",
        {"expectedRevision": 0, "records": [{"id": "nonexistent", "label": "Wrong bill"}]},
        "unidentified-correction",
    )
    assert result["code"] == "invalidFacts"
    assert "nonexistent" not in str(result.get("snapshot"))
    assert (await store.get("owner")).revision == 0
