import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateReleaseBundle } from "./governance-delivery-contracts.mjs";
import {
  buildReleaseAuthorization,
  evidenceSetDigest,
  releaseBundleDigest,
  sha256Hex,
  validateReleaseAuthorization,
} from "./release-authorization.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_D = "d".repeat(40);
const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = new Date("2026-08-07T12:00:00.000Z");
const AUTHORIZED_AT = "2026-08-07T11:00:00.000Z";
const VALID_UNTIL = "2026-08-14T00:00:00.000Z";
const EVIDENCE_ID = "runtime-api-development-20260807";
const REVIEW_REF = "docs/releases/authorizations/buyer-pilot-20260807.review.md";
const REQUIRED_CONTEXTS = [
  "renderer visual scope",
  "build · typecheck · test",
  "contracts · drift · lint · breaking",
  "gitleaks 密钥扫描",
  "governance · traceability · release",
];

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeKey(directory, name) {
  const keyPath = join(directory, name);
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", keyPath]);
  return {
    privateKey: keyPath,
    publicKey: readFileSync(`${keyPath}.pub`, "utf8").trim(),
  };
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "release-authorization-repo-"));
  mkdirSync(join(root, ".github"), { recursive: true });
  mkdirSync(join(root, "docs/governance"), { recursive: true });
  mkdirSync(join(root, "docs/releases/authorizations"), { recursive: true });
  writeJson(join(root, ".github/required-contexts.json"), {
    schema_version: "required-contexts/v1",
    required_contexts: REQUIRED_CONTEXTS,
    context_implementations: [],
  });
  const key = makeKey(root, "owner-release-test");
  writeJson(join(root, "docs/governance/release-authority-keys.json"), {
    schema_version: "release-authority-keys/v1",
    keys: [
      {
        key_id: "owner-release-test",
        principal: "test-release-authority",
        public_key: key.publicKey,
        added_at: "2026-11-11T00:00:00.000Z",
        revoked_at: null,
      },
    ],
  });
  writeFileSync(
    join(root, REVIEW_REF),
    "# Independent review record\n\nReviewed diff, tests, and evidence bindings.\n",
  );
  return { root, key };
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
        evidence_ids: [EVIDENCE_ID],
      },
    ],
    scope: { included: ["bounded buyer discovery"], excluded: ["campaigns"] },
    promise: {
      user_outcome: "A reviewer can inspect explainable buyer candidates.",
      non_guarantees: ["No automated outreach."],
    },
    source: {
      repository: "mlhjyx/global-backend",
      base_commit: SHA_A,
      source_head: SHA_B,
    },
    evidence_ids: [EVIDENCE_ID],
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

function releaseContext(root) {
  const evidence = {
    schema_version: "runtime-evidence/v1",
    evidence_id: EVIDENCE_ID,
    commit: SHA_D,
    environment: "pilot",
    verified_at: "2026-08-07T10:26:00.000Z",
    valid_until: "2026-08-08T10:26:00.000Z",
    evidence_kind: "runtime_probe",
    result: "PASS",
    artifact_digest: DIGEST,
  };
  const chain = {
    chain_id: "buyer-discovery-pilot",
    capability_id: "CAP-BUYER-001",
    object_ids: ["OBJ-FE-009"],
    operation_ids: ["DiscoveryController_execute_v1"],
    code_paths: ["apps/api/src/discovery/discovery.controller.ts"],
    test_paths: ["apps/api/src/discovery/discovery.service.spec.ts"],
    scenario_ids: ["SCN-FE-BUYER-001"],
    delivery_state: "PILOT",
    evidence_ids: [EVIDENCE_ID],
    required_evidence_kinds: ["runtime_probe"],
  };
  return {
    evidence_by_id: new Map([[EVIDENCE_ID, evidence]]),
    traceability_by_id: new Map([[chain.chain_id, chain]]),
    now: NOW,
    repo_root: root,
  };
}

