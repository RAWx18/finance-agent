---
# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only
name: engineering-quality
description: 'Use when asked to perform an engineering-quality or maintainability review of proposed or existing code. Inspect the design and implementation, validate affected behavior, and report actionable findings against repository instructions.'
---

# Engineering Review

1. Identify the review scope, intended behavior, constraints, and relevant repository instructions in [the instructions directory](../../instructions/). Read the implementation, callers, configuration, and tests needed to understand the change.
2. Trace the affected behavior end-to-end. Compare responsibility boundaries and design choices with the applicable instructions; check for unnecessary complexity, duplication, coupling, and unrelated changes.
3. Inspect naming, comments, configuration, environment handling, portability, licensing, and affected developer documentation. Consolidate findings that have the same underlying cause.
4. Run relevant checks and tests where available, including affected integration and release checks. Examine failure paths and identify important untested behavior.
5. Report actionable findings by severity with file references, impact, and the smallest justified correction. Summarize checks performed, results, and verification gaps. If there are no findings, say so without implying unverified behavior is correct.