import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCandidateInput } from "./development-candidate-input.mjs";

export const CANDIDATE_PREDICATE_TYPE =
  "https://global-backend.dev/attestations/development-candidate/v1";
export const CANDIDATE_IMAGE_REPOSITORY =
  "ghcr.io/mlhjyx/global-backend-development-candidate";
const SHA = /^[0-9a-f]{40}$/u,
  HASH = /^[0-9a-f]{64}$/u,
  DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/u;
const DAY = 86_400_000;
function fail(code = "CANDIDATE_CONTRACT_INVALID") {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
function keys(value, allowed) {
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !== [...allowed].sort().join(",")
  )
    fail();
}
function instant(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function workspaces(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((id) => typeof id === "string" && UUID.test(id)) &&
    new Set(value).size === 2
  );
}
function identifier(value) {
  return typeof value === "string" && ID.test(value);
}
function policyValid(policy) {
  if (
    policy?.repository !== "mlhjyx/global-backend" ||
    !SHA.test(policy.trustedWorkflowCommit)
  )
    fail("CANDIDATE_TRUST_POLICY_INVALID");
}

export function validateCandidateAuthorization(
  value,
  policy,
  now = new Date().toISOString(),
) {
  policyValid(policy);
  const productGrants =
    value?.schemaVersion === "development-candidate-authorization/v2";
  keys(value, [
    "schemaVersion",
    "environment",
    "trustedWorkflowCommit",
    "candidateCommit",
    "gitTree",
    "instanceId",
    "workspaceIds",
    "instanceManifestSha256",
    "authorizedAt",
    "validUntil",
    "keyId",
    ...(productGrants
      ? ["budgetPolicy"]
      : ["campaignCapMicrousd", "armCapMicrousd"]),
  ]);
  if (
    (!productGrants &&
      value.schemaVersion !== "development-candidate-authorization/v1") ||
    value.environment !== "development" ||
    value.trustedWorkflowCommit !== policy.trustedWorkflowCommit ||
    !SHA.test(value.candidateCommit) ||
    value.candidateCommit === value.trustedWorkflowCommit ||
    !SHA.test(value.gitTree) ||
    !identifier(value.instanceId) ||
    !identifier(value.keyId) ||
    !HASH.test(value.instanceManifestSha256) ||
    !workspaces(value.workspaceIds) ||
    !instant(value.authorizedAt) ||
    !instant(value.validUntil) ||
    !instant(now) ||
    Date.parse(value.authorizedAt) > Date.parse(now) ||
    Date.parse(value.validUntil) <= Date.parse(now) ||
    Date.parse(value.validUntil) - Date.parse(value.authorizedAt) > DAY ||
    (productGrants
      ? value.budgetPolicy !== "product_grants"
      : value.campaignCapMicrousd !== 5_000_000 ||
        value.armCapMicrousd !== 2_500_000)
  )
    fail("CANDIDATE_AUTHORIZATION_INVALID");
  return value;
}

