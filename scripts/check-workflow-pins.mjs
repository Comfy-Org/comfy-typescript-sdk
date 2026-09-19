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
 * Documented limit: a `workflows_ref:` written INSIDE a block scalar in the
 * same job (rather than as a real `with:` key) would be read as the input.
 * Nothing in this repo does that, and the failure is a loud false alarm rather
 * than a silent miss, so it does not justify carrying a YAML parser into a job
 * that deliberately runs without `pnpm install`.
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

const errors = [];
const checked = [];

/**
 * The lines belonging to the job that owns the `uses:` on `usesIndex`.
 *
 * A job's `uses:`, `with:` and `secrets:` are siblings at the same indent, so
 * the job body runs until a line appears at a SHALLOWER indent than that --
 * which is the next job's key, or the next top-level key. Blank lines and
 * whole-line comments carry no structure and never end the body (a comment is
 * often written flush-left).
 */
function jobBodyAfter(lines, usesIndex, usesIndent) {
  const body = [];
  for (let i = usesIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent < usesIndent) break;
    body.push({ line, lineNo: i + 1 });
  }
  return body;
}

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
    const usesLineNo = i + 1;
    const reusable = workflowPath.split("/").pop();
    const at = `${rel}:${usesLineNo}`;
    checked.push(`${rel}:${usesLineNo} -> ${reusable}`);

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
    const indent = indentStr.length;
    const body = jobBodyAfter(lines, i, indent);
    const refLine = body
      .map(({ line, lineNo }) => {
        const rm = WORKFLOWS_REF_RE.exec(line);
        return rm ? { value: rm[2], lineNo } : null;
      })
      .find(Boolean);

    if (!refLine) {
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

    if (refLine.value !== ref) {
      errors.push(
        `${rel}:${refLine.lineNo}: \`workflows_ref\` is \`${refLine.value}\` but ` +
          `\`uses:\` (line ${usesLineNo}) is pinned to \`${ref}\`. The two must be ` +
          `the same commit, or the review runs with prompts/scripts from a ` +
          `different commit than the workflow definition.`,
      );
    }
  }
}

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

if (checked.length === 0) {
  // Not an error -- the repo may simply not call these reusables any more --
  // but a lint that silently checks nothing is worse than no lint, so say so.
  console.log(`check-workflow-pins: no ${REUSABLE_OWNER_REPO} callers found; nothing to check.`);
} else {
  console.log(
    `check-workflow-pins: ${checked.length} ${REUSABLE_OWNER_REPO} caller(s) ` +
      `checked, all pins agree.\n` +
      checked.map((c) => `  - ${c}`).join("\n"),
  );
}
