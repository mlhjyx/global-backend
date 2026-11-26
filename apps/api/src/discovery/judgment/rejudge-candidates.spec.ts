import { describe, expect, it, vi } from 'vitest';
import { isContactFreeText } from '../raw-source-provider-normalizer';
import { sanitizeCanonicalCompanyAttributes } from '../canonical-company-attributes';
import { WEBSITE_PROFILE_PARSER_VERSION } from '../providers/website-profile.provider';
import { prepareJudgeCall } from './judge-run';
import {
  hasNonRedactedEuVat,
  selectRejudgeCandidates,
  viesAttemptToken,
} from './rejudge-candidates';
import { loadIcpBrief } from '../fit-judge';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const ICP_ID = '20000000-0000-4000-8000-000000000002';
const COMPANY_IT = '30000000-0000-4000-8000-000000000003';
const COMPANY_DE = '40000000-0000-4000-8000-000000000004';
const COMPANY_NO_VAT = '50000000-0000-4000-8000-000000000005';
const COMPANY_SUPPRESSED = '60000000-0000-4000-8000-000000000006';

const ICP_ROW = {
  id: ICP_ID,
  name: 'Italy Solar Distributors',
  companyAttributes: { trade_side: 'distributor', process_required: false },
  exclusions: ['valve manufacturer'],
  targetMarkets: ['IT'],
  company: { name: 'Liansheng Solar', summary: 'Solar modules manufacturer' },
};

function makeTx(args: {
  companies: Array<Record<string, unknown>>;
  judgments?: Array<{
    canonicalCompanyId: string;
    inputDigest: string;
    promptHash: string;
    rubricVersion: string;
  }>;
}) {
  return {
    icpDefinition: {
      findUnique: vi.fn(async () => ICP_ROW),
    },
    canonicalCompany: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const ids = (where.id as { in?: string[] } | undefined)?.in;
        return args.companies.filter((c) => {
          if (c.status === 'SUPPRESSED') return false;
          if (ids && !ids.includes(c.id as string)) return false;
          return true;
        });
      }),
    },
    judgmentRecord: {
      findMany: vi.fn(async () => args.judgments ?? []),
    },
  } as never;
}

