# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

"""Offline safety checks and the isolated live harness's authenticated probe factory."""

import asyncio
import json
import re
import subprocess
import sys
from contextlib import asynccontextmanager, suppress
from datetime import date
from types import SimpleNamespace

import pytest
from fastapi import Request
from fastapi.testclient import TestClient

from app.config import ROOT
from scripts.verify_continuous_voice import browser_environment, failure_category, scenario


def probe(pipeline):
    metrics = getattr(pipeline, "metrics", {})
    return {
        "metrics": {
            key: value
            for key, value in metrics.items()
            if re.fullmatch(
                r"(?:model_requests|model_text|model_text_received|model_completed|model_cancelled|"
                r"model_failed|model_ends|model_empty|model_stream_text|tool_calls|synthesis_contexts|"
                r"model_finish_(?:stop|length|tool_calls|content_filter|other)|model_refusals|"
                r"synthesis_audio|published_audio|user_starts|user_turns|errors|"
                r"waiting|continued|"
                r"stale_[a-z_]{1,40})",
                key,
            )
            and type(value) is int
            and value >= 0
        },
        **{
            name: value if type(value := getattr(pipeline, name, None)) is kind else None
            for name, kind in (
                ("generation", int),
                ("waiting", bool),
                ("sequence", int),
                ("state_sequence", int),
            )
        },
        "ready": bool(pipeline and pipeline.client_ready.is_set()),
    }


def browser_app():
    from azure.cognitiveservices.speech import OutputFormat, ResultReason

    from app import speech

    from .auth_support import browser_app as authenticated_app

    application = authenticated_app()
    lifespan = application.router.lifespan_context
    pipelines = {}
    requests = {}
    rooms = set()
    recognition = []
    recognition_class = speech.SpeechRecognition
    connection_generation = 0

    class ConnectionBoundary:
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            generation = connection_generation

            async def forward(message):
                if (
                    scope.get("path") == "/api/session/events"
                    and message["type"] == "http.response.body"
                    and generation < connection_generation
                ):
                    raise ConnectionResetError("Synthetic connection interruption")
                await send(message)

            await self.app(scope, receive, forward)

    application.add_middleware(ConnectionBoundary)

    class ObservedRecognition(recognition_class):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self._speech_config.output_format = OutputFormat.Detailed

        def _on_handle_recognized(self, event):
            if event.result.reason == ResultReason.RecognizedSpeech:
                result = json.loads(event.result.json)
                recognition.extend(
                    {key: candidate.get(key) for key in ("Confidence", "Lexical", "ITN", "Display")}
                    for candidate in result.get("NBest", [])[:1]
                )
                del recognition[:-20]
            super()._on_handle_recognized(event)

    @asynccontextmanager
    async def observed_lifespan(app):
        async def observe():
            while True:
                call = app.state.calls.call
                if call:
                    if call.pipeline:
                        pipelines[call.owner] = call.pipeline
                        if call.pipeline.llm and call.pipeline not in requests:
                            requests[call.pipeline] = None

                            async def capture(request, pipeline=call.pipeline):
                                if request.url.path.endswith("/chat/completions"):
                                    requests[pipeline] = json.loads(request.content)

                            call.pipeline.llm._client._client.event_hooks["request"].append(capture)
                    name = "finance-" + call.id.hex
                    if name not in rooms:
                        rooms.add(name)
                        path = app.state.calls.environment.data_dir / "rooms.json"
                        path.write_text(json.dumps(sorted(rooms)))
                await asyncio.sleep(0.05)

        speech.SpeechRecognition = ObservedRecognition
        try:
            async with lifespan(app):
                task = asyncio.create_task(observe())
                try:
                    yield
                finally:
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task
        finally:
            speech.SpeechRecognition = recognition_class

    application.router.lifespan_context = observed_lifespan

    @application.get("/__test/voice", include_in_schema=False)
    async def voice(request: Request):
        access = await application.state.auth.identify(request)
        call = application.state.calls.call
        pipeline = call.pipeline if call and call.owner == access else pipelines.get(access)
        pipeline = pipeline or pipelines.get(access)
        result = probe(pipeline)
        if request.query_params.get("diagnostics") == "true" and pipeline:
            result["syntheticRequest"] = requests.get(pipeline)
            result["syntheticRecognition"] = recognition
            result["filteringIncompleteTurns"] = pipeline.llm._filter_incomplete_user_turns
            result["syntheticDialogue"] = [
                {"role": message["role"], "content": message.get("content")}
                for message in pipeline.context.get_messages()
                if isinstance(message, dict)
                and message.get("role") in {"user", "assistant"}
                and message.get("content")
            ][-12:]
        return result

    # The production SPA catch-all must not consume this test-only route.
    application.router.routes.insert(0, application.router.routes.pop())

    @application.post("/__test/connection", include_in_schema=False)
    async def disconnect(request: Request):
        nonlocal connection_generation
        access = await application.state.auth.identify(request)
        snapshot = await application.state.store.get(access)
        connection_generation += 1
        application.state.store.publish(access.user_id, snapshot)
        return {"disconnected": True}

    application.router.routes.insert(0, application.router.routes.pop())
    return application


