# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

"""Opt-in real voice reproduction, isolated from the running application.

From backend: python -m scripts.verify_continuous_voice --allow-billable --phase baseline
The default lifecycle phase also requires real server waiting/Continue support.
"""

import argparse
import asyncio
import base64
import json
import os
import re
import socket
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, tostring
from zoneinfo import ZoneInfo

from app.config import ROOT, load_config

PROVIDERS = (
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_SPEECH_KEY",
    "AZURE_SPEECH_REGION",
    "DAILY_API_KEY",
)


def scenario(day):
    """Build synthetic utterances for cash capture, interruption, and correction checks."""
    return {
        "sampleRate": 16000,
        "dueDate": day.isoformat(),
        "samples": {
            "cash": "My available cash is six thousand rupees.",
            "filler": "Um.",
            "rent": (
                f"My rent is two thousand rupees, due on {day:%B} {day.day}. "
                "I have not told you all my expenses yet."
            ),
            "no": "No.",
            "stop": "Stop.",
            "correction": "Correction. My available cash is six thousand five hundred rupees, "
            "not six thousand. The rent stays the same.",
            "followup": "Please tell me my available cash and rent. "
            "I have not finished listing expenses.",
        },
    }


async def stop(process):
    """Terminate a running child process and kill it if graceful shutdown times out."""
    if process is not None and process.returncode is None:
        process.terminate()
        try:
            async with asyncio.timeout(20):
                await process.wait()
        except TimeoutError:
            process.kill()
            await process.wait()


def browser_environment():
    """Select noncredential environment values needed by the browser verification process."""
    # No provider, Google, or application credentials are inherited by Node/Chromium.
    return {
        name: value
        for name, value in os.environ.items()
        if name
        in {
            "PATH",
            "HOME",
            "TMPDIR",
            "TEMP",
            "TMP",
            "SYSTEMROOT",
            "WINDIR",
            "LANG",
            "LC_ALL",
            "LD_LIBRARY_PATH",
            "PLAYWRIGHT_BROWSERS_PATH",
        }
    }


def failure_category(line):
    """Extract bounded, nonsensitive failure metadata from a recognized voice log line."""
    match = re.search(
        rb"Voice failure source=([A-Za-z0-9_]{1,80}) category=([A-Z_]{1,40}) "
        rb"exception=([A-Za-z0-9_]{1,80}) status=(None|[1-5][0-9]{2}) metrics=",
        line,
    )
    if not match:
        return None
    return dict(
        zip(
            ("source", "category", "exceptionType", "status"),
            (item.decode("ascii") for item in match.groups()),
            strict=True,
        )
    )


