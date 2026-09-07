import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { types } from "node:util";

export const PLATFORM_AUTHORITY_POLICY_ARTIFACT_BYTES = 15_583 as const;
export const PLATFORM_AUTHORITY_POLICY_ARTIFACT_SHA256 =
  "f9e9591731772f974b087307b5d0365c58c86b501232804c77a20fd3592db01b" as const;
export const PLATFORM_AUTHORITY_POLICY_ARTIFACT_ID =
  "platform-authority-policy-matrix/2026-09-04-reviewed-v2" as const;
export const PLATFORM_AUTHORITY_POLICY_MATRIX_REVISION = "reviewed-v2" as const;

const EXPECTED_ROW_IDS = Object.freeze([
  "platform.acquisition/acq-sweep",
  "platform.acquisition/patents-cache-refresh",
  "platform.intent_watch/intent-sweep",
  "platform.sanctions/sanctions-refresh",
] as const);

export interface PlatformAuthorityPolicySuccessorRowV2 {
  readonly row_id: (typeof EXPECTED_ROW_IDS)[number];
  readonly purpose:
    | "platform.acquisition"
    | "platform.intent_watch"
    | "platform.sanctions";
  readonly temporal_namespace: "platform-automation";
  readonly schedule_id:
    | "acq-sweep"
    | "patents-cache-refresh"
    | "intent-sweep"
    | "sanctions-refresh";
  readonly workflow_type: string;
  readonly task_queue: "understanding";
  readonly schedule_request_sha256: string;
  readonly desired_mode: "ENABLED" | "INTENTIONALLY_DISABLED_NO_EGRESS";
  readonly default_issuance_state: "DENIED";
  readonly execution_envelope: Readonly<Record<string, unknown>>;
  readonly reviewed_predecessor_quote_vector: Readonly<Record<string, unknown>>;
}

export interface PlatformAuthorityPolicySuccessorV2 {
  readonly schema_version: "platform-authority-policy-matrix/v2";
  readonly artifact_id: typeof PLATFORM_AUTHORITY_POLICY_ARTIFACT_ID;
  readonly matrix_revision: typeof PLATFORM_AUTHORITY_POLICY_MATRIX_REVISION;
  readonly currency: "USD";
  readonly unit: "microusd";
  readonly predecessor: Readonly<{
    readonly artifact_id: "platform-authority-policy-matrix/2026-09-04-candidate-v1";
    readonly artifact_sha256: "248a416e72a8c2590a5c6c8adb941f4105c6ac3e722bc85ced3a77f404784fa1";
    readonly matrix_revision: "candidate-v1";
  }>;
  readonly backend_review: Readonly<{
    readonly exact_commit: "061892b0159c9eb01b589465e60605ffa6591244";
    readonly review_kind: "independent_read_only_source_review";
    readonly review_scope_base_commit: "50267cb505379ed3658798e7c381c9614364808f";
    readonly review_scope_head_commit: "061892b0159c9eb01b589465e60605ffa6591244";
    readonly review_verdict: "APPROVE";
    readonly technical_contract_sha256: "230c0252403f401f35003d3cd3e7d99912ae5689fb84c37bbd50ed624cd9325b";
  }>;
  readonly policy_revision_contract: Readonly<{
    readonly mode: "RECOMPUTE_ACTUAL_RUN_WITH_SUCCESSOR_IDENTITY";
    readonly sample_values_authoritative: false;
    readonly schema_version: "platform-execution-technical-policy/v1";
  }>;
  readonly issuability_requirements: readonly string[];
  readonly rows: readonly PlatformAuthorityPolicySuccessorRowV2[];
}

export interface PlatformAuthorityPolicyProvenanceV2 {
  readonly schema_version: "growthos-platform-authority-policy-provenance/v2";
  readonly artifact: Readonly<{
    readonly materialized_path: "ops/policy/platform-authority-policy-matrix-v2.json";
    readonly byte_length: typeof PLATFORM_AUTHORITY_POLICY_ARTIFACT_BYTES;
    readonly sha256: typeof PLATFORM_AUTHORITY_POLICY_ARTIFACT_SHA256;
  }>;
  readonly growthos_authority: Readonly<{
    readonly reviewed_head_commit: "17e68953ff2e26ac8433db5aa49689e5f9283659";
    readonly reviewed_head_tree: "46832215fc8189b4c2c71dc56b653d2eac401d7c";
    readonly artifact_commit: "cb572a149d44ab402d5cfcdaaa0aeb21c053ad9e";
    readonly artifact_commit_tree: "953a4345900b8aeabc64ee582e02a86873d1be52";
    readonly patch_path: "patches/0057-platform-authority-policy-successor.patch";
    readonly patch_blob_sha1: "ba5ffc2642cca2d95167c22574d76be425f5d1b4";
    readonly patch_sha256: "2a6943a17bc6c31d76b9266b98834fb0dd5e2cf2abf67f5f74d0ea358bf37fd9";
    readonly artifact_commit_patch_stack_sha256: "a660488367c5197f84469c39524ae322cdb50973493ba9c3066e8346156143ce";
    readonly source_archive_sha256: "5906e7a287843c7bafd8d7bb20aa930d1ae97eb6cf2946110d27ecc3a5dfc75a";
  }>;
}

