# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Literal, get_args
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel


@dataclass(frozen=True)
class Access:
    """Authenticated user identity bound to a hashed login session."""

    user_id: str
    session_hash: str = field(repr=False)


Owner = str | Access
FixedReturnPath = Literal[
    "/app",
    "/money",
    "/money/income",
    "/money/spending",
    "/money/debts",
    "/money/upcoming",
    "/money/changes",
    "/account",
    "/history",
]
CONVERSATION_PATH = r"/(?:history|app)/[a-z0-9]+(?:-[a-z0-9]+)*"


def is_return_path(value: str) -> bool:
    """Check whether a return destination is an allowed application route."""
    return value in get_args(FixedReturnPath) or (
        len(value) <= 128 and re.fullmatch(CONVERSATION_PATH, value) is not None
    )


def validate_return_path(value: str) -> str:
    """Reject return destinations outside the allowed application routes."""
    if not is_return_path(value):
        raise ValueError("Invalid return path")
    return value


ReturnPath = (
    FixedReturnPath
    | Annotated[
        str,
        Field(pattern="^" + CONVERSATION_PATH + "$", max_length=128),
        AfterValidator(validate_return_path),
    ]
)


class AuthModel(BaseModel):
    """Strict authentication payload with camel-case aliases."""

    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


class AuthSettings(AuthModel):
    """Public sign-in availability and session lifetime settings."""

    google_available: bool
    session_hours: int


class LoginRequest(AuthModel):
    """Sign-in request with an allowed application return destination."""

    return_to: ReturnPath = "/app"


class LoginURL(AuthModel):
    """Provider sign-in URL returned to the client."""

    url: str


class User(AuthModel):
    """Account identity with chosen display name and Google profile details."""

    id: UUID
    display_name: str
    google_name: str
    email: str


class AuthSession(AuthModel):
    """Authenticated account profile and session expiry."""

    user: User
    expires_at: datetime


class AccountUpdate(AuthModel):
    """Requested account display-name change."""

    display_name: str = Field(min_length=1, max_length=80, strict=True)

    @field_validator("display_name", mode="before")
    @classmethod
    def validate_name(cls, value: object) -> object:
        """Trim display names and reject control or invisible formatting characters."""
        if isinstance(value, str):
            if any(unicodedata.category(char).startswith("C") for char in value):
                raise ValueError("Display name cannot contain control characters")
            return value.strip()
        return value


class AccountDelete(AuthModel):
    """Explicit confirmation for account deletion."""

    confirmation: Literal["DELETE"]


class AccountDeleted(AuthModel):
    """Successful account deletion acknowledgement."""

    deleted: Literal[True] = True
