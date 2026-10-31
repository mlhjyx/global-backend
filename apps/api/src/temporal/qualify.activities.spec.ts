import { describe, expect, it, vi } from 'vitest';
import { createQualifyActivities } from './qualify.activities';
import type { ScreenResult } from '../sanctions/sanctions-screening.service';
import {
  MATCH_E1,
  SANCTIONS_GATE_CASES,
  liveScreen,
  storedScreening,
} from '../sanctions/sanctions-gate.test-fixture';

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
  /** 库里的筛查记录；假 findMany 按 where 里的公司与 status 过滤。 */
  storedHits?: Array<{ canonicalCompanyId: string; status: string; reviewState: string }>;
  /** 同一批里的其他公司（与主公司同形，可换 id、名称、国家）。 */
  extraCompanies?: Array<{ id: string; name?: string; country?: string }>;
  /** 按公司名与国家给出筛查结果；给了它就不看 screen。 */
  screenImpl?: (name: string, country: string | null) => ScreenResult;
  /** 命中路径 reconcile 读到的库里记录（findFirst 的返回）。 */
  prior?: { status: string; reviewState: string; matches: unknown } | null;
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
  const findMany = vi.fn(async (_args: FindManyArgs) => [
    company,
    ...(options.extraCompanies ?? []).map((extra) => ({ ...company, ...extra })),
  ]);
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
      findFirst: vi.fn(async () => options.prior ?? null),
      upsert: vi.fn(async () => ({})),
      findMany: vi.fn(async (args: { where: { canonicalCompanyId: { in: string[] }; status: string } }) =>
        (options.storedHits ?? []).filter(
          (row) => args.where.canonicalCompanyId.in.includes(row.canonicalCompanyId) && row.status === args.where.status,
        ),
      ),
      updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
    },
    outboxEvent: { create: vi.fn(async () => ({})) },
  };
  const sanctionsScreening = options.screenImpl
    ? { rebuildIndex: vi.fn(async () => undefined), screen: vi.fn(options.screenImpl) }
    : options.screen
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
  return {
    activities,
    findMany,
    leadUpsert,
    suppressionFindMany,
    upserted,
    screening: tx.sanctionsScreeningResult,
    sanctionsScreening,
  };
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
 * (q) 队列与 accept 的制裁拦截用同一条规则：库里的命中未被人工清白（open / confirmed_true_hit）就拦。
 * 以前 qualify 只看这次的 live 筛查：命中消失后（名单移除了实体、匹配规则修正了误报）队列不再 hold，
 * accept 与周报导出却按库里的命中硬拦，lead 停在 recommended 却永远 accept 不了。
 * 现在这类 lead 进 sanctions_hold，由人在复核端点清白；qualify 不改写、不新建任何筛查记录（fail-closed：
 * 命中只由人关闭，复审 #665 证实自动改写在索引覆盖不全或与复核并发时会误放）。
 */
