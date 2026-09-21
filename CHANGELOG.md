# Changelog

All notable changes to `@comfyorg/sdk` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries for `0.1.0` through `0.1.7` were reconstructed from the published
GitHub Release notes when this file was introduced; the releases themselves
remain the authoritative record for those versions.

## [Unreleased]

<!--
Add user-visible changes here under Added / Changed / Deprecated / Removed /
Fixed / Security. Internal-only changes (refactors, tests, CI) do not need an
entry. See CONTRIBUTING.md.
-->

### Added

- **The rest of a job's state is readable off the handle.** `Job` held the
  whole v2 job model privately and re-exported four fields, so a caller who
  wanted a run's duration had to cast past `private` to reach the timestamps.
  Eight read-only accessors now cover the remainder of the wire contract:
  `createdAt` and `expiresAt` (`Date`), `startedAt` and `completedAt`
  (`Date | null` — both are nullable on the wire, and a duration is
  `completedAt` minus `startedAt`), `progress`, `queuePosition`, `metrics` and
  `urls`. They read whatever state the handle currently holds, exactly like
  `id`/`status` — nothing re-fetches implicitly — and the object-valued three
  hand back a snapshot copy so editing the result cannot rewrite the handle's
  own links. Note that Comfy Cloud's poll response carries `progress: null`
  even for a running job today, so `job.events()` remains the live-progress
  source there. Where the wire field is nullable, an absent or unusable value
  reads as "none" rather than as an `Invalid Date` or an empty snapshot; where
  it is required and non-nullable (`createdAt`, `expiresAt`, `urls`) a
  response that omits it raises `ComfyError` (`unexpected_response`) instead
  of handing back a `Date` that silently compares false against everything, or
  a `{}` typed as a full set of links.
- **Comfy Router alt-provider controls on `comfy.models.run` —
  `modelProvider`, `strictMode` and `fallbackProvider`.** Three optional
  `RunOptions` fields, sent as the `model_provider`, `strict_mode` and
  `fallback_provider` query params on the synchronous run route.
  `modelProvider` selects an alternate serving provider (e.g. `"fal"`);
  `strictMode` (default `false`) toggles native ↔ provider translation, and
  `true` passes the provider's own raw shape both ways; `fallbackProvider`
  accepts `"false"` to opt out of provider-fallback. Each is sent ONLY when
  set, so a run that names none of the three is byte-for-byte the request it
  always was. These are run-route only — the queued `submit`/`subscribe`
  surface does not accept them.
- **Three queue-tier `routerErrors` classes — `Cancelled`, `QueueTimeout`
  and `RequestNotFound`** — for the `cancelled`, `queue_timeout` and
  `request_not_found` buckets the vendored Router contract now declares, so a
  queued failure carrying one of them is a typed `catch` rather than a bare
  `RouterError`.

## [0.3.0] - 2026-09-14

### Added

