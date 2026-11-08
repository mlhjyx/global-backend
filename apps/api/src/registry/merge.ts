/**
 * 确定性归并 v0（ch03 §3.16 子集，纯函数）：
 *
 *  - 硬键（自动判定，写 CONFIRMED）：LEI 完全一致；注册号交叉引用（一方的 identifiers
 *    命中另一方的业务主键，namespace 按 scheme 隔离）。
 *  - 半硬键（确定性分组、人工确认，写 PROPOSED）：VAT 一致。VAT 在税组（如 DE Organschaft）
 *    可跨法人共享，VIES 校验（后续波次）前不自动合并。
 *  - 域名一致（写 PROPOSED / UNCERTAIN）：同域通常是集团门户或同实体多国注册，
 *    必须人工判定 SAME 还是 BRANCH。
 *  - 名称 trigram：只生成候选对（PROPOSED / UNCERTAIN，rule=name_trigram），绝不自动合并。
 *    Müller GmbH 在每个城市都有一家——误并会把两家公司串成一条链。
 *
 * 输出规范：一对实体不论输入顺序，left/right 按 (scheme, regNumber) 字典序规范化；
 * 同一对只保留最强规则（lei > identifier > vat > domain > trigram），其余证据并入
 * evidence.alsoMatchedBy。输入顺序不影响输出（确定性）。
 */
import { normalizeDomain } from '../discovery/identity';
import { normalizeLei, normalizeVatId } from './frame-normalize';

export type LinkType = 'SAME' | 'PARENT' | 'SUBSIDIARY' | 'BRANCH' | 'UNCERTAIN';
export type LinkStatus = 'PROPOSED' | 'CONFIRMED';

export interface LinkableEntity {
  scheme: string;
  regNumber: string;
  country: string;
  nameNorm: string;
  lei?: string | null;
  vatId?: string | null;
  website?: string | null;
  identifiers?: Array<{ scheme: string; value: string }> | null;
}

export interface EntityLinkProposal {
  leftScheme: string;
  leftRegNumber: string;
  rightScheme: string;
  rightRegNumber: string;
  linkType: LinkType;
  rule: 'lei_exact' | 'identifier_exact' | 'vat_exact' | 'domain_exact' | 'name_trigram';
  score: number | null;
  evidence: Record<string, unknown> | null;
  status: LinkStatus;
}

interface RuleSpec {
  rule: EntityLinkProposal['rule'];
  linkType: LinkType;
  status: LinkStatus;
  /** 越小越强。 */
  strength: number;
}

const RULES: Record<EntityLinkProposal['rule'], RuleSpec> = {
  lei_exact: { rule: 'lei_exact', linkType: 'SAME', status: 'CONFIRMED', strength: 0 },
  identifier_exact: { rule: 'identifier_exact', linkType: 'SAME', status: 'CONFIRMED', strength: 1 },
  vat_exact: { rule: 'vat_exact', linkType: 'SAME', status: 'PROPOSED', strength: 2 },
  domain_exact: { rule: 'domain_exact', linkType: 'UNCERTAIN', status: 'PROPOSED', strength: 3 },
  name_trigram: { rule: 'name_trigram', linkType: 'UNCERTAIN', status: 'PROPOSED', strength: 4 },
};

function entityKey(entity: { scheme: string; regNumber: string }): string {
  return `${entity.scheme}\u0001${entity.regNumber}`;
}

function identifierToken(scheme: string, value: string): string | null {
  const normalized = value.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (!normalized) return null;
  return `${scheme.toLowerCase()}:${normalized}`;
}

function canonicalPair(
  a: LinkableEntity,
  b: LinkableEntity,
): { left: LinkableEntity; right: LinkableEntity } {
  const leftKey = `${a.scheme}|${a.regNumber}`;
  const rightKey = `${b.scheme}|${b.regNumber}`;
  return leftKey <= rightKey ? { left: a, right: b } : { left: b, right: a };
}

interface ProposalAccumulator {
  proposal: EntityLinkProposal;
  strength: number;
  alsoMatchedBy: string[];
}

function pairToken(a: LinkableEntity, b: LinkableEntity): string {
  const { left, right } = canonicalPair(a, b);
  return `${entityKey(left)}\u0002${entityKey(right)}`;
}

/** 字符 trigram（名称含空格；两端补边界符）。 */
export function trigrams(value: string): Set<string> {
  const padded = `\u0002${value}\u0003`;
  const grams = new Set<string>();
  for (let i = 0; i + 2 < padded.length; i++) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

/** Dice 系数：2|A∩B| / (|A|+|B|)，0..1。 */
export function trigramDice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const gram of left) {
    if (right.has(gram)) overlap++;
  }
  return (2 * overlap) / (left.size + right.size);
}

export interface ProposeLinksOptions {
  /** trigram 候选阈值（Dice，0..1）；低于阈值不产生候选对。 */
  nameThreshold?: number;
  /** 单个 blocking 桶超过该规模则跳过（防 O(n²) 爆炸；后续波次交给 Splink）。 */
  maxBlockSize?: number;
}

const DEFAULT_NAME_THRESHOLD = 0.6;
const DEFAULT_MAX_BLOCK_SIZE = 400;

