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
 * The scan is structure-aware in the two places text matching would otherwise
 * be wrong in the SILENT direction:
 *
 * - Block scalars (`run: |`) are skipped, so a `uses:` line quoted inside a
 *   shell script body is not mistaken for a caller. This file's own sibling
 *   ci.yml writes issue bodies about workflow pins inside `run: |`, so that is
 *   a live shape here, not a hypothetical one. A phantom caller would fail the
 *   lint on a pin that does not exist and, worse, make `--print-pin` ambiguous
 *   and take the daily `cursor-review-pin-freshness` watchdog down with it.
 * - The `uses` KEY may be quoted (`"uses":`), which YAML allows and which must
 *   not read as "no uses: here".
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
 * empty scan means the lint checked nothing -- far more likely a caller in a
 * shape this scanner cannot see than a real removal, and the same edit would
 * silence `--print-pin` and the daily watchdog with it.
 *
 * One documented limit, which reads as "input absent": a `with:` written as a
 * FLOW mapping (`with: { ... }`) is not parsed. That fails LOUDLY as a missing
 * input rather than passing silently, which is the direction this lint is
 * allowed to be wrong in -- so it does not justify carrying a YAML parser into
 * a job that deliberately runs without `pnpm install`.
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

// Reusables the `cursor-review-pin-freshness` watchdog in .github/workflows/ci.yml
// actually watches -- it asks `--print-pin` for ONE named file.
//
// The `ignore:` block in .github/dependabot.yml is deliberately repo-WIDE for
// every `Comfy-Org/github-workflows` reusable, security advisories included,
// because Dependabot cannot move a double-pinned caller correctly at all. That
// leaves upstream staleness entirely to the watchdog -- so a SECOND org
// reusable called from this repo would have its only bump mechanism muted and
// no freshness alarm to replace it, and `lint()` below would prove nothing more
// than that its two pins agree with each other while both froze together. That
// is precisely the silently-frozen pin this whole lint exists to end, so
// adding such a caller is a red build here until the watchdog is extended to
// cover it too.
const WATCHDOG_COVERED = new Set(["cursor-review.yml"]);

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

