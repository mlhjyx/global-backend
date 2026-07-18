import { createHash } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
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
import { modelPolicyRegistry } from '../agents/model-policy.registry';

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

export interface EvaluationSourceFingerprint {
  path: string;
  sha256: string;
}

export interface EvaluationSourceBundleIntegrity {
  startBundleSha256: string;
  endBundleSha256: string;
  stable: boolean;
  changedPaths: string[];
}

export function inspectEvaluationSourceBundle(
  start: readonly EvaluationSourceFingerprint[],
  end: readonly EvaluationSourceFingerprint[],
): EvaluationSourceBundleIntegrity {
  const startByPath = new Map(start.map((item) => [item.path, item.sha256]));
  const endByPath = new Map(end.map((item) => [item.path, item.sha256]));
  const changedPaths = [...new Set([...startByPath.keys(), ...endByPath.keys()])]
    .filter((path) => startByPath.get(path) !== endByPath.get(path))
    .sort();
  const startBundleSha256 = sha256CanonicalJson(start);
  const endBundleSha256 = sha256CanonicalJson(end);
  return {
    startBundleSha256,
    endBundleSha256,
    stable:
      changedPaths.length === 0 && startBundleSha256 === endBundleSha256,
    changedPaths,
  };
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

/**
 * Prepare a fresh evidence directory before any paid call. The final writer
 * must still use `flag: 'wx'`; this preflight only creates the parent and
 * rejects a report path that is already occupied.
 */
export async function prepareEvaluationReportPath(
  reportPath: string,
): Promise<void> {
  await mkdir(dirname(reportPath), { recursive: true });
  await assertEvaluationReportPathAvailable(reportPath);
}

export interface DiagnosticRejectedOutput<T> {
  model: string;
  fixtureId: string;
  attempt: number;
  validationError: string;
  output: T;
}

/**
 * Full artifacts are diagnostic-only. Candidate and baseline reports retain
 * the privacy-safe artifact hash and never persist model output by default.
 */
export function captureDiagnosticRejectedOutput<T>(
  enabled: boolean,
  record: DiagnosticRejectedOutput<T>,
): DiagnosticRejectedOutput<T> | undefined {
  return enabled ? structuredClone(record) : undefined;
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

export type EvaluationEvidenceRole = 'candidate' | 'baseline' | 'diagnostic';

export interface EvaluationOutcomeInput {
  evidenceRole: EvaluationEvidenceRole;
  diagnosticsEnabled: boolean;
  preflightPassed: boolean;
  sourceStable: boolean;
  matrixComplete: boolean;
  artifactFailures: number;
  provenanceExact: boolean;
}

export interface EvaluationOutcome {
  status:
    | 'failed_preflight'
    | 'failed_source_drift'
    | 'failed_incomplete_matrix'
    | 'completed_with_failures'
    | 'completed_diagnostic'
    | 'completed_eligible'
    | 'completed_baseline'
    | 'completed_unproven_provenance';
  promotionEligible: boolean;
  shouldFail: boolean;
}

export function classifyEvaluationOutcome(
  input: EvaluationOutcomeInput,
): EvaluationOutcome {
  const completeEvidence =
    !input.diagnosticsEnabled &&
    input.preflightPassed &&
    input.sourceStable &&
    input.matrixComplete &&
    input.artifactFailures === 0 &&
    input.provenanceExact;
  const promotionEligible =
    input.evidenceRole === 'candidate' && completeEvidence;
  const baselineComplete =
    input.evidenceRole === 'baseline' && completeEvidence;

  const status = !input.preflightPassed
    ? 'failed_preflight'
    : !input.sourceStable
      ? 'failed_source_drift'
      : !input.matrixComplete
        ? 'failed_incomplete_matrix'
        : input.artifactFailures > 0
          ? 'completed_with_failures'
          : input.diagnosticsEnabled
            ? 'completed_diagnostic'
            : promotionEligible
              ? 'completed_eligible'
              : baselineComplete
                ? 'completed_baseline'
                : 'completed_unproven_provenance';

  return {
    status,
    promotionEligible,
    shouldFail:
      !input.preflightPassed ||
      !input.sourceStable ||
      !input.matrixComplete ||
      input.artifactFailures > 0 ||
      (!input.diagnosticsEnabled &&
        !promotionEligible &&
        !baselineComplete),
  };
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

/**
 * A frozen baseline may intentionally request a stable alias whose upstream
 * response reports a versioned identifier. The alias is proven only when the
 * upstream supplied both reported and resolved identities and they agree.
 */
export function isProvenUpstreamModelResolution(
  resolution: EvaluationModelResolution,
): boolean {
  return (
    resolution.modelResolutionSource === 'upstream_response' &&
    typeof resolution.reportedModel === 'string' &&
    resolution.reportedModel.length > 0 &&
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
 * A baseline replays the complete frozen pre-promotion production route. It is
 * one route-shaped comparator: a primary failure may legitimately reach the
 * configured fallback, but every run must record the model that actually
 * served the accepted artifact.
 */
export function routeForTaskBaselineEvaluation(
  taskId: SiteBuilderTaskId,
): TaskRoute {
  const binding = getSiteBuilderTaskRouteBinding(taskId);
  const profile = SITE_BUILDER_MODEL_PROFILES[binding.profile];
  const legacy = modelPolicyRegistry.getLegacyTaskPolicy(taskId);
  const dataPolicy = { ...profile.dataPolicy };
  const route = {
    primary: legacy.route.primary,
    fallbacks: [...legacy.route.fallbacks],
  };
  return {
    ...binding,
    profile: binding.profile,
    primary: route.primary,
    fallbacks: [...route.fallbacks],
    dataPolicy,
    policy: {
      policyVersion: SITE_BUILDER_MODEL_POLICY_VERSION,
      profile: binding.profile,
      routeState: legacy.state,
      lifecycle: legacy.lifecycle,
      source: 'registry',
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

/** Capability probes inherit the material task knobs that affect visibility. */
export function evaluationProbePolicy(route: TaskRoute): {
  maxCostCents: number;
  reasoningEffort?: TaskRoute['reasoningEffort'];
} {
  return {
    maxCostCents: route.maxCostCents,
    ...(route.reasoningEffort
      ? { reasoningEffort: route.reasoningEffort }
      : {}),
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
