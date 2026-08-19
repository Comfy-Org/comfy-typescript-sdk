# Contributing

Thanks for helping improve `@comfyorg/sdk`, the TypeScript client for the
[Comfy API v2](https://docs.comfy.org).

This is a small, public, published package: whatever lands on `main` can ship
to every consumer on the next release. That shapes most of the rules below —
in particular, **a large part of `src/` is generated from
[`spec/openapi.yaml`](spec/openapi.yaml) and must not be hand-edited**. CI
enforces it. See [Generated code](#generated-code-do-not-hand-edit) before you
touch anything under `src/low/generated/`.

## Contents

- [Before you start](#before-you-start)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [The checks CI runs](#the-checks-ci-runs)
- [Generated code (do not hand-edit)](#generated-code-do-not-hand-edit)
- [Public-repo hygiene](#public-repo-hygiene)
- [Tests](#tests)
- [Commits and pull requests](#commits-and-pull-requests)
- [Releases and the changelog](#releases-and-the-changelog)

## Before you start

- **Bugs and features:** open an issue first using the
  [issue templates](.github/ISSUE_TEMPLATE). For a bug, include the SDK
  version, your Node version, and a minimal reproduction — it is almost always
  faster than a round trip asking for them.
- **Small fixes** (typos, a failing edge case with a test) can go straight to a
  pull request.
- **Behavior changes to the public API** are worth discussing in an issue
  before you write the code. Every exported symbol is consumed by someone; see
  [Commits and pull requests](#commits-and-pull-requests) for what counts as
  breaking.
- **CLA:** the first pull request you open triggers the CLA Assistant bot,
  which asks you to comment your agreement on the PR. Only the PR author needs
  to sign. The check blocks merge until it passes.

## Prerequisites

- **Node >= 22** (`engines` in `package.json`). CI tests Node 22 and 24.
- **pnpm.** The version is pinned by the `packageManager` field in
  `package.json`; the simplest way to match it is
  [Corepack](https://nodejs.org/api/corepack.html):

  ```bash
  corepack enable
  ```

  `npm` and `yarn` are not supported — the lockfile is `pnpm-lock.yaml` and CI
  installs with `--frozen-lockfile`.

## Setup

```bash
git clone https://github.com/Comfy-Org/comfy-typescript-sdk.git
cd comfy-typescript-sdk
pnpm install --frozen-lockfile
```

Use `--frozen-lockfile` locally too. A plain `pnpm install` may rewrite
`pnpm-lock.yaml`; if you did not intend to change dependencies, do not commit
that diff.

No credentials, no running ComfyUI, and no network access are needed to build
or test. The test suite runs entirely against an in-process stub server
(`test/support/stub-server.ts`).

## The checks CI runs

Run these before pushing. They are exactly what `.github/workflows/ci.yml`
runs, in the same order, so a green local run is a good predictor of green CI.

| Check | Command | What fails it |
| --- | --- | --- |
| Lint | `pnpm lint` | `oxlint` findings |
| Format | `pnpm format:check` | anything `oxfmt` would reformat |
| Types | `pnpm typecheck` | `tsc --noEmit` errors |
| Codegen drift | `pnpm check:spec-drift` | `src/low/generated/*` is stale or hand-edited |
| Tests | `pnpm test` | a failing `vitest` test |
| Build | `pnpm build` | `tsc` cannot emit `dist/` |

All six in one go:

```bash
pnpm install --frozen-lockfile && \
  pnpm lint && pnpm format:check && pnpm typecheck && \
  pnpm check:spec-drift && pnpm test && pnpm build
```

To fix formatting rather than just check it:

```bash
pnpm format          # oxfmt --write .
```

Two more jobs run on the pull request and have no local `pnpm` script:

- **`build-check` (publish dry run)** — packs the tarball with `pnpm pack` and
  asserts the published file set still contains `dist/index.js` and
  `dist/index.d.ts`. It catches a broken `exports` map or a missing build
  artifact at PR time instead of at release time. Reproduce locally with
  `pnpm build && pnpm pack`.
- **`public-repo-hygiene`** — see [below](#public-repo-hygiene). Reproduce
  locally with `node scripts/check-public-repo-hygiene.mjs`.

## Generated code (do not hand-edit)

`spec/openapi.yaml` is a vendored, one-way copy of the canonical Comfy API v2
HTTP contract. Everything under `src/low/generated/` is produced from it by
[`@hey-api/openapi-ts`](https://heyapi.dev) using `openapi-ts.config.ts`:

```
spec/openapi.yaml ──(pnpm generate)──▶ src/low/generated/types.gen.ts
                                       src/low/generated/zod.gen.ts
                                       src/low/generated/index.ts
```

**Regenerate with:**

```bash
pnpm generate
```

(that is `openapi-ts`, which reads `openapi-ts.config.ts` — do not invoke the
generator with your own flags, or the output will not match what CI expects).
Then commit the resulting diff under `src/low/generated/` together with your
change.

Rules that will save you a CI round trip:

- **Never hand-edit a file in `src/low/generated/`.** The generator runs with
  `clean: true` and rewrites every file it owns, so your edit is both lost on
  the next regeneration and caught by CI before then.
- **Never reformat generated files.** `src/low/generated/` is listed in
  `.prettierignore` (which `oxfmt` reads) and in `ignorePatterns` in
  `.oxlintrc.json` for exactly this reason: the drift check compares committed
  bytes against a fresh generation, so reformatting is drift.
- **The drift check is a required CI step.** `scripts/check-spec-drift.mjs`
  regenerates into a temp directory with the same config and diffs the result
  against what is committed. If it fails, the fix is always the same:

  ```bash
  pnpm generate
  git add src/low/generated
  ```

- **Do not hand-edit `spec/openapi.yaml` either.** It is synced from the
  canonical contract (and the sync strips internal-only operations, since this
  repo is public). If the SDK is missing an endpoint or a field, that is a
  contract change — open an issue describing what you need rather than
  patching the vendored copy in a pull request.

Behavior that is *not* generated lives in the hand-written low layer
(`src/low/transport.ts`, `errors.ts`, `sse.ts`, and the aggregator
`src/low/index.ts`) and in the high-level client under `src/sdk/`. That is
where a fix normally belongs. Note that `src/low/index.ts` is hand-written and
`src/low/generated/index.ts` is not — they are different files; only the
latter is codegen output.

## Public-repo hygiene

`scripts/check-public-repo-hygiene.mjs` runs as its own CI job and scans every
tracked file for references that only make sense inside Comfy's private
context. It is a regression guard (this repo leaked such references once), not
a secrets scanner. It flags three categories:

1. **Ticket-shaped identifiers** — two to six capital letters, a hyphen, then
   digits. (No literal example here: this file is scanned too.)
2. **Internal collaboration-tool links** — Notion, Slack, Google Docs/Drive,
   Datadog, PostHog, Linear, and `incident-` references.
3. **References to `Comfy-Org/<repo>` or `@Comfy-Org/<team>` outside the
   known-public allowlist** in the script. This is default-deny, so a brand new
   public repo will be flagged until it is added to the list.

Most contributor-triggered failures are category 3 or an accidental paste of an
internal link into a comment or commit body. If you hit a genuine false
positive, extend the allowlist in the script with a comment explaining why —
that is the intended fix.

## Tests

- [Vitest](https://vitest.dev). Unit tests live next to the code they cover as
  `*.test.ts` (for example `src/sdk/jobs.test.ts`); shared fixtures live in
  `test/support/`.
- Tests must not hit the network. Drive HTTP behavior through the stub server
  in `test/support/stub-server.ts`.
- Coverage: `pnpm test:coverage`. `vitest.config.ts` deliberately excludes
  generated output so coverage measures hand-written code.
- Bug fixes should come with a test that fails without the fix. Assert the
  behavior described in the issue, not just the current output — a test that
  only pins today's return value does not protect anyone.

## Commits and pull requests

- **Conventional Commits** for both commit subjects and the pull request title:
  `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `ci:`, `refactor:`, with an
  optional scope (`fix(ci): ...`). A breaking change gets a `!`
  (`feat!: ...`) and an explanation in the body.
- **Do not add AI-assistant attribution trailers** (for example
  `Co-Authored-By:` lines naming an assistant, or "generated with" footers) to
  commit messages. Comfy repositories reject them.
- **Keep the pull request focused.** A codegen regeneration, a refactor, and a
  behavior change in one branch are three reviews in a trench coat.
- **Link the issue** in the body (`Closes #123`).
- **Describe the consumer impact** for anything touching `src/`: is an export's
  type changing, is a default changing, does existing code keep compiling? This
  is a published SDK, so removing or narrowing an export is a breaking change
  even when nothing in this repo notices.
- **Review:** `.github/CODEOWNERS` requires an approving review from a
  maintainer team before merge, and CI plus the CLA check must be green.
  CodeRabbit also reviews automatically; its configuration tells it not to
  repeat lint/format findings, so its comments are usually worth reading.

## Releases and the changelog

Releases are **tag-driven** and maintainer-only. Publishing to npm happens in
`.github/workflows/publish.yml` when a GitHub Release with a `vX.Y.Z` tag is
published; that tag is the source of truth for the version, which is injected
into `package.json` at build time. The `version` field committed in
`package.json` is a placeholder — **do not bump it in a pull request.**

Do add an entry to [`CHANGELOG.md`](CHANGELOG.md) under `## [Unreleased]` for
any user-visible change (added, changed, deprecated, removed, fixed, security).
Purely internal changes — refactors, test-only changes, CI edits — do not need
one. Maintainers move the `Unreleased` section under a version heading when
cutting a release.