describe('viesAttemptToken and hasNonRedactedEuVat', () => {
  it('produces a lowercase segmented token that passes marker validation and never triggers contact-free-text phone guard', () => {
    const token = viesAttemptToken('IT04553650989');
    expect(token).toMatch(/^v1-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(isContactFreeText(token)).toBe(true);
    expect(viesAttemptToken('it 0455.365.0989')).toBe(token);
    expect(viesAttemptToken('IT02053810517')).not.toBe(token);

    const sanitized = sanitizeCanonicalCompanyAttributes({
      website_profile: { _vies_attempted: token },
    });
    expect(sanitized).toEqual({ website_profile: { _vies_attempted: token } });
  });

  it('excludes German (publicly redacted) VAT IDs and invalid VAT IDs from VIES backfill eligibility', () => {
    expect(hasNonRedactedEuVat({ website_profile: { vat_id: 'IT04553650989' } })).toBe(true);
    expect(hasNonRedactedEuVat({ website_profile: { vat_id: 'DE252368289' } })).toBe(false);
    expect(hasNonRedactedEuVat({ website_profile: { vat_id: 'INVALID' } })).toBe(false);
    expect(hasNonRedactedEuVat({})).toBe(false);
  });
});

describe('selectRejudgeCandidates', () => {
  it('converges to zero candidates on repeat run for Italian VIES-matched, VIES-attempted-miss, German redacted, and no-VAT v2 companies', async () => {
    const itMatched = {
      id: COMPANY_IT,
      name: 'Effe Energy',
      domain: 'effeenergy.it',
      country: 'IT',
      industry: 'Solar',
      status: 'ENRICHED',
      attributes: {
        website_profile: {
          _parser_version: WEBSITE_PROFILE_PARSER_VERSION,
          vat_id: 'IT04553650989',
          trade_role: 'distributor',
        },
        vies: {
          vat_id: 'IT04553650989',
          legal_name: 'EFFE ENERGY SRL',
          registered_country: 'IT',
          verified_status: 'VALID',
        },
      },
    };
    const deRedacted = {
      id: COMPANY_DE,
      name: 'Centroplan GmbH',
      domain: 'centroplan.de',
      country: 'DE',
      industry: 'Solar',
      status: 'ENRICHED',
      attributes: {
        website_profile: {
          _parser_version: WEBSITE_PROFILE_PARSER_VERSION,
          vat_id: 'DE252368289',
          trade_role: 'distributor',
        },
      },
    };
    const noVatV2 = {
      id: COMPANY_NO_VAT,
      name: 'No Vat Srl',
      domain: 'novat.it',
      country: 'IT',
      industry: 'Solar',
      status: 'ENRICHED',
      attributes: {
        website_profile: {
          _parser_version: WEBSITE_PROFILE_PARSER_VERSION,
          trade_role: 'distributor',
        },
      },
    };
    const itAttemptedMiss = {
      id: '70000000-0000-4000-8000-000000000007',
      name: 'Invalid Vat Srl',
      domain: 'invalidvat.it',
      country: 'IT',
      industry: 'Solar',
      status: 'ENRICHED',
      attributes: {
        website_profile: {
          _parser_version: WEBSITE_PROFILE_PARSER_VERSION,
          vat_id: 'IT02053810517',
          _vies_attempted: viesAttemptToken('IT02053810517'),
          trade_role: 'distributor',
        },
      },
    };

    const companies = [itMatched, deRedacted, noVatV2, itAttemptedMiss];
    const probeTx = makeTx({ companies });
    const icpBrief = await loadIcpBrief(probeTx, ICP_ID);
    const judgments = companies.map((company) => {
      const prepared = prepareJudgeCall(icpBrief, company);
      return {
        canonicalCompanyId: company.id,
        inputDigest: prepared.inputDigest,
        promptHash: prepared.prompt.promptHash,
        rubricVersion: prepared.prompt.rubricVersion,
      };
    });

    const tx = makeTx({ companies, judgments });
    const candidates = await selectRejudgeCandidates(tx, {
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      refreshWebsiteProfile: true,
      refreshCorroboration: true,
      includeFresh: false,
    });

    expect(candidates).toEqual([]);
  });

  it('selects companies matching needsWebsiteV2, needsViesBackfill, or needsDigestRejudge and excludes SUPPRESSED', async () => {
    const staleProfileNoVat = {
      id: COMPANY_NO_VAT,
      name: 'Old Profile Srl',
      domain: 'oldprofile.it',
      country: 'IT',
      industry: 'Solar',
      status: 'NEW',
      attributes: { website_profile: { trade_role: 'distributor' } },
    };
    const needsVies = {
      id: COMPANY_IT,
      name: 'Italsol Srl',
      domain: 'italsolsrl.it',
      country: 'IT',
      industry: 'Solar',
      status: 'ENRICHED',
      attributes: {
        website_profile: {
          _parser_version: WEBSITE_PROFILE_PARSER_VERSION,
          vat_id: 'IT02053810517',
          trade_role: 'distributor',
        },
      },
    };
    const staleDigest = {
      id: COMPANY_DE,
      name: 'Stale Digest GmbH',
      domain: 'staledigest.de',
      country: 'DE',
      industry: 'Solar',
      status: 'ENRICHED',
      attributes: {
        website_profile: {
          _parser_version: WEBSITE_PROFILE_PARSER_VERSION,
          vat_id: 'DE252368289',
        },
      },
    };
    const suppressed = {
      id: COMPANY_SUPPRESSED,
      name: 'Suppressed Srl',
      domain: 'suppressed.it',
      country: 'IT',
      industry: 'Solar',
      status: 'SUPPRESSED',
      attributes: {},
    };

    const icpBrief = await loadIcpBrief(makeTx({ companies: [] }), ICP_ID);
    const p1 = prepareJudgeCall(icpBrief, staleProfileNoVat);
    const p2 = prepareJudgeCall(icpBrief, needsVies);
    const tx = makeTx({
      companies: [staleProfileNoVat, needsVies, staleDigest, suppressed],
      judgments: [
        // Both staleProfileNoVat & needsVies have fresh digests, so they only enter via Condition 1 & Condition 2
        {
          canonicalCompanyId: staleProfileNoVat.id,
          inputDigest: p1.inputDigest,
          promptHash: p1.prompt.promptHash,
          rubricVersion: p1.prompt.rubricVersion,
        },
        {
          canonicalCompanyId: needsVies.id,
          inputDigest: p2.inputDigest,
          promptHash: p2.prompt.promptHash,
          rubricVersion: p2.prompt.rubricVersion,
        },
        // staleDigest has an outdated inputDigest -> enters via Condition 3
        {
          canonicalCompanyId: staleDigest.id,
          inputDigest: '0'.repeat(64),
          promptHash: p2.prompt.promptHash,
          rubricVersion: p2.prompt.rubricVersion,
        },
      ],
    });

    const candidates = await selectRejudgeCandidates(tx, {
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      refreshWebsiteProfile: true,
      refreshCorroboration: true,
      includeFresh: false,
    });

    expect(candidates.map((c) => c.canonicalCompanyId).sort()).toEqual(
      [COMPANY_IT, COMPANY_DE, COMPANY_NO_VAT].sort(),
    );
  });

  it('allows includeFresh=true only with explicit companyIds and still excludes SUPPRESSED', async () => {
    const freshCompany = {
      id: COMPANY_IT,
      name: 'Fresh Srl',
      domain: 'fresh.it',
      country: 'IT',
      industry: 'Solar',
      status: 'ENRICHED',
      attributes: {
        website_profile: {
          _parser_version: WEBSITE_PROFILE_PARSER_VERSION,
          vat_id: 'IT04553650989',
        },
        vies: { vat_id: 'IT04553650989', verified_status: 'VALID' },
      },
    };
    const suppressed = {
      id: COMPANY_SUPPRESSED,
      name: 'Suppressed Srl',
      domain: 'suppressed.it',
      country: 'IT',
      industry: 'Solar',
      status: 'SUPPRESSED',
      attributes: {},
    };
    const icpBrief = await loadIcpBrief(makeTx({ companies: [] }), ICP_ID);
    const p = prepareJudgeCall(icpBrief, freshCompany);
    const tx = makeTx({
      companies: [freshCompany, suppressed],
      judgments: [
        {
          canonicalCompanyId: freshCompany.id,
          inputDigest: p.inputDigest,
          promptHash: p.prompt.promptHash,
          rubricVersion: p.prompt.rubricVersion,
        },
      ],
    });

    const candidates = await selectRejudgeCandidates(tx, {
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      companyIds: [COMPANY_IT, COMPANY_SUPPRESSED],
      refreshWebsiteProfile: false,
      refreshCorroboration: false,
      includeFresh: true,
    });

    expect(candidates).toEqual([
      {
        canonicalCompanyId: COMPANY_IT,
        companyName: 'Fresh Srl',
        domain: 'fresh.it',
        icpId: ICP_ID,
      },
    ]);
  });
});