describe('scoreCandidates — 库里未清白的制裁命中让 lead 进 sanctions_hold（q）', () => {
  const OTHER_ID = '30000000-0000-4000-8000-000000000099';

  it.each([
    ['open', 'clear'],
    ['confirmed_true_hit', 'clear'],
    ['open', 'not_screened'],
    ['confirmed_true_hit', 'not_screened'],
  ] as const)('库里 potential_match/%s、这次 %s → sanctions_hold，不写筛查记录', async (reviewState, status) => {
    const f = fixture({
      points: CONTACT_PAGE,
      screen: { status },
      storedHits: [{ canonicalCompanyId: COMPANY_ID, status: 'potential_match', reviewState }],
    });

    await expect(f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP })).resolves.toMatchObject({
      queues: { sanctions_hold: 1 },
    });

    expect(f.screening.findMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, canonicalCompanyId: { in: [COMPANY_ID] }, status: 'potential_match' },
      select: { canonicalCompanyId: true, status: true, reviewState: true },
    });
    expect(f.upserted().queue).toBe('sanctions_hold');
    expect(f.screening.upsert).not.toHaveBeenCalled();
    expect(f.screening.updateMany).not.toHaveBeenCalled();
  });

  it('库里的命中已被人工清白 → 不 hold', async () => {
    const f = fixture({
      points: CONTACT_PAGE,
      screen: { status: 'clear' },
      storedHits: [{ canonicalCompanyId: COMPANY_ID, status: 'potential_match', reviewState: 'cleared_false_positive' }],
    });

    await f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });

    expect(f.upserted().queue).toBe('recommended');
  });

  it('库里没有命中、这次也无命中 → 不 hold，不写筛查记录', async () => {
    const f = fixture({ points: CONTACT_PAGE, screen: { status: 'clear' }, storedHits: [] });

    await f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });

    expect(f.upserted().queue).toBe('recommended');
    expect(f.screening.upsert).not.toHaveBeenCalled();
    expect(f.screening.updateMany).not.toHaveBeenCalled();
  });

  it('没接筛查服务时同样按库里的命中 hold（与 accept 的持久化兜底一致）', async () => {
    const f = fixture({
      points: CONTACT_PAGE,
      storedHits: [{ canonicalCompanyId: COMPANY_ID, status: 'potential_match', reviewState: 'open' }],
    });

    await f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });

    expect(f.upserted().queue).toBe('sanctions_hold');
  });

  it('一批多家：只 hold 库里有未清白命中的那家', async () => {
    const f = fixture({
      points: CONTACT_PAGE,
      screen: { status: 'clear' },
      extraCompanies: [{ id: OTHER_ID }],
      storedHits: [{ canonicalCompanyId: OTHER_ID, status: 'potential_match', reviewState: 'open' }],
    });

    await expect(f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP })).resolves.toMatchObject({
      scored: 2,
      queues: { recommended: 1, sanctions_hold: 1 },
    });

    const queueOf = (id: string) =>
      (f.leadUpsert.mock.calls as unknown as Array<[{ where: { workspaceId_icpId_canonicalCompanyId: { canonicalCompanyId: string } }; update: { queue: string } }]>)
        .find(([call]) => call.where.workspaceId_icpId_canonicalCompanyId.canonicalCompanyId === id)![0].update.queue;
    expect(queueOf(COMPANY_ID)).toBe('recommended');
    expect(queueOf(OTHER_ID)).toBe('sanctions_hold');
  });

  it('这次有命中 → 照旧 upsert potential_match 并 hold，不读批量的库存命中', async () => {
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
    expect(f.screening.upsert).toHaveBeenCalledTimes(1);
    expect(f.upserted().queue).toBe('sanctions_hold');
  });
});

describe('scoreCandidates — 第五门与 accept、导出同一张真值表（#665）', () => {
  it.each(SANCTIONS_GATE_CASES)('live=$live × 库里=$stored → sanctions_hold=$blocks', async ({ live, stored, blocks }) => {
    const row = storedScreening(stored);
    const f = fixture({
      points: CONTACT_PAGE,
      screenImpl: () => liveScreen(live),
      prior: row,
      storedHits: row ? [{ canonicalCompanyId: COMPANY_ID, status: row.status, reviewState: row.reviewState }] : [],
    });

    await f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP });

    expect(f.upserted().queue === 'sanctions_hold').toBe(blocks);
    // live 无命中的路径绝不写筛查记录；命中路径照旧 upsert。
    if (live === 'clear' || live === 'not_screened') expect(f.screening.upsert).not.toHaveBeenCalled();
    else expect(f.screening.upsert).toHaveBeenCalledTimes(1);
  });

  it('一批多家：每家用自己的名称与国家筛查，结果不串到别家', async () => {
    const OTHER = '30000000-0000-4000-8000-000000000098';
    const f = fixture({
      points: CONTACT_PAGE,
      extraCompanies: [{ id: OTHER, name: 'Ventil Werk GmbH', country: 'AT' }],
      screenImpl: (name) =>
        name === 'Pumpen Handel GmbH'
          ? { status: 'potential_match', matches: [MATCH_E1], listVersions: { ofac_sdn: '2026-10-19' } }
          : { status: 'clear', matches: [], listVersions: { ofac_sdn: '2026-10-19' } },
      storedHits: [],
    });

    await expect(f.activities.scoreCandidates({ workspaceId: WS, icpId: ICP })).resolves.toMatchObject({
      scored: 2,
      queues: { recommended: 1, sanctions_hold: 1 },
    });

    expect(f.sanctionsScreening!.screen).toHaveBeenCalledWith('Pumpen Handel GmbH', 'DE');
    expect(f.sanctionsScreening!.screen).toHaveBeenCalledWith('Ventil Werk GmbH', 'AT');
    const calls = f.leadUpsert.mock.calls as unknown as Array<
      [{ where: { workspaceId_icpId_canonicalCompanyId: { canonicalCompanyId: string } }; update: { queue: string } }]
    >;
    const queueOf = (id: string) =>
      calls.find(([call]) => call.where.workspaceId_icpId_canonicalCompanyId.canonicalCompanyId === id)![0].update.queue;
    expect(queueOf(COMPANY_ID)).toBe('sanctions_hold');
    expect(queueOf(OTHER)).toBe('recommended');
    // 只为这次无命中的那家读库存命中。
    expect(f.screening.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ canonicalCompanyId: { in: [OTHER] } }) }),
    );
  });
});
