import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { scopeIndependentEnrichment } from '../enrichment-identity';
import { loadIcpBrief, type FitJudgeCompany } from '../fit-judge';
import {
  WEBSITE_PROFILE_PARSER_MARKER,
  WEBSITE_PROFILE_PARSER_VERSION,
} from '../providers/website-profile.provider';
import {
  normalizeEuVat,
  splitViesVat,
  VIES_PUBLIC_NAME_REDACTED_COUNTRIES,
} from '../website-profile/eu-vat';
import { prepareJudgeCall } from './judge-run';
import type { RejudgeCandidate } from './rejudge-plan';

export const VIES_ATTEMPTED_MARKER = '_vies_attempted' as const;

/**
 * Deterministic lowercase segmented token stored under `website_profile._vies_attempted`
 * after a non-transient VIES miss (`v1-xxxx-xxxx-xxxx-xxxx`).
 * - Passes `MARKER_VALUE` / `BOOKKEEPING_MARKER_VALUE` (lowercase hex + dashes).
 * - At most 4 consecutive digits per segment so it never triggers `isContactFreeText`.
 */
export function viesAttemptToken(vatId: string): string {
  const canonical = normalizeEuVat(vatId) ?? vatId.trim().toUpperCase();
  const hex = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
  return `v1-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readWebsiteProfileRecord(attributes: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(attributes)?.website_profile);
}

/**
 * True iff `website_profile.vat_id` is a valid EU VAT whose member state does NOT
 * unconditionally redact company names in public VIES responses (e.g. excludes DE).
 */
export function hasNonRedactedEuVat(attributes: unknown): boolean {
  const rawVat = readWebsiteProfileRecord(attributes)?.vat_id;
  if (typeof rawVat !== 'string') return false;
  const split = splitViesVat(rawVat);
  if (!split) return false;
  return (
    !VIES_PUBLIC_NAME_REDACTED_COUNTRIES.has(split.countryCode) &&
    !VIES_PUBLIC_NAME_REDACTED_COUNTRIES.has(split.isoCountry)
  );
}

export function needsWebsiteProfileV2Refresh(company: {
  domain: string | null;
  attributes: unknown;
}): boolean {
  if (!company.domain || company.domain.trim().length === 0) return false;
  const profile = readWebsiteProfileRecord(company.attributes);
  return (
    profile?.[WEBSITE_PROFILE_PARSER_MARKER] !== WEBSITE_PROFILE_PARSER_VERSION &&
    profile?.vat_id == null
  );
}

export function needsViesBackfill(attributes: unknown): boolean {
  if (!hasNonRedactedEuVat(attributes)) return false;
  const root = asRecord(attributes);
  if (asRecord(root?.vies)) return false;
  const profile = readWebsiteProfileRecord(attributes);
  const rawVat = profile?.vat_id;
  if (typeof rawVat !== 'string') return false;
  return profile?.[VIES_ATTEMPTED_MARKER] !== viesAttemptToken(rawVat);
}

export interface SelectRejudgeCandidatesInput {
  readonly workspaceId: string;
  readonly icpId: string;
  readonly companyIds?: readonly string[];
  readonly refreshWebsiteProfile: boolean;
  readonly refreshCorroboration: boolean;
  readonly includeFresh: boolean;
}

interface CandidateCompanyRow extends FitJudgeCompany {
  readonly status: string;
}

/**
 * Loads non-suppressed candidate companies for an ACTIVE ICP and applies the
 * three-condition convergence filter so repeated runs with identical inputs
 * converge cleanly to an empty candidate set (409 NO_REJUDGE_CANDIDATES).
 */
export async function selectRejudgeCandidates(
  tx: Prisma.TransactionClient,
  input: SelectRejudgeCandidatesInput,
): Promise<RejudgeCandidate[]> {
  const icpBrief = await loadIcpBrief(tx, input.icpId);
  const companies = (await tx.canonicalCompany.findMany({
    where: {
      workspaceId: input.workspaceId,
      status: { not: 'SUPPRESSED' },
      ...(input.companyIds
        ? { id: { in: [...input.companyIds] } }
        : {
            OR: [
              { leads: { some: { workspaceId: input.workspaceId, icpId: input.icpId } } },
              {
                judgmentRecords: {
                  some: { workspaceId: input.workspaceId, icpId: input.icpId },
                },
              },
            ],
          }),
    },
    select: {
      id: true,
      name: true,
      domain: true,
      country: true,
      industry: true,
      status: true,
      attributes: true,
    },
  })) as CandidateCompanyRow[];

  const activeCompanies = companies.filter((company) => company.status !== 'SUPPRESSED');
  if (activeCompanies.length === 0) return [];

  if (input.includeFresh && input.companyIds && input.companyIds.length > 0) {
    return activeCompanies.map((company) => ({
      canonicalCompanyId: company.id,
      companyName: company.name,
      domain: company.domain,
      icpId: input.icpId,
    }));
  }

  const preparedByCompany = new Map<
    string,
    { inputDigest: string; promptHash: string; rubricVersion: string }
  >();
  for (const company of activeCompanies) {
    const scoped: FitJudgeCompany = {
      ...company,
      attributes: scopeIndependentEnrichment(company),
    };
    const prepared = prepareJudgeCall(icpBrief, scoped);
    preparedByCompany.set(company.id, {
      inputDigest: prepared.inputDigest,
      promptHash: prepared.prompt.promptHash,
      rubricVersion: prepared.prompt.rubricVersion,
    });
  }

  const existingRecords = await tx.judgmentRecord.findMany({
    where: {
      workspaceId: input.workspaceId,
      icpId: input.icpId,
      judgeLevel: 2,
      canonicalCompanyId: { in: activeCompanies.map((company) => company.id) },
    },
    select: {
      canonicalCompanyId: true,
      inputDigest: true,
      promptHash: true,
      rubricVersion: true,
    },
  });

  const freshKeys = new Set(
    existingRecords.map(
      (row) =>
        `${row.canonicalCompanyId}\u0000${row.inputDigest}\u0000${row.promptHash}\u0000${row.rubricVersion}`,
    ),
  );

  const selected: RejudgeCandidate[] = [];
  for (const company of activeCompanies) {
    const needsWebV2 = input.refreshWebsiteProfile && needsWebsiteProfileV2Refresh(company);
    const needsVies = input.refreshCorroboration && needsViesBackfill(company.attributes);
    const expected = preparedByCompany.get(company.id)!;
    const digestKey = `${company.id}\u0000${expected.inputDigest}\u0000${expected.promptHash}\u0000${expected.rubricVersion}`;
    const needsDigest = !freshKeys.has(digestKey);
    if (needsWebV2 || needsVies || needsDigest) {
      selected.push({
        canonicalCompanyId: company.id,
        companyName: company.name,
        domain: company.domain,
        icpId: input.icpId,
      });
    }
  }
  return selected;
}
