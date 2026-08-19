---
name: Feature request
about: Submit a feature request for this repo.
title: ''
labels: enhancement
assignees: ''

---

**Describe the solution you'd like**
A clear and concise description of what you want to happen.

**What are you trying to do?**
The use case behind the request — what you are building, and what is awkward or
impossible today.

**Describe alternatives you've considered**
A clear and concise description of any alternative solutions or features you've
considered, including whether the low-level escape hatch
(`@comfyorg/sdk/low`) already covers it.

**Environment**
- `@comfyorg/sdk` version: <!-- `npm ls @comfyorg/sdk` -->
- Node version: <!-- `node --version` -->
- Which surface: <!-- Comfy Cloud / serverless deployment / self-hosted via comfy-api-proxy -->

**Does this need an API change?**
Some requests need a change to the Comfy API v2 contract itself rather than to
this client — the SDK's models are generated from `spec/openapi.yaml`, which is
synced one-way from that contract. If you know the endpoint or field involved,
mention it.

**Additional context**
Add any other context or screenshots about the feature request here.
