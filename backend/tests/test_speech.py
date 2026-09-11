# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from unittest.mock import AsyncMock, Mock
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
    assert SpeechSynthesis.run_tts is AzureTTSService.run_tts
    assert SpeechRecognition._disconnect is AzureSTTService._disconnect
    assert SpeechRecognition._on_handle_recognized is AzureSTTService._on_handle_recognized


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
    recognizer.recognizing.connect.assert_called_once_with(stt._on_handle_recognizing)
    recognizer.recognized.connect.assert_called_once_with(stt._on_handle_recognized)
    recognizer.canceled.connect.assert_called_once_with(stt._on_handle_canceled)
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
    assert stt._audio_stream is None and stt._speech_recognizer is None


async def test_recognizer_failure_is_sanitized(config, monkeypatch):
    stt = SpeechRecognition(
        api_key="test-only", region="centralindia", phrases=config.voice.stt_phrases
    )
    monkeypatch.setattr("app.speech.PushAudioInputStream", Mock(side_effect=RuntimeError("secret")))
    stt.push_error = AsyncMock()
    await stt._connect()
    stt.push_error.assert_awaited_once_with(
        error_msg="Azure speech recognition could not start.", fatal=True
    )


@pytest.mark.parametrize("region", ["https://centralindia", "a.b", "a/b", "a@b", "-a", "a-", "a\n"])
def test_region_rejects_unsafe_hostname_labels(region):
    with pytest.raises(ValidationError):
        Environment(azure_speech_region=region)


@pytest.mark.parametrize(
    "name",
    [
        "azure_openai_api_key",
        "azure_openai_endpoint",
        "azure_openai_deployment",
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
        await manager.start("owner")
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
