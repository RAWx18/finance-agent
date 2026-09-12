<!-- SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Voice and financial-state backend

FastAPI owns sessions, deterministic cash flow and a single supervised Pipecat/Daily call.
Streaming Azure Speech connects a GPT-5.6-Terra conversation role to validated fact and decision tools.
Provider-backed calls require the setup in [../README.md](../README.md);
[Azure component checks](../docs/azureSetup.md) verified actual target-account inference/STT/TTS,
not the complete Daily call or human recognition quality. Manual comparisons and export
use the same state. No payments, bank connections or audio recordings are made. Actual final human
captions and emitted Isha responses are retained as separate per-call conversations in SQLite.

The [financial workspace contract](../docs/financialWorkspace.md) describes templates, fact
lifecycle, evidence and conversational boundaries. `updateFacts` and voice `update_facts` use
[app/facts.py](app/facts.py); [app/workspace.py](app/workspace.py) derives the same read-only
workspace for HTTP/SSE, cards and Isha.

## Run and validate

From the repository root, with Python 3.12–3.14 and uv:

```sh
uv sync --project backend --locked
uv run --project backend uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000 --no-proxy-headers --no-access-log
uv run --project backend pytest backend/tests --cov=app --cov-report=term-missing --cov-report=xml:backend/coverage.xml
uv run --project backend ruff check backend/app backend/tests
uv run --project backend ruff format --check backend/app backend/tests
uv run --project backend mypy --config-file backend/pyproject.toml backend/app
```

Use **one Uvicorn worker and one backend instance per database**. The backend is the sole
SQLite writer. [Root startup](../README.md) builds the frontend and backend together;
[CI](../.github/workflows/ci.yaml) runs the tests and uploads coverage through Codecov.

[../config.toml](../config.toml) is the typed, nonsecret behavior configuration. Unsupported
currency/timezone/horizon and invalid limits fail startup. Only these environment values are read:

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_ENV` | `local` | `local` or `staging`; staging requires HTTPS |
| `PUBLIC_ORIGIN` | `http://localhost:8000` | Exact public origin, without trailing slash/path |
| `DATA_DIR` | repository `.data` directory | SQLite storage; set `/data` in the container |
| `GOOGLE_CLIENT_ID` | empty | Google Web application OAuth client; required for sign-in |
| `GOOGLE_CLIENT_SECRET` | unset | Google client secret; backend only |
| `AUTH_ENCRYPTION_KEY` | unset | Stable Fernet key for persisted Google grants |
| `AZURE_OPENAI_API_KEY` | unset | Azure resource key for conversation; secret |
| `AZURE_OPENAI_ENDPOINT` | empty | Azure resource root or `/openai/v1/` URL; normalized to v1 |
| `DAILY_API_KEY` | unset | Required for private rooms and scoped participant tokens |
| `AZURE_SPEECH_KEY` | unset | Required for Foundry Speech continuous recognition and streaming synthesis |
| `AZURE_SPEECH_REGION` | empty | Matching resource region; no region or resource is silently selected |

Azure/Daily credentials and Speech region are required only for voice. Google settings are
required for all user access; missing settings do not disable health endpoints or the login page.
The selected stack and live evaluation steps
are in [../docs/voicePlan.md](../docs/voicePlan.md). Database creation and cleanup start in lifespan,
not on import. Session expiry is fixed at creation, not extended by reads or edits.
The local-date anchor and `asOf` cash basis stay fixed on refresh and editing. Corrections refer
to that original financial picture; a current cash position needs a fresh projection.
SQLite rows and command results are
deleted on expiry/deletion; this is logical deletion, not a forensic secure-erasure guarantee.

Built React output is served from the frontend build directory. API/health paths never
fall through to the SPA. The CSP permits same-origin application assets and specific Daily
connection/worker resources; inline scripts/styles remain blocked. Build CSS to files.

## Conversation execution

The primary configuration's `[voice]` section selects the assistant name/introduction, language,
tone, verified model deployment, turn/VAD timings, inactivity, token/tool budgets and response
length guidance. Resource endpoints and credentials stay in the environment. The configured
opening guidance drives one model response after client readiness with financial tools disabled.
It requests a brief introduction and free invitation, not opening cash. User-first speech preempts
it; its one-time instruction is removed before processing the first user turn.

Every completed user turn requires a processing tool before speech. One `update_facts` can merge
all clear facts; `read_state` handles a turn without changes. Tool-bearing completions do not
publish their accompanying prose. Only a completed, current-generation response after the tools
may speak. The same model handles extraction and language; no second financial planner runs.
Model streams and tool rounds have configured upper bounds. Sentence/question limits guide model
presentation; they are not proof of arbitrary language compliance.

Recognition activity rearms the 2.6-second continuation window even when VAD misses a short filler.
The independent 60-second idle state pauses browser capture, not the room or financial session.
Sequenced Continue is explicit, read-only and owner-validated; it cannot extend the original
30-minute call deadline. Empty normal-stop model output offers the same recovery with an
unfinished-response explanation, never automatic retries or fabricated audio. Provider failures
remain bounded and fail closed. [Live checks and limits](../docs/releaseChecks.md) distinguish
real audio/connection evidence from synthetic identity/input and intermittent recognition failures.

An explicit unknown money value or null date in a patch records an unavailable answer only for
the corresponding clarification, in the same transaction. Omitted fields are not such answers.
Unknowns remain visible and qualified; later corrections invalidate dependent responses. Ambiguous
record targets and competing field values are retained until an explicit clarification, not silently
chosen or erased by an unrelated manual draft.

[app/voice.py](app/voice.py) verifies the configured Azure female English voice, then provisions
a private room with separate short-lived browser/bot tokens. Both room and tokens use
`permissions: {canSend: ["audio"], canAdmin: false}`; neither participant is a meeting owner.
This enforces audio-only media rather than relying on the camera starting off. The call manager
supervises readiness and closes the call on end, deletion, expiry or failure.
[app/voice_pipeline.py](app/voice_pipeline.py) connects Daily → Azure real-time STT → Terra
→ financial tools → Azure streaming TTS → Daily, with real RTVI events and Silero/timeout turns.
[app/speech.py](app/speech.py) attaches financial phrase hints before recognition and uses HD-safe
SSML without unsupported prosody/silence tags. The standard en-IN STT endpoint is service-managed;
no invented latest model ID or batch-transcription path is used. TTS streams audio per short sentence.
[app/voice_tools.py](app/voice_tools.py) exposes `read_state`, `update_facts`, `review_plan`,
`respond_to_action`, `preview_adjustments`, `accept_preview`, `reject_preview`, `discard_preview`,
and `clear_accepted`. `review_plan({expectedRevision})` reads the deterministic workspace and
active assessment; no planner LLM runs. Explicit rejection records refusal; discarding only closes
exploration. Both leave reported facts unchanged.
Persist concerns through `update_facts.decision`. Scenario tools use the same commands as HTTP.
`AzureLLMService` sends streaming Chat Completions to the supplied Azure v1 endpoint;
`voice.model` supplies the verified deployment name in the API's `model` field. No direct OpenAI
billing is used.
No dated inference `api-version` is needed. Terra's Chat Completions tools require the configured
`reasoning_effort=none`; a different deployment must be verified for compatible capabilities.
`parallel_tool_calls=false` prevents parallel model tool requests; Pipecat callbacks also run
sequentially. Completed STT segments are collected through the current VAD/pause-based turn
aggregator before inference. Split corrections and interrupted writes are exercised using the
real installed Pipecat frame/aggregator code with isolated provider boundaries.

