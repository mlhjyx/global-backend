/**
 * ch01 PR-03：度量聚合工作流的纯逻辑（无 IO）。
 *
 * 职责：stratum 规范化键、观测的 computation_hash、Wilson/参数化 bootstrap 置信区间、
 * 最近观测挑选与日/周 rollup 行构建。所有函数可单测；数据库读写只在 run.ts。
 */
import { createHash } from "node:crypto";

export interface MetricObservationInput {
  workspaceId: string | null;
  metricId: string;
  metricVersion: number;
  stratum: Record<string, unknown>;
  stratumKey: string;
  windowStart: Date;
  windowEnd: Date;
  numerator: number;
  denominator: number | null;
  value: number;
  ciLow: number | null;
  ciHigh: number | null;
  sampleN: number | null;
  computationHash: string;
}

export interface RollupRow {
  bucket: Date;
  metricId: string;
  metricVersion: number;
  stratum: Record<string, unknown>;
  stratumKey: string;
  numerator: number;
  denominator: number | null;
  value: number;
  ciLow: number | null;
  ciHigh: number | null;
  sampleN: number | null;
}

/** Deterministic JSON with sorted object keys (stratum_key's canonical text). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}

export function stratumKeyOf(stratum: Record<string, unknown>): string {
  return stableStringify(stratum);
}

/** sha256 over the observation identity (idempotency key material). */
export function computationHashOf(input: {
  metricId: string;
  metricVersion: number;
  stratumKey: string;
  windowStart: Date;
  windowEnd: Date;
  numerator: number;
  denominator: number | null;
}): string {
  return createHash("sha256")
    .update(
      [
        input.metricId,
        String(input.metricVersion),
        input.stratumKey,
        input.windowStart.toISOString(),
        input.windowEnd.toISOString(),
        String(input.numerator),
        input.denominator === null ? "null" : String(input.denominator),
      ].join("|"),
    )
    .digest("hex");
}

/** Ratio value; null when the denominator is absent or zero. */
export function observationValue(
  numerator: number,
  denominator: number | null,
): number | null {
  if (denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

/** Wilson score interval (z = 1.96); null when n = 0. */
export function wilsonInterval(
  numerator: number,
  denominator: number,
): { low: number; high: number } | null {
  if (denominator <= 0) return null;
  const p = numerator / denominator;
  const z = 1.96;
  const z2 = z * z;
  const centre = (p + z2 / (2 * denominator)) / (1 + z2 / denominator);
  const half =
    (z * Math.sqrt((p * (1 - p)) / denominator + z2 / (4 * denominator * denominator))) /
    (1 + z2 / denominator);
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Mulberry32 PRNG (seeded) for the ratio-of-counts bootstrap. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(lambda: number, rng: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda >= 30) {
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal));
  }
  const limit = Math.exp(-lambda);
  let product = 1;
  let count = 0;
  do {
    count += 1;
    product *= rng();
  } while (product > limit);
  return count - 1;
}

function quantile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? null;
  const weight = position - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

/**
 * Parametric bootstrap interval for a ratio of counts (contacts per account).
 * Deterministic per seed; zero-denominator draws are skipped.
 */
export function bootstrapRatioInterval(
  numerator: number,
  denominator: number,
  seed: string,
  reps = 400,
): { low: number; high: number } | null {
  if (denominator <= 0) return null;
  const rng = mulberry32(
    createHash("sha256").update(seed).digest().readUInt32BE(0),
  );
  const values: number[] = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const drawnNumerator = poisson(numerator, rng);
    const drawnDenominator = poisson(denominator, rng);
    if (drawnDenominator > 0) values.push(drawnNumerator / drawnDenominator);
  }
  values.sort((left, right) => left - right);
  const low = quantile(values, 0.025);
  const high = quantile(values, 0.975);
  return low === null || high === null ? null : { low, high };
}

export interface BuildObservationParams {
  metricId: string;
  metricVersion: number;
  workspaceId: string | null;
  stratum: Record<string, unknown>;
  windowStart: Date;
  windowEnd: Date;
  numerator: number;
  denominator: number | null;
  ci: { low: number; high: number } | null;
  sampleN?: number | null;
}

/** Build one observation row (identity hash included). */
export function buildObservation(
  params: BuildObservationParams,
): MetricObservationInput {
  const stratumKey = stratumKeyOf(params.stratum);
  const value = observationValue(params.numerator, params.denominator) ?? 0;
  return {
    workspaceId: params.workspaceId,
    metricId: params.metricId,
    metricVersion: params.metricVersion,
    stratum: params.stratum,
    stratumKey,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    numerator: params.numerator,
    denominator: params.denominator,
    value,
    ciLow: params.ci?.low ?? null,
    ciHigh: params.ci?.high ?? null,
    sampleN: params.sampleN ?? params.denominator,
    computationHash: computationHashOf({
      metricId: params.metricId,
      metricVersion: params.metricVersion,
      stratumKey,
      windowStart: params.windowStart,
      windowEnd: params.windowEnd,
      numerator: params.numerator,
      denominator: params.denominator,
    }),
  };
}

/** Monday 00:00 UTC of the ISO week containing `day`. */
export function weekStartOf(day: Date): Date {
  const start = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()),
  );
  const weekday = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - (weekday - 1));
  return start;
}

/** Latest observation per (metric, version, stratumKey): max windowEnd, then input order. */
export function latestPerStratum(
  observations: MetricObservationInput[],
): MetricObservationInput[] {
  const latest = new Map<string, MetricObservationInput>();
  for (const observation of observations) {
    const key = `${observation.metricId}|${observation.metricVersion}|${observation.stratumKey}`;
    const current = latest.get(key);
    if (!current || observation.windowEnd.getTime() >= current.windowEnd.getTime()) {
      latest.set(key, observation);
    }
  }
  return [...latest.values()];
}

/** Build daily or weekly rollup rows from the latest observations. */
export function buildRollupRows(
  observations: MetricObservationInput[],
  granularity: "day" | "week",
): RollupRow[] {
  return latestPerStratum(observations).map((observation) => ({
    bucket:
      granularity === "day"
        ? new Date(
            Date.UTC(
              observation.windowEnd.getUTCFullYear(),
              observation.windowEnd.getUTCMonth(),
              observation.windowEnd.getUTCDate(),
            ),
          )
        : weekStartOf(observation.windowEnd),
    metricId: observation.metricId,
    metricVersion: observation.metricVersion,
    stratum: observation.stratum,
    stratumKey: observation.stratumKey,
    numerator: observation.numerator,
    denominator: observation.denominator,
    value: observation.value,
    ciLow: observation.ciLow,
    ciHigh: observation.ciHigh,
    sampleN: observation.sampleN,
  }));
}
