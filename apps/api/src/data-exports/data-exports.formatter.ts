import type { Prisma } from '@prisma/client';
import { encodeCsv, type CsvValue } from '../report/csv';
import type { DataExportFormat, DataExportScope } from './data-exports.types';
import { buildZipArchive, type ZipEntryInput } from './zip-writer';

export const DATA_EXPORT_PAGE_SIZE = 500;
export const DATA_EXPORT_MAX_ROWS_PER_DOMAIN = 50_000;
export const DATA_EXPORT_MAX_BYTES = 50 * 1024 * 1024;

type Tx = Prisma.TransactionClient;

export class DataExportTooLargeError extends Error {
  readonly code = 'DATA_EXPORT_TOO_LARGE';
  constructor(message = 'DATA_EXPORT_TOO_LARGE') {
    super(message);
    this.name = 'DataExportTooLargeError';
  }
}

export interface FormattedDomainData {
  readonly domain: string;
  readonly header: readonly string[];
  readonly csvRows: readonly (readonly CsvValue[])[];
  readonly jsonRecords: readonly Record<string, unknown>[];
}

export interface BuiltExportPayload {
  readonly body: Buffer;
  readonly contentType: string;
  readonly ext: 'csv' | 'jsonl' | 'zip';
  readonly rowCount: number;
}

function iso(value: Date | null | undefined): string {
  return value ? value.toISOString() : '';
}

function jsonText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

function assertRowBound(total: number): void {
  if (total > DATA_EXPORT_MAX_ROWS_PER_DOMAIN) {
    throw new DataExportTooLargeError();
  }
}

async function fetchPaginated<T extends { id: string }>(
  fetchPage: (cursorId?: string) => Promise<T[]>,
): Promise<T[]> {
  const all: T[] = [];
  let cursorId: string | undefined;
  for (;;) {
    const batch = await fetchPage(cursorId);
    if (batch.length === 0) break;
    all.push(...batch);
    assertRowBound(all.length);
    if (batch.length < DATA_EXPORT_PAGE_SIZE) break;
    cursorId = batch[batch.length - 1]!.id;
  }
  return all;
}

async function readLeadsDomain(tx: Tx): Promise<FormattedDomainData> {
  const leads = await fetchPaginated((cursorId) =>
    tx.lead.findMany({
      take: DATA_EXPORT_PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      orderBy: [{ id: 'asc' }],
      include: {
        canonicalCompany: {
          select: { id: true, name: true, domain: true, country: true, industry: true, status: true },
        },
        decisions: {
          select: { action: true, reasonCode: true, reason: true, createdAt: true },
          orderBy: [{ createdAt: 'desc' }],
          take: 5,
        },
        outcomes: {
          select: {
            relevance: true,
            willingToContact: true,
            reasonCode: true,
            note: true,
            contacted: true,
            source: true,
            createdAt: true,
          },
          orderBy: [{ createdAt: 'desc' }],
          take: 5,
        },
        outreachDrafts: {
          select: { version: true, language: true, subject: true, body: true, bodyZh: true, createdAt: true },
          orderBy: [{ version: 'desc' }],
          take: 1,
        },
      },
    }),
  );

  const icpIds = [...new Set(leads.map((l) => l.icpId))];
  const icps =
    icpIds.length > 0
      ? await tx.icpDefinition.findMany({
          where: { id: { in: icpIds } },
          select: { id: true, name: true, status: true },
        })
      : [];
  const icpMap = new Map(icps.map((i) => [i.id, i]));

  const header = [
    'id',
    'icpId',
    'icpName',
    'icpStatus',
    'canonicalCompanyId',
    'companyName',
    'companyDomain',
    'companyCountry',
    'companyIndustry',
    'companyStatus',
    'status',
    'queue',
    'fitVerdict',
    'totalScore',
    'scoredAt',
    'latestDecisionAction',
    'latestDecisionReasonCode',
    'latestOutcomeRelevance',
    'latestOutreachSubject',
    'createdAt',
    'updatedAt',
  ] as const;

  const csvRows: CsvValue[][] = [];
  const jsonRecords: Record<string, unknown>[] = [];
  for (const lead of leads) {
    const icp = icpMap.get(lead.icpId);
    const latestDecision = lead.decisions[0];
    const latestOutcome = lead.outcomes[0];
    const latestDraft = lead.outreachDrafts[0];
    csvRows.push([
      lead.id,
      lead.icpId,
      icp?.name ?? '',
      icp?.status ?? '',
      lead.canonicalCompanyId,
      lead.canonicalCompany.name,
      lead.canonicalCompany.domain ?? '',
      lead.canonicalCompany.country ?? '',
      lead.canonicalCompany.industry ?? '',
      lead.canonicalCompany.status,
      lead.status,
      lead.queue,
      lead.fitVerdict ?? '',
      lead.totalScore ?? null,
      iso(lead.scoredAt),
      latestDecision?.action ?? '',
      latestDecision?.reasonCode ?? '',
      latestOutcome?.relevance ?? null,
      latestDraft?.subject ?? '',
      iso(lead.createdAt),
      iso(lead.updatedAt),
    ]);
    jsonRecords.push({
      id: lead.id,
      icp: icp ?? { id: lead.icpId },
      canonicalCompany: lead.canonicalCompany,
      status: lead.status,
      queue: lead.queue,
      fitVerdict: lead.fitVerdict,
      fitReasons: lead.fitReasons,
      totalScore: lead.totalScore,
      scores: lead.scores,
      scoreDetail: lead.scoreDetail,
      scoredAt: lead.scoredAt?.toISOString() ?? null,
      decisions: lead.decisions,
      outcomes: lead.outcomes,
      latestOutreachDraft: latestDraft ?? null,
      createdAt: lead.createdAt.toISOString(),
      updatedAt: lead.updatedAt.toISOString(),
    });
  }

  return { domain: 'leads', header, csvRows, jsonRecords };
}

