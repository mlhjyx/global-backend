import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FitJudgment } from '../discovery/fit-judge';

/**
 * 回归测试（收口① CandidateAssessment）：ICP 资格门判定 = 「某公司 × 某 ICP」，必须挂 **Lead**（per ICP×公司），
 * 不能挂 CanonicalCompany（公司级）。旧实现把 fitVerdict 写在 canonical 上 → 同 workspace 两个 ACTIVE ICP，
 * 后判的会读到/覆盖前判的判定（qualifyFit* 只判 `fitVerdict:null`、scoreCandidates 读 `canonical.fitVerdict`）。
 *
 * 本文件用**内存假 Prisma** 直接驱动两条真实活动（qualifyFitForRun / qualifyFitBacklog），只把 LLM 判定
 * （judgeFitCompany）与 ICP 摘要加载（loadIcpBrief）替换掉——upsertLeadFit 用真实实现，验证落库形态。
 * 对旧代码此测 FAIL：旧路径不建 Lead（写 canonical.update），断言「两条独立 Lead」自然不成立。
 */

// 只替换 LLM 判定与 ICP 摘要加载；upsertLeadFit / 类型等保留真实实现。
vi.mock('../discovery/fit-judge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery/fit-judge')>();
  return {
    ...actual,
    loadIcpBrief: vi.fn(async () => ({ seller: 'S', seller_summary: null })),
    judgeFitCompany: vi.fn(),
  };
});

import { judgeFitCompany } from '../discovery/fit-judge';
import { createDiscoveryActivities } from './discovery.activities';
import { createBacklogActivities } from './backlog.activities';

const judgeFitMock = vi.mocked(judgeFitCompany);

const WS = 'ws-1';
const ICP_A = 'icp-a';
const ICP_B = 'icp-b';
const RUN = 'run-1';

const judgment = (verdict: FitJudgment['verdict']): FitJudgment => ({
  verdict,
  fitReasons: { material: 'm', role: 'r', process: 'p', business_model: 'b', reasons: [] },
});

// ── 内存假 Prisma：实现活动实际用到的查询面（canonical/lead/rawSourceRecord/identityLink）。 ──
interface FakeCompany {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  industry: string | null;
  attributes: unknown;
  status: string;
}
interface FakeLead {
  workspaceId: string;
  icpId: string;
  canonicalCompanyId: string;
  status: string;
  queue: string;
  fitVerdict: string | null;
  fitReasons: unknown;
  version: number;
}
interface FakeRaw {
  id: string;
  runId: string;
}
interface FakeLink {
  canonicalType: string;
  rawRecordId: string;
  canonicalId: string;
}

interface Store {
  companies: FakeCompany[];
  leads: FakeLead[];
  raws: FakeRaw[];
  links: FakeLink[];
}

type VerdictCond = null | string | { not: string | null };

function matchVerdict(actual: string | null, cond: VerdictCond | undefined): boolean {
  if (cond === undefined) return true;
  if (cond !== null && typeof cond === 'object' && 'not' in cond) {
    return cond.not === null ? actual !== null : actual !== cond.not;
  }
  return actual === cond;
}

