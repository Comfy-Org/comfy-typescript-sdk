# Cross-SDK surface parity

`python-surface.json` is a committed snapshot of the **Python SDK's** public surface — the public method names under its `models` namespace, its router error class names, the `error_type` each of those classes maps to, and the error classes its package root re-exports. It is not hand-written; do not edit it.

## Why this exists

The two SDKs are maintained in separate repositories by separate pull requests, so they drift. The drift is invisible until somebody follows a Python example in TypeScript and the method is not there. This snapshot plus `src/sdk/surface-parity.test.ts` turn that into a test failure naming the symbol that diverged.

## How the other repository's surface is obtained

`scripts/sync-python-surface.mjs` reads four files from the public `Comfy-Org/comfy-python-sdk` repository over plain HTTPS (`raw.githubusercontent.com` — no token, no clone, no Python toolchain) and extracts the surface with `scripts/python-surface.mjs`, which parses those four source files rather than importing the package.

The result is committed rather than fetched at test time, for the same reason `spec/openapi.yaml` is vendored: the assertion has to run offline and deterministically on every pull request, and a test that reaches the network fails for reasons that have nothing to do with the code under review. So the work is split in two:

| Where                                          | What it does                                                                                | Network |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- | ------- |
| `pnpm test` (`src/sdk/surface-parity.test.ts`) | Diffs this SDK's live exports against the committed snapshot. This is the parity assertion. | no      |
| `sdk-parity` CI job (`pnpm check:sdk-parity`)  | Re-derives the snapshot from the Python SDK's default branch and fails if it has moved.     | yes     |

Without the second half the snapshot could go quietly stale and the first half would keep passing — which is the failure mode this whole check is built to avoid.

## When a check fails

```bash
pnpm sync:python-surface   # refresh the snapshot from the Python SDK
pnpm test                  # see which symbols actually diverged
```

Then either mirror the change in this SDK, or — if the difference is deliberate — add it to the `INTENTIONAL_ASYMMETRIES` allowlist in `src/sdk/surface-parity.test.ts` with the reason. An allowlist entry is a design decision, not a way to quiet a failure.

## What this deliberately does not check

- **Behaviour.** Surface only: names, and the `error_type` each error class maps to. Two methods with the same name that do different things pass.
- **Within-language parity.** Whether the Python SDK's own sync and async clients agree is that SDK's test to run, not this one's. The one exception is that the async `models` class may not introduce a method name the sync class lacks, because such a name would be a Python-only method with no counterpart here.
- **Documentation.** Whether the two SDKs' docs cover the same ground is a separate concern.
