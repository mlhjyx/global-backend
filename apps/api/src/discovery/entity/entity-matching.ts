/**
 * 获客挖掘 vNext W2（2026-11-10）：公司 ↔ 法人实体的链接判定（确定性键 + 概率匹配骨架）。
 *
 * 权威计划：docs/superpowers/plans/2026-11-10-deep-acquisition-vnext.md §3 W2。
 *
 * 判定顺序（每个候选实体独立）：
 *  1. **同 scheme 冲突**：公司自带某 scheme 的确定性键，而候选实体同 scheme 的值不同 →
 *     `rejected`（留档）。这是「同名异法人」的硬反例：名字再像也不能连。
 *  2. **确定性键命中**：同 scheme 同值 → `deterministic`。hard scheme（LEI/SIREN/CH/KVK/CVR/
 *     bolagsverket）auto；caveat scheme（VAT/HRB/other）review——VAT 由注入的 VIES 校验器
 *     （`VatValidator`，契约在 registry/domain/domain-verifier）佐证，通过才 auto。
 *  3. **概率匹配**（无确定性关系时）：Fellegi–Sunter 对数似然评分。blocking = 同国家 +
 *     归一化名字前 4 字符；字段 = 名称 / 国家 / 地址（任一缺失则跳过该字段，LLR=0）。
 *     双阈值：后验 ≥ autoThreshold → auto；≥ reviewThreshold → review；否则不产出链接。
 *
 * 快照纪律：本模块是纯判定（除 VIES 注入点外零副作用、零数据库、零出网默认实现），
 * 权重表与阈值可配（`MatchConfig`），默认值即基线 v1（fellegi_sunter_v1）。
 * 绝不自动合并两个已存在的 canonical 公司：链接只表达「公司 ↔ 法人实体」，合并进人工复核。
 */
import { normForMatch } from '../name-match';
import type { VatValidator } from '../../registry/domain/domain-verifier';
import { trigramDice } from '../../registry/merge';
import {
  LegalEntityScheme,
  LegalEntityStatus,
  LegalLinkMethod,
  LegalLinkStatus,
  SCHEME_STRENGTH,
} from './entity-keys';

export interface CompanyIdentitySnapshot {
  companyId: string;
  /** 运营名（canonical_company.name）。 */
  name: string;
  /** 官方法人名（如 GLEIF legal_name）；有则优先用于名称比对。 */
  legalName?: string | null;
  country?: string | null;
  /** 公司侧地址（可选；canonical_company 无地址列，装载层可经快照传入）。地址两侧都有才评分。 */
  address?: string | null;
  /** 公司自带的确定性键（来自 attributes：gleif.lei / website_profile.vat_id …），已规范化。 */
  identifiers: ReadonlyArray<{ scheme: LegalEntityScheme; value: string; country?: string | null }>;
}

export interface LegalEntityCandidate {
  entityId?: string | null;
  scheme: LegalEntityScheme;
  value: string;
  country: string;
  name: string;
  address?: string | null;
  status?: LegalEntityStatus;
}

type Level = 'agree' | 'partial' | 'disagree';

export interface LevelRates {
  m: number;
  u: number;
}

export interface FieldProfile {
  agree: LevelRates;
  partial?: LevelRates;
  disagree: LevelRates;
}

export interface MatchConfig {
  /** 先验链接概率（同一 blocking 桶内随机一对的先验）。 */
  priorLinkProbability: number;
  autoThreshold: number;
  reviewThreshold: number;
  nameAgreeSimilarity: number;
  namePartialSimilarity: number;
  addressAgreeSimilarity: number;
  addressPartialSimilarity: number;
  name: FieldProfile;
  country: FieldProfile;
  address: FieldProfile;
}

/**
 * 基线权重表 v1。m = 同一实体对出现该一致级别的概率，u = 随机对出现的概率；
 * 数值为文档化的起始值（并非从标注数据拟合——标注数据来源留待 W5 主动学习重校准，
 * 界面与端点只消费本表，届时换版本号即可）。
 */
export const DEFAULT_MATCH_CONFIG: Readonly<MatchConfig> = Object.freeze({
  priorLinkProbability: 0.1,
  autoThreshold: 0.9,
  reviewThreshold: 0.7,
  nameAgreeSimilarity: 0.92,
  namePartialSimilarity: 0.75,
  addressAgreeSimilarity: 0.9,
  addressPartialSimilarity: 0.7,
  name: {
    agree: { m: 0.94, u: 0.04 },
    partial: { m: 0.05, u: 0.25 },
    disagree: { m: 0.01, u: 0.71 },
  },
  // 国家一致是弱正证据（同国实体海量），不一致是强负证据；一侧缺失时整个字段跳过。
  country: {
    agree: { m: 0.9, u: 0.6 },
    disagree: { m: 0.1, u: 0.4 },
  },
  address: {
    agree: { m: 0.8, u: 0.06 },
    partial: { m: 0.14, u: 0.18 },
    disagree: { m: 0.06, u: 0.76 },
  },
});

export interface FieldAssessment {
  field: 'name' | 'country' | 'address';
  level: Level;
  /** 名称/地址为相似度；国家为 1/0。 */
  similarity: number;
  logLikelihoodRatio: number;
}

export interface ProbabilisticAssessment {
  configVersion: 'fellegi_sunter_v1';
  blockingKey: string;
  logOdds: number;
  posterior: number;
  fields: FieldAssessment[];
  thresholds: { auto: number; review: number };
}

function levelRates(profile: FieldProfile, level: Level): LevelRates | null {
  if (level === 'agree') return profile.agree;
  if (level === 'partial') return profile.partial ?? profile.disagree;
  return profile.disagree;
}

function llr(rates: LevelRates): number {
  return Math.log(rates.m / rates.u);
}

function classify(similarity: number, agreeAt: number, partialAt: number): Level {
  if (similarity >= agreeAt) return 'agree';
  if (similarity >= partialAt) return 'partial';
  return 'disagree';
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

/** 地址比对用归一：小写、非字母数字折叠为单空格。 */
export function normalizeAddressForMatch(raw?: string | null): string {
  return (raw ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** blocking 键：国家 + 归一化名字前 4 字符（计划 §3 W2 的 blocking 口径；域名属于
 *  canonical_company/company_domain_resolution，法人实体记录自身不带域名）。 */
export function blockingKeyFor(country: string | null | undefined, name: string): string | null {
  const normalizedCountry = (country ?? '').trim().toUpperCase();
  const normalizedName = normForMatch(name);
  if (!/^[A-Z]{2}$/u.test(normalizedCountry) || !normalizedName) return null;
  return `${normalizedCountry}\u0001${normalizedName.slice(0, 4)}`;
}

/**
 * Fellegi–Sunter 评分。返回 null 表示不满足 blocking（不进入概率比对）。
 * 字段缺失（一侧无值）→ 该字段跳过（LLR=0），按可用字段累计。
 */
export function scoreProbabilistic(
  company: CompanyIdentitySnapshot,
  entity: LegalEntityCandidate,
  config: MatchConfig = DEFAULT_MATCH_CONFIG,
): ProbabilisticAssessment | null {
  const companyName = company.legalName?.trim() || company.name;
  const blockingKey = blockingKeyFor(company.country, companyName);
  if (!blockingKey) return null;
  if (blockingKey !== blockingKeyFor(entity.country, entity.name)) return null;

  const fields: FieldAssessment[] = [];

  const nameSimilarity = trigramDice(normForMatch(companyName), normForMatch(entity.name));
  const nameLevel = classify(nameSimilarity, config.nameAgreeSimilarity, config.namePartialSimilarity);
  fields.push({
    field: 'name',
    level: nameLevel,
    similarity: round6(nameSimilarity),
    logLikelihoodRatio: round6(llr(levelRates(config.name, nameLevel)!)),
  });

  const companyCountry = (company.country ?? '').trim().toUpperCase();
  const entityCountry = entity.country.trim().toUpperCase();
  if (companyCountry && entityCountry) {
    const level: Level = companyCountry === entityCountry ? 'agree' : 'disagree';
    fields.push({
      field: 'country',
      level,
      similarity: level === 'agree' ? 1 : 0,
      logLikelihoodRatio: round6(llr(levelRates(config.country, level)!)),
    });
  }

  const companyAddress = normalizeAddressForMatch(company.address);
  const entityAddress = normalizeAddressForMatch(entity.address);
  if (companyAddress && entityAddress) {
    const similarity = trigramDice(companyAddress, entityAddress);
    const level = classify(similarity, config.addressAgreeSimilarity, config.addressPartialSimilarity);
    fields.push({
      field: 'address',
      level,
      similarity: round6(similarity),
      logLikelihoodRatio: round6(llr(levelRates(config.address, level)!)),
    });
  }

  const priorLogOdds = Math.log(config.priorLinkProbability / (1 - config.priorLinkProbability));
  const logOdds = priorLogOdds + fields.reduce((sum, field) => sum + field.logLikelihoodRatio, 0);
  return {
    configVersion: 'fellegi_sunter_v1',
    blockingKey,
    logOdds: round6(logOdds),
    posterior: round6(sigmoid(logOdds)),
    fields,
    thresholds: { auto: config.autoThreshold, review: config.reviewThreshold },
  };
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

export interface LinkDecision {
  entity: LegalEntityCandidate;
  status: LegalLinkStatus;
  matchMethod: LegalLinkMethod;
  matchRule: string;
  confidence: number;
  evidence: Record<string, unknown>;
}

export interface DecideOptions {
  config?: MatchConfig;
  /** VIES 校验注入点（真实 REST 或 fixture）；缺省 = 未校验，VAT 命中落 review。 */
  vatValidator?: VatValidator | null;
}

/**
 * 判定一个公司与一批候选实体的全部链接。确定性键优先；只有与公司**没有任何同 scheme
 * 确定性关系**（既不命中也不冲突）的实体才进入概率匹配。输出按状态强度与置信度排序。
 */
export async function decideCompanyLegalLinks(
  company: CompanyIdentitySnapshot,
  entities: ReadonlyArray<LegalEntityCandidate>,
  options: DecideOptions = {},
): Promise<LinkDecision[]> {
  const config = options.config ?? DEFAULT_MATCH_CONFIG;
  const decisions: LinkDecision[] = [];
  const seen = new Set<string>();

  for (const entity of entities) {
    // 实体身份 = scheme+country+value（同号异国是不同实体行）。
    const identity = `${entity.scheme}:${entity.country}:${entity.value}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    const sameScheme = company.identifiers.filter((identifier) =>
      identifierAppliesTo(identifier, entity),
    );
    const conflicting = sameScheme.filter((identifier) => identifier.value !== entity.value);
    if (conflicting.length > 0) {
      // 同名异法人反例：公司自身的确定性键排除了该实体，名字/地址再像也不连。
      // 只为「若无键冲突本会达到 review 以上」的实体留 rejected 档（可审计的反例），
      // 显然不相似的实体不落行——避免给同国每个不相关实体写拒绝噪音。
      const assessment = scoreProbabilistic(company, entity, config);
      if (!assessment || assessment.posterior < config.reviewThreshold) continue;
      decisions.push({
        entity,
        status: 'rejected',
        matchMethod: 'deterministic',
        matchRule: 'identifier_conflict',
        confidence: 0,
        evidence: {
          scheme: entity.scheme,
          companyValues: conflicting.map((identifier) => identifier.value).sort(),
          entityValue: entity.value,
          wouldBePosterior: assessment.posterior,
          fields: assessment.fields,
        },
      });
      continue;
    }

    const matching = sameScheme.filter((identifier) => identifier.value === entity.value);
    if (matching.length > 0) {
      decisions.push(await decideDeterministic(entity, options.vatValidator ?? null));
      continue;
    }

    const assessment = scoreProbabilistic(company, entity, config);
    if (!assessment) continue;
    if (assessment.posterior < config.reviewThreshold) continue;
    decisions.push({
      entity,
      status: assessment.posterior >= config.autoThreshold ? 'auto' : 'review',
      matchMethod: 'probabilistic',
      matchRule: assessment.configVersion,
      confidence: assessment.posterior,
      evidence: { ...assessment },
    });
  }

  const rank: Record<LegalLinkStatus, number> = { auto: 0, review: 1, rejected: 2 };
  decisions.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      b.confidence - a.confidence ||
      `${a.entity.scheme}:${a.entity.value}`.localeCompare(`${b.entity.scheme}:${b.entity.value}`),
  );
  return decisions;
}

/** 国家域内编号（HRB/SIREN/CH/KVK/CVR/bolagsverket/other）只在同一国家内可比较；
 *  LEI 全球唯一，与国家无关。公司标识缺国家时不做国家约束（宁可信其有）。 */
const COUNTRY_SCOPED_SCHEMES: ReadonlySet<LegalEntityScheme> = new Set([
  'vat',
  'hrb',
  'siren',
  'ch',
  'kvk',
  'cvr',
  'bolagsverket',
  'other',
]);

function identifierAppliesTo(
  identifier: { scheme: LegalEntityScheme; value: string; country?: string | null },
  entity: LegalEntityCandidate,
): boolean {
  if (identifier.scheme !== entity.scheme) return false;
  if (!COUNTRY_SCOPED_SCHEMES.has(identifier.scheme)) return true;
  const country = (identifier.country ?? '').trim().toUpperCase();
  return country === '' || country === entity.country.trim().toUpperCase();
}

async function decideDeterministic(
  entity: LegalEntityCandidate,
  vatValidator: VatValidator | null,
): Promise<LinkDecision> {
  const rule = `${entity.scheme}_exact`;
  const baseEvidence: Record<string, unknown> = { scheme: entity.scheme, value: entity.value };

  if (entity.scheme === 'vat' && vatValidator) {
    let vies: Record<string, unknown>;
    try {
      const result = await vatValidator.validate(entity.value);
      vies = { provider: result.provider, valid: result.valid };
    } catch {
      vies = { provider: vatValidator.provider, valid: null, unavailable: true };
    }
    const valid = vies.valid === true;
    return {
      entity,
      status: valid ? 'auto' : 'review',
      matchMethod: 'deterministic',
      matchRule: rule,
      confidence: valid ? 1 : 0.6,
      evidence: { ...baseEvidence, vies },
    };
  }

  const strength = SCHEME_STRENGTH[entity.scheme];
  return {
    entity,
    // VAT（未经 VIES）与 HRB/other 的唯一性有 caveat：命中只落人工复核档。
    status: strength === 'hard' ? 'auto' : 'review',
    matchMethod: 'deterministic',
    matchRule: rule,
    confidence: strength === 'hard' ? 1 : 0.8,
    evidence: baseEvidence,
  };
}
