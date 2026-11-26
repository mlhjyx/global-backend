/**
 * 统一企业国别与法域解析中枢（Batch 1.5-A）。
 *
 * 解决现网实跑 run 607b314d 暴露的「41.8% 公司 country=NULL、58.2% 联系人归属空国别公司、
 * 导致德国 Centroplan GmbH 28 个具名员工静默漏排 GDPR Art.14」问题：
 *  1) 复用 `inferPrefilterCountry` 五级高置信信号（权威列 → GLEIF/VAT → 70+ 单国 ccTLD →
 *     28 类单国专属法定后缀如 S.r.l./S.p.A./B.V./GmbH & Co. KG → 60+ 国际电话区号）；
 *  2) 提供保守的 EU/UK 合规 Fail-Closed 兜底（仅当确定性解析仍为空，且命中 `.eu`、
 *     德语/欧盟跨国企业形态如 `GmbH`/`KGaA`/`SE`/`UG`/`mbH`，或所属工作区目标市场全部为 EU/UK 时
 *     触发，绝不误伤美国/中东/拉美/亚太市场）。
 */
import type { Prisma } from '@prisma/client';
import { normalizeJurisdiction } from '../compliance/jurisdiction';
import {
  inferPrefilterCountry,
  type PrefilterCountryInference,
  type PrefilterCountryInput,
} from './prefilter-country';
import { normalizeMarketIsos } from './judgment/gates';

export type ResolvedCompanyJurisdiction = PrefilterCountryInference;

export interface CompanyPhoneChannelLike {
  readonly channel: string;
  readonly value: string;
  readonly status?: string | null;
}

/** 宽容读取公司在 `company_contact_channel` 中的有效电话渠道（兼容未 mock 该表的旧单测）。 */
export async function loadCompanyPhoneChannels(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<CompanyPhoneChannelLike[]> {
  const delegate = (tx as unknown as {
    companyContactChannel?: {
      findMany?: (args: unknown) => Promise<CompanyPhoneChannelLike[]>;
    };
  }).companyContactChannel;
  if (typeof delegate?.findMany !== 'function') return [];
  return delegate.findMany({
    where: { companyId, channel: 'phone', status: { not: 'INVALID' } },
    select: { channel: true, value: true, status: true },
    take: 20,
  });
}

/**
 * 若公司 `country` 仍为空，结合 `company_contact_channel(channel='phone')` 复判国别并回填
 * `canonical_company.country` + `field_evidence(providerKey='jurisdiction_resolver')`。
 */
export async function backfillCompanyCountryFromChannels(
  tx: Prisma.TransactionClient,
  args: {
    readonly workspaceId: string;
    readonly company: {
      readonly id: string;
      readonly name?: string | null;
      readonly domain?: string | null;
      readonly country?: string | null;
      readonly attributes?: unknown;
    };
    readonly extraChannels?: readonly CompanyPhoneChannelLike[];
  },
): Promise<ResolvedCompanyJurisdiction | null> {
  if (typeof args.company.country === 'string' && args.company.country.trim()) {
    return resolveCompanyJurisdiction(args.company);
  }
  const dbChannels = await loadCompanyPhoneChannels(tx, args.company.id);
  const contactChannels = [...(args.extraChannels ?? []), ...dbChannels];
  const resolved = resolveCompanyJurisdiction({
    name: args.company.name,
    domain: args.company.domain,
    country: args.company.country,
    attributes: args.company.attributes,
    contactChannels,
  });
  if (!resolved) return null;

  const companyRepo = (tx as unknown as {
    canonicalCompany?: {
      updateMany?: (input: unknown) => Promise<{ count: number }>;
    };
  }).canonicalCompany;
  if (typeof companyRepo?.updateMany === 'function') {
    const updated = await companyRepo.updateMany({
      where: { id: args.company.id, country: null, status: { not: 'SUPPRESSED' } },
      data: { country: resolved.iso, version: { increment: 1 } },
    });
    const evidenceRepo = (tx as unknown as {
      fieldEvidence?: { create?: (input: unknown) => Promise<unknown> };
    }).fieldEvidence;
    if (updated.count === 1 && typeof evidenceRepo?.create === 'function') {
      await evidenceRepo.create({
        data: {
          workspaceId: args.workspaceId,
          entityType: 'company',
          entityId: args.company.id,
          field: 'country',
          value: {
            iso: resolved.iso,
            source: resolved.source,
            evidence: resolved.evidence,
          } as Prisma.InputJsonValue,
          providerKey: 'jurisdiction_resolver',
          confidence: 0.9,
          license: 'public',
          allowedActions: ['display', 'match'] as Prisma.InputJsonValue,
          dataClass: 'green',
        },
      });
    }
  }
  return resolved;
}

/** 多国共用但均落入 EU/EEA/CH 高保护法域的企业后缀（如 GmbH 跨 DE/AT/CH，不可定单国但必受 GDPR/FADP 约束）。 */
const EU_BLOC_LEGAL_SUFFIX_RE =
  /(?:^|[\s,(-])(?:GmbH|mbH|KGaA|UG\s*\(haftungsbeschr[äa]nkt\)|SE\s*&\s*Co\.|SA\/NV)(?:$|[\s.,)])/u;

/** 确定性解析公司 ISO 3166-1 alpha-2 国别（不猜多国共用后缀或泛用域名）。 */
export function resolveCompanyJurisdiction(
  input: PrefilterCountryInput,
): ResolvedCompanyJurisdiction | null {
  return inferPrefilterCountry(input);
}

/**
 * GDPR Art.14 保守 Fail-Closed 兜底：
 * 当公司 `country` 仍无法确定单国 ISO 时，仅在存在明确欧洲法域信号时返回 `'EU'` 或 `'UK'`：
 *  1) 域名后缀为 `.eu`；
 *  2) 企业法定名称命中多国欧盟/DACH 专属后缀（如 `Centroplan GmbH`）；
 *  3) 工作区显式配置的目标市场非空且全部落入 EU/UK（如仅投意大利/德国光伏市场）。
 */
export function inferConservativeEuUkFallback(
  company: { readonly name?: string | null; readonly domain?: string | null },
  workspaceTargetMarkets?: readonly string[] | null,
): 'EU' | 'UK' | null {
  const domain = (company.domain ?? '').trim().toLowerCase().replace(/^https?:\/\//u, '').replace(/\/.*$/u, '');
  if (domain.endsWith('.eu')) return 'EU';

  const name = (company.name ?? '').trim();
  if (name && EU_BLOC_LEGAL_SUFFIX_RE.test(name)) return 'EU';

  if (workspaceTargetMarkets && workspaceTargetMarkets.length > 0) {
    const isos = normalizeMarketIsos(workspaceTargetMarkets);
    if (isos.length > 0) {
      const jurisdictions = new Set(isos.map((iso) => normalizeJurisdiction(iso)));
      const allEuOrUk = [...jurisdictions].every((j) => j === 'EU' || j === 'UK');
      if (allEuOrUk) {
        return jurisdictions.size === 1 && jurisdictions.has('UK') ? 'UK' : 'EU';
      }
    }
  }
  return null;
}

/** 将保守法域兜底转换为 `scheduleArticle14NoticeInTransaction` 接受的国别代表码。 */
export function conservativeCountryCodeForFallback(fallback: 'EU' | 'UK'): 'DE' | 'GB' {
  return fallback === 'UK' ? 'GB' : 'DE';
}
