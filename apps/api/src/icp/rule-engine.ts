/**
 * Deterministic qualification-rule engine (LED-003/004, PRD 7.5).
 * AI proposes rules; THIS code decides — evaluation must be reproducible and
 * auditable, so no LLM anywhere in here. Reused by ICP backtests (P2) and the
 * Fit dimension of lead scoring (P4).
 */

export type RuleKind = 'MUST_HAVE' | 'NICE_TO_HAVE' | 'EXCLUSION';
export type RuleOutcome = 'pass' | 'fail' | 'unknown';

export interface RuleLike {
  id?: string;
  kind: RuleKind;
  field: string;
  operator: string;
  value: unknown;
  weight?: number;
}

export interface RuleEvaluation {
  ruleId?: string;
  kind: RuleKind;
  field: string;
  operator: string;
  outcome: RuleOutcome;
  /**
   * 评分规则 v3：权威 Fit（ICP 资格门）存在时，MUST_HAVE 的镜像 EXCLUSION 的命中只记录、不改判定
   *（`QualifyOptions.mirrorExclusionsAdvisory`）。只在为 true 时出现。
   */
  advisory?: true;
}

export interface QualifyResult {
  /** match=符合 ICP；exclude=命中排除；no_match=必要条件不满足；review=数据不足无法判定 */
  verdict: 'match' | 'exclude' | 'no_match' | 'review';
  /** NICE_TO_HAVE 加权得分 0..1（无 nice-to-have 规则时为 null） */
  score: number | null;
  evaluations: RuleEvaluation[];
}

export interface QualifyOptions {
  /**
   * MUST_HAVE 的镜像 EXCLUSION（`mirrorExclusionRuleIndexes`：同 field 同 value、否定操作符）只评估、只记录
   *（evaluation.advisory=true），不产生 `exclude`。评分在 ICP 资格门（LLM 四门）已给出权威 Fit 时打开：ICP 生成
   * 常把 MUST_HAVE 镜像成否定型 EXCLUSION（MUST_HAVE `keywords contains "泵"` + EXCLUSION `keywords not_contains "泵"`），
   * 而公司属性是受控英文词表、永远不含中文，镜像规则对每家公司都 pass，带 keywords 的公司一律 rejected
   *（xin ICP 22202d3c：6 条镜像）。
   * 只降级镜像（W5-f 收窄）：不是镜像的否定型 EXCLUSION（如用户手加的 `country not_in [DE, AT, CH]`）与正向
   * EXCLUSION（contains / in / eq / gte / lte / matches）一样照旧排除、最高优先；`lintQualificationRules` 对前者提示。
   */
  mirrorExclusionsAdvisory?: boolean;
}

/** 否定操作符：「属性存在且不含/不等/不在 → pass」，作为 EXCLUSION 时与 MUST_HAVE 互为镜像。 */
export const NEGATIVE_OPERATORS: ReadonlySet<string> = new Set(['neq', 'not_in', 'not_contains']);

export function isNegativeOperator(operator: string): boolean {
  return NEGATIVE_OPERATORS.has(operator);
}

const norm = (v: unknown): string => String(v).trim().toLowerCase();

/** Case-insensitive attribute lookup; supports snake/camel variants. */
function getAttr(attributes: Record<string, unknown>, field: string): unknown {
  if (field in attributes) return attributes[field];
  const target = normField(field);
  for (const [k, v] of Object.entries(attributes)) {
    if (normField(k) === target) return v;
  }
  return undefined;
}

function normField(field: unknown): string {
  return String(field ?? '').toLowerCase().replace(/[_\s-]/g, '');
}

