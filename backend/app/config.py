# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import os
import re
import tomllib
from pathlib import Path
from string import Formatter
from typing import Literal
from urllib.parse import urlsplit

from cryptography.fernet import Fernet
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

ROOT = Path(__file__).resolve().parents[2]


class AuthConfig(BaseModel):
    """Authentication lifetimes, provider limits, and abuse-prevention bounds."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    session_hours: int = Field(ge=1, le=168)
    idle_hours: int = Field(ge=1, le=168)
    oauth_seconds: int = Field(ge=60, le=600)
    recheck_seconds: int = Field(ge=30, le=3600)
    recheck_grace_seconds: int = Field(default=120, ge=0, le=600)
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
        """Require idle expiry to fit within the absolute session lifetime."""
        if self.idle_hours > self.session_hours:
            raise ValueError("Idle lifetime cannot exceed the absolute session lifetime")
        return self


class VoiceConfig(BaseModel):
    """Conversation, speech recognition, synthesis, and voice lifecycle settings."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    assistant_name: str = Field(min_length=1, max_length=60)
    introduction: str = Field(min_length=1, max_length=350)
    language: str = Field(min_length=1, max_length=60)
    tone: str = Field(min_length=1, max_length=500)
    model: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    reasoning_effort: Literal["none"]
    model_timeout_seconds: float = Field(ge=1, le=120)
    max_completion_tokens: int = Field(ge=128, le=8192)
    max_tool_rounds: int = Field(ge=1, le=12)
    history_turns: int = Field(default=40, ge=1, le=200, strict=True)
    response_max_sentences: int = Field(ge=1, le=6)
    outcome_max_sentences: int = Field(ge=1, le=10)
    max_questions: int = Field(ge=1, le=2)
    stt_locale: str = Field(pattern=r"^[a-z]{2,3}(?:-[A-Z][A-Za-z0-9]{1,7})?$", max_length=20)
    stt_segmentation_ms: int = Field(ge=100, le=5000)
    stt_phrases: list[str] = Field(min_length=1)
    tts_voice: str = Field(min_length=1)
    tts_locale: str = Field(pattern=r"^[a-z]{2,3}(?:-[A-Z][A-Za-z0-9]{1,7})?$", max_length=20)
    tts_gender: Literal["Female", "Male"]
    tts_first_audio_seconds: float = Field(ge=1, le=60)
    tts_progress_seconds: float = Field(ge=1, le=60)
    vad_confidence: float = Field(ge=0, le=1)
    vad_start_seconds: float = Field(ge=0.1, le=1)
    vad_stop_seconds: float = Field(ge=0.1, le=1)
    vad_min_volume: float = Field(ge=0, le=1)
    call_seconds: int = Field(ge=60, le=3600)
    startup_seconds: int = Field(ge=5, le=120)
    shutdown_seconds: int = Field(ge=1, le=30)
    tool_timeout_seconds: int = Field(ge=1, le=120)
    speech_timeout_seconds: float = Field(ge=0.3, le=3)
    inactive_seconds: float = Field(ge=15, le=300)

    @field_validator("assistant_name", "introduction", "language", "tone")
    @classmethod
    def validate_words(cls, value: str) -> str:
        """Validate and trim nonempty conversation text without control characters."""
        if not value.strip() or re.search(r"[\x00-\x1f\x7f]", value):
            raise ValueError("Conversation text must be nonempty and contain no control characters")
        return value.strip()

    @field_validator("introduction")
    @classmethod
    def validate_introduction(cls, value: str) -> str:
        """Restrict introduction placeholders to assistant name and planning horizon."""
        for _, field, spec, conversion in Formatter().parse(value):
            if field is not None and (
                field not in {"assistant_name", "horizon_days"} or spec or conversion
            ):
                raise ValueError("Introduction supports only {assistant_name} and {horizon_days}")
        return value


class HistoryConfig(BaseModel):
    """Conversation history storage and search limits."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    max_conversations: int = Field(default=200, ge=1, le=1000)
    max_messages: int = Field(default=2000, ge=1, le=10000)
    max_caption_chars: int = Field(default=16000, ge=1, le=100000)
    max_search_chars: int = Field(default=200, ge=1, le=1000)


class ExchangeConfig(BaseModel):
    """Exchange-rate provider request deadline."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    timeout_seconds: float = Field(default=5, ge=0.1, le=30, allow_inf_nan=False)


