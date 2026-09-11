<!-- SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# 30-day voice financial planner

A conversation-first prototype using **Daily, Pipecat, GPT-5.6-Terra and Microsoft Foundry Speech**.
The conversation role captures partial facts and corrections through validated application tools;
`review_plan` reads the deterministic decision assessment. INR state, calculations and live cards
share the same committed facts.
The manual planner remains under **Your figures**. No runtime mocks, bank connections,
payment execution or fabricated conversations are included.

**Live voice requires provider credentials and the matching Azure Speech resource region.** The repository contains
no keys. The selected Azure deployment, streamed HD synthesis and continuous recognition have
passed real component checks. An authorized Daily audio-only recheck passed actual joins and
bidirectional audio with clean teardown; the earlier payment-method blocker did not recur.
The complete Daily browser financial conversation remains unverified.
See the [deployment report and recognition limitations](docs/azureSetup.md).

## Run locally

Requires Docker Engine/Desktop with Compose v2+ and internet access for the first build.
No host Python/Node installation is needed. Copy [.env.example](.env.example) to `.env` at the
repository root and fill in the Azure OpenAI endpoint, deployment and key, Speech key/region,
and Daily key privately. Do not paste keys into chat or commit them. Read the
[Azure setup values and private credential instructions](docs/azureSetup.md). The configured model
calls Azure, never direct OpenAI; the existing `caracalaus` deployment and the Central India
`financeVoiceIndia` Speech resource are ready for use.
Azure Speech is the selected implementation;
there is no separate authorization flag or automatic provider fallback. Without credentials,
the manual inspection path still works but voice cannot start.

```sh
docker compose up --build
```

Open **http://localhost:8000** once the application is ready. Use `localhost`, not
`127.0.0.1`, in the browser: API Host/Origin checks match the configured address.
Compose stays attached; no second frontend or backend startup command is needed.

| Environment | Default | Requirement |
| --- | --- | --- |
| `APP_ENV` | `local` | Optional; `staging` requires an HTTPS public origin and an external TLS edge |
| `PUBLIC_ORIGIN` | `http://localhost:8000` | Optional exact trusted origin, without path/trailing slash |
| `DATA_DIR` | `/data` in Compose | Injected by Compose; private named volume. Direct Python defaults to repository-local storage |
| `AZURE_OPENAI_API_KEY` | empty | Voice-only secret: Azure resource key for the assistant LLM |
| `AZURE_OPENAI_ENDPOINT` | empty | Required Azure HTTPS resource endpoint; root or `/openai/v1/`, normalized to v1 |
| `AZURE_OPENAI_DEPLOYMENT` | empty | Voice-only deployment name, distinct from the underlying model ID |
| `DAILY_API_KEY` | empty | Required for voice: private rooms and scoped expiring participant tokens |
| `AZURE_SPEECH_KEY` | empty | Required for voice: Microsoft Foundry Speech recognition and synthesis |
| `AZURE_SPEECH_REGION` | empty | Required matching Speech resource region, for example `centralindia`; no resource is provisioned automatically |

Non-secret behavior and limits belong in [config.toml](config.toml), not environment
variables. The image runs one non-root Python process, serving built React and owning SQLite.
Do not scale instances/workers against the same database or expose this local build publicly.

Azure OpenAI v1 needs no dated inference API-version variable. Change the endpoint/deployment
to use another approved, compatible Azure deployment without changing code; changing an alias
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

Only one voice call runs at a time. **Start conversation** opens preparation; **Connect microphone**
requests microphone access before a room is created. Rooms and participant tokens permit audio
only and grant no recording, transcription or participant-administration privileges. The app never
requests the camera. Listening/speaking states and captions come from actual
SDK events. End conversation stops local audio and releases the server call; refresh does not
restart the microphone. If playback is blocked, use **Resume assistant audio**.

