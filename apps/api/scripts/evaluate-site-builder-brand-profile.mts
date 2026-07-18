/**
 * MODEL-1 BrandProfile evaluator — deliberately local/manual, never CI.
 *
 * Uses six committed synthetic fixtures to call the real new-api endpoint via
 * the production OpenAI-compatible provider and AiTask stack. It does not
 * change routing or write a database row. A non-zero exit means a candidate
 * did not produce an accepted artifact for every requested fixture/run.
 *
 * Run from apps/api (loads its ignored .env):
 *   MODEL_EVAL_REPEATS=2 \
 *   MODEL_EVAL_MODELS=gpt-5.6-terra,claude-sonnet-5 \
 *   node --import tsx scripts/evaluate-site-builder-brand-profile.mts
 */
import 'dotenv/config';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelProviderRegistry } from '../src/model-gateway/model-provider.registry';
import { ModelRouter } from '../src/model-gateway/model-router';
import { VERIFIED_GATEWAY_MODEL_TRANSPORTS } from '../src/model-gateway/model-transports';
import {
  OpenAICompatibleProvider,
  type GatewayModelTransport,
} from '../src/model-gateway/providers/openai-compatible.provider';
import { ProviderOutputError } from '../src/model-gateway/providers/provider-output-error';
import { RouterModelGateway } from '../src/model-gateway/router-model-gateway';
import { AiTaskError, runAiTask } from '../src/site-builder/agents/ai-task';
import {
  BRAND_PROFILE_PROMPT_VERSION,
  BRAND_PROFILE_ROUTE_VALIDATION_VERSION,
  type BrandProfileOutput,
} from '../src/site-builder/agents/brand-profile';
import {
  BRAND_PROFILE_EVALUATOR_RUBRIC,
  BRAND_PROFILE_EVALUATOR_VERSION,
  BRAND_PROFILE_EVAL_FIXTURE_SCHEMA_VERSION,
  BRAND_PROFILE_TASK,
  evaluateBrandProfileOutput,
  prepareBrandProfileEvalFixture,
  type BrandProfileEvalFixture,
} from '../src/site-builder/eval/brand-profile-eval';
import {
  assertEvaluationReportPathAvailable,
  assertUniqueEvaluationValues,
  inspectEvaluationMatrix,
  isExactUpstreamModelResolution,
  sha256CanonicalJson,
  sha256Bytes,
  sha256Text,
  routeForTaskEvaluation,
  runWithEvaluationDeadline,
  sanitizeGatewayBaseUrl,
  snapshotEvaluationExecutionPolicy,
  type EvaluationExecutionPolicy,
} from '../src/site-builder/eval/eval-provenance';
import type { TaskRoute } from '../src/site-builder/agents/task-routes';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(SCRIPT_DIR, '..');
const REPO_DIR = join(API_DIR, '../..');
const FIXTURE_DIR = join(
  API_DIR,
  'test/fixtures/golden-companies/brand-profile',
);
const EVAL_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const EVAL_PROVIDER_ID = 'new-api-eval';
const GATEWAY_CATALOG_TIMEOUT_MS = 15_000;
const SOURCE_FILES = Object.freeze([
  { role: 'task', path: 'apps/api/src/site-builder/agents/brand-profile.ts' },
  {
    role: 'judge',
    path: 'apps/api/src/site-builder/eval/brand-profile-eval.ts',
  },
  {
    role: 'harness',
    path: 'apps/api/scripts/evaluate-site-builder-brand-profile.mts',
  },
  {
    role: 'provider',
    path: 'apps/api/src/model-gateway/providers/openai-compatible.provider.ts',
  },
  {
    role: 'transport_registry',
    path: 'apps/api/src/model-gateway/model-transports.ts',
  },
  { role: 'task_runner', path: 'apps/api/src/site-builder/agents/ai-task.ts' },
  {
    role: 'gateway_router',
    path: 'apps/api/src/model-gateway/router-model-gateway.ts',
  },
  {
    role: 'schema_validator',
    path: 'apps/api/src/model-gateway/schema-validate.ts',
  },
  {
    role: 'evaluation_provenance',
    path: 'apps/api/src/site-builder/eval/eval-provenance.ts',
  },
  {
    role: 'task_route',
    path: 'apps/api/src/site-builder/agents/task-routes.ts',
  },
  {
    role: 'task_route_binding',
    path: 'apps/api/src/site-builder/agents/task-route-bindings.ts',
  },
  {
    role: 'evidence_contract',
    path: 'apps/api/src/site-builder/agents/evidence-ref.ts',
  },
  { role: 'pii_guard', path: 'apps/api/src/site-builder/agents/pii.ts' },
  {
    role: 'claim_classifier',
    path: 'apps/api/src/site-builder/claim-classification.ts',
  },
  {
    role: 'profile_registry',
    path: 'apps/api/src/site-builder/agents/model-profiles.ts',
  },
  {
    role: 'provider_registry',
    path: 'apps/api/src/model-gateway/model-provider.registry.ts',
  },
  { role: 'model_router', path: 'apps/api/src/model-gateway/model-router.ts' },
  {
    role: 'provider_error',
    path: 'apps/api/src/model-gateway/providers/provider-output-error.ts',
  },
  { role: 'gateway_types', path: 'apps/api/src/model-gateway/types.ts' },
  {
    role: 'gateway_contract',
    path: 'apps/api/src/model-gateway/model-gateway.ts',
  },
  {
    role: 'provider_contract',
    path: 'apps/api/src/model-gateway/model-provider.ts',
  },
  { role: 'budget_ledger', path: 'apps/api/src/tools/budget.ts' },
  { role: 'contracts_runtime', path: 'packages/contracts/dist/index.js' },
  {
    role: 'contracts_runtime',
    path: 'packages/contracts/dist/site-builder/evidence.js',
  },
  {
    role: 'contracts_runtime',
    path: 'packages/contracts/dist/site-builder/media-foundation.js',
  },
  {
    role: 'contracts_runtime',
    path: 'packages/contracts/dist/site-builder/model-policy.js',
  },
  {
    role: 'contracts_runtime',
    path: 'packages/contracts/dist/site-builder/site-spec.js',
  },
  { role: 'contracts_manifest', path: 'packages/contracts/package.json' },
  { role: 'dependency_lock', path: 'pnpm-lock.yaml' },
] as const);
const CAPABILITY_PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string', const: 'ok' } },
} as const;

