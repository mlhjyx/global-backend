import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ARTIFACT_BYTE_LENGTH = 3121;
const ARTIFACT_SHA256 =
  "248a416e72a8c2590a5c6c8adb941f4105c6ac3e722bc85ced3a77f404784fa1";
const ROW_IDS = [
  "platform.acquisition/acq-sweep",
  "platform.acquisition/patents-cache-refresh",
  "platform.intent_watch/intent-sweep",
  "platform.sanctions/sanctions-refresh",
] as const;
const EXPECTED_AUTHORITY = Object.freeze({
  commit_sha: "290c6f9f6a41c7c39dfe071683252982536937d8",
  tree_sha: "3d04b799ed8f87fa5d9b71ff003f2cd2eb822289",
  patch_blob_sha: "40dc2fe631470827fdf9ea5ddc9d6fdbcaf144d2",
});
const EXPECTED_SOURCE = Object.freeze({
  archive_sha256:
    "5906e7a287843c7bafd8d7bb20aa930d1ae97eb6cf2946110d27ecc3a5dfc75a",
  patch_stack_sha256:
    "ced29b101ad1ff88b875f41a726fc988160eccc6d36526034be271f77f500fff",
});
const SHA256 = /^[0-9a-f]{64}$/;
const ASCII_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const CONTROL_CHARACTER = /\p{Cc}/u;

export interface PlatformAuthorityPolicyProvenanceV1 {
  readonly schema_version: "growthos-platform-authority-policy-provenance/v1";
  readonly artifact: Readonly<{
    readonly path: string;
    readonly sha256: string;
  }>;
  readonly authority: Readonly<{
    readonly commit_sha: string;
    readonly tree_sha: string;
    readonly patch_blob_sha: string;
  }>;
  readonly source: Readonly<{
    readonly archive_sha256: string;
    readonly patch_stack_sha256: string;
  }>;
}

export interface PlatformAuthorityCandidatePolicyRow {
  readonly row_id: (typeof ROW_IDS)[number];
  readonly backend_source_anchor: Readonly<{
    readonly request_sha256: string;
    readonly schedule_id: string;
    readonly task_queue_symbol: string;
    readonly workflow_type_symbol: string;
  }>;
  readonly candidate: Readonly<{
    readonly mode: "candidate_deny";
    readonly reason: "unverified_required_fields" | "disabled_no_egress";
    readonly unresolved_fields: readonly string[];
  }>;
  readonly desired_growthos_policy: Readonly<{
    readonly namespace: "platform-automation";
    readonly schedule_id: string;
    readonly status: "desired_unverified";
    readonly task_queue: "understanding";
    readonly workflow_type: string;
  }>;
  readonly temporal_observation: Readonly<{ readonly status: "UNKNOWN" }>;
}

export interface PlatformAuthorityCandidatePolicyV1 {
  readonly artifact_id: "platform-authority-policy-matrix/2026-09-04-candidate-v1";
  readonly matrix_revision: "candidate-v1";
  readonly rows: readonly PlatformAuthorityCandidatePolicyRow[];
  readonly schema_version: "platform-authority-policy-matrix/v1";
}

export interface VerifiedPlatformAuthorityPolicyAsset {
  readonly byteLength: 3121;
  readonly sha256: typeof ARTIFACT_SHA256;
  readonly policy: PlatformAuthorityCandidatePolicyV1;
  readonly provenance: PlatformAuthorityPolicyProvenanceV1;
}

export class PlatformAuthorityPolicyDriftError extends Error {
  readonly code = "PLATFORM_AUTHORITY_POLICY_DRIFT" as const;

  constructor() {
    super("PLATFORM_AUTHORITY_POLICY_DRIFT");
    this.name = "PlatformAuthorityPolicyDriftError";
  }
}

function drift(): never {
  throw new PlatformAuthorityPolicyDriftError();
}

function exactKeys(value: unknown, keys: readonly string[]): value is object {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!exactKeys(value, Object.keys(value as object))) drift();
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function validateStrings(value: unknown): void {
  if (typeof value === "string") {
    if (value !== value.normalize("NFC") || CONTROL_CHARACTER.test(value))
      drift();
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) validateStrings(child);
    return;
  }
  if (value === null || typeof value !== "object") drift();
  for (const [key, child] of Object.entries(value)) {
    if (!ASCII_KEY.test(key)) drift();
    validateStrings(child);
  }
}

function validateRow(
  value: unknown,
  expectedRowId: (typeof ROW_IDS)[number],
): asserts value is PlatformAuthorityCandidatePolicyRow {
  if (
    !exactKeys(value, [
      "backend_source_anchor",
      "candidate",
      "desired_growthos_policy",
      "row_id",
      "temporal_observation",
    ])
  ) {
    drift();
  }
  const row = value as unknown as Record<string, unknown>;
  const anchor = row.backend_source_anchor as Record<string, unknown>;
  const candidate = row.candidate as Record<string, unknown>;
  const desired = row.desired_growthos_policy as Record<string, unknown>;
  const observation = row.temporal_observation as Record<string, unknown>;
  if (
    row.row_id !== expectedRowId ||
    !exactKeys(anchor, [
      "request_sha256",
      "schedule_id",
      "task_queue_symbol",
      "workflow_type_symbol",
    ]) ||
    !SHA256.test(String(anchor.request_sha256 ?? "")) ||
    !exactKeys(candidate, ["mode", "reason", "unresolved_fields"]) ||
    candidate.mode !== "candidate_deny" ||
    !Array.isArray(candidate.unresolved_fields) ||
    candidate.unresolved_fields.length < 1 ||
    new Set(candidate.unresolved_fields).size !==
      candidate.unresolved_fields.length ||
    !exactKeys(desired, [
      "namespace",
      "schedule_id",
      "status",
      "task_queue",
      "workflow_type",
    ]) ||
    desired.namespace !== "platform-automation" ||
    desired.status !== "desired_unverified" ||
    desired.task_queue !== "understanding" ||
    anchor.schedule_id !== desired.schedule_id ||
    anchor.task_queue_symbol !== desired.task_queue ||
    anchor.workflow_type_symbol !== desired.workflow_type ||
    !exactKeys(observation, ["status"]) ||
    observation.status !== "UNKNOWN" ||
    (expectedRowId.includes("patents-cache-refresh")
      ? candidate.reason !== "disabled_no_egress"
      : candidate.reason !== "unverified_required_fields")
  ) {
    drift();
  }
}

