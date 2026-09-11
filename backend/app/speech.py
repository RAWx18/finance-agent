# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
from typing import Any
from xml.sax.saxutils import escape, quoteattr

from azure.cognitiveservices.speech import (  # type: ignore[import-untyped]
    PhraseListGrammar,
    SpeechRecognizer,
)
from azure.cognitiveservices.speech.audio import (  # type: ignore[import-untyped]
    AudioConfig,
    AudioStreamFormat,
    PushAudioInputStream,
)
from pipecat.services.azure.stt import AzureSTTService
from pipecat.services.azure.tts import AzureTTSService
from pipecat.utils.types import assert_given


class SpeechRecognition(AzureSTTService):
    _speech_recognizer: Any

    def __init__(self, *, phrases: list[str], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.phrases = phrases

    async def _connect(self) -> None:
        if self._audio_stream:
            return
        try:
            self._audio_stream = PushAudioInputStream(
                AudioStreamFormat(samples_per_second=self.sample_rate, channels=1)
            )
            self._speech_recognizer = SpeechRecognizer(
                speech_config=self._speech_config,
                audio_config=AudioConfig(stream=self._audio_stream),
            )
            self._speech_recognizer.recognizing.connect(self._on_handle_recognizing)
            self._speech_recognizer.recognized.connect(self._on_handle_recognized)
            self._speech_recognizer.canceled.connect(self._on_handle_canceled)
            # Vocabulary biases recognition, never authoritative financial state.
            grammar = PhraseListGrammar.from_recognizer(self._speech_recognizer)
            for phrase in self.phrases:
                grammar.addPhrase(phrase)
            grammar.setWeight(1.0)
            await asyncio.to_thread(
                self._speech_recognizer.start_continuous_recognition_async().get
            )
        except Exception:
            await self.push_error(error_msg="Azure speech recognition could not start.", fatal=True)


class SpeechSynthesis(AzureTTSService):
    def _construct_ssml(self, text: str) -> str:
        locale = quoteattr(str(assert_given(self._settings.language)))
        voice = quoteattr(str(assert_given(self._settings.voice)))
        # DragonHD accepts language selection, not prosody or mstts:silence controls.
        return (
            f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
            f"xml:lang={locale}><voice name={voice}><lang xml:lang={locale}>"
            f"{escape(text)}</lang></voice></speak>"
        )
