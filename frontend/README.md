<!-- SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Conversation-first financial frontend

React 19, TypeScript, React Router, Vite and the Pipecat Daily browser transport. Google sign-in
gates `/app`, `/history`, `/money` and `/account`; the backend independently authorizes all financial access.
The journey is welcome →
microphone preparation → live conversation and evolving cards → review → finished. Opening the
page or preparing never starts capture. **Money** has a compact overview and shallow income, spending,
debt, upcoming and plan-change routes. Focused corrections preserve exact record identity and are
unavailable during a call; unresolved corrections or commands prevent a new call. No simulated conversation, payment
execution, browser financial calculations or runtime sample data are included. Provider setup and live-call
verification are documented in [../README.md](../README.md).
The server uses an Azure-hosted Terra deployment with Microsoft Foundry Speech STT/TTS;
Azure keys/endpoints stay server-side. See [the voice plan](../docs/voicePlan.md) for live acceptance
and [Azure setup](../docs/azureSetup.md) for verified component checks and remaining live-journey
acceptance.

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

## Money

[src/MoneyPage.tsx](src/MoneyPage.tsx) owns the saved-picture shell; [src/moneyRoutes.ts](src/moneyRoutes.ts)
defines `/money` and its `/income`, `/spending`, `/debts`, `/upcoming`, and `/changes` destinations.
The overview prioritizes the first dated gap and a server-selected next step. Category lists use
bounded scrolling, pagination and useful search/filter controls. Earlier requirements and unknown
dates remain discoverable without being labelled paid. User reports, estimates, conflicts, proposed
changes, saved assumptions and calculated results stay distinct.

Corrections use revision-checked `updateFacts`, not a replacement copy of financial truth.
Concurrent edits require reopening current values; unconfirmed saves retain the identical command
for retry. Calculation dialogs use server contributions and exclusion reasons. Active projections
use `accepted.plan ?? plan`; previews never enter ordinary totals or backend downloads.

## Integration

[Root startup](../README.md) and [CI](../.github/workflows/ci.yaml) build and serve
the frontend with the backend at http://localhost:8000. No separate frontend
process is required in the built app. For direct Python development, build this
frontend before starting the backend.
Vite is development-only; its API proxy rewrites Host and Origin to localhost:8000.
Google callbacks return to the configured backend origin; use the built app on port 8000 for
complete sign-in and account testing. Do not expose the development proxy publicly.

`npm run test:e2e` starts a temporary real backend using the test-only
`tests.auth_support:browser_app` provider factory. Install Chromium with
`npx playwright install chromium` and build first. OAuth callback/crypto/session storage are real;
Google responses are synthetic and no test-login route is shipped. The desktop, tablet,
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
Neither mode uses the shared Compose volume. With `--serve`, run Playwright directly with
`E2E_BASE_URL` set to the printed origin to reuse that test server.

[src/Auth.tsx](src/Auth.tsx) restores a server login before mounting financial state, refreshes
visible sessions and checks on focus or browser restoration. Logout/expiry clear user-owned
in-memory data, requests and media. Cross-tab signals carry no credentials and only trigger
server revalidation. Google tokens never enter browser storage; auth and financial retention
are independent. The header [profile menu](src/ProfileMenu.tsx) exposes Settings and Sign out;
it supports keyboard navigation and closes outside or on route changes without shifting the page.
[Settings](src/Account.tsx) stays at `/account`, with display-name editing, compact read-only Google
identity and a secondary account-deletion action. Deletion requires explicit confirmation and recent
sign-in when requested. Privacy and retention details remain in the footer.

Unit doubles verify client contract behavior only. They do not establish live API,
voice, browser CSP, complete accessibility, or container integration. Run the real
browser suite against the built application and inspect the rendered states.

