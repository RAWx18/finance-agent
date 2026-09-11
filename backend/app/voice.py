# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import logging
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import aiohttp

from .auth import Auth
from .auth_models import Access, Owner
from .config import Config, Environment
from .models import CallJoin, CallState, Error, Snapshot
from .store import Problem, Store
from .voice_pipeline import VoicePipeline

VOICE_UNAVAILABLE = "Conversations are temporarily unavailable. Please try again shortly."
logger = logging.getLogger(__name__)


def unavailable_reason(config: Config, environment: Environment) -> str | None:
    missing = environment.missing_azure_openai() + [
        name.upper()
        for name in ("daily_api_key", "azure_speech_key")
        if not getattr(environment, name)
        or not getattr(environment, name).get_secret_value().strip()
    ]
    if not environment.azure_speech_region:
        missing.append("AZURE_SPEECH_REGION")
    return "Missing setup: " + ", ".join(missing) + "." if missing else None


async def check_voice(config: Config, environment: Environment) -> None:
    assert environment.azure_speech_key and environment.azure_speech_region
    try:
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=config.voice.startup_seconds)
        ) as http:
            async with http.get(
                f"https://{environment.azure_speech_region}.tts.speech.microsoft.com"
                "/cognitiveservices/voices/list",
                headers={
                    "Ocp-Apim-Subscription-Key": environment.azure_speech_key.get_secret_value()
                },
                allow_redirects=False,
            ) as response:
                if response.status != 200:
                    raise Problem(
                        503,
                        "voiceUnavailable",
                        f"Azure Speech voice check returned HTTP {response.status}; "
                        "check the speech key, resource region, and service availability.",
                    )
                voices = await response.json()
        if not isinstance(voices, list):
            raise ValueError("Invalid voice list")
        if not any(
            isinstance(voice, dict)
            and voice.get("ShortName") == config.voice.tts_voice
            and voice.get("Gender") == "Female"
            and voice.get("Locale") == config.voice.tts_locale
            and config.voice.tts_locale.startswith("en-")
            for voice in voices
        ):
            raise Problem(
                503,
                "voiceUnavailable",
                "Configured female English voice is unavailable in this Azure Speech resource; "
                "verify voice.tts_voice, voice.tts_locale, and AZURE_SPEECH_REGION.",
            )
    except (aiohttp.ClientError, TimeoutError, ValueError):
        raise Problem(
            503,
            "voiceUnavailable",
            "Azure Speech voice check failed; verify the resource region and service connectivity.",
        ) from None


class DailyRooms:
    def __init__(self, environment: Environment, timeout: float):
        assert environment.daily_api_key
        self.http = aiohttp.ClientSession(
            headers={"Authorization": "Bearer " + environment.daily_api_key.get_secret_value()},
            timeout=aiohttp.ClientTimeout(total=timeout),
        )

    async def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        async with self.http.request(
            method,
            "https://api.daily.co/v1" + path,
            json=body,
            allow_redirects=False,
        ) as response:
            if method == "DELETE" and response.status == 404:
                return None
            if response.status not in {200, 201, 204}:
                logger.warning(
                    "Daily %s %s returned HTTP %s", method, path.split("/")[1], response.status
                )
                raise Problem(503, "voiceUnavailable", "Daily room service is unavailable.")
            return await response.json() if method != "DELETE" else None

    async def create(self, name: str, expires: int) -> str:
        room = await self.request(
            "POST",
            "/rooms",
            {
                "name": name,
                "privacy": "private",
                "properties": {
                    "exp": expires,
                    "eject_at_room_exp": True,
                    "start_video_off": True,
                    "max_participants": 2,
                    "permissions": {"canSend": ["audio"], "canAdmin": False},
                },
            },
        )
        url = urlsplit(room["url"])
        if (
            room["name"] != name
            or url.scheme != "https"
            or not url.hostname
            or not url.hostname.endswith(".daily.co")
            or url.username
            or url.password
            or url.port not in {None, 443}
            or url.query
            or url.fragment
        ):
            raise Problem(503, "voiceUnavailable", "Daily returned an invalid room.")
        return str(room["url"])

    async def token(self, name: str, expires: int, user_id: UUID) -> str:
        result = await self.request(
            "POST",
            "/meeting-tokens",
            {
                "properties": {
                    "room_name": name,
                    "exp": expires,
                    "user_id": str(user_id),
                    "is_owner": False,
                    "eject_at_token_exp": True,
                    "permissions": {"canSend": ["audio"], "canAdmin": False},
                }
            },
        )
        if not isinstance(result.get("token"), str) or not result["token"]:
            raise Problem(503, "voiceUnavailable", "Daily returned an invalid token.")
        return str(result["token"])

    async def delete(self, name: str) -> None:
        await self.request("DELETE", "/rooms/" + name)

    async def close(self) -> None:
        await self.http.close()


