# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

"""Opt-in live startup/release probe; no synthesized user speech or financial scenario.

From the repository root: backend/.venv/bin/python backend/scripts/verify_lifecycle.py
--allow-billable --cycles 2. Build the frontend first. Each cycle is bounded by 180s,
including the shared server startup and emergency cleanup budget.
The prompt mode uses visible Chromium and requires an existing desktop display.
"""

import argparse
import asyncio
import json
import os
import re
import signal
import socket
import sys
import tempfile
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from scripts.verify_continuous_voice import (  # noqa: E402
    PROVIDERS,
    browser_environment,
    failure_category,
)


def silence(path):
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(bytes(16000 * 2))


async def stop(process, seconds):
    if process is None:
        return True
    if process.returncode is None:
        try:
            process.terminate()
        except ProcessLookupError:
            await process.wait()
            return True
        try:
            async with asyncio.timeout(seconds):
                await process.wait()
        except TimeoutError:
            try:
                if os.name == "posix":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            except ProcessLookupError:
                pass
            await process.wait()
            return False
    return True


async def cleanup_rooms(path, key):
    import aiohttp

    results = []
    if not path.exists():
        return results
    names = json.loads(path.read_text())
    if not isinstance(names, list) or len(names) > 8:
        raise ValueError("Invalid owned room manifest")
    async with aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=4),
        headers={"Authorization": "Bearer " + key},
    ) as http:
        for name in names:
            if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", name):
                raise ValueError("Invalid owned room name")
            result = {"room": len(results) + 1, "deleteStatus": None, "getStatus": None}
            try:
                async with http.delete(
                    "https://api.daily.co/v1/rooms/" + name, allow_redirects=False
                ) as response:
                    result["deleteStatus"] = response.status
                async with http.get(
                    "https://api.daily.co/v1/rooms/" + name, allow_redirects=False
                ) as response:
                    result["getStatus"] = response.status
            except (aiohttp.ClientError, TimeoutError):
                pass
            result["passed"] = (
                result["deleteStatus"] in {200, 204, 404} and result["getStatus"] == 404
            )
            results.append(result)
    return results


async def verify(cycles, mode):
    from dotenv import dotenv_values

    values = dotenv_values(ROOT / ".env", interpolate=False)
    if not all(values.get(name) for name in PROVIDERS):
        raise ValueError("Azure/Daily credentials are required in the private dotenv file")
    if not (ROOT / "frontend/dist/index.html").is_file():
        raise FileNotFoundError("Build the frontend before verification")
    interpreter = ROOT / "backend/.venv/bin/python"
    if not interpreter.is_file():
        raise FileNotFoundError("The backend virtual environment is required")
    server = browser = logs = None
    ready = asyncio.Event()
    failures = []
    result = 1
    cleanup = False
    with tempfile.TemporaryDirectory(prefix="finance-lifecycle-") as directory:
        directory = Path(directory)
        silence(directory / "silence.wav")
        try:
            # Reserve 45 seconds for terminating both children and verifying owned room deletion.
            async with asyncio.timeout(cycles * 180 - 45):
                with socket.socket() as reservation:
                    reservation.bind(("127.0.0.1", 0))
                    port = reservation.getsockname()[1]
                origin = f"http://127.0.0.1:{port}"
                server = await asyncio.create_subprocess_exec(
                    str(interpreter),
                    "-m",
                    "uvicorn",
                    "tests.lifecycle_support:browser_app",
                    "--factory",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--no-proxy-headers",
                    "--no-access-log",
                    "--timeout-graceful-shutdown",
                    "5",
                    cwd=ROOT / "backend",
                    env={
                        **os.environ,
                        **{name: values[name] for name in PROVIDERS},
                        "PUBLIC_ORIGIN": origin,
                        "DATA_DIR": str(directory),
                        "APP_ENV": "local",
                    },
                    start_new_session=os.name == "posix",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                )

                async def drain():
                    while line := await server.stderr.readline():
                        if b"Uvicorn running on" in line:
                            ready.set()
                        if category := failure_category(line):
                            failures.append(category)
                            del failures[:-12]
                    ready.set()

                logs = asyncio.create_task(drain())
                async with asyncio.timeout(20):
                    await ready.wait()
                if server.returncode is not None:
                    raise RuntimeError("Isolated server stopped")
                browser = await asyncio.create_subprocess_exec(
                    "node",
                    str(ROOT / "frontend/scripts/verifyLifecycle.mjs"),
                    "--allow-billable",
                    "--cycles",
                    str(cycles),
                    "--mode",
                    mode,
                    "--url",
                    origin,
                    "--audio",
                    str(directory / "silence.wav"),
                    cwd=ROOT,
                    env={
                        **browser_environment(),
                        **{
                            name: os.environ[name]
                            for name in ("DISPLAY", "XAUTHORITY")
                            if mode == "prompt" and name in os.environ
                        },
                    },
                    start_new_session=os.name == "posix",
                    stderr=asyncio.subprocess.DEVNULL,
                )
                result = await browser.wait()
        finally:
            browser_stopped = await stop(browser, 8)
            server_stopped = await stop(server, 12)
            if logs:
                await asyncio.gather(logs, return_exceptions=True)
            rooms = []
            try:
                async with asyncio.timeout(20):
                    rooms = await cleanup_rooms(
                        directory / "lifecycleRooms.json", values["DAILY_API_KEY"]
                    )
                cleanup = all(room["passed"] for room in rooms)
            except Exception:
                cleanup = False
            print(
                json.dumps(
                    {
                        "check": "isolatedCleanup",
                        "passed": cleanup,
                        "browserGraceful": browser_stopped,
                        "serverGraceful": server_stopped,
                        "rooms": rooms,
                        "providerFailures": failures,
                    }
                ),
                flush=True,
            )
        return result if cleanup and browser_stopped and server_stopped else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-billable", action="store_true", required=True)
    parser.add_argument("--cycles", type=int, choices=(1, 2), default=2)
    parser.add_argument(
        "--mode", choices=("cycles", "denied", "prompt", "refresh"), default="cycles"
    )
    arguments = parser.parse_args()

    async def run():
        task = asyncio.current_task()
        if os.name == "posix":
            asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
        return await verify(arguments.cycles, arguments.mode)

    try:
        return asyncio.run(run())
    except (Exception, KeyboardInterrupt, asyncio.CancelledError) as error:
        print(json.dumps({"passed": False, "exceptionType": type(error).__name__}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
