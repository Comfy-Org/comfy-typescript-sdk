<div align="center">

<!-- Pinned to a commit SHA, not `main`: npm freezes each version's README text, so a
     mutable ref would 404 on every already-published page if assets/ ever moves.
     Re-pin this when assets/logo.svg changes. -->
<img src="https://raw.githubusercontent.com/Comfy-Org/comfy-typescript-sdk/5ca3792f0e6c0d9d4ec58c0d9b411df51a71fd3e/assets/logo.svg" alt="Comfy" width="130"/>

<h1>comfy-typescript-sdk</h1>

<p>
  <strong>The TypeScript client for the <a href="https://docs.comfy.org">Comfy API v2</a>.</strong><br/>
  Submit a workflow, stream its progress, get your outputs — against self-hosted ComfyUI, Comfy Cloud, or serverless.
</p>

</div>

<p align="center">
  <a href="https://www.npmjs.com/package/@comfyorg/sdk"><img src="https://img.shields.io/npm/v/@comfyorg/sdk?style=for-the-badge&logo=npm&logoColor=white&label=npm" alt="npm"></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/Node-%3E%3D22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node >=22"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://cloud.comfy.org"><img src="https://img.shields.io/badge/Comfy_Cloud-cloud.comfy.org-211927?style=for-the-badge" alt="Comfy Cloud"></a>
</p>

---

