/**
 * 证据包 v1（2026-11-10，多源证据图核心切片 ②；当晚口径：直接 enforce，无影子期）。
 *
 * 背景：官网理解单源（website_profile）+ 富集结果各源各写 attributes.<provider>，
 * 没有任何「跨源分层视图」。本模块把已存属性里的证据（零出网）与按需实时探测的
 * 富集 provider（经 ToolBroker，按 data_provider ENABLED 可用性）装配成一份分层证据包：
 *
 *   T1 = 官方注册/招投标/专利（gleif / ted / fda / companies_house / inpi_rne / google_patents / samgov）
 *   T2 = 聚合与二手（wikidata）
 *   T3 = 官网/技术足迹/结构化收割（website_profile / digital_footprint / structured_harvest）
 *
 * **enforce 语义**：判定链在 FIT/NOT_FIT 落地前现场装配/读取本包并交给跨源佐证门
 * （judgment/corroboration.ts）：低于 2 个独立分层的结论按 fail-closed 降级 UNKNOWN
 * （可回滚：JUDGE_CORROBORATION_MODE=shadow/off）。判定事务内把包写回
 * `canonical_company.attributes.evidence_bundle` 供审计与离线复核。
 *
 * 落库形状对 sanitizeCanonicalCompanyAttributes 友好（该 sanitizer 会在下次公司合并时
 * 清洗 attributes）：facts 的键避开 SEMANTIC_IDENTIFIER/CONTACT 键名黑名单，字符串值
 * 预过滤 `isContactFreeText`（≥7 位连续数字的电话形态会被丢弃——长数字标识改存 number
 * 或拆分，如 TED 公告号存 notice_id/notice_year、CPV 存去尾零前缀）。
 */
import { currentManufacturerEvidence, type ManufacturerNetworkEvidence } from './manufacturer-network-evidence';
import type {
  CompanyEnrichmentAdapter,
  CompanyEnrichmentInput,
  EnrichmentResult,
  ExecutionContext,
} from './provider-contract';
import { isContactFreeText } from './raw-source-provider-normalizer';

export type EvidenceTier = 'T1' | 'T2' | 'T3';

export const EVIDENCE_TIERS: readonly EvidenceTier[] = Object.freeze(['T1', 'T2', 'T3']);

/** 属性域 → 分层。未列出的域不进入证据包（搜索摘要 T4 尚无持久化面）。 */
const SOURCE_TIERS: Readonly<Record<string, EvidenceTier>> = Object.freeze({
  gleif: 'T1',
  vies: 'T1',
  ted: 'T1',
  fda: 'T1',
  companies_house: 'T1',
  inpi_rne: 'T1',
  google_patents: 'T1',
  samgov: 'T1',
  wikidata: 'T2',
  website_profile: 'T3',
  digital_footprint: 'T3',
  structured_harvest: 'T3',
});

const SOURCE_KINDS: Readonly<Record<string, string>> = Object.freeze({
  gleif: 'legal_identity',
  vies: 'vat_registry',
  ted: 'procurement',
  fda: 'device_registration',
  companies_house: 'registry_entry',
  inpi_rne: 'registry_entry',
  google_patents: 'patent',
  samgov: 'procurement',
  wikidata: 'industry_graph',
  website_profile: 'website',
  digital_footprint: 'tech_footprint',
  structured_harvest: 'structured_harvest',
});

export type EvidenceFactValue = string | number | boolean | string[] | number[];

export interface EvidenceBundleEntry {
  tier: EvidenceTier;
  source_key: string;
  evidence_kind: string;
  source_page?: string;
  captured_at?: string;
  confidence?: number;
  facts: Record<string, EvidenceFactValue>;
}

export interface EvidenceCoverage {
  tiers: Record<EvidenceTier, number>;
  tier_list: EvidenceTier[];
  distinct_sources: number;
  /** ≥2 个独立分层即视为跨源佐证（corroboration 门的输入口径）。 */
  corroborated: boolean;
}

