# AGENTS.md

Notes for automated contributors (and humans) working in this repo. Everything
here is enforced by CI — see `.github/workflows/ci.yml` and `scripts/`.

## 1. Never hand-edit a generated file

This is the trap that costs a round trip: a hand-edit to generated code reads
fine in review, passes lint/typecheck/tests, and then fails the CI step
`Check the code coupled to spec/ is in sync with it`.

Generated, do **not** edit by hand:

| Path                             | Produced by                                    |
| -------------------------------- | ---------------------------------------------- |
| `src/low/generated/types.gen.ts` | `pnpm generate` (`@hey-api/openapi-ts`)        |
| `src/low/generated/zod.gen.ts`   | `pnpm generate`                                |
| `src/low/generated/index.ts`     | `pnpm generate`                                |
| `src/low/version.ts`             | `scripts/gen-version.mjs`, run by `pnpm build` |
| `parity/python-surface.json`     | `pnpm sync:python-surface` (see section 6)     |

`spec/openapi.yaml` is also off-limits: it is a vendored, one-way sync of the
canonical Comfy API v2 contract with internal operations stripped (see
`spec/README.md`). Fix the contract upstream; do not patch the vendored copy to
make codegen emit what you want. The same goes for `spec/router-openapi.yaml`,
the vendored Comfy Router contract — nothing is generated from it, but
`src/sdk/routerErrors.ts` is checked against it (section 2).

Everything else under `src/` is hand-written — including `src/low/index.ts`,
which is the aggregator for the whole low layer, **not** codegen output. Note
that `openapi-ts.config.ts` sets `clean: true` on the output directory, so any
file you add under `src/low/generated/` is deleted on the next regeneration.
That directory is also excluded from `oxlint` (`.oxlintrc.json`
`ignorePatterns`) and from `oxfmt` (`.prettierignore`); leave both exclusions
alone. Reformatting generated output makes it differ byte-for-byte from a fresh
generation, which is exactly what the drift check compares.

### Regenerating

```bash
pnpm generate          # rewrites src/low/generated/* from spec/openapi.yaml
pnpm check:spec-drift  # same check CI runs (node scripts/check-spec-drift.mjs)
```

`scripts/check-spec-drift.mjs` regenerates into a temp directory using the same
`openapi-ts.config.ts` and compares the three files above byte-for-byte against
what is committed. There is no tolerance for whitespace or ordering. It then
runs a second, unrelated check that needs no codegen — the Router route against
`spec/router-openapi.yaml` (section 2) — and reports both, so a stale
regeneration cannot hide a moved route.

## 2. Spec-coupled hand-written code

Five hand-written things must be updated in lockstep when a vendored spec
changes. Three are coupled to `spec/openapi.yaml` and fail
`src/low/spec-coverage.test.ts`; the other two are coupled to
`spec/router-openapi.yaml` and fail `src/sdk/router-spec-coverage.test.ts` and
`src/sdk/router-spec-contract.test.ts` respectively. Only the route check
(fourth below) names the constant to fix; for the rest the failure message will
not tell you this:

- **`src/low/transport.ts` — `OPERATION_IDS`.** Must equal, as a set, the
  `operationId` of every non-internal operation in `spec/openapi.yaml`. A spec
  sync that adds an operation is not done until a transport method exists for
  it.
- **`src/low/transport.ts` — `OPERATION_METHODS`.** Maps every operation ID to
  a method name that must actually exist on `ComfyLow.prototype`. The test
  checks both directions of the mapping and the method's existence.
- **`src/sdk/routerErrors.ts` — the closed `error_type` set.** Checked against
  a _different_ spec: `spec/router-openapi.yaml`, whose
  `components.schemas.RouterErrorType.x-comfy-error-types` names every bucket,
  its tier and its meaning. `src/sdk/router-spec-coverage.test.ts` asserts the
  buckets, their order, their tier split and the class per bucket in both
  directions. Nothing is generated from that spec, so this test is its drift
  check — a Router spec sync that adds a bucket is not done until a
  `RouterError` subclass exists for it, named the PascalCase of the wire value.
  Adding one usually also needs a `routerErrorClassesAheadOfPython` entry in
  `src/sdk/surface-parity.test.ts` until the Python twin lands (section 6).