- **Queued model delivery — `comfy.models.submit`, `comfy.models.subscribe`
  and `comfy.models.handle`.** `comfy.models.run` holds one connection open
  until the generation is finished; `submit` returns a `RequestHandle` as soon
  as the server accepts the request, so a caller who cannot hold a connection
  for the length of a generation — a web request that has to return now, a
  worker that submits in one process and collects in another — can collect it
  later. The handle carries `requestId`, `model`, `status()`, `get()`,
  `cancel()` and an async-iterable `events()`; `get()` resolves to the same
  `{ data, requestId }` `run` does. `subscribe` is submit + poll + collect in
  one call with an `onQueueUpdate` callback, and `handle(model, requestId)`
  rebuilds a handle from the two ids with no request made. Polling is
  poll-authoritative with adaptive backoff, a server `Retry-After` beats the
  schedule (capped at 60 s), and `timeoutMs`/`signal` bound the whole wait
  rather than only the pauses in it. A `COMPLETED` status carrying an
  `error_type` — which is how the server reports a failed _and_ a cancelled
  request — rejects with the matching `routerErrors` class, so a `200` is
  never handed back as a successful result. Intended to mirror `models.submit` /
  `subscribe` / `handle` in the Python SDK, which have not shipped yet
  (comfy-python-sdk#137) — the TypeScript SDK leads on this surface until they
  do, so do not read the names as a parity guarantee today. The surface is gated server side:
  outside the preview it answers `403 not_enabled`, which arrives as
  `routerErrors.NotEnabled`.
- `routerErrors.errorFromCompletion(body, requestId)` — the typed exception a
  completed queued request reports, or `null`. Maps a `COMPLETED` body's
  `error_type` through the same table `toRouterError` uses, with `httpStatus`
  left `null` because the poll that found it was a `200`.
- `comfy.models.run` now caps the response body it will buffer, and takes a
  `maxBytes` option to size that cap per call. The whole body is held in memory
  — the call resolves with a finished result, so there is no streaming surface
  to hand one to a caller through — and until now nothing bounded it, so a
  pathological or mis-routed response could allocate without bound in the
  caller's process. The default ceiling is 64 MiB
  (`DEFAULT_MAX_RESPONSE_BYTES`, exported), comfortably above what the catalog
  returns today; pass a larger `maxBytes` for a model whose generation is
  genuinely bigger, or `maxBytes: null` to disable the cap entirely. A
  `Content-Length` over the cap is refused before the body is read at all and
  the connection is dropped, so the oversized response is never downloaded; the
  bytes actually read are counted against the same cap, since a chunked
  response declares no length and a declared one is a claim rather than a
  bound. The read accumulates into one growable buffer rather than a list of
  chunks, so the cap bounds the heap and not merely the payload. A breach
  raises a `ComfyError` with the new `code: "response_too_large"` — its own
  bucket rather than `unexpected_response`, so it can be branched on —
  carrying `maxBytes` and the offending size on `details`, and the
  `Retry-After` the response carried. It is deliberately **not** retried: it
  is a verdict about the response rather than a transport failure, and the
  retry loop would otherwise re-download the same oversized body on every
  attempt until the budget expired.
- The cap never changes what a response means. A response `run` is going to
  retry or collect is classified from its status and headers, and its body is
  dropped unread — so an oversized upstream error page cannot make a retryable
  `502` fatal, or abandon a generation the server is still holding behind a
  collectable `409`/`504`. An error response `run` does hand back is truncated
  at the cap rather than refused, so an oversized error body still arrives as
  `Unauthorized`, `InsufficientCredits` or whatever bucket its status and
  `X-Comfy-Error-Type` name. Only a result past the cap raises
  `response_too_large`, and `details.maxBytes` is what distinguishes that local
  breach from an upstream that declared the same `code` itself.
- **Model discovery — `comfy.models.schema()` and `comfy.models.list()`.**
  Comfy Router publishes both which models it runs and what arguments each one
  takes, and neither was reachable from this SDK: you could only `run()` a
  model whose ID and input shape you already knew.
  `comfy.models.schema(model, options?)` fetches one model's published OpenAPI
  document and resolves to `{ unchanged: false, document, etag, requestId }`;
  pass an `etag` you already hold and it goes out as `If-None-Match`, and a
  `304` resolves as an explicit `{ unchanged: true, document: undefined, etag,
requestId }` rather than throwing or handing back an empty document. The
  result is a discriminated union on `unchanged`, so reading `.document`
  without narrowing is a compile error. `comfy.models.list(options?)` returns a
  lazy handle that is async-iterable over models, following `next_cursor` until
  the catalog is exhausted, with `list().page()` as the single-page form for a
  caller driving its own pagination. Both go through `run()`'s credential gate,
  base-URL resolution, request-id capture and error table. The document is
  returned as data and is not validated here — these are OpenAPI 3.0.2
  documents, and a browser-loadable package should not carry a validator.
  Exported alongside them: `DEFAULT_DISCOVERY_TIMEOUT_MS`, `ETAG_HEADER`,
  `IF_NONE_MATCH_HEADER`, and the `CatalogModel`, `DiscoveryOptions`,
  `ListOptions`, `ModelList`, `ModelPage`, `SchemaDocument`, `SchemaOptions`,
  `SchemaResult` and `SchemaUnchanged` types. Neither method exists in the
  Python SDK yet, so the TypeScript SDK leads on this surface — declared in
  `surface-parity.test.ts` with a rot guard rather than assumed.

### Fixed

- `comfy.models.run` no longer throws `unexpected_response` ("body is not
  JSON") on a model whose `200` is the generated file itself. The run route's
  `200` has two branches in the contract — `application/json` and `*/*` with
  `format: binary` — and the ElevenLabs audio models (`elevenlabs/eleven_v3`,
  `elevenlabs/eleven_sfx_v2`) are the first of the second kind in the catalog;
  every one of them was unusable from this SDK, and the failure landed _after_
  the server had run and billed the generation, with the bytes already
  destroyed by the lossy text decode on the way to the parse. `run` now reads
  the response `Content-Type` before it touches the body and returns the bytes
  untouched.

### Changed

- **Breaking (types).** `RunResult` is now a discriminated union of the two
  documented `200` shapes: `RunJsonResult` (`kind: "json"`, `data` the parsed
  document — unchanged from before) and the new `RunBinaryResult`
  (`kind: "binary"`, `data` a `Uint8Array` of the exact bytes, `contentType`
  the partner's own media type, `""` when the response declared none). The
  runtime shape of a JSON result gains only `kind`, so existing code keeps
  working; existing _types_ need a `if (result.kind === "json")` narrowing
  before `data` is the supplied `TData` again. Both members are exported, as
  is `CONTENT_TYPE_HEADER`.
- A `200` that declares a non-JSON `Content-Type` is now a binary result
  rather than an `unexpected_response` error. A `200` declaring no
  `Content-Type` at all is parsed as JSON if it decodes as UTF-8 and parses,
  and is a binary result with `contentType: ""` otherwise. A media type counts
  as JSON when its subtype is `json` (so `text/json` too) or carries the
  structured `+json` suffix. A `200` that says `application/json` and then does
  not parse still raises `unexpected_response` — as does any other `2xx`, since
  a `204`/`205`/`206` is not a completed result, and as does a `200` with an
  empty body rather than returning zero bytes as the generation. The `202`
  guard is unchanged.
- `comfy.models.run` now sends `Accept: application/json, */*;q=0.9` rather
  than `Accept: application/json`. JSON is still ranked first; the client just
  no longer claims to reject the binary branch its own contract declares.

## [0.2.0] - 2026-09-10

### Added

- `Asset.getDownloadUrl()` — a directly-fetchable URL for an _uploaded_
  asset's bytes, mirroring `Output.getDownloadUrl()` (same
  `{ url, expiresAt }` shape, commits the asset first if needed). On Comfy
  Cloud / serverless it is a short-lived signed URL any fetcher can read
  until `expiresAt`, which is what lets a local image be passed to a
  URL-taking image-to-image model via `comfy.models.run`: upload the file
  as an asset, resolve its URL, put the URL in the model's input. The
  README's "Image to image — upload an asset first" section walks through
  the flow. Matches `Asset.get_download_url()` in the Python SDK.
- `comfy.models.run` now COLLECTS a generation that is still running instead of
  raising it. Comfy answers two failures with a `Retry-After` that means "the
  generation your `Idempotency-Key` already names has not finished — wait, then
  ask again for that one": a `409` carrying
  `X-Comfy-Error-Type: concurrency_limit_exceeded` (an earlier attempt of this
  same call is still in flight, which is what a re-send after a dropped
  connection meets) and a `504` carrying `deadline_exceeded` (Comfy stopped
  holding the connection at its own bound while the provider carried on). Both
  used to be terminal here — the `409` because every sub-500 status is, and the
  `504` because the two-minute retry budget was long spent by the time a
  ten-minute deadline produced one — so a caller lost a generation that had
  already been dispatched, and paid for. `run` now waits the interval the server
  named, re-sends the same key, and resolves with the result: no second
  dispatch, no second charge, nothing to enable. It has its own budget,
  `retry.collectBudgetMs`, defaulting to 20 minutes (two Comfy deadline windows:
  one to reach the `504`, one to collect what it left running); ordinary retries
  still give up at `retry.budgetMs`. Set `collectBudgetMs: 0` to switch the
  collect loop off alone, or `retry: false` to switch off both. A `409` carrying
  no `Retry-After` is unchanged and still raises on the first attempt: that is
  the deterministic key refusal, and the answer is a new key.
- Every `ComfyError` now carries `retryAfter` and `idempotencyKey`. `retryAfter`
  is the server's `Retry-After` in seconds, `null` when the response carried
  none. `idempotencyKey` is the key the failed call went out under: every
  `ComfyError` that `comfy.models.run` raises once a request has gone out has
  one — including a key it minted for you, which was previously not visible
  anywhere — and it is `null` only on a failure raised before any request was
  sent. They are what a manual re-ask needs after the collect budget is spent:
  the pace, and the key naming the generation Comfy is still holding.
  `routerErrors.RouterError` gains `retryAfter` for the same reason.

- `Job.getLogs()` — the run's captured execution log via the new
  `GET /api/v2/jobs/{id}/logs` operation (`ComfyLow.getJobLogs()` in the low
  layer; the `JobLogs` type is generated from the spec). Resolves to
  `{ text, truncated, captured_at, complete }`, or `null` for the `204` that
  means the job has no log: today only a job run on a serverless deployment (a
  `{deployment}.run.comfy.app` host) has one, Comfy Cloud captures none and
  answers `null` for every job, and a job that has not finished or whose run
  was killed before the worker could report has none either. Follows the job's
  `urls.logs` link
  and returns `null` without a request when the server offers none. The text
  is untrusted workflow output and should be rendered as plain text.
- `Job.urls.logs` is now on the generated `JobUrls` type, optional, and
  `PostJobsData["body"]["extra_data"]` accepts `auth_token_comfy_org` beside
  `api_key_comfy_org` (low layer only; `client.submit({ apiKey })` is
  unchanged).

### Changed

- The default `comfy.models.run` deadline (`DEFAULT_RUN_TIMEOUT_MS`) is now 20
  minutes, up from 10. The deadline covers every attempt of a call rather than
  each one separately, and Comfy's own deadline is 10 minutes — so the previous
  default was exactly spent at the moment a `deadline_exceeded` `504` arrives,
  and the collect above could never start under it. Successful calls are
  unaffected: the deadline is a ceiling, not a wait. Pass `timeoutMs` for the
  old bound, and note that a `timeoutMs` shorter than Comfy's 10-minute deadline
  forfeits the `504` collect (the `409` collect still works inside a short one,
  since that answer arrives in milliseconds).

## [0.1.9] - 2026-09-04

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
  disables the deadline. A dispatcher already on the request — a `ProxyAgent`,
  an mTLS agent, an egress policy — is delegated to rather than replaced, and a
  client constructed with its own `fetch` is left alone entirely: `dispatcher`
  is undici's own init key, so that transport stays the caller's to configure
  (see `ComfyLowOptions.fetch`).

## [0.1.8] - 2026-09-01

### Fixed

- `models.run` now posts to `POST {routerBaseUrl}/v2/models/{provider}/{model}`.
  The Comfy Router service moved its model routes from `/v1/models` to
  `/v2/models` and the SDK's path template was never updated, so
  every `models.run` call answered a bare 404 against the live service. The
  vendored `spec/router-openapi.yaml` is synced to the same contract in this
  change, and the router-spec contract test re-pins the two together.

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
  version is affected:** `routerErrors` had never shipped before this release
  (it is absent from `v0.1.7`), so this changes behaviour only for callers who
  were building against `main`.
- **No behaviour change.** The route `comfy.models.run` posts to
  (`/v2/models/{provider}/{model}`) and the default host
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

[Unreleased]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Comfy-Org/comfy-typescript-sdk/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Comfy-Org/comfy-typescript-sdk/releases/tag/v0.1.0