export function proposeEntityLinks(
  entities: LinkableEntity[],
  options: ProposeLinksOptions = {},
): EntityLinkProposal[] {
  const threshold = options.nameThreshold ?? DEFAULT_NAME_THRESHOLD;
  const maxBlockSize = options.maxBlockSize ?? DEFAULT_MAX_BLOCK_SIZE;
  const byPair = new Map<string, ProposalAccumulator>();

  const record = (
    a: LinkableEntity,
    b: LinkableEntity,
    rule: EntityLinkProposal['rule'],
    score: number | null,
    evidence: Record<string, unknown>,
  ): void => {
    if (entityKey(a) === entityKey(b)) return;
    const token = pairToken(a, b);
    const spec = RULES[rule];
    const existing = byPair.get(token);
    if (!existing) {
      const { left, right } = canonicalPair(a, b);
      byPair.set(token, {
        proposal: {
          leftScheme: left.scheme,
          leftRegNumber: left.regNumber,
          rightScheme: right.scheme,
          rightRegNumber: right.regNumber,
          linkType: spec.linkType,
          rule: spec.rule,
          score,
          evidence,
          status: spec.status,
        },
        strength: spec.strength,
        alsoMatchedBy: [],
      });
      return;
    }
    if (spec.strength < existing.strength) {
      const { left, right } = canonicalPair(a, b);
      existing.alsoMatchedBy.push(`${existing.proposal.rule}@${existing.proposal.status}`);
      existing.proposal = {
        leftScheme: left.scheme,
        leftRegNumber: left.regNumber,
        rightScheme: right.scheme,
        rightRegNumber: right.regNumber,
        linkType: spec.linkType,
        rule: spec.rule,
        score,
        evidence,
        status: spec.status,
      };
      existing.strength = spec.strength;
      return;
    }
    if (spec.strength > existing.strength) {
      existing.alsoMatchedBy.push(`${spec.rule}@${spec.status}`);
      return;
    }
    if (spec.rule !== existing.proposal.rule) {
      existing.alsoMatchedBy.push(`${spec.rule}@${spec.status}`);
    }
  };

  const groupBy = (keyOf: (entity: LinkableEntity) => string | null): Map<string, LinkableEntity[]> => {
    const groups = new Map<string, LinkableEntity[]>();
    for (const entity of entities) {
      const key = keyOf(entity);
      if (!key) continue;
      const bucket = groups.get(key);
      if (bucket) bucket.push(entity);
      else groups.set(key, [entity]);
    }
    return groups;
  };

  // 硬键 1：LEI 完全一致。
  for (const bucket of groupBy((e) => {
    const lei = e.lei ? normalizeLei(e.lei) : null;
    return lei ? `lei:${lei}` : null;
  }).values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        record(bucket[i]!, bucket[j]!, 'lei_exact', null, {
          lei: normalizeLei(bucket[i]!.lei ?? ''),
        });
      }
    }
  }

  // 硬键 2：VAT（确定性分组，人工确认）。
  for (const bucket of groupBy((e) => {
    const vat = e.vatId ? normalizeVatId(e.vatId) : null;
    return vat ? `vat:${vat}` : null;
  }).values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        record(bucket[i]!, bucket[j]!, 'vat_exact', null, {
          vatId: normalizeVatId(bucket[i]!.vatId ?? ''),
        });
      }
    }
  }

  // 硬键 3：注册号交叉引用（identifiers ↔ 业务主键；scheme 命名空间隔离）。
  const byIdentifier = new Map<string, LinkableEntity[]>();
  const addIdentifier = (token: string | null, entity: LinkableEntity): void => {
    if (!token) return;
    const bucket = byIdentifier.get(token);
    if (bucket) bucket.push(entity);
    else byIdentifier.set(token, [entity]);
  };
  for (const entity of entities) {
    addIdentifier(identifierToken(entity.scheme, entity.regNumber), entity);
    for (const identifier of entity.identifiers ?? []) {
      addIdentifier(identifierToken(identifier.scheme, identifier.value), entity);
    }
  }
  for (const [token, bucket] of byIdentifier) {
    const distinct = [...new Map(bucket.map((entity) => [entityKey(entity), entity])).values()];
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) {
        record(distinct[i]!, distinct[j]!, 'identifier_exact', null, { identifier: token });
      }
    }
  }

  // 域名一致（人工判定 SAME/BRANCH）。
  for (const bucket of groupBy((e) => {
    const domain = e.website ? normalizeDomain(e.website) : null;
    return domain ? `domain:${domain}` : null;
  }).values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        record(bucket[i]!, bucket[j]!, 'domain_exact', null, {
          domain: normalizeDomain(bucket[i]!.website ?? ''),
        });
      }
    }
  }

  // 名称 trigram 候选对：blocking = 国家 + nameNorm 前 4 字符（ch03 §3.16.3）。
  const blocks = new Map<string, LinkableEntity[]>();
  for (const entity of entities) {
    if (!entity.nameNorm) continue;
    const key = `${entity.country}\u0001${entity.nameNorm.slice(0, 4)}`;
    const bucket = blocks.get(key);
    if (bucket) bucket.push(entity);
    else blocks.set(key, [entity]);
  }
  for (const bucket of blocks.values()) {
    if (bucket.length < 2 || bucket.length > maxBlockSize) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        if (byPair.has(pairToken(a, b))) continue;
        const score = trigramDice(a.nameNorm, b.nameNorm);
        if (score < threshold) continue;
        record(a, b, 'name_trigram', Number(score.toFixed(6)), {
          nameSimilarity: Number(score.toFixed(6)),
          threshold,
        });
      }
    }
  }

  const proposals = [...byPair.values()].map(({ proposal, alsoMatchedBy }) => {
    if (alsoMatchedBy.length > 0) {
      proposal.evidence = { ...(proposal.evidence ?? {}), alsoMatchedBy: [...new Set(alsoMatchedBy)].sort() };
    }
    return proposal;
  });
  proposals.sort((a, b) => {
    const left = `${a.leftScheme}|${a.leftRegNumber}|${a.rightScheme}|${a.rightRegNumber}|${a.rule}`;
    const right = `${b.leftScheme}|${b.leftRegNumber}|${b.rightScheme}|${b.rightRegNumber}|${b.rule}`;
    return left.localeCompare(right);
  });
  return proposals;
}
