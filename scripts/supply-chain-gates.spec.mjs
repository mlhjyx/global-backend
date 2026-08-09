import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);
const BASE_COMMIT = "362f88cac1656016bd5aba93032e0f1d90048cba";
const LOCKFILE_DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = new Date("2026-08-09T12:00:00.000Z");

async function readRepositoryFile(path) {
  return readFile(new URL(path, repositoryRoot), "utf8");
}

function issueCodes(result) {
  return result.issues.map((issue) => issue.code);
}

function advisory(overrides = {}) {
  return {
    ghsa_id: "GHSA-aaaa-bbbb-cccc",
    package: "example-runtime",
    severity: "moderate",
    vulnerable_versions: "<2.0.0",
    patched_versions: ">=2.0.0",
    url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
    remediation: {
      stream: "runtime-maintenance",
      owner: "OWN-SECURITY",
      due_at: "2026-09-08T00:00:00.000Z",
      reason: "Existing transitive production dependency pending coordinated upgrade.",
    },
    ...overrides,
  };
}

function baseline(advisories = [advisory()], overrides = {}) {
  const vulnerabilityCounts = {
    info: advisories.filter((item) => item.severity === "info").length,
    low: advisories.filter((item) => item.severity === "low").length,
    moderate: advisories.filter((item) => item.severity === "moderate").length,
    high: advisories.filter((item) => item.severity === "high").length,
    critical: advisories.filter((item) => item.severity === "critical").length,
  };
  return {
    schema_version: "production-dependency-audit-baseline/v1",
    source: {
      base_commit: BASE_COMMIT,
      lockfile_digest: LOCKFILE_DIGEST,
      registry: "https://registry.npmjs.org/",
      package_manager: "pnpm@9.15.9",
      command:
        "pnpm audit --prod --registry=https://registry.npmjs.org --json",
      captured_at: "2026-08-09T12:00:00.000Z",
    },
    bootstrap: {
      mode: "INITIAL_BASELINE",
      base_commit: BASE_COMMIT,
    },
    governance: {
      owner: "OWN-SECURITY",
      valid_until: "2026-09-08T00:00:00.000Z",
      policy:
        "Existing advisories may disappear; new advisories, severity increases, critical findings, and expired baselines fail closed.",
    },
    summary: {
      advisories: advisories.length,
      vulnerabilities: vulnerabilityCounts,
    },
    advisories,
    ...overrides,
  };
}

function pnpmAudit(advisories = [advisory()]) {
  const vulnerabilities = Object.fromEntries(
    ["info", "low", "moderate", "high", "critical"].map((severity) => [
      severity,
      advisories.filter((item) => item.severity === severity).length,
    ]),
  );
  return {
    advisories: Object.fromEntries(
      advisories.map((item, index) => [
        String(index + 1),
        {
          id: index + 1,
          github_advisory_id: item.ghsa_id,
          module_name: item.package,
          severity: item.severity,
          vulnerable_versions: item.vulnerable_versions,
          patched_versions: item.patched_versions,
          url: item.url,
          findings: [{ version: "1.0.0", paths: [`api > ${item.package}@1.0.0`] }],
        },
      ]),
    ),
    metadata: {
      vulnerabilities,
      dependencies: 1,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 1,
    },
  };
}

test("production audit ratchet accepts the legacy set and improvements", async () => {
  const { evaluateProductionAudit } = await import("./supply-chain-audit.mjs");
  const existing = advisory();
  const second = advisory({
    ghsa_id: "GHSA-dddd-eeee-ffff",
    package: "second-runtime",
    severity: "high",
    url: "https://github.com/advisories/GHSA-dddd-eeee-ffff",
  });
  const legacyBaseline = baseline([existing, second]);

  assert.deepEqual(
    evaluateProductionAudit(pnpmAudit([existing, second]), legacyBaseline, {
      now: NOW,
      expectedBootstrapBase: BASE_COMMIT,
    }).issues,
    [],
  );
  const improved = evaluateProductionAudit(
    pnpmAudit([existing]),
    legacyBaseline,
    { now: NOW, expectedBootstrapBase: BASE_COMMIT },
  );
  assert.deepEqual(improved.issues, []);
  assert.deepEqual(improved.resolved_advisories, [
    "GHSA-dddd-eeee-ffff|second-runtime",
  ]);
});