function leadSomeMatches(store: Store, companyId: string, cond: { icpId?: string; fitVerdict?: VerdictCond }): boolean {
  return store.leads.some(
    (l) =>
      l.canonicalCompanyId === companyId &&
      (cond.icpId === undefined || l.icpId === cond.icpId) &&
      matchVerdict(l.fitVerdict, cond.fitVerdict),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function companyMatches(store: Store, c: FakeCompany, where: any): boolean {
  if (where.id?.in && !where.id.in.includes(c.id)) return false;
  if (where.id?.gt && !(c.id > where.id.gt)) return false;
  if (where.status?.not && c.status === where.status.not) return false;
  if (where.domain?.not === null && c.domain === null) return false;
  if (where.NOT?.leads?.some && leadSomeMatches(store, c.id, where.NOT.leads.some)) return false;
  if (where.leads?.some && !leadSomeMatches(store, c.id, where.leads.some)) return false;
  return true;
}

function makeTx(store: Store) {
  return {
    icpDefinition: { findUnique: async () => ({ id: ICP_A, company: null }) },
    rawSourceRecord: {
      findMany: async ({ where }: { where: { runId: string } }) =>
        store.raws.filter((r) => r.runId === where.runId).map((r) => ({ id: r.id })),
    },
    identityLink: {
      findMany: async ({ where }: { where: { rawRecordId: { in: string[] } } }) =>
        store.links
          .filter((l) => where.rawRecordId.in.includes(l.rawRecordId))
          .map((l) => ({ canonicalId: l.canonicalId })),
    },
    canonicalCompany: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where = {}, take }: any) => {
        let rows = store.companies.filter((c) => companyMatches(store, c, where));
        rows = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (take != null) rows = rows.slice(0, take);
        return rows.map((c) => ({ ...c }));
      },
      // 旧代码路径（fit 写 canonical）——保留以证明旧实现 FAIL（此断言下不建 Lead）。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: async ({ where, data }: any) => {
        const idx = store.companies.findIndex((c) => c.id === where.id);
        if (idx >= 0) store.companies[idx] = { ...store.companies[idx], ...data };
        return store.companies[idx];
      },
    },
    lead: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: async ({ where }: any) => {
        const k = where.workspaceId_icpId_canonicalCompanyId;
        return (
          store.leads.find(
            (l) => l.workspaceId === k.workspaceId && l.icpId === k.icpId && l.canonicalCompanyId === k.canonicalCompanyId,
          ) ?? null
        );
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      upsert: async ({ where, update, create }: any) => {
        const k = where.workspaceId_icpId_canonicalCompanyId;
        const idx = store.leads.findIndex(
          (l) => l.workspaceId === k.workspaceId && l.icpId === k.icpId && l.canonicalCompanyId === k.canonicalCompanyId,
        );
        if (idx >= 0) {
          const cur = store.leads[idx];
          store.leads = store.leads.map((l, i) =>
            i === idx
              ? {
                  ...cur,
                  ...(update.fitVerdict !== undefined ? { fitVerdict: update.fitVerdict } : {}),
                  ...(update.fitReasons !== undefined ? { fitReasons: update.fitReasons } : {}),
                  version: cur.version + 1,
                }
              : l,
          );
          return store.leads[idx];
        }
        const row: FakeLead = {
          workspaceId: create.workspaceId,
          icpId: create.icpId,
          canonicalCompanyId: create.canonicalCompanyId,
          status: create.status ?? 'DISCOVERED',
          queue: create.queue ?? 'needs_review',
          fitVerdict: create.fitVerdict ?? null,
          fitReasons: create.fitReasons ?? null,
          version: 1,
        };
        store.leads = [...store.leads, row];
        return row;
      },
    },
  };
}

