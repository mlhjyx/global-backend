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
}

export interface QualifyResult {
  /** match=符合 ICP；exclude=命中排除；no_match=必要条件不满足；review=数据不足无法判定 */
  verdict: 'match' | 'exclude' | 'no_match' | 'review';
  /** NICE_TO_HAVE 加权得分 0..1（无 nice-to-have 规则时为 null） */
  score: number | null;
  evaluations: RuleEvaluation[];
}

const norm = (v: unknown): string => String(v).trim().toLowerCase();

/** Case-insensitive attribute lookup; supports snake/camel variants. */
function getAttr(attributes: Record<string, unknown>, field: string): unknown {
  if (field in attributes) return attributes[field];
  const target = field.toLowerCase().replace(/[_\s-]/g, '');
  for (const [k, v] of Object.entries(attributes)) {
    if (k.toLowerCase().replace(/[_\s-]/g, '') === target) return v;
  }
  return undefined;
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
 */
export function qualify(rules: RuleLike[], attributes: Record<string, unknown>): QualifyResult {
  const evaluations: RuleEvaluation[] = rules.map((r) => ({
    ruleId: r.id,
    kind: r.kind,
    field: r.field,
    operator: r.operator,
    outcome: evaluateRule(r, attributes),
  }));

  const of = (kind: RuleKind) => evaluations.filter((e) => e.kind === kind);

  if (of('EXCLUSION').some((e) => e.outcome === 'pass')) {
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
