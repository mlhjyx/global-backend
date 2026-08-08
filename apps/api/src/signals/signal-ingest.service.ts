import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PLATFORM_WORKSPACE } from '../discovery/provider-contract';
import { BudgetExceededError } from '../tools/budget';
import type { ExecutionBroker } from '../tools/tool-contract';
import type { OpenFdaSearchInput, OpenFdaSearchOutput, SamSearchInput, SamSearchOutput, TedSearchInput, TedSearchOutput } from '../tools/source-tools';
import type { Fda510kClearance } from '../adapters/openfda-api';
import type { TedContractNotice } from '../adapters/ted-api';
import type { SamSourcesSought } from '../adapters/sam-api';
import {
  CanonicalQuerySpec,
  canonicalFdaSpec,
  canonicalSamSpec,
  canonicalTedSpec,
  queryFingerprint,
  windowKeyFor,
} from './signal-query';
import { MapOutcome, mapFdaClearance, mapSamSourcesSought, mapTedNotice } from './signal-mappers';

/**
 * 平台层信号摄取（收口⑤ ingest-once）：外部源 → source_signal 一等事实，**拉取一次服务所有租户**。
 *  - 账本门：(provider, queryFingerprint, windowKey) 已有 OK 行 → 不出网（跨 workspace/ICP 同参共享）；
 *    ERROR 行可重试覆盖。
 *  - §8.8（收口②）：ted.search / openfda.search 是 required 工具，一律经 ExecutionBroker fail-closed；
 *    无 broker = 不出网。平台级执行身份 = PLATFORM_WORKSPACE 哨兵（只入工具 Trace/预算，绝不流入 AiContext）；
 *    预算键经 opts.budgetKey 传 ctx.runId（sweep 开账），BudgetExceededError **透传**（预算拦截不吞）。
 *  - 幂等：source_signal 按唯一键 upsert，复现记录只前移 observedAt——status/occurredAt/payload 不动，
 *    **绝不复活** EXPIRED/REVOKED。
 *  - 状态机：expireStale（ACTIVE 且过期 → EXPIRED，sweep 头部调）；revoke（合规撤回入口）。
 */
export class SignalIngestService {
  constructor(private readonly deps: { prisma: PrismaService; broker?: ExecutionBroker }) {}

  async ingestTed(
    params: { cpvCodes: string[]; buyerCountries: string[]; sinceDays?: number; maxRecords?: number },
    opts?: IngestOpts,
  ): Promise<IngestOutcome> {
    const spec = canonicalTedSpec(params);
    // 绝不裸拉全库：空 CPV 或空国别（TED 查询省略国别子句会拉全 EU）→ 不启动。
    if (!spec.cpvCodes.length || !spec.buyerCountries.length) return emptyOutcome('ted', 'empty_query');
    return this.ingest(spec, opts, async (broker, ctx) => {
      const res = await broker.invoke<TedSearchInput, TedSearchOutput>(
        'ted.search',
        {
          kind: 'contract',
          params: {
            cpvCodes: spec.cpvCodes,
            buyerCountries: spec.buyerCountries,
            sinceDays: spec.sinceDays,
            scope: 'ACTIVE', // 当前开放的招标 = 有效需求窗口
            maxRecords: spec.maxRecords,
          },
        },
        ctx,
      );
      const notices: TedContractNotice[] = res.data.notices ?? [];
      return { records: notices.length, outcomes: notices.map((n) => mapTedNotice(n, ctx.observedAt)) };
    });
  }

  async ingestFda(
    params: { productCodes: string[]; applicantCountries?: string[]; sinceDays?: number; maxRecords?: number },
    opts?: IngestOpts,
  ): Promise<IngestOutcome> {
    const spec = canonicalFdaSpec(params);
    if (!spec.productCodes.length) return emptyOutcome('openfda', 'empty_query'); // 绝不裸拉全库
    return this.ingest(spec, opts, async (broker, ctx) => {
      const res = await broker.invoke<OpenFdaSearchInput, OpenFdaSearchOutput>(
        'openfda.search',
        {
          kind: '510k',
          params: {
            productCodes: spec.productCodes,
            countries: spec.applicantCountries.length ? spec.applicantCountries : undefined,
            sinceDays: spec.sinceDays,
            maxRecords: spec.maxRecords,
            clearedOnly: true, // §8.6：只要正向清关，NSE/被拒/撤回绝不成为信号
          },
        },
        ctx,
      );
      const clearances: Fda510kClearance[] = res.data.clearances ?? [];
      return { records: clearances.length, outcomes: clearances.map((c) => mapFdaClearance(c, ctx.observedAt)) };
    });
  }

