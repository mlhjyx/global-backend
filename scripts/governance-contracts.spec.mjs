import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import "./governance-ci-topology.spec.mjs";
import "./governance-document-drift.spec.mjs";
import "./environment-parity-policy.spec.mjs";
import "./governance-main-worktree-sync.spec.mjs";
import "./governance-codeql-action-pin.spec.mjs";
import "./governance-oasdiff-action-pin.spec.mjs";
import "./copy-fixed-source-impact.spec.mjs";
import "./supply-chain-gates.spec.mjs";
import "./runtime-deployment-contract.spec.mjs";
import "./ghcr-runtime-publication.spec.mjs";
import "./docker-image-config-path.spec.mjs";

import {
  renderProviderRegistry,
  renderReleaseBundle,
  parseSeedProviders,
  validateDecisionGateSeparation,
  validateMergeEvidence,
  validateProviderRegistry,
  validateReleaseBundle,
  validateRequiredContexts,
  validateRuntimeEvidence,
  validateTraceability,
} from "./governance-contracts.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const DIGEST = `sha256:${"e".repeat(64)}`;
const NOW = new Date("2026-08-07T12:00:00.000Z");

test("the discovery lineage successor is current-main based and the quarantined mega-branch is provenance only", () => {
  const plan = readFileSync(
    new URL(
      "../docs/superpowers/plans/2026-08-29-discovery-query-lineage-foundation.md",
      import.meta.url,
    ),
    "utf8",
  );
  const conflicts = readFileSync(
    new URL("../docs/governance/conflict-register.md", import.meta.url),
    "utf8",
  );
  const status = readFileSync(
    new URL("../docs/status/current.md", import.meta.url),
    "utf8",
  );
  const releasePlan = readFileSync(
    new URL("../docs/roadmap/release-plan.md", import.meta.url),
    "utf8",
  );
  const closeoutPlan = readFileSync(
    new URL(
      "../docs/superpowers/plans/2026-08-30-discovery-lineage-g0-closeout.md",
      import.meta.url,
    ),
    "utf8",
  );
  for (const required of [
    "c7e39e050b2f30ed9ff155aec139ff206fb850d0",
    "codex/discovery-query-materialization-successor",
    "NON_DEPLOYABLE / PROVENANCE_ONLY",
    "no-product-code boundary",
  ]) {
    assert.match(plan, new RegExp(required.replaceAll("/", "\\/")));
  }
  assert.match(plan, /DISCOVERY_GOVERNED_LINEAGE_NOT_READY/);
  for (const required of [
    "d2c93dd6bea0348381286558896b395c84945171",
    "codex/discovery-lineage-g0-closeout",
    "ZERO_PRODUCT_CODE",
    "DISCOVERY_GOVERNED_LINEAGE_NOT_READY",
    "stops after a locally reviewed commit",
  ]) {
    assert.match(closeoutPlan, new RegExp(required));
  }

  const expectedCard =
    "| `GPP-B-LINEAGE-001` | `ADMITTED / ZERO_PRODUCT_CODE / CURRENT_MAIN_READBACK_PASS` | `codex/discovery-query-materialization-successor` | initial base=`c7e39e050b2f30ed9ff155aec139ff206fb850d0`；PR #425 merge/readback=`d2c93dd6bea0348381286558896b395c84945171`；scope 仍仅为 Program B ACK identity、index-preserving Raw resolution 与 Provider-owned company lineage。旧 A mega-branch 继续 `NON_DEPLOYABLE / PROVENANCE_ONLY`；G0 ownership 已关闭，但本卡不授权 G2/G3 产品实现。 |";
  const assertUniqueDiscoveryLineageCard = (document) => {
    const rows = document
      .split("\n")
      .filter((line) => line.startsWith("| `GPP-B-LINEAGE-001` |"));
    assert.deepEqual(rows, [expectedCard]);
  };
  assertUniqueDiscoveryLineageCard(conflicts);
  assert.match(
    conflicts,
    /> 当前工程核验基线：`origin\/main@d2c93dd6bea0348381286558896b395c84945171`；Program A historical delta-audit base=`23d111f7b400403deb7466abf34ab709685b8376`/,
  );
  for (const mutation of [
    ["ZERO_PRODUCT_CODE", "PRODUCT_CODE"],
    ["codex/discovery-query-materialization-successor", "codex/other-writer"],
    ["c7e39e050b2f30ed9ff155aec139ff206fb850d0", "b".repeat(40)],
    [
      "scope 仍仅为 Program B ACK identity",
      "scope 扩大为 Program A ACK identity",
    ],
    ["CURRENT_MAIN_READBACK_PASS", "IMPLEMENTATION_AUTHORIZED"],
    ["d2c93dd6bea0348381286558896b395c84945171", "d".repeat(40)],
  ]) {
    assert.throws(() =>
      assertUniqueDiscoveryLineageCard(
        conflicts.replace(
          expectedCard,
          expectedCard.replace(mutation[0], mutation[1]),
        ),
      ),
    );
  }

  const expectedProgramBRow =
    "| B — Buyer Intelligence discovery | AMBER | Owns query receipt, raw source, Identity/Canonical, Provider/transport, discovery workflow and immutable `LeadQualifiedPackage`; does **not** own generic Grant/primitive, SaaS Opportunity or runtime deploy | `GPP-B-LINEAGE-001` 已通过 PR #425 merge/readback `d2c93dd6bea0348381286558896b395c84945171` 由 current main admit 给唯一 writer `codex/discovery-query-materialization-successor`，状态 `ADMITTED / ZERO_PRODUCT_CODE / CURRENT_MAIN_READBACK_PASS`。G0 ownership 已关闭；A 分支的 B-owned delta 仍非 accepted implementation，任何产品施工必须另过 G2/G3 计划与 review。 |";
  const expectedG0Row =
    "| G0 — Truth & Ownership | `PASS / OWNERSHIP_CLOSED` | PR #424 已固定 ADR-025/`DEC-GPP-001` 与 mega-branch disposition；PR #425 merge/readback `d2c93dd6bea0348381286558896b395c84945171` 已把唯一 `GPP-B-LINEAGE-001` card/writer 持久写入 current main。`CON-GPP-001=RESOLVED_WITH_REMEDIATION`、`BLK-GPP-001=RESOLVED`。此 PASS 只关闭 ownership/provenance；Program B implementation/TDD 仍属于 G2，DB/RLS/replay 与集成仍属于 G3，G1–G7 不由本门升级。 |";
  const normalizeTableRow = (line) =>
    line
      .split("|")
      .map((cell) => cell.trim())
      .join(" | ");
  const statusRowLabel = (prefix) => prefix.trimEnd().replace(/\s*\|$/, "");
  const assertUniqueStatusRow = (document, prefix, expected) => {
    const rows = document
      .split("\n")
      .filter((line) => line.startsWith(statusRowLabel(prefix)));
    assert.deepEqual(rows.map(normalizeTableRow), [
      normalizeTableRow(expected),
    ]);
  };
  const mutateStatusRow = (document, prefix, from, to) =>
    document
      .split("\n")
      .map((line) =>
        line.startsWith(statusRowLabel(prefix)) ? line.replace(from, to) : line,
      )
      .join("\n");
  assertUniqueStatusRow(
    status,
    "| B — Buyer Intelligence discovery |",
    expectedProgramBRow,
  );
  assertUniqueStatusRow(status, "| G0 — Truth & Ownership |", expectedG0Row);
  const expectedProgramARow =
    "| A — authority/runtime primitives | RED | Owns generic Execution Authority, GovernedSubject/Relation primitives, Site Quote/Grant, OCI/runtime and unified RuntimeEvidence/Release; does **not** own RawSourceRecord, IdentityLink, CanonicalCompany business schema, Provider or Opportunity | `OWNERSHIP_CLOSED_WITH_REMEDIATION`: writer inactivity、clean/no-`MERGE_HEAD` packet、post-`ed615d1b` delta classification 与 binding-ledger/provenance correction 已在 `91cae351795cceced59893bcf552c2b502a4ebaa` 完成。35 个 main ancestry commits 仍是 `KEEP_AS_MAIN_INTEGRATION_PROVENANCE`；`b57af498` 是 two-parent integration provenance；五个 B-owned deltas 仍不是 accepted A work；四个 Task 5.2 commits 继续 `QUARANTINED / HOLD_OWNERSHIP` 历史处置。PR #424 已将 mega-branch 固定为 `NON_DEPLOYABLE / PROVENANCE_ONLY`，PR #425 readback `d2c93dd6bea0348381286558896b395c84945171` 已接受唯一 B card/writer。A 的 ownership gate 已关闭，但其 source/runtime/Release 能力仍按 G2–G5 单独验证。 |";
  const expectedRootRow =
    "| `/global/backend` root `main` | `HEAD=origin/main=da2f7aebafe87de3a5286d13e9d77864464dff7e`; protected local现场仅保留未跟踪 `.playwright-cli/` | PR #441 merge 后由受控 fast-forward 脚本同步；没有 stash/reset/clean，未跟踪现场未被删除。该 status 只绑定 path/state entries，不证明未跟踪内容字节身份。 |";
  assertUniqueStatusRow(
    status,
    "| A — authority/runtime primitives |",
    expectedProgramARow,
  );
  assertUniqueStatusRow(
    status,
    "| `/global/backend` root `main` |",
    expectedRootRow,
  );
  for (const [expected, prefix, mutations] of [
    [
      expectedProgramBRow,
      "| B — Buyer Intelligence discovery |",
      [
        ["ZERO_PRODUCT_CODE", "PRODUCT_CODE"],
        ["CURRENT_MAIN_READBACK_PASS", "IMPLEMENTATION_AUTHORIZED"],
        [
          "codex/discovery-query-materialization-successor",
          "codex/other-writer",
        ],
      ],
    ],
    [
      expectedG0Row,
      "| G0 — Truth & Ownership |",
      [
        ["`PASS / OWNERSHIP_CLOSED`", "`PASS / IMPLEMENTATION_COMPLETE`"],
        ["RESOLVED_WITH_REMEDIATION", "HOLD_OWNERSHIP"],
        ["G1–G7 不由本门升级", "G1–G7 PASS"],
      ],
    ],
  ]) {
    for (const [from, to] of mutations) {
      assert.throws(() =>
        assertUniqueStatusRow(
          mutateStatusRow(status, prefix, from, to),
          prefix,
          expected,
        ),
      );
    }
  }
  for (const [expected, prefix, mutation] of [
    [
      expectedProgramARow,
      "| A — authority/runtime primitives |",
      ["OWNERSHIP_CLOSED_WITH_REMEDIATION", "HOLD_OWNERSHIP"],
    ],
    [
      expectedRootRow,
      "| `/global/backend` root `main` |",
      ["只绑定 path/state entries", "证明 ignored content bytes"],
    ],
  ]) {
    assert.throws(() =>
      assertUniqueStatusRow(
        mutateStatusRow(status, prefix, mutation[0], mutation[1]),
        prefix,
        expected,
      ),
    );
  }
  assert.match(status, /> 最后核验：2026-09-02T/);
  assert.match(
    status,
    /当前 Backend runtime source authority 为 `main@da2f7aebafe87de3a5286d13e9d77864464dff7e`/,
  );
  assert.match(
    status,
    /historical construction base 是 `23d111f7b400403deb7466abf34ab709685b8376`/,
  );
  const expectedConflictRow =
    "| `CON-GPP-001` | Program A Task 5.2 与 Program B 的 Raw/Identity/Canonical/Discovery ownership 重叠。 | `RESOLVED_WITH_REMEDIATION` | `OWN-PRODUCT` | PR #424 固定 owner/seam 与 mega-branch `NON_DEPLOYABLE / PROVENANCE_ONLY` disposition；PR #425 merge/readback `d2c93dd6bea0348381286558896b395c84945171` 将唯一 `GPP-B-LINEAGE-001` card/writer 写入 current main。ownership collision 已关闭；四个 Task 5.2 commits 与五个 B-owned deltas 继续按 ADR-025 分类，G2/G3 产品实现仍未接纳。 |";
  const expectedBlockerRow =
    "| `BLK-GPP-001` | Ownership/provenance collision 已由 PR #424 与 PR #425 current-main readback 关闭。 | `OWN-PRODUCT` | `RESOLVED` at `main@d2c93dd6bea0348381286558896b395c84945171`；若 Program A head/index/worktree/merge 移动、出现第二 writer/card、或隔离提交进入 successor/migration/deploy，则重新打开 G0。 | `RESOLVED`；不授权 Discovery 产品实现，后续仍受 G2/G3、费用、runtime 与发布门约束。 |";
  assertUniqueStatusRow(conflicts, "| `CON-GPP-001` |", expectedConflictRow);
  assertUniqueStatusRow(conflicts, "| `BLK-GPP-001` |", expectedBlockerRow);
  for (const [expected, prefix, mutation] of [
    [
      expectedConflictRow,
      "| `CON-GPP-001` |",
      ["RESOLVED_WITH_REMEDIATION", "HOLD_OWNERSHIP"],
    ],
    [
      expectedBlockerRow,
      "| `BLK-GPP-001` |",
      ["`RESOLVED`", "`HOLD_OWNERSHIP`"],
    ],
  ]) {
    assert.throws(() =>
      assertUniqueStatusRow(
        conflicts.replace(expected, expected.replace(mutation[0], mutation[1])),
        prefix,
        expected,
      ),
    );
  }
  const phase0Rows = releasePlan
    .split("\n")
    .filter((line) => line.startsWith("1. **Phase 0:**"));
  const expectedPhase0Row =
    "1. **Phase 0:** current truth、A/B interface、provenance 与 documentation 已完成；G0=`PASS / OWNERSHIP_CLOSED`，绑定 PR #424 与 PR #425 merge/readback `d2c93dd6bea0348381286558896b395c84945171`。这不升级 G1–G7；Program B source/TDD 从 G2 继续，DB/RLS/replay/integration 从 G3 继续。";
  assert.deepEqual(phase0Rows, [expectedPhase0Row]);
  const releaseG0Rows = releasePlan
    .split("\n")
    .filter((line) => line.startsWith("| G0 — Truth & Ownership |"));
  assert.deepEqual(releaseG0Rows, [
    "| G0 — Truth & Ownership | `PASS / OWNERSHIP_CLOSED` |",
  ]);
  const laterGateRows = status
    .split("\n")
    .filter((line) => /^\| G[1-7] —/.test(line))
    .map(normalizeTableRow)
    .join("\n");
  assert.equal(
    createHash("sha256").update(laterGateRows).digest("hex"),
    "a2d97a21d32732ae79ca46cd701aaaba1f7d781c0ef3d1d8bb8c7613808e22ea",
  );
});

