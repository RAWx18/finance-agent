---
# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only
description: 'Use when selecting frameworks, dependencies, databases, services, development tools, or architecture technologies.'
applyTo: '**'
---

# Technology Selection

- Use React and TypeScript for the frontend. Use Python and Node.js for the backend, with Python as the primary backend language.
- Default to mature, suitable open-source frameworks, libraries, databases, observability, infrastructure, testing, and developer tools and services. Do not choose proprietary products when a technically strong open-source alternative meets the need.
- Proprietary services require a clear engineering reason, platform requirement, or meaningful advantage not reasonably provided by open source. The approved GPT model policy is an explicit exception; see [AI and voice](./ai.instructions.md).
- Evaluate maintenance burden, maturity, performance, security, ecosystem, operational complexity, license, deployment and testing implications, and suitable open-source alternatives before introducing technology. Prefer long-term simplicity and developer control.
- Each dependency, microservice, queue, database, framework, and third-party service needs a concrete purpose and justified trade-off; availability alone is not justification.
- Apply [infrastructure](./infrastructure.instructions.md), [container](./containers.instructions.md), and [testing](./testing.instructions.md) requirements when selecting deployment and development technologies.
