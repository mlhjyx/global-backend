import { Prisma, type PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SourceAdapterRegistry } from './source-adapter';
import { cleanEntity, CleanedEntity } from './clean';
import { MISS_THRESHOLD, computeNextFetchAt } from './monitored-source.lifecycle';
import type { ToolContext } from '../tools/tool-contract';
import { BudgetExceededError } from '../tools/budget-store';
import { isExecutionControlError } from '../execution-budget/execution-control-error';
import { applyDomainAckConsumerTransactions } from '../durable-results/domain-ack-consumer-bindings';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';

const PARSER_VERSION = 'acquisition/v1';
const CHUNK = 50;
const DEFAULT_FETCH_LIMIT = 10000; // 显式抓取上限；raw 达此值视为「疑似截断」→ 本次不判 REMOVED（防误杀）。源可用 config.fetchLimit 覆盖
type AcquisitionWriteDb = Pick<
  PrismaClient,
  'sourceEntity' | 'sourceEntityChange' | 'sourceFetch' | 'monitoredSource'
>;

export interface AcquireResult {
  sourceId: string;
  status: 'DONE' | 'FAILED' | 'SKIPPED';
  total: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  reason?: string;
}

const ACQUISITION_RECEIPT_PRODUCERS = Object.freeze({
  trade_fair: 'tradefair.algolia',
  mapyourshow: 'mapyourshow.fetch',
} as const);

function parseAcquireResult(value: unknown): AcquireResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DOMAIN_ACK_AUTHORITATIVE_READBACK_UNAVAILABLE');
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.sourceId !== 'string' || row.status !== 'DONE' ||
    !['total', 'added', 'updated', 'removed', 'unchanged'].every(
      (key) => Number.isSafeInteger(row[key]) && (row[key] as number) >= 0,
    )
  ) {
    throw new Error('DOMAIN_ACK_AUTHORITATIVE_READBACK_UNAVAILABLE');
  }
  return Object.freeze({
    sourceId: row.sourceId,
    status: 'DONE' as const,
    total: row.total as number,
    added: row.added as number,
    updated: row.updated as number,
    removed: row.removed as number,
    unchanged: row.unchanged as number,
  });
}

/**
 * 采集与监控核心（源无关）：对一个 monitored_source 跑一次「抓取 → 清洗 → 快照落库 → diff 增量」。
 *  - 抓取：providerKey 对应的 source 适配器（展会/名录/…），网络在事务外。
 *  - 清洗：cleanEntity 归一去噪 + 邮箱分级 + contentHash。
 *  - 增量：按 (source, externalId) 对齐现有 source_entity——新增=ADDED、hash 变=UPDATED、
 *    缺席累计到阈值=REMOVED（防误杀）、不变=touch lastSeen。变更进 source_entity_change（时机信号）。
 * 平台级共享（无 RLS）：一个源抓一次服务所有租户。Kill-Switch=source.status!=ACTIVE。
 */
export class AcquisitionService {
  constructor(private readonly deps: {
    prisma: PrismaService;
    registry: SourceAdapterRegistry;
    platformWriter?: PrismaClient;
  }) {}