[src/Conversation.tsx](src/Conversation.tsx) requests microphone permission before starting the
cookie-owned call, attaches remote audio tracks, and requires BotReady plus a live local capture
track before claiming listening. Speaking, thinking, interruption, pause and disconnect follow
actual SDK events. The [official assistant-ui VoiceOrb](src/components/assistant-ui/elements/voice.tsx)
comes from the standalone renderer used by the [`@assistant-ui/voice` registry](https://r.assistant-ui.com/voice.json).
It receives the emerald palette, five session states and measured local/remote audio volume;
no assistant-ui session runtime, model adapter or second media connection is needed. Connecting
and reconnecting map to `connecting`; muted or paused capture to `muted`; audible assistant speech
to `speaking`; user speech, interruption and thinking to `listening`; terminal states to `idle`.
Silent, muted, stale and blocked input supplies zero volume, not fabricated microphone activity.
The upstream component owns the WebGL2 shaders and state animations. Its
[registry provenance](src/components/assistant-ui/registry.json) and [MIT license](src/components/assistant-ui/LICENSE.md)
are retained; unit tests verify the renderer hash and browser tests verify its compiled shaders,
emerald uniforms and actual drawn pixels. A documented accessibility patch freezes the same WebGL
renderer under reduced motion, redrawing only for state and size changes; there is no substitute SVG.
Reconnect explicitly starts a fresh transport after
cleanup, not a claimed restoration of the previous call. Mute/end, page exit and failed startup release
local devices and the server call. Reload never opens the microphone automatically. Only the
short-lived Daily participant token enters browser memory; provider keys remain server-side.
GET/POST/DELETE `/api/session/call` use generated contracts, and financial updates continue over
the existing snapshot SSE connection. Component SDK doubles test lifecycle behavior, not live audio.
Public failures use consumer wording; server logs retain safe setup diagnostics. No configuration
names or raw SDK/provider error messages are rendered.

A fresh valid financial snapshot is required before room creation. Lost or corrupt updates end
local capture and playback rather than allowing a stale financial conversation to continue.
After recovery, reconnect is explicit; late SDK events, snapshots and replies from old sessions
are ignored. A disconnected microphone also releases the call and offers retry. The
[release checks](../docs/releaseChecks.md) distinguish real HTTP/SSE recovery tests, SDK doubles,
real provider smoke and the remaining human acceptance exercise.

[src/Captions.tsx](src/Captions.tsx) shows only the latest spoken caption under the large official Orb
and accessible icon call controls. [src/History.tsx](src/History.tsx) reads separate persisted calls from
`/api/history`, with title/date/message search and readable `/history/<slug>` deep links that survive
Google sign-in. Assistant UI's official Thread List and Day Separator elements render the stored
human and Isha captions; its disabled external-store runtime owns conversation scrolling without a
composer or model connection. [Component provenance](src/components/assistant-ui/historyRegistry.json)
records MIT sources and styling/accessibility adaptations. Mobile navigation switches between the list
and the selected chat. Downloads fetch the selected server transcript, not the financial-plan export.

Navigation between History and the call keeps the existing call alive. Caption notifications refresh
saved history without copying ephemeral browser text into it; reading position is preserved. Records
survive reload/sign-out until the financial session expires or is deleted; deleting the account also
deletes captions. Only final human transcription and actually emitted assistant spoken-progress are
stored. Interrupted prefixes stay partial; unspoken output, tool calls and earlier unsaved conversations
are never reconstructed. Privacy and retention details remain in the footer.

[src/Toast.tsx](src/Toast.tsx) provides one bottom-right notification stack, including inside native
dialogs. Informational notices expire; permission issues, failed connections and uncertain mutations
retain recovery actions. Hover, focus, hidden tabs and minimized notifications pause expiry. Critical
notices are retained through retry and can be minimized without dismissing them. Field validation
and financial conditions remain next to their controls. Notifications are cleared across account changes.

[src/FinancialContext.tsx](src/FinancialContext.tsx) renders only the server's `workspace.cards`:
progressive grouped facts, missing/conflicting information, timing/gaps, decisions and outcome.
Empty categories are absent. [src/WorkspaceDetails.tsx](src/WorkspaceDetails.tsx) provides targeted
corrections, explicit conflict resolution and calculation evidence without browser arithmetic.
Cards and Isha share the same workspace, including bounded question candidates and unresolved issues;
see the [financial contract and templates](../docs/financialWorkspace.md).
Corrections highlight changed cards and their dependent results without moving focus. Proposed changes are separate
from the current picture and visibly excluded until accepted. The inline proposal review uses
the same command path as manual comparisons, shows full replacements/removals and requires exact
unconditional consent. Saved unavailable answers and declined cuts move to the server's next action
without hiding unknown facts or financial gaps. Action-specific failures use the shared notification
system. Rejecting a preview records explicit refusal; closing it only discards exploration.
Finishing review is a local navigation
step, not financial verification or a backend mutation; later saved changes require review again.

[src/Dialog.tsx](src/Dialog.tsx) handles secondary financial details, privacy and editing with native
modals, keyboard containment, Escape and focus return. Nothing expands in the page. Ready/live
panes keep their dimensions; the tiny live caption, dedicated history and financial context each own their scroll area. Short screens
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