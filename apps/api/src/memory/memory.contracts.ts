/**
 * D-MA-7 memory layer v0 contracts.
 *
 * Design: docs/superpowers/plans/2026-11-08-memory-layer-v0.md (APPROVED).
 * These parsers are the write boundary: only whitelisted aggregate fields may
 * reach mem_run_episode, so a future event field cannot silently carry PII into
 * memory. Unknown top-level keys are rejected, not ignored.
 */

export const MEMORY_WORKFLOW_DISCOVERY = 'discovery';
export const MEMORY_EVENT_TYPES = [
  'DiscoveryRunCompleted',
  'LeadsScored',
] as const;
export type MemoryEventType = (typeof MEMORY_EVENT_TYPES)[number];

export const MEMORY_EPISODE_PHASES = [
  'run_completed',
  'results_backfilled',
] as const;
export type MemoryEpisodePhase = (typeof MEMORY_EPISODE_PHASES)[number];

export const MEMORY_SCOPE_TYPES = [
  'workspace',
  'icp',
  'source',
  'channel',
  'industry',
  'country',
] as const;
export type MemoryScopeType = (typeof MEMORY_SCOPE_TYPES)[number];

export const MEMORY_RUN_STATUSES = [
  'DONE',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
] as const;
export type MemoryRunStatus = (typeof MEMORY_RUN_STATUSES)[number];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MemoryPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryPayloadError';
  }
}

export interface MemoryProvenance {
  eventType: string;
  schemaVersion: number;
  producer: string;
  eventId: string;
  correlationId: string | null;
  causationId: string | null;
}

export interface RunCompletedPayload {
  planId: string;
  status: MemoryRunStatus;
  cost: number;
  costBasis: string;
  taskRef?: { taskId: string; taskRunId: string };
  stats: Record<string, unknown>;
}

export interface ResultsBackfilledPayload {
  scored: number;
  queues: Record<string, number>;
}

export interface MemoryConsumerConfig {
  enabled: boolean;
  pollMs: number;
  lookbackDays: number;
  batchSize: number;
}

export interface MemorySemanticConfig {
  enabled: boolean;
  minN: number;
  maxCiWidth: number;
  briefMaxTokens: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Keys that name person-level data. Counters such as `contacts` are allowed. */
const PII_KEY = /(^|_)(email|phone|mobile|linkedin|full_?name|first_?name|last_?name|contact_?(name|email))$/i;

function assertNoPersonalData(
  value: unknown,
  path: string,
  depth = 0,
): void {
  if (depth > 6) {
    throw new MemoryPayloadError(`stats nested too deeply at ${path}`);
  }
  if (typeof value === 'string') {
    if (value.length > 500) {
      throw new MemoryPayloadError(`stats string too long at ${path}`);
    }
    return;
  }
  if (finiteNumber(value) || typeof value === 'boolean' || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) {
      throw new MemoryPayloadError(`stats array too long at ${path}`);
    }
    value.forEach((item, index) =>
      assertNoPersonalData(item, `${path}[${index}]`, depth + 1),
    );
    return;
  }
  const object = record(value);
  if (!object) {
    throw new MemoryPayloadError(`unsupported stats value at ${path}`);
  }
  for (const [key, child] of Object.entries(object)) {
    if (key.length > 256) {
      throw new MemoryPayloadError(`stats key too long at ${path}`);
    }
    if (PII_KEY.test(key)) {
      throw new MemoryPayloadError(
        `personal-data key '${key}' is not allowed in memory payloads (${path})`,
      );
    }
    assertNoPersonalData(child, `${path}.${key}`, depth + 1);
  }
}

/** Reject unknown top-level keys; a new event field must be reviewed before it is stored. */
function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new MemoryPayloadError(`unexpected memory payload key '${key}'`);
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      throw new MemoryPayloadError(`missing memory payload key '${key}'`);
    }
  }
}

