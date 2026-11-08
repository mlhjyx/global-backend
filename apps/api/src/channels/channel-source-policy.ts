import type { ChannelManifestDocument } from '@global/contracts';

/**
 * CH-8（v3.0 第 6 章 §6.3.6.5）：source_policy 派生与启用条款闸门。
 *
 * 治理事实：source_policy 是 app_user **只读**的治理表（2026-10-09 加固，且由
 * `governance-table-privileges.postgres.spec.ts` 在 CI 漂移时拦住）。所以派生不能像
 * 章节草稿设想的那样在 API 事务里 upsert——本模块只产出「草稿行」与闸门判定（纯函数），
 * 由 owner 权限的运营脚本 `apply-channel-source-policies.mts` 落库；渠道启用时再以
 * SELECT 读回逐域校验。
 *
 * 三个状态位各司其职（不互相替代）：
 *   - reviewStatus 只是域名白名单的启停位（派生行直接 APPROVED）；
 *   - termsStatus 是条款复核门（必须 REVIEWED_OK / REVIEWED_RESTRICTED）；
 *   - robotsStatus 是抓取许可（crawl 形态必须 ALLOWS；api 无 robots 语义）。
 */

/** 官方开放数据白名单：不要求人工条款复核（命中即豁免 source_policy 行）。 */
export const OFFICIAL_SOURCE_HOSTS = [
  '*.gov',
  '*.europa.eu',
  'api.gleif.org',
  'query.wikidata.org',
  'overpass-api.de',
] as const;

/** 渠道类别 → source_policy.source_type（章节 §6.3.6.5 的映射；该列是自由文本）。 */
export const CHANNEL_SOURCE_TYPE_BY_CATEGORY: Readonly<Record<string, string>> = Object.freeze({
  trade_fair: 'trade_fair',
  customs: 'customs',
  association: 'association',
  directory: 'directory',
  tender: 'tender',
  other: 'news',
});

const CONCRETE_HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;

function hostMatchesPattern(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return host.endsWith(`.${suffix}`) && host.length > suffix.length + 1;
  }
  return host === pattern;
}

export function isOfficialSourceHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return OFFICIAL_SOURCE_HOSTS.some((pattern) => hostMatchesPattern(normalized, pattern));
}

export function isConcreteHost(host: string): boolean {
  return CONCRETE_HOST.test(host) && !host.includes('*');
}

function policyDomain(host: string): string {
  return host.toLowerCase().replace(/^www\./u, '');
}

/** host → source_policy.domain（小写、去 www）。 */
export function sourcePolicyDomain(host: string): string {
  return policyDomain(host);
}

/** 供 SELECT 查询的归一化 domain 列表（去 www、去重、跳过通配）。 */
export function sourcePolicyLookupDomains(hosts: readonly string[]): string[] {
  return [...new Set(hosts.filter(isConcreteHost).map(policyDomain))];
}

export interface ChannelSourcePolicyDraft {
  readonly domain: string;
  readonly sourceType: string;
  readonly accessMode: 'api' | 'crawl';
  readonly robotsStatus: 'ALLOWS' | 'UNREVIEWED';
  readonly termsStatus: 'UNREVIEWED' | 'REVIEWED_OK';
  readonly personalData: boolean;
  readonly allowedPurpose: string[] | null;
  readonly crawlDelayMs: number;
  readonly retentionDays: number;
  readonly reviewStatus: 'APPROVED';
  readonly notes: string;
}

export interface ChannelPolicySubject {
  readonly id: string;
  readonly mode: string;
  readonly category: string;
}

/**
 * 由已校验 manifest 派生 source_policy 草稿（每个具体 host 一行；通配 host 无法枚举，跳过）。
 * `meta.version` 写进 notes 供审计；条款/robots 的人工结论由落库脚本保留、不被覆盖。
 */