function issueCodes(result) {
  return result.issues.map((issue) => issue.code);
}

function runtimeEvidence(overrides = {}) {
  return {
    schema_version: "runtime-evidence/v1",
    evidence_id: "runtime-api-development-20260807",
    commit: SHA_A,
    environment: "development",
    verified_at: "2026-08-07T01:00:00.000Z",
    valid_until: "2026-08-08T01:00:00.000Z",
    evidence_kind: "runtime_probe",
    result: "PASS",
    artifact_digest: DIGEST,
    ...overrides,
  };
}

function releaseEvidence(overrides = {}) {
  return runtimeEvidence({
    commit: SHA_D,
    environment: "pilot",
    verified_at: "2026-08-07T10:26:00.000Z",
    valid_until: "2026-08-08T10:26:00.000Z",
    ...overrides,
  });
}

function provider(overrides = {}) {
  return {
    key: "public_web",
    status: "IMPLEMENTED",
    source_classes: ["public_intelligence"],
    purpose: "Discover public company facts from bounded web search and crawl.",
    taxonomy: ["ICP industry and product terms"],
    license: {
      classification: "SOURCE_SPECIFIC",
      note: "Preserve source provenance and terms; no blanket content licence.",
    },
    personal_data_class: "RESTRICTED_POSSIBLE",
    default_enablement: "ENABLED",
    call_gates: ["source_policy", "egress_guard", "tool_broker"],
    test_paths: [
      "apps/api/src/discovery/providers/public-web.provider.spec.ts",
    ],
    evidence_refs: [
      {
        kind: "TEST_ANCHOR",
        path: "apps/api/src/discovery/providers/public-web.provider.spec.ts",
      },
    ],
    ...overrides,
  };
}