export function verifyCandidateOwnerSignature(
  bytes,
  signaturePath,
  keyRegistry,
  keyId,
) {
  const found =
    keyRegistry?.keys?.filter(
      (key) => key.key_id === keyId && key.revoked_at === null,
    ) ?? [];
  if (
    found.length !== 1 ||
    !identifier(found[0].principal) ||
    !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/u.test(found[0].public_key)
  )
    fail("CANDIDATE_OWNER_KEY_INVALID");
  const directory = mkdtempSync(join(tmpdir(), "candidate-owner-"));
  try {
    const allowed = join(directory, "allowed_signers");
    writeFileSync(allowed, `${found[0].principal} ${found[0].public_key}\n`, {
      mode: 0o600,
    });
    if (!Buffer.isBuffer(bytes) || bytes.length > 65_536) fail();
    const signature = join(directory, "signature");
    writeFileSync(
      signature,
      readCandidateInput(
        signaturePath,
        8_192,
        "CANDIDATE_OWNER_SIGNATURE_INVALID",
      ),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    execFileSync(
      "ssh-keygen",
      [
        "-Y",
        "verify",
        "-f",
        allowed,
        "-I",
        found[0].principal,
        "-n",
        "development-candidate-authorization",
        "-s",
        signature,
      ],
      {
        input: bytes,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
        maxBuffer: 65_536,
      },
    );
    return true;
  } catch {
    fail("CANDIDATE_OWNER_SIGNATURE_INVALID");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function candidateAttestationArguments(imageReference, policy) {
  policyValid(policy);
  if (
    typeof imageReference !== "string" ||
    !imageReference.startsWith(`${CANDIDATE_IMAGE_REPOSITORY}@`) ||
    !DIGEST.test(imageReference.slice(imageReference.indexOf("@") + 1))
  )
    fail("CANDIDATE_IMAGE_REFERENCE_INVALID");
  return [
    "attestation",
    "verify",
    `oci://${imageReference}`,
    "--repo",
    policy.repository,
    "--signer-workflow",
    `${policy.repository}/.github/workflows/publish-development-candidate.yml`,
    "--signer-digest",
    policy.trustedWorkflowCommit,
    "--source-digest",
    policy.trustedWorkflowCommit,
    "--source-ref",
    "refs/heads/main",
    "--deny-self-hosted-runners",
    "--predicate-type",
    CANDIDATE_PREDICATE_TYPE,
    "--format",
    "json",
  ];
}

// This is additional semantic validation of stdout from a SUCCESSFUL pinned
// gh verifier. It is not a signature verifier and must never accept a user-
// supplied JSON file as proof. The CLI always executes gh itself first.
export function validateCandidateStatement(
  verifiedResults,
  { imageReference, authorization, authorizationSha256, policy, now },
) {
  validateCandidateAuthorization(authorization, policy, now);
  candidateAttestationArguments(imageReference, policy);
  if (
    !HASH.test(authorizationSha256) ||
    !Array.isArray(verifiedResults) ||
    verifiedResults.length !== 1
  )
    fail("CANDIDATE_ATTESTATION_INVALID");
  const statement = verifiedResults[0]?.verificationResult?.statement;
  const predicate = statement?.predicate;
  if (
    statement?._type !== "https://in-toto.io/Statement/v1" ||
    statement?.predicateType !== CANDIDATE_PREDICATE_TYPE ||
    !Array.isArray(statement.subject) ||
    statement.subject.length !== 1 ||
    statement.subject[0]?.name !== CANDIDATE_IMAGE_REPOSITORY ||
    statement.subject[0]?.digest?.sha256 !== imageReference.split("@sha256:")[1]
  )
    fail("CANDIDATE_ATTESTATION_INVALID");
  keys(predicate, [
    "schemaVersion",
    "authorizationSha256",
    "trustedWorkflowCommit",
    "candidateCommit",
    "gitTree",
    "sourceTreeDigest",
    "artifactDigest",
    "instanceId",
    "workspaceIds",
    "validUntil",
    "instanceManifestSha256",
  ]);
  if (
    predicate.schemaVersion !== "development-candidate-build/v1" ||
    predicate.authorizationSha256 !== authorizationSha256 ||
    !DIGEST.test(predicate.sourceTreeDigest) ||
    !DIGEST.test(predicate.artifactDigest)
  )
    fail("CANDIDATE_ATTESTATION_INVALID");
  for (const key of [
    "trustedWorkflowCommit",
    "candidateCommit",
    "gitTree",
    "instanceId",
    "workspaceIds",
    "validUntil",
    "instanceManifestSha256",
  ]) {
    if (JSON.stringify(predicate[key]) !== JSON.stringify(authorization[key]))
      fail("CANDIDATE_ATTESTATION_INVALID");
  }
  return predicate;
}

function endpoint(value, protocol) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== protocol ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      fail();
    return url;
  } catch {
    fail();
  }
}
function database(value) {
  keys(value, ["host", "port", "name"]);
  if (
    value.host !== "127.0.0.1" ||
    !Number.isInteger(value.port) ||
    value.port < 1024 ||
    value.port > 65535 ||
    value.port === 5432 ||
    !/^global_candidate_[a-z0-9_]{1,50}$/u.test(value.name)
  )
    fail("CANDIDATE_DATABASE_NOT_ISOLATED");
}
export function validateCandidateInstance(value) {
  keys(value, [
    "schemaVersion",
    "instanceId",
    "environment",
    "workspaceIds",
    "apiOrigin",
    "database",
    "leaseDatabases",
    "temporal",
    "controlPlane",
    "dependencyProofs",
    "schedulesEnabled",
    "sharedRuntimeMutation",
    "readOnlyRoot",
  ]);
  if (
    value.schemaVersion !== "development-candidate-instance/v1" ||
    value.environment !== "development" ||
    !identifier(value.instanceId) ||
    !workspaces(value.workspaceIds) ||
    value.schedulesEnabled !== false ||
    value.sharedRuntimeMutation !== false ||
    value.readOnlyRoot !== true
  )
    fail();
  const origin = endpoint(value.apiOrigin, "http:");
  if (["3000", "3010"].includes(origin.port) || origin.pathname !== "/") fail();
  database(value.database);
  keys(value.leaseDatabases, ["API", "WORKER", "OUTBOX_RELAY"]);
  for (const connection of Object.values(value.leaseDatabases)) {
    database(connection);
    if (
      connection.host !== value.database.host ||
      connection.port !== value.database.port ||
      connection.name !== value.database.name
    )
      fail("CANDIDATE_LEASE_DATABASE_MISMATCH");
  }
  keys(value.temporal, [
    "address",
    "namespace",
    "taskQueue",
    "tlsServerName",
    "authorizer",
    "configurationRevision",
  ]);
  if (
    !/^127\.0\.0\.1:[0-9]{4,5}$/u.test(value.temporal.address) ||
    ["127.0.0.1:7233", "127.0.0.1:17233"].includes(value.temporal.address) ||
    Number(value.temporal.address.split(":")[1]) > 65535 ||
    value.temporal.namespace !== "default" ||
    value.temporal.taskQueue !== "understanding" ||
    value.temporal.authorizer !== "native-machine-policy" ||
    !/^[a-zA-Z0-9.-]+$/u.test(value.temporal.tlsServerName) ||
    !HASH.test(value.temporal.configurationRevision)
  )
    fail("CANDIDATE_TEMPORAL_NOT_ISOLATED");
  keys(value.controlPlane, ["issuer", "jwks", "targetId", "machineSubjects"]);
  endpoint(value.controlPlane.issuer, "https:");
  endpoint(value.controlPlane.jwks, "https:");
  if (
    !identifier(value.controlPlane.targetId) ||
    !Array.isArray(value.controlPlane.machineSubjects) ||
    value.controlPlane.machineSubjects.length !== 2 ||
    new Set(value.controlPlane.machineSubjects).size !== 2 ||
    !value.controlPlane.machineSubjects.every((id) => identifier(id))
  )
    fail();
  keys(value.dependencyProofs, [
    "databasePrivileges",
    "temporalIdentity",
    "storage",
    "redis",
    "gateway",
    "renderer",
    "browser",
    "jwks",
    "grantVerification",
  ]);
  if (
    !Object.values(value.dependencyProofs).every((digest) => HASH.test(digest))
  )
    fail();
  return value; // Structure only: real signature/provisioning/readiness remain mandatory.
}

export function candidateMarker(authorization, authorizationSha256) {
  return {
    schemaVersion:
      authorization.schemaVersion === "development-candidate-authorization/v2"
        ? "development-candidate-marker/v2"
        : "development-candidate-marker/v1",
    ...(authorization.schemaVersion === "development-candidate-authorization/v2"
      ? { budgetPolicy: authorization.budgetPolicy }
      : {}),
    candidateCommit: authorization.candidateCommit,
    trustedWorkflowCommit: authorization.trustedWorkflowCommit,
    authorizationSha256,
    instanceManifestSha256: authorization.instanceManifestSha256,
    instanceId: authorization.instanceId,
    workspaceIds: authorization.workspaceIds,
    validUntil: authorization.validUntil,
  };
}
export function candidateAdmissionReceipt(
  imageReference,
  authorization,
  authorizationSha256,
  predicate,
  instance,
) {
  return {
    ...candidateMarker(authorization, authorizationSha256),
    schemaVersion:
      authorization.schemaVersion === "development-candidate-authorization/v2"
        ? "development-candidate-admission/v2"
        : "development-candidate-admission/v1",
    imageReference,
    artifactDigest: predicate.artifactDigest,
    sourceTreeDigest: predicate.sourceTreeDigest,
    instanceManifestSha256: authorization.instanceManifestSha256,
    instance,
    verificationKind: "github-attestation-and-owner-ssh",
  };
}
