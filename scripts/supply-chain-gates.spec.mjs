import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);
const BASE_COMMIT = "6b78901c2b4aee211e93ca11d5af13ea74398459";
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
      reason:
        "Existing transitive production dependency pending coordinated upgrade.",
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
      command: "pnpm audit --prod --registry=https://registry.npmjs.org --json",
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
      exposures: advisories.reduce(
        (count, item) =>
          count +
          (
            item.findings ?? [
              { version: "1.0.0", paths: [`api > ${item.package}@1.0.0`] },
            ]
          ).reduce(
            (findingCount, finding) =>
              findingCount + Math.max(finding.paths.length, 1),
            0,
          ),
        0,
      ),
      vulnerabilities: vulnerabilityCounts,
    },
    exposure: {
      schema_version: "production-dependency-exposure/v1",
      path_evidence: "REQUIRED",
      findings: advisories.flatMap((item) =>
        (
          item.findings ?? [
            { version: "1.0.0", paths: [`api > ${item.package}@1.0.0`] },
          ]
        ).flatMap((finding) =>
          (finding.paths.length === 0 ? [null] : finding.paths).map((path) => ({
            ghsa_id: item.ghsa_id,
            package: item.package,
            version: finding.version,
            path,
          })),
        ),
      ),
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
          findings: item.findings ?? [
            { version: "1.0.0", paths: [`api > ${item.package}@1.0.0`] },
          ],
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
    { now: NOW },
  );
  assert.deepEqual(improved.issues, []);
  assert.deepEqual(improved.resolved_advisories, [
    "GHSA-dddd-eeee-ffff|second-runtime",
  ]);
});

test("audit receipt distinguishes legacy-risk ratchet pass from a clear result", async () => {
  const { buildProductionAuditReceipt } =
    await import("./supply-chain-audit.mjs");

  assert.deepEqual(
    buildProductionAuditReceipt({
      ok: true,
      current_advisories: 2,
      resolved_advisories: [],
    }),
    {
      schema_version: "production-dependency-audit-result/v1",
      result: "RATCHET_PASS_WITH_LEGACY_RISK",
      current_advisories: 2,
      resolved_advisories: [],
      registry: "https://registry.npmjs.org/",
    },
  );
  assert.equal(
    buildProductionAuditReceipt({
      ok: true,
      current_advisories: 0,
      resolved_advisories: ["GHSA-aaaa-bbbb-cccc|example-runtime"],
    }).result,
    "PASS_CLEAR",
  );
});

test("a resolved advisory cannot reappear relative to the PR base audit", async () => {
  const { evaluateProductionAudit } = await import("./supply-chain-audit.mjs");
  const retained = advisory();
  const resolvedAtBase = advisory({
    ghsa_id: "GHSA-dddd-eeee-ffff",
    package: "resolved-runtime",
    severity: "low",
    url: "https://github.com/advisories/GHSA-dddd-eeee-ffff",
  });
  const legacyBaseline = baseline([retained, resolvedAtBase]);

  const result = evaluateProductionAudit(
    pnpmAudit([retained, resolvedAtBase]),
    legacyBaseline,
    {
      now: NOW,
      comparisonAudit: pnpmAudit([retained]),
    },
  );
  assert.ok(issueCodes(result).includes("AUDIT_REINTRODUCED_ADVISORY"));

  const malformedComparison = evaluateProductionAudit(
    pnpmAudit([retained]),
    legacyBaseline,
    {
      now: NOW,
      comparisonAudit: { metadata: {}, advisories: {} },
    },
  );
  assert.ok(
    issueCodes(malformedComparison).includes("AUDIT_COMPARISON_INVALID"),
  );
});

test("an admitted advisory cannot expand to a new version or dependency path", async () => {
  const { evaluateProductionAudit } = await import("./supply-chain-audit.mjs");
  const existing = advisory();
  const baseAudit = pnpmAudit([
    {
      ...existing,
      findings: [{ version: "1.0.0", paths: ["api > example-runtime@1.0.0"] }],
    },
  ]);
  const expandedAudit = pnpmAudit([
    {
      ...existing,
      findings: [
        {
          version: "1.0.0",
          paths: [
            "api > example-runtime@1.0.0",
            "worker > example-runtime@1.0.0",
          ],
        },
        { version: "1.1.0", paths: [] },
      ],
    },
  ]);

  const result = evaluateProductionAudit(expandedAudit, baseline([existing]), {
    now: NOW,
    comparisonAudit: baseAudit,
  });
  assert.ok(issueCodes(result).includes("AUDIT_EXPOSURE_EXPANDED"));

  const scheduledResult = evaluateProductionAudit(
    expandedAudit,
    baseline([existing]),
    { now: NOW },
  );
  assert.ok(
    issueCodes(scheduledResult).includes("AUDIT_EXPOSURE_NOT_BASELINED"),
  );
});

