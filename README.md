<!-- SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# 30-day voice financial planner

An English-language voice assistant (Isha) for planning the next 30 days of cash flow in INR.
React/TypeScript provides the UI; FastAPI/Python and SQLite own financial state and calculations.
Voice uses Pipecat, Daily, Azure-hosted GPT-5.6 and Microsoft Foundry Speech.

## Key functionality

- Capture income, expenses, loans and card payments by voice; clarify missing information and corrections.
- Recalculate cash-flow gaps and synchronized editable cards from one authoritative financial state.
- Model recurring schedules, reported monthly patterns, estimated budgets and foreign-income conversions.
- Preview eligible spending changes with explicit consent; review, print and download the plan in **Money**.
- Google sign-in, searchable conversation history, same-chat continuation and scoped conversational memory.

## Prerequisites

- Docker Engine/Desktop with Compose v2+ and internet access. Host Python/Node are not needed to run the app.
- A Google OAuth Web application client for sign-in.
- For voice: an Azure OpenAI deployment, a Speech resource with its matching region, a Daily account,
	and a browser with microphone access. Daily usage is billed separately from Azure.
- For local development/tests: Python 3.12–3.14, uv and Node.js 24.12+.

## Environment setup

Copy [.env.example](.env.example) to [.env](.env) at the repository root and fill in the required values.
Keep credentials private and out of Git.

| Variable | Required for | Purpose / default |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Sign-in | Google OAuth Web application client ID |
| `GOOGLE_CLIENT_SECRET` | Sign-in | The same client's secret |
| `AUTH_ENCRYPTION_KEY` | Sign-in | Stable Fernet key for stored Google credentials |
| `AZURE_OPENAI_API_KEY` | Voice | Azure resource key, not a direct OpenAI key |
| `AZURE_OPENAI_ENDPOINT` | Voice | Azure resource base URL, such as `https://<resource>.openai.azure.com/openai/v1/` |
| `AZURE_SPEECH_KEY` | Voice | Speech recognition and synthesis key |
| `AZURE_SPEECH_REGION` | Voice | Matching Speech resource region, such as `centralindia` |
| `DAILY_API_KEY` | Voice | Private rooms and participant tokens |
| `APP_ENV` | Optional | `local` by default; `staging` requires HTTPS and an external TLS endpoint |
| `PUBLIC_ORIGIN` | Optional | `http://localhost:8000`; exact origin without a path or trailing slash |
| `DATA_DIR` | Native run override | Private writable storage; Compose supplies its persistent data volume |

### Google and encryption key

1. In [Google Auth Platform](https://console.cloud.google.com/auth/overview), configure the audience
	 and add test users if the OAuth app is in testing mode.
2. Create a **Web application** client with redirect URI **http://localhost:8000/auth/callback**.
	 For another origin, use `PUBLIC_ORIGIN` followed by `/auth/callback`.
3. Generate `AUTH_ENCRYPTION_KEY` locally and copy it into the environment file:

	 ```sh
	 docker compose run --build --rm --no-deps app python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
	 ```

	 Keep all 44 URL-safe Base64 characters, including the final `=`; do not use a hexadecimal key.
	 **Keep the key unchanged across restarts** or existing stored Google credentials become unreadable.

### Voice configuration

Use the Azure base endpoint, not an operation URL ending in `/responses` or `/chat/completions`.
Select an existing compatible deployment through `voice.model` in [config.toml](config.toml)
(currently `gpt-5.6-luna`). The same file owns assistant identity, speech settings and runtime limits.
No provider resources are created automatically and there is no model fallback.
See [Azure setup](docs/azureSetup.md) for resource and credential details.

Without Google settings, sign-in is unavailable. Without voice credentials, authenticated manual
planning still works. Rebuild/restart after changing configuration or environment values.

## Run locally

From the repository root:

```sh
docker compose up --build
```

Open **http://localhost:8000**. Use `localhost`, not `127.0.0.1`, to match API origin checks.
Compose starts the frontend and backend together.

Sign in → **Start conversation** → **Start talking**. The microphone starts only on request.
**End conversation** releases media; **Continue** or **Reconnect** requires an explicit action.
Reloading restores saved state, not an active microphone. Use **Resume audio** if playback is blocked.

Stop with Ctrl+C or `docker compose down`; the data volume is retained.
**`docker compose down --volumes` deletes all local application storage.**

## Development and validation

Run from the repository root:

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

After building the frontend, run browser checks:

```sh
npm --prefix frontend exec -- playwright install chromium
npm --prefix frontend run test:e2e
```

Browser tests use temporary storage, synthetic Google identity and voice-provider doubles; they
do not modify the running app's data or prove live speech quality. Opt-in [live checks](docs/releaseChecks.md)
use real providers and incur usage. Keep provider credentials out of pull-request CI.
[CI](.github/workflows/ci.yaml) runs checks and reports coverage; enable the repository in Codecov for uploads.

## Important limitations and data handling

- **Prototype scope:** one active voice call and one backend worker/instance per database.
	Do not expose the local build publicly; there is no backup or high-availability guarantee.
- **Financial authority:** calculations use reported facts, not bank access. Starting cash belongs
	to the original plan date; only unpaid/future items should be added. Same-day payments precede
	receipts conservatively. A positive closing balance can hide an earlier gap and is not a spending allowance.
- **Assumptions:** unknown amounts/dates are not zero; uncertain income is not assured funds.
	Pattern dates and undated-payment comparisons stay qualified. Foreign exchange rates are user-supplied.
	Accepted changes are planning assumptions, not payments, cancellations or lender approvals.
- **Voice:** recognition can mishear amounts/dates, and response latency varies. Verify important values
	against the cards. Provider-double tests do not replace human-microphone acceptance testing.
- **Retention:** plans and captions expire 24 hours after plan creation by default, even though the
	projection covers 30 days. Download before expiry. Rebuilds retain unexpired data in the volume.
- **Memory:** common preferences remain until forgotten/account deletion; user context expires after
	30 days; chat notes follow their chat's expiry. Ask the assistant to forget a saved note.
- **Privacy/deletion:** Daily and Azure process audio and relevant context; the app stores captions,
	not audio recordings. Provider retention policies still apply. Sign-out retains saved data.
	Deleting a plan removes its chats/chat notes; account deletion requires recent sign-in and removes
	all local account data, not the Google account or downloaded files. Signing in after account deletion
	creates an empty account.

## Further documentation

- [Backend and API](backend/README.md) · [Frontend development](frontend/README.md)
- [Financial rules](docs/financialWorkspace.md) · [Voice checks and known limits](docs/releaseChecks.md)
- License: [AGPL-3.0-only](LICENSE.md)
