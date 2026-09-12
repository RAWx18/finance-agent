# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

"""Opt-in browser/Daily/Pipecat/Azure check with test-only Google identity and generated speech.

Run as python -m scripts.verify_voice --allow-billable from the backend environment.
Credentials come privately from the repository .env; all financial data and audio are temporary.
"""

import argparse
import asyncio
import json
import os
import socket
import sys
import tempfile
import wave
from pathlib import Path

from app.config import ROOT, load_config


async def stop(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        process.terminate()
        try:
            async with asyncio.timeout(35):
                await process.wait()
        except TimeoutError:
            process.kill()
            await process.wait()


async def verify() -> int:
    from azure.cognitiveservices.speech import (
        ResultReason,
        SpeechConfig,
        SpeechSynthesisOutputFormat,
        SpeechSynthesizer,
    )
    from dotenv import dotenv_values

    values = dotenv_values(ROOT / ".env", interpolate=False)
    names = (
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_SPEECH_KEY",
        "AZURE_SPEECH_REGION",
        "DAILY_API_KEY",
    )
    if not all(values.get(name) for name in names):
        raise ValueError("Azure and Daily credentials are required in the repository .env")
    with tempfile.TemporaryDirectory(prefix="finance-live-") as directory:
        config = SpeechConfig(
            subscription=values["AZURE_SPEECH_KEY"], region=values["AZURE_SPEECH_REGION"]
        )
        config.speech_synthesis_voice_name = load_config().voice.tts_voice
        config.set_speech_synthesis_output_format(SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm)
        synthesizer = SpeechSynthesizer(speech_config=config, audio_config=None)
        segments = []
        for text in (
            "My available cash is six thousand rupees. I have not told you all my expenses yet.",
            "Correction. My available cash is six thousand five hundred rupees, "
            "not six thousand. No other changes.",
        ):
            result = await asyncio.to_thread(synthesizer.speak_text_async(text).get)
            if result.reason != ResultReason.SynthesizingAudioCompleted:
                raise RuntimeError("Synthetic microphone speech generation failed")
            segments.append(result.audio_data)
        audio = Path(directory) / "microphone.wav"
        with wave.open(str(audio), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(16000)
            output.writeframes(
                b"\0" * 32000 * 15
                + segments[0]
                + b"\0" * 32000 * 25
                + segments[1]
                + b"\0" * 32000 * 90
            )
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        environment = {
            **os.environ,
            **{name: values[name] for name in names},
            "PUBLIC_ORIGIN": origin,
            "DATA_DIR": directory,
            "APP_ENV": "local",
        }
        server = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "uvicorn",
            "tests.auth_support:browser_app",
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
            env=environment,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        logs = None
        try:
            async with asyncio.timeout(40):
                while True:
                    line = await server.stderr.readline()
                    if not line:
                        raise RuntimeError("Isolated server stopped")
                    if b"Uvicorn running on" in line:
                        break
            # Drain private provider logs so pipe capacity cannot stall the server.
            logs = asyncio.create_task(server.communicate())
            print(
                json.dumps(
                    {
                        "check": "livePipelineServer",
                        "mode": "realDailyAzureSyntheticGoogleAndMicrophone",
                        "ready": True,
                    }
                ),
                flush=True,
            )
            browser = await asyncio.create_subprocess_exec(
                "node",
                str(ROOT / "frontend/scripts/verifyVoice.mjs"),
                "--allow-billable",
                "--synthetic-login",
                "--audio",
                str(audio),
                "--url",
                origin,
                cwd=ROOT,
            )
            try:
                async with asyncio.timeout(240):
                    return await browser.wait()
            finally:
                await stop(browser)
        finally:
            if logs is None:
                logs = asyncio.create_task(server.communicate())
            await stop(server)
            await logs
            print(
                json.dumps(
                    {"check": "livePipelineServerCleanup", "stopped": server.returncode is not None}
                ),
                flush=True,
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--allow-billable",
        action="store_true",
        required=True,
        help="Allow real Azure speech/model and Daily calls using synthetic test inputs.",
    )
    parser.parse_args()
    try:
        return asyncio.run(verify())
    except Exception as error:
        print(json.dumps({"passed": False, "errorType": type(error).__name__}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
