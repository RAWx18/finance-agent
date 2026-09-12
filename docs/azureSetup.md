<!-- SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Azure AI deployment and setup

**Current model, 12 September 2026:** the configured resource lists `gpt-5.6-luna` and
`gpt-5.6-luna-2`; Terra returns deployment-not-found. The app selects the existing primary
`gpt-5.6-luna`, verified with streamed conversational-memory tool calls. No deployment or key was
changed. Terra-specific capacity, pricing and measurements below describe the earlier check, not Luna.

Verified **11 September 2026**, Azure CLI **2.81.0**, public Azure cloud. The existing Terra
deployment was reused unchanged. **One Speech resource was created through Azure CLI** and
live inference, synthesis and recognition passed component checks through the installed SDKs.
Provisioning checks held keys only in process memory; the user subsequently supplied private
runtime configuration. Daily audio-only media subsequently passed a real bidirectional check;
human-voice acceptance and the complete financial conversation remain unverified.

## Configured application check

The user-supplied private configuration was tested from the rebuilt application container on
11 September 2026. The Azure base endpoint was corrected from an operation URL ending in
`/responses` to `https://caracalaus.services.ai.azure.com/openai/v1/`; keys were not changed.

| Check | Observed result |
| --- | --- |
| Azure LLM | Streaming tool calls saved/corrected synthetic cash; Responses structured parsing passed |
| Azure TTS | Aarti HD streamed 30 chunks / 12.55s audio with 37 word boundaries; first audio 0.457s |
| Azure STT | Continuous recognition returned interim/final financial amounts, dates and correction |
| Daily REST | Configured key authenticated; actual private room and scoped tokens were created |
| Initial Daily media join | Blocked by `account-missing-payment-method` at the first configured browser check |
| Daily media recheck | Two actual audio-only participants joined and exchanged non-silent 16-kHz PCM in both directions |

The actual browser attempt used synthetic microphone audio and real providers, not the isolated
provider-double UI tests. It did not reach an active conversation. The test session and room
were removed; a subsequent Daily room GET returned 404. No payment method or paid plan was enabled.

The authorized media recheck on 11 September used the application's private audio-only room and
non-owner token permissions with two native Daily clients. Each received over one second of
non-silent synthetic audio (33,280 and 34,560 PCM bytes). Clients left and were released; deleting
the probe room was verified by GET 404 and the process exited cleanly. No microphone, Azure calls,
authentication/UI changes or billing changes were involved. This clears the earlier media-access
blocker, not the separate real-consumer conversation acceptance gate.

Browser setup uses Daily's no-eval loader to preserve the Content Security Policy, and Pipecat
owns SDK disconnection rather than directly calling Daily's prohibited `destroy()` method.
The [live browser verifier](../frontend/scripts/verifyVoice.mjs) remains opt-in and exits nonzero
on a failed provider join. Its media/correction branch subsequently passed using real Daily/Azure
and synthetic microphone speech with test-only Google identity: cash ₹6,000 → ₹6,500, visible
card update, bidirectional WebRTC audio, stopped capture and deleted test room. See
[release checks](releaseChecks.md) for the repeatable harness and evidence limits.

## Resource inventory

| Resource | Action | Region / purpose |
| --- | --- | --- |
| `caracalaus`, `AIServices` / S0, group `rg-monitoring` | Reused without changing deployment/capacity | Australia East; existing Terra |
| `financeVoiceIndia`, `SpeechServices` / S0, group `rg-monitoring` | Created; `Succeeded`; live STT/TTS verified | Central India; one account for recognition and HD synthesis |
| `caracalaus/caracal`, existing logging/Application Insights, action groups, shutdown automation/runbooks and Network Watcher | Left unchanged | Unrelated existing resources |

No resource group, model duplicate, VM, database, storage account, network, identity, commitment
plan or hosting service was created. [OpenTofu management](../infra/speech/README.md) adopts only
the Speech account; import and the actual **no-change plan** passed. The existing group and Terra
remain outside that state. No OpenTofu apply or key rotation was performed.

