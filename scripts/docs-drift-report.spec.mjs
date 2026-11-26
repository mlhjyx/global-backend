import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./docs-drift-report.mjs", import.meta.url));

function write(root, path, content) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gain-docs-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, "backend/package.json", '{"scripts":{"docs:verify":"node scripts/check.mjs"}}');
  write(root, "backend/scripts/check.mjs", "");
  write(root, "gain-saas/package.json", '{"scripts":{"lint:date":"node scripts/test.mjs"}}');
  return root;
}

function report(workspace, ...args) {
  return spawnSync(process.execPath, [script, "--workspace", workspace, ...args], {
    encoding: "utf8",
  });
}

function commit(repo, message) {
  const git = (...args) => execFileSync("git", [
    "-C", repo, "-c", "core.hooksPath=/dev/null",
    "-c", "user.name=Documentation Fixture",
    "-c", "user.email=fixture@example.invalid",
    ...args,
  ], { encoding: "utf8" }).trim();
  git("add", ".");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

test("reports broken destinations, anchors, and retired commands without changing documents", (t) => {
  const root = fixture(t);
  const agentDoc = [
    "# Shared notes",
    "[gone](backend/docs/deleted.md)",
    "[wrong heading](backend/README.md#old-section)",
    "\x60node scripts/retired.mjs\x60",
    "\x60pnpm docs:retired\x60",
    "",
  ].join("\n");
  write(root, "AGENTS.md", agentDoc);
  write(root, "backend/README.md", "# Backend\n\n## Current section\n");

  const result = report(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WARN BROKEN_LINK AGENTS\.md:2/);
  assert.match(result.stdout, /WARN BROKEN_ANCHOR AGENTS\.md:3/);
  assert.match(result.stdout, /WARN MISSING_SCRIPT AGENTS\.md:4.*scripts\/retired\.mjs/);
  assert.match(result.stdout, /WARN MISSING_PNPM_SCRIPT AGENTS\.md:5.*docs:retired/);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), agentDoc);
});

test("uses selected worktrees for valid workspace and repository links", (t) => {
  const root = fixture(t);
  const worktree = join(root, "selected-saas");
  write(worktree, "package.json", '{"scripts":{"lint:date":"node scripts/date.mjs"}}');
  write(worktree, "docs/README.md", "# 导航\n\n## 实现状态\n");
  write(worktree, "README.md", [
    "# SaaS",
    "[状态][guide]",
    "[guide]: docs/README.md#实现状态",
    "\x60pnpm lint:date\x60",
    "",
  ].join("\n"));
  write(root, "CLAUDE.md", [
    "# Shared",
    "[导航](gain-saas/docs/README.md#实现状态)",
    "[指定仓](https://github.com/mlhjyx/gain-saas/blob/main/docs/README.md#实现状态)",
    "\x60node scripts/check.mjs\x60",
    "\x60pnpm --filter @vben/web-antd build\x60",
    "",
  ].join("\n"));

  const result = report(root, "--saas", worktree);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /WARN (?:BROKEN_(?:LINK|ANCHOR)|MISSING_(?:PNPM_)?SCRIPT)\b/);
});

test("reports a deleted reference definition and accepts normalized reference labels", (t) => {
  const root = fixture(t);
  write(root, "backend/README.md", [
    "# Docs",
    "[operator guide][retired]",
    "[Active guide][]",
    "[another][ACTIVE   GUIDE]",
    "[active guide]: #docs",
    "",
  ].join("\n"));
  const result = report(root);
  assert.equal(result.status, 0, result.stderr);
  const findings = result.stdout.split("\n").filter((line) => line.includes("MISSING_LINK_REFERENCE"));
  assert.equal(findings.length, 1);
  assert.match(findings[0], /backend\/README\.md:2\b/);
});

test("checks a node script after an explicit relative directory change", (t) => {
  const root = fixture(t);
  write(root, "backend/apps/api/scripts/seed.mjs", "");
  write(root, "backend/README.md", [
    "# Backend",
    "",
    "\x60\x60\x60bash",
    "pnpm --filter @global/api build && (cd apps/api && node scripts/seed.mjs)",
    "(cd apps/api && node scripts/old-seed.mjs)",
    "\x60\x60\x60",
    "",
  ].join("\n"));
  const result = report(root);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /WARN MISSING_SCRIPT .*\/seed\.mjs/);
  assert.match(result.stdout, /WARN MISSING_SCRIPT backend\/README\.md:5.*apps\/api\/scripts\/old-seed\.mjs/);
});

test("reports an escaping link without reading its target", (t) => {
  const root = fixture(t);
  write(root, "outside.md", "# Outside\n");
  symlinkSync(join(root, "outside.md"), join(root, "backend/unsafe.md"));
  write(root, "backend/AGENTS.md", "# Backend\n[unsafe](unsafe.md#outside)\n");

  const result = report(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WARN LINK_OUTSIDE_ROOT backend\/AGENTS\.md:2/);
});

test("suggests corresponding docs only when a topic's source changed without them", (t) => {
  const root = fixture(t);
  const repo = join(root, "gain-saas");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const base = commit(repo, "base");
  write(repo, "apps/server/src/wallet/wallet.service.ts", "export {};\n");
  const source = commit(repo, "source");
  write(repo, "docs/technical/credits-wallet.md", "# Credits\n");
  const documented = commit(repo, "documentation");
  const options = ["--repo", "gain-saas", "--base", base, "--head"];

  const missing = report(root, ...options, source);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /WARN DOC_REVIEW gain-saas .*钱包.*docs\/technical\/credits-wallet\.md/);

  const covered = report(root, ...options, documented);
  assert.equal(covered.status, 0, covered.stderr);
  assert.doesNotMatch(covered.stdout, /WARN DOC_REVIEW/);
});

test("flags event consumer changes for inbox and wallet documentation", (t) => {
  const root = fixture(t);
  const repo = join(root, "gain-saas");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const base = commit(repo, "base");
  write(repo, "apps/server/src/service/event-consumer.service.ts", "export {};\n");
  const head = commit(repo, "consumer");

  const result = report(root, "--repo", "gain-saas", "--base", base, "--head", head);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WARN DOC_REVIEW gain-saas .*钱包.*credits-wallet\.md/);
  assert.match(result.stdout, /WARN DOC_REVIEW gain-saas .*事件.*campaign-control-plane/);
});

test("fails explicitly for incomplete diff arguments or a ref that cannot be read", (t) => {
  const root = fixture(t);
  const repo = join(root, "backend");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const head = commit(repo, "base");

  const incomplete = report(root, "--repo", "backend", "--base", head);
  assert.equal(incomplete.status, 2);
  assert.match(incomplete.stderr, /ERROR.*--head/);

  const invalid = report(root, "--repo", "backend", "--base", "no-such-ref", "--head", head);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /ERROR.*no-such-ref/);
});