function transportForCandidate(model: string): GatewayModelTransport {
  return VERIFIED_GATEWAY_MODEL_TRANSPORTS[model] ?? 'openai-chat-completions';
}

interface EvalUsage {
  inputTokens?: number;
  outputTokens?: number;
  calls?: number;
}

interface EvalTaskContract {
  taskId: string;
  promptVersion: string;
  inputSchemaSha256: string;
  outputSchemaSha256: string;
  routeValidationVersion: string;
  evaluatorVersion: string;
  evaluatorRubricSha256: string;
  fixtureSchemaVersion: string;
  evaluationPolicyVersion: string;
  sourceFiles: Array<{ role: string; path: string; sha256: string }>;
  sourceBundleSha256: string;
}

interface EvalFixtureContract extends EvalTaskContract {
  fixtureId: string;
  fixtureSha256: string;
  promptSha256: string;
}

interface EvalProbe {
  requestedModel: string;
  transport: GatewayModelTransport;
  accepted: boolean;
  elapsedMs: number;
  provider?: string;
  resolvedModel?: string;
  reportedModel?: string;
  modelResolutionSource?: 'upstream_response' | 'requested_fallback';
  usage?: EvalUsage;
  error?: string;
}

interface EvalRun {
  model: string;
  requestedModel: string;
  transport: GatewayModelTransport;
  fixtureId: string;
  targetMarkets: string[];
  materialCompleteness: BrandProfileEvalFixture['materialCompleteness'];
  attempt: number;
  acceptedArtifact: boolean;
  elapsedMs: number;
  provider?: string;
  resolvedModel?: string;
  reportedModel?: string;
  modelResolutionSource?: 'upstream_response' | 'requested_fallback';
  acceptedFactCount?: number;
  rejectedFactCount?: number;
  missingAcceptedTerms?: string[];
  forbiddenOutputTerms?: string[];
  modelSnapshot?: unknown;
  fallbackIndex?: number;
  executionPolicy: EvaluationExecutionPolicy;
  /** Privacy-safe fingerprint of the model artifact actually judged. */
  artifactSha256?: string;
  taskContract: EvalFixtureContract;
  usage?: EvalUsage;
  acceptedArtifactCost: {
    reportedCostUsd: null;
    inputTokens: number;
    outputTokens: number;
    note: string;
  };
  error?: string;
}

