# Changelog

All notable changes to `@comfyorg/sdk` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries for `0.1.0` through `0.1.7` were reconstructed from the published
GitHub Release notes when this file was introduced; the releases themselves
remain the authoritative record for those versions.

## [Unreleased]

### Fixed

- A `timeoutMs` longer than five minutes is now honoured instead of being
  silently capped at 300 s. On Node — the only runtime this package supports —
  `fetch` is undici, whose `headersTimeout` and `bodyTimeout` both default to
  300 s and live on the dispatcher, where no `AbortSignal` can reach them. Any
  request that waited longer than that died as `TypeError: fetch failed` with
  no HTTP status and no server request id, which hit `comfy.models.run`
  hardest: it holds one request open for the whole generation, so nothing
  arrives on it until the model finishes, and its own default deadline is
  600 s. Both limits are now derived per request from the deadline the caller
  actually asked for, and `timeoutMs: null` disables them the same way it
  disables the deadline.

- `models.run` now posts to `POST {routerBaseUrl}/v2/models/{provider}/{model}`.
  The Comfy Router service moved its model routes from `/v1/models` to
  `/v2/models` and the SDK's path template was never updated, so
  every `models.run` call answered a bare 404 against the live service. The
  vendored `spec/router-openapi.yaml` is synced to the same contract in this
  change, and the router-spec contract test re-pins the two together.

<!--
Add user-visible changes here under Added / Changed / Deprecated / Removed /
Fixed / Security. Internal-only changes (refactors, tests, CI) do not need an
entry. See CONTRIBUTING.md.
-->

### Added

- `comfy.models.run(model, input)` — run a partner model by its canonical
  `{provider}/{model}` ID and get its native output back. Resolves only when
  the generation is complete (one call; the server does any provider-side
  polling internally) to a `{ data, requestId }` result: `data` is the
  provider's payload untouched, typed `unknown` by default and narrowable with
  `run<T>(...)`; `requestId` is the server's `X-Comfy-Request-Id`, present on
  errors too via the thrown `ComfyError`. Sends an `Idempotency-Key` on every
  call, and defaults to a 10-minute deadline (`timeoutMs` / `signal` to
  override). Streaming is not included.
- Retries for `comfy.models.run`, bounded by **total elapsed time** rather than
  an attempt count (`retry.budgetMs`, default 2 minutes) with jittered
  exponential backoff. Only a transport failure or a 5xx is retried — a `404`,
  `409`, `422` or `content_policy_violation` is the server's answer about the
  request and raises immediately. Every attempt of one call replays that call's
  single `Idempotency-Key`, so a retry cannot run (or bill) the model twice.
  Pass `retry: false` for a single attempt.
- Cancellation for `comfy.models.run` via `signal`: it aborts the underlying
  connection, so the server observes a disconnect rather than a client that
  stopped listening, and it stops the retry loop between attempts. The call
  rejects with the standard `AbortError`, distinct from a transport failure and
  from the SDK's own `request_timeout`. The `timeoutMs` deadline now spans every
  attempt of a call rather than restarting per attempt.
- `comfy.config({ baseUrl })` and the `COMFY_ROUTER_BASE_URL` environment
  variable point `comfy.models` at another deployment. This is the Comfy API
  host that fronts the model router — a different surface from the class
  client's `COMFY_BASE_URL`.
- `ComfyError.requestId` — the `X-Comfy-Request-Id` of the call that failed,
  or `null` when the response carried none.

### Changed

