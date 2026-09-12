# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from scripts import score_dialogue


@pytest.fixture
def evidence(tmp_path):
    """A tiny captured transcript keeps judge tests offline and independent of the engine."""
    source = tmp_path / "capture.json"
    source.write_text(
        json.dumps(
            {
                "status": "completed",
                "sourceStable": True,
                "deterministic": {"status": "failed"},
                "turns": [
                    {
                        "case": "enough",
                        "turn": 1,
                        "status": "completed",
                        "user": "Is my rent covered?",
                        "assistant": "The rent is still short.",
                    }
                ],
            }
        )
    )
    return source


@pytest.fixture
def ratings():
    """All six ratings cite real evidence without asserting that their judgments are right."""
    return {
        "scores": [
            {
                "criterion": criterion,
                "score": 1,
                "turn": 1,
                "quote": "The rent is still short.",
                "reason": "Needs a next step.",
            }
            for criterion in score_dialogue.CRITERIA
        ]
    }


@pytest.mark.parametrize("defect", ["missing", "duplicate", "inventedQuote", "badScore"])
def test_judge_rejects_invalid_or_uncited_scores(ratings, defect):
    """A malformed or invented citation cannot become apparently valid quality evidence."""
    if defect == "missing":
        ratings["scores"].pop()
    elif defect == "duplicate":
        ratings["scores"][0]["criterion"] = ratings["scores"][1]["criterion"]
    elif defect == "inventedQuote":
        ratings["scores"][0]["quote"] = "Your rent is covered."
    else:
        ratings["scores"][0]["score"] = 3
    with pytest.raises(ValueError):
        score_dialogue.Review.model_validate(ratings).validate_quotes(
            [{"turn": 1, "assistant": "The rent is still short."}]
        )


def test_judge_cli_requires_explicit_billing_consent(monkeypatch, tmp_path):
    """No credentials, file read or provider call occurs without the explicit opt-in."""
    score = AsyncMock()
    monkeypatch.setattr(score_dialogue, "score", score)
    monkeypatch.setattr(
        "sys.argv",
        [
            "score_dialogue",
            "--input",
            "absent.json",
            "--output",
            str(tmp_path / "score.json"),
            "--case",
            "enough",
        ],
    )
    with pytest.raises(SystemExit) as error:
        score_dialogue.main()
    assert error.value.code == 2
    score.assert_not_called()


async def test_subjective_score_cannot_replace_failed_financial_checks(
    monkeypatch, tmp_path, evidence, ratings, config
):
    """Use one tool-free bounded request, retain provenance, and leave financial evidence intact."""
    raw = evidence.read_bytes()
    response = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(ratings)))],
        model="synthetic",
        usage=None,
    )
    client = AsyncMock()
    client.chat.completions.create.return_value = response
    manager = AsyncMock()
    manager.__aenter__.return_value = client
    constructor = Mock(return_value=manager)
    monkeypatch.setattr(score_dialogue, "AsyncOpenAI", constructor)
    monkeypatch.setattr(score_dialogue, "load_config", Mock(return_value=config))
    monkeypatch.setattr(
        score_dialogue,
        "dotenv_values",
        Mock(
            return_value={
                "AZURE_OPENAI_API_KEY": "synthetic-key",
                "AZURE_OPENAI_ENDPOINT": "https://synthetic.openai.azure.com/openai/v1/",
            }
        ),
    )
    output = tmp_path / "score.json"
    await score_dialogue.score(evidence, output, "enough")
    assert evidence.read_bytes() == raw
    saved = json.loads(output.read_text())
    assert saved["mode"] == "subjectiveModelReviewNotGate"
    assert saved["sourceSha256"] == hashlib.sha256(raw).hexdigest()
    assert saved["humanReview"] == "pending"
    assert "synthetic-key" not in output.read_text()
    request = client.chat.completions.create.call_args.kwargs
    assert "tools" not in request
    assert request["store"] is False
    assert request["model"] == config.voice.model
    assert request["messages"][0]["content"] == score_dialogue.RUBRIC
    assert constructor.call_args.kwargs["max_retries"] == 0
    assert constructor.call_args.kwargs["timeout"] == config.voice.model_timeout_seconds
    client.chat.completions.create.assert_awaited_once()
    manager.__aexit__.assert_awaited_once()


@pytest.mark.parametrize("field,value", [("sourceStable", False), ("status", "incomplete")])
async def test_noncomparable_run_never_calls_judge(monkeypatch, tmp_path, evidence, field, value):
    """Interrupted or moving-source runs must not receive an apparently comparable rating."""
    data = json.loads(evidence.read_text())
    data[field] = value
    evidence.write_text(json.dumps(data))
    constructor = Mock(side_effect=AssertionError("No provider calls"))
    monkeypatch.setattr(score_dialogue, "AsyncOpenAI", constructor)
    with pytest.raises(ValueError, match="complete, source-stable"):
        await score_dialogue.score(evidence, tmp_path / "score.json", "enough")
    constructor.assert_not_called()