  /**
   * SAM.gov Sources Sought 摄取（bulk-CSV，**NAICS 无关**）：整包 CSV 无服务端按码过滤 → 无 empty_query 守，
   * 每窗口恒下载一次（指纹只含窗参数 → 全 ICP 收敛一次拉取），投影层再按 NAICS 过滤。🔴 联系官 PII 已在
   * adapter/mapper 双层剔除，绿库只落机构/公告事实。
   */
  async ingestSam(
    params: { sinceDays?: number; maxRecords?: number },
    opts?: IngestOpts,
  ): Promise<IngestOutcome> {
    const spec = canonicalSamSpec(params);
    return this.ingest(spec, opts, async (broker, ctx) => {
      const res = await broker.invoke<SamSearchInput, SamSearchOutput>(
        'samgov.search',
        { params: { sinceDays: spec.sinceDays, maxRecords: spec.maxRecords } },
        ctx,
      );
      const notices: SamSourcesSought[] = res.data.notices ?? [];
      return { records: notices.length, outcomes: notices.map((n) => mapSamSourcesSought(n, ctx.observedAt)) };
    });
  }

  /** 状态机：ACTIVE 且 expiresAt<now → EXPIRED（EXPIRED/REVOKED 不动）。sweep 头部调。 */
  async expireStale(now: Date = new Date()): Promise<number> {
    const res = await this.deps.prisma.sourceSignal.updateMany({
      where: { status: 'ACTIVE', expiresAt: { lt: now } },
      data: { status: 'EXPIRED' },
    });
    return res.count;
  }

  /**
   * 合规撤回入口（REVOKED 终态：投影/复算剔除，摄取不复活）。**撤即脱敏**（对抗复审：个体户漏网的
   * 残余自然人名需 Art.17 擦除路径）：subjectName 置占位、payload 清空；externalId/subjectKey 保留
   * 供审计对账与防复活（subjectKey 为规范化派生键，完全擦除含键的路径随收口⑥ DataRightsService 落地）。
   */
  async revoke(signalId: string): Promise<void> {
    await this.deps.prisma.sourceSignal.update({
      where: { id: signalId },
      data: revokePatch(),
    });
  }

  /** 批量撤回：按主体（Art.17 单主体擦除请求）。返回翻转行数。 */
  async revokeBySubjectKey(subjectKey: string): Promise<number> {
    const res = await this.deps.prisma.sourceSignal.updateMany({
      where: { subjectKey, status: { not: 'REVOKED' } },
      data: revokePatch(),
    });
    return res.count;
  }

  /** 批量撤回：按 provider（合规事件「采集本身被判违规」时的整源处置——SUSPENDED 只停采不停用，
   *  存量处置靠本入口；两级撤停语义见 docs/architecture §5）。返回翻转行数。 */
  async revokeByProvider(providerKey: string): Promise<number> {
    const res = await this.deps.prisma.sourceSignal.updateMany({
      where: { providerKey, status: { not: 'REVOKED' } },
      data: revokePatch(),
    });
    return res.count;
  }