test("admitted advisory version metadata cannot drift without review", async () => {
  const { evaluateProductionAudit } = await import("./supply-chain-audit.mjs");
  const existing = advisory();
  const drifted = advisory({
    vulnerable_versions: "<3.0.0",
    patched_versions: ">=3.0.0",
  });

  const result = evaluateProductionAudit(
    pnpmAudit([drifted]),
    baseline([existing]),
    { now: NOW, comparisonAudit: pnpmAudit([existing]) },
  );
  assert.ok(issueCodes(result).includes("AUDIT_ADVISORY_METADATA_DRIFT"));
});

test("initial bootstrap is exact and cannot pre-admit future advisories", async () => {
  const { evaluateProductionAudit, validateProductionAuditBaseline } =
    await import("./supply-chain-audit.mjs");
  const existing = advisory();
  const preAdmitted = advisory({
    ghsa_id: "GHSA-futr-vuln-0001",
    package: "future-runtime",
    url: "https://github.com/advisories/GHSA-futr-vuln-0001",
  });
  const result = evaluateProductionAudit(
    pnpmAudit([existing]),
    baseline([existing, preAdmitted]),
    {
      now: NOW,
      expectedBootstrapBase: BASE_COMMIT,
      expectedSourceLockfileDigest: LOCKFILE_DIGEST,
    },
  );
  assert.ok(issueCodes(result).includes("BASELINE_BOOTSTRAP_SET_MISMATCH"));

  const wrongLockDigest = validateProductionAuditBaseline(baseline(), {
    now: NOW,
    expectedBootstrapBase: BASE_COMMIT,
    expectedSourceLockfileDigest: `sha256:${"b".repeat(64)}`,
  });
  assert.ok(
    issueCodes(wrongLockDigest).includes("BASELINE_SOURCE_LOCK_MISMATCH"),
  );

  const wrongExposure = evaluateProductionAudit(
    pnpmAudit([existing]),
    {
      ...baseline([existing]),
      exposure: {
        ...baseline([existing]).exposure,
        findings: [],
      },
      summary: { ...baseline([existing]).summary, exposures: 0 },
    },
    { now: NOW, expectedBootstrapBase: BASE_COMMIT },
  );
  assert.ok(
    issueCodes(wrongExposure).includes("BASELINE_BOOTSTRAP_EXPOSURE_MISMATCH"),
  );
});

test("unresolved advisories fail after their remediation due date", async () => {
  const { evaluateProductionAudit } = await import("./supply-chain-audit.mjs");
  const existing = advisory({
    remediation: {
      ...advisory().remediation,
      due_at: "2026-08-10T00:00:00.000Z",
    },
  });
  const result = evaluateProductionAudit(
    pnpmAudit([existing]),
    baseline([existing]),
    { now: new Date("2026-08-10T00:00:00.000Z") },
  );
  assert.ok(issueCodes(result).includes("AUDIT_REMEDIATION_OVERDUE"));
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
  const { validateProductionAuditBaseline } =
    await import("./supply-chain-audit.mjs");
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
  const original = pnpmAudit();
  const malformed = {
    ...original,
    metadata: {
      ...original.metadata,
      dependencies: "unknown",
      devDependencies: 3,
      vulnerabilities: {
        ...original.metadata.vulnerabilities,
        moderate: 0,
      },
    },
  };
  const result = evaluateProductionAudit(malformed, baseline(), {
    now: NOW,
    expectedBootstrapBase: BASE_COMMIT,
  });
  assert.ok(issueCodes(result).includes("AUDIT_NOT_PRODUCTION_ONLY"));
  assert.ok(issueCodes(result).includes("AUDIT_METADATA_INVALID"));
  assert.ok(issueCodes(result).includes("AUDIT_SUMMARY_MISMATCH"));

  const validFindings = pnpmAudit();
  const malformedFindings = {
    ...validFindings,
    advisories: {
      ...validFindings.advisories,
      1: {
        ...validFindings.advisories["1"],
        findings: [{ version: "1.0.0", paths: [""] }],
      },
    },
  };
  const findingResult = evaluateProductionAudit(malformedFindings, baseline(), {
    now: NOW,
  });
  assert.ok(issueCodes(findingResult).includes("AUDIT_FINDINGS_INVALID"));

  const missingPaths = pnpmAudit([
    { ...advisory(), findings: [{ version: "1.0.0", paths: [] }] },
  ]);
  const missingPathResult = evaluateProductionAudit(missingPaths, baseline(), {
    now: NOW,
    comparisonAudit: missingPaths,
  });
  assert.ok(
    issueCodes(missingPathResult).includes("AUDIT_PATH_EVIDENCE_INCOMPLETE"),
  );
});

