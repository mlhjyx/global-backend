import { describe, expect, it } from 'vitest';
import { BudgetExceededError } from '../tools/budget';
import { PLATFORM_WORKSPACE } from '../discovery/provider-contract';
import type { PrismaService } from '../prisma/prisma.service';
import type { ExecutionBroker, ToolContext } from '../tools/tool-contract';
import { SignalIngestService } from './signal-ingest.service';

const NOW = Date.UTC(2026, 6, 11, 7, 0); // 2026-07-11T07:00Z → 6h 桶 06:00Z
const WINDOW_MS = 6 * 3600_000;

const TED_NOTICE = {
  publicationNumber: '00123456-2026',
  publicationDateIso: '2026-07-01T00:00:00.000Z',
  cpvCodes: ['42122000'],
  buyerNames: ['Stadt Musterstadt'],
  buyerCountries: ['DEU'],
  deadlines: [],
};

const FDA_CLEARANCE_REC = {
  kNumber: 'K261234',
  applicant: 'Aidoc Medical Ltd',
  country: 'IL',
  productCode: 'LLZ',
  decisionDateIso: '2026-05-05T00:00:00.000Z',
  deviceName: 'BriefCase Triage',
};

interface FakeDb {
  ledger: Map<string, Record<string, unknown>>;
  signals: Map<string, Record<string, unknown>>;
}

/** 平台两表的内存假体（唯一键语义与 schema 一致）。 */
function fakePrisma(): PrismaService & FakeDb {
  const ledger = new Map<string, Record<string, unknown>>();
  const signals = new Map<string, Record<string, unknown>>();
  const lKey = (w: Record<string, string>) => `${w.providerKey}|${w.queryFingerprint}|${w.windowKey}`;
  const sKey = (w: Record<string, string>) => `${w.providerKey}|${w.externalId}|${w.signalType}|${w.subjectKey}`;
  return {
    ledger,
    signals,
    signalIngest: {
      findUnique: async ({ where }: { where: { providerKey_queryFingerprint_windowKey: Record<string, string> } }) =>
        ledger.get(lKey(where.providerKey_queryFingerprint_windowKey)) ?? null,
      upsert: async ({ where, create, update }: {
        where: { providerKey_queryFingerprint_windowKey: Record<string, string> };
        create: Record<string, unknown>; update: Record<string, unknown>;
      }) => {
        const k = lKey(where.providerKey_queryFingerprint_windowKey);
        const prior = ledger.get(k);
        const row = prior ? { ...prior, ...update } : { id: `li-${ledger.size}`, ...create };
        ledger.set(k, row);
        return row;
      },
      updateMany: async ({ where, data }: {
        where: { providerKey: string; queryFingerprint: string; windowKey: string; status?: { not: string } };
        data: Record<string, unknown>;
      }) => {
        const k = `${where.providerKey}|${where.queryFingerprint}|${where.windowKey}`;
        const row = ledger.get(k);
        if (!row || (where.status?.not && row.status === where.status.not)) return { count: 0 };
        ledger.set(k, { ...row, ...data });
        return { count: 1 };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const k = `${data.providerKey}|${data.queryFingerprint}|${data.windowKey}`;
        if (ledger.has(k)) throw Object.assign(new Error('unique violation'), { code: 'P2002' });
        const row = { id: `li-${ledger.size}`, ...data };
        ledger.set(k, row);
        return row;
      },
    },
    sourceSignal: {
      upsert: async ({ where, create, update }: {
        where: { providerKey_externalId_signalType_subjectKey: Record<string, string> };
        create: Record<string, unknown>; update: Record<string, unknown>;
      }) => {
        const k = sKey(where.providerKey_externalId_signalType_subjectKey);
        const prior = signals.get(k);
        const row = prior ? { ...prior, ...update } : { id: `sig-${signals.size}`, status: 'ACTIVE', ...create };
        signals.set(k, row);
        return row;
      },
      updateMany: async ({ where, data }: {
        where: { status?: string | { not: string }; expiresAt?: { lt: Date }; subjectKey?: string; providerKey?: string };
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const [k, row] of signals) {
          const statusOk =
            where.status === undefined ||
            (typeof where.status === 'string' ? row.status === where.status : row.status !== where.status.not);
          const expiresOk = !where.expiresAt || (row.expiresAt as Date).getTime() < where.expiresAt.lt.getTime();
          const subjectOk = !where.subjectKey || row.subjectKey === where.subjectKey;
          const providerOk = !where.providerKey || row.providerKey === where.providerKey;
          if (statusOk && expiresOk && subjectOk && providerOk) {
            signals.set(k, { ...row, ...data });
            count += 1;
          }
        }
        return { count };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        for (const [k, row] of signals) {
          if (row.id === where.id) {
            const next = { ...row, ...data };
            signals.set(k, next);
            return next;
          }
        }
        throw new Error('not found');
      },
    },
  } as unknown as PrismaService & FakeDb;
}

