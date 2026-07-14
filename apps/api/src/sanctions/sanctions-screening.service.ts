import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
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
export class SanctionsScreeningService implements OnModuleInit {
  private readonly logger = new Logger(SanctionsScreeningService.name);
  private index: IndexedSanctionsEntity[] = [];
  private listVersions: Record<string, string> = {};
  private active = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
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