async def verify(phase, initial_wait=False):
    """Run an isolated real-provider browser scenario with generated audio and room cleanup."""
    import aiohttp
    from dotenv import dotenv_values

    values = dotenv_values(ROOT / ".env", interpolate=False)
    if not all(values.get(name) for name in PROVIDERS):
        raise ValueError("Azure/Daily credentials and endpoint/region values are required")
    if not re.fullmatch(r"[a-z0-9-]{1,64}", values["AZURE_SPEECH_REGION"]):
        raise ValueError("Invalid speech region")
    if not (ROOT / "frontend/dist/index.html").is_file():
        raise FileNotFoundError("Build the current frontend before verification")
    server = browser = logs = None
    failures = []
    ready = asyncio.Event()
    result = 1
    with tempfile.TemporaryDirectory(prefix="finance-continuous-") as directory:
        samples = Path(directory) / "samples.json"
        rooms = Path(directory) / "rooms.json"
        try:
            async with asyncio.timeout(560 if initial_wait else 410):
                config = load_config()
                payload = scenario(
                    (datetime.now(ZoneInfo(config.timezone)) + timedelta(days=3)).date()
                )
                if phase == "demo":
                    payload["samples"]["followup"] = (
                        "The rent is due in three days. That is my only payment for the next "
                        "thirty days. I have no income, no other essential expenses, no optional "
                        "spending, and no loans or credit card payments. Please give me my "
                        "thirty-day plan using those facts."
                    )
                async with aiohttp.ClientSession(
                    timeout=aiohttp.ClientTimeout(total=25),
                    headers={
                        "Ocp-Apim-Subscription-Key": values["AZURE_SPEECH_KEY"],
                        "Content-Type": "application/ssml+xml",
                        "X-Microsoft-OutputFormat": "raw-16khz-16bit-mono-pcm",
                        "User-Agent": "finance-continuous-verification",
                    },
                ) as http:
                    for name, text in payload["samples"].items():
                        speech = Element(
                            "speak", {"version": "1.0", "xml:lang": config.voice.tts_locale}
                        )
                        SubElement(speech, "voice", {"name": config.voice.tts_voice}).text = text
                        async with http.post(
                            f"https://{values['AZURE_SPEECH_REGION']}.tts.speech.microsoft.com"
                            "/cognitiveservices/v1",
                            data=tostring(speech, encoding="utf-8"),
                            allow_redirects=False,
                        ) as response:
                            if response.status != 200:
                                raise RuntimeError("Microphone synthesis failed")
                            audio = bytearray()
                            async for chunk in response.content.iter_chunked(32768):
                                audio.extend(chunk)
                                if len(audio) > 640000:
                                    raise ValueError("Microphone sample exceeds duration bound")
                        if not audio or len(audio) % 2:
                            raise ValueError("Invalid microphone PCM")
                        payload["samples"][name] = base64.b64encode(audio).decode("ascii")
                samples.write_text(json.dumps(payload))
                with socket.socket() as reservation:
                    reservation.bind(("127.0.0.1", 0))
                    port = reservation.getsockname()[1]
                origin = f"http://127.0.0.1:{port}"
                server = await asyncio.create_subprocess_exec(
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "tests.test_continuous_verification:browser_app",
                    "--factory",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--no-proxy-headers",
                    "--no-access-log",
                    "--timeout-graceful-shutdown",
                    "10",
                    cwd=ROOT / "backend",
                    env={
                        **os.environ,
                        **{name: values[name] for name in PROVIDERS},
                        "PUBLIC_ORIGIN": origin,
                        "DATA_DIR": directory,
                        "APP_ENV": "local",
                    },
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                )

                async def drain():
                    """Drain server logs, signal readiness, and retain bounded failure metadata."""
                    while line := await server.stderr.readline():
                        if b"Uvicorn running on" in line:
                            ready.set()
                        if category := failure_category(line):
                            failures.append(category)
                            del failures[:-12]
                    ready.set()

                logs = asyncio.create_task(drain())
                async with asyncio.timeout(35):
                    await ready.wait()
                if server.returncode is not None:
                    raise RuntimeError("Isolated server stopped")
                browser = await asyncio.create_subprocess_exec(
                    "node",
                    str(ROOT / "frontend/scripts/verifyContinuousVoice.mjs"),
                    "--allow-billable",
                    "--phase",
                    phase,
                    *(["--initial-wait"] if initial_wait else []),
                    "--samples",
                    str(samples),
                    "--url",
                    origin,
                    cwd=ROOT,
                    env=browser_environment(),
                )
                result = await browser.wait()
        finally:
            await stop(browser)
            await stop(server)
            if logs:
                await logs
            # The API releases rooms first; this also covers browser termination mid-scenario.
            cleanup = True
            if rooms.exists():
                async with aiohttp.ClientSession(
                    timeout=aiohttp.ClientTimeout(total=6),
                    headers={"Authorization": "Bearer " + values["DAILY_API_KEY"]},
                ) as http:
                    for name in json.loads(rooms.read_text())[:4]:
                        if not re.fullmatch(r"finance-[0-9a-f]{32}", name):
                            cleanup = False
                            continue
                        try:
                            async with http.delete(
                                "https://api.daily.co/v1/rooms/" + name, allow_redirects=False
                            ) as response:
                                cleanup &= response.status in {200, 204, 404}
                        except (aiohttp.ClientError, TimeoutError):
                            cleanup = False
            print(
                json.dumps(
                    {"check": "isolatedCleanup", "passed": cleanup, "providerFailures": failures}
                ),
                flush=True,
            )
        return result if cleanup else 1


def main():
    """Parse billing consent and run the selected continuous-voice verification phase."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--allow-billable",
        action="store_true",
        required=True,
        help="Allow real Azure speech/model and Daily billing.",
    )
    parser.add_argument(
        "--phase", choices=("baseline", "demo", "lifecycle", "recovery"), default="lifecycle"
    )
    parser.add_argument("--initial-wait", action="store_true")
    arguments = parser.parse_args()
    try:
        return asyncio.run(verify(arguments.phase, arguments.initial_wait))
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({"passed": False, "exceptionType": type(error).__name__}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