test("repository baseline is a current, exact-main-bound 36-advisory snapshot", async () => {
  const { validateProductionAuditBaseline } =
    await import("./supply-chain-audit.mjs");
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
  const [workflow, requiredContextsText, auditScript] = await Promise.all([
    readRepositoryFile(".github/workflows/supply-chain.yml"),
    readRepositoryFile(".github/required-contexts.json"),
    readRepositoryFile("scripts/supply-chain-audit.mjs"),
  ]);
  const requiredContexts = JSON.parse(requiredContextsText);

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
  assert.match(workflow, /--expected-bootstrap-base "\$PR_BASE_SHA"/);
  assert.match(
    workflow,
    /--expected-source-lockfile-digest "\$base_lock_digest"/,
  );
  assert.match(
    workflow,
    /git diff --no-renames --name-only -z "\$PR_BASE_SHA\.\.\.\$GITHUB_SHA"/,
  );
  assert.match(workflow, /pnpm audit --prod[^\n]+> "\$BASE_AUDIT"/);
  assert.match(workflow, /--comparison-audit-file "\$BASE_AUDIT"/);
  assert.match(workflow, /^          version: 9\.15\.9$/m);
  assert.ok(
    workflow.match(
      /pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile/g,
    )?.length >= 2,
  );
  for (const protectedBootstrapPath of [
    "package.json | */package.json",
    "pnpm-lock.yaml | pnpm-workspace.yaml",
    ".npmrc | */.npmrc",
    ".pnpmfile.cjs | */.pnpmfile.cjs",
    "patches/*",
  ]) {
    assert.ok(
      workflow.includes(protectedBootstrapPath),
      `bootstrap dependency scope must include ${protectedBootstrapPath}`,
    );
  }
  assert.match(
    auditScript,
    /pnpm audit --prod --registry=https:\/\/registry\.npmjs\.org --json/,
  );
  assert.match(workflow, /node "\$TRUSTED_VERIFIER" "\$\{audit_args\[@\]\}"/);
  for (const canaryContext of [
    "dependency review · canary",
    "production dependency audit · canary",
  ]) {
    assert.ok(!requiredContexts.required_contexts.includes(canaryContext));
  }
});

