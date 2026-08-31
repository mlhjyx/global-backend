import { types } from 'node:util';
import { Prisma } from '@prisma/client';
import { ApplicationFailure } from '@temporalio/activity';
import { companyIdentity } from '../discovery/identity';
import { loadMaterializableCompanyState } from '../discovery/company-suppression-gate';
import type { PrecomputedCompanySuppressionDecision } from '../discovery/company-suppression-gate';
import { assertProductDiscoveryProvenance, resolveEvidenceLicense } from '../discovery/evidence-license';
import {
  canonicalCompanyAttributesEqual,
  mergeCanonicalCompanyAttributes,
  sanitizeCanonicalCompanyAttributes,
  sanitizeStoredCompanyFieldEvidence,
} from '../discovery/canonical-company-attributes';

type Data = Readonly<Record<string, unknown>>;
type Transaction = Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const Q_KEYS = ['queryItemId', 'queryKey', 'queryOrdinal', 'providerKey', 'recordIndex',
  'operationId', 'rawRecordId', 'rawGovernedSubjectId', 'qRelationId', 'qIngestStatus'] as const;
const FACT_KEYS = ['rawStatus', 'rawExpiredAt', 'restrictedDispositionId',
  'suppressionRecordIds', 'product'] as const;

function fail(code: string): never { throw ApplicationFailure.nonRetryable(code, code); }
function field(value: Data, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
function record(value: unknown, keys: readonly string[]): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
      keys.some((key) => descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key]!, 'value')))
    fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  return value as Data;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  return value;
}
function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum)
    fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  return Number(value);
}
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function productRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value) &&
    Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : null;
}

async function readEvidenceManifest(transaction: Transaction, workspaceId: string,
  canonicalCompanyId: string, rawRecordId: string): Promise<Readonly<{ count: number; sha256: string }>> {
  const rows = await transaction.$queryRaw<unknown[]>(Prisma.sql`
    SELECT count(*)::integer AS evidence_count,
      encode(digest(convert_to(coalesce(jsonb_agg(jsonb_build_array(
        evidence.field,evidence.id,encode(digest(evidence.value::text,'sha256'),'hex'),
        evidence.provider_key,evidence.license,
        encode(digest(coalesce(evidence.allowed_actions,'null'::jsonb)::text,'sha256'),'hex')
        ORDER BY evidence.field,evidence.id),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex')
        AS evidence_manifest_sha256
    FROM field_evidence evidence
    WHERE evidence.workspace_id=${workspaceId}::uuid AND evidence.entity_type='company'
      AND evidence.entity_id=${canonicalCompanyId}::uuid AND evidence.raw_record_id=${rawRecordId}::uuid
  `);
  if (!Array.isArray(rows) || rows.length !== 1) fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  const row = record(rows[0], ['evidence_count', 'evidence_manifest_sha256']);
  const sha256 = field(row, 'evidence_manifest_sha256');
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sha256))
    fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  return Object.freeze({ count: count(field(row, 'evidence_count'), 1_000_000), sha256 });
}

