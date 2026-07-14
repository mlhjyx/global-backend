import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import countries from 'world-countries';
import type { ExecutionBroker } from '../tools/tool-contract';
import { PLATFORM_WORKSPACE } from '../discovery/provider-contract';
import { normForMatch } from '../discovery/name-match';
import { parseOfacXml, type ParsedSanctionsEntity, type ParsedSanctionsList } from '../adapters/ofac-xml';
import { parseEuFsf } from '../adapters/eu-fsf-xml';
import type { SanctionsDownloadInput, SanctionsDownloadOutput } from '../tools/source-tools';

/**
 * 制裁名单刷新服务（Temporal 每日 Schedule 活动 + verify 脚本用）。owner 连接写平台表（绕 RLS）。
 * 下载**经 broker**（ADR-005 出网门 + source_policy fail-closed + SUSPENDED kill-switch）→ 按 format 解析
 * （仅 Entity/enterprise，person 已在解析层剔除）→ diff（contentHash）→ 批量 upsert + 缺席撤下。
 * 单源失败 fail-safe（标 FAILED，不阻断其余）。**非 @Injectable**（镜像 external-intent activities 注入 deps）。
 */

// 国名/代码 → alpha-2（world-countries）：OFAC 给全名 "Cuba"、EU 给代码/名 → 统一归 alpha-2，与 canonical 对齐。
const NAME_TO_ALPHA2 = buildCountryMap();
function buildCountryMap(): Map<string, string> {
  const m = new Map<string, string>();
  const list = countries as { cca2: string; cca3: string; name: { common: string; official: string }; altSpellings: string[] }[];
  for (const c of list) {
    for (const k of [c.name.common, c.name.official, c.cca2, c.cca3, ...(c.altSpellings ?? [])]) {
      if (k) m.set(k.toLowerCase(), c.cca2);
    }
  }
  return m;
}
export function countryToAlpha2(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return NAME_TO_ALPHA2.get(raw.trim().toLowerCase()) ?? null;
}

const PARSERS: Record<string, (xml: string) => ParsedSanctionsList> = {
  ofac_sdn_xml: parseOfacXml,
  eu_fsf_xml: parseEuFsf,
};

/** 归一后的目标实体行（persist 用；normalizedName + alpha-2 国别 + contentHash 均在此算一次）。 */
export interface DesiredSanctionsEntity {
  externalId: string;
  primaryName: string;
  normalizedName: string;
  country: string | null;
  programs: string[];
  aliases: { name: string; quality: 'strong' | 'weak' }[];
  rawFeatures: { addressCountry: string } | null; // 仅绿字段（地址国别），🔴 无 person PII
  listVersion: string;
  contentHash: string;
}

/** 解析实体 → 目标行（纯函数，可测）。contentHash 覆盖决定「变没变」的字段。 */
export function toDesiredEntity(e: ParsedSanctionsEntity, listVersion: string): DesiredSanctionsEntity {
  const canon = JSON.stringify({
    n: e.primaryName,
    c: e.country,
    p: [...e.programs].sort(),
    a: [...e.aliases].map((x) => `${x.quality}:${x.name}`).sort(),
    v: listVersion,
  });
  return {
    externalId: e.externalId,
    primaryName: e.primaryName,
    normalizedName: normForMatch(e.primaryName),
    country: countryToAlpha2(e.country),
    programs: e.programs,
    aliases: e.aliases,
    rawFeatures: e.country ? { addressCountry: e.country } : null,
    listVersion,
    contentHash: createHash('sha256').update(canon).digest('hex').slice(0, 24),
  };
}

export interface ExistingEntityRow {
  externalId: string;
  contentHash: string;
  withdrawnAt: Date | null;
}

export interface SanctionsDiff {
  toCreate: DesiredSanctionsEntity[];
  toUpdate: DesiredSanctionsEntity[]; // contentHash 变了 或 之前被撤下现又出现
  toWithdrawExternalIds: string[]; // 本次未出现且尚未撤下
  unchanged: number;
}

/** diff：现有行 vs 目标行 → 增/改/撤/不变（纯函数，可测）。 */
export function diffSanctionsEntities(
  existing: readonly ExistingEntityRow[],
  desired: readonly DesiredSanctionsEntity[],
): SanctionsDiff {
  const priorByExt = new Map(existing.map((e) => [e.externalId, e]));
  const seen = new Set<string>();
  const toCreate: DesiredSanctionsEntity[] = [];
  const toUpdate: DesiredSanctionsEntity[] = [];
  let unchanged = 0;
  for (const d of desired) {
    seen.add(d.externalId);
    const prior = priorByExt.get(d.externalId);
    if (!prior) toCreate.push(d);
    else if (prior.contentHash !== d.contentHash || prior.withdrawnAt) toUpdate.push(d);
    else unchanged++;
  }
  const toWithdrawExternalIds = existing.filter((e) => !seen.has(e.externalId) && !e.withdrawnAt).map((e) => e.externalId);
  return { toCreate, toUpdate, toWithdrawExternalIds, unchanged };
}

