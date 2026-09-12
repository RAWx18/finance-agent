# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import pytest
from pydantic import ValidationError

from app.config import VoiceConfig
from app.voice_tools import conversation, introduction


def test_identity_introduction_and_style_come_from_one_configuration(config):
    voice = VoiceConfig.model_validate(
        {
            **config.voice.model_dump(),
            "assistant_name": "Mira",
            "introduction": "Hello, I'm {assistant_name}. Let's consider {horizon_days} days.",
            "tone": "Calm, direct and patient.",
            "language": "English",
            "response_max_sentences": 2,
            "outcome_max_sentences": 4,
        }
    )
    configured = config.model_copy(update={"voice": voice})
    assert introduction(configured) == "Hello, I'm Mira. Let's consider 30 days."
    prompt = conversation(configured)
    assert "You are Mira," in prompt and "Calm, direct and patient." in prompt
    assert "at most 2 short sentences" in prompt and "4 for an outcome" in prompt
    assert config.voice.assistant_name not in prompt
    assert "Speak English" in prompt and "next 30 days in INR" in prompt


@pytest.mark.parametrize(
    "template",
    [
        "Hello {missing}",
        "Hello {assistant_name.upper}",
        "Hello {assistant_name[0]}",
        "Hello {assistant_name!r}",
        "Hello {assistant_name:>400}",
        "Hello {",
        "Hello {}",
    ],
)
def test_introduction_rejects_nonexistent_or_executable_format_fields(config, template):
    with pytest.raises(ValidationError):
        VoiceConfig.model_validate({**config.voice.model_dump(), "introduction": template})


@pytest.mark.parametrize("name", ["assistant_name", "introduction", "language", "tone"])
@pytest.mark.parametrize("value", ["", "  ", "Words\nmore words", "Words\0more words"])
def test_conversation_copy_is_nonempty_plain_text(config, name, value):
    with pytest.raises(ValidationError):
        VoiceConfig.model_validate({**config.voice.model_dump(), name: value})


@pytest.mark.parametrize(
    "name,value",
    [
        ("model_timeout_seconds", 0),
        ("max_tool_rounds", 0),
        ("max_completion_tokens", 0),
        ("max_questions", 3),
        ("response_max_sentences", 0),
        ("vad_confidence", 1.1),
        ("vad_min_volume", -0.1),
        ("speech_timeout_seconds", 0),
        ("stt_locale", "not a locale"),
        ("tts_gender", "any"),
    ],
)
def test_conversation_limits_fail_configuration_instead_of_running_unbounded(config, name, value):
    with pytest.raises(ValidationError):
        VoiceConfig.model_validate({**config.voice.model_dump(), name: value})
