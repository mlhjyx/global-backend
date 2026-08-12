import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function composeServiceNames(compose) {
  const lines = compose.split("\n");
  const start = lines.findIndex((line) => line === "services:");
  assert.notEqual(
    start,
    -1,
    "docker-compose.yml must contain a services block",
  );
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line) && !line.startsWith("#")) break;
    const match = line.match(/^  ([a-z0-9][a-z0-9-]*):\s*$/u);
    if (match) names.push(match[1]);
  }
  return names;
}

test("governance changes preserve the active Copy fixed-source boundary", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/copy-fixed-source-impact.mjs"],
    {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    },
  );

  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
});

test("AGENTS.md remains a stable entrypoint without versioned current-state mirrors", () => {
  const agents = read("AGENTS.md");
  const lines = agents.trimEnd().split("\n");

  assert.ok(
    lines.length <= 100,
    `AGENTS.md has drifted to ${lines.length} lines`,
  );
  assert.doesNotMatch(agents, /origin\/main@[0-9a-f]{40}/i);
});

test("CLAUDE.md remains a small compatibility pointer instead of a truth mirror", () => {
  const claude = read("CLAUDE.md");
  const lines = claude.trimEnd().split("\n");

  assert.ok(
    lines.length <= 20,
    `CLAUDE.md has drifted to ${lines.length} lines`,
  );
  assert.match(claude, /\[AGENTS\.md\]\(AGENTS\.md\)/);
  assert.match(claude, /docs\/status\/current\.md/);
  assert.doesNotMatch(
    claude,
    /已暂停新增开发|获客线当前冻结|获客侧冻结 backlog/,
  );
});

test("README reports completed M1 and the current nine-service Compose topology", () => {
  const readme = read("README.md");
  const serviceNames = composeServiceNames(read("docker-compose.yml"));

  assert.match(readme, /获客侧[^\n]*冻结已解除/);
  assert.match(readme, /Site Builder M1[^\n]*已完成/);
  assert.equal(serviceNames.length, 9);
  assert.match(readme, new RegExp(`${serviceNames.length} 服务`));
  assert.ok(serviceNames.includes("openox-video-compat"));
  assert.match(readme, /openox-video-compat/);
  assert.doesNotMatch(
    readme,
    /当前仍在施工的主线|M1 收口前只做|下一施工顺序为|R3-B → R4-A1|8 服务|8 个 global-/,
  );
});

test("current architecture describes the completed gate and exact Copy source route", () => {
  const architecture = read("docs/architecture/current.md");
  const registry = read(
    "apps/api/src/site-builder/agents/model-policy.registry.ts",
  );

  assert.match(architecture, /M1 已完成阶段收口/);
  assert.match(
    registry,
    /taskId: 'site_builder\.copy',[\s\S]*?route: Object\.freeze\(\{[\s\S]*?primary: 'claude-sonnet-5',[\s\S]*?fallbacks: Object\.freeze\(\[\]\),[\s\S]*?transport: 'anthropic-messages'[\s\S]*?reasoningEffort: 'medium'/,
  );
  assert.match(
    registry,
    /'site_builder\.copy': \{\s*kind: 'model_route',\s*route: \{ primary: 'deepseek-v4-pro', fallbacks: \['glm-5\.2'\] \}/,
  );
  assert.match(
    architecture,
    /claude-sonnet-5[^\n]*Anthropic Messages \(anthropic-messages\)[^\n]*medium[^\n]*no fallback/,
  );
  assert.match(
    architecture,
    /SITE_BUILDER_MODEL_ROLLBACK_COPY=true[^\n]*deepseek-v4-pro[^\n]*glm-5\.2[^\n]*low/,
  );
  assert.doesNotMatch(
    architecture,
    /M1 收口前只做审计\/规划准备，M1 收口后才恢复实现/,
  );
});

test("product scope does not retain the pre-M1 acquisition construction gate", () => {
  const productScope = read("docs/product-scope.md");

  assert.match(productScope, /获客侧冻结已解除/);
  assert.match(productScope, /Site Builder M1[^\n]*已完成阶段收口/);
  assert.doesNotMatch(productScope, /M1 收口前可规划但不启动实现/);
});

test("current and corrective acquisition surfaces do not retain the closed M1 gate", () => {
  const currentSurfaces = [
    "docs/governance/conflict-register.md",
    "docs/governance/core-object-register.md",
    "docs/status/pilot-readiness-gap-report.md",
    "packages/contracts/INTEGRATION.md",
    "docs/site-builder/01-prd.md",
    "docs/site-builder/09-m1-implementation-design.md",
  ];
  const correctiveHistoricalHeaders = [
    "docs/implementation-records/ted-provider-spec.md",
    "docs/research/positioning-and-acquisition-backlog.md",
    "docs/roadmap/sam-sources-sought-p4-design.md",
  ];

  for (const path of [...currentSurfaces, ...correctiveHistoricalHeaders]) {
    assert.doesNotMatch(
      read(path),
      /M1(?: 收口)?前[^\n]*(不恢复实现|不启动[^\n]*实现|只做准备|只做接入审计|仅供接入审计)/,
      `${path} retains the closed pre-M1 construction gate`,
    );
  }
});
