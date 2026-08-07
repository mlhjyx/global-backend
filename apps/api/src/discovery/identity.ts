/**
 * 身份解析（PRD 8.8）：确定性规则优先 —— 域名精确匹配 > 名称+国家规范化。
 * 纯函数，可测试；匹配规则名记入 identity_link.match_rule 供审计。
 */
import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { parse } from 'tldts-icann';
import { contactEmailKind } from '../compliance/email-kind';
import { normalizePersonName, personNameKeyVariants } from './person-name';

export { contactEmailKind } from '../compliance/email-kind';

const LEGAL_SUFFIXES =
  /\b(gmbh|ag|kg|co\.?|ltd\.?|llc|inc\.?|corp\.?|s\.?a\.?|s\.?r\.?l\.?|b\.?v\.?|oy|ab|as|plc|pty|limited|company|holdings?)\b|有限公司|株式会社|주식회사/gi;

export function normalizeDomain(raw?: string | null): string | null {
  if (!raw) return null;
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split(/[/?#]/)[0];
  return d || null;
}

/**
 * ICANN registrable-domain normalizer used by the controlled identity resolver.
 * Special-use domains, IP literals, invalid hosts and bare public suffixes fail closed.
 * The legacy {@link normalizeDomain} remains unchanged for persisted-key compatibility.
 */
export function normalizeRegistrableDomain(raw?: string | null): string | null {
  if (!raw?.trim()) return null;
  const parsed = parse(raw.trim(), {
    allowIcannDomains: true,
    allowPrivateDomains: false,
    detectIp: true,
    detectSpecialUse: true,
    extractHostname: true,
    mixedInputs: true,
    validateHostname: true,
  });
  if (!parsed.domain || parsed.isIp || parsed.isSpecialUse || parsed.isPrivate === true) return null;
  return domainToASCII(parsed.domain).toLowerCase() || null;
}

export function normalizeCompanyName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface IdentityKey {
  dedupeKey: string;
  matchRule: 'domain_exact' | 'identifier_exact' | 'name_country';
}

/** provider 标识（税号/注册号/LEI…）；scheme 命名空间隔离 id 体系。 */
export interface CompanyIdentifier {
  scheme: string;
  value: string;
}

/** 归一 provider 标识：scheme 小写 + 值剥非字母数字（"DE 291499156"→"de291499156"）；空值 → null。 */
export function normalizeIdentifier(id?: CompanyIdentifier | null): string | null {
  if (!id) return null;
  const value = id.value.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (!value) return null;
  return `${id.scheme.toLowerCase()}:${value}`;
}

export function companyIdentity(rec: {
  name: string;
  domain?: string | null;
  country?: string | null;
  identifier?: CompanyIdentifier | null;
}): IdentityKey {
  const domain = normalizeDomain(rec.domain);
  if (domain) return { dedupeKey: `d:${domain}`, matchRule: 'domain_exact' };
  // §8.4：无域名但有 provider 标识（税号/注册号）→ 按 id 归一，防同名同国不同实体误并；
  // 无域名的 TED 中标方常见。scheme 命名空间隔离，绝不跨 id 体系（ted-natid ≠ lei）串号。
  const id = normalizeIdentifier(rec.identifier);
  if (id) return { dedupeKey: `id:${id}`, matchRule: 'identifier_exact' };
  return {
    dedupeKey: `n:${normalizeCompanyName(rec.name)}:${(rec.country ?? '').toLowerCase()}`,
    matchRule: 'name_country',
  };
}

export const COMPANY_IDENTITY_RULE_VERSION = 'company-identity-resolution/2026-08-07-v1' as const;

const COUNTRY_QUALIFIED_AUTHORITATIVE_SCHEMES = new Set(['ted-natid']);

export type CompanyIdentityDecisionKind = 'AUTO_LINK' | 'REVIEW_LINK' | 'REJECT_LINK' | 'SPLIT';
export type CompanyIdentityAction = 'CREATE_CANONICAL' | 'LINK_EXISTING' | 'HOLD_FOR_REVIEW';

export type CompanyIdentityDecisionReason =
  | 'AUTHORITATIVE_IDENTIFIER_EXACT'
  | 'NEW_AUTHORITATIVE_IDENTIFIER'
  | 'REGISTRABLE_DOMAIN_COMPATIBLE'
  | 'NEW_GROUNDED_DOMAIN'
  | 'COUNTRY_EVIDENCE_MISSING'
  | 'COUNTRY_CONFLICT'
  | 'LEGAL_NAME_EVIDENCE_MISSING'
  | 'LEGAL_NAME_CONFLICT'
  | 'SHARED_GROUP_DOMAIN'
  | 'MULTIPLE_DOMAIN_CANDIDATES'
  | 'MULTIPLE_IDENTIFIER_CANDIDATES'
  | 'NAME_COUNTRY_REQUIRES_REVIEW'
  | 'IDENTIFIER_NOT_AUTHORITATIVE_OR_COUNTRY_QUALIFIED'
  | 'IDENTIFIER_COUNTRY_CONFLICT'
  | 'IDENTIFIER_DOMAIN_CONFLICT'
  | 'HUMAN_LINK_REJECTED'
  | 'HUMAN_SPLIT_REQUIRED';

export interface CompanyIdentityEvidence {
  readonly name: string;
  readonly legalName?: string | null;
  readonly domain?: string | null;
  readonly country?: string | null;
  readonly identifier?: CompanyIdentifier | null;
  readonly sharedGroupAmbiguity?: boolean;
}

export interface CompanyIdentityCandidate {
  readonly dedupeKey: string;
  readonly name: string;
  readonly legalName?: string | null;
  readonly domain?: string | null;
  readonly country?: string | null;
  readonly sharedGroupAmbiguity?: boolean;
}

export interface CompanyIdentityActor {
  readonly type: 'SYSTEM' | 'USER';
  readonly id: string;
}

export interface CompanyIdentityEvidenceRef {
  readonly type: 'RAW_RECORD' | 'FIELD_EVIDENCE' | 'CANONICAL_COMPANY' | 'SOURCE_SIGNAL';
  readonly id: string;
}

export interface CompanyIdentityDecisionContext {
  readonly ruleVersion: typeof COMPANY_IDENTITY_RULE_VERSION;
  readonly actor: CompanyIdentityActor;
  readonly decidedAt: string;
  readonly evidence: readonly CompanyIdentityEvidenceRef[];
}

export interface CompanyIdentityDecision {
  readonly decision: CompanyIdentityDecisionKind;
  readonly action: CompanyIdentityAction;
  readonly identity: Readonly<IdentityKey>;
  readonly ambiguous: boolean;
  readonly recommendationEligible: boolean;
  readonly reasons: readonly CompanyIdentityDecisionReason[];
  readonly ruleVersion: typeof COMPANY_IDENTITY_RULE_VERSION;
  readonly actor: Readonly<CompanyIdentityActor>;
  readonly decidedAt: string;
  readonly evidence: readonly Readonly<CompanyIdentityEvidenceRef>[];
}

export interface ResolveCompanyIdentityInput {
  readonly incoming: CompanyIdentityEvidence;
  readonly candidates?: readonly CompanyIdentityCandidate[];
  readonly context: CompanyIdentityDecisionContext;
}

export function provisionalReviewCanonicalKey(seed: string): string {
  const normalized = seed.trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,127}$/.test(normalized)) return `review:${normalized}`;
  return `review:h${createHash('sha256').update(normalized).digest('hex')}`;
}

