/**
 * Workflow-safe product bounds shared by Platform schedules and the pure
 * technical quote. This module deliberately has no Node, Nest, database,
 * Temporal, Provider, or network import.
 */
export const PLATFORM_ACQUISITION_DUE_SOURCE_MAX = 50 as const;
export const PLATFORM_ACQUISITION_SOURCE_FETCH_ITEM_MAX = 10_000 as const;
export const PLATFORM_INTENT_DUE_SOURCE_MAX = 50 as const;
export const PLATFORM_INTENT_PAGES_PER_SOURCE_MAX = 20 as const;
export const PLATFORM_SANCTIONS_SCHEDULED_SOURCE_KEYS = Object.freeze([
  "ofac_sdn",
  "eu_fsf",
] as const);
export const PLATFORM_SANCTIONS_SOURCE_MAX = 2 as const;
export const PLATFORM_PATENTS_MAX_ANCHORS = 25 as const;
export const PLATFORM_PATENTS_MAXIMUM_BYTES_PER_ANCHOR =
  "214748364800" as const;
export const PLATFORM_TYPED_PROJECTION_MAX_BYTES = 120 * 1024;
export const PLATFORM_CRAWL4AI_ARTIFACT_MAX_BYTES = 3_000_000 as const;
export const PLATFORM_SANCTIONS_ARTIFACT_MAX_BYTES = 33_554_432 as const;
export const PLATFORM_TRADE_FAIR_OUTPUT_ITEM_MAX = 10_000 as const;
export const PLATFORM_MAPYOURSHOW_OUTPUT_ITEM_MAX = 10_000 as const;
export const PLATFORM_PATENTS_OUTPUT_ITEM_MAX = 50 as const;
export const PLATFORM_EXECUTION_ACTIVITY_MAXIMUM_ATTEMPTS = 2 as const;
export const PLATFORM_ALGOLIA_ITEMS_PER_PAGE_MAX = 1_000 as const;
export const PLATFORM_ALGOLIA_PAGES_PER_SOURCE_MAX = 10 as const;
export const PLATFORM_MAPYOURSHOW_WIRES_PER_SOURCE_MAX = 1 as const;
export const PLATFORM_ROBOTS_REDIRECT_MAX = 3 as const;
export const PLATFORM_ROBOTS_RESPONSE_MAX_BYTES = 100_000 as const;
export const PLATFORM_JSON_TRANSPORT_RESPONSE_MAX_BYTES = 5_000_000 as const;
export const PLATFORM_PUBLIC_HTTP_RESPONSE_MAX_BYTES = 33_554_432 as const;
export const PLATFORM_ACQUISITION_ALGOLIA_PHYSICAL_WIRE_MAX =
  PLATFORM_ACQUISITION_DUE_SOURCE_MAX *
  PLATFORM_ALGOLIA_PAGES_PER_SOURCE_MAX;
export const PLATFORM_ACQUISITION_MAPYOURSHOW_PHYSICAL_WIRE_MAX =
  PLATFORM_ACQUISITION_DUE_SOURCE_MAX *
  PLATFORM_MAPYOURSHOW_WIRES_PER_SOURCE_MAX;
export const PLATFORM_INTENT_PAGE_OPERATION_MAX =
  PLATFORM_INTENT_DUE_SOURCE_MAX * PLATFORM_INTENT_PAGES_PER_SOURCE_MAX;
export const PLATFORM_INTENT_ROBOTS_PHYSICAL_WIRE_MAX =
  PLATFORM_INTENT_PAGE_OPERATION_MAX * (PLATFORM_ROBOTS_REDIRECT_MAX + 1);
export const PLATFORM_INTENT_CRAWL_PHYSICAL_WIRE_MAX =
  PLATFORM_INTENT_PAGE_OPERATION_MAX;
export const PLATFORM_INTENT_TOTAL_PHYSICAL_WIRE_MAX =
  PLATFORM_INTENT_ROBOTS_PHYSICAL_WIRE_MAX +
  PLATFORM_INTENT_CRAWL_PHYSICAL_WIRE_MAX;
export const PLATFORM_SANCTIONS_TOTAL_PHYSICAL_WIRE_MAX =
  PLATFORM_SANCTIONS_SOURCE_MAX * (PLATFORM_ROBOTS_REDIRECT_MAX + 1);
const PLATFORM_EXECUTION_ACTIVITY_MAXIMUM_ATTEMPTS_TEXT = "2" as const;

export type PlatformExecutionScheduleId =
  | "acq-sweep"
  | "patents-cache-refresh"
  | "intent-sweep"
  | "sanctions-refresh";

