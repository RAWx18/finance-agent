# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import argparse
import asyncio
import json
from unittest.mock import AsyncMock, Mock
from uuid import UUID

import pytest
from loguru import logger

from scripts import verify_azure


@pytest.mark.parametrize("name", ["--debug", "../account", "account;command", "account name"])
def test_verification_resource_names_reject_command_or_path_input(name):
    """Verify Azure verification resource names reject command-like and path-like input."""
    with pytest.raises(argparse.ArgumentTypeError):
        verify_azure.resource_name(name)


@pytest.mark.parametrize("billable", [False, True])
def test_verification_requires_explicit_billing_permission(monkeypatch, billable):
    """Verify Azure verification arguments require explicit permission for billable calls."""
    argv = [
        "verify_azure",
        "--subscription",
        "00000000-0000-0000-0000-000000000001",
        "--resource-group",
        "testGroup",
        "--openai-resource",
        "testOpenai",
        "--deployment",
        "testDeployment",
        "--speech-resource",
        "testSpeech",
    ]
    if billable:
        argv.append("--allow-billable")
    monkeypatch.setattr("sys.argv", argv)
    if billable:
        assert verify_azure.arguments().allow_billable is True
    else:
        with pytest.raises(SystemExit) as error:
            verify_azure.arguments()
        assert error.value.code == 2


async def test_verification_key_capture_is_private_and_subscription_scoped(monkeypatch, capsys):
    """Verify Azure key retrieval scopes CLI requests and keeps captured credentials private."""
    process = Mock(returncode=0)
    process.communicate = AsyncMock(return_value=(b'"synthetic-private-key"', b""))
    launch = AsyncMock(return_value=process)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    args = argparse.Namespace(
        subscription=UUID("00000000-0000-0000-0000-000000000001"), resource_group="testGroup"
    )
    key = await verify_azure.azure(args, "keys", "list", "--name", "testSpeech", "--query", "key1")
    assert key == "synthetic-private-key"
    command = launch.call_args.args
    assert command[:5] == ("az", "cognitiveservices", "account", "keys", "list")
    assert command[command.index("--subscription") + 1] == str(args.subscription)
    assert command[command.index("--resource-group") + 1] == "testGroup"
    assert "synthetic-private-key" not in command
    assert launch.call_args.kwargs == {
        "stdin": asyncio.subprocess.DEVNULL,
        "stdout": asyncio.subprocess.PIPE,
        "stderr": asyncio.subprocess.PIPE,
    }
    assert capsys.readouterr().out == ""


def test_verification_failure_does_not_print_secrets(monkeypatch, capsys):
    """Verify verification failures report error types and locations without secret messages."""
    monkeypatch.setattr(verify_azure, "arguments", Mock(return_value=argparse.Namespace()))
    monkeypatch.setattr(
        verify_azure, "verify", AsyncMock(side_effect=RuntimeError("synthetic-private-key"))
    )
    monkeypatch.setattr(verify_azure.logging, "disable", Mock())
    monkeypatch.setattr(logger, "remove", Mock())
    timer = Mock()
    monkeypatch.setattr(verify_azure.threading, "Timer", Mock(return_value=timer))
    assert verify_azure.main() == 1
    output = capsys.readouterr()
    assert "synthetic-private-key" not in output.out + output.err
    report = json.loads(output.out)
    assert report["passed"] is False
    assert report["errorType"] == "RuntimeError"
    assert report["locations"]
    timer.start.assert_called_once()
    timer.cancel.assert_called_once()