export interface SanctionsRefreshSummary {
  sourceKey: string;
  status: 'DONE' | 'FAILED';
  total: number;
  added: number;
  updated: number;
  unchanged: number;
  withdrawn: number;
  publishDate: string | null;
  error?: string;
}

export interface SanctionsRefreshDeps {
  ownerDb: PrismaClient; // owner 连接（绕 RLS，写平台表）
  broker: ExecutionBroker;
}

const CHUNK = 1000;
function chunks<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export class SanctionsRefreshService {
  constructor(private readonly deps: SanctionsRefreshDeps) {}

  /** 刷新全部 ENABLED 源（单源失败 fail-safe）。 */
  async refreshAll(): Promise<SanctionsRefreshSummary[]> {
    const sources = await this.deps.ownerDb.sanctionsSource.findMany({ where: { status: 'ENABLED' } });
    const out: SanctionsRefreshSummary[] = [];
    for (const src of sources) {
      try {
        out.push(await this.refreshSource(src.id));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.deps.ownerDb.sanctionsSource
          .update({ where: { id: src.id }, data: { lastRefreshedAt: new Date(), lastFetchStatus: 'FAILED' } })
          .catch(() => undefined);
        out.push({ sourceKey: src.key, status: 'FAILED', total: 0, added: 0, updated: 0, unchanged: 0, withdrawn: 0, publishDate: null, error: msg });
      }
    }
    return out;
  }

  /** 刷新单源：broker 下载 → 解析 → diff → 批量 upsert + 撤下 → 更新审计。 */
  async refreshSource(sourceId: string): Promise<SanctionsRefreshSummary> {
    const src = await this.deps.ownerDb.sanctionsSource.findUniqueOrThrow({ where: { id: sourceId } });
    const parse = PARSERS[src.format];
    if (!parse) throw new Error(`unsupported sanctions format: ${src.format}`);

    const userAgent = (src.config as { userAgent?: string } | null)?.userAgent;
    const res = await this.deps.broker.invoke<SanctionsDownloadInput, SanctionsDownloadOutput>(
      'sanctions.download',
      { url: src.url, userAgent },
      { workspaceId: PLATFORM_WORKSPACE, purpose: 'sanctions_screening' },
    );
    const parsed = parse(res.data.body);
    const listVersion = parsed.publishDate ?? new Date().toISOString().slice(0, 10);
    const desired = parsed.entities.map((e) => toDesiredEntity(e, listVersion));

    const existing = await this.deps.ownerDb.sanctionsEntity.findMany({
      where: { sourceId },
      select: { externalId: true, contentHash: true, withdrawnAt: true },
    });
    const diff = diffSanctionsEntities(existing, desired);

    const now = new Date();
    for (const chunk of chunks(diff.toCreate, CHUNK)) {
      await this.deps.ownerDb.sanctionsEntity.createMany({
        data: chunk.map((d) => ({ sourceId, ...toRow(d) })),
        skipDuplicates: true,
      });
    }
    for (const d of diff.toUpdate) {
      await this.deps.ownerDb.sanctionsEntity.update({
        where: { sourceId_externalId: { sourceId, externalId: d.externalId } },
        data: { ...toRow(d), lastSeenAt: now, withdrawnAt: null },
      });
    }
    for (const chunk of chunks(diff.toWithdrawExternalIds, CHUNK)) {
      await this.deps.ownerDb.sanctionsEntity.updateMany({
        where: { sourceId, externalId: { in: chunk } },
        data: { withdrawnAt: now },
      });
    }

    await this.deps.ownerDb.sanctionsSource.update({
      where: { id: sourceId },
      data: {
        publishDate: parsed.publishDate ? new Date(`${parsed.publishDate}T00:00:00.000Z`) : undefined,
        recordCount: parsed.entities.length,
        lastRefreshedAt: now,
        lastFetchStatus: 'DONE',
      },
    });

    return {
      sourceKey: src.key,
      status: 'DONE',
      total: parsed.entities.length,
      added: diff.toCreate.length,
      updated: diff.toUpdate.length,
      unchanged: diff.unchanged,
      withdrawn: diff.toWithdrawExternalIds.length,
      publishDate: parsed.publishDate,
    };
  }
}

/** 目标行 → Prisma 列（sourceId 由调用方补）。 */
function toRow(d: DesiredSanctionsEntity) {
  return {
    externalId: d.externalId,
    primaryName: d.primaryName,
    normalizedName: d.normalizedName,
    country: d.country,
    programs: d.programs,
    aliases: d.aliases,
    rawFeatures: d.rawFeatures ?? undefined,
    listVersion: d.listVersion,
    contentHash: d.contentHash,
  };
}
