/**
 * ch01 PR-05：度量告警评估引擎（纯函数，无数据库依赖）。
 *
 * 规则文件：docs/metrics/alerts/rules.v1.json（metrics-lint 校验结构与指标
 * 存在性）。评估输入是从 metric_rollup_daily / metric_rollup_weekly /
 * metric_observation 读出的快照行，由 apps/api/scripts/measurement-alerts.mts
 * 负责取数并调用这里。
 *
 * 两类规则：
 *  - threshold：对指定粒度的 rollup 桶做阈值比较（below/above，严格不等号）；
 *    aggregation=mean 时取最近 lookbackBuckets 个已观测桶的算术平均；
 *    minSample 用分母（缺失视为不足）；stratumEquals 逐键字符串相等匹配，
 *    未命中任何桶是 NO_DATA 而不是 OK——数据缺失不能被当成健康。
 *  - freshness：最新数据时间（观测的 window_end / rollup 桶的结束时刻）距
 *    asOf 超过 maxAgeHours 即 FIRING。
 *
 * 本模块不写任何表、不发通知：告警的消费（看板/渠道）由后续切片接线。
 */

export type AlertSeverity = "WARNING" | "CRITICAL";
export type AlertKind = "threshold" | "freshness";
export type AlertStatus = "OK" | "FIRING" | "NO_DATA" | "INSUFFICIENT_DATA";
export type RollupGranularity = "daily" | "weekly";

export interface ThresholdAlertRule {
  id: string;
  metricId: string;
  severity: AlertSeverity;
  kind: "threshold";
  owner: string;
  description: string;
  comparison: "below" | "above";
  bound: number;
  granularity: RollupGranularity;
  aggregation?: "latest" | "mean";
  lookbackBuckets?: number;
  minSample?: number;
  stratumEquals: Record<string, string>;
}

export interface FreshnessAlertRule {
  id: string;
  metricId: string;
  severity: AlertSeverity;
  kind: "freshness";
  owner: string;
  description: string;
  source: "observation" | "rollup";
  granularity?: RollupGranularity;
  maxAgeHours: number;
}

export type AlertRule = ThresholdAlertRule | FreshnessAlertRule;

/** One rollup row as read from the database. */
export interface AlertSample {
  metricId: string;
  metricVersion: number;
  stratum: Record<string, unknown>;
  /** YYYY-MM-DD: daily `day`, weekly week-start `week`. */
  bucket: string;
  value: number;
  denominator: number | null;
  granularity: RollupGranularity;
}

export interface AlertEvaluation {
  ruleId: string;
  metricId: string;
  severity: AlertSeverity;
  kind: AlertKind;
  status: AlertStatus;
  message: string;
  evaluatedAt: string;
  bucket?: string;
  buckets?: string[];
  observedValue?: number;
  bound?: number;
  comparison?: "below" | "above";
  sampleDenominator?: number | null;
  latestDataAt?: string;
  ageHours?: number;
  maxAgeHours?: number;
}

export interface AlertSummary {
  total: number;
  firing: number;
  ok: number;
  noData: number;
  insufficientData: number;
  worstSeverity: AlertSeverity | null;
  /** 0 = 无告警；10 = 有 WARNING；20 = 有 CRITICAL（运维脚本按此退出）。 */
  exitCode: number;
}