function fakeBroker(handler?: (toolId: string) => unknown): ExecutionBroker & { calls: { toolId: string; ctx: ToolContext }[] } {
  const calls: { toolId: string; ctx: ToolContext }[] = [];
  return {
    calls,
    checkSourcePolicy: async () => ({ allowed: true }),
    invoke: async <I, O>(toolId: string, _input: I, ctx: ToolContext) => {
      calls.push({ toolId, ctx });
      if (handler) {
        const out = handler(toolId);
        if (out instanceof Error) throw out;
        return { ok: true, data: out as O, meta: {} } as never;
      }
      const data = toolId === 'ted.search' ? { notices: [TED_NOTICE] } : { clearances: [FDA_CLEARANCE_REC] };
      return { ok: true, data: data as O, meta: {} } as never;
    },
  } as never;
}

const tedParams = { cpvCodes: ['42122000'], buyerCountries: ['DEU'] };

describe('SignalIngestService.ingestTed —— ingest-once（收口⑤核心验收）', () => {
  it('同 provider+指纹+窗口第二次摄取 → 账本命中不出网（跨 workspace 只拉取一次的机制）', async () => {
    const prisma = fakePrisma();
    const broker = fakeBroker();
    const svc = new SignalIngestService({ prisma, broker });

    const r1 = await svc.ingestTed(tedParams, { nowMs: NOW });
    expect(r1.ledgerHit).toBe(false);
    expect(r1.recordsFetched).toBe(1);
    expect(r1.signalsUpserted).toBe(1);
    expect(broker.calls.length).toBe(1);
    // 平台级执行身份：PLATFORM_WORKSPACE 哨兵 + intent 用途门
    expect(broker.calls[0].ctx.workspaceId).toBe(PLATFORM_WORKSPACE);
    expect(broker.calls[0].ctx.purpose).toEqual(['intent', 'discovery']);

    const r2 = await svc.ingestTed({ cpvCodes: ['42122000'], buyerCountries: ['deu'] }, { nowMs: NOW + 60_000 });
    expect(r2.ledgerHit).toBe(true); // 参数序/大小写无关 → 同指纹同窗 → 不再出网
    expect(r2.recordsFetched).toBe(0); // 命中计数如实归 0（本轮零拉取零落库——防 sweep 跨窗双计，复审 LOW）
    expect(r2.signalsUpserted).toBe(0);
    expect(broker.calls.length).toBe(1);
    expect(prisma.ledger.size).toBe(1);
  });

  it('跨窗口 → 重新拉取；同窗不同参数 → 各自拉取', async () => {
    const prisma = fakePrisma();
    const broker = fakeBroker();
    const svc = new SignalIngestService({ prisma, broker });

    await svc.ingestTed(tedParams, { nowMs: NOW });
    await svc.ingestTed(tedParams, { nowMs: NOW + WINDOW_MS }); // 下一窗
    expect(broker.calls.length).toBe(2);
    await svc.ingestTed({ cpvCodes: ['99999999'], buyerCountries: ['DEU'] }, { nowMs: NOW }); // 同窗异参
    expect(broker.calls.length).toBe(3);
  });

  it('拉取失败 → 账本 ERROR 行可重试（下次同窗重新拉取并翻 OK）', async () => {
    const prisma = fakePrisma();
    let fail = true;
    const broker = fakeBroker(() => (fail ? new Error('ted 500') : { notices: [TED_NOTICE] }));
    const svc = new SignalIngestService({ prisma, broker });

    const r1 = await svc.ingestTed(tedParams, { nowMs: NOW });
    expect(r1.error).toContain('ted 500');
    expect([...prisma.ledger.values()][0].status).toBe('ERROR');

    fail = false;
    const r2 = await svc.ingestTed(tedParams, { nowMs: NOW });
    expect(r2.ledgerHit).toBe(false); // ERROR 行不算命中
    expect(r2.signalsUpserted).toBe(1);
    expect([...prisma.ledger.values()][0].status).toBe('OK');
  });

  it('无 broker → fail-closed 不出网、不记账（broker 恢复后可重拉）', async () => {
    const prisma = fakePrisma();
    const svc = new SignalIngestService({ prisma });
    const r = await svc.ingestTed(tedParams, { nowMs: NOW });
    expect(r.error).toBe('broker_unavailable');
    expect(prisma.ledger.size).toBe(0);
    expect(prisma.signals.size).toBe(0);
  });

  it('空码/空国别 → 不启动（绝不裸拉全库），不记账不出网', async () => {
    const prisma = fakePrisma();
    const broker = fakeBroker();
    const svc = new SignalIngestService({ prisma, broker });
    expect((await svc.ingestTed({ cpvCodes: [], buyerCountries: ['DEU'] }, { nowMs: NOW })).error).toBe('empty_query');
    expect((await svc.ingestTed({ cpvCodes: ['42122000'], buyerCountries: [] }, { nowMs: NOW })).error).toBe('empty_query');
    expect(broker.calls.length).toBe(0);
  });

  it('BudgetExceededError 透传（预算真拦截不被吞成 ERROR 账本行）', async () => {
    const prisma = fakePrisma();
    const broker = fakeBroker(() => new BudgetExceededError('sweep:external-intent', 1, 0));
    const svc = new SignalIngestService({ prisma, broker });
    await expect(svc.ingestTed(tedParams, { nowMs: NOW, budgetKey: 'sweep:external-intent' })).rejects.toBeInstanceOf(BudgetExceededError);
    expect([...prisma.ledger.values()].filter((r) => r.status === 'OK').length).toBe(0);
  });

  it('摄取幂等：同 externalId 复现 → 单行、observedAt 前移、status 绝不复活（EXPIRED 保持）', async () => {
    const prisma = fakePrisma();
    const broker = fakeBroker();
    const svc = new SignalIngestService({ prisma, broker });

    await svc.ingestTed(tedParams, { nowMs: NOW });
    const first = [...prisma.signals.values()][0];
    // 手动过期（模拟状态机翻转后同记录再现）
    prisma.signals.set([...prisma.signals.keys()][0], { ...first, status: 'EXPIRED' });

    await svc.ingestTed(tedParams, { nowMs: NOW + WINDOW_MS }); // 下一窗重拉同记录
    expect(prisma.signals.size).toBe(1);
    const after = [...prisma.signals.values()][0];
    expect(after.status).toBe('EXPIRED'); // 不复活
    expect((after.observedAt as Date).getTime()).toBe(NOW + WINDOW_MS);
  });
});

