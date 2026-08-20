import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  findingFingerprint,
  scanEnvironmentParityFindings,
  validateEnvironmentParityPolicy,
  verifyEnvironmentParityRepository,
} from "./environment-parity-policy.mjs";

const repositoryRoot = new URL("../", import.meta.url);

function policy(overrides = {}) {
  return {
    schema_version: "environment-parity-policy/v1",
    product_source_roots: ["apps/api/src", "apps/site-renderer/src"],
    product_runtime_manifests: [
      "apps/api/package.json",
      "apps/site-renderer/package.json",
      "packages/contracts/package.json",
      "packages/db/package.json",
    ],
    excluded_path_patterns: [
      "(?:^|/)__tests__(?:/|$)",
      "\\.(?:spec|test)\\.[cm]?[jt]sx?$",
    ],
    allowed_difference_categories: [
      "trust",
      "endpoint",
      "secret",
      "network",
      "resource",
      "observability",
      "deployment",
      "test-process",
    ],
    configuration_allowlist: [],
    migration_allowlist: [],
    forbidden_runtime_dependencies: [
      "@global/test-support",
      "@global/site-renderer-visual-harness",
      "@global/site-builder-eval-runner",
    ],
    ...overrides,
  };
}

function findingFor(files, rule) {
  const finding = scanEnvironmentParityFindings(policy(), files).find(
    (candidate) => candidate.rule === rule,
  );
  assert.ok(finding, `expected ${rule} finding`);
  return finding;
}

test("unregistered product environment branches fail closed", () => {
  const directFiles = new Map([
    [
      "apps/api/src/composition.ts",
      "if (process.env.NODE_ENV !== 'production') registerSyntheticProvider();\n",
    ],
  ]);
  const directResult = validateEnvironmentParityPolicy(policy(), directFiles);

  assert.ok(
    directResult.issues.some(
      (issue) => issue.code === "ENVIRONMENT_PARITY_VIOLATION",
    ),
  );

  const destructuredResult = validateEnvironmentParityPolicy(
    policy(),
    new Map([
      [
        "apps/api/src/composition.ts",
        "const { NODE_ENV } = process.env;\nif (NODE_ENV !== 'production') registerSyntheticProvider();\n",
      ],
    ]),
  );
  assert.ok(
    destructuredResult.issues.some(
      (issue) => issue.code === "ENVIRONMENT_PARITY_VIOLATION",
    ),
    "destructured environment selectors must not bypass the policy",
  );
});

test("the source scan is structural and ignores explanatory string literals", () => {
  const findings = scanEnvironmentParityFindings(
    policy(),
    new Map([
      [
        "apps/api/src/runtime/help.ts",
        "export const help = 'APP_ENVIRONMENT does not permit DevTokenVerifier';\n",
      ],
    ]),
  );

  assert.deepEqual(findings, []);
});

test("an exact configuration difference may be allowlisted by category", () => {
  const files = new Map([
    [
      "apps/api/src/runtime/network.ts",
      "const mode = process.env.APP_ENVIRONMENT;\n",
    ],
  ]);
  const finding = findingFor(files, "ENVIRONMENT_BRANCH");
  const result = validateEnvironmentParityPolicy(
    policy({
      configuration_allowlist: [
        {
          id: "runtime-mode-input",
          rule: finding.rule,
          path: finding.path,
          match_sha256: findingFingerprint(finding),
          category: "deployment",
          reason: "Select the deployment trust and endpoint configuration.",
        },
      ],
    }),
    files,
  );

  assert.deepEqual(result.issues, []);
});

test("business semantics cannot be invented as an allowed difference category", () => {
  const files = new Map([
    [
      "apps/api/src/runtime/business.ts",
      "const mode = process.env.APP_ENVIRONMENT;\n",
    ],
  ]);
  const finding = findingFor(files, "ENVIRONMENT_BRANCH");
  const result = validateEnvironmentParityPolicy(
    policy({
      allowed_difference_categories: ["deployment", "business"],
      configuration_allowlist: [
        {
          id: "business-mode",
          rule: finding.rule,
          path: finding.path,
          match_sha256: findingFingerprint(finding),
          category: "business",
          reason: "Change product behavior by environment.",
        },
      ],
    }),
    files,
  );

  assert.ok(
    result.issues.some(
      (issue) => issue.code === "ENVIRONMENT_PARITY_POLICY_INVALID",
    ),
  );
});

