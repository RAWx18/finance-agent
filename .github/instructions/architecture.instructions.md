---
# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only
description: 'Use when designing, implementing, reviewing, or refactoring features and repository structure.'
applyTo: '**'
---

# Architecture and Repository Integrity

- Understand the requirement, system direction, existing behavior, boundaries, and constraints before implementation. Make material assumptions explicit; resolve minor gaps with the simplest reasonable assumption rather than blocking work.
- Choose the smallest architecture that balances correctness, simplicity, maintainability, extensibility, and implementation cost. Reject speculative infrastructure, premature optimization, unnecessary layers, and pattern-driven complexity, but retain infrastructure justified by a current requirement.
- Give directories, files, packages, and components clear responsibilities. Keep structure predictable and discoverable without hidden conventions or excessive indirection.
- Use cohesive modules, low coupling, and explicit boundaries so changes remain local. Reuse existing behavior when useful; do not create generic abstractions or hypothetical extension points merely for reuse or portability.
- Use encapsulation, composition, interfaces, and polymorphism where they make behavior easier to replace or test. Prefer functions and data structures when they are clearer.
- Keep interfaces, data formats, infrastructure definitions, and boundaries portable where practical without introducing theoretical portability layers.
- This is a Version 1 codebase with no external customers or legacy compatibility obligations. Replace poor designs cleanly; do not preserve deprecated paths, compatibility layers, duplicate implementations, or migration machinery without a concrete current requirement.
- Every feature must work end-to-end and integrate with the system. No placeholders, temporary hacks, abandoned experiments, half-integrated architecture, or structures created only to satisfy an interface or demonstrate a pattern.
- Keep the repository coherent, runnable, deployable, and capable of a clean release during incremental development. Maintain clear development, staging/RC, and stable-production-ready states; unfinished work must not compromise the main system.
