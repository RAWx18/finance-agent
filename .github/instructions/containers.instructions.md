---
# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only
description: 'Use when designing container boundaries or creating container images, Dockerfiles, Compose configuration, and container build workflows.'
applyTo: '**/Dockerfile,**/Dockerfile.*,**/*.Dockerfile,**/Containerfile,**/Containerfile.*,**/.dockerignore,**/*compose*.yaml,**/*compose*.yml'
---

# Containers

- Dockerize almost everything that benefits from isolation, reproducibility, deployment consistency, or environment parity. Avoid containers that add complexity without meaningful value.
- Keep images lightweight and fast to build and start, but complete and robust. Never remove required dependencies, observability, diagnostics, security controls, or useful runtime capabilities just to reduce size.
- Use appropriate minimal base images, multi-stage builds where useful, deterministic builds, clean runtime dependencies, and sensible container boundaries.