function providerRegistry(overrides = {}) {
  return {
    schema_version: "provider-registry/v1",
    generated_document: "docs/backend/provider-registry.md",
    providers: [provider()],
    ...overrides,
  };
}

function releaseBundle(overrides = {}) {
  return {
    schema_version: "release-bundle/v1",
    release_id: "buyer-pilot-20260807",
    release_status: "PILOT",
    environment: "pilot",
    release_owner: "OWN-BUYER-BE",
    implementation_commit: SHA_D,
    released_at: "2026-08-07T10:30:00.000Z",
    capability_ids: ["CAP-BUYER-001"],
    external_provenance: {
      status: "EXTERNAL_UNVERIFIED",
      verifier: "NONE",
      verification_ref: "NONE",
    },
    traceability_bindings: [
      {
        chain_id: "buyer-discovery-pilot",
        capability_id: "CAP-BUYER-001",
        evidence_ids: ["runtime-api-development-20260807"],
      },
    ],
    scope: {
      included: ["bounded buyer discovery"],
      excluded: ["campaigns and outreach"],
    },
    promise: {
      user_outcome: "A reviewer can inspect explainable buyer candidates.",
      non_guarantees: ["No automated outreach."],
    },
    source: {
      repository: "mlhjyx/global-backend",
      base_commit: SHA_A,
      source_head: SHA_B,
    },
    evidence_ids: ["runtime-api-development-20260807"],
    operations: {
      runbook: "docs/backend/runbook.md",
      observability: "runtime evidence is digest-bound",
    },
    data: {
      classification: "company facts plus restricted contact data",
      retention: "source-specific",
    },
    rollback_and_exit: {
      trigger: "quality or policy gate fails",
      procedure: "disable the pilot route and preserve receipts",
    },
    guides: ["docs/README.md"],
    approval: {
      machine: {
        status: "PASS",
        provenance: "CHECK_RUN",
        evidence_ref: "https://github.example/checks/1",
        verified_at: "2026-08-07T10:00:00.000Z",
      },
      reviewer: {
        status: "APPROVED",
        provenance: "GITHUB_REVIEW",
        evidence_ref: "https://github.example/reviews/2",
        actor: "independent-reviewer",
        reviewed_at: "2026-08-07T10:10:00.000Z",
      },
      user_authorization: {
        status: "AUTHORIZED",
        provenance: "SIGNED_AUTHORIZATION",
        evidence_ref: "https://github.example/authorizations/3",
        actor: "product-owner",
        authorized_at: "2026-08-07T10:20:00.000Z",
      },
    },
    merge_evidence: {
      method: "MERGE_COMMIT",
      base_commit: SHA_A,
      source_head: SHA_B,
      result_commit: SHA_D,
      parent_commits: [SHA_A, SHA_B],
      merged_at: "2026-08-07T10:25:00.000Z",
    },
    learning: {
      owner: "OWN-BUYER-BE",
      review_at: "2026-08-14T10:30:00.000Z",
      success_measure: "reviewer acceptance and zero policy bypasses",
    },
    ...overrides,
  };
}

