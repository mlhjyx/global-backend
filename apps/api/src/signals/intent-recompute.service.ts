import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeDomain } from '../discovery/identity';
import { toAlpha2 } from '../discovery/providers/ted.provider';
import { cpvOverlap } from '../intent/ted-intent-projection.service';
import {
  INTENT_CHANGE_TYPES,
  IntentAttr,
  IntentEvent,
  mergeIntent,
  sameIntent,
  toIntentEvent,
} from '../intent/intent-projection.service';
import { WEB_WATCH_KEY } from '../intent/website-watch.service';
import { isLikelyIndividualApplicant } from './signal-mappers';

const DEFAULT_WEB_WATCH_REPLAY_MS = 90 * 86_400_000; // web_watch 事实重放窗（受保留期清理约束——GDPR 存储限制即复算地平线）
const DEFAULT_PAGE_LIMIT = 200;
const WEB_WATCH_REPLAY_TAKE = 500;
const TED_DEFAULT_SINCE_DAYS = 30; // 与增量投影同窗（ted-intent-projection DEFAULT_SINCE_DAYS）
const FDA_DEFAULT_SINCE_DAYS = 365;
const DAY_MS = 86_400_000;

/**
 * 复算的投影面 = 增量投影的过滤参数（由调用方从本 workspace 全部 ACTIVE ICP 解析而来，
 * 即 resolveExternalIntentTarget 的输出）。**复算必须与增量投影重放同一过滤面**——否则跨 CPV/跨 ICP
 * 的他租户信号会被注入本租户 intent，且与增量 sweep 无公共不动点形成抖动循环（对抗复审 HIGH）。
 */
export type ProjectionSurface =
  | { provider: 'ted'; cpvCodes: string[]; buyerCountries: string[]; sinceDays?: number }
  | { provider: 'openfda'; productCodes: string[]; applicantCountries?: string[]; sinceDays?: number };

export type RecomputeCompanyOutcome = 'unchanged' | 'rebuilt' | 'cleared' | 'missing';

export interface RecomputeOpts {
  /** 外部源投影面（缺省空=只重放 web_watch 租户轨；TED/FDA 信号一律不注入）。 */
  surfaces?: ProjectionSurface[];
  webWatchReplayMs?: number;
}

export interface RecomputeWorkspaceResult {
  companiesScanned: number;
  companiesRebuilt: number;
  companiesCleared: number;
  nextCursor: string | null; // id 游标（分页续跑；null=扫完）
}

/**
 * attributes.intent 复算入口（收口⑤验收「信号可复算」）：把租户投影从事实源**确定性重建**——
 *   ① 平台一等信号 source_signal（TED/openFDA）：ACTIVE + **surfaces 过滤面**（同增量投影的
 *      窗口/国别/分类码/个体户四重过滤），**全部匹配信号**都映射为事件（与增量逐 sweep 累积的事件集
 *      同构，mergeIntent 按 type|epoch 去重）——EXPIRED/REVOKED 剔除 = 过期语义在复算路径的强制执行点；
 *   ② web_watch 租户轨事实 source_entity_change（按域名 sourceKey 定位监控源，保留期内重放同一
 *      INTENT_CHANGE_TYPES 事实集）——web_watch 按 ADR-006 归租户层不进 source_signal，其一等事实账本
 *      就是 source_entity_change，复算地平线受 purgeStaleEvents 保留期约束（GDPR 存储限制，文档化边界）。
 * 语义：重建结果与既有实质相同 → 不写（幂等，与增量投影有公共不动点）；事实源已无任何事件而公司仍挂
 * intent → **清除**（过期收敛）；复算不写 field_evidence（投影维护非新证据）。SUPPRESSED 跳过。
 */
export class IntentRecomputeService {
  constructor(private readonly deps: { prisma: PrismaService }) {}

