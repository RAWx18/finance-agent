# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from time import monotonic
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import aiohttp

from .auth import Auth, AuthProblem
from .auth_models import Access, Owner
from .config import Config, Environment
from .history import CaptionHistory, History
from .models import CallJoin, CallState, Error, Snapshot
from .store import Problem, Store
from .voice_pipeline import VoicePipeline

VOICE_UNAVAILABLE = "Conversations are temporarily unavailable. Please try again shortly."
logger = logging.getLogger(__name__)


def unavailable_reason(config: Config, environment: Environment) -> str | None:
    """Describe missing voice credentials and region settings, if any."""
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
    """Validate speech locales and the configured voice against Azure's voice list."""
    from pipecat.transcriptions.language import Language

    try:
        Language(config.voice.stt_locale)
        Language(config.voice.tts_locale)
    except ValueError:
        raise Problem(
            503,
            "voiceUnavailable",
            "Configured speech locale is unsupported; "
            "verify voice.stt_locale and voice.tts_locale.",
        ) from None
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
            and voice.get("Gender") == config.voice.tts_gender
            and voice.get("Locale") == config.voice.tts_locale
            for voice in voices
        ):
            raise Problem(
                503,
                "voiceUnavailable",
                f"Configured {config.voice.tts_gender.lower()} {config.voice.language} voice "
                "is unavailable in this Azure Speech resource; "
                "verify voice.tts_voice, voice.tts_locale, and AZURE_SPEECH_REGION.",
            )
    except (aiohttp.ClientError, TimeoutError, ValueError):
        raise Problem(
            503,
            "voiceUnavailable",
            "Azure Speech voice check failed; verify the resource region and service connectivity.",
        ) from None


class DailyRooms:
    """Daily room and meeting-token client."""

    def __init__(self, environment: Environment, timeout: float):
        """Create an authenticated HTTP session with the supplied timeout."""
        assert environment.daily_api_key
        self.http = aiohttp.ClientSession(
            headers={"Authorization": "Bearer " + environment.daily_api_key.get_secret_value()},
            timeout=aiohttp.ClientTimeout(total=timeout),
        )

    async def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        """Send a Daily API request and translate invalid responses into service errors."""
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
            if method == "DELETE":
                return None
            try:
                return await response.json()
            except (ValueError, aiohttp.ContentTypeError) as error:
                logger.warning("Daily response HTTP %s (%s)", response.status, type(error).__name__)
                raise Problem(
                    503, "voiceUnavailable", "Daily room service is unavailable."
                ) from None

    async def create(self, name: str, expires: int) -> str:
        """Create a private audio room and validate its returned URL and identity."""
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
        try:
            if not isinstance(room, dict) or not isinstance(room.get("url"), str):
                raise ValueError
            url = urlsplit(room["url"])
            if (
                room.get("name") != name
                or room.get("privacy") != "private"
                or url.scheme != "https"
                or not url.hostname
                or re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.daily\.co", url.hostname)
                is None
                or url.username
                or url.password
                or url.port not in {None, 443}
                or url.path != "/" + name
                or url.query
                or url.fragment
                or any(character.isspace() or ord(character) < 32 for character in room["url"])
            ):
                raise ValueError
        except ValueError:
            logger.warning("Daily room response type %s", type(room).__name__)
            raise Problem(503, "voiceUnavailable", "Daily returned an invalid room.") from None
        return str(room["url"])

    async def token(self, name: str, expires: int, user_id: UUID) -> str:
        """Issue and validate an expiring, audio-only participant token."""
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
        if (
            not isinstance(result, dict)
            or not isinstance(result.get("token"), str)
            or not result["token"].strip()
        ):
            logger.warning("Daily token response type %s", type(result).__name__)
            raise Problem(503, "voiceUnavailable", "Daily returned an invalid token.")
        return str(result["token"])

    async def delete(self, name: str) -> None:
        """Delete the named room, treating an absent room as already deleted."""
        await self.request("DELETE", "/rooms/" + name)

    async def close(self) -> None:
        """Close the Daily API HTTP session."""
        await self.http.close()


