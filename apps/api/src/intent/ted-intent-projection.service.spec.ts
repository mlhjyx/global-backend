import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { companyIdentity } from '../discovery/identity';
import { TedIntentProjectionService, cpvOverlap, TENDER_PUBLISHED } from './ted-intent-projection.service';
import type { IntentAttr } from './intent-projection.service';

const WS = 'ws-1';
const DAY_MS = 86_400_000;

interface SignalRow {
  id: string;
  providerKey: string;
  signalType: string;
  externalId: string;
  subjectName: string;
  subjectCountry: string;
  subjectKey: string;
  taxonomyKeys: string[];
  strength: number;
  occurredAt: Date;
  observedAt: Date;
  payload: Record<string, unknown>;
  license: string;
  jurisdiction: string;
  status: string;
  expiresAt: Date;
}

function tedSignal(over: Partial<SignalRow> & { name: string; occurredAt: Date }): SignalRow {
  const country = over.subjectCountry ?? 'DE';
  return {
    id: over.id ?? `sig-${over.name}-${over.occurredAt.getTime()}`,
    providerKey: 'ted',
    signalType: TENDER_PUBLISHED,
    externalId: over.externalId ?? `N-${over.occurredAt.getTime()}`,
    subjectName: over.name,
    subjectCountry: country,
    subjectKey: companyIdentity({ name: over.name, country }).dedupeKey,
    taxonomyKeys: over.taxonomyKeys ?? ['cpv:42122130'],
    strength: 0.9,
    occurredAt: over.occurredAt,
    observedAt: over.observedAt ?? over.occurredAt,
    payload: over.payload ?? { cpv: ['42122130'], notice: over.externalId ?? 'N-1', source: 'ted' },
    license: 'CC BY 4.0',
    jurisdiction: 'EU',
    status: over.status ?? 'ACTIVE',
    expiresAt: over.expiresAt ?? new Date(over.occurredAt.getTime() + 90 * DAY_MS),
  };
}

interface FakeTenant {
  companies: Map<string, { id: string; workspaceId: string; dedupeKey: string; name: string; country: string; status: string; attributes: Record<string, unknown>; version: number }>;
  evidence: { field: string; providerKey: string; value: unknown }[];
}