## Subscription and credit boundary

- Subscription: **Azure subscription 1**, `e4f89284-8be8-403e-994b-9c49736281c8`, Enabled.
  This was the only visible subscription. Billing APIs linked it to the profile holding the credits;
  the active CLI default was not treated as evidence by itself.
- ARM quota policy: `Sponsored_2016-01-01`. Billing agreement: Microsoft Customer Agreement,
  Microsoft Azure Plan. Startup sponsorship credit originally US$100,000; credit-lot balance
  **US$99,997.97**, expiring **22 May 2028 at 16:19:54 UTC**. The balance is as of invoicing,
  not a real-time spending cap; pending transactions exist and were not subtracted twice.
- Subscription and billing-profile spending limits are **Off**. Existing budget/shutdown automation
  is not a guaranteed hard cap. No protection setting was removed or modified.
- Microsoft's startup policy covers Azure-sold Foundry models and eligible standard Azure
  consumption while credit remains valid. Terra's existing deployment is Azure-native OpenAI
  Global Standard, not a Marketplace purchase. Standard Azure Speech consumption is the intended
  credit-backed service. No partner model, PTU reservation, commitment tier or paid add-on is proposed.
- The selected resources are billed to this verified credit-bearing subscription; no subscription
  switch occurred. Eligible consumption automatically draws its sponsorship credit while valid.
  The post-test Consumption API returned no AI usage rows yet, so **the individual test charges
  have not been reconciled to a posted credit deduction**. Eligibility is verified from the actual
  offer and Microsoft's first-party policy, not invented invoice evidence.
- Sponsorship terms permit paid billing after credit exhaustion/expiry. Spending protection remains
  Off; this setup does not provide an unconditional no-overage guarantee or alter billing controls.
- **Daily is outside Azure credit coverage.** Its account allowance/billing must be independently
  confirmed before a complete voice call. No Daily account or paid plan was created here.

## Existing GPT deployment — reuse, do not duplicate

| Setting | Verified value |
| --- | --- |
| Resource | `caracalaus`, resource group `rg-monitoring` |
| Resource kind / SKU | `Microsoft.CognitiveServices/accounts`, `AIServices`, `S0` |
| Resource region | `australiaeast` |
| Resource state | `Succeeded`; local API-key authentication enabled |
| Deployment name | `gpt-5.6-terra` |
| Underlying model | Format `OpenAI`, name `gpt-5.6-terra`, version **`2026-07-09`** |
| Deployment state / billing type | `Succeeded`, **`GlobalStandard`**, pay per token |
| API base | **`https://caracalaus.openai.azure.com/openai/v1/`** |
| Alternate advertised v1 host | `https://caracalaus.services.ai.azure.com/openai/v1/` |
| Allocated capacity | 5,000 units; returned limits **5,000 requests/minute**, **5,000,000 tokens/minute** |
| Subscription regional quota | `OpenAI.GlobalStandard.gpt-5.6-terra`: 10,000 units total, 5,000 allocated |

The catalogue, deployment responses and successful streaming Chat Completions/Responses requests
establish access to this deployed version. Global Standard processing is not confined to
Australia East. The capacity is a throughput allocation, not a prepaid token purchase or monetary
limit. Do not change the existing deployment or other workloads to prepare this prototype.

The supported deployment interface is `az cognitiveservices account deployment create` or ARM
`Microsoft.CognitiveServices/accounts/deployments` with OpenAI model name/version and a supported
SKU. Microsoft documents management API `2025-06-01`; this subscription also advertises stable
`2026-07-01`. No deployment creation is necessary here. The deployment alias happened to equal
the model ID; both were independently read from Azure rather than assumed.

Use Pipecat **`pipecat.services.azure.llm.AzureLLMService`** with `endpoint` from the environment
and `Settings(model=deployment_name)`. The v1 endpoint selects the modern Azure API; no dated
inference `api_version` or `AZURE_OPENAI_API_VERSION` is required. The conversation uses streaming
Chat Completions with **`reasoning_effort="none"`**, required for Terra's Chat Completions plus tools.
The deployed model also passed a separate Responses structured-output check through the
OpenAI-compatible SDK at the same Azure base URL. Current application `review_plan` reads the
deterministic decision assessment; it does not make a second model call or need another deployment.
Deterministic financial state/calculations remain local.

