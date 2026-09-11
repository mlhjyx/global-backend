#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const repoRoot = process.env.PR407_REPO_ROOT ?? process.cwd();
const baseCommit = "a5948b85d355eccb53732aa50e5f40c85167437b";
const prCommit = "70885cdb4196ae86db762ae96ca73f4cfa51f89d";
const liveMainCommit = process.env.PR407_LIVE_MAIN ?? "7f25536bbdadf2a09d51434978ba08b354575284";

function git(args) {
  return execFileSync("/usr/bin/git", ["-C", repoRoot, ...args], {
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
    encoding: "buffer",
  });
}
function validPath(value) {
  return value && !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && !value.split("/").some(part => !part || part === "." || part === "..");
}
function tree(commit) {
  const rows = git(["ls-tree", "-rz", "--full-tree", commit]).toString("utf8").split("\0").filter(Boolean);
  return new Map(rows.map(row => {
    const match = /^(100644|100755|120000) (?:blob) ([0-9a-f]{40})\t([\s\S]+)$/u.exec(row);
    if (!match || !validPath(match[3])) throw new Error("TREE_ENTRY_INVALID");
    return [match[3], { blobId: match[2], mode: match[1] }];
  }));
}
function classify(path) {
  if (/^packages\/db\/prisma\/migrations\//u.test(path)) return ["MIGRATION", "PRISMA_SCHEMA"];
  if (/^packages\/db\/(?:prisma\/schema|src\/.*identity|.*identity)/u.test(path)) return ["PRISMA_SCHEMA", "IDENTITY_AUTHORITY"];
  if (/organization[-_]identity|identity[-_]link|canonical-company|materialization/u.test(path)) return ["IDENTITY_CALLER", "IDENTITY_AUTHORITY"];
  if (/provider|toolbroker|procurement|searx|serper|brave/u.test(path)) return ["RAW_CAPABILITY", "OTHER"];
  if (/^docs\//u.test(path) || /governance|workflow|CODEOWNERS|\.github\//u.test(path)) return ["GOVERNANCE", "OTHER"];
  if (/test|spec|fixture|evidence/u.test(path)) return ["GENERATED_EVIDENCE", "OTHER"];
  if (/package\.json|lock|tsconfig|Dockerfile|compose|\.ya?ml$/u.test(path)) return ["BUILD", "OTHER"];
  return ["OTHER", "OTHER"];
}
function changeKind(base, head, path) {
  if (!base.has(path)) return "ADD";
  if (!head.has(path)) return "DELETE";
  return "MODIFY";
}
function blob(map, path) { return map.get(path)?.blobId ?? null; }
function changedPaths(from, to) {
  return new Set(git(["diff", "--name-only", "--no-ext-diff", "--no-textconv", from, to, "--"]).toString("utf8").split("\n").filter(Boolean));
}
const base = tree(baseCommit);
const head = tree(prCommit);
const main = tree(liveMainCommit);
const prChangedPaths = changedPaths(baseCommit, prCommit);
const mainChangedPaths = changedPaths(baseCommit, liveMainCommit);
const raw = git(["diff", "--name-status", "--no-ext-diff", "--no-textconv", "-z", baseCommit, prCommit, "--"]);
const fields = raw.toString("utf8").split("\0").filter(Boolean);
const paths = [];
for (let index = 0; index < fields.length; index += 2) {
  const status = fields[index];
  const path = fields[index + 1];
  if (!/^[AMD]$/u.test(status) || !validPath(path)) throw new Error("PR407_DIFF_UNSUPPORTED");
  paths.push(path);
}
paths.sort();
if (paths.length !== 276 || new Set(paths).size !== 276) throw new Error(`PR407_PATH_COUNT_INVALID:${paths.length}`);
const records = paths.map(path => {
  const [primary, secondary] = classify(path);
  return {
    originalPath: path,
    responsibility: `${primary}/${secondary}`,
    baseBlobId: blob(base, path),
    prBlobId: blob(head, path),
    currentMainPath: main.has(path) ? path : null,
    currentMainBlobId: blob(main, path),
    changeKind: changeKind(base, head, path),
    classifications: [primary, secondary].filter((value, index, values) => values.indexOf(value) === index).sort(),
    originalAuthor: "tugjvnh",
    sourceCommit: prCommit,
    decision: "blocked",
    decisionReason: "MECHANICAL_PROVENANCE_ONLY_SEMANTIC_REVIEW_REQUIRED",
    successorBranch: null,
    successorPr: null,
    verificationEvidence: [],
  };
});
const result = {
  schemaVersion: "pr407-successor-mapping/v1",
  status: "MECHANICAL_PROVENANCE_ONLY",
  source: { author: "tugjvnh", baseCommit, prCommit, liveMainCommit, bundle: "pr407-70885cdb.bundle" },
  counts: {
    total: records.length, blocked: records.length, adopt: 0, rewrite: 0, drop: 0, superseded: 0,
    overlapWithCurrentMain: [...prChangedPaths].filter(path => mainChangedPaths.has(path)).length,
    prOnlyAgainstCurrentMain: [...prChangedPaths].filter(path => !mainChangedPaths.has(path)).length,
    currentMainOnlyAgainstBase: [...mainChangedPaths].filter(path => !prChangedPaths.has(path)).length,
  },
  semanticReview: "REQUIRED",
  paths: records,
};
const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`, "utf8");
result.manifestSha256 = createHash("sha256").update(bytes).digest("hex");
mkdirSync(`${repoRoot}/docs/governance`, { recursive: true });
writeFileSync(`${repoRoot}/docs/governance/pr407-successor-mapping.json`, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 });
process.stdout.write(JSON.stringify({ status: "PASS", pathCount: records.length, blocked: records.length, manifestSha256: result.manifestSha256 }) + "\n");
