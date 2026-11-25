import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateRuntimeCandidate,
  readRuntimeCandidate,
  candidateWorkspaceAllowed,
  assertCandidatePhysicalExecutionAllowed,
} from "./development-candidate";

const NOW = Date.parse("2026-11-15T14:00:00.000Z");
it("ordinary runtime keeps the existing physical execution quota", () => {
  expect(() => assertCandidatePhysicalExecutionAllowed()).not.toThrow();
});
const WS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
];
const IMAGE = `ghcr.io/mlhjyx/global-backend-development-candidate@sha256:${"a".repeat(64)}`;
const marker = {
  schemaVersion: "development-candidate-marker/v1",
  candidateCommit: "a".repeat(40),
  trustedWorkflowCommit: "b".repeat(40),
  authorizationSha256: "c".repeat(64),
  instanceManifestSha256: "",
  instanceId: "pump-ab",
  workspaceIds: WS,
  validUntil: "2026-11-16T14:00:00.000Z",
};
const instance = {
  apiOrigin: "http://127.0.0.1:13010",
  database: {
    host: "127.0.0.1",
    port: 15432,
    name: "global_candidate_pump_ab",
  },
  temporal: {
    address: "127.0.0.1:27233",
    tlsServerName: "candidate.temporal.local",
    configurationRevision: "9".repeat(64),
  },
  controlPlane: {
    issuer: "https://127.0.0.1:28446",
    jwks: "https://127.0.0.1:28446/jwks",
    machineSubjects: ["candidate-api", "candidate-worker"],
  },
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
marker.instanceManifestSha256 = createHash("sha256")
  .update(canonical(instance))
  .digest("hex");
const receipt = {
  ...marker,
  schemaVersion: "development-candidate-admission/v1",
  imageReference: IMAGE,
  artifactDigest: `sha256:${"d".repeat(64)}`,
  sourceTreeDigest: `sha256:${"e".repeat(64)}`,
  verificationKind: "github-attestation-and-owner-ssh",
  instance,
  instanceManifestSha256: createHash("sha256")
    .update(canonical(instance))
    .digest("hex"),
};
const build = {
  build_sha: marker.candidateCommit,
  artifact_digest: receipt.artifactDigest,
  source_tree_digest: receipt.sourceTreeDigest,
};
const env = {
  APP_ENVIRONMENT: "development",
  NODE_ENV: "production",
  RUNTIME_IMAGE_REFERENCE: IMAGE,
  RUNTIME_CANDIDATE_INSTANCE_ID: marker.instanceId,
  APP_DATABASE_URL:
    "postgresql://app_user@127.0.0.1:15432/global_candidate_pump_ab",
  DATABASE_URL: "",
  RUNTIME_API_LEASE_DATABASE_URL:
    "postgresql://runtime_api@127.0.0.1:15432/global_candidate_pump_ab",
  TEMPORAL_ADDRESS: instance.temporal.address,
  TEMPORAL_TLS_SERVER_NAME: instance.temporal.tlsServerName,
  MACHINE_BOOTSTRAP_CONFIGURATION_REVISION:
    instance.temporal.configurationRevision,
  TEMPORAL_MACHINE_SUBJECT: "candidate-api",
  AUTH_ISSUER: instance.controlPlane.issuer,
  AUTH_JWKS_URI: instance.controlPlane.jwks,
  PORT: "13010",
  SWEEP_SCHEDULER_ENABLED: "off",
};

describe("development candidate runtime admission", () => {
  it("binds an externally verified receipt cache to the immutable build and actual isolated configuration", () => {
    const context = validateRuntimeCandidate(marker, receipt, build, env, NOW);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.workspaceIds)).toBe(true);
    expect(candidateWorkspaceAllowed(WS[0]!, context, NOW)).toBe(true);
    expect(candidateWorkspaceAllowed("other-workspace", context, NOW)).toBe(
      false,
    );
    expect(
      candidateWorkspaceAllowed(WS[0]!, context, Date.parse(marker.validUntil)),
    ).toBe(false);
    expect(
      candidateWorkspaceAllowed("ordinary-release-workspace", undefined, NOW),
    ).toBe(true);
  });

  it.each([
    { APP_ENVIRONMENT: "production" },
    { APP_ENVIRONMENT: "pilot" },
    { NODE_ENV: "test" },
    { RUNTIME_CANDIDATE_INSTANCE_ID: "other" },
    { RUNTIME_IMAGE_REFERENCE: IMAGE.replace(/a{64}/u, "f".repeat(64)) },
    { APP_DATABASE_URL: "postgresql://app_user@127.0.0.1:5432/global_dev" },
    { DATABASE_URL: "postgresql://global@127.0.0.1:15432/global_candidate_pump_ab" },
    {
      OUTBOX_RELAY_DATABASE_URL:
        "postgresql://global@127.0.0.1:15432/global_candidate_pump_ab",
    },
    {
      OUTBOX_RELAY_DATABASE_URL:
        "postgresql://postgres@127.0.0.1:15432/global_candidate_pump_ab",
    },
    {
      EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL:
        "postgresql://postgres@127.0.0.1:15432/global_candidate_pump_ab",
    },
    {
      RUNTIME_API_LEASE_DATABASE_URL:
        "postgresql://runtime_api@127.0.0.1:5432/global_dev",
    },
    { TEMPORAL_ADDRESS: "127.0.0.1:7233" },
    { TEMPORAL_TLS_SERVER_NAME: "wrong" },
    { MACHINE_BOOTSTRAP_CONFIGURATION_REVISION: "wrong" },
    { TEMPORAL_MACHINE_SUBJECT: "shared-worker" },
    { AUTH_ISSUER: "https://127.0.0.1:18446" },
    { AUTH_JWKS_URI: "https://127.0.0.1:18446/jwks" },
    { PORT: "3000" },
  ])(
    "rejects incompatible environment or real target configuration %j before runtime work",
    (patch) => {
      expect(() =>
        validateRuntimeCandidate(
          marker,
          receipt,
          build,
          { ...env, ...patch },
          NOW,
        ),
      ).toThrow("DEVELOPMENT_CANDIDATE_ADMISSION_INVALID");
    },
  );

  it("rejects a forged/mismatched cache, changed instance manifest or expiry", () => {
    for (const patch of [
      { authorizationSha256: "f".repeat(64) },
      { candidateCommit: "f".repeat(40) },
      { trustedWorkflowCommit: "f".repeat(40) },
      { workspaceIds: [...WS].reverse() },
      { artifactDigest: `sha256:${"f".repeat(64)}` },
      { sourceTreeDigest: `sha256:${"f".repeat(64)}` },
      { validUntil: new Date(NOW).toISOString() },
      { verificationKind: "self-asserted" },
      { instanceManifestSha256: "f".repeat(64) },
    ])
      expect(() =>
        validateRuntimeCandidate(
          marker,
          { ...receipt, ...patch },
          build,
          env,
          NOW,
        ),
      ).toThrow();
    expect(() =>
      validateRuntimeCandidate(
        marker,
        receipt,
        build,
        env,
        Date.parse(marker.validUntil),
      ),
    ).toThrow();
  });

  it("ordinary release needs no candidate cache; candidate namespace or variables cannot omit its immutable marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "candidate-runtime-"));
    await expect(
      readRuntimeCandidate(root, build, {
        RUNTIME_IMAGE_REFERENCE: "registry.example/release@sha256:abc",
      }),
    ).resolves.toBeUndefined();
    await expect(readRuntimeCandidate(root, build, env)).rejects.toThrow();
    await expect(
      readRuntimeCandidate(root, build, {
        RUNTIME_CANDIDATE_INSTANCE_ID: "unexpected",
      }),
    ).rejects.toThrow();
    await writeFile(join(root, "runtime-candidate.json"), "{invalid json");
    await expect(readRuntimeCandidate(root, build, env)).rejects.toThrow();
  });
});