async function readCompaniesDomain(tx: Tx): Promise<FormattedDomainData> {
  const canonicals = await fetchPaginated((cursorId) =>
    tx.canonicalCompany.findMany({
      take: DATA_EXPORT_PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      orderBy: [{ id: 'asc' }],
      include: {
        companyContactPoints: {
          select: { kind: true, value: true, status: true },
        },
      },
    }),
  );

  const profiles = await fetchPaginated((cursorId) =>
    tx.companyProfile.findMany({
      where: { deletedAt: null },
      take: DATA_EXPORT_PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      orderBy: [{ id: 'asc' }],
      include: {
        offerings: {
          select: { id: true, name: true, description: true, attributes: true },
        },
      },
    }),
  );
  assertRowBound(canonicals.length + profiles.length);

  const header = [
    'recordType',
    'id',
    'name',
    'domainOrWebsite',
    'country',
    'region',
    'industry',
    'status',
    'employeeCount',
    'revenueUsd',
    'contactPointsOrSummary',
    'createdAt',
    'updatedAt',
  ] as const;

  const csvRows: CsvValue[][] = [];
  const jsonRecords: Record<string, unknown>[] = [];
  for (const company of canonicals) {
    csvRows.push([
      'canonical_company',
      company.id,
      company.name,
      company.domain ?? '',
      company.country ?? '',
      company.region ?? '',
      company.industry ?? '',
      company.status,
      company.employeeCount ?? null,
      company.revenueUsd ?? null,
      jsonText(company.companyContactPoints),
      iso(company.createdAt),
      iso(company.updatedAt),
    ]);
    jsonRecords.push({
      recordType: 'canonical_company',
      id: company.id,
      name: company.name,
      domain: company.domain,
      country: company.country,
      region: company.region,
      industry: company.industry,
      employeeCount: company.employeeCount,
      revenueUsd: company.revenueUsd,
      attributes: company.attributes,
      status: company.status,
      dedupeKey: company.dedupeKey,
      contactPoints: company.companyContactPoints,
      createdAt: company.createdAt.toISOString(),
      updatedAt: company.updatedAt.toISOString(),
    });
  }
  for (const profile of profiles) {
    csvRows.push([
      'company_profile',
      profile.id,
      profile.name,
      profile.website ?? '',
      '',
      '',
      profile.industry ?? '',
      profile.status,
      null,
      null,
      profile.summary ?? '',
      iso(profile.createdAt),
      iso(profile.updatedAt),
    ]);
    jsonRecords.push({
      recordType: 'company_profile',
      id: profile.id,
      name: profile.name,
      website: profile.website,
      status: profile.status,
      industry: profile.industry,
      industryCode: profile.industryCode,
      targetMarkets: profile.targetMarkets,
      businessEmail: profile.businessEmail,
      summary: profile.summary,
      publicContacts: profile.publicContacts,
      offerings: profile.offerings,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
    });
  }

  return { domain: 'companies', header, csvRows, jsonRecords };
}