test("migration allowances are exact and stale allowances fail", () => {
  const originalFiles = new Map([
    ["apps/api/src/auth/auth.module.ts", "return new DevTokenVerifier();\n"],
  ]);
  const finding = findingFor(originalFiles, "DEV_ONLY_RUNTIME_SYMBOL");
  const migration = {
    id: "remove-dev-token-verifier",
    rule: finding.rule,
    path: finding.path,
    match_sha256: findingFingerprint(finding),
    reason: "Existing development-only authentication path.",
    target_state: "All managed runtimes use the JWKS verifier.",
  };

  assert.deepEqual(
    validateEnvironmentParityPolicy(
      policy({ migration_allowlist: [migration] }),
      originalFiles,
    ).issues,
    [],
  );

  const removed = validateEnvironmentParityPolicy(
    policy({ migration_allowlist: [migration] }),
    new Map([["apps/api/src/auth/auth.module.ts", "return verifier;\n"]]),
  );
  assert.ok(
    removed.issues.some(
      (issue) => issue.code === "ENVIRONMENT_ALLOWANCE_STALE",
    ),
  );

  const mutated = validateEnvironmentParityPolicy(
    policy({ migration_allowlist: [migration] }),
    new Map([
      [
        "apps/api/src/auth/auth.module.ts",
        "return new DevTokenVerifier({ unsafe: true });\n",
      ],
    ]),
  );
  assert.ok(
    mutated.issues.some(
      (issue) => issue.code === "ENVIRONMENT_PARITY_VIOLATION",
    ),
  );
  assert.ok(
    mutated.issues.some(
      (issue) => issue.code === "ENVIRONMENT_ALLOWANCE_STALE",
    ),
  );
});

test("duplicating an allowlisted branch creates a new unapproved occurrence", () => {
  const path = "apps/api/src/runtime/network.ts";
  const originalFiles = new Map([
    [path, "const mode = process.env.APP_ENVIRONMENT;\n"],
  ]);
  const finding = findingFor(originalFiles, "ENVIRONMENT_BRANCH");
  const configuredPolicy = policy({
    configuration_allowlist: [
      {
        id: "runtime-mode-input",
        rule: finding.rule,
        path,
        match_sha256: findingFingerprint(finding),
        category: "deployment",
        reason: "Select the deployment configuration.",
      },
    ],
  });
  const result = validateEnvironmentParityPolicy(
    configuredPolicy,
    new Map([
      [
        path,
        "const mode = process.env.APP_ENVIRONMENT;\nconst mode = process.env.APP_ENVIRONMENT;\n",
      ],
    ]),
  );

  assert.ok(
    result.issues.some(
      (issue) => issue.code === "ENVIRONMENT_PARITY_VIOLATION",
    ),
  );
});

test("legacy settlement gates and test-only runtime symbols are prohibited", () => {
  const cases = [
    [
      "const path = env.SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_PATH;",
      "LEGACY_MODEL_SETTLEMENT_GATE",
    ],
    [
      "throw new PaidCallDeniedError('MODEL_PREFLIGHT_PAID_OPERATION_NOT_ATTESTED');",
      "LEGACY_MODEL_SETTLEMENT_GATE",
    ],
    ["registry.register(new StubModelProvider());", "DEV_ONLY_RUNTIME_SYMBOL"],
    [
      "registry.register(new SandboxDiscoveryProvider());",
      "DEV_ONLY_RUNTIME_SYMBOL",
    ],
    ["return new DevTokenVerifier();", "DEV_ONLY_RUNTIME_SYMBOL"],
    [
      "if (provider.id === 'stub') return unvalidated;",
      "SYNTHETIC_PROVIDER_RUNTIME_PATH",
    ],
    [
      "if (env.DISCOVERY_ALLOW_SANDBOX === 'true') registerSandbox();",
      "SYNTHETIC_PROVIDER_RUNTIME_PATH",
    ],
    [
      "beforeQualityCollectionForTest?: () => Promise<void>;",
      "TEST_ONLY_RUNTIME_HOOK",
    ],
    ["return 'site-renderer@dev-unpinned';", "UNPINNED_RUNTIME_IDENTITY"],
    [
      "return intFromEnv('SITE_BUILD_BUDGET_CENTS', 500);",
      "HIDDEN_PRODUCT_BUDGET_CAP",
    ],
  ];

  for (const [source, expectedRule] of cases) {
    const findings = scanEnvironmentParityFindings(
      policy(),
      new Map([["apps/api/src/product.ts", `${source}\n`]]),
    );
    assert.ok(
      findings.some((finding) => finding.rule === expectedRule),
      `${source} must trigger ${expectedRule}`,
    );
  }
});

