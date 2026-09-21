/**
 * Regression suite for `scripts/check-workflow-pins.mjs`, driven as a
 * SUBPROCESS against fixture repo roots.
 *
 * Subprocess rather than import, for two reasons. The script is a CLI: its
 * contract is an exit status plus what it writes to stdout/stderr, and it
 * calls `process.exit` on the failure paths, which an in-process import would
 * turn into a killed test run. And it resolves the repo root from its OWN file
 * location (`new URL("..", import.meta.url)`) with no `--root` flag, so the
 * only way to point it at a fixture tree is to put a copy of the script inside
 * that tree -- which is exactly what `fixtureRoot` does.
 *
 * Every case here pins a parser behaviour the script's own header documents:
 * which lines count as a caller, where a `workflows_ref` input is allowed to
 * live, and which shapes must be ignored in the direction that fails LOUD
 * rather than silently passing a split pin.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./check-workflow-pins.mjs", import.meta.url));
const REAL_REPO = fileURLToPath(new URL("..", import.meta.url));
const HISTORICAL_FIXTURE = fileURLToPath(
  new URL("./__fixtures__/ci-cursor-review.83c0c87.yml", import.meta.url),
);

/** The commit both pins carry today. */
const SHA = "425c154ce5049324ee23ad10e106baeed4cfa31b";
/** A different, equally real commit -- the one the split-pin era left behind. */
const OTHER = "ebfd9e44588ffc560a063d0d13cf8a9a91d1ffb0";
/** The abbreviation the historical split's trailing comment claimed. */
const STALE_SHORT = "ffcc3f5";

const REUSABLE = "Comfy-Org/github-workflows/.github/workflows/cursor-review.yml";
const WORKFLOW = "ci-cursor-review.yml";
const REL = `.github/workflows/${WORKFLOW}`;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A throwaway repo root holding a copy of the script plus the given workflow
 * files, registered for teardown.
 */
function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "check-workflow-pins-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(SCRIPT, join(root, "scripts", "check-workflow-pins.mjs"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, ".github", "workflows", name), body);
  }
  return root;
}

