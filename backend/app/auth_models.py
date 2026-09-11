# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel


@dataclass(frozen=True)
class Access:
    user_id: str
    session_hash: str = field(repr=False)


Owner = str | Access
ReturnPath = Literal["/app", "/figures", "/account"]


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
