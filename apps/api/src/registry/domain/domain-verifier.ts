/**
 * 域名校验器（ch03 §3.12.3 / T3-13 的离线骨架）。
 *
 * 校验目标不是「这个网站看起来像这家公司」，而是「这个网站能证明它属于这条注册实体」。
 * 证据强度（§3.12.3）：注册号精确 > VAT（VIES 通过）> 邮编+城市 > 法定名称相似 > 域名 token。
 * 全部离线：页面文本与 VIES 结果由调用方（未来是执行面）采集，这里只做确定性抽取、比对与评分；
 * 抓取/fetcher 契约、播放与限速属于执行面（T3-10/T3-12/T3-13 在线部分）。
 *
 * 复用：
 *  - `parseImpressum`（DE Impressum 的法定名/HR 注册号/VAT/地址，逐行确定性解析）；
 *  - `brandToken`/`normalizeDomain`（候选生成同一契约）；
 *  - `trigramDice` + `normalizeCompanyName`（名称相似度，0..1）。
 *
 * 评分（与 §3.12.3 完全一致）：
 *  注册号精确 +55 · VAT 精确且 VIES 通过 +35 · 邮编+城市 +20 ·
 *  名称相似 ≥0.85 +15 / ≥0.70 +8 · 域名 token 命中品牌 +5；上限 100。
 *  VERIFIED ≥90；AMBIGUOUS 55–89；REJECTED <55 或命中负证据。
 *  没有注册号/VAT 时最高 40 分——无硬证据一律不自动 VERIFIED。
 */
import { normalizeCompanyName } from '../../discovery/identity';
import {
  parseImpressum,
  scanRegisterNumbers,
  type ParsedImpressum,
} from '../../discovery/website-profile/impressum';
import { trigramDice } from '../merge';
import { brandToken } from './domain-resolver';

export type LegalPageKind = 'impressum' | 'mentions-legales' | 'legal' | 'privacy' | 'contact';

export interface LegalPageText {
  kind: LegalPageKind;
  url: string;
  text: string;
}

export interface VerifierEntity {
  scheme: string;
  regNumber: string;
  name: string;
  country: string;
  city?: string | null;
  postalCode?: string | null;
  vatId?: string | null;
  /** 注册号只在法院内唯一（DE）：实体侧已知法院时参与比对。 */
  registerCourt?: string | null;
}

export interface VatValidationResult {
  valid: boolean;
  /** provider 标识（如 vies_fixture），写入 evidence 供审计。 */
  provider: string;
}

/** VIES 契约：离线骨架只有 fixture 实现；真实 REST 在 T3-13 在线部分接线。 */
export interface VatValidator {
  readonly provider: string;
  validate(vatId: string): Promise<VatValidationResult>;
}

export interface ExtractedRegisterEvidence {
  type: string | null;
  number: string;
  court: string | null;
}

export type DomainVerdict = 'VERIFIED' | 'AMBIGUOUS' | 'REJECTED';

export type DomainMatchType = 'register_number' | 'vat' | 'name_address' | 'name_only' | 'none';

export interface DomainVerificationSignals {
  /** null = 页面/实体没有可比对的注册号（未知，不是不符）。 */
  registerNumberExact: boolean | null;
  registerMismatch: boolean;
  /** 页面上出现多个不同注册号（集团门户/多实体共用域）→ 人工判定，不自动 VERIFIED。 */
  multipleRegisters: boolean;
  vatExactAndViesValid: boolean | null;
  postalCodeAndCityMatch: boolean;
  nameSimilarity: number;
  domainTokenMatchesBrand: boolean;
  parkedDomain: boolean;
  noLegalPage: boolean;
}

export interface DomainVerificationResult {
  verdict: DomainVerdict;
  score: number;
  matchType: DomainMatchType;
  signals: DomainVerificationSignals;
  /** 负证据/拒绝原因码（REGISTER_MISMATCH / PARKED_DOMAIN / NO_LEGAL_PAGE / LOW_SCORE）。 */
  rejectReasons: string[];
  /** 抽取到的页面注册号（审计用；未抽到为 null）。 */
  pageRegister: ExtractedRegisterEvidence | null;
  pageVatId: string | null;
  evidenceUrls: string[];
}

const VERIFIED_THRESHOLD = 90;
const AMBIGUOUS_THRESHOLD = 55;
const PARKED_RE = /domain\s+(?:is|may\s+be)\s+for\s+sale|buy\s+this\s+domain|this\s+domain\s+(?:is|may\s+be)\s+parked|parked\s+(?:domain|free)/iu;
const MIN_CONTENT_CHARS = 200;

