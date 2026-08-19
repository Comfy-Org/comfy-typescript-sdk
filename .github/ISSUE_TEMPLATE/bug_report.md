---
name: Bug report
about: Create a bug report to help us improve.
title: ""
labels: bug
assignees: ""
---

**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
A minimal reproduction — the smallest snippet that shows the problem. Please
include the SDK call you made and, if relevant, how the client was constructed
(with any API key redacted).

```ts
import { Comfy } from "@comfyorg/sdk";

// ...
```

**Expected behavior**
A clear and concise description of what you expected to happen.

**Environment**

- `@comfyorg/sdk` version: <!-- `npm ls @comfyorg/sdk` -->
- Node version: <!-- `node --version` (the SDK requires >=22) -->
- OS:
- Which surface: <!-- Comfy Cloud / serverless deployment / self-hosted via comfy-api-proxy -->

**Nice to have**

- [ ] The full error, including any `code` / `status` on a thrown SDK error
- [ ] Terminal output or stack trace
- [ ] Whether it worked on an earlier SDK version (which one?)

**Additional context**
Add any other context about the problem here.