Partial updates merge under the existing store lock, then use the existing normalization,
calculation, revision, idempotency and SSE path. Missing amounts/dates stay unknown; income
reliability and debt type can remain explicitly unknown. Completed tool arguments—not interim
transcripts—reach the store. Interruption cancels synchronous tools; transactions either commit
or roll back, and the assistant must reread before assuming a save succeeded. External edits
interrupt obsolete speech and refresh its context. Review rejects stale revisions. Canonical state
includes the same `workspace` as the cards, explicit `scope`, `activeAssessment`, `currentAction`,
`actionResponses`, `outcome` and a deterministic `spokenBrief`. Bounded `dialogue.questionOptions`
identify material fields and decision relevance; Isha chooses the wording, not the engine.
Results carry contributing/excluded references and the exact deficit-producing occurrences.
No second financial ledger lives inside the agent. Framework integration tests
do not establish acoustic barge-in, recognition accuracy or end-to-end voice latency.

Model text, tool results and synthesized audio carry the current conversation generation. State
changes and interruption invalidate prior output; late native SDK callbacks belong only to their
original synthesis request. The watcher refreshes canonical state on heartbeat as well as events.
Errors revoke output before bounded cleanup, without exposing provider exception bodies.

Voice creation rejects a repeated normalized label within its category rather than silently
adding another commitment. `distinct: true` is reserved for an explicitly separate new item;
corrections use the existing ID. Ambiguous targets must be clarified, and disputed amounts must
not be presented as newly confirmed. This guard supplements, not replaces, model-level semantic
evaluation. See the [recovery suite and opt-in live checks](../docs/releaseChecks.md).

`respond_to_action({expectedRevision, actionId, response})` records only a completed explicit
`unavailable` answer to a currently offered clarification/receipt/terms question or inability to take
its contact, follow-up, support or shared-commitment review step. `declined` rejects only that
spending reduction. Deferral never invents a payee response; outstanding steps and risks remain
in the outcome. The HTTP operation is `respondToAction`. The server owns
dependency keys and validates membership in the bounded workspace actions; facts, coverage and
obligations stay unchanged. Deferred questions leave the candidate list but remain visible issues.
Relevant corrections invalidate responses while unrelated edits preserve them. An overlapping
different preview is a conflict requiring review/discard, not permission to guess the user's intent.

Combined same-date card minimum comparisons use the existing cash-flow kernel. Declining target
reductions does not turn a funded minimum into an unfunded required payment or apply the cuts.
Reported terms preserve known zero/estimated costs. Label corrections refresh retained assumption
labels without changing amounts, occurrence consent or its original acceptance revision.

## HTTP contract

Google OIDC and account management are separate from financial facts. See
[app/auth.py](app/auth.py), [app/auth_routes.py](app/auth_routes.py) and [app/google.py](app/google.py).
Google subject plus issuer maps to an internal UUID; emails never link accounts. OAuth uses
one-use state bound to a browser cookie, S256 PKCE, nonce, RS256 ID-token validation and fixed Google
endpoints. Access/refresh tokens stay encrypted on the server. Logins are opaque random cookies
stored as hashes, with absolute/idle expiry. Configured rechecks detect revoked Google grants;
provider failures fail closed without erasing finances.

| Identity endpoint | Contract |
| --- | --- |
| `GET /api/auth/settings` | Public `{googleAvailable, sessionHours}` |
| `POST /api/auth/login` | `{returnTo}` → `{url}`; exact allowlisted app, Money and history destinations create a bound sign-in flow |
| `GET /auth/callback` | Only cross-site callback; validates and consumes state, then redirects to an allowed route |
| `GET /api/auth/session` | `{user:{id,displayName,googleName,email},expiresAt}` or 401 |
| `POST /api/auth/refresh` | `{}` → auth session; never extends the absolute limit |
| `POST /api/auth/logout` | `{}` → 204; revoke current login and stop its voice connection |
| `PATCH /api/account` | `{displayName}` → user; 1–80 trimmed characters, no controls |
| `DELETE /api/account` | `{confirmation:"DELETE"}` → `{deleted:true}`; recent login required |

