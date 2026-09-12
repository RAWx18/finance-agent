<!-- SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Prototype recovery and conversation checks

The [joint voice reliability task](voiceReliability.md) defines provider recovery, call-scoped
termination, native-stop confirmation and the focused failure regressions. Its verification
limits apply independently of the earlier live-provider evidence below.

## Offline release checks

Run the [root validation commands](../README.md#development-and-validation), build the frontend,
then `npm --prefix frontend run test:e2e`. Browser tests use temporary financial storage and a
test-only Google provider; voice boundary doubles cannot be selected in the production app.

| Behavior | Regression evidence |
| --- | --- |
| Multi-fact intake, missing dates, uncertain income, repeated/similar debts and exact-ID corrections | [voice ambiguity](../backend/tests/test_voice_ambiguity.py), [voice flow](../backend/tests/test_voice_flow.py), [turn processing](../backend/tests/test_voice_turns.py) |
| Correction/interruption rejects delayed model text, tool calls and native synthesis callbacks | [voice errors](../backend/tests/test_voice_errors.py) |
| Recognition without filler VAD rearms the pause window; short corrections interrupt immediately | [continuation](../backend/tests/test_voice_continuation.py), [waiting](../backend/tests/test_voice_waiting.py) |
| Idle/empty-response waiting, explicit same-call Continue, zero-user recovery and bounded model/tool execution | [voice policy](../backend/tests/test_voice_policy.py), [opening](../backend/tests/test_voice_opening.py), [waiting](../backend/tests/test_voice_waiting.py) |
| Bounded recent dialogue, removal of superseded tool snapshots and preservation of current state/turn budgets | [voice context](../backend/tests/test_voice_context.py) |
| Save cancellation before/after commit, sequential tools, fresh canonical read | [turn processing](../backend/tests/test_voice_turns.py), [authorization races](../backend/tests/test_auth_races.py) |
| Denied/disconnected microphone, blocked playback, provider failure, ending during device/room/readiness setup | [browser recovery](../frontend/tests/e2e/voice.spec.ts), [conversation components](../frontend/tests/Conversation.test.tsx) |
| Lost/corrupt financial updates stop capture/playback; old streams and auth epochs cannot restore obsolete figures | [session recovery](../frontend/tests/recovery.test.tsx), [browser recovery](../frontend/tests/e2e/voice.spec.ts) |
| Expired login/logout remove private views and media; late responses stay invalid | [auth browser checks](../frontend/tests/e2e/auth.spec.ts), [voice errors](../backend/tests/test_voice_errors.py) |
| A committed save with a lost response retries the identical command without applying twice | [browser recovery](../frontend/tests/e2e/voice.spec.ts), [session recovery](../frontend/tests/recovery.test.tsx) |
| Refused/deferred actions, combined card minimums, reported costs and consent-preserving labels | [financial follow-ups](../backend/tests/test_financial_followups.py) |
| Named exclusions beside closing, timing-only versus residual gaps, focus/correction card priority and first reserve-breach date | [financial flow](../backend/tests/test_financial_flow.py), [summary](../frontend/tests/PlanSummary.test.tsx) |
| Corrected next steps survive reload; export retains exclusions; timing advice can be deferred without inventing order or creditors | [browser financial flow](../frontend/tests/e2e/financialFlow.spec.ts) |

Financial freshness requires a valid snapshot from the current stream, not merely an open socket.
Losing that stream stops the call; restoring updates does not automatically reopen the microphone.
Provider/setup retries require a user action. Failed saves retain their exact command identity until
their outcome is established. Ending remains available even when a plan is incomplete.

Conversation has no Review/Take your plan destinations or post-call plan panel. End keeps the
voice surface, live cards and Reconnect in place; detailed review, printing and downloads stay
in Money. The focused journey/continuation suites pass 64 tests, and the HTTP/SSE browser check
passes on desktop, tablet and mobile, including 320px/200% text, unchanged cards, End/reconnect,
and Money export. Types, lint and build pass. Provider boundaries are doubled in these UI checks.
The wider component run also found unrelated memory-copy, Money-region and card-summary
expectation failures; it is not an all-suite-green result.

## Opt-in real services

These checks consume real provider usage. Keep Azure/Daily credentials and endpoint/region privately in the root
environment file. They do not change provider billing, real financial sessions or Google accounts.
Use the locked backend environment, installed frontend dependencies and built frontend.

From the backend directory:

```sh
uv run --locked python -m scripts.verify_conversation --allow-billable
uv run --locked python -m scripts.verify_voice --allow-billable
uv run --locked python -m scripts.verify_continuous_voice --allow-billable --phase demo
uv run --locked python -m scripts.verify_continuous_voice --allow-billable --phase lifecycle
uv run --locked python -m scripts.verify_continuous_voice --allow-billable --phase recovery --initial-wait
```

- [Conversation verifier](../backend/scripts/verify_conversation.py): actual configured Azure model,
  configured introduction, production prompt/tools and temporary SQLite; fourteen synthetic text turns,
  at most forty model requests. Exercises free-form openings, repeated facts, conflicting amounts,
  two similar debts, an explicitly separate
  third debt, uncertainty, clarified corrections and a qualified conclusion. Optional `--output`
  writes synthetic scenario evidence, never provider keys.
- [Voice verifier](../backend/scripts/verify_voice.py): actual browser → Daily → Pipecat → Azure
  STT/model/tools/TTS → browser. Generates a temporary microphone WAV; uses test-only Google
  identity responses, not a production authentication bypass. Verifies audible stream presence,
  spoken cash capture/correction, card consistency and end cleanup. No test factory ships in the image.
- [Continuous verifier](../backend/scripts/verify_continuous_voice.py): controlled synthetic microphone,
  real providers, remote RTP, non-silent browser audio and playback state. `baseline` tests 1.2-second
  and 2-second pauses around a filler, atomic multi-fact capture, follow-up, overlapping No/Stop
  correction and End. `lifecycle` also tests 60-second waiting, Continue and genuine event-stream
  interruption followed by explicit reconnect. `recovery` uses a labeled financial fixture through
  the real command API to isolate lifecycle checks from numeric recognition; it is not spoken-fact
  acceptance. `--initial-wait` additionally exercises two real idle/Continue cycles before any speech.
  All variants use temporary SQLite/test-only Google identity and clean only their own rooms/data.
  `demo` adds explicit date clarification and complete financial scope before the interruption and
  correction. It requires one retained rent record, corrected cash of ₹6,500, a ready 30-day
  outcome with ₹4,500 closing cash, synchronized cards, audible output and clean End.

## Voice timing and recovery

The `[voice]` settings in [config.toml](../config.toml) are independent:

| Setting | Value | Meaning |
| --- | --- | --- |
| Azure segmentation silence | 500 ms | Finalizes an STT segment, not the call or conversation turn |
| VAD confidence / minimum volume | 0.5 / 0.5 | Measured short-word detection thresholds; not recognition certainty |
| VAD start / stop | 100 / 200 ms | Speech activity; stopping VAD does not interrupt the assistant |
| Continuation window | 2.6 s | Rearmed by VAD stop and nonempty final/interim recognition while VAD is quiet |
| User inactivity | 60 s | After actual assistant output ends, pause capture and offer Continue |
| Absolute call cap | 1,800 s | Waiting and Continue never extend the original call deadline |

An empty, successfully completed model response enters waiting immediately with an explicit
unfinished-response message. It does not automatically retry or invent speech. Continue requests
a read-only model response against current facts in the same room/context; stale acknowledgements
cannot enable capture. A genuine connection/financial-stream loss instead releases media and
requires an explicit new call, preserving the financial session. Daily participant acknowledgements,
owned live tracks and actual playback drive microphone/speaking status, not a synchronous toggle guess.

Diagnostics contain stage counters, completion reasons and sanitized error categories/types/status,
not keys, provider bodies, transcripts or financial values. Synthetic diagnostic payloads exist only
in the isolated authenticated test factory, which is excluded from the production image.

### Startup and End verification

The startup blocker was Pipecat's missing NLTK `punkt_tab` data: worker warmup attempted a
runtime download, and sentence aggregation could raise `LookupError` in the read-only image.
The image bundles and validates the data as the non-root runtime user; imports warm before
serving calls. Successful voice-catalog validation is cached, both Daily tokens are requested
concurrently, and BotReady waits for actual processor startup rather than the opening response.
End stops local media and finishes the UI immediately; owned keepalive termination and SDK
cleanup proceed independently. Unconfirmed backend cleanup still blocks overlapping calls.

Real Chromium/Daily/Pipecat/Azure measurements on 12 September (two consecutive calls):

| Measurement | Cold call | Warm call |
| --- | --- | --- |
| Start → ready with live microphone | 5.91 s | 4.41 s |
| Start → first non-silent assistant audio | 10.15 s | 7.98 s |
| End → local media stop | 1 ms | 1 ms |
| End → confirmed backend cleanup | 270 ms | 265 ms |

These are observed samples with microphone permission granted, not latency guarantees or human
permission-decision time. Daily room/token requests took about 2 s and native join 1.7–2.4 s;
opening-model generation remains the main delay after readiness. Framework warmup during each
call took 1.5–2.6 ms. Refresh released the real call in 365 ms. Native permission denial and
End during a genuinely pending permission prompt created no room or worker. All owned rooms
were confirmed absent with Daily GET 404, and test processes/storage were released.

Reproduce using [the managed lifecycle verifier](../backend/scripts/verify_lifecycle.py):
`uv run --locked python -m scripts.verify_lifecycle --allow-billable --cycles 2 --mode cycles`
from the backend directory. Modes `refresh`, `denied`, and `prompt` accept `--cycles 1`;
`prompt` requires a desktop display. The verifier uses Reconnect on the same Conversation surface.
The final focused checks passed 84 backend and 268 frontend tests, plus types/lint/contracts/build.
These results describe the validated demo snapshot, not subsequent concurrent worktree edits.
One 300 ms synthetic model-timeout case failed initially, then passed unchanged in isolation and
the scoped rerun; no production timeout was altered. Slow-provider and Daily reconnect failure
paths are boundary-injected regressions, not claims of a deliberately induced live-provider outage.

## Evidence boundary

The demo-focused check on 12 September passed the actual Daily/Pipecat/Azure/model path in three
completed user turns and seven model requests, including paused intake, date clarification,
interruption, correction and the ready outcome above. No hang or provider error occurred; media,
room and temporary-data cleanup passed. Six focused financial-flow regressions also passed.

Its initial rehearsal exposed a garbled date being marked as an unavailable answer. The voice
instructions distinguish unclear recognition from an explicit “I don't know”; a targeted real-model
replay preserved both clear amounts and kept the date askable. This is prompt guidance, not a
guarantee for arbitrary model output. Recognition itself remains variable. Use a guided prototype
demo and verify spoken amounts/dates against the cards; human-microphone acceptance remains separate.

The 12 September prototype handoff ran 99 focused regressions covering opening, continuation,
context bounds, configuration, explicit unknowns, conflict resolution and Azure adapter construction.
Python types/lint, frontend types/lint, generated contracts and the production frontend build passed.
The full suites and paid voice exercises were not repeated for this final handoff; this is not a
claim of complete human-conversation acceptance.

Voice-specific handoff checks pass six desktop/mobile cases: acknowledged microphone toggles,
same-call Continue with corrected figures, and End during pending Continue. The affected backend
policy/turn/waiting suites pass 61 tests under coverage; an earlier full frontend unit run passed
641 tests. The local app's health endpoints return 200, its voice/config hashes match source,
and the served frontend matches the current production build at `http://localhost:8000`.

The earlier broad browser run had 175 passes, 42 failures and 14 skips, including obsolete UI
assertions. Two callback timeouts in the full backend coverage run were corrected and checked in
the focused suites. Neither broad suite was rerun for the voice handoff; no all-suite-green claim
is made. Mobile card reflow is allowed after financial changes without relaxing call-control checks.

On 12 September 2026, real media reproduced premature turn splitting and an empty normal-stop
model response after No/Stop plus a correction. The original reported fatal incident's logs were
not retained, so its exact exception remains unknown. Recognition-aware continuation and measured
short-word VAD settings passed the paused multi-fact exercise. Explicit post-tool response guidance
passed audible corrections without automatic retries. A real Continue run exposed stale muted UI
state despite active capture; the Daily participant acknowledgement regression and live rerun passed.

Real checks also passed 60-second waiting, two same-call idle/Continue cycles before any user speech,
a six-second thinking pause without inference, actual event-stream loss with capture release,
explicit reconnect to a different media call with unchanged financial facts/session, audible response,
and End cleanup. Browser offline emulation alone left WebRTC connected; it is not reconnect evidence.
The actual stream-loss/reconnect check used the separately labeled API-seeded recovery fixture.

Repeated strict speech runs remain nondeterministic: ₹6,500 was sometimes recognized as ₹60,500,
and 15 September was once recognized lexically as 5 April. A separate detailed-recognition probe
recognized ₹6,500 correctly twice; that does not resolve the intermittent error. No numeric tolerance,
silent correction, provider substitution or success claim masks these failures. The prototype still
needs human numeric/date verification, noisy-room/breath testing and physical-speaker evaluation.

On 11 September 2026, the real-model eleven-turn exercise passed in 21 requests. The browser
voice smoke also passed: spoken ₹6,000 was saved and corrected to ₹6,500 on the card; inbound and
outbound WebRTC audio were observed, capture stopped, and the temporary room was subsequently
confirmed deleted by GET 404. Google identity and microphone speech were synthetic in that check.

This does not certify arbitrary model outputs, human speech recognition, acoustic barge-in latency,
subjective voice quality or consumer understanding. Test at least one human conversation with an
early gap, missing information and a correction before calling the submission fully accepted.
The production login additionally requires private Google configuration; local health alone does
not establish sign-in/provider availability. Remote CI and Codecov uploads need their own run.