function assertDecisionContext(context: CompanyIdentityDecisionContext): void {
  if (context.ruleVersion !== COMPANY_IDENTITY_RULE_VERSION) throw new Error('unsupported company identity ruleVersion');
  if (!context.actor.id.trim()) throw new Error('company identity actor id is required');
  if (!Number.isFinite(Date.parse(context.decidedAt))) throw new Error('company identity decidedAt must be ISO-8601');
  if (!context.evidence.length || context.evidence.some((item) => !item.id.trim())) {
    throw new Error('company identity evidence references are required');
  }
}

export function createCompanyIdentityDecision(input: {
  readonly decision: CompanyIdentityDecisionKind;
  readonly identity: IdentityKey;
  readonly reasons: readonly CompanyIdentityDecisionReason[];
} & CompanyIdentityDecisionContext): CompanyIdentityDecision {
  assertDecisionContext(input);
  if (!input.identity.dedupeKey.trim() || !input.reasons.length) throw new Error('identity and reasons are required');
  const automatic = input.decision === 'AUTO_LINK';
  const createsCanonical = automatic && input.reasons.some(
    (reason) => reason === 'NEW_AUTHORITATIVE_IDENTIFIER' || reason === 'NEW_GROUNDED_DOMAIN',
  );
  const actor = Object.freeze({ ...input.actor });
  const evidence = Object.freeze(input.evidence.map((item) => Object.freeze({ ...item })));
  return Object.freeze({
    decision: input.decision,
    action: automatic ? (createsCanonical ? 'CREATE_CANONICAL' : 'LINK_EXISTING') : 'HOLD_FOR_REVIEW',
    identity: Object.freeze({ ...input.identity }),
    ambiguous: !automatic,
    recommendationEligible: automatic,
    reasons: Object.freeze([...new Set(input.reasons)]),
    ruleVersion: COMPANY_IDENTITY_RULE_VERSION,
    actor,
    decidedAt: input.decidedAt,
    evidence,
  });
}

