import { createHash } from 'node:crypto';
import {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryResult,
  ExecutionContext,
  ProviderCompanyRecord,
  SourceClass,
} from '../provider-contract';
import type { TedAwardNotice } from '../../adapters/ted-api';
import type { TedSearchInput, TedSearchOutput } from '../../tools/source-tools';
import type { ExecutionBroker } from '../../tools/tool-contract';
import { companyIdentity, normalizeDomain } from '../identity';

const PARSER_VERSION = 'ted/v1';
const NOTICE_DETAIL_BASE = 'https://ted.europa.eu/en/notice/-/detail/';
// CC BY 4.0 / 2011/833/EU：绿事实可商用但**署名是 license 义务，不可省**（spec §3.1）。
const TED_ATTRIBUTION = 'Source: TED — © European Union; reused under CC BY 4.0';
const NOTICE_CAP = 250; // 有界样本上限（绝不 grind 全量；全量是 Schedule 增量蚕食的活）
const DEFAULT_SINCE_DAYS = 30;
const TED_LICENSE = 'CC BY 4.0'; // §8.5 写入 field_evidence.license（展示/法务 token；SPDX slug 'CC-BY-4.0' 见 attributes.ted.license）
const TED_ID_SCHEME = 'ted-natid'; // §8.4 国别税号/注册号命名空间（绝不与 lei 等其它 id 体系串号）

/**
 * TED 中标发现 Provider（归 public_intelligence 类，复用 discovery→fit→enrich→score 全管线）。
 * 中标公告 → 每个具名中标供应商一条 canonical 线索。以 winner-name + winner-identifier（税号）
 * 为主解析键；有 winner-internet-address 才做域名 key，否则退 name+country（识别未见 → 不臆造）。
 *
 * 合规：只落 🟢 公司/组织/CPV/日期绿事实（带 CC BY 4.0 provenance + 署名）；
 * winner-email 等 🔴 具名联系点**不进本记录**（个人数据隔离，走后续 contact-persist 路径）。
 *
 * CPV 过滤缺失时直接返回空（fail-safe）——ICP→CPV 映射（P2）落地前，CPV 由 filters 显式带入。
 */
export class TedDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'ted';
  readonly classes: SourceClass[] = ['public_intelligence'];

  constructor(private readonly deps?: { broker?: ExecutionBroker }) {}

  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext, opts?: DiscoveryOptions): Promise<DiscoveryResult> {
    const filters = query.filters ?? {};
    const cpvCodes = readCpvCodes(filters);
    if (!cpvCodes.length) return { records: [], costCents: 0 }; // 无 CPV → 不启动（绝不裸拉全库）

    // §8.8 合规门（收口②：Broker 单点判定）：ted.search 是 required 工具——SUSPENDED/未登记/
    // 用途不符/无 reader 一律 fail-closed。无 broker = 不允许直连（生产 registry 两处均注入）。
    if (!this.deps?.broker) {
       
      console.warn('[ted] broker unavailable, fail-closed (no raw egress)');
      return { records: [], costCents: 0 };
    }

    let notices: TedAwardNotice[];
    try {
      const res = await this.deps.broker.invoke<TedSearchInput, TedSearchOutput>(
        'ted.search',
        {
          kind: 'award',
          params: {
            cpvCodes,
            buyerCountries: readBuyerCountries(filters),
            sinceDays: readSinceDays(filters),
            maxRecords: Math.min(Math.max(query.limit ?? 25, 50), NOTICE_CAP),
          },
        },
        { workspaceId: ctx.workspaceId, runId: ctx.runId, correlationId: ctx.correlationId },
      );
      notices = res.data.awards ?? [];
    } catch (err) {
      // fail-safe：单源失败/闸门拒绝不阻断其余源（CLAUDE.md §5）；拒绝原因已入 Broker DENIED trace
       
      console.warn(`[ted] discover failed: ${String(err).slice(0, 150)}`);
      return { records: [], costCents: 0 };
    }

    const blocked = new Set((opts?.blockedDomains ?? []).map((d) => d.toLowerCase()));
    const now = new Date().toISOString();
    const dedup = new Map<string, ProviderCompanyRecord>();
    for (const notice of notices) {
      for (const rec of mapNoticeToRecords(notice, now)) {
        if (rec.domain && blocked.has(rec.domain)) continue;
        const key = companyIdentity({
          name: rec.name,
          domain: rec.domain,
          country: rec.country,
          identifier: rec.identifier, // §8.4：无域名时按税号消歧
        }).dedupeKey;
        if (!dedup.has(key)) dedup.set(key, rec); // 先到优先（SORT DESC → 最新在前）
      }
    }
    return { records: [...dedup.values()], costCents: 0 };
  }

}

/**
 * 一条中标公告 → 每个中标方一条 ProviderCompanyRecord（🟢 公司/组织事实）。
 * 绝不写入 winner-email 等 🔴 具名联系点（个人数据隔离）。
 */