test("production audit ratchet rejects new, escalated, and critical findings", async () => {
  const { evaluateProductionAudit } = await import("./supply-chain-audit.mjs");
  const existing = advisory();

  const withNewAdvisory = evaluateProductionAudit(
    pnpmAudit([
      existing,
      advisory({
        ghsa_id: "GHSA-neww-vuln-0001",
        package: "new-runtime",
        url: "https://github.com/advisories/GHSA-neww-vuln-0001",
      }),
    ]),
    baseline([existing]),
    { now: NOW, expectedBootstrapBase: BASE_COMMIT },
  );
  assert.ok(issueCodes(withNewAdvisory).includes("AUDIT_NEW_ADVISORY"));

  const escalated = evaluateProductionAudit(
    pnpmAudit([advisory({ severity: "high" })]),
    baseline([existing]),
    { now: NOW, expectedBootstrapBase: BASE_COMMIT },
  );
  assert.ok(issueCodes(escalated).includes("AUDIT_SEVERITY_ESCALATED"));

  const critical = evaluateProductionAudit(
    pnpmAudit([
      advisory({
        ghsa_id: "GHSA-crit-ical-0001",
        severity: "critical",
        url: "https://github.com/advisories/GHSA-crit-ical-0001",
      }),
    ]),
    baseline([existing]),
    { now: NOW, expectedBootstrapBase: BASE_COMMIT },
  );
  assert.ok(issueCodes(critical).includes("AUDIT_CRITICAL_ADVISORY"));
});

test("baseline validation fails closed on expiry, bootstrap drift, duplicates, and summary drift", async () => {
  const { validateProductionAuditBaseline } = await import(
    "./supply-chain-audit.mjs"
  );
  const existing = advisory();

  assert.ok(
    issueCodes(
      validateProductionAuditBaseline(
        baseline([existing], {
          governance: {
            ...baseline().governance,
            valid_until: "2026-08-09T11:59:59.000Z",
          },
        }),
        { now: NOW, expectedBootstrapBase: BASE_COMMIT },
      ),
    ).includes("BASELINE_EXPIRED"),
  );
  assert.ok(
    issueCodes(
      validateProductionAuditBaseline(baseline([existing]), {
        now: NOW,
        expectedBootstrapBase: "f".repeat(40),
      }),
    ).includes("BASELINE_BOOTSTRAP_BASE_MISMATCH"),
  );
  assert.ok(
    issueCodes(
      validateProductionAuditBaseline(baseline([existing, existing]), {
        now: NOW,
        expectedBootstrapBase: BASE_COMMIT,
      }),
    ).includes("BASELINE_ADVISORY_DUPLICATE"),
  );
  assert.ok(
    issueCodes(
      validateProductionAuditBaseline(
        baseline([existing], {
          summary: {
            advisories: 99,
            vulnerabilities: baseline().summary.vulnerabilities,
          },
        }),
        { now: NOW, expectedBootstrapBase: BASE_COMMIT },
      ),
    ).includes("BASELINE_SUMMARY_MISMATCH"),
  );
});

test("production audit input must be a complete production-only pnpm report", async () => {
  const { evaluateProductionAudit } = await import("./supply-chain-audit.mjs");
  const malformed = pnpmAudit();
  malformed.metadata.devDependencies = 3;
  malformed.metadata.vulnerabilities.moderate = 0;
  const result = evaluateProductionAudit(malformed, baseline(), {
    now: NOW,
    expectedBootstrapBase: BASE_COMMIT,
  });
  assert.ok(issueCodes(result).includes("AUDIT_NOT_PRODUCTION_ONLY"));
  assert.ok(issueCodes(result).includes("AUDIT_SUMMARY_MISMATCH"));
});

test("repository baseline is a current, exact-main-bound 36-advisory snapshot", async () => {
  const { validateProductionAuditBaseline } = await import(
    "./supply-chain-audit.mjs"
  );
  const repositoryBaseline = JSON.parse(
    await readRepositoryFile(
      "docs/security/production-dependency-audit-baseline.json",
    ),
  );
  const validation = validateProductionAuditBaseline(repositoryBaseline, {
    now: NOW,
    expectedBootstrapBase: BASE_COMMIT,
  });
  assert.deepEqual(validation.issues, []);
  assert.equal(repositoryBaseline.summary.advisories, 36);
  assert.deepEqual(repositoryBaseline.summary.vulnerabilities, {
    info: 0,
    low: 4,
    moderate: 14,
    high: 18,
    critical: 0,
  });
  assert.equal(repositoryBaseline.source.base_commit, BASE_COMMIT);
});

