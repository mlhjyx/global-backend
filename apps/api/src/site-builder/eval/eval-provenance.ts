import { createHash } from 'node:crypto';
import type { ModelExecutionPolicySnapshot } from '@global/contracts';
import type { TaskRoute } from '../agents/task-routes';

export interface EvaluationExecutionPolicy {
  /** Registry/env policy used by the gateway, including profile and data policy. */
  modelPolicy: ModelExecutionPolicySnapshot;
  maxTokens: number;
  timeoutMs: number;
  maxCostCents: number;
  reasoningEffort: TaskRoute['reasoningEffort'] | null;
}

export class EvaluationDeadlineError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`model evaluation deadline exceeded after ${timeoutMs}ms`);
    this.name = 'EvaluationDeadlineError';
  }
}

/**
 * Deterministic JSON serialization for evaluator provenance fingerprints.
 * Arrays retain their semantic order; object keys are sorted recursively so a
 * hash does not change merely because a source object was constructed in a
 * different insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // Do not use localeCompare here: its collation can differ by host locale,
      // which would make an otherwise identical evaluator report hash differ
      // between development and CI. JavaScript's relational string comparison
      // is stable Unicode code-unit ordering.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`);
    return `{${entries.join(',')}}`;
  }

  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') {
    throw new Error('evaluator provenance must be JSON-serializable');
  }
  return serialized;
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256CanonicalJson(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

/**
 * A task contract alone is insufficient to replay a model run: token ceiling,
 * timeout and reasoning effort materially affect structured-output quality.
 */
export function snapshotEvaluationExecutionPolicy(
  route: TaskRoute,
  modelPolicy: ModelExecutionPolicySnapshot = route.policy,
): EvaluationExecutionPolicy {
  return {
    modelPolicy: {
      ...modelPolicy,
      dataPolicy: { ...modelPolicy.dataPolicy },
      route: {
        primary: modelPolicy.route.primary,
        fallbacks: [...modelPolicy.route.fallbacks],
      },
    },
    maxTokens: route.maxTokens,
    timeoutMs: route.timeoutMs,
    maxCostCents: route.maxCostCents,
    reasoningEffort: route.reasoningEffort ?? null,
  };
}

/**
 * The caller supplies a task-calibrated deadline (never a global evaluator
 * default). The abort signal reaches the OpenAI-compatible fetch, while the
 * race lets a fail-stop evaluator return even if an upstream ignores abort.
 */
export async function runWithEvaluationDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new EvaluationDeadlineError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