export interface EvidenceBundle {
  version: 1;
  built_at: string;
  subject: { name: string; domain: string | null; country: string | null };
  entries: EvidenceBundleEntry[];
  coverage: EvidenceCoverage;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 字符串值的落库前过滤（与 sanitizer 同谓词）：电话/密钥形态丢弃，长度有界。 */
function safeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1_024) return undefined;
  return isContactFreeText(trimmed) ? trimmed : undefined;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return safeString(url.toString());
  } catch {
    return undefined;
  }
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numericString(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^\d{1,16}$/u.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

function safeBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringList(value: unknown, max = 8): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => safeString(item))
    .filter((item): item is string => item !== undefined)
    .slice(0, max);
  return items.length ? items : undefined;
}

/** TED 公告号 "727192-2026" → {notice_id: 727192, notice_year: 2026}（字符串形态会被电话过滤丢弃）。 */
function splitNoticeNumber(value: unknown): { notice_id?: number; notice_year?: number } {
  if (typeof value !== 'string') return {};
  const match = /^(\d{1,9})-(\d{4})$/u.exec(value.trim());
  if (!match) return {};
  return { notice_id: Number.parseInt(match[1]!, 10), notice_year: Number.parseInt(match[2]!, 10) };
}

/** CPV 前缀（去尾零，≤6 位数字，绕开 sanitizer 的电话形态过滤）——正是 NACE 交叉用的子树锚。 */
function cpvPrefixes(value: unknown, max = 8): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const prefixes = value
    .filter((item): item is string => typeof item === 'string' && /^\d{8}$/u.test(item))
    .map((code) => Number.parseInt(code.replace(/0+$/u, '') || '0', 10))
    .filter((prefix) => Number.isInteger(prefix) && prefix > 0);
  const unique = [...new Set(prefixes)].slice(0, max);
  return unique.length ? unique : undefined;
}

function compact(facts: Record<string, EvidenceFactValue | undefined>): Record<string, EvidenceFactValue> {
  return Object.fromEntries(
    Object.entries(facts).filter(([, value]) => value !== undefined),
  ) as Record<string, EvidenceFactValue>;
}

function finish(sourceKey: string, entry: Omit<EvidenceBundleEntry, 'tier' | 'source_key' | 'evidence_kind'>): EvidenceBundleEntry | null {
  const tier = SOURCE_TIERS[sourceKey];
  if (!tier) return null;
  if (Object.keys(entry.facts).length === 0 && entry.source_page === undefined) return null;
  return {
    tier,
    source_key: sourceKey,
    evidence_kind: SOURCE_KINDS[sourceKey]!,
    ...(entry.source_page !== undefined ? { source_page: entry.source_page } : {}),
    ...(entry.captured_at !== undefined ? { captured_at: entry.captured_at } : {}),
    ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
    facts: entry.facts,
  };
}

/** 单源抽取器：把 attributes.<source> 命名空间映射为键白名单内的事实（键避开 sanitizer 黑名单）。 */
interface ExtractedEntry {
  source_page?: string;
  captured_at?: string;
  confidence?: number;
  facts: Record<string, EvidenceFactValue | undefined>;
}

