/**
 * BI-19/BI-21/BI-15（交付闭环设计 §2/§3）：按线索组装的交付读模型 `LeadPackage`。
 *
 * 纯组装函数：调用方在一个只读事务里取好 lead、公司、联系路径、证据与制裁状态后传入。
 * 只含公司级（green / amber）事实，不读 `canonical_contact`，因此结构上不带具名个人。
 * 三处使用同一口径：accept 快照的可选字段、周报、`GET /leads/:id/package`。
 * 缺失的事实留空（null / []），绝不猜。
 */

import { clamp01 } from './scoring';
import { deriveFitReasonCodes } from './reason-codes';
import { extractIdentifiers, isoOrNull } from './lead-qualified-snapshot';
import {
  CONTACT_PATH_DISPLAY_ORDER,
  suggestedContactPath,
  type SuggestedContactPath,
} from './suggested-contact-path';

export interface LeadPackageLead {
  readonly id: string;
  readonly status: string;
  readonly queue: string;
  readonly fitVerdict: string | null;
  readonly fitReasons: unknown;
  readonly scores: unknown;
  readonly scoreDetail: unknown;
  readonly totalScore: number | null;
}

export interface LeadPackageCompany {
  readonly id: string;
  readonly name: string;
  readonly domain: string | null;
  readonly country: string | null;
  readonly attributes: unknown;
}

export interface LeadPackageContactPoint {
  readonly kind: string;
  readonly value: string;
  readonly status: string;
}

export interface LeadPackageEvidence {
  readonly field: string;
  readonly sourceUrl: string | null;
  readonly fetchedAt: Date | string | null;
}

export type LeadPackageSanctionsStatus =
  | 'clear'
  | 'cleared_false_positive'
  | 'not_screened'
  | 'potential_match'
  | 'confirmed_true_hit';

export interface LeadPackageInput {
  readonly lead: LeadPackageLead;
  readonly company: LeadPackageCompany;
  readonly contactPoints: readonly LeadPackageContactPoint[];
  readonly evidence: readonly LeadPackageEvidence[];
  readonly sanctions: { readonly status: LeadPackageSanctionsStatus; readonly screened_at: string | null };
  readonly validUntil: string | null;
}

export interface LeadPackage {
  readonly lead_id: string;
  readonly status: string;
  readonly company: {
    readonly canonical_company_id: string;
    readonly name: string;
    readonly domain: string | null;
    readonly country: string | null;
    readonly city: string | null;
  };
  readonly company_profile: {
    readonly trade_role: string | null;
    readonly trade_role_confidence: number | null;
    readonly own_manufacturing: boolean | null;
    readonly carried_brands: readonly { readonly name: string; readonly country: string | null }[];
    readonly carries_chinese_brand: boolean | null;
    readonly carries_foreign_brand: boolean | null;
  };
  readonly registered_address: string | null;
  readonly identifiers: {
    readonly register_key: string | null;
    readonly vat_id: string | null;
    readonly lei: string | null;
    readonly fda_reg: string | null;
  };
  readonly contact_points: readonly {
    readonly kind: string;
    readonly url: string;
    readonly status: string;
  }[];
  readonly suggested_contact_path: SuggestedContactPath | null;
  readonly signals: readonly {
    readonly type: string;
    readonly at: string;
    readonly url: string | null;
  }[];
  readonly scores: {
    readonly fit: number | null;
    readonly role: number | null;
    readonly intent: number | null;
    readonly demand_proof: number | null;
    readonly reachability: number | null;
    readonly data_quality: number | null;
    readonly engagement: number | null;
    readonly total: number | null;
  };
  readonly fit: {
    readonly verdict: string | null;
    readonly reason_codes: readonly string[];
    readonly reasons: readonly string[];
  };
  readonly evidence: readonly {
    readonly field: string;
    readonly source_url: string;
    readonly fetched_at: string;
  }[];
  readonly sanctions: {
    readonly status: LeadPackageSanctionsStatus;
    readonly screened_at: string | null;
  };
  readonly valid_until: string | null;
}

const MAX_SIGNALS = 3;
const MAX_EVIDENCE = 20;
const MAX_BRANDS = 50;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Date 或 ISO 串 → ISO 串（与快照同一个归一策略）；其他类型 → null。 */
function isoInstant(value: unknown): string | null {
  return value instanceof Date || typeof value === 'string' ? isoOrNull(value) : null;
}

function isHttps(value: string | null): value is string {
  return value !== null && value.startsWith('https://');
}

function contactKindRank(kind: string): number {
  const index = CONTACT_PATH_DISPLAY_ORDER.indexOf(kind as (typeof CONTACT_PATH_DISPLAY_ORDER)[number]);
  return index < 0 ? CONTACT_PATH_DISPLAY_ORDER.length : index;
}

