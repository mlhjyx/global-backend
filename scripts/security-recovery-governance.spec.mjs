import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateDependencyAuditRegression,
  evaluateCoverage,
  scanSourceForSecurityFindings,
  validateComposeLock,
  validateIntegrationMatrix,
  validateRecoveryRehearsal,
  validateWorkflowPolicy,
} from "./security-recovery-governance.mjs";

function auditReport(advisories = []) {
  return {
    actions: [],
    advisories: Object.fromEntries(
      advisories.map((advisory, index) => [String(index + 1), advisory]),
    ),
    muted: [],
    metadata: {
      vulnerabilities: {
        info: 0,
        low: advisories.filter(({ severity }) => severity === "low").length,
        moderate: advisories.filter(({ severity }) => severity === "moderate")
          .length,
        high: advisories.filter(({ severity }) => severity === "high").length,
        critical: advisories.filter(({ severity }) => severity === "critical")
          .length,
      },
    },
  };
}

function advisory({
  id = "GHSA-existing",
  severity = "high",
  moduleName = "example-package",
  paths = ["apps/api > example-package@1.0.0"],
} = {}) {
  return {
    github_advisory_id: id,
    id: 123,
    severity,
    module_name: moduleName,
    vulnerable_versions: "<2.0.0",
    findings: [{ version: "1.0.0", paths }],
  };
}

const coveragePolicy = {
  schemaVersion: "api-coverage-policy/v1",
  targetPercent: 80,
  scope: {
    include: ["src/**/*.ts"],
    exclude: ["src/**/*.spec.ts", "src/**/testing/**"],
  },
  baseline: {
    statements: { covered: 17217, total: 24333 },
    branches: { covered: 13492, total: 20168 },
    functions: { covered: 3519, total: 4736 },
    lines: { covered: 16071, total: 22036 },
  },
  critical: {
    auth: {
      targetPercent: 80,
      baseline: { covered: 1, total: 40 },
      paths: ["src/auth/"],
    },
    events: {
      targetPercent: 80,
      baseline: { covered: 22, total: 23 },
      paths: ["src/events/"],
    },
  },
};

const expectedCoverageSources = [
  "src/auth/auth.guard.ts",
  "src/events/events.service.ts",
];

function summary(overrides = {}) {
  return {
    total: {
      statements: { covered: 17217, total: 24333 },
      branches: { covered: 13492, total: 20168 },
      functions: { covered: 3519, total: 4736 },
      lines: { covered: 16071, total: 22036 },
    },
    "/repo/apps/api/src/auth/auth.guard.ts": {
      branches: { covered: 1, total: 40 },
    },
    "/repo/apps/api/src/events/events.service.ts": {
      branches: { covered: 22, total: 23 },
    },
    ...overrides,
  };
}

describe("coverage ratchet", () => {
  it("keeps the 80 percent target explicit while reporting current debt", () => {
    const result = evaluateCoverage(
      coveragePolicy,
      summary(),
      expectedCoverageSources,
    );
    assert.equal(result.ok, true);
    assert.equal(result.targetPercent, 80);
    assert.equal(result.targetMet, false);
    assert.deepEqual(
      result.debt.map((entry) => entry.scope),
      [
        "global:statements",
        "global:branches",
        "global:functions",
        "global:lines",
        "critical:auth",
      ],
    );
    assert.deepEqual(
      result.debt.slice(0, 4).map((entry) => entry.currentPercent),
      [70.75, 66.89, 74.3, 72.93],
    );
  });

  it("fails when one global branch is lost even if rounded percentages look equal", () => {
    const result = evaluateCoverage(
      coveragePolicy,
      summary({
        total: {
          ...summary().total,
          branches: { covered: 13491, total: 20168 },
        },
      }),
      expectedCoverageSources,
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /global branches declined/);
  });

  it("fails when a below-target critical cohort declines", () => {
    const result = evaluateCoverage(
      coveragePolicy,
      summary({
        "/repo/apps/api/src/auth/auth.guard.ts": {
          branches: { covered: 0, total: 40 },
        },
      }),
      expectedCoverageSources,
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /critical:auth branches declined/);
  });

  it("fails when the summary omits a production source file", () => {
    const result = evaluateCoverage(coveragePolicy, summary(), [
      ...expectedCoverageSources,
      "src/main.ts",
    ]);
    assert.equal(result.ok, false);
    assert.match(
      result.errors.join("\n"),
      /coverage summary is missing production source src\/main\.ts/,
    );
  });
});