function makeFakePrisma(store: Store) {
  return {
    withWorkspace: async <T>(_ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(makeTx(store)),
    sourcePolicy: { findMany: async () => [] as { domain: string }[] },
  };
}

function seedOneCompany(): Store {
  return {
    companies: [{ id: 'c1', name: 'Acme', domain: 'acme.com', country: 'DE', industry: 'manufacturing', attributes: {}, status: 'NEW' }],
    leads: [],
    raws: [{ id: 'raw1', runId: RUN }],
    links: [{ canonicalType: 'company', rawRecordId: 'raw1', canonicalId: 'c1' }],
  };
}

const leadFor = (store: Store, icpId: string) =>
  store.leads.find((l) => l.icpId === icpId && l.canonicalCompanyId === 'c1');

beforeEach(() => judgeFitMock.mockReset());

describe('qualifyFitForRun — fit 判定挂 Lead（per ICP×公司），两个 ICP 互不覆盖', () => {
  it('同一公司：ICP-A 判 match、ICP-B 判 mismatch → 两条独立 Lead，各自 fitVerdict 不被对方覆盖', async () => {
    const store = seedOneCompany();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acts = createDiscoveryActivities({ prisma: makeFakePrisma(store) as any, providers: {} as any, gateway: {} as any });

    // ICP-A：match
    judgeFitMock.mockResolvedValue(judgment('match'));
    const rA = await acts.qualifyFitForRun({ workspaceId: WS, runId: RUN, icpId: ICP_A });
    expect(rA.judged).toBe(1);
    expect(store.leads).toHaveLength(1); // ← 旧实现此处 = 0（写的是 canonical，不建 Lead）→ FAIL
    expect(leadFor(store, ICP_A)?.fitVerdict).toBe('match');
    expect(leadFor(store, ICP_A)?.status).toBe('DISCOVERED'); // CandidateAssessment：发现即建行

    // ICP-B：mismatch —— 关键：ICP-A 已判 match 的公司在 ICP-B 仍会被判（修「后判 ICP 判不了」）
    judgeFitMock.mockResolvedValue(judgment('mismatch'));
    const rB = await acts.qualifyFitForRun({ workspaceId: WS, runId: RUN, icpId: ICP_B });
    expect(rB.judged).toBe(1);
    expect(store.leads).toHaveLength(2);
    expect(leadFor(store, ICP_A)?.fitVerdict).toBe('match'); // ← 未被 ICP-B 覆盖（旧实现会被覆盖成 mismatch）
    expect(leadFor(store, ICP_B)?.fitVerdict).toBe('mismatch');
    // 初始队列按 verdict 映射（对抗复审修复）：mismatch 不挂 needs_review 误导人工待审窗口
    expect(leadFor(store, ICP_A)?.queue).toBe('needs_review');
    expect(leadFor(store, ICP_B)?.queue).toBe('rejected');
  });

  it('幂等：同一 ICP 重跑不重复判（已有该 ICP 的已判 Lead 的公司离开待判集）', async () => {
    const store = seedOneCompany();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acts = createDiscoveryActivities({ prisma: makeFakePrisma(store) as any, providers: {} as any, gateway: {} as any });
    judgeFitMock.mockResolvedValue(judgment('match'));
    await acts.qualifyFitForRun({ workspaceId: WS, runId: RUN, icpId: ICP_A });
    const second = await acts.qualifyFitForRun({ workspaceId: WS, runId: RUN, icpId: ICP_A });
    expect(second.judged).toBe(0); // 已判 → 不再判
    expect(store.leads).toHaveLength(1);
    expect(judgeFitMock).toHaveBeenCalledTimes(1);
  });
});

describe('qualifyFitBacklog — 存量对账 per-ICP：两个 ACTIVE ICP 独立判同一存量公司', () => {
  it('ICP-A match、ICP-B mismatch → 两条独立 Lead（存量投影公司的多 ICP 场景）', async () => {
    // 存量场景：公司经租户投影进来、不属于任何 run（无 raw/link）——backlog 直接扫 canonical。
    const store: Store = {
      companies: [{ id: 'c1', name: 'Acme', domain: 'acme.com', country: 'DE', industry: 'manufacturing', attributes: {}, status: 'NEW' }],
      leads: [],
      raws: [],
      links: [],
    };
    const acts = createBacklogActivities({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: makeFakePrisma(store) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      providers: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gateway: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ownerDb: {} as any,
    });

    judgeFitMock.mockResolvedValue(judgment('match'));
    const rA = await acts.qualifyFitBacklog({ workspaceId: WS, icpId: ICP_A });
    expect(rA.judged).toBe(1);
    expect(leadFor(store, ICP_A)?.fitVerdict).toBe('match');

    judgeFitMock.mockResolvedValue(judgment('mismatch'));
    const rB = await acts.qualifyFitBacklog({ workspaceId: WS, icpId: ICP_B });
    expect(rB.judged).toBe(1); // 关键：ICP-A 已判过，ICP-B 仍能判（旧实现 canonical.fitVerdict≠null → judged=0）
    expect(store.leads).toHaveLength(2);
    expect(leadFor(store, ICP_A)?.fitVerdict).toBe('match'); // 不被覆盖
    expect(leadFor(store, ICP_B)?.fitVerdict).toBe('mismatch');
  });
});
