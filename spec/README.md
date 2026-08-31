# Vendored contracts

Two one-way vendored copies live here; neither is hand-edited, and neither is merged into the other.

## `openapi.yaml`

Vendored copy of the canonical **Comfy API v2** HTTP contract (OpenAPI 3.0.3). Synced one-way from the canonical contract — do not hand-edit. The sync strips any operation tagged `internal` / `x-internal: true` (this is a public repo). `VERSION` pins the contract version. Regenerate `src/low/types.gen.ts` and `src/low/zod.gen.ts` from this file with `pnpm generate`; CI (`scripts/check-spec-drift.mjs`) fails on drift.

## `router-openapi.yaml`

Vendored copy of the **Comfy Router** HTTP contract — the `/v1/models/...` surface `comfy.models.run` calls. Same one-way sync, same do-not-hand-edit rule, and a contract of its own: it is never merged into `openapi.yaml`.

Nothing in this repo generates code from it, so there is nothing for `scripts/check-spec-drift.mjs` to regenerate and byte-diff. Two hand-written things are coupled to it instead, and each is checked by comparison rather than by regeneration:

- **The error buckets.** The closed `error_type` set and the class per bucket in `src/sdk/routerErrors.ts`, checked by `src/sdk/router-spec-coverage.test.ts` against this file's `components.schemas.RouterErrorType.x-comfy-error-types` — the buckets, their order, their tier and their classes. A sync that adds a bucket is not merged until a class exists for it.
- **The invocation route.** `RUN_ROUTE_TEMPLATE` in `src/sdk/models.ts` (the path `comfy.models.run` posts to) and `COMFY_ROUTER_BASE_URL` in `src/sdk/credentials.ts` (the default host), checked against this file's `runRouterModel` path, its path parameters and its `servers[0].url`. This one is checked twice on purpose: `src/sdk/router-spec-contract.test.ts` asserts it in `pnpm test` against the live constants, and `scripts/check-spec-drift.mjs` asserts it again in the `check:spec-drift` CI job, reading the same constants out of their source text — so a sync that moves the route reddens the job whose name says why, not only the unit suite. Without it a route move would land green here and `comfy.models.run` would 404.

Both read this file with the `yaml` dev dependency; the shared reader for the route half is `scripts/router-route-contract.mjs`. In every case this file is the side that is right — update the hand-written constant, never this copy.