function run(root: string, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts", "check-workflow-pins.mjs"), ...args],
    // `spawnSync` BLOCKS the worker's event loop, so vitest's per-test timeout
    // can never fire on a wedged child -- the cap has to be spawnSync's own.
    { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" },
  );
  // A child that failed to START (ENOENT, EAGAIN) or that was KILLED (the
  // timeout above, or any signal) reports that out of band: `status`, `stdout`
  // and `stderr` all come back null, and every assertion downstream would
  // degrade to "expected null to be 0" with the real cause lost. Surface it.
  if (result.error) throw result.error;
  if (result.signal !== null) {
    throw new Error(
      `check-workflow-pins.mjs was killed by ${result.signal} (args: ${args.join(" ") || "<none>"})`,
    );
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Fixture bodies are written as line ARRAYS, not template literals: YAML is
 * indentation-significant and an array keeps every leading space visible at
 * review time instead of tangled with the surrounding TypeScript indent.
 */
function yaml(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

/** 1-based line number of `line` within `lines`, for `${REL}:<n>` assertions. */
function lineNo(lines: string[], line: string): number {
  const index = lines.indexOf(line);
  expect(index, `fixture does not contain ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(0);
  return index + 1;
}

const HEADER = ["name: CI - Cursor Review", "on: [pull_request]", "", "jobs:"];

/** The simplest correctly-pinned caller: `uses:` and its `with:` input agree. */
function pinnedCaller(usesRef = SHA, withRef = SHA, comment = ""): string[] {
  return [
    ...HEADER,
    "  cursor-review:",
    `    uses: ${REUSABLE}@${usesRef}${comment === "" ? "" : ` ${comment}`}`,
    "    with:",
    `      workflows_ref: ${withRef}`,
  ];
}

/**
 * An earlier job whose `run: |` body carries a `uses:` line naming a DIFFERENT
 * commit -- the shape this repo's own ci.yml writes when it explains the pin
 * pair inside an issue body. A parser that read block-scalar content would
 * find a phantom second caller here: a red build over a pin that does not
 * exist, and an ambiguous `--print-pin`.
 *
 * The decoy is a HEREDOC body line, not an `echo "uses: ..."` argument, and
 * that spelling is load-bearing. The caller regex anchors `uses` as the first
 * token after the indent (`^(\s*)(["']?)uses\2\s*:`), so an `echo`-prefixed
 * line is rejected on spelling alone and never reaches the block-scalar skip
 * -- a decoy written that way would still pass with the skip DELETED from the
 * script, pinning nothing. Here `uses:` is the first non-space token of the
 * body, so only the block-scalar skip keeps it from reading as a caller.
 */
const DECOY_USES_LINE = `    uses: ${REUSABLE}@${SHA}`;
const DECOY_LINES = [
  ...HEADER,
  "  explain:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - name: Explain the pin pair",
  "        run: |",
  "          cat <<'EOF'",
  `          uses: ${REUSABLE}@${OTHER}`,
  `          workflows_ref: ${OTHER}`,
  "          EOF",
  "  cursor-review:",
  DECOY_USES_LINE,
  "    with:",
  `      workflows_ref: ${SHA}`,
];

describe("check-workflow-pins.mjs against the real repo", () => {
  it("passes, and says the pins agree", () => {
    const { status, stdout } = run(REAL_REPO);
    expect(status).toBe(0);
    expect(stdout).toContain("all pins agree");
  });

  it("--print-pin writes a bare 40-hex SHA and nothing else", () => {
    const { status, stdout } = run(REAL_REPO, "--print-pin", "cursor-review.yml");
    expect(status).toBe(0);
    expect(stdout).toMatch(/^[0-9a-f]{40}\n$/);
  });
});

describe("the historical split this lint was written for", () => {
  it("reports BOTH halves of the pin pair it shipped between two releases", () => {
    const root = fixtureRoot({ [WORKFLOW]: readFileSync(HISTORICAL_FIXTURE, "utf8") });
    const { status, stderr } = run(root);
    expect(status).toBe(1);
    expect(stderr).toContain("2 problem(s)");
    // (a) the trailing comment names a commit `uses:` is not pinned to ...
    expect(stderr).toContain(`names commit \`${STALE_SHORT}\``);
    // ... and (b) `workflows_ref` names that same stale commit in full.
    expect(stderr).toContain(`\`workflows_ref\` is \`${STALE_SHORT}`);
  });
});

describe("the three pin assertions", () => {
  it("fails when `uses:` and `workflows_ref` name different commits", () => {
    const root = fixtureRoot({ [WORKFLOW]: yaml(pinnedCaller(SHA, OTHER)) });
    const { status, stderr } = run(root);
    expect(status).toBe(1);
    expect(stderr).toContain("The two must be the same commit");
  });

  it("fails on a stale parenthesised trailing comment", () => {
    const comment = `# github-workflows main (${STALE_SHORT})`;
    const root = fixtureRoot({ [WORKFLOW]: yaml(pinnedCaller(SHA, SHA, comment)) });
    const { status, stderr } = run(root);
    expect(status).toBe(1);
    expect(stderr).toContain(`names commit \`${STALE_SHORT}\``);
  });

  it("fails on a stale BARE trailing comment, with no parentheses to key on", () => {
    const root = fixtureRoot({ [WORKFLOW]: yaml(pinnedCaller(SHA, SHA, `# ${STALE_SHORT}`)) });
    const { status, stderr } = run(root);
    expect(status).toBe(1);
    expect(stderr).toContain(`names commit \`${STALE_SHORT}\``);
  });

  it("accepts a date in the trailing comment beside the parenthesised short SHA", () => {
    const comment = "# github-workflows main (425c154) - bumped 20260919";
    const root = fixtureRoot({ [WORKFLOW]: yaml(pinnedCaller(SHA, SHA, comment)) });
    const { status, stderr } = run(root);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("fails on a branch-pinned `uses:`, which whoever owns it can move", () => {
    const root = fixtureRoot({ [WORKFLOW]: yaml(pinnedCaller("main", SHA)) });
    const { status, stderr } = run(root);
    expect(status).toBe(1);
    expect(stderr).toContain("not a full 40-hex");
  });
});

describe("where a `workflows_ref` input is allowed to live", () => {
  const MISSING = "passes no `workflows_ref` input";

  it("fails when the caller passes none -- both with and without a `with:` block", () => {
    const withBlockButNoInput = fixtureRoot({
      [WORKFLOW]: yaml([
        ...HEADER,
        "  cursor-review:",
        `    uses: ${REUSABLE}@${SHA}`,
        "    with:",
        "      extra_generated_globs: dist/**",
      ]),
    });
    const withBlockResult = run(withBlockButNoInput);
    expect(withBlockResult.status).toBe(1);
    expect(withBlockResult.stderr).toContain(MISSING);

    const noWithBlockAtAll = fixtureRoot({
      [WORKFLOW]: yaml([...HEADER, "  cursor-review:", `    uses: ${REUSABLE}@${SHA}`]),
    });
    const noWithResult = run(noWithBlockAtAll);
    expect(noWithResult.status).toBe(1);
    expect(noWithResult.stderr).toContain(MISSING);
  });

  it("ignores a `workflows_ref` written as a SIBLING of `uses:`", () => {
    // GitHub accepts inputs only at `jobs.<id>.with.<input>`; at this indent
    // the key is not passed to the reusable at all.
    const root = fixtureRoot({
      [WORKFLOW]: yaml([
        ...HEADER,
        "  cursor-review:",
        `    uses: ${REUSABLE}@${SHA}`,
        `    workflows_ref: ${SHA}`,
      ]),
    });
    const { status, stderr } = run(root);
    expect(status).toBe(1);
    expect(stderr).toContain(MISSING);
  });

  it("ignores a `workflows_ref` nested deeper than the `with:` children", () => {
    const underNestedMapping = fixtureRoot({
      [WORKFLOW]: yaml([
        ...HEADER,
        "  cursor-review:",
        `    uses: ${REUSABLE}@${SHA}`,
        "    with:",
        "      config:",
        `        workflows_ref: ${SHA}`,
      ]),
    });
    const nestedResult = run(underNestedMapping);
    expect(nestedResult.status).toBe(1);
    expect(nestedResult.stderr).toContain(MISSING);

    const insideABlockScalarInput = fixtureRoot({
      [WORKFLOW]: yaml([
        ...HEADER,
        "  cursor-review:",
        `    uses: ${REUSABLE}@${SHA}`,
        "    with:",
        "      body: |",
        `        workflows_ref: ${SHA}`,
      ]),
    });
    const blockScalarResult = run(insideABlockScalarInput);
    expect(blockScalarResult.status).toBe(1);
    expect(blockScalarResult.stderr).toContain(MISSING);
  });

  it("does not let a PRECEDING job's `with:` stand in for the caller's own", () => {
    const root = fixtureRoot({
      [WORKFLOW]: yaml([
        ...HEADER,
        "  earlier:",
        "    uses: other-org/shared/.github/workflows/build.yml@v1",
        "    with:",
        `      workflows_ref: ${SHA}`,
        "  cursor-review:",
        `    uses: ${REUSABLE}@${SHA}`,
      ]),
    });
    const { status, stderr } = run(root);
    expect(status).toBe(1);
    expect(stderr).toContain(MISSING);
  });

  it("accepts `with:` written ABOVE its job's `uses:` -- YAML mappings are unordered", () => {
    const root = fixtureRoot({
      [WORKFLOW]: yaml([
        ...HEADER,
        "  cursor-review:",
        "    with:",
        `      workflows_ref: ${SHA}`,
        `    uses: ${REUSABLE}@${SHA}`,
      ]),
    });
    const { status, stderr } = run(root);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("accepts a trailing comment on `with:` and a flush-left comment inside it", () => {
    const root = fixtureRoot({
      [WORKFLOW]: yaml([
        ...HEADER,
        "  cursor-review:",
        `    uses: ${REUSABLE}@${SHA}`,
        "    with: # inputs",
        "# Load the prompts/scripts from the same ref as `uses:`.",
        `      workflows_ref: ${SHA}`,
      ]),
    });
    const { status, stderr } = run(root);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });
});

describe("shapes that must NOT read as a caller", () => {
  it("skips a `uses:` quoted inside an earlier job's `run: |` body", () => {
    const root = fixtureRoot({ [WORKFLOW]: yaml(DECOY_LINES) });
    const { status, stdout, stderr } = run(root);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("1 Comfy-Org/github-workflows caller(s)");
    expect(stdout).toContain(`${REL}:${lineNo(DECOY_LINES, DECOY_USES_LINE)} -> cursor-review.yml`);
  });

  it("ends a `- run: |` block at its sibling key, not at the next job", () => {
    // The dash-carrying spelling of the decoy: here `run:` carries its own
    // `- `, where the case above writes it under a `- name:` step. Group 1 of
    // the script's BLOCK_SCALAR_RE spans that `- `, so the block's column is
    // `run`'s (8) -- and the sibling `shell:` at that same column ENDS it, so
    // the block must not run on and swallow the real caller two lines down.
    //
    // This fixture deliberately does NOT claim to distinguish measuring the
    // column from the dash (6) instead of from `run` (8): `  cursor-review:`
    // sits at column 2 and terminates the block under either reading, so
    // stdout is byte-identical. The two columns diverge only for a line at
    // column 7-8, which in this shape is a step-sibling mapping key, not a
    // caller. What IS pinned here is the skip itself -- as above, the decoy is
    // a heredoc body line so that `uses` is the first token after the indent.
    const lines = [
      ...HEADER,
      "  earlier:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: |",
      "          cat <<'EOF'",
      `          uses: ${REUSABLE}@${OTHER}`,
      "          EOF",
      "        shell: bash",
      "  cursor-review:",
      `    uses: ${REUSABLE}@${SHA}`,
      "    with:",
      `      workflows_ref: ${SHA}`,
    ];
    const root = fixtureRoot({ [WORKFLOW]: yaml(lines) });
    const { status, stdout, stderr } = run(root);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("1 Comfy-Org/github-workflows caller(s)");
    expect(stdout).toContain(`${REL}:${lineNo(lines, `    uses: ${REUSABLE}@${SHA}`)}`);
  });

  it("finds a caller written AFTER a multi-line block scalar in the same file", () => {
    const usesLine = `    uses: ${REUSABLE}@${SHA}`;
    const lines = [
      ...HEADER,
      "  notes:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: |",
      "          cat <<'EOF'",
      "            both pins move together",
      "            see .github/dependabot.yml",
      "          EOF",
      "  cursor-review:",
      usesLine,
      "    with:",
      `      workflows_ref: ${SHA}`,
    ];
    const root = fixtureRoot({ [WORKFLOW]: yaml(lines) });
    const { status, stdout, stderr } = run(root);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("1 Comfy-Org/github-workflows caller(s)");
    expect(stdout).toContain(`${REL}:${lineNo(lines, usesLine)} -> cursor-review.yml`);
  });

  it("skips a whole-line `# uses:` comment above the real caller", () => {
    // The header of the repo's own ci-cursor-review.yml documents the call
    // this way; reading it would make every caller look doubly pinned.
    const usesLine = `    uses: ${REUSABLE}@${SHA}`;
    const lines = [
      ...HEADER,
      "  cursor-review:",
      `    # uses: ${REUSABLE}@${OTHER}`,
      usesLine,
      "    with:",
      `      workflows_ref: ${SHA}`,
    ];
    const root = fixtureRoot({ [WORKFLOW]: yaml(lines) });
    const { status, stdout, stderr } = run(root);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("1 Comfy-Org/github-workflows caller(s)");
    expect(stdout).toContain(`${REL}:${lineNo(lines, usesLine)} -> cursor-review.yml`);
  });

  it("reads a QUOTED `uses:` key and value, and still catches a split there", () => {
    const quoted = (withRef: string) => [
      ...HEADER,
      "  cursor-review:",
      `    "uses": "${REUSABLE}@${SHA}"`,
      "    with:",
      `      workflows_ref: ${withRef}`,
    ];

    const agreeing = fixtureRoot({ [WORKFLOW]: yaml(quoted(SHA)) });
    const agreeingResult = run(agreeing);
    expect(agreeingResult.stderr).toBe("");
    expect(agreeingResult.status).toBe(0);

    const split = fixtureRoot({ [WORKFLOW]: yaml(quoted(OTHER)) });
    const splitResult = run(split);
    expect(splitResult.status).toBe(1);
    expect(splitResult.stderr).toContain("The two must be the same commit");
  });

  it("ignores a composite-ACTION step, which pins once and has no input to split", () => {
    const root = fixtureRoot({
      [WORKFLOW]: yaml([
        ...HEADER,
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        `      - uses: Comfy-Org/github-workflows/actions/setup@${SHA}`,
      ]),
    });
    const { status, stdout } = run(root);
    expect(status).toBe(0);
    expect(stdout).toContain("no Comfy-Org/github-workflows callers found");
  });
});

describe("--print-pin", () => {
  it("prints the one pin even with a block-scalar decoy in the file", () => {
    const root = fixtureRoot({ [WORKFLOW]: yaml(DECOY_LINES) });
    const { status, stdout } = run(root, "--print-pin", "cursor-review.yml");
    expect(status).toBe(0);
    expect(stdout).toBe(`${SHA}\n`);
  });

  it("refuses to choose when two callers of the same reusable exist", () => {
    const root = fixtureRoot({
      [WORKFLOW]: yaml([
        ...HEADER,
        "  cursor-review:",
        `    uses: ${REUSABLE}@${SHA}`,
        "    with:",
        `      workflows_ref: ${SHA}`,
        "  cursor-review-again:",
        `    uses: ${REUSABLE}@${SHA}`,
        "    with:",
        `      workflows_ref: ${SHA}`,
      ]),
    });
    const { status, stderr } = run(root, "--print-pin", "cursor-review.yml");
    expect(status).toBe(1);
    expect(stderr).toContain("cannot choose between them");
  });

  it("fails when no caller of the named reusable exists", () => {
    const root = fixtureRoot({
      [WORKFLOW]: yaml([
        ...HEADER,
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        `      - uses: Comfy-Org/github-workflows/actions/setup@${SHA}`,
      ]),
    });
    const { status, stderr } = run(root, "--print-pin", "cursor-review.yml");
    expect(status).toBe(1);
    expect(stderr).toContain("no Comfy-Org/github-workflows caller");
  });

  it("fails when given no reusable name", () => {
    const root = fixtureRoot({ [WORKFLOW]: yaml(pinnedCaller()) });
    const { status, stderr } = run(root, "--print-pin");
    expect(status).toBe(1);
    expect(stderr).toContain("needs a reusable workflow file name");
  });

  it("accepts the inline `--print-pin=<name>` form", () => {
    const root = fixtureRoot({ [WORKFLOW]: yaml(pinnedCaller()) });
    const { status, stdout } = run(root, "--print-pin=cursor-review.yml");
    expect(status).toBe(0);
    expect(stdout).toBe(`${SHA}\n`);
  });
});
