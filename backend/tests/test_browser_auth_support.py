# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

from app.config import Config, Environment, load_config

from .auth_support import BrowserGoogle, auth_app, browser_app


def test_browser_rate_overrides_leave_auth_defaults_unchanged(tmp_path, monkeypatch):
    """Verify browser rate overrides reach auth and Google without mutating shared defaults."""
    config = load_config()
    expected = config.model_dump()
    environment = Environment(data_dir=tmp_path)
    monkeypatch.setattr(Environment, "load", classmethod(lambda cls: environment))

    application = browser_app()
    expected["auth"].update(
        rate_window_seconds=1, login_limit=100, recheck_seconds=300, recheck_grace_seconds=60
    )
    assert application.state.store.config == Config.model_validate(expected)
    assert application.state.auth.config == application.state.store.config.auth
    assert isinstance(application.state.auth.google, BrowserGoogle)
    assert application.state.auth.google.config is application.state.auth.config

    assert config.auth.rate_window_seconds == 60
    assert config.auth.login_limit == 10
    assert load_config() == config
    expected["auth"].update(rate_window_seconds=60, login_limit=10)
    application = auth_app(config, environment)
    assert application.state.store.config == Config.model_validate(expected)
    assert application.state.auth.google.config is application.state.auth.config
    assert load_config() == config