export type PlatformExecutionPurpose =
  | "platform.acquisition"
  | "platform.intent_watch"
  | "platform.sanctions";

export interface PlatformExecutionHardBoundsV1 {
  readonly maximumPhysicalInvocations: string;
  readonly maximumCostedInvocations: string;
  readonly maximumDueSources: string;
  readonly maximumSourceFetchItems: string;
  readonly maximumPagesPerSource: string;
  readonly maximumSanctionsSources: string;
  readonly maximumPatentAnchors: string;
  readonly maximumBytesPerPatentAnchor: string;
  readonly maximumOutputItemsPerWire: string;
  readonly maximumTransportResponseBytesPerWire: string;
  readonly maximumDurableResultBytes: string;
  readonly maximumRedirectsPerOperation: string;
  readonly maximumRepairWires: string;
  readonly maximumFallbackWires: string;
  readonly maximumInputTokens: string;
  readonly maximumOutputTokens: string;
}

export interface PlatformExecutionToolContractV1 {
  readonly toolId: PlatformExecutionToolId;
  readonly version: string;
  readonly estimatedCents: string;
  readonly costUnit: "call" | "page";
  readonly maximumPhysicalInvocations: string;
  readonly maximumCostedInvocations: string;
  readonly resultStrategy: "typed_projection" | "artifact_reference";
  readonly resultSchema:
    | "tradefair-algolia/v1"
    | "mapyourshow-fetch/v1"
    | "google-patents-search/v1"
    | "crawl4ai-render/v1"
    | "sanctions-download/v1";
  readonly maximumOutputItems: string;
  readonly maximumTransportResponseBytes: string;
  readonly maximumDurableResultBytes: string;
}

export interface PlatformExecutionPhysicalWireContractV1 {
  readonly wireId: string;
  readonly maximumParentOperations: string;
  readonly maximumWiresPerOperation: string;
  readonly maximumPhysicalInvocations: string;
  readonly maximumRedirectsPerOperation: string;
  readonly maximumItemsPerWire: string;
  readonly maximumTransportResponseBytes: string;
}

export interface PlatformExecutionProviderRequirementV1 {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly requiredEnablement: "ENABLED" | "DISABLED";
  readonly metering: "per_call" | "bytes";
  readonly bytePriceCatalogRequired: "0" | "1";
}

export interface PlatformExecutionTechnicalRowV1 {
  readonly rowId: string;
  readonly purpose: PlatformExecutionPurpose;
  readonly temporalNamespace: "platform-automation";
  readonly scheduleId: PlatformExecutionScheduleId;
  readonly workflowType: string;
  readonly taskQueue: "understanding";
  readonly scheduleRequestSha256: string;
  readonly maximumActivityAttempts: "2";
  readonly costMode:
    | "zero_paid_dispatch"
    | "tool_estimated_cents"
    | "disabled_no_egress";
  readonly physicalWireSelection:
    | "one_source_provider_per_due_source"
    | "all_declared_wires"
    | "disabled_no_egress";
  readonly physicalWireContracts: readonly PlatformExecutionPhysicalWireContractV1[];
  readonly providerRequirements: readonly PlatformExecutionProviderRequirementV1[];
  readonly toolContracts: readonly PlatformExecutionToolContractV1[];
  readonly hardBounds: PlatformExecutionHardBoundsV1;
}

export interface PlatformExecutionTechnicalContractV1 {
  readonly schemaVersion: "platform-execution-contract/v1";
  readonly executionEnvelopeSchemaVersion: "platform-execution-envelope/v1";
  readonly requestContractVersion: "platform-schedule-authority-v1";
  readonly quoteTtlSeconds: "300";
  readonly currency: "USD";
  readonly unit: "microusd";
  readonly microUsdPerCent: "10000";
  readonly representationMinimumMicrousd: "1";
  readonly rows: readonly PlatformExecutionTechnicalRowV1[];
}

export interface PlatformExecutionProviderSnapshotEntryV1 {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly enablement: "ENABLED" | "DISABLED";
  readonly bytePriceCatalogRevision: string | null;
}

