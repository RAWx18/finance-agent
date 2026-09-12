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
    return value in get_args(FixedReturnPath) or (
        len(value) <= 128 and re.fullmatch(CONVERSATION_PATH, value) is not None
    )


def validate_return_path(value: str) -> str:
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
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


class AuthSettings(AuthModel):
    google_available: bool
    session_hours: int


class LoginRequest(AuthModel):
    return_to: ReturnPath = "/app"


class LoginURL(AuthModel):
    url: str


class User(AuthModel):
    id: UUID
    display_name: str
    google_name: str
    email: str


class AuthSession(AuthModel):
    user: User
    expires_at: datetime


class AccountUpdate(AuthModel):
    display_name: str = Field(min_length=1, max_length=80, strict=True)

    @field_validator("display_name", mode="before")
    @classmethod
    def validate_name(cls, value: object) -> object:
        if isinstance(value, str):
            if any(unicodedata.category(char).startswith("C") for char in value):
                raise ValueError("Display name cannot contain control characters")
            return value.strip()
        return value


class AccountDelete(AuthModel):
    confirmation: Literal["DELETE"]


class AccountDeleted(AuthModel):
    deleted: Literal[True] = True
