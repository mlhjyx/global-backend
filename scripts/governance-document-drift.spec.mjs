import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

test("current Platform Writer documentation records terminal reconciliation and points to its successor receipt", () => {
  const status = read("docs/status/current.md");
  const architecture = read("docs/architecture/current.md");
  const evidenceIndex = read("docs/evidence/README.md");
  const changelog = read("docs/roadmap/changelog.md");

  for (const document of [status, architecture, evidenceIndex, changelog]) {
    assert.match(document, /attempts 1–5[\s\S]{0,120}6[\s\S]{0,120}EXPIRED/u);
    assert.match(document, /UNKNOWN/u);
    assert.match(
      document,
      /no (?:second )?(?:physical )?(?:call|redispatch)|不重发|没有[\s\S]{0,80}(?:redispatch|第二次物理调用)/u,
    );
  }
  assert.match(status, /reservation\/conservative charge 均为 `800000`/u);
  assert.match(
    status,
    /完整脱敏字段见 \[2026-09-04 platform-writer successor runtime readback\]\(\.\.\/evidence\/site-builder\/production-parity-platform-writer-runtime-readback-20260904\.json\)/u,
  );
  assert.match(
    status,
    /20260901[^\n]*historical provenance/u,
  );
});

test("the Platform Writer successor evidence records terminal reconciliation without rewriting UNKNOWN execution truth", () => {
  const receipt = JSON.parse(
    read(
      "docs/evidence/site-builder/production-parity-platform-writer-runtime-readback-20260904.json",
    ),
  );
  const deterministicEvidence = JSON.parse(
    read(
      "docs/evidence/runtime/site-builder-deterministic-product-path-platform-writer-development-20260904.json",
    ),
  );
  const terminalEvidence = JSON.parse(
    read(
      "docs/evidence/runtime/site-builder-reconciliation-terminal-platform-writer-development-20260904.json",
    ),
  );
  const release = JSON.parse(
    read(
      "docs/releases/site-builder-production-parity-platform-writer-development-20260904.release.json",
    ),
  );

  assert.equal(receipt.persisted_unknown_containment.spend_status, "UNKNOWN");
  assert.equal(receipt.persisted_unknown_containment.cost_basis, "unknown");
  assert.equal(receipt.persisted_unknown_containment.reservation_microusd, "800000");
  assert.equal(
    receipt.persisted_unknown_containment.conservative_charge_microusd,
    "800000",
  );
  assert.equal(receipt.persisted_unknown_containment.physical_model_calls, 1);
  assert.equal(receipt.persisted_unknown_containment.build_run_id, "81dcfe5a-b510-42fa-bbf8-317835bb2b52");
  assert.match(receipt.persisted_unknown_containment.request_identity_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    receipt.persisted_unknown_containment.automatic_second_physical_call,
    false,
  );
  assert.equal(receipt.persisted_unknown_containment.reconciliation_attempts, 6);
  assert.equal(
    receipt.persisted_unknown_containment.latest_reconciliation_status,
    "EXPIRED",
  );
  assert.deepEqual(
    receipt.persisted_unknown_containment.attempts.map((attempt) => attempt.status),
    ["UNRESOLVED", "UNRESOLVED", "UNRESOLVED", "UNRESOLVED", "UNRESOLVED", "EXPIRED"],
  );
  assert.deepEqual(receipt.persisted_unknown_containment.attempts.slice(0, 5).map((attempt) => attempt.resolver_id), Array(5).fill("new-api-request-bound-reconciliation-v1"));
  assert.equal(receipt.persisted_unknown_containment.attempts[5].resolver_id, "reconciliation-sweep-v1");
  assert.equal(release.merge_evidence.method, "squash");
  assert.equal(deterministicEvidence.result, "PASS");
  assert.equal(deterministicEvidence.evidence_kind, "deterministic_product_path");
  assert.equal(terminalEvidence.result, "PASS");
  assert.equal(
    terminalEvidence.evidence_kind,
    "reconciliation_terminalization_readback",
  );
  assert.equal(release.release_status, "CANDIDATE");
  assert.equal(release.external_provenance.status, "EXTERNAL_UNVERIFIED");
  assert.equal(release.approval.machine.status, "NOT_VERIFIED");
  assert.equal(release.approval.reviewer.status, "NOT_REVIEWED");
  assert.equal(release.approval.user_authorization.status, "NOT_AUTHORIZED");

});