Verify a real call by speaking cash, income and a commitment in one response, leaving one date
unknown. Confirm the assistant asks a useful follow-up, that cards reflect saved facts, and that
a spoken amount/date correction changes both the card and explanation. Finish with a qualified
financial conclusion, then end the call and verify the microphone is off. Until that exercise
passes with real providers, the live journey is unverified—not a completed product demonstration.

## Use and privacy

Start a conversation and supply facts naturally, or use **Your figures** to create a
projection and enter them manually. Include only unpaid/future items at the displayed cash basis.
Amounts, dates, income reliability and debt type may remain unknown. A positive
closing balance can coexist with an earlier cash gap. Same-day debits precede receipts
conservatively; verify timing before relying on them. Debt targets include the required/minimum
payment rather than adding to it. A projection never reduces the reported outstanding debt.

Use **Compare a spending change** to select individual eligible occurrences and confirm that
each can still be changed. Optional expenses must be uncommitted and controllable without
cutting essentials. One-time card targets cannot go below the reported exact minimum;
interest and fees may still apply. Essentials, other debts, automatic debits, past dates,
and unknown/estimated amounts cannot be reduced here. A known required payment remains
in the partial projection when its higher selected target is unknown.

Preview shows the reported baseline beside the proposed assumptions, including closing cash,
first/peak gaps and the reserve. A later reduction cannot fix an earlier shortage. Accept only
after reviewing the exact preview; acceptance saves **planning assumptions**, not payments or
account changes. Replacement assumptions do not stack. Rejecting a preview keeps saved figures;
clearing saved assumptions restores the reported baseline. The engine selects a consequential
question, a useful spending-change preview, or a deadline-specific provider action. Conditional
income comparisons show what depends on receipts arriving; they never promise payment or approval.
The outcome and download explain covered requirements, exposed commitments, next actions and
revisit conditions. Dated remainders are not permission to spend.

Proposals can be reviewed, accepted or rejected beside the conversation, without opening the
manual editor. Consent applies to the exact whole proposal, including removals, and resets if
the proposal, saved revision or connection freshness changes. A rejected preview does not mean
you declined the underlying suggestion. **I cannot confirm this now** keeps the detail unknown
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
Ownership uses an HttpOnly cookie, not account login. Deletion and expiry remove application
rows, not forensic copies or files already downloaded. Audio travels through Daily and Azure Speech
during a call; conversation and financial context are sent to the configured Azure OpenAI resource.
Global Standard model processing is not restricted to the resource's region. This application does not
record audio or persist transcripts. Captions remain in the page only; provider retention policies
still apply. Use synthetic data for testing; there is no backup/HA guarantee.

Stop with Ctrl+C, then optionally `docker compose down` (keeps retained sessions).
Shutdown gives active HTTP requests up to 10 seconds, then bounds pipeline and room cleanup
separately within the container's 40-second stop grace period. Reload recovers saved figures,
not a terminated voice call.
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

Browser checks use the real application at localhost:8000 with synthetic finances. Start
Compose with an isolated project name (for example `docker compose -p finance-check up --build`)
before running them; stop any other process using port 8000 first.

```sh
npm --prefix frontend exec -- playwright install chromium
npm --prefix frontend run test:e2e
```

Alternatively, after building the frontend, `node frontend/scripts/e2e.mjs` runs the same suite
against a temporary real backend on a free local port and removes only its own test storage.

Browser tests delete only their own sessions. Component mocks do not prove real API/voice
integration. CI runs checks and actual container-backed browser journeys, and uploads coverage
through Codecov OIDC for trusted runs; enable the repository in Codecov before expecting
remote uploads to succeed. Provider doubles in isolated tests verify lifecycle and tool contracts,
not a real financial conversation. Keep provider credentials out of pull-request CI; run the live
call check above in the configured local environment.

See [backend/README.md](backend/README.md) for financial/API semantics and
[frontend/README.md](frontend/README.md) for contract generation and UI development.
Source licensing: [LICENSE.md](LICENSE.md).
