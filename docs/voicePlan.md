<!-- SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Voice-first prototype implementation plan

## Outcome and initial choices

The next acceptance milestone is a real consumer conversation, not a polished manual planner:
start a call, describe multiple financial facts, answer a useful follow-up, see calculated cards,
correct a fact by voice, and hear a meaningful 30-day conclusion from the corrected state.

These are the initial production-oriented prototype choices selected on 11 September 2026.
They are a starting point for measured integration, not permanent assumptions or evidence of
production readiness. Do not compare alternative providers before exercising this path.

| Responsibility | Initial implementation | What must be verified in the configured account |
| --- | --- | --- |
| Conversation and reasoning | Azure-hosted GPT-5.6-Terra; `AzureLLMService` with environment-supplied v1 endpoint and configured `voice.model` deployment; reasoning effort `none` | Deployment access, tool accuracy, useful follow-ups, correction handling and latency |
| STT | Microsoft Foundry Speech continuous real-time recognition through Pipecat's `AzureSTTService`; `en-IN` | Current service-managed English model, regional availability and numeric/date accuracy |
| TTS | Microsoft Foundry Speech through Pipecat's streaming `AzureTTSService`; female `en-IN-Aarti:DragonHDLatestNeural` | Exact voice availability, streaming audio, pronunciation, word-boundary events and listener preference |
| Transport and turns | Daily WebRTC and Pipecat, local Silero speech detection, timeout-based turn completion | Real microphone/playback, turn endings, interruption and resource cleanup |

The STT SDK's standard endpoint chooses the service-managed model: do not invent a `latest`
model identifier or use batch/fast transcription as the live path. The configured locale is
Indian English, not multilingual auto-detection. A small phrase list biases recognition toward
rupees, lakh/lakhs, crore/crores, EMI and minimum due; it does not establish financial facts.
Use the actual resource region. `financeVoiceIndia` is provisioned in Central India and passed
real continuous recognition and HD synthesis; [the setup report](azureSetup.md) records evidence
and observed date/paise recognition errors. GA PostRefinement was evaluated but not selected:
it did not consistently improve financial entities and increased final-result latency in the sample.

The TTS voice is listed by Microsoft as female Indian-English Dragon HD. `LatestNeural` tracks
Microsoft's current base-model version. The application checks the resource's voice list before
creating a Daily room; an unavailable voice produces an explicit setup failure, never an automatic
voice/provider substitution. If the configured resource cannot serve suitable en-IN HD, select a
supported female English neural voice explicitly after checking the resource and auditioning it.
`en-IN-AartiIndicNeural` is a documented non-HD candidate, not a dormant runtime fallback.

## Integrated path and responsibilities

**Browser → Daily WebRTC → Pipecat → Azure Speech STT → GPT-5.6-Terra → financial tools/state
→ Azure Speech TTS → Pipecat → Daily → Browser.**

- The conversation role understands the situation, chooses the next useful question, handles
  ambiguity and corrections, and speaks as one coherent assistant. Accept several facts per turn;
  save partial records and ask only for consequential missing information.
- `review_plan` reads the deterministic decision assessment and active canonical plan without
  another LLM request. The speaking Terra role explains it; calculations and selected financial
  questions remain application-owned. No second model deployment is needed.
- `read_state` and `update_facts` bind ownership on the server. Complete tool arguments merge into
  the existing state under revision checks; existing deterministic code owns arithmetic, dated
  projections, scenarios and persistence. A model never becomes a second financial ledger.
- `respond_to_action` records an explicit unavailable answer or refusal of the current supported
  action. Unconfirmed details stay unknown and declined cuts do not change obligations. The next
  action comes from the same deterministic assessment; corrections reopen only dependent responses.
- Inline proposal review shows the exact assumption set, removals and remaining gaps. Acceptance
  requires fresh unconditional consent; rejecting the preview is separate from declining a cut.
  A conflicting pending proposal produces visible guidance instead of a silent failed response.
- The same committed snapshot updates cards and conversational context. Fact corrections invalidate
  dependent assumptions. Stale review revisions are rejected; external edits interrupt obsolete
  speech. Interrupted writes must be reread rather than assumed successful.
- **Start conversation** opens preparation without capture; **Start talking** requests
  microphone access before room creation. Ready/listening/speaking/captions follow actual SDK
  events. End releases capture, playback and server resources. Reopening saved figures does not
  reopen the microphone. The manual inspector remains secondary.
- Daily room/token permissions allow microphone audio only and no administrative capabilities.
  This does not bypass Daily account activation or billing requirements.

Implementation: [pipeline](../backend/app/voice_pipeline.py), [Azure speech](../backend/app/speech.py),
[call lifecycle](../backend/app/voice.py), [AI tools](../backend/app/voice_tools.py),
[conversation UI](../frontend/src/Conversation.tsx), [configuration](../config.toml).

## Speech and latency behavior

Turn completion uses a 2.6-second continuation window rearmed by recognition activity as well as
VAD stop. VAD uses confidence/volume 0.5, 100-ms start and 200-ms stop; Azure's 500-ms segmentation
only finalizes recognition segments. Sixty seconds after assistant playback ends, the server enters
waiting and the browser disables capture. Explicit Continue retains the room and financial context;
the 30-minute absolute call deadline does not move. An empty model response also offers explicit
Continue, with a distinct explanation and no automatic model retry. See [evidence and limits](releaseChecks.md).