  /** 公共摄取骨架：账本门 → broker 拉取 → 白名单映射 → 幂等落库 → 账本记账。 */
  private async ingest(
    spec: CanonicalQuerySpec,
    opts: IngestOpts | undefined,
    fetch: (
      broker: ExecutionBroker,
      ctx: { workspaceId: string; runId?: string; correlationId: string; purpose: string[]; observedAt: Date },
    ) => Promise<{ records: number; outcomes: MapOutcome[] }>,
  ): Promise<IngestOutcome> {
    const nowMs = opts?.nowMs ?? Date.now();
    const fingerprint = queryFingerprint(spec);
    const windowKey = windowKeyFor(nowMs);
    const base: IngestOutcome = {
      provider: spec.provider, fingerprint, windowKey, ledgerHit: false, recordsFetched: 0, signalsUpserted: 0, skipped: {},
    };

    // Fast path before requiring a broker. The atomic lease claim below repeats
    // this read because another process may change the row between these steps.
    const prior = await this.deps.prisma.signalIngest.findUnique({
      where: { providerKey_queryFingerprint_windowKey: { providerKey: spec.provider, queryFingerprint: fingerprint, windowKey } },
    });
    if (prior?.status === 'OK') {
      // ingest-once 命中：同源同参同窗已拉过（可能来自另一 workspace 的 ICP）→ 不出网。
      // 计数如实归 0（本轮零拉取零落库；首拉计数保留在账本行供审计）——防 sweep 汇总跨窗双计（复审 LOW）。
      return { ...base, ledgerHit: true };
    }

    if (!this.deps.broker) {
      // fail-closed：无 broker 不允许原始出网；不记账（broker 恢复后同窗可重拉）。
      console.warn(`[signal-ingest] broker unavailable, fail-closed (no raw egress) provider=${spec.provider}`);
      return { ...base, error: 'broker_unavailable' };
    }

    const clock = opts?.nowMs === undefined ? () => Date.now() : () => opts.nowMs!;
    const leaseMs = resolveLeaseMs(opts?.leaseMs);
    const leaseOwner = opts?.leaseOwner ?? randomUUID();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(leaseOwner)) {
      throw new Error('INVALID_SIGNAL_INGEST_LEASE_OWNER');
    }
    const claim = await this.acquireLease({
      spec,
      fingerprint,
      windowKey,
      leaseOwner,
      leaseToken: randomUUID(),
      now: new Date(clock()),
      leaseMs,
    });
    if (claim.kind === 'OK_HIT') return { ...base, ledgerHit: true };
    if (claim.kind === 'BUSY') {
      return { ...base, error: 'lease_busy', leaseBusy: true };
    }

    let fetched: { records: number; outcomes: MapOutcome[] };
    try {
      fetched = await fetch(this.deps.broker, {
        workspaceId: PLATFORM_WORKSPACE,
        runId: opts?.budgetKey,
        correlationId: 'signal-ingest',
        purpose: ['intent', 'discovery'],
        observedAt: new Date(nowMs),
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        await this.finalizeLeaseError(claim, 'BUDGET_EXCEEDED', new Date(clock()));
        throw err; // 预算真拦截透传；lease 立即释放而不是僵死到超时
      }
      const finalized = await this.finalizeLeaseError(
        claim,
        'SIGNAL_FETCH_FAILED',
        new Date(clock()),
      );
      if (!finalized) return { ...base, error: 'lease_lost', leaseLost: true };
      console.warn(
        `[signal-ingest] fetch failed provider=${spec.provider} code=SIGNAL_FETCH_FAILED`,
      );
      return { ...base, error: 'signal_fetch_failed' };
    }

    let persisted: {
      owned: boolean;
      upserted: number;
      skipped: Record<string, number>;
    };
    try {
      persisted = await this.persistSignalsAndFinalize({
        claim,
        outcomes: fetched.outcomes,
        recordsFetched: fetched.records,
        now: new Date(clock()),
        leaseMs,
      });
    } catch (error) {
      await this.finalizeLeaseError(claim, 'SIGNAL_PERSIST_FAILED', new Date(clock()));
      throw error;
    }
    if (!persisted.owned) return { ...base, error: 'lease_lost', leaseLost: true };
    const { upserted, skipped } = persisted;
    return { ...base, recordsFetched: fetched.records, signalsUpserted: upserted, skipped };
  }