// `owner/repo` as a case-INSENSITIVE regex fragment, one character class per
// letter. GitHub resolves an owner and a repository name without regard to
// case, so `comfy-org/github-workflows/...` is a WORKING caller of the very
// reusable this script exists to police -- but interpolated case-sensitively it
// was invisible to the scan, and with the canonical-case caller keeping
// `callers.length` non-zero the repo-wide fail-closed guard below never noticed.
// An invisible caller may carry a branch ref or a split pin straight past the
// lint, which is the silent skip this file's header promises never happens.
// Only the owner and repository are relaxed: the workflow PATH after them is a
// git path and stays case-sensitive, as do the ref comparisons.
const caseInsensitiveOwnerRepo = (s) =>
  s.replace(/[A-Za-z]/g, (ch) => `[${ch.toUpperCase()}${ch.toLowerCase()}]`).replace(/\//g, "\\/");

// `uses: Comfy-Org/github-workflows/.github/workflows/<name>.yml@<ref>  # <comment>`
// The value may be quoted (`uses: "owner/repo/...@sha"`). Unquoted is what
// every caller doc writes, but a quoted one must not read as "no uses: here" --
// a silent skip is the one direction this lint must never fail in.
// Matched only as a job-level mapping KEY, never as a step's `- uses:` (see
// the header). The key and the value may each be quoted.
// The owner/repo is CAPTURED as well as matched, so lint (4) below can hold
// every caller to ONE spelling. A non-canonical caller is still MATCHED here --
// deliberately, since an unseen caller is the one failure this lint must never
// have -- and is then reported rather than skipped.
//
// That lint is HYGIENE, not the other half of the ignore: Dependabot compares
// `dependency-name` with `Dependabot::Config::UpdateConfig.wildcard_match?`,
// which LOWERCASES both pattern and candidate, so a caller spelled
// `comfy-org/github-workflows` is already covered by the canonical-case entry
// in `.github/dependabot.yml`. (An earlier draft of this comment claimed the
// match was case-SENSITIVE and that a lowercase caller escaped the ignore --
// it does not; see the same correction in that file.) What one spelling buys
// is that the caller, that ignore entry and the pin `--print-pin` hands the
// freshness watchdog all name the dependency identically.
// The path segment is `[^@\s"']+`, NOT a lazy `\S+?`. Two nested lazy
// quantifiers over overlapping character sets backtrack quadratically on a
// line that does not match: `uses: Comfy-Org/github-workflows/` followed by
// many `@` and a trailing quote gives the outer group one start position per
// `@`, and forces the inner group to grow to the quote from each of them.
// Measured at 4x per doubling of the `@` run. This job runs on `pull_request`
// and checks out the MERGE COMMIT, so a fork PR could add such a
// `.github/workflows/*.yml` and burn the job to its timeout. Excluding `@`
// from the path leaves exactly one split point per line, which is linear --
// and matches identically, since the separator is the FIRST `@` either way
// (a ref may still contain `@`, and still does: group 6 is unchanged).
const USES_RE = new RegExp(
  String.raw`^(\s*)(["']?)uses\2\s*:\s*(["']?)(` +
    caseInsensitiveOwnerRepo(REUSABLE_OWNER_REPO) +
    String.raw`)\/([^@\s"']+)@([^\s"']+?)\3(?:\s+#(.*))?\s*$`,
);
// The `#` must be preceded by WHITESPACE in both patterns: YAML starts a comment
// only at a `#` that follows a space (or opens the line), so
// `workflows_ref: <40-hex>#oops` is the single scalar `<40-hex>#oops`, not a pin
// carrying a comment. Allowing a bare `#` let that line lint CLEAN as a 40-hex
// pin while GitHub received the literal `<sha>#oops` -- and handed the same
// wrong value to the `cursor-review-pin-freshness` watchdog via `--print-pin`.
// The closing `\s*` still tolerates trailing whitespace.
// The KEY may be quoted, for the same reason `USES_RE` and the `with:` test
// tolerate one: `"workflows_ref": <sha>` is valid YAML that GitHub accepts and
// that genuinely passes the input. Matched bare, such a caller read as passing
// NO pin -- `lint()` reported "passes no `workflows_ref` input" and `printPin`
// failed, which the daily watchdog turns into a `broken` verdict and a sticky
// issue blaming a caller that is in fact correct. All three key patterns now
// agree.
const WORKFLOWS_REF_RE = /^\s*(["']?)workflows_ref\1\s*:\s*(["']?)([^\s"']+?)\2(?:\s+#.*)?\s*$/;
// A line that opens a BLOCK SCALAR (`run: |`, `body: >-`). Group 1 spans the
// indent AND any `- ` sequence marker, so its length is the KEY's column --
// block content is indented deeper than the key, which for `- run: |` is not
// the same as deeper than the dash.
const BLOCK_SCALAR_RE = /^(\s*(?:-\s+)?)[^\s#][^:]*:\s*[|>][0-9+-]*\s*(?:#.*)?$/;
// Short-SHA candidates inside the trailing comment. The DOCUMENTED spelling
// parenthesises the abbreviation (`# github-workflows main (425c154)`), so when
// the comment carries any parenthesised candidate those are the whole set --
// anything else in the comment is prose and not a claim about this pin.
//
// BOTH patterns accept `A-F` as well as `a-f`. Hex commit IDs are
// case-insensitive, so `# github-workflows main (DEADBEE)` plainly names a
// commit -- but matched lowercase-only it yielded no candidate at all and
// assertion (3) was skipped without a word, the silent direction this file's
// header promises to avoid. Candidates are lowercased at the COMPARISON site
// rather than here, so the error message still quotes the comment as written.
const PAREN_SHA_RE = /\(([0-9a-fA-F]{7,40})\)/g;
// Fallback for a comment written without parentheses: 7-40 hex characters as a
// whole word. 7 is git's minimum abbreviation, so shorter tokens (`# v7`) are
// version spellings. DATE-shaped runs are dropped -- see `commentShaCandidates`
// for why that test is a LENGTH one rather than "contains no a-f".
const BARE_SHA_RE = /\b[0-9a-fA-F]{7,40}\b/g;
// A `uses:` MAPPING KEY that opens a block scalar (`uses: >-`, `uses: |`) and
// so carries its value on the following lines. Same key shapes `USES_RE`
// tolerates; only the value differs.
const USES_BLOCK_SCALAR_RE = /^(\s*)(["']?)uses\2\s*:\s*[|>][0-9+-]*\s*(?:#.*)?$/;
// The OTHER way a `uses:` value can sit on the following line: a plain
// multi-line scalar, with no `|`/`>` indicator at all and the value simply
// indented beneath the key. It is valid YAML that GitHub accepts, and it
// evades the scan even more completely than the block-scalar form --
// `USES_RE` sees no value, `USES_BLOCK_SCALAR_RE` sees no indicator, and
// `blockScalarMask` does not mark the continuation lines either (there is no
// indicator for it to key on), so nothing hides them and nothing reads them.
// Same consequence as the block-scalar shape: the caller is dropped in
// silence, free to carry a branch ref or a split pin, while the repo-wide
// zero-caller guard stays quiet because other callers keep the count
// non-zero.
const USES_EMPTY_VALUE_RE = /^(\s*)(["']?)uses\2\s*:\s*(?:#.*)?$/;
// The same owner/repo, for testing a block scalar's folded VALUE rather than a
// whole `uses:` line.
const OWNER_REPO_RE = new RegExp(caseInsensitiveOwnerRepo(REUSABLE_OWNER_REPO));
// A `<job id>:` key -- a bare key with no value, optionally quoted. GitHub
// restricts job ids to `[A-Za-z_][A-Za-z0-9_-]*`.
const JOB_ID_KEY_RE = /^(["']?)[A-Za-z_][A-Za-z0-9_-]*\1\s*:\s*(?:#.*)?$/;
const JOBS_KEY_RE = /^(["']?)jobs\1\s*:\s*(?:#.*)?$/;

/**
 * Commit abbreviations the trailing comment claims, most precise form first.
 *
 * The date filter applies to BOTH branches. It used to sit only on the
 * fallback, so the parenthesised branch returned every token raw and
 * short-circuited past it -- and since the caller requires every candidate to
 * prefix the ref, a perfectly correct
 * `# github-workflows main (425c154) -- bumped (20260919)` reddened CI over the
 * date. That is the same false positive the filter was added to remove.
 *
 * The test is LENGTH, not "contains an a-f". Dropping every ALL-DIGIT token was
 * far too broad: a hex abbreviation is all digits with probability (10/16)^n,
 * which at git's 7-character minimum is ~3.7% -- about 1 in 27, not the
 * 1-in-1.7-million a "digits are never a SHA" reading assumes. That silently
 * skipped assertion (3) for roughly one caller in 27, and a check that silently
 * verifies nothing is the direction this script's header promises never to fail
 * in. A date written for humans is 8 digits (`20260919`), so only 8-digit runs
 * are dropped; 7-digit and 9-plus-digit runs are kept and checked like any
 * other abbreviation. An 8-character all-digit SHA abbreviation is still
 * skipped -- ~2.3%, and unlike the old filter it costs only the one caller that
 * writes its abbreviation to 8 characters instead of the documented 7.
 *
 * ALL surviving candidates are returned, not just the first. A comment naming a
 * second commit is ambiguous either way, and honouring only the first would
 * miss a stale token written after a fresh one -- trading this loud, one-reword
 * false positive for a silent miss, which is the direction this lint is not
 * allowed to be wrong in.
 */
function commentShaCandidates(comment) {
  const notADate = (c) => !/^[0-9]{8}$/.test(c);
  const parenthesised = [...comment.matchAll(PAREN_SHA_RE)].map((m) => m[1]).filter(notADate);
  if (parenthesised.length > 0) return parenthesised;
  return (comment.match(BARE_SHA_RE) ?? []).filter(notADate);
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
 * For every line, the chain of enclosing mapping keys VISIBLE above it --
 * innermost first, each node linking outward to the key that owns it.
 *
 * This is the "previous smaller indent" stack, built in ONE forward pass and
 * shared by every walk-back in this file. It replaces a scan that started at
 * the `uses:` line and walked backward to a shallower line each time it was
 * asked. That scan was O(file) per question, and `isJobLevelUses` asks it
 * three times per caller while `workflowsRefInput` asks a fourth -- so a
 * workflow file carrying N sibling job-level `uses: Comfy-Org/github-workflows/...`
 * lines at one indent cost O(N^2), with a `trim()`/`trimStart()` allocation
 * per iteration. `workflow-pins` runs on `pull_request` against the MERGE
 * COMMIT, so a fork PR could add such a `.github/workflows/*.yml` and push the
 * job toward its 5-minute timeout -- the same reachability that got the
 * quadratic `USES_RE` backtracking fixed, by the same route.
 *
 * A lookup is now O(nesting depth), which YAML bounds at a handful of levels
 * regardless of how long the file is.
 *
 * Skipping rules are UNCHANGED and live here alone, so the forward and
 * backward directions cannot drift about what counts as structure: block-
 * scalar CONTENT, blank lines and whole-line comments are not keys, and
 * neither is a document marker (`---`, `...`) or a `%YAML`/`%TAG` directive.
 * Those last two matter because they sit at column 0: against an INDENTED root
 * mapping (legal YAML that GitHub accepts, and the case `isJobLevelUses` asks
 * its question structurally to support) one would otherwise be returned as the
 * owner of `jobs:`, which then reads as non-root, drops every caller in the
 * file, and passes with no output -- the silent skip this file's header
 * promises never happens. Matched as a PREFIX, not compared exactly, because
 * YAML allows a comment after either marker (`--- # doc`, `... # end`) and
 * allows `---` to be followed by a node on the same line.
 */
function owningKeyChain(lines, inBlock) {
  const chain = Array.from({ length: lines.length }, () => null);
  let top = null;

  for (let i = 0; i < lines.length; i++) {
    // What a question asked AT line `i` can see above it -- recorded before
    // line `i` itself joins the stack, so a line is never its own owner.
    chain[i] = top;

    if (inBlock[i]) continue;
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (/^(---|\.\.\.)(\s|$)/.test(trimmed) || trimmed.startsWith("%")) continue;

    const indent = lines[i].length - lines[i].trimStart().length;
    // A key at or deeper than this one is closed by it, so it can no longer
    // own anything below -- and it can never be the nearest shallower line for
    // a later question either, because THIS line sits between the two and is
    // at least as shallow.
    while (top !== null && top.indent >= indent) top = top.parent;
    top = { trimmed, indent, index: i, parent: top };
  }

  return chain;
}

/**
 * The nearest line above `index` indented SHALLOWER than `indent` -- that is,
 * the key that owns it -- or `null` if nothing does.
 *
 * Read off the precomputed chain rather than rescanned. The chain's indents
 * increase from the outside in, so the FIRST node shallower than `indent` is
 * also the nearest one above `index`.
 */
function owningKey(chain, index, indent) {
  let node = chain[index];
  while (node !== null && node.indent >= indent) node = node.parent;
  return node;
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
function isJobLevelUses(chain, usesIndex, usesIndent) {
  const job = owningKey(chain, usesIndex, usesIndent);
  if (job === null || !JOB_ID_KEY_RE.test(job.trimmed)) return false;
  const jobs = owningKey(chain, job.index, job.indent);
  if (jobs === null || !JOBS_KEY_RE.test(jobs.trimmed)) return false;
  // `jobs:` must be a ROOT key, which is asked STRUCTURALLY -- nothing
  // shallower owns it -- rather than as `indent === 0`. A YAML block mapping
  // may legally begin at any column provided it is consistent, and GitHub
  // accepts a workflow whose root mapping is indented; against a column test
  // every caller in such a file read as not-job-level and was dropped from the
  // lint with no output, the silent skip this file's header promises never
  // happens. `owningKey` already skips blanks, comments and block-scalar
  // content, so a flush-left comment or heredoc body cannot pose as an owner.
  return owningKey(chain, jobs.index, jobs.indent) === null;
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
 *
 * Returns `null` when the job passes no `workflows_ref`, else
 * `{ value, lineNo, duplicateLineNo }` describing the FIRST one. The scan keeps
 * going after that first hit purely to set `duplicateLineNo`: a job that passes
 * the key twice is an ambiguity neither caller of this function may resolve
 * silently, so both report it instead. See the note at the match itself.
 */
function workflowsRefInput(lines, inBlock, chain, memo, usesIndex, usesIndent) {
  // The job's `<job id>:` key is the nearest shallower line above `uses:`; the
  // body starts just after it, so a `with:` block written ABOVE `uses:` is
  // still inside the scanned range.
  const job = owningKey(chain, usesIndex, usesIndent);
  const bodyStart = job === null ? 0 : job.index + 1;

  // MEMOISED PER JOB BODY, because the answer is a property of the job, not of
  // the `uses:` line that asked. The scan below reads the whole body and no
  // longer stops at the first hit (it has to see a second `workflows_ref:` to
  // report the duplicate), so N sibling job-level `uses:` lines under ONE job
  // key would otherwise rescan that same body N times -- O(N^2) on a file a
  // fork PR controls, against a job with a 5-minute timeout. `bodyStart` and
  // `usesIndent` together identify the range scanned, so they are the key.
  const memoKey = `${bodyStart}:${usesIndent}`;
  if (memo.has(memoKey)) {
    const hit = memo.get(memoKey);
    // Copied out so a caller can never mutate another caller's answer.
    return hit === null ? null : { ...hit };
  }

  let inWith = false;
  // The first `workflows_ref:` seen, and where a second one was seen if there
  // was one. See the duplicate note at the match below.
  let found = null;
  // The indent shared by `with:`'s direct children, learned from the first one.
  let withChildIndent = null;

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
      // Quoted key tolerated for the same reason `USES_RE` tolerates one: a
      // `"with":` block is valid YAML that GitHub accepts and that genuinely
      // passes `workflows_ref`, so reading it as absent would report a caller
      // as passing no pin when it passes one.
      inWith = /^(["']?)with\1\s*:\s*(?:#.*)?$/.test(trimmed);
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
    // Group 1 is the key's optional quote and group 2 the value's, so the
    // VALUE is group 3.
    //
    // The scan does NOT stop at the first hit. Returning it immediately meant
    // this lint and `--print-pin` both read the FIRST `workflows_ref:` while
    // the value GitHub actually passes is whichever one its own YAML parser
    // keeps -- so a caller carrying two, the first agreeing with `uses:` and
    // the second stale, would SPLIT the pin while passing the very check that
    // exists to catch a split. A duplicate key is never legitimate here, so
    // rather than reason about which side wins, the second occurrence is
    // recorded and reported as its own error.
    if (rm) {
      if (found) {
        found.duplicateLineNo = i + 1;
        break;
      }
      found = { value: rm[3], lineNo: i + 1, duplicateLineNo: null };
    }
  }

  memo.set(memoKey, found);
  return found === null ? null : { ...found };
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

    // Computed ONCE and shared with the walk-backs below, so the forward and
    // backward directions can never disagree about which lines are structure.
    const inBlock = blockScalarMask(lines);
    // Likewise once: every "which key owns this line" question in this file is
    // a lookup into this chain rather than its own backward scan.
    const chain = owningKeyChain(lines, inBlock);
    // One `workflows_ref` answer per job body, not per `uses:` line that asks.
    const refMemo = new Map();

    for (let i = 0; i < lines.length; i++) {
      // Inside a block scalar: content, never structure.
      if (inBlock[i]) continue;

      const trimmed = lines[i].trimStart();

      // A whole-line comment can quote a `uses:` while documenting it; the
      // header of ci-cursor-review.yml does exactly that.
      if (trimmed.startsWith("#")) continue;

      // A job-level `uses:` written as a BLOCK SCALAR (`uses: >-` with the
      // value on the next line) is legal YAML that GitHub accepts, and it is
      // invisible to this scan TWICE over: the header line carries no value for
      // `USES_RE` to match, and `blockScalarMask` deliberately hides the
      // continuation lines that do. The repo-wide zero-caller guard in the CLI
      // below is NOT a backstop for it -- that fires only when the WHOLE
      // repository yields nothing, so one caller rewritten this way is dropped
      // in silence for as long as any other caller keeps the count non-zero,
      // free to carry a branch ref or a split pin. Detect the shape itself.
      const bs = USES_BLOCK_SCALAR_RE.exec(lines[i]);
      if (bs) {
        // The folded value is exactly the lines the mask marks as this key's
        // content. Only a call to OUR reusable is this lint's business, so an
        // unrelated `uses: >-` is read and left alone rather than reddened.
        let folded = "";
        for (let j = i + 1; j < lines.length && inBlock[j]; j++) folded += ` ${lines[j].trim()}`;
        if (OWNER_REPO_RE.test(folded) && isJobLevelUses(chain, i, bs[1].length)) {
          fail(
            `${rel}:${i + 1}: this job calls \`${REUSABLE_OWNER_REPO}\` through a ` +
              `block-scalar \`uses:\`, which puts the pin on a continuation line where ` +
              `this text-level scanner cannot read it -- and an unreadable caller is ` +
              `skipped in silence rather than checked. Write the call as a plain ` +
              `one-line scalar: \`uses: ${REUSABLE_OWNER_REPO}/.github/workflows/<name>.yml@<40-hex>\`.`,
          );
        }
        continue;
      }

      // The indicator-less sibling of the shape above. The continuation is
      // gathered here rather than read off `inBlock`, because a plain
      // multi-line scalar has no indicator for `blockScalarMask` to key on:
      // its value is every following line indented DEEPER than the key, up to
      // the first line that is not.
      const ev = USES_EMPTY_VALUE_RE.exec(lines[i]);
      if (ev) {
        const keyIndent = ev[1].length;
        let folded = "";
        for (let j = i + 1; j < lines.length; j++) {
          const cont = lines[j];
          const contTrimmed = cont.trim();
          if (contTrimmed === "") continue;
          // The comment skip is tested BEFORE the dedent break, not after.
          // A YAML comment carries no indentation semantics -- it is not
          // content and cannot close a multi-line plain scalar -- so a
          // full-line comment written at or below the key column is legal in
          // the middle of this fold and GitHub accepts it. Tested after the
          // break, such a line ended the fold instead: `folded` stayed empty,
          // `OWNER_REPO_RE` failed, and the caller was dropped in SILENCE,
          // free to carry a branch ref or a split pin with the repo-wide
          // zero-caller guard kept quiet by any other caller. Silence is the
          // one direction this lint must never fail in.
          if (contTrimmed.startsWith("#")) continue;
          if (cont.length - cont.trimStart().length <= keyIndent) break;
          folded += ` ${contTrimmed}`;
        }
        // Only a call to OUR reusable is this lint's business -- an unrelated
        // `uses:` written this way is left alone rather than reddened, exactly
        // as for the block-scalar form.
        if (OWNER_REPO_RE.test(folded) && isJobLevelUses(chain, i, keyIndent)) {
          fail(
            `${rel}:${i + 1}: this job calls \`${REUSABLE_OWNER_REPO}\` through a ` +
              `\`uses:\` whose value sits on a continuation line, where this ` +
              `text-level scanner cannot read the pin -- and an unreadable caller is ` +
              `skipped in silence rather than checked. Write the call as a plain ` +
              `one-line scalar: \`uses: ${REUSABLE_OWNER_REPO}/.github/workflows/<name>.yml@<40-hex>\`.`,
          );
        }
        continue;
      }

      const m = USES_RE.exec(lines[i]);
      if (!m) continue;

      const [, indentStr, , , ownerRepo, workflowPath, ref, comment] = m;

      // `jobs.<id>.uses` only -- see `isJobLevelUses`. A composite-action step
      // is not a reusable-workflow call and has no second pin to disagree.
      if (!isJobLevelUses(chain, i, indentStr.length)) continue;

      callers.push({
        rel,
        ownerRepo,
        reusable: workflowPath.split("/").pop(),
        usesLineNo: i + 1,
        ref,
        comment,
        workflowsRef: workflowsRefInput(lines, inBlock, chain, refMemo, i, indentStr.length),
      });
    }
  }

  return callers;
}

/** The four pin assertions, as a list of human-readable problems. */
function lint(callers) {
  const errors = [];

  for (const { rel, ownerRepo, reusable, usesLineNo, ref, comment, workflowsRef } of callers) {
    const at = `${rel}:${usesLineNo}`;

    // (4) The owner/repo must be spelled CANONICALLY. Checked FIRST, and it
    // does not `continue`: unlike (1) the spelling is independent of the ref,
    // so a caller can be both misspelled and badly pinned and deserves to hear
    // about both in one run.
    //
    // This is HYGIENE, and saying so matters because the stronger claim that
    // used to be written here -- and in `.github/dependabot.yml` -- was not
    // true. Dependabot matches `ignore.dependency-name` with
    // `Dependabot::Config::UpdateConfig.wildcard_match?`, which LOWERCASES
    // both the pattern and the candidate before comparing, so a caller spelled
    // `comfy-org/github-workflows` is already covered by the canonical-case
    // entry over there; this lint is not the other half of that defence and
    // relaxing it would not open a hole in it. What one spelling does buy is
    // that the caller, that ignore entry and the pin `--print-pin` hands
    // the freshness watchdog all name the dependency identically, so whoever
    // greps for one finds the rest.
    if (ownerRepo !== REUSABLE_OWNER_REPO) {
      errors.push(
        `${at}: \`uses:\` names \`${ownerRepo}\`, but this repository spells that ` +
          `dependency \`${REUSABLE_OWNER_REPO}\` everywhere else -- the ignore entry ` +
          `in \`.github/dependabot.yml\` and the pin this script prints for the ` +
          `freshness watchdog. GitHub and Dependabot both resolve the name ` +
          `case-insensitively, so the mismatch does not by itself break anything; ` +
          `one spelling is what keeps those three readable as the same dependency. ` +
          `Spell it \`${REUSABLE_OWNER_REPO}\`.`,
      );
    }

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
        // `ref` is already proven 40-hex LOWERCASE by (1) above, so the
        // candidate is lowercased for the prefix test -- `DEADBEE` and
        // `deadbee` name the same commit and neither may read as a mismatch.
        if (!ref.startsWith(candidate.toLowerCase())) {
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

    // (5) A DUPLICATE `workflows_ref:` under the same `with:`. Reported on its
    // own, before the value comparison, because the comparison below can only
    // read one of them: whichever this scan saw first. GitHub's parser decides
    // which one is really passed, and if it keeps the other, a caller whose
    // second entry is stale would pass (2) while shipping a split pin -- the
    // exact failure this script exists to prevent. Duplicate mapping keys are
    // never legitimate, so the fix is always to delete one, never to work out
    // which side wins.
    if (workflowsRef.duplicateLineNo) {
      errors.push(
        `${rel}:${workflowsRef.duplicateLineNo}: a second \`workflows_ref\` input ` +
          `(the first is on line ${workflowsRef.lineNo}) -- this job passes the key ` +
          `twice under one \`with:\`. Which value reaches the reusable is up to ` +
          `GitHub's YAML parser, so the pair below cannot be checked reliably and ` +
          `a stale duplicate could split the pin unnoticed. Delete the entry that ` +
          `is not \`${ref}\`.`,
      );
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

  // A DUPLICATE `workflows_ref:` is an ambiguity about which value is the pin,
  // so this mode fails for the same reason it refuses two callers above: it
  // returns one pin and cannot choose. Unlike the pair equality -- left to the
  // lint on purpose, so one split pin does not redden two jobs -- there is no
  // single answer to print here, and printing the first silently hands the
  // freshness watchdog a SHA that GitHub's parser may not be passing at all.
  if (caller.workflowsRef.duplicateLineNo) {
    fail(
      `--print-pin ${wanted}: ${caller.rel} passes \`workflows_ref\` twice under one ` +
        `\`with:\` (lines ${caller.workflowsRef.lineNo} and ` +
        `${caller.workflowsRef.duplicateLineNo}); which one GitHub passes is up to its ` +
        `YAML parser, so there is no single pin to print. Delete the stale entry.`,
    );
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

  // ZERO CALLERS IS AN ERROR, not a notice. This repo does call these
  // reusables, so an empty result means this lint checked NOTHING -- and the
  // likeliest cause is a caller spelled in a shape the scanner cannot see (a
  // folded `uses: >-`, a flow mapping) rather than a real removal. That edit
  // would take `--print-pin` down with it and silence the daily
  // `cursor-review-pin-freshness` watchdog in the same change, so the lint and
  // its watchdog would go quiet together. Fail loudly instead.
  if (callers.length === 0) {
    fail(
      `no ${REUSABLE_OWNER_REPO} caller found under .github/workflows, so this ` +
        `lint checked nothing. Either a caller is written in a shape this ` +
        `text-level scanner cannot see -- a folded \`uses: >-\`, a flow mapping -- ` +
        `or the callers really were removed, in which case delete this script ` +
        `along with its \`workflow-pins\` job and the \`cursor-review-pin-freshness\` ` +
        `watchdog that depends on \`--print-pin\`.`,
    );
  }

  const unwatched = [...new Set(callers.map((c) => c.reusable))]
    .filter((r) => !WATCHDOG_COVERED.has(r))
    .sort();
  if (unwatched.length > 0) {
    fail(
      `${unwatched.map((r) => `\`${r}\``).join(", ")} ` +
        `${unwatched.length === 1 ? "is a reusable" : "are reusables"} called from this ` +
        `repo but not watched by the \`cursor-review-pin-freshness\` job in ` +
        `.github/workflows/ci.yml, while .github/dependabot.yml ignores EVERY ` +
        `${REUSABLE_OWNER_REPO} reusable -- so nothing would ever tell you that pin had ` +
        `gone stale. Extend that watchdog to the new reusable and add it to ` +
        `\`WATCHDOG_COVERED\` in this script, or narrow the Dependabot ignore.`,
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