interface GatewaySnapshot {
  providerId: string;
  baseUrl: string;
  modelCatalogCount: number;
  modelCatalogSha256: string;
  modelCatalogTimeoutMs: number;
  requestedModelsPresent: Record<string, boolean>;
}

interface EvaluationTimePlan {
  taskId: string;
  profile: string;
  maxTokens: number;
  perProbeTimeoutMs: number;
  perFixtureAttemptTimeoutMs: number;
  candidateCount: number;
  fixtureCount: number;
  repeats: number;
  expectedRunCount: number;
  absoluteMaximumWallClockMs: number;
}

/**
 * Keep stdout as one final JSON report. A partial matrix is explicitly marked
 * ineligible and cannot satisfy the immutable promotion-evidence spec. Stderr
 * receives a JSON line at each bounded unit of work for liveness monitoring.
 */
function progress(event: string, details: Record<string, unknown> = {}): void {
  process.stderr.write(
    `${JSON.stringify({ event, at: new Date().toISOString(), ...details })}\n`,
  );
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error(`${name} must be an integer from 1 to 3`);
  }
  return value;
}

async function loadFixtures(): Promise<BrandProfileEvalFixture[]> {
  const names = (await readdir(FIXTURE_DIR))
    .filter((name) => name.endsWith('.json'))
    .sort();
  const fixtures = await Promise.all(
    names.map(
      async (name) =>
        JSON.parse(
          await readFile(join(FIXTURE_DIR, name), 'utf8'),
        ) as BrandProfileEvalFixture,
    ),
  );
  if (fixtures.length !== 6)
    throw new Error(
      `expected exactly 6 BrandProfile fixtures, found ${fixtures.length}`,
    );
  assertUniqueEvaluationValues(
    'committed BrandProfile fixture ids',
    fixtures.map((fixture) => fixture.id),
  );
  for (const fixture of fixtures) {
    assertUniqueEvaluationValues(
      `${fixture.id} source ids`,
      fixture.sources.map((source) => source.id),
    );
  }
  return fixtures;
}

async function sourceFileFingerprints(): Promise<
  Array<{ role: string; path: string; sha256: string }>
> {
  return Promise.all(
    SOURCE_FILES.map(async ({ role, path }) => ({
      role,
      path,
      sha256: sha256Bytes(await readFile(join(REPO_DIR, path))),
    })),
  );
}