function traceability(overrides = {}) {
  return {
    schema_version: "delivery-traceability/v1",
    chains: [
      {
        chain_id: "buyer-discovery-pilot",
        capability_id: "CAP-BUYER-001",
        object_ids: ["OBJ-FE-009", "OBJ-FE-010"],
        operation_ids: ["DiscoveryController_execute_v1"],
        code_paths: ["apps/api/src/discovery/discovery.controller.ts"],
        test_paths: ["apps/api/src/discovery/discovery.service.spec.ts"],
        scenario_ids: ["SCN-FE-BUYER-001"],
        delivery_state: "PILOT",
        evidence_ids: ["runtime-api-development-20260807"],
        required_evidence_kinds: ["runtime_probe"],
      },
    ],
    ...overrides,
  };
}

function releaseValidationContext(overrides = {}) {
  const chain = traceability().chains[0];
  return {
    evidence_by_id: new Map([
      ["runtime-api-development-20260807", releaseEvidence()],
    ]),
    traceability_by_id: new Map([[chain.chain_id, chain]]),
    now: NOW,
    ...overrides,
  };
}

function traceabilityContext(overrides = {}) {
  return {
    capability_ids: new Set(["CAP-BUYER-001"]),
    object_ids: new Set(["OBJ-FE-009", "OBJ-FE-010"]),
    operation_ids: new Set(["DiscoveryController_execute_v1"]),
    scenario_ids: new Set(["SCN-FE-BUYER-001"]),
    existing_paths: new Set([
      "apps/api/src/discovery/discovery.controller.ts",
      "apps/api/src/discovery/discovery.service.spec.ts",
    ]),
    evidence_by_id: new Map([
      ["runtime-api-development-20260807", runtimeEvidence()],
    ]),
    release_bundles_by_capability: new Map([
      ["CAP-BUYER-001", [releaseBundle()]],
    ]),
    now: NOW,
    ...overrides,
  };
}

test("runtime evidence is current only inside its explicit validity window", () => {
  const current = validateRuntimeEvidence(runtimeEvidence(), { now: NOW });
  assert.deepEqual(current.issues, []);
  assert.equal(current.classification, "CURRENT");

  const expired = validateRuntimeEvidence(runtimeEvidence(), {
    now: new Date("2026-08-08T01:00:00.000Z"),
  });
  assert.deepEqual(expired.issues, []);
  assert.equal(expired.classification, "HISTORICAL");
  assert.equal(expired.eligible_for_promotion, false);
});

test("runtime evidence rejects missing identity and non-SHA-256 artifacts", () => {
  const result = validateRuntimeEvidence(
    runtimeEvidence({ commit: undefined, artifact_digest: "latest" }),
    { now: NOW },
  );
  assert.deepEqual(
    new Set(issueCodes(result)),
    new Set(["EVIDENCE_COMMIT_INVALID", "EVIDENCE_DIGEST_INVALID"]),
  );
});

test("runtime evidence rejects artifact paths outside the repository", () => {
  for (const artifactPath of [
    "/etc/passwd",
    "../outside.json",
    "docs/evidence/../../outside.json",
  ]) {
    const result = validateRuntimeEvidence(
      runtimeEvidence({ artifact_path: artifactPath }),
      { now: NOW },
    );
    assert.ok(
      issueCodes(result).includes("EVIDENCE_ARTIFACT_PATH_INVALID"),
      artifactPath,
    );
    assert.equal(result.classification, "INVALID");
  }
});

test("runtime evidence cannot self-authorize an unbounded freshness window", () => {
  const result = validateRuntimeEvidence(
    runtimeEvidence({ valid_until: "2026-08-08T01:00:00.001Z" }),
    { now: NOW },
  );
  assert.ok(issueCodes(result).includes("EVIDENCE_WINDOW_TOO_LONG"));
  assert.equal(result.eligible_for_promotion, false);
});