test("dependency review and production audit are pinned, bounded canaries", async () => {
  const [workflow, requiredContextsText, packageText] = await Promise.all([
    readRepositoryFile(".github/workflows/supply-chain.yml"),
    readRepositoryFile(".github/required-contexts.json"),
    readRepositoryFile("package.json"),
  ]);
  const requiredContexts = JSON.parse(requiredContextsText);
  const repositoryPackage = JSON.parse(packageText);

  assert.match(workflow, /^  pull_request:\s*$/m);
  assert.match(workflow, /^  push:\s*$/m);
  assert.match(workflow, /^  schedule:\s*$/m);
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(
    workflow,
    /actions\/dependency-review-action@2031cfc080254a8a887f58cffee85186f0e49e48 # v4/,
  );
  assert.match(workflow, /^          fail-on-severity: moderate$/m);
  assert.match(workflow, /^          fail-on-scopes: runtime$/m);
  assert.doesNotMatch(workflow, /continue-on-error:/);
  assert.match(
    workflow,
    /git show "\$PR_BASE_SHA:\$BASELINE_PATH" > "\$TRUSTED_BASELINE"/,
  );
  assert.match(
    workflow,
    /--expected-bootstrap-base "\$PR_BASE_SHA"/,
  );
  assert.match(
    workflow,
    /pnpm audit --prod --registry=https:\/\/registry\.npmjs\.org --json/,
  );
  assert.equal(
    repositoryPackage.scripts["security:audit:prod"],
    "node scripts/supply-chain-audit.mjs verify",
  );
  for (const canaryContext of [
    "dependency review · canary",
    "production dependency audit · canary",
  ]) {
    assert.ok(!requiredContexts.required_contexts.includes(canaryContext));
  }
});

test("Dependabot keeps coordinated majors separate and groups maintenance by domain", async () => {
  const config = await readRepositoryFile(".github/dependabot.yml");
  for (const group of [
    "nestjs-runtime",
    "temporal-runtime",
    "site-renderer",
    "observability-runtime",
    "data-infrastructure",
    "ai-model-runtime",
    "contracts-tooling",
    "development-tooling",
    "production-runtime",
    "production-security",
    "development-security",
  ]) {
    assert.match(config, new RegExp(`^      ${group}:$`, "m"), group);
  }
  assert.doesNotMatch(config, /^      minor-and-patch:$/m);
  for (const dependency of [
    "astro",
    '"@nestjs/*"',
    '"fast-xml-parser"',
    '"@types/node"',
  ]) {
    assert.ok(config.includes(`dependency-name: ${dependency}`), dependency);
  }
  assert.match(config, /production-security:\n        applies-to: security-updates/);
  assert.match(config, /development-security:\n        applies-to: security-updates/);
});

test("CodeQL is a non-required JavaScript and TypeScript canary with minimal permissions", async () => {
  const [workflow, requiredContextsText] = await Promise.all([
    readRepositoryFile(".github/workflows/codeql-canary.yml"),
    readRepositoryFile(".github/required-contexts.json"),
  ]);
  const requiredContexts = JSON.parse(requiredContextsText);

  assert.match(workflow, /^  pull_request:\s*$/m);
  assert.match(workflow, /^  push:\s*$/m);
  assert.match(workflow, /^  schedule:\s*$/m);
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
  assert.match(
    workflow,
    /^permissions:\n  actions: read\n  contents: read\n  security-events: write$/m,
  );
  assert.match(
    workflow,
    /github\/codeql-action\/init@5595ccaf912efad79be6eef63a5619ff05969be3 # v4/,
  );
  assert.match(
    workflow,
    /github\/codeql-action\/analyze@5595ccaf912efad79be6eef63a5619ff05969be3 # v4/,
  );
  assert.match(workflow, /^          languages: javascript-typescript$/m);
  assert.match(workflow, /^          queries: security-extended$/m);
  assert.doesNotMatch(workflow, /continue-on-error:/);
  assert.ok(
    !requiredContexts.required_contexts.includes(
      "CodeQL JavaScript/TypeScript · canary",
    ),
  );
});