Account deletion atomically removes identity, grants, every login, financial rows and command
history; queued streams and voice work are revoked before commit. `Access` is revalidated inside
financial transaction boundaries so a racing request cannot restore deleted data. Limits cover
sign-in attempts, invalid cookies, sensitive mutations and voice starts; logs contain event codes,
not tokens, profile details or financial values. Forwarded headers are not trusted. Serve one
worker; configure a trusted proxy explicitly before changing that deployment boundary.

All JSON models forbid extra fields and use lowerCamelCase aliases. The schema is available at
`GET /openapi.json`, or print it without initializing storage:

```sh
uv run --project backend python -c 'import json,sys; sys.path.insert(0,"backend"); from app.main import app; print(json.dumps(app.openapi()))'
```

| Endpoint | Request / response |
| --- | --- |
| `GET /api/settings` | `Settings`: dates, limits, `voiceAvailable` setup readiness and reason; not a live provider health check |
| `POST /api/session` | JSON `{}` → current live `Snapshot`, or a fresh session |
| `GET /api/session` | Current `Snapshot` |
| `GET /api/session/options` | Owner-scoped `AdjustmentOptions`; may refresh the clock-derived assessment as described below |
| `GET /api/session/call` | `CallState`: current owner-scoped call status |
| `POST /api/session/call` | JSON `{}` → `CallJoin`: callId, room url, browser token, expiresAt |
| `DELETE /api/session/call` | Idempotent call teardown → `CallState` |
| `POST /api/session/commands` | `Command` → committed `Snapshot` |
| `GET /api/session/events` | SSE `snapshot` events containing complete `Snapshot` JSON |
| `GET /api/session/export` | `text/plain` attachment using the same stored calculation |
| `GET /api/history` | Owner-scoped conversations; optional `search` matches titles, dates and stored message text |
| `GET /api/history/{slug}` | One chronological human/Isha conversation, with timestamps and partial-caption markers |
| `GET /api/history/{slug}/transcript` | Plain-text captions attachment: timestamp, speaker and exact stored text only |
| `DELETE /api/session` | `{ "deleted": true }`; deletes only the user's financial plan, not their login |
| `GET /health/live`, `GET /health/ready` | `{ "status": "ok" }`; readiness checks local DB/cleanup only |

Financial endpoints and settings require a valid app login. Use `credentials: "same-origin"`
and **`Content-Type: application/json` for POST/PATCH and account DELETE requests**.
No custom CSRF header is required. The browser's `Origin` must equal `PUBLIC_ORIGIN`;
`Host` must match its authority. Mutations require matching Origin or same-origin Fetch Metadata;
cross-site/same-site requests and API query parameters other than History's bounded `search` are rejected. The Google callback is the
narrow exception for cross-site navigation. No wildcard CORS is enabled. Cookies are host-only,
HttpOnly and SameSite Lax; HTTPS uses Secure `__Host-` names. Client-supplied user/session IDs never
authorize access. Never place credentials in application URLs, JavaScript storage or logs.

[app/history.py](app/history.py) stores one chat per call, not per financial revision. Public RTVI
output is saved before forwarding captions; interim speech, generated-but-unspoken text, tools and
financial context are excluded. Interrupted prefixes cannot be extended by late completions. History
uses the financial session's expiry and cascades on plan/account deletion; sign-out revokes access
without deleting retained captions. Limits are in `[history]` in [config.toml](../config.toml). Existing
unsaved calls cannot be recovered. History routes accept bounded lowercase slugs through the same
protected SPA and Google return-path validation as other application routes.

### Command and financial input

`Command = { commandId: UUID, expectedRevision: integer, operation }`.
The discriminated `operation.type` selects one of the operations below. `replaceFacts` submits
the entire facts document; adding/removing/editing records is atomic.
Use a fresh command ID per intentional edit and retain exactly the same command for network retries.