describe('SignalIngestService.ingestFda —— openFDA 同构 + §6 个体户摄取层拒收', () => {
  it('清关落 Signal；个体户自然人计入 skipped 不落库', async () => {
    const prisma = fakePrisma();
    const broker = fakeBroker(() => ({ clearances: [FDA_CLEARANCE_REC, { ...FDA_CLEARANCE_REC, kNumber: 'K269999', applicant: 'Smith, John' }] }));
    const svc = new SignalIngestService({ prisma, broker });
    const r = await svc.ingestFda({ productCodes: ['LLZ'] }, { nowMs: NOW });
    expect(r.recordsFetched).toBe(2);
    expect(r.signalsUpserted).toBe(1);
    expect(r.skipped.individual).toBe(1);
    expect(prisma.signals.size).toBe(1);
  });
});

describe('状态机：expireStale / revoke', () => {
  it('expireStale：ACTIVE 且 expiresAt<now → EXPIRED（REVOKED/EXPIRED 不动）', async () => {
    const prisma = fakePrisma();
    const svc = new SignalIngestService({ prisma });
    const put = (id: string, status: string, expiresAt: Date) =>
      prisma.signals.set(id, { id, status, expiresAt });
    put('a', 'ACTIVE', new Date(NOW - 1)); // 过期
    put('b', 'ACTIVE', new Date(NOW + 1)); // 未过期
    put('c', 'REVOKED', new Date(NOW - 1)); // 已撤回不动
    const n = await svc.expireStale(new Date(NOW));
    expect(n).toBe(1);
    expect(prisma.signals.get('a')!.status).toBe('EXPIRED');
    expect(prisma.signals.get('b')!.status).toBe('ACTIVE');
    expect(prisma.signals.get('c')!.status).toBe('REVOKED');
  });

  it('revoke：置 REVOKED + revokedAt 且**撤即脱敏**（subjectName 占位、payload 清空——Art.17 擦除路径）', async () => {
    const prisma = fakePrisma();
    const svc = new SignalIngestService({ prisma });
    prisma.signals.set('x', { id: 'sig-x', status: 'ACTIVE', expiresAt: new Date(NOW + 1), subjectName: 'Smith, John', payload: { device: 'X' } });
    await svc.revoke('sig-x');
    const row = prisma.signals.get('x')!;
    expect(row.status).toBe('REVOKED');
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.subjectName).toBe('REDACTED');
    expect(row.payload).toEqual({});
  });

  it('revokeBySubjectKey / revokeByProvider：批量撤回（已 REVOKED 的不重复计数）', async () => {
    const prisma = fakePrisma();
    const svc = new SignalIngestService({ prisma });
    const put = (id: string, over: Record<string, unknown>) =>
      prisma.signals.set(id, { id, status: 'ACTIVE', expiresAt: new Date(NOW + 1), subjectName: 'X', payload: {}, providerKey: 'ted', subjectKey: 'k-1', ...over });
    put('a', { subjectKey: 'k-1' });
    put('b', { subjectKey: 'k-1', status: 'REVOKED' });
    put('c', { subjectKey: 'k-2', providerKey: 'openfda' });
    expect(await svc.revokeBySubjectKey('k-1')).toBe(1); // b 已 REVOKED 不计
    expect(prisma.signals.get('a')!.status).toBe('REVOKED');
    expect(await svc.revokeByProvider('openfda')).toBe(1);
    expect(prisma.signals.get('c')!.status).toBe('REVOKED');
  });
});

