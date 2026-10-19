import { describe, expect, it, vi } from 'vitest';
import { createQualifyActivities } from './qualify.activities';

/**
 * scoreCandidates 读公司级联系路径（BI-14 company_contact_point，#630）进可达性（评分规则 v3）。
 * 内存假 Prisma：只实现活动用到的查询面；合成 `.example` 域名。
 */

const WS = '10000000-0000-4000-8000-000000000001';
const ICP = '20000000-0000-4000-8000-000000000002';
const COMPANY_ID = '30000000-0000-4000-8000-000000000003';

type FindManyArgs = { include?: Record<string, unknown>; where?: unknown };

function fixture(options: {
  points?: Array<{ kind: string; value: string; status: string }>;
  contacts?: Array<{ title: string | null; seniority: string | null; contactPoints: { type: string; status: string }[] }>;
  suppressions?: Array<{ type: string; value: string }>;
  fitVerdict?: 'match' | 'weak' | 'mismatch' | null;
  status?: string;
  /** 制裁筛查这次的结果；不传 = 没有接筛查服务。 */
  screen?: { status: 'clear' | 'potential_match' | 'not_screened'; matches?: unknown[] };
  /** 库里该公司的 potential_match 记录（findMany 的返回）。 */
  staleHits?: Array<{ canonicalCompanyId: string; reviewState: string }>;
} = {}) {
  const company = {
    id: COMPANY_ID,
    name: 'Pumpen Handel GmbH',
    domain: 'pumpen-handel.example',
    country: 'DE',
    // xin 现状：public_web 原始记录从不带行业与员工数（150/150 家为 NULL）→ DataQuality 0.5。
    industry: null,
    employeeCount: null,
    revenueUsd: null,
    attributes: { keywords: ['industrial pumps'] },
    status: options.status ?? 'ENRICHED',
    contacts: options.contacts ?? [],
    companyContactPoints: options.points ?? [],
  };
  const findMany = vi.fn(async (_args: FindManyArgs) => [company]);
  const leadUpsert = vi.fn(async () => ({}));
  const suppressionFindMany = vi.fn(async () => options.suppressions ?? []);
  const tx = {
    icpDefinition: {
      findUnique: vi.fn(async () => ({ status: 'ACTIVE', rules: [], roles: [], triggerSignals: [] })),
    },
    canonicalCompany: { findMany },
    suppressionRecord: { findMany: suppressionFindMany },
    fieldEvidence: { findMany: vi.fn(async () => []) },
    lead: {
      findUnique: vi.fn(async () =>
        options.fitVerdict === undefined
          ? { id: 'lead-1', status: 'REVIEW', fitVerdict: 'match' }
          : options.fitVerdict === null
            ? null
            : { id: 'lead-1', status: 'REVIEW', fitVerdict: options.fitVerdict },
      ),
      upsert: leadUpsert,
    },
    sanctionsScreeningResult: {
      findFirst: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
      findMany: vi.fn(async (_args: unknown) => options.staleHits ?? []),
      updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
    },
    outboxEvent: { create: vi.fn(async () => ({})) },
  };
  const sanctionsScreening = options.screen
    ? {
        rebuildIndex: vi.fn(async () => undefined),
        screen: vi.fn(() => ({
          status: options.screen!.status,
          matches: options.screen!.matches ?? [],
          listVersions: options.screen!.status === 'not_screened' ? {} : LIST_VERSIONS,
        })),
      }
    : undefined;
  const activities = createQualifyActivities({
    prisma: {
      withWorkspace: async <T>(_workspaceId: string, callback: (client: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    } as never,
    sanctionsScreening: sanctionsScreening as never,
  });
  const upserted = () => {
    const call = leadUpsert.mock.calls[0]![0] as unknown as {
      update: { queue: string; totalScore: number; scores: Record<string, number>; scoreDetail: Record<string, unknown> };
      create: { queue: string };
    };
    return call.update;
  };
  return { activities, findMany, leadUpsert, suppressionFindMany, upserted, screening: tx.sanctionsScreeningResult };
}

const LIST_VERSIONS = { ofac_sdn: '2026-10-19', eu_fsf: '2026-10-19' };
const CONTACT_PAGE = [{ kind: 'contact_page', value: 'https://pumpen-handel.example/kontakt', status: 'UNVERIFIED' }];

describe('scoreCandidates — 公司级联系路径进可达性（评分规则 v3）', () => {
  it('include 公司级联系点（只取 VALID / UNVERIFIED），资格门 match + 联系页 → recommended（xin 的 ce100faa 形态）', async () => {
    const f = fixture({
      points: [{ kind: 'contact_page', value: 'https://pumpen-handel.example/kontakt', status: 'UNVERIFIED' }],
    });

    await expect(f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP })).resolves.toMatchObject({
      scored: 1,
      queues: { recommended: 1 },
    });

    const include = f.findMany.mock.calls[0]![0].include as Record<string, { where?: { status?: { in?: string[] } } }>;
    expect(include.companyContactPoints).toBeDefined();
    expect(include.companyContactPoints.where?.status?.in).toEqual(expect.arrayContaining(['VALID', 'UNVERIFIED']));
    expect(include.companyContactPoints.where?.status?.in).not.toContain('INVALID');

    const lead = f.upserted();
    expect(lead.queue).toBe('recommended');
    expect(lead.scores.reachability).toBe(1);
    // 0.85×0.45 (fit) + 0.20 (reach) + 0.15×0.5 (dataQuality: industry/employee_count 皆缺) = 0.6575
    expect(lead.totalScore).toBeCloseTo(0.6575, 4);
    expect(lead.scoreDetail.reasonCodes).toEqual([]);
  });

  it('无任何联系路径 → needs_review，score_detail.reasonCodes 写 MISSING_CONTACT_POINT（持久痕迹）', async () => {
    const f = fixture({ points: [] });

    await f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });

    const lead = f.upserted();
    expect(lead.queue).toBe('needs_review');
    expect(lead.scores.reachability).toBe(0);
    expect(lead.scoreDetail.reasonCodes).toContain('MISSING_CONTACT_POINT');
  });

  it('禁联在读时过滤：公司域名被禁联后，已存的联系页不再计入可达性', async () => {
    const f = fixture({
      points: [{ kind: 'contact_page', value: 'https://pumpen-handel.example/kontakt', status: 'UNVERIFIED' }],
      suppressions: [{ type: 'domain', value: 'pumpen-handel.example' }],
    });

    await f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });

    expect(f.suppressionFindMany).toHaveBeenCalled();
    const lead = f.upserted();
    expect(lead.scores.reachability).toBe(0);
    expect(lead.queue).toBe('needs_review');
    expect(lead.scoreDetail.reasonCodes).toContain('MISSING_CONTACT_POINT');
  });

  it('社交页（linkedin_company_page / x_company_account）不是联系路径 → 可达性 0', async () => {
    const f = fixture({
      points: [
        { kind: 'linkedin_company_page', value: 'https://www.linkedin.com/company/pumpen-handel', status: 'UNVERIFIED' },
        { kind: 'x_company_account', value: 'https://x.com/pumpenhandel', status: 'UNVERIFIED' },
      ],
    });

    await f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });

    expect(f.upserted().scores.reachability).toBe(0);
  });

  it('公司级与个人旧口径取大：个人 UNVERIFIED 邮箱 0.5 < 公司联系页 1.0', async () => {
    const personalOnly = fixture({
      contacts: [{ title: 'Einkauf', seniority: null, contactPoints: [{ type: 'email', status: 'UNVERIFIED' }] }],
    });
    await personalOnly.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });
    expect(personalOnly.upserted().scores.reachability).toBe(0.5);

    const both = fixture({
      contacts: [{ title: 'Einkauf', seniority: null, contactPoints: [{ type: 'email', status: 'UNVERIFIED' }] }],
      points: [{ kind: 'impressum_page', value: 'https://pumpen-handel.example/impressum', status: 'VALID' }],
    });
    await both.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });
    expect(both.upserted().scores.reachability).toBe(1);
  });
});

