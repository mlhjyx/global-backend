import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  prepareRawSourceBatch,
  type PreparedRawSourceRow,
  type RawSourcePolicySnapshot,
} from '../discovery/raw-source-ingestion';
import type { OrganizationIdentityRecord } from '../discovery/organization-identity-resolver';

type JsonRecord = Record<string, unknown>;

export type MonitoredSourceBridgeSource = {
  id: string;
  sourceKey: string;
  providerKey: string;
  config: unknown;
};

export type MonitoredSourceBridgeEntity = {
  id: string;
  externalId: string;
  name: string;
  domain: string | null;
  country: string | null;
  cleaned: unknown;
  contentHash: string;
  lastSeenAt: Date | null;
  lastSeenFetchId: string | null;
};

export type MonitoredSourceBridgeFetch = {
  id: string;
  status: string;
  parserVersion: string | null;
  finishedAt: Date | null;
};

export type MonitoredSourceBridgePolicy = RawSourcePolicySnapshot & {
  allowedPurpose?: unknown;
};

export type MonitoredSourceIdentityRecord = OrganizationIdentityRecord & {
  license: string;
  provenance: {
    sourceUrl: string;
    fetchedAt: string;
    contentHash: string;
    parserVersion: string;
  };
  monitoredSource: {
    sourceId: string;
    sourceKey: string;
    sourceEntityId: string;
    sourceExternalId: string;
    sourceFetchId: string;
    originProviderKey: string;
  };
};

export type PreparedMonitoredSourceRawBridge = {
  identityProviderKey: string;
  license: string;
  sourceClass: string;
  record: MonitoredSourceIdentityRecord;
  row: PreparedRawSourceRow;
  uniqueWhere: {
    workspaceId: string;
    sourceEntityId: string;
    ingestKey: string;
  };
};

export class MonitoredSourceRawBridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MonitoredSourceRawBridgeError';
    this.code = code;
  }
}

function stringField(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function validDate(value: Date | null): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

type GovernedMonitoredSourceProfile = {
  identityProviderKey: string;
  sourceClass: string;
  license: string;
};

// Runtime mirror of the governed Provider Registry facts for adapters supported
// by AcquisitionService. Source config is tenant/operator input and is never an
// authority for class or licence claims.
const GOVERNED_MONITORED_SOURCE_PROFILES: Readonly<Record<string, GovernedMonitoredSourceProfile>> = Object.freeze({
  trade_fair: Object.freeze({
    identityProviderKey: 'trade_fair',
    sourceClass: 'industry_data',
    license: 'SOURCE_SPECIFIC_RESTRICTED',
  }),
  mapyourshow: Object.freeze({
    identityProviderKey: 'trade_fair',
    sourceClass: 'industry_data',
    license: 'SOURCE_SPECIFIC_RESTRICTED',
  }),
});

function governedSourceProfile(providerKey: string): GovernedMonitoredSourceProfile | null {
  return GOVERNED_MONITORED_SOURCE_PROFILES[providerKey] ?? null;
}

function sourceUrlFor(source: MonitoredSourceBridgeSource, config: JsonRecord): string | null {
  const explicit = stringField(config, 'sourceUrl') ?? stringField(config, 'exhibitorUrl') ?? stringField(config, 'url');
  if (explicit) return explicit;

  const host = stringField(config, 'host');
  if (host && /^[\w.-]+\.mapyourshow\.com$/u.test(host)) {
    return `https://${host}/8_0/explore/exhibitor-gallery.cfm`;
  }

  const algolia = config.algolia;
  if (algolia && typeof algolia === 'object' && !Array.isArray(algolia)) {
    const appId = stringField(algolia as JsonRecord, 'appId');
    const indexName = stringField(algolia as JsonRecord, 'indexName');
    if (appId && indexName) {
      return `https://${appId.toLowerCase()}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}`;
    }
  }
  return null;
}

function hostnameOf(sourceUrl: string): string | null {
  try {
    const parsed = new URL(sourceUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return null;
  }
}

function policyCoversHost(policyDomain: string, hostname: string): boolean {
  const normalized = policyDomain.trim().toLowerCase().replace(/^www\./u, '');
  return normalized === hostname || hostname.endsWith(`.${normalized}`);
}

function policyAllowsProjection(policy: MonitoredSourceBridgePolicy): boolean {
  if (policy.reviewStatus !== 'APPROVED') return false;
  if (!Array.isArray(policy.allowedPurpose)) return false;
  return policy.allowedPurpose.some((purpose) => purpose === 'discovery' || purpose === 'enrichment');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value as JsonRecord)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

export function prepareMonitoredSourceRawBridge(args: {
  workspaceId: string;
  source: MonitoredSourceBridgeSource;
  entity: MonitoredSourceBridgeEntity;
  fetch: MonitoredSourceBridgeFetch;
  policies: MonitoredSourceBridgePolicy[];
  attributes: Record<string, unknown>;
}): PreparedMonitoredSourceRawBridge {
  const config = args.source.config && typeof args.source.config === 'object' && !Array.isArray(args.source.config)
    ? (args.source.config as JsonRecord)
    : {};
  const providerProfile = governedSourceProfile(args.source.providerKey);
  const license = providerProfile?.license ?? null;
  const sourceClass = providerProfile?.sourceClass ?? null;
  const parserVersion = args.fetch.parserVersion?.trim() || null;
  const sourceUrl = sourceUrlFor(args.source, config);
  const hostname = sourceUrl ? hostnameOf(sourceUrl) : null;

  if (Object.hasOwn(args.attributes, 'contact_email')) {
    throw new MonitoredSourceRawBridgeError(
      'MONITORED_SOURCE_DYNAMIC_ATTRIBUTE_REJECTED',
      'suppression-dependent contact_email belongs only in the canonical projection',
    );
  }

  if (!args.workspaceId.trim() || !args.source.id || !args.entity.id || !args.entity.externalId.trim()) {
    throw new MonitoredSourceRawBridgeError('MONITORED_SOURCE_IDENTITY_MISSING', 'monitored source bridge identity is incomplete');
  }
  if (!providerProfile) {
    throw new MonitoredSourceRawBridgeError(
      'MONITORED_SOURCE_PROVIDER_UNGOVERNED',
      'monitored source provider has no governed projection profile',
    );
  }
  if (!license) {
    throw new MonitoredSourceRawBridgeError('MONITORED_SOURCE_LICENSE_MISSING', 'monitored source license is required');
  }
  if (!sourceClass) {
    throw new MonitoredSourceRawBridgeError('MONITORED_SOURCE_CLASS_MISSING', 'monitored source class is required');
  }
  if (!parserVersion) {
    throw new MonitoredSourceRawBridgeError('MONITORED_SOURCE_PARSER_MISSING', 'successful source fetch parser version is required');
  }
  if (!validDate(args.entity.lastSeenAt)) {
    throw new MonitoredSourceRawBridgeError('MONITORED_SOURCE_OBSERVED_AT_MISSING', 'source entity observed time is required');
  }
  if (!['DONE', 'PARTIAL'].includes(args.fetch.status) || !validDate(args.fetch.finishedAt)) {
    throw new MonitoredSourceRawBridgeError(
      'MONITORED_SOURCE_FETCH_INCOMPLETE',
      'source entity fetch must be completed before projection',
    );
  }
  if (!args.entity.lastSeenFetchId || args.entity.lastSeenFetchId !== args.fetch.id) {
    throw new MonitoredSourceRawBridgeError(
      'MONITORED_SOURCE_FETCH_PROVENANCE_MISMATCH',
      'source entity does not reference the supplied fetch observation',
    );
  }
  if (args.entity.lastSeenAt.getTime() !== args.fetch.finishedAt.getTime()) {
    throw new MonitoredSourceRawBridgeError(
      'MONITORED_SOURCE_OBSERVATION_TIME_MISMATCH',
      'source entity observation time does not match its fetch completion time',
    );
  }
  if (!/^[a-f0-9]{64}$/iu.test(args.entity.contentHash)) {
    throw new MonitoredSourceRawBridgeError('MONITORED_SOURCE_CONTENT_HASH_INVALID', 'source entity content hash is invalid');
  }
  if (!sourceUrl || !hostname) {
    throw new MonitoredSourceRawBridgeError('MONITORED_SOURCE_URL_MISSING', 'monitored source URL is required');
  }
  const policy = args.policies
    .filter((candidate) => policyCoversHost(candidate.domain, hostname))
    .sort((left, right) => right.domain.length - left.domain.length)[0];
  if (!policy || !policyAllowsProjection(policy)) {
    throw new MonitoredSourceRawBridgeError('MONITORED_SOURCE_POLICY_DENIED', 'approved source policy for projection is required');
  }

  const identityProviderKey = providerProfile.identityProviderKey;
  const snapshotBasis = stableJson({
    sourceId: args.source.id,
    sourceEntityId: args.entity.id,
    contentHash: args.entity.contentHash,
    parserVersion,
    sourceFetchId: args.fetch.id,
    sourceUrl,
    license,
  });
  const snapshotExternalId = `monitored:${sha256(snapshotBasis)}`;
  const record: MonitoredSourceIdentityRecord & { externalId: string } = {
    externalId: snapshotExternalId,
    name: args.entity.name,
    ...(args.entity.domain ? { domain: args.entity.domain } : {}),
    ...(args.entity.country ? { country: args.entity.country } : {}),
    attributes: args.attributes,
    license,
    provenance: {
      sourceUrl,
      fetchedAt: args.fetch.finishedAt.toISOString(),
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
  const prepared = prepareRawSourceBatch({
    providerKey: identityProviderKey,
    records: [record],
    policies: args.policies,
    now: args.fetch.finishedAt,
  }).rows[0];
  if (!prepared || prepared.ingestStatus !== 'ACCEPTED') {
    throw new MonitoredSourceRawBridgeError(
      'MONITORED_SOURCE_RAW_REJECTED',
      `monitored source raw receipt was not accepted: ${prepared?.dispositionCode ?? 'UNKNOWN'}`,
    );
  }

  return {
    identityProviderKey,
    license,
    sourceClass,
    record,
    row: prepared,
    uniqueWhere: {
      workspaceId: args.workspaceId,
      sourceEntityId: args.entity.id,
      ingestKey: prepared.ingestKey,
    },
  };
}

export async function persistMonitoredSourceRawBridge(
  tx: Prisma.TransactionClient,
  args: {
    workspaceId: string;
    prepared: PreparedMonitoredSourceRawBridge;
  },
): Promise<{ id: string; payloadHash: string | null; ingestStatus: string }> {
  const { prepared } = args;
  const raw = await tx.rawSourceRecord.upsert({
    where: {
      workspaceId_sourceEntityId_ingestKey: prepared.uniqueWhere,
    },
    update: {},
    create: {
      workspaceId: args.workspaceId,
      runId: null,
      sourceEntityId: prepared.uniqueWhere.sourceEntityId,
      providerKey: prepared.identityProviderKey,
      sourceClass: prepared.sourceClass,
      externalId: prepared.row.externalId,
      payload: prepared.row.payload as Prisma.InputJsonValue,
      sourceUrl: prepared.row.sourceUrl,
      fetchedAt: prepared.row.fetchedAt,
      contentHash: prepared.row.contentHash,
      parserVersion: prepared.row.parserVersion,
      ingestKey: prepared.row.ingestKey,
      payloadHash: prepared.row.payloadHash,
      payloadBytes: prepared.row.payloadBytes,
      ingestVersion: prepared.row.ingestVersion,
      ingestStatus: prepared.row.ingestStatus,
      dispositionCode: prepared.row.dispositionCode,
      retentionDays: prepared.row.retentionDays,
      expiresAt: prepared.row.expiresAt,
      sourcePolicySnapshot: prepared.row.sourcePolicySnapshot as Prisma.InputJsonValue,
      costCents: 0,
    },
    select: { id: true, payloadHash: true, ingestStatus: true },
  });
  if (raw.ingestStatus !== 'ACCEPTED' || raw.payloadHash !== prepared.row.payloadHash) {
    throw new MonitoredSourceRawBridgeError(
      'MONITORED_SOURCE_RAW_DRIFT',
      'existing monitored source raw receipt does not match the deterministic snapshot',
    );
  }
  return raw;
}