function validatePolicy(
  value: unknown,
): asserts value is PlatformAuthorityCandidatePolicyV1 {
  if (
    !exactKeys(value, [
      "artifact_id",
      "matrix_revision",
      "rows",
      "schema_version",
    ])
  ) {
    drift();
  }
  const policy = value as unknown as Record<string, unknown>;
  if (
    policy.schema_version !== "platform-authority-policy-matrix/v1" ||
    policy.artifact_id !==
      "platform-authority-policy-matrix/2026-09-04-candidate-v1" ||
    policy.matrix_revision !== "candidate-v1" ||
    !Array.isArray(policy.rows) ||
    policy.rows.length !== ROW_IDS.length
  ) {
    drift();
  }
  policy.rows.forEach((row, index) => validateRow(row, ROW_IDS[index]!));
  validateStrings(policy);
}

function validateProvenance(
  value: unknown,
): asserts value is PlatformAuthorityPolicyProvenanceV1 {
  if (
    !exactKeys(value, ["schema_version", "artifact", "authority", "source"])
  ) {
    drift();
  }
  const receipt = value as unknown as Record<string, unknown>;
  const artifact = receipt.artifact as Record<string, unknown>;
  const authority = receipt.authority as Record<string, unknown>;
  const source = receipt.source as Record<string, unknown>;
  if (
    receipt.schema_version !==
      "growthos-platform-authority-policy-provenance/v1" ||
    !exactKeys(artifact, ["path", "sha256"]) ||
    artifact.path !== "ops/policy/platform-authority-policy-matrix-v1.json" ||
    artifact.sha256 !== ARTIFACT_SHA256 ||
    !exactKeys(authority, ["commit_sha", "tree_sha", "patch_blob_sha"]) ||
    authority.commit_sha !== EXPECTED_AUTHORITY.commit_sha ||
    authority.tree_sha !== EXPECTED_AUTHORITY.tree_sha ||
    authority.patch_blob_sha !== EXPECTED_AUTHORITY.patch_blob_sha ||
    !exactKeys(source, ["archive_sha256", "patch_stack_sha256"]) ||
    source.archive_sha256 !== EXPECTED_SOURCE.archive_sha256 ||
    source.patch_stack_sha256 !== EXPECTED_SOURCE.patch_stack_sha256
  ) {
    drift();
  }
}

const FROZEN_PROVENANCE = deepFreeze({
  schema_version: "growthos-platform-authority-policy-provenance/v1",
  artifact: {
    path: "ops/policy/platform-authority-policy-matrix-v1.json",
    sha256: ARTIFACT_SHA256,
  },
  authority: { ...EXPECTED_AUTHORITY },
  source: { ...EXPECTED_SOURCE },
} as unknown);
validateProvenance(FROZEN_PROVENANCE);

export const PLATFORM_AUTHORITY_POLICY_PROVENANCE =
  FROZEN_PROVENANCE as PlatformAuthorityPolicyProvenanceV1;

export function verifyPlatformAuthorityPolicyAsset(input: {
  readonly artifactBytes: Uint8Array;
  readonly provenance: unknown;
}): VerifiedPlatformAuthorityPolicyAsset {
  if (!(input.artifactBytes instanceof Uint8Array)) drift();
  const bytes = Buffer.from(input.artifactBytes);
  if (
    bytes.byteLength !== ARTIFACT_BYTE_LENGTH ||
    createHash("sha256").update(bytes).digest("hex") !== ARTIFACT_SHA256
  ) {
    drift();
  }
  validateProvenance(input.provenance);
  let decoded: string;
  let parsed: unknown;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (decoded.charCodeAt(0) === 0xfeff) drift();
    parsed = JSON.parse(decoded);
  } catch {
    return drift();
  }
  validatePolicy(parsed);
  if (`${canonicalJson(parsed)}\n` !== decoded) {
    drift();
  }
  return deepFreeze({
    byteLength: ARTIFACT_BYTE_LENGTH,
    sha256: ARTIFACT_SHA256,
    policy: parsed,
    provenance: structuredClone(input.provenance),
  });
}

export function loadVerifiedPlatformAuthorityPolicyAsset(): VerifiedPlatformAuthorityPolicyAsset {
  const artifactBytes = readFileSync(
    resolve(__dirname, "platform-authority-policy-matrix-v1.json"),
  );
  return verifyPlatformAuthorityPolicyAsset({
    artifactBytes,
    provenance: PLATFORM_AUTHORITY_POLICY_PROVENANCE,
  });
}
