<!-- SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Conversation-first financial frontend

React 19, TypeScript, Vite and the Pipecat Daily browser transport. The journey is welcome →
microphone preparation → live conversation and evolving cards → review → finished. Opening the
page or preparing never starts capture. **Your figures** opens a secondary dialog; editing is
unavailable during a call, and unresolved drafts or commands prevent a new call. No simulated conversation, payment
execution, browser financial calculations or runtime sample data are included. Provider setup and live-call
verification are documented in [../README.md](../README.md).
The server uses an Azure-hosted Terra deployment with Microsoft Foundry Speech STT/TTS;
Azure keys/endpoints stay server-side. See [the voice plan](../docs/voicePlan.md) for live acceptance
and [Azure setup](../docs/azureSetup.md) for verified component checks and the current Daily
account-activation blocker.

## Checks (from this directory)

- `npm ci` — install the locked dependencies with Node 24.12 or later.
- `npm run contracts` — generate the committed TypeScript API schema.
- `npm run contracts:check` — regenerate in memory and require byte equality.
- `npm run check` — TypeScript and ESLint.
- `npm run test:unit` — Vitest/RTL; writes LCOV and Cobertura under coverage.
- `npm run build` — type check and build static output under dist.
- `npm run dev` — optional frontend-only Vite development server on localhost:5173.
- `npm run test:e2e` — real-backend Playwright tests, including explicitly isolated voice transport doubles.

The contract generator uses the Node `openapi-typescript` API, spawning
`uv run --project <absolute backend path> --locked python -c ...` from the backend
directory. Importing `app.main` and printing `app.openapi()` does not open storage
or start the server. Python/uv and the backend environment are required only for
contract generation/checking, not for building the checked-in TypeScript artifact.
The generated source begins with the repository SPDX attribution.

## Integration

[Root startup](../README.md) and [CI](../.github/workflows/ci.yaml) build and serve
the frontend with the backend at http://localhost:8000. No separate frontend
process is required in the built app. For direct Python development, build this
frontend before starting the backend.
Vite is development-only; its API proxy rewrites Host and Origin to localhost:8000.
Do not expose that development proxy as a public deployment.

Playwright expects the built UI and real backend already running, with isolated
local test storage and `PUBLIC_ORIGIN` matching the test origin. It does not start
servers. Install its Chromium browser with `npx playwright install chromium`.
`E2E_BASE_URL` can select a different authorized local origin. The desktop, tablet,
and mobile projects use synthetic figures, derive dates from the session anchor,
and delete their sessions. The suite covers the early-gap golden scenario,
salary correction, persistence, export, deletion, and multi-tab SSE reconciliation.
It also covers optional/card consent and minimums, preview isolation, acceptance,
replacement without stacking, clearing, correction invalidation, and saved print/export.
Financial tests use the real HTTP/SSE API. Preparation tests prohibit capture and provider calls;
availability failures are isolated at the settings boundary. The separate
[voice browser suite](tests/e2e/voice.spec.ts) builds the real App in memory with
[test-only SDK doubles](tests/voiceSdk.ts), uses Chromium's fake microphone, intercepts every
call endpoint, and blocks provider traffic. Financial commands, calculations, SSE corrections and
downloads still use the real backend. Its screenshots and event assertions validate layout and
integration, not recognition, real audio playback, latency or a provider-backed conversation.
For isolated validation after building, `node scripts/e2e.mjs` starts a real backend
on a free port, runs the suite, and removes temporary storage. Use
`node scripts/e2e.mjs --serve` to inspect the same built UI manually; stop with Ctrl+C.
Neither mode uses the shared Compose volume. With `--serve`, run the normal E2E
command against the printed origin to reuse that server.

Unit doubles verify client contract behavior only. They do not establish live API,
voice, browser CSP, complete accessibility, or container integration. Run the real
browser suite against the built application and inspect the rendered states.

[src/Conversation.tsx](src/Conversation.tsx) requests microphone permission before starting the
cookie-owned call, attaches remote audio tracks, and requires BotReady plus a live local capture
track before claiming listening. Speaking, thinking, interruption, pause and disconnect follow
actual SDK events. Only spoken text becomes captions; four recent entries and bounded history
keep the call readable. Mute/end, page exit and failed startup release
local devices and the server call. Reload never opens the microphone automatically. Only the
short-lived Daily participant token enters browser memory; provider keys remain server-side.
GET/POST/DELETE `/api/session/call` use generated contracts, and financial updates continue over
the existing snapshot SSE connection. Component SDK doubles test lifecycle behavior, not live audio.
Public failures use consumer wording; server logs retain safe setup diagnostics. No configuration
names or raw SDK/provider error messages are rendered.

[src/FinancialContext.tsx](src/FinancialContext.tsx) consumes the current canonical snapshot:
reported facts, active accepted plan, server-selected questions/actions, budget uncertainty and
outcome. Corrections highlight changed cards without moving focus. Proposed changes are separate
from the current picture and visibly excluded until accepted. The inline proposal review uses
the same command path as manual comparisons, shows full replacements/removals and requires exact
unconditional consent. Saved unavailable answers and declined cuts move to the server's next action
without hiding unknown facts or financial gaps. Action-specific failures are visible beside these
controls; discarding a conflicting preview does not silently record a decline.
Finishing review is a local navigation
step, not financial verification or a backend mutation; later saved changes require review again.

[src/Dialog.tsx](src/Dialog.tsx) handles secondary details, privacy, history and editing with native
modals, keyboard containment, Escape and focus return. Nothing expands in the page. Ready/live
panes keep their dimensions; captions and financial context each own one scroll area. Short screens
and enlarged text can scroll naturally. The browser suite checks viewport fit, dialog stability,
corrections without card reordering, touch control labels, and 320-pixel layouts at 200% text.

Drafts and unsubmitted selections stay in memory. An uncertain mutation locks editing and retains the exact command
UUID/body for retry; keep the page open until resolved. Cross-tab changes require
explicit review before replacing saved facts or accepting a preview. Eligibility comes
only from the options endpoint and refreshes on financial revision changes. Each
selected occurrence has its own amount. A hypothesis can be previewed while changeability is
unknown, but acceptance requires confirmed saved changeability and explicit unconditional consent
to the exact whole proposal, including removals. Corrections clear previews and invalidate affected
occurrence assumptions; unrelated accepted assumptions remain saved and are recalculated.
Consent resets on proposal identity, revision, sequence, visibility and lock changes, including
lost freshness. Snapshot facts/plan remain the reported baseline; saved cards use accepted.plan when
present. Downloads always use the backend's last saved projection; printing includes
accepted assumptions but excludes previews, selections and fact drafts. Cookie ownership stays HttpOnly
and is never copied to URLs or browser storage.