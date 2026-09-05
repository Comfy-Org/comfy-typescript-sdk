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

| Surface                                                            | Auth                                   |
| ------------------------------------------------------------------ | -------------------------------------- |
| Self-hosted proxy (`comfy-api-proxy` in front of your own ComfyUI) | none — do **not** pass `apiKey`        |
| Comfy Cloud                                                        | `new Comfy({ apiKey: "comfyui-..." })` |
| Serverless                                                         | `new Comfy({ apiKey: "comfyui-..." })` |

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
const { data, requestId } = await comfy.models.run("bfl/flux-2-pro", {
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

It resolves to a `{ data, requestId }` result:

- **`data`** is the provider's native payload, exactly as it came off the
  wire. It is typed `unknown` by default — deliberately not `any`, which would
  silently switch type-checking off for every field you touch. Per-model
  schemas are published by the server (each model serves its own OpenAPI
  document), not baked into this package, so supply the type you have:
  `await comfy.models.run<FluxOutput>("bfl/flux-2-pro", { prompt })`.
- **`requestId`** is the server's `X-Comfy-Request-Id` for the call — the value
  to quote in a support request, surfaced so you never have to go reading
  response headers to find one. It is `null` only when the response carried no
  such header, which a proxy error page generated before the request reached
  Comfy genuinely does not.

Note this wrapper is a **deliberate difference from the Python SDK**, which
returns the payload directly. It matches the shape a TypeScript integration
being ported from a comparable hosted-inference client already expects; it is
an intentional asymmetry, not a parity gap.

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

`run` accepts a third options argument: `signal`, `timeoutMs`, `idempotencyKey`, and `retry`.

The default deadline is **20 minutes** — minutes rather than seconds, because the finished generation is the response and a short default would abort work that had already been paid for. It covers the whole call, retries included, rather than restarting per attempt, which is also why it is twenty and not ten: Comfy's own deadline is ten minutes, so a default of ten would leave nothing for the collect described below. Pass `timeoutMs: null` to disable it, and prefer pairing that with a `signal`.

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
  if (err instanceof ComfyError && err.retryAfter !== null) {
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

All extend a shared `ComfyError` (`code`, `httpStatus`, `details`, `requestId`, `retryAfter`, `idempotencyKey`). The last two are `null` unless the failure carried them: `retryAfter` is the pace the server named for re-sending this exact request, and `idempotencyKey` is the key the failed call went out under — the two things a manual re-ask needs, and the pair `comfy.models.run` uses for the collect loop above.

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
match. Every failure carries a coarse, machine-readable `error_type` on the
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
