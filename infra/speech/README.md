<!-- SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Development Speech resource

OpenTofu manages only `financeVoiceIndia`: SpeechServices S0, Central India, in the
existing `rg-monitoring` group. The group, existing Terra deployment and all other
resources remain unmanaged. See [the Azure setup report](../../docs/azureSetup.md).

Requires OpenTofu 1.12.6 and an authenticated Azure CLI user session without
competing service-principal/workload-identity environment credentials. Subscription
and tenant are explicit in [main.tf](main.tf). No service keys are retrieved.

Verified 11 September 2026: Azure CLI creation, OpenTofu import, validation and an
actual no-change plan passed. A publisher-checksummed temporary OpenTofu binary was
used for validation; OpenTofu was not installed system-wide.

## Adopt and verify

From the repository root, import once on a machine without this local state.
Do not apply before importing the existing resource.

```sh
tofu -chdir=infra/speech init
tofu -chdir=infra/speech fmt -check
tofu -chdir=infra/speech validate
tofu -chdir=infra/speech import azapi_resource.speech \
  '/subscriptions/e4f89284-8be8-403e-994b-9c49736281c8/resourceGroups/rg-monitoring/providers/Microsoft.CognitiveServices/accounts/financeVoiceIndia?api-version=2025-06-01'
tofu -chdir=infra/speech plan -detailed-exitcode
```

Expect **No changes**, exit code 0. Exit code 2 means changes; exit code 1 means
an error. Investigate either before applying. API 2025-06-01 is supported by the
pinned provider and Azure; it is a management API, not a Speech inference version.

Public access stays enabled for the local prototype. Local authentication remains
at its unset, key-enabled default. No identity, commitments or additional resources
are configured. Default response exports and automatic provider registration are disabled.

State is local and ignored by Git, not encrypted or backed up by these files. Keep it
private and backed up; retain the provider lockfile. A clean checkout must import
the existing resource before any apply, otherwise it lacks ownership state.

## Intentional teardown

Preview with `tofu -chdir=infra/speech plan -destroy`. Expect only the Speech account.
Deletion stops STT/TTS. Run `tofu -chdir=infra/speech destroy` only after deliberate
approval and review of its confirmation prompt; the existing group is retained.