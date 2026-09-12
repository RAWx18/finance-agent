# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4
from xml.etree import ElementTree

import aiohttp
import pytest
from azure.cognitiveservices.speech import PropertyId
from pipecat.services.azure.stt import AzureSTTService
from pipecat.services.azure.tts import AzureTTSService
from pipecat.services.tts_service import TextAggregationMode
from pipecat.transcriptions.language import Language
from pydantic import ValidationError

from app.config import Environment
from app.speech import SpeechRecognition, SpeechSynthesis
from app.store import Problem
from app.voice import CallManager, check_voice, unavailable_reason

from .test_voice import environment


def test_native_services_and_hd_ssml(config):
    stt = SpeechRecognition(
        api_key="test-only",
        region="centralindia",
        sample_rate=16000,
        phrases=config.voice.stt_phrases,
        settings=SpeechRecognition.Settings(
            language=Language(config.voice.stt_locale),
            segmentation_silence_timeout_ms=config.voice.stt_segmentation_ms,
        ),
    )
    assert isinstance(stt, AzureSTTService)
    assert stt._settings.model is None
    assert stt._speech_config.speech_recognition_language == "en-IN"
    assert stt._speech_config.get_property(PropertyId.Speech_SegmentationSilenceTimeoutMs) == "500"
    assert stt.phrases == [
        "rupees",
        "paise",
        "lakh",
        "lakhs",
        "crore",
        "crores",
        "EMI",
        "equated monthly instalment",
        "minimum due",
    ]
    tts = SpeechSynthesis(
        api_key="test-only",
        region="centralindia",
        sample_rate=24000,
        settings=SpeechSynthesis.Settings(
            voice=config.voice.tts_voice,
            language=Language(config.voice.tts_locale),
            force_locale=True,
        ),
        text_aggregation_mode=TextAggregationMode.SENTENCE,
    )
    assert isinstance(tts, AzureTTSService)
    assert tts._settings.force_locale
    text = 'Rent & "EMI" <label> costs five thousand rupees.'
    ssml = tts._construct_ssml(text)
    root = ElementTree.fromstring(ssml)
    ns = "{http://www.w3.org/2001/10/synthesis}"
    assert [node.tag for node in root.iter()] == [ns + name for name in ("speak", "voice", "lang")]
    assert root.attrib["{http://www.w3.org/XML/1998/namespace}lang"] == "en-IN"
    assert root[0].attrib == {"name": config.voice.tts_voice}
    assert root[0][0].text == text
    assert all(word not in ssml for word in ("mstts", "prosody", "emphasis", "express-as"))
    tts._settings.voice = "label'\"<&"
    assert ElementTree.fromstring(tts._construct_ssml(text))[0].attrib["name"] == "label'\"<&"
    assert tts._stop_frame_timeout_s > config.voice.tts_total_seconds


async def test_synthesis_scopes_callbacks_and_streams_native_audio(monkeypatch):
    from pipecat.frames.frames import TTSAudioRawFrame

    synthesizer = Mock()
    monkeypatch.setattr("app.speech.SpeechSynthesizer", Mock(return_value=synthesizer))
    tts = SpeechSynthesis(api_key="test-only", region="centralindia", sample_rate=24000)
    tts.get_event_loop = Mock(return_value=asyncio.get_running_loop())
    tts.add_word_timestamps = AsyncMock()

    def stream(ssml):
        assert "Reported cash" in ssml
        synthesizer.synthesizing.connect.call_args.args[0](
            SimpleNamespace(result=SimpleNamespace(audio_data=b"\x01\x00"))
        )
        synthesizer.synthesis_completed.connect.call_args.args[0](
            SimpleNamespace(result=SimpleNamespace(audio_duration=timedelta(milliseconds=20)))
        )

    synthesizer.speak_ssml_async.side_effect = stream
    frames = [item async for item in tts.run_tts("Reported cash", "sentence")]
    assert len(frames) == 1 and isinstance(frames[0], TTSAudioRawFrame)
    assert frames[0].audio == b"\x01\x00" and frames[0].context_id == "sentence"
    synthesizer.stop_speaking_async.assert_not_called()
    for signal in (
        synthesizer.synthesizing,
        synthesizer.synthesis_completed,
        synthesizer.synthesis_canceled,
        synthesizer.synthesis_word_boundary,
    ):
        signal.disconnect_all.assert_called_once()


