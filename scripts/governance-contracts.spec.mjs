import assert from "node:assert/strict";
import test from "node:test";

import {
  renderProviderRegistry,
  renderReleaseBundle,
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
    test_paths: ["apps/api/src/discovery/providers/public-web.provider.spec.ts"],
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
      },
    ],
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
    release_bundle_capability_ids: new Set(["CAP-BUYER-001"]),
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

test("provider registry is bound to code-seeded key, SourceClass, and enablement", () => {
  const context = {
    seed_providers: [
      {
        key: "public_web",
        source_class: "public_intelligence",
        default_enablement: "ENABLED",
      },
    ],
    existing_paths: new Set([
      "apps/api/src/discovery/providers/public-web.provider.spec.ts",
    ]),
  };
  assert.deepEqual(validateProviderRegistry(providerRegistry(), context).issues, []);

  const mutant = providerRegistry({
    providers: [provider({ source_classes: ["company_registry"] })],
  });
  assert.ok(
    issueCodes(validateProviderRegistry(mutant, context)).includes(
      "PROVIDER_SOURCE_CLASS_DRIFT",
    ),
  );
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
      { ...chain, operation_ids: ["Missing_operation"] },
      "TRACE_OPERATION_MISSING",
    ],
    [{ ...chain, code_paths: ["apps/api/src/missing.ts"] }, "TRACE_CODE_MISSING"],
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
    traceabilityContext({ release_bundle_capability_ids: new Set() }),
  );
  assert.ok(issueCodes(noBundle).includes("TRACE_RELEASE_BUNDLE_REQUIRED"));
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
      traceabilityContext({ release_bundle_capability_ids: new Set() }),
    ).issues,
    [],
  );
});

test("Release Bundle keeps machine, reviewer, and user authorization evidence separate", () => {
  const context = {
    evidence_by_id: new Map([
      ["runtime-api-development-20260807", runtimeEvidence()],
    ]),
    now: NOW,
  };
  assert.deepEqual(validateReleaseBundle(releaseBundle(), context).issues, []);
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

test("Release Bundle rejects one artifact reused as all three decision gates", () => {
  const approval = structuredClone(releaseBundle().approval);
  approval.reviewer.evidence_ref = approval.machine.evidence_ref;
  approval.user_authorization.evidence_ref = approval.machine.evidence_ref;
  const result = validateDecisionGateSeparation(approval);
  assert.ok(issueCodes(result).includes("DECISION_GATE_EVIDENCE_CONFLATED"));
});

test("merge-method evidence proves the result shape instead of naming a method only", () => {
  assert.deepEqual(validateMergeEvidence(releaseBundle().merge_evidence).issues, []);

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

test("required-context policy fails when a repository workflow drops a named context", () => {
  const policy = {
    schema_version: "required-contexts/v1",
    required_contexts: [
      "build · typecheck · test",
      "governance · traceability · release",
    ],
  };
  const workflows = new Map([
    [
      ".github/workflows/ci.yml",
      "jobs:\n  build:\n    name: build · typecheck · test\n",
    ],
    [
      ".github/workflows/governance.yml",
      "jobs:\n  governance:\n    name: governance · traceability · release\n",
    ],
  ]);
  assert.deepEqual(validateRequiredContexts(policy, workflows).issues, []);

  workflows.delete(".github/workflows/governance.yml");
  assert.ok(
    issueCodes(validateRequiredContexts(policy, workflows)).includes(
      "REQUIRED_CONTEXT_NOT_IMPLEMENTED",
    ),
  );
});

test("pilot Release Bundle rejects expired evidence even when every approval says PASS", () => {
  const staleEvidence = runtimeEvidence({
    valid_until: "2026-08-07T11:59:59.000Z",
  });
  const result = validateReleaseBundle(releaseBundle(), {
    evidence_by_id: new Map([[staleEvidence.evidence_id, staleEvidence]]),
    now: NOW,
  });
  assert.ok(issueCodes(result).includes("RELEASE_FRESH_EVIDENCE_REQUIRED"));
});

