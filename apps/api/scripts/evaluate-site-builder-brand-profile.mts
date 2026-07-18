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
import {
  OpenAICompatibleProvider,
  type GatewayModelTransport,
} from '../src/model-gateway/providers/openai-compatible.provider';
import { ProviderOutputError } from '../src/model-gateway/providers/provider-output-error';
import { RouterModelGateway } from '../src/model-gateway/router-model-gateway';
import { AiTaskError, runAiTask } from '../src/site-builder/agents/ai-task';
import { BRAND_PROFILE_PROMPT_VERSION } from '../src/site-builder/agents/brand-profile';
import {
  BRAND_PROFILE_EVALUATOR_RUBRIC,
  BRAND_PROFILE_EVALUATOR_VERSION,
  BRAND_PROFILE_TASK,
  evaluateBrandProfileOutput,
  prepareBrandProfileEvalFixture,
  type BrandProfileEvalFixture,
} from '../src/site-builder/eval/brand-profile-eval';
import {
  sha256CanonicalJson,
  sha256Text,
  runWithEvaluationDeadline,
  snapshotEvaluationExecutionPolicy,
  type EvaluationExecutionPolicy,
} from '../src/site-builder/eval/eval-provenance';
import { resolveTaskRoute, type TaskRoute } from '../src/site-builder/agents/task-routes';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../test/fixtures/golden-companies/brand-profile',
);
const EVAL_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const CAPABILITY_PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string', const: 'ok' } },
} as const;

/**
 * These are evaluation-only protocol selections, established by real gateway
 * probes. Production keeps its existing provider configuration until a later
 * per-task promotion PR explicitly activates a tested route.
 */
const EVALUATION_TRANSPORTS: Readonly<Record<string, GatewayModelTransport>> = Object.freeze({
  'gpt-5.6-terra': 'openai-responses',
  'claude-sonnet-5': 'anthropic-messages',
});

function transportForCandidate(model: string): GatewayModelTransport {
  return EVALUATION_TRANSPORTS[model] ?? 'openai-chat-completions';
}

interface EvalUsage {
  inputTokens?: number;
  outputTokens?: number;
  calls?: number;
}

