<div align="center">

<img src="assets/logo.svg" alt="Comfy" width="130"/>

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
await comfy.models.run("owner/model", { prompt: "a cat" });
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

**`comfy.models.run` does not execute anything yet.** It resolves credentials
and raises, locally and without opening a socket:

| Situation                 | Error                    |
| ------------------------- | ------------------------ |
| no credentials configured | `MissingCredentials`     |
| credentials present       | `ModelRunNotImplemented` |

Both are `ComfyError` subclasses. The second one is a placeholder: the Comfy
API v2 spec this SDK generates its types from declares no model-execution
route, and the request/response types have to come from the spec rather than
be hand-written. **To run a model today, run its workflow graph** with the
class client — `await new Comfy({ apiKey }).run(workflow)`, as in the
Quickstart below.

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

All extend a shared `ComfyError` (`code`, `httpStatus`, `details`).

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