async function readContactsDomain(tx: Tx): Promise<FormattedDomainData> {
  // Query via Prisma ORM so piiExtension decrypts fullName & contactPoint.value transparently.
  const contacts = await fetchPaginated((cursorId) =>
    tx.canonicalContact.findMany({
      take: DATA_EXPORT_PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      orderBy: [{ id: 'asc' }],
      include: {
        company: { select: { name: true, domain: true } },
        contactPoints: {
          select: {
            id: true,
            type: true,
            value: true,
            status: true,
            verificationState: true,
            emailType: true,
            sourceType: true,
            sourceUrl: true,
            legalBasis: true,
            verifiedAt: true,
            createdAt: true,
          },
          orderBy: [{ createdAt: 'asc' }],
        },
      },
    }),
  );

  const header = [
    'contactId',
    'companyId',
    'companyName',
    'companyDomain',
    'fullName',
    'title',
    'seniority',
    'department',
    'contactPointId',
    'contactPointType',
    'contactPointValue',
    'contactPointStatus',
    'verificationState',
    'emailType',
    'sourceType',
    'legalBasis',
    'verifiedAt',
    'createdAt',
  ] as const;

  const csvRows: CsvValue[][] = [];
  const jsonRecords: Record<string, unknown>[] = [];
  for (const contact of contacts) {
    jsonRecords.push({
      id: contact.id,
      companyId: contact.companyId,
      companyName: contact.company.name,
      companyDomain: contact.company.domain,
      fullName: contact.fullName,
      title: contact.title,
      seniority: contact.seniority,
      department: contact.department,
      contactPoints: contact.contactPoints.map((cp) => ({
        ...cp,
        verifiedAt: cp.verifiedAt?.toISOString() ?? null,
        createdAt: cp.createdAt.toISOString(),
      })),
      createdAt: contact.createdAt.toISOString(),
    });
    if (contact.contactPoints.length === 0) {
      csvRows.push([
        contact.id,
        contact.companyId,
        contact.company.name,
        contact.company.domain ?? '',
        contact.fullName,
        contact.title ?? '',
        contact.seniority ?? '',
        contact.department ?? '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        iso(contact.createdAt),
      ]);
      continue;
    }
    for (const cp of contact.contactPoints) {
      csvRows.push([
        contact.id,
        contact.companyId,
        contact.company.name,
        contact.company.domain ?? '',
        contact.fullName,
        contact.title ?? '',
        contact.seniority ?? '',
        contact.department ?? '',
        cp.id,
        cp.type,
        cp.value,
        cp.status,
        cp.verificationState,
        cp.emailType ?? '',
        cp.sourceType,
        cp.legalBasis ?? '',
        iso(cp.verifiedAt),
        iso(contact.createdAt),
      ]);
    }
  }

  return { domain: 'contacts', header, csvRows, jsonRecords };
}

