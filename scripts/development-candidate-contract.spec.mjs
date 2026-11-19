import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CANDIDATE_PREDICATE_TYPE,
  validateCandidateAuthorization,
  validateCandidateStatement,
  validateCandidateInstance,
  verifyCandidateOwnerSignature,
  candidateAttestationArguments,
  candidateMarker,
  candidateAdmissionReceipt,
} from "./development-candidate-contract.mjs";

const NOW = "2026-11-15T14:00:00.000Z";
const SHA = "a".repeat(40),
  BUILDER = "b".repeat(40),
  TREE = "c".repeat(40);
const HASH = "d".repeat(64),
  HASH2 = "e".repeat(64);
const POLICY = {
  repository: "mlhjyx/global-backend",
  trustedWorkflowCommit: BUILDER,
};
const AUTH = {
  schemaVersion: "development-candidate-authorization/v1",
  environment: "development",
  trustedWorkflowCommit: BUILDER,
  candidateCommit: SHA,
  gitTree: TREE,
  instanceId: "pump-ab-20261115",
  workspaceIds: [
    "10000000-0000-4000-8000-000000000001",
    "10000000-0000-4000-8000-000000000002",
  ],
  instanceManifestSha256: HASH,
  authorizedAt: NOW,
  validUntil: "2026-11-16T14:00:00.000Z",
  keyId: "fixture-owner",
  campaignCapMicrousd: 5_000_000,
  armCapMicrousd: 2_500_000,
};
const IMAGE = `ghcr.io/mlhjyx/global-backend-development-candidate@sha256:${HASH}`;
function statement() {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: IMAGE.split("@")[0], digest: { sha256: HASH } }],
    predicateType: CANDIDATE_PREDICATE_TYPE,
    predicate: {
      schemaVersion: "development-candidate-build/v1",
      authorizationSha256: HASH2,
      trustedWorkflowCommit: BUILDER,
      candidateCommit: SHA,
      gitTree: TREE,
      sourceTreeDigest: `sha256:${HASH}`,
      artifactDigest: `sha256:${HASH2}`,
      instanceId: AUTH.instanceId,
      workspaceIds: AUTH.workspaceIds,
      validUntil: AUTH.validUntil,
      instanceManifestSha256: HASH,
    },
  };
}

test("binds owner-approved source and builder identities separately, with bounded development scope", () => {
  assert.deepEqual(validateCandidateAuthorization(AUTH, POLICY, NOW), AUTH);
  for (const patch of [
    { environment: "production" },
    { candidateCommit: BUILDER },
    { trustedWorkflowCommit: SHA },
    { validUntil: NOW },
    { validUntil: "2026-12-15T14:00:00.000Z" },
    { campaignCapMicrousd: 5_000_001 },
    { armCapMicrousd: 2_500_001 },
    { workspaceIds: [AUTH.workspaceIds[0], AUTH.workspaceIds[0]] },
    { unexpected: true },
    { instanceId: null },
    { keyId: null },
  ])
    assert.throws(() =>
      validateCandidateAuthorization({ ...AUTH, ...patch }, POLICY, NOW),
    );
});

test("verifies real detached owner SSH signatures in a distinct namespace, not a claimed VERIFIED string", () => {
  const dir = mkdtempSync(join(tmpdir(), "candidate-signature-"));
  const key = join(dir, "fixture-key"),
    path = join(dir, "authorization.json");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  writeFileSync(path, JSON.stringify(AUTH));
  execFileSync(
    "ssh-keygen",
    [
      "-Y",
      "sign",
      "-f",
      key,
      "-n",
      "development-candidate-authorization",
      path,
    ],
    { stdio: "ignore" },
  );
  const keys = {
    keys: [
      {
        key_id: AUTH.keyId,
        principal: "fixture-owner",
        public_key: readFileSync(`${key}.pub`, "utf8").trim(),
        revoked_at: null,
      },
    ],
  };
  assert.equal(
    verifyCandidateOwnerSignature(
      readFileSync(path),
      `${path}.sig`,
      keys,
      AUTH.keyId,
    ),
    true,
  );
  writeFileSync(
    path,
    JSON.stringify({ ...AUTH, campaignCapMicrousd: 50_000_000 }),
  );
  assert.throws(
    () =>
      verifyCandidateOwnerSignature(
        readFileSync(path),
        `${path}.sig`,
        keys,
        AUTH.keyId,
      ),
    /CANDIDATE_OWNER_SIGNATURE_INVALID/u,
  );
  assert.throws(() =>
    verifyCandidateOwnerSignature(
      readFileSync(path),
      `${path}.sig`,
      { keys: [{ ...keys.keys[0], revoked_at: NOW }] },
      AUTH.keyId,
    ),
  );
});