@dataclass
class Call:
    """Voice call identity, lifecycle state, and owned resources."""

    owner: Owner
    id: UUID
    state: CallState
    join: asyncio.Future[CallJoin]
    stop: asyncio.Event = field(default_factory=asyncio.Event)
    running: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task[None] | None = None
    teardown: asyncio.Task[None] | None = None
    pipeline: VoicePipeline | None = None
    revoked: bool = False
    stopping: bool = False
    room_name: str = field(default_factory=lambda: "finance-" + uuid4().hex)
    rooms: DailyRooms | None = None
    history: History | None = None
    operations: dict[str, asyncio.Task[bool]] = field(default_factory=dict)
    watchers: list[asyncio.Task[Any]] = field(default_factory=list)
    admitted_at: float = field(default_factory=monotonic)
    timings: dict[str, float] = field(default_factory=dict)
    session_id: UUID | None = None
    resume_slug: str | None = None

    def mark(self, stage: str) -> None:
        """Record and log a lifecycle stage's elapsed time since admission."""
        # Monotonic seconds since admission; repeated stages record the latest attempt.
        self.timings[stage] = monotonic() - self.admitted_at
        logger.info(
            "Voice lifecycle call=%s stage=%s elapsed_seconds=%.6f",
            self.id,
            stage,
            self.timings[stage],
        )


