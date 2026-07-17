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
import { OpenAICompatibleProvider } from '../src/model-gateway/providers/openai-compatible.provider';
import { ProviderOutputError } from '../src/model-gateway/providers/provider-output-error';
import { RouterModelGateway } from '../src/model-gateway/router-model-gateway';
import { AiTaskError, runAiTask } from '../src/site-builder/agents/ai-task';
import {
  BRAND_PROFILE_TASK,
  evaluateBrandProfileOutput,
  prepareBrandProfileEvalFixture,
  type BrandProfileEvalFixture,
} from '../src/site-builder/eval/brand-profile-eval';
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

interface EvalUsage {
  inputTokens?: number;
  outputTokens?: number;
  calls?: number;
}

interface EvalProbe {
  requestedModel: string;
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
  usage?: EvalUsage;
  acceptedArtifactCost: {
    reportedCostUsd: null;
    inputTokens: number;
    outputTokens: number;
    note: string;
  };
  error?: string;
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
  try {
    const result = await gateway.generateStructured<{ status: 'ok' }>(
      {
        task: 'site_builder.brand_profile.capability_probe',
        prompt: 'Return exactly {"status":"ok"}.',
        schema: CAPABILITY_PROBE_SCHEMA,
        model: requestedModel,
        maxTokens: 128,
        maxCostCents: route.maxCostCents,
      },
      {
        workspaceId: EVAL_WORKSPACE_ID,
        runId: `model1-probe:${requestedModel}`,
        modelPolicy: { ...route.policy, fallbackIndex: 0 },
      },
    );
    if (result.provider === 'stub' || result.data.status !== 'ok') {
      throw new Error('capability probe returned an unusable response');
    }
    return {
      requestedModel,
      accepted: true,
      elapsedMs: Math.round(performance.now() - started),
      provider: result.provider,
      resolvedModel: result.model,
      usage: result.usage,
    };
  } catch (error) {
    const usage = error instanceof ProviderOutputError ? error.usage : undefined;
    return {
      requestedModel,
      accepted: false,
      elapsedMs: Math.round(performance.now() - started),
      usage,
      error: error instanceof Error ? error.message : String(error),
    };
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

for (const model of models) {
  const route = candidateRoute(model);
  const gateway = gatewayFor(model);
  const probe = await probeCandidate(gateway, route, model);
  probes.push(probe);
  if (probe.accepted !== true) continue;
  for (const fixture of fixtures) {
    const prepared = prepareBrandProfileEvalFixture(fixture);
    for (let attempt = 1; attempt <= repeats; attempt += 1) {
      const started = performance.now();
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
          usage: result.usage,
          acceptedArtifactCost: {
            reportedCostUsd: null,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            note: 'new-api response does not report costUsd; token totals are retained for later price reconciliation.',
          },
        });
      } catch (error) {
        const usage = error instanceof AiTaskError ? error.usage : undefined;
        runs.push({
          model,
          requestedModel: model,
          fixtureId: fixture.id,
          targetMarkets: fixture.targetMarkets,
          materialCompleteness: fixture.materialCompleteness,
          attempt,
          acceptedArtifact: false,
          elapsedMs: Math.round(performance.now() - started),
          usage,
          acceptedArtifactCost: {
            reportedCostUsd: null,
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            note: 'A failed call can still consume tokens; new-api does not report costUsd for reconciliation.',
          },
          error: error instanceof Error ? error.message : String(error),
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
    schemaVersion: 'site-builder-model1-brand-profile-report/v1',
    generatedAt: new Date().toISOString(),
    repeats,
    fixtureCount: fixtures.length,
    probes,
    summary,
    runs,
  },
  null,
  2,
);
const reportPath = process.env.MODEL_EVAL_REPORT_PATH?.trim();
if (reportPath) await writeFile(reportPath, `${report}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(report);

if (probes.some((probe) => probe.accepted !== true) || runs.some((run) => run.acceptedArtifact !== true)) {
  process.exitCode = 1;
}
