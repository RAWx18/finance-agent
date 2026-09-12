# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

"""Authenticated, observational diagnostics for the isolated lifecycle probe."""

import asyncio
import json
import math
import re
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from time import monotonic

from fastapi import Request

from .auth_support import browser_app as authenticated_app


def timings(values):
    """Filter timing diagnostics to safe labels and rounded nonnegative finite numbers."""
    return {
        name: round(value, 6)
        for name, value in values.items()
        if re.fullmatch(r"[A-Za-z][A-Za-z0-9_.#-]{0,119}", name)
        and type(value) in {float, int}
        and math.isfinite(value)
        and value >= 0
    }


def task_state(task):
    """Summarize whether an optional task exists and has completed."""
    return {"present": task is not None, "done": task.done() if task is not None else None}


def task_stack(task):
    """Collect a bounded coroutine stack while withholding custom task labels and paths."""
    # Task labels can contain runtime data; only asyncio's generated names are emitted.
    name = task.get_name()
    frames = []
    coroutine = task.get_coro()
    for _ in range(24):
        code = getattr(coroutine, "cr_code", getattr(coroutine, "gi_code", None))
        frame = getattr(coroutine, "cr_frame", getattr(coroutine, "gi_frame", None))
        if code is not None:
            frames.append(
                {
                    "function": code.co_name,
                    "source": Path(code.co_filename).name,
                    "line": frame.f_lineno if frame is not None else code.co_firstlineno,
                }
            )
        coroutine = getattr(coroutine, "cr_await", getattr(coroutine, "gi_yieldfrom", None))
        if coroutine is None:
            break
    return {
        "name": name if re.fullmatch(r"Task-\d+", name) else "named-task",
        "cancelling": task.cancelling(),
        "stack": frames,
    }


def call_probe(call, pipeline):
    """Describe call lifecycle flags, timings, and owned task completion states."""
    return {
        "callId": str(call.id),
        "status": call.state.status,
        "cleanupConfirmed": call.state.cleanup_confirmed,
        "secondsSinceAdmission": round(monotonic() - call.admitted_at, 6),
        "timings": timings(call.timings),
        "pipelineTimings": timings(getattr(pipeline, "timings", {})),
        "started": bool(pipeline and pipeline.started.is_set()),
        "joined": bool(pipeline and pipeline.joined.is_set()),
        "client_ready": bool(pipeline and pipeline.client_ready.is_set()),
        "running": call.running.is_set(),
        "stop": call.stop.is_set(),
        "task": task_state(call.task),
        "teardown": task_state(call.teardown),
        "workerTask": task_state(getattr(getattr(pipeline, "worker", None), "task", None)),
        "pipelineTask": task_state(getattr(pipeline, "task", None)),
        "operations": {name: task_state(task) for name, task in call.operations.items()},
    }


def browser_app():
    """Build an authenticated browser app with call lifecycle observation and diagnostics."""
    application = authenticated_app()
    lifespan = application.router.lifespan_context
    calls = {}
    pipelines = {}
    rooms = set()

    def observe():
        """Retain observed calls and pipelines and persist their room names for cleanup."""
        call = application.state.calls.call
        if call is None:
            return
        calls[call.id] = call
        if call.pipeline is not None:
            pipelines[call.id] = call.pipeline
        if call.room_name not in rooms:
            rooms.add(call.room_name)
            path = application.state.calls.environment.data_dir / "lifecycleRooms.json"
            path.write_text(json.dumps(sorted(rooms)))

    @asynccontextmanager
    async def observed_lifespan(app):
        """Run the lifecycle monitor inside the application lifespan and cancel it on exit."""

        async def monitor():
            """Sample the active call repeatedly so short-lived lifecycle states are retained."""
            while True:
                observe()
                await asyncio.sleep(0.02)

        async with lifespan(app):
            task = asyncio.create_task(monitor(), name="lifecycle-observer")
            try:
                yield
            finally:
                observe()
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

    application.router.lifespan_context = observed_lifespan

    @application.get("/__test/lifecycle", include_in_schema=False)
    async def lifecycle(request: Request):
        """Expose owned call state and optional bounded task diagnostics to a signed-in probe."""
        access = await application.state.auth.identify(request)
        observe()
        tasks = [task for task in asyncio.all_tasks() if not task.done()]
        owned = [call for call in calls.values() if call.owner == access]
        result = {
            "factory": "lifecycle",
            "call": call_probe(owned[-1], pipelines.get(owned[-1].id)) if owned else None,
            "callsObserved": len(owned),
            "liveTasks": len(tasks),
        }
        if request.query_params.get("diagnostics") == "true":
            result["tasks"] = [task_stack(task) for task in tasks[:120]]
            result["tasksTruncated"] = len(tasks) > 120
        return result

    application.router.routes.insert(0, application.router.routes.pop())
    return application