- **Behaviour change, in `routerErrors`.** An error response carrying **no**
  `X-Comfy-Error-Type` header and no `error_type` in its body now raises the
  base `RouterError` — with `httpStatus` intact and `errorType` empty — for any
  status the fallback table does not name, which as of this entry includes
  `400`, `422`, `500` and `503`. Previously a header-less `400` or `422` raised
  `InvalidInput`, and every other unmapped status raised `InternalError`.
  Neither guess was safe: a `400` is `invalid_input` **or**
  `content_policy_violation`, and those differ in whether a retry can ever
  succeed, so calling it `invalid_input` tells a caller to fix-and-resend what
  may be a deterministic refusal; the contract pins no bucket to `422` at all,
  since that response carries its bucket only on the header. Relatedly,
  `RouterError.errorType` now defaults to `""` ("no bucket") rather than
  `"internal_error"` — a real member of the closed set, which therefore could
  not also mean "unknown". Both match the Python SDK, and the cross-SDK parity
  check now compares the two fallback tables and the two base defaults rather
  than class names alone. Responses that DO name their bucket — which is every
  response Router itself writes, on any status — are unaffected. **No published
  version is affected:** `routerErrors` has never shipped (it is absent from
  `v0.1.7`, the latest release on npm), so this changes behaviour only for
  callers building against `main`.
- **No behaviour change.** The route `comfy.models.run` posts to
  (`/v1/models/{provider}/{model}`) and the default host
  (`https://api.comfy.org`) are now pinned to `spec/router-openapi.yaml` — the
  vendored Comfy Router contract — rather than only hard-coded. Both
  `pnpm test` (`src/sdk/router-spec-contract.test.ts`) and
  `pnpm check:spec-drift` compare them against that file's `runRouterModel`
  path, its path parameters and its `servers[0].url`, so a sync that moves the
  route reddens CI instead of leaving `run` to 404 against a route the SDK
  still spells the old way. The URL it builds, and the percent-encoding of
  each segment, are unchanged.

## [0.1.7] - 2026-08-13

### Added

- `job.getWorkflow()` — fetch the workflow behind a job, including one
  rehydrated by id. Returns the graph plus a `format` discriminator: `save`
  (the authoring workflow at the version the job ran, with canvas layout and
  editor-only nodes intact) or `api` (the executed API-format graph). Which
  shape comes back depends on how the job was submitted; jobs submitted through
  this SDK always get `api` today.
- Asset deletion: `Asset.delete()` and `assets.delete(id)`, matching the Python
  SDK. Requires backend support — Comfy Cloud has it; a self-hosted
  `comfy-api-proxy` must be new enough to serve `DELETE /api/v2/assets/{id}`,
  older ones return `405 Method Not Allowed`.
- `jobId` on outputs and assets, so an output file can be traced back to the job
  that produced it without a side table. Absent for uploaded assets, which have
  no producing job.
- `expiresAt` on assets.

### Fixed

- `jobId` and `expiresAt` were present on the wire but not exposed by the public
  wrapper classes, making them unreachable.
- `getJobWorkflow` given a job URL rather than a bare id fetched the job
  resource instead of its workflow, returning `workflow` and `format` as
  `undefined` with no error.

## [0.1.6] - 2026-08-11

### Changed

- **Breaking:** the base URL moved from a constructor argument to the
  `COMFY_BASE_URL` environment variable. `new Comfy()` targets Comfy Cloud by
  default; an arbitrary endpoint is no longer part of the call surface.
  TypeScript callers get a compile error on the old form, untyped JavaScript
  callers get a `TypeError` rather than a silently ignored argument. The
  variable is read on each construction (not at module load), must be an
  `http(s)` URL, and unset-or-blank means Comfy Cloud.

  ```diff
  - const client = new Comfy("https://my-deployment.example.com", opts)
  + // COMFY_BASE_URL=https://my-deployment.example.com
  + const client = new Comfy(opts)
  ```

  `ComfyLow` (`@comfyorg/sdk/low`), the documented escape hatch the client is
  built on, still takes a base URL directly and is unchanged.

## [0.1.5] - 2026-07-30

Maintenance release. No API changes — existing code needs no updates.

### Added

- An MIT license in the published package (it previously declared none) and
  `keywords` for discoverability.
- Source maps in the published package, and `sideEffects: false` so bundlers can
  tree-shake the SDK.
- TSDoc for the public API members that had none.

