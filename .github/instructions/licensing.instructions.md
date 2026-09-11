---
# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only
description: 'Use when creating or modifying source files and repository customizations to apply the repository SPDX license and attribution.'
applyTo: '**'
---

# Repository Licensing

Include the following two-line SPDX header in source files from creation, using the language's comment syntax and repository conventions:

```text
SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
SPDX-License-Identifier: AGPL-3.0-only
```

Keep YAML-frontmatter customization headers as comments inside frontmatter so discovery metadata remains parseable. Formats that cannot contain comments, such as JSON, do not receive comment headers. Preserve separately licensed third-party components.