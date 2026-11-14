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
import { ToolDurableResultProjectionError } from '../../tools/tool-broker';
import { companyIdentity, normalizeDomain } from '../identity';
import { BudgetOperationReplayError } from '../../tools/budget-store';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  buildDiscoveryCompanyResultLineage,
  createDiscoveryCompanyReceiptCollector,
  isDiscoveryCompanyLineageInvalid,
} from '../company-discovery-lineage';

const PARSER_VERSION = 'ted/v1';
const NOTICE_DETAIL_BASE = 'https://ted.europa.eu/en/notice/-/detail/';
// CC BY 4.0 / 2011/833/EU：绿事实可商用但**署名是 license 义务，不可省**（spec §3.1）。
const TED_ATTRIBUTION = 'Source: TED — © European Union; reused under CC BY 4.0';
/** 持久投影 ted-search/v1 的 awards 数上限（超出即整包 TOOL_DURABLE_RESULT_PROJECTION_REJECTED）。 */
const TED_DURABLE_AWARDS_MAX = 32;
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
  readonly companyResultLineage = DISCOVERY_COMPANY_RESULT_LINEAGE_V1;

  constructor(private readonly deps?: { broker?: ExecutionBroker }) {}

  private emptyLineage(): DiscoveryResult {
    return {
      records: [],
      costCents: 0,
      lineage: buildDiscoveryCompanyResultLineage({
        providerKey: 'ted',
        recordCount: 0,
        observations: [],
      }),
    };
  }

  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext, opts?: DiscoveryOptions,
  ): Promise<DiscoveryResult> {
    const filters = query.filters ?? {};
    const cpvCodes = readCpvCodes(filters);
    if (!cpvCodes.length) return this.emptyLineage(); // 无 CPV → 不启动（绝不裸拉全库）

    // §8.8 合规门（收口②：Broker 单点判定）：ted.search 是 required 工具——SUSPENDED/未登记/
    // 用途不符/无 reader 一律 fail-closed。无 broker = 不允许直连（生产 registry 两处均注入）。
    if (!this.deps?.broker) {

      console.warn('[ted] broker unavailable, fail-closed (no raw egress)');
      return this.emptyLineage();
    }

    const collector = createDiscoveryCompanyReceiptCollector({
      providerKey: 'ted',
      producerId: 'ted.search',
      parentOnDurableReceipt: ctx.onDurableReceipt,
    });
    collector.markExpectedInvocation();
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
            // 持久投影 ted-search/v1 的 awards 上限 32，且整包还要过 120 KiB 聚合门——
            // 请求 50/250 条只会让整包被投影拒绝（2026-11-10 run 97a4fa1b：
            // TOOL_DURABLE_RESULT_PROJECTION_REJECTED，ted 恒 0 条）。请求量必须落在
            // 持久契约内；把契约上调（更多 awards/查询）是平台级改动，另行评审。
            maxRecords: Math.min(query.limit ?? 25, TED_DURABLE_AWARDS_MAX),
          },
        },
        // purpose='discovery'：用途门按本次调用用途判（域策略去掉 discovery 即拦本路径）
        { ...ctx, onDurableReceipt: collector.onDurableReceipt, purpose: 'discovery' },
      );
      notices = res.data.awards ?? [];
    } catch (err) {
      if (collector.isForwardingFailure(err) || isDiscoveryCompanyLineageInvalid(err)) {
        throw err;
      }
      if (err instanceof BudgetOperationReplayError) throw err;
      // 结算失败但无回执（投影拒绝）可证明未产生公司记录：记 failed，血缘仍有效。
      if (err instanceof ToolDurableResultProjectionError) collector.markInvocationFailed();
      // fail-safe：单源失败/闸门拒绝不阻断其余源（AGENTS.md §5）；拒绝原因已入 Broker DENIED trace

      console.warn(`[ted] discover failed: ${String(err).slice(0, 150)}`);
      const observation = collector.finish([]);
      return {
        records: [],
        costCents: 0,
        lineage: buildDiscoveryCompanyResultLineage({
          providerKey: 'ted',
          recordCount: 0,
          observations: [observation],
        }),
      };
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
    const records = [...dedup.values()];
    const observation = collector.finish(records.map((_, index) => index));
    const lineage = buildDiscoveryCompanyResultLineage({
      providerKey: 'ted',
      recordCount: records.length,
      observations: [observation],
    });
    return { records, costCents: 0, ...(lineage ? { lineage } : {}) };
  }
}

/** raw-source 契约的数组上限（tokenArray/容器守卫均 20）：去重后截断，超限整条会被拒收。 */
const TED_ARRAY_CAP = 20;
/** TED 名称里的排版标点换成 ASCII 等价（STRUCTURED_TOKEN 不收 ’ – —）。 */
const TED_NAME_PUNCTUATION: ReadonlyArray<readonly [RegExp, string]> = [
  [/[’‘“”"]/gu, "'"],
  [/[–—]/gu, '-'],
  [/\p{Cc}/gu, ' '],
];

export function normalizeTedCompanyName(raw: string): string {
  let name = raw.trim();
  for (const [pattern, replacement] of TED_NAME_PUNCTUATION) name = name.replace(pattern, replacement);
  name = name.replace(/\s+/gu, ' ').trim();
  // raw schema 的公司名上限 16 词：超长联合体名（多个中标成员拼接）按词截断，保留领衔方。
  const words = name.split(' ');
  return words.length > 16 ? words.slice(0, 16).join(' ') : name;
}

/**
 * 只有形如标识符的值才进 identifier / attributes.ted.winner_identifier：TED 的
 * winner-identifier 有时是整句联合体描述（「ATI Geko S.p.A. (mandataria), …」），
 * 那既不是标识符也会被 raw schema 拒收。纯数字国家税号原样保留（schema 对 ted 放行）。
 */
function tedIdentifier(raw?: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  return /^[\p{L}\p{N}][\p{L}\p{N} ._:/-]{0,79}$/u.test(value) ? value : undefined;
}

function dedupeCapped(values: readonly string[]): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= TED_ARRAY_CAP) break;
  }
  return out.length ? out : undefined;
}

/**
 * 一条中标公告 → 每个中标方一条 ProviderCompanyRecord（🟢 公司/组织事实）。
 * 绝不写入 winner-email 等 🔴 具名联系点（个人数据隔离）。
 */
export function mapNoticeToRecords(notice: TedAwardNotice, now: string): ProviderCompanyRecord[] {
  const cpv = dedupeCapped(notice.cpvCodes);
  const buyerCountries = dedupeCapped(notice.buyerCountries);
  // §8.3 关系结构（PR-03b）：TED 记录主体是**中标方**，买方只以事实字段存在。
  // 显式写出 buyer/winner 关系与 self_role，下游才能判断「这家公司是买方还是供方」，
  // 不再把中标方默认当买家。buyer_countries 保留源始 alpha-3；关系里给 alpha-2。
  const buyerRelationships = notice.buyerNames.map((name, idx) => {
    const iso2 = toAlpha2(notice.buyerCountries[idx]);
    return prune({ role: 'buyer', name: name.trim(), country: iso2 });
  });
  const winnerRelationships = notice.winners
    .filter((w) => w.name.trim())
    .map((w) =>
      prune({
        role: 'winner',
        name: normalizeTedCompanyName(w.name),
        country: toAlpha2(w.country),
        identifier: tedIdentifier(w.identifier),
      }),
    );
  return notice.winners
    .filter((w) => w.name.trim())
    .map((w, i) => {
      const domain = w.internetAddress ? (normalizeDomain(w.internetAddress) ?? undefined) : undefined;
      const ted = prune({
        publication_number: notice.publicationNumber,
        publication_date: notice.publicationDate,
        notice_type: notice.noticeType,
        cpv,
        buyer_names: notice.buyerNames.length ? notice.buyerNames : undefined,
        buyer_countries: buyerCountries,
        winner_identifier: tedIdentifier(w.identifier),
        winner_city: w.city,
        self_role: 'winner',
        relationships: [...buyerRelationships, ...winnerRelationships],
        license: 'CC-BY-4.0',
        attribution: TED_ATTRIBUTION,
      });
      const idValue = tedIdentifier(w.identifier);
      const country = toAlpha2(w.country); // §8.3：ISO-3(DEU)→alpha-2(DE)，复用于国别字段 + §8.4 id scheme 国别限定
      return {
        externalId: `ted:${notice.publicationNumber ?? 'na'}:${i}`,
        name: normalizeTedCompanyName(w.name),
        domain,
        country,
        // §8.4：winner-identifier 是**国别**税号/注册号（仅国内唯一）→ scheme 按国别限定，防不同国
        // 同号的不同法人跨境误并（审查修正 · 绝不贴错身份）；无国别时退回裸 scheme（罕见）。
        identifier: idValue
          ? {
              scheme: country ? `${TED_ID_SCHEME}:${country.toLowerCase()}` : TED_ID_SCHEME,
              value: idValue,
            }
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
  if (Array.isArray(v))
    return v
      .filter((x) => x != null)
      .map((x) => String(x).trim())
      .filter(Boolean);
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
  AUT: 'AT',
  BEL: 'BE',
  BGR: 'BG',
  CHE: 'CH',
  CYP: 'CY',
  CZE: 'CZ',
  DEU: 'DE',
  DNK: 'DK',
  ESP: 'ES',
  EST: 'EE',
  FIN: 'FI',
  FRA: 'FR',
  GBR: 'GB',
  GRC: 'GR',
  HRV: 'HR',
  HUN: 'HU',
  IRL: 'IE',
  ISL: 'IS',
  ITA: 'IT',
  LIE: 'LI',
  LTU: 'LT',
  LUX: 'LU',
  LVA: 'LV',
  MLT: 'MT',
  NLD: 'NL',
  NOR: 'NO',
  POL: 'PL',
  PRT: 'PT',
  ROU: 'RO',
  SVK: 'SK',
  SVN: 'SI',
  SWE: 'SE',
  // 常见非欧盟中标方来源
  USA: 'US',
  CHN: 'CN',
  JPN: 'JP',
  KOR: 'KR',
  TUR: 'TR',
  IND: 'IN',
  CAN: 'CA',
  AUS: 'AU',
  BRA: 'BR',
  RUS: 'RU',
  UKR: 'UA',
  SRB: 'RS',
  ISR: 'IL',
};

/** ISO-3 → alpha-2（未收录保留原值）。空/无值透传。 */
export function toAlpha2(iso3?: string): string | undefined {
  if (!iso3) return iso3;
  return TED_ISO3_TO_ISO2[iso3.toUpperCase()] ?? iso3;
}