function normalizeCourt(value: string | null | undefined): string | null {
  if (!value) return null;
  const stripped = value
    .normalize('NFC')
    .toLowerCase()
    .replace(/^(?:amtsgericht|registergericht|ag)\s+/u, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return stripped || null;
}

function digitsOnly(value: string): string {
  return value.replace(/\D+/gu, '').replace(/^0+/u, '');
}

/** DE：从实体注册号（`HRB 12345`/`HRB:12345`）抽取类型与号码。 */
function parseGermanRegisterNumber(regNumber: string): { type: string; number: string } | null {
  const match = /^(HR[AB])[\s:.-]*(\d{1,6})$/iu.exec(regNumber.trim());
  if (!match) return null;
  return { type: match[1]!.toUpperCase(), number: digitsOnly(match[2]!) };
}

const FR_SIREN_RE =
  /\b(?:SIREN|SIRET|RCS)\b[^\d\n]{0,24}(\d{3})\s?(\d{3})\s?(\d{3})(?:\s?(\d{3})\s?(\d{2}))?\b/iu;
const GB_CRN_RE =
  /(?:company\s+(?:registration\s+)?number|registered\s+in\s+(?:england(?:\s+and\s+wales)?|scotland|northern\s+ireland)(?:\s+(?:and\s+wales))?\s*(?:no\.?|number)?)[:\s]*([A-Z]{2}\d{6}|\d{8})\b/iu;
// §3.12.9 其余国家锚点（T3-13 矩阵扩充）：IT REA+省、ES NIF/CIF、NL KVK、BE KBO、CH UID。
const IT_REA_RE =
  /(?:R\.?\s?E\.?\s?A\.?|Repertorio\s+Economico\s+Amministrativo)[:\s]*([A-Z]{2})[\s-]*(\d{5,9})\b/iu;
const ES_NIF_CIF_RE =
  /(?:N\.?\s?I\.?\s?F\.?|C\.?\s?I\.?\s?F\.?)[:\s]*([A-Z]\s?-?\s?\d{7}\s?-?\s?[A-Z0-9])\b/iu;
const NL_KVK_RE = /(?:K\.?\s?V\.?\s?K\.?|Kamer\s+van\s+Koophandel)[^\d\n]{0,24}(\d{8})\b/iu;
const BE_KBO_RE =
  /(?:K\.?\s?B\.?\s?O\.?|B\.?\s?C\.?\s?E\.?|Ondernemingsnummer)[^\d\n]{0,16}([01]\d{3}[.\s]?\d{3}[.\s]?\d{3})\b/iu;
const CH_UID_RE = /\bCHE[-\s]?(\d{3})[.\s](\d{3})[.\s](\d{3})\b/u;

/**
 * 按 scheme 从法律页文本抽取注册号证据（找不到返回 null——「未知」不等于「不符」）。
 * 目前覆盖 §3.12.9 锚点矩阵的 DE（parseImpressum HR+法院）、FR（SIREN/SIRET/RCS）、
 * GB（CRN）、IT（REA+省）、ES（NIF/CIF）、NL（KVK）、BE（KBO）、CH（UID）；其余 scheme 返回 null。
 */
interface CollectedRegisters {
  registers: ExtractedRegisterEvidence[];
  parsed: ParsedImpressum | null;
}

/** 收集全部页面上的注册号证据（集团门户页可能有多个不同注册号——由调用方判 AMBIGUOUS）。 */
export function collectRegisterEvidence(
  scheme: string,
  pages: readonly LegalPageText[],
): CollectedRegisters {
  const registers: ExtractedRegisterEvidence[] = [];
  let parsed: ParsedImpressum | null = null;
  const deEntity = scheme === 'de_hrb' || scheme === 'de_hra';
  for (const page of pages) {
    if (deEntity) {
      const pageParsed = parseImpressum(page.text);
      const scanned = scanRegisterNumbers(page.text);
      const own = pageParsed.register;
      if (scanned.length > 0) {
        for (const register of scanned) {
          const isParsed =
            own && own.type === register.type && digitsOnly(own.number) === digitsOnly(register.number);
          registers.push({
            type: register.type,
            number: digitsOnly(register.number),
            court: isParsed ? own!.court : null,
          });
        }
        parsed ??= pageParsed;
      } else if (own) {
        registers.push({ type: own.type, number: digitsOnly(own.number), court: own.court });
        parsed ??= pageParsed;
      }
      continue;
    }
    if (scheme === 'fr_siren') {
      for (const match of page.text.matchAll(new RegExp(FR_SIREN_RE.source, 'giu'))) {
        registers.push({ type: 'siren', number: digitsOnly(`${match[1]}${match[2]}${match[3]}`), court: null });
      }
      continue;
    }
    if (scheme === 'gb_crn') {
      for (const match of page.text.matchAll(new RegExp(GB_CRN_RE.source, 'giu'))) {
        registers.push({ type: 'crn', number: match[1]!.toUpperCase(), court: null });
      }
      continue;
    }
    if (scheme === 'it_rea') {
      for (const match of page.text.matchAll(new RegExp(IT_REA_RE.source, 'giu'))) {
        registers.push({ type: 'rea', number: `${match[1]!.toUpperCase()}-${digitsOnly(match[2]!)}`, court: null });
      }
      continue;
    }
    if (scheme === 'es_nif') {
      for (const match of page.text.matchAll(new RegExp(ES_NIF_CIF_RE.source, 'giu'))) {
        registers.push({ type: 'nif', number: match[1]!.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ''), court: null });
      }
      continue;
    }
    if (scheme === 'nl_kvk') {
      for (const match of page.text.matchAll(new RegExp(NL_KVK_RE.source, 'giu'))) {
        registers.push({ type: 'kvk', number: digitsOnly(match[1]!), court: null });
      }
      continue;
    }
    if (scheme === 'be_kbo') {
      for (const match of page.text.matchAll(new RegExp(BE_KBO_RE.source, 'giu'))) {
        registers.push({ type: 'kbo', number: digitsOnly(match[1]!), court: null });
      }
      continue;
    }
    if (scheme === 'ch_uid') {
      for (const match of page.text.matchAll(new RegExp(CH_UID_RE.source, 'gu'))) {
        registers.push({ type: 'uid', number: digitsOnly(`${match[1]}${match[2]}${match[3]}`), court: null });
      }
    }
  }
  return { registers, parsed };
}