const SOURCE_EXTRACTORS: Readonly<Record<string, (source: Record<string, unknown>) => ExtractedEntry>> =
  Object.freeze({
    gleif: (source) => ({
      source_page:
        typeof source.lei === 'string' && source.lei.length > 0
          ? safeUrl(`https://search.gleif.org/#/record/${source.lei}`)
          : undefined,
      captured_at: safeString(source._ts),
      confidence: safeNumber(source.match_confidence),
      facts: {
        legal_name: safeString(source.legal_name),
        legal_form: safeString(source.legal_form),
        entity_status: safeString(source.entity_status),
        registration_status: safeString(source.registration_status),
        registered_country: safeString(source.registered_country),
        registered_city: safeString(source.registered_city),
        registry_lei: safeString(source.lei),
        is_subsidiary: safeBool(source.is_subsidiary),
        parent_name: safeString(source.parent_name),
        ultimate_parent_name: safeString(source.ultimate_parent_name),
      },
    }),
    vies: (source) => ({
      source_page: 'https://ec.europa.eu/taxation_customs/vies/',
      captured_at: safeString(source._ts),
      confidence: safeNumber(source.match_confidence),
      facts: {
        legal_name: safeString(source.legal_name),
        registered_country: safeString(source.registered_country),
        registered_city: safeString(source.registered_city),
        verified_status: safeString(source.verified_status),
      },
    }),
    ted: (source) => ({
      facts: {
        notice_type: safeString(source.notice_type),
        buyer_countries: stringList(source.buyer_countries),
        cpv_prefixes: cpvPrefixes(source.cpv),
        ...splitNoticeNumber(source.publication_number),
      },
    }),
    fda: (source) => ({
      facts: {
        fei_no: numericString(source.fei_number),
        registration_no: numericString(source.registration_number),
        state_code: safeString(source.state_code),
        status_code: safeString(source.status_code),
        product_codes: stringList(source.product_codes),
      },
    }),
    companies_house: (source) => {
      const rawNo = typeof source.company_number === 'string' ? source.company_number.trim().toUpperCase() : '';
      const validNo = /^[A-Z0-9]{1,12}$/u.test(rawNo) ? rawNo : undefined;
      // 8 位纯数字注册号会被 isContactFreeText 视作电话形态；数字型转 number，字母前缀保留 string。
      const companyNoFact = validNo
        ? /^\d+$/u.test(validNo)
          ? numericString(validNo)
          : safeString(validNo)
        : undefined;
      return {
        source_page: validNo
          ? (safeUrl(`https://find-and-update.company-information.service.gov.uk/company/${validNo}`) ??
            'https://find-and-update.company-information.service.gov.uk/')
          : undefined,
        captured_at: safeString(source._ts),
        confidence: safeNumber(source.match_confidence),
        facts: {
          registry_company_no: companyNoFact,
          company_status: safeString(source.company_status),
          company_type: safeString(source.company_type),
          jurisdiction: safeString(source.jurisdiction),
          sic_codes: stringList(source.sic_codes),
          incorporation_year: numericString(source.incorporation_year),
        },
      };
    },
    inpi_rne: (source) => {
      const sirenNum = numericString(source.siren);
      return {
        source_page: sirenNum
          ? (safeUrl(`https://annuaire-entreprises.data.gouv.fr/entreprise/${sirenNum}`) ??
            'https://annuaire-entreprises.data.gouv.fr/')
          : undefined,
        captured_at: safeString(source._ts),
        confidence: safeNumber(source.match_confidence),
        facts: {
          registry_siren: sirenNum,
          legal_name: safeString(source.legal_name ?? source.denomination),
          legal_nature: safeString(source.legal_nature ?? source.nature_juridique),
          naf_code: safeString(source.naf_code ?? source.activite_principale),
          entity_status: safeString(source.entity_status ?? source.etat_administratif),
          registered_city: safeString(source.registered_city),
        },
      };
    },
    google_patents: (source) => ({
      source_page: safeUrl(source.source_page) ?? 'https://patents.google.com/',
      captured_at: safeString(source._ts),
      confidence: safeNumber(source.match_confidence),
      facts: {
        applicant_name: safeString(source.applicant_name),
        patent_count: numericString(source.patent_count),
        recent_patent_count: numericString(source.recent_patent_count),
        cpc_codes: stringList(source.cpc_codes),
        ipc_codes: stringList(source.ipc_codes),
        latest_filing_year: numericString(source.latest_filing_year),
      },
    }),
    samgov: (source) => ({
      source_page: safeUrl(source.source_page) ?? 'https://sam.gov/',
      captured_at: safeString(source._ts),
      confidence: safeNumber(source.match_confidence),
      facts: {
        market_signal: safeBool(source.market_signal),
        government_buyer: safeBool(source.government_buyer),
        agency: safeString(source.agency),
        notice_count: numericString(source.notice_count),
        naics_codes: stringList(source.naics_codes ?? source.naics),
        set_aside: safeString(source.set_aside),
        latest_notice_date: safeString(source.latest_notice_date),
      },
    }),
    wikidata: (source) => {
      const qid = safeString(source.qid);
      return {
        source_page: qid ? safeUrl(`https://www.wikidata.org/wiki/${qid}`) : undefined,
        confidence: safeNumber(source.match_confidence),
        facts: {
          entity_qid: qid,
          label: safeString(source.label),
          industry_labels: stringList(source.industries),
          wikidata_products: stringList(source.products),
          employees: safeNumber(source.employees),
          inception_year: safeNumber(source.inception_year),
          country: safeString(source.country),
          headquarters: safeString(source.headquarters),
          parent_name: safeString(source.parent_name),
          stock_exchange: safeString(source.stock_exchange),
        },
      };
    },
    website_profile: (source) => ({
      source_page: safeUrl(source.source_url),
      captured_at: safeString(source._ts),
      confidence: safeNumber(source.trade_role_confidence),
      facts: {
        trade_role: safeString(source.trade_role),
        trade_role_source: safeString(source.trade_role_source),
        own_manufacturing: safeBool(source.own_manufacturing),
        carries_chinese_brand: safeBool(source.carries_chinese_brand),
        carries_foreign_brand: safeBool(source.carries_foreign_brand),
      },
    }),
    digital_footprint: (source) => ({
      facts: {
        tech_platform: safeString(source.tech_platform),
        served_langs: stringList(source.served_langs),
        served_markets: stringList(source.served_markets),
        is_advertiser: safeBool(source.is_advertiser),
        hiring_signal: safeBool(source.hiring_signal),
      },
    }),
    structured_harvest: (source) => ({
      source_page: safeUrl(source.careers_url),
      facts: {
        sitemap_url_count: safeNumber(source.sitemap_url_count),
      },
    }),
  });

/** 属性域事实的键白名单（键名避开 sanitizer 的 SEMANTIC_IDENTIFIER/CONTACT 黑名单）。 */
function storedSourceEntry(sourceKey: string, raw: unknown): EvidenceBundleEntry | null {
  const source = jsonObject(raw);
  const extractor = SOURCE_EXTRACTORS[sourceKey];
  if (!source || !extractor) return null;
  const { facts, ...rest } = extractor(source);
  return finish(sourceKey, { ...rest, facts: compact(facts) });
}

/** 从 intent.events 中抽取 SAM.gov 公开采购事实，补齐仅写 sam_market_signal/intent.events 的记录。 */
function samgovAttributesFromRoot(root: Record<string, unknown>): Record<string, unknown> | null {
  const explicit = jsonObject(root.samgov);
  if (explicit) return explicit;
  const intent = jsonObject(root.intent);
  const events = Array.isArray(intent?.events) ? intent.events : [];
  const samEvents = events.filter((event) => {
    const obj = jsonObject(event);
    const ev = jsonObject(obj?.evidence);
    return ev?.source === 'samgov';
  });
  if (root.sam_market_signal !== true && samEvents.length === 0) return null;
  const naics: string[] = [];
  for (const event of samEvents) {
    const ev = jsonObject(jsonObject(event)?.evidence);
    if (Array.isArray(ev?.naics)) {
      for (const code of ev.naics) {
        if (typeof code === 'string') naics.push(code);
      }
    }
  }
  return {
    ...(root.sam_market_signal === true ? { market_signal: true } : {}),
    ...(root.government_buyer === true ? { government_buyer: true } : {}),
    ...(samEvents.length > 0 ? { notice_count: samEvents.length } : {}),
    ...(naics.length > 0 ? { naics_codes: [...new Set(naics)] } : {}),
  };
}