Endpoint validation accepts HTTPS resource roots or `/openai/v1/` on `.openai.azure.com` and
`.services.ai.azure.com`, normalizing to v1. Arbitrary/direct-OpenAI hosts and dated deployment URLs
are rejected. Change the endpoint environment value and `voice.model` in [config.toml](../config.toml) for another approved compatible
Azure deployment; the alias need not equal its underlying model ID. Reverify capabilities before
changing models. Management API versions are separate: Cognitive Services advertised stable
`2026-07-01`; invoice-credit inspection used the current Consumption `2026-06-01` API.

## Speech STT and TTS

**`financeVoiceIndia`**, SpeechServices **S0**, **Central India (`centralindia`)**, supplies both
STT and TTS. Provisioning state is `Succeeded`; authenticated voice listing, continuous recognition
and streamed synthesis all succeeded. Its ARM endpoint is
`https://centralindia.api.cognitive.microsoft.com/`; use the matching region with Pipecat, not that
management-advertised root as the Azure OpenAI endpoint.

| Component | Selected configuration | Verification status |
| --- | --- | --- |
| STT | Continuous `SpeechRecognizer`, `en-IN`, service-managed standard real-time model; 16 kHz/16-bit mono PCM | Actual interim and final results received through application `SpeechRecognition` |
| TTS | `en-IN-Aarti:DragonHDLatestNeural`, Female, `en-IN`, GA, `NeuralHD`, 24 kHz PCM | Exact authenticated catalogue match; actual streamed audio and word boundaries received |
| STT service endpoint | `https://centralindia.stt.speech.microsoft.com` | Advertised by resource and usable through Speech SDK |
| TTS service endpoint | `https://centralindia.tts.speech.microsoft.com` | Voice list HTTP 200 and successful SDK synthesis |
| Existing Australia East Speech | Standard STT/neural voices; `en-IN-AartiIndicNeural` Female/GA verified | Selected HD voice absent; not used as a hidden fallback |

Australia East supports standard recognition/neural voices but does not list HD support in the
current region table. Central India supports real-time STT and HD, preserves a native Indian-English
voice and avoids another cross-continent speech hop for an India-hosted backend. End-to-end latency
still depends on the actual backend/Daily/client location. Do not
reuse an Australia East key with a Central India hostname. South India is not Central India and
is not supported for Speech processing in the current documentation.

The resource region determines the standard Speech SDK endpoints. No separate STT model deployment,
model-version string, TTS deployment, dated REST API version or Speech endpoint environment variable
is needed for this regional-key path. The SDK uses continuous recognition and streamed synthesis,
not batch uploads. `LatestNeural` is a service-managed voice alias, not a frozen model version.
No custom STT training, MAI preview, Voice Live bundle or separate TTS deployment is needed.

Pipecat integrations: **`AzureSTTService`** and **`AzureTTSService`**, installed Pipecat **1.9.0**,
Speech SDK **1.51.2**. [Speech adapters](../backend/app/speech.py) add financial phrase hints before
recognition and emit escaped HD-safe SSML without unsupported silence/prosody controls. TTS consumes
short sentence inputs and streams audio output; it is not an assertion of incremental-text v2 use.
The application verifies the exact female English voice in the selected resource before opening
Daily. No automatic provider/voice substitution or invented recognition result is used.

Published default quotas: S0 STT 100 concurrent base-endpoint requests; S0 TTS 30 transactions/second.
F0 permits one concurrent STT request, 5 audio hours/month and 0.5M neural characters/month, but the
free allowance does not establish Dragon HD eligibility. Actual concurrency overrides are not
exposed by CLI/API according to Microsoft; support must confirm them if needed. One prototype call
needs no quota increase. Voice-specific regional capacity can still return HTTP 429.

