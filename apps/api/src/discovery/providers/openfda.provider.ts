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
import {
  OpenFdaEstablishment,
  OPENFDA_LICENSE,
  OPENFDA_ATTRIBUTION,
  FDA_REGISTRATION_DISCLAIMER,
} from '../../adapters/openfda-api';
import type { OpenFdaSearchInput, OpenFdaSearchOutput } from '../../tools/source-tools';
import type { ExecutionBroker } from '../../tools/tool-contract';
import { companyIdentity } from '../identity';

const PARSER_VERSION = 'openfda/v1';
const REG_QUERY_BASE = 'https://api.fda.gov/device/registrationlisting.json?search=registration.registration_number:';
const RECORD_CAP = 250; // 有界样本上限（绝不 grind 32 万——全量是 Schedule 增量的活）
const DEFAULT_LIMIT = 100;
// FDA registration_number 由 FDA 全局分配（**非**国别税号）→ scheme 不按国别限定（与 TED §8.4 国别税号不同）。
const FDA_ID_SCHEME = 'fda-reg';

/**
 * openFDA 器械注册发现 Provider（归 public_intelligence 类，复用 discovery→fit→enrich→score 全管线）。
 * `device/registrationlisting` establishment → 每个注册法人一条 canonical 线索。以 `registration.name`
 * + `iso_country_code` 为主解析键（多数记录无官网）；有 FDA 注册号则按 `fda-reg` 消歧（全局唯一）。
 *
 * 合规（spec §3）：只落 🟢 establishment/产品码/分类绿事实（CC0，署名非义务）；
 * 🔴 `us_agent.name`/`contact` 等具名个人**由 adapter 层剥离、绝不入本记录**（GDPR 隔离，走 contact 路径）。
 * 🔴 文案红线：`attributes.fda.disclaimer` 标注「注册≠核准」，绝不呈现为 FDA 认证/批准/背书。
 *
 * product code 过滤缺失时直接返回空（fail-safe）——ICP→FDA 产品码映射（P2）落地前，码由 filters 显式带入。
 */
export class OpenFdaDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'openfda';
  readonly classes: SourceClass[] = ['public_intelligence'];

  constructor(private readonly deps?: { broker?: ExecutionBroker }) {}

  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext, _opts?: DiscoveryOptions): Promise<DiscoveryResult> {
    const filters = query.filters ?? {};
    const productCodes = readProductCodes(filters);
    if (!productCodes.length) return { records: [], costCents: 0 }; // 无产品码 → 不启动（绝不裸拉全库）

    // §8.8 合规门（收口②：Broker 单点判定）：openfda.search 是 required 工具（registrationlisting
    // 可含具名 us_agent/contact）——SUSPENDED/未登记/用途不符/无 reader 一律 fail-closed。
    // 无 broker = 不允许直连（生产 registry 两处均注入）。
    if (!this.deps?.broker) {
       
      console.warn('[openfda] broker unavailable, fail-closed (no raw egress)');
      return { records: [], costCents: 0 };
    }

    let establishments: OpenFdaEstablishment[];
    try {
      const res = await this.deps.broker.invoke<OpenFdaSearchInput, OpenFdaSearchOutput>(
        'openfda.search',
        {
          kind: 'registration',
          params: {
            productCodes,
            isoCountry: readIsoCountry(filters),
            importerOnly: readImporterOnly(filters),
            establishmentTypes: readEstablishmentTypes(filters),
            limit: DEFAULT_LIMIT,
            maxRecords: Math.min(Math.max(query.limit ?? 50, 50), RECORD_CAP),
          },
        },
        { workspaceId: ctx.workspaceId, runId: ctx.runId, correlationId: ctx.correlationId },
      );
      establishments = res.data.establishments ?? [];
    } catch (err) {
      // fail-safe：单源失败/闸门拒绝不阻断其余源（CLAUDE.md §5）；拒绝原因已入 Broker DENIED trace
       
      console.warn(`[openfda] discover failed: ${String(err).slice(0, 150)}`);
      return { records: [], costCents: 0 };
    }

    const now = new Date().toISOString();
    const dedup = new Map<string, ProviderCompanyRecord>();
    for (const est of establishments) {
      const rec = mapEstablishmentToRecord(est, now);
      const key = companyIdentity({
        name: rec.name,
        country: rec.country,
        identifier: rec.identifier, // 无域名时按 FDA 注册号消歧
      }).dedupeKey;
      if (!dedup.has(key)) dedup.set(key, rec); // 先到优先
    }
    return { records: [...dedup.values()], costCents: 0 };
  }
}