/** Parse numbers including range strings ("51-200", "200+") → [min, max]. */
function toRange(v: unknown): [number, number] | null {
  if (typeof v === 'number' && Number.isFinite(v)) return [v, v];
  const s = String(v).replace(/[,\s]/g, '');
  const range = s.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
  if (range) return [Number(range[1]), Number(range[2])];
  const plus = s.match(/^(\d+(?:\.\d+)?)\+$/);
  if (plus) return [Number(plus[1]), Number.POSITIVE_INFINITY];
  const n = Number(s);
  return Number.isFinite(n) ? [n, n] : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

/** any element of a equals (ci) any element of b */
function anyEqual(a: unknown[], b: unknown[]): boolean {
  const bn = b.map(norm);
  return a.some((x) => bn.includes(norm(x)));
}

/** any element of haystack contains (substring, ci) any element of needles */
function anyContains(haystack: unknown[], needles: unknown[]): boolean {
  const ns = needles.map(norm);
  return haystack.some((h) => {
    const hs = norm(h);
    return ns.some((n) => hs.includes(n));
  });
}

export function evaluateRule(rule: RuleLike, attributes: Record<string, unknown>): RuleOutcome {
  const attr = getAttr(attributes, rule.field);
  if (attr === undefined || attr === null || (typeof attr === 'string' && !attr.trim())) {
    return 'unknown';
  }
  const attrArr = asArray(attr);
  const valArr = asArray(rule.value);

  switch (rule.operator) {
    case 'eq':
      return anyEqual(attrArr, valArr) ? 'pass' : 'fail';
    case 'neq':
      return anyEqual(attrArr, valArr) ? 'fail' : 'pass';
    case 'in':
      return anyEqual(attrArr, valArr) ? 'pass' : 'fail';
    case 'not_in':
      return anyEqual(attrArr, valArr) ? 'fail' : 'pass';
    case 'contains':
      return anyContains(attrArr, valArr) ? 'pass' : 'fail';
    case 'not_contains':
      return anyContains(attrArr, valArr) ? 'fail' : 'pass';
    case 'gte': {
      const a = toRange(attr);
      const b = toRange(valArr[0]);
      if (!a || !b) return 'unknown';
      return a[1] >= b[0] ? 'pass' : 'fail'; // range upper bound reaches threshold
    }
    case 'lte': {
      const a = toRange(attr);
      const b = toRange(valArr[0]);
      if (!a || !b) return 'unknown';
      return a[0] <= b[0] ? 'pass' : 'fail';
    }
    case 'matches': {
      try {
        const re = new RegExp(String(valArr[0]), 'i');
        return attrArr.some((x) => re.test(String(x))) ? 'pass' : 'fail';
      } catch {
        return 'unknown'; // malformed pattern must not crash qualification
      }
    }
    default:
      return 'unknown';
  }
}

/**
 * Qualify one company's attributes against an ICP's rules.
 * Precedence (PRD 7.5): EXCLUSION hit → exclude; MUST_HAVE fail → no_match;
 * MUST_HAVE unknown → review (数据不足，不硬判); otherwise match + weighted score.
 * With `mirrorExclusionsAdvisory`, an EXCLUSION that mirrors a MUST_HAVE is evaluated
 * and recorded but never produces `exclude`; every other EXCLUSION still does (see QualifyOptions).
 */
export function qualify(
  rules: RuleLike[],
  attributes: Record<string, unknown>,
  options?: QualifyOptions,
): QualifyResult {
  const advisory = new Set(options?.mirrorExclusionsAdvisory === true ? mirrorExclusionRuleIndexes(rules) : []);
  const evaluations: RuleEvaluation[] = rules.map((r, index) => ({
    ruleId: r.id,
    kind: r.kind,
    field: r.field,
    operator: r.operator,
    outcome: evaluateRule(r, attributes),
    ...(advisory.has(index) ? { advisory: true as const } : {}),
  }));

  const of = (kind: RuleKind) => evaluations.filter((e) => e.kind === kind);

  if (of('EXCLUSION').some((e) => e.outcome === 'pass' && !e.advisory)) {
    return { verdict: 'exclude', score: null, evaluations };
  }
  if (of('MUST_HAVE').some((e) => e.outcome === 'fail')) {
    return { verdict: 'no_match', score: scoreNiceToHave(rules, evaluations), evaluations };
  }
  if (of('MUST_HAVE').some((e) => e.outcome === 'unknown')) {
    return { verdict: 'review', score: scoreNiceToHave(rules, evaluations), evaluations };
  }
  return { verdict: 'match', score: scoreNiceToHave(rules, evaluations), evaluations };
}

function scoreNiceToHave(rules: RuleLike[], evaluations: RuleEvaluation[]): number | null {
  const nice = rules
    .map((r, i) => ({ rule: r, ev: evaluations[i] }))
    .filter(({ rule }) => rule.kind === 'NICE_TO_HAVE');
  if (!nice.length) return null;
  const total = nice.reduce((s, { rule }) => s + (rule.weight ?? 1), 0);
  const got = nice
    .filter(({ ev }) => ev.outcome === 'pass')
    .reduce((s, { rule }) => s + (rule.weight ?? 1), 0);
  return total > 0 ? Number((got / total).toFixed(4)) : null;
}

// ── 镜像 EXCLUSION（评分规则 v3）──────────────────────────────────────────────

/** 规则的「field + value」身份：field 归一化（大小写 / 下划线 / 空白），value 归一化为排序后的元素集合。 */
function ruleIdentity(rule: Pick<RuleLike, 'field' | 'value'>): string {
  const values = asArray(rule.value)
    .map(norm)
    .filter((v) => v.length > 0)
    .sort();
  return `${normField(rule.field)}\n${JSON.stringify(values)}`;
}

/**
 * 与某条 MUST_HAVE 同 field 同 value、且用否定操作符的 EXCLUSION 规则的下标。
 * 这样的规则是 MUST_HAVE 的镜像：MUST_HAVE 不满足时本就 no_match，镜像只会在词表不一致时把
 * 本应「复核」的公司硬排除。ICP 生成时丢弃（icp.service），读取 / 激活时作 lint 提示（IcpDto.ruleLint）。
 */
export function mirrorExclusionRuleIndexes(rules: readonly RuleLike[]): number[] {
  const mustHave = new Set(rules.filter((r) => r.kind === 'MUST_HAVE').map(ruleIdentity));
  if (mustHave.size === 0) return [];
  return rules.flatMap((rule, index) =>
    rule.kind === 'EXCLUSION' && isNegativeOperator(rule.operator) && mustHave.has(ruleIdentity(rule))
      ? [index]
      : [],
  );
}

/**
 * 人可读的规则提示，供激活 / 读取 ICP 时展示（按规则顺序，一条规则至多一行）；无问题 → 空数组：
 *  - MUST_HAVE 的镜像 EXCLUSION：资格门已判 Fit 时只记录不排除，建议删除；
 *  - 不是镜像的否定型 EXCLUSION（W5-f）：资格门已判 Fit 时**仍然排除**——「属性有值且不在 / 不含 / 不等」
 *    即排除，取值写法与公司属性不一致（中文词 vs 受控英文词表、「德国」vs ISO 代码）时会排除所有公司，请确认本意。
 */
export function lintQualificationRules(rules: readonly RuleLike[]): string[] {
  const mirrors = new Set(mirrorExclusionRuleIndexes(rules));
  return rules.flatMap((rule, index) => {
    if (rule.kind !== 'EXCLUSION' || !isNegativeOperator(rule.operator)) return [];
    const label = rule.id ? `规则 ${rule.id}` : `第 ${index + 1} 条规则`;
    const subject = `${label}：EXCLUSION ${rule.field} ${rule.operator} ${JSON.stringify(rule.value)}`;
    if (mirrors.has(index)) {
      return [
        `${subject} 是 MUST_HAVE 的镜像（同 field 同 value）。公司属性是受控英文词表时它对每家公司都命中；` +
          `资格门已判 Fit 时只记录不排除。建议删除。`,
      ];
    }
    return [
      `${subject} 是否定型排除：属性有值且不满足所列取值的公司一律排除，资格门已判 Fit 时仍然排除。` +
        `取值写法须与公司属性一致（受控英文词表、ISO 国家代码），否则会排除所有公司；请确认这是本意。`,
    ];
  });
}
