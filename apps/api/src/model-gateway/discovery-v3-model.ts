import type { Prisma } from '@prisma/client';
import { projectModelResultForReplay, restoreModelResultFromReplay } from '../durable-results/model-result-replay';
import type { GenericOperationProjection } from '../tools/generic-operation-projection';
import {
  DiscoveryV3OperationError, discoveryV3Digest, type DiscoveryV3Cost, type DiscoveryV3OperationInput,
} from '../durable-results/discovery-v3-operation-contract';
import { currentDiscoveryV3OperationScope, discoveryV3WireSignal, persistDiscoveryV3WireReceipt } from '../durable-results/discovery-v3-operation-scope';
import { assertStatelessModelCallLimits } from '../execution-budget/legacy-execution-budget-mode';
import { definiteModelFailureCode } from './definite-model-failure';
import { discoveryV3GatewayReportedCost, type DiscoveryV3GatewayEvidence } from './discovery-v3-gateway-contract';
import {
  prepareDiscoveryV3GatewayWire, readDiscoveryV3GatewayEvidence, withDiscoveryV3GatewayWire,
  type DiscoveryV3GatewayReadbackRuntime,
} from './discovery-v3-gateway-readback';
import type { ModelProvider } from './model-provider';
import { microusdFromTokens } from './model-token-cost';
import { boundedModelTokenCount } from './model-usage-boundary';
import { OpenAICompatibleProvider } from './providers/openai-compatible.provider';
import { ProviderOutputError, ProviderOutputUnresolvedError, ProviderTransportError } from './providers/provider-output-error';
import {
  assertTenantDailyCostAllowed, recordTenantDailyCostObserved, resolveModelTaskTimeoutMs,
} from './router-model-gateway-bypass';
import { withTaskTimeoutSignal } from './task-timeout';
import type { TenantDailyCostBreaker } from './tenant-daily-cost-breaker';
import type { AiContext, ModelOp, ModelResult, ModelUsage } from './types';

type NativeScope = NonNullable<ReturnType<typeof currentDiscoveryV3OperationScope>>;
type WireInput = { task: string; model?: string; maxTokens?: number; signal?: AbortSignal };

function knownUsage(usage: ModelUsage | undefined) {
  return { inputTokens: boundedModelTokenCount(usage?.inputTokens), outputTokens: boundedModelTokenCount(usage?.outputTokens) };
}

export async function executeDiscoveryV3ModelCall<T>(options: {
  scope: NativeScope;
  context: AiContext;
  task: string;
  signal?: AbortSignal;
  provider: ModelProvider;
  registeredTask?: { timeoutMs?: number; maxOutputTokens?: number };
  settlementReadback?: DiscoveryV3GatewayReadbackRuntime;
  dailyCostBreaker?: TenantDailyCostBreaker;
  authorizeExternalAction: () => Promise<void>;
  call: (provider: ModelProvider, context: AiContext, signal?: AbortSignal) => Promise<ModelResult<T>>;
}): Promise<ModelResult<T>> {
  const { context, registeredTask, dailyCostBreaker } = options;
  if (context.paidCost || context.platformEgress) throw new Error('DISCOVERY_V3_MODEL_SCOPE_CONFLICT');
  const timeoutMs = resolveModelTaskTimeoutMs(registeredTask?.timeoutMs, true)!;
  const signal = withTaskTimeoutSignal(options.signal, timeoutMs);
  const provider = discoveryV3ModelProvider({
    scope: options.scope, context, provider: options.provider, timeoutMs,
    maxOutputTokens: registeredTask?.maxOutputTokens,
    settlementReadback: options.settlementReadback,
    authorize: async () => {
      await assertTenantDailyCostAllowed(dailyCostBreaker, context, options.task);
      await options.authorizeExternalAction();
    },
    observeSpend: (usage) => recordTenantDailyCostObserved(dailyCostBreaker, context, { usage }),
  });
  return options.call(provider, context, signal);
}

