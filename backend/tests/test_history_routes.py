# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.auth_models import LoginRequest
from app.config import Environment

from .auth_support import auth_app
from .conftest import NOW, ORIGIN
from .test_auth import begin, callback


@pytest.mark.parametrize(
    "path",
    [
        "/history/conversation-2026-09-12-143205",
        "/history/conversation-2026-09-12-143205-2",
        "/history/a",
        "/history/" + "a" * 119,
    ],
)
def test_history_deep_link_survives_protected_reload_and_oauth(tmp_path, config, path):
    (tmp_path / "index.html").write_text("<html>application</html>")
    application = auth_app(config, Environment(data_dir=tmp_path), lambda: NOW, tmp_path)
    with TestClient(application, base_url=ORIGIN, headers={"Origin": ORIGIN}) as client:
        response = client.get(path, follow_redirects=False)
        assert response.status_code == 303
        assert response.headers["location"] == "/login?returnTo=" + path
        params, _ = begin(client, return_to=path)
        assert callback(client, params).headers["location"] == path
        assert client.get(path).text == "<html>application</html>"


@pytest.mark.parametrize(
    "path",
    [
        "/history/",
        "/history//x",
        "/history/../account",
        "/history/x/y",
        "/history/x?x=y",
        "/history/x#fragment",
        "/history/x\n",
        "/history/x\r",
        "/history/x\x00",
        "/history/UPPER",
        "/history/x_2",
        "/history/-x",
        "/history/x-",
        "/history/x--y",
        "/history/%2e%2e",
        "/history/x\\account",
        "//evil.test/history/x",
        "https://evil.test",
        "/history/" + "a" * 120,
    ],
)
def test_oauth_rejects_history_path_injection(path):
    with pytest.raises(ValidationError):
        LoginRequest(returnTo=path)


@pytest.mark.parametrize("path", ["/history/UPPER", "/history/x/y", "/history/x--y"])
def test_unknown_history_routes_do_not_serve_spa(client, path):
    assert client.get(path).status_code == 404


def test_history_openapi_matches_frontend_contract(client):
    schema = client.app.openapi()
    models = schema["components"]["schemas"]
    summary = {"slug", "title", "startedAt", "endedAt", "expiresAt", "messageCount"}
    assert set(models["ConversationSummary"]["properties"]) == summary
    assert set(models["SavedConversation"]["properties"]) == summary | {"messages"}
    assert set(models["ConversationList"]["properties"]) == {"conversations"}
    assert set(models["ConversationMessage"]["properties"]) == {
        "id",
        "role",
        "text",
        "createdAt",
        "interrupted",
    }
    assert models["ConversationMessage"]["properties"]["role"]["enum"] == ["user", "assistant"]
    assert set(schema["paths"]["/api/history"]) == {"get"}