describe('TOCTOU 护栏（对抗复审 MEDIUM）：失败方 ERROR 绝不覆盖并发成功方的 OK 账本行', () => {
  it('慢僵尸失败晚于并发成功 → 账本保持 OK（计数不被清零，同窗不再重复出网）', async () => {
    const prisma = fakePrisma();
    let call = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    const broker = {
      checkSourcePolicy: async () => ({ allowed: true }),
      invoke: async <I, O>(_t: string, _i: I, _c: ToolContext) => {
        call += 1;
        if (call === 1) {
          await firstGate; // 僵尸 attempt：挂起到并发方完成后才失败
          throw new Error('slow zombie failed');
        }
        return { ok: true, data: { notices: [TED_NOTICE] } as O, meta: {} } as never;
      },
    } as unknown as ExecutionBroker;
    const svc = new SignalIngestService({ prisma, broker });

    const p1 = svc.ingestTed(tedParams, { nowMs: NOW }); // 通过账本检查进入 fetch 后挂起
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await svc.ingestTed(tedParams, { nowMs: NOW }); // 并发方：真拉成功写 OK
    expect(r2.signalsUpserted).toBe(1);
    releaseFirst();
    const r1 = await p1;
    expect(r1.error).toContain('slow zombie');
    const row = [...prisma.ledger.values()][0];
    expect(row.status).toBe('OK'); // ERROR 条件写（status≠OK 才更新）保住成功方账本行
    expect(row.signalsUpserted).toBe(1);
  });
});