The configured opening guidance produces one short model introduction with tools disabled,
through guarded synthesis, followed by listening. Its instruction is then removed from context.
For later turns, buffer model prose until tool selection is complete: discard tool-bearing prose,
commit facts and recalculate before publishing an answer. Accepted text goes to Azure as complete
sentences with streamed audio. This is streamed **audio output**, not a claim that
the current Pipecat adapter uses Azure's incremental-text WebSocket v2 API. Sending each token as
an independent synthesis request would undermine pronunciation and naturalness.

Use an adult, warm, pleasant and trustworthy female delivery. Approachability should come from
clear wording and a suitable voice, not childish pitch, exaggerated emotions or artificial filler.
Do not promise that a voice is sweet or natural until someone hears it in the real conversation.
Keep dates and currency explicit, avoid reading internal IDs or markup, and verify that spoken INR
amounts match the authoritative figures. Ambiguous recognition must produce clarification.

The HD synthesis request uses supported language/voice SSML and escaped text, without the
adapter's unsupported `mstts:silence`, prosody, emphasis or role controls. Do not assume that
standard-neural styling controls or word timestamps behave identically for Dragon HD.

## Delivery order and evidence

1. **Use the integrated stack.** Keep the verified Azure resources and Pipecat/Daily adapters,
   pass keys only at runtime, and keep the single startup. Model tool requests and callbacks are
   sequential; interrupted writes are reread rather than assumed successful.
2. **Run one financial call.** Speak opening cash, a later income and an earlier obligation in any
   order; leave a date unknown. Verify a useful question, saved partial facts and progressive cards.
3. **Correct and conclude.** Correct the income date or an amount naturally. Check the saved revision,
   calculated gap, card and spoken explanation. Finish with what can be concluded, what remains
   unknown and one useful next action. A qualified or infeasible outcome is valid; invented funding is not.
4. **Measure and refine this integration.** Exercise 20–30 varied finance turns before considering
   alternatives. Retain observed failures and rerun the same cases after each targeted change.

| Evaluation | Required observation |
| --- | --- |
| Responsiveness | Timestamp speech end, final STT, first model token, tool commit, first TTS audio and browser playback; report distributions, not advertised provider latency |
| Numeric accuracy | Lakh/crore, rupees/paise, similar-sounding amounts, dates and corrections survive recognition and structured capture without silent value changes |
| Natural conversation | Multiple facts per turn; no rigid questionnaire, repeated supplied questions or pressure to invent unknown values |
| Voice experience | Listener assessment of warmth, clarity, adult tone, pacing, sentence joins and INR/date/financial pronunciation |
| Interruption | User barge-in stops obsolete audible output; correction changes the right record and subsequent speech/cards agree |
| Outcome | Early shortfall remains visible despite a positive closing balance or a later spending cut; the consumer understands the next action |
| Lifecycle | No auto-microphone on reload; end/disconnect release devices and room; no fake ready or completed-plan state |

Record SDK/configuration version, exact voice name, region and observation date with measurements,
because service-managed STT and the HD Latest alias can change. Compare alternatives only after a
measured problem with this stack; change one variable at a time rather than build a provider fleet.

## Setup and current verification boundary

Use [the root setup](../README.md) and [.env.example](../.env.example): `AZURE_OPENAI_API_KEY`,
`AZURE_OPENAI_ENDPOINT`, `DAILY_API_KEY`, `AZURE_SPEECH_KEY`, and `AZURE_SPEECH_REGION`.
Select the verified Azure deployment in `voice.model`; there is no directly billed
OpenAI fallback. No dated inference API-version is required by the selected v1 API.

The [Azure deployment report](azureSetup.md) verifies existing Terra `2026-07-09`, the linked
startup credit and the created `financeVoiceIndia` S0 Speech resource in Central India.
Actual Pipecat tool-call writes/corrections, Responses schema parsing, streamed Aarti HD audio
with word boundaries and continuous `en-IN` recognition passed component checks using privately
supplied runtime credentials. Synthetic recognition exposed errors on some corrected dates and
fractional amounts; no human-accuracy or subjective voice-quality claim is made.
The latest authorized Daily check passed actual audio-only joins and bidirectional non-silent
audio between two native clients, followed by room deletion and clean client teardown. The earlier
`account-missing-payment-method` blocker did not recur. No billing settings were changed.
Offline tests use real financial HTTP/SSE and Pipecat frame aggregation with isolated provider
boundaries. A separate real browser/Daily/Pipecat/Azure smoke passed spoken cash capture,
₹6,000 → ₹6,500 correction, visible card updates, audio traffic and cleanup using synthetic
microphone speech and test-only Google identity. Eleven real-model text turns also exercised
multi-fact intake, repeated information, uncertainty, similar debts and conflicting corrections.
See [reproducible release checks](releaseChecks.md). Human microphone recognition, end-to-end
latency, acoustic interruption and consumer understanding still need human acceptance.

## Verification sources

- [Azure-sold GPT-5.6-Terra models](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure#gpt-56)
- [Azure OpenAI v1 API](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)
- [Azure language and voice catalogue](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support)
- [Azure HD voice capabilities and SSML](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/high-definition-voices)
- [Resource voice-list API](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech#get-a-list-of-voices)
- [Real-time phrase lists](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/improve-accuracy-phrase-list)
- [Pipecat Azure STT](https://docs.pipecat.ai/api-reference/server/services/stt/azure)
- [Pipecat Azure streaming TTS](https://docs.pipecat.ai/api-reference/server/services/tts/azure)
