import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import {
  SITE_BUILDER_MODEL_POLICY_VERSION,
  type ModelExecutionPolicySnapshot,
} from '@global/contracts';
import type { TaskRoute } from '../agents/task-routes';
import {
  getSiteBuilderTaskRouteBinding,
  type SiteBuilderTaskId,
} from '../agents/task-route-bindings';
import { SITE_BUILDER_MODEL_PROFILES } from '../agents/model-profiles';

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
      .map(
        ([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`,
      );
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

export function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256CanonicalJson(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

export function sanitizeGatewayBaseUrl(raw: string): string {
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

export function assertUniqueEvaluationValues(
  name: string,
  values: readonly string[],
): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `${name} contains duplicate values: ${[...duplicates].join(', ')}`,
    );
  }
}

type EvaluationPathExists = (path: string) => Promise<boolean>;

const evaluationPathExists: EvaluationPathExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

/** Prevent a known `writeFile(..., flag: 'wx')` collision before paid calls. */
export async function assertEvaluationReportPathAvailable(
  reportPath: string,
  pathExists: EvaluationPathExists = evaluationPathExists,
): Promise<void> {
  if (await pathExists(reportPath)) {
    throw new Error(`evaluation report path already exists: ${reportPath}`);
  }
}

export interface EvaluationMatrixRowKey {
  model: string;
  fixtureId: string;
  attempt: number;
}

export interface EvaluationMatrixIntegrity {
  expectedRunCount: number;
  actualRunCount: number;
  complete: boolean;
  duplicateKeys: string[];
  missingKeys: string[];
  unexpectedKeys: string[];
}

export interface EvaluationModelResolution {
  requestedModel: string;
  resolvedModel?: string;
  reportedModel?: string;
  modelResolutionSource?: 'upstream_response' | 'requested_fallback';
}

export function isExactUpstreamModelResolution(
  resolution: EvaluationModelResolution,
): boolean {
  return (
    resolution.modelResolutionSource === 'upstream_response' &&
    resolution.reportedModel === resolution.requestedModel &&
    resolution.resolvedModel === resolution.reportedModel
  );
}

function evaluationRunKey(row: EvaluationMatrixRowKey): string {
  return `${row.model}\u0000${row.fixtureId}\u0000${row.attempt}`;
}

export function inspectEvaluationMatrix(
  models: readonly string[],
  fixtureIds: readonly string[],
  repeats: number,
  rows: readonly EvaluationMatrixRowKey[],
): EvaluationMatrixIntegrity {
  const expected = new Set<string>();
  for (const model of models) {
    for (const fixtureId of fixtureIds) {
      for (let attempt = 1; attempt <= repeats; attempt += 1) {
        expected.add(evaluationRunKey({ model, fixtureId, attempt }));
      }
    }
  }

  const actual = new Set<string>();
  const duplicateKeys = new Set<string>();
  for (const row of rows) {
    const key = evaluationRunKey(row);
    if (actual.has(key)) duplicateKeys.add(key);
    actual.add(key);
  }
  const missingKeys = [...expected].filter((key) => !actual.has(key)).sort();
  const unexpectedKeys = [...actual].filter((key) => !expected.has(key)).sort();
  return {
    expectedRunCount: expected.size,
    actualRunCount: rows.length,
    complete:
      duplicateKeys.size === 0 &&
      missingKeys.length === 0 &&
      unexpectedKeys.length === 0 &&
      rows.length === expected.size,
    duplicateKeys: [...duplicateKeys].sort(),
    missingKeys,
    unexpectedKeys,
  };
}

/**
 * A MODEL-1 evaluation is independent evidence, not traffic under the active
 * promotion. Preserve the real task profile/budgets while removing the old
 * promotion id so a new report cannot become self-referential.
 */
export function routeForModelEvaluation(
  baseRoute: TaskRoute,
  model: string,
): TaskRoute {
  const { promotionEvidenceId: _promotionEvidenceId, ...basePolicy } =
    baseRoute.policy;
  return {
    ...baseRoute,
    primary: model,
    fallbacks: [],
    dataPolicy: { ...baseRoute.dataPolicy },
    policy: {
      ...basePolicy,
      routeState: 'currentRoute',
      lifecycle: 'active',
      source: 'env_override',
      dataPolicy: { ...basePolicy.dataPolicy },
      route: { primary: model, fallbacks: [] },
    },
  };
}

/**
 * Build a candidate route from immutable task semantics, not active promotion
 * state. This keeps an evaluation report valid when its evidence id is later
 * registered in the production policy registry.
 */
export function routeForTaskEvaluation(
  taskId: SiteBuilderTaskId,
  model: string,
): TaskRoute {
  const binding = getSiteBuilderTaskRouteBinding(taskId);
  const profile = SITE_BUILDER_MODEL_PROFILES[binding.profile];
  const dataPolicy = { ...profile.dataPolicy };
  const route = { primary: model, fallbacks: [] };
  return {
    ...binding,
    profile: binding.profile,
    primary: model,
    fallbacks: [],
    dataPolicy,
    policy: {
      policyVersion: SITE_BUILDER_MODEL_POLICY_VERSION,
      profile: binding.profile,
      routeState: 'currentRoute',
      lifecycle: 'active',
      source: 'env_override',
      dataPolicy: { ...dataPolicy },
      maxCostCents: binding.maxCostCents,
      route,
    },
  };
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
