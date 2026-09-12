# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from uuid import UUID

import pytest
from pydantic import ValidationError

from app.config import VoiceConfig
from app.voice_tools import conversation, opening

CALL = UUID(int=7)


def test_identity_openings_and_style_come_from_one_configuration(config):
    """Verify voice configuration controls identity, openings, language, and reply limits."""
    voice = VoiceConfig.model_validate(
        {
            **config.voice.model_dump(),
            "assistant_name": "Mira",
            "openings": ["Hello, I'm {assistant_name}. Let's consider {horizon_days} days."],
            "resumptions": ["Welcome back; let me check where we stopped."],
            "tone": "Calm, direct and patient.",
            "language": "English",
            "response_max_sentences": 2,
            "outcome_max_sentences": 4,
        }
    )
    configured = config.model_copy(update={"voice": voice})
    assert opening(configured, CALL, False) == "Hello, I'm Mira. Let's consider 30 days."
    assert opening(configured, CALL, True) == "Welcome back; let me check where we stopped."
    prompt = conversation(configured)
    assert "You are Mira," in prompt and "Calm, direct and patient." in prompt
    assert "at most 2 short sentences" in prompt and "4 for an outcome" in prompt
    assert config.voice.assistant_name not in prompt
    assert "Speak English" in prompt and "next 30 days in INR" in prompt


def test_openings_vary_by_call_and_never_claim_specific_memories(config):
    """Verify configured openings cover every variant across calls and stay short."""
    for resumed, lines in ((False, config.voice.openings), (True, config.voice.resumptions)):
        assert 2 <= len(lines) <= 3
        spoken = {opening(config, UUID(int=index), resumed) for index in range(len(lines))}
        assert len(spoken) == len(lines)
        for text in spoken:
            assert "{" not in text and len(text) <= 120
            assert (config.voice.assistant_name in text) is not resumed


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
        "",
        "Words\nmore words",
    ],
)
@pytest.mark.parametrize("name", ["openings", "resumptions"])
def test_openings_reject_nonexistent_or_executable_format_fields(config, name, template):
    """Verify opening templates reject unknown fields, attribute access, and format tricks."""
    with pytest.raises(ValidationError):
        VoiceConfig.model_validate({**config.voice.model_dump(), name: [template]})


@pytest.mark.parametrize("name", ["assistant_name", "language", "tone"])
@pytest.mark.parametrize("value", ["", "  ", "Words\nmore words", "Words\0more words"])
def test_conversation_copy_is_nonempty_plain_text(config, name, value):
    """Verify conversational text settings reject blank values and control characters."""
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
    """Verify invalid model, speech, turn, and response settings fail configuration validation."""
    with pytest.raises(ValidationError):
        VoiceConfig.model_validate({**config.voice.model_dump(), name: value})
