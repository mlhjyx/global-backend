import { createHash } from "node:crypto";
import { types } from "node:util";

import {
  PLATFORM_EXECUTION_TECHNICAL_QUOTE_HASH_PREIMAGE_SCHEMA_V1,
  PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA_V1,
  canonicalizePlatformAuthorityRequestBodyV1,
} from "@global/contracts/platform-authority";

import {
  loadVerifiedPlatformAuthorityPolicyAsset,
  type VerifiedPlatformAuthorityPolicyAsset,
} from "./platform-authority-policy-asset";
import {
  isCodeOwnedPlatformExecutionProviderSnapshotV1,
  type PlatformExecutionHardBoundsV1,
  type PlatformExecutionProviderSnapshotV1,
  type PlatformExecutionTechnicalContractV1,
  type PlatformExecutionTechnicalRowV1,
} from "./platform-execution-contract";

export const PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA =
  "platform-execution-technical-quote/v1" as const;
export const PLATFORM_EXECUTION_TECHNICAL_CONTRACT_SHA256 =
  "230c0252403f401f35003d3cd3e7d99912ae5689fb84c37bbd50ed624cd9325b" as const;

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const MAX_NUMERIC_DATE = 253_402_300_799;
const SHA256 = /^[0-9a-f]{64}$/;
const LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CONTROL_CHARACTER = /\p{Cc}/u;
const DATE_GET_TIME = Date.prototype.getTime;
const INPUT_KEYS = [
  "purpose",
  "scheduleId",
  "workflowType",
  "workflowId",
  "workflowRunId",
  "scheduleRequestSha256",
  "now",
  "providerSnapshot",
] as const;

export type PlatformExecutionTechnicalQuoteErrorCode =
  | "PLATFORM_EXECUTION_BUDGET_QUOTE_INVALID"
  | "PLATFORM_EXECUTION_BUDGET_QUOTE_UNAVAILABLE"
  | "PLATFORM_EXECUTION_BUDGET_POLICY_DRIFT";

export class PlatformExecutionTechnicalQuoteError extends Error {
  constructor(public readonly code: PlatformExecutionTechnicalQuoteErrorCode) {
    super(code);
    this.name = "PlatformExecutionTechnicalQuoteError";
  }
}

export interface PlatformExecutionTechnicalQuoteInput {
  readonly purpose: string;
  readonly scheduleId: string;
  readonly workflowType: string;
  readonly workflowId: string;
  readonly workflowRunId: string;
  readonly scheduleRequestSha256: string;
  readonly now: Date;
  readonly providerSnapshot: PlatformExecutionProviderSnapshotV1;
}

export interface PlatformExecutionTechnicalQuoteV1 {
  readonly schema_version: typeof PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA;
  readonly quote_id: string;
  readonly quote_sha256: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly purpose: string;
  readonly temporal_namespace: "platform-automation";
  readonly schedule_id: string;
  readonly workflow_type: string;
  readonly workflow_id: string;
  readonly workflow_run_id: string;
  readonly schedule_request_sha256: string;
  readonly required_cap_per_run_microusd: string;
  readonly required_max_runs: "1";
  readonly required_campaign_cap_microusd: string;
  readonly policy_revision: string;
  readonly policy_artifact_id: string;
  readonly policy_artifact_sha256: string;
  readonly policy_matrix_revision: string;
  readonly request_contract_version: "platform-schedule-authority-v1";
  readonly execution_envelope_schema_version: "platform-execution-envelope/v1";
  readonly execution_envelope_sha256: string;
  readonly tool_contracts_sha256: string;
  readonly provider_snapshot_sha256: string;
  readonly price_catalog_revision: string;
  readonly hard_bounds_sha256: string;
  readonly maximum_activity_attempts: string;
  readonly maximum_physical_invocations: string;
  readonly maximum_costed_invocations: string;
  readonly maximum_due_sources: string;
  readonly maximum_source_fetch_items: string;
  readonly maximum_pages_per_source: string;
  readonly maximum_sanctions_sources: string;
  readonly maximum_patent_anchors: string;
  readonly maximum_bytes_per_patent_anchor: string;
  readonly maximum_output_items_per_wire: string;
  readonly maximum_transport_response_bytes_per_wire: string;
  readonly maximum_durable_result_bytes: string;
  readonly maximum_redirects_per_operation: string;
  readonly maximum_repair_wires: string;
  readonly maximum_fallback_wires: string;
  readonly maximum_input_tokens: string;
  readonly maximum_output_tokens: string;
  readonly physical_wire_contracts_sha256: string;
  readonly physical_wire_selection: string;
}