- **`src/sdk/models.ts` — `RUN_ROUTE_TEMPLATE`, and `src/sdk/credentials.ts` —
  `COMFY_ROUTER_BASE_URL`.** The path `comfy.models.run` posts to and the host
  it posts to by default, checked against `spec/router-openapi.yaml`'s
  `runRouterModel` path, its path parameters and its `servers[0].url`. Checked
  in two places on purpose: `src/sdk/router-spec-contract.test.ts` compares the
  live constants in `pnpm test`, and `scripts/check-spec-drift.mjs` compares
  the same constants read out of their source text (plain Node, no TypeScript
  loader) so `pnpm check:spec-drift` reddens too. Both messages name the
  constant to update. The vendored spec is the side that is right — a Router
  sync that moves the route is not done until the constant follows, and until
  it does `comfy.models.run` 404s. The shared spec reader is
  `scripts/router-route-contract.mjs`.
- **`src/low/models.ts`.** Holds four schemas codegen cannot reach, because
  `@hey-api/openapi-ts` only emits types reachable from an operation's
  request/response: `StatusEvent`, `PreviewEvent`, `LogEvent` (reachable only
  via the `x-sse-events` vendor extension) and `AssetReference` (the
  `core/ASSET` object embedded in workflow JSON). The test asserts their
  property lists match `components.schemas` in the spec exactly.

## 3. Public repo hygiene

This repo is public and `scripts/check-public-repo-hygiene.mjs` runs as its own
CI job. It scans every tracked text file (`git ls-files`), excluding only its
own source and `src/low/generated/`. **This file is scanned too**, as is any
doc, comment, test fixture, or commit-message-turned-doc you add. Three
categories fail the build:

1. **Ticket-shaped identifiers** — anything matching
   `\b[A-Z]{2,6}-\d{2,6}\b`. Note this is a shape, not a list of real team
   keys, so an innocent-looking token can trip it; the allowlist covers only
   things like `UTF-8`, `SHA-256`, `ISO-8601` and three specific RFC numbers.
   Branch names in this repo use ticket-shaped prefixes — do not carry one into
   a file.
2. **Internal collaboration-tool links** — Notion, Slack archive/client
   permalinks, Google Docs and Drive, Datadog, PostHog project URLs, the Linear
   app domain, and `incident-<number>` markers. Link to the public docs site,
   the GitHub issue, or nothing.
3. **References to org repos or teams outside the known-public allowlist.**
   `Comfy-Org/<name>` is default-deny: only the repos listed in the script are
   accepted, and `@Comfy-Org/<team>` handles are limited to the two teams in
   `.github/CODEOWNERS`. A new sibling repo needs an allowlist entry (with a
   comment saying it is public) before you can reference it.

A genuine false positive is fixed by extending the allowlist in the script with
a comment explaining why — not by deleting the check or excluding the file.

Keep this script in sync with `scripts/check_public_repo_hygiene.py` in the
Python SDK, per the note at the top of the file.

## 4. Checks a PR must pass

CI runs the `test` job on Node 22 **and** 24, plus two standalone jobs. Locally:

```bash
pnpm install --frozen-lockfile
pnpm lint             # oxlint .
pnpm format:check     # oxfmt --check .
pnpm typecheck        # tsc --noEmit
pnpm check:spec-drift # node scripts/check-spec-drift.mjs
pnpm check:sdk-parity # node scripts/sync-python-surface.mjs (needs network)
pnpm test             # vitest run
pnpm build            # gen-version + tsc -> dist/
```

The three other jobs:

- **`build-check`** — `pnpm build`, then `pnpm pack`, then asserts the tarball
  contains `package/dist/index.js` and `package/dist/index.d.ts`. Touching
  `files`, `exports`, `main`, `types`, or `outDir` can break this while every
  other check stays green. Reproduce with
  `pnpm build && pnpm pack --pack-destination /tmp/pack-check && tar tzf /tmp/pack-check/*.tgz`.