class MemoryConfig(BaseModel):
    """Conversational note size, count, and user-context retention limits."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    max_notes: int = Field(ge=1, le=20)
    max_note_chars: int = Field(ge=40, le=500)
    user_days: int = Field(ge=1, le=90)


class DiagnosticsConfig(BaseModel):
    """Bounded local retention for payload-free operational diagnostics."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    max_bytes: int = Field(default=2097152, ge=16384, le=16777216, strict=True)
    backup_count: int = Field(default=3, ge=1, le=10, strict=True)


class Config(BaseModel):
    """Application behavior, financial bounds, and service configuration."""

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
    workspace_max_questions: int = Field(default=3, ge=1, le=10)
    workspace_max_actions: int = Field(default=6, ge=1, le=20)
    history: HistoryConfig = Field(default_factory=HistoryConfig)
    exchange: ExchangeConfig = Field(default_factory=ExchangeConfig)
    diagnostics: DiagnosticsConfig = Field(default_factory=DiagnosticsConfig)
    memory: MemoryConfig
    auth: AuthConfig
    voice: VoiceConfig

    @model_validator(mode="after")
    def validate_limits(self) -> "Config":
        """Require the aggregate money limit to cover individual amounts."""
        if self.max_total_paise < self.max_money_paise:
            raise ValueError("Aggregate money limit must cover the per-amount limit")
        return self


class Environment(BaseModel):
    """Deployment environment, storage location, and provider credentials."""

    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

    app_env: Literal["local", "staging"] = "local"
    public_origin: str = "http://localhost:8000"
    data_dir: Path = ROOT / ".data"
    google_client_id: str = Field(default="", max_length=255, pattern=r"^[A-Za-z0-9_.-]*$")
    google_client_secret: SecretStr | None = Field(default=None, repr=False)
    auth_encryption_key: SecretStr | None = Field(default=None, repr=False)
    azure_openai_api_key: SecretStr | None = Field(default=None, repr=False)
    azure_openai_endpoint: str = ""
    daily_api_key: SecretStr | None = Field(default=None, repr=False)
    azure_speech_key: SecretStr | None = Field(default=None, repr=False)
    azure_speech_region: str = Field(
        default="", pattern=r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)?$"
    )
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    # Unset selects colored console output on a terminal and JSON lines elsewhere.
    log_format: Literal["json", "console"] | None = None

    @field_validator("log_level", mode="before")
    @classmethod
    def validate_log_level(cls, value: object) -> object:
        """Accept log levels in any letter case."""
        return value.upper() if isinstance(value, str) else value

    @field_validator("auth_encryption_key")
    @classmethod
    def validate_auth_key(cls, value: SecretStr | None) -> SecretStr | None:
        """Validate a supplied authentication encryption key or treat blanks as absent."""
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
        """Check whether Google sign-in credentials are complete."""
        return bool(
            self.google_client_id
            and self.google_client_secret
            and self.google_client_secret.get_secret_value().strip()
            and self.auth_encryption_key
        )

    @field_validator("azure_openai_endpoint")
    @classmethod
    def validate_azure_endpoint(cls, value: str) -> str:
        """Validate and normalize an Azure OpenAI resource endpoint."""
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
        """Identify missing Azure OpenAI credentials and endpoint configuration."""
        missing = []
        if (
            not self.azure_openai_api_key
            or not self.azure_openai_api_key.get_secret_value().strip()
        ):
            missing.append("AZURE_OPENAI_API_KEY")
        if not self.azure_openai_endpoint:
            missing.append("AZURE_OPENAI_ENDPOINT")
        return missing

    @model_validator(mode="after")
    def validate_origin(self) -> "Environment":
        """Validate and normalize the public origin under deployment security rules."""
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
        """Load deployment settings and credentials from supported environment values."""
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
                    "DAILY_API_KEY",
                    "AZURE_SPEECH_KEY",
                    "AZURE_SPEECH_REGION",
                    "LOG_LEVEL",
                    "LOG_FORMAT",
                )
                if name in os.environ
            }
        )


def load_config(path: Path = ROOT / "config.toml") -> Config:
    """Load and validate application behavior from a TOML configuration file."""
    with path.open("rb") as file:
        return Config.model_validate(tomllib.load(file))