export function deriveSourcePolicyDrafts(
  channel: ChannelPolicySubject,
  manifest: ChannelManifestDocument,
): ChannelSourcePolicyDraft[] {
  const accessMode = channel.mode === 'api' ? 'api' : 'crawl';
  const sourceType = CHANNEL_SOURCE_TYPE_BY_CATEGORY[channel.category] ?? 'news';
  const hosts = manifest.transport.allowedHosts ?? [new URL(manifest.transport.baseUrl).hostname];
  const seen = new Set<string>();
  const drafts: ChannelSourcePolicyDraft[] = [];
  for (const host of hosts) {
    if (!isConcreteHost(host)) continue;
    const domain = policyDomain(host);
    if (seen.has(domain)) continue;
    seen.add(domain);
    const official = isOfficialSourceHost(domain);
    drafts.push({
      domain,
      sourceType,
      accessMode,
      // api 无 robots 语义，默认 ALLOWS；crawl 的实际结论由 probe 写入，这里保持 UNREVIEWED。
      robotsStatus: accessMode === 'api' ? 'ALLOWS' : 'UNREVIEWED',
      termsStatus: official ? 'REVIEWED_OK' : 'UNREVIEWED',
      personalData: manifest.governance?.personalData ?? false,
      allowedPurpose: manifest.governance?.allowedPurpose ?? null,
      crawlDelayMs: manifest.rateLimit?.perDomainDelayMs ?? 2000,
      retentionDays: manifest.governance?.retentionDays ?? 365,
      reviewStatus: 'APPROVED',
      notes: `${official ? 'official-open-data; ' : ''}derived from channel ${channel.id} manifest v${manifest.meta.version}`,
    });
  }
  return drafts;
}

export interface ChannelPolicyRow {
  readonly domain: string;
  readonly reviewStatus: string;
  readonly termsStatus: string;
  readonly robotsStatus: string;
}

export type ChannelPolicyViolationReason =
  | 'POLICY_MISSING'
  | 'POLICY_SUSPENDED'
  | 'TERMS_UNREVIEWED'
  | 'ROBOTS_RESTRICTS';

export interface ChannelPolicyViolation {
  readonly host: string;
  readonly reason: ChannelPolicyViolationReason;
}

/**
 * 启用闸门（只读判定）：allowedHosts 逐域必须有行、reviewStatus=APPROVED、
 * termsStatus∈{REVIEWED_OK,REVIEWED_RESTRICTED}；crawl 形态还要求 robotsStatus=ALLOWS。
 * 官方开放数据域豁免（无需行）。
 */
export function evaluateChannelSourcePolicyGate(input: {
  readonly mode: string;
  readonly hosts: readonly string[];
  readonly policies: readonly ChannelPolicyRow[];
}): ChannelPolicyViolation[] {
  const byDomain = new Map(input.policies.map((row) => [row.domain.toLowerCase(), row]));
  const violations: ChannelPolicyViolation[] = [];
  for (const host of input.hosts) {
    if (!isConcreteHost(host)) continue;
    const domain = policyDomain(host);
    if (isOfficialSourceHost(domain)) continue;
    const policy = byDomain.get(domain);
    if (!policy) {
      violations.push({ host: domain, reason: 'POLICY_MISSING' });
      continue;
    }
    if (policy.reviewStatus !== 'APPROVED') {
      violations.push({ host: domain, reason: 'POLICY_SUSPENDED' });
      continue;
    }
    if (policy.termsStatus !== 'REVIEWED_OK' && policy.termsStatus !== 'REVIEWED_RESTRICTED') {
      violations.push({ host: domain, reason: 'TERMS_UNREVIEWED' });
      continue;
    }
    if (input.mode === 'crawl' && policy.robotsStatus !== 'ALLOWS') {
      violations.push({ host: domain, reason: 'ROBOTS_RESTRICTS' });
    }
  }
  return violations;
}

export interface SourcePolicyUpsertInput {
  readonly create: ChannelSourcePolicyDraft;
  /** 更新只碰派生字段；terms/review/robots 的人工结论保留。 */
  readonly update: Omit<
    ChannelSourcePolicyDraft,
    'domain' | 'termsStatus' | 'reviewStatus' | 'robotsStatus'
  >;
}

/** owner 脚本用的 upsert 输入（创建写全量；更新保留人工治理结论）。 */
export function sourcePolicyUpsertInput(draft: ChannelSourcePolicyDraft): SourcePolicyUpsertInput {
  return {
    create: { ...draft },
    update: {
      sourceType: draft.sourceType,
      accessMode: draft.accessMode,
      personalData: draft.personalData,
      allowedPurpose: draft.allowedPurpose,
      crawlDelayMs: draft.crawlDelayMs,
      retentionDays: draft.retentionDays,
      notes: draft.notes,
    },
  };
}
