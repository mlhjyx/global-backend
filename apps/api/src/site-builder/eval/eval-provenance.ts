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
      .sort(([left], [right]) => left.localeCompare(right))
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