test("cryptographic CLI policy fixes actor, source, builder digest and predicate before parsing a statement", () => {
  const args = candidateAttestationArguments(IMAGE, POLICY);
  for (const item of [
    "--deny-self-hosted-runners",
    "--predicate-type",
    CANDIDATE_PREDICATE_TYPE,
    "--signer-digest",
    BUILDER,
    "--source-ref",
    "refs/heads/main",
  ])
    assert.ok(args.includes(item));
  assert.ok(
    args.includes(
      "mlhjyx/global-backend/.github/workflows/publish-development-candidate.yml",
    ),
  );
  assert.throws(() =>
    candidateAttestationArguments(
      `ghcr.io/mlhjyx/global-backend@sha256:${HASH}`,
      POLICY,
    ),
  );
  assert.throws(() =>
    candidateAttestationArguments("https://attacker.example/image", POLICY),
  );
});

test("accepts only a verified-result statement exactly bound to image, approval, source and instance", () => {
  const result = [{ verificationResult: { statement: statement() } }];
  const predicate = validateCandidateStatement(result, {
    imageReference: IMAGE,
    authorization: AUTH,
    authorizationSha256: HASH2,
    policy: POLICY,
    now: NOW,
  });
  assert.equal(predicate.candidateCommit, SHA);
  for (const change of [
    (value) => {
      value[0].verificationResult.statement.predicate.candidateCommit = BUILDER;
    },
    (value) => {
      value[0].verificationResult.statement.subject[0].digest.sha256 = HASH2;
    },
    (value) => {
      value[0].verificationResult.statement.predicate.authorizationSha256 =
        HASH;
    },
    (value) => {
      value[0].verificationResult.statement.predicate.workspaceIds.reverse();
    },
    (value) => {
      value[0].verificationResult.statement.predicate.instanceManifestSha256 =
        HASH2;
    },
    (value) => {
      value[0].verificationResult.statement.predicate.validUntil = NOW;
    },
    (value) => {
      value.push(value[0]);
    },
  ]) {
    const value = structuredClone(result);
    change(value);
    assert.throws(() =>
      validateCandidateStatement(value, {
        imageReference: IMAGE,
        authorization: AUTH,
        authorizationSha256: HASH2,
        policy: POLICY,
        now: NOW,
      }),
    );
  }
  assert.throws(() =>
    validateCandidateStatement(
      { status: "VERIFIED", statement: statement() },
      {
        imageReference: IMAGE,
        authorization: AUTH,
        authorizationSha256: HASH2,
        policy: POLICY,
        now: NOW,
      },
    ),
  );
});