async function readOutreachDomain(tx: Tx): Promise<FormattedDomainData> {
  const drafts = await fetchPaginated((cursorId) =>
    tx.leadOutreachDraft.findMany({
      take: DATA_EXPORT_PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      orderBy: [{ id: 'asc' }],
    }),
  );
  const suppressions = await fetchPaginated((cursorId) =>
    tx.suppressionRecord.findMany({
      take: DATA_EXPORT_PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      orderBy: [{ id: 'asc' }],
    }),
  );
  const decisions = await fetchPaginated((cursorId) =>
    tx.suppressionDecision.findMany({
      take: DATA_EXPORT_PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      orderBy: [{ id: 'asc' }],
    }),
  );
  assertRowBound(drafts.length + suppressions.length + decisions.length);

  const header = [
    'recordType',
    'id',
    'leadOrSuppressionId',
    'version',
    'language',
    'subjectOrType',
    'bodyOrValue',
    'reasonOrProtection',
    'decision',
    'createdAt',
  ] as const;

  const csvRows: CsvValue[][] = [];
  const jsonRecords: Record<string, unknown>[] = [];
  for (const draft of drafts) {
    csvRows.push([
      'outreach_draft',
      draft.id,
      draft.leadId,
      draft.version,
      draft.language,
      draft.subject,
      draft.body,
      draft.model,
      '',
      iso(draft.createdAt),
    ]);
    jsonRecords.push({
      recordType: 'outreach_draft',
      ...draft,
      createdAt: draft.createdAt.toISOString(),
    });
  }
  for (const sup of suppressions) {
    csvRows.push([
      'suppression_record',
      sup.id,
      sup.id,
      null,
      '',
      sup.type,
      sup.value,
      `${sup.reason ?? ''}:${sup.protectionClass}`,
      '',
      iso(sup.createdAt),
    ]);
    jsonRecords.push({
      recordType: 'suppression_record',
      ...sup,
      createdAt: sup.createdAt.toISOString(),
    });
  }
  for (const dec of decisions) {
    csvRows.push([
      'suppression_decision',
      dec.id,
      dec.suppressionId,
      null,
      '',
      dec.requestedDecision,
      dec.requestId,
      dec.reasonCode,
      dec.decision,
      iso(dec.createdAt),
    ]);
    jsonRecords.push({
      recordType: 'suppression_decision',
      ...dec,
      createdAt: dec.createdAt.toISOString(),
    });
  }

  return { domain: 'outreach', header, csvRows, jsonRecords };
}

async function readSellerDocumentsDomain(tx: Tx): Promise<FormattedDomainData> {
  const docs = await fetchPaginated((cursorId) =>
    tx.sellerDocument.findMany({
      where: { deletedAt: null },
      take: DATA_EXPORT_PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      orderBy: [{ id: 'asc' }],
      select: {
        id: true,
        companyId: true,
        filename: true,
        mime: true,
        sizeBytes: true,
        kind: true,
        status: true,
        contentHash: true,
        parseRevision: true,
        chunkCount: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  );

  const header = [
    'id',
    'companyId',
    'filename',
    'mime',
    'sizeBytes',
    'kind',
    'status',
    'contentHash',
    'parseRevision',
    'chunkCount',
    'createdAt',
    'updatedAt',
  ] as const;

  const csvRows = docs.map((d) => [
    d.id,
    d.companyId,
    d.filename,
    d.mime,
    Number(d.sizeBytes),
    d.kind,
    d.status,
    d.contentHash ?? '',
    d.parseRevision ?? null,
    d.chunkCount,
    iso(d.createdAt),
    iso(d.updatedAt),
  ]);
  const jsonRecords = docs.map((d) => ({
    ...d,
    sizeBytes: Number(d.sizeBytes),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  }));

  return { domain: 'seller_documents', header, csvRows, jsonRecords };
}

async function readDiscoveryRunsDomain(tx: Tx): Promise<FormattedDomainData> {
  const runs = await fetchPaginated((cursorId) =>
    tx.discoveryRun.findMany({
      take: DATA_EXPORT_PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      orderBy: [{ id: 'asc' }],
      select: {
        id: true,
        planId: true,
        icpId: true,
        status: true,
        mode: true,
        stats: true,
        phases: true,
        createdAt: true,
        completedAt: true,
      },
    }),
  );
  const header = [
    'id',
    'planId',
    'icpId',
    'status',
    'mode',
    'stats',
    'createdAt',
    'completedAt',
  ] as const;
  const csvRows = runs.map((r) => [
    r.id,
    r.planId,
    r.icpId,
    r.status,
    r.mode,
    jsonText(r.stats),
    iso(r.createdAt),
    iso(r.completedAt),
  ]);
  const jsonRecords = runs.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
  }));
  return { domain: 'discovery_runs', header, csvRows, jsonRecords };
}