@pytest.mark.parametrize("arguments, code", [([], 2), (["--help"], 0)])
def test_cli_requires_explicit_billing(arguments, code):
    result = subprocess.run(
        [sys.executable, "-m", "scripts.verify_continuous_voice", *arguments],
        cwd=ROOT / "backend",
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == code
    assert "--allow-billable" in result.stdout + result.stderr
    assert "isolatedCleanup" not in result.stdout + result.stderr


def test_import_does_not_contact_providers():
    result = subprocess.run(
        [sys.executable, "-c", "import scripts.verify_continuous_voice"],
        cwd=ROOT / "backend",
        capture_output=True,
        text=True,
        timeout=15,
        check=True,
    )
    assert result.stdout == result.stderr == ""


def test_samples_bounded_and_relative():
    payload = scenario(date(2027, 1, 3))
    assert payload["sampleRate"] == 16000
    assert payload["dueDate"] == "2027-01-03"
    assert len(payload["samples"]) == 7
    assert "January 3" in payload["samples"]["rent"]
    assert all(len(text) < 180 for text in payload["samples"].values())


def test_browser_does_not_inherit_credentials(monkeypatch):
    for name in (
        "AZURE_OPENAI_API_KEY",
        "DAILY_API_KEY",
        "GOOGLE_CLIENT_SECRET",
        "UNRELATED_TOKEN",
    ):
        monkeypatch.setenv(name, "private-value")
    assert not any("private-value" == value for value in browser_environment().values())


def test_probe_omits_text_and_private_fields():
    pipeline = SimpleNamespace(
        metrics={
            "model_text": 2,
            "errors": 1,
            "stale_audio": 3,
            "waiting": 2,
            "continued": 1,
            "token": "private",
            "model_requests": "private",
        },
        generation=4,
        waiting=True,
        sequence=8,
        state_sequence=4,
        client_ready=SimpleNamespace(is_set=lambda: True),
    )
    assert probe(pipeline) == {
        "metrics": {"model_text": 2, "errors": 1, "stale_audio": 3, "waiting": 2, "continued": 1},
        "generation": 4,
        "waiting": True,
        "sequence": 8,
        "state_sequence": 4,
        "ready": True,
    }
    assert probe(None)["waiting"] is None
    assert failure_category(b"provider secret traceback") is None
    assert failure_category(
        b"Voice failure source=Speech category=UNKNOWN exception=TimeoutError status=None "
        b"metrics={} private-provider-body"
    ) == {
        "source": "Speech",
        "category": "UNKNOWN",
        "exceptionType": "TimeoutError",
        "status": "None",
    }


def test_probe_requires_authentication_and_is_not_production(monkeypatch, tmp_path):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    application = browser_app()
    with TestClient(application, base_url="http://localhost:8000") as client:
        assert client.get("/__test/voice").status_code == 401
        client.headers["Origin"] = "http://localhost:8000"
        assert client.post("/__test/connection", json={}).status_code == 401
        login = client.post("/api/auth/login", json={})
        assert login.status_code == 200
        assert client.get(login.json()["url"], follow_redirects=False).status_code == 303
        response = client.get("/__test/voice")
        assert response.status_code == 200
        assert response.json() == probe(None)
        assert "no-store" in response.headers["cache-control"]
    assert "tests.test_continuous_verification" not in (ROOT / "Dockerfile").read_text()


def test_browser_requires_billing_before_reading_samples():
    result = subprocess.run(
        ["node", str(ROOT / "frontend/scripts/verifyContinuousVoice.mjs")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 1
    assert '"check":"arguments"' in result.stderr


def test_controlled_pcm_in_real_browser_offline():
    script = """
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { installMicrophone } from './scripts/verifyContinuousVoice.mjs';
const browser = await chromium.launch({headless: true, args: [
    '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
]});
try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('http://127.0.0.1/', route => route.fulfill({body: '<html></html>'}));
    await page.goto('http://127.0.0.1/');
    const pcm = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) pcm.writeInt16LE(Math.sin(i / 8) * 8000, i * 2);
    await page.evaluate(installMicrophone, {sampleRate: 16000,
        samples: {cash: pcm.toString('base64'), rent: pcm.toString('base64')}});
    await page.evaluate(async () => {
        globalThis.stream = await navigator.mediaDevices.getUserMedia({audio: true});
        const audio = document.createElement('audio');
        audio.srcObject = globalThis.stream;
        document.body.append(audio);
        await audio.play();
    });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(async () =>
        (await continuousVoice.snapshot()).energySamples), 0, 'No background fake-mic tone');
    assert.equal(await page.evaluate(async () => {
        stream.getAudioTracks()[0].enabled = false;
        return continuousVoice.play([{name: 'cash'}]);
    }), null, 'Waiting does not force-enable capture');
    await page.evaluate(() => { stream.getAudioTracks()[0].enabled = true; });
    await page.evaluate(() => continuousVoice.play([{name: 'cash', gap: 1.2}, {name: 'rent'}]));
    await page.waitForFunction(async () => (await continuousVoice.snapshot()).energySamples > 0);
    await page.waitForTimeout(500);
    assert.ok(await page.evaluate(async () =>
        (await continuousVoice.snapshot()).audio.every(audio => audio.rms < 0.0001)));
    await page.waitForTimeout(1200);
    const observed = await page.evaluate(() => continuousVoice.snapshot());
    assert.ok(observed.energySamples > 0);
    assert.ok(observed.peak > 0.01);
    assert.ok(Math.abs(observed.injections[1].at - observed.injections[0].at - 1300) < 20);
    assert.ok(Date.now() - observed.lastEnergyAt > 100, 'PCM is not looped');
    await page.evaluate(() => continuousVoice.close());
    assert.equal(await page.evaluate(() =>
        stream.getTracks().every(t => t.readyState === 'ended')), true);
    await context.close();
} finally { await browser.close(); }
"""
    subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT / "frontend",
        env=browser_environment(),
        capture_output=True,
        text=True,
        timeout=25,
        check=True,
    )
