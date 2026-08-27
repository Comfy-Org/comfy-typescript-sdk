# Vendored contracts

Two one-way vendored copies live here; neither is hand-edited, and neither is merged into the other.

## `openapi.yaml`

Vendored copy of the canonical **Comfy API v2** HTTP contract (OpenAPI 3.0.3). Synced one-way from the canonical contract — do not hand-edit. The sync strips any operation tagged `internal` / `x-internal: true` (this is a public repo). `VERSION` pins the contract version. Regenerate `src/low/types.gen.ts` and `src/low/zod.gen.ts` from this file with `pnpm generate`; CI (`scripts/check-spec-drift.mjs`) fails on drift.

## `router-openapi.yaml`

Vendored copy of the **Comfy Router** HTTP contract — the `/v1/models/...` surface `comfy.models.run` calls. Same one-way sync, same do-not-hand-edit rule, and a contract of its own: it is never merged into `openapi.yaml`.

Nothing in this repo generates code from it, so `scripts/check-spec-drift.mjs` has nothing to regenerate and diff. The one thing that _is_ coupled to it is hand-written — the closed `error_type` set and the class per bucket in `src/sdk/routerErrors.ts` — so its drift check is a test instead: `src/sdk/router-spec-coverage.test.ts` reads this file's `components.schemas.RouterErrorType.x-comfy-error-types` and fails if the buckets, their order, their tier or their classes disagree. A sync that adds a bucket is not merged until a class exists for it.