### Live verification and accuracy limits

The [opt-in verification script](../backend/scripts/verify_azure.py) uses actual Pipecat **1.9.0**,
OpenAI **2.54.0** and Speech SDK **1.51.2**, with temporary synthetic SQLite state and audio in memory.
It has no provider doubles, microphone capture, audio files or application credential writes.

- Two streamed Terra tool calls saved opening cash ₹6,000, then corrected it to ₹6,500 through
  `VoiceTools.update_facts`; committed revisions and deterministic closing balances were checked.
  Each returned 23 stream chunks; final-run elapsed times were 2.84s and 2.33s.
- Responses structured parsing returned ₹6,500/INR. This validates its schema API, not a full
  `review_plan` conclusion or every application tool schema.
- Aarti HD generated 12.9 seconds of audio in 30 chunks with 37 word-boundary events in the final
  run; first audio arrived at **0.916s**, synthesis completed at 5.270s. Across six short synthetic
  syntheses, first audio was 0.429–0.916s. These are host component measurements, not consumer latency percentiles.
- Continuous STT preserved ₹1,25,000, 25 September, ₹6,000/15 September and the ₹6,500 correction.
  Additional crore/paise samples preserved ₹1,25,00,000 and ₹12,500.50, but **some corrected dates
  were misrecognized**, including “sixteenth” becoming “6th 10th”. Do not silently accept ambiguous dates.
- GA monolingual PostRefinement was tested on identical audio with phrase lists. It added roughly
  0.4–0.6s to final results in the first sample without improving its amounts. A richer sample
  improved paise/date text but rendered the crore amount ambiguously as “₹1,25 lakh”. It is not
  enabled in the application on this evidence. Standard real-time `en-IN` plus financial hints,
  including `paise`, remains the selected path; no inferior alternate model was deployed.

Synthetic TTS-to-STT input was fed faster than live speech. These checks establish usable services,
not human-accent robustness, subjective voice preference, barge-in, browser playback or error-free
financial recognition. Exercise those through the actual Daily conversation before product acceptance.

## Prices checked — not a guarantee of future charges

Microsoft pricing page and Retail Prices API observations, USD before taxes/agreement/FX effects:

| Usage | Public consumption price |
| --- | --- |
| Terra Global Standard, short context | Input **$2/1M tokens**, cached input **$0.20/1M**, output **$12/1M**; cache writes **$2.50/1M** |
| Terra Global Standard, long context | Input **$4/1M**, cached input **$0.40/1M**, output **$18/1M** |
| Speech standard real-time STT | **$1/audio hour**, billed by audio seconds |
| Standard neural TTS | **$15/1M characters** |
| Neural HD TTS, Central India catalogue | **$22/1M characters** |

Terra prices were matched to Australia East **Std Gl** meters, not **PP** priority or provisioned
meters. Speech retail labels can say `S1` while the account SKU is `S0`; copy the resource SKU from
ARM, not the meter label. The public Speech page displayed N/A for HD, whereas the Retail API
returned the HD meter above. A price-list entry is not resource availability or account-specific
invoice evidence. No credit-eligible AI consumption line was present in the queried usage records;
the eligibility assessment uses the actual offer plus Microsoft's first-party coverage policy.

The app allows one call at a time and caps each call at 30 minutes in [config.toml](../config.toml).
Those are usage controls, not monetary caps. Live verification requests capped LLM output at
256 tokens/request with retries disabled. Initial deployment verification used nine LLM requests (1,608 input /
261 output tokens), 1,224 HD characters and approximately 93.3 seconds of STT input including
trailing silence: roughly **US$0.06** at the listed rates, not a settled invoice amount.

## Runtime environment mapping

Supply these privately using [.env.example](../.env.example). These five values are required to start a
voice call; none is required merely to inspect saved manual figures.