TypeScript SDK for running ComfyUI workflows via the **Comfy API v2**. The
same code runs against three surfaces — Comfy Cloud, a serverless
deployment, or a self-hosted ComfyUI (through
[`comfy-api-proxy`](https://github.com/Comfy-Org/comfy-api-proxy)) — changing
only the `COMFY_BASE_URL` environment variable and an optional API key. It
mirrors the behavior of the
[Python SDK](https://github.com/Comfy-Org/comfy-python-sdk) (`comfy-sdk`):
upload/dedup inputs, submit a workflow, wait for it, download the outputs —
collapsed here to a single async client (no separate sync/async API;
JavaScript is async-native).

```ts
import { Comfy } from "@comfyorg/sdk";

const client = new Comfy({ apiKey: "..." }); // Comfy Cloud
// ...or set COMFY_API_KEY and write `new Comfy()` — the key is optional, the
// environment variable is the fallback.
// COMFY_BASE_URL=http://127.0.0.1:8189 targets a local proxy instead (no key needed)

const wf = await client.workflows.fromFile("workflow_api.json");
const asset = client.assets.fromFile("photo.png"); // lazy; hashed + uploaded on first use
wf.setInput("10", "image", asset);

const job = await client.run(wf); // submit, then poll to a terminal state
await job.getOutputs("13")[0].toFile("out.png");
```

## Requirements

- **Node >=22.** Node 20 reached end-of-life; browser support is out of
  scope for v1.
- **Install:**

  ```bash
  npm i @comfyorg/sdk
  pnpm add @comfyorg/sdk
  yarn add @comfyorg/sdk
  ```

  Releases are published to npm from a GitHub Release (tag `vX.Y.Z`) by
  [`.github/workflows/publish.yml`](.github/workflows/publish.yml). To build
  from source instead (for local development, or to track an unreleased
  commit), clone this repo, `pnpm install`, `pnpm build`, and reference the
  built `dist/`.

## Auth, per surface

| Surface                                                            | Auth                                                       |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Self-hosted proxy (`comfy-api-proxy` in front of your own ComfyUI) | none — do **not** pass `apiKey`                            |
| Comfy Cloud                                                        | `new Comfy({ apiKey: "comfyui-..." })`, or `COMFY_API_KEY` |
| Serverless                                                         | `new Comfy({ apiKey: "comfyui-..." })`, or `COMFY_API_KEY` |

`new Comfy()` resolves its credential at construction, in this order — the same
order and the same variable the [Python SDK](https://github.com/Comfy-Org/comfy-python-sdk)
uses, and the same variable `comfy.models.*` reads:

1. The explicit `apiKey` option, when it is a non-blank string.
2. Otherwise `COMFY_API_KEY` from the environment. Surrounding whitespace is
   stripped and a blank value counts as unset, so `COMFY_API_KEY=` in a shell
   profile is not an error, and a key read out of a file brings its trailing
   newline along harmlessly. It is read **per construction**, so a process can
   build successive clients under different credentials.
3. Otherwise, targeting Comfy Cloud — which always requires a key — a
   `MissingCredentials` thrown **at construction**, naming both ways to supply
   one. No request is made: a missing credential reported as a server `401`
   sends you looking at your key's validity instead of at its absence.

Point `COMFY_BASE_URL` at another deployment and step 3 changes: an unresolved
key is not an error there, and means "send no credentials at all" — a
self-hosted ComfyUI behind `comfy-api-proxy` legitimately has none.

A runtime with no `process` (a browser) never sees the variable, so there the
`apiKey` option is the only source. `comfy.config({ credentials })` configures
the `comfy.*` namespace only — deliberately, so a process-global credential
cannot leak into a multi-tenant server's per-request clients — and does **not**
configure a class client.

The client only attaches the `Authorization` header to requests aimed at its
own target deployment's origin. If the server hands back an absolute URL on a
different host (for example a job's `events`/`cancel` link, or a redirect on
an asset download), the key is not sent there — see "Typed errors" below for
the exception classes this surface can raise.

The SDK identifies itself via `User-Agent` (for support + usage analytics);
no other data is collected. Pass `clientInfo` to `new Comfy({ ... })`
to append your own app's name to it, for example when attributing traffic
from a Worker built on top of this SDK.

## Module-level config (`comfy.config`) and `comfy.models`

Alongside the class client there is a module-level namespace, for apps that
configure credentials once at startup rather than threading a client through
every call site. Both import shapes reach the same members:

```ts
import { comfy } from "@comfyorg/sdk";
// or: import * as comfy from "@comfyorg/sdk";

comfy.config({ credentials: "comfyui-..." });
const { kind, data, requestId } = await comfy.models.run("bfl/flux-2-pro", {
  prompt: "a cat",
});
```

`comfy.config({ credentials })` sets the credential for every subsequent
`comfy.*` call in the process. If you set none, `COMFY_API_KEY` is read from
the environment instead — explicit config always wins, and the variable is
read per call, so rotating it mid-run is picked up. A blank or
whitespace-only variable counts as unset, and a runtime with no `process` (a
browser) simply never sees it. Pass `credentials: undefined` to clear a
configured value and fall back to the environment again; passing an empty
string is an error rather than a silent clear.

Configuration is **process-global**, which is the point for a single-tenant
app and the wrong tool for a multi-tenant server: if you need a different
credential per request, keep using `new Comfy({ apiKey })`, which resolves
per instance and is unaffected by `comfy.config`.

The credential is held in a module-private binding and is never a property of
anything the SDK hands back, so `JSON.stringify(comfy)`, `console.log(comfy)`
and any error this SDK throws are all safe to paste into a bug report. The
same now holds for the class client: `console.log(client)` no longer prints
the `apiKey` you constructed it with.

There are two ways to run a model on this namespace — `run`, which waits, and
`submit`, which queues — and they send the same request.

### `comfy.models.run(model, input)`

`model` is a canonical `{provider}/{model}` ID (`"bfl/flux-2-pro"`). `input`
is the model's own native JSON input, forwarded to the provider unchanged —
there is no Comfy envelope to wrap it in, so an integration already written
against the provider keeps the request body it already has.

The route this posts to (`/v2/models/{provider}/{model}`) and the host it posts to by default (`https://api.comfy.org`) are both pinned to the vendored Router contract in `spec/router-openapi.yaml`: `src/sdk/router-spec-contract.test.ts` and `pnpm check:spec-drift` compare them against that file's `runRouterModel` path and `servers[0].url`, so a sync PR that moves either one fails CI instead of leaving `run` to 404. When that happens, the vendored spec is the side that is right — update `RUN_ROUTE_TEMPLATE` in `src/sdk/models.ts` for the route and `COMFY_ROUTER_BASE_URL` in `src/sdk/credentials.ts` for the host.

The promise resolves **only when the generation is complete**. One call is the
whole contract: for a provider whose own API is submit-then-poll, the server
does that polling inside the call rather than handing back a task handle, so
there is nothing to poll and no job to track. M1 returns the final result
only — no progress and no streaming.

It resolves to a `{ kind, data, requestId }` result, where `kind` tells you which of the route's two documented `200` shapes came back:

- **`kind: "json"`** — the partner answered with a JSON document, which is what most of the catalog does. `data` is that document.
- **`kind: "binary"`** — the partner's generation _is_ the response body, returned under the partner's own media type. `data` is a `Uint8Array` of the exact bytes and `contentType` carries that media type.

Common to both:

- **`data`** is the provider's native payload, exactly as it came off the
  wire. On the JSON branch it is typed `unknown` by default — deliberately not
  `any`, which would silently switch type-checking off for every field you
  touch. Per-model schemas are published by the server (each model serves its
  own OpenAPI document), not baked into this package, so supply the type you
  have: `await comfy.models.run<FluxOutput>("bfl/flux-2-pro", { prompt })`.
- **`requestId`** is the server's `X-Comfy-Request-Id` for the call — the value
  to quote in a support request, surfaced so you never have to go reading
  response headers to find one. It is `null` only when the response carried no
  such header, which a proxy error page generated before the request reached
  Comfy genuinely does not.

Note this wrapper is a **deliberate difference from the Python SDK**, which
returns the payload directly. It matches the shape a TypeScript integration
being ported from a comparable hosted-inference client already expects; it is
an intentional asymmetry, not a parity gap.

#### Binary results — a model that returns audio, image or video bytes

The run route's `200` has two branches in the contract: `application/json`, and `*/*` with `format: binary` for a partner whose generated file is the whole response. The ElevenLabs audio models (`elevenlabs/eleven_v3`, `elevenlabs/eleven_sfx_v2`) are the first of those in the catalog, and they answer with `audio/mpeg` bytes. `run` reads the response `Content-Type` before it touches the body and hands those bytes back untouched — not base64, not wrapped in an object:

```ts
import { writeFile } from "node:fs/promises";

const result = await comfy.models.run("elevenlabs/eleven_v3", {
  text: "[excited] Ship it!",
  output_format: "mp3_44100_128",
});

if (result.kind === "binary") {
  // Node — straight to disk; `data` is a Uint8Array of the exact bytes.
  await writeFile("dialogue.mp3", result.data);

  // Browser — hand it to an <audio> element, or download it.
  const blob = new Blob([result.data], { type: result.contentType }); // "audio/mpeg"
  const url = URL.createObjectURL(blob);
} else {
  // A JSON-answering model (most of the catalog) lands here.
  console.log(result.data);
}
```

`contentType` is the partner's own media type forwarded verbatim — remote input, not a value this SDK vouches for. A blob typed `text/html` or `image/svg+xml` and handed to `URL.createObjectURL` runs script in your origin the moment it is opened, so pin the type you expect — `new Blob([result.data], { type: "audio/mpeg" })` — anywhere the result might be navigated to rather than played.

Checking `result.kind` is also what narrows the type: TypeScript will not let you pass `result.data` to `writeFile` until it knows the result is the binary one. If you know a given model's branch, assert it — `if (result.kind !== "binary") throw new Error("expected audio")` — rather than casting.

A media type is JSON if its subtype is `json` (`application/json`, and the `text/json` some providers still send) or carries the structured `+json` suffix; anything else is bytes. The response carries `X-Content-Type-Options: nosniff`, so the partner's declared type is taken at its word and never guessed at from the body. The one exception is a `2xx` that declares **no** `Content-Type` at all: that body is parsed as JSON if it parses, and is otherwise a binary result with `contentType: ""`. A response that says `application/json` and then isn't still raises `ComfyError` with `code: "unexpected_response"`.

The whole body is buffered in memory; there is no streaming surface yet.

Failures raise a `ComfyError`, and `requestId` is on the error too — an error
response is exactly when you need one, as are `retryAfter` (the pace the server
named, when it named one) and `idempotencyKey` (the key the failed call went out
under, including one `run` minted for you). `code` carries the server's coarse
failure bucket (`model_not_found`, `invalid_input`, `provider_timeout`,
`content_policy_violation`, ...), and the familiar buckets keep their existing
classes: `Unauthorized`, `Forbidden`, `InsufficientCredits`, and `NotFound`
for an ID that names no model. A model-level validation failure keeps its
per-field detail on `error.details.detail`.

An `Idempotency-Key` is sent on every call; one is minted per call unless you pass your own. Every attempt within one call — the first and every retry — sends that same key, so a retry after a lost or 5xx-ed response is a replay rather than a second generation, and a second charge. Supplying your own key extends that across calls: a fresh `run` with a key you already used replays the original result instead of running the model again.

```ts
const { data, requestId } = await comfy.models.run(
  "bfl/flux-2-pro",
  { prompt: "a cat" },
  { timeoutMs: 300_000, signal: controller.signal },
);
```

`run` accepts a third options argument: `signal`, `timeoutMs`, `maxBytes`, `idempotencyKey`, and `retry`.

The default deadline is **20 minutes** — minutes rather than seconds, because the finished generation is the response and a short default would abort work that had already been paid for. It covers the whole call, retries included, rather than restarting per attempt, which is also why it is twenty and not ten: Comfy's own deadline is ten minutes, so a default of ten would leave nothing for the collect described below. Pass `timeoutMs: null` to disable it, and prefer pairing that with a `signal`.

#### How much of a response it will buffer

The whole body is held in memory: one call resolves with one finished result, so there is no streaming surface to hand it to you through. `maxBytes` is the ceiling on that, defaulting to **64 MiB** (`DEFAULT_MAX_RESPONSE_BYTES`, exported) — comfortably above what the catalog returns today, and short of letting a pathological or mis-routed response allocate without bound in your process.

```ts
// A larger generation than the default allows for.
await comfy.models.run("some/video-model", { prompt }, { maxBytes: 512 * 1024 * 1024 });

// No cap at all — you would rather have the allocation than the error.
await comfy.models.run("some/video-model", { prompt }, { maxBytes: null });
```

It is checked twice, because the two checks catch different responses. A `Content-Length` over the cap is refused **before the body is read** and the connection is dropped, so the oversized response is never downloaded rather than downloaded and discarded. The bytes actually read are then counted against the same cap, since a chunked response declares no length at all and a declared one is a claim by the sender rather than a bound on it.

A result over the cap raises a `ComfyError` with `code: "response_too_large"`, carrying `maxBytes` and the offending size on `details`. It is **not retried** — it is a verdict about the response rather than a transport failure, and re-asking would re-download the same oversized body on every attempt. Check `details.maxBytes` rather than the code alone if you branch on it: `code` on an error derived from a response is whatever the server's `X-Comfy-Error-Type` said, so an upstream can answer with the same string, and only a cap breach raised here carries `maxBytes`.

The cap never changes what a response _means_. A response `run` is going to retry or collect is classified from its status and headers, and its body is dropped unread — so an intermediary answering a `503` with a huge error page does not turn a retryable failure into a fatal one, and does not abandon a generation the server is still holding behind a `409`/`504`. An error response `run` does hand back is truncated at the cap instead of refused, so an oversized error body still arrives as `Unauthorized`, `InsufficientCredits`, or whatever bucket its status and header name.

#### Retries

| Setting                 | Default              | What it does                                                          |
| ----------------------- | -------------------- | --------------------------------------------------------------------- |
| `retry.budgetMs`        | `120_000` (2 min)    | Total wall clock, from the first attempt, in which retries may happen |
| `retry.baseDelayMs`     | `500`                | Backoff before the first retry; doubles per attempt                   |
| `retry.maxDelayMs`      | `8_000`              | Ceiling for one backoff, applied before jitter                        |
| `retry.collectBudgetMs` | `1_200_000` (20 min) | Wall clock for the collect loop below, from the same first attempt    |

**Only a transport failure or a 5xx is retried.** A `404`, `422`, or a `content_policy_violation` is the server's answer about this request, and sending it again buys the same verdict twice — so those raise immediately. A terminal bucket that arrives under a 5xx (`X-Comfy-Error-Type: content_policy_violation`) is treated the same way.

The bound is **elapsed time, not an attempt count**. On a route that holds the connection for the whole generation, "3 retries" says nothing about how long the call can take; a clock does. Each backoff is jittered — half the delay fixed, half random — so clients that failed against the same incident do not re-land on the recovering server as one wave. When the budget runs out, the last failure the server actually gave is what raises.

Two attempts is a good rule of thumb for the default budget against a slow surface, and dozens against a fast-failing one; that is the point of budgeting by clock rather than by count.

Pass `retry: false` for a single attempt, or narrow it per call:

```ts
await comfy.models.run("bfl/flux-2-pro", { prompt: "a cat" }, { retry: false });
await comfy.models.run("bfl/flux-2-pro", { prompt: "a cat" }, { retry: { budgetMs: 30_000 } });
```

#### Collecting a generation after a lost response

There is a second, narrower loop underneath the retries, and the server is the one that asks for it. Two answers mean "the generation your `Idempotency-Key` already names has not finished — wait, then ask again for THAT one", and Comfy pairs each with a `Retry-After` saying how long to wait:

- a **`409`** carrying `X-Comfy-Error-Type: concurrency_limit_exceeded` — an earlier attempt of this same call is still in flight. It is what a re-send after a dropped connection meets, and it is not the same thing as the `429` that shares the bucket, where the workspace slot pool is full and nothing is running under your key.
- a **`504`** carrying `X-Comfy-Error-Type: deadline_exceeded` — Comfy stopped holding the connection at its own ten-minute bound while the provider carried on generating.

`run` collects those for you rather than raising them: it waits the interval the server named, re-sends the same key, and resolves with the generation when it arrives — no second dispatch, and no second charge. Nothing needs enabling.

It gets **its own budget**, `collectBudgetMs`, defaulting to twenty minutes, because a collect has to outlast the deadline that produced it: a `504` arrives AT Comfy's ten-minute bound, so a two-minute budget measured from the first attempt is long spent by then and the collect it exists for could never start. The ordinary `budgetMs` is unchanged by this — a refused connection still gives up after two minutes.

Three things bound it, and the call's own `timeoutMs` is the outermost:

```ts
// The default deadline (20 min) is what makes room for a 504 collect. A
// SHORTER one wins over collectBudgetMs and forfeits that collect, since the
// 504 cannot arrive before a deadline under ten minutes has already fired.
// The 409 collect still works inside a short deadline: it arrives in
// milliseconds, not at a ten-minute bound.
await comfy.models.run("bfl/flux-2-pro", { prompt: "a cat" }, { timeoutMs: 60_000 });

// Switch the collect off and have those answers raised instead, leaving
// ordinary retries alone. `retry: false` switches off both.
await comfy.models.run("bfl/flux-2-pro", { prompt: "a cat" }, { retry: { collectBudgetMs: 0 } });
```

A `409` that carries **no** `Retry-After` is not this: it is the contract's deterministic key refusal — the key names a different request, or its answer can no longer be replayed — and the answer is a new key, not a wait. It raises on the first attempt.

When the collect budget (or the deadline) runs out, the server's own last answer is what raises, never a synthetic "retries exhausted" — and it carries what a manual re-ask needs:

```ts
try {
  await comfy.models.run("bfl/flux-2-pro", { prompt: "a cat" }, { idempotencyKey: myKey });
} catch (err) {
  // `retryAfter` alone means "wait": a 429 throttle carries one too. These two
  // codes are the ones where the wait is for a generation still running under
  // your key.
  if (
    err instanceof ComfyError &&
    err.retryAfter !== null &&
    (err.code === "concurrency_limit_exceeded" || err.code === "deadline_exceeded")
  ) {
    // Still running. Ask again later under err.idempotencyKey — the same key —
    // and Comfy hands back that generation instead of starting another.
    console.log(err.code, err.httpStatus, err.retryAfter, err.idempotencyKey);
  }
}
```

This mirrors the Python SDK's collect loop (`is_collectable` / `collect_max_elapsed` in `comfy_sdk/retry.py`), sized the same way; `src/sdk/surface-parity.test.ts` compares the two budgets so they cannot drift apart.

#### Cancelling a call

Because the server holds the connection for the whole generation, "stop this one" is an ordinary request rather than an edge case — and it is also the cheap exit, since a call the client disconnects from is not billed. `signal` is what makes that reach the server:

```ts
const controller = new AbortController();
document.querySelector("#cancel")?.addEventListener("click", () => controller.abort());

await comfy.models.run("bfl/flux-2-pro", { prompt: "a cat" }, { signal: controller.signal });
```

The abort aborts the underlying connection, so the server observes a disconnect rather than a client that merely stopped listening, and it stops the retry loop between attempts as well as during one. It rejects with the standard `AbortError` — your own abort, re-thrown untouched rather than dressed up as an SDK error, so `err.name === "AbortError"` tells "I cancelled this" apart from a transport failure (a `TypeError`) and from this SDK's own deadline (a `ComfyError` with `code: "request_timeout"`).

### `comfy.models.submit(model, input)` — queue it, collect it later

`run` holds one connection open until the generation is finished. When the caller cannot wait that long — a web request that has to return now, a worker that submits in one process and collects in another, a batch that should be in flight all at once — submit it to the queue instead:

```ts
const handle = await comfy.models.submit("bfl/flux-2-pro", { prompt: "a cat" });

handle.requestId; // with the model id, all another process needs
(await handle.status()).status; // 'IN_QUEUE' / 'IN_PROGRESS' / 'COMPLETED'
const { data } = await handle.get(); // waits, then returns the provider payload
```

`submit` sends the same request `run` does — the same model id, the same native body, the same `/v2/models/{provider}/{model}` prefix with a `requests` collection under it — and resolves as soon as the server has **accepted** it. The queue is the server's: ordering, admission, retries, timeouts, billing and expiry are all decided there, and this SDK adds polling and ergonomics on top of it and nothing else.

The handle carries four operations:

| Operation                 | What it does                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handle.status()`         | one authoritative poll, resolved as a `QueueUpdate` (`status`, `completed`, `queuePosition`, `errorType`, `retryAfterMs`, `raw`)                            |
| `handle.get(options?)`    | poll to completion, then resolve to `{ data, requestId }` — the same `RunResult` shape `run` returns, with the provider's own payload in `data`             |
| `handle.cancel()`         | ask the server to cancel, as a `PUT`. A request, not a guarantee: a request that already completed stays completed, and the next `status()` is what is true |
| `handle.events(options?)` | the poll loop with its updates exposed — an async iterable yielding the first observation, every change of status or queue position, and the completion     |

Polling is **poll-authoritative**: there is no stream to reconcile against on this surface, and `events()` is the poll loop rather than SSE. It backs off adaptively, and a `Retry-After` the server names on a poll beats that schedule — the server knows its own pace — capped at 60 seconds so one header cannot park a caller behind it.

**A `200` is not the same thing as a success here.** The server reports a failed _and_ a cancelled request as `COMPLETED` carrying an `error_type`, so `get()` rejects with the matching typed exception from [`routerErrors`](#router-errors-comfymodelsrun) rather than handing the failure back as a result. `events()` deliberately does not reject **for that case** — a completion carrying an `error_type` is yielded as an observation, because `events()` is a view of the queue's progress and `get()` is the one that collects. It can still reject for reasons that are not the request's own outcome: a transport failure, an exhausted `timeoutMs`, or an aborted `signal`. So keep those handlers; it is only the completion error that arrives as data rather than a throw.

Rebuild a handle in another process from the two ids that address the request, with no call made:

```ts
const handle = comfy.models.handle("bfl/flux-2-pro", requestId);
const { data } = await handle.get();
```

Both ids are needed because both address the route (`/v2/models/{provider}/{model}/requests/{request_id}`), and both are validated locally before anything is sent — a malformed model id, or a `requestId` that is not one printable path segment of at most 256 characters, throws a `TypeError` rather than being pasted into a URL.

### `comfy.models.subscribe(model, input, options)` — submit, follow, collect

```ts
const { data } = await comfy.models.subscribe(
  "bfl/flux-2-pro",
  { prompt: "a cat" },
  {
    onQueueUpdate: (update) => console.log(update.status, update.queuePosition),
    timeoutMs: 300_000,
  },
);
```

`submit` + poll + `get`, in one call, for a caller who does want to wait but also wants to show progress. It resolves to the same `{ data, requestId }` `run` would have returned. `onQueueUpdate` is awaited if it returns a promise, so an `async` callback finishes before the next poll; an exception it raises propagates and abandons the wait, and the request keeps running server-side.

`timeoutMs` is a **client-side** bound with no server-side meaning — the queue's own timeouts are the server's. It covers the submit, every poll, every retry of one, the pauses between them, and the result fetch. It does **not** cover time spent inside your own `onQueueUpdate` callback: the deadline and `signal` are checked by the poll loop, and a callback is awaited between polls, so a callback that returns a promise which never settles parks `subscribe` indefinitely and neither the timeout nor an abort will fire. That is deliberate and matches how a callback that _throws_ is treated — it is your code, and tearing down a healthy request because of it would be destructive — but it means an `async` `onQueueUpdate` should carry its own bound. When it runs out — or when `signal` aborts — `subscribe` makes one best-effort `cancel()`, so a caller who has stopped waiting is not also still paying for a generation nobody will collect, and then rejects. **That applies only once the submit has returned a handle**: `subscribe` submits before it has anything to cancel, so a deadline that expires during the submit itself — or a submit the server accepted whose response was lost — leaves a request running with no handle to address it. That window is what `idempotencyKey` below is for: re-submitting under the same key replays the original acceptance and returns the same request rather than queueing a second one, which is the only way back to an id that was lost with its reply. Best-effort is literal: a cancel that itself fails is swallowed, because the timeout is the failure worth reporting and a masked one sends you looking in the wrong place. Use `submit` when the request should outlive the caller's patience.

The same bound is available on `handle.get()` and `handle.events()`, where it rejects **without** cancelling: the queue is the server's, and a local clock running out says nothing about it. The first poll is always made, so `timeoutMs: 0` reads "look once".

Each `submit` **call** mints one fresh `Idempotency-Key`: two deliberate submits of the same input are two requests, while a transport-level retry inside one call keeps the one key and replays the original acceptance rather than queueing a second generation. Pass `idempotencyKey` to choose it yourself — the case that earns it is a lost response, where the request may have been accepted and its id lost with the reply.

This surface is **gated server side**. A caller the queue is not switched on for is answered `403 not_enabled`, which arrives as `routerErrors.NotEnabled` — nothing about the request is wrong, and it is terminal, so it is not retried.

> The queued methods raise `routerErrors.*` rather than the `ComfyError` family `run` maps its failures into. That difference is deliberate and matches the Python SDK: a queue failure is reported as an `error_type` inside a `200` body, where there is no HTTP status to classify and the bucket is the only thing there is.

### Image to image — upload an asset first

An image-to-image model takes an image _as input_, and Router forwards the
model's native body unchanged — so the image goes in whatever form the
provider documents. Most URL-taking models want a URL the provider can fetch,
and your local file doesn't have one yet. Give it one by uploading it as an
asset and handing the model the asset's download URL:

```ts
import { Comfy, comfy } from "@comfyorg/sdk";

// Both surfaces read COMFY_API_KEY when nothing was passed, so one variable
// in the environment configures this whole snippet.
const client = new Comfy();

// 1. Upload the local image (dedup-aware; a re-run re-uploads nothing) and
//    resolve a short-lived, self-authorizing signed URL for it.
const asset = client.assets.fromFile("photo.png");
const { url } = await asset.getDownloadUrl();

// 2. Pass that URL wherever the model's own input schema takes an image.
const { data } = await comfy.models.run("wan/wan2.5-i2i-preview", {
  input: { images: [url], prompt: "Make it golden." },
  parameters: { size: "768*768" },
});
```

`Asset.getDownloadUrl()` commits the asset if needed (hash → dedup probe →
upload, exactly like submitting it in a workflow) and resolves to the same
`{ url, expiresAt }` as an output's `getDownloadUrl()`: on Comfy Cloud /
serverless a signed storage URL any fetcher can read until `expiresAt`
(`null` when the URL carries no expiry the SDK can read) — which is what
lets the provider behind Router pull your image without your API key. Mind
the two caveats that follow from that: the URL is short-lived, so resolve it
right before the run rather than storing it; and on a _self-hosted_ backend
the URL is the auth-guarded content endpoint, which an external provider
cannot fetch — upload to Comfy Cloud (the default assets surface) for Router
inputs.

Some models take images inline instead of by URL — `bfl/flux-2-pro`'s
`input_image` is base64, for example — and then there is nothing to upload:

```ts
import { readFileSync } from "node:fs";

const imageB64 = readFileSync("photo.png").toString("base64");
const { data } = await comfy.models.run("bfl/flux-2-pro", {
  prompt: "make it watercolor",
  input_image: imageB64,
});
```

Which form a model takes is in its input schema, which
`comfy.models.schema(model)` fetches for you (below), or the model's page in
the [Router model catalog](https://docs.comfy.org/development/comfy-router/models).

### Discovering models — `comfy.models.list()` and `comfy.models.schema()`

You do not have to know a model ID (or its arguments) up front. `list()` walks
the catalog `run()` accepts IDs from, and `schema()` returns the OpenAPI
document Router publishes for one model — so listing the catalog, reading one
model's schema and running it are three calls on the same namespace, with the
same credential, base URL, error mapping and `requestId` capture:

```ts
import { comfy } from "@comfyorg/sdk";

comfy.config({ credentials: "comfyui-..." });

// Every model, across every page — `list()` follows the cursor for you.
for await (const model of comfy.models.list()) {
  console.log(model.id, model.provider, model.model);
}

// One model's published input AND output schemas, as an OpenAPI document.
const result = await comfy.models.schema("bfl/flux-2-pro");
if (!result.unchanged) {
  console.log(Object.keys(result.document as Record<string, unknown>));
}

const { data } = await comfy.models.run("bfl/flux-2-pro", { prompt: "a cat" });
```

**`list()` iterates models, not pages.** The catalog is cursor-paginated with
a server-chosen page size (20 at the time of writing), so a method that handed
back one page would make "the first twenty models, with no error to say so"
the default outcome. Nothing is sent until the iteration starts, and each
iteration is a fresh walk.

If you are driving your own pagination — a "load more" button, say — take one
page instead. Paginate by what came back, never by the `limit` you asked for:
a value above the server's maximum is clamped rather than refused.

```ts
const page = await comfy.models.list({ limit: 50 }).page();
page.data; // CatalogModel[]
page.hasMore; // the ONLY thing that says the walk is over
page.nextCursor; // opaque — round-trip it, never parse it
page.limit; // the size actually served, which may be smaller than 50

// `hasMore` is the guard, not a formality: at the end of the walk
// `nextCursor` is `null`, and `list` ignores a null cursor — so following it
// unguarded silently re-serves page one.
const next = page.hasMore ? await comfy.models.list({ cursor: page.nextCursor }).page() : null;
```

**`schema()` revalidates with `ETag`.** The route ships `ETag` and
`Cache-Control` precisely so a client can cache a document and re-check it
cheaply, and a per-model schema changes rarely. Store the tag next to your
copy and pass it back; a `304` resolves as an explicit `unchanged: true`
rather than throwing or handing you an empty document:

```ts
let cached: { document: unknown; etag: string | null } | undefined;

const fresh = await comfy.models.schema("bfl/flux-2-pro", { etag: cached?.etag });
if (!fresh.unchanged) cached = { document: fresh.document, etag: fresh.etag };
// else: `cached` is still current, and no document crossed the wire.
```

The document is returned as **data** and is not validated here — no validator
is a dependency of this package. That is deliberate: these are OpenAPI 3.0.2
documents, so JSON Schema draft-04 plus `nullable`, which stock Ajv does not
cover; a consumer that validates against one wants `ajv-draft-04` and its own
decisions about it. Type the document yourself if you have a type for it —
`schema<OpenAPIV3.Document>(...)` — exactly as `run<TData>` takes one.

Both routes are pinned to the vendored contract the same way `run`'s is: the
route-coverage check in `src/sdk/router-spec-contract.test.ts` maps every
operation `spec/router-openapi.yaml` declares to the `comfy.models` method
that calls it, so the next route a sync adds fails CI rather than sitting
unreachable.

### Pointing `comfy.models` somewhere else

`comfy.models` talks to the Comfy API host that fronts the model router
(`https://api.comfy.org`), which is **not** the same surface `new Comfy()`
talks to: that one speaks the Comfy API v2 job/asset routes, which a
self-hosted proxy or a serverless deployment also serves. They are two
settings, and pointing one at the other 404s.

Set `comfy.config({ baseUrl })`, or the `COMFY_ROUTER_BASE_URL` environment
variable, to reach a staging deployment or a local stub — explicit config
wins, and a value that is not an http(s) URL without query or fragment is an
error rather than a silent fallback to the default. `COMFY_BASE_URL` is the
class client's setting and is untouched by this.

**To run a workflow _graph_** — your own ComfyUI node graph rather than a
partner model — use the class client instead: `await new Comfy({ apiKey
}).run(workflow)`, as in the Quickstart below.

### Module formats

The package is **ESM-only** — it publishes no CommonJS build, and its
`exports` map has a single `default` condition. In practice:

- ESM consumers (`import`): supported, the primary path.
- CommonJS consumers on Node >= 22.12: `require("@comfyorg/sdk")` works via
  Node's built-in `require(esm)`. In TypeScript this needs `"module":
"nodenext"`; under `"module": "node16"` a static import from a CommonJS
  file is rejected (`TS1479`) and you need `await import("@comfyorg/sdk")`.
- Node 22.0-22.11 CommonJS: use `await import("@comfyorg/sdk")`.

## Targeting another deployment

`new Comfy()` points at Comfy Cloud and takes no base-URL argument. To run
against a serverless deployment or a self-hosted instance behind
`comfy-api-proxy`, set `COMFY_BASE_URL` in the environment:

```bash
export COMFY_BASE_URL="https://<deployment>.run.comfy.app"  # serverless
export COMFY_BASE_URL="http://127.0.0.1:8189"               # self-hosted proxy
```

It is read each time a client is constructed, must be an `http(s)` URL, and
an unset or blank value (including whitespace-only) means Comfy Cloud.

It also decides whether a missing credential is an error: see "Auth, per
surface" above. Comfy Cloud is matched by normalized origin and path rather
than by string, so `https://cloud.comfy.org:443` is still Comfy Cloud, while a
deployment mounted under that host (`https://cloud.comfy.org/self-hosted`) is a
different target and may go keyless.

Upgrading from an earlier version: `new Comfy(url, opts)` becomes
`new Comfy(opts)` with `COMFY_BASE_URL` set. A positional string now throws a
`TypeError` rather than being silently ignored.

## Quickstart

```ts
import { Comfy } from "@comfyorg/sdk";

const client = new Comfy({ apiKey: "comfyui-..." });

const wf = await client.workflows.fromFile("workflow_api.json");
const job = await client.run(wf); // submit + poll to a terminal state; throws on failure
const outputs = job.getOutputs("13"); // outputs produced by node "13"
await outputs[0].toFile("out.png");
```

`run()` submits and polls to completion in one call. If you want to act on
the job in between (read `job.status`, stream progress, cancel it), use
`submit()` and drive the job yourself:

```ts
const job = await client.submit(wf);
await job.wait(); // poll to terminal (adaptive backoff); or call job.refresh() yourself
console.log(job.status, job.outputs);
```

## Building a workflow

`client.workflows` has three constructors for the same API-format graph, so
the graph does not have to be a file on disk:

| Constructor                             | Input                                                        |
| --------------------------------------- | ------------------------------------------------------------ |
| `await client.workflows.fromFile(path)` | a JSON file on disk (the only async one — it reads the file) |
| `client.workflows.fromJson(graph)`      | an already-parsed graph object, used as-is (not copied)      |
| `client.workflows.fromString(text)`     | JSON text you already hold in memory                         |

`fromJson` is the one to reach for when your app builds the graph in code —
a template it fills in per request — rather than shipping a
`workflow_api.json` next to it:

```ts
const wf = client.workflows.fromJson({
  "4": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "v1-5-pruned-emaonly.safetensors" },
  },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
  // … the rest of the graph
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["8", 0] } },
});

wf.setInput("6", "text", "a red fox in the snow"); // fill the prompt in per request
const job = await client.run(wf);
```

All three return the same `Workflow`, so everything else — `setInput`,
embedded asset handles, `run`/`submit` — behaves identically no matter how
the graph was constructed. The graph is the **API format** (ComfyUI's "Save
(API Format)"): an object keyed by node id, where a link to another node's
output is `[nodeId, slotIndex]`. It stays a plain mutable object as
`wf.json` if you would rather edit it directly, and `setInput(nodeId, field,
value)` is sugar for `wf.json[nodeId].inputs[field] = value` that also
accepts an asset handle. None of the three validates the graph — a UI-format
export is caught at submit time, where it throws `WorkflowFormatUi` locally
before any request goes out.

## Partner (API) node auth

Workflows that use partner/API nodes (Gemini, etc.) need a Comfy API key to
authenticate them. Pass it per submit with `apiKey`. This is **not** the same as
the credential you construct `Comfy` with: the constructor key authenticates
_you_ to the server, while this one authenticates the partner nodes _inside_ the
workflow (it is often the same `comfyui-…` key):

```ts
const job = await client.run(wf, { apiKey: "comfyui-…" });
// or: await client.submit(wf, { apiKey: "comfyui-…" });
```

The SDK sends it once as `extra_data.api_key_comfy_org` alongside the workflow —
one key authenticates every partner node in the graph. It is never logged or
persisted by the SDK. Omit `apiKey` and no `extra_data` is sent at all.

## Assets and `core/ASSET`

`client.assets.fromFile(path)` / `client.assets.fromBytes(data, options)`
return a **lazy** asset handle: nothing is hashed or uploaded until the
handle is actually used. Embed the handle directly in a workflow input with
`wf.setInput(...)`:

```ts
const asset = client.assets.fromFile("photo.png");
wf.setInput("10", "image", asset);
```

On submit, the SDK walks the workflow graph, finds every embedded handle,
and for each one: hashes the bytes locally (blake3, via
[`hash-wasm`](https://www.npmjs.com/package/hash-wasm) — pure WebAssembly,
no native addon), probes the server's dedup fast path, and only streams a
full upload if the server does not already have those bytes. Each handle is
then substituted in place with a `core/ASSET` reference
(`{ __type: "core/ASSET", info: { id, hash, file_path } }`) before the
workflow is sent. Re-running a script against unchanged files re-uploads
nothing.

`client.assets` also has `fromStream`, `fromUrl`, and `get(assetId)` (to
rehydrate a handle for an asset that is already committed) for less common
cases — see the type definitions for details.

An uploaded asset can also hand out a directly-fetchable URL for its bytes —
`asset.getDownloadUrl()`, the same `{ url, expiresAt }` an output resolves to
(it commits first if needed). That is how a local image reaches a service
that fetches by URL, e.g. an image-to-image model behind Comfy Router — see
[Image to image — upload an asset first](#image-to-image--upload-an-asset-first).

A committed asset also exposes `jobId` — the ID of the job that produced it,
`undefined` for an asset you uploaded yourself (which has no producing job)
— and `expiresAt`, its retention deadline (`undefined` if it never expires).
Delete one with `asset.delete()` on a handle you already hold (throws if the
handle was never committed — there's nothing to delete yet), or
`client.assets.delete(id)` to delete by UUID without fetching first. Deleting
needs a `comfy-api-proxy` new enough to serve `DELETE /api/v2/assets/{id}`;
an older proxy returns `405`.

## Live progress

`job.events()` is a typed, auto-reconnecting async iterator over the job's
live event stream:

```ts
const job = await client.submit(wf);
for await (const event of job.events()) {
  switch (event.kind) {
    case "progress":
      console.log(event.value);
      break;
    case "outputReady":
      await event.output.toFile(`${event.output.name}`);
      break;
    case "statusChange":
      if (event.status === "succeeded") break;
  }
}
```

The stream carries no replay cursor, so a dropped connection is reconnected
from "now," not replayed from the start. Polling stays the source of truth
for whether the job is actually done: if the stream is throttled, drops
permanently, or never even connects, `events()` falls back to polling
`GET /jobs/{id}` to detect the terminal state, so consumers never hang
waiting on a stream that isn't coming back. If you only care about the
final result, `run()`/`job.wait()` (poll-only, no SSE) is simpler.

## Cancellation and timeouts

`submit`, `run`, `wait`, `events`, and `cancel` all accept an `AbortSignal`,
which stops both the in-flight request _and_ any internal wait (the queue-full
retry pause, the poll backoff, the SSE reconnect pause) — an abort takes
effect immediately rather than only after the current network call returns:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000); // give up after 30s

const job = await client.submit(wf, { signal: controller.signal });
await job.wait(undefined, controller.signal);
```

`run()` also takes a plain `timeoutMs` if you just want a deadline without
managing an `AbortController` yourself:

```ts
await client.run(wf, { timeoutMs: 60_000 });
```

## Downloading outputs

A finished job exposes its results as output handles — `job.outputs`, or
`job.getOutputs(nodeId)` to filter to one node. Each is an asset you can pull
down whichever way suits the caller, and each carries `jobId` — the ID of
the job that produced it, for tracing a file back to the job that made it:

```ts
const out = job.getOutputs("13")[0];
await out.toFile("result.png"); // stream to disk
const data = await out.toBytes(); // buffer into memory
await out.toFile("head.png", { range: [0, 1023] }); // range-aware: first 1 KiB only
```

Outputs are not image-only: `out.type` is the kind discriminator —
`"image" | "video" | "audio" | "text" | "file" | "latent"` — and
`out.contentType` carries the MIME type the server reported. Every download
method above works the same way on all of them, so a job that saved audio or
video is read exactly like one that saved a PNG:

```ts
const [track] = job.getOutputs("9"); // e.g. a SaveAudioMP3 node
track.type; // "audio"
track.contentType; // "audio/mpeg"
await track.toFile("track.mp3");
```

`getDownloadUrl()` hands back a fetchable URL instead of streaming the bytes
through your process — give it to a browser, a CDN, or another service:

```ts
const { url, expiresAt } = await out.getDownloadUrl();
```

That is what you want for media a browser plays rather than your server
processes — the bytes never pass through your process at all. On Comfy Cloud
and serverless the URL is self-authorizing, so a page can put it straight in
an `<audio>`/`<video>` element with no API key of its own; on a self-hosted
proxy it is the asset's content URL and normal auth still applies (see
below).

```ts
const [track] = job.getOutputs("9");
if (track.type === "audio") {
  const { url } = await track.getDownloadUrl();
  // hand `url` to the page: <audio src={url} controls />
}
```

On Comfy Cloud / serverless it's a short-lived, **self-authorizing** signed
storage URL: whoever holds it can read the asset until `expiresAt` with no API
key of their own. On a self-hosted proxy it's the content endpoint (normal auth
still applies) and `expiresAt` is `null`. It works on every backend and never
downloads the bytes first.

## The workflow behind a job

A job handle rehydrated by ID alone — `await client.jobs.get(jobId)` — has
no record of what it ran; `job.getWorkflow()` recovers it:

```ts
const job = await client.jobs.get(jobId);
const { workflow, format } = await job.getWorkflow();
```

`format` says which shape you got, and callers must branch on it — which one
comes back depends on how the job was submitted, not on anything the caller
controls per-request:

- `"api"` — the executed graph: frontend-only constructs (Note nodes,
  Get/Set) are already resolved away.
- `"save"` — the authoring workflow at the version the job ran, canvas
  layout and editor-only nodes intact. Only returned for a job pinned to a
  specific workflow version.

Jobs submitted through this SDK always get `"api"` today, since v2
submission has no version-pinning fields yet. It 404s for an unknown ID, a job that
is not yours, a job past retention, or a job whose workflow the server no
longer holds.

## What a job printed

`job.getLogs()` fetches the run's captured execution log via
`GET /api/v2/jobs/{id}/logs` — whatever the workflow's own code and nodes wrote
to standard output, in order:

```ts
const job = await client.run(wf);
const logs = await job.getLogs();
if (logs !== null) {
  process.stdout.write(logs.text); // untrusted text: render it, never interpret it
  if (logs.truncated) console.warn("(beginning of the log was shed; this is the tail)");
}
```

`null` is the ordinary answer for a job with no log, not an error, and it does
not say why: the surface captures no logs at all, the job has not finished, the
run was killed before the worker could report its output, or the log is
withheld. Today only a job run on a serverless deployment (a
`{deployment}.run.comfy.app` host) has a log; Comfy Cloud captures none and
answers `null` for every job. Read it after a terminal status; a `null` read
after that is final. The SDK follows
the job's own `urls.logs` link and returns `null` without a request when the
server offers none, which is a surface saying it captures no logs for any job.
It 404s under the same conditions `client.jobs.get()` does: unknown, not yours,
or past retention.

## Typed errors

Protocol-level failures are raised as one exception class per error code, so
you can catch what you actually expect instead of string-matching messages:

Catch these SDK-level exceptions around `Comfy` methods. Public asset, job,
event, and output helpers translate protocol errors; raw low-level exceptions
are only exposed by direct `ComfyLow` calls.

- `Unauthorized`, `Forbidden`, `NotFound`
- `InvalidWorkflow` (and `WorkflowFormatUi`, for submitting a UI-export
  instead of an API-format graph)
- `MissingAsset` — a `core/ASSET` reference the server couldn't resolve
- `HashMismatch` — uploaded bytes didn't match the declared hash
- `BlobNotFound`
- `IdempotencyKeyReuse` — the `Idempotency-Key` was reused. `submit()` (and
  `run()`) attach a fresh key to every call, so an accidental exact resend never
  runs the workflow twice. Keys are single-use (reject-on-duplicate, no replay),
  so reusing your own explicit `idempotencyKey` throws this. After an ambiguous
  failure, poll or list your jobs instead of resubmitting with the same key.
- `InsufficientCredits`
- `QueueFull` (carries `retryAfter: number | null`; `submit()` retries 429
  responses with `Retry-After` for a bounded budget, including deployment warm-up)
- `JobFailed` — a job reached a non-`succeeded` terminal state (carries the
  node-level `error` detail when the platform provided one)

All extend a shared `ComfyError` (`code`, `httpStatus`, `details`, `requestId`, `retryAfter`, `idempotencyKey`). `retryAfter` is the pace the server named for re-sending this exact request, and is `null` whenever the response carried no `Retry-After`. `idempotencyKey` is the key the failed call went out under: every `ComfyError` that `comfy.models.run` raises once a request has gone out carries one — including a key it minted for you — and it is `null` only on a failure raised before any request was sent, or from a surface that stamps no key. Together they are the two things a manual re-ask needs, and the pair `comfy.models.run` uses for the collect loop above.

`QueueFull.retryAfter` is nullable when the server omits the header. This is a
breaking type change from earlier releases: check for `null` before using it in
duration arithmetic or custom backoff logic.

```ts
import { JobFailed, MissingAsset } from "@comfyorg/sdk";

try {
  await client.run(wf);
} catch (err) {
  if (err instanceof JobFailed) {
    console.error(err.error); // { code, message, node_id, class_type, traceback } | null
  } else if (err instanceof MissingAsset) {
    console.error("asset reference was not usable:", err.details);
  } else {
    throw err;
  }
}
```

### Router errors (`comfy.models.run`)

Model execution has its own error contract, and its own exception hierarchy to
match. The queued surface (`comfy.models.submit` / `subscribe` and the handle
they return) raises from this same hierarchy for every failure it reports,
including the ones that arrive inside a `COMPLETED` body rather than on a
status. Every failure carries a coarse, machine-readable `error_type` on the
`X-Comfy-Error-Type` response header; this SDK turns that value into one class
per bucket, all descending from `RouterError`. The Python SDK spells every one
of these names identically, so a snippet transfers between the two languages
unchanged.

They live in their own namespace because three of the names —
`Unauthorized`, `Forbidden`, `InsufficientCredits` — are already taken above by
the workflow-API exceptions, which are unrelated classes descending from
`ComfyError`:

```ts
import { routerErrors } from "@comfyorg/sdk";
// or, to import the classes directly:
import { ContentPolicyViolation, InvalidInput } from "@comfyorg/sdk/errors";
```

The set is closed at fifteen buckets in this release. Six are request-level:

- `InvalidInput` — the request was rejected as invalid, by the model or before
  dispatch. Carries `detail[]` (see below)
- `ContentPolicyViolation` — the model's content policy refused the request.
  Deterministic: retrying the same input will not succeed, which is why this is
  a separate class from `ProviderError` rather than a flavor of it
- `ProviderError` — the upstream model provider returned an error
- `ProviderTimeout` — the upstream provider did not respond in time (a
  Comfy-side deadline shares the same `504` but is `DeadlineExceeded`, not this)
- `InsufficientCredits`
- `ModelNotFound`

and nine are transport-level: `Unauthorized`, `Forbidden`,
`ConcurrencyLimitExceeded`, `ClientDisconnected`, `InternalError`,
`DeadlineExceeded`, `NotEnabled`, `ServiceUnavailable`, `RateLimited`.

Three of those transport buckets **share an HTTP status with an older one**,
which is the whole reason to branch on the class rather than on `httpStatus`:

- `403` is `Forbidden` (this credential is not entitled to this model) or
  `NotEnabled` (Comfy Router is not switched on for this caller yet — nothing
  about the request is wrong, and it is the answer every caller gets until the
  rollout reaches them). `NotEnabled` is terminal: do not retry it, and do not
  treat it as an outage.
- `429` is `ConcurrencyLimitExceeded` (clears when one of your own in-flight
  calls finishes) or `RateLimited` (clears only when a time window rolls).
- `504` is `ProviderTimeout` (the partner ran out of time) or
  `DeadlineExceeded` (Comfy stopped holding the connection).

`ServiceUnavailable` (`503`) is the one bucket whose condition clears on its
own, so it is the one refusal `comfy.models.run` retries by default —
with backoff, replayed under the call's own `Idempotency-Key`. Everything
below `500` is left alone, `NotEnabled` included.

Every one of them carries `errorType`, `requestId` (the server-minted id off
`X-Comfy-Request-Id` — the value to quote in a support request) and
`httpStatus`.

An `error_type` this release has never heard of — a newer server — surfaces as
a plain `RouterError` carrying the raw value in `errorType`, never as an
untyped throw. Catching `RouterError` therefore keeps working across a server
upgrade.

A response carrying **no** bucket at all — a proxy, gateway or load balancer
that answered before Router was reached — is classified from its HTTP status
where the status has one plain reading (`401` → `Unauthorized`, `404` →
`ModelNotFound`, `502` → `ProviderError`, and so on). Where it does not, the
SDK says so rather than guessing: a header-less `400`, `422`, `500` or `503`
raises the base `RouterError` with `errorType` empty and `httpStatus` intact.
A `400` is `invalid_input` _or_ `content_policy_violation` and those differ in
whether a retry can ever succeed, so guessing between them would be worse than
saying nothing. This only ever applies to responses Router did not write —
Router repeats the bucket on `X-Comfy-Error-Type` for every error it sends —
and the Python SDK classifies the same responses the same way.

`InvalidInput` is the one class with extra structure. A model-level validation
failure names the offending fields, and those entries stay structured rather
than being flattened into the message:

```ts
try {
  await comfy.models.run("owner/model", { prompt: "a cat" });
} catch (err) {
  if (err instanceof routerErrors.InvalidInput) {
    for (const d of err.detail) {
      console.error(d.loc.join("."), d.type, d.msg, d.ctx);
      // e.g. "body.image_url" "image_too_small" "..." { min_width: 512 }
    }
  } else if (err instanceof routerErrors.ContentPolicyViolation) {
    // Do not retry this one.
  } else if (err instanceof routerErrors.RouterError) {
    console.error(err.errorType, "request id:", err.requestId);
  } else {
    throw err;
  }
}
```

`d.type` is the provider's own specific reason (`image_too_small`,
`greater_than`, `unsupported_audio_format`, `missing`, ...) and `d.ctx` is the
bound it violated. Both are deliberately open — the provider vocabulary grows
on the provider's release cycle, not this SDK's — so treat an unrecognized
`type` as informational rather than switching exhaustively on it. `detail` is an
empty array for a rejection that names no field.

These classes are the error **contract** — the shared vocabulary both SDKs
spell identically, kept in step with the vendored `spec/router-openapi.yaml`.
`comfy.models.run` today reports the same buckets through `ComfyError` instead:
`err.code` is the `error_type` verbatim (`"not_enabled"`,
`"service_unavailable"`, …), alongside `httpStatus`, `requestId` and
`details`. So branch on `err.code` for a failure raised by `run()`, and use
these classes when you are classifying a Router response yourself. Routing
`run()`'s own failures through `RouterError` is a separate change: it would
move `Unauthorized`, `Forbidden`, `InsufficientCredits` and `NotFound` out of
the `ComfyError` hierarchy that catches them today.

## Two layers

- **`@comfyorg/sdk`** — the idiomatic client above: asset dedup/upload,
  `core/ASSET` substitution, idempotent submit with queue-full backoff,
  poll-authoritative job completion, typed SSE events, range-aware
  downloads, and typed errors.
- **`@comfyorg/sdk/low`** — generated types + [Zod](https://zod.dev) schemas
  plus a hand-written `fetch` transport (`ComfyLow`) with one method per API
  operation and the escape hatches the SDK layer is built on: raw `Response`
  access, unbuffered streaming bodies (for SSE and range downloads), a
  streaming multipart upload body, and per-request `AbortSignal`/timeout.
  Use this directly if you need lower-level control.

The generated part of `low` (`src/low/generated/*`) is produced by
[`@hey-api/openapi-ts`](https://heyapi.dev) from `spec/openapi.yaml`, a
vendored, filtered copy of the canonical Comfy API v2 contract (see
`spec/README.md`). Regenerate it with `pnpm generate` after the spec
changes; CI fails if the generated code has drifted from the spec.

## Related projects

Clients for the same Comfy API v2 contract:

| Project                                                                   | Language   | Package         |
| ------------------------------------------------------------------------- | ---------- | --------------- |
| [comfy-python-sdk](https://github.com/Comfy-Org/comfy-python-sdk)         | Python     | `comfy-sdk`     |
| [comfy-typescript-sdk](https://github.com/Comfy-Org/comfy-typescript-sdk) | TypeScript | `@comfyorg/sdk` |

[comfy-api-proxy](https://github.com/Comfy-Org/comfy-api-proxy) fronts a
self-hosted ComfyUI with this same v2 contract (it is the `comfy-api-proxy`
entry in the `servers` list of `spec/openapi.yaml`).

## Development

```bash
pnpm install --frozen-lockfile
pnpm lint             # oxlint
pnpm format:check     # oxfmt --check
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest run
pnpm build            # tsc -> dist/
```

Other useful scripts:

```bash
pnpm generate         # regenerate src/low/generated/* from spec/openapi.yaml
pnpm format           # oxfmt --write
pnpm test:coverage    # vitest run --coverage
pnpm check:spec-drift # fails if src/low/generated/* is stale vs. the spec
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor workflow —
setup, the checks CI runs, and the rules around generated code. Release
history is in [CHANGELOG.md](CHANGELOG.md).