/**
 * 零出网装配：从已存 canonical attributes 生成证据条目。
 * 兼容 attributes.wikidata_qid（早期只存 QID 形态）、attributes.ch_registry（Companies House 注册表）
 * 以及 attributes.sam_market_signal / intent.events(source=samgov)。
 */
export function entriesFromStoredAttributes(attributes: unknown): EvidenceBundleEntry[] {
  const root = jsonObject(attributes);
  if (!root) return [];
  const entries: EvidenceBundleEntry[] = [];
  for (const sourceKey of Object.keys(SOURCE_TIERS)) {
    if (sourceKey === 'wikidata') continue; // 先处理完整命名空间，再回退 QID
    const raw =
      sourceKey === 'companies_house'
        ? (root.companies_house ?? root.ch_registry)
        : sourceKey === 'samgov'
          ? samgovAttributesFromRoot(root)
          : root[sourceKey];
    const entry = storedSourceEntry(sourceKey, raw);
    if (entry) entries.push(entry);
  }
  const wikidataEntry = storedSourceEntry('wikidata', root.wikidata);
  const bareQid = safeString(root.wikidata_qid);
  if (wikidataEntry) {
    entries.push(wikidataEntry);
  } else if (bareQid) {
    entries.push({
      tier: 'T2',
      source_key: 'wikidata',
      evidence_kind: 'industry_graph',
      source_page: `https://www.wikidata.org/wiki/${bareQid}`,
      facts: { entity_qid: bareQid },
    });
  }
  return entries;
}

/** 实时富集结果 → 证据条目（source_key = enricher.key，只收 SOURCE_TIERS 里的域）。 */
export function entryFromEnrichment(sourceKey: string, result: EnrichmentResult): EvidenceBundleEntry | null {
  if (!result.matched) return null;
  const base = storedSourceEntry(sourceKey, result.attributes);
  if (!base) return null;
  return {
    ...base,
    source_page: safeUrl(result.provenance?.sourceUrl) ?? base.source_page,
    captured_at: safeString(result.provenance?.fetchedAt) ?? base.captured_at,
    confidence: Number.isFinite(result.confidence) ? result.confidence : base.confidence,
  };
}

/** 纯装配：条目 → 包（覆盖率按分层计数；corroborated = ≥2 个不同分层）。 */
export function assembleEvidenceBundle(
  subject: { name: string; domain?: string | null; country?: string | null },
  entries: readonly EvidenceBundleEntry[],
  builtAt: Date = new Date(),
): EvidenceBundle {
  const tiers: Record<EvidenceTier, number> = { T1: 0, T2: 0, T3: 0 };
  for (const entry of entries) tiers[entry.tier] += 1;
  const tierList = EVIDENCE_TIERS.filter((tier) => tiers[tier] > 0);
  const sources = new Set(entries.map((entry) => entry.source_key));
  return {
    version: 1,
    built_at: builtAt.toISOString(),
    subject: {
      name: subject.name,
      domain: subject.domain ?? null,
      country: subject.country ?? null,
    },
    entries: [...entries],
    coverage: {
      tiers,
      tier_list: tierList,
      distinct_sources: sources.size,
      corroborated: tierList.length >= 2,
    },
  };
}

/**
 * IO 驱动：已存属性装配 + 缺失域经注入的富集 provider 实时探测（provider 内部走
 * ToolBroker：source_policy/预算/限流/Trace 单点强制）。单源失败不致命（记为错过）。
 * 返回包 + 实时探测的域列表（报告用）。
 */