export function discoveryV3ModelProvider(input: {
  scope: NativeScope;
  context: AiContext;
  provider: ModelProvider;
  timeoutMs: number;
  maxOutputTokens: number | undefined;
  settlementReadback?: DiscoveryV3GatewayReadbackRuntime;
  authorize: () => Promise<void>;
  observeSpend: (usage: ModelUsage | undefined) => void;
}): ModelProvider {
  const { scope, context, provider } = input;
  // Assigned once per logical gateway call. The router invokes the decorated
  // provider again for structured repair, with its own wire ordinal.
  const step = `${scope.step}/model/${++scope.nextModel}`;
  let ordinal = 0;

  async function wire<I extends WireInput, T>(
    method: ModelOp, request: I, callContext: AiContext, send: (scoped: I, context: AiContext) => Promise<ModelResult<T>>,
  ): Promise<ModelResult<T>> {
    const maxTokens = request.maxTokens ?? Math.min(input.maxOutputTokens ?? 32_768, 32_768);
    assertStatelessModelCallLimits({ taskId: request.task, maxTokens, taskMaxOutputTokens: input.maxOutputTokens });
    const { signal: callerSignal, ...requestWithoutSignal } = request;
    scope.signal.throwIfAborted();
    callerSignal?.throwIfAborted();
    // The bytes that establish admission must survive awaits and later caller edits.
    const snapshot = JSON.parse(JSON.stringify({ ...requestWithoutSignal, maxTokens })) as Prisma.InputJsonObject;
    const outbound = { ...requestWithoutSignal, ...snapshot, maxTokens } as I;
    const operation: DiscoveryV3OperationInput = {
      step, kind: 'MODEL', ordinal: ++ordinal, provider: provider.id, action: request.task, method,
      maxDurationMs: input.timeoutMs,
      requestSha256: discoveryV3Digest({ ...snapshot, projectionSchema: context.durableResultSchema ?? null }),
    };
    const workerAttempt = scope.workerAttempt ?? 1;
    const claim = await scope.store.claim(scope.command, operation, workerAttempt);
    if (claim.status === 'REPLAY' && claim.result && claim.resultSha256 && context.durableResultSchema) {
      const result = restoreModelResultFromReplay(context.durableResultSchema, claim.result) as ModelResult<T>;
      scope.onResult?.({ operation, operationId: claim.operationId, resultSha256: claim.resultSha256 });
      return result;
    }
    if (claim.status !== 'CLAIMED') throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_UNRESOLVED');
    const readbackRuntime = input.settlementReadback;
    const target = { command: scope.command, operation, operationId: claim.operationId };
    let readbackWire: ReturnType<typeof prepareDiscoveryV3GatewayWire> | undefined;
    const readEvidence = (usage: ModelUsage | undefined) => readbackRuntime && readbackWire?.dispatched
      ? readDiscoveryV3GatewayEvidence({ ...target, runtime: readbackRuntime, binding: readbackWire.binding,
          store: scope.store, probeSequence: 1, usage: knownUsage(usage) })
      : undefined;
    const settle = async (
      outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN', usage?: ModelUsage, model?: string,
      result?: GenericOperationProjection, notBilled = false, evidence?: DiscoveryV3GatewayEvidence,
    ) => {
      const counts = knownUsage(evidence ?? usage);
      const reportedUsd = readbackWire ? undefined : usage?.costUsd;
      const reportedMicros = typeof reportedUsd === 'number' && reportedUsd >= 0 ? Math.round(reportedUsd * 1_000_000) : NaN;
      const estimatedMicros = microusdFromTokens(counts);
      const gatewayCost = evidence && discoveryV3GatewayReportedCost(evidence);
      let cost: DiscoveryV3Cost;
      if (gatewayCost) {
        cost = gatewayCost;
      } else if (Number.isSafeInteger(reportedMicros)) {
        cost = {
          basis: 'PROVIDER_REPORTED', currency: 'USD', amountMicros: reportedMicros,
          evidenceSha256: discoveryV3Digest([claim.operationId, operation.requestSha256, provider.id, model ?? null, reportedMicros, counts]),
        };
      } else if (notBilled) {
        cost = {
          basis: 'CONFIRMED_ZERO', currency: 'USD', amountMicros: 0,
          evidenceSha256: discoveryV3Digest([claim.operationId, operation.requestSha256, 'no_wire']),
        };
      } else if (estimatedMicros !== null && Number.isSafeInteger(estimatedMicros)) {
        cost = { basis: 'ESTIMATED', currency: 'USD', amountMicros: estimatedMicros, source: 'token' };
      } else {
        cost = { basis: 'UNKNOWN' };
      }
      await persistDiscoveryV3WireReceipt(scope, operation, claim, {
        outcome, usage: counts, model: model ?? readbackWire?.binding.alias, result, cost,
      });
      if (cost.basis === 'PROVIDER_REPORTED' && cost.currency === 'USD') {
        input.observeSpend({ costUsd: cost.amountMicros / 1_000_000 });
      }
    };
    let signal: AbortSignal;
    try {
      await input.authorize();
      if (readbackRuntime && provider instanceof OpenAICompatibleProvider) {
        readbackWire = prepareDiscoveryV3GatewayWire(readbackRuntime, target,
          provider.discoveryV3GatewayRoute(callContext, outbound.model, maxTokens));
      }
      const authorizationStarted = performance.now();
      const remaining = await scope.store.authorizeSend(scope.command, operation, claim, workerAttempt, readbackWire?.binding);
      signal = discoveryV3WireSignal(scope.signal, remaining, authorizationStarted, callerSignal);
      signal.throwIfAborted();
    } catch (error) {
      // A replacement activity may already have parked the original
      // operation. A local denial still proves that this holder sent nothing.
      await settle('FAILED', undefined, outbound.model, undefined, true);
      throw error;
    }
    let result: ModelResult<T>;
    try {
      const bounded = { ...outbound, signal };
      result = readbackWire
        ? await withDiscoveryV3GatewayWire(callContext, readbackWire, (boundContext) => send(bounded, boundContext))
        : await send(bounded, callContext);
    } catch (error) {
      const knownReply = error instanceof ProviderOutputError &&
        !(error instanceof ProviderOutputUnresolvedError) && !(error instanceof ProviderTransportError);
      const definite = definiteModelFailureCode(error);
      const usage = error instanceof ProviderOutputError ? error.usage : undefined;
      const notBilled = (readbackWire && !readbackWire.dispatched) || definite === 'MODEL_PROVIDER_CONNECTION_NOT_ESTABLISHED';
      const evidence = notBilled ? undefined : await readEvidence(usage);
      await settle(knownReply || definite || notBilled ? 'FAILED' : 'UNKNOWN', usage,
        error instanceof ProviderOutputError ? error.model ?? outbound.model : outbound.model, undefined,
        notBilled, evidence);
      throw error;
    }
    const evidence = await readEvidence(result.usage);
    let projection: GenericOperationProjection | undefined;
    if (context.durableResultSchema) {
      try {
        projection = projectModelResultForReplay(context.durableResultSchema, result);
      } catch {
        // A repair must be reproducible from the original bounded answer.
        await settle('FAILED', result.usage, result.model, undefined, false, evidence);
        throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_INVALID');
      }
    }
    await settle('SUCCEEDED', result.usage, result.model, projection, false, evidence);
    if (projection) scope.onResult?.({ operation, operationId: claim.operationId, resultSha256: projection.digest });
    return result;
  }

  return {
    id: provider.id,
    supports: (method, task) => provider.supports(method, task),
    health: () => provider.health(),
    generateText: (request, ctx) => wire('generateText', request, ctx, (bounded, boundContext) => provider.generateText(bounded, boundContext)),
    generateStructured: <T>(request: Parameters<ModelProvider['generateStructured']>[0], ctx: AiContext) =>
      wire('generateStructured', request, ctx, (bounded, boundContext) => provider.generateStructured<T>(bounded, boundContext)),
    generateChatWithTools: provider.generateChatWithTools
      ? (request, ctx) => wire('generateChatWithTools', request, ctx, (bounded, boundContext) => provider.generateChatWithTools!(bounded, boundContext))
      : undefined,
    embed: () => Promise.reject(new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_INVALID')),
    reviewVision: () => Promise.reject(new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_INVALID')),
  };
}