export function parseRunCompletedPayload(
  payload: unknown,
): RunCompletedPayload {
  const object = record(payload);
  if (!object) throw new MemoryPayloadError('run payload is not an object');
  exactKeys(
    object,
    ['planId', 'status', 'stats'],
    ['cost', 'costBasis', 'taskRef'],
  );
  if (typeof object.planId !== 'string' || !UUID_RE.test(object.planId)) {
    throw new MemoryPayloadError('planId is not a UUID');
  }
  if (
    typeof object.status !== 'string' ||
    !(MEMORY_RUN_STATUSES as readonly string[]).includes(object.status)
  ) {
    throw new MemoryPayloadError('status is not a known run status');
  }
  const cost = object.cost ?? 0;
  if (!finiteNumber(cost) || cost < 0) {
    throw new MemoryPayloadError('cost is not a non-negative number');
  }
  const costBasis = object.costBasis ?? 'usage_ledger-runid/v1';
  if (typeof costBasis !== 'string' || costBasis.length > 64) {
    throw new MemoryPayloadError('costBasis is not a short string');
  }
  let taskRef: RunCompletedPayload['taskRef'];
  if (object.taskRef !== undefined) {
    const ref = record(object.taskRef);
    if (
      !ref ||
      typeof ref.taskId !== 'string' ||
      typeof ref.taskRunId !== 'string' ||
      ref.taskId.length > 128 ||
      ref.taskRunId.length > 128
    ) {
      throw new MemoryPayloadError('taskRef is malformed');
    }
    taskRef = { taskId: ref.taskId, taskRunId: ref.taskRunId };
  }
  const stats = record(object.stats);
  if (!stats) throw new MemoryPayloadError('stats is not an object');
  assertNoPersonalData(stats, 'stats');
  return {
    planId: object.planId,
    status: object.status as MemoryRunStatus,
    cost,
    costBasis,
    ...(taskRef ? { taskRef } : {}),
    stats,
  };
}

export function parseLeadsScoredPayload(
  payload: unknown,
): ResultsBackfilledPayload {
  const object = record(payload);
  if (!object) throw new MemoryPayloadError('scored payload is not an object');
  exactKeys(object, ['scored', 'queues'], []);
  if (!Number.isInteger(object.scored) || (object.scored as number) < 0) {
    throw new MemoryPayloadError('scored is not a non-negative integer');
  }
  const queues = record(object.queues);
  if (!queues) throw new MemoryPayloadError('queues is not an object');
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(queues)) {
    if (key.length > 64 || !Number.isInteger(value) || (value as number) < 0) {
      throw new MemoryPayloadError('queues contains an invalid counter');
    }
    normalized[key] = value as number;
  }
  return { scored: object.scored as number, queues: normalized };
}

export function buildProvenance(input: {
  eventType: string;
  schemaVersion: number;
  producer: string;
  eventId: string;
  correlationId: string | null;
  causationId: string | null;
}): MemoryProvenance {
  return {
    eventType: input.eventType,
    schemaVersion: input.schemaVersion,
    producer: input.producer,
    eventId: input.eventId,
    correlationId: input.correlationId,
    causationId: input.causationId,
  };
}

/**
 * Wilson score interval (95%): the conservative posterior lower bound used for
 * `n>=minN && ciWidth<=maxCiWidth`. Pure stdlib, no dependency.
 */
export function wilsonInterval(
  successes: number,
  failures: number,
  z = 1.96,
): { low: number; high: number } {
  const n = successes + failures;
  if (n <= 0) return { low: 0, high: 1 };
  const phat = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denominator;
  const margin =
    (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denominator;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

export function readMemoryConsumerConfig(
  env: NodeJS.ProcessEnv = process.env,
): MemoryConsumerConfig {
  const int = (raw: string | undefined, fallback: number, min: number, max: number) => {
    const parsed = Number.parseInt(raw ?? '', 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };
  return {
    enabled: env.MEMORY_LAYER_V0_ENABLED === 'true',
    pollMs: int(env.MEMORY_CONSUMER_POLL_MS, 60_000, 5_000, 3_600_000),
    lookbackDays: int(env.MEMORY_CONSUMER_LOOKBACK_DAYS, 14, 1, 90),
    batchSize: int(env.MEMORY_CONSUMER_BATCH_SIZE, 100, 1, 500),
  };
}

export function readMemorySemanticConfig(
  env: NodeJS.ProcessEnv = process.env,
): MemorySemanticConfig {
  const number = (raw: string | undefined, fallback: number) => {
    const parsed = Number.parseFloat(raw ?? '');
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    enabled: env.MEMORY_SEMANTIC_CONSUMPTION_ENABLED === 'true',
    minN: Math.max(1, Math.trunc(number(env.MEMORY_STRATEGY_MIN_N, 30))),
    maxCiWidth: Math.min(
      1,
      Math.max(0, number(env.MEMORY_STRATEGY_MAX_CI_WIDTH, 0.2)),
    ),
    briefMaxTokens: Math.min(
      2000,
      Math.max(200, Math.trunc(number(env.MEMORY_BRIEF_MAX_TOKENS, 2000))),
    ),
  };
}