describe("workflow security policy", () => {
  const pinnedCheckout =
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";

  it("requires every external Action to use a full commit SHA", () => {
    const result = validateWorkflowPolicy({
      ".github/workflows/security.yml": `
permissions:
  contents: read
  pull-requests: read
jobs:
  secret-scan:
    name: gitleaks 密钥扫描
    steps:
      - run: gitleaks detect
  dependency-audit:
    name: dependency audit
    steps:
      - uses: ${pinnedCheckout}
        with:
          persist-credentials: false
      - run: pnpm audit --prod --json
      - run: node scripts/security-recovery-governance.mjs dependency-regression --base=base.json --head=head.json
  source-sast:
    name: repository SAST
    steps:
      - uses: ${pinnedCheckout}
        with:
          persist-credentials: false
      - run: pnpm security:sast
  compose-iac:
    name: container and Compose IaC
    steps:
      - uses: ${pinnedCheckout}
        with:
          persist-credentials: false
      - run: pnpm security:compose
  required-security:
    if: always()
    name: security · required gate
    needs: [secret-scan, dependency-audit, source-sast, compose-iac]
    steps:
      - env:
          SECRET_SCAN: \${{ needs.secret-scan.result }}
          DEPENDENCY_AUDIT: \${{ needs.dependency-audit.result }}
          SOURCE_SAST: \${{ needs.source-sast.result }}
          COMPOSE_IAC: \${{ needs.compose-iac.result }}
        run: |
          for result in "$SECRET_SCAN" "$DEPENDENCY_AUDIT" "$SOURCE_SAST" "$COMPOSE_IAC"; do
            if [[ "$result" != "success" ]]; then exit 1; fi
          done
`,
    });
    assert.equal(result.ok, true);
  });

  it("rejects a tag pin, write permission, or missing security lane", () => {
    const result = validateWorkflowPolicy({
      ".github/workflows/security.yml": `
permissions:
  contents: write
jobs:
  source-sast:
    steps:
      - uses: actions/checkout@v7
`,
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /full commit SHA/);
    assert.match(result.errors.join("\n"), /write permission/);
    assert.match(result.errors.join("\n"), /dependency audit/);
    assert.match(result.errors.join("\n"), /container and Compose IaC/);
  });

  it("rejects an omitted top-level permission boundary", () => {
    const result = validateWorkflowPolicy({
      ".github/workflows/security.yml": `
jobs:
  dependency-audit:
    name: dependency audit
    steps: [{ run: pnpm audit }]
  source-sast:
    name: repository SAST
    steps: [{ run: pnpm security:sast }]
  compose-iac:
    name: container and Compose IaC
    steps: [{ run: pnpm security:compose }]
`,
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /top-level contents: read/);
  });

  it("rejects checkout credentials persisted into PR-executing jobs", () => {
    const result = validateWorkflowPolicy({
      ".github/workflows/security.yml": `
permissions:
  contents: read
jobs:
  dependency-audit:
    name: dependency audit
    steps:
      - uses: ${pinnedCheckout}
      - run: pnpm audit
  source-sast:
    name: repository SAST
    steps: [{ run: pnpm security:sast }]
  compose-iac:
    name: container and Compose IaC
    steps: [{ run: pnpm security:compose }]
`,
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /persist-credentials: false/);
  });

  it("rejects a dependency lane that reports debt without comparing the PR against its base", () => {
    const result = validateWorkflowPolicy({
      ".github/workflows/security.yml": `
permissions:
  contents: read
jobs:
  dependency-audit:
    name: dependency audit
    steps:
      - run: pnpm audit --prod --audit-level=high
  source-sast:
    name: repository SAST
    steps: [{ run: pnpm security:sast }]
  compose-iac:
    name: container and Compose IaC
    steps: [{ run: pnpm security:compose }]
`,
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /dependency regression comparator/);
    assert.match(result.errors.join("\n"), /security required gate/);
  });

  it("rejects a security aggregator that can skip failures or ignores a lane result", () => {
    const result = validateWorkflowPolicy({
      ".github/workflows/security.yml": `
permissions:
  contents: read
jobs:
  secret-scan:
    name: gitleaks 密钥扫描
    steps: [{ run: gitleaks detect }]
  dependency-audit:
    name: dependency audit
    steps:
      - run: pnpm audit --prod --json
      - run: node scripts/security-recovery-governance.mjs dependency-regression --base=base.json --head=head.json
  source-sast:
    name: repository SAST
    steps: [{ run: pnpm security:sast }]
  compose-iac:
    name: container and Compose IaC
    steps: [{ run: pnpm security:compose }]
  required-security:
    name: security · required gate
    needs: [secret-scan, dependency-audit, source-sast, compose-iac]
    continue-on-error: true
    steps:
      - run: test "\${{ needs.secret-scan.result }}" = success
`,
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /cannot continue on error/);
    assert.match(result.errors.join("\n"), /must run with if: always/);
    assert.match(
      result.errors.join("\n"),
      /must inspect dependency-audit result/,
    );
  });
});

describe("dependency audit regression", () => {
  it("keeps inherited high-severity debt visible without blaming an unrelated PR", () => {
    const existing = advisory();
    const result = evaluateDependencyAuditRegression(
      auditReport([existing]),
      auditReport([existing]),
    );

    assert.equal(result.ok, true);
    assert.equal(result.inherited.length, 1);
    assert.equal(result.inherited[0].pathCount, 1);
    assert.equal(result.inheritedExposureCount, 1);
    assert.deepEqual(result.regressions, []);
    assert.equal(result.head.summary.high, 1);
  });

  it("fails when the head adds a high-severity advisory or a new vulnerable path", () => {
    const existing = advisory();
    const widened = advisory({
      paths: [
        "apps/api > example-package@1.0.0",
        "apps/worker > example-package@1.0.0",
      ],
    });
    const newCritical = advisory({
      id: "GHSA-new-critical",
      severity: "critical",
      moduleName: "new-package",
      paths: ["apps/api > new-package@1.0.0"],
    });
    const result = evaluateDependencyAuditRegression(
      auditReport([existing]),
      auditReport([widened, newCritical]),
    );

    assert.equal(result.ok, false);
    assert.equal(result.regressions.length, 2);
    assert.ok(
      result.regressions.some(({ advisoryId }) =>
        advisoryId.includes("GHSA-new-critical"),
      ),
    );
    assert.ok(
      result.regressions.some(({ path }) => path.startsWith("apps/worker")),
    );
  });

  it("does not block a newly reported moderate advisory but includes it in debt totals", () => {
    const result = evaluateDependencyAuditRegression(
      auditReport([]),
      auditReport([advisory({ severity: "moderate" })]),
    );

    assert.equal(result.ok, true);
    assert.equal(result.head.summary.moderate, 1);
    assert.deepEqual(result.regressions, []);
  });

  it("fails closed when either package registry response is an error envelope", () => {
    const result = evaluateDependencyAuditRegression(
      { error: { code: "AUDIT_UNAVAILABLE" } },
      auditReport([]),
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /base audit response/);
  });

  it("fails closed when an advisory has no dependency path evidence", () => {
    const withoutPath = {
      ...advisory(),
      findings: [],
    };
    const result = evaluateDependencyAuditRegression(
      auditReport([withoutPath]),
      auditReport([withoutPath]),
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /dependency paths/);
  });
});

describe("repository-local SAST", () => {
  it("rejects dynamic evaluation, unsafe Prisma raw SQL, and shell execution", () => {
    const findings = scanSourceForSecurityFindings({
      "apps/api/src/safe.ts": "export const safe = 1;\n",
      "apps/api/src/eval.ts": "eval(untrusted);\n",
      "apps/api/src/sql.ts": "db.$queryRawUnsafe(input);\n",
      "apps/api/src/shell.ts": "spawn('sh', [], { shell: true });\n",
    });
    assert.deepEqual(
      findings.map((finding) => finding.rule).sort(),
      ["dynamic-eval", "shell-true", "unsafe-prisma-raw"].sort(),
    );
  });
});

describe("Compose image lock", () => {
  const manifest = {
    schemaVersion: "container-image-lock/v1",
    services: {
      postgres: {
        kind: "remote",
        image:
          "pgvector/pgvector@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb",
        status: "VERIFIED_GLOBAL_DEV",
      },
      crawler: {
        kind: "local-build",
        image: "global-crawler:src-aaaaaaaaaaaa",
        build: { context: "./infra/crawler", dockerfile: "Dockerfile" },
        baseImages: ["example/crawler@sha256:" + "b".repeat(64)],
        sourceDigest: "a".repeat(64),
        sourceFiles: ["infra/crawler/Dockerfile"],
        buildReceiptStatus: "NOT_RUN",
        status: "SOURCE_LOCKED",
      },
    },
    profiles: {
      default: { services: ["postgres", "crawler"], status: "SOURCE_LOCKED" },
      observability: { services: [], status: "UNVERIFIED" },
    },
  };

  it("accepts digest-pinned remotes and source-bound local tags", () => {
    const compose = `
services:
  postgres:
    image: ${manifest.services.postgres.image}
  crawler:
    build:
      context: ./infra/crawler
    image: global-crawler:src-aaaaaaaaaaaa
`;
    const result = validateComposeLock({
      composeText: compose,
      manifest,
      profile: "default",
      localSourceDigests: { crawler: "a".repeat(64) },
      localDockerfileTexts: {
        crawler: `FROM example/crawler@sha256:${"b".repeat(64)}\n`,
      },
    });
    assert.equal(result.ok, true);
  });

  it("rejects moving tags, local source drift, and an unverified profile", () => {
    const moving = validateComposeLock({
      composeText: "services:\n  postgres:\n    image: postgres:latest\n",
      manifest,
      profile: "default",
      localSourceDigests: { crawler: "b".repeat(64) },
      localDockerfileTexts: {
        crawler: `FROM example/crawler@sha256:${"b".repeat(64)}\n`,
      },
    });
    assert.equal(moving.ok, false);
    assert.match(moving.errors.join("\n"), /moving or unlocked image/);
    assert.match(moving.errors.join("\n"), /source digest drift/);

    const redirectedBuild = validateComposeLock({
      composeText: `
services:
  postgres:
    image: ${manifest.services.postgres.image}
  crawler:
    build:
      context: ./infra/evil
    image: global-crawler:src-aaaaaaaaaaaa
`,
      manifest,
      profile: "default",
      localSourceDigests: { crawler: "a".repeat(64) },
      localDockerfileTexts: { crawler: "FROM example/crawler:latest\n" },
    });
    assert.equal(redirectedBuild.ok, false);
    assert.match(redirectedBuild.errors.join("\n"), /build source/);
    assert.match(redirectedBuild.errors.join("\n"), /Dockerfile FROM/);

    const optional = validateComposeLock({
      composeText: "",
      manifest,
      profile: "observability",
      localSourceDigests: {},
    });
    assert.equal(optional.ok, false);
    assert.match(
      optional.errors.join("\n"),
      /profile observability is UNVERIFIED/,
    );
  });

  it("rejects a build-only service without a source-bound image", () => {
    const result = validateComposeLock({
      composeText: `
services:
  postgres:
    image: ${manifest.services.postgres.image}
  crawler:
    build:
      context: ./infra/crawler
    image: global-crawler:src-aaaaaaaaaaaa
  bypass-build:
    build:
      context: ./infra/crawler
`,
      manifest,
      profile: "default",
      localSourceDigests: { crawler: "a".repeat(64) },
      localDockerfileTexts: {
        crawler: `FROM example/crawler@sha256:${"b".repeat(64)}\n`,
      },
    });
    assert.equal(result.ok, false);
    assert.match(
      result.errors.join("\n"),
      /bypass-build: compose service must declare a locked image/,
    );
  });

  it("rejects a local build override on a digest-locked remote service", () => {
    const result = validateComposeLock({
      composeText: `
services:
  postgres:
    build: ./infra/crawler
    image: ${manifest.services.postgres.image}
  crawler:
    build:
      context: ./infra/crawler
    image: global-crawler:src-aaaaaaaaaaaa
`,
      manifest,
      profile: "default",
      localSourceDigests: { crawler: "a".repeat(64) },
      localDockerfileTexts: {
        crawler: `FROM example/crawler@sha256:${"b".repeat(64)}\n`,
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /cannot declare a build context/);
  });
});

describe("recovery rehearsal admission", () => {
  const notRun = {
    schemaVersion: "recovery-rehearsal/v1",
    status: "NOT_RUN",
    authorization: null,
    startedAt: null,
    completedAt: null,
    receipts: [],
  };

  it("accepts the safe create-only NOT_RUN state", () => {
    assert.equal(validateRecoveryRehearsal(notRun).ok, true);
  });

  it("rejects every executed-state claim in the source-only verifier", () => {
    const result = validateRecoveryRehearsal({
      ...notRun,
      status: "PASSED",
      authorization: {
        authorizationId: "forged",
        authorizedBy: "forged",
        authorizedAt: "2026-08-08T00:00:00.000Z",
        scope: [
          "postgresql",
          "new-api",
          "minio",
          "temporal-sqlite",
          "configuration",
        ],
      },
      completedAt: "2026-08-08T00:00:00.000Z",
      receipts: [
        "postgresql",
        "new-api",
        "minio",
        "temporal-sqlite",
        "configuration",
      ].map((asset) => ({
        asset,
        status: "RESTORE_VERIFIED",
        sha256: "a".repeat(64),
      })),
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /accepts only NOT_RUN/);
  });
});

describe("integration context matrix", () => {
  const matrix = {
    schemaVersion: "integration-context-matrix/v1",
    contexts: {
      postgresql: {
        requiredContext: "PostgreSQL integration",
        status: "BLOCKED",
        isolation: "DISPOSABLE_DATABASE_AND_ROLE",
        command: null,
      },
      temporal: {
        requiredContext: "Temporal integration",
        status: "BLOCKED",
        isolation: "OFFICIAL_TEST_ENV_OR_PURE_HISTORY_REPLAY",
        command: null,
      },
    },
  };

  it("records blocked contexts without treating them as satisfied", () => {
    const result = validateIntegrationMatrix(matrix);
    assert.equal(result.ok, true);
    assert.equal(result.requiredContextsSatisfied, false);
    assert.deepEqual(result.blocked, ["postgresql", "temporal"]);
  });

  it("rejects an enabled database context that is not disposable", () => {
    const result = validateIntegrationMatrix({
      ...matrix,
      contexts: {
        ...matrix.contexts,
        postgresql: {
          ...matrix.contexts.postgresql,
          status: "ENABLED",
          isolation: "SHARED_DATABASE",
          command: "pnpm verify:database",
        },
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /disposable database and role/);
  });

  it("rejects arbitrary commands even when isolation labels look valid", () => {
    const enabled = Object.fromEntries(
      Object.entries(matrix.contexts).map(([name, entry]) => [
        name,
        { ...entry, status: "ENABLED", command: "echo PASSED" },
      ]),
    );
    const result = validateIntegrationMatrix({ ...matrix, contexts: enabled });
    assert.equal(result.ok, false);
    assert.equal(result.requiredContextsSatisfied, false);
    assert.match(result.errors.join("\n"), /allowlisted integration runner/);
  });
});