test("test workspaces are forbidden only as product runtime dependencies", () => {
  const productionManifest = JSON.stringify({
    name: "@global/api",
    dependencies: { "@global/test-support": "workspace:*" },
  });
  const runtimeResult = validateEnvironmentParityPolicy(
    policy(),
    new Map([["apps/api/package.json", productionManifest]]),
  );
  assert.ok(
    runtimeResult.issues.some(
      (issue) => issue.code === "TEST_RUNTIME_DEPENDENCY_FORBIDDEN",
    ),
  );

  const testManifest = JSON.stringify({
    name: "@global/api",
    devDependencies: { "@global/test-support": "workspace:*" },
  });
  assert.deepEqual(
    validateEnvironmentParityPolicy(
      policy(),
      new Map([["apps/api/package.json", testManifest]]),
    ).issues,
    [],
  );

  const sourceImport = validateEnvironmentParityPolicy(
    policy(),
    new Map([
      [
        "apps/api/src/main.ts",
        "import { fixture } from '@global/test-support';\nimport { stub } from '@global/test-support/model';\nconst lazy = import('@global/test-support');\nconst common = require('@global/test-support');\nvoid fixture; void stub; void lazy; void common;\n",
      ],
      ["apps/api/package.json", testManifest],
    ]),
  );
  assert.ok(
    sourceImport.issues.some(
      (issue) => issue.code === "TEST_RUNTIME_DEPENDENCY_FORBIDDEN",
    ),
  );
  assert.equal(
    scanEnvironmentParityFindings(
      policy(),
      new Map([
        [
          "apps/api/src/main.ts",
          "import { fixture } from '@global/test-support';\nimport { stub } from '@global/test-support/model';\nconst lazy = import('@global/test-support');\nconst common = require('@global/test-support');\n",
        ],
      ]),
    ).filter((finding) => finding.rule === "TEST_RUNTIME_DEPENDENCY_FORBIDDEN")
      .length,
    4,
  );
});

test("the repository policy is executable and current", async () => {
  const result = await verifyEnvironmentParityRepository({
    root: repositoryRoot,
  });
  assert.deepEqual(result.issues, []);
  assert.ok(
    result.finding_count > 0,
    "configuration and migration findings remain explicit",
  );
});

test("the parity policy and high-risk runtime surfaces are code-owner controlled", async () => {
  const [codeowners, requiredContextsText] = await Promise.all([
    readFile(new URL(".github/CODEOWNERS", repositoryRoot), "utf8"),
    readFile(new URL(".github/required-contexts.json", repositoryRoot), "utf8"),
  ]);
  const requiredContexts = JSON.parse(requiredContextsText);
  const patterns = [
    "/apps/api/src/auth/",
    "/apps/api/src/discovery/provider.registry.ts",
    "/apps/api/src/discovery/providers/",
    "/apps/api/src/health/",
    "/apps/api/src/model-gateway/",
    "/apps/api/src/site-builder/site-build-cost-ledger.ts",
    "/apps/api/src/site-builder/site-builder-model-settlement.ts",
    "/apps/api/src/temporal/",
    "/apps/site-renderer/src/",
    "/docs/adr/",
    "/docs/product-scope.md",
    "/docs/site-builder/model-settlement-preflight.md",
    "/scripts/environment-parity-*.mjs",
  ];

  for (const pattern of patterns) {
    assert.ok(
      codeowners.split(/\r?\n/u).includes(`${pattern} @mlhjyx`),
      `CODEOWNERS is missing ${pattern}`,
    );
    assert.ok(
      requiredContexts.codeowner_requirements.terminal_patterns.includes(
        pattern,
      ),
      `machine CODEOWNERS policy is missing ${pattern}`,
    );
  }
});

test("ADR-024 and the supersession boundary remain explicit", async () => {
  const [registry, scope, preflight, authImplementationRecord] =
    await Promise.all([
      readFile(new URL("docs/adr/registry.md", repositoryRoot), "utf8"),
      readFile(new URL("docs/product-scope.md", repositoryRoot), "utf8"),
      readFile(
        new URL(
          "docs/site-builder/model-settlement-preflight.md",
          repositoryRoot,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "docs/implementation-records/acq-authz-scopes-tdd.md",
          repositoryRoot,
        ),
        "utf8",
      ),
    ]);

  assert.match(registry, /ADR-024 ENVIRONMENT-PARITY-AND-BUDGET-AUTHORITY/);
  assert.match(registry, /正常产品请求.*Budget Grant/);
  assert.match(registry, /ad-hoc.*evaluation/i);
  assert.match(scope, /SaaS.*Billing.*Credits.*SoR/);
  assert.match(scope, /Budget Grant/);
  assert.match(preflight, /Status: `SUPERSEDED`/);
  assert.match(preflight, /ADR-024/);
  assert.match(preflight, /历史 provenance/);
  assert.match(authImplementationRecord, /Status: `SUPERSEDED`/);
  assert.match(authImplementationRecord, /ADR-024/);
  assert.match(authImplementationRecord, /DevTokenVerifier.*历史实现/);
});