@dataclass
class Call:
    owner: Owner
    id: UUID
    state: CallState
    join: asyncio.Future[CallJoin]
    stop: asyncio.Event = field(default_factory=asyncio.Event)
    running: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task[None] | None = None
    pipeline: VoicePipeline | None = None
    revoked: bool = False


class CallManager:
    def __init__(
        self, store: Store, config: Config, environment: Environment, auth: Auth | None = None
    ):
        self.store = store
        self.config = config
        self.environment = environment
        self.auth = auth
        self.call: Call | None = None
        self.lock = asyncio.Lock()
        self.closed = False

    def state(self, owner: Owner) -> CallState:
        if self.call and self.call.owner == owner:
            state = self.call.state.model_copy()
            if state.status == "error":
                state.message = VOICE_UNAVAILABLE
            return state
        return CallState()

    async def start(self, owner: Owner) -> CallJoin:
        await self.store.get(owner)
        reason = unavailable_reason(self.config, self.environment)
        if reason:
            raise Problem(503, "voiceUnavailable", reason)
        async with self.lock:
            if self.closed:
                raise Problem(503, "voiceUnavailable", "Voice is shutting down.")
            if self.call and self.call.task and not self.call.task.done():
                raise Problem(409, "callBusy", "A voice call is already running.")
            call_id = uuid4()
            call = Call(
                owner,
                call_id,
                CallState(call_id=call_id, status="connecting"),
                asyncio.get_running_loop().create_future(),
            )
            self.call = call
            call.task = asyncio.create_task(self.run(call))
        try:
            result = await asyncio.shield(call.join)
            await self.store.check(owner)
            return result
        except Problem:
            await self.store.check(owner)
            raise
        except asyncio.CancelledError:
            call.stop.set()
            if call.task is not None and call.state.status == "connecting":
                await call.running.wait()
                call.task.cancel()
            call.join.add_done_callback(lambda future: future.exception())
            raise

    async def end(self, owner: Owner) -> CallState:
        call = self.call
        if call and call.owner == owner:
            call.stop.set()
            if call.task is not None and call.task is not asyncio.current_task():
                if call.state.status == "connecting" and not call.join.done():
                    await call.running.wait()
                    call.task.cancel()
                await asyncio.shield(call.task)
        return self.state(owner)

    def invalidate(self, user_id: str, session_hash: str | None = None) -> None:
        call = self.call
        if (
            call is not None
            and isinstance(call.owner, Access)
            and call.owner.user_id == user_id
            and (session_hash is None or call.owner.session_hash == session_hash)
        ):
            call.revoked = True
            call.stop.set()
            if call.pipeline is not None:
                call.pipeline.invalidate()
            if call.task is not None and call.task.done():
                self.call = None
            if call.task and call.running.is_set() and call.task is not asyncio.current_task():
                call.task.cancel()

    async def settle_revoked(self) -> None:
        call = self.call
        if call and call.revoked and call.task and call.task is not asyncio.current_task():
            await asyncio.shield(call.task)

    async def close(self) -> None:
        self.closed = True
        if self.call:
            await self.end(self.call.owner)

    async def watch(
        self, call: Call, pipeline: VoicePipeline, queue: asyncio.Queue[Snapshot | Error]
    ) -> None:
        sequence = pipeline.sequence
        while True:
            try:
                value = await asyncio.wait_for(queue.get(), self.config.heartbeat_seconds)
            except TimeoutError:
                await self.store.get(call.owner)
                continue
            if isinstance(value, Error):
                call.stop.set()
                return
            value = await self.store.get(call.owner)
            if value.sequence <= sequence:
                continue
            sequence = value.sequence
            pipeline.refresh(value)
            if pipeline.tools and value.sequence != pipeline.tools.written_sequence:
                await pipeline.interrupt()

    async def run(self, call: Call) -> None:
        call.running.set()
        voice = self.config.voice
        rooms: DailyRooms | None = None
        pipeline = VoicePipeline()
        call.pipeline = pipeline
        room_name = "finance-" + call.id.hex
        queue: asyncio.Queue[Snapshot | Error] | None = None
        tasks: list[asyncio.Task[Any]] = []
        setup_error: str | None = None

        def fail() -> None:
            call.state = CallState(
                call_id=call.id,
                status="error",
                message="Voice provider unavailable; continue with manual entry.",
            )
            call.stop.set()

        try:
            async with asyncio.timeout(voice.startup_seconds):
                if call.revoked:
                    raise Problem(401, "unauthenticated", "Sign in to continue.")
                snapshot = await self.store.get(call.owner)
                expires = min(
                    self.store.clock() + timedelta(seconds=voice.call_seconds),
                    snapshot.expires_at,
                )
                if isinstance(call.owner, Access):
                    if self.auth is None:
                        raise Problem(401, "unauthenticated", "Sign in to continue.")
                    expires = min(expires, (await self.auth.session(call.owner)).expires_at)
                await check_voice(self.config, self.environment)
                rooms = DailyRooms(self.environment, voice.startup_seconds)
                url = await rooms.create(room_name, int(expires.timestamp()))
                browser_token = await rooms.token(room_name, int(expires.timestamp()), uuid4())
                bot_token = await rooms.token(room_name, int(expires.timestamp()), uuid4())
                queue = await self.store.subscribe(call.owner)
                await pipeline.start(
                    self.store,
                    call.owner,
                    call.id,
                    url,
                    bot_token,
                    self.environment,
                    fail,
                    call.stop.set,
                )
                await self.store.check(call.owner)
                if call.revoked:
                    raise Problem(401, "unauthenticated", "Sign in to continue.")
                call.join.set_result(
                    CallJoin(
                        call_id=call.id,
                        url=url,
                        token=browser_token,
                        expires_at=expires,
                    )
                )
            watcher = asyncio.create_task(self.watch(call, pipeline, queue))

            def watch_finished(task: asyncio.Task[None]) -> None:
                if not task.cancelled() and task.exception() is not None:
                    fail()

            watcher.add_done_callback(watch_finished)
            tasks.append(watcher)
            readiness = asyncio.create_task(pipeline.ready())
            stopped = asyncio.create_task(call.stop.wait())
            tasks.extend([readiness, stopped])
            done, _ = await asyncio.wait(
                [readiness, stopped],
                timeout=voice.startup_seconds,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if stopped not in done:
                if readiness not in done:
                    raise TimeoutError
                readiness.result()
                call.state = CallState(call_id=call.id, status="active")
                remaining = max(0.0, (expires - self.store.clock()).total_seconds())
                with suppress(TimeoutError):
                    await asyncio.wait_for(call.stop.wait(), remaining)
        except asyncio.CancelledError:
            call.stop.set()
        except Problem as error:
            fail()
            setup_error = error.body.message
            call.state.message = setup_error
        except Exception as error:
            logger.warning("Voice lifecycle failed (%s)", type(error).__name__)
            fail()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if queue is not None:
                self.store.unsubscribe(call.owner, queue)
            try:
                async with asyncio.timeout(voice.shutdown_seconds):
                    await pipeline.close()
            except Exception:
                fail()
            if rooms is not None:
                try:
                    async with asyncio.timeout(voice.shutdown_seconds):
                        await rooms.delete(room_name)
                except Exception:
                    fail()
                finally:
                    await rooms.close()
            if call.state.status != "error":
                call.state = CallState(call_id=call.id, status="ended")
            if not call.join.done():
                call.join.set_exception(
                    Problem(
                        503,
                        "voiceUnavailable",
                        setup_error or "Voice setup failed; continue with manual entry.",
                    )
                )
            if call.revoked and self.call is call:
                self.call = None
            call.pipeline = None