```json
{
  "commandId": "6d07d630-19f0-4bcf-9b47-6ad11907f20c",
  "expectedRevision": 0,
  "operation": {
    "type": "replaceFacts",
    "facts": {
      "opening": { "amount": "12000.00", "status": "exact" },
      "reserve": "0",
      "coverage": { "income": "none", "essential": "reviewed", "debt": "none", "optional": "none" },
      "records": [{
        "id": "rent", "kind": "essential", "label": "Rent",
        "amount": { "amount": "8000", "status": "exact" },
        "schedule": { "date": "2026-09-15", "recurrence": "once" }
      }]
    }
  }
}
```

- `MoneyInput`: `{ amount: decimalRupeeString | null, status: exact | estimate | unknown }`.
  Unknown requires null; other statuses require a value. Nonnegative, ungrouped numeric strings
  with at most two decimals only: no floats, commas, exponent notation, signs, or precision rounding.
- `FactsInput`: required `opening`, `coverage`, `records`; `reserve` defaults explicitly to `"0"`.
  `decision` defaults to `{intent:"plan30Days", concern:null, focusRecordIds:[],
  responsePreference:"standard"}`. Intent also accepts `specificDecision`; preference also accepts
  `brief` and never overrides risk. Focus IDs must exist.
  `providerResponses` stores latest occurrence-scoped reports: `eventId`, `status`
  (`awaiting|declined|reportedTerms`), `reportedOn`, optional `payment`, `paymentDate`, `cost`.
  Money inputs use `MoneyInput`; unknown cost is not zero. Responses never reschedule dues or prove
  approval. Changed obligation dependencies invalidate responses; unchanged refusals/pending
  responses suppress repeated contact questions. Outputs include a server `dependencyKey`.
- `RecordInput`: `id` (1–64 ASCII letters/digits/underscore/hyphen), `kind`
  (`income|essential|optional|debt`), nonempty `label`, `amount`, `schedule`.
  Only income requires `reliability: reliable|uncertain|unknown`; only debt requires
  `debtType: loan|card|informal|unknown`. Unknown reliability is excluded from balances and
  leaves the projection partial. `autoDebit` defaults false.
  Outflow `controllability` is `unknown|controllable|committed` (defaults unknown); income uses null.
  Exact amount and income reliability are independent: only exact reliable dated income is assured.
- `schedule`: required `date: YYYY-MM-DD|null`; `recurrence` is
  `once|weekly|fortnightly|monthly`, default `once`. Date is the next unpaid/future date.
- Debt `amount` is the required/minimum payment. Optional debt-only `target` and `outstanding`
  use `MoneyInput`. Target **replaces**, never adds to, the required amount. Known targets below
  known required amounts are rejected. Outstanding is informational and never reduced by projections.
  If the selected target is unknown, a known required payment is retained and labeled required-only;
  the target stays unknown and the projection stays partial. Zero reported outstanding alongside a
  positive required payment prompts reconciliation and prevents card reductions until corrected.
- Coverage fields are `income`, `essential`, `debt`, `optional`, each one of
  `notDiscussed|reported|reviewed|none|unknown`. Only `reviewed`/`none` completes coverage;
  `none` forbids records, and reviewed empty categories must be explicitly `none`.

### Snapshot, events, and errors

`Snapshot` contains `sessionId`, `revision`, `sequence`, UTC `createdAt`, `asOf`, `expiresAt`,
`anchorDate`, `endDateExclusive`, `currency`, `facts`, `plan`, `preview: Scenario|null`, and
`accepted: Scenario|null`. Both scenario fields default to null. **Facts and plan always describe
the reported baseline**; show `accepted.plan` separately as an assumed projection, not paid debt.
`asOf` is the original financial basis, not the time of the last edit or account verification.
Snapshot money objects are `{ amountPaise: integer|null, status }`; reserve is `reservePaise`.
**Do not post a snapshot directly:** convert paise to decimal strings for editing using integer/string
formatting, never floating-point arithmetic. Unknowns stay null. User-supplied exactness is reported,
not independent verification.