interface QuoteDependencies {
  readonly policyAsset: VerifiedPlatformAuthorityPolicyAsset;
  readonly technicalContract: PlatformExecutionTechnicalContractV1;
}

function invalid(): never {
  throw new PlatformExecutionTechnicalQuoteError(
    "PLATFORM_EXECUTION_BUDGET_QUOTE_INVALID",
  );
}

function unavailable(): never {
  throw new PlatformExecutionTechnicalQuoteError(
    "PLATFORM_EXECUTION_BUDGET_QUOTE_UNAVAILABLE",
  );
}

function policyDrift(): never {
  throw new PlatformExecutionTechnicalQuoteError(
    "PLATFORM_EXECUTION_BUDGET_POLICY_DRIFT",
  );
}

function ownDataSnapshot(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return invalid();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
      Object.keys(descriptors).sort().join("\0") !==
        [...expectedKeys].sort().join("\0")
    ) {
      return invalid();
    }
    const snapshot: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return invalid();
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return invalid();
  }
}

function canonicalJson(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (value !== value.normalize("NFC") || CONTROL_CHARACTER.test(value)) {
      return policyDrift();
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && !Object.is(value, -0)
      ? JSON.stringify(value)
      : policyDrift();
  }
  if (typeof value !== "object" || types.isProxy(value) || seen.has(value)) {
    return policyDrift();
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return policyDrift();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (
        Reflect.ownKeys(descriptors).some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)),
        )
      ) {
        return policyDrift();
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          return policyDrift();
        }
        items.push(canonicalJson(descriptor.value, seen));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return policyDrift();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
      return policyDrift();
    }
    const entries: string[] = [];
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        key !== key.normalize("NFC") ||
        CONTROL_CHARACTER.test(key)
      ) {
        return policyDrift();
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

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function uuidFromDigest(value: string): string {
  const characters = value.slice(0, 32).split("");
  characters[12] = "5";
  characters[16] = (8 + (Number.parseInt(characters[16]!, 16) & 3)).toString(
    16,
  );
  const joined = characters.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function validatePolicyAsset(
  input: VerifiedPlatformAuthorityPolicyAsset,
): VerifiedPlatformAuthorityPolicyAsset {
  const expected = loadVerifiedPlatformAuthorityPolicyAsset();
  if (digest(input) !== digest(expected)) return policyDrift();
  return input;
}

function validateContract(
  input: PlatformExecutionTechnicalContractV1,
): PlatformExecutionTechnicalContractV1 {
  if (digest(input) !== PLATFORM_EXECUTION_TECHNICAL_CONTRACT_SHA256) {
    return policyDrift();
  }
  return input;
}

function validateProviderSnapshot(
  row: PlatformExecutionTechnicalRowV1,
  input: unknown,
): PlatformExecutionProviderSnapshotV1 {
  if (!isCodeOwnedPlatformExecutionProviderSnapshotV1(input)) {
    return unavailable();
  }
  if (
    input.scheduleId !== row.scheduleId ||
    input.providers.length !== row.providerRequirements.length
  ) {
    return unavailable();
  }
  for (let index = 0; index < row.providerRequirements.length; index += 1) {
    const required = row.providerRequirements[index]!;
    const observed = input.providers[index]!;
    if (
      observed.providerId !== required.providerId ||
      observed.providerVersion !== required.providerVersion ||
      observed.enablement !== required.requiredEnablement
    ) {
      return unavailable();
    }
    if (
      required.metering === "per_call" &&
      observed.bytePriceCatalogRevision !== null
    ) {
      return unavailable();
    }
    if (
      required.metering === "bytes" &&
      (observed.enablement !== "DISABLED" ||
        observed.bytePriceCatalogRevision !== null)
    ) {
      return unavailable();
    }
  }
  return input;
}

function requiredCapMicrousd(row: PlatformExecutionTechnicalRowV1): string {
  let cents = 0n;
  if (row.costMode !== "disabled_no_egress") {
    for (const tool of row.toolContracts) {
      cents +=
        BigInt(tool.estimatedCents) *
        BigInt(tool.maximumCostedInvocations);
    }
  }
  if (
    row.costMode === "zero_paid_dispatch" &&
    row.toolContracts.some((tool) => tool.estimatedCents !== "0")
  ) {
    return policyDrift();
  }
  const cap = cents * 10_000n;
  const bounded = cap > 0n ? cap : 1n;
  if (bounded > POSTGRES_BIGINT_MAX) return policyDrift();
  return bounded.toString();
}

function quoteBounds(bounds: PlatformExecutionHardBoundsV1) {
  return {
    maximum_physical_invocations: bounds.maximumPhysicalInvocations,
    maximum_costed_invocations: bounds.maximumCostedInvocations,
    maximum_due_sources: bounds.maximumDueSources,
    maximum_source_fetch_items: bounds.maximumSourceFetchItems,
    maximum_pages_per_source: bounds.maximumPagesPerSource,
    maximum_sanctions_sources: bounds.maximumSanctionsSources,
    maximum_patent_anchors: bounds.maximumPatentAnchors,
    maximum_bytes_per_patent_anchor: bounds.maximumBytesPerPatentAnchor,
    maximum_output_items_per_wire: bounds.maximumOutputItemsPerWire,
    maximum_transport_response_bytes_per_wire:
      bounds.maximumTransportResponseBytesPerWire,
    maximum_durable_result_bytes: bounds.maximumDurableResultBytes,
    maximum_redirects_per_operation: bounds.maximumRedirectsPerOperation,
    maximum_repair_wires: bounds.maximumRepairWires,
    maximum_fallback_wires: bounds.maximumFallbackWires,
    maximum_input_tokens: bounds.maximumInputTokens,
    maximum_output_tokens: bounds.maximumOutputTokens,
  } as const;
}

/**
 * Pure Platform quote projection: all inputs are immutable in-memory facts and
 * the implementation has no database, Temporal, storage, Provider, billing,
 * or network dependency.
 */
export class PlatformExecutionTechnicalQuoteService {
  constructor(private readonly dependencies: QuoteDependencies) {}

  quote(rawInput: PlatformExecutionTechnicalQuoteInput): PlatformExecutionTechnicalQuoteV1 {
    const policyAsset = validatePolicyAsset(this.dependencies.policyAsset);
    const technicalContract = validateContract(
      this.dependencies.technicalContract,
    );
    const input = ownDataSnapshot(rawInput, INPUT_KEYS);
    const scheduleId = input.scheduleId;
    const row = technicalContract.rows.find(
      (candidate) => candidate.scheduleId === scheduleId,
    );
    if (!row) return invalid();
    const workflowId = input.workflowId;
    const workflowRunId = input.workflowRunId;
    const scheduleRequestSha256 = input.scheduleRequestSha256;
    if (
      input.purpose !== row.purpose ||
      input.workflowType !== row.workflowType ||
      typeof workflowId !== "string" ||
      !WORKFLOW_ID.test(workflowId) ||
      typeof workflowRunId !== "string" ||
      !LOWERCASE_UUID.test(workflowRunId) ||
      scheduleRequestSha256 !== row.scheduleRequestSha256 ||
      typeof scheduleRequestSha256 !== "string" ||
      !SHA256.test(scheduleRequestSha256)
    ) {
      return invalid();
    }
    const now = input.now;
    let nowMilliseconds: number;
    try {
      if (Object.getPrototypeOf(now) !== Date.prototype) return invalid();
      nowMilliseconds = DATE_GET_TIME.call(now) as number;
    } catch {
      return invalid();
    }
    if (!Number.isFinite(nowMilliseconds)) {
      return invalid();
    }
    const issuedAt = Math.floor(nowMilliseconds / 1_000);
    const expiresAt = issuedAt + Number(technicalContract.quoteTtlSeconds);
    if (
      issuedAt < 0 ||
      !Number.isSafeInteger(issuedAt) ||
      expiresAt > MAX_NUMERIC_DATE
    ) {
      return invalid();
    }

    const policyRow = policyAsset.policy.rows.find(
      (candidate) => candidate.backend_source_anchor.schedule_id === row.scheduleId,
    );
    if (
      !policyRow ||
      policyRow.row_id !== row.rowId ||
      policyRow.backend_source_anchor.request_sha256 !==
        row.scheduleRequestSha256 ||
      policyRow.backend_source_anchor.workflow_type_symbol !== row.workflowType ||
      policyRow.backend_source_anchor.task_queue_symbol !== row.taskQueue ||
      policyRow.desired_growthos_policy.namespace !== row.temporalNamespace ||
      policyRow.desired_growthos_policy.schedule_id !== row.scheduleId ||
      policyRow.desired_growthos_policy.workflow_type !== row.workflowType ||
      policyRow.desired_growthos_policy.task_queue !== row.taskQueue
    ) {
      return policyDrift();
    }

    const providerSnapshot = validateProviderSnapshot(
      row,
      input.providerSnapshot,
    );
    const toolContractsSha256 = digest(row.toolContracts);
    const providerSnapshotSha256 = digest(providerSnapshot);
    const hardBoundsSha256 = digest(row.hardBounds);
    const physicalWireContractsSha256 = digest(row.physicalWireContracts);
    const priceCatalog = {
      schemaVersion: "platform-execution-price-catalog/v1",
      toolPrices: row.toolContracts.map((tool) => ({
        toolId: tool.toolId,
        version: tool.version,
        estimatedCents: tool.estimatedCents,
        costUnit: tool.costUnit,
      })),
      providerBytePrices: providerSnapshot.providers.map((provider) => ({
        providerId: provider.providerId,
        providerVersion: provider.providerVersion,
        enablement: provider.enablement,
        bytePriceCatalogRevision: provider.bytePriceCatalogRevision,
      })),
    } as const;
    const priceCatalogRevision = digest(priceCatalog);
    const executionEnvelope = {
      schemaVersion: technicalContract.executionEnvelopeSchemaVersion,
      contractSha256: PLATFORM_EXECUTION_TECHNICAL_CONTRACT_SHA256,
      row,
      providerSnapshot,
      priceCatalogRevision,
    } as const;
    const executionEnvelopeSha256 = digest(executionEnvelope);
    const artifact = {
      id: policyAsset.policy.artifact_id,
      sha: policyAsset.sha256,
      revision: policyAsset.policy.matrix_revision,
    } as const;
    const policyRevision = digest({
      schemaVersion: "platform-execution-technical-policy/v1",
      binding: {
        purpose: row.purpose,
        temporalNamespace: row.temporalNamespace,
        scheduleId: row.scheduleId,
        workflowType: row.workflowType,
        workflowId,
        workflowRunId,
        scheduleRequestSha256,
      },
      executionEnvelope,
      artifact,
    });
    const issuedAtText = String(issuedAt);
    const quoteId = uuidFromDigest(
      digest({
        schemaVersion: "platform-execution-technical-quote-id/v1",
        issuedAt: issuedAtText,
        policyRevision,
        purpose: row.purpose,
        scheduleId: row.scheduleId,
        scheduleRequestSha256,
        workflowId,
        workflowRunId,
      }),
    );
    const requiredCap = requiredCapMicrousd(row);
    const preimage = Object.freeze({
      schema_version: PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA,
      quote_id: quoteId,
      issued_at: issuedAtText,
      expires_at: String(expiresAt),
      purpose: row.purpose,
      temporal_namespace: row.temporalNamespace,
      schedule_id: row.scheduleId,
      workflow_type: row.workflowType,
      workflow_id: workflowId,
      workflow_run_id: workflowRunId,
      schedule_request_sha256: scheduleRequestSha256,
      required_cap_per_run_microusd: requiredCap,
      required_max_runs: "1" as const,
      required_campaign_cap_microusd: requiredCap,
      policy_revision: policyRevision,
      policy_artifact_id: artifact.id,
      policy_artifact_sha256: artifact.sha,
      policy_matrix_revision: artifact.revision,
      request_contract_version: technicalContract.requestContractVersion,
      execution_envelope_schema_version:
        technicalContract.executionEnvelopeSchemaVersion,
      execution_envelope_sha256: executionEnvelopeSha256,
      tool_contracts_sha256: toolContractsSha256,
      provider_snapshot_sha256: providerSnapshotSha256,
      price_catalog_revision: priceCatalogRevision,
      hard_bounds_sha256: hardBoundsSha256,
      physical_wire_contracts_sha256: physicalWireContractsSha256,
      physical_wire_selection: row.physicalWireSelection,
      maximum_activity_attempts: row.maximumActivityAttempts,
      ...quoteBounds(row.hardBounds),
    });
    const canonicalPreimage = canonicalizePlatformAuthorityRequestBodyV1({
      contentType: "application/json",
      rawBody: Buffer.from(JSON.stringify(preimage), "utf8"),
      schema: PLATFORM_EXECUTION_TECHNICAL_QUOTE_HASH_PREIMAGE_SCHEMA_V1,
    });
    const quote = Object.freeze({
      ...preimage,
      quote_sha256: createHash("sha256")
        .update(canonicalPreimage.canonicalBodyUtf8, "utf8")
        .digest("hex"),
    });
    canonicalizePlatformAuthorityRequestBodyV1({
      contentType: "application/json",
      rawBody: Buffer.from(JSON.stringify(quote), "utf8"),
      schema: PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA_V1,
    });
    return quote;
  }
}
