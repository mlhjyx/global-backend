import { Prisma } from '@prisma/client';
import { readManufacturerNetworkEvidence } from '../discovery/manufacturer-network-evidence';
import { manufacturerNameKey } from '../discovery/manufacturer-network-sources';

const FIELD = 'manufacturer_network.evidence';
interface Subject {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  attributes: unknown;
}
interface CurrentField {
  companyId: string;
  workspaceId: string;
  providerKey: string;
  license: string;
  allowedActions: unknown;
  sourceUrl: string | null;
  fetchedAt: Date;
  value: unknown;
  proofMatched: boolean;
}

/**
 * Current field only: absent => undefined, present but unverified => null (unknown).
 * The proof table is app_user SELECT-only; a bare namespace or writable FE cannot
 * authenticate a deadline. Expired proofs remain readable here as past deadlines,
 * without granting current T2 eligibility or renewing their original capture.
 */
export async function loadManufacturerProofExpiries(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  companies: readonly Subject[],
  fields: readonly { entityId: string; field: string }[],
  now = new Date(),
): Promise<Map<string, string | null>> {
  const fieldOwners = new Set(fields.filter(row => row.field === FIELD).map(row => row.entityId));
  const subjects = new Map(companies.filter(company => fieldOwners.has(company.id) ||
    (company.attributes !== null && typeof company.attributes === 'object' &&
      Object.hasOwn(company.attributes, 'manufacturer_network'))).map(company => [company.id, company]));
  const expiries = new Map<string, string | null>([...subjects.keys()].map(id => [id, null]));
  if (!subjects.size) return expiries;
  // One current FE per company, not the earliest proof from an unbounded history.
  // Do not add an expiry predicate: losing an expired field would extend validity.
  const rows = await tx.$queryRaw<CurrentField[]>`
    SELECT c.id AS "companyId", current_field.workspace_id AS "workspaceId",
      current_field.provider_key AS "providerKey", current_field.license,
      current_field.allowed_actions AS "allowedActions", current_field.source_url AS "sourceUrl",
      current_field.fetched_at AS "fetchedAt", current_field.value,
      EXISTS (SELECT 1 FROM public.manufacturer_network_evidence p
        WHERE p.workspace_id = c.workspace_id AND p.company_id = c.id
          AND p.evidence = current_field.value) AS "proofMatched"
    FROM public.canonical_company c
    JOIN LATERAL (
      SELECT f.workspace_id, f.provider_key, f.license, f.allowed_actions, f.source_url, f.fetched_at, f.value
      FROM public.field_evidence f
      WHERE f.workspace_id = ${workspaceId}::uuid AND f.entity_type = 'company'
        AND f.entity_id = c.id AND f.field = ${FIELD}
      ORDER BY f.fetched_at DESC, f.id DESC LIMIT 1
    ) current_field ON true
    WHERE c.workspace_id = ${workspaceId}::uuid
      AND c.id IN (${Prisma.join([...subjects.keys()].map(id => Prisma.sql`${id}::uuid`))})`;
  for (const row of rows) {
    const subject = subjects.get(row.companyId);
    const proof = readManufacturerNetworkEvidence(row.value);
    const fetchedAt = row.fetchedAt instanceof Date ? row.fetchedAt.getTime() : NaN;
    if (!subject || !proof || row.proofMatched !== true || row.workspaceId !== workspaceId ||
      proof.workspaceId !== workspaceId || proof.companyId !== subject.id ||
      subject.country !== 'DE' || proof.targetDomain !== subject.domain?.replace(/^www\./u, '') ||
      manufacturerNameKey(proof.targetName) !== manufacturerNameKey(subject.name) ||
      fetchedAt !== Date.parse(proof.fetchedAt) || fetchedAt > now.getTime() ||
      row.providerKey !== 'manufacturer_network' || row.license !== proof.licenseLabel ||
      row.sourceUrl !== proof.sourceUrl || JSON.stringify(row.allowedActions) !== JSON.stringify(proof.allowedActions)) continue;
    expiries.set(subject.id, proof.expiresAt);
  }
  return expiries;
}
