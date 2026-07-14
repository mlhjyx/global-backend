import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildSanctionsIndex,
  screenName,
  DEFAULT_MATCH_THRESHOLD,
  type IndexedSanctionsEntity,
  type MatcherOpts,
  type SanctionsEntityRow,
  type ScreenMatch,
} from './sanctions-matcher';

/**
 * 制裁筛查服务（Qualify 第五门的匹配引擎）。进程内内存索引（从 sanctions_entity 建，init + 刷新后重建），
 * 对公司名召回优先匹配。平台参考表无 RLS、app_user 只读（GRANT SELECT），故直接 this.prisma 读、不需租户上下文。
 *
 * 🔴 fail-open 诚实姿势（设计决策④）：无 ENABLED 源 / 空索引 → `screen()` 返 `not_screened`（快照如实标、门不拦，
 *    不断管线）；ops 翻 ENABLED + 真测绿后才生效为硬门。索引构建失败亦 active=false（不阻断 qualify）。
 */

export interface ScreenResult {
  status: 'clear' | 'potential_match' | 'not_screened';
  matches: ScreenMatch[];
  listVersions: Record<string, string>; // sourceKey → 名单版本（ISO 日期）
}

@Injectable()
export class SanctionsScreeningService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SanctionsScreeningService.name);
  private index: IndexedSanctionsEntity[] = [];
  private listVersions: Record<string, string> = {};
  private active = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.rebuildIndexSafe();
    // 周期性重建：API 长驻进程与每日名单刷新之间保持新鲜（decide 硬门读同一索引；默认 1h，env 可调）。
    this.timer = setInterval(() => void this.rebuildIndexSafe(), rebuildIntervalMs());
    if (typeof this.timer.unref === 'function') this.timer.unref(); // 不阻止进程退出
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async rebuildIndexSafe(): Promise<void> {
    try {
      await this.rebuildIndex();
    } catch (err) {
      // 索引构建失败 → active=false（fail-open：门标 not_screened，不阻断 qualify 管线）
      this.logger.warn(`sanctions index build failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 从 ENABLED 源 + 未撤下实体重建进程内索引（刷新后调）。 */
  async rebuildIndex(): Promise<void> {
    const sources = await this.prisma.sanctionsSource.findMany({ where: { status: 'ENABLED' } });
    if (!sources.length) {
      this.index = [];
      this.listVersions = {};
      this.active = false;
      return;
    }
    const keyById = new Map(sources.map((s) => [s.id, s.key]));
    const entities = await this.prisma.sanctionsEntity.findMany({
      where: { sourceId: { in: sources.map((s) => s.id) }, withdrawnAt: null },
      select: {
        externalId: true,
        sourceId: true,
        primaryName: true,
        country: true,
        listVersion: true,
        aliases: true,
      },
    });
    const rows: SanctionsEntityRow[] = entities.map((e) => ({
      externalId: e.externalId,
      sourceKey: keyById.get(e.sourceId) ?? 'unknown',
      primaryName: e.primaryName,
      country: e.country,
      listVersion: e.listVersion,
      aliases: e.aliases,
    }));
    this.index = buildSanctionsIndex(rows);
    this.listVersions = Object.fromEntries(
      sources.map((s) => [s.key, s.publishDate ? s.publishDate.toISOString().slice(0, 10) : '']),
    );
    this.active = this.index.length > 0;
    this.logger.log(`sanctions index built: ${this.index.length} entities from ${sources.length} enabled source(s)`);
  }

  /** 门是否生效（有 ENABLED 源 + 非空索引）。 */
  isActive(): boolean {
    return this.active;
  }

  /** 对一个公司名筛查。未生效 → not_screened（快照如实、门不拦，fail-open）。 */
  screen(companyName: string, country: string | null, opts?: MatcherOpts): ScreenResult {
    if (!this.active) return { status: 'not_screened', matches: [], listVersions: {} };
    const matches = screenName(companyName, country, this.index, { threshold: envThreshold(), ...opts });
    return {
      status: matches.length ? 'potential_match' : 'clear',
      matches,
      listVersions: this.listVersions,
    };
  }
}

/** env 覆盖召回阈值（默认 0.70）；非法值退回默认。 */
function envThreshold(): number {
  const raw = Number(process.env.SANCTIONS_MATCH_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_MATCH_THRESHOLD;
}

/** 索引重建周期（ms，默认 1h，下限 60s）。 */
function rebuildIntervalMs(): number {
  const raw = Number(process.env.SANCTIONS_INDEX_REBUILD_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 3_600_000;
}

/** 命中抑制键 = 名单源:条目 id（re-screen 时判「是否同一条已清命中」）。 */
export function screenMatchKey(m: { sourceKey: string; externalId: string }): string {
  return `${m.sourceKey}:${m.externalId}`;
}

/** Prisma matches Json → reconcile 输入的最小形状（sourceKey/externalId）。qualify/decide 共用。 */
export function matchesFromJson(raw: unknown): { sourceKey: string; externalId: string }[] {
  if (!Array.isArray(raw)) return [];
  return (raw as { sourceKey?: unknown; externalId?: unknown }[])
    .filter((m) => typeof m?.sourceKey === 'string' && typeof m?.externalId === 'string')
    .map((m) => ({ sourceKey: m.sourceKey as string, externalId: m.externalId as string }));
}

/**
 * 复核态对账（re-screen 时，纯函数）：
 *  - confirmed_true_hit 恒留（真命中，永远隔离）；
 *  - cleared_false_positive **仅当新命中 ⊆ 已清命中**才保留（prior-cleared-match 抑制，防复核疲劳）；
 *    出现**任一新条目** → 重开 'open'（名单新增了新的疑似命中，须重新人审）；
 *  - 其余（含无既有记录）→ 'open'。
 */
export function reconcileReviewState(
  existing: { reviewState: string; matches: { sourceKey: string; externalId: string }[] } | null,
  newMatches: readonly { sourceKey: string; externalId: string }[],
): 'open' | 'cleared_false_positive' | 'confirmed_true_hit' {
  if (!existing) return 'open';
  if (existing.reviewState === 'confirmed_true_hit') return 'confirmed_true_hit';
  if (existing.reviewState === 'cleared_false_positive') {
    const cleared = new Set(existing.matches.map(screenMatchKey));
    return newMatches.every((m) => cleared.has(screenMatchKey(m))) ? 'cleared_false_positive' : 'open';
  }
  return 'open';
}