test("provider registry is bound to code-seeded key, SourceClass, and enablement", () => {
  const context = {
    seed_providers: [
      {
        key: "public_web",
        source_class: "public_intelligence",
        default_enablement: "ENABLED",
      },
    ],
    source_class_manifest: {
      public_web: ["public_intelligence"],
    },
    existing_paths: new Set([
      "apps/api/src/discovery/providers/public-web.provider.spec.ts",
    ]),
  };
  assert.deepEqual(
    validateProviderRegistry(providerRegistry(), context).issues,
    [],
  );

  const mutant = providerRegistry({
    providers: [provider({ source_classes: ["company_registry"] })],
  });
  assert.ok(
    issueCodes(validateProviderRegistry(mutant, context)).includes(
      "PROVIDER_SOURCE_CLASS_DRIFT",
    ),
  );
  const extraClassMutant = providerRegistry({
    providers: [
      provider({
        source_classes: ["public_intelligence", "bogus_unrouted_class"],
      }),
    ],
  });
  assert.ok(
    issueCodes(validateProviderRegistry(extraClassMutant, context)).includes(
      "PROVIDER_SOURCE_CLASS_DRIFT",
    ),
  );
  const missingClassMutant = providerRegistry({
    providers: [provider({ source_classes: ["public_intelligence"] })],
  });
  assert.ok(
    issueCodes(
      validateProviderRegistry(missingClassMutant, {
        ...context,
        source_class_manifest: {
          public_web: ["public_intelligence", "industry_data"],
        },
      }),
    ).includes("PROVIDER_SOURCE_CLASS_DRIFT"),
  );
  const disabledMutant = providerRegistry({
    providers: [provider({ default_enablement: "DISABLED" })],
  });
  assert.ok(
    issueCodes(validateProviderRegistry(disabledMutant, context)).includes(
      "PROVIDER_ENABLEMENT_DRIFT",
    ),
  );
  const missingEvidenceMutant = providerRegistry({
    providers: [
      provider({
        evidence_refs: [
          { kind: "TEST_ANCHOR", path: "apps/api/src/missing.spec.ts" },
        ],
      }),
    ],
  });
  assert.ok(
    issueCodes(
      validateProviderRegistry(missingEvidenceMutant, context),
    ).includes("PROVIDER_EVIDENCE_MISSING"),
  );
});

test("provider seed parsing tolerates formatting but fails closed when no seed can be read", () => {
  const source = `
    create: {
      status: "ENABLED",
      costPerCallCents: 0,
      class: "industry_data",
      key: "directory"
    }
  `;
  assert.deepEqual(parseSeedProviders(source), [
    {
      key: "directory",
      source_class: "industry_data",
      default_enablement: "ENABLED",
    },
  ]);
  const validation = validateProviderRegistry(providerRegistry(), {
    seed_providers: [],
    source_class_manifest: {
      public_web: ["public_intelligence"],
    },
    existing_paths: new Set([
      "apps/api/src/discovery/providers/public-web.provider.spec.ts",
    ]),
  });
  assert.ok(issueCodes(validation).includes("PROVIDER_SEED_PARSE_EMPTY"));
});