| Variable | Value/source | Secret? |
| --- | --- | --- |
| `AZURE_OPENAI_API_KEY` | Key 1 or Key 2 from `caracalaus`; authenticates the voice assistant LLM | **Yes** |
| `AZURE_OPENAI_ENDPOINT` | `https://caracalaus.openai.azure.com/openai/v1/` | No |
| `AZURE_SPEECH_KEY` | Key 1 or Key 2 from `financeVoiceIndia`; authenticates STT and TTS | **Yes** |
| `AZURE_SPEECH_REGION` | `centralindia` | No |
| `DAILY_API_KEY` | Daily dashboard → Developers → API keys; authenticates private rooms/tokens, separate billing | **Yes** |

These are **voice-only requirements**; application startup/manual inspection works without them.
The verified deployment name is selected separately as `voice.model = "gpt-5.6-luna"` in
[config.toml](../config.toml), alongside ordinary conversation behavior.
Neither Azure subscription/tenant IDs, a Speech endpoint variable nor an API-version variable is
required by application runtime. Keep provider entries blank in the committed example. Put actual
values privately in the root [.env](../.env); it is ignored by Git. Do not send secrets to chat.

## Obtain values without printing secrets

Azure Portal → **Subscriptions → Azure subscription 1 → Resource groups → rg-monitoring**:

- Open **caracalaus → Resource Management → Keys and Endpoint**; copy Key 1 or Key 2 privately into
  `AZURE_OPENAI_API_KEY`. Use the verified v1 URL above for `AZURE_OPENAI_ENDPOINT`.
- Open **caracalaus → Go to Microsoft Foundry → Models + endpoints / Deployments**; the deployed
  alias selected by `voice.model` is `gpt-5.6-luna` in the primary configuration.
- Open **financeVoiceIndia → Resource Management → Keys and Endpoint**; copy its Key 1 or Key 2
  into `AZURE_SPEECH_KEY`, and its region `centralindia` into `AZURE_SPEECH_REGION`.