/**
 * 一条 establishment → ProviderCompanyRecord（🟢 法人事实）。
 * 绝不写入 us_agent/contact 等 🔴 具名个人（adapter 已剥离）；标注「注册≠核准」文案红线。
 */
export function mapEstablishmentToRecord(est: OpenFdaEstablishment, now: string): ProviderCompanyRecord {
  const idValue = est.registrationNumber?.trim() || undefined; // 空串注册号当无（?? 不兜空串）
  const fda = prune({
    registration_number: idValue,
    fei_number: est.feiNumber,
    status_code: est.statusCode,
    city: est.city,
    state_code: est.stateCode,
    establishment_types: est.establishmentTypes.length ? est.establishmentTypes : undefined,
    initial_importer: est.initialImporter,
    product_codes: est.productCodes.length ? est.productCodes : undefined,
    device_facts: est.deviceFacts,
    owner_operator_numbers: est.ownerOperatorNumbers.length ? est.ownerOperatorNumbers : undefined, // 🟢 非个人 firm id（未来跨设施归并）
    created_date: est.createdDate,
    license: OPENFDA_LICENSE, // CC0-1.0（署名非义务）
    attribution: OPENFDA_ATTRIBUTION,
    disclaimer: FDA_REGISTRATION_DISCLAIMER, // 🔴 注册≠核准
  });
  // externalId 必须**每个 distinct establishment 唯一**（raw @@unique[runId,providerKey,externalId]）：
  // 无注册号时退 name+country（与 dedupeKey 同粒度）——绝不塌成 name-only，否则跨国同名互撞被 skipDuplicates 静默丢一个。
  const idKey = idValue ?? `${est.name}:${est.country ?? ''}`;
  return {
    externalId: `openfda:${idKey}`,
    name: est.name,
    country: est.country,
    industry: est.deviceFacts?.medicalSpecialtyDescription, // 匹配搜索码的专科 ≈ 行业维（便利，非硬编码）
    // fit 门只读 attributes.products（fit-judge.ts）→ 喂可读设备名（无则退产品码），否则 openFDA 线索在门前设备信号为空。
    attributes: { fda, products: est.deviceNames.length ? est.deviceNames : est.productCodes },
    // FDA 注册号全局唯一（非国别税号）→ scheme 不按国别限定。
    identifier: idValue ? { scheme: FDA_ID_SCHEME, value: idValue } : undefined,
    license: OPENFDA_LICENSE, // 写入 field_evidence.license（CC0，非硬编码 licensed）
    provenance: {
      sourceUrl: idValue ? `${REG_QUERY_BASE}${idValue}` : 'https://open.fda.gov/apis/device/registrationlisting/',
      fetchedAt: now,
      contentHash: createHash('sha256').update(`openfda:${idKey}:${est.name}`).digest('hex'),
      parserVersion: PARSER_VERSION,
    },
  };
}

// ── filters 读取（多别名容错；csv 或数组）────────────────────────────────
function readProductCodes(filters: Record<string, unknown>): string[] {
  return csvList(filters.product_code ?? filters.product_codes ?? filters._productCodes ?? filters.fda_product_code).map((c) => c.toUpperCase());
}
function readIsoCountry(filters: Record<string, unknown>): string | undefined {
  const v = csvList(filters.iso_country ?? filters.country ?? filters.registrant_country)[0];
  return v ? v.toUpperCase() : undefined;
}
function readImporterOnly(filters: Record<string, unknown>): boolean {
  const side = String(filters.trade_side ?? '').toLowerCase();
  return filters.importer_only === true || side === 'importer' || side === 'us_importer';
}
function readEstablishmentTypes(filters: Record<string, unknown>): string[] | undefined {
  const v = csvList(filters.establishment_type ?? filters.establishment_types);
  return v.length ? v : undefined;
}

function csvList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x) => x != null).map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}
function prune(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, val]) => val != null));
}