function normalizedCountry(raw?: string | null): string | null {
  const country = raw?.trim().toUpperCase() ?? '';
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

interface AuthoritativeIdentifier {
  readonly identity: IdentityKey;
  readonly schemeCountry: string;
}

function countryQualifiedAuthoritativeIdentifier(incoming: CompanyIdentityEvidence): AuthoritativeIdentifier | null {
  if (!incoming.identifier) return null;
  const scheme = incoming.identifier.scheme.trim().toLowerCase();
  const match = /^([a-z][a-z0-9_-]*):([a-z]{2})$/.exec(scheme);
  const identifier = normalizeIdentifier(incoming.identifier);
  if (!match || !identifier || !COUNTRY_QUALIFIED_AUTHORITATIVE_SCHEMES.has(match[1])) return null;
  return {
    identity: Object.freeze({ dedupeKey: `id:${identifier}`, matchRule: 'identifier_exact' as const }),
    schemeCountry: match[2].toUpperCase(),
  };
}

function countryCompatibility(
  incoming: CompanyIdentityEvidence,
  candidate: CompanyIdentityCandidate,
): CompanyIdentityDecisionReason | null {
  const incomingCountry = normalizedCountry(incoming.country);
  const candidateCountry = normalizedCountry(candidate.country);
  if (!incomingCountry || !candidateCountry) return 'COUNTRY_EVIDENCE_MISSING';
  return incomingCountry === candidateCountry ? null : 'COUNTRY_CONFLICT';
}

function legalNameCompatibility(
  incoming: CompanyIdentityEvidence,
  candidate: CompanyIdentityCandidate,
): CompanyIdentityDecisionReason | null {
  const incomingName = incoming.legalName ? normalizeCompanyName(incoming.legalName) : '';
  const candidateName = candidate.legalName ? normalizeCompanyName(candidate.legalName) : '';
  if (!incomingName || !candidateName) return 'LEGAL_NAME_EVIDENCE_MISSING';
  return incomingName === candidateName ? null : 'LEGAL_NAME_CONFLICT';
}

function matchingDomainCandidates(
  registrableDomain: string,
  candidates: readonly CompanyIdentityCandidate[],
): CompanyIdentityCandidate[] {
  const matches = candidates.filter(
    (candidate) =>
      candidate.dedupeKey === `d:${registrableDomain}` ||
      normalizeRegistrableDomain(candidate.domain) === registrableDomain,
  );
  return [...new Map(matches.map((candidate) => [candidate.dedupeKey, candidate])).values()];
}

function decision(
  context: CompanyIdentityDecisionContext,
  kind: 'AUTO_LINK' | 'REVIEW_LINK',
  identity: IdentityKey,
  reasons: readonly CompanyIdentityDecisionReason[],
): CompanyIdentityDecision {
  return createCompanyIdentityDecision({ decision: kind, identity, reasons, ...context });
}

function reviewIdentity(context: CompanyIdentityDecisionContext): IdentityKey {
  const seed = context.evidence[0]?.id ?? 'missing-evidence';
  return { dedupeKey: provisionalReviewCanonicalKey(seed), matchRule: 'name_country' };
}

/**
 * Immutable, fail-closed company identity decision for the controlled pilot.
 * Name+country never selects an existing canonical. A domain must have explicit,
 * compatible country and legal-name evidence. Only an allowlisted identifier scheme
 * carrying the same country may select an identifier canonical automatically.
 */
export function resolveCompanyIdentity(input: ResolveCompanyIdentityInput): CompanyIdentityDecision {
  const { incoming, context } = input;
  const candidates = input.candidates ?? [];
  const authoritative = countryQualifiedAuthoritativeIdentifier(incoming);
  const incomingCountry = normalizedCountry(incoming.country);
  const registrableDomain = normalizeRegistrableDomain(incoming.domain);

  if (authoritative) {
    if (!incomingCountry || incomingCountry !== authoritative.schemeCountry) {
      return decision(context, 'REVIEW_LINK', reviewIdentity(context), ['IDENTIFIER_COUNTRY_CONFLICT']);
    }
    const identifierCandidates = candidates.filter(
      (candidate) => candidate.dedupeKey === authoritative.identity.dedupeKey,
    );
    if (identifierCandidates.length > 1) {
      return decision(context, 'REVIEW_LINK', reviewIdentity(context), ['MULTIPLE_IDENTIFIER_CANDIDATES']);
    }
    const exact = identifierCandidates[0];
    const domainCandidates = registrableDomain ? matchingDomainCandidates(registrableDomain, candidates) : [];
    const domainPointsElsewhere = domainCandidates.some(
      (candidate) => candidate.dedupeKey !== authoritative.identity.dedupeKey,
    );
    const exactDomain = exact ? normalizeRegistrableDomain(exact.domain) : null;
    const identifierDomainConflicts = exactDomain != null && registrableDomain != null && exactDomain !== registrableDomain;
    if (domainPointsElsewhere || identifierDomainConflicts) {
      return decision(context, 'REVIEW_LINK', reviewIdentity(context), ['IDENTIFIER_DOMAIN_CONFLICT']);
    }
    if (exact) {
      const countryReason = countryCompatibility(incoming, exact);
      if (countryReason) return decision(context, 'REVIEW_LINK', reviewIdentity(context), [countryReason]);
      return decision(context, 'AUTO_LINK', authoritative.identity, ['AUTHORITATIVE_IDENTIFIER_EXACT']);
    }
    return decision(context, 'AUTO_LINK', authoritative.identity, ['NEW_AUTHORITATIVE_IDENTIFIER']);
  }

  if (registrableDomain) {
    const domainIdentity: IdentityKey = { dedupeKey: `d:${registrableDomain}`, matchRule: 'domain_exact' };
    const domainCandidates = matchingDomainCandidates(registrableDomain, candidates);
    if (domainCandidates.length > 1) {
      return decision(context, 'REVIEW_LINK', reviewIdentity(context), ['MULTIPLE_DOMAIN_CANDIDATES']);
    }
    const candidate = domainCandidates[0];
    const reasons: CompanyIdentityDecisionReason[] = [];
    if (incoming.identifier) reasons.push('IDENTIFIER_NOT_AUTHORITATIVE_OR_COUNTRY_QUALIFIED');
    if (incoming.sharedGroupAmbiguity || candidate?.sharedGroupAmbiguity) reasons.push('SHARED_GROUP_DOMAIN');
    if (candidate) {
      const countryReason = countryCompatibility(incoming, candidate);
      if (countryReason) reasons.push(countryReason);
      const legalNameReason = legalNameCompatibility(incoming, candidate);
      if (legalNameReason) reasons.push(legalNameReason);
      if (reasons.length) return decision(context, 'REVIEW_LINK', reviewIdentity(context), reasons);
      return decision(
        context,
        'AUTO_LINK',
        { dedupeKey: candidate.dedupeKey, matchRule: 'domain_exact' },
        ['REGISTRABLE_DOMAIN_COMPATIBLE'],
      );
    }
    if (!incomingCountry) reasons.push('COUNTRY_EVIDENCE_MISSING');
    if (!incoming.legalName || !normalizeCompanyName(incoming.legalName)) reasons.push('LEGAL_NAME_EVIDENCE_MISSING');
    if (reasons.length) return decision(context, 'REVIEW_LINK', reviewIdentity(context), reasons);
    return decision(context, 'AUTO_LINK', domainIdentity, ['NEW_GROUNDED_DOMAIN']);
  }

  const reasons: CompanyIdentityDecisionReason[] = ['NAME_COUNTRY_REQUIRES_REVIEW'];
  if (incoming.identifier) reasons.push('IDENTIFIER_NOT_AUTHORITATIVE_OR_COUNTRY_QUALIFIED');
  if (!incomingCountry) reasons.push('COUNTRY_EVIDENCE_MISSING');
  return decision(context, 'REVIEW_LINK', reviewIdentity(context), reasons);
}

export class IdentityReviewRequiredError extends Error {
  constructor(readonly decision: CompanyIdentityDecision) {
    super(`identity requires review: ${decision.reasons.join(',')}`);
    this.name = 'IdentityReviewRequiredError';
  }
}

/** Guard used at canonicalization boundaries; only AUTO_LINK has an automatic target key. */
export function automaticCanonicalKey(value: CompanyIdentityDecision): string {
  if (value.decision !== 'AUTO_LINK') throw new IdentityReviewRequiredError(value);
  return value.identity.dedupeKey;
}

/** 联系人去重键的人名归一（小写 + 折叠空白 + 去首尾）；contactIdentity 的明文 c 形用。 */
function contactNameKeyPart(fullName: string): string {
  return fullName.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * **拒并键**的人名判别符：用 resolver 同款 {@link normalizePersonName}（去称谓 / "Family, Given" 语序 /
 * 音译）——与 `resolveWithReason` 判同名歧义的归一同源，故 "Anna Weber" / "Dr. Anna Weber" / "Weber, Anna"
 * 落**同一** declined 行（幂等，#67 P2）。归一为空（纯称谓/无解析）时回退明文键，保留可区分性、不塌成一键。
 */
function declinedNameKeyPart(fullName: string): string {
  return normalizePersonName(fullName) || contactNameKeyPart(fullName);
}

export function contactIdentity(contact: { fullName: string; email?: string | null }, companyKey: string): string {
  if (contact.email) {
    const email = contact.email.trim().toLowerCase();
    return contactEmailKind(email) === 'role' ? `re:${companyKey}:${email}` : `e:${email}`;
  }
  return `c:${companyKey}:${contactNameKeyPart(contact.fullName)}`;
}

/**
 * 联系人**禁联/对账**键集（GDPR Art.17 person-level）：对同一自然人产出**多归一变体**的
 * `c:<companyKey>:<归一名变体>` 键（{@link personNameKeyVariants}：德语音译 ä→ae + 纯去音标 ä→a 两形，
 * 覆盖变音丢弃 / 德语 ASCII 拼写 Müller↔Mueller↔Muller / 分解 Unicode / "Surname, Given" 语序 / 称谓）。
 * 令被 Art.17 擦除的具名人以**任一拼写变体**（换邮箱 / 无邮箱 / 跨源不同拼写）重现都命中禁联而不重建、被对账删净。
 * 归一为空（纯称谓）时回退 {@link contactNameKeyPart} 明文键，保留可区分性、不塌成 `c:<ck>:` 空键。
 *
 * 🔴 与 {@link contactIdentity} 的**单值 dedupe 键**分离（各司其职）：dedupe（去重 upsert）走 contactIdentity +
 * resolver 模糊并（方向偏**欠并**，绝不误并两人）；禁联/对账走此**变体集**（方向偏**过禁**——over-suppress 于
 * Art.17 是安全侧，宁误禁同名另一人也不漏禁被擦除人；对账**删除**侧的同名误删另受 deletion 的 createdAt 有界窗口约束）。
 * email-独立（禁联从不按邮箱，被擦除人换邮箱也须拦），故仅取 fullName + companyKey。
 */
export function contactSuppressionKeys(fullName: string, companyKey: string): string[] {
  // 变体集（德语音译 / 纯去音标 / umlaut 折叠）+ **旧单值形**（保变音/称谓/语序的 contactNameKeyPart）。
  // 🔴 叠加旧单值形是**向后兼容**：本改动前写入的 contact_key（= blind(c:<ck>:<旧归一>))仅存盲值、明文已擦除、
  //    无法回填——把旧形留在键集里，令这些既有记录仍按其精确形命中，杜绝「静默失配回归」（变体集只增不减匹配面）。
  // 空/纯称谓时旧形亦为空 → filter 去空 → []（不塌成 `c:<ck>:` 空键；调用方按空集处理）。
  const parts = [...personNameKeyVariants(fullName), contactNameKeyPart(fullName)].filter((p) => p.length > 0);
  return [...new Set(parts.map((part) => `c:${companyKey}:${part}`))].sort();
}

/** 源侧稳定标识排序取首（确定性，不受输入顺序影响）；归一为 `scheme:value` 小写。空 → null。 */
function stableExternalIdKey(externalIds?: { scheme: string; value: string }[]): string | null {
  if (!externalIds?.length) return null;
  const normalized = externalIds.map((e) => `${e.scheme}:${e.value}`.toLowerCase()).sort();
  return normalized[0] ?? null;
}

/**
 * **拒并键**（待办 2 create 层收尾）：`resolvePersonIdentity` 明确「拒并」（同名歧义 / RISKY 猜测邮箱）
 * 但 {@link contactIdentity} 的明文键与既有**不同**联系人碰撞时，改用此键新建独立行——既尊重 resolve
 * 的拒并、绝不并回错行，又**确定性** → 同源再跑落到同一行（幂等）。
 *
 * 判别符优先级 **externalId > 可信 email > 人名**（越强越先，绝不塌不同人为一键）：
 *  - **externalId** `dx:x:<companyKey>:<scheme:value>`（全局稳定：同名不同 officer_id 各自成键，
 *    同一董事跨源经 Tier 0 再归并）；
 *  - **可信 email** `dx:e:<companyKey>:<归一名>:<email>`（🔴 同名不同人各带不同 VALID 邮箱靠 email 区分、
 *    **不同名共用同一 catch-all 地址靠人名区分**——名+邮箱双判别符，不同人绝不塌成一行）——⚠️ 调用方须只在
 *    email **可信**（未被既有行占用 = 非 catch-all/RISKY 共享地址）时才传入 email，已占用则传 undefined 退回纯人名；
 *  - **人名** `dx:c:<companyKey>:<归一名>`（无 externalId、无可信 email 的兜底；同名无其他信息才折叠=floor）。
 *  - `dx:` 命名空间与明文 `e:`/`c:` 互斥 → declined 行绝不与既有 non-declined 行碰撞；按 `companyKey` 隔离。
 */
export function declinedContactIdentity(
  contact: { fullName: string; email?: string | null; externalIds?: { scheme: string; value: string }[] },
  companyKey: string,
): string {
  const eid = stableExternalIdKey(contact.externalIds);
  if (eid) return `dx:x:${companyKey}:${eid}`;
  // 名+邮箱双判别符：不同名（Alice/Bob）共用一 catch-all 地址靠名分开；同名不同邮箱靠邮箱分开。
  // 人名部用 resolver 同款归一（#67 P2），称谓/逗号语序变体幂等落同一 declined 行。
  const nameKey = declinedNameKeyPart(contact.fullName);
  if (contact.email) return `dx:e:${companyKey}:${nameKey}:${contact.email.trim().toLowerCase()}`;
  return `dx:c:${companyKey}:${nameKey}`;
}
