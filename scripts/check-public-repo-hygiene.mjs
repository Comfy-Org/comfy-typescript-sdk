#!/usr/bin/env node
/**
 * Fail CI if the tree contains markers that only make sense in an internal
 * (private) context -- this repo is public.
 *
 * This is a lightweight regression guard, not a secrets scanner: it looks
 * for categories of internal-only references (ticket-style IDs, internal
 * collaboration-tool links, and repo names outside the known-public set),
 * not credentials. It intentionally uses small, explicit allow/deny lists
 * instead of a single clever regex, so a false positive is a one-line list
 * edit instead of a mystery.
 *
 * Mirrors scripts/check_public_repo_hygiene.py in the Python SDK -- keep the
 * two in sync.
 *
 * Run: node scripts/check-public-repo-hygiene.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Files this script itself doesn't need to scan (its own source and
// generated/vendored output that isn't hand-authored).
const EXCLUDE_PATHS = new Set(["scripts/check-public-repo-hygiene.mjs"]);
const EXCLUDE_DIR_PREFIXES = ["src/low/generated/"];

// --- Category 1: ticket-shaped identifiers (TEAM-1234) --------------------
// Generic shape rather than a guessed list of real internal team keys, so we
// don't need to encode (and thus disclose) an internal naming scheme here.
const TICKET_RE = /\b[A-Z]{2,6}-\d{2,6}\b/g;
const TICKET_ALLOWLIST = new Set([
  "UTF-8",
  "ISO-8601",
  "SHA-256",
  "SHA-384",
  "SHA-512",
  "AES-128",
  "AES-256",
  "RFC-2119",
  "RFC-7231",
  "RFC-3339",
  "OAUTH-2",
  "IPV-4",
  "IPV-6",
  "X-25519",
  "WIN-32",
  "WIN-64",
]);

// --- Category 2: internal collaboration-tool links/markers -----------------
const INTERNAL_MARKER_RES = [
  /notion\.(so|site)\//i,
  /slack\.com\/(archives|client)\//i,
  /\bapp\.slack\.com\b/i,
  /docs\.google\.com\//i,
  /drive\.google\.com\//i,
  /app\.datadoghq\.com\//i,
  /\bposthog\.com\/project\//i,
  /\blinear\.app\//i,
  /\bincident-\d+\b/i,
];

// --- Category 3: references to Comfy-Org repos outside the known-public set
// Default-deny: only these are known to be public. Anything else under
// `Comfy-Org/<repo>` gets flagged so a maintainer can either scrub it or add
// it here once confirmed public. (No private repo names are listed here on
// purpose -- the point of default-deny is that we never need to.)
const PUBLIC_COMFY_ORG_REPOS = new Set([
  "comfy-api-proxy",
  "comfy-cla",
  "comfy-cli",
  "comfy-cloud-mcp-server",
  "Comfy-Desktop",
  "comfy-python-sdk",
  // Reusable GitHub Actions workflows (cursor-review and friends). Verified
  // public: unauthenticated GET https://github.com/Comfy-Org/github-workflows
  // returns 200. That check is the ONLY basis for an entry here -- a resolving
  // `uses:` reference is not evidence, because a private repo can share its
  // reusable workflows org-internally (Settings > Actions > access), so a
  // passing run says nothing about visibility.
  "github-workflows",
  "comfy-swift-sdk",
  "comfy-typescript-sdk",
  "ComfyUI_frontend",
  "ComfyUI",
]);
// CODEOWNERS team handles (`@Comfy-Org/<team>`) are inherently public on a
// public repo -- GitHub renders the CODEOWNERS owners to anyone who can see the
// repo, so listing them here is not a leak. These mirror the sibling repos'
// CODEOWNERS (e.g. comfy-api-proxy). An `@Comfy-Org/<team>` handle NOT in this
// set is still flagged, so a genuinely-internal team reference surfaces.
const PUBLIC_COMFY_ORG_TEAMS = new Set(["comfy-cloud-team", "core-engine-team"]);
const REPO_REF_RE = /Comfy-Org\/([A-Za-z0-9_.-]+)/g;

function trackedFiles() {
  const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf-8" });
  return out.split("\n").filter(Boolean);
}

function isExcluded(rel) {
  if (EXCLUDE_PATHS.has(rel)) return true;
  return EXCLUDE_DIR_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

// Crude binary check: treat any file containing a NUL control character as
// out of scope rather than trying to grep it as text.
const CONTROL_NUL_RE = new RegExp(String.fromCharCode(0));

function checkFile(rel) {
  const findings = [];
  let text;
  try {
    text = readFileSync(join(ROOT, rel), "utf-8");
  } catch {
    return findings; // unreadable; not in scope
  }
  if (CONTROL_NUL_RE.test(text)) return findings; // binary file

  const lines = text.split("\n");
  lines.forEach((line, idx) => {
    const lineno = idx + 1;

    for (const match of line.matchAll(TICKET_RE)) {
      if (!TICKET_ALLOWLIST.has(match[0].toUpperCase())) {
        findings.push(`${rel}:${lineno}: possible internal ticket ID: ${JSON.stringify(match[0])}`);
      }
    }

    for (const pattern of INTERNAL_MARKER_RES) {
      if (pattern.test(line)) {
        findings.push(
          `${rel}:${lineno}: internal collaboration-tool marker: ${JSON.stringify(line.trim())}`,
        );
      }
    }

    for (const match of line.matchAll(REPO_REF_RE)) {
      const name = match[1];
      // A leading `@` makes this a CODEOWNERS team handle, not a repo ref.
      if (match.index > 0 && line[match.index - 1] === "@") {
        if (!PUBLIC_COMFY_ORG_TEAMS.has(name)) {
          findings.push(
            `${rel}:${lineno}: reference to @Comfy-Org/${name}, a team not in the known-public ` +
              "allowlist (scripts/check-public-repo-hygiene.mjs) -- confirm it's public and add it, " +
              "or remove the reference",
          );
        }
        continue;
      }
      // Strip a trailing `.git` — repository URLs (package.json `repository.url`,
      // git remotes) conventionally end in `.git`, and `Foo.git` is still a
      // reference to the public repo `Foo`.
      const repo = name.replace(/\.git$/, "");
      if (!PUBLIC_COMFY_ORG_REPOS.has(repo)) {
        findings.push(
          `${rel}:${lineno}: reference to Comfy-Org/${repo}, which is not in the known-public ` +
            "allowlist (scripts/check-public-repo-hygiene.mjs) -- confirm it's public and add it, " +
            "or remove the reference",
        );
      }
    }
  });

  return findings;
}

function main() {
  const allFindings = [];
  for (const rel of trackedFiles()) {
    if (isExcluded(rel)) continue;
    allFindings.push(...checkFile(rel));
  }

  if (allFindings.length > 0) {
    console.error("ERROR: possible internal-only references found in this public repo:\n");
    for (const finding of allFindings) {
      console.error(`  ${finding}`);
    }
    console.error(
      "\nIf this is a genuine false positive, extend the allowlist in " +
        "scripts/check-public-repo-hygiene.mjs with a comment explaining why.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("OK: no internal-only references found");
}

main();
