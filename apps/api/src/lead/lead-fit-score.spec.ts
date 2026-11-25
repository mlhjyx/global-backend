import { describe, expect, it } from 'vitest';
import {
  deriveAuthoritativeFitScore,
  effectiveIndustryForDataQuality,
  hasReachableCompanyChannel,
} from './lead-fit-score';
import { scoreLead, type CompanyForScoring, type IcpForScoring } from './scoring';

const EMPTY_ICP: IcpForScoring = { rules: [], triggerSignals: [], committeeRoles: [] };

function mkCompany(over: Partial<CompanyForScoring> = {}): CompanyForScoring {
  return {
    name: 'Test Solar Srl',
    domain: 'testsolar.it',
    country: 'IT',
    industry: null,
    employeeCount: null,
    revenueUsd: null,
    attributes: null,
    status: 'ENRICHED',
    contacts: [],
    companyContactPoints: [],
    ...over,
  };
}

describe('lead-fit-score & scoring differentiation', () => {
  it('returns null when fitReasons lacks v2 criterion scores (preserves legacy static fallback)', () => {
    expect(deriveAuthoritativeFitScore('match', null)).toBeNull();
    expect(deriveAuthoritativeFitScore('weak', { reasons: ['legacy text'] })).toBeNull();
  });

  it('strictly separates strong weak PV buyers from all-unclear and failed-criterion junk', () => {
    const ioSolar = deriveAuthoritativeFitScore('weak', {
      material: 'pass（score 8）：经营光伏组件分销',
      role: 'pass（score 10）：专业光伏批发商',
      process: 'unclear（score —）：未提制造工艺',
      business_model: 'pass（score 10）：B2B 渠道分销',
      reasons: ['聚合 v2：verdict=UNKNOWN，加权分=证据门/硬门先决'],
    });
    const hackingTeam = deriveAuthoritativeFitScore('weak', {
      material: 'unclear（score —）：无信息',
      role: 'unclear（score —）：无信息',
      process: 'unclear（score —）：无信息',
      business_model: 'unclear（score —）：无信息',
    });
    const vipItalia = deriveAuthoritativeFitScore('weak', {
      material: 'unclear（score —）：美容设备',
      role: 'fail（score 3）：美容仪制造商，非光伏买家',
      process: 'not_applicable（score —）：不适用',
      business_model: 'fail（score 2）：无关行业',
    });
    const strongMatch = deriveAuthoritativeFitScore('match', {
      material: 'pass（score 9）：光伏组件分销',
      role: 'pass（score 10）：EPC/分销商',
      process: 'not_applicable（score —）：不适用',
      business_model: 'pass（score 10）：B2B 批发',
      reasons: ['聚合 v2：verdict=FIT，加权分=9.60，reasonCodes=FIT'],
    });

    expect(strongMatch).toBeGreaterThanOrEqual(0.95);
    expect(ioSolar).toBeGreaterThanOrEqual(0.65);
    expect(hackingTeam).toBe(0.25);
    expect(vipItalia).toBe(0.15);
    expect(strongMatch!).toBeGreaterThan(ioSolar!);
    expect(ioSolar!).toBeGreaterThan(hackingTeam!);
    expect(hackingTeam!).toBeGreaterThan(vipItalia!);
  });

  it('counts company_contact_channel phone/email/form_url into reachability and website_profile.trade_role into dataQuality', () => {
    expect(hasReachableCompanyChannel([], [{ channel: 'phone', status: 'UNVERIFIED' }])).toBe(true);
    expect(hasReachableCompanyChannel([], [{ channel: 'email', status: 'INVALID' }])).toBe(false);
    expect(effectiveIndustryForDataQuality(null, { website_profile: { trade_role: 'distributor' } })).toBe('distributor');

    const res = scoreLead(
      mkCompany({
        attributes: { website_profile: { trade_role: 'distributor' } },
        companyContactChannels: [{ channel: 'email', status: 'UNVERIFIED' }],
      }),
      EMPTY_ICP,
      {
        authoritativeFit: 'match',
        fitReasons: {
          material: 'pass（score 9）：PV',
          role: 'pass（score 10）：distributor',
          reasons: ['聚合 v2：verdict=FIT，加权分=9.50'],
        },
      },
    );
    expect(res.scores.reachability).toBe(1);
    expect(res.scores.dataQuality).toBe(0.75);
    expect(res.scores.fit).toBeGreaterThan(0.95);
    expect(res.queue).toBe('recommended');
  });
});