### Changed

- The repository was renamed from `ComfyTypeScriptSDK` to
  `comfy-typescript-sdk`, matching the org's lower-kebab-case convention; the
  old URLs redirect. **The npm package name is unchanged (`@comfyorg/sdk`).**
  This is the first release whose published metadata carries the corrected
  repository, homepage, and bugs URLs.
- README now leads with the same branded header and "Related projects" table as
  the sibling SDKs.
- Added a Vitest config so coverage measures hand-written code rather than
  generated output.

## [0.1.4] - 2026-07-28

Comfy Cloud now serves the v2 API on `cloud.comfy.org`; `api.comfy.org`
continues to serve the node registry.

### Changed

- **Breaking:** `api.comfy.org/api/v2/*` no longer responds. Code that passes
  that host explicitly will get 404s until it is updated.
- `baseUrl` now defaults to `https://cloud.comfy.org`, added as a constructor
  overload so the options-only form reads naturally. `COMFY_CLOUD_BASE_URL` is
  exported for callers who want the value.
- Spec server URL, the regenerated `baseUrl` type union, README, and doc
  comments updated to the new host.
- Passing an explicit `baseUrl` still wins, so self-hosted and serverless
  callers are unaffected.

  ```ts
  // before
  const client = new Comfy("https://api.comfy.org", { apiKey: "..." });

  // after — the default is correct, so the host can be dropped
  const client = new Comfy({ apiKey: "..." });
  ```

## [0.1.3] - 2026-07-27

### Fixed

- Serverless gateway: follow-up links no longer 404 after submit. A gateway
  serving the v2 API under a mount prefix (for example
  `/deployment/{id}/api/v2`) returns `job.urls.*` links that already include
  that prefix; those links were joined to `baseUrl`, which carries the same
  prefix, doubling it — so the first poll after a successful submit failed with
  `NotFound`. Server-returned links (leading slash, containing `/api/`) now
  resolve against the origin. Internal shorthand paths and Comfy Cloud /
  self-hosted behavior are unchanged.
- `User-Agent` now reports the real SDK version. `SDK_VERSION` was a hardcoded
  constant while versioning is tag-driven, so every published build identified
  itself as `0.1.0`. It is now generated from `package.json` at build time.

## [0.1.2] - 2026-07-23

### Added

- `output.getDownloadUrl()` — get a fetchable URL for an output instead of
  streaming the bytes through your process. On Comfy Cloud and serverless it is
  a short-lived, self-authorizing signed storage URL (with `expiresAt`); on a
  self-hosted proxy it is the content endpoint and `expiresAt` is `null`.
- The client now identifies itself with a `User-Agent` header; pass
  `clientInfo` to attribute your own integration's traffic.

### Fixed

- SSE: a read-idle timeout, so a stalled stream can no longer hang `events()`.
- Entity-specific 404s (`job_not_found` / `asset_not_found`) now map to
  `NotFound` in the high-level client too.
- Asset upload sends the multipart `content_type` before the file part.

### Changed

- Documented `getDownloadUrl()` and corrected the API-key placeholder in the
  README.

## [0.1.1] - 2026-07-21

### Added

- An optional `apiKey` option on `submit()` / `run()` that authenticates partner
  (API) nodes in a workflow, sent as `extra_data.api_key_comfy_org`. Omitting it
  (or passing `""`) sends no `extra_data`. The key is never logged or persisted
  and does not participate in idempotency.

### Changed

- Published to npm via OIDC trusted publishing.

## [0.1.0] - 2026-07-21

First public release of the Comfy API v2 TypeScript SDK (`@comfyorg/sdk`).

### Added

- A single typed client for running ComfyUI workflows across self-hosted, Comfy
  Cloud, and serverless: upload and dedup inputs, submit a workflow, follow it
  (poll or SSE), and download outputs. Requires Node >= 22.

[Unreleased]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Comfy-Org/comfy-typescript-sdk/releases/tag/v0.1.0