async function gatewaySnapshot(
  models: readonly string[],
): Promise<GatewaySnapshot> {
  const rawBaseUrl = required('MODEL_GATEWAY_URL');
  const baseUrl = sanitizeGatewayBaseUrl(rawBaseUrl);
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${required('MODEL_GATEWAY_KEY')}` },
    signal: AbortSignal.timeout(GATEWAY_CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `new-api model catalog probe failed with HTTP ${response.status}`,
    );
  }
  const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
  const ids = (payload.data ?? [])
    .map((item) => item.id)
    .filter(
      (id): id is string => typeof id === 'string' && id.trim().length > 0,
    )
    .map((id) => id.trim())
    .sort();
  assertUniqueEvaluationValues('new-api model catalog ids', ids);
  return {
    providerId: EVAL_PROVIDER_ID,
    baseUrl,
    modelCatalogCount: ids.length,
    modelCatalogSha256: sha256CanonicalJson(ids),
    modelCatalogTimeoutMs: GATEWAY_CATALOG_TIMEOUT_MS,
    requestedModelsPresent: Object.fromEntries(
      models.map((model) => [model, ids.includes(model)]),
    ),
  };
}

function candidateRoute(model: string): TaskRoute {
  return routeForTaskEvaluation('site_builder.brand_profile', model);
}

function gatewayFor(model: string): RouterModelGateway {
  const registry = new ModelProviderRegistry();
  registry.register(
    new OpenAICompatibleProvider({
      id: EVAL_PROVIDER_ID,
      baseUrl: required('MODEL_GATEWAY_URL'),
      apiKey: required('MODEL_GATEWAY_KEY'),
      model,
      modelTransports: VERIFIED_GATEWAY_MODEL_TRANSPORTS,
    }),
  );
  return new RouterModelGateway(new ModelRouter(registry));
}

async function probeCandidate(
  gateway: RouterModelGateway,
  route: TaskRoute,
  requestedModel: string,
): Promise<EvalProbe> {
  const started = performance.now();
  const transport = transportForCandidate(requestedModel);
  progress('capability_probe_started', {
    model: requestedModel,
    transport,
    timeoutMs: route.timeoutMs,
  });
  try {
    const result = await runWithEvaluationDeadline(
      // A probe is still an operation for this task: inherit the task's
      // calibrated timeout rather than inventing a global fixed number.
      route.timeoutMs,
      (signal) =>
        gateway.generateStructured<{ status: 'ok' }>(
          {
            task: 'site_builder.brand_profile.capability_probe',
            prompt: 'Return exactly {"status":"ok"}.',
            schema: CAPABILITY_PROBE_SCHEMA,
            model: requestedModel,
            maxTokens: 128,
            maxCostCents: route.maxCostCents,
            signal,
          },
          {
            workspaceId: EVAL_WORKSPACE_ID,
            runId: `model1-probe:${requestedModel}`,
            modelPolicy: { ...route.policy, fallbackIndex: 0 },
          },
        ),
    );
    if (result.provider === 'stub' || result.data.status !== 'ok') {
      throw new Error('capability probe returned an unusable response');
    }
    const probe = {
      requestedModel,
      transport,
      accepted: true,
      elapsedMs: Math.round(performance.now() - started),
      provider: result.provider,
      resolvedModel: result.model,
      reportedModel: result.reportedModel,
      modelResolutionSource: result.modelResolutionSource,
      usage: result.usage,
    };
    progress('capability_probe_completed', {
      model: requestedModel,
      transport,
      accepted: true,
      elapsedMs: probe.elapsedMs,
    });
    return probe;
  } catch (error) {
    const usage =
      error instanceof ProviderOutputError ? error.usage : undefined;
    const probe = {
      requestedModel,
      transport,
      accepted: false,
      elapsedMs: Math.round(performance.now() - started),
      provider:
        error instanceof ProviderOutputError ? error.provider : undefined,
      resolvedModel:
        error instanceof ProviderOutputError ? error.model : undefined,
      reportedModel:
        error instanceof ProviderOutputError ? error.reportedModel : undefined,
      modelResolutionSource:
        error instanceof ProviderOutputError
          ? error.modelResolutionSource
          : undefined,
      usage,
      error: error instanceof Error ? error.message : String(error),
    };
    progress('capability_probe_completed', {
      model: requestedModel,
      transport,
      accepted: false,
      elapsedMs: probe.elapsedMs,
    });
    return probe;
  }
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  ];
}

const repeats = positiveInt('MODEL_EVAL_REPEATS', 2);
const models = (
  process.env.MODEL_EVAL_MODELS ?? 'gpt-5.6-terra,claude-sonnet-5'
)
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
if (models.length === 0)
  throw new Error('MODEL_EVAL_MODELS must contain at least one model');
assertUniqueEvaluationValues('MODEL_EVAL_MODELS', models);

const allFixtures = await loadFixtures();
const requestedFixtureIds = (process.env.MODEL_EVAL_FIXTURES ?? '')
  .split(',')
  .map((fixtureId) => fixtureId.trim())
  .filter(Boolean);
assertUniqueEvaluationValues('MODEL_EVAL_FIXTURES', requestedFixtureIds);
const fixtures =
  requestedFixtureIds.length === 0
    ? allFixtures
    : allFixtures.filter((fixture) => requestedFixtureIds.includes(fixture.id));
const unknownFixtureIds = requestedFixtureIds.filter(
  (fixtureId) => !allFixtures.some((fixture) => fixture.id === fixtureId),
);
if (unknownFixtureIds.length > 0) {
  throw new Error(
    `unknown MODEL_EVAL_FIXTURES: ${unknownFixtureIds.join(', ')}`,
  );
}
if (fixtures.length === 0) {
  throw new Error('MODEL_EVAL_FIXTURES must select at least one fixture');
}
const matrixScope = requestedFixtureIds.length === 0 ? 'full' : 'diagnostic';
const diagnosticRouteValidationBypass =
  process.env.MODEL_EVAL_DIAGNOSTIC_BYPASS_ROUTE_VALIDATION === 'true';
const diagnosticCaptureRejectedOutput =
  process.env.MODEL_EVAL_DIAGNOSTIC_CAPTURE_REJECTED_OUTPUT === 'true';
const evidenceRole =
  process.env.MODEL_EVAL_EVIDENCE_ROLE?.trim() ||
  (matrixScope === 'diagnostic' ? 'diagnostic' : 'candidate');
if (!['candidate', 'baseline', 'diagnostic'].includes(evidenceRole)) {
  throw new Error(
    'MODEL_EVAL_EVIDENCE_ROLE must be candidate, baseline or diagnostic',
  );
}
if (
  diagnosticRouteValidationBypass &&
  (matrixScope !== 'diagnostic' ||
    fixtures.length !== 1 ||
    models.length !== 1 ||
    repeats !== 1)
) {
  throw new Error(
    'MODEL_EVAL_DIAGNOSTIC_BYPASS_ROUTE_VALIDATION requires one selected fixture, one model and one repeat',
  );
}
if (
  diagnosticCaptureRejectedOutput &&
  (matrixScope !== 'diagnostic' ||
    fixtures.length !== 1 ||
    models.length !== 1 ||
    repeats !== 1 ||
    diagnosticRouteValidationBypass)
) {
  throw new Error(
    'MODEL_EVAL_DIAGNOSTIC_CAPTURE_REJECTED_OUTPUT requires one selected fixture, one model, one repeat and route validation enabled',
  );
}
const reportPath = process.env.MODEL_EVAL_REPORT_PATH?.trim();
if (reportPath) await assertEvaluationReportPathAvailable(reportPath);
const runs: EvalRun[] = [];
const probes: EvalProbe[] = [];
const evaluationRoute = candidateRoute(models[0]);
const expectedRunCount = models.length * fixtures.length * repeats;
const timePlan: EvaluationTimePlan = {
  taskId: BRAND_PROFILE_TASK.id,
  profile: evaluationRoute.profile,
  maxTokens: evaluationRoute.maxTokens,
  perProbeTimeoutMs: evaluationRoute.timeoutMs,
  perFixtureAttemptTimeoutMs: evaluationRoute.timeoutMs,
  candidateCount: models.length,
  fixtureCount: fixtures.length,
  repeats,
  expectedRunCount,
  // Every probe and fixture attempt is independently bounded by its own task
  // route. This is an upper safety bound, not a predicted completion time.
  absoluteMaximumWallClockMs:
    models.length * (1 + fixtures.length * repeats) * evaluationRoute.timeoutMs,
};
const gateway = await gatewaySnapshot(models);
const sourceFiles = await sourceFileFingerprints();
progress('evaluation_started', {
  models,
  gatewayBaseUrl: gateway.baseUrl,
  gatewayModelCatalogCount: gateway.modelCatalogCount,
  ...timePlan,
});
const taskContract: EvalTaskContract = {
  taskId: BRAND_PROFILE_TASK.id,
  promptVersion: BRAND_PROFILE_PROMPT_VERSION,
  inputSchemaSha256: sha256CanonicalJson(BRAND_PROFILE_TASK.inputSchema),
  outputSchemaSha256: sha256CanonicalJson(BRAND_PROFILE_TASK.outputSchema),
  routeValidationVersion: BRAND_PROFILE_ROUTE_VALIDATION_VERSION,
  evaluatorVersion: BRAND_PROFILE_EVALUATOR_VERSION,
  evaluatorRubricSha256: sha256CanonicalJson(BRAND_PROFILE_EVALUATOR_RUBRIC),
  fixtureSchemaVersion: BRAND_PROFILE_EVAL_FIXTURE_SCHEMA_VERSION,
  evaluationPolicyVersion: 'brand-profile-evaluation-policy/2',
  sourceFiles,
  sourceBundleSha256: sha256CanonicalJson(sourceFiles),
};
const fixtureContracts = new Map<string, EvalFixtureContract>();

function contractForFixture(
  fixture: BrandProfileEvalFixture,
  input: Parameters<typeof BRAND_PROFILE_TASK.buildPrompt>[0],
): EvalFixtureContract {
  const existing = fixtureContracts.get(fixture.id);
  if (existing) return existing;
  const contract = {
    ...taskContract,
    fixtureId: fixture.id,
    fixtureSha256: sha256CanonicalJson(fixture),
    promptSha256: sha256Text(BRAND_PROFILE_TASK.buildPrompt(input)),
  };
  fixtureContracts.set(fixture.id, contract);
  return contract;
}

const modelExecutions = models.map((model) => ({
  model,
  route: candidateRoute(model),
  modelGateway: gatewayFor(model),
  transport: transportForCandidate(model),
}));

for (const { model, route, modelGateway, transport } of modelExecutions) {
  progress('model_started', {
    model,
    transport,
    expectedRuns: fixtures.length * repeats,
    timeoutMs: route.timeoutMs,
  });
  const probe = gateway.requestedModelsPresent[model]
    ? await probeCandidate(modelGateway, route, model)
    : {
        requestedModel: model,
        transport,
        accepted: false,
        elapsedMs: 0,
        error: 'requested model absent from current new-api model catalog',
      };
  probes.push(probe);
}

const preflightPassed = probes.every((probe) => probe.accepted === true);
if (!preflightPassed) {
  progress('matrix_skipped', { reason: 'capability_probe_failed' });
}

if (preflightPassed) {
  matrix: for (const {
    model,
    route,
    modelGateway,
    transport,
  } of modelExecutions) {
    for (const fixture of fixtures) {
      const prepared = prepareBrandProfileEvalFixture(fixture);
      const fixtureContract = contractForFixture(fixture, prepared.input);
      for (let attempt = 1; attempt <= repeats; attempt += 1) {
        const started = performance.now();
        progress('run_started', {
          model,
          transport,
          fixtureId: fixture.id,
          attempt,
          completedRuns: runs.length,
          expectedRunCount,
          timeoutMs: route.timeoutMs,
        });
        let rejectedOutput: BrandProfileOutput | undefined;
        let evaluatedArtifactSha256: string | undefined;
        try {
          const task = {
            ...BRAND_PROFILE_TASK,
            validateOutput: (
              input: Parameters<
                NonNullable<typeof BRAND_PROFILE_TASK.validateOutput>
              >[0],
              output: BrandProfileOutput,
            ) => {
              evaluatedArtifactSha256 = sha256CanonicalJson(output);
              if (diagnosticRouteValidationBypass) return;
              try {
                BRAND_PROFILE_TASK.validateOutput?.(input, output);
              } catch (error) {
                if (diagnosticCaptureRejectedOutput) rejectedOutput = output;
                throw error;
              }
            },
          };
          const result = await runAiTask(task, prepared.input, {
            gateway: modelGateway,
            ctx: {
              workspaceId: EVAL_WORKSPACE_ID,
              runId: `model1-eval:${model}:${fixture.id}:${attempt}`,
            },
            route,
          });
          if (diagnosticRouteValidationBypass) {
            progress('diagnostic_gaps', {
              model,
              fixtureId: fixture.id,
              attempt,
              gaps: result.data.gaps,
            });
          }
          if (diagnosticCaptureRejectedOutput) {
            progress('diagnostic_validated_output', {
              model,
              fixtureId: fixture.id,
              attempt,
              gaps: result.data.gaps,
            });
          }
          const outcome = evaluateBrandProfileOutput(prepared, result.data);
          runs.push({
            model,
            requestedModel: model,
            transport,
            provider: result.provider,
            resolvedModel: result.model,
            reportedModel: result.reportedModel,
            modelResolutionSource: result.modelResolutionSource,
            fixtureId: fixture.id,
            targetMarkets: fixture.targetMarkets,
            materialCompleteness: fixture.materialCompleteness,
            attempt,
            acceptedArtifact: outcome.acceptedArtifact,
            elapsedMs: Math.round(performance.now() - started),
            acceptedFactCount: outcome.acceptedFactCount,
            rejectedFactCount: outcome.rejectedFactCount,
            missingAcceptedTerms: outcome.missingAcceptedTerms,
            forbiddenOutputTerms: outcome.forbiddenOutputTerms,
            modelSnapshot: result.modelSnapshot,
            fallbackIndex: result.fallbackIndex,
            executionPolicy: snapshotEvaluationExecutionPolicy(
              route,
              result.routePolicy,
            ),
            artifactSha256:
              evaluatedArtifactSha256 ?? sha256CanonicalJson(result.data),
            taskContract: fixtureContract,
            usage: result.usage,
            acceptedArtifactCost: {
              reportedCostUsd: null,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              note: 'new-api response does not report costUsd; token totals are retained for later price reconciliation.',
            },
          });
          progress('run_completed', {
            model,
            fixtureId: fixture.id,
            attempt,
            acceptedArtifact: outcome.acceptedArtifact,
            acceptedFactCount: outcome.acceptedFactCount,
            rejectedFactCount: outcome.rejectedFactCount,
            missingAcceptedTerms: outcome.missingAcceptedTerms,
            forbiddenOutputTerms: outcome.forbiddenOutputTerms,
            elapsedMs: runs.at(-1)?.elapsedMs,
          completedRuns: runs.length,
          expectedRunCount,
        });
        if (evidenceRole === 'candidate' && !outcome.acceptedArtifact) {
          progress('matrix_fail_fast', {
            model,
            fixtureId: fixture.id,
            attempt,
            reason: 'candidate_artifact_rejected',
          });
          break matrix;
        }
      } catch (error) {
          if (diagnosticCaptureRejectedOutput && rejectedOutput) {
            progress('diagnostic_rejected_output', {
              model,
              fixtureId: fixture.id,
              attempt,
              gaps: rejectedOutput.gaps,
            });
          }
          const usage = error instanceof AiTaskError ? error.usage : undefined;
          const finalAttempt =
            error instanceof AiTaskError ? error.attempts.at(-1) : undefined;
          runs.push({
            model,
            requestedModel: model,
            transport,
            provider: finalAttempt?.provider,
            resolvedModel: finalAttempt?.resolvedModel,
            reportedModel: finalAttempt?.reportedModel,
            modelResolutionSource: finalAttempt?.modelResolutionSource,
            fixtureId: fixture.id,
            targetMarkets: fixture.targetMarkets,
            materialCompleteness: fixture.materialCompleteness,
            attempt,
            acceptedArtifact: false,
            elapsedMs: Math.round(performance.now() - started),
            usage,
            executionPolicy: snapshotEvaluationExecutionPolicy(route),
            artifactSha256: evaluatedArtifactSha256,
            taskContract: fixtureContract,
            acceptedArtifactCost: {
              reportedCostUsd: null,
              inputTokens: usage?.inputTokens ?? 0,
              outputTokens: usage?.outputTokens ?? 0,
              note: 'A failed call can still consume tokens; new-api does not report costUsd for reconciliation.',
            },
            error: error instanceof Error ? error.message : String(error),
          });
          progress('run_completed', {
            model,
            fixtureId: fixture.id,
            attempt,
            acceptedArtifact: false,
            error:
              error instanceof Error
                ? error.message.slice(0, 500)
                : String(error).slice(0, 500),
            elapsedMs: runs.at(-1)?.elapsedMs,
          completedRuns: runs.length,
          expectedRunCount,
        });
        if (evidenceRole === 'candidate') {
          progress('matrix_fail_fast', {
            model,
            fixtureId: fixture.id,
            attempt,
            reason: 'candidate_run_failed',
          });
          break matrix;
        }
      }
      }
    }
  }
}

const summary = models.map((model) => {
  const rows = runs.filter((run) => run.model === model);
  const capabilityProbe = probes.find(
    (probe) => probe.requestedModel === model,
  );
  const accepted = rows.filter((run) => run.acceptedArtifact === true);
  const latencies = rows
    .map((run) => run.elapsedMs)
    .filter((value): value is number => typeof value === 'number');
  return {
    model,
    transport: transportForCandidate(model),
    capabilityProbe,
    matrixSkipped: capabilityProbe?.accepted !== true,
    expectedRuns: fixtures.length * repeats,
    runs: rows.length,
    missingRuns: fixtures.length * repeats - rows.length,
    acceptedArtifacts: accepted.length,
    // A failed probe or incomplete matrix is a failure, never a misleading 0/0.
    hardFailures: fixtures.length * repeats - accepted.length,
    p95LatencyMs: percentile95(latencies),
    attemptedTokenTotals: rows.reduce(
      (total, row) => {
        const usage = row.usage;
        return {
          inputTokens: total.inputTokens + (usage?.inputTokens ?? 0),
          outputTokens: total.outputTokens + (usage?.outputTokens ?? 0),
        };
      },
      { inputTokens: 0, outputTokens: 0 },
    ),
    acceptedArtifactTokenTotals: accepted.reduce(
      (total, row) => {
        const usage = row.usage;
        return {
          inputTokens: total.inputTokens + (usage?.inputTokens ?? 0),
          outputTokens: total.outputTokens + (usage?.outputTokens ?? 0),
        };
      },
      { inputTokens: 0, outputTokens: 0 },
    ),
  };
});

const matrixIntegrity = inspectEvaluationMatrix(
  models,
  fixtures.map((fixture) => fixture.id),
  repeats,
  runs,
);
const diagnosticsEnabled =
  matrixScope !== 'full' ||
  diagnosticRouteValidationBypass ||
  diagnosticCaptureRejectedOutput;
const artifactFailures = runs.filter(
  (run) => run.acceptedArtifact !== true,
).length;
const promotionEligible =
  evidenceRole === 'candidate' &&
  !diagnosticsEnabled &&
  preflightPassed &&
  matrixIntegrity.complete &&
  artifactFailures === 0 &&
  probes.every(
    (probe) =>
      probe.provider === EVAL_PROVIDER_ID &&
      isExactUpstreamModelResolution(probe),
  ) &&
  runs.every(
    (run) =>
      run.provider === EVAL_PROVIDER_ID &&
      isExactUpstreamModelResolution(run),
  );
const status = !preflightPassed
  ? 'failed_preflight'
  : !matrixIntegrity.complete
    ? 'failed_incomplete_matrix'
    : artifactFailures > 0
      ? 'completed_with_failures'
      : diagnosticsEnabled
        ? 'completed_diagnostic'
        : promotionEligible
          ? 'completed_eligible'
          : 'completed_unproven_provenance';

const report = JSON.stringify(
  {
    schemaVersion: 'site-builder-model1-brand-profile-report/v5',
    generatedAt: new Date().toISOString(),
    evidenceRole,
    status,
    promotionEligible,
    gateway,
    matrixScope,
    diagnosticOptions: {
      routeValidationBypassed: diagnosticRouteValidationBypass,
      rejectedOutputCaptured: diagnosticCaptureRejectedOutput,
    },
    allFixtureCount: allFixtures.length,
    selectedFixtureIds: fixtures.map((fixture) => fixture.id),
    repeats,
    fixtureCount: fixtures.length,
    timePlan,
    matrixIntegrity,
    taskContract,
    fixtureContracts: [...fixtureContracts.values()],
    probes,
    summary,
    runs,
  },
  null,
  2,
);
if (reportPath)
  await writeFile(reportPath, `${report}\n`, { encoding: 'utf8', flag: 'wx' });
progress('evaluation_completed', {
  reportPath: reportPath ?? null,
  completedRuns: runs.length,
  expectedRunCount,
  probeFailures: probes.filter((probe) => probe.accepted !== true).length,
  artifactFailures,
  status,
  promotionEligible,
});
console.log(report);

if (
  !preflightPassed ||
  !matrixIntegrity.complete ||
  artifactFailures > 0 ||
  (!diagnosticsEnabled && !promotionEligible)
) {
  process.exitCode = 1;
}