  private async acquireLease(input: {
    spec: CanonicalQuerySpec;
    fingerprint: string;
    windowKey: string;
    leaseOwner: string;
    leaseToken: string;
    now: Date;
    leaseMs: number;
  }): Promise<LeaseClaim> {
    const key = {
      providerKey: input.spec.provider,
      queryFingerprint: input.fingerprint,
      windowKey: input.windowKey,
    };
    for (let pass = 0; pass < 3; pass += 1) {
      const prior = await this.deps.prisma.signalIngest.findUnique({
        where: { providerKey_queryFingerprint_windowKey: key },
      });
      if (prior?.status === 'OK') return { kind: 'OK_HIT' };
      if (!prior) {
        try {
          await this.deps.prisma.signalIngest.create({
            data: {
              ...key,
              querySpec: input.spec as unknown as Prisma.InputJsonValue,
              recordsFetched: 0,
              signalsUpserted: 0,
              status: 'PENDING',
              error: null,
              fetchedAt: input.now,
              leaseOwner: input.leaseOwner,
              leaseToken: input.leaseToken,
              leaseFence: 1,
              leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
              startedAt: input.now,
              completedAt: null,
              attempt: 1,
            },
          });
          return {
            kind: 'CLAIMED',
            ...key,
            leaseOwner: input.leaseOwner,
            leaseToken: input.leaseToken,
            leaseFence: 1,
          };
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          continue;
        }
      }

      const priorExpiry = prior.leaseExpiresAt?.getTime();
      if (prior.status === 'PENDING' && priorExpiry !== undefined && priorExpiry >= input.now.getTime()) {
        return { kind: 'BUSY' };
      }
      const nextFence = Number(prior.leaseFence ?? 0) + 1;
      const updated = await this.deps.prisma.signalIngest.updateMany({
        where: {
          ...key,
          OR: [
            { status: 'ERROR' },
            { status: 'PENDING', leaseExpiresAt: { lt: input.now } },
          ],
        },
        data: {
          status: 'PENDING',
          error: null,
          recordsFetched: 0,
          signalsUpserted: 0,
          fetchedAt: input.now,
          leaseOwner: input.leaseOwner,
          leaseToken: input.leaseToken,
          leaseFence: { increment: 1 },
          leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
          startedAt: input.now,
          completedAt: null,
          attempt: { increment: 1 },
        },
      });
      if (updated.count === 1) {
        return {
          kind: 'CLAIMED',
          ...key,
          leaseOwner: input.leaseOwner,
          leaseToken: input.leaseToken,
          leaseFence: nextFence,
        };
      }
    }
    return { kind: 'BUSY' };
  }