export interface VerifiedPlatformAuthorityPolicyAsset {
  readonly byteLength: typeof PLATFORM_AUTHORITY_POLICY_ARTIFACT_BYTES;
  readonly sha256: typeof PLATFORM_AUTHORITY_POLICY_ARTIFACT_SHA256;
  readonly policy: PlatformAuthorityPolicySuccessorV2;
  readonly provenance: PlatformAuthorityPolicyProvenanceV2;
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

function canonicalJson(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (value !== value.normalize("NFC") || /\p{Cc}/u.test(value)) drift();
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && !Object.is(value, -0)
      ? JSON.stringify(value)
      : drift();
  }
  if (typeof value !== "object" || types.isProxy(value) || seen.has(value)) {
    return drift();
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) drift();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (
        Reflect.ownKeys(descriptors).some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)),
        )
      ) {
        drift();
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          drift();
        }
        items.push(canonicalJson(descriptor.value, seen));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) drift();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
      drift();
    }
    const entries: string[] = [];
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        key !== key.normalize("NFC") ||
        /\p{Cc}/u.test(key)
      ) {
        drift();
      }
      entries.push(
        `${JSON.stringify(key)}:${canonicalJson(descriptor.value, seen)}`,
      );
    }
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const FROZEN_PROVENANCE = deepFreeze({
  schema_version: "growthos-platform-authority-policy-provenance/v2",
  artifact: {
    materialized_path:
      "ops/policy/platform-authority-policy-matrix-v2.json",
    byte_length: PLATFORM_AUTHORITY_POLICY_ARTIFACT_BYTES,
    sha256: PLATFORM_AUTHORITY_POLICY_ARTIFACT_SHA256,
  },
  growthos_authority: {
    reviewed_head_commit: "17e68953ff2e26ac8433db5aa49689e5f9283659",
    reviewed_head_tree: "46832215fc8189b4c2c71dc56b653d2eac401d7c",
    artifact_commit: "cb572a149d44ab402d5cfcdaaa0aeb21c053ad9e",
    artifact_commit_tree: "953a4345900b8aeabc64ee582e02a86873d1be52",
    patch_path: "patches/0057-platform-authority-policy-successor.patch",
    patch_blob_sha1: "ba5ffc2642cca2d95167c22574d76be425f5d1b4",
    patch_sha256:
      "2a6943a17bc6c31d76b9266b98834fb0dd5e2cf2abf67f5f74d0ea358bf37fd9",
    artifact_commit_patch_stack_sha256:
      "a660488367c5197f84469c39524ae322cdb50973493ba9c3066e8346156143ce",
    source_archive_sha256:
      "5906e7a287843c7bafd8d7bb20aa930d1ae97eb6cf2946110d27ecc3a5dfc75a",
  },
} as const);

export const PLATFORM_AUTHORITY_POLICY_PROVENANCE =
  FROZEN_PROVENANCE as PlatformAuthorityPolicyProvenanceV2;

function exactProvenance(value: unknown): boolean {
  try {
    return canonicalJson(value) === canonicalJson(FROZEN_PROVENANCE);
  } catch {
    return false;
  }
}

function exactPolicy(value: unknown): PlatformAuthorityPolicySuccessorV2 {
  const canonical = canonicalJson(value);
  const bytes = Buffer.from(`${canonical}\n`, "utf8");
  if (
    bytes.byteLength !== PLATFORM_AUTHORITY_POLICY_ARTIFACT_BYTES ||
    createHash("sha256").update(bytes).digest("hex") !==
      PLATFORM_AUTHORITY_POLICY_ARTIFACT_SHA256
  ) {
    drift();
  }
  const parsed = JSON.parse(canonical) as PlatformAuthorityPolicySuccessorV2;
  if (
    parsed.schema_version !== "platform-authority-policy-matrix/v2" ||
    parsed.artifact_id !== PLATFORM_AUTHORITY_POLICY_ARTIFACT_ID ||
    parsed.matrix_revision !== PLATFORM_AUTHORITY_POLICY_MATRIX_REVISION ||
    parsed.rows.length !== EXPECTED_ROW_IDS.length ||
    !parsed.rows.every((row, index) => row.row_id === EXPECTED_ROW_IDS[index])
  ) {
    drift();
  }
  return deepFreeze(parsed);
}

function bundledJson(path: string, maximumBytes: number): unknown {
  try {
    const bytes = readFileSync(resolve(__dirname, path));
    if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) drift();
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source.charCodeAt(0) === 0xfeff || !source.endsWith("\n")) drift();
    return JSON.parse(source) as unknown;
  } catch (error) {
    if (error instanceof PlatformAuthorityPolicyDriftError) throw error;
    return drift();
  }
}

export function verifyPlatformAuthorityPolicyAsset(input: {
  readonly artifact: unknown;
  readonly provenance: unknown;
}): VerifiedPlatformAuthorityPolicyAsset {
  if (!exactProvenance(input.provenance)) drift();
  return deepFreeze({
    byteLength: PLATFORM_AUTHORITY_POLICY_ARTIFACT_BYTES,
    sha256: PLATFORM_AUTHORITY_POLICY_ARTIFACT_SHA256,
    policy: exactPolicy(input.artifact),
    provenance: PLATFORM_AUTHORITY_POLICY_PROVENANCE,
  });
}

const CURRENT_POLICY = verifyPlatformAuthorityPolicyAsset({
  artifact: bundledJson(
    "platform-authority-policy-matrix-v2.json",
    PLATFORM_AUTHORITY_POLICY_ARTIFACT_BYTES,
  ),
  provenance: bundledJson("platform-authority-policy-provenance-v2.json", 2048),
});

/** The unique current product policy. Candidate-v1 remains historical data only. */
export function loadVerifiedPlatformAuthorityPolicyAsset(): VerifiedPlatformAuthorityPolicyAsset {
  return CURRENT_POLICY;
}
