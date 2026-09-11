---
# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only
description: 'Use when naming files, directories, symbols, configuration keys, environment variables, or tests, and when writing or reviewing code and comments.'
applyTo: '**'
---

# Naming and Code Style

- Establish and follow one clear, language-appropriate convention for each kind of name before creating it. Keep variables, functions, classes, packages, files, directories, configuration keys, environment variables, and tests predictable, descriptive, concise, and consistent. Similar concepts must not use competing styles.
- Names and directory structure should make responsibilities obvious without opening every file.
- Implement complete behavior with the fewest lines and concepts reasonably necessary, without becoming cryptic. Prefer straightforward control flow, small focused functions, and clear ownership over boilerplate, wrappers, deep nesting, oversized functions, and duplication.
- Keep every declaration purposeful. No unused functions, variables, imports, classes, interfaces, packages, configuration, feature flags, commented-out implementations, or speculative code.
- Comments should convey one non-obvious intent, constraint, invariant, or implementation choice that naming and structure cannot express. Prefer one line; normally use no more than two. Keep comments accurate and remove stale or redundant ones.
- Do not narrate code, write essays or TODO stories, or describe edits and authorship. Avoid “changed,” “updated,” “fixed old behavior,” and “moved from” commentary. Mention history only when technically necessary; modifications should read as native, intentional design.
- Keep execution OS-agnostic where practical. Use runtime abstractions and portable libraries rather than assumptions about paths, separators, shells, installed utilities, processes, line endings, or OS-specific APIs. Common operating systems should need minimal or no code changes.