function machineContexts(overrides = {}) {
  return REQUIRED_CONTEXTS.map((name) => ({
    name,
    conclusion: overrides[name] ?? "success",
    run_id: 1000 + REQUIRED_CONTEXTS.indexOf(name),
    url: `https://github.example/checks/${name}`,
  }));
}

function signBundle(repo, bundle, options = {}) {
  const authorization = buildReleaseAuthorization({
    bundle,
    repository: bundle.source.repository,
    machineContexts: options.machineContexts ?? machineContexts(),
    fetchedAt: options.fetchedAt ?? AUTHORIZED_AT,
    reviewArtifactRef: REVIEW_REF,
    reviewArtifactSha256: sha256Hex(
      readFileSync(join(repo.root, REVIEW_REF)),
    ),
    authorizedBy: "mlhjyx",
    keyId: options.keyId ?? "owner-release-test",
    authorizedAt: options.authorizedAt ?? AUTHORIZED_AT,
    validUntil: options.validUntil ?? VALID_UNTIL,
  });
  const relative = `docs/releases/authorizations/${bundle.release_id}.authorization.json`;
  const absolute = join(repo.root, relative);
  writeJson(absolute, authorization);
  execFileSync("ssh-keygen", [
    "-Y",
    "sign",
    "-f",
    options.signingKey ?? repo.key.privateKey,
    "-n",
    "release-authorization",
    absolute,
  ]);
  return {
    authorization,
    relative,
    absolute,
    bundle: {
      ...bundle,
      external_provenance: {
        status: "OWNER_SIGNED",
        verifier: "PRODUCT_OWNER_SSH_SIGNATURE",
        verification_ref: relative,
      },
    },
  };
}

function issueCodes(result) {
  return result.issues.map((entry) => entry.code);
}

test("a valid owner-signed authorization opens the PILOT gate", () => {
  const repo = makeRepo();
  const signed = signBundle(repo, releaseBundle());
  const result = validateReleaseBundle(signed.bundle, releaseContext(repo.root));
  assert.deepEqual(issueCodes(result), []);
});

test("EXTERNAL_UNVERIFIED still blocks promotion", () => {
  const repo = makeRepo();
  const result = validateReleaseBundle(releaseBundle(), releaseContext(repo.root));
  assert.deepEqual(issueCodes(result), ["RELEASE_EXTERNAL_PROVENANCE_UNVERIFIED"]);
});

test("self-asserted VERIFIED strings still fail closed", () => {
  const repo = makeRepo();
  const forged = releaseBundle({
    external_provenance: {
      status: "VERIFIED",
      verifier: "INDEPENDENT_EXTERNAL_READBACK",
      verification_ref: "https://attacker.invalid/readback",
    },
  });
  const codes = issueCodes(validateReleaseBundle(forged, releaseContext(repo.root)));
  assert.ok(codes.includes("RELEASE_EXTERNAL_PROVENANCE_UNSUPPORTED"));
  assert.ok(codes.includes("RELEASE_EXTERNAL_PROVENANCE_UNVERIFIED"));
});

test("a bundle changed after signing fails the binding", () => {
  const repo = makeRepo();
  const signed = signBundle(repo, releaseBundle());
  const tampered = {
    ...signed.bundle,
    scope: { included: ["everything"], excluded: [] },
  };
  const codes = issueCodes(validateReleaseBundle(tampered, releaseContext(repo.root)));
  assert.ok(codes.includes("RELEASE_AUTHORIZATION_BUNDLE_MISMATCH"));
});

test("a signature from an unpinned key is rejected", () => {
  const repo = makeRepo();
  const other = makeKey(repo.root, "other-key");
  const signed = signBundle(repo, releaseBundle(), {
    signingKey: other.privateKey,
  });
  const codes = issueCodes(
    validateReleaseBundle(signed.bundle, releaseContext(repo.root)),
  );
  assert.ok(codes.includes("RELEASE_AUTHORIZATION_SIGNATURE_INVALID"));
});

