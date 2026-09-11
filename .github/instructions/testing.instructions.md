---
# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only
description: 'Use when implementing or reviewing behavior, designing tests, validating integration, or configuring CI and coverage.'
applyTo: '**'
---

# Testing and CI

- Treat testing as part of implementation. Use unit tests for isolated logic, integration tests for component interactions, and end-to-end tests for critical workflows.
- Add component, API, contract, infrastructure, performance, or resilience tests where they provide meaningful confidence. Validate actual behavior, important edge cases, system boundaries, and failure paths.
- CI must execute relevant test suites and integrate Codecov for coverage reporting. Keep it deterministic, maintainable, and reasonably fast without weakening meaningful validation.
- Coverage is a quality signal, not an objective. Do not add superficial tests merely to increase percentages.
- Validate changed behavior, end-to-end integration, and affected release workflows with appropriate checks. State verification limitations explicitly; do not imply unexecuted checks passed.
