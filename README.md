<!-- SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# 30-day voice financial planner

A conversation-first prototype using **Daily, Pipecat, GPT-5.6 and Microsoft Foundry Speech**.
The conversation role captures partial facts and corrections through validated application tools;
`review_plan` reads the deterministic decision assessment. INR state, calculations and live cards
share the same committed facts.
The [financial workspace](docs/financialWorkspace.md) defines progressive templates, validated
corrections/conflicts/decisions, calculation evidence and Isha's authority boundary.
Google sign-in establishes secure user ownership. **Money** organizes the saved financial picture,
upcoming requirements and focused corrections between conversations. No runtime mocks, bank connections,
payment execution or fabricated conversations are included.

**Live voice requires provider credentials and the matching Azure Speech resource region.** The repository contains
no keys. The selected Azure deployment, streamed HD synthesis and continuous recognition have
passed real component checks. An authorized Daily audio-only recheck passed actual joins and
bidirectional audio with clean teardown; the earlier payment-method blocker did not recur.
The real browser/Daily/Pipecat/Azure path also passed spoken cash capture, correction and cleanup
with synthetic microphone speech and a test-only Google identity. Eleven real-model text turns
covered broader financial ambiguity. Human conversational acceptance remains outstanding; see
the [recovery suite and verification boundaries](docs/releaseChecks.md).
See the [deployment report and recognition limitations](docs/azureSetup.md).

## Run locally

Requires Docker Engine/Desktop with Compose v2+ and internet access for the first build.
No host Python/Node installation is needed. Copy [.env.example](.env.example) to `.env` at the
repository root and configure the three Google sign-in values below. Configure the Azure OpenAI
endpoint and key, Speech key/region, and Daily key only if using voice. Select the verified Azure
deployment with `voice.model` in [config.toml](config.toml).
The current setting uses the existing `gpt-5.6-luna` deployment; the former Terra deployment is
no longer available in the configured resource.
Do not paste keys into chat or commit them. Read the
[Azure setup values and private credential instructions](docs/azureSetup.md). The configured model
calls Azure, never direct OpenAI; the existing `caracalaus` deployment and the Central India
`financeVoiceIndia` Speech resource are ready for use.
Azure Speech is the selected implementation;
there is no separate authorization flag or automatic provider fallback. Without Google settings,
the service starts but sign-in is unavailable; there is no anonymous access to financial data.
Without voice credentials, authenticated manual planning still works.

```sh
docker compose up --build
```

Open **http://localhost:8000** once the application is ready. Use `localhost`, not
`127.0.0.1`, in the browser: API Host/Origin checks match the configured address.
Compose stays attached; no second frontend or backend startup command is needed.

### Google sign-in setup

