#!/usr/bin/env node
/**
 * Fail CI if a Comfy-Org/github-workflows caller's TWO pins disagree.
 *
 * A caller of those reusables pins the same upstream commit twice: the
 * `uses:` SHA selects the workflow definition, and the `workflows_ref:`
 * input selects the prompts/scripts that definition loads at run time. They
 * are independent -- nothing in GitHub or in the reusable ties them -- so
 * they can drift apart silently and the review still runs, just with
 * prompts from a different commit than the workflow.
 *
 * That is not hypothetical: it is what this repo shipped between #135 and
 * #153. Dependabot rewrites `uses:` and never touches a `with:` input, so
 * each of its bumps moved one pin of the pair and left the other behind.
 * .github/dependabot.yml now tells it to leave these alone, and this lint is
 * the other half -- the part that notices if the pair splits again, whoever
 * splits it.
 *
 * Three assertions per caller, all on the same upstream SHA:
 *   1. the `uses:` ref is a full 40-hex commit SHA (not a tag or branch);
 *   2. `workflows_ref:` equals it exactly;
 *   3. the trailing `# ... (short)` comment agrees with it.
 *
 * Text-level parsing, deliberately: this runs from a bare `actions/checkout`
 * + `setup-node` with no `pnpm install` (same shape as public-repo-hygiene),
 * so it cannot import the `yaml` devDependency. The shapes it needs to read
 * are a `uses:` line and one `with:` key, both of which are unambiguous on
 * their own line.
 *
 * Position is read, not just spelling: the input is recognised only as a DIRECT
 * CHILD of the calling job's `with:` block, which is the only place GitHub
 * accepts one. A same-indent `workflows_ref:` (a sibling of `uses:`) and one
 * buried deeper (inside a block scalar, or under a nested mapping) are both
 * ignored, so neither can stand in for a pin the job does not actually pass.
 *
 * One documented limit, which reads as "input absent": a `with:` written as a
 * FLOW mapping (`with: { ... }`) is not parsed. On a reusable in
 * `REQUIRES_WORKFLOWS_REF` that fails LOUDLY as a missing input rather than
 * passing silently, which is the direction this lint is allowed to be wrong in
 * -- so it does not justify carrying a YAML parser into a job that deliberately
 * runs without `pnpm install`.
 *
 * Block-mapping key ORDER is not a limit: `with:` may sit above or below its
 * job's `uses:`, because the scan covers the whole job body rather than only
 * the lines after `uses:`. YAML mappings are unordered, so a caller that spells
 * it that way is correctly pinned and must not be reported as unpinned.
 *
 * Two modes, ONE parser (`findCallers`) shared between them:
 *
 *   node scripts/check-workflow-pins.mjs
 *     The lint above. Exits 1 on any disagreement.
 *
 *   node scripts/check-workflow-pins.mjs --print-pin cursor-review.yml
 *     Prints that caller's `workflows_ref` SHA on stdout and nothing else, so
 *     a workflow can capture it with `$(...)`. Used by the
 *     `cursor-review-pin-freshness` job in ci.yml, which needs the pinned
 *     commit to ask github-workflows whether anything consumer-visible has
 *     landed since. It shares the parser rather than re-deriving the SHA with
 *     its own `grep`, so the two cannot disagree about which line is the pin.
 *
 * Run: node scripts/check-workflow-pins.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");

// Only the org's own reusables pin twice. A third-party action pins once and
// is not this lint's business (it has no `workflows_ref` to disagree with).
const REUSABLE_OWNER_REPO = "Comfy-Org/github-workflows";

// Reusables that REQUIRE `workflows_ref` (upstream declares it
// `required: true` with no default). Dropping the input from one of these
// callers is the same bug as splitting the pair -- the reusable would load
// its scripts from an empty ref -- so absence is an error, not a skip. Add a
// reusable here when it starts taking the input.
const REQUIRES_WORKFLOWS_REF = new Set(["cursor-review.yml"]);

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
// `uses: Comfy-Org/github-workflows/.github/workflows/<name>.yml@<ref>  # <comment>`
// The value may be quoted (`uses: "owner/repo/...@sha"`). Unquoted is what
// every caller doc writes, but a quoted one must not read as "no uses: here" --
// a silent skip is the one direction this lint must never fail in.
const USES_RE = new RegExp(
  String.raw`^(\s*)uses:\s*(["']?)` +
    REUSABLE_OWNER_REPO.replace("/", "\\/") +
    String.raw`\/(\S+?)@([^\s"']+?)\2\s*(?:#(.*))?$`,
);
const WORKFLOWS_REF_RE = /^\s*workflows_ref:\s*(["']?)([^\s"']+?)\1\s*(?:#.*)?$/;
// A short-SHA candidate inside the trailing comment: 7-40 hex characters as a
// whole word. 7 is git's minimum abbreviation, so shorter tokens (`# v7`) are
// version spellings, not SHAs, and are left alone.
const SHORT_SHA_RE = /\b[0-9a-f]{7,40}\b/g;

/**
 * The `workflows_ref` INPUT of the job that owns the `uses:` on `usesIndex`,
 * or `null` if that job passes none.
 *
 * GitHub accepts a reusable-workflow input only at `jobs.<id>.with.<input>`, so
 * that is the only place this looks. Position, not just spelling, is what makes
 * a line the pin:
 *
 * - A job's `uses:`, `with:` and `secrets:` are siblings at the same indent, so
 *   the job body runs from just after its `<job id>:` key until a line appears
 *   at a SHALLOWER indent -- the next job's key, or the next top-level key.
 * - Inside the body, only a DIRECT CHILD of `with:` is an input. A
 *   `workflows_ref:` written as a sibling of `uses:` is not passed to the
 *   reusable at all (it makes the job invalid), and one nested deeper than the
 *   `with:` children -- inside a block scalar, or under a nested mapping -- is
 *   part of some other input's value. Neither may satisfy the pin, or this lint
 *   would pass a caller whose real `workflows_ref` is missing or split.
 *
 * The scan covers the WHOLE job body, not just the part after `uses:`. YAML
 * mappings are unordered, so `with:` above its job's `uses:` is a legal
 * spelling; reading only the suffix would miss that pin and report a correctly
 * pinned caller as passing none. The job's first line is found by walking back
 * from `uses:` to the nearest shallower line, which is its `<job id>:` key --
 * a block scalar's content is always indented deeper than the key that owns
 * it, so nothing inside the job can be mistaken for that boundary.
 *
 * Blank lines and whole-line comments carry no structure and never end a block
 * (a comment is often written flush-left).
 */
function workflowsRefInput(lines, usesIndex, usesIndent) {
  let inWith = false;
  // The indent shared by `with:`'s direct children, learned from the first one.
  let withChildIndent = null;

  // Walk back to the job's `<job id>:` key -- the nearest shallower line above
  // `uses:` -- and start just after it, so a `with:` block written above
  // `uses:` is still inside the scanned body.
  let bodyStart = 0;
  for (let i = usesIndex - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (lines[i].length - lines[i].trimStart().length < usesIndent) {
      bodyStart = i + 1;
      break;
    }
  }

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    // Shallower than `uses:` -- the job is over.
    if (indent < usesIndent) break;

    // A sibling of `uses:`: opens the `with:` block, or closes it.
    if (indent === usesIndent) {
      inWith = /^with:\s*(?:#.*)?$/.test(trimmed);
      withChildIndent = null;
      continue;
    }

    // Deeper than `uses:`, but outside `with:` (a `secrets:` value, a block
    // scalar under a job-level key) -- not an input.
    if (!inWith) continue;

    withChildIndent ??= indent;
    // Deeper than the `with:` children: inside another input's value.
    if (indent !== withChildIndent) continue;

    const rm = WORKFLOWS_REF_RE.exec(line);
    if (rm) return { value: rm[2], lineNo: i + 1 };
  }

  return null;
}

/**
 * Every `Comfy-Org/github-workflows` caller in `.github/workflows`, parsed.
 *
 * PARSING ONLY -- it asserts nothing at all. Both modes read these records, so
 * neither can drift from the other about what counts as a caller, which line
 * holds its `uses:` ref, or where its `workflows_ref` input lives.
 */
function findCallers() {
  const callers = [];

  for (const file of readdirSync(WORKFLOWS_DIR).sort()) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const rel = `.github/workflows/${file}`;
    const lines = readFileSync(join(WORKFLOWS_DIR, file), "utf8").split("\n");

    for (let i = 0; i < lines.length; i++) {
      // A whole-line comment can quote a `uses:` while documenting it; the
      // header of ci-cursor-review.yml does exactly that.
      if (lines[i].trimStart().startsWith("#")) continue;
      const m = USES_RE.exec(lines[i]);
      if (!m) continue;

      const [, indentStr, , workflowPath, ref, comment] = m;

      callers.push({
        rel,
        reusable: workflowPath.split("/").pop(),
        usesLineNo: i + 1,
        ref,
        comment,
        workflowsRef: workflowsRefInput(lines, i, indentStr.length),
      });
    }
  }

  return callers;
}

/** The three pin assertions, as a list of human-readable problems. */
function lint(callers) {
  const errors = [];

  for (const { rel, reusable, usesLineNo, ref, comment, workflowsRef } of callers) {
    const at = `${rel}:${usesLineNo}`;

    // (1) The `uses:` ref must be immutable.
    if (!FULL_SHA_RE.test(ref)) {
      errors.push(
        `${at}: \`uses:\` is pinned to \`${ref}\`, which is not a full 40-hex ` +
          `commit SHA. A tag or branch can be moved by whoever owns it; pin the SHA.`,
      );
      // Everything below compares against this ref, so a bad one would turn
      // one error into three. Report it once and move on.
      continue;
    }

    // (3) The trailing version comment must not name a different commit.
    // Checked before the pair so a stale comment is reported even on a caller
    // that takes no `workflows_ref`.
    if (comment) {
      for (const candidate of comment.match(SHORT_SHA_RE) ?? []) {
        if (!ref.startsWith(candidate)) {
          errors.push(
            `${at}: the trailing comment names commit \`${candidate}\`, but ` +
              `\`uses:\` is pinned to \`${ref}\`. Update the comment to ` +
              `\`${ref.slice(0, 7)}\`, or repin \`uses:\` if the comment is the ` +
              `commit you meant.`,
          );
        }
      }
    }

    // (2) `workflows_ref` must be the same commit as `uses:`.
    if (!workflowsRef) {
      if (REQUIRES_WORKFLOWS_REF.has(reusable)) {
        errors.push(
          `${at}: this job calls \`${reusable}\`, which requires a ` +
            `\`workflows_ref\` input, but none is set. Without it the reusable ` +
            `loads its prompts/scripts from an empty ref. Add ` +
            `\`workflows_ref: ${ref}\` under \`with:\`.`,
        );
      }
      continue;
    }

    if (workflowsRef.value !== ref) {
      errors.push(
        `${rel}:${workflowsRef.lineNo}: \`workflows_ref\` is \`${workflowsRef.value}\` but ` +
          `\`uses:\` (line ${usesLineNo}) is pinned to \`${ref}\`. The two must be ` +
          `the same commit, or the review runs with prompts/scripts from a ` +
          `different commit than the workflow definition.`,
      );
    }
  }

  return errors;
}

function fail(message) {
  console.error(`check-workflow-pins: ${message}`);
  process.exit(1);
}

/**
 * Print ONE caller's `workflows_ref` SHA on stdout, and nothing else.
 *
 * Deliberately does NOT assert that `workflows_ref` equals the `uses:` ref:
 * that is the lint's assertion and the `workflow-pins` job's red build, and
 * reddening a second job for the same split pin would just double the noise.
 * What it does enforce is that the value is a full 40-hex SHA, because every
 * caller of this mode feeds it to git as a commit-ish -- a tag or branch there
 * would resolve to a moving target and make the answer meaningless.
 */
function printPin(callers, wanted) {
  const matches = callers.filter((c) => c.reusable === wanted);
  if (matches.length === 0) {
    fail(
      `--print-pin ${wanted}: no ${REUSABLE_OWNER_REPO} caller of \`${wanted}\` found ` +
        `under .github/workflows. Either the caller was removed or the reusable was renamed.`,
    );
  }
  if (matches.length > 1) {
    fail(
      `--print-pin ${wanted}: ${matches.length} callers of \`${wanted}\` found ` +
        `(${matches.map((c) => `${c.rel}:${c.usesLineNo}`).join(", ")}); this mode returns ` +
        `one pin and cannot choose between them.`,
    );
  }

  const [caller] = matches;
  const at = `${caller.rel}:${caller.usesLineNo}`;
  if (!caller.workflowsRef) {
    fail(`--print-pin ${wanted}: ${at} sets no \`workflows_ref\`; there is no pin to print.`);
  }

  const pin = caller.workflowsRef.value;
  if (!FULL_SHA_RE.test(pin)) {
    fail(
      `${caller.rel}:${caller.workflowsRef.lineNo}: \`workflows_ref\` is \`${pin}\`, not a ` +
        `full 40-hex commit SHA. Re-pin it to a commit; \`node scripts/check-workflow-pins.mjs\` ` +
        `explains the pair this belongs to.`,
    );
  }

  process.stdout.write(`${pin}\n`);
}

// --- CLI ------------------------------------------------------------------
const argv = process.argv.slice(2);
const printPinArg = (() => {
  const i = argv.indexOf("--print-pin");
  if (i !== -1) return argv[i + 1] ?? "";
  const inline = argv.find((a) => a.startsWith("--print-pin="));
  return inline === undefined ? null : inline.slice("--print-pin=".length);
})();

if (printPinArg !== null) {
  if (printPinArg === "") {
    fail("--print-pin needs a reusable workflow file name, e.g. `--print-pin cursor-review.yml`.");
  }
  printPin(findCallers(), printPinArg);
} else {
  const callers = findCallers();
  const errors = lint(callers);

  if (errors.length > 0) {
    console.error(
      `check-workflow-pins: ${errors.length} problem(s) with the ` +
        `${REUSABLE_OWNER_REPO} pin pair(s):\n`,
    );
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      `\nBoth pins move together. See the \`ignore:\` block in ` +
        `.github/dependabot.yml for why Dependabot must not move them for you.`,
    );
    process.exit(1);
  }

  if (callers.length === 0) {
    // Not an error -- the repo may simply not call these reusables any more --
    // but a lint that silently checks nothing is worse than no lint, so say so.
    console.log(`check-workflow-pins: no ${REUSABLE_OWNER_REPO} callers found; nothing to check.`);
  } else {
    console.log(
      `check-workflow-pins: ${callers.length} ${REUSABLE_OWNER_REPO} caller(s) ` +
        `checked, all pins agree.\n` +
        callers.map((c) => `  - ${c.rel}:${c.usesLineNo} -> ${c.reusable}`).join("\n"),
    );
  }
}
