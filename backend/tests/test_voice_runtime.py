# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from unittest.mock import AsyncMock, Mock

import nltk
import pytest

from app.voice_pipeline import prepare_runtime

from .test_voice_turns import voice as voice
from .test_voice_turns import voice_boundaries as voice_boundaries


def test_missing_tokenizer_fails_before_any_runtime_download(monkeypatch):
    """Verify missing tokenizer data fails preparation without attempting a download."""
    download = Mock(side_effect=AssertionError("Calls must not download model data"))
    monkeypatch.setattr(nltk, "download", download)
    monkeypatch.setattr(nltk.data, "find", Mock(side_effect=LookupError("missing")))
    with pytest.raises(RuntimeError, match="install punkt_tab"):
        prepare_runtime()
    download.assert_not_called()


def test_installed_tokenizer_prepares_without_network(monkeypatch):
    """Verify installed tokenizer data prepares successfully without a network download."""
    download = Mock(side_effect=AssertionError("Network is unavailable"))
    monkeypatch.setattr(nltk, "download", download)
    prepare_runtime()
    assert nltk.sent_tokenize("Ready. Listening.") == ["Ready.", "Listening."]
    download.assert_not_called()


async def test_bot_ready_waits_for_started_processors_not_model_response(voice, monkeypatch):
    """Verify bot readiness waits for processor startup rather than a model response."""
    rtvi = voice.pipeline.worker.rtvi
    send = AsyncMock()
    monkeypatch.setattr(rtvi, "_send_bot_ready", send)
    voice.pipeline.started.clear()
    ready = asyncio.create_task(rtvi.set_bot_ready())
    try:
        await asyncio.wait({ready}, timeout=0.02)
        assert not ready.done()
        send.assert_not_awaited()
        voice.pipeline.started.set()
        await asyncio.wait_for(ready, 1)
        send.assert_awaited_once()
        assert voice.requests.empty()
        assert "botReadySent" in voice.pipeline.timings
    finally:
        voice.pipeline.started.set()
        ready.cancel()
        await asyncio.gather(ready, return_exceptions=True)


async def test_cancelled_start_never_announces_ready(voice, monkeypatch):
    """Verify revoked startup never announces bot readiness."""
    rtvi = voice.pipeline.worker.rtvi
    send = AsyncMock()
    monkeypatch.setattr(rtvi, "_send_bot_ready", send)
    voice.pipeline.invalidate()
    await rtvi.set_bot_ready()
    send.assert_not_awaited()
