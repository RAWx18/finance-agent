# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

"""Opt-in, synthetic Azure component checks; run as scripts.verify_azure from backend."""

import argparse
import asyncio
import json
import logging
import os
import re
import threading
import traceback
from collections.abc import AsyncIterator
from contextlib import aclosing, asynccontextmanager
from importlib.metadata import version
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic
from typing import TYPE_CHECKING, Any, Literal
from uuid import UUID, uuid4

if TYPE_CHECKING:
    from app.config import Config

MODEL = "gpt-5.6-terra"
MODEL_VERSION = "2026-07-09"
TOKENS = 256
SAMPLE = (
    "My salary is one lakh twenty-five thousand rupees on the twenty-fifth of September. "
    "My EMI is six thousand rupees on the fifteenth of September. "
    "Correction: my EMI is six thousand five hundred rupees."
)


def require(condition: Any) -> None:
    if not condition:
        raise ValueError("Verification assertion failed")


def emit(check: str, **metrics: Any) -> None:
    print(json.dumps({"check": check, **metrics}, ensure_ascii=True), flush=True)


def resource_name(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,89}", value):
        raise argparse.ArgumentTypeError("Use an Azure resource or deployment name")
    return value


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-billable", action="store_true", required=True)
    parser.add_argument("--subscription", type=UUID, required=True)
    for name in ("resource-group", "openai-resource", "deployment", "speech-resource"):
        parser.add_argument(f"--{name}", type=resource_name, required=True)
    parser.add_argument(
        "--post-refinement", action="store_true", help="Repeat STT with PostRefinement"
    )
    return parser.parse_args()


