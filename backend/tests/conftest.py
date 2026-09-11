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
    return {"amount": amount, "status": status}


def record(id, kind, amount, day, **values):
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
    return {
        "commandId": str(id or uuid4()),
        "expectedRevision": revision,
        "operation": {"type": "replaceFacts", "facts": data},
    }


def parsed_command(data, revision=0):
    return Command.model_validate(command(data, revision))


@pytest.fixture
def config() -> Config:
    return load_config()


@pytest.fixture
async def store(tmp_path: Path, config: Config):
    store = Store(tmp_path / "sessions.sqlite3", config, lambda: NOW)
    await store.open()
    try:
        yield store
    finally:
        await store.close()


@pytest.fixture
def client(tmp_path: Path, config: Config):
    application = auth_app(config, Environment(data_dir=tmp_path), clock=lambda: NOW)
    with TestClient(application, base_url=ORIGIN) as client:
        sign_in(client)
        yield client
