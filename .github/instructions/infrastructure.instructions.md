---
# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only
description: 'Use when planning cloud resources, provisioning environments, deploying releases, or managing infrastructure state.'
applyTo: '**/*.tf,**/*.tf.json,**/*.tfvars,**/*.tfvars.json,**/*.tofu,**/*.tofu.json,**/*.tofuvars,**/*.tofuvars.json,**/.terraform.lock.hcl'
---

# Cloud Infrastructure

- Azure is the target cloud. Manage infrastructure with OpenTofu so environments can be provisioned, reproduced, deployed, and destroyed easily.
- Keep infrastructure understandable, reproducible, and free of manual setup wherever reasonably possible.
- Make environment-specific configuration explicit and easy to locate. Development, staging/RC, and production must have clear, reproducible infrastructure states.