- Daily is not in Azure. A Daily account owner/admin obtains `DAILY_API_KEY` from
  **[Daily dashboard](https://dashboard.daily.co) → Developers → API keys** and checks allowance/usage.

CLI alternative, in a private unrecorded Bash terminal: capture keys rather than printing them.
These commands do not modify resources or keys. Do not enable shell tracing or Azure `--debug`:

```sh
set +x
SUBSCRIPTION_ID='e4f89284-8be8-403e-994b-9c49736281c8'
AZURE_OPENAI_API_KEY="$(az cognitiveservices account keys list --subscription "$SUBSCRIPTION_ID" --resource-group rg-monitoring --name caracalaus --query key1 --output tsv --only-show-errors)"
AZURE_SPEECH_KEY="$(az cognitiveservices account keys list --subscription "$SUBSCRIPTION_ID" --resource-group rg-monitoring --name financeVoiceIndia --query key1 --output tsv --only-show-errors)"
export AZURE_OPENAI_API_KEY AZURE_SPEECH_KEY
export AZURE_OPENAI_ENDPOINT='https://caracalaus.openai.azure.com/openai/v1/'
export AZURE_SPEECH_REGION='centralindia'
```

These exports configure the current shell/Compose invocation; they do not populate the private
environment file. For file-based setup, use Portal's copy controls and paste directly into the
matching assignments in the editor. On Linux, restrict that existing file before filling secrets:

```sh
chmod 600 .env
```

Key rotation is **not required** for setup and was not performed. If intentionally rotating Key 2,
first confirm no workloads use it, run the appropriate command below, then retrieve `key2` into
a private variable as above. Never regenerate both keys together or rotate a shared active key blindly.

```sh
az cognitiveservices account keys regenerate --subscription "$SUBSCRIPTION_ID" --resource-group rg-monitoring --name caracalaus --key-name Key2 --output none --only-show-errors
az cognitiveservices account keys regenerate --subscription "$SUBSCRIPTION_ID" --resource-group rg-monitoring --name financeVoiceIndia --key-name Key2 --output none --only-show-errors
```

Environment values are visible to privileged processes; keep the machine trusted. Never print
interpolated Compose configuration; use `docker compose config --quiet`. Do not commit actual keys.

Azure LLM v1 also supports Entra ID with scope `https://ai.azure.com/.default` and the appropriate
Azure OpenAI User role; Pipecat accepts `token_provider`. The current application deliberately uses
one real key-auth path, not a dormant alternate auth adapter. No new role assignment is required for
key-based use of the existing account. Speech Entra requires its own supported custom-domain/RBAC
setup and is not silently interchangeable with the regional-key integration.

## Remaining setup and repeat verification

1. Supply the three secret keys privately and the three verified non-secret values above.
  No additional Azure deployment input is needed. The only outside-Azure account information
  still needed is the Daily key and its applicable allowance/billing.
2. Start with `docker compose up --build`, open **http://localhost:8000**, allow the microphone
  through **Start conversation**, and exercise the real voice → tools → cards → spoken correction
  → conclusion journey. Evaluate recognition and voice preference with actual Indian-English users.
3. Reconcile AI usage with Azure credits when delayed usage records appear. Never infer a hard
  monetary cap from quota, a budget notification or the credit balance.

To repeat the bounded Azure-only component check, run from the repository root:

```sh
cd backend
uv run --locked python -m scripts.verify_azure --allow-billable \
  --subscription e4f89284-8be8-403e-994b-9c49736281c8 --resource-group rg-monitoring \
  --openai-resource caracalaus --deployment gpt-5.6-terra --speech-resource financeVoiceIndia
```

It makes three small LLM requests, one synthetic TTS request and one continuous STT request.
Optional `--post-refinement` compares another recognition pass; it does not change runtime settings.
It requires Azure CLI permission to read resource keys, not keys in chat or the environment file.
Never run billable checks automatically in pull-request CI.

Billing review: Azure Portal → **Cost Management + Billing → linked billing profile → Payment
methods → Azure credits**. Verify expiry and pending charges, not just the invoice balance.

## Official sources

- [Startup credit coverage](https://learn.microsoft.com/en-us/startups/benefits/azure-credits/use-azure-credits)
- [Foundry sponsorship coverage](https://learn.microsoft.com/en-us/startups/benefits/technical-benefits/azure-credits/foundry-model-sponsorship-coverage)
- [Credit balance semantics](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/mca-check-azure-credits-balance)
- [Sponsorship conversion terms](https://azure.microsoft.com/en-us/pricing/offers/ms-azr-0036p/)
- [Spending limits](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit)
- [Azure OpenAI model catalogue](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure#gpt-56)
- [Azure OpenAI v1](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)
- [Pipecat Azure LLM](https://docs.pipecat.ai/api-reference/server/services/llm/azure)
- [Speech regions](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions)
- [Speech voices](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support)
- [Speech quotas](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits)
- [Speech pricing](https://azure.microsoft.com/en-us/pricing/details/speech/)
- [Azure OpenAI pricing](https://azure.microsoft.com/en-us/pricing/details/azure-openai/)
- [Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)
- [Current Foundry resource creation](https://learn.microsoft.com/en-us/azure/ai-services/multi-service-resource)
- [Azure account CLI](https://learn.microsoft.com/en-us/cli/azure/cognitiveservices/account)
- [Deployment CLI](https://learn.microsoft.com/en-us/cli/azure/cognitiveservices/account/deployment)
- [Deployment management API](https://learn.microsoft.com/en-us/rest/api/microsoftfoundry/accountmanagement/deployments/create-or-update?view=rest-microsoftfoundry-accountmanagement-2025-06-01)
- [Key retrieval and rotation](https://learn.microsoft.com/en-us/cli/azure/cognitiveservices/account/keys)
- [Real-time recognition and PostRefinement](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-recognize-speech)
- [Speech SDK release notes](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/releasenotes)
- [Pipecat Azure STT](https://docs.pipecat.ai/api-reference/server/services/stt/azure)
- [Pipecat Azure streaming TTS](https://docs.pipecat.ai/api-reference/server/services/tts/azure)
- [Daily API authentication](https://docs.daily.co/docs/rest-api/authentication.md)
