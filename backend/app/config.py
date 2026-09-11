# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import os
import re
import tomllib
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from cryptography.fernet import Fernet
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

ROOT = Path(__file__).resolve().parents[2]


class AuthConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    session_hours: int = Field(ge=1, le=168)
    idle_hours: int = Field(ge=1, le=168)
    oauth_seconds: int = Field(ge=60, le=600)
    recheck_seconds: int = Field(ge=30, le=300)
    recent_signin_seconds: int = Field(ge=60, le=900)
    provider_timeout_seconds: float = Field(ge=1, le=10)
    provider_max_bytes: int = Field(ge=4096, le=262144)
    provider_connections: int = Field(ge=1, le=32)
    clock_skew_seconds: int = Field(ge=0, le=60)
    jwks_cache_seconds: int = Field(ge=60, le=86400)
    jwks_refresh_seconds: int = Field(ge=1, le=300)
    max_flows: int = Field(ge=1, le=10000)
    max_users: int = Field(ge=1, le=10000)
    max_logins_per_user: int = Field(ge=1, le=20)
    max_cookie_bytes: int = Field(ge=256, le=16384)
    rate_window_seconds: int = Field(ge=1, le=3600)
    login_limit: int = Field(ge=1, le=100)
    invalid_limit: int = Field(ge=1, le=500)
    account_limit: int = Field(ge=1, le=100)
    mutation_limit: int = Field(ge=1, le=1000)
    voice_limit: int = Field(ge=1, le=30)
    max_rate_keys: int = Field(ge=1, le=10000)

    @model_validator(mode="after")
    def validate_idle(self) -> "AuthConfig":
        if self.idle_hours > self.session_hours:
            raise ValueError("Idle lifetime cannot exceed the absolute session lifetime")
        return self


class VoiceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    reasoning_effort: Literal["none"]
    stt_locale: Literal["en-IN"]
    stt_segmentation_ms: int = Field(ge=100, le=5000)
    stt_phrases: list[str] = Field(min_length=1)
    tts_voice: str = Field(min_length=1)
    tts_locale: Literal["en-IN"]
    call_seconds: int = Field(ge=60, le=3600)
    startup_seconds: int = Field(ge=5, le=120)
    shutdown_seconds: int = Field(ge=1, le=30)
    tool_timeout_seconds: int = Field(ge=1, le=120)
    speech_timeout_seconds: float = Field(ge=0.3, le=3)