test("package-manager network trust is isolated before install and audit", async () => {
  const {
    assertNoRepositoryNpmrc,
    assertNoRepositoryNonRegularFiles,
    buildTrustedPnpmEnvironment,
  } = await import("./supply-chain-source-policy.mjs");
  const hostileEnvironment = {
    PATH: "/trusted/bin",
    HTTPS_PROXY: "http://attacker.invalid:8080",
    npm_config_https_proxy: "http://attacker.invalid:8080",
    NPM_CONFIG_STRICT_SSL: "false",
    NPM_CONFIG_CAFILE: "/tmp/attacker-ca.pem",
    NODE_EXTRA_CA_CERTS: "/tmp/attacker-ca.pem",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NODE_OPTIONS: "--require=/tmp/attacker-hook.cjs",
    SSL_CERT_FILE: "/tmp/attacker-ca.pem",
  };
  const trustedEnvironment = buildTrustedPnpmEnvironment(hostileEnvironment);

  assert.equal(trustedEnvironment.PATH, "/trusted/bin");
  assert.equal(
    trustedEnvironment.NPM_CONFIG_REGISTRY,
    "https://registry.npmjs.org/",
  );
  assert.equal(trustedEnvironment.NPM_CONFIG_USERCONFIG, "/dev/null");
  assert.equal(trustedEnvironment.NPM_CONFIG_GLOBALCONFIG, "/dev/null");
  assert.equal(trustedEnvironment.NPM_CONFIG_IGNORE_PNPMFILE, "true");
  assert.equal(trustedEnvironment.NPM_CONFIG_IGNORE_SCRIPTS, "true");
  for (const key of Object.keys(trustedEnvironment)) {
    assert.doesNotMatch(
      key,
      /^(?:https?_proxy|all_proxy|no_proxy|node_extra_ca_certs|node_tls_reject_unauthorized|node_options|ssl_cert_(?:file|dir)|npm_config_(?:https?_proxy|proxy|strict_ssl|cafile|ca))$/i,
    );
  }
  assert.doesNotThrow(() => assertNoRepositoryNpmrc([]));
  assert.throws(
    () => assertNoRepositoryNpmrc([".npmrc", "packages/api/.npmrc"]),
    /repository \.npmrc is not admitted/,
  );
  assert.doesNotThrow(() => assertNoRepositoryNonRegularFiles([]));
  assert.throws(
    () =>
      assertNoRepositoryNonRegularFiles([
        { mode: "120000", path: "apps/external-workspace" },
        { mode: "160000", path: "packages/external-submodule" },
      ]),
    /repository symlinks and gitlinks are not admitted/,
  );

  const [workflow, codeowners, auditScript, requiredContextsText] =
    await Promise.all([
      readRepositoryFile(".github/workflows/supply-chain.yml"),
      readRepositoryFile(".github/CODEOWNERS"),
      readRepositoryFile("scripts/supply-chain-audit.mjs"),
      readRepositoryFile(".github/required-contexts.json"),
    ]);
  const requiredContexts = JSON.parse(requiredContextsText);
  const configGuard = workflow.indexOf(
    "Reject repository package-manager network overrides",
  );
  const auditStep = workflow.indexOf(
    "Audit production dependencies against the trusted ratchet",
  );
  assert.ok(configGuard >= 0 && configGuard < auditStep);
  assert.match(workflow, /git ls-files -z[^\n]+\.npmrc/);
  assert.ok(
    workflow.match(
      /pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --registry=https:\/\/registry\.npmjs\.org/g,
    )?.length >= 2,
  );
  assert.ok(
    workflow.match(/^\s+env -i \\$/gm)?.length >= 2,
    "both head and base installs must start from an environment allowlist",
  );
  for (const safeOverride of [
    "NPM_CONFIG_REGISTRY=https://registry.npmjs.org/",
    "NPM_CONFIG_USERCONFIG=/dev/null",
    "NPM_CONFIG_GLOBALCONFIG=/dev/null",
    "NPM_CONFIG_IGNORE_PNPMFILE=true",
    "NPM_CONFIG_IGNORE_SCRIPTS=true",
  ]) {
    assert.ok(workflow.includes(safeOverride), safeOverride);
  }
  for (const protectedPath of [
    "/package.json @mlhjyx",
    "/**/package.json @mlhjyx",
    "/pnpm-lock.yaml @mlhjyx",
    "/pnpm-workspace.yaml @mlhjyx",
    "/.npmrc @mlhjyx",
    "/**/.npmrc @mlhjyx",
    "/.pnpmfile.cjs @mlhjyx",
    "/**/.pnpmfile.cjs @mlhjyx",
    "/patches/ @mlhjyx",
    "/scripts/supply-chain-source-policy*.mjs @mlhjyx",
  ]) {
    assert.ok(codeowners.includes(protectedPath), protectedPath);
  }
  for (const protectedPattern of [
    "/**/package.json",
    "/pnpm-lock.yaml",
    "/pnpm-workspace.yaml",
    "/.npmrc",
    "/**/.npmrc",
    "/.pnpmfile.cjs",
    "/**/.pnpmfile.cjs",
    "/patches/",
    "/scripts/supply-chain-source-policy*.mjs",
  ]) {
    assert.ok(
      requiredContexts.codeowner_requirements.terminal_patterns.includes(
        protectedPattern,
      ),
      `machine governance must bind ${protectedPattern}`,
    );
  }
  assert.match(
    auditScript,
    /assertNoRepositoryNpmrc\(listTrackedRepositoryNpmrc\(process\.cwd\(\)\)\);[\s\S]+spawnSync\(/,
  );
  assert.match(
    auditScript,
    /validateRepositoryDependencySources\(process\.cwd\(\)\)/,
    "the verifier CLI must independently enforce source admission",
  );
});

test("trusted source policy rejects direct dependency fetches before install", async () => {
  const { validateDependencySourcePolicy } =
    await import("./supply-chain-source-policy.mjs");
  const safeInput = {
    manifests: [
      {
        path: "package.json",
        document: {
          name: "root",
          dependencies: {
            registry: "^1.2.3",
            workspace: "workspace:*",
          },
        },
      },
      {
        path: "packages/workspace/package.json",
        document: { name: "workspace" },
      },
    ],
    workspaceText: 'packages:\n  - "packages/*"\n',
    lockfileText:
      "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      workspace:\n        specifier: workspace:*\n        version: link:packages/workspace\n",
  };
  assert.deepEqual(validateDependencySourcePolicy(safeInput).issues, []);

  for (const auditConfig of [
    { ignoreGhsas: ["GHSA-aaaa-bbbb-cccc"] },
    { ignoreCves: ["CVE-2026-0001"] },
  ]) {
    const result = validateDependencySourcePolicy({
      ...safeInput,
      manifests: safeInput.manifests.map((manifest) =>
        manifest.path === "package.json"
          ? {
              ...manifest,
              document: {
                ...manifest.document,
                pnpm: { auditConfig },
              },
            }
          : manifest,
      ),
    });
    assert.ok(
      issueCodes(result).includes("DEPENDENCY_AUDIT_IGNORE_NOT_TRUSTED"),
      JSON.stringify(auditConfig),
    );
  }

  for (const workspaceMutation of [
    'packages: ["../outside"]\n',
    'packages: ["/tmp/outside"]\n',
    'packages: ["packages/*", "../outside"]\n',
    "packages:\n  - 123\n",
    'packages:\n  - "packages/*"\nhttps\\u0050roxy: "http://attacker.invalid"\nstrict\\u0053sl: false\n',
  ]) {
    const result = validateDependencySourcePolicy({
      ...safeInput,
      workspaceText: workspaceMutation,
    });
    assert.ok(
      issueCodes(result).includes("WORKSPACE_SOURCE_NOT_TRUSTED"),
      workspaceMutation,
    );
  }

  for (const specifier of [
    "https://attacker.invalid/runtime.tgz",
    "git+https://attacker.invalid/runtime.git",
    "github:attacker/runtime",
    "git@attacker.invalid:runtime.git",
    "file:../../outside",
    "link:../../outside",
  ]) {
    const result = validateDependencySourcePolicy({
      ...safeInput,
      manifests: [
        {
          path: "package.json",
          document: {
            name: "root",
            dependencies: { runtime: specifier },
          },
        },
      ],
    });
    assert.ok(
      issueCodes(result).includes("DEPENDENCY_SOURCE_NOT_TRUSTED"),
      specifier,
    );
  }

  for (const lockfileMutation of [
    "\npackages:\n  runtime:\n    resolution: {tarball: https://attacker.invalid/runtime.tgz}\n",
    "\npackages:\n  runtime:\n    resolution: {repo: git@attacker.invalid:runtime.git}\n",
    "\npackages:\n  runtime:\n    resolution: {repo: attacker/runtime, commit: deadbeef, type: git}\n",
    "\nimporters:\n  apps/api:\n    dependencies:\n      runtime:\n        version: link:../../../../outside\n",
  ]) {
    const result = validateDependencySourcePolicy({
      ...safeInput,
      lockfileText: `${safeInput.lockfileText}${lockfileMutation}`,
    });
    assert.ok(
      issueCodes(result).some((code) =>
        [
          "LOCKFILE_EXTERNAL_SOURCE_NOT_TRUSTED",
          "LOCKFILE_LINK_NOT_TRUSTED",
        ].includes(code),
      ),
      lockfileMutation,
    );
  }

  for (const escapedLockfileMutation of [
    '\npackages:\n  runtime:\n    resolution: {"re\\\\u0070o": attacker/runtime, "co\\\\u006dmit": deadbeef, "ty\\\\u0070e": git}\n',
    '\npackages:\n  runtime:\n    resolution:\n      "re\\\\u0070o": attacker/runtime\n      "co\\\\u006dmit": deadbeef\n      "ty\\\\u0070e": git\n',
    '\npackages:\n  runtime:\n    resolution: {"ta\\\\u0072ball": "htt\\\\u0070s://attacker.invalid/runtime.tgz"}\n',
    '\npackages:\n  runtime:\n    resolution: {"ta\\\\x72ball": "htt\\\\x70s://attacker.invalid/runtime.tgz"}\n',
    '\npackages:\n  runtime:\n    resolution: {"ta\\\\U00000072ball": "htt\\\\U00000070s://attacker.invalid/runtime.tgz"}\n',
    '\nimporters:\n  apps/api:\n    dependencies:\n      runtime:\n        version: "l\\\\u0069nk:../../outside"\n',
    "\npackages:\n  runtime:\n    'resolution': {'repo': attacker/runtime, 'commit': deadbeef, 'type': git}\n",
    "\npackages:\n  runtime@1.0.0: {!!binary cmVzb2x1dGlvbg== : {!!binary cmVwbw== : !!binary aHR0cHM6Ly9hdHRhY2tlci5pbnZhbGlkL3g=, !!binary Y29tbWl0 : deadbeef, !!binary dHlwZQ== : git}}\n",
    "\nlockfileVersion: !!str '9.0'\n",
    "\nlockfileVersion: !<tag:yaml.org,2002:str> '9.0'\n",
    "\nfoo: *.v\n",
    "\npackages:\n  runtime@1.0.0: {[resolution]: {[repo]: mirror.invalid:runtime, [commit]: deadbeef, [type]: git}}\n",
    "\npackages:\n  runtime@1.0.0: {? [resolution]: {? [repo]: mirror.invalid:runtime, ? [commit]: deadbeef, ? [type]: git}}\n",
  ]) {
    const result = validateDependencySourcePolicy({
      ...safeInput,
      lockfileText: `${safeInput.lockfileText}${escapedLockfileMutation}`,
    });
    assert.ok(
      issueCodes(result).includes("LOCKFILE_SYNTAX_NOT_TRUSTED"),
      escapedLockfileMutation,
    );
  }

  const workflow = await readRepositoryFile(
    ".github/workflows/supply-chain.yml",
  );
  const trustedSourcePolicy = workflow.indexOf(
    'git show "$PR_BASE_SHA:scripts/supply-chain-source-policy.mjs" > "$TRUSTED_SOURCE_POLICY"',
  );
  const headSourceValidation = workflow.indexOf(
    'node "$TRUSTED_SOURCE_POLICY" validate-sources --repository-root "$GITHUB_WORKSPACE"',
  );
  const headInstall = workflow.indexOf(
    "pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --registry=https://registry.npmjs.org",
    headSourceValidation,
  );
  assert.ok(
    trustedSourcePolicy >= 0 &&
      headSourceValidation > trustedSourcePolicy &&
      headInstall > headSourceValidation,
    "trusted base source policy must run before the head install",
  );
  const baseSourceValidation = workflow.indexOf(
    'node "$TRUSTED_SOURCE_POLICY" validate-sources --repository-root "$BASE_CHECKOUT"',
  );
  const baseInstall = workflow.indexOf(
    "pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --registry=https://registry.npmjs.org",
    baseSourceValidation,
  );
  assert.ok(
    baseSourceValidation > trustedSourcePolicy &&
      baseInstall > baseSourceValidation,
    "trusted source policy must run before the base install",
  );
  assert.match(
    workflow,
    /git worktree add --detach "\$BASE_CHECKOUT" "\$PR_BASE_SHA"/,
  );
  assert.doesNotMatch(
    workflow,
    /git archive "\$PR_BASE_SHA" \| tar -xf - -C "\$BASE_CHECKOUT"/,
  );
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
    '"astro"',
    '"@nestjs/*"',
    '"fast-xml-parser"',
    '"@types/node"',
  ]) {
    assert.ok(config.includes(`dependency-name: ${dependency}`), dependency);
  }
  assert.match(
    config,
    /production-security:\n        applies-to: security-updates/,
  );
  assert.match(
    config,
    /development-security:\n        applies-to: security-updates/,
  );
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