- **`public-repo-hygiene`** — `node scripts/check-public-repo-hygiene.mjs`.
  Pure Node, no dependencies, so you can run it in a clean checkout without
  installing anything.
- **`sdk-parity`** — `node scripts/sync-python-surface.mjs`. The only job that
  reaches the network. See section 6.

A CLA check (`.github/workflows/cla.yml`) also runs; only the PR author needs
to sign. `.github/CODEOWNERS` makes every file require review from
`@Comfy-Org/comfy-cloud-team` or `@Comfy-Org/core-engine-team`.

## 5. Non-obvious conventions

- **`tsc --noEmit` does not check test files.** `tsconfig.json` excludes
  `src/**/*.test.ts`, and Vitest does not typecheck. A type error inside a test
  is caught by no gate in this repo — read your test code carefully.
- **Relative imports must carry a `.js` extension**, including from a `.ts`
  source (`./transport.js`, `./generated/types.gen.js`). The package is ESM
  with `moduleResolution: NodeNext`. Every relative import in `src/` follows
  this; an extensionless one will not resolve at runtime.
- **Do not bump `version` in `package.json`.** Releases are tag-driven:
  `.github/workflows/publish.yml` injects the release tag's version at build
  time, so the committed value is a placeholder. `pnpm build` regenerates
  `src/low/version.ts` from whatever `package.json` says, so a version edit
  shows up as an unexpected dirty file.
- **`oxfmt` formats Markdown, not just TypeScript.** `pnpm format:check` fails
  on an unformatted `.md` file, so a docs-only PR can fail the `test` job. Run
  `pnpm format` after editing any Markdown.
- **Tests are colocated** (`src/**/*.test.ts`) and run against
  `test/support/stub-server.ts`, a real Node `http` stub of the v2 API — there
  is no request-mocking library. Add a scenario to `ServerState` rather than
  intercepting `fetch`.
- **`src/` ships in the published package**, not just `dist/` — see the `files`
  field in `package.json` — so source comments are published too.
- This SDK deliberately mirrors the Python SDK's structure (stub server, drift
  check, hygiene check, generated/hand-written split). When changing one of
  those shared mechanisms, check whether the sibling needs the same change.

## 6. Cross-SDK surface parity

`src/sdk/surface-parity.test.ts` diffs this SDK's public surface against the
Python SDK's and fails naming the symbol that diverged: the public method names
under `models`, the router error class names, the `error_type` each of those
classes maps to, and the error classes the package root re-exports.

The Python side is read from `parity/python-surface.json`, a **committed
snapshot** — generated, do not hand-edit. `parity/README.md` has the full
mechanism; the short version is that the assertion runs offline against the
snapshot in `pnpm test`, and the `sdk-parity` CI job re-derives the snapshot
from the Python SDK's default branch over HTTPS so it cannot go quietly stale.

Two things to know before you touch it:

- **A `sdk-parity` failure is usually not about your branch.** It means the
  Python SDK's surface moved. Run `pnpm sync:python-surface`, commit the
  refreshed snapshot, then run `pnpm test` to see which symbols diverged.
- **Deliberate divergences go in the `INTENTIONAL_ASYMMETRIES` allowlist** at
  the top of the test, each with a stated reason. Four are declared today (the
  result envelope, credential resolution, the absence of a sync variant, and
  the router buckets this SDK currently leads on). Anything not declared there
  fails. Adding an entry is a design decision — the test also fails on an entry
  that no longer applies, so the list cannot rot into a blanket exemption.
- **A LEAD is not an asymmetry, and has its own field.** The two SDKs ship on
  separate pull requests, so one of them carries a new Router bucket first.
  `routerErrorClassesAheadOfPython` tolerates that in ONE direction —
  TypeScript may lead, never lag — and the rot guard fails the moment the
  Python snapshot grows the same name, which is the signal to delete the entry
  rather than to grow it. Do not reach for it to excuse a class this SDK
  invented: `router-spec-coverage.test.ts` only passes for a bucket the
  vendored Router contract actually declares.