test("provider human documentation is deterministic and exposes every governance field", () => {
  const rendered = renderProviderRegistry(providerRegistry());
  assert.match(rendered, /# Provider Registry/);
  assert.match(rendered, /public_web/);
  assert.match(rendered, /public_intelligence/);
  assert.match(rendered, /Personal data class/);
  assert.match(rendered, /Call gates/);
  assert.equal(rendered, renderProviderRegistry(providerRegistry()));
});

test("traceability requires every registry, contract, code, test, scenario, evidence, and bundle link", () => {
  assert.deepEqual(
    validateTraceability(traceability(), traceabilityContext()).issues,
    [],
  );

  const chain = traceability().chains[0];
  const mutants = [
    [
      { ...chain, capability_id: "CAP-MISSING-001" },
      "TRACE_CAPABILITY_MISSING",
    ],
    [{ ...chain, object_ids: ["OBJ-FE-999"] }, "TRACE_OBJECT_MISSING"],
    [
      { ...chain, operation_ids: ["Missing_operation"] },
      "TRACE_OPERATION_MISSING",
    ],
    [
      { ...chain, code_paths: ["apps/api/src/missing.ts"] },
      "TRACE_CODE_MISSING",
    ],
    [
      { ...chain, test_paths: ["apps/api/src/missing.spec.ts"] },
      "TRACE_TEST_MISSING",
    ],
    [
      { ...chain, scenario_ids: ["SCN-FE-MISSING-001"] },
      "TRACE_SCENARIO_MISSING",
    ],
  ];
  for (const [mutant, expected] of mutants) {
    const result = validateTraceability(
      { ...traceability(), chains: [mutant] },
      traceabilityContext(),
    );
    assert.ok(issueCodes(result).includes(expected), expected);
  }
});

test("pilot traceability fails closed on expired evidence or an absent Release Bundle", () => {
  const staleEvidence = runtimeEvidence({
    valid_until: "2026-08-07T11:59:59.000Z",
  });
  const stale = validateTraceability(
    traceability(),
    traceabilityContext({
      evidence_by_id: new Map([[staleEvidence.evidence_id, staleEvidence]]),
    }),
  );
  assert.ok(issueCodes(stale).includes("TRACE_FRESH_EVIDENCE_REQUIRED"));

  const noBundle = validateTraceability(
    traceability(),
    traceabilityContext({ release_bundles_by_capability: new Map() }),
  );
  assert.ok(issueCodes(noBundle).includes("TRACE_RELEASE_BUNDLE_REQUIRED"));
});

test("pilot traceability binds the required evidence kind and exact Release Bundle chain", () => {
  const wrongKind = runtimeEvidence({ evidence_kind: "generic_smoke" });
  const wrongKindResult = validateTraceability(
    traceability(),
    traceabilityContext({
      evidence_by_id: new Map([[wrongKind.evidence_id, wrongKind]]),
    }),
  );
  assert.ok(
    issueCodes(wrongKindResult).includes("TRACE_EVIDENCE_KIND_UNEXPECTED"),
  );
  assert.ok(
    issueCodes(wrongKindResult).includes("TRACE_FRESH_EVIDENCE_REQUIRED"),
  );

  const wrongBinding = releaseBundle({
    traceability_bindings: [
      {
        chain_id: "another-chain",
        capability_id: "CAP-BUYER-001",
        evidence_ids: ["runtime-api-development-20260807"],
      },
    ],
  });
  const wrongBindingResult = validateTraceability(
    traceability(),
    traceabilityContext({
      release_bundles_by_capability: new Map([
        ["CAP-BUYER-001", [wrongBinding]],
      ]),
    }),
  );
  assert.ok(
    issueCodes(wrongBindingResult).includes("TRACE_RELEASE_BUNDLE_REQUIRED"),
  );

  const wrongEvidence = releaseBundle({
    traceability_bindings: [
      {
        chain_id: "buyer-discovery-pilot",
        capability_id: "CAP-BUYER-001",
        evidence_ids: ["other-evidence"],
      },
    ],
  });
  const wrongEvidenceResult = validateTraceability(
    traceability(),
    traceabilityContext({
      release_bundles_by_capability: new Map([
        ["CAP-BUYER-001", [wrongEvidence]],
      ]),
    }),
  );
  assert.ok(
    issueCodes(wrongEvidenceResult).includes("TRACE_RELEASE_BUNDLE_REQUIRED"),
  );
});

test("internal-only traceability preserves missing runtime proof without pretending pilot readiness", () => {
  const internal = {
    ...traceability(),
    chains: [
      {
        ...traceability().chains[0],
        delivery_state: "INTERNAL_ONLY",
        evidence_ids: [],
      },
    ],
  };
  assert.deepEqual(
    validateTraceability(
      internal,
      traceabilityContext({ release_bundles_by_capability: new Map() }),
    ).issues,
    [],
  );
});

test("Release Bundle keeps decision lanes separate but documentary until external readback", () => {
  const context = releaseValidationContext();
  assert.deepEqual(
    issueCodes(validateReleaseBundle(releaseBundle(), context)),
    ["RELEASE_EXTERNAL_PROVENANCE_UNVERIFIED"],
  );
  assert.deepEqual(
    validateDecisionGateSeparation(releaseBundle().approval).issues,
    [],
  );

  const flattened = {
    ...releaseBundle().approval,
    user_authorization: {
      ...releaseBundle().approval.user_authorization,
      provenance: "PR_BODY_DECLARATION",
    },
  };
  assert.ok(
    issueCodes(validateDecisionGateSeparation(flattened)).includes(
      "AUTHORIZATION_PROVENANCE_UNTRUSTED",
    ),
  );
});

test("forged external URLs and VERIFIED strings cannot promote a Release Bundle", () => {
  const forged = releaseBundle({
    external_provenance: {
      status: "VERIFIED",
      verifier: "INDEPENDENT_EXTERNAL_READBACK",
      verification_ref: "https://attacker.invalid/readback",
    },
    approval: {
      machine: {
        ...releaseBundle().approval.machine,
        evidence_ref: "https://attacker.invalid/check",
      },
      reviewer: {
        ...releaseBundle().approval.reviewer,
        evidence_ref: "https://attacker.invalid/review",
      },
      user_authorization: {
        ...releaseBundle().approval.user_authorization,
        evidence_ref: "https://attacker.invalid/authorization",
      },
    },
  });
  const result = validateReleaseBundle(forged, releaseValidationContext());
  assert.ok(
    issueCodes(result).includes("RELEASE_EXTERNAL_PROVENANCE_UNVERIFIED"),
  );
  assert.ok(
    issueCodes(result).includes("RELEASE_EXTERNAL_PROVENANCE_UNSUPPORTED"),
  );
});

test("Release Bundle rejects one artifact reused as all three decision gates", () => {
  const approval = structuredClone(releaseBundle().approval);
  approval.reviewer.evidence_ref = approval.machine.evidence_ref;
  approval.user_authorization.evidence_ref = approval.machine.evidence_ref;
  const result = validateDecisionGateSeparation(approval);
  assert.ok(issueCodes(result).includes("DECISION_GATE_EVIDENCE_CONFLATED"));
});

test("merge-method evidence proves the result shape instead of naming a method only", () => {
  assert.deepEqual(
    validateMergeEvidence(releaseBundle().merge_evidence).issues,
    [],
  );

  const mutant = {
    ...releaseBundle().merge_evidence,
    parent_commits: [SHA_A],
  };
  assert.ok(
    issueCodes(validateMergeEvidence(mutant)).includes(
      "MERGE_COMMIT_PARENTS_INVALID",
    ),
  );
});

test("Release Bundle rendering is deterministic and includes every review section", () => {
  const rendered = renderReleaseBundle(releaseBundle());
  for (const heading of [
    "Identity",
    "Scope",
    "Promise",
    "Source",
    "Evidence",
    "External provenance",
    "Operations",
    "Data",
    "Rollback and exit",
    "Guides",
    "Approval",
    "Learning",
  ]) {
    assert.match(rendered, new RegExp(`## ${heading}`));
  }
  assert.equal(rendered, renderReleaseBundle(releaseBundle()));
});

test("a copied Release Bundle template cannot be accepted as a real bundle", () => {
  const mutant = releaseBundle({ release_id: "REPLACE_WITH_RELEASE_ID" });
  const result = validateReleaseBundle(mutant, releaseValidationContext());
  assert.ok(issueCodes(result).includes("RELEASE_PLACEHOLDER_PRESENT"));
});

test("Release Bundle binds every capability to a traceability chain and the same evidence set", () => {
  const context = releaseValidationContext();
  const missingChain = releaseBundle({ traceability_bindings: [] });
  assert.ok(
    issueCodes(validateReleaseBundle(missingChain, context)).includes(
      "RELEASE_TRACEABILITY_REQUIRED",
    ),
  );

  const unboundEvidence = releaseBundle({
    traceability_bindings: [
      {
        chain_id: "buyer-discovery-pilot",
        capability_id: "CAP-BUYER-001",
        evidence_ids: ["different-evidence"],
      },
    ],
  });
  assert.ok(
    issueCodes(validateReleaseBundle(unboundEvidence, context)).includes(
      "RELEASE_TRACEABILITY_EVIDENCE_UNBOUND",
    ),
  );

  const missingRegistryChain = releaseBundle({
    traceability_bindings: [
      {
        chain_id: "not-in-traceability-registry",
        capability_id: "CAP-BUYER-001",
        evidence_ids: ["runtime-api-development-20260807"],
      },
    ],
  });
  assert.ok(
    issueCodes(validateReleaseBundle(missingRegistryChain, context)).includes(
      "RELEASE_TRACEABILITY_CHAIN_MISSING",
    ),
  );
});

test("required-context policy fails when a repository workflow drops a named context", () => {
  const setupNodeRevision = "820762786026740c76f36085b0efc47a31fe5020";
  const codeowners = [
    "# ordinary ownership",
    "/apps/api/src/auth/ @mlhjyx",
    "# terminal governance ownership block",
    "/.github/ @mlhjyx",
    "/.gitleaks.toml @mlhjyx",
    "/.gitleaksignore @mlhjyx",
    "/docs/governance/ @mlhjyx",
    "/package.json @mlhjyx",
    "/scripts/governance-*.mjs @mlhjyx",
  ].join("\n");
  const policy = {
    schema_version: "required-contexts/v1",
    required_contexts: [
      "build · typecheck · test",
      "governance · traceability · release",
    ],
    context_implementations: [
      {
        name: "build · typecheck · test",
        workflow: ".github/workflows/ci.yml",
        event: "pull_request",
      },
      {
        name: "governance · traceability · release",
        workflow: ".github/workflows/governance.yml",
        event: "pull_request",
      },
    ],
    workflow_runtime_requirements: [
      { workflow: ".github/workflows/governance.yml", node_major: 22 },
    ],
    workflow_action_pins: [
      {
        workflow: ".github/workflows/governance.yml",
        action: "actions/setup-node",
        revision: setupNodeRevision,
        version: "v7",
      },
    ],
    codeowner_requirements: {
      owner: "@mlhjyx",
      terminal_patterns: [
        "/.github/",
        "/.gitleaks.toml",
        "/.gitleaksignore",
        "/docs/governance/",
        "/package.json",
        "/scripts/governance-*.mjs",
      ],
    },
    external_ruleset_requirements: {
      required_approving_reviews: 1,
      require_code_owner_review: true,
      dismiss_stale_reviews: true,
      require_conversation_resolution: true,
      allow_force_push: false,
      allow_deletion: false,
      user_authorization: "separate signed authorization",
      merge_evidence: "record the actual merge method",
    },
  };
  const workflows = new Map([
    [
      ".github/workflows/ci.yml",
      "on:\n  pull_request:\njobs:\n  build:\n    name: build · typecheck · test\n",
    ],
    [
      ".github/workflows/governance.yml",
      `on:\n  pull_request:\njobs:\n  governance:\n    name: governance · traceability · release\n    steps:\n      - uses: actions/setup-node@${setupNodeRevision} # v7\n        with:\n          node-version: 22\n`,
    ],
  ]);
  const repositoryContext = { codeowners };
  assert.deepEqual(
    validateRequiredContexts(policy, workflows, repositoryContext).issues,
    [],
  );

  for (const condition of [
    "false",
    "contains(github.event.pull_request.labels.*.name, 'run-ci')",
  ]) {
    const conditional = new Map(workflows);
    conditional.set(
      ".github/workflows/ci.yml",
      `on:\n  pull_request:\njobs:\n  build:\n    if: ${condition}\n    name: build · typecheck · test\n`,
    );
    assert.ok(
      issueCodes(
        validateRequiredContexts(policy, conditional, repositoryContext),
      ).includes("REQUIRED_CONTEXT_JOB_CONDITIONAL"),
      condition,
    );
  }

  const approvedCondition =
    "github.event.pull_request.base.ref == github.event.repository.default_branch";
  const conditionPolicy = {
    ...policy,
    context_implementations: policy.context_implementations.map((item) =>
      item.name === "build · typecheck · test"
        ? { ...item, allowed_job_if: approvedCondition }
        : item,
    ),
  };
  const approvedConditional = new Map(workflows);
  approvedConditional.set(
    ".github/workflows/ci.yml",
    `on:\n  pull_request:\njobs:\n  build:\n    if: ${approvedCondition}\n    name: build · typecheck · test\n`,
  );
  const approvedConditionalCodes = issueCodes(
    validateRequiredContexts(
      conditionPolicy,
      approvedConditional,
      repositoryContext,
    ),
  );
  assert.ok(
    !approvedConditionalCodes.includes("REQUIRED_CONTEXT_JOB_CONDITIONAL"),
  );
  assert.ok(
    !approvedConditionalCodes.includes("REQUIRED_CONTEXT_JOB_CONDITION_DRIFT"),
  );
  approvedConditional.set(
    ".github/workflows/ci.yml",
    "on:\n  pull_request:\njobs:\n  build:\n    if: false\n    name: build · typecheck · test\n",
  );
  const driftedConditionalCodes = issueCodes(
    validateRequiredContexts(
      conditionPolicy,
      approvedConditional,
      repositoryContext,
    ),
  );
  assert.ok(
    driftedConditionalCodes.includes("REQUIRED_CONTEXT_JOB_CONDITIONAL"),
  );
  assert.ok(
    driftedConditionalCodes.includes("REQUIRED_CONTEXT_JOB_CONDITION_DRIFT"),
  );

  const conditionalDependency = new Map(workflows);
  conditionalDependency.set(
    ".github/workflows/ci.yml",
    "on:\n  pull_request:\njobs:\n  optional:\n    if: false\n    name: optional\n  build:\n    needs: optional\n    name: build · typecheck · test\n",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(
        policy,
        conditionalDependency,
        repositoryContext,
      ),
    ).includes("REQUIRED_CONTEXT_NEEDS_UNPROTECTED"),
  );

  const continueOnError = new Map(workflows);
  continueOnError.set(
    ".github/workflows/ci.yml",
    "on:\n  pull_request:\njobs:\n  build:\n    name: build · typecheck · test\n    continue-on-error: true\n",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, continueOnError, repositoryContext),
    ).includes("REQUIRED_CONTEXT_CONTINUE_ON_ERROR"),
  );

  const duplicateContext = new Map(workflows);
  duplicateContext.set(
    ".github/workflows/ci.yml",
    "on:\n  pull_request:\njobs:\n  build-a:\n    name: build · typecheck · test\n  build-b:\n    name: build · typecheck · test\n",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, duplicateContext, repositoryContext),
    ).includes("REQUIRED_CONTEXT_JOB_AMBIGUOUS"),
  );

  workflows.delete(".github/workflows/governance.yml");
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, workflows, repositoryContext),
    ).includes("REQUIRED_CONTEXT_NOT_IMPLEMENTED"),
  );

  const stepOnly = new Map([
    [
      ".github/workflows/ci.yml",
      "on:\n  pull_request:\njobs:\n  build:\n    name: build · typecheck · test\n    steps:\n      - name: governance · traceability · release\n",
    ],
  ]);
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, stepOnly, repositoryContext),
    ).includes("REQUIRED_CONTEXT_NOT_IMPLEMENTED"),
  );

  const noPullRequest = new Map(workflows);
  noPullRequest.set(
    ".github/workflows/governance.yml",
    "on:\n  workflow_dispatch:\njobs:\n  governance:\n    name: governance · traceability · release\n",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, noPullRequest, repositoryContext),
    ).includes("REQUIRED_CONTEXT_EVENT_MISSING"),
  );

  const unsafeRuleset = {
    ...policy,
    external_ruleset_requirements: {
      ...policy.external_ruleset_requirements,
      allow_force_push: true,
    },
  };
  assert.ok(
    issueCodes(
      validateRequiredContexts(unsafeRuleset, noPullRequest, repositoryContext),
    ).includes("EXTERNAL_RULESET_REQUIREMENTS_UNSAFE"),
  );

  const unpinnedNode = new Map(workflows);
  unpinnedNode.set(
    ".github/workflows/governance.yml",
    "on:\n  pull_request:\njobs:\n  governance:\n    name: governance · traceability · release\n",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, unpinnedNode, repositoryContext),
    ).includes("WORKFLOW_NODE_RUNTIME_UNPINNED"),
  );

  const ownershipDeleted = codeowners.replace(
    "/scripts/governance-*.mjs @mlhjyx",
    "",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, workflows, {
        codeowners: ownershipDeleted,
      }),
    ).includes("CODEOWNER_PROTECTION_MISSING"),
  );

  for (const scannerConfig of ["/.gitleaks.toml", "/.gitleaksignore"]) {
    const unprotectedScannerConfig = codeowners.replace(
      `${scannerConfig} @mlhjyx`,
      "",
    );
    assert.ok(
      issueCodes(
        validateRequiredContexts(policy, workflows, {
          codeowners: unprotectedScannerConfig,
        }),
      ).includes("CODEOWNER_PROTECTION_MISSING"),
      scannerConfig,
    );
  }

  const movingTag = new Map(workflows);
  movingTag.set(
    ".github/workflows/governance.yml",
    "on:\n  pull_request:\njobs:\n  governance:\n    name: governance · traceability · release\n    steps:\n      - uses: actions/setup-node@v7\n        with:\n          node-version: 22\n",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, movingTag, repositoryContext),
    ).includes("WORKFLOW_ACTION_UNPINNED"),
  );

  const unlistedWorkflow = new Map(workflows);
  unlistedWorkflow.set(
    ".github/workflows/unlisted.yml",
    "on:\n  pull_request:\njobs:\n  audit:\n    name: unlisted audit\n    steps:\n      - uses: actions/checkout@v7\n",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, unlistedWorkflow, repositoryContext),
    ).includes("WORKFLOW_ACTION_UNPINNED"),
  );

  const missingRevision = new Map(workflows);
  missingRevision.set(
    ".github/workflows/governance.yml",
    "on:\n  pull_request:\njobs:\n  governance:\n    name: governance · traceability · release\n    steps:\n      - uses: actions/setup-node\n        with:\n          node-version: 22\n",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, missingRevision, repositoryContext),
    ).includes("WORKFLOW_ACTION_UNPINNED"),
  );
});

