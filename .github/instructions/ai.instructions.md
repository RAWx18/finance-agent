---
# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only
description: 'Use when planning or implementing AI, selecting models, configuring LLM services, or integrating real-time conversational and voice workflows.'
---

# AI Models and Real-Time Voice

- Only the project-approved GPT-5.6 family may be used: GPT-5.6-Luna, GPT-5.6-Sol, and GPT-5.6-Terra.
- These are approval-list names, not verified API identifiers. Verify availability, exact API or deployment identifiers, capabilities, and pricing using current provider documentation and the target account before integration. Do not invent characteristics or silently substitute models; report mismatches and seek an approved resolution.
- Select models deliberately for task suitability, context, reasoning, latency, and cost. Do not automatically choose the strongest or most expensive model, or underuse AI when it provides meaningful value.
- Prefer deterministic code when it is simpler, faster, cheaper, and more reliable; prefer an appropriate model when it is substantially better suited. Avoid unnecessary LLM calls.
- Use Pipecat and Daily together for real-time conversational and voice workflows. Separate transport, orchestration, model interaction, business logic, application logic, and infrastructure so components can be replaced and tested independently.
