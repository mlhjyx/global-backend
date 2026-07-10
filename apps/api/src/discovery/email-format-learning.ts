/**
 * 公司邮箱格式学习（选项 B · P0，纯逻辑不触网）。
 *
 * 思路：一家公司通常**只用一种**邮箱命名法。若已从官网抽到该公司**某一个**具名人的邮箱
 * （如 `s.vogt@acme.de` 对应 "Sabine Vogt"），即可反推格式 `f.last`，再**套用到同公司其他决策人**
 * → 命中率远高于盲排列（{@link ./email-permutation}）。多个已知样本一致 → 置信更高。
 *
 * 与 {@link ./email-permutation} 共享同一套模式定义（KNOWN_PATTERNS/buildLocalPart，DRY）。
 * 🔴 合规同排列器：产出仍是**候选**，未经 SMTP 证实不当既成事实；是人名邮箱，下游过 lawful-basis 门。
 */
import {
  EmailCandidate,
  KNOWN_PATTERNS,
  buildLocalPart,
  parseName,
  transliterateVariants,
} from './email-permutation';

/** 已知的 (姓名, 邮箱) 样本（同一公司）。 */
export interface KnownEmailSample {
  fullName: string;
  email: string;
}

/** 学习结果：胜出的命名法 + 支持度。 */
export interface LearnedFormat {
  /** 胜出模式标签（如 `f.last`）。 */
  pattern: string;
  /** 支持该模式的样本数。 */
  support: number;
  /** 有效样本总数（能解析且吻合某模式）。 */
  samples: number;
  /** 置信度（1 个一致样本≈0.6，多个一致更高，封顶 0.95）。 */
  confidence: number;
}

/** 某姓名在各音译变体下的 {first,fi,last,li} 组合（供正/反向构造复用）。 */
function partsVariants(fullName: string): { first: string; fi: string; last: string; li: string }[] {
  const parsed = parseName(fullName);
  if (!parsed) return [];
  const firsts = transliterateVariants(parsed.given);
  const lastSources = parsed.surname
    ? Array.from(new Set([parsed.surname.replace(/\s+/g, ''), parsed.surnameCore]))
    : [];
  const lasts = lastSources.flatMap(transliterateVariants);
  const combos: { first: string; fi: string; last: string; li: string }[] = [];
  for (const first of firsts) {
    for (const last of lasts.length ? lasts : ['']) {
      combos.push({ first, fi: first.charAt(0), last, li: last.charAt(0) });
    }
  }
  return combos;
}

/** 单样本：local-part 命中了哪些模式（可能多个，如单 token 名有歧义）。 */
function matchingPatterns(fullName: string, localPart: string): string[] {
  const local = localPart.toLowerCase();
  const combos = partsVariants(fullName);
  const hits: string[] = [];
  for (const { label } of KNOWN_PATTERNS) {
    for (const parts of combos) {
      if (buildLocalPart(label, parts) === local) {
        hits.push(label);
        break;
      }
    }
  }
  return hits;
}

/**
 * 从已知样本反推公司命名法。样本需能解析姓名且邮箱 local-part 与其某模式吻合。
 * 多样本投票：出现在最多样本里的模式胜出；平票取先验更高者（更普遍的命名法）。
 * @returns null 表示无法确定（无有效样本或全不吻合）。
 */
export function inferEmailPattern(samples: KnownEmailSample[]): LearnedFormat | null {
  const priorOf = new Map(KNOWN_PATTERNS.map((p) => [p.label, p.prior]));
  const votes = new Map<string, number>();
  let valid = 0;
  for (const s of samples) {
    const at = s.email.indexOf('@');
    if (at <= 0) continue;
    const local = s.email.slice(0, at).toLowerCase();
    const hits = matchingPatterns(s.fullName, local);
    if (hits.length === 0) continue;
    valid += 1;
    for (const label of hits) votes.set(label, (votes.get(label) ?? 0) + 1);
  }
  if (valid === 0 || votes.size === 0) return null;

  let best: { label: string; count: number } | null = null;
  for (const [label, count] of votes) {
    if (
      !best ||
      count > best.count ||
      (count === best.count && (priorOf.get(label) ?? 0) > (priorOf.get(best.label) ?? 0))
    ) {
      best = { label, count };
    }
  }
  if (!best) return null;
  // 置信度：单一致样本给 0.6 基线，多样本一致线性抬升，封顶 0.95。
  const confidence = Math.min(0.95, 0.6 + (best.count - 1) * 0.15);
  return { pattern: best.label, support: best.count, samples: valid, confidence };
}

/**
 * 用学到的命名法为目标姓名构造候选（单条高置信）。音译产生多变体时全给出，按学习置信排序。
 * @returns 空数组表示该姓名无法用此模式构造（如缺姓）。
 */
export function applyLearnedPattern(
  learned: LearnedFormat,
  fullName: string,
  domain: string,
): EmailCandidate[] {
  const dom = domain.trim().toLowerCase().replace(/^@/, '').replace(/^www\./, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dom)) return [];
  const seen = new Set<string>();
  const out: EmailCandidate[] = [];
  for (const parts of partsVariants(fullName)) {
    const local = buildLocalPart(learned.pattern, parts);
    if (!local) continue;
    const email = `${local}@${dom}`;
    if (seen.has(email)) continue;
    seen.add(email);
    // prior 用学习置信度（压过盲排列的经验先验）
    out.push({ email, pattern: `learned:${learned.pattern}`, prior: learned.confidence });
  }
  return out;
}