/** 单值便捷入口（首个注册号）；需要集团门户判断时用 {@link collectRegisterEvidence}。 */
export function extractRegisterEvidence(
  scheme: string,
  pages: readonly LegalPageText[],
): { evidence: ExtractedRegisterEvidence; parsed: ParsedImpressum | null } | null {
  const collected = collectRegisterEvidence(scheme, pages);
  const first = collected.registers[0];
  return first ? { evidence: first, parsed: collected.parsed } : null;
}

function registerMatches(
  scheme: string,
  entity: VerifierEntity,
  page: ExtractedRegisterEvidence,
): boolean {
  if (scheme === 'de_hrb' || scheme === 'de_hra') {
    const own = parseGermanRegisterNumber(entity.regNumber);
    if (!own) return false;
    if (own.type !== page.type || own.number !== page.number) return false;
    // 注册号只在法院内唯一：双方都知道法院时必须一致。
    const entityCourt = normalizeCourt(entity.registerCourt);
    const pageCourt = normalizeCourt(page.court);
    if (entityCourt && pageCourt && entityCourt !== pageCourt) return false;
    return true;
  }
  if (scheme === 'fr_siren') return digitsOnly(entity.regNumber) === page.number;
  if (scheme === 'gb_crn') return entity.regNumber.trim().toUpperCase() === page.number;
  if (scheme === 'it_rea') {
    // REA 号只在省内唯一：实体注册号形如 `REA MI-1234567` 或 `MI-1234567`。
    const own = /^(?:REA[\s:]*)?([A-Z]{2})[-\s]?(\d{1,9})$/iu.exec(entity.regNumber.trim());
    if (!own) return false;
    return `${own[1]!.toUpperCase()}-${digitsOnly(own[2]!)}` === page.number;
  }
  if (scheme === 'es_nif') {
    return entity.regNumber.trim().toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '') === page.number;
  }
  if (scheme === 'nl_kvk') return digitsOnly(entity.regNumber) === page.number;
  if (scheme === 'be_kbo') return digitsOnly(entity.regNumber) === page.number;
  if (scheme === 'ch_uid') return digitsOnly(entity.regNumber) === page.number;
  return false;
}

function bestNameSimilarity(entity: VerifierEntity, pages: readonly LegalPageText[]): number {
  const target = normalizeCompanyName(entity.name);
  if (!target) return 0;
  let best = 0;
  for (const page of pages) {
    const parsed = parseImpressum(page.text);
    const candidates: string[] = [];
    if (parsed.legalName) candidates.push(parsed.legalName);
    for (const line of page.text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed.length >= 3 && trimmed.length <= 120) candidates.push(trimmed);
    }
    for (const candidate of candidates) {
      const normalized = normalizeCompanyName(candidate);
      if (!normalized) continue;
      const similarity = trigramDice(target, normalized);
      if (similarity > best) best = similarity;
    }
  }
  return Number(best.toFixed(4));
}

function addressMatches(entity: VerifierEntity, pages: readonly LegalPageText[]): boolean {
  const postal = entity.postalCode?.trim().toUpperCase();
  const city = entity.city?.trim().toLowerCase();
  if (!postal || !city) return false;
  return pages.some((page) => {
    const text = page.text.toUpperCase();
    return text.includes(postal) && page.text.toLowerCase().includes(city);
  });
}

function domainTokenMatches(entity: VerifierEntity, domain: string): boolean {
  const token = brandToken(entity.name);
  if (!token) return false;
  const registered = domain.toLowerCase().split('.').slice(0, -1).join('.');
  return registered.includes(token);
}

export interface VerifyDomainCandidateInput {
  entity: VerifierEntity;
  candidateDomain: string;
  pages: readonly LegalPageText[];
  vatValidator?: VatValidator;
}

/** 单候选校验：确定性评分 + 负证据判定（§3.12.3 / §3.12.10）。 */
export async function verifyDomainCandidate(
  input: VerifyDomainCandidateInput,
): Promise<DomainVerificationResult> {
  const { entity, pages } = input;
  const evidenceUrls = pages.map((page) => page.url);
  const rejectReasons: string[] = [];

  const collected = collectRegisterEvidence(entity.scheme, pages);
  const pageRegister = collected.registers[0] ?? null;
  const distinctRegisters = new Set(
    collected.registers.map(
      (register) => `${register.type}:${register.number}:${normalizeCourt(register.court) ?? ''}`,
    ),
  );
  const multipleRegisters = distinctRegisters.size > 1;

  let registerNumberExact: boolean | null = null;
  let registerMismatch = false;
  if (collected.registers.length > 0) {
    // 任一注册号命中即算精确匹配（多注册号仍走 AMBIGUOUS，见下方 group portal 规则）。
    registerNumberExact = collected.registers.some((register) =>
      registerMatches(entity.scheme, entity, register),
    );
    registerMismatch = !registerNumberExact;
  }

  // VAT：页面 VAT 与实体一致，再经 VIES（接口）验证通过才算强证据。
  const pageVatId =
    collected.parsed?.vatId ??
    pages
      .flatMap((page) => [...page.text.matchAll(/\b([A-Z]{2}\s?[A-Z0-9]{8,12})\b/gu)].map((match) => match[1]!.replace(/\s+/gu, '')))
      .find((candidate) => entity.vatId && candidate === entity.vatId.replace(/\s+/gu, '')) ??
    null;
  let vatExactAndViesValid: boolean | null = null;
  if (entity.vatId && pageVatId) {
    const normalizedEntityVat = entity.vatId.replace(/[\s.-]/gu, '').toUpperCase();
    const normalizedPageVat = pageVatId.replace(/[\s.-]/gu, '').toUpperCase();
    if (normalizedEntityVat === normalizedPageVat) {
      if (input.vatValidator) {
        try {
          vatExactAndViesValid = (await input.vatValidator.validate(normalizedEntityVat)).valid === true;
        } catch {
          vatExactAndViesValid = null; // VIES 不可用 ≠ 无效：按未知处理，不扣分也不加分。
        }
      } else {
        vatExactAndViesValid = null;
      }
    } else {
      vatExactAndViesValid = false;
    }
  }

  const postalCodeAndCityMatch = addressMatches(entity, pages);
  const nameSimilarity = bestNameSimilarity(entity, pages);
  const domainToken = domainTokenMatches(entity, input.candidateDomain);
  const parkedDomain = pages.some((page) => PARKED_RE.test(page.text));
  const noLegalPage = pages.length === 0;

  let score = 0;
  if (registerNumberExact) score += 55;
  if (vatExactAndViesValid) score += 35;
  if (postalCodeAndCityMatch) score += 20;
  if (nameSimilarity >= 0.85) score += 15;
  else if (nameSimilarity >= 0.7) score += 8;
  if (domainToken) score += 5;
  score = Math.min(score, 100);

  let verdict: DomainVerdict;
  if (registerMismatch) {
    rejectReasons.push('REGISTER_MISMATCH');
    verdict = 'REJECTED';
  } else if (parkedDomain) {
    rejectReasons.push('PARKED_DOMAIN');
    verdict = 'REJECTED';
  } else if (noLegalPage) {
    rejectReasons.push('NO_LEGAL_PAGE');
    verdict = 'REJECTED';
  } else if (multipleRegisters) {
    // §3.12.10 集团门户/多品牌共用域：注册号命中也不自动 VERIFIED，人工决定主实体。
    rejectReasons.push('MULTIPLE_REGISTERS');
    verdict = 'AMBIGUOUS';
  } else if (score >= VERIFIED_THRESHOLD) {
    verdict = 'VERIFIED';
  } else if (score >= AMBIGUOUS_THRESHOLD) {
    verdict = 'AMBIGUOUS';
  } else {
    rejectReasons.push('LOW_SCORE');
    verdict = 'REJECTED';
  }

  const matchType: DomainMatchType = registerNumberExact
    ? 'register_number'
    : vatExactAndViesValid === true
      ? 'vat'
      : postalCodeAndCityMatch && nameSimilarity >= 0.85
        ? 'name_address'
        : nameSimilarity >= 0.7
          ? 'name_only'
          : 'none';

  return {
    verdict,
    score,
    matchType,
    signals: {
      registerNumberExact,
      registerMismatch,
      multipleRegisters,
      vatExactAndViesValid,
      postalCodeAndCityMatch,
      nameSimilarity,
      domainTokenMatchesBrand: domainToken,
      parkedDomain,
      noLegalPage,
    },
    rejectReasons,
    pageRegister,
    pageVatId,
    evidenceUrls,
  };
}