async function readIcpsDomain(tx: Tx): Promise<FormattedDomainData> {
  const icps = await fetchPaginated((cursorId) =>
    tx.icpDefinition.findMany({
      take: DATA_EXPORT_PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      orderBy: [{ id: 'asc' }],
      include: {
        rules: {
          select: { id: true, kind: true, field: true, operator: true, value: true, weight: true },
        },
      },
    }),
  );
  const header = [
    'id',
    'companyId',
    'name',
    'status',
    'version',
    'targetMarkets',
    'ruleCount',
    'createdAt',
    'updatedAt',
  ] as const;
  const csvRows = icps.map((i) => [
    i.id,
    i.companyId,
    i.name,
    i.status,
    i.version,
    jsonText(i.targetMarkets),
    i.rules.length,
    iso(i.createdAt),
    iso(i.updatedAt),
  ]);
  const jsonRecords = icps.map((i) => ({
    ...i,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  }));
  return { domain: 'icps', header, csvRows, jsonRecords };
}

function serializeDomain(
  data: FormattedDomainData,
  format: DataExportFormat,
): Buffer {
  if (format === 'csv') {
    return Buffer.from(encodeCsv(data.header, data.csvRows), 'utf8');
  }
  const text =
    data.jsonRecords.length === 0
      ? ''
      : `${data.jsonRecords.map((r) => JSON.stringify(r)).join('\n')}\n`;
  return Buffer.from(text, 'utf8');
}

export async function buildWorkspaceExportPayload(
  tx: Tx,
  input: { workspaceId: string; exportId: string; scope: DataExportScope; format: DataExportFormat },
  now: Date = new Date(),
): Promise<BuiltExportPayload> {
  if (input.scope !== 'full_archive') {
    const readers: Record<Exclude<DataExportScope, 'full_archive'>, (t: Tx) => Promise<FormattedDomainData>> = {
      leads: readLeadsDomain,
      companies: readCompaniesDomain,
      contacts: readContactsDomain,
      outreach: readOutreachDomain,
    };
    const domainData = await readers[input.scope](tx);
    const body = serializeDomain(domainData, input.format);
    if (body.byteLength > DATA_EXPORT_MAX_BYTES) {
      throw new DataExportTooLargeError();
    }
    return {
      body,
      contentType:
        input.format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/x-ndjson; charset=utf-8',
      ext: input.format,
      rowCount:
        input.format === 'csv' ? domainData.csvRows.length : domainData.jsonRecords.length,
    };
  }

  const domains = await Promise.all([
    readLeadsDomain(tx),
    readCompaniesDomain(tx),
    readContactsDomain(tx),
    readOutreachDomain(tx),
    readSellerDocumentsDomain(tx),
    readDiscoveryRunsDomain(tx),
    readIcpsDomain(tx),
  ]);

  const counts: Record<string, number> = {};
  let totalRows = 0;
  let totalUncompressed = 0;
  const entries: ZipEntryInput[] = [];
  for (const domainData of domains) {
    const buf = serializeDomain(domainData, input.format);
    totalUncompressed += buf.byteLength;
    if (totalUncompressed > DATA_EXPORT_MAX_BYTES) {
      throw new DataExportTooLargeError();
    }
    const count =
      input.format === 'csv' ? domainData.csvRows.length : domainData.jsonRecords.length;
    counts[domainData.domain] = count;
    totalRows += count;
    entries.push({
      name: `${domainData.domain}.${input.format}`,
      data: buf,
    });
  }

  entries.push({
    name: 'manifest.json',
    data: JSON.stringify(
      {
        schemaVersion: 'data-export-manifest/v1',
        workspaceId: input.workspaceId,
        exportId: input.exportId,
        scope: input.scope,
        format: input.format,
        exportedAt: now.toISOString(),
        counts,
      },
      null,
      2,
    ),
  });

  const body = buildZipArchive(entries, now);
  if (body.byteLength > DATA_EXPORT_MAX_BYTES) {
    throw new DataExportTooLargeError();
  }
  return {
    body,
    contentType: 'application/zip',
    ext: 'zip',
    rowCount: totalRows,
  };
}