export interface PlatformExecutionProviderSnapshotV1 {
  readonly schemaVersion: "platform-execution-provider-snapshot/v1";
  readonly scheduleId: PlatformExecutionScheduleId;
  readonly providers: readonly PlatformExecutionProviderSnapshotEntryV1[];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function technicalRow<const T extends PlatformExecutionTechnicalRowV1>(
  value: T,
): T {
  return deepFreeze(value);
}

const ZERO_NON_APPLICABLE_BOUNDS = Object.freeze({
  maximumRepairWires: "0",
  maximumFallbackWires: "0",
  maximumInputTokens: "0",
  maximumOutputTokens: "0",
} as const);

export const PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1 = deepFreeze({
  schemaVersion: "platform-execution-contract/v1",
  executionEnvelopeSchemaVersion: "platform-execution-envelope/v1",
  requestContractVersion: "platform-schedule-authority-v1",
  quoteTtlSeconds: "300",
  currency: "USD",
  unit: "microusd",
  microUsdPerCent: "10000",
  representationMinimumMicrousd: "1",
  rows: [
    technicalRow({
      rowId: "platform.acquisition/acq-sweep",
      purpose: "platform.acquisition",
      temporalNamespace: "platform-automation",
      scheduleId: "acq-sweep",
      workflowType: "acquisitionSweepWorkflow",
      taskQueue: "understanding",
      scheduleRequestSha256:
        "5e960ccef72129aa32bdd9464c9d7b546e5ed6dd7a639caad46df77edea3448e",
      maximumActivityAttempts: PLATFORM_EXECUTION_ACTIVITY_MAXIMUM_ATTEMPTS_TEXT,
      costMode: "zero_paid_dispatch",
      physicalWireSelection: "one_source_provider_per_due_source",
      physicalWireContracts: [
        {
          wireId: "tradefair.algolia.page",
          maximumParentOperations: "50",
          maximumWiresPerOperation: "10",
          maximumPhysicalInvocations: "500",
          maximumRedirectsPerOperation: "0",
          maximumItemsPerWire: "1000",
          maximumTransportResponseBytes: "5000000",
        },
        {
          wireId: "mapyourshow.fetch",
          maximumParentOperations: "50",
          maximumWiresPerOperation: "1",
          maximumPhysicalInvocations: "50",
          maximumRedirectsPerOperation: "0",
          maximumItemsPerWire: "10000",
          maximumTransportResponseBytes: "5000000",
        },
      ],
      providerRequirements: [
        {
          providerId: "tradefair.algolia",
          providerVersion: "1.0.0",
          requiredEnablement: "ENABLED",
          metering: "per_call",
          bytePriceCatalogRequired: "0",
        },
        {
          providerId: "mapyourshow.fetch",
          providerVersion: "1.0.0",
          requiredEnablement: "ENABLED",
          metering: "per_call",
          bytePriceCatalogRequired: "0",
        },
      ],
      toolContracts: [
        {
          toolId: "tradefair.algolia",
          version: "1.0.0",
          estimatedCents: "0",
          costUnit: "call",
          maximumPhysicalInvocations: "500",
          maximumCostedInvocations: "50",
          resultStrategy: "typed_projection",
          resultSchema: "tradefair-algolia/v1",
          maximumOutputItems: "10000",
          maximumTransportResponseBytes: "5000000",
          maximumDurableResultBytes: "122880",
        },
        {
          toolId: "mapyourshow.fetch",
          version: "1.0.0",
          estimatedCents: "0",
          costUnit: "call",
          maximumPhysicalInvocations: "50",
          maximumCostedInvocations: "50",
          resultStrategy: "typed_projection",
          resultSchema: "mapyourshow-fetch/v1",
          maximumOutputItems: "10000",
          maximumTransportResponseBytes: "5000000",
          maximumDurableResultBytes: "122880",
        },
      ],
      hardBounds: {
        ...ZERO_NON_APPLICABLE_BOUNDS,
        maximumPhysicalInvocations: "500",
        maximumCostedInvocations: "50",
        maximumDueSources: "50",
        maximumSourceFetchItems: "10000",
        maximumPagesPerSource: "0",
        maximumSanctionsSources: "0",
        maximumPatentAnchors: "0",
        maximumBytesPerPatentAnchor: "0",
        maximumOutputItemsPerWire: "10000",
        maximumTransportResponseBytesPerWire: "5000000",
        maximumDurableResultBytes: "122880",
        maximumRedirectsPerOperation: "0",
      },
    }),
    technicalRow({
      rowId: "platform.acquisition/patents-cache-refresh",
      purpose: "platform.acquisition",
      temporalNamespace: "platform-automation",
      scheduleId: "patents-cache-refresh",
      workflowType: "patentsCacheRefreshWorkflow",
      taskQueue: "understanding",
      scheduleRequestSha256:
        "3fbcd9326937d66243f1395d3f0c4f098c6748977d00ae90017d0f8f04202db6",
      maximumActivityAttempts: PLATFORM_EXECUTION_ACTIVITY_MAXIMUM_ATTEMPTS_TEXT,
      costMode: "disabled_no_egress",
      physicalWireSelection: "disabled_no_egress",
      physicalWireContracts: [
        {
          wireId: "google_patents.bigquery",
          maximumParentOperations: "0",
          maximumWiresPerOperation: "0",
          maximumPhysicalInvocations: "0",
          maximumRedirectsPerOperation: "0",
          maximumItemsPerWire: "0",
          maximumTransportResponseBytes: "0",
        },
      ],
      providerRequirements: [
        {
          providerId: "google_patents",
          providerVersion: "1.0.0",
          requiredEnablement: "DISABLED",
          metering: "bytes",
          bytePriceCatalogRequired: "1",
        },
      ],
      toolContracts: [
        {
          toolId: "google_patents.search",
          version: "1.0.0",
          estimatedCents: "0",
          costUnit: "call",
          maximumPhysicalInvocations: "0",
          maximumCostedInvocations: "0",
          resultStrategy: "typed_projection",
          resultSchema: "google-patents-search/v1",
          maximumOutputItems: "50",
          maximumTransportResponseBytes: "0",
          maximumDurableResultBytes: "122880",
        },
      ],
      hardBounds: {
        ...ZERO_NON_APPLICABLE_BOUNDS,
        maximumPhysicalInvocations: "0",
        maximumCostedInvocations: "0",
        maximumDueSources: "0",
        maximumSourceFetchItems: "0",
        maximumPagesPerSource: "0",
        maximumSanctionsSources: "0",
        maximumPatentAnchors: "25",
        maximumBytesPerPatentAnchor: "214748364800",
        maximumOutputItemsPerWire: "50",
        maximumTransportResponseBytesPerWire: "0",
        maximumDurableResultBytes: "122880",
        maximumRedirectsPerOperation: "0",
      },
    }),
    technicalRow({
      rowId: "platform.intent_watch/intent-sweep",
      purpose: "platform.intent_watch",
      temporalNamespace: "platform-automation",
      scheduleId: "intent-sweep",
      workflowType: "intentSweepWorkflow",
      taskQueue: "understanding",
      scheduleRequestSha256:
        "9ef4afce408c36472e00db01a80b6e3a3e461a2b13af7f456d9ce31a7676c34a",
      maximumActivityAttempts: PLATFORM_EXECUTION_ACTIVITY_MAXIMUM_ATTEMPTS_TEXT,
      costMode: "tool_estimated_cents",
      physicalWireSelection: "all_declared_wires",
      physicalWireContracts: [
        {
          wireId: "robots.public_http",
          maximumParentOperations: "1000",
          maximumWiresPerOperation: "4",
          maximumPhysicalInvocations: "4000",
          maximumRedirectsPerOperation: "3",
          maximumItemsPerWire: "0",
          maximumTransportResponseBytes: "100000",
        },
        {
          wireId: "crawl4ai.render.dispatch",
          maximumParentOperations: "1000",
          maximumWiresPerOperation: "1",
          maximumPhysicalInvocations: "1000",
          maximumRedirectsPerOperation: "0",
          maximumItemsPerWire: "0",
          maximumTransportResponseBytes: "5000000",
        },
      ],
      providerRequirements: [
        {
          providerId: "crawl4ai.render",
          providerVersion: "1.0.0",
          requiredEnablement: "ENABLED",
          metering: "per_call",
          bytePriceCatalogRequired: "0",
        },
      ],
      toolContracts: [
        {
          toolId: "crawl4ai.render",
          version: "1.0.0",
          estimatedCents: "1",
          costUnit: "page",
          maximumPhysicalInvocations: "5000",
          maximumCostedInvocations: "1000",
          resultStrategy: "artifact_reference",
          resultSchema: "crawl4ai-render/v1",
          maximumOutputItems: "0",
          maximumTransportResponseBytes: "5000000",
          maximumDurableResultBytes: "3000000",
        },
      ],
      hardBounds: {
        ...ZERO_NON_APPLICABLE_BOUNDS,
        maximumPhysicalInvocations: "5000",
        maximumCostedInvocations: "1000",
        maximumDueSources: "50",
        maximumSourceFetchItems: "0",
        maximumPagesPerSource: "20",
        maximumSanctionsSources: "0",
        maximumPatentAnchors: "0",
        maximumBytesPerPatentAnchor: "0",
        maximumOutputItemsPerWire: "0",
        maximumTransportResponseBytesPerWire: "5000000",
        maximumDurableResultBytes: "3000000",
        maximumRedirectsPerOperation: "3",
      },
    }),
    technicalRow({
      rowId: "platform.sanctions/sanctions-refresh",
      purpose: "platform.sanctions",
      temporalNamespace: "platform-automation",
      scheduleId: "sanctions-refresh",
      workflowType: "sanctionsRefreshWorkflow",
      taskQueue: "understanding",
      scheduleRequestSha256:
        "50b8dfae274bb16a825147c648f46789ea0eb291b3d32964c8bacf385340dffe",
      maximumActivityAttempts: PLATFORM_EXECUTION_ACTIVITY_MAXIMUM_ATTEMPTS_TEXT,
      costMode: "zero_paid_dispatch",
      physicalWireSelection: "all_declared_wires",
      physicalWireContracts: [
        {
          wireId: "sanctions.public_http",
          maximumParentOperations: "2",
          maximumWiresPerOperation: "4",
          maximumPhysicalInvocations: "8",
          maximumRedirectsPerOperation: "3",
          maximumItemsPerWire: "0",
          maximumTransportResponseBytes: "33554432",
        },
      ],
      providerRequirements: [
        {
          providerId: "ofac_sdn",
          providerVersion: "1.0.0",
          requiredEnablement: "ENABLED",
          metering: "per_call",
          bytePriceCatalogRequired: "0",
        },
        {
          providerId: "eu_fsf",
          providerVersion: "1.0.0",
          requiredEnablement: "ENABLED",
          metering: "per_call",
          bytePriceCatalogRequired: "0",
        },
      ],
      toolContracts: [
        {
          toolId: "sanctions.download",
          version: "1.0.0",
          estimatedCents: "0",
          costUnit: "call",
          maximumPhysicalInvocations: "8",
          maximumCostedInvocations: "2",
          resultStrategy: "artifact_reference",
          resultSchema: "sanctions-download/v1",
          maximumOutputItems: "0",
          maximumTransportResponseBytes: "33554432",
          maximumDurableResultBytes: "33554432",
        },
      ],
      hardBounds: {
        ...ZERO_NON_APPLICABLE_BOUNDS,
        maximumPhysicalInvocations: "8",
        maximumCostedInvocations: "2",
        maximumDueSources: "0",
        maximumSourceFetchItems: "0",
        maximumPagesPerSource: "0",
        maximumSanctionsSources: "2",
        maximumPatentAnchors: "0",
        maximumBytesPerPatentAnchor: "0",
        maximumOutputItemsPerWire: "0",
        maximumTransportResponseBytesPerWire: "33554432",
        maximumDurableResultBytes: "33554432",
        maximumRedirectsPerOperation: "3",
      },
    }),
  ],
} satisfies PlatformExecutionTechnicalContractV1);

export type PlatformExecutionToolId =
  | "tradefair.algolia"
  | "mapyourshow.fetch"
  | "google_patents.search"
  | "crawl4ai.render"
  | "sanctions.download";

export function platformExecutionToolContract<const T extends PlatformExecutionToolId>(
  toolId: T,
): Extract<
  (typeof PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1.rows)[number]["toolContracts"][number],
  { readonly toolId: T }
> {
  const matches = PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1.rows.flatMap(
    (row) => row.toolContracts.filter((tool) => tool.toolId === toolId),
  );
  if (matches.length !== 1) throw new PlatformExecutionContractError();
  return matches[0]! as Extract<
    (typeof PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1.rows)[number]["toolContracts"][number],
    { readonly toolId: T }
  >;
}

export function platformExecutionTechnicalRow(
  scheduleId: PlatformExecutionScheduleId,
): PlatformExecutionTechnicalRowV1 {
  const row = PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1.rows.find(
    (candidate) => candidate.scheduleId === scheduleId,
  );
  if (!row) throw new PlatformExecutionContractError();
  return row;
}

export class PlatformExecutionContractError extends Error {
  readonly code = "PLATFORM_EXECUTION_CONTRACT_INVALID" as const;

  constructor() {
    super("PLATFORM_EXECUTION_CONTRACT_INVALID");
    this.name = "PlatformExecutionContractError";
  }
}

export function boundedPlatformDueSourceLimit(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? Math.min(value as number, PLATFORM_ACQUISITION_DUE_SOURCE_MAX)
    : PLATFORM_ACQUISITION_DUE_SOURCE_MAX;
}

export function boundedPlatformIntentDueSourceLimit(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? Math.min(value as number, PLATFORM_INTENT_DUE_SOURCE_MAX)
    : PLATFORM_INTENT_DUE_SOURCE_MAX;
}

export function boundedPlatformAcquisitionFetchLimit(value: unknown): number {
  if (value === undefined) return PLATFORM_ACQUISITION_SOURCE_FETCH_ITEM_MAX;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PlatformExecutionContractError();
  }
  return Math.min(
    value as number,
    PLATFORM_ACQUISITION_SOURCE_FETCH_ITEM_MAX,
  );
}