`Plan` contains required `evaluatedOn: YYYY-MM-DD` (the local assessment date), `projectionPartial`,
`reliableIncomePaise`, `uncertainIncomePaise`, `outflowPaise`, `closingPaise`, `troughPaise`,
`firstGap: { date, amountPaise }|null`, `peakGapPaise`, `peakGapDate: date|null`,
`reserveShortfallPaise`, `events`, `issues`, `budgetBasis`, `decisionAssessment`, `incomeComparisons`.
Balance/gap values are null if opening is unknown. Numeric balances with unknown outflows are
requirements remainders, never available-to-spend claims. `budgetBasis.datedProjectionComplete`
and `unresolvedAmounts[{recordId,reason,amount,recurrence}]` expose excluded or incomplete requirements.
Reasons are `missingDate|missingAmount|unknownTarget`; undated recurrences are not summed into a
fabricated period total. Category coverage remains separate from dated projection completeness.

`decisionAssessment` separates `uncertainties`, `constraints`, grouped `consequences`, `choices`,
`actions`, `nextQuestionId`, `nextActionId`, and `outcome`. Uncertainties identify affected records,
field, question, decision changes, blocked scope, material priority/reason and deadline. Diagnostic
`issues` are not a questionnaire. Choices include prerequisites, evaluated metrics, remaining risk
references and `affectsFirstGap`, `affectsPeakGap`, `laterOnly`. Enquiries promise no agreement.
Outcome exposes `branch: fits|uncertain|gap|conflict`, `readiness: ready|qualified`, `trueNow`, risk
and choice references, selected action, uncertain references and revisit conditions. Its compact
`summary`, `covered`, `notCovered`, `nextStep` and `conditions` answer the consumer's decision;
the same selected action drives `spokenBrief`, cards and the opening of the export.
An action's `choiceId` links to evaluated reductions where applicable. Material dependencies
precede actionable relief; late receipts or cuts cannot resolve an earlier deadline. A single
scope question completes broad planning when no more consequential action remains.

`incomeComparisons` has two bounded joint branches when eligible conditional receipts exist:
all arrive on their reported dates, or none arrive by the horizon. Each has `id`,
`conditions[{eventId,arrival:reportedDate|notByHorizon}]`, and flat `ProjectionMetrics`, not nested
plans. Missing dates/amounts never generate invented receipt branches. Baseline, branches and
adjustment impacts use the same reconciliation kernel in [app/finance.py](app/finance.py).

Each event has `id`, `recordId`, `label`, `kind`, `date`, `originalDueDate`, `amountPaise`,
`amountBasis` (`reported|assumed|requiredOnly`), `included`, `overdue`, `autoDebit`, and
`balancePaise`. Issues have `code`, `message`, `recordId|null`.
Timing issues also carry an explicit nullable `date` so later warnings do not displace earlier
decisions. Unknown calendar occurrences and past-income reconciliation qualify the budget basis.
Reliable income alone contributes to assurance. Same-day debits precede receipts. Trough includes
opening; the first gap is the largest deficit on the first affected date, independent of item IDs.
The peak gap is the deepest cumulative deficit, not a sum of negative balances. Reserve is
a floor, not an expense. Unavoidable debits appear once; no manual earmarks are calculated.
`peakGapDate` is the earliest date attaining the positive peak gap, otherwise null.
Same-date competing obligations are grouped; record ID ordering is presentation only, never
a payment ranking. Actions offer supported change previews, targeted clarification, provider
enquiries, follow-up or support—not allocations, lender promises or borrowing.
Zero planned outflows retain their audit rows but do not drive commitment tasks. Overdue guidance
preserves the original deadline. Reserve guidance pairs the first breached date with the largest
shortfall on that date; the headline reserve shortfall remains the largest over the whole horizon.

