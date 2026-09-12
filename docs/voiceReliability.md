<!-- SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Joint voice reliability implementation

**Owners:** Team Lead Agent — failure priorities, recovery semantics and review;
Backend & AI Engineer Agent — provider, worker and call lifecycle implementation;
coordinator — browser integration and focused end-to-end verification.

**Outcome:** a voice failure must not delete a financial plan, replay a financial mutation,
publish obsolete advice, silently resume capture or claim resource cleanup without evidence.
The existing Pipecat → Daily → Azure Speech → configured GPT-5.6-Terra → financial
tools/SQLite → browser architecture remains in use. No alternative provider or retry service.

## Recovery decisions

| Failure | Recovery |
| --- | --- |
| User interruption or financial correction | Advance the response generation, flush playback and cancel obsolete model/tool/speech work. Refresh authoritative state before answering. |
| LLM timeout, connection failure, throttling or retryable server outage | Pause the same call. Discard partial assistant/tool context, retain completed user input and committed figures, and require explicit Continue. No automatic model request or write replay. |
| TTS first-audio, progress or overall timeout; empty audio; temporary speech-provider failure | Retire request callbacks, stop synthesis and pause only after interruption settles. Do not emit a speaking-start signal without audio. Continue requests one read-only response from current state. |
| Invalid provider credentials, exhausted billing quota, malformed output, unsafe completion or unknown pipeline exception | End media, preserve the plan and report a concise failure. A new call requires a user action; provider configuration may need repair. No fabricated financial answer. |
| STT unexpected cancellation/session stop or malformed recognition | Retire the recognizer and reject late callbacks. End media; explicit reconnect creates a fresh recognizer with current financial state. Intentional shutdown is not a recognition failure. |
| Invalid/stale tool arguments | Keep structured validation/current-state feedback and revision checks. Unknown tools or exhausted execution budgets cannot authorize an ungrounded response. |
| Interrupted or uncertain financial command | Preserve transaction boundaries and command receipts. Reconcile authoritative state; retry only the same command identity/body. A committed write survives response loss. |
| Daily setup/join failure, terminal disconnect or call/token expiry | Stop the owned call and attempt room cleanup. Reconnect explicitly with a fresh call ID, room and tokens, retaining the valid financial session. |
| Browser media failure, lost/corrupt SSE or backend synchronization loss | Stop capture/playback immediately. Do not reconnect automatically or accept stale SDK/SSE/auth callbacks. Require current financial updates before another room request. |
| Page refresh or unload request loss | Attempt call-scoped keepalive End without awaiting SDK disconnect. Reload checks server ownership without microphone access; unresolved calls expose Retry ending call. |
| Auth/session expiry or deletion | Stop media and reject financial work. Require authentication or a genuinely new financial session as appropriate; never silently recreate deleted/expired figures. |

## Ownership and cleanup contract

- POST and DELETE of `/api/session/call` require `{callId}`. Allocate the UUID before
  setup. Same-ID starts share one join; completed/cancelled IDs cannot create another agent.
  End(A) cannot stop B, including End arriving before A's delayed setup request.
- Status includes `cleanupConfirmed` and `ending`. A terminal status alone is not proof of
  cleanup. Unresolved pipeline/native/room teardown blocks replacement admission; explicit End
  retry reobserves pending work rather than duplicating native stop requests.
- Cancellation identities are budgeted per user and reclaimed on login revocation. One user's
  exhausted budget cannot deny other users admission.
- History finalization, room deletion and media teardown have independent progress within the
  shutdown budget. A stalled history operation must not prevent room deletion.
- Azure native operations remain tracked after a coroutine timeout. Recognizer stop cannot
  overtake a queued native start. Callback retirement is immediate; actual termination is a
  separate fact. Pipecat worker exceptions, cancellation and timeout cannot look like clean End.
- Deadlines live in [config.toml](../config.toml): model, startup, shutdown, absolute call
  lifetime, and synthesis first-audio/progress/overall limits. Browser startup/shutdown limits
  come from server settings; media expiry comes from the returned credentials.
- Logs retain sanitized stage, exception type, provider HTTP status and generation information,
  not credentials, raw provider bodies or private financial dialogue.

## Focused acceptance evidence

- [Provider recovery](../backend/tests/test_voice_recovery.py): LLM timeout/connection/throttle/
  server failure before and after commit; explicit Continue; empty/stalled/cancelled TTS;
  stale callbacks; STT loss; worker crash and timeout.
- [Native and pipeline cleanup](../backend/tests/test_voice_errors.py) and
  [speech lifecycle](../backend/tests/test_speech.py): real releasable thread waits, repeated
  cleanup, queued recognition start and cancellation. Unconfirmed native work blocks replacement.
- [Call recovery](../backend/tests/test_call_recovery.py): identity races, duplicate start,
  cancellation before/during setup, partial cleanup and retry, malformed Daily responses,
  expiry, per-user cancellation budgets and retained figures.
- [Financial cancellation](../backend/tests/test_voice.py),
  [turn guards](../backend/tests/test_voice_turns.py) and
  [authorization races](../backend/tests/test_auth_races.py): rollback, idempotent retry,
  committed-state preservation and rejection of obsolete results.
- [Browser components](../frontend/tests/Conversation.test.tsx),
  [API validation](../frontend/tests/api.test.ts) and
  [authenticated HTTP/SSE](../frontend/tests/e2e/voice.spec.ts): token expiry, hung SDK cleanup,
  actual refresh with explicitly injected unload network loss, same-ID End retry, SSE loss,
  microphone disconnect, stale Continue acknowledgements and duplicate command retry.

## Verification limits and operations

These fault tests isolate external providers while exercising real Pipecat, SQLite and browser
boundaries. They do not certify live Azure/Daily outage behavior, physical playback, acoustic
interruption or arbitrary model accuracy. See [release checks](releaseChecks.md) for opt-in
paid-provider acceptance. Full unrelated suites and remote CI/Codecov were not rerun for this task.

Browsers cannot guarantee unload delivery. A native SDK thread that never returns cannot be
force-stopped safely by Python; cleanup remains unconfirmed. Retry End first; an operator may
need to restart the application while retaining its SQLite volume. Hard process termination
cannot run finalizers or immediately delete a Daily room: room/token expiry bounds remaining
media access. Immediate room deletion after SIGKILL is not claimed.