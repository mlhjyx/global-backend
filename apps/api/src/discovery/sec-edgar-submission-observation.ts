import { Prisma } from '@prisma/client';
import type { EnrichmentResult } from './provider-contract';
import { normalizeCikIdentifier } from './organization-identity-v2';
import {
  loadOrganizationIdentitySnapshot,
  resolveOrganizationRoot,
} from './organization-identity-root';
import { resolveOrganizationIdentityForRaw } from './organization-identity-resolver';
import {
  prepareRawSourceBatch,
  rawDriftIngestKey,
  reconcileRawSourceBatch,
  type RawSourceIngestLimits,
  type RawSourcePolicySnapshot,
} from './raw-source-ingestion';
import { commitCompanyEnrichmentResults } from './company-enrichment-commit';

const DIRECTORY_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
const DIRECTORY_PARSER = 'sec-edgar-company-tickers-exchange/1';
const OBSERVATION_SCHEMA = 'sec-edgar-submission-observation/v1';

type JsonRecord = Record<string, unknown>;

export interface SecEdgarDirectoryBinding {
  rawRecordId: string;
  companyId: string;
  companyName: string;
  cik: string;
  identitySnapshot: string;
  externalId: string;
  sourceUrl: typeof DIRECTORY_URL;
  parserVersion: typeof DIRECTORY_PARSER;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
}

function normalizedName(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('en-US')
    : '';
}

function cikIdentifiers(payload: JsonRecord): string[] {
  const values: unknown[] = [];
  if (Array.isArray(payload.identifiers)) values.push(...payload.identifiers);
  if (payload.identifier) values.push(payload.identifier);
  return [...new Set(values.flatMap((value) => {
    const item = record(value);
    if (
      item?.scheme !== 'cik' || item.jurisdiction !== 'US' ||
      typeof item.value !== 'string'
    ) return [];
    const cik = normalizeCikIdentifier(item.value);
    return cik ? [cik] : [];
  }))];
}

function hasExactSingleCikIdentifier(payload: JsonRecord, activeCik: string): boolean {
  if (!Array.isArray(payload.identifiers) || payload.identifiers.length !== 1) return false;
  const identifier = record(payload.identifiers[0]);
  return !!identifier &&
    exactKeys(identifier, ['jurisdiction', 'scheme', 'value']) &&
    identifier.scheme === 'cik' &&
    identifier.jurisdiction === 'US' &&
    typeof identifier.value === 'string' &&
    normalizeCikIdentifier(identifier.value) === activeCik;
}

export function validateSecEdgarDirectoryRawPayload(
  payloadValue: unknown,
  expected: { companyName: string; activeCik: string },
): { name: string; cik: string } {
  const payload = record(payloadValue);
  const activeCik = normalizeCikIdentifier(expected.activeCik);
  const name = typeof payload?.name === 'string' ? payload.name : '';
  const identifiers = payload ? cikIdentifiers(payload) : [];
  if (
    !payload || !activeCik || identifiers.length !== 1 || identifiers[0] !== activeCik ||
    normalizedName(name) !== normalizedName(expected.companyName) ||
    payload.externalId !== `sec-edgar:${activeCik}`
  ) {
    throw new Error('SEC_EDGAR_DIRECTORY_RAW_BINDING_INVALID');
  }
  return { name, cik: activeCik };
}

export function validateSecEdgarSubmissionObservation(
  observationValue: EnrichmentResult['rawObservation'],
  expected: {
    companyName: string;
    activeCik: string;
    provenance: NonNullable<EnrichmentResult['provenance']>;
  },
): JsonRecord {
  const payload = record(observationValue?.payload);
  const attributes = record(payload?.attributes);
  const submission = record(attributes?.sec_edgar_submission);
  const provenance = record(payload?.provenance);
  const activeCik = normalizeCikIdentifier(expected.activeCik);
  const expectedProvenance = expected.provenance;
  const valid =
    !!observationValue && !!payload && !!attributes && !!submission && !!provenance && !!activeCik &&
    observationValue.sourceClass === 'company_registry' &&
    observationValue.license === 'US-GOV-PUBLIC-INFO' &&
    observationValue.externalId === `sec-edgar-submission:${activeCik}` &&
    exactKeys(payload, ['attributes', 'externalId', 'identifiers', 'license', 'name', 'provenance']) &&
    exactKeys(attributes, ['sec_edgar_submission']) &&
    exactKeys(submission, ['cik', 'entity_type', 'schema_version', 'semantic_scope']) &&
    exactKeys(provenance, ['contentHash', 'fetchedAt', 'parserVersion', 'sourceUrl']) &&
    payload.externalId === observationValue.externalId &&
    payload.license === observationValue.license &&
    normalizedName(payload.name) === normalizedName(expected.companyName) &&
    hasExactSingleCikIdentifier(payload, activeCik) &&
    submission.schema_version === OBSERVATION_SCHEMA &&
    submission.cik === activeCik &&
    submission.entity_type === 'operating' &&
    submission.semantic_scope === 'sec_filer_classification_only' &&
    provenance.sourceUrl === expectedProvenance.sourceUrl &&
    provenance.fetchedAt === expectedProvenance.fetchedAt &&
    provenance.contentHash === expectedProvenance.contentHash &&
    provenance.parserVersion === expectedProvenance.parserVersion;
  if (!valid) throw new Error('SEC_EDGAR_SUBMISSION_OBSERVATION_INVALID');
  return payload;
}

export async function loadSecEdgarDirectoryBinding(
  tx: Prisma.TransactionClient,
  args: { workspaceId: string; runId: string; companyId: string },
): Promise<SecEdgarDirectoryBinding | null> {
  const snapshot = await loadOrganizationIdentitySnapshot(tx, args.workspaceId, args.companyId);
  const ciks = snapshot.identifiers
    .filter((item) => item.scheme === 'cik' && item.jurisdiction === 'US')
    .flatMap((item) => normalizeCikIdentifier(item.value) ? [normalizeCikIdentifier(item.value)!] : []);
  if (ciks.length !== 1) return null;
  const company = await tx.canonicalCompany.findUnique({
    where: { id: snapshot.rootCompanyId },
    select: { id: true, name: true, status: true },
  });
  if (!company || company.status === 'SUPPRESSED') return null;
  const raw = await tx.rawSourceRecord.findFirst({
    where: {
      workspaceId: args.workspaceId,
      runId: args.runId,
      providerKey: 'sec_edgar',
      ingestStatus: 'ACCEPTED',
      sourceUrl: DIRECTORY_URL,
      parserVersion: DIRECTORY_PARSER,
      identityLinks: {
        some: {
          workspaceId: args.workspaceId,
          canonicalType: 'company',
          canonicalId: { in: snapshot.relatedCompanyIds },
          status: 'ACTIVE',
        },
      },
    },
    select: { id: true, externalId: true, payload: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!raw) return null;
  const validated = validateSecEdgarDirectoryRawPayload(raw.payload, {
    companyName: company.name,
    activeCik: ciks[0]!,
  });
  if (raw.externalId !== `sec-edgar:${validated.cik}`) return null;
  return {
    rawRecordId: raw.id,
    companyId: snapshot.rootCompanyId,
    companyName: company.name,
    cik: validated.cik,
    identitySnapshot: snapshot.fingerprint,
    externalId: raw.externalId,
    sourceUrl: DIRECTORY_URL,
    parserVersion: DIRECTORY_PARSER,
  };
}

export async function persistSecEdgarSubmissionObservation(
  tx: Prisma.TransactionClient,
  args: {
    workspaceId: string;
    runId: string;
    binding: SecEdgarDirectoryBinding;
    result: EnrichmentResult;
    sourcePolicies: RawSourcePolicySnapshot[];
    limits?: RawSourceIngestLimits;
    now?: Date;
  },
): Promise<{ rawRecordId: string; rawCreated: number; replayed: boolean; evidenceWritten: number }> {
  if (!args.result.matched || !args.result.provenance || !args.result.rawObservation) {
    throw new Error('SEC_EDGAR_SUBMISSION_OBSERVATION_REQUIRED');
  }
  const currentBinding = await loadSecEdgarDirectoryBinding(tx, {
    workspaceId: args.workspaceId,
    runId: args.runId,
    companyId: args.binding.companyId,
  });
  if (
    !currentBinding || currentBinding.rawRecordId !== args.binding.rawRecordId ||
    currentBinding.identitySnapshot !== args.binding.identitySnapshot ||
    currentBinding.cik !== args.binding.cik ||
    normalizedName(currentBinding.companyName) !== normalizedName(args.binding.companyName)
  ) throw new Error('SEC_EDGAR_DIRECTORY_BINDING_STALE');

  const payload = validateSecEdgarSubmissionObservation(args.result.rawObservation, {
    companyName: currentBinding.companyName,
    activeCik: currentBinding.cik,
    provenance: args.result.provenance,
  });
  const prepared = prepareRawSourceBatch({
    providerKey: 'sec_edgar',
    records: [payload],
    policies: args.sourcePolicies,
    ...(args.limits ? { limits: args.limits } : {}),
    ...(args.now ? { now: args.now } : {}),
  });
  const candidate = prepared.rows[0];
  if (!candidate || candidate.ingestStatus !== 'ACCEPTED') {
    throw new Error('SEC_EDGAR_SUBMISSION_RAW_NOT_ACCEPTED');
  }
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`raw-source:${args.workspaceId}:${args.runId}:sec_edgar:submission:${currentBinding.cik}`}, 0))`,
  );
  const existing = await tx.rawSourceRecord.findMany({
    where: {
      runId: args.runId,
      providerKey: 'sec_edgar',
      OR: [
        { ingestKey: { in: [candidate.ingestKey, rawDriftIngestKey(candidate.ingestKey, candidate.payloadHash)] } },
        { externalId: candidate.externalId },
      ],
    },
    select: { id: true, externalId: true, ingestKey: true, payloadHash: true, payload: true },
  });
  const reconciled = reconcileRawSourceBatch(prepared.rows, existing);
  if (reconciled.quarantinedCount || reconciled.rejectedCount) {
    throw new Error('SEC_EDGAR_SUBMISSION_RAW_DRIFT');
  }
  let rawCreated = 0;
  if (reconciled.rows.length) {
    const created = await tx.rawSourceRecord.createMany({
      data: reconciled.rows.map((row) => ({
        workspaceId: args.workspaceId,
        runId: args.runId,
        providerKey: 'sec_edgar',
        sourceClass: 'company_registry',
        externalId: row.externalId,
        payload: row.payload as Prisma.InputJsonValue,
        sourceUrl: row.sourceUrl,
        fetchedAt: row.fetchedAt,
        contentHash: row.contentHash,
        parserVersion: row.parserVersion,
        ingestKey: row.ingestKey,
        payloadHash: row.payloadHash,
        payloadBytes: row.payloadBytes,
        ingestVersion: row.ingestVersion,
        ingestStatus: row.ingestStatus,
        dispositionCode: row.dispositionCode,
        retentionDays: row.retentionDays,
        expiresAt: row.expiresAt,
        sourcePolicySnapshot: row.sourcePolicySnapshot as Prisma.InputJsonValue,
        costCents: args.result.costCents,
      })),
      skipDuplicates: true,
    });
    if (created.count !== reconciled.rows.length) throw new Error('SEC_EDGAR_SUBMISSION_RAW_CONCURRENT_WRITE');
    rawCreated = created.count;
  }
  const raw = await tx.rawSourceRecord.findFirst({
    where: {
      runId: args.runId,
      providerKey: 'sec_edgar',
      ingestKey: candidate.ingestKey,
      ingestStatus: 'ACCEPTED',
    },
    select: { id: true },
  });
  if (!raw) throw new Error('SEC_EDGAR_SUBMISSION_RAW_MISSING');

  const resolution = await resolveOrganizationIdentityForRaw(tx, {
    workspaceId: args.workspaceId,
    rawRecordId: raw.id,
    providerKey: 'sec_edgar',
    record: payload as never,
  });
  if (resolution.kind !== 'bound') throw new Error('SEC_EDGAR_SUBMISSION_IDENTITY_CONFLICT');
  const resolvedRoot = await resolveOrganizationRoot(tx, args.workspaceId, resolution.companyId);
  if (resolvedRoot.rootCompanyId !== currentBinding.companyId) {
    throw new Error('SEC_EDGAR_SUBMISSION_COMPANY_MISMATCH');
  }

  const fields = Object.entries(args.result.attributes).filter(([, value]) => value != null);
  if (resolution.replayed) {
    const existingEvidence = await tx.fieldEvidence.count({
      where: {
        workspaceId: args.workspaceId,
        entityType: 'company',
        entityId: currentBinding.companyId,
        providerKey: 'sec_edgar',
        rawRecordId: raw.id,
        field: { in: fields.map(([field]) => `sec_edgar.${field}`) },
      },
    });
    if (existingEvidence === fields.length) {
      return { rawRecordId: raw.id, rawCreated, replayed: true, evidenceWritten: 0 };
    }
  }
  const committed = await commitCompanyEnrichmentResults(tx, {
    workspaceId: args.workspaceId,
    companyId: currentBinding.companyId,
    hits: [{
      key: 'sec_edgar',
      result: args.result,
      rawRecordId: raw.id,
      license: args.result.rawObservation.license,
      allowedActions: ['display'],
    }],
    status: 'ENRICHED',
    expectedIdentitySnapshot: currentBinding.identitySnapshot,
  });
  if (!committed) throw new Error('SEC_EDGAR_SUBMISSION_COMMIT_REJECTED');
  return { rawRecordId: raw.id, rawCreated, replayed: resolution.replayed, evidenceWritten: fields.length };
}