Every current read calculates the baseline from
reported facts and recalculates both scenarios from their recorded, validated assumptions using
the same engine. Dates, consent and reported facts are not reinterpreted; eligibility is checked
when previewing or accepting, not when viewing an already accepted as-of plan. Read-time
recalculation within the same local date does not write SQLite or advance sequence. The explicit
exception is a change from `plan.evaluatedOn` to the current Asia/Kolkata date: under the store lock,
baseline, preview and accepted assessments refresh together, the latest snapshot is persisted in
one transaction with `sequence + 1`, and existing subscribers receive it. Financial `revision`,
facts, cash basis, anchor, horizon, expiry, preview identity and historical consent stay unchanged.
Repeated reads/reconnects on that date do not advance sequence again. Command results retain their
recorded evaluation dates; replays never rewrite history or restore historical state. Missing or
invalid financial or consent data fails stored-state validation. If the cached evaluation date is
absent, the projection is rebuilt from valid saved facts and assumptions; the current view is
persisted once with a fresh sequence, keeping ownership, financial revision, cash basis and expiry.
Historical command results without this cache date use their fixed anchor and never overwrite the
current session. An explicitly malformed evaluation date is still rejected.

The 30-date interval is `[anchorDate, endDateExclusive)`. One overdue unpaid outflow is carried
at the anchor with its original date; past income is excluded for opening-cash reconciliation.
Recurring overdue schedules require review of other unpaid installments. Missing monthly dates
produce an issue rather than an invented month-end rule. Duplicate IDs fail; equal labels alone
do not merge obligations or trigger repeated questions. Paid/received flags and balance rebasing
are unsupported.

SSE uses `event: snapshot`, `id: sequence`, and one-line `data: <Snapshot JSON>`. Reconnect always
receives current state, regardless of Last-Event-ID; this is not an event-log replay. Each subscriber
holds only the latest pending state. Comments provide heartbeats. Terminal `expired`, `deleted`,
`notFound`, or `unavailable` events contain the error envelope and end the stream. Close EventSource
on terminal events. Apply only snapshots at least as recent as the displayed sequence for that session.
SSE and the voice watcher use configured `heartbeat_seconds` to check clock freshness even without
edits or page requests. A rollover publishes through the same queue, invalidates sequence-keyed
reviews, and interrupts obsolete voice advice; duplicate queued SSE snapshots are suppressed.

Errors are `{ code, message, snapshot? }` (snapshot may be null). `409 staleRevision` includes the
**current complete** snapshot; preserve the editor draft for manual reconciliation. Idempotency is
checked first: a committed command replay returns its original persisted result even after later edits,
but never rewrites state or publishes that historical result. Different content under the same command
ID gives `409 commandConflict`. `410 expired` is returned when distinguishable; after cleanup it is `404`.
`413` is the byte cap, `415` the JSON content-type requirement, `422` invalid facts/fields, `429` a session,
command, or stream cap, and `503` storage/readiness unavailable. Export before deliberately deleting
a session; starting again establishes a new cookie and anchor.

### Occurrence-level planning assumptions

`AdjustmentOptions = { revision: integer, today: date, options: AdjustmentOption[] }`.
`AdjustmentOption = { eventId: string, recordId: string, label: string,
kind: "optional"|"card", date: date, originalPaise: integer, minimumPaise: integer,
acceptanceReady: boolean, dependencyKey: string }`.
Options are calculated under the store lock from the **reported baseline**, never from the
accepted or preview plan. `today` uses the actual Asia/Kolkata clock, not the frozen cash basis.