async def azure(args: argparse.Namespace, *command: str) -> Any:
    process = await asyncio.create_subprocess_exec(
        "az",
        "cognitiveservices",
        "account",
        *command,
        "--subscription",
        str(args.subscription),
        "--resource-group",
        args.resource_group,
        "--only-show-errors",
        "--output",
        "json",
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        async with asyncio.timeout(20):
            output, _ = await process.communicate()
        require(process.returncode == 0)
        return json.loads(output)
    finally:
        if process.returncode is None:
            process.kill()
            await process.communicate()


@asynccontextmanager
async def speech_worker(service: Any) -> AsyncIterator[Any]:
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineWorker
    from pipecat.workers.runner import WorkerRunner

    ready = asyncio.Event()
    failed = asyncio.Event()
    worker = PipelineWorker(
        Pipeline([service]),
        enable_rtvi=False,
        enable_turn_tracking=False,
        idle_timeout_secs=None,
        setup_timeout_secs=30,
        start_timeout_secs=10,
        cancel_timeout_secs=5,
    )

    async def started(*_: Any) -> None:
        ready.set()

    async def error(*_: Any) -> None:
        failed.set()
        ready.set()

    worker.add_event_handler("on_pipeline_started", started)
    worker.add_event_handler("on_pipeline_error", error)
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    task = asyncio.create_task(runner.run())
    try:
        async with asyncio.timeout(35):
            await ready.wait()
        require(not failed.is_set() and not task.done())
        yield worker
        require(not failed.is_set() and not task.done())
    finally:
        try:
            async with asyncio.timeout(10):
                await worker.cancel()
                await task
        finally:
            if not task.done():
                task.cancel()
            async with asyncio.timeout(5):
                await asyncio.gather(task, return_exceptions=True)
                await service.cleanup()


async def language_checks(config: "Config", endpoint: str, key: str, deployment: str) -> None:
    from openai import AsyncOpenAI
    from pipecat.adapters.schemas.function_schema import FunctionSchema
    from pipecat.adapters.schemas.tools_schema import ToolsSchema
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.services.azure.llm import AzureLLMService
    from pydantic import BaseModel, ConfigDict

    from app.store import Store
    from app.voice_tools import VoiceTools

    llm = AzureLLMService(
        endpoint=endpoint,
        api_key=key,
        retry_on_timeout=False,
        settings=AzureLLMService.Settings(
            model=deployment,
            system_instruction="Save only opening cash with update_facts. "
            "INR amounts must be decimal strings with two decimal places. "
            "Use the supplied expectedRevision. Do not add other fields.",
            max_completion_tokens=TOKENS,
            extra={
                "store": False,
                "reasoning_effort": config.voice.reasoning_effort,
                "parallel_tool_calls": False,
            },
        ),
    )
    # AzureLLMService.create_client ignores client kwargs in Pipecat 1.9.0.
    llm._client.max_retries = 0
    llm._client.timeout = 30
    try:
        async with AsyncOpenAI(
            api_key=key, base_url=endpoint, max_retries=0, timeout=30
        ) as planner:
            with TemporaryDirectory(prefix="azure-verification-") as directory:
                store = Store(Path(directory) / "synthetic.sqlite3", config)
                try:
                    await store.open()
                    await store.create("synthetic")
                    tools = VoiceTools(
                        store,
                        "synthetic",
                        uuid4(),
                        lambda _: None,
                    )
                    schema = FunctionSchema(
                        name="update_facts",
                        description="Save explicitly reported opening cash.",
                        properties={
                            "expectedRevision": {"type": "integer"},
                            "opening": {
                                "type": "object",
                                "additionalProperties": False,
                                "properties": {
                                    "amount": {"type": "string"},
                                    "status": {"type": "string", "enum": ["exact"]},
                                },
                                "required": ["amount", "status"],
                            },
                        },
                        required=["expectedRevision", "opening"],
                    )
                    context = LLMContext(
                        [],
                        tools=ToolsSchema(standard_tools=[schema]),
                        tool_choice={"type": "function", "function": {"name": "update_facts"}},
                    )
                    for revision, amount, statement in (
                        (0, "6000.00", "My opening cash is ₹6000."),
                        (1, "6500.00", "Correction: my opening cash is ₹6500, not ₹6000."),
                    ):
                        context.add_message(
                            {"role": "user", "content": f"expectedRevision={revision}. {statement}"}
                        )
                        calls: dict[int, dict[str, str]] = {}
                        chunks = 0
                        usage = None
                        finish = None
                        started = monotonic()
                        async with asyncio.timeout(30):
                            stream = await llm.get_chat_completions(context)
                            async with stream, aclosing(stream.__aiter__()) as iterator:
                                async for chunk in iterator:
                                    chunks += 1
                                    if chunk.usage:
                                        usage = {
                                            "input": chunk.usage.prompt_tokens,
                                            "output": chunk.usage.completion_tokens,
                                        }
                                    for choice in chunk.choices:
                                        require(choice.index == 0)
                                        if choice.finish_reason:
                                            finish = choice.finish_reason
                                        for call in choice.delta.tool_calls or []:
                                            data = calls.setdefault(
                                                call.index, {"id": "", "name": "", "arguments": ""}
                                            )
                                            data["id"] += call.id or ""
                                            if call.function:
                                                data["name"] += call.function.name or ""
                                                data["arguments"] += call.function.arguments or ""
                        require(finish == "tool_calls" and len(calls) == 1 and 0 in calls)
                        call = calls[0]
                        require(call["name"] == "update_facts" and call["id"])
                        expected = {
                            "expectedRevision": revision,
                            "opening": {"amount": amount, "status": "exact"},
                        }
                        require(json.loads(call["arguments"]) == expected)
                        result = await tools.update_facts(json.loads(call["arguments"]), call["id"])
                        snapshot = await store.get("synthetic")
                        paise = 600000 if revision == 0 else 650000
                        require(not result["stateChanged"] and snapshot.revision == revision + 1)
                        require(snapshot.facts.opening.amount_paise == paise)
                        require(snapshot.plan.closing_paise == paise)
                        context.add_message(
                            {
                                "role": "assistant",
                                "tool_calls": [
                                    {
                                        "id": call["id"],
                                        "type": "function",
                                        "function": {
                                            "name": call["name"],
                                            "arguments": call["arguments"],
                                        },
                                    }
                                ],
                            }
                        )
                        context.add_message(
                            {
                                "role": "tool",
                                "tool_call_id": call["id"],
                                "content": json.dumps(
                                    {"revision": revision + 1, "openingPaise": paise}
                                ),
                            }
                        )
                        emit(
                            "chat_tool_correction",
                            revision=snapshot.revision,
                            openingPaise=paise,
                            chunks=chunks,
                            usage=usage,
                            elapsedSeconds=round(monotonic() - started, 3),
                        )
                finally:
                    await store.close()

            class StructuredOpening(BaseModel):
                model_config = ConfigDict(extra="forbid")
                amount: Literal["6500.00"]
                currency: Literal["INR"]

            async with asyncio.timeout(30):
                response = await planner.responses.parse(
                    model=deployment,
                    reasoning={"effort": config.voice.reasoning_effort},
                    input="Opening cash: ₹6000, corrected to ₹6500. Return the correction.",
                    text_format=StructuredOpening,
                    max_output_tokens=TOKENS,
                    store=False,
                )
            require(response.status == "completed" and response.output_parsed is not None)
            emit(
                "responses_structured_parse",
                value=response.output_parsed.model_dump(),
                usage={"input": response.usage.input_tokens, "output": response.usage.output_tokens}
                if response.usage
                else None,
                scope="Schema connectivity only; not VoiceTools.review_plan",
            )
    finally:
        await llm._client.close()
        await llm.cleanup()


async def synthesize(config: "Config", key: str, region: str) -> bytes:
    from pipecat.frames.frames import ErrorFrame, TTSAudioRawFrame, TTSSpeakFrame, TTSStoppedFrame
    from pipecat.services.tts_service import TextAggregationMode
    from pipecat.transcriptions.language import Language

    from app.speech import SpeechSynthesis

    tts = SpeechSynthesis(
        api_key=key,
        region=region,
        sample_rate=24000,
        settings=SpeechSynthesis.Settings(
            language=Language(config.voice.tts_locale),
            voice=config.voice.tts_voice,
            force_locale=True,
        ),
        text_aggregation_mode=TextAggregationMode.SENTENCE,
    )
    done = asyncio.Event()
    completed = asyncio.Event()
    audio = bytearray()
    chunks = 0
    first_audio = None
    duration = 0.0
    boundaries: list[dict[str, Any]] = []
    failed = False
    started = monotonic()

    async def frame_pushed(_: Any, frame: Any) -> None:
        nonlocal chunks, first_audio, failed
        if isinstance(frame, TTSAudioRawFrame):
            if first_audio is None:
                first_audio = round(monotonic() - started, 3)
            if (
                frame.sample_rate != 24000
                or frame.num_channels != 1
                or len(audio) + len(frame.audio) > 24000 * 2 * 45
            ):
                failed = True
                done.set()
                return
            audio.extend(frame.audio)
            chunks += 1
        elif isinstance(frame, ErrorFrame):
            failed = True
            done.set()
        elif isinstance(frame, TTSStoppedFrame):
            done.set()

    tts.add_event_handler("on_before_push_frame", frame_pushed)
    loop = asyncio.get_running_loop()

    def boundary(event: Any) -> None:
        loop.call_soon_threadsafe(
            boundaries.append,
            {
                "text": event.text[:100],
                "audioOffsetSeconds": event.audio_offset / 10_000_000,
            },
        )

    def synthesized(event: Any) -> None:
        nonlocal duration
        duration = event.result.audio_duration.total_seconds()
        loop.call_soon_threadsafe(completed.set)

    async with speech_worker(tts) as worker:
        tts._speech_synthesizer.synthesis_word_boundary.connect(boundary)
        tts._speech_synthesizer.synthesis_completed.connect(synthesized)
        try:
            started = monotonic()
            async with asyncio.timeout(45):
                await worker.queue_frame(TTSSpeakFrame(SAMPLE))
                await done.wait()
                require(not failed)
                await completed.wait()
            require(not failed and audio and len(audio) <= 24000 * 2 * 45)
            emit(
                "speech_synthesis",
                characters=len(SAMPLE),
                chunks=chunks,
                firstAudioSeconds=first_audio,
                elapsedSeconds=round(monotonic() - started, 3),
                audioSeconds=round(len(audio) / (24000 * 2), 3),
                sdkAudioSeconds=duration,
                wordBoundaryCount=len(boundaries),
                wordBoundarySample=boundaries[:8],
            )
            require(boundaries and chunks > 1 and abs(len(audio) / 48000 - duration) < 0.1)
        finally:
            async with asyncio.timeout(5):
                await asyncio.to_thread(tts._speech_synthesizer.stop_speaking_async().get)
            tts._speech_synthesizer.synthesis_word_boundary.disconnect_all()
            tts._speech_synthesizer.synthesis_completed.disconnect_all()
    return bytes(audio)


async def recognize(
    config: "Config", key: str, region: str, audio: bytes, refinement: bool
) -> None:
    from azure.cognitiveservices.speech import CancellationReason, PropertyId, ResultReason
    from pipecat.frames.frames import ErrorFrame
    from pipecat.transcriptions.language import Language

    from app.speech import SpeechRecognition

    stt = SpeechRecognition(
        api_key=key,
        region=region,
        sample_rate=16000,
        phrases=config.voice.stt_phrases,
        settings=SpeechRecognition.Settings(
            language=Language(config.voice.stt_locale),
            segmentation_silence_timeout_ms=config.voice.stt_segmentation_ms,
        ),
    )
    if refinement:
        stt._speech_config.set_property(
            PropertyId.SpeechServiceResponse_PostProcessingOption, "PostRefinement"
        )
    results: list[dict[str, Any]] = []
    done = asyncio.Event()
    failed = asyncio.Event()
    loop = asyncio.get_running_loop()
    started = monotonic()

    def result(event: Any) -> None:
        if event.result.reason in (ResultReason.RecognizingSpeech, ResultReason.RecognizedSpeech):
            loop.call_soon_threadsafe(
                results.append,
                {
                    "final": event.result.reason == ResultReason.RecognizedSpeech,
                    "text": event.result.text[:2000],
                    "elapsedSeconds": round(monotonic() - started, 3),
                },
            )

    def stopped(_: Any) -> None:
        loop.call_soon_threadsafe(done.set)

    def canceled(event: Any) -> None:
        if event.result.cancellation_details.reason == CancellationReason.Error:
            loop.call_soon_threadsafe(failed.set)
        loop.call_soon_threadsafe(done.set)

    async with speech_worker(stt):
        recognizer = stt._speech_recognizer
        require(recognizer is not None and stt._audio_stream is not None)
        recognizer.recognizing.connect(result)
        recognizer.recognized.connect(result)
        recognizer.session_stopped.connect(stopped)
        recognizer.canceled.connect(canceled)
        try:
            started = monotonic()
            async with asyncio.timeout(60):
                # EOF plus trailing silence lets continuous recognition finalize every phrase.
                for offset in range(0, len(audio), 3200):
                    async for frame in stt.run_stt(audio[offset : offset + 3200]):
                        require(not isinstance(frame, ErrorFrame))
                async for frame in stt.run_stt(bytes(16000 * 2)):
                    require(not isinstance(frame, ErrorFrame))
                stt._audio_stream.close()
                await done.wait()
            finals = [item for item in results if item["final"]]
            interims = [item for item in results if not item["final"]]
            emit(
                "speech_recognition",
                postRefinement=refinement,
                finals=finals,
                interimCount=len(interims),
                interimSample=interims[:3],
                elapsedSeconds=round(monotonic() - started, 3),
                inputAudioSeconds=round(len(audio) / 32000 + 1, 3),
            )
            require(not failed.is_set() and finals and interims)
        finally:
            async with asyncio.timeout(5):
                await asyncio.to_thread(recognizer.stop_continuous_recognition_async().get)
            recognizer.recognizing.disconnect_all()
            recognizer.recognized.disconnect_all()
            recognizer.session_stopped.disconnect_all()
            recognizer.canceled.disconnect_all()


async def verify(args: argparse.Namespace) -> None:
    from app.config import Environment, load_config

    config = load_config()
    require(config.voice.reasoning_effort == "none")
    packages = {
        name: version(name) for name in ("pipecat-ai", "openai", "azure-cognitiveservices-speech")
    }
    require(
        packages
        == {"pipecat-ai": "1.9.0", "openai": "2.54.0", "azure-cognitiveservices-speech": "1.51.2"}
    )
    emit("versions", packages=packages)
    account = await azure(args, "show", "--name", args.openai_resource)
    deployment = await azure(
        args,
        "deployment",
        "show",
        "--name",
        args.openai_resource,
        "--deployment-name",
        args.deployment,
    )
    speech = await azure(args, "show", "--name", args.speech_resource)
    model = deployment["properties"]["model"]
    require(
        model["format"] == "OpenAI" and model["name"] == MODEL and model["version"] == MODEL_VERSION
    )
    require(deployment["properties"]["provisioningState"] == "Succeeded")
    require(account["properties"]["provisioningState"] == "Succeeded")
    require(
        speech["kind"] == "SpeechServices"
        and speech["sku"]["name"] == "S0"
        and speech["properties"]["provisioningState"] == "Succeeded"
    )
    endpoint = account["properties"].get("endpoints", {}).get("OpenAI Language Model Instance API")
    if endpoint is None:
        endpoint = account["properties"]["endpoint"]
    environment = Environment(
        azure_openai_endpoint=endpoint, azure_speech_region=speech["location"]
    )
    endpoint = environment.azure_openai_endpoint
    region = environment.azure_speech_region
    require(region and endpoint)
    # Region-based SDK routing must agree with the resource's actual metadata.
    endpoints = speech["properties"]["endpoints"]
    require(
        endpoints["Speech Services Speech to Text (Standard)"].rstrip("/")
        == f"https://{region}.stt.speech.microsoft.com"
    )
    require(
        endpoints["Speech Services Text to Speech (Neural)"].rstrip("/")
        == f"https://{region}.tts.speech.microsoft.com"
    )
    emit(
        "metadata",
        model=MODEL,
        modelVersion=MODEL_VERSION,
        deployment=args.deployment,
        openaiRegion=account["location"],
        openaiEndpoint=endpoint,
        speechRegion=region,
        voice=config.voice.tts_voice,
    )
    key = await azure(args, "keys", "list", "--name", args.openai_resource, "--query", "key1")
    try:
        require(isinstance(key, str) and key.strip())
        await language_checks(config, endpoint, key, args.deployment)
    finally:
        key = None
    key = await azure(args, "keys", "list", "--name", args.speech_resource, "--query", "key1")
    try:
        require(isinstance(key, str) and key.strip())
        audio = await synthesize(config, key, region)
        from pipecat.audio.resamplers.soxr_resampler import SOXRAudioResampler

        audio = await SOXRAudioResampler().resample(audio, 24000, 16000)
        require(audio and len(audio) % 2 == 0 and len(audio) <= 16000 * 2 * 45)
        await recognize(config, key, region, audio, False)
        if args.post_refinement:
            await recognize(config, key, region, audio, True)
    finally:
        key = None
    emit(
        "complete",
        passed=True,
        scope="Synthetic component connectivity, not human recognition "
        "quality, consumer latency, Daily, full conversation, or planner review",
    )


def main() -> int:
    args = arguments()
    logging.disable(logging.CRITICAL)
    from loguru import logger

    logger.remove()

    def deadline() -> None:
        # Native SDK futures cannot be canceled by asyncio; bound interpreter shutdown too.
        os.write(1, b'{"check":"deadline","passed":false,"reason":"native_shutdown_timeout"}\n')
        os._exit(124)

    watchdog = threading.Timer(260, deadline)
    watchdog.daemon = True
    watchdog.start()

    async def bounded() -> None:
        async with asyncio.timeout(240):
            await verify(args)

    try:
        asyncio.run(bounded())
        return 0
    except (Exception, KeyboardInterrupt) as error:
        emit(
            "failure",
            passed=False,
            errorType=type(error).__name__,
            locations=[
                {"file": Path(frame.filename).name, "line": frame.lineno, "function": frame.name}
                for frame in traceback.extract_tb(error.__traceback__)
            ],
        )
        return 1
    finally:
        watchdog.cancel()


if __name__ == "__main__":
    raise SystemExit(main())