function companyProfile(attributes: Record<string, unknown>) {
  const profile = record(attributes.website_profile);
  const carried = Array.isArray(profile.carried_brands) ? profile.carried_brands : [];
  const brands = carried
    .map((entry) => record(entry))
    .flatMap((brand) => {
      const name = text(brand.name);
      return name ? [{ name, country: text(brand.country) }] : [];
    })
    .slice(0, MAX_BRANDS)
    .map((brand) => Object.freeze(brand));
  return Object.freeze({
    trade_role: text(profile.trade_role),
    // 契约是系统边界：与六维分一样 clamp 到 [0,1]，库里的历史越界值不外泄。
    trade_role_confidence:
      finite(profile.trade_role_confidence) == null ? null : clamp01(finite(profile.trade_role_confidence)!),
    own_manufacturing: bool(profile.own_manufacturing),
    carried_brands: Object.freeze(brands),
    carries_chinese_brand: bool(profile.carries_chinese_brand),
    carries_foreign_brand: bool(profile.carries_foreign_brand),
  });
}

/** The newest intent signals behind "why now", at most {@link MAX_SIGNALS}, shared with the weekly report. */
export function leadSignals(attributes: unknown): readonly { type: string; at: string; url: string | null }[] {
  const intent = record(record(attributes).intent);
  const events = Array.isArray(intent.events) ? intent.events : [];
  return events
    .map((entry) => record(entry))
    .flatMap((event) => {
      const type = text(event.type);
      const at = isoInstant(event.at);
      if (!type || !at) return [];
      const url = isHttps(text(event.page_url)) ? (text(event.page_url) as string) : null;
      return [{ type, at, url }];
    })
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, MAX_SIGNALS)
    .map((signal) => Object.freeze(signal));
}

function evidenceList(
  evidence: readonly LeadPackageEvidence[],
  profileSourceUrl: string | null,
) {
  const seen = new Set<string>();
  // Newest first, then dedupe: the surviving row per (field, source) is the freshest one
  // whatever order the caller read the rows in.
  return evidence
    .flatMap((row) => {
      const source = isHttps(row.sourceUrl)
        ? row.sourceUrl
        : row.field.startsWith('website_profile.')
          ? profileSourceUrl
          : null;
      const fetchedAt = isoInstant(row.fetchedAt);
      if (!isHttps(source) || !fetchedAt || !row.field) return [];
      return [{ field: row.field, source_url: source, fetched_at: fetchedAt, sort: Date.parse(fetchedAt) }];
    })
    .sort((left, right) => right.sort - left.sort)
    .filter((row) => {
      const key = `${row.field}\n${row.source_url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_EVIDENCE)
    .map(({ sort: _sort, ...row }) => Object.freeze(row));
}

/** Pure assembly of the delivery read model; every nested value is frozen. */
export function buildLeadPackage(input: LeadPackageInput): LeadPackage {
  const attributes = record(input.company.attributes);
  const profile = record(attributes.website_profile);
  const scores = record(input.lead.scores);
  const fitReasons = record(input.lead.fitReasons);
  const reasons = (Array.isArray(fitReasons.reasons) ? fitReasons.reasons : [])
    .filter((reason): reason is string => typeof reason === 'string' && reason.length > 0)
    .map((reason) => reason);

  const contactPoints = input.contactPoints
    .filter((point) => point.status !== 'INVALID' && isHttps(point.value))
    .sort(
      (left, right) => contactKindRank(left.kind) - contactKindRank(right.kind) || left.value.localeCompare(right.value),
    )
    .map((point) => Object.freeze({ kind: point.kind, url: point.value, status: point.status }));

  const gleif = record(attributes.gleif);
  const profileSourceUrl = text(profile.source_url);
  const { lei, fda_reg: fdaReg } = extractIdentifiers(attributes);

  return Object.freeze({
    lead_id: input.lead.id,
    status: input.lead.status,
    company: Object.freeze({
      canonical_company_id: input.company.id,
      name: input.company.name,
      domain: input.company.domain,
      country: input.company.country,
      city: text(gleif.registered_city),
    }),
    company_profile: companyProfile(attributes),
    registered_address: text(profile.registered_address),
    identifiers: Object.freeze({
      register_key: text(profile.register_key),
      vat_id: text(profile.vat_id),
      lei,
      fda_reg: fdaReg,
    }),
    contact_points: Object.freeze(contactPoints),
    suggested_contact_path: suggestedContactPath(input.contactPoints),
    signals: Object.freeze([...leadSignals(attributes)]),
    scores: Object.freeze({
      fit: finite(scores.fit),
      role: finite(scores.role),
      intent: finite(scores.intent),
      demand_proof: finite(scores.demandProof),
      reachability: finite(scores.reachability),
      data_quality: finite(scores.dataQuality),
      engagement: finite(scores.engagement),
      total: finite(input.lead.totalScore),
    }),
    fit: Object.freeze({
      verdict: text(input.lead.fitVerdict),
      reason_codes: deriveFitReasonCodes({
        fitVerdict: input.lead.fitVerdict,
        queue: input.lead.queue,
        scores: input.lead.scores,
        scoreDetail: input.lead.scoreDetail,
      }),
      reasons: Object.freeze(reasons),
    }),
    evidence: Object.freeze(evidenceList(input.evidence, profileSourceUrl)),
    sanctions: Object.freeze({
      status: input.sanctions.status,
      screened_at: isoInstant(input.sanctions.screened_at),
    }),
    valid_until: isoInstant(input.validUntil),
  });
}