test("pilot Release Bundle rejects expired evidence even when every approval says PASS", () => {
  const staleEvidence = releaseEvidence({
    valid_until: "2026-08-07T11:59:59.000Z",
  });
  const result = validateReleaseBundle(
    releaseBundle(),
    releaseValidationContext({
      evidence_by_id: new Map([[staleEvidence.evidence_id, staleEvidence]]),
    }),
  );
  assert.ok(issueCodes(result).includes("RELEASE_FRESH_EVIDENCE_REQUIRED"));
});

test("pilot evidence must bind the exact implementation commit and environment", () => {
  const wrongCommit = runtimeEvidence({ environment: "pilot" });
  const wrongCommitResult = validateReleaseBundle(
    releaseBundle(),
    releaseValidationContext({
      evidence_by_id: new Map([[wrongCommit.evidence_id, wrongCommit]]),
    }),
  );
  assert.ok(
    issueCodes(wrongCommitResult).includes(
      "RELEASE_EVIDENCE_IDENTITY_MISMATCH",
    ),
  );

  const wrongEnvironment = runtimeEvidence({ commit: SHA_D });
  const wrongEnvironmentResult = validateReleaseBundle(
    releaseBundle(),
    releaseValidationContext({
      evidence_by_id: new Map([
        [wrongEnvironment.evidence_id, wrongEnvironment],
      ]),
    }),
  );
  assert.ok(
    issueCodes(wrongEnvironmentResult).includes(
      "RELEASE_EVIDENCE_IDENTITY_MISMATCH",
    ),
  );
});

test("Release Bundle implementation and source identity must match merge evidence", () => {
  const mutant = releaseBundle({ implementation_commit: SHA_C });
  const validation = validateReleaseBundle(
    mutant,
    releaseValidationContext({
      evidence_by_id: new Map([
        [
          "runtime-api-development-20260807",
          releaseEvidence({ commit: SHA_C }),
        ],
      ]),
    }),
  );
  assert.ok(
    issueCodes(validation).includes("RELEASE_IMPLEMENTATION_MERGE_MISMATCH"),
  );
});