1. In [Google Auth Platform](https://console.cloud.google.com/auth/overview), configure the app's
	branding and audience. While the OAuth app is in testing, add the intended Google test users.
2. Create an OAuth client of type **Web application**. Register the exact authorized redirect URI
	**http://localhost:8000/auth/callback**. For another deployment, register
	`PUBLIC_ORIGIN` followed by `/auth/callback`, with no trailing slash. Use HTTPS outside local
	development. The server-code flow does not need a frontend client secret or JavaScript SDK.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from that client. Generate a Fernet key
	locally for `AUTH_ENCRYPTION_KEY`, for example with
	`uv run --project backend python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.
	Copy its 44-character URL-safe Base64 output, including the final `=`, privately into the
	environment file—not a 64-character hexadecimal string. Keep this key stable across restarts;
	replacing it makes existing encrypted Google grants unreadable.
4. Start the application and choose **Continue with Google**. Only `openid profile email` are
	requested. Sign-in does not start a microphone, a financial plan, or a paid voice call.

Routes include `/login`, `/app`, `/app/<conversation-slug>`, `/money`, `/account`, `/history`
and `/history/<conversation-slug>`.
Money has shallow `/money/income`, `/money/spending`, `/money/debts`, `/money/upcoming`, and
`/money/changes` pages. Authenticated deep links retain their destination through sign-in.
The backend protects application pages
and every financial API, including exports and live updates. `/account` supports an app display
name, read-only Google identity, logout, and deliberate account deletion.

| Environment | Default | Requirement |
| --- | --- | --- |
| `APP_ENV` | `local` | Optional; `staging` requires an HTTPS public origin and an external TLS edge |
| `PUBLIC_ORIGIN` | `http://localhost:8000` | Optional exact trusted origin, without path/trailing slash |
| `DATA_DIR` | `/data` in Compose | Injected by Compose; private named volume. Direct Python defaults to repository-local storage |
| `GOOGLE_CLIENT_ID` | empty | Required for sign-in: Google Web application OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | empty | Required secret: that OAuth client's secret; backend only |
| `AUTH_ENCRYPTION_KEY` | empty | Required secret: stable Fernet key encrypting stored Google grants |
| `AZURE_OPENAI_API_KEY` | empty | Voice-only secret: Azure resource key for the assistant LLM |
| `AZURE_OPENAI_ENDPOINT` | empty | Required Azure HTTPS resource endpoint; root or `/openai/v1/`, normalized to v1 |
| `DAILY_API_KEY` | empty | Required for voice: private rooms and scoped expiring participant tokens |
| `AZURE_SPEECH_KEY` | empty | Required for voice: Microsoft Foundry Speech recognition and synthesis |
| `AZURE_SPEECH_REGION` | empty | Required matching Speech resource region, for example `centralindia`; no resource is provisioned automatically |

Non-secret behavior and limits belong in [config.toml](config.toml), not environment
variables. The image runs one non-root Python process, serving built React and owning SQLite.
Do not scale instances/workers against the same database or expose this local build publicly.

Azure OpenAI v1 needs no dated inference API-version variable. Change the endpoint environment
value and `voice.model` to use another approved, compatible Azure deployment; changing an alias
does not prove the underlying model supports the required tools or parameters. Arbitrary hosts,
direct OpenAI URLs and dated deployment API paths are rejected. Azure credits do not pay Daily
charges; confirm the Daily account's free allowance or separately approved billing before a call.

The [voice implementation plan](docs/voicePlan.md) sets the initial production-oriented prototype
choices: Terra with `none` reasoning effort, continuous `en-IN` recognition with financial phrase
hints, and `en-IN-Aarti:DragonHDLatestNeural` female TTS. The resource voice list is checked before
room creation. Short sentences use streamed audio output and HD-safe SSML, without artificial
pitch/rate/emotion settings. These choices need real latency, pronunciation, interruption and
consumer evaluation. Synthetic audio checks exposed some paise/date recognition errors; they are
not a quality guarantee. Keep unknown or ambiguous financial facts explicit rather than guessing.

### Conversation settings and flow

The `[voice]` section of [config.toml](config.toml) owns the assistant name (default **Isha**),
introduction, language, tone, Azure model/deployment, reply limits, voice/locale, VAD thresholds,
turn silence, inactivity, request/tool budgets and call timeouts. Introduction templates support
only `{assistant_name}` and `{horizon_days}`. Keep keys, resource endpoints and regions in the
environment. Restart the backend after configuration changes; there is no hidden model fallback.

Isha uses the configured opening guidance for one short introduction and open invitation, then
waits for the user to explain freely. The opening model request cannot call financial tools;
there is no opening-cash questionnaire. User-first speech or an
interruption takes precedence; reconnecting does not repeat the introduction. Completed turns
are processed together: save all clear facts, recalculate, then ask the selected decision-changing
question or explain the next step. Speech from a tool-bearing response is not published before
the tool finishes. The default 2.6-second turn pause lets short thinking pauses remain one turn;
the separate 60-second inactivity threshold waits for explicit continuation.

The bounded financial framework covers usable money, usable income dates/reliability, essential
needs, required payments, timing gaps, relevant spending choices and unresolved conflicts. It is
not a required field sequence. A positive purchase answer needs material living costs and payment
needs checked; a known shortfall can receive help before the entire plan is complete. Unknowns
stay unknown, estimates remain qualified, and explicitly unavailable answers are recorded with
the supplied facts so they are not repeatedly requested. Opening guidance is removed after the
first user turn; the spoken greeting remains in history without repeatedly instructing an introduction.

`voice.history_turns` bounds recent dialogue sent to the model (40 user turns by default).
Completed turns do not resend their tool snapshots: the latest authoritative financial state and
the current turn's tool results remain available. This avoids accumulating a full ledger per turn
without deleting saved facts, corrections or accepted assumptions.

Isha receives the current account display name and a small separate conversational memory.
`[memory]` limits notes to eight per scope and 240 characters each: common preferences last until
forgotten, explicitly retained user context expires after 30 days, and chat notes expire with their
chat. Ask Isha to remember or forget a preference; no transcript dump or second financial ledger is
created. See [memory boundaries](backend/README.md#conversational-memory).

Only one voice call runs at a time. **Start conversation** opens preparation; **Start talking**
requests microphone access before a room is created. Rooms and participant tokens permit audio
only and grant no recording, transcription or participant-administration privileges. The app never
requests the camera. Listening/speaking states and captions come from actual
SDK events. End conversation stops local audio and releases the server call; refresh does not
restart the microphone. If playback is blocked, use **Resume audio**.

Verify a real call by speaking cash, income and a commitment in one response, leaving one date
unknown. Confirm the assistant asks a useful follow-up, that cards reflect saved facts, and that
a spoken amount/date correction changes both the card and explanation. Finish with a qualified
financial conclusion, then end the call and verify the microphone is off. Until that exercise
passes with real providers, the live journey is unverified—not a completed product demonstration.

## Use and privacy

Start a conversation and supply facts naturally, or open **Money** to inspect the saved plan,
correct an item, or explicitly start a blank plan. Its overview prioritizes the earliest funding gap;
focused income, spending, debt, upcoming and change views use the same saved state and live updates.
Starting cash belongs to the original plan date, not today's bank balance. Include only unpaid/future items at the displayed cash basis.
Amounts, dates, income reliability and debt type may remain unknown. A positive
closing balance can coexist with an earlier cash gap. Same-day debits precede receipts
conservatively; verify timing before relying on them. Debt targets include the required/minimum
payment rather than adding to it. A projection never reduces the reported outstanding debt.

Conversation and Money show one current next step with its financial consequence. Closing forecasts
name excluded items and amounts beside the number. Same-day timing exposure is distinct from money
still unfunded after that day's included receipts; timing advice never establishes bank processing order.
Money offers **Download saved plan** beside its expiry notice. The default 24-hour retention is not
30 days of online availability; saved conversational preferences do not preserve an expired plan.

For foreign income, edit **Amount** to enter the original currency amount, INR-per-unit rate,
rate certainty/date and INR deduction. The backend calculates net INR; unknown rates or fees
remain unknown, and estimated conversion terms stay conditional. There is no live rate lookup.
In **Repeats**, set daily/weekly/fortnightly/monthly cadence, inclusive end date or occurrence count.
Choose **Varies by occurrence** under Amount for an ordered finite amount sequence without entering
every date. For essential or optional spending, **Monthly budget** spreads the stated calendar-month
budget evenly across actual month days as an explicit estimated forecast, not a scheduled bill.
Budget and variable occurrences are not eligible for Plan changes proposals.

Use **Plan changes** to compare individual eligible occurrences and confirm that
each can still be changed. Optional expenses must be uncommitted and controllable without
cutting essentials. One-time card targets cannot go below the reported exact minimum;
interest and fees may still apply. Essentials, other debts, automatic debits, past dates,
and unknown/estimated amounts cannot be reduced here. A known required payment remains
in the partial projection when its higher selected target is unknown.

Preview compares the active plan with proposed assumptions; closing cash, peak gaps and reserve
remain available in calculation details. A later reduction cannot fix an earlier shortage. Accept only
after reviewing the exact preview; acceptance saves **planning assumptions**, not payments or
account changes. Replacement assumptions do not stack. Rejecting a preview keeps saved figures;
clearing saved assumptions restores the reported baseline. The engine selects a consequential
set of question candidates, a useful spending-change preview, or a deadline-specific provider action.
Isha chooses the useful question and phrases it naturally. Conditional
income comparisons show what depends on receipts arriving; they never promise payment or approval.
The outcome and download explain covered requirements, exposed commitments, next actions and
revisit conditions. Dated remainders are not permission to spend.

Proposals can be reviewed, accepted or rejected beside the conversation, without opening the
manual editor. Consent applies to the exact whole proposal, including removals, and resets if
the proposal, saved revision or connection freshness changes. **Reject preview** records refusal
of that whole proposal; **Close preview** only ends exploration without recording refusal.
**I cannot confirm this now** keeps the detail unknown
and moves to another useful step; **Do not suggest this cut** records that specific refusal
without changing spending or confirming it is committed. Conflicting proposals produce visible
guidance; no failed response is silently treated as saved.

An intended card-payment target and its required minimum remain distinct after a declined cut.
A target shortfall is not described as an unfunded minimum when the modeled minimum fits.

The cash basis and 30-date window stay fixed. Edits correct that original picture; start a
fresh projection for a current cash balance. Unsaved drafts stay only in the open page.
Cross-tab edits require explicit reconciliation. Saving any fact correction clears previews
and revalidates accepted assumptions individually. Unaffected choices remain saved; changed
occurrences require fresh consent. Correcting an amount or date does not restart category review.
Download/print uses accepted assumptions when present, otherwise reported facts; previews and
unsaved edits are excluded.

Sessions expire 24 hours after creation by default and survive ordinary container restart.
The port-8000 Compose instance retains sessions in its volume. Rebuilding the image does not erase
them: missing projection-cache metadata is recovered from saved facts. A genuinely unreadable
saved session is reported separately from a connection failure and is never silently deleted.
Ownership uses an internal user ID derived from the verified Google subject, never an email or
browser-supplied plan ID. Anonymous figures from earlier versions are not silently claimed by
the next Google login. They remain inaccessible to authenticated users and expire normally.

Sign-in cookies are HttpOnly, persistent and Secure on HTTPS. Logins last at most seven days,
with 24-hour inactivity expiry; visible use refreshes the idle period, not the absolute limit.
Google credentials are rechecked at most five minutes apart on access. A revoked grant or invalid
credential requires sign-in; temporary provider failures block access until retry succeeds.
Google sign-out is separate from app sign-out and is not an immediate revocation notification.
Google may omit or expire refresh tokens, including for testing-mode OAuth apps; sign in again
when requested. Financial retention remains 24 hours, independently of login lifetime.

**Sign out** ends the current browser login and its voice connection without deleting the plan.
Other tabs detect logout through a browser signal and server revalidation; independent browser
logins remain valid. **Delete app account** requires typing `DELETE` and a sign-in within the last
15 minutes. It removes the user, Google grants, all app logins, conversational memories, figures,
assumptions and command history, and stops active voice/access. It does not delete the Google
account or downloaded files. Deleting only the plan removes chat notes, not shared preferences.
The app attempts Google grant revocation after local deletion; external-provider retention rules
remain outside this application's control. SQLite deletion is not a forensic-erasure guarantee.
Audio travels through Daily and Azure Speech
during a call; relevant profile/memory, conversation and financial context are sent to the configured
Azure OpenAI resource.
Global Standard model processing is not restricted to the resource's region. This application does not
record audio. **History** saves each call separately with its final human captions and emitted Isha
responses. Search by title, date or stored words, open a conversation, and use **Download captions**
for timestamped speaker-labelled text. Captions survive reload and sign-out until the financial plan
expires; deleting the plan or account deletes its conversations. Unspoken responses, tools, internal
financial state and earlier unsaved calls are not reconstructed into history. Provider retention policies
still apply. Use synthetic data for testing; there is no backup/HA guarantee.

Stop with Ctrl+C, then optionally `docker compose down` (keeps retained sessions).
Shutdown gives active HTTP requests up to 10 seconds, then bounds pipeline and room cleanup
separately within the container's 40-second stop grace period. Reload recovers saved figures,
not a terminated media call. Reconnect or History's **Continue talking** starts fresh media for
the same saved chat, restoring only its financial memory and recent dialogue. Reload alone never
opens the microphone. Older transcripts without an attributable financial snapshot remain readable
but cannot safely be continued; another chat's figures are never substituted.
`docker compose down --volumes` deliberately deletes **all local session storage**.

## Development and validation

Use Node 24.12+ and Python 3.12–3.14 with uv; the container pins Python 3.13.

```sh
uv sync --project backend --locked
npm --prefix frontend ci
uv run --project backend ruff check backend
uv run --project backend ruff format --check backend/app backend/tests
uv run --project backend mypy --config-file backend/pyproject.toml backend/app
uv run --project backend pytest backend/tests --cov=app --cov-report=xml:backend/coverage.xml
npm --prefix frontend run contracts:check
npm --prefix frontend run check
npm --prefix frontend run test:unit
npm --prefix frontend run build
```

Browser checks start a temporary real backend on a free port with synthetic finances and a
test-only Google provider. The callback, signature verification, authentication database and
financial APIs are real; Google HTTP responses and voice transport are isolated. No production
test-login endpoint or authentication bypass is included in the image.

```sh
npm --prefix frontend exec -- playwright install chromium
npm --prefix frontend run test:e2e
```

Build the frontend first. The runner removes only its own temporary storage and does not use
the running port-8000 application or its retained volume.

Browser tests delete only their own sessions. Component mocks do not prove real API/voice
integration. CI verifies the production container rejects anonymous access, runs authenticated
browser journeys against the isolated Google test provider, and uploads coverage
through Codecov OIDC for trusted runs; enable the repository in Codecov before expecting
remote uploads to succeed. Provider doubles in isolated tests verify lifecycle and tool contracts,
not a real financial conversation. Keep provider credentials out of pull-request CI; run the live
call check above in the configured local environment.

See [backend/README.md](backend/README.md) for financial/API semantics and
[frontend/README.md](frontend/README.md) for contract generation and UI development.
Source licensing: [LICENSE.md](LICENSE.md).