describe('scoreCandidates — score_detail 记下计分所用的规则版本（W5-f）', () => {
  it('score_detail.ruleVersion = 本次计分的规则版本（create 与 update 两路一致），LeadQualified 快照读它', async () => {
    const f = fixture({
      points: [{ kind: 'contact_page', value: 'https://pumpen-handel.example/kontakt', status: 'UNVERIFIED' }],
    });

    await f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });

    const call = f.leadUpsert.mock.calls[0]![0] as unknown as {
      update: { scoreDetail: Record<string, unknown> };
      create: { scoreDetail: Record<string, unknown> };
    };
    expect(call.update.scoreDetail.ruleVersion).toBe('additive-6dim-v3');
    expect(call.create.scoreDetail.ruleVersion).toBe('additive-6dim-v3');
  });
});

/**
 * (q) 命中消失后的旧记录：qualify 以前只在有命中时写 sanctions_screening_result，命中全部消失的公司
 * （名单更新移除了实体、匹配规则修正了误报，如 #660）留着旧的 potential_match，accept 与周报导出按它硬拦。
 * 规则：索引生效且这次无命中时，未确认的旧命中改写为 clear；人工确认的真命中保留并继续 hold；
 * 索引没生效（not_screened）时不读也不改。
 */
describe('scoreCandidates — 命中消失后改写旧的制裁筛查记录（q）', () => {
  const STALE_WHERE = {
    workspaceId: WS,
    canonicalCompanyId: COMPANY_ID,
    status: 'potential_match',
    reviewState: { in: ['open', 'cleared_false_positive'] },
  };

  it('索引生效、这次无命中，库里有未复核的旧命中 → 改写为 clear，lead 不进 sanctions_hold', async () => {
    const f = fixture({
      points: CONTACT_PAGE,
      screen: { status: 'clear' },
      staleHits: [{ canonicalCompanyId: COMPANY_ID, reviewState: 'open' }],
    });

    await f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });

    expect(f.screening.findMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, canonicalCompanyId: { in: [COMPANY_ID] }, status: 'potential_match' },
      select: { canonicalCompanyId: true, reviewState: true },
    });
    expect(f.screening.updateMany).toHaveBeenCalledWith({
      where: STALE_WHERE,
      data: {
        screenedName: 'Pumpen Handel GmbH',
        status: 'clear',
        matches: [],
        topScore: null,
        listVersions: LIST_VERSIONS,
        screenedAt: expect.any(Date),
      },
    });
    expect(f.screening.upsert).not.toHaveBeenCalled();
    expect(f.upserted().queue).toBe('recommended');
  });

  it('人工已清的旧命中同样改写为 clear，复核态不动（不写 reviewState）', async () => {
    const f = fixture({
      points: CONTACT_PAGE,
      screen: { status: 'clear' },
      staleHits: [{ canonicalCompanyId: COMPANY_ID, reviewState: 'cleared_false_positive' }],
    });

    await f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });

    expect(f.screening.updateMany).toHaveBeenCalledTimes(1);
    const call = f.screening.updateMany.mock.calls[0]![0] as { where: unknown; data: Record<string, unknown> };
    expect(call.where).toEqual(STALE_WHERE);
    expect(call.data).not.toHaveProperty('reviewState');
  });

  it('人工确认的真命中不改写，lead 仍是 sanctions_hold（与 accept 的硬拦一致）', async () => {
    const f = fixture({
      points: CONTACT_PAGE,
      screen: { status: 'clear' },
      staleHits: [{ canonicalCompanyId: COMPANY_ID, reviewState: 'confirmed_true_hit' }],
    });

    await expect(f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP })).resolves.toMatchObject({
      queues: { sanctions_hold: 1 },
    });

    expect(f.screening.updateMany).not.toHaveBeenCalled();
    expect(f.upserted().queue).toBe('sanctions_hold');
  });

  it('索引没生效（not_screened）→ 不读、不改旧记录：索引空或构建失败时绝不清掉命中', async () => {
    const f = fixture({
      points: CONTACT_PAGE,
      screen: { status: 'not_screened' },
      staleHits: [{ canonicalCompanyId: COMPANY_ID, reviewState: 'open' }],
    });

    await f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });

    expect(f.screening.findMany).not.toHaveBeenCalled();
    expect(f.screening.updateMany).not.toHaveBeenCalled();
  });

  it('这次无命中、库里也没有旧命中 → 不写任何筛查记录', async () => {
    const f = fixture({ points: CONTACT_PAGE, screen: { status: 'clear' }, staleHits: [] });

    await f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });

    expect(f.screening.updateMany).not.toHaveBeenCalled();
    expect(f.screening.upsert).not.toHaveBeenCalled();
  });

  it('这次有命中 → 照旧 upsert potential_match，不读旧命中、不走改写', async () => {
    const match = {
      externalId: 'e-1',
      sourceKey: 'ofac_sdn',
      matchedName: 'PUMPEN HANDEL',
      aliasQuality: 'primary',
      score: 0.9,
      nameScore: 0.9,
      entityCountry: null,
      countryMatch: 'unknown',
      listVersion: '2026-10-19',
    };
    const f = fixture({ points: CONTACT_PAGE, screen: { status: 'potential_match', matches: [match] } });

    await f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });

    expect(f.screening.findMany).not.toHaveBeenCalled();
    expect(f.screening.updateMany).not.toHaveBeenCalled();
    expect(f.screening.upsert).toHaveBeenCalledTimes(1);
    expect(f.upserted().queue).toBe('sanctions_hold');
  });
});