  async acquire(sourceId: string, opts?: {
    limit?: number;
    context?: ToolContext;
    durableReceipts?: Array<{
      producerId: string;
      receipt: DurableExecutionReceipt;
    }>;
  }): Promise<AcquireResult> {
    const { prisma, registry } = this.deps;
    const source = await prisma.monitoredSource.findUnique({ where: { id: sourceId } });
    if (!source) throw new Error(`monitored_source ${sourceId} not found`);
    if (source.status !== 'ACTIVE') {
      return { sourceId, status: 'SKIPPED', total: 0, added: 0, updated: 0, removed: 0, unchanged: 0, reason: `status=${source.status}` };
    }
    const adapter = registry.get(source.providerKey);
    if (!adapter) throw new Error(`no source adapter for providerKey=${source.providerKey}`);

    const fetch = await prisma.sourceFetch.create({
      data: { sourceId, status: 'RUNNING', parserVersion: PARSER_VERSION },
    });

    // ── 抓取（事务外，网络）+ 清洗 ──
    let cleaned: CleanedEntity[];
    const durableReceipts = opts?.durableReceipts ?? [];
    const expectedProducer = ACQUISITION_RECEIPT_PRODUCERS[
      source.providerKey as keyof typeof ACQUISITION_RECEIPT_PRODUCERS
    ];
    const context = opts?.durableReceipts
      ? opts.context
      : opts?.context
        ? {
            ...opts.context,
            onDurableReceipt: (producerId: string, receipt: DurableExecutionReceipt) => {
              if (!expectedProducer || producerId !== expectedProducer) {
                throw new Error('DOMAIN_ACK_CONSUMER_BINDING_MISSING');
              }
              durableReceipts.push({ producerId, receipt });
            },
          }
        : undefined;
    let truncated = false; // raw 达到抓取上限 → 快照可能不完整
    try {
      const config = { ...(source.config as Record<string, unknown>), sourceKey: source.sourceKey };
      const configLimit = Number((source.config as Record<string, unknown>)?.fetchLimit);
      const limit = opts?.limit ?? (Number.isFinite(configLimit) && configLimit > 0 ? configLimit : DEFAULT_FETCH_LIMIT);
      const raw = await adapter.fetch(config, limit, context);
      truncated = raw.length >= limit;
      const byExt = new Map<string, CleanedEntity>();
      for (const r of raw) {
        const c = cleanEntity(r);
        if (c && !byExt.has(c.externalId)) byExt.set(c.externalId, c); // 批内去重
      }
      cleaned = [...byExt.values()];
    } catch (err) {
      if (err instanceof BudgetExceededError || isExecutionControlError(err)) throw err;
      await prisma.sourceFetch.update({
        where: { id: fetch.id },
        data: { status: 'FAILED', error: String(err).slice(0, 300), finishedAt: new Date() },
      });
      return { sourceId, status: 'FAILED', total: 0, added: 0, updated: 0, removed: 0, unchanged: 0, reason: String(err).slice(0, 200) };
    }
    if (
      durableReceipts.some(({ producerId }) =>
        !expectedProducer || producerId !== expectedProducer)
    ) {
      throw new Error('DOMAIN_ACK_CONSUMER_BINDING_MISSING');
    }

    const persist = async (database: AcquisitionWriteDb): Promise<AcquireResult> => {
    // ── diff vs 现有快照 ──
    const existing = await database.sourceEntity.findMany({ where: { sourceId } });
    const existingByExt = new Map(existing.map((e) => [e.externalId, e]));
    const now = new Date();

    const toAdd: Prisma.SourceEntityCreateManyInput[] = [];
    const toUpdate: { id: string; c: CleanedEntity; changeType: string }[] = [];
    const toTouch: string[] = [];
    const changes: Prisma.SourceEntityChangeCreateManyInput[] = [];
    const seen = new Set<string>();

    for (const c of cleaned) {
      seen.add(c.externalId);
      const prev = existingByExt.get(c.externalId);
      if (!prev) {
        toAdd.push({
          sourceId, externalId: c.externalId, entityKind: 'company',
          name: c.name, domain: c.domain ?? null, country: c.country ?? null,
          cleaned: c.cleaned as Prisma.InputJsonValue, contentHash: c.contentHash,
          firstSeenAt: now, lastSeenAt: now,
        });
        changes.push({ sourceId, fetchId: fetch.id, externalId: c.externalId, changeType: 'ADDED', detail: { name: c.name, domain: c.domain } as Prisma.InputJsonValue });
      } else if (prev.withdrawnAt || prev.contentHash !== c.contentHash) {
        const changeType = prev.withdrawnAt ? 'ADDED' : detectChangeType(prev.cleaned, c.cleaned);
        toUpdate.push({ id: prev.id, c, changeType });
        changes.push({ sourceId, fetchId: fetch.id, externalId: c.externalId, changeType, detail: Prisma.JsonNull });
      } else {
        toTouch.push(prev.id);
      }
    }

    // 缺席 → miss / removed（防误杀：连续缺席达阈值才判退出）。
    // **截断快照跳过缺席判定**：raw 达到抓取上限时，"缺席"可能只是超出上限被截断（如定时 sweep
    // 用默认上限抓一个 >上限 的大展会），不应据此累计 miss / 判 REMOVED，否则会误杀仍在场的实体。
    const toMiss: { id: string; miss: number }[] = [];
    const toRemove: string[] = [];
    if (!truncated) {
      for (const e of existing) {
        if (seen.has(e.externalId) || e.withdrawnAt) continue;
        const miss = e.missCount + 1;
        if (miss >= MISS_THRESHOLD) {
          toRemove.push(e.id);
          changes.push({ sourceId, fetchId: fetch.id, externalId: e.externalId, changeType: 'REMOVED', detail: Prisma.JsonNull });
        } else {
          toMiss.push({ id: e.id, miss });
        }
      }
    }

    // ── 落库（分批）──
    if (toAdd.length) await database.sourceEntity.createMany({ data: toAdd, skipDuplicates: true });
    await inChunks(toUpdate, CHUNK, (u) =>
      database.sourceEntity.update({
        where: { id: u.id },
        data: {
          name: u.c.name, domain: u.c.domain ?? null, country: u.c.country ?? null,
          cleaned: u.c.cleaned as Prisma.InputJsonValue, contentHash: u.c.contentHash,
          lastSeenAt: now, withdrawnAt: null, missCount: 0,
        },
      }),
    );
    await inChunks(toTouch, CHUNK, (id) => database.sourceEntity.update({ where: { id }, data: { lastSeenAt: now, missCount: 0 } }));
    await inChunks(toMiss, CHUNK, (m) => database.sourceEntity.update({ where: { id: m.id }, data: { missCount: m.miss } }));
    await inChunks(toRemove, CHUNK, (id) => database.sourceEntity.update({ where: { id }, data: { withdrawnAt: now, missCount: MISS_THRESHOLD } }));
    if (changes.length) await database.sourceEntityChange.createMany({ data: changes });

    const result: AcquireResult = {
      sourceId, status: 'DONE',
      total: cleaned.length, added: toAdd.length, updated: toUpdate.length, removed: toRemove.length, unchanged: toTouch.length,
    };
    await database.sourceFetch.update({
      where: { id: fetch.id },
      data: {
        status: 'DONE', total: result.total, added: result.added,
        updated: result.updated, removed: result.removed,
        unchanged: result.unchanged, finishedAt: now,
        ...(durableReceipts.length ? {
          executionOperationIds: durableReceipts.map(
            ({ receipt }) => receipt.operationId,
          ) as unknown as Prisma.InputJsonValue,
          executionResult: result as unknown as Prisma.InputJsonValue,
        } : {}),
      },
    });
    await database.monitoredSource.update({
      where: { id: sourceId },
      data: { lastFetchAt: now, nextFetchAt: computeNextFetchAt(source.cadence, now) },
    });
    return result;
    };
    if (!durableReceipts.length) {
      return persist(prisma as unknown as AcquisitionWriteDb);
    }
    if (!this.deps.platformWriter) {
      throw new Error('DOMAIN_ACK_PLATFORM_TRANSACTION_UNAVAILABLE');
    }
    return this.deps.platformWriter.$transaction(async (transaction) => {
      const result = await applyDomainAckConsumerTransactions({
        transaction,
        acknowledgements: durableReceipts.map(({ producerId, receipt }) => ({
          producerId,
          receipt,
          domainAckKey: `${sourceId}:${receipt.operationId}`,
          domainRevision: receipt.resultDigest,
        })),
        apply: (database) => persist(database as unknown as AcquisitionWriteDb),
        readback: async (database) => {
          const operationIds = durableReceipts.map(({ receipt }) => receipt.operationId);
          const prior = await database.sourceFetch.findFirst({
            where: {
              status: 'DONE',
              executionOperationIds: { equals: operationIds },
            },
            orderBy: { finishedAt: 'desc' },
            select: { executionResult: true },
          } as never);
          const authoritative = parseAcquireResult(prior?.executionResult);
          await database.sourceFetch.update({
            where: { id: fetch.id },
            data: {
              status: 'REPLAYED',
              finishedAt: new Date(),
              executionResult: authoritative as unknown as Prisma.InputJsonValue,
            },
          } as never);
          return authoritative;
        },
      });
      return result.value;
    });
  }
}

/** 判定变更子类型：产品变→PRODUCTS_CHANGED、联系方式变→CONTACT_CHANGED、否则 UPDATED。 */
function detectChangeType(prevCleaned: unknown, nextCleaned: Record<string, unknown>): string {
  const prev = (prevCleaned ?? {}) as Record<string, unknown>;
  const j = (v: unknown) => JSON.stringify(v ?? null);
  if (j(prev.products) !== j(nextCleaned.products)) return 'PRODUCTS_CHANGED';
  if (j(prev.email) !== j(nextCleaned.email) || j(prev.phone) !== j(nextCleaned.phone)) return 'CONTACT_CHANGED';
  return 'UPDATED';
}

async function inChunks<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}
