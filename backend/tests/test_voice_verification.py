# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import ast
import subprocess
import sys

import pytest

from app.config import ROOT


def test_voice_verification_import_has_no_execution():
    tree = ast.parse((ROOT / "backend/scripts/verify_voice.py").read_text())
    assert isinstance(tree.body[0], ast.Expr)
    assert isinstance(tree.body[0].value, ast.Constant)
    assert isinstance(tree.body[-1], ast.If)
    assert ast.unparse(tree.body[-1].test) == "__name__ == '__main__'"
    assert all(
        isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef))
        for node in tree.body[1:-1]
    )
    result = subprocess.run(
        [sys.executable, "-c", "import scripts.verify_voice"],
        cwd=ROOT / "backend",
        capture_output=True,
        text=True,
        timeout=15,
        check=True,
    )
    assert result.stdout == result.stderr == ""


@pytest.mark.parametrize("arguments, code", [([], 2), (["--help"], 0)])
def test_voice_verification_cli_is_offline(arguments, code):
    result = subprocess.run(
        [sys.executable, "-m", "scripts.verify_voice", *arguments],
        cwd=ROOT / "backend",
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == code
    assert "--allow-billable" in result.stdout + result.stderr
    assert "livePipelineServer" not in result.stdout + result.stderr


def test_production_image_excludes_voice_test_factory():
    dockerfile = (ROOT / "Dockerfile").read_text()
    copies = [line for line in dockerfile.splitlines() if line.startswith("COPY ")]
    assert [line for line in copies if "--from=" not in line and "backend/" in line] == [
        "COPY backend/pyproject.toml backend/uv.lock ./",
        "COPY backend/app/ /app/backend/app/",
    ]
    assert "tests.auth_support" not in dockerfile
    assert '"app.main:app"' in dockerfile