/** 平台 source_signal + 租户 canonical/fieldEvidence 的内存假体。 */
function fakePrisma(signals: SignalRow[]): PrismaService & FakeTenant {
  const companies: FakeTenant['companies'] = new Map();
  const evidence: FakeTenant['evidence'] = [];
  const tx = {
    canonicalCompany: {
      findUnique: async ({ where }: { where: { workspaceId_dedupeKey: { workspaceId: string; dedupeKey: string } } }) =>
        companies.get(where.workspaceId_dedupeKey.dedupeKey) ?? null,
      upsert: async ({ where, create, update }: {
        where: { workspaceId_dedupeKey: { dedupeKey: string } };
        create: Record<string, unknown>; update: Record<string, unknown>;
      }) => {
        const key = where.workspaceId_dedupeKey.dedupeKey;
        const prior = companies.get(key);
        if (prior) {
          const next = {
            ...prior,
            attributes: update.attributes as Record<string, unknown>,
            version: prior.version + 1,
          };
          companies.set(key, next);
          return { id: next.id };
        }
        const created = {
          id: `co-${companies.size}`,
          workspaceId: WS,
          dedupeKey: key,
          name: create.name as string,
          country: create.country as string,
          status: create.status as string,
          attributes: create.attributes as Record<string, unknown>,
          version: 1,
        };
        companies.set(key, created);
        return { id: created.id };
      },
    },
    fieldEvidence: {
      create: async ({ data }: { data: { field: string; providerKey: string; value: unknown } }) => {
        evidence.push({ field: data.field, providerKey: data.providerKey, value: data.value });
        return { id: `fe-${evidence.length}` };
      },
    },
  };
  return {
    companies,
    evidence,
    sourceSignal: {
      // 支持 (occurredAt desc, id desc) 稳定排序 + Prisma cursor 分页（cursor/skip）——投影端分页扫描 CPV 匹配。
      findMany: async ({ where, take, cursor, skip }: {
        where: { providerKey: string; signalType: string; status: string; occurredAt: { gte: Date }; subjectCountry: { in: string[] } };
        take: number;
        cursor?: { id: string };
        skip?: number;
      }) => {
        const rows = signals
          .filter(
            (s) =>
              s.providerKey === where.providerKey &&
              s.signalType === where.signalType &&
              s.status === where.status &&
              s.occurredAt.getTime() >= where.occurredAt.gte.getTime() &&
              where.subjectCountry.in.includes(s.subjectCountry),
          )
          .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        let start = 0;
        if (cursor) {
          const idx = rows.findIndex((s) => s.id === cursor.id);
          start = idx < 0 ? rows.length : idx + (skip ?? 0);
        }
        return rows.slice(start, start + take);
      },
    },
    withWorkspace: async (_ws: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService & FakeTenant;
}

const now = Date.now();
const params = { cpvCodes: ['42120000'], buyerCountries: ['DEU'] }; // ISO-3 输入（resolveIcpToCpv 格式）

describe('cpvOverlap —— CPV 子树匹配（去尾零前缀，双向）', () => {
  it('精确/子树/反向粗码命中；异子树/非 cpv 键不命中', () => {
    expect(cpvOverlap('42122130', 'cpv:42122130')).toBe(true); // 精确
    expect(cpvOverlap('42120000', 'cpv:42122130')).toBe(true); // ICP 粗 → 信号细
    expect(cpvOverlap('42122130', 'cpv:42120000')).toBe(true); // 信号粗 → ICP 细（拉取端既按码检索到，不反丢）
    expect(cpvOverlap('33100000', 'cpv:42122130')).toBe(false); // 异子树
    expect(cpvOverlap('42120000', 'fda:LLZ')).toBe(false); // 非 cpv 键
  });
});

describe('TedIntentProjectionService.projectTenders —— 从 source_signal 只读投影（收口⑤反转）', () => {
  it('ACTIVE 信号按 CPV 子树×国别（ISO-3→alpha-2）匹配 → 新建买方线索 + TENDER_PUBLISHED + CC BY 双证据', async () => {
    const at = new Date(now - 3 * DAY_MS);
    const prisma = fakePrisma([
      tedSignal({ name: 'Stadt Musterstadt', occurredAt: at, externalId: 'N-100' }),
      tedSignal({ name: 'Ville de Lyon', occurredAt: at, subjectCountry: 'FR' }), // 国别外 → 不投
      tedSignal({ name: 'Klinikum Beispiel', occurredAt: at, taxonomyKeys: ['cpv:33100000'] }), // 子树外 → 不投
    ]);
    const svc = new TedIntentProjectionService({ prisma });
    const r = await svc.projectTenders(WS, params);

    expect(r.signalsMatched).toBe(1);
    expect(r.companiesTouched).toBe(1);
    expect(prisma.companies.size).toBe(1);
    const co = [...prisma.companies.values()][0];
    expect(co.status).toBe('NEW');
    expect((co.attributes.intent as IntentAttr).events[0]).toMatchObject({
      type: TENDER_PUBLISHED,
      at: at.toISOString(),
      strength: 0.9,
    });
    // CC BY 4.0 署名义务：intent.tender 证据 + 新建时 identity 署名行
    expect(prisma.evidence.map((e) => e.field).sort()).toEqual(['identity', 'intent.tender']);
  });

  it('同买方多招标 → 归并取最新发布日（单事件，不灌满 events[≤20]）', async () => {
    const older = new Date(now - 10 * DAY_MS);
    const newer = new Date(now - 2 * DAY_MS);
    const prisma = fakePrisma([
      tedSignal({ name: 'Stadt Musterstadt', occurredAt: older, externalId: 'N-old' }),
      tedSignal({ name: 'Stadt Musterstadt', occurredAt: newer, externalId: 'N-new' }),
    ]);
    const svc = new TedIntentProjectionService({ prisma });
    const r = await svc.projectTenders(WS, params);
    expect(r.signalsMatched).toBe(2);
    expect(r.companiesTouched).toBe(1);
    const intent = [...prisma.companies.values()][0].attributes.intent as IntentAttr;
    expect(intent.events).toHaveLength(1);
    expect(intent.events[0].at).toBe(newer.toISOString());
  });

  it('状态机：EXPIRED / REVOKED 信号绝不投影（可过期验收的单元级证明）', async () => {
    const at = new Date(now - 3 * DAY_MS);
    const prisma = fakePrisma([
      tedSignal({ name: 'Expired GmbH', occurredAt: at, status: 'EXPIRED' }),
      tedSignal({ name: 'Revoked AG', occurredAt: at, status: 'REVOKED' }),
    ]);
    const svc = new TedIntentProjectionService({ prisma });
    const r = await svc.projectTenders(WS, params);
    expect(r.signalsMatched).toBe(0);
    expect(prisma.companies.size).toBe(0);
  });

  it('幂等：同信号第二轮投影 → 不 bump version、不堆 evidence 行', async () => {
    const at = new Date(now - 3 * DAY_MS);
    const prisma = fakePrisma([tedSignal({ name: 'Stadt Musterstadt', occurredAt: at, externalId: 'N-100' })]);
    const svc = new TedIntentProjectionService({ prisma });
    await svc.projectTenders(WS, params);
    const versionAfterFirst = [...prisma.companies.values()][0].version;
    const evidenceAfterFirst = prisma.evidence.length;

    const r2 = await svc.projectTenders(WS, params);
    expect(r2.companiesTouched).toBe(0); // 实质未变 → 指标不虚报
    expect([...prisma.companies.values()][0].version).toBe(versionAfterFirst);
    expect(prisma.evidence.length).toBe(evidenceAfterFirst);
  });

  it('SUPPRESSED 公司跳过（抑制名单绝不复活）', async () => {
    const at = new Date(now - 3 * DAY_MS);
    const sig = tedSignal({ name: 'Stadt Musterstadt', occurredAt: at });
    const prisma = fakePrisma([sig]);
    prisma.companies.set(sig.subjectKey, {
      id: 'co-x', workspaceId: WS, dedupeKey: sig.subjectKey, name: 'Stadt Musterstadt', country: 'DE',
      status: 'SUPPRESSED', attributes: {}, version: 1,
    });
    const svc = new TedIntentProjectionService({ prisma });
    const r = await svc.projectTenders(WS, params);
    expect(r.companiesTouched).toBe(0);
    expect(prisma.evidence.length).toBe(0);
  });

  it('分页扫描：>SCAN_LIMIT 条更新的非匹配 ACTIVE 信号不截断更旧的 CPV 匹配信号（#56 P2）', async () => {
    // 首页 2000 条更"新"的异子树信号（cpv:33*，不匹配 ICP 42*）+ 1 条更旧的匹配信号（cpv:42122130）。
    // 旧单次 take:2000 只拿到首页 → 匹配信号被截断在窗外（signalsMatched=0）；分页后第二页扫到它。
    const noise = Array.from({ length: 2000 }, (_, i) =>
      tedSignal({ name: `Noise ${i}`, occurredAt: new Date(now - DAY_MS - i), taxonomyKeys: ['cpv:33100000'], id: `noise-${String(i).padStart(5, '0')}` }),
    );
    const oldMatch = tedSignal({ name: 'Stadt Alt', occurredAt: new Date(now - 20 * DAY_MS), externalId: 'N-old', id: 'zmatch-old' });
    const prisma = fakePrisma([...noise, oldMatch]);
    const svc = new TedIntentProjectionService({ prisma });
    const r = await svc.projectTenders(WS, params);
    expect(r.signalsMatched).toBe(1);
    expect(prisma.companies.size).toBe(1);
    expect([...prisma.companies.values()][0].name).toBe('Stadt Alt');
  });

  it('空码/空国别 → 零投影（本 ICP 无匹配面）', async () => {
    const prisma = fakePrisma([tedSignal({ name: 'X', occurredAt: new Date(now) })]);
    const svc = new TedIntentProjectionService({ prisma });
    expect((await svc.projectTenders(WS, { cpvCodes: [], buyerCountries: ['DEU'] })).signalsMatched).toBe(0);
    expect((await svc.projectTenders(WS, { cpvCodes: ['42120000'], buyerCountries: [] })).signalsMatched).toBe(0);
  });
});