export async function buildEvidenceBundle(args: {
  subject: CompanyEnrichmentInput;
  attributes: unknown;
  enrichers: readonly CompanyEnrichmentAdapter[];
  ctx: ExecutionContext;
  now?: Date;
}): Promise<{ bundle: EvidenceBundle; probed: string[]; errors: Record<string, string> }> {
  const entries = entriesFromStoredAttributes(args.attributes);
  const present = new Set(entries.map((entry) => entry.source_key));
  const probed: string[] = [];
  const errors: Record<string, string> = {};
  for (const enricher of args.enrichers) {
    if (present.has(enricher.key) || !SOURCE_TIERS[enricher.key]) continue;
    probed.push(enricher.key);
    try {
      const result = await enricher.enrichCompany(args.subject, args.ctx);
      const entry = entryFromEnrichment(enricher.key, result);
      if (entry) entries.push(entry);
    } catch (error) {
      errors[enricher.key] = error instanceof Error ? error.message.slice(0, 160) : String(error);
    }
  }
  return { bundle: assembleEvidenceBundle(args.subject, entries, args.now ?? new Date()), probed, errors };
}

/** 判定快照用的跨源证据摘要（紧凑、有界；让模型看到 T1/T2/T3 证据而非仅官网文本）。 */
export interface CrossSourceEvidenceSummary {
  tier_list: EvidenceTier[];
  corroborated: boolean;
  sources: Array<{ tier: EvidenceTier; source_key: string; facts: string[] }>;
}

const MAX_SUMMARY_ENTRIES = 6;
const MAX_SUMMARY_FACTS = 10;

/** 从 canonical attributes 现场装配摘要（零出网）；无证据条目返回 null。 */
export function crossSourceEvidenceSummary(attributes: unknown): CrossSourceEvidenceSummary | null {
  const entries = entriesFromStoredAttributes(attributes);
  if (entries.length === 0) return null;
  const tiers = new Set(entries.map((entry) => entry.tier));
  return {
    tier_list: EVIDENCE_TIERS.filter((tier) => tiers.has(tier)),
    corroborated: tiers.size >= 2,
    sources: entries.slice(0, MAX_SUMMARY_ENTRIES).map((entry) => ({
      tier: entry.tier,
      source_key: entry.source_key,
      facts: Object.entries(entry.facts)
        .slice(0, MAX_SUMMARY_FACTS)
        .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('|') : String(value)}`),
    })),
  };
}

/** 判定用证据包：现场按当前属性装配（含本 run 刚写回的 website_profile / 富集结果）。 */
export function currentEvidenceBundle(company: {
  id?: string;
  manufacturerEvidence?: ManufacturerNetworkEvidence;
  name: string;
  domain: string | null;
  country: string | null;
  attributes: unknown;
}, now = new Date()): EvidenceBundle {
  const qualified = company.id ? currentManufacturerEvidence(company.manufacturerEvidence,{...company,id:company.id},now) : undefined;
  const entries = entriesFromStoredAttributes(company.attributes);
  if (qualified) entries.push({ tier:'T2',source_key:'manufacturer_network',evidence_kind:'manufacturer_relationship',source_page:qualified.sourceUrl,
    captured_at:qualified.fetchedAt,confidence:1,facts:{publisher:qualified.publisherId,relationship:qualified.relationship,country:qualified.country} });
  return assembleEvidenceBundle(
    { name: company.name, domain: company.domain, country: company.country },
    entries,
  );
}

/** attributes.evidence_bundle 的读侧校验（宽容：非法/缺字段按 null 处理，绝不 throw）。 */
export function readEvidenceBundle(attributes: unknown): EvidenceBundle | null {
  const root = jsonObject(attributes);
  const bundle = jsonObject(root?.evidence_bundle);
  if (!bundle || bundle.version !== 1) return null;
  if (!Array.isArray(bundle.entries) || !jsonObject(bundle.coverage)) return null;
  return bundle as unknown as EvidenceBundle;
}