async def test_phrase_hints_precede_continuous_recognition(config, monkeypatch):
    stt = SpeechRecognition(
        api_key="test-only", region="centralindia", phrases=config.voice.stt_phrases
    )
    calls = Mock()
    recognizer = Mock()
    grammar = Mock()
    calls.attach_mock(grammar, "grammar")
    calls.attach_mock(recognizer, "recognizer")
    factory = Mock(return_value=recognizer)
    monkeypatch.setattr("app.speech.SpeechRecognizer", factory)
    monkeypatch.setattr("app.speech.PhraseListGrammar.from_recognizer", Mock(return_value=grammar))
    monkeypatch.setattr("app.speech.PushAudioInputStream", Mock())
    monkeypatch.setattr("app.speech.AudioConfig", Mock())
    await stt._connect()
    for name in ("recognizing", "recognized", "canceled", "session_stopped"):
        getattr(recognizer, name).connect.assert_called_once()
    assert [call.args[0] for call in grammar.addPhrase.call_args_list] == config.voice.stt_phrases
    names = [call[0] for call in calls.mock_calls]
    assert names.index("grammar.setWeight") < names.index(
        "recognizer.start_continuous_recognition_async"
    )
    grammar.setWeight.assert_called_once_with(1.0)
    recognizer.start_continuous_recognition_async.return_value.get.assert_called_once()
    await stt._connect()
    factory.assert_called_once()
    await stt._disconnect()
    recognizer.stop_continuous_recognition_async.assert_called_once()
    recognizer.stop_continuous_recognition_async.return_value.get.assert_called_once()
    for name in ("recognizing", "recognized", "canceled", "session_stopped"):
        getattr(recognizer, name).disconnect_all.assert_called_once()
    assert stt._audio_stream is None and stt._speech_recognizer is None


async def test_recognizer_failure_is_sanitized(config, monkeypatch):
    stt = SpeechRecognition(
        api_key="test-only", region="centralindia", phrases=config.voice.stt_phrases
    )
    monkeypatch.setattr("app.speech.PushAudioInputStream", Mock(side_effect=RuntimeError("secret")))
    stt.push_error = AsyncMock()
    await stt._connect()
    stt.push_error.assert_awaited_once_with(
        error_msg="Azure speech recognition could not start.", force_treat_as_permanent=True
    )


@pytest.mark.parametrize("queued", [False, True])
async def test_native_start_settles_before_stop_after_cancellation(config, monkeypatch, queued):
    stt = SpeechRecognition(
        api_key="test-only",
        region="centralindia",
        phrases=[],
        config=config.voice.model_copy(update={"shutdown_seconds": 0.02}),
    )
    recognizer = Mock()
    stream = Mock()
    monkeypatch.setattr("app.speech.SpeechRecognizer", Mock(return_value=recognizer))
    monkeypatch.setattr("app.speech.PhraseListGrammar.from_recognizer", Mock())
    monkeypatch.setattr("app.speech.PushAudioInputStream", Mock(return_value=stream))
    monkeypatch.setattr("app.speech.AudioConfig", Mock())
    loop = asyncio.get_running_loop()
    release = Event()
    entered = asyncio.Event()
    submitted = asyncio.Event()
    calls = []

    def blocked():
        loop.call_soon_threadsafe(entered.set)
        release.wait()

    def start():
        if not queued:
            blocked()
        calls.append("start")

    recognizer.start_continuous_recognition_async.return_value.get.side_effect = start
    recognizer.stop_continuous_recognition_async.return_value.get.side_effect = lambda: (
        calls.append("stop")
    )
    # A single occupied executor proves cancellation cannot skip a queued native start.
    with ThreadPoolExecutor(max_workers=1) as executor:
        run_in_executor = loop.run_in_executor

        def submit(pool, function, *args):
            future = run_in_executor(executor, function, *args)
            submitted.set()
            return future

        monkeypatch.setattr(loop, "run_in_executor", submit)
        blocker = executor.submit(blocked) if queued else None
        connect = asyncio.create_task(stt._connect())
        try:
            await asyncio.wait_for(entered.wait(), 2)
            await asyncio.wait_for(submitted.wait(), 2)
            connect.cancel()
            with pytest.raises(TimeoutError):
                await connect
            task = stt._native_stop
            assert stt._recognition_id is None and not stt._native_start.done()
            with pytest.raises(TimeoutError):
                await stt._disconnect()
            assert stt._native_stop is task and not task.done()
            recognizer.stop_continuous_recognition_async.assert_not_called()
            stream.close.assert_not_called()
            release.set()
            await asyncio.wait_for(asyncio.shield(task), 2)
            await stt._disconnect()
            assert calls == ["start", "stop"]
            stream.close.assert_called_once()
            assert stt._speech_recognizer is None and stt._audio_stream is None
        finally:
            release.set()
            await asyncio.gather(connect, return_exceptions=True)
            if stt._native_stop is not None:
                await asyncio.wait_for(asyncio.shield(stt._native_stop), 2)
            if blocker is not None:
                blocker.result()


