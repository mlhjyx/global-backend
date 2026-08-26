import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  prepareRawSourceBatch,
  type PreparedRawSourceRow,
  type RawSourcePolicySnapshot,
} from "../discovery/raw-source-ingestion";
import { persistPreparedRawSourceRecord } from "../discovery/raw-source-writer";

type JsonRecord = Record<string, unknown>;

export interface MonitoredSourceBridgeSource {
  id: string;
  sourceKey: string;
  providerKey: string;
  config: unknown;
}

export interface MonitoredSourceBridgeEntity {
  id: string;
  externalId: string;
  name: string;
  domain: string | null;
  country: string | null;
  cleaned: unknown;
  contentHash: string;
  lastSeenAt: Date | null;
  lastSeenFetchId: string | null;
}

export interface MonitoredSourceBridgeFetch {
  id: string;
  sourceId: string;
  status: string;
  parserVersion: string | null;
  finishedAt: Date | null;
}

export type MonitoredSourceBridgePolicy = RawSourcePolicySnapshot & {
  allowedPurpose?: unknown;
};

export interface PreparedMonitoredSourceRawBridge {
  identityProviderKey: "trade_fair";
  license: "SOURCE_SPECIFIC_RESTRICTED";
  sourceClass: "industry_data";
  row: PreparedRawSourceRow;
  uniqueWhere: {
    workspaceId: string;
    sourceEntityId: string;
    ingestKey: string;
  };
}

export class MonitoredSourceRawBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MonitoredSourceRawBridgeError";
  }
}

const PROFILES = Object.freeze({
  trade_fair: Object.freeze({
    identityProviderKey: "trade_fair" as const,
    sourceClass: "industry_data" as const,
    license: "SOURCE_SPECIFIC_RESTRICTED" as const,
  }),
  mapyourshow: Object.freeze({
    identityProviderKey: "trade_fair" as const,
    sourceClass: "industry_data" as const,
    license: "SOURCE_SPECIFIC_RESTRICTED" as const,
  }),
});

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(value: unknown, maximumBytes: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= maximumBytes
    ? normalized
    : null;
}

function sourceUrl(source: MonitoredSourceBridgeSource): string | null {
  const config = record(source.config);
  if (source.providerKey === "mapyourshow") {
    const host = text(config.host, 253)?.toLowerCase();
    return host && /^[a-z0-9.-]+\.mapyourshow\.com$/u.test(host)
      ? `https://${host}/8_0/explore/exhibitor-gallery.cfm`
      : null;
  }
  if (source.providerKey === "trade_fair") {
    const algolia = record(config.algolia);
    const appId = text(algolia.appId, 128)?.toLowerCase();
    const indexName = text(algolia.indexName, 256);
    if (appId && indexName && /^[a-z0-9-]+$/u.test(appId)) {
      return `https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}`;
    }
  }
  return null;
}

function hostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function policyCovers(
  policy: MonitoredSourceBridgePolicy,
  host: string,
): boolean {
  const domain = policy.domain
    .trim()
    .toLowerCase()
    .replace(/^www\./u, "");
  const purpose = Array.isArray(policy.allowedPurpose)
    ? policy.allowedPurpose
    : [];
  return (
    policy.reviewStatus === "APPROVED" &&
    (host === domain || host.endsWith(`.${domain}`)) &&
    purpose.some((value) => value === "discovery" || value === "enrichment")
  );
}

function safeAttributes(value: unknown): JsonRecord {
  const cleaned = record(value);
  const products = Array.isArray(cleaned.products)
    ? cleaned.products
        .flatMap((item) => (typeof item === "string" ? [text(item, 256)] : []))
        .filter((item): item is string => item !== null)
        .slice(0, 20)
    : [];
  const allowed = {
    ...(products.length ? { products } : {}),
    ...(text(cleaned.stand, 128) ? { stand: text(cleaned.stand, 128)! } : {}),
    ...(text(cleaned.hall, 128) ? { hall: text(cleaned.hall, 128)! } : {}),
    ...(text(cleaned.source_fair, 256)
      ? { source_fair: text(cleaned.source_fair, 256)! }
      : {}),
    ...(text(cleaned.source_kind, 128)
      ? { source_kind: text(cleaned.source_kind, 128)! }
      : {}),
  };
  return Object.freeze(allowed);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function prepareMonitoredSourceRawBridge(args: {
  workspaceId: string;
  source: MonitoredSourceBridgeSource;
  entity: MonitoredSourceBridgeEntity;
  fetch: MonitoredSourceBridgeFetch;
  policies: readonly MonitoredSourceBridgePolicy[];
}): PreparedMonitoredSourceRawBridge {
  const profile = PROFILES[args.source.providerKey as keyof typeof PROFILES];
  const observedAt = args.entity.lastSeenAt;
  const finishedAt = args.fetch.finishedAt;
  const parserVersion = text(args.fetch.parserVersion, 256);
  const url = sourceUrl(args.source);
  const host = url ? hostname(url) : null;
  const policy = host
    ? [...args.policies]
        .filter((candidate) => policyCovers(candidate, host))
        .sort((left, right) => right.domain.length - left.domain.length)[0]
    : undefined;

  if (
    !args.workspaceId.trim() ||
    !args.source.id ||
    !args.entity.id ||
    !args.entity.externalId.trim()
  ) {
    throw new MonitoredSourceRawBridgeError(
      "MONITORED_SOURCE_IDENTITY_MISSING",
      "monitored source bridge identity is incomplete",
    );
  }
  if (!profile) {
    throw new MonitoredSourceRawBridgeError(
      "MONITORED_SOURCE_PROVIDER_UNGOVERNED",
      "monitored source provider has no governed bridge profile",
    );
  }
  if (
    args.fetch.sourceId !== args.source.id ||
    args.entity.lastSeenFetchId !== args.fetch.id
  ) {
    throw new MonitoredSourceRawBridgeError(
      "MONITORED_SOURCE_FETCH_PROVENANCE_MISMATCH",
      "entity and fetch do not share the exact monitored source observation",
    );
  }
  if (
    !["DONE", "PARTIAL"].includes(args.fetch.status) ||
    !(finishedAt instanceof Date) ||
    Number.isNaN(finishedAt.getTime())
  ) {
    throw new MonitoredSourceRawBridgeError(
      "MONITORED_SOURCE_FETCH_INCOMPLETE",
      "only completed parser-versioned fetches may be projected",
    );
  }
  if (
    !(observedAt instanceof Date) ||
    observedAt.getTime() !== finishedAt.getTime()
  ) {
    throw new MonitoredSourceRawBridgeError(
      "MONITORED_SOURCE_OBSERVATION_TIME_MISMATCH",
      "entity observation time must equal the referenced fetch completion",
    );
  }
  if (!parserVersion || !/^[0-9a-f]{64}$/u.test(args.entity.contentHash)) {
    throw new MonitoredSourceRawBridgeError(
      "MONITORED_SOURCE_PROVENANCE_INVALID",
      "parser version and SHA-256 content hash are required",
    );
  }
  if (!url || !host || !policy) {
    throw new MonitoredSourceRawBridgeError(
      "MONITORED_SOURCE_POLICY_DENIED",
      "an approved purpose-scoped policy must cover the governed source URL",
    );
  }

  const attributes = safeAttributes(args.entity.cleaned);
  const snapshotId = digest(
    [
      args.source.id,
      args.entity.id,
      args.fetch.id,
      args.entity.contentHash,
      parserVersion,
      url,
      profile.license,
    ].join("\0"),
  );
  const payload = {
    externalId: `monitored:${snapshotId}`,
    name: args.entity.name,
    ...(args.entity.domain ? { domain: args.entity.domain } : {}),
    ...(args.entity.country ? { country: args.entity.country } : {}),
    attributes,
    license: profile.license,
    provenance: {
      sourceUrl: url,
      fetchedAt: finishedAt.toISOString(),
      contentHash: args.entity.contentHash,
      parserVersion,
    },
    monitoredSource: {
      sourceId: args.source.id,
      sourceKey: args.source.sourceKey,
      sourceEntityId: args.entity.id,
      sourceExternalId: args.entity.externalId,
      sourceFetchId: args.fetch.id,
      originProviderKey: args.source.providerKey,
    },
  };
  const row = prepareRawSourceBatch({
    providerKey: profile.identityProviderKey,
    records: [payload],
    policies: args.policies,
    now: finishedAt,
  }).rows[0];
  if (!row || row.ingestStatus !== "ACCEPTED") {
    throw new MonitoredSourceRawBridgeError(
      "MONITORED_SOURCE_RAW_REJECTED",
      `governed monitored snapshot was rejected: ${row?.dispositionCode ?? "UNKNOWN"}`,
    );
  }
  return Object.freeze({
    ...profile,
    row,
    uniqueWhere: Object.freeze({
      workspaceId: args.workspaceId,
      sourceEntityId: args.entity.id,
      ingestKey: row.ingestKey,
    }),
  });
}

export async function persistMonitoredSourceRawBridge(
  tx: Prisma.TransactionClient,
  args: { workspaceId: string; prepared: PreparedMonitoredSourceRawBridge },
): Promise<{ id: string; payloadHash: string | null; ingestStatus: string }> {
  if (args.workspaceId !== args.prepared.uniqueWhere.workspaceId) {
    throw new MonitoredSourceRawBridgeError(
      "MONITORED_SOURCE_WORKSPACE_MISMATCH",
      "prepared bridge belongs to a different workspace",
    );
  }
  const { prepared } = args;
  let raw: Awaited<ReturnType<typeof persistPreparedRawSourceRecord>>;
  try {
    raw = await persistPreparedRawSourceRecord(tx, {
      workspaceId: args.workspaceId,
      runId: null,
      sourceEntityId: prepared.uniqueWhere.sourceEntityId,
      providerKey: prepared.identityProviderKey,
      sourceClass: prepared.sourceClass,
      row: prepared.row,
      costCents: 0,
    });
  } catch {
    throw new MonitoredSourceRawBridgeError(
      "MONITORED_SOURCE_RAW_DRIFT",
      "controlled Raw writer rejected the monitored snapshot",
    );
  }
  if (
    raw.ingestStatus !== "ACCEPTED" ||
    raw.payloadHash !== prepared.row.payloadHash
  ) {
    throw new MonitoredSourceRawBridgeError(
      "MONITORED_SOURCE_RAW_DRIFT",
      "existing monitored Raw receipt differs from the deterministic snapshot",
    );
  }
  return {
    id: raw.id,
    payloadHash: raw.payloadHash,
    ingestStatus: raw.ingestStatus,
  };
}