export interface CandidatePageEvidence {
  candidateDomain: string;
  pages: readonly LegalPageText[];
}

export interface VerifyCandidateSetResult {
  results: Array<{ candidateDomain: string } & DomainVerificationResult>;
  /** 唯一 VERIFIED 且无同名冲突时的选中域名；否则 null（进人工队列）。 */
  selectedDomain: string | null;
  /** ≥2 个候选达到 AMBIGUOUS 阈值时的同名冲突标记（全部保持 AMBIGUOUS）。 */
  nameCollision: boolean;
}

/**
 * 多候选编排（§3.12.3 特例）：同一实体 ≥2 个候选都 ≥55 分 → 全部 AMBIGUOUS（同名冲突，
 * 人工决定），其余按单候选判定；只有唯一 VERIFIED 才被选中。
 */
export async function verifyDomainCandidates(input: {
  entity: VerifierEntity;
  candidates: readonly CandidatePageEvidence[];
  vatValidator?: VatValidator;
}): Promise<VerifyCandidateSetResult> {
  const results: Array<{ candidateDomain: string } & DomainVerificationResult> = [];
  for (const candidate of input.candidates) {
    const verified = await verifyDomainCandidate({
      entity: input.entity,
      candidateDomain: candidate.candidateDomain,
      pages: candidate.pages,
      vatValidator: input.vatValidator,
    });
    results.push({ candidateDomain: candidate.candidateDomain, ...verified });
  }
  const strong = results.filter(
    (result) => result.verdict !== 'REJECTED' && result.score >= AMBIGUOUS_THRESHOLD,
  );
  const nameCollision = strong.length >= 2;
  if (nameCollision) {
    for (const result of strong) {
      if (result.verdict === 'VERIFIED') result.verdict = 'AMBIGUOUS';
    }
  }
  const verified = results.filter((result) => result.verdict === 'VERIFIED');
  return {
    results,
    selectedDomain: !nameCollision && verified.length === 1 ? verified[0]!.candidateDomain : null,
    nameCollision,
  };
}

/**
 * 映射到 ch03 §3.9.4 `company_domain_resolution` 的行草案（不含 workspace/company 归属与 DB 写入，
 * 由执行面填充）。route/routeRank 由候选生成器给出；expiresAt 默认 180 天由执行面设置。
 */
export interface DomainResolutionDraft {
  candidateDomain: string;
  status: 'VERIFIED' | 'AMBIGUOUS' | 'REJECTED';
  matchType: DomainMatchType;
  confidence: number;
  evidenceUrl: string | null;
  evidenceJson: {
    signals: DomainVerificationSignals;
    rejectReasons: string[];
    pageRegister: ExtractedRegisterEvidence | null;
    evidenceUrls: string[];
  };
  selected: boolean;
}

export function toDomainResolutionDrafts(
  verification: VerifyCandidateSetResult,
): DomainResolutionDraft[] {
  return verification.results.map((result) => ({
    candidateDomain: result.candidateDomain,
    status: result.verdict,
    matchType: result.matchType,
    confidence: result.score,
    evidenceUrl: result.evidenceUrls[0] ?? null,
    evidenceJson: {
      signals: result.signals,
      rejectReasons: result.rejectReasons,
      pageRegister: result.pageRegister,
      evidenceUrls: result.evidenceUrls,
    },
    selected: verification.selectedDomain === result.candidateDomain,
  }));
}
