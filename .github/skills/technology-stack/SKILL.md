---
# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only
name: technology-stack
description: 'Use when asked to evaluate a technology, compare dependencies or services, select an AI model for a task, or propose a stack change. Assess candidates against repository instructions and produce a justified recommendation with validation evidence.'
---

# Technology Evaluation

1. Identify the capability needed, current stack, deployment environment, and functional and operational constraints. Determine whether existing components or deterministic code already meet the need.
2. Read [technology selection](../../instructions/technology.instructions.md) and the instructions relevant to the proposed capability. Identify eligible candidates without changing the repository yet.
3. Compare candidates against the required evaluation criteria using current documentation and available evidence. For model candidates, verify provider availability and exact identifiers in the target environment.
4. Assess integration boundaries, configuration, deployment, maintenance, and testing impact. Use a focused experiment only when necessary to resolve a material uncertainty.
5. Recommend the smallest suitable option with concise trade-offs, evidence, and unresolved assumptions. Explain any required approval or availability mismatch, then identify the implementation and validation steps for the selected option.