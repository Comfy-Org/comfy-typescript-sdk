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
 * The scan is structure-aware in the three places text matching would
 * otherwise be wrong in the SILENT direction:
 *
 * - Block scalars (`run: |`) are skipped, so a `uses:` line quoted inside a
 *   shell script body is not mistaken for a caller. This file's own sibling
 *   ci.yml writes issue bodies about workflow pins inside `run: |`, so that is
 *   a live shape here, not a hypothetical one. A phantom caller would fail the
 *   lint on a pin that does not exist and, worse, make `--print-pin` ambiguous
 *   and take the daily `cursor-review-pin-freshness` watchdog down with it.
 * - The `uses` KEY may be quoted (`"uses":`), which YAML allows and which must
 *   not read as "no uses: here".
 * - A job-level `uses:` whose VALUE this scanner cannot read is REPORTED by
 *   file and line, not skipped: a block scalar (`uses: >-`), a value pushed
 *   onto a continuation line, an unterminated quoted scalar, or any other
 *   spelling that still names a Comfy-Org/github-workflows reusable. So is a
 *   job written as a FLOW mapping (`review: { uses: ..., with: { ... } }`),
 *   whose `uses:` never starts a line for the scan to match. Each of those
 *   used to read as "no caller here", so a split pin written that way next to
 *   one plain sibling caller passed the lint, and `--print-pin` answered with
 *   the sibling's SHA instead of refusing. Both modes now exit 1 naming the
 *   line -- and the message names the spelling to write instead, so the fix is
 *   a reword, not a call the author can no longer make. A single-line `uses:`
 *   naming some OTHER owner -- a local reusable, or a third party's -- is read
 *   fine and is genuinely not this lint's business, so it stays a silent skip.
 *
 * A STEP's `uses:` is deliberately NOT matched, and that is enforced by
 * POSITION rather than by spelling: the matched `uses:` must be a direct child
 * of a `<job id>:` key which is itself a direct child of the top-level `jobs:`.
 * Spelling alone is not enough -- it rules out `- uses:`, where `uses` is the
 * step's first key, but the form written throughout this repo (`- name:` on one
 * line, `uses:` indented beneath) is a plain mapping key and matches. Either
 * way `jobs.<id>.uses` is the only place GitHub accepts a reusable-workflow
 * call; a `uses:` inside `steps:` is a composite ACTION, which pins once and
 * has no `workflows_ref` to disagree with. Matching one would make this lint
 * demand a pin that cannot exist.
 *
 * Finding NO caller at all is an ERROR. This repo calls these reusables, so an
 * empty scan means the lint checked nothing, and the same edit would silence
 * `--print-pin` and the daily watchdog with it.
 *
 * One documented limit, which reads as "input absent": on a job whose `uses:`
 * IS readable, a `with:` written as a FLOW mapping (`with: { ... }`) is not
 * parsed. That fails LOUDLY as a missing input rather than passing silently,
 * which is the direction this lint is allowed to be wrong in -- so it does not
 * justify carrying a YAML parser into a job that deliberately runs without
 * `pnpm install`. (A job whose WHOLE body is a flow mapping is a different
 * case and is reported by name, above: there the `uses:` is unreadable too, so
 * nothing is left to fail loudly about.)
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

// `workflows_ref` is REQUIRED of every caller unless the reusable it calls is
// named here. The default is deliberately fail-CLOSED: an opt-in allowlist
// means a reusable nobody remembered to add is skipped in silence, which is the
// same split-pin escape this script exists to catch -- and it would swallow the
// flow-mapping `with:` limit too, since that also reads as "input absent".
// Failing closed turns both into a red build naming the file and the line.
//
// Add a reusable here only after checking upstream that its `workflow_call`
// declares no `workflows_ref` input at all. Empty today: the org's reusables
// that this repo calls all take one.
const NO_WORKFLOWS_REF = new Set([]);

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
// `uses: Comfy-Org/github-workflows/.github/workflows/<name>.yml@<ref>  # <comment>`
// The value may be quoted (`uses: "owner/repo/...@sha"`). Unquoted is what
// every caller doc writes, but a quoted one must not read as "no uses: here" --
// a silent skip is the one direction this lint must never fail in.
// Matched only as a job-level mapping KEY, never as a step's `- uses:` (see
// the header). The key and the value may each be quoted.
const USES_RE = new RegExp(
  String.raw`^(\s*)(["']?)uses\2\s*:\s*(["']?)` +
    REUSABLE_OWNER_REPO.replace("/", "\\/") +
    String.raw`\/(\S+?)@([^\s"']+?)\3\s*(?:#(.*))?$`,
);
const WORKFLOWS_REF_RE = /^\s*workflows_ref:\s*(["']?)([^\s"']+?)\1\s*(?:#.*)?$/;
// A line that opens a BLOCK SCALAR (`run: |`, `body: >-`). Group 1 spans the
// indent AND any `- ` sequence marker, so its length is the KEY's column --
// block content is indented deeper than the key, which for `- run: |` is not
// the same as deeper than the dash.
const BLOCK_SCALAR_RE = /^(\s*(?:-\s+)?)[^\s#][^:]*:\s*[|>][0-9+-]*\s*(?:#.*)?$/;
// Short-SHA candidates inside the trailing comment. The DOCUMENTED spelling
// parenthesises the abbreviation (`# github-workflows main (425c154)`), so when
// the comment carries any parenthesised candidate those are the whole set --
// anything else in the comment is prose and not a claim about this pin.
const PAREN_SHA_RE = /\(([0-9a-f]{7,40})\)/g;
// Fallback for a comment written without parentheses: 7-40 hex characters as a
// whole word. 7 is git's minimum abbreviation, so shorter tokens (`# v7`) are
// version spellings. All-DIGIT runs are dropped: `20260919` is a date, and a
// real abbreviated SHA that happens to be all digits is a 1-in-1.7-million
// coincidence that costs only a comment reworded to the parenthesised form.
const BARE_SHA_RE = /\b[0-9a-f]{7,40}\b/g;
// A `<job id>:` key -- a bare key with no value, optionally quoted. GitHub
// restricts job ids to `[A-Za-z_][A-Za-z0-9_-]*`.
const JOB_ID_KEY_RE = /^(["']?)[A-Za-z_][A-Za-z0-9_-]*\1\s*:\s*(?:#.*)?$/;
const JOBS_KEY_RE = /^(["']?)jobs\1\s*:\s*(?:#.*)?$/;
// A `uses` KEY with ANY value at all, including none on this line. `USES_RE`
// above matches only the value spellings this scanner can READ, so the gap
// between the two is exactly the set of `uses:` lines that would otherwise be
// skipped in silence -- which is what `unreadableUsesReason` classifies.
const USES_KEY_RE = /^(\s*)(["']?)uses\2\s*:(.*)$/;
// A `<job id>:` whose value opens a FLOW mapping (`review: { uses: ... }`).
// Being a job rather than some other flow-mapped key is decided by POSITION at
// the call site (its owning key must be the column-0 `jobs:`), not by
// hardcoding the two-space indent every workflow in this repo happens to use.
//
// EVERY such job is reported, including one that calls no reusable at all: a
// flow mapping nests to any depth on one line, so "does this contain a
// `uses:`" is precisely the question a line-anchored scanner cannot answer,
// and guessing at it would put the silent skip straight back. No workflow in
// this repo is written that way, and the remedy the message asks for -- spell
// the job as a block mapping -- costs a reformat.
const FLOW_JOB_RE = /^(["']?)[A-Za-z_][A-Za-z0-9_-]*\1\s*:\s*\{/;
// A value that is nothing but a block-scalar header: `|`, `>-`, `|2`, `>2-`.
// Same indicator class as `BLOCK_SCALAR_RE`, which is deliberately loose about
// the order of the chomping and indentation indicators.
const BLOCK_SCALAR_VALUE_RE = /^[|>][0-9+-]*$/;

/**
 * Commit abbreviations the trailing comment claims, most precise form first.
 *
 * The all-digit filter applies to BOTH branches. It used to sit only on the
 * fallback, so the parenthesised branch returned every token raw and
 * short-circuited past it -- and since the caller requires every candidate to
 * prefix the ref, a perfectly correct
 * `# github-workflows main (425c154) -- bumped (20260919)` reddened CI over the
 * date. That is the same false positive the digit filter was added to remove.
 *
 * ALL surviving candidates are returned, not just the first. A comment naming a
 * second commit is ambiguous either way, and honouring only the first would
 * miss a stale token written after a fresh one -- trading this loud, one-reword
 * false positive for a silent miss, which is the direction this lint is not
 * allowed to be wrong in.
 */
function commentShaCandidates(comment) {
  const looksHex = (c) => /[a-f]/.test(c);
  const parenthesised = [...comment.matchAll(PAREN_SHA_RE)].map((m) => m[1]).filter(looksHex);
  if (parenthesised.length > 0) return parenthesised;
  return (comment.match(BARE_SHA_RE) ?? []).filter(looksHex);
}

/**
 * Every line that is CONTENT of a block scalar (`key: |`/`>`), by index.
 *
 * The forward scan in `findCallers` has always tracked this, but the WALK-BACK
 * that resolves a `uses:` to its owning key did not -- it read raw lines, so a
 * column-0 line inside an earlier `run: |` body (a flush-left heredoc body, or
 * its `EOF` terminator) was returned as the owning key. `isJobLevelUses` then
 * said false and a genuine job-level caller was dropped with NO output, which
 * is the silent skip this lint's header promises never happens. Computing the
 * mask once per file and sharing it keeps the two directions agreeing about
 * what is structure and what is text.
 */
function blockScalarMask(lines) {
  const mask = Array.from({ length: lines.length }, () => false);
  let blockKeyIndent = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const indent = lines[i].length - trimmed.length;

    if (blockKeyIndent !== null) {
      if (trimmed === "" || indent > blockKeyIndent) {
        mask[i] = true;
        continue;
      }
      blockKeyIndent = null;
    }

    if (trimmed.startsWith("#")) continue;

    const bm = BLOCK_SCALAR_RE.exec(lines[i]);
    if (bm) blockKeyIndent = bm[1].length;
  }

  return mask;
}

/**
 * The nearest line above `index` indented SHALLOWER than `indent`, skipping
 * blanks, whole-line comments and block-scalar CONTENT -- that is, the key that
 * owns it.
 */
function owningKey(lines, index, indent, inBlock) {
  for (let i = index - 1; i >= 0; i--) {
    if (inBlock[i]) continue;
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const ownIndent = lines[i].length - lines[i].trimStart().length;
    if (ownIndent < indent) return { trimmed, indent: ownIndent, index: i };
  }
  return null;
}

/**
 * True when the `uses:` on `usesIndex` really is `jobs.<id>.uses`.
 *
 * SPELLING IS NOT ENOUGH. `USES_RE` only rules out the step form whose FIRST
 * key is `uses` (`- uses:`); the form this repo writes throughout -- `- name:`
 * on one line and `uses:` indented beneath it -- is a plain mapping key and
 * matches it happily. So a step consuming a `Comfy-Org/github-workflows`
 * composite ACTION would be pulled into the lint, and with `NO_WORKFLOWS_REF`
 * failing closed it would hard-error demanding a `workflows_ref` input that a
 * composite action cannot accept -- exactly the outcome the header promises is
 * avoided. Position is what actually selects a reusable call: the `uses:` must
 * be a direct child of a `<job id>:` key, which is itself a direct child of the
 * top-level `jobs:`.
 */
function isJobLevelUses(lines, usesIndex, usesIndent, inBlock) {
  const job = owningKey(lines, usesIndex, usesIndent, inBlock);
  if (job === null || !JOB_ID_KEY_RE.test(job.trimmed)) return false;
  const jobs = owningKey(lines, job.index, job.indent, inBlock);
  return jobs !== null && jobs.indent === 0 && JOBS_KEY_RE.test(jobs.trimmed);
}

/**
 * A YAML value with its trailing `# ...` comment removed.
 *
 * A comment opens at a `#` that begins the value or follows whitespace, which
 * is YAML's own rule -- `@sha#1` is part of the ref, not a comment.
 */
function stripTrailingComment(value) {
  const at = value.search(/(?:^|\s)#/);
  return at === -1 ? value : value.slice(0, at).trim();
}

/**
 * Why a job-level `uses:` value cannot be read, or `null` when it reads fine
 * and simply names something that is not this lint's business.
 *
 * Reached only for a `uses:` that `USES_RE` did NOT match, so "reads fine" here
 * means a single-line value naming some other owner -- a local reusable
 * (`./.github/workflows/x.yml`) or a third party's
 * (`octo/repo/.github/workflows/x.yml@v1`). Those pin once, have no
 * `workflows_ref` to disagree with, and are correctly skipped in silence.
 *
 * Everything else is a spelling this text-level scanner cannot see THROUGH,
 * and every one of them used to be indistinguishable from "no caller on this
 * line". The quoted-scalar check runs on the RAW value, before the comment is
 * stripped, so a `#` inside an unterminated quote is read as part of the
 * scalar rather than as the comment that would make the quote look closed.
 */
function unreadableUsesReason(rawValue) {
  const raw = rawValue.trim();

  const quote = raw[0];
  if ((quote === '"' || quote === "'") && !raw.slice(1).includes(quote)) {
    return "multi-line quoted scalar";
  }

  const value = stripTrailingComment(raw);
  if (value === "") return "value on a continuation line";
  if (BLOCK_SCALAR_VALUE_RE.test(value)) return "folded/literal block scalar";
  // GitHub resolves owner and repository names CASE-INSENSITIVELY, so
  // `comfy-org/github-workflows/...` names the very same reusable as the
  // canonical spelling and calls it successfully. `USES_RE` is case-sensitive
  // and does not read such a line as a caller, so a case-sensitive test HERE
  // would return null and skip it in silence -- reinstating, over nothing but
  // letter case, the invisible-caller hole this function exists to close: the
  // lint would report "all pins agree" across a genuinely split pair and
  // `--print-pin` would hand the watchdog the other job's SHA.
  if (value.toLowerCase().includes(REUSABLE_OWNER_REPO.toLowerCase())) {
    return "owner/path/ref did not parse";
  }

  return null;
}

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
function workflowsRefInput(lines, usesIndex, usesIndent, inBlock) {
  let inWith = false;
  // The indent shared by `with:`'s direct children, learned from the first one.
  let withChildIndent = null;

  // Walk back to the job's `<job id>:` key -- the nearest shallower line above
  // `uses:` -- and start just after it, so a `with:` block written above
  // `uses:` is still inside the scanned body.
  let bodyStart = 0;
  for (let i = usesIndex - 1; i >= 0; i--) {
    if (inBlock[i]) continue;
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (lines[i].length - lines[i].trimStart().length < usesIndent) {
      bodyStart = i + 1;
      break;
    }
  }

  for (let i = bodyStart; i < lines.length; i++) {
    // Block-scalar CONTENT is text, not structure: a flush-left line in a
    // `run: |` body must not read as "shallower than `uses:`" and end the job.
    if (inBlock[i]) continue;
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
 * Every `Comfy-Org/github-workflows` caller in `.github/workflows`, parsed,
 * plus every job-level `uses:` written in a spelling this scanner cannot read.
 *
 * PARSING ONLY -- it asserts nothing at all. Both modes read these records, so
 * neither can drift from the other about what counts as a caller, which line
 * holds its `uses:` ref, or where its `workflows_ref` input lives.
 *
 * `unreadable` is the fail-closed half, and both modes must read it. A caller
 * the scanner cannot see is not the same thing as a caller that is not there:
 * with one plain sibling caller in the file, an unreadable second job left the
 * lint reporting "all pins agree" over a split pair, and left `--print-pin`
 * returning the sibling's SHA to the daily watchdog as though it were the only
 * pin in the repo.
 */
function findCallers() {
  const callers = [];
  const unreadable = [];

  for (const file of readdirSync(WORKFLOWS_DIR).sort()) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const rel = `.github/workflows/${file}`;
    const lines = readFileSync(join(WORKFLOWS_DIR, file), "utf8").split("\n");

    // Computed ONCE and shared with the walk-backs below, so the forward and
    // backward directions can never disagree about which lines are structure.
    const inBlock = blockScalarMask(lines);

    for (let i = 0; i < lines.length; i++) {
      // Inside a block scalar: content, never structure.
      if (inBlock[i]) continue;

      const trimmed = lines[i].trimStart();

      // A whole-line comment can quote a `uses:` while documenting it; the
      // header of ci-cursor-review.yml does exactly that.
      if (trimmed.startsWith("#")) continue;

      // A job whose whole body is a FLOW mapping hides its `uses:` mid-line,
      // where no line-anchored match can reach it. Position is what makes this
      // a job rather than some other flow-mapped key -- `on: { push: { ... } }`
      // is owned by `on:`, not by `jobs:`, and must not be reported.
      if (FLOW_JOB_RE.test(trimmed)) {
        const indent = lines[i].length - trimmed.length;
        const jobs = owningKey(lines, i, indent, inBlock);
        if (jobs !== null && jobs.indent === 0 && JOBS_KEY_RE.test(jobs.trimmed)) {
          unreadable.push({
            rel,
            lineNo: i + 1,
            reason: "job written as a flow mapping",
          });
          continue;
        }
      }

      const m = USES_RE.exec(lines[i]);
      if (!m) {
        // Not a value this scanner can read -- but the KEY may still be a
        // job-level `uses:`, in which case failing closed on it is the whole
        // point. `unreadableUsesReason` returns null for the one shape that is
        // legitimately none of this lint's business.
        const km = USES_KEY_RE.exec(lines[i]);
        if (km !== null && isJobLevelUses(lines, i, km[1].length, inBlock)) {
          const reason = unreadableUsesReason(km[3]);
          if (reason !== null) unreadable.push({ rel, lineNo: i + 1, reason });
        }
        continue;
      }

      const [, indentStr, , , workflowPath, ref, comment] = m;

      // `jobs.<id>.uses` only -- see `isJobLevelUses`. A composite-action step
      // is not a reusable-workflow call and has no second pin to disagree.
      if (!isJobLevelUses(lines, i, indentStr.length, inBlock)) continue;

      callers.push({
        rel,
        reusable: workflowPath.split("/").pop(),
        usesLineNo: i + 1,
        ref,
        comment,
        workflowsRef: workflowsRefInput(lines, i, indentStr.length, inBlock),
      });
    }
  }

  return { callers, unreadable };
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
      for (const candidate of commentShaCandidates(comment)) {
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
      if (!NO_WORKFLOWS_REF.has(reusable)) {
        errors.push(
          `${at}: this job calls \`${reusable}\` but passes no ` +
            `\`workflows_ref\` input. An omitted input arrives as \`''\`, and the ` +
            `reusable would load its prompts/scripts from an empty ref. Add ` +
            `\`workflows_ref: ${ref}\` under \`with:\` -- or, if \`${reusable}\` ` +
            `genuinely declares no such input upstream, add it to ` +
            `\`NO_WORKFLOWS_REF\` in this script.`,
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
 * Report every unreadable job-level `uses:` on STDERR and exit 1.
 *
 * Runs in BOTH modes, and before either mode's own checks, because neither can
 * say anything true while a caller is invisible to it: the lint would compare
 * the pins it can see and call them agreed, and `--print-pin` would hand the
 * watchdog one SHA as if it were the only pin in the repo. Nothing goes to
 * STDOUT -- `cursor-review-pin-freshness` captures this script's stdout with
 * `$(...)`, so a diagnostic written there becomes the "pin" it feeds to git.
 */
function reportUnreadable(unreadable) {
  console.error(
    `check-workflow-pins: ${unreadable.length} job-level \`uses:\` line(s) this ` +
      `checker cannot read:\n`,
  );
  for (const { rel, lineNo, reason } of unreadable) {
    console.error(
      `  - ${rel}:${lineNo}: job-level \`uses:\` is written in a spelling this checker ` +
        `cannot read (${reason}); write ` +
        `\`uses: ${REUSABLE_OWNER_REPO}/.github/workflows/<name>.yml@<sha>\` on one line`,
    );
  }
  console.error(
    `\nThis is a fail-CLOSED report, not a style rule: a caller this scanner ` +
      `cannot see reads exactly like no caller at all, so a pin split inside ` +
      `one would pass the lint and \`--print-pin\` would answer with some other ` +
      `job's SHA.`,
  );
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
  const { callers, unreadable } = findCallers();
  if (unreadable.length > 0) reportUnreadable(unreadable);
  printPin(callers, printPinArg);
} else {
  const { callers, unreadable } = findCallers();

  // Checked BEFORE the zero-caller guard below, so a file whose only caller is
  // unreadable is reported as the spelling it is rather than as an empty repo.
  if (unreadable.length > 0) reportUnreadable(unreadable);

  // ZERO CALLERS IS AN ERROR, not a notice. This repo does call these
  // reusables, so an empty result means this lint checked NOTHING. The
  // spellings that used to be the likeliest cause -- a folded `uses: >-`, a
  // flow-mapping job -- are reported by name above, so reaching here means the
  // scanner found no job-level `uses:` at all. That edit would take
  // `--print-pin` down with it and silence the daily
  // `cursor-review-pin-freshness` watchdog in the same change, so the lint and
  // its watchdog would go quiet together. Fail loudly instead.
  if (callers.length === 0) {
    fail(
      `no ${REUSABLE_OWNER_REPO} caller found under .github/workflows, so this ` +
        `lint checked nothing. If the callers really were removed, delete this ` +
        `script along with its \`workflow-pins\` job and the ` +
        `\`cursor-review-pin-freshness\` watchdog that depends on \`--print-pin\`.`,
    );
  }

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

  console.log(
    `check-workflow-pins: ${callers.length} ${REUSABLE_OWNER_REPO} caller(s) ` +
      `checked, all pins agree.\n` +
      callers.map((c) => `  - ${c.rel}:${c.usesLineNo} -> ${c.reusable}`).join("\n"),
  );
}