async def test_native_start_timeout_cannot_leave_a_late_recognizer(config, monkeypatch):
    stt = SpeechRecognition(
        api_key="test-only",
        region="centralindia",
        phrases=[],
        config=config.voice.model_copy(update={"startup_seconds": 0.02, "shutdown_seconds": 0.02}),
    )
    recognizer = Mock()
    monkeypatch.setattr("app.speech.SpeechRecognizer", Mock(return_value=recognizer))
    monkeypatch.setattr("app.speech.PhraseListGrammar.from_recognizer", Mock())
    monkeypatch.setattr("app.speech.PushAudioInputStream", Mock())
    monkeypatch.setattr("app.speech.AudioConfig", Mock())
    release = Event()
    entered = asyncio.Event()
    loop = asyncio.get_running_loop()

    def start():
        loop.call_soon_threadsafe(entered.set)
        release.wait()

    recognizer.start_continuous_recognition_async.return_value.get.side_effect = start
    try:
        with pytest.raises(TimeoutError):
            await stt._connect()
        await asyncio.wait_for(entered.wait(), 2)
        task = stt._native_start
        assert not task.done()
        with pytest.raises(TimeoutError):
            await stt.cleanup()
        recognizer.stop_continuous_recognition_async.assert_not_called()
        assert stt._native_start is task and stt._speech_recognizer is recognizer
    finally:
        release.set()
        if stt._native_stop is not None:
            await asyncio.wait_for(asyncio.shield(stt._native_stop), 2)
    await stt.cleanup()
    recognizer.start_continuous_recognition_async.assert_called_once()
    recognizer.stop_continuous_recognition_async.assert_called_once()


@pytest.mark.parametrize("service", ["recognition", "synthesis"])
async def test_failed_native_stop_remains_unconfirmed(config, monkeypatch, service):
    provider = Mock()
    if service == "recognition":
        adapter = SpeechRecognition(api_key="test-only", region="centralindia", phrases=[])
        adapter._speech_recognizer = provider
        adapter._audio_stream = Mock()
        stop = provider.stop_continuous_recognition_async
        operation = adapter._disconnect
    else:
        adapter = SpeechSynthesis(api_key="test-only", region="centralindia")
        adapter._speech_synthesizer = provider
        adapter._retire_synthesis = Mock()
        stop = provider.stop_speaking_async
        operation = adapter._stop_synthesis
    stop.return_value.get.side_effect = RuntimeError("native stop failed")
    with pytest.raises(RuntimeError, match="native stop failed"):
        await operation()
    task = adapter._native_stop
    for _ in range(2):
        with pytest.raises(RuntimeError, match="native stop failed"):
            await adapter.cleanup()
        assert adapter._native_stop is task
    stop.assert_called_once()
    stop.return_value.get.assert_called_once()


@pytest.mark.parametrize("region", ["https://centralindia", "a.b", "a/b", "a@b", "-a", "a-", "a\n"])
def test_region_rejects_unsafe_hostname_labels(region):
    with pytest.raises(ValidationError):
        Environment(azure_speech_region=region)


@pytest.mark.parametrize(
    "name",
    [
        "azure_openai_api_key",
        "azure_openai_endpoint",
        "daily_api_key",
        "azure_speech_key",
        "azure_speech_region",
    ],
)
def test_only_missing_environment_blocks_voice(config, tmp_path, name):
    env = environment(tmp_path)
    assert unavailable_reason(config, env) is None
    env = env.model_copy(update={name: None if name.endswith("key") else ""})
    assert unavailable_reason(config, env) == f"Missing setup: {name.upper()}."
    assert Environment(azure_speech_region="").azure_speech_region == ""