class CallManager:
    """Serialized voice-call admission, supervision, and resource cleanup."""

    def __init__(
        self, store: Store, config: Config, environment: Environment, auth: Auth | None = None
    ):
        """Initialize call ownership, admission locks, and voice-check state."""
        self.store = store
        self.config = config
        self.environment = environment
        self.auth = auth
        self.call: Call | None = None
        self.lock = asyncio.Lock()
        self.closed = False
        self.attempts: dict[tuple[Owner, UUID], datetime | None] = {}
        self.voice_checked = False
        self.voice_lock = asyncio.Lock()

    async def prepare_voice(self) -> None:
        """Serialize voice checks and cache only a successful check."""
        async with self.voice_lock:
            if not self.voice_checked:
                # Configuration is immutable for the manager's lifetime; failures remain retryable.
                await check_voice(self.config, self.environment)
                self.voice_checked = True

    def remember(self, owner: Owner, call_id: UUID) -> None:
        """Retain attempted call identities and enforce per-user identity capacity."""
        now = self.store.clock()
        self.attempts = {
            key: expires
            for key, expires in self.attempts.items()
            if expires is None or expires > now
        }
        if (owner, call_id) in self.attempts:
            return
        # Retain identities beyond the login's maximum lifetime; never evict a live tombstone.
        user = owner.user_id if isinstance(owner, Access) else owner
        if (
            sum(
                (access.user_id if isinstance(access, Access) else access) == user
                for access, _ in self.attempts
            )
            >= self.config.max_commands
        ):
            raise Problem(
                409, "callLimit", "Call identity capacity reached; try after sign-in expiry."
            )
        self.attempts[owner, call_id] = (
            now + timedelta(hours=self.config.auth.session_hours)
            if isinstance(owner, Access)
            else None
        )

    def state(self, owner: Owner) -> CallState:
        """Return the owner's call state with provider error details concealed."""
        if self.call and self.call.owner == owner:
            state = self.call.state.model_copy()
            if state.status == "error":
                state.message = VOICE_UNAVAILABLE
            return state
        return CallState()

    def check_idle(self) -> None:
        """Reject admission while a call or its cleanup remains unsettled."""
        call = self.call
        if call and (
            call.state.status in {"connecting", "active", "ending"}
            or not call.state.cleanup_confirmed
            or call.task is not None
            and not call.task.done()
            or call.teardown is not None
            and not call.teardown.done()
            or any(not task.done() for task in call.operations.values())
        ):
            raise Problem(409, "callBusy", "A voice call is already running or ending.")

    async def select(self, owner: Owner, slug: str) -> Snapshot:
        """Select a saved conversation only while voice admission is idle."""
        await self.store.check(owner)
        async with self.lock:
            if self.closed:
                raise Problem(503, "voiceUnavailable", "Voice is shutting down.")
            self.check_idle()
            return await History(self.store).select(owner, slug)

    async def start(
        self, owner: Owner, call_id: UUID, conversation_slug: str | None = None
    ) -> CallJoin:
        """Admit or rejoin an identified call and await valid browser credentials."""
        snapshot = await self.store.get(owner)
        async with self.lock:
            if self.closed:
                raise Problem(503, "voiceUnavailable", "Voice is shutting down.")
            call = self.call
            if call and call.owner == owner and call.id == call_id:
                if call.stop.is_set() or call.state.status not in {"connecting", "active"}:
                    raise Problem(409, "callEnded", "This call has ended; use a fresh call ID.")
                if conversation_slug != call.resume_slug:
                    raise Problem(409, "conversationChanged", "Call belongs to another chat.")
            else:
                if (owner, call_id) in self.attempts:
                    raise Problem(409, "callEnded", "This call has ended; use a fresh call ID.")
                self.check_idle()
                if (
                    conversation_slug is not None
                    and snapshot.conversation_slug != conversation_slug
                ):
                    raise Problem(
                        409, "conversationChanged", "Select this conversation before starting it."
                    )
                self.remember(owner, call_id)
                reason = unavailable_reason(self.config, self.environment)
                if reason:
                    raise Problem(503, "voiceUnavailable", reason)
                call = Call(
                    owner,
                    call_id,
                    CallState(
                        call_id=call_id,
                        conversation_slug=conversation_slug,
                        status="connecting",
                        cleanup_confirmed=False,
                    ),
                    asyncio.get_running_loop().create_future(),
                    session_id=snapshot.session_id,
                    resume_slug=conversation_slug,
                )
                call.join.add_done_callback(
                    lambda future: None if future.cancelled() else future.exception()
                )
                self.call = call
                call.task = asyncio.create_task(self.run(call))
        try:
            done, _ = await asyncio.wait(
                {call.join},
                timeout=self.config.voice.startup_seconds + self.config.voice.shutdown_seconds,
            )
            if not done:
                self.stop(call)
                raise Problem(
                    503, "voiceUnavailable", "Voice setup failed; continue with manual entry."
                )
            result = call.join.result()
            await self.store.check(owner)
            async with self.store.lock:
                await self.store.owner_key(owner)
            if result.expires_at <= self.store.clock():
                call.state.message = "Call credentials expired; start a new conversation."
                self.stop(call)
            if call.stop.is_set():
                raise Problem(409, "callEnded", "This call has ended; use a fresh call ID.")
            return result
        except Problem:
            try:
                await self.store.check(owner)
            finally:
                if call.revoked and call.task is not None:
                    await asyncio.wait({call.task}, timeout=self.config.voice.shutdown_seconds)
            raise
        except asyncio.CancelledError:
            self.stop(call)
            raise

    def stop(self, call: Call) -> None:
        """Invalidate call output and request lifecycle cancellation."""
        if "shutdownRequested" not in call.timings:
            call.mark("shutdownRequested")
        call.stop.set()
        if call.pipeline is not None:
            call.pipeline.invalidate()
        if call.state.status in {"connecting", "active"}:
            call.state.status = "ending"
        if (
            call.task
            and call.running.is_set()
            and not call.stopping
            and not call.task.done()
            and call.task is not asyncio.current_task()
        ):
            call.task.cancel()

    async def end(self, owner: Owner, call_id: UUID) -> CallState:
        """End an owned call or retry its cleanup within the shutdown budget."""
        async with self.lock:
            call = self.call
            if not call or call.owner != owner or call.id != call_id:
                self.remember(owner, call_id)
                return CallState(call_id=call_id, status="ended")
            self.stop(call)
            if (
                call.task
                and call.task.done()
                and not call.state.cleanup_confirmed
                and (call.teardown is None or call.teardown.done())
            ):
                call.teardown = asyncio.create_task(self.cleanup(call))
            task = call.teardown or call.task
        if task and task is not asyncio.current_task():
            await asyncio.wait({task}, timeout=self.config.voice.shutdown_seconds)
        state = call.state.model_copy()
        if state.status == "error":
            state.message = VOICE_UNAVAILABLE
        return state

    def invalidate(self, user_id: str, session_hash: str | None = None) -> None:
        """Revoke matching authenticated calls and discard their admission identities."""
        self.attempts = {
            key: expires
            for key, expires in self.attempts.items()
            if not (
                isinstance(key[0], Access)
                and key[0].user_id == user_id
                and (session_hash is None or key[0].session_hash == session_hash)
            )
        }
        call = self.call
        if (
            call is not None
            and isinstance(call.owner, Access)
            and call.owner.user_id == user_id
            and (session_hash is None or call.owner.session_hash == session_hash)
        ):
            call.revoked = True
            self.stop(call)
            if call.state.cleanup_confirmed and call.task is not None and call.task.done():
                self.call = None

    async def settle_revoked(self) -> None:
        """Await bounded termination of a revoked call."""
        call = self.call
        if call and call.revoked and call.task and call.task is not asyncio.current_task():
            await self.end(call.owner, call.id)

    async def close(self) -> None:
        """Block further admission and end the current call."""
        self.closed = True
        if self.call:
            await self.end(self.call.owner, self.call.id)

    async def watch(
        self, call: Call, pipeline: VoicePipeline, queue: asyncio.Queue[Snapshot | Error]
    ) -> None:
        """Refresh voice state and stop or interrupt calls when shared state changes."""
        sequence = pipeline.sequence
        while True:
            value: Snapshot | Error | None = None
            try:
                value = await asyncio.wait_for(queue.get(), self.config.heartbeat_seconds)
            except TimeoutError:
                pass
            if isinstance(value, Error):
                pipeline.invalidate()
                call.stop.set()
                return
            value = await self.store.get(call.owner)
            if call.session_id is not None and (
                value.session_id != call.session_id
                or value.conversation_slug != call.state.conversation_slug
            ):
                pipeline.invalidate()
                call.stop.set()
                return
            if value.sequence <= sequence:
                continue
            sequence = value.sequence
            pipeline.refresh(value)
            if pipeline.tools and value.sequence != pipeline.tools.written_sequence:
                await pipeline.interrupt()

    async def run(self, call: Call) -> None:
        """Set up, supervise, and tear down a call within its lifecycle deadlines."""
        call.running.set()
        call.mark("setupStarted")
        voice = self.config.voice
        queue: asyncio.Queue[Snapshot | Error] | None = None
        setup_error: Problem | None = None
        history = History(self.store)

        def fail() -> None:
            """Invalidate the pipeline and mark the call as failed before stopping."""
            if call.pipeline is not None:
                call.pipeline.invalidate()
            if call.state.status == "error":
                call.stop.set()
                return
            call.state = CallState(
                call_id=call.id,
                conversation_slug=call.state.conversation_slug,
                status="error",
                cleanup_confirmed=False,
                message="Voice provider unavailable; continue with manual entry.",
            )
            call.stop.set()

        try:
            pipeline = VoicePipeline()
            call.pipeline = pipeline
            async with asyncio.timeout(voice.startup_seconds):
                if call.revoked:
                    raise AuthProblem(401, "unauthenticated")
                if call.stop.is_set():
                    raise asyncio.CancelledError
                snapshot = await self.store.get(call.owner)
                if snapshot.session_id != call.session_id:
                    raise Problem(409, "sessionChanged", "The financial session has changed.")
                call.state.conversation_slug = await history.start(
                    call.owner, call.id, snapshot.session_id, call.resume_slug
                )
                call.history = history
                snapshot = await self.store.get(call.owner)
                call.session_id = snapshot.session_id
                pipeline.history = CaptionHistory(history, call.owner, call.id)
                pipeline.resume_slug = call.resume_slug
                pipeline.resume_messages = (
                    await history.recent(call.owner, call.id) if call.resume_slug else []
                )
                expires = min(
                    self.store.clock() + timedelta(seconds=voice.call_seconds),
                    snapshot.expires_at,
                )
                if isinstance(call.owner, Access):
                    if self.auth is None:
                        raise AuthProblem(401, "unauthenticated")
                    expires = min(expires, (await self.auth.session(call.owner)).expires_at)
                call.mark("voiceCheckStarted")
                await self.prepare_voice()
                call.mark("voiceCheckComplete")
                if call.stop.is_set():
                    raise asyncio.CancelledError
                rooms = DailyRooms(self.environment, voice.startup_seconds)
                call.rooms = rooms
                call.mark("roomCreateStarted")
                url = await rooms.create(call.room_name, int(expires.timestamp()))
                call.mark("roomCreateComplete")
                if call.stop.is_set():
                    raise asyncio.CancelledError
                call.mark("tokensStarted")
                try:
                    # Settle both requests before teardown can delete their room.
                    async with asyncio.TaskGroup() as tokens:
                        browser_token = tokens.create_task(
                            rooms.token(call.room_name, int(expires.timestamp()), uuid4())
                        )
                        bot_token = tokens.create_task(
                            rooms.token(call.room_name, int(expires.timestamp()), uuid4())
                        )
                except ExceptionGroup as error:
                    for cause in error.exceptions:
                        if isinstance(cause, Problem):
                            raise cause from None
                    raise
                call.mark("tokensComplete")
                if call.stop.is_set():
                    raise asyncio.CancelledError
                queue = await self.store.subscribe(call.owner)
                async with self.store.lock, self.store.transaction():
                    await history.active(call.owner, call.id)
                call.mark("pipelineConstructionStarted")
                await pipeline.start(
                    self.store,
                    call.owner,
                    call.id,
                    url,
                    bot_token.result(),
                    self.environment,
                    fail,
                    call.stop.set,
                )
                call.mark("pipelineConstructionComplete")
                await self.store.check(call.owner)
                async with self.store.lock:
                    await self.store.owner_key(call.owner)
                    await history.active(call.owner, call.id)
                    if call.revoked:
                        raise AuthProblem(401, "unauthenticated")
                    if call.stop.is_set():
                        raise asyncio.CancelledError
                    if self.store.clock() >= expires:
                        raise Problem(
                            503, "voiceUnavailable", "Call credentials expired during setup."
                        )
                    assert call.state.conversation_slug is not None
                    call.join.set_result(
                        CallJoin(
                            call_id=call.id,
                            conversation_slug=call.state.conversation_slug,
                            url=url,
                            token=browser_token.result(),
                            expires_at=expires,
                        )
                    )
                    call.mark("joinSupplied")
            watcher = asyncio.create_task(self.watch(call, pipeline, queue))

            def watch_finished(task: asyncio.Task[None]) -> None:
                """Fail the call when its state watcher exits with an exception."""
                if not task.cancelled() and task.exception() is not None:
                    fail()

            watcher.add_done_callback(watch_finished)
            call.watchers.append(watcher)
            call.mark("readinessStarted")
            readiness = asyncio.create_task(pipeline.ready())
            stopped = asyncio.create_task(call.stop.wait())
            call.watchers.extend([readiness, stopped])
            done, _ = await asyncio.wait(
                [readiness, stopped],
                timeout=voice.startup_seconds,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if stopped not in done:
                if readiness not in done:
                    raise TimeoutError
                readiness.result()
                call.state = CallState(
                    call_id=call.id,
                    conversation_slug=call.state.conversation_slug,
                    status="active",
                    cleanup_confirmed=False,
                )
                call.mark("ready")
                remaining = max(0.0, (expires - self.store.clock()).total_seconds())
                try:
                    await asyncio.wait_for(call.stop.wait(), remaining)
                except TimeoutError:
                    call.state.message = "Call credentials expired; start a new conversation."
        except asyncio.CancelledError:
            call.stop.set()
        except Problem as error:
            fail()
            setup_error = (
                AuthProblem(401, error.body.code)
                if isinstance(error, AuthProblem) and error.status == 401
                else error
                if error.status in {404, 409, 410}
                else Problem(503, "voiceUnavailable", error.body.message)
            )
            call.state.message = setup_error.body.message
        except (Exception, SystemExit) as error:
            logger.warning("Voice lifecycle failed (%s)", type(error).__name__)
            fail()
        finally:
            call.stopping = True
            if queue is not None:
                self.store.unsubscribe(call.owner, queue)
            call.teardown = asyncio.create_task(self.finish(call, setup_error))
            try:
                await asyncio.shield(call.teardown)
            except asyncio.CancelledError:
                pass

    async def finish(self, call: Call, setup_error: Problem | None) -> None:
        """Clean up the call and reject any unresolved join request."""
        try:
            await self.cleanup(call)
        finally:
            if not call.join.done():
                if call.revoked and (setup_error is None or setup_error.status != 401):
                    setup_error = AuthProblem(401, "unauthenticated")
                call.join.set_exception(
                    setup_error
                    or Problem(
                        503,
                        "voiceUnavailable",
                        "Voice setup failed; continue with manual entry.",
                    )
                )

    async def cleanup(self, call: Call) -> None:
        """Settle call resources with bounded, retryable cleanup operations."""
        call.stopping = True
        if "shutdownRequested" not in call.timings:
            call.mark("shutdownRequested")
        call.mark("shutdownStarted")
        call.stop.set()
        if call.state.status != "error":
            call.state.status = "ending"
        if call.pipeline is not None:
            call.pipeline.invalidate()
        for watcher in call.watchers:
            if not watcher.done():
                watcher.cancel()
        deadline = asyncio.get_running_loop().time() + self.config.voice.shutdown_seconds

        def completed(name: str) -> bool:
            """Check whether a named cleanup operation finished successfully."""
            task = call.operations.get(name)
            return bool(task and task.done() and not task.cancelled() and task.result())

        def launch(name: str, operation: Callable[[], Awaitable[None]]) -> None:
            """Start or retry a cleanup operation unless it is pending or successful."""
            task = call.operations.get(name)
            if task and (not task.done() or completed(name)):
                return

            async def execute() -> bool:
                """Run a cleanup operation and record its timing and success status."""
                call.mark(name + "Started")
                try:
                    await operation()
                    call.mark(name + "Complete")
                    return True
                except (Exception, asyncio.CancelledError, SystemExit) as error:
                    if (
                        name == "history"
                        and isinstance(error, Problem)
                        and error.status in {401, 404, 410}
                    ):
                        call.mark(name + "Complete")
                        return True
                    call.mark(name + "Failed")
                    logger.warning("Voice cleanup %s failed (%s)", name, type(error).__name__)
                    return False

            call.operations[name] = asyncio.create_task(execute())

        if call.pipeline is not None:
            launch("pipeline", call.pipeline.close)
        if call.history is not None:
            history = call.history
            # Revocation blocks further captions; history closure need not await native media.
            launch("history", lambda: history.finish(call.owner, call.id))
        # A failed DELETE needs a fresh HTTP client, not a replacement room or worker.
        task = call.operations.get("roomDelete")
        if call.rooms is None and task is not None and not completed("roomDelete"):
            if task.done():
                call.rooms = DailyRooms(self.environment, self.config.voice.shutdown_seconds)
                call.operations.pop("roomClose", None)
        if call.rooms is not None:
            rooms = call.rooms
            launch("roomDelete", lambda: rooms.delete(call.room_name))

        task = call.operations.get("roomDelete")
        if task is not None and not task.done():
            # Reserve half the total teardown budget for closing the HTTP client after DELETE.
            _, pending = await asyncio.wait({task}, timeout=self.config.voice.shutdown_seconds / 2)
            for task in pending:
                task.cancel()
        if call.rooms is not None:
            launch("roomClose", call.rooms.close)
        pending = {task for task in [*call.operations.values(), *call.watchers] if not task.done()}
        if pending:
            _, pending = await asyncio.wait(
                pending, timeout=max(0, deadline - asyncio.get_running_loop().time())
            )
            for task in pending:
                task.cancel()
        call.state.cleanup_confirmed = all(
            completed(name) for name in call.operations if name != "history"
        ) and all(task.done() for task in call.watchers)
        if completed("roomClose") and call.operations["roomDelete"].done():
            call.rooms = None
        if completed("pipeline"):
            call.pipeline = None
        if not call.state.cleanup_confirmed:
            call.state.status = "error"
            if call.state.message is None:
                call.state.message = "Call termination is unconfirmed; retry ending this call."
        elif call.state.status != "error":
            call.state.status = "ended"
        call.mark("shutdownComplete" if call.state.cleanup_confirmed else "shutdownUnconfirmed")
        if call.revoked and call.state.cleanup_confirmed and self.call is call:
            self.call = None