export async function materializeDiscoveryCompanyCanonicalCandidate(
  transaction: Transaction,
  workspaceId: string,
  candidate: Data,
  suppressionDecision?: PrecomputedCompanySuppressionDecision,
  reusableCanonical?: Readonly<{ id: string; dedupeKey: string; name: string; domain: string | null; status: string }>,
): Promise<Data> {
  const qItem = record(field(candidate, 'qItem'), Q_KEYS);
  const facts = record(field(candidate, 'lockedFacts'), FACT_KEYS);
  const reusableValue = field(candidate, 'reusableIdentity');
  if (reusableValue !== null) {
    const reusable = record(reusableValue, ['canonicalCompanyId', 'identityLinkId', 'identityCanonicalType',
      'canonicalGovernedSubjectId', 'cRelationId', 'cRelationKey', 'matchRule', 'confidence',
      'mutationClass', 'evidenceCount', 'evidenceManifestSha256']);
    if (!reusableCanonical || !suppressionDecision ||
        uuid(field(reusable, 'canonicalCompanyId')) !== reusableCanonical.id ||
        suppressionDecision.canonicalCompanyId !== reusableCanonical.id)
      fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
    let state: Awaited<ReturnType<typeof loadMaterializableCompanyState>>;
    try {
      state = await loadMaterializableCompanyState(transaction, workspaceId, reusableCanonical.dedupeKey,
        { name: reusableCanonical.name, domain: reusableCanonical.domain },
        { precomputedSuppressionDecision: suppressionDecision });
    } catch (error) {
      if (error instanceof Error && error.message === 'COMPANY_SUPPRESSION_DECISION_INVALID')
        fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
      throw error;
    }
    const suppressionIds = field(facts, 'suppressionRecordIds');
    if (Array.isArray(suppressionIds) && suppressionIds.length > 0) {
      if (state.allowed) fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
      return candidate;
    }
    if (!state.allowed) fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
    return candidate;
  }
  if (field(candidate, 'exactExistingOutcome') !== null || field(qItem, 'qIngestStatus') !== 'ACCEPTED' ||
      field(facts, 'restrictedDispositionId') !== null ||
      field(facts, 'rawStatus') === 'EXPIRED') return candidate;
  const product = productRecord(field(facts, 'product'));
  const name = product ? optionalText(product.name) : undefined;
  if (!product || !name) return Object.freeze({ ...candidate,
    companyParse: Object.freeze({ status: 'INVALID', reasonCode: 'MISSING_NAME' }) });
  const providerKey = field(qItem, 'providerKey');
  if (typeof providerKey !== 'string') fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  try { assertProductDiscoveryProvenance({ providerKey, license: product.license }); }
  catch { return Object.freeze({ ...candidate,
    companyParse: Object.freeze({ status: 'INVALID', reasonCode: 'NON_PRODUCT_PROVENANCE' }) }); }
  const domain = optionalText(product.domain), country = optionalText(product.country);
  const rawIdentifier = product.identifier;
  const identifier = rawIdentifier && typeof rawIdentifier === 'object' && !Array.isArray(rawIdentifier)
    ? rawIdentifier as { scheme?: unknown; value?: unknown } : undefined;
  if (identifier && (typeof identifier.scheme !== 'string' || typeof identifier.value !== 'string'))
    return Object.freeze({ ...candidate,
      companyParse: Object.freeze({ status: 'INVALID', reasonCode: 'COMPANY_IDENTITY_INVALID' }) });
  const identity = companyIdentity({ name, domain, country, identifier: identifier
    ? { scheme: identifier.scheme as string, value: identifier.value as string } : undefined });
  let materialization: Awaited<ReturnType<typeof loadMaterializableCompanyState>>;
  try {
    materialization = await loadMaterializableCompanyState(transaction, workspaceId,
      identity.dedupeKey, { name, domain }, suppressionDecision
        ? { precomputedSuppressionDecision: suppressionDecision } : undefined);
  } catch (error) {
    if (error instanceof Error && error.message === 'COMPANY_SUPPRESSION_DECISION_INVALID')
      fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
    throw error;
  }
  const suppressionIds = field(facts, 'suppressionRecordIds');
  if (Array.isArray(suppressionIds) && suppressionIds.length > 0) {
    if (materialization.allowed) fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
    return candidate;
  }
  if (!materialization.allowed) fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
  const rawRecordId = uuid(field(qItem, 'rawRecordId'));
  const existingLink = await transaction.identityLink.findFirst({
    where: { workspaceId, canonicalType: 'company', rawRecordId },
    select: { id: true, canonicalId: true, matchRule: true, confidence: true },
  });
  if (existingLink) {
    const expectedConfidence = identity.matchRule === 'name_country' ? 0.8 : 1;
    if (!materialization.prior || existingLink.canonicalId !== materialization.prior.id ||
        existingLink.matchRule !== identity.matchRule || existingLink.confidence !== expectedConfidence)
      fail('DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT');
    const manifest = await readEvidenceManifest(transaction, workspaceId, existingLink.canonicalId, rawRecordId);
    return Object.freeze({ ...candidate,
      companyParse: Object.freeze({ status: 'VALID', dedupeKey: identity.dedupeKey }),
      canonicalWrite: Object.freeze({ canonicalCompanyId: existingLink.canonicalId,
        identityLinkId: existingLink.id, identityCanonicalType: 'company', canonicalGovernedSubjectId: null,
        cRelationId: null, cRelationKey: `discovery.canonical_company:${count(field(qItem, 'recordIndex'), 999_999)}`,
        matchRule: existingLink.matchRule, confidence: existingLink.confidence, mutationClass: 'LINKED',
        evidenceCount: manifest.count, evidenceManifestSha256: manifest.sha256 }) });
  }
  const attributes = product.attributes && typeof product.attributes === 'object' && !Array.isArray(product.attributes)
    ? product.attributes as Record<string, unknown> : undefined;
  const currentAttributes = sanitizeCanonicalCompanyAttributes(attributes), prior = materialization.prior;
  const priorScalars = prior ? await transaction.canonicalCompany.findUnique({
    where: { id: prior.id }, select: { id: true, domain: true, country: true, region: true,
      industry: true, employeeCount: true, revenueUsd: true },
  }) : null;
  if (prior && (!priorScalars || priorScalars.id !== prior.id))
    fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
  const canonicalAttributes = mergeCanonicalCompanyAttributes(prior?.attributes, currentAttributes);
  const attributesChanged = prior ? materialization.attributesRequireRepair ||
    !canonicalCompanyAttributesEqual(canonicalAttributes, prior.attributes) : true;
  const region = optionalText(product.region), industry = optionalText(product.industry);
  const employeeCount = Number.isSafeInteger(product.employeeCount) ? Number(product.employeeCount) : undefined;
  const revenueUsd = typeof product.revenueUsd === 'number' && Number.isFinite(product.revenueUsd) ? product.revenueUsd : undefined;
  const domainChanged = Boolean(priorScalars && priorScalars.domain === null && domain),
    countryChanged = Boolean(priorScalars && priorScalars.country === null && country),
    regionChanged = Boolean(priorScalars && priorScalars.region === null && region),
    industryChanged = Boolean(priorScalars && priorScalars.industry === null && industry),
    employeeCountChanged = Boolean(priorScalars && priorScalars.employeeCount === null && employeeCount !== undefined),
    revenueUsdChanged = Boolean(priorScalars && priorScalars.revenueUsd === null && revenueUsd !== undefined);
  const canonicalChanged = !prior || attributesChanged || domainChanged || countryChanged || regionChanged ||
    industryChanged || employeeCountChanged || revenueUsdChanged;
  const canonical = canonicalChanged ? await transaction.canonicalCompany.upsert({
    where: { workspaceId_dedupeKey: { workspaceId, dedupeKey: identity.dedupeKey } },
    update: { ...(domainChanged ? { domain: { set: domain } } : {}),
      ...(countryChanged ? { country: { set: country } } : {}), ...(regionChanged ? { region: { set: region } } : {}),
      ...(industryChanged ? { industry: { set: industry } } : {}),
      ...(employeeCountChanged ? { employeeCount: { set: employeeCount } } : {}),
      ...(revenueUsdChanged ? { revenueUsd: { set: revenueUsd } } : {}),
      ...(attributesChanged ? { attributes: canonicalAttributes as Prisma.InputJsonValue } : {}), version: { increment: 1 } },
    create: { workspaceId, name, domain: domain ?? null, country: country ?? null, region: region ?? null,
      industry: industry ?? null, employeeCount: employeeCount ?? null, revenueUsd: revenueUsd ?? null,
      attributes: canonicalAttributes as Prisma.InputJsonValue, status: 'NEW', dedupeKey: identity.dedupeKey },
    select: { id: true },
  }) : { id: prior!.id };
  let identityLink: { id: string };
  try {
    identityLink = await transaction.identityLink.create({ data: { workspaceId, canonicalType: 'company',
      canonicalId: canonical.id, rawRecordId, matchRule: identity.matchRule,
      confidence: identity.matchRule === 'name_country' ? 0.8 : 1 }, select: { id: true } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      fail('DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT');
    throw error;
  }
  const evidenceFields: readonly [string, unknown][] = [['name', name], ['domain', domain], ['country', country],
    ['region', region], ['industry', product.industry], ['employee_count', product.employeeCount],
    ['revenue_usd', product.revenueUsd], ['attributes', currentAttributes]];
  for (const [evidenceField, value] of evidenceFields) {
    if (value === undefined || value === null) continue;
    const governedValue = sanitizeStoredCompanyFieldEvidence(evidenceField, value);
    if (governedValue === undefined) continue;
    await transaction.fieldEvidence.create({ data: { workspaceId, entityType: 'company', entityId: canonical.id,
      field: evidenceField, value: governedValue as Prisma.InputJsonValue, providerKey, rawRecordId,
      license: resolveEvidenceLicense(optionalText(product.license), providerKey),
      allowedActions: ['display', 'match'] as Prisma.InputJsonValue } });
  }
  const manifest = await readEvidenceManifest(transaction, workspaceId, canonical.id, rawRecordId);
  return Object.freeze({ ...candidate,
    companyParse: Object.freeze({ status: 'VALID', dedupeKey: identity.dedupeKey }),
    canonicalWrite: Object.freeze({ canonicalCompanyId: canonical.id, identityLinkId: identityLink.id,
      identityCanonicalType: 'company', canonicalGovernedSubjectId: null, cRelationId: null,
      cRelationKey: `discovery.canonical_company:${count(field(qItem, 'recordIndex'), 999_999)}`,
      matchRule: identity.matchRule, confidence: identity.matchRule === 'name_country' ? 0.8 : 1,
      mutationClass: prior ? (canonicalChanged ? 'UPDATED' : 'LINKED') : 'CREATED',
      evidenceCount: manifest.count, evidenceManifestSha256: manifest.sha256 }) });
}
