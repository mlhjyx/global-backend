import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SourceAdapterRegistry } from './source-adapter';
import { cleanEntity, CleanedEntity } from './clean';
import { MISS_THRESHOLD, computeNextFetchAt } from './monitored-source.lifecycle';

const PARSER_VERSION = 'acquisition/v1';
const CHUNK = 50;
const DEFAULT_FETCH_LIMIT = 10000; // 显式抓取上限；raw 达此值视为「疑似截断」→ 本次不判 REMOVED（防误杀）。源可用 config.fetchLimit 覆盖

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

/**
 * 采集与监控核心（源无关）：对一个 monitored_source 跑一次「抓取 → 清洗 → 快照落库 → diff 增量」。
 *  - 抓取：providerKey 对应的 source 适配器（展会/名录/…），网络在事务外。
 *  - 清洗：cleanEntity 归一去噪 + 邮箱分级 + contentHash。
 *  - 增量：按 (source, externalId) 对齐现有 source_entity——新增=ADDED、hash 变=UPDATED、
 *    缺席累计到阈值=REMOVED（防误杀）、不变=touch lastSeen。变更进 source_entity_change（时机信号）。
 * 平台级共享（无 RLS）：一个源抓一次服务所有租户。Kill-Switch=source.status!=ACTIVE。
 */
export class AcquisitionService {
  constructor(private readonly deps: { prisma: PrismaService; registry: SourceAdapterRegistry }) {}

  async acquire(sourceId: string, opts?: { limit?: number }): Promise<AcquireResult> {
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
    let truncated = false; // raw 达到抓取上限 → 快照可能不完整
    try {
      const config = { ...(source.config as Record<string, unknown>), sourceKey: source.sourceKey };
      const configLimit = Number((source.config as Record<string, unknown>)?.fetchLimit);
      const limit = opts?.limit ?? (Number.isFinite(configLimit) && configLimit > 0 ? configLimit : DEFAULT_FETCH_LIMIT);
      const raw = await adapter.fetch(config, limit);
      truncated = raw.length >= limit;
      const byExt = new Map<string, CleanedEntity>();
      for (const r of raw) {
        const c = cleanEntity(r);
        if (c && !byExt.has(c.externalId)) byExt.set(c.externalId, c); // 批内去重
      }
      cleaned = [...byExt.values()];
    } catch (err) {
      await prisma.sourceFetch.update({
        where: { id: fetch.id },
        data: { status: 'FAILED', error: String(err).slice(0, 300), finishedAt: new Date() },
      });
      return { sourceId, status: 'FAILED', total: 0, added: 0, updated: 0, removed: 0, unchanged: 0, reason: String(err).slice(0, 200) };
    }

    // ── diff vs 现有快照 ──
    const existing = await prisma.sourceEntity.findMany({ where: { sourceId } });
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
    if (toAdd.length) await prisma.sourceEntity.createMany({ data: toAdd, skipDuplicates: true });
    await inChunks(toUpdate, CHUNK, (u) =>
      prisma.sourceEntity.update({
        where: { id: u.id },
        data: {
          name: u.c.name, domain: u.c.domain ?? null, country: u.c.country ?? null,
          cleaned: u.c.cleaned as Prisma.InputJsonValue, contentHash: u.c.contentHash,
          lastSeenAt: now, withdrawnAt: null, missCount: 0,
        },
      }),
    );
    await inChunks(toTouch, CHUNK, (id) => prisma.sourceEntity.update({ where: { id }, data: { lastSeenAt: now, missCount: 0 } }));
    await inChunks(toMiss, CHUNK, (m) => prisma.sourceEntity.update({ where: { id: m.id }, data: { missCount: m.miss } }));
    await inChunks(toRemove, CHUNK, (id) => prisma.sourceEntity.update({ where: { id }, data: { withdrawnAt: now, missCount: MISS_THRESHOLD } }));
    if (changes.length) await prisma.sourceEntityChange.createMany({ data: changes });

    const result: AcquireResult = {
      sourceId, status: 'DONE',
      total: cleaned.length, added: toAdd.length, updated: toUpdate.length, removed: toRemove.length, unchanged: toTouch.length,
    };
    await prisma.sourceFetch.update({
      where: { id: fetch.id },
      data: { status: 'DONE', total: result.total, added: result.added, updated: result.updated, removed: result.removed, unchanged: result.unchanged, finishedAt: now },
    });
    await prisma.monitoredSource.update({
      where: { id: sourceId },
      data: { lastFetchAt: now, nextFetchAt: computeNextFetchAt(source.cadence, now) },
    });
    return result;
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