const database = {
  host: "127.0.0.1",
  port: 15432,
  name: "global_candidate_pump_ab",
};
function instance() {
  return structuredClone({
    schemaVersion: "development-candidate-instance/v1",
    instanceId: AUTH.instanceId,
    environment: "development",
    workspaceIds: AUTH.workspaceIds,
    apiOrigin: "http://127.0.0.1:13010",
    database,
    leaseDatabases: { API: database, WORKER: database, OUTBOX_RELAY: database },
    temporal: {
      address: "127.0.0.1:27233",
      namespace: "default",
      taskQueue: "understanding",
      tlsServerName: "candidate.temporal.local",
      authorizer: "native-machine-policy",
      configurationRevision: "9".repeat(64),
    },
    controlPlane: {
      issuer: "https://127.0.0.1:28447",
      jwks: "https://127.0.0.1:28447/jwks",
      targetId: "candidate-target-v1",
      machineSubjects: ["candidate-api", "candidate-customer-worker"],
    },
    dependencyProofs: {
      databasePrivileges: HASH,
      temporalIdentity: HASH,
      storage: HASH,
      redis: HASH,
      gateway: HASH,
      renderer: HASH,
      browser: HASH,
      jwks: HASH,
      grantVerification: HASH,
    },
    schedulesEnabled: false,
    sharedRuntimeMutation: false,
    readOnlyRoot: true,
  });
}

test("validates an isolated normal-runtime manifest without pretending its proof references prove readiness", () => {
  assert.equal(
    validateCandidateInstance(instance()).instanceId,
    AUTH.instanceId,
  );
  for (const change of [
    (value) => {
      value.database.name = "global_dev";
    },
    (value) => {
      value.apiOrigin = "http://0.0.0.0:13010";
    },
    (value) => {
      value.leaseDatabases.WORKER = { ...database, name: "global_dev" };
    },
    (value) => {
      value.temporal.address = "127.0.0.1:7233";
    },
    (value) => {
      value.temporal.tlsServerName = "";
    },
    (value) => {
      value.temporal.authorizer = "cli";
    },
    (value) => {
      value.controlPlane.issuer = "http://127.0.0.1:28447";
    },
    (value) => {
      delete value.dependencyProofs.grantVerification;
    },
    (value) => {
      value.schedulesEnabled = true;
    },
    (value) => {
      value.readOnlyRoot = false;
    },
    (value) => {
      value.password = "must not be in a public instance manifest";
    },
  ]) {
    const value = instance();
    change(value);
    assert.throws(() => validateCandidateInstance(value));
  }
});

test("derives marker and root-owned runtime receipt from already verified approval and predicate", () => {
  const marker = candidateMarker(AUTH, HASH2);
  const receipt = candidateAdmissionReceipt(
    IMAGE,
    AUTH,
    HASH2,
    statement().predicate,
  );
  assert.equal(marker.authorizationSha256, HASH2);
  assert.equal(receipt.imageReference, IMAGE);
  assert.equal(receipt.artifactDigest, `sha256:${HASH2}`);
  assert.equal(receipt.verificationKind, "github-attestation-and-owner-ssh");
});

test("explicit v2 product-Grant policy removes only the experiment-wide cap", () => {
  const { campaignCapMicrousd, armCapMicrousd, ...identity } = AUTH;
  const authorization = {
    ...identity,
    schemaVersion: "development-candidate-authorization/v2",
    budgetPolicy: "product_grants",
  };
  assert.deepEqual(
    validateCandidateAuthorization(authorization, POLICY, NOW),
    authorization,
  );
  const marker = candidateMarker(authorization, HASH2);
  assert.equal(marker.schemaVersion, "development-candidate-marker/v2");
  assert.equal(marker.budgetPolicy, "product_grants");
  const admission = candidateAdmissionReceipt(
    IMAGE,
    authorization,
    HASH2,
    statement().predicate,
    {},
  );
  assert.equal(admission.schemaVersion, "development-candidate-admission/v2");
  assert.equal(admission.budgetPolicy, "product_grants");
  for (const patch of [
    { budgetPolicy: "unlimited" },
    { budgetPolicy: undefined },
    { campaignCapMicrousd: 5_000_000 },
    { schemaVersion: "development-candidate-authorization/v1" },
    { schemaVersion: "development-candidate-authorization/v3" },
    { environment: "production" },
    { validUntil: NOW },
  ]) {
    assert.throws(() =>
      validateCandidateAuthorization(
        { ...authorization, ...patch },
        POLICY,
        NOW,
      ),
    );
  }
});