interface EvalTaskContract {
  taskId: string;
  promptVersion: string;
  outputSchemaSha256: string;
  evaluatorVersion: string;
  evaluatorRubricSha256: string;
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
 * Keep stdout as one final JSON report. A partial matrix is never evidence for
 * promotion, so it is intentionally not written as a report. Stderr instead
 * receives a JSON line at each bounded unit of work for liveness monitoring.
 */
function progress(event: string, details: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ event, at: new Date().toISOString(), ...details })}\n`);
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
  const names = (await readdir(FIXTURE_DIR)).filter((name) => name.endsWith('.json')).sort();
  const fixtures = await Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(FIXTURE_DIR, name), 'utf8')) as BrandProfileEvalFixture),
  );
  if (fixtures.length !== 6) throw new Error(`expected exactly 6 BrandProfile fixtures, found ${fixtures.length}`);
  return fixtures;
}

function candidateRoute(model: string): TaskRoute {
  const current = resolveTaskRoute('site_builder.brand_profile', {});
  return {
    ...current,
    primary: model,
    fallbacks: [],
    policy: {
      ...current.policy,
      source: 'env_override',
      route: { primary: model, fallbacks: [] },
    },
  };
}

function gatewayFor(model: string): RouterModelGateway {
  const registry = new ModelProviderRegistry();
  registry.register(
    new OpenAICompatibleProvider({
      id: 'new-api-eval',
      baseUrl: required('MODEL_GATEWAY_URL'),
      apiKey: required('MODEL_GATEWAY_KEY'),
      model,
      modelTransports: EVALUATION_TRANSPORTS,
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
  progress('capability_probe_started', { model: requestedModel, transport, timeoutMs: route.timeoutMs });
  try {
    const result = await runWithEvaluationDeadline(
      // A probe is still an operation for this task: inherit the task's
      // calibrated timeout rather than inventing a global fixed number.
      route.timeoutMs,
      (signal) => gateway.generateStructured<{ status: 'ok' }>(
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
      usage: result.usage,
    };
    progress('capability_probe_completed', { model: requestedModel, transport, accepted: true, elapsedMs: probe.elapsedMs });
    return probe;
  } catch (error) {
    const usage = error instanceof ProviderOutputError ? error.usage : undefined;
    const probe = {
      requestedModel,
      transport,
      accepted: false,
      elapsedMs: Math.round(performance.now() - started),
      usage,
      error: error instanceof Error ? error.message : String(error),
    };
    progress('capability_probe_completed', { model: requestedModel, transport, accepted: false, elapsedMs: probe.elapsedMs });
    return probe;
  }
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

const repeats = positiveInt('MODEL_EVAL_REPEATS', 2);
const models = (process.env.MODEL_EVAL_MODELS ?? 'gpt-5.6-terra,claude-sonnet-5')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
if (models.length === 0) throw new Error('MODEL_EVAL_MODELS must contain at least one model');

const fixtures = await loadFixtures();
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
  absoluteMaximumWallClockMs: models.length * (1 + fixtures.length * repeats) * evaluationRoute.timeoutMs,
};
progress('evaluation_started', { models, ...timePlan });
const taskContract: EvalTaskContract = {
  taskId: BRAND_PROFILE_TASK.id,
  promptVersion: BRAND_PROFILE_PROMPT_VERSION,
  outputSchemaSha256: sha256CanonicalJson(BRAND_PROFILE_TASK.outputSchema),
  evaluatorVersion: BRAND_PROFILE_EVALUATOR_VERSION,
  evaluatorRubricSha256: sha256CanonicalJson(BRAND_PROFILE_EVALUATOR_RUBRIC),
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

for (const model of models) {
  const route = candidateRoute(model);
  const gateway = gatewayFor(model);
  const transport = transportForCandidate(model);
  progress('model_started', { model, transport, expectedRuns: fixtures.length * repeats, timeoutMs: route.timeoutMs });
  const probe = await probeCandidate(gateway, route, model);
  probes.push(probe);
  if (probe.accepted !== true) {
    progress('model_skipped', { model, reason: 'capability_probe_failed' });
    continue;
  }
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
      try {
        const result = await runAiTask(BRAND_PROFILE_TASK, prepared.input, {
          gateway,
          ctx: { workspaceId: EVAL_WORKSPACE_ID, runId: `model1-eval:${model}:${fixture.id}:${attempt}` },
          route,
        });
        const outcome = evaluateBrandProfileOutput(prepared, result.data);
        runs.push({
          model,
          requestedModel: model,
          transport,
          provider: result.provider,
          resolvedModel: result.model,
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
          executionPolicy: snapshotEvaluationExecutionPolicy(route, result.routePolicy),
          artifactSha256: sha256CanonicalJson(result.data),
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
          elapsedMs: runs.at(-1)?.elapsedMs,
          completedRuns: runs.length,
          expectedRunCount,
        });
      } catch (error) {
        const usage = error instanceof AiTaskError ? error.usage : undefined;
        runs.push({
          model,
          requestedModel: model,
          transport,
          fixtureId: fixture.id,
          targetMarkets: fixture.targetMarkets,
          materialCompleteness: fixture.materialCompleteness,
          attempt,
          acceptedArtifact: false,
          elapsedMs: Math.round(performance.now() - started),
          usage,
          executionPolicy: snapshotEvaluationExecutionPolicy(route),
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
          elapsedMs: runs.at(-1)?.elapsedMs,
          completedRuns: runs.length,
          expectedRunCount,
        });
      }
    }
  }
}

const summary = models.map((model) => {
  const rows = runs.filter((run) => run.model === model);
  const capabilityProbe = probes.find((probe) => probe.requestedModel === model);
  const accepted = rows.filter((run) => run.acceptedArtifact === true);
  const latencies = rows
    .map((run) => run.elapsedMs)
    .filter((value): value is number => typeof value === 'number');
  return {
    model,
    transport: transportForCandidate(model),
    capabilityProbe,
    matrixSkipped: capabilityProbe?.accepted !== true,
    runs: rows.length,
    acceptedArtifacts: accepted.length,
    hardFailures: rows.length - accepted.length,
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

const report = JSON.stringify(
  {
    schemaVersion: 'site-builder-model1-brand-profile-report/v3',
    generatedAt: new Date().toISOString(),
    repeats,
    fixtureCount: fixtures.length,
    timePlan,
    taskContract,
    fixtureContracts: [...fixtureContracts.values()],
    probes,
    summary,
    runs,
  },
  null,
  2,
);
const reportPath = process.env.MODEL_EVAL_REPORT_PATH?.trim();
if (reportPath) await writeFile(reportPath, `${report}\n`, { encoding: 'utf8', flag: 'wx' });
progress('evaluation_completed', {
  reportPath: reportPath ?? null,
  completedRuns: runs.length,
  expectedRunCount,
  probeFailures: probes.filter((probe) => probe.accepted !== true).length,
  artifactFailures: runs.filter((run) => run.acceptedArtifact !== true).length,
});
console.log(report);

if (probes.some((probe) => probe.accepted !== true) || runs.some((run) => run.acceptedArtifact !== true)) {
  process.exitCode = 1;
}