test("an unknown or revoked key is rejected", () => {
  const repo = makeRepo();
  const unknown = signBundle(repo, releaseBundle(), { keyId: "not-pinned" });
  assert.ok(
    issueCodes(
      validateReleaseBundle(unknown.bundle, releaseContext(repo.root)),
    ).includes("RELEASE_AUTHORIZATION_KEY_UNKNOWN"),
  );

  const revokedRepo = makeRepo();
  const before = signBundle(revokedRepo, releaseBundle());
  writeJson(join(revokedRepo.root, "docs/governance/release-authority-keys.json"), {
    schema_version: "release-authority-keys/v1",
    keys: [
      {
        key_id: "owner-release-test",
        principal: "test-release-authority",
        public_key: revokedRepo.key.publicKey,
        added_at: "2026-11-11T00:00:00.000Z",
        revoked_at: "2026-11-12T00:00:00.000Z",
      },
    ],
  });
  assert.ok(
    issueCodes(
      validateReleaseBundle(before.bundle, releaseContext(revokedRepo.root)),
    ).includes("RELEASE_AUTHORIZATION_KEY_REVOKED"),
  );
});

test("an expired authorization cannot promote", () => {
  const repo = makeRepo();
  const signed = signBundle(repo, releaseBundle(), {
    authorizedAt: "2026-07-01T00:00:00.000Z",
    validUntil: "2026-07-08T00:00:00.000Z",
    fetchedAt: "2026-07-01T00:00:00.000Z",
  });
  assert.ok(
    issueCodes(
      validateReleaseBundle(signed.bundle, releaseContext(repo.root)),
    ).includes("RELEASE_AUTHORIZATION_EXPIRED"),
  );
});

test("a missing or failed required machine context cannot promote", () => {
  const repo = makeRepo();
  const contexts = machineContexts();
  contexts[1] = { ...contexts[1], conclusion: "failure" };
  const signed = signBundle(repo, releaseBundle(), { machineContexts: contexts });
  assert.ok(
    issueCodes(
      validateReleaseBundle(signed.bundle, releaseContext(repo.root)),
    ).includes("RELEASE_AUTHORIZATION_CONTEXT_MISSING"),
  );
});

test("evidence set changes break the signed binding", () => {
  const repo = makeRepo();
  const signed = signBundle(repo, releaseBundle());
  const changed = {
    ...signed.bundle,
    evidence_ids: [EVIDENCE_ID, "runtime-api-development-20260808"],
  };
  const codes = issueCodes(
    validateReleaseBundle(changed, releaseContext(repo.root)),
  );
  assert.ok(codes.includes("RELEASE_AUTHORIZATION_BUNDLE_MISMATCH"));
});

test("a modified review artifact breaks the signed binding", () => {
  const repo = makeRepo();
  const signed = signBundle(repo, releaseBundle());
  writeFileSync(join(repo.root, REVIEW_REF), "# Rewritten review\n");
  assert.ok(
    issueCodes(
      validateReleaseBundle(signed.bundle, releaseContext(repo.root)),
    ).includes("RELEASE_AUTHORIZATION_REVIEW_MISMATCH"),
  );
});

test("canonical digests are stable and exclude external_provenance", () => {
  const bundle = releaseBundle();
  const withDifferentProvenance = {
    ...bundle,
    external_provenance: {
      status: "OWNER_SIGNED",
      verifier: "PRODUCT_OWNER_SSH_SIGNATURE",
      verification_ref: "docs/releases/authorizations/x.authorization.json",
    },
  };
  assert.equal(
    releaseBundleDigest(bundle),
    releaseBundleDigest(withDifferentProvenance),
  );
  assert.equal(
    evidenceSetDigest(["b", "a", "a"]),
    evidenceSetDigest(["a", "b"]),
  );
  const validation = validateReleaseAuthorization(bundle, {
    repoRoot: tmpdir(),
    now: NOW,
  });
  assert.ok(
    validation.issues.some((entry) =>
      entry.code.startsWith("RELEASE_AUTHORIZATION_"),
    ),
  );
});