class Config(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    currency: Literal["INR"]
    timezone: Literal["Asia/Kolkata"]
    horizon_days: Literal[30]
    retention_hours: int = Field(ge=1, le=168)
    cleanup_seconds: int = Field(ge=1, le=3600)
    heartbeat_seconds: int = Field(ge=1, le=60)
    max_request_bytes: int = Field(ge=1024, le=1048576)
    max_records: int = Field(ge=1, le=500)
    max_occurrences: int = Field(ge=1, le=10000)
    max_money_paise: int = Field(ge=1, le=1000000000000)
    max_total_paise: int = Field(ge=1, lt=9007199254740991)
    max_sessions: int = Field(ge=1, le=10000)
    max_commands: int = Field(ge=1, le=10000)
    max_event_streams: int = Field(ge=1, le=10000)
    max_streams_per_session: int = Field(ge=1, le=100)
    auth: AuthConfig
    voice: VoiceConfig

    @model_validator(mode="after")
    def validate_limits(self) -> "Config":
        if self.max_total_paise < self.max_money_paise:
            raise ValueError("Aggregate money limit must cover the per-amount limit")
        return self


class Environment(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

    app_env: Literal["local", "staging"] = "local"
    public_origin: str = "http://localhost:8000"
    data_dir: Path = ROOT / ".data"
    google_client_id: str = Field(default="", max_length=255, pattern=r"^[A-Za-z0-9_.-]*$")
    google_client_secret: SecretStr | None = Field(default=None, repr=False)
    auth_encryption_key: SecretStr | None = Field(default=None, repr=False)
    azure_openai_api_key: SecretStr | None = Field(default=None, repr=False)
    azure_openai_endpoint: str = ""
    azure_openai_deployment: str = Field(default="", max_length=64, pattern=r"^[A-Za-z0-9_.-]*$")
    daily_api_key: SecretStr | None = Field(default=None, repr=False)
    azure_speech_key: SecretStr | None = Field(default=None, repr=False)
    azure_speech_region: str = Field(
        default="", pattern=r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)?$"
    )

    @field_validator("auth_encryption_key")
    @classmethod
    def validate_auth_key(cls, value: SecretStr | None) -> SecretStr | None:
        if value is None or not value.get_secret_value().strip():
            return None
        try:
            if re.fullmatch(r"[A-Za-z0-9_-]{43}=", value.get_secret_value()) is None:
                raise ValueError
            Fernet(value.get_secret_value().encode("ascii"))
        except (ValueError, UnicodeError):
            raise ValueError("AUTH_ENCRYPTION_KEY must be a Fernet key") from None
        return value

    @property
    def google_available(self) -> bool:
        return bool(
            self.google_client_id
            and self.google_client_secret
            and self.google_client_secret.get_secret_value().strip()
            and self.auth_encryption_key
        )

    @field_validator("azure_openai_endpoint")
    @classmethod
    def validate_azure_endpoint(cls, value: str) -> str:
        if not value:
            return value
        endpoint = re.fullmatch(
            r"https://(?P<host>[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
            r"\.(?:openai|services\.ai)\.azure\.com)(?::443)?(?:/|/openai/v1/?)?",
            value,
        )
        if endpoint is None:
            raise ValueError(
                "AZURE_OPENAI_ENDPOINT must be an HTTPS Azure resource endpoint at "
                "<resource>.openai.azure.com or <resource>.services.ai.azure.com, "
                "with root or /openai/v1 path, optional trailing slash and port 443 only"
            )
        return f"https://{endpoint['host']}/openai/v1/"

    def missing_azure_openai(self) -> list[str]:
        missing = []
        if (
            not self.azure_openai_api_key
            or not self.azure_openai_api_key.get_secret_value().strip()
        ):
            missing.append("AZURE_OPENAI_API_KEY")
        if not self.azure_openai_endpoint:
            missing.append("AZURE_OPENAI_ENDPOINT")
        if not self.azure_openai_deployment:
            missing.append("AZURE_OPENAI_DEPLOYMENT")
        return missing

    @model_validator(mode="after")
    def validate_origin(self) -> "Environment":
        origin = urlsplit(self.public_origin)
        if (
            origin.scheme not in {"http", "https"}
            or not origin.hostname
            or origin.username
            or origin.password
            or origin.path
            or origin.query
            or origin.fragment
        ):
            raise ValueError("PUBLIC_ORIGIN must be an HTTP(S) origin without a path")
        try:
            if origin.port == 0:
                raise ValueError("Port zero is not a public endpoint")
        except ValueError as error:
            raise ValueError("PUBLIC_ORIGIN has an invalid port") from error
        if self.app_env == "staging" and origin.scheme != "https":
            raise ValueError("Staging requires an HTTPS PUBLIC_ORIGIN")
        host = origin.hostname.encode("idna").decode().lower()
        if re.search(r"[\s\x00-\x1f\x7f]", host):
            raise ValueError("PUBLIC_ORIGIN has an invalid host")
        host = f"[{host}]" if ":" in host else host
        port = (
            ""
            if origin.port in {None, 443 if origin.scheme == "https" else 80}
            else f":{origin.port}"
        )
        object.__setattr__(self, "public_origin", f"{origin.scheme}://{host}{port}")
        return self

    @classmethod
    def load(cls) -> "Environment":
        return cls.model_validate(
            {
                name.lower(): os.environ[name]
                for name in (
                    "APP_ENV",
                    "PUBLIC_ORIGIN",
                    "DATA_DIR",
                    "GOOGLE_CLIENT_ID",
                    "GOOGLE_CLIENT_SECRET",
                    "AUTH_ENCRYPTION_KEY",
                    "AZURE_OPENAI_API_KEY",
                    "AZURE_OPENAI_ENDPOINT",
                    "AZURE_OPENAI_DEPLOYMENT",
                    "DAILY_API_KEY",
                    "AZURE_SPEECH_KEY",
                    "AZURE_SPEECH_REGION",
                )
                if name in os.environ
            }
        )


def load_config(path: Path = ROOT / "config.toml") -> Config:
    with path.open("rb") as file:
        return Config.model_validate(tomllib.load(file))