test("the Authority closeout coverage preserves the complete budget and readiness denominator", () => {
  const record = read(
    "docs/implementation-records/execution-budget-authority-contract.md",
  );
  const requiredCoverageTokens = [
    "--coverage.include='src/execution-budget/**/*.ts'",
    "--coverage.include=src/runtime/managed-dependency-readiness.ts",
    "--coverage.include=src/health/runtime-readiness.service.ts",
    "--coverage.include=src/health/health.controller.ts",
    "--coverage.include=src/health/health-openapi.schemas.ts",
    "--coverage.include=src/runtime/site-build-runtime.guard.ts",
    "--coverage.include=src/tools/budget-store.ts",
    "src/tools/budget-store.spec.ts",
  ];

  for (const token of requiredCoverageTokens) {
    assert.ok(record.includes(token), `Authority coverage omits ${token}`);
  }
  assert.match(record, /statements 88\.76% \(632\/712\)/i);
  assert.match(record, /branches 88\.21% \(479\/543\)/i);
});

test("the Authority durable record uses the code-first health path and executable local verification commands", () => {
  const record = read(
    "docs/implementation-records/execution-budget-authority-contract.md",
  );
  const requiredTokens = [
    "GET /api/v1/health/ready",
    "pnpm --filter @global/db exec prisma validate",
    "pnpm --filter @global/db generate",
    "pnpm docs:verify",
    "pnpm code-intelligence:scan",
    "pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..",
    "pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact",
  ];

  for (const token of requiredTokens) {
    assert.ok(record.includes(token), `Authority record omits ${token}`);
  }
  assert.doesNotMatch(record, /GET \/health\/ready\b/u);
});

test("the Copy fixed-source governance document reflects the active reviewed successor", () => {
  const governance = read(
    "docs/implementation-records/copy-fixed-source-impact-governance.md",
  );
  const eligibilityBytes = read(
    "docs/evidence/site-builder/copy-runtime-eligibility.json",
  );
  const eligibility = JSON.parse(eligibilityBytes);
  const eligibilitySha256 = createHash("sha256")
    .update(eligibilityBytes)
    .digest("hex");

  assert.match(governance, /active v22/i);
  assert.doesNotMatch(governance, /\bv15\b/i);
  assert.match(governance, /reviewed exact path-set successor/i);
  assert.match(
    governance,
    new RegExp(eligibility.stale_scope.replaceAll("_", "[_]"), "u"),
  );
  assert.match(governance, /STALE_HOLD/);
  assert.match(governance, /NOT_AUTHORIZED/);
  assert.match(governance, /BLOCKED/);
  assert.match(governance, /REBASE_FIXED_SOURCE_BEFORE_DISPATCH/);
  assert.ok(
    governance.includes(eligibility.current_source_fingerprint),
    "Copy governance must quote the current machine source fingerprint",
  );
  assert.ok(
    governance.includes(eligibilitySha256),
    "Copy governance must quote the exact current eligibility receipt SHA-256",
  );
  assert.match(governance, /successor[^\n]*(?:不是|不等于)[^\n]*CURRENT/i);
  assert.match(governance, /successor[^\n]*(?:不代表|不构成)[^\n]*rebaseline/i);
  assert.match(governance, /successor[^\n]*(?:不授权|不能授权)[^\n]*dispatch/i);
  assert.doesNotMatch(
    governance,
    /STALE_HOLD` 当前只允许 `packages\/db\/prisma\/schema\.prisma`/,
  );

  for (const path of eligibility.drifted_paths) {
    assert.ok(governance.includes(path), `Copy governance omits ${path}`);
  }
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

test("README reports completed M1 and the current ten-service Compose topology", () => {
  const readme = read("README.md");
  const serviceNames = composeServiceNames(read("docker-compose.yml"));

  assert.match(readme, /获客侧[^\n]*冻结已解除/);
  assert.match(readme, /Site Builder M1[^\n]*已完成/);
  assert.equal(serviceNames.length, 10);
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