  async recomputeCompany(
    workspaceId: string,
    canonicalCompanyId: string,
    opts?: RecomputeOpts,
  ): Promise<RecomputeCompanyOutcome> {
    const { prisma } = this.deps;
    const company = await prisma.withWorkspace(workspaceId, (tx) =>
      tx.canonicalCompany.findUnique({
        where: { id: canonicalCompanyId },
        select: { id: true, domain: true, dedupeKey: true, attributes: true, status: true },
      }),
    );
    if (!company || company.status === 'SUPPRESSED') return 'missing';

    const events: IntentEvent[] = [];
    const now = Date.now();

    // ① 平台一等信号：ACTIVE + 投影面过滤（与增量投影同一谓词），全部匹配信号入事件集。
    const surfaces = opts?.surfaces ?? [];
    if (surfaces.length) {
      const signals = await prisma.sourceSignal.findMany({
        where: { subjectKey: company.dedupeKey, status: 'ACTIVE' },
        orderBy: { occurredAt: 'desc' },
      });
      for (const s of signals) {
        if (!surfaces.some((sf) => surfaceMatches(sf, s, now))) continue;
        if (s.providerKey === 'openfda' && isLikelyIndividualApplicant(s.subjectName)) continue; // §6 防御纵深（同投影层）
        events.push({
          type: s.signalType,
          at: s.occurredAt.toISOString(),
          strength: s.strength,
          evidence: signalEvidence(s.providerKey, (s.payload ?? {}) as Record<string, unknown>, s.externalId),
        });
      }
    }

    // ② web_watch 租户轨事实重放（域名定位监控源；保留期内）。
    const domain = company.domain ? normalizeDomain(company.domain) ?? undefined : undefined;
    if (domain) {
      const src = await prisma.monitoredSource.findUnique({
        where: { sourceKey: `${WEB_WATCH_KEY}:${domain}` },
        select: { id: true },
      });
      if (src) {
        const changes = await prisma.sourceEntityChange.findMany({
          where: {
            sourceId: src.id,
            changeType: { in: INTENT_CHANGE_TYPES },
            createdAt: { gte: new Date(now - (opts?.webWatchReplayMs ?? DEFAULT_WEB_WATCH_REPLAY_MS)) },
          },
          orderBy: { createdAt: 'desc' },
          take: WEB_WATCH_REPLAY_TAKE,
        });
        events.push(...changes.map(toIntentEvent));
      }
    }

    const attrs = ((company.attributes as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
    const priorIntent = attrs.intent as IntentAttr | undefined;
    const nextIntent = events.length ? mergeIntent(undefined, events) : undefined;

    if (!nextIntent) {
      if (!priorIntent) return 'unchanged';
      // 事实源已无任何有效事件（全过期/撤回/超保留期/出投影面）→ 清除陈旧投影（过期收敛）。
      const { intent: _stale, ...rest } = attrs;
      await this.writeAttributes(workspaceId, company.id, rest);
      return 'cleared';
    }
    if (priorIntent && sameIntent(priorIntent, nextIntent)) return 'unchanged';
    await this.writeAttributes(workspaceId, company.id, { ...attrs, intent: nextIntent });
    return 'rebuilt';
  }

  /** 分页复算整个 workspace（id 游标防活锁，同 backlog 惯例；有界，绝不单轮 grind 全量）。 */
  async recomputeWorkspace(
    workspaceId: string,
    opts?: RecomputeOpts & { limit?: number; cursor?: string },
  ): Promise<RecomputeWorkspaceResult> {
    const { prisma } = this.deps;
    const limit = opts?.limit ?? DEFAULT_PAGE_LIMIT;
    const companies = await prisma.withWorkspace(workspaceId, (tx) =>
      tx.canonicalCompany.findMany({
        where: opts?.cursor ? { id: { gt: opts.cursor } } : {},
        select: { id: true },
        orderBy: { id: 'asc' },
        take: limit,
      }),
    );
    const out: RecomputeWorkspaceResult = {
      companiesScanned: companies.length,
      companiesRebuilt: 0,
      companiesCleared: 0,
      nextCursor: companies.length === limit ? companies[companies.length - 1].id : null,
    };
    for (const c of companies) {
      const r = await this.recomputeCompany(workspaceId, c.id, opts);
      if (r === 'rebuilt') out.companiesRebuilt += 1;
      if (r === 'cleared') out.companiesCleared += 1;
    }
    return out;
  }

  private async writeAttributes(workspaceId: string, companyId: string, attributes: Record<string, unknown>): Promise<void> {
    await this.deps.prisma.withWorkspace(workspaceId, (tx) =>
      tx.canonicalCompany.update({
        where: { id: companyId },
        data: { attributes: attributes as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
      }),
    );
  }
}

/** 投影面谓词（与 ted/openfda 投影 service 的过滤语义逐条对齐——改那边必须同步改这里）。 */
function surfaceMatches(
  sf: ProjectionSurface,
  s: { providerKey: string; occurredAt: Date; subjectCountry: string; taxonomyKeys: unknown },
  nowMs: number,
): boolean {
  if (s.providerKey !== sf.provider) return false;
  const keys = Array.isArray(s.taxonomyKeys) ? (s.taxonomyKeys as string[]) : [];
  if (sf.provider === 'ted') {
    if (!sf.cpvCodes.length || !sf.buyerCountries.length) return false;
    const since = nowMs - (sf.sinceDays ?? TED_DEFAULT_SINCE_DAYS) * DAY_MS;
    if (s.occurredAt.getTime() < since) return false;
    const countries = new Set(sf.buyerCountries.map((c) => toAlpha2(c)).filter(Boolean));
    if (!countries.has(s.subjectCountry)) return false;
    return keys.some((k) => sf.cpvCodes.some((icpCode) => cpvOverlap(icpCode, k)));
  }
  if (!sf.productCodes.length) return false;
  const since = nowMs - (sf.sinceDays ?? FDA_DEFAULT_SINCE_DAYS) * DAY_MS;
  if (s.occurredAt.getTime() < since) return false;
  if (sf.applicantCountries?.length) {
    const countries = new Set(sf.applicantCountries.map((c) => c.trim().toUpperCase()));
    if (!countries.has(s.subjectCountry.toUpperCase())) return false;
  }
  const wanted = new Set(sf.productCodes.map((c) => c.trim().toUpperCase()));
  return keys.some((k) => k.startsWith('fda:') && wanted.has(k.slice(4).toUpperCase()));
}

/** 与增量投影同形的事件证据（评分/审计视角无差异）。 */
function signalEvidence(providerKey: string, payload: Record<string, unknown>, externalId: string): unknown {
  if (providerKey === 'ted') {
    return {
      cpv: Array.isArray(payload.cpv) ? payload.cpv : [],
      notice: typeof payload.notice === 'string' ? payload.notice : externalId,
      source: 'ted',
    };
  }
  return {
    product_code: typeof payload.product_code === 'string' ? payload.product_code : undefined,
    k_number: typeof payload.k_number === 'string' ? payload.k_number : externalId, // 与增量投影同回退（sameIntent 不动点依赖证据同形）
    device: typeof payload.device === 'string' ? payload.device : undefined,
    source: 'openfda',
  };
}
