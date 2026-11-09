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
import {
  evaluateSanctionsFreshness,
  sanctionsFreshnessThresholds,
  type SanctionsListFreshness,
} from './sanctions-freshness';
import {
  buildSanctionsFacts,
  sanctionsFreshnessState,
  type SanctionsSourceRow,
} from '../discovery/judgment/gates';
import {
  toSanctionsGateFreshness,
  type SanctionsGateFreshness,
} from '../discovery/judgment/gate-chain';

/**
 * 制裁筛查服务（Qualify 第五门的匹配引擎）。进程内内存索引（从 sanctions_entity 建，init + 刷新后重建），
 * 对公司名召回优先匹配。平台参考表无 RLS、app_user 只读（GRANT SELECT），故直接 this.prisma 读、不需租户上下文。
 *
 * 🔴 fail-open 诚实姿势（设计决策⑤：种子 DISABLED，未启用时门不拦）：无 ENABLED 源 / 空索引 → `screen()` 返 `not_screened`（快照如实标、门不拦，
 *    不断管线）；ops 翻 ENABLED + 真测绿后才生效为硬门。索引构建失败亦 active=false（不阻断 qualify）。
 *    例外：库里已有、未被人工清白的命中照拦（`storedScreeningBlocks`，accept、导出与 qualify 队列共用）。
 */

/**
 * P3 J07：筛查新鲜度四态（与 L0 门引擎同一套阈值：72h/168h 常量，见 gates.ts）。
 * `not_screened` = 无 ENABLED 源（门未启用），不是「筛过且清白」。
 */
export type SanctionsScreeningFreshness = SanctionsGateFreshness;

export interface ScreenResult {
  status: 'clear' | 'potential_match' | 'not_screened';
  matches: ScreenMatch[];
  listVersions: Record<string, string>; // sourceKey → 名单版本（ISO 日期）
  /**
   * P3 J07：本次筛查时名单处于 yellow/red（陈旧）。筛查仍跑、命中仍按原语义处理，
   * 但结果不得自动清白（不得进 recommended/导出/交付——执行归下游 J20 面板）。
   */
  readonly stale: boolean;
}

@Injectable()
export class SanctionsScreeningService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SanctionsScreeningService.name);
  private index: IndexedSanctionsEntity[] = [];
  private listVersions: Record<string, string> = {};
  private active = false;
  private timer?: ReturnType<typeof setInterval>;
  /**
   * P3 J07：重建索引时缓存的 ENABLED 源行（screen() 是同步热路径，鲜度阈值随时钟变化，
   * 用缓存行 + 当前时钟现算四态，不额外查库）。每小时重建顺带刷新。
   */
  private freshnessSources: readonly SanctionsSourceRow[] = [];

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
    this.freshnessSources = sources.map((source) => ({
      key: source.key,
      lastRefreshedAt: source.lastRefreshedAt,
      lastFetchStatus: source.lastFetchStatus,
    }));
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
    // 复审 #2：只对索引里**真有实体**的源声明覆盖——ENABLED 但零实体（刷新失败/全撤下）的源不进 listVersions，
    // 否则「clear」快照会虚报未实际筛过的名单覆盖（快照诚实红线）。
    const presentKeys = new Set(this.index.map((e) => e.sourceKey));
    this.listVersions = Object.fromEntries(
      sources
        .filter((s) => presentKeys.has(s.key))
        .map((s) => [s.key, s.publishDate ? s.publishDate.toISOString().slice(0, 10) : '']),
    );
    this.active = this.index.length > 0;
    this.logger.log(`sanctions index built: ${this.index.length} entities from ${sources.length} enabled source(s)`);
  }

  /** 门是否生效（有 ENABLED 源 + 非空索引）。 */
  isActive(): boolean {
    return this.active;
  }

  /**
   * ch08 §3.1.12 制裁陈旧门：读 ENABLED 源的最新刷新时间与抓取状态，按 env 阈值判三档。
   * 无 ENABLED 源 → inactive（筛查门本身未启用，不改变现状）。qualify / decide 调用前各查一次。
   */
  async listFreshness(now: Date = new Date()): Promise<SanctionsListFreshness> {
    const sources = await this.prisma.sanctionsSource.findMany({
      where: { status: 'ENABLED' },
      select: { key: true, lastRefreshedAt: true, lastFetchStatus: true },
      orderBy: { key: 'asc' },
    });
    return evaluateSanctionsFreshness(sources, now, sanctionsFreshnessThresholds());
  }

  /**
   * P3 J07：筛查门新鲜度四态 fresh/yellow/red/not_screened（阈值与 L0 门引擎同一套
   * 常量：72h fresh 上限、168h yellow 上限；任一 ENABLED 源从未刷新按 red 兜底）。
   * 与 listFreshness 的区别：listFreshness 是 ch08 的三档 env 阈值口径（accept/qualify
   * 既有行为），本方法是 gates.ts 决策表的口径（L0 门链与告警读这份）。
   */
  async freshness(now: Date = new Date()): Promise<SanctionsScreeningFreshness> {
    const sources = await this.prisma.sanctionsSource.findMany({
      where: { status: 'ENABLED' },
      select: { key: true, lastRefreshedAt: true, lastFetchStatus: true },
      orderBy: { key: 'asc' },
    });
    return toSanctionsGateFreshness(
      sanctionsFreshnessState(buildSanctionsFacts({ screening: null, sources, now })),
    );
  }

  /** 用重建时缓存的源行 + 当前时钟现算四态（同步热路径，不查库）。 */
  private cachedFreshness(now: Date): SanctionsScreeningFreshness {
    return toSanctionsGateFreshness(
      sanctionsFreshnessState(
        buildSanctionsFacts({ screening: null, sources: this.freshnessSources, now }),
      ),
    );
  }

  /** 对一个公司名筛查。未生效 → not_screened（快照如实、门不拦，fail-open）。 */
  screen(companyName: string, country: string | null, opts?: MatcherOpts): ScreenResult {
    const freshness = this.cachedFreshness(new Date());
    const stale = freshness === 'yellow' || freshness === 'red';
    if (!this.active) return { status: 'not_screened', matches: [], listVersions: {}, stale };
    const matches = screenName(companyName, country, this.index, { threshold: envThreshold(), ...opts });
    return {
      status: matches.length ? 'potential_match' : 'clear',
      matches,
      listVersions: this.listVersions,
      stale,
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
 * 库里存的筛查结果是否仍拦交付：命中且没被人工清白（open / confirmed_true_hit）。
 * accept（decide）、周报导出与 qualify 的队列共用这一条，三处不再各算各的（(q)：qualify 曾只看 live 筛查，
 * 命中消失后队列不 hold、accept 却照拦）。命中只由人在复核端点关闭，live 无命中不会自动放行。
 */
export function storedScreeningBlocks(prior: { status: string; reviewState: string } | null | undefined): boolean {
  return !!prior && prior.status === 'potential_match' && prior.reviewState !== 'cleared_false_positive';
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