  private async finalizeLeaseError(
    claim: ClaimedLease,
    error: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.deps.prisma.signalIngest.updateMany({
      where: leaseWhere(claim),
      data: {
        status: 'ERROR',
        error: error.slice(0, 300),
        recordsFetched: 0,
        signalsUpserted: 0,
        fetchedAt: now,
        completedAt: now,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    return result.count === 1;
  }

  private async persistSignalsAndFinalize(input: {
    claim: ClaimedLease;
    outcomes: MapOutcome[];
    recordsFetched: number;
    now: Date;
    leaseMs: number;
  }): Promise<{
    owned: boolean;
    upserted: number;
    skipped: Record<string, number>;
  }> {
    return this.deps.prisma.$transaction(
      async (tx) => {
        // This conditional UPDATE both revalidates the exact fence and holds a
        // row lock until source writes + OK settlement commit. A successor
        // reclaim therefore happens either wholly before this transaction
        // (zero writes) or wholly after the row becomes OK (no reclaim).
        const renewed = await tx.signalIngest.updateMany({
          where: {
            ...leaseWhere(input.claim),
            leaseExpiresAt: { gte: input.now },
          },
          data: {
            leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
          },
        });
        if (renewed.count !== 1) {
          return { owned: false, upserted: 0, skipped: {} };
        }

        const persisted = await this.persistSignals(input.outcomes, tx);
        const finalized = await tx.signalIngest.updateMany({
          where: leaseWhere(input.claim),
          data: {
            status: 'OK',
            error: null,
            recordsFetched: input.recordsFetched,
            signalsUpserted: persisted.upserted,
            fetchedAt: input.now,
            completedAt: input.now,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        if (finalized.count !== 1) {
          throw new Error('SIGNAL_LEASE_SETTLEMENT_FAILED');
        }
        return { owned: true, ...persisted };
      },
      { maxWait: 5_000, timeout: 120_000 },
    );
  }

  private async persistSignals(
    outcomes: MapOutcome[],
    db: Pick<Prisma.TransactionClient, 'sourceSignal'>,
  ): Promise<{ upserted: number; skipped: Record<string, number> }> {
    let upserted = 0;
    const skipped: Record<string, number> = {};
    for (const o of outcomes) {
      if (!o.row) {
        skipped[o.skip] = (skipped[o.skip] ?? 0) + 1;
        continue;
      }
      const r = o.row;
      await db.sourceSignal.upsert({
        where: {
          providerKey_externalId_signalType_subjectKey: {
            providerKey: r.providerKey, externalId: r.externalId, signalType: r.signalType, subjectKey: r.subjectKey,
          },
        },
        create: {
          providerKey: r.providerKey,
          signalType: r.signalType,
          externalId: r.externalId,
          subjectName: r.subjectName,
          subjectCountry: r.subjectCountry,
          subjectKey: r.subjectKey,
          taxonomyKeys: r.taxonomyKeys as unknown as Prisma.InputJsonValue,
          strength: r.strength,
          occurredAt: r.occurredAt,
          observedAt: r.observedAt,
          payload: r.payload as unknown as Prisma.InputJsonValue,
          license: r.license,
          jurisdiction: r.jurisdiction,
          expiresAt: r.expiresAt,
        },
        // 复现记录只前移观测时间：status/occurredAt/payload 不动（绝不复活 EXPIRED/REVOKED，事实不漂移）。
        update: { observedAt: r.observedAt },
      });
      upserted += 1;
    }
    return { upserted, skipped };
  }

}

interface ClaimedLease {
  kind: 'CLAIMED';
  providerKey: string;
  queryFingerprint: string;
  windowKey: string;
  leaseOwner: string;
  leaseToken: string;
  leaseFence: number;
}

type LeaseClaim = ClaimedLease | { kind: 'OK_HIT' } | { kind: 'BUSY' };

function leaseWhere(claim: ClaimedLease): Record<string, unknown> {
  return {
    providerKey: claim.providerKey,
    queryFingerprint: claim.queryFingerprint,
    windowKey: claim.windowKey,
    status: 'PENDING',
    leaseOwner: claim.leaseOwner,
    leaseToken: claim.leaseToken,
    leaseFence: claim.leaseFence,
  };
}

function resolveLeaseMs(explicit?: number): number {
  const raw = explicit ?? Number(process.env.SIGNAL_INGEST_LEASE_MS ?? 35 * 60_000);
  if (!Number.isSafeInteger(raw) || raw < 1_000 || raw > 60 * 60_000) {
    throw new Error('INVALID_SIGNAL_INGEST_LEASE_MS');
  }
  return raw;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/** 撤回补丁：状态翻转 + 脱敏（subjectName 占位、payload 清空）。 */
function revokePatch(): {
  status: string;
  revokedAt: Date;
  subjectName: string;
  payload: Prisma.InputJsonValue;
} {
  return { status: 'REVOKED', revokedAt: new Date(), subjectName: 'REDACTED', payload: {} };
}

export interface IngestOpts {
  /** 时钟注入（单测/verify 确定窗）；缺省 Date.now()。 */
  nowMs?: number;
  /** 预算账键（sweep 开账后传入，经 ctx.runId 入 Broker reserve-settle）。 */
  budgetKey?: string;
  /** Bounded machine identity for the current activity attempt. */
  leaseOwner?: string;
  /** Explicit lease duration for deterministic tests; production defaults to 35 minutes. */
  leaseMs?: number;
}

export interface IngestOutcome {
  provider: 'ted' | 'openfda' | 'samgov';
  fingerprint: string;
  windowKey: string;
  /** true = 账本 OK 行命中，本次未出网（ingest-once）。 */
  ledgerHit: boolean;
  recordsFetched: number;
  signalsUpserted: number;
  skipped: Record<string, number>;
  error?: string;
  leaseBusy?: boolean;
  leaseLost?: boolean;
}

function emptyOutcome(provider: 'ted' | 'openfda' | 'samgov', error: string): IngestOutcome {
  return { provider, fingerprint: '', windowKey: '', ledgerHit: false, recordsFetched: 0, signalsUpserted: 0, skipped: {}, error };
}