export function mapNoticeToRecords(notice: TedAwardNotice, now: string): ProviderCompanyRecord[] {
  return notice.winners
    .filter((w) => w.name.trim())
    .map((w, i) => {
      const domain = w.internetAddress ? normalizeDomain(w.internetAddress) ?? undefined : undefined;
      const ted = prune({
        publication_number: notice.publicationNumber,
        publication_date: notice.publicationDate,
        notice_type: notice.noticeType,
        cpv: notice.cpvCodes.length ? notice.cpvCodes : undefined,
        buyer_names: notice.buyerNames.length ? notice.buyerNames : undefined,
        buyer_countries: notice.buyerCountries.length ? notice.buyerCountries : undefined,
        winner_identifier: w.identifier,
        winner_city: w.city,
        license: 'CC-BY-4.0',
        attribution: TED_ATTRIBUTION,
      });
      const idValue = w.identifier?.trim();
      const country = toAlpha2(w.country); // §8.3：ISO-3(DEU)→alpha-2(DE)，复用于国别字段 + §8.4 id scheme 国别限定
      return {
        externalId: `ted:${notice.publicationNumber ?? 'na'}:${i}`,
        name: w.name.trim(),
        domain,
        country,
        // §8.4：winner-identifier 是**国别**税号/注册号（仅国内唯一）→ scheme 按国别限定，防不同国
        // 同号的不同法人跨境误并（审查修正 · 绝不贴错身份）；无国别时退回裸 scheme（罕见）。
        identifier: idValue
          ? { scheme: country ? `${TED_ID_SCHEME}:${country.toLowerCase()}` : TED_ID_SCHEME, value: idValue }
          : undefined,
        license: TED_LICENSE, // §8.5 绿事实 CC BY 4.0 署名义务（写入 field_evidence.license）
        attributes: { ted },
        provenance: {
          sourceUrl: notice.publicationNumber ? `${NOTICE_DETAIL_BASE}${notice.publicationNumber}` : NOTICE_DETAIL_BASE,
          fetchedAt: now,
          contentHash: createHash('sha256')
            .update(`ted:${notice.publicationNumber ?? ''}:${w.name}:${w.identifier ?? ''}`)
            .digest('hex'),
          parserVersion: PARSER_VERSION,
        },
      };
    });
}

function readCpvCodes(filters: Record<string, unknown>): string[] {
  return csvList(filters.cpv ?? filters._cpvCodes ?? filters.classification_cpv);
}

function readBuyerCountries(filters: Record<string, unknown>): string[] {
  return csvList(filters.buyer_country ?? filters.buyer_countries ?? filters._buyerCountries).map((c) =>
    c.toUpperCase(),
  );
}

function readSinceDays(filters: Record<string, unknown>): number {
  const v = Number(filters.since_days ?? filters.sinceDays);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_SINCE_DAYS;
}

/** 逗号串或数组 → 去空 trim 后的字符串数组。 */
function csvList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x) => x != null).map((x) => String(x).trim()).filter(Boolean);
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function prune(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, val]) => val != null));
}

/**
 * §8.3 国别码归一：TED `winner-country` 是 ISO-3（DEU），canonical/identity.ts dedupeKey 用 alpha-2（DE，
 * 镜像 country seed 的 `cca2`）。不转 → 同一德国公司经 TED(`n:x:deu`) vs GLEIF/Wikidata(`n:x:de`) 裂成两 key，
 * 且国别资格规则漏判。此处按 ISO 3166 标准（= country 节点 crosswalks.alpha3 的同一映射）转齐；
 * 覆盖 TED 买方覆盖集（§2.4 EU/EEA/UK）+ 常见中标方来源国。未收录码保留原值（best-effort，不静默出错）。
 */
const TED_ISO3_TO_ISO2: Record<string, string> = {
  AUT: 'AT', BEL: 'BE', BGR: 'BG', CHE: 'CH', CYP: 'CY', CZE: 'CZ', DEU: 'DE', DNK: 'DK',
  ESP: 'ES', EST: 'EE', FIN: 'FI', FRA: 'FR', GBR: 'GB', GRC: 'GR', HRV: 'HR', HUN: 'HU',
  IRL: 'IE', ISL: 'IS', ITA: 'IT', LIE: 'LI', LTU: 'LT', LUX: 'LU', LVA: 'LV', MLT: 'MT',
  NLD: 'NL', NOR: 'NO', POL: 'PL', PRT: 'PT', ROU: 'RO', SVK: 'SK', SVN: 'SI', SWE: 'SE',
  // 常见非欧盟中标方来源
  USA: 'US', CHN: 'CN', JPN: 'JP', KOR: 'KR', TUR: 'TR', IND: 'IN', CAN: 'CA', AUS: 'AU',
  BRA: 'BR', RUS: 'RU', UKR: 'UA', SRB: 'RS', ISR: 'IL',
};

/** ISO-3 → alpha-2（未收录保留原值）。空/无值透传。 */
export function toAlpha2(iso3?: string): string | undefined {
  if (!iso3) return iso3;
  return TED_ISO3_TO_ISO2[iso3.toUpperCase()] ?? iso3;
}
