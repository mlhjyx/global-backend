import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { types } from "node:util";

export const PLATFORM_AUTHORITY_POLICY_ARTIFACT_BYTES = 15_996 as const;
export const PLATFORM_AUTHORITY_POLICY_ARTIFACT_SHA256 =
  "84e6a8a1121024dc4232b0eaf16cb84af18626e604db1f01881a9d6af2262fab" as const;
export const PLATFORM_AUTHORITY_POLICY_ARTIFACT_ID =
  "platform-authority-policy-matrix/2026-11-05-reviewed-v3" as const;
export const PLATFORM_AUTHORITY_POLICY_MATRIX_REVISION = "reviewed-v3" as const;
/** Channel-crawl capability section of the reviewed-v3 successor (P4-P2). */
export const PLATFORM_AUTHORITY_CHANNEL_CRAWL_PURPOSE =
  "platform.channel_crawl" as const;

const EXPECTED_ROW_IDS = Object.freeze([
  "platform.acquisition/acq-sweep",
  "platform.acquisition/patents-cache-refresh",
  "platform.intent_watch/intent-sweep",
  "platform.sanctions/sanctions-refresh",
] as const);

export interface PlatformAuthorityPolicyScheduleRowV3 {
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

export interface PlatformAuthorityChannelCrawlSection {
  readonly purpose: typeof PLATFORM_AUTHORITY_CHANNEL_CRAWL_PURPOSE;
  readonly temporal_namespace: "platform-automation";
  readonly default_issuance_state: "DENIED";
  readonly execution_envelope: Readonly<{
    readonly execution_envelope_schema_version: "platform-execution-envelope/v1";
    readonly maximum_pages_per_run: "50";
    readonly maximum_pages_per_channel_per_day: "500";
    readonly preview_pages: "1";
    readonly required_max_runs: "1";
  }>;
}

export interface PlatformAuthorityPolicySuccessorV3 {
  readonly schema_version: "platform-authority-policy-matrix/v3";
  readonly artifact_id: typeof PLATFORM_AUTHORITY_POLICY_ARTIFACT_ID;
  readonly matrix_revision: typeof PLATFORM_AUTHORITY_POLICY_MATRIX_REVISION;
  readonly currency: "USD";
  readonly unit: "microusd";
  readonly predecessor: Readonly<{
    readonly artifact_id: "platform-authority-policy-matrix/2026-09-04-reviewed-v2";
    readonly artifact_sha256: "f9e9591731772f974b087307b5d0365c58c86b501232804c77a20fd3592db01b";
    readonly matrix_revision: "reviewed-v2";
  }>;
  readonly backend_review: Readonly<{
    readonly review_kind: "independent_read_only_diff_review";
    readonly review_verdict: "APPROVE";
    readonly review_scope_base_commit: string;
    readonly review_scope_head_commit: string;
    readonly technical_contract_sha256: "230c0252403f401f35003d3cd3e7d99912ae5689fb84c37bbd50ed624cd9325b";
  }>;
  readonly policy_revision_contract: Readonly<{
    readonly mode: "RECOMPUTE_ACTUAL_RUN_WITH_SUCCESSOR_IDENTITY";
    readonly sample_values_authoritative: false;
    readonly schema_version: "platform-execution-technical-policy/v1";
  }>;
  readonly issuability_requirements: readonly string[];
  /** The four schedule rows stay byte-identical to the reviewed-v2 predecessor. */
  readonly rows: readonly PlatformAuthorityPolicyScheduleRowV3[];
  /** Channel crawl is a per-run capability, deliberately outside the schedule row set. */
  readonly channel_crawl: PlatformAuthorityChannelCrawlSection;
}

export interface PlatformAuthorityPolicyProvenanceV3 {
  readonly schema_version: "growthos-platform-authority-policy-provenance/v3";
  readonly artifact: Readonly<{
    readonly materialized_path: "apps/api/src/platform-authority/platform-authority-policy-matrix-v3.json";
    readonly byte_length: typeof PLATFORM_AUTHORITY_POLICY_ARTIFACT_BYTES;
    readonly sha256: typeof PLATFORM_AUTHORITY_POLICY_ARTIFACT_SHA256;
  }>;
  readonly predecessor: Readonly<{
    readonly materialized_path: "apps/api/src/platform-authority/platform-authority-policy-matrix-v2.json";
    readonly byte_length: 15_583;
    readonly sha256: "f9e9591731772f974b087307b5d0365c58c86b501232804c77a20fd3592db01b";
    readonly artifact_id: "platform-authority-policy-matrix/2026-09-04-reviewed-v2";
    readonly matrix_revision: "reviewed-v2";
    readonly schedule_rows_sha256: "a148e6ea30b7781a52fd4351319c3383641db9f2db9f557adceb13e00cf2d948";
  }>;
  /** The reviewed GrowthOS provenance of the v2 base stays pinned verbatim. */
  readonly base_authority: Readonly<{
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
  readonly successor: Readonly<{
    readonly authorship: "backend_authored_successor";
    readonly decision_ref: "docs/implementation-records/platform-channel-crawl-budget-authority.md";
    readonly change_summary: "adds the channel_crawl capability section; the four schedule rows are byte-identical to the predecessor";
  }>;
}

export interface VerifiedPlatformAuthorityPolicyAsset {
  readonly byteLength: typeof PLATFORM_AUTHORITY_POLICY_ARTIFACT_BYTES;
  readonly sha256: typeof PLATFORM_AUTHORITY_POLICY_ARTIFACT_SHA256;
  readonly policy: PlatformAuthorityPolicySuccessorV3;
  readonly provenance: PlatformAuthorityPolicyProvenanceV3;
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
  schema_version: "growthos-platform-authority-policy-provenance/v3",
  artifact: {
    materialized_path:
      "apps/api/src/platform-authority/platform-authority-policy-matrix-v3.json",
    byte_length: PLATFORM_AUTHORITY_POLICY_ARTIFACT_BYTES,
    sha256: PLATFORM_AUTHORITY_POLICY_ARTIFACT_SHA256,
  },
  predecessor: {
    materialized_path:
      "apps/api/src/platform-authority/platform-authority-policy-matrix-v2.json",
    byte_length: 15_583,
    sha256: "f9e9591731772f974b087307b5d0365c58c86b501232804c77a20fd3592db01b",
    artifact_id: "platform-authority-policy-matrix/2026-09-04-reviewed-v2",
    matrix_revision: "reviewed-v2",
    schedule_rows_sha256:
      "a148e6ea30b7781a52fd4351319c3383641db9f2db9f557adceb13e00cf2d948",
  },
  base_authority: {
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
  successor: {
    authorship: "backend_authored_successor",
    decision_ref:
      "docs/implementation-records/platform-channel-crawl-budget-authority.md",
    change_summary:
      "adds the channel_crawl capability section; the four schedule rows are byte-identical to the predecessor",
  },
} as const);

export const PLATFORM_AUTHORITY_POLICY_PROVENANCE =
  FROZEN_PROVENANCE as PlatformAuthorityPolicyProvenanceV3;

function exactProvenance(value: unknown): boolean {
  try {
    return canonicalJson(value) === canonicalJson(FROZEN_PROVENANCE);
  } catch {
    return false;
  }
}

function exactPolicy(value: unknown): PlatformAuthorityPolicySuccessorV3 {
  const canonical = canonicalJson(value);
  const bytes = Buffer.from(`${canonical}\n`, "utf8");
  if (
    bytes.byteLength !== PLATFORM_AUTHORITY_POLICY_ARTIFACT_BYTES ||
    createHash("sha256").update(bytes).digest("hex") !==
      PLATFORM_AUTHORITY_POLICY_ARTIFACT_SHA256
  ) {
    drift();
  }
  const parsed = JSON.parse(canonical) as PlatformAuthorityPolicySuccessorV3;
  if (
    parsed.schema_version !== "platform-authority-policy-matrix/v3" ||
    parsed.artifact_id !== PLATFORM_AUTHORITY_POLICY_ARTIFACT_ID ||
    parsed.matrix_revision !== PLATFORM_AUTHORITY_POLICY_MATRIX_REVISION ||
    parsed.rows.length !== EXPECTED_ROW_IDS.length ||
    !parsed.rows.every((row, index) => row.row_id === EXPECTED_ROW_IDS[index]) ||
    parsed.backend_review.review_kind !== "independent_read_only_diff_review" ||
    parsed.backend_review.review_verdict !== "APPROVE" ||
    parsed.backend_review.technical_contract_sha256 !==
      "230c0252403f401f35003d3cd3e7d99912ae5689fb84c37bbd50ed624cd9325b"
  ) {
    drift();
  }
  const crawl = parsed.channel_crawl;
  if (
    crawl.purpose !== PLATFORM_AUTHORITY_CHANNEL_CRAWL_PURPOSE ||
    crawl.temporal_namespace !== "platform-automation" ||
    crawl.default_issuance_state !== "DENIED" ||
    crawl.execution_envelope.execution_envelope_schema_version !==
      "platform-execution-envelope/v1" ||
    crawl.execution_envelope.maximum_pages_per_run !== "50" ||
    crawl.execution_envelope.maximum_pages_per_channel_per_day !== "500" ||
    crawl.execution_envelope.preview_pages !== "1" ||
    crawl.execution_envelope.required_max_runs !== "1"
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
    "platform-authority-policy-matrix-v3.json",
    PLATFORM_AUTHORITY_POLICY_ARTIFACT_BYTES,
  ),
  provenance: bundledJson("platform-authority-policy-provenance-v3.json", 4096),
});

/**
 * The unique current product policy (reviewed-v3). Candidate-v1 and reviewed-v2
 * remain historical data: reviewed-v2 is still the byte-exact GrowthOS base the
 * successor's schedule rows are verified against.
 */
export function loadVerifiedPlatformAuthorityPolicyAsset(): VerifiedPlatformAuthorityPolicyAsset {
  return CURRENT_POLICY;
}