@pytest.fixture
def voice_http(config, monkeypatch):
    response = AsyncMock()
    response.status = 200
    response.json.return_value = [
        {
            "ShortName": config.voice.tts_voice,
            "Gender": "Female",
            "Locale": "en-IN",
        }
    ]
    request = AsyncMock()
    request.__aenter__.return_value = response
    http = Mock()
    http.get.return_value = request
    session = AsyncMock()
    session.__aenter__.return_value = http
    monkeypatch.setattr("app.voice.aiohttp.ClientSession", Mock(return_value=session))
    return http, response


async def test_exact_resource_voice_check(config, tmp_path, voice_http):
    http, response = voice_http
    await check_voice(config, environment(tmp_path))
    http.get.assert_called_once_with(
        "https://centralindia.tts.speech.microsoft.com/cognitiveservices/voices/list",
        headers={"Ocp-Apim-Subscription-Key": "test-only-speech"},
        allow_redirects=False,
    )
    response.json.assert_awaited_once()


async def test_configured_gender_and_locale_are_verified_without_fallback(
    config, tmp_path, voice_http
):
    _, response = voice_http
    config = config.model_copy(
        update={
            "voice": config.voice.model_copy(
                update={
                    "tts_voice": "en-GB-RyanNeural",
                    "tts_locale": "en-GB",
                    "tts_gender": "Male",
                }
            )
        }
    )
    with pytest.raises(Problem, match="Configured male English voice is unavailable"):
        await check_voice(config, environment(tmp_path))
    response.json.return_value = [
        {
            "ShortName": "en-GB-RyanNeural",
            "Locale": "en-GB",
            "Gender": "Male",
        }
    ]
    await check_voice(config, environment(tmp_path))


@pytest.mark.parametrize("field", ["stt_locale", "tts_locale"])
async def test_unsupported_sdk_locale_blocks_preflight_and_paid_room(
    store, config, tmp_path, voice_http, monkeypatch, field
):
    await store.create("owner")
    config = config.model_copy(update={"voice": config.voice.model_copy(update={field: "xx-YY"})})
    rooms = Mock()
    monkeypatch.setattr("app.voice.DailyRooms", rooms)
    manager = CallManager(store, config, environment(tmp_path))
    try:
        with pytest.raises(Problem, match="speech locale is unsupported"):
            await manager.start("owner", uuid4())
        rooms.assert_not_called()
        voice_http[0].get.assert_not_called()
    finally:
        await manager.close()


@pytest.mark.parametrize("status", [301, 401, 403, 429, 500])
async def test_voice_list_http_failures_are_actionable(config, tmp_path, voice_http, status):
    _, response = voice_http
    response.status = status
    with pytest.raises(Problem, match=f"HTTP {status}") as error:
        await check_voice(config, environment(tmp_path))
    assert "speech key, resource region" in str(error.value)
    response.json.assert_not_awaited()


@pytest.mark.parametrize(
    "field,value",
    [("ShortName", "other"), ("Gender", "Male"), ("Locale", "hi-IN"), ("Locale", "en-US")],
)
async def test_no_voice_fallback(config, tmp_path, voice_http, field, value):
    _, response = voice_http
    response.json.return_value[0][field] = value
    with pytest.raises(Problem, match="Configured female English voice is unavailable"):
        await check_voice(config, environment(tmp_path))


@pytest.mark.parametrize(
    "failure", [ValueError("secret"), aiohttp.ClientError("secret"), TimeoutError("secret")]
)
async def test_voice_check_transport_errors_are_sanitized(config, tmp_path, voice_http, failure):
    http, _ = voice_http
    http.get.side_effect = failure
    with pytest.raises(Problem, match="verify the resource region") as error:
        await check_voice(config, environment(tmp_path))
    assert "secret" not in str(error.value)


async def test_preflight_failure_creates_no_room(store, config, tmp_path, voice_http, monkeypatch):
    await store.create("owner")
    _, response = voice_http
    response.json.return_value = []
    rooms = Mock()
    monkeypatch.setattr("app.voice.DailyRooms", rooms)
    manager = CallManager(store, config, environment(tmp_path))
    with pytest.raises(Problem, match="Configured female English voice is unavailable"):
        await manager.start("owner", uuid4())
    rooms.assert_not_called()
    assert manager.state("owner").status == "error"
    assert manager.state("owner").message == (
        "Conversations are temporarily unavailable. Please try again shortly."
    )
    assert manager.call is not None
    assert manager.call.state.message is not None
    assert "AZURE_SPEECH_REGION" in manager.call.state.message
    assert not store.listeners
    await manager.close()
