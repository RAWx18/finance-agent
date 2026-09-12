# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.config import Config, Environment, load_config
from app.models import Command
from app.store import Store

from .auth_support import auth_app, sign_in

NOW = datetime(2026, 9, 11, 6, tzinfo=UTC)
ORIGIN = "http://localhost:8000"


def money(amount="0", status="exact"):
    """Build a money input with an explicit amount and certainty status."""
    return {"amount": amount, "status": status}


def record(id, kind, amount, day, **values):
    """Build a dated financial record with kind-specific defaults and optional overrides."""
    return {
        "id": id,
        "kind": kind,
        "label": id,
        "amount": money(amount),
        "schedule": {"date": day, "recurrence": "once"},
        **({"reliability": "reliable"} if kind == "income" else {}),
        **({"debtType": "loan"} if kind == "debt" else {}),
        **({"controllability": "controllable"} if kind in {"optional", "debt"} else {}),
        **values,
    }


def facts(opening="0", records=(), **values):
    """Build financial facts with coverage inferred from the supplied record kinds."""
    return {
        "opening": money(opening),
        "reserve": "0",
        "records": list(records),
        "coverage": {
            kind: "reviewed" if any(item["kind"] == kind for item in records) else "none"
            for kind in ("income", "essential", "optional", "debt")
        },
        **values,
    }


def command(data, revision=0, id=None):
    """Wrap facts in a replacement command with revision and idempotency metadata."""
    return {
        "commandId": str(id or uuid4()),
        "expectedRevision": revision,
        "operation": {"type": "replaceFacts", "facts": data},
    }


def parsed_command(data, revision=0):
    """Validate a facts-replacement payload as a command for direct store tests."""
    return Command.model_validate(command(data, revision))


@pytest.fixture
def config() -> Config:
    """Provide the repository's application configuration."""
    return load_config()


@pytest.fixture
async def store(tmp_path: Path, config: Config):
    """Provide an isolated open SQLite store at a fixed clock and close it after use."""
    store = Store(tmp_path / "sessions.sqlite3", config, lambda: NOW)
    await store.open()
    try:
        yield store
    finally:
        await store.close()


@pytest.fixture
def client(tmp_path: Path, config: Config):
    """Provide a signed-in API client with isolated storage and a fixed clock."""
    application = auth_app(config, Environment(data_dir=tmp_path), clock=lambda: NOW)
    with TestClient(application, base_url=ORIGIN) as client:
        sign_in(client)
        yield client