const SEVERITIES: ReadonlySet<string> = new Set(["WARNING", "CRITICAL"]);
const KINDS: ReadonlySet<string> = new Set(["threshold", "freshness"]);
const GRANULARITIES: ReadonlySet<string> = new Set(["daily", "weekly"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * CLI 侧运行时校验：规则文件先过这里再评估（metrics-lint 是提交期门禁，
 * 这里保证手工传入的 --rules 文件同样不能带病运行）。语义校验保持最小，
 * 结构错误一律抛 ALERT_RULES_INVALID。
 */
export function assertAlertRules(document: unknown): AlertRule[] {
  const fail = (message: string): never => {
    throw new Error(`ALERT_RULES_INVALID: ${message}`);
  };
  if (!isRecord(document) || document.schemaVersion !== "measurement-alerts/v1") {
    fail('schemaVersion must be "measurement-alerts/v1"');
  }
  const rules = (document as Record<string, unknown>).rules;
  if (!Array.isArray(rules) || rules.length === 0) fail("rules must be a non-empty array");
  const seen = new Set<string>();
  return (rules as unknown[]).map((raw, index) => {
    if (!isRecord(raw)) return fail(`rules[${index}] must be an object`);
    const id = raw.id;
    if (typeof id !== "string" || !/^AL-\d{3}$/.test(id)) fail(`rules[${index}].id is invalid`);
    if (seen.has(id as string)) fail(`duplicate rule id ${id}`);
    seen.add(id as string);
    if (typeof raw.metricId !== "string" || raw.metricId === "") fail(`${id}.metricId is required`);
    if (!SEVERITIES.has(raw.severity as string)) fail(`${id}.severity must be WARNING or CRITICAL`);
    if (!KINDS.has(raw.kind as string)) fail(`${id}.kind must be threshold or freshness`);
    if (typeof raw.owner !== "string" || raw.owner === "") fail(`${id}.owner is required`);
    if (typeof raw.description !== "string" || raw.description.trim().length < 10) {
      fail(`${id}.description must be a non-trivial string`);
    }
    if (raw.kind === "threshold") {
      if (raw.comparison !== "below" && raw.comparison !== "above") {
        fail(`${id}.comparison must be below or above`);
      }
      if (typeof raw.bound !== "number" || !Number.isFinite(raw.bound)) fail(`${id}.bound must be a number`);
      if (!GRANULARITIES.has(raw.granularity as string)) fail(`${id}.granularity must be daily or weekly`);
      if (raw.aggregation !== undefined && raw.aggregation !== "latest" && raw.aggregation !== "mean") {
        fail(`${id}.aggregation must be latest or mean`);
      }
      if (raw.lookbackBuckets !== undefined && (!Number.isInteger(raw.lookbackBuckets) || (raw.lookbackBuckets as number) < 1)) {
        fail(`${id}.lookbackBuckets must be a positive integer`);
      }
      if (raw.minSample !== undefined && (!Number.isInteger(raw.minSample) || (raw.minSample as number) < 1)) {
        fail(`${id}.minSample must be a positive integer`);
      }
      const stratumEquals = raw.stratumEquals;
      if (!isRecord(stratumEquals) || Object.keys(stratumEquals).length === 0) {
        return fail(`${id}.stratumEquals must be a non-empty object`);
      }
      for (const [key, value] of Object.entries(stratumEquals)) {
        if (typeof value !== "string") fail(`${id}.stratumEquals.${key} must be a string`);
      }
    } else {
      if (raw.source !== "observation" && raw.source !== "rollup") {
        fail(`${id}.source must be observation or rollup`);
      }
      if (raw.source === "rollup" && !GRANULARITIES.has(raw.granularity as string)) {
        fail(`${id}.granularity is required for rollup freshness rules`);
      }
      if (raw.granularity !== undefined && !GRANULARITIES.has(raw.granularity as string)) {
        fail(`${id}.granularity must be daily or weekly`);
      }
      if (!Number.isInteger(raw.maxAgeHours) || (raw.maxAgeHours as number) < 1) {
        fail(`${id}.maxAgeHours must be a positive integer`);
      }
    }
    return raw as unknown as AlertRule;
  });
}

/** Every key of `expected` must exist on the sample's stratum and equal it as a string. */
export function stratumMatches(stratum: Record<string, unknown>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(
    ([key, value]) => key in stratum && String(stratum[key]) === value,
  );
}

function asOfDay(asOf: Date): string {
  return asOf.toISOString().slice(0, 10);
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Threshold evaluation over one granularity's rollup samples.
 *
 * Bucket selection: only buckets at or before asOf's UTC day are eligible,
 * ordered newest-first (ISO dates sort lexicographically), then the newest
 * `lookbackBuckets` observed buckets are used — the count is over observed
 * buckets, not calendar slots; freshness gaps are what freshness rules watch.
 * Per bucket the highest metricVersion wins.
 */
export function evaluateThresholdRule(
  rule: ThresholdAlertRule,
  samples: readonly AlertSample[],
  asOf: Date,
): AlertEvaluation {
  const evaluatedAt = asOf.toISOString();
  const base: AlertEvaluation = {
    ruleId: rule.id,
    metricId: rule.metricId,
    severity: rule.severity,
    kind: "threshold",
    status: "NO_DATA",
    message: "",
    evaluatedAt,
    bound: rule.bound,
    comparison: rule.comparison,
  };
  const aggregation = rule.aggregation ?? "latest";
  const lookback = aggregation === "mean" ? (rule.lookbackBuckets ?? 7) : 1;
  const cutoff = asOfDay(asOf);
  const byBucket = new Map<string, AlertSample>();
  for (const sample of samples) {
    if (sample.metricId !== rule.metricId) continue;
    if (sample.granularity !== rule.granularity) continue;
    if (sample.bucket > cutoff) continue;
    if (!stratumMatches(sample.stratum, rule.stratumEquals)) continue;
    const existing = byBucket.get(sample.bucket);
    if (!existing || sample.metricVersion > existing.metricVersion) {
      byBucket.set(sample.bucket, sample);
    }
  }
  const buckets = [...byBucket.keys()].sort().reverse().slice(0, lookback);
  if (buckets.length === 0) {
    return {
      ...base,
      message: `no ${rule.granularity} rollup bucket for ${rule.metricId} matching ${JSON.stringify(rule.stratumEquals)} at or before ${cutoff}`,
    };
  }
  const chosen = buckets.map((bucket) => byBucket.get(bucket) as AlertSample);
  const observedValue =
    aggregation === "mean"
      ? round(chosen.reduce((sum, sample) => sum + sample.value, 0) / chosen.length)
      : round(chosen[0]!.value);
  const sampleDenominator = chosen.some((sample) => sample.denominator === null)
    ? null
    : Math.min(...chosen.map((sample) => sample.denominator as number));
  const withData: AlertEvaluation = {
    ...base,
    bucket: buckets[0],
    buckets: buckets.slice().reverse(),
    observedValue,
    sampleDenominator,
  };
  if (rule.minSample !== undefined && (sampleDenominator === null || sampleDenominator < rule.minSample)) {
    return {
      ...withData,
      status: "INSUFFICIENT_DATA",
      message: `denominator ${sampleDenominator ?? "null"} below minSample ${rule.minSample}`,
    };
  }
  const firing = rule.comparison === "below" ? observedValue < rule.bound : observedValue > rule.bound;
  return {
    ...withData,
    status: firing ? "FIRING" : "OK",
    message: firing
      ? `${aggregation === "mean" ? `mean(${buckets.length} buckets)` : `bucket ${buckets[0]}`} value ${observedValue} ${rule.comparison} ${rule.bound}`
      : `value ${observedValue} not ${rule.comparison} ${rule.bound}`,
  };
}

/**
 * Freshness evaluation. `latestDataAt` is the moment the newest data became
 * complete: metric_observation.window_end, or the end of the newest rollup
 * bucket (day + 1 day / week + 7 days, computed by the caller).
 */
export function evaluateFreshnessRule(
  rule: FreshnessAlertRule,
  latestDataAt: Date | null,
  asOf: Date,
): AlertEvaluation {
  const evaluatedAt = asOf.toISOString();
  const base: AlertEvaluation = {
    ruleId: rule.id,
    metricId: rule.metricId,
    severity: rule.severity,
    kind: "freshness",
    status: "NO_DATA",
    message: "",
    evaluatedAt,
    maxAgeHours: rule.maxAgeHours,
  };
  if (latestDataAt === null) {
    return { ...base, message: `no ${rule.source} data for ${rule.metricId}` };
  }
  const ageHours = round((asOf.getTime() - latestDataAt.getTime()) / 3_600_000, 2);
  const firing = ageHours > rule.maxAgeHours;
  return {
    ...base,
    status: firing ? "FIRING" : "OK",
    latestDataAt: latestDataAt.toISOString(),
    ageHours,
    message: firing
      ? `data is ${ageHours}h old, older than ${rule.maxAgeHours}h`
      : `data is ${ageHours}h old, within ${rule.maxAgeHours}h`,
  };
}

export interface AlertEvaluationInput {
  /** Rollup rows for threshold rules (both granularities may be mixed). */
  thresholdSamples: readonly AlertSample[];
  /** metricId -> newest metric_observation.window_end. */
  observationLatest: ReadonlyMap<string, Date | null>;
  /** `${granularity}:${metricId}` -> end of the newest rollup bucket. */
  rollupLatest: ReadonlyMap<string, Date | null>;
}

export function evaluateAlerts(
  rules: readonly AlertRule[],
  input: AlertEvaluationInput,
  asOf: Date,
): AlertEvaluation[] {
  return rules.map((rule) =>
    rule.kind === "threshold"
      ? evaluateThresholdRule(rule, input.thresholdSamples, asOf)
      : evaluateFreshnessRule(
          rule,
          rule.source === "observation"
            ? (input.observationLatest.get(rule.metricId) ?? null)
            : (input.rollupLatest.get(`${rule.granularity}:${rule.metricId}`) ?? null),
          asOf,
        ),
  );
}

export function summarizeAlertEvaluations(evaluations: readonly AlertEvaluation[]): AlertSummary {
  const firingEvaluations = evaluations.filter((evaluation) => evaluation.status === "FIRING");
  const worstSeverity: AlertSeverity | null = firingEvaluations.some((evaluation) => evaluation.severity === "CRITICAL")
    ? "CRITICAL"
    : firingEvaluations.length > 0
      ? "WARNING"
      : null;
  return {
    total: evaluations.length,
    firing: firingEvaluations.length,
    ok: evaluations.filter((evaluation) => evaluation.status === "OK").length,
    noData: evaluations.filter((evaluation) => evaluation.status === "NO_DATA").length,
    insufficientData: evaluations.filter((evaluation) => evaluation.status === "INSUFFICIENT_DATA").length,
    worstSeverity,
    exitCode: worstSeverity === "CRITICAL" ? 20 : worstSeverity === "WARNING" ? 10 : 0,
  };
}
