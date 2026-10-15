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
    sanctionsScreeningResult: { findFirst: vi.fn(), upsert: vi.fn() },
    outboxEvent: { create: vi.fn(async () => ({})) },
  };
  const activities = createQualifyActivities({
    prisma: {
      withWorkspace: async <T>(_workspaceId: string, callback: (client: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    } as never,
  });
  const upserted = () => {
    const call = leadUpsert.mock.calls[0]![0] as unknown as {
      update: { queue: string; totalScore: number; scores: Record<string, number>; scoreDetail: Record<string, unknown> };
      create: { queue: string };
    };
    return call.update;
  };
  return { activities, findMany, leadUpsert, suppressionFindMany, upserted };
}

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