Eligible occurrences are included, positive, exact, non-overdue, non-auto-debit, within the
anchored horizon and on/after today. Optional occurrences permit reduction to zero only when
the user explicitly affirms they are controllable/uncommitted. Cards require a one-time schedule,
an exact selected target above an exact required/minimum payment, and explicit confirmation that
the minimum was checked and the payment can be changed. Recurring cards, other debts, essentials,
income, estimated/unknown amounts and missing dates are not adjustable. Each recurring optional
occurrence has its own event ID; selecting one never changes the others.

`AdjustmentInput = { eventId: string, amount: Rupees }` is a proposal, not consent.
Unknown controllability permits a hypothesis but not acceptance. Committed items are not options.
Money uses the same decimal-string and configured paise limits as facts.
The amount must be at least the server minimum and strictly below the original. Empty selections,
duplicate IDs and no-ops fail; selection count is bounded by configured `max_occurrences`.
Clients cannot submit minimums, original amounts, labels or dates.

`Adjustment = AdjustmentOption & { amountPaise: integer, acceptedRevision: integer|null }`.
`Scenario = { id: UUID, sourceRevision: integer, createdAt: datetime,
adjustments: Adjustment[], plan: Plan, reducedOutflowPaise: integer,
removedAssumptionIds: string[] }`.
Previews are complete proposed assumption sets; initialize selection from retained accepted cuts
and show `removedAssumptionIds` before confirmation. Acceptance requires strict `confirmed:true` and
`consentScope:"unconditional"`; conditional language cannot authorize it. Acceptance revalidates
every selection and current revision/date. A fresh past-date cut cannot be accepted; an unchanged
already accepted occurrence retains its original consent. Corrections clear previews and revalidate
consent per occurrence/date/amount/minimum/controllability/auto-debit/debt conflict. Unaffected cuts
survive cash or salary corrections. `Snapshot.invalidatedAssumptions[{eventId,reason}]` explains
invalidations. Date/amount-only voice corrections preserve coverage; membership changes reset it.
Qualification, missing facts, reserve shortfalls and early cash gaps are retained as applicable.
Card minimums are not payoff; interest and fees may still apply, without invented cost estimates.

| Operation | State transition | Revision / sequence |
| --- | --- | --- |
| `{ type: "replaceFacts", facts: FactsInput }` | Replace baseline; clear preview; retain valid consent | +1 / +1 |
| `{ type: "previewAdjustments", adjustments: AdjustmentInput[] }` | Replace preview; preserve accepted | unchanged / +1 |
| `{ type: "acceptPreview", previewId: UUID, confirmed: true, consentScope: "unconditional" }` | Accept exact current preview; replace accepted; clear preview | +1 / +1 |
| `{ type: "discardPreview", previewId: UUID }` | Clear matching preview only | unchanged / +1 |
| `{ type: "clearAccepted" }` | Clear accepted and preview; reject if nothing accepted | +1 / +1 |

`revision` is the financial revision; there is no separate `financialRevision` property. Every
new operation checks `expectedRevision`. Acceptance also checks `sourceRevision`, current preview
ID and the local date. Replacement scenarios never stack: reductions always refer to the baseline.
Acceptance never alters reported cash, income, dates, targets, required/minimum or outstanding debt.
Each successful operation commits snapshot and idempotency outcome atomically, then publishes a
full SSE snapshot. Retries are checked before revision/preconditions and never publish old state.

Additional errors: `422 invalidAdjustments`, `409 stalePreview` (wrong/replaced/expired occurrence
or source revision), and `409 noAccepted`. These include the current snapshot. Invalid field types
or false/missing confirmation use the existing `422 validationError` envelope. All owner, origin,
request, command, stream, retention and storage safeguards also cover these operations.

Export ignores preview entirely. With acceptance, it includes the accepted plan, dated
**planning assumptions** with original → assumed amounts, **reduced planned outflow**, and reported
baseline versus accepted first/peak gaps, reserve shortfalls and closing cash. All reported record
amount/date details remain included, including out-of-horizon records. Clearing acceptance exports
the reported baseline only. No payment execution, allocation or reduction of outstanding is implied.
