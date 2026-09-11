---
# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only
description: 'Use when designing runtime behavior, selecting algorithms, or handling application configuration and environment values.'
applyTo: '**'
---

# Configuration and Environment

- Centralize non-secret application behavior in one primary configuration file wherever practical. Put tunable limits, timeouts, feature choices, algorithm selection, operational defaults, and other runtime decisions there.
- A behavior, algorithm, or limit change should normally require one obvious configuration edit rather than searching through business logic.
- Where multiple implementations are genuinely required, use separate classes or well-defined interchangeable implementations selected through configuration. Make available options explicit and briefly explain the choices in the corresponding code comment. Do not build speculative alternatives.
- Keep environment values distinct from application configuration. Use environment variables primarily for credentials, secrets, deployment-specific values, and genuine execution-environment settings, not ordinary behavior merely for convenience.
- Organize and consistently name environment files and variables. Briefly document each required value so setup does not require lengthy documentation. Never commit actual secrets in example environment files.
