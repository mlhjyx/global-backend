import type { ModelGateway } from '../model-gateway/model-gateway';
import { checkAgainstSchema } from '../model-gateway/schema-validate';
import type { AiContext, ModelResolutionSource, ModelResult } from '../model-gateway/types';
import {
  getModelCandidateCatalogEntry,
  type ModelCandidateProtocol,
} from '../site-builder/agents/model-candidate-baseline';
import type { SiteBuilderTaskId, TaskRoute } from '../site-builder/agents/task-routes';
import { canonicalDigest, ContextEngine } from './context-engine';
import { ModelExecutionRuntime } from './model-execution-runtime';
import type {
  ContextSegment,
  ModelExecutionState,
  ModelProtocol,
  ReasoningLevel,
  RuntimeTelemetry,
  TaskModelContract,
} from './types';

const SITE_BUILDER_CONTEXT_WINDOW = 128_000;

const PROTOCOLS: Readonly<Partial<Record<ModelCandidateProtocol, ModelProtocol>>> = Object.freeze({
  'openai-responses': 'openai_responses',
  'openai-chat-completions': 'openai_chat_completions',
  'anthropic-messages': 'anthropic_messages',
  'google-generate-content': 'google_native',
});

export interface SiteBuilderRuntimeTaskDefinition<Input, Output> {
  id: SiteBuilderTaskId;
  contractVersion?: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  buildPrompt: (input: Input) => string;
  validateOutput?: (input: Input, output: Output) => void;
  repairTaskOutput?: boolean;
  system?: string;
}

export interface SiteBuilderRuntimeExecutionMetadata {
  contractVersion: string;
  contextDigest: string;
  promptDigest: string;
  states: readonly ModelExecutionState[];
  transportAttempts: number;
  repairAttempts: number;
  /** Physical gateway calls, including its existing single closed repair. */
  physicalCalls: number;
  gatewayRepairCalls: number;
  requestedAlias: string;
  runtimeResolvedAlias: string;
  gatewayResolvedModel: string;
  provider: string;
  reportedModel?: string;
  modelResolutionSource?: ModelResolutionSource;
}

interface ExecuteSiteBuilderAttemptOptions<Input, Output> {
  definition: SiteBuilderRuntimeTaskDefinition<Input, Output>;
  input: Input;
  prompt: string;
  route: TaskRoute;
  model: string;
  fallbackIndex: number;
  gateway: ModelGateway;
  context: AiContext;
  signal: AbortSignal;
  allowInjectedTestAlias: boolean;
  telemetry?: RuntimeTelemetry;
}

export interface SiteBuilderRuntimeAttemptResult<Output> {
  gatewayResult: ModelResult<Output>;
  runtime: SiteBuilderRuntimeExecutionMetadata;
}

function reasoningLevel(route: TaskRoute): ReasoningLevel {
  return route.reasoningEffort ?? 'none';
}

function reasoningReserve(level: ReasoningLevel): number {
  if (level === 'high') return 2_048;
  if (level === 'medium') return 1_024;
  if (level === 'low') return 256;
  return 0;
}

function estimateTokens(content: unknown): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(content), 'utf8') / 3));
}

function resolveProtocol(alias: string, allowInjectedTestAlias: boolean): ModelProtocol {
  try {
    const candidate = getModelCandidateCatalogEntry(alias);
    const resolved = candidate.expectedProtocols.map((protocol) => PROTOCOLS[protocol]).find(Boolean);
    if (!resolved) throw new Error(`model alias has no supported text protocol: ${alias}`);
    return resolved;
  } catch (error) {
    if (allowInjectedTestAlias) return 'openai_chat_completions';
    throw error;
  }
}

function segment(
  value: Omit<ContextSegment, 'sourceDigest' | 'estimatedTokens'> & { estimatedTokens?: number },
): ContextSegment {
  return {
    ...value,
    sourceDigest: canonicalDigest(value.content),
    estimatedTokens: value.estimatedTokens ?? estimateTokens(value.content),
  };
}

export async function executeSiteBuilderModelAttempt<Input, Output>(
  options: ExecuteSiteBuilderAttemptOptions<Input, Output>,
): Promise<SiteBuilderRuntimeAttemptResult<Output>> {
  const contractVersion = options.definition.contractVersion
    ?? `site-builder-task-contract/${options.definition.id}/v1`;
  const promptVersion = `${contractVersion}/prompt-v1`;
  const protocol = resolveProtocol(options.model, options.allowInjectedTestAlias);
  const reasoning = reasoningLevel(options.route);
  const settlementRequired = options.context.paidCost !== undefined;
  const policyRef = `task-policy:${options.definition.id}@${contractVersion}`;
  const schemaRef = `task-schema:${options.definition.id}@${contractVersion}`;
  const inputRef = `task-input:${options.definition.id}@${canonicalDigest(options.input)}`;
  const requestRef = `task-prompt:${options.definition.id}@${promptVersion}`;
  const contextSegments = [
    segment({
      kind: 'policy',
      sourceRef: policyRef,
      sensitivity: 'public',
      cacheClass: 'stable-prefix',
      content: {
        taskId: options.definition.id,
        contractVersion,
        system: options.definition.system ?? '',
        dataPolicy: options.route.dataPolicy,
        gatewayRepair: options.definition.repairTaskOutput ? 'single_closed_repair' : 'disabled',
      },
    }),
    segment({
      kind: 'schema',
      sourceRef: schemaRef,
      sensitivity: 'public',
      cacheClass: 'stable-prefix',
      content: { input: options.definition.inputSchema, output: options.definition.outputSchema },
    }),
    segment({
      kind: 'facts',
      sourceRef: inputRef,
      sensitivity: 'workspace',
      cacheClass: 'request-local',
      content: options.input,
      relevance: 100,
    }),
    segment({
      kind: 'request',
      sourceRef: requestRef,
      sensitivity: 'workspace',
      cacheClass: 'request-local',
      content: { prompt: options.prompt },
    }),
  ];
  const context = new ContextEngine().assemble({
    workspaceId: options.context.workspaceId,
    policy: {
      version: `${contractVersion}/context-v1`,
      allowedSourceRefs: contextSegments.map((item) => item.sourceRef),
    },
    segments: contextSegments,
    budget: {
      contextWindow: SITE_BUILDER_CONTEXT_WINDOW,
      outputReserve: options.route.maxTokens,
      reasoningReserve: reasoningReserve(reasoning),
    },
  });
  const contract: TaskModelContract<Input, Output> = {
    taskId: options.definition.id,
    version: contractVersion,
    executionMode: 'generative',
    inputSchema: options.definition.inputSchema,
    outputSchema: options.definition.outputSchema,
    contextPolicy: {
      version: `${contractVersion}/context-v1`,
      allowedSourceRefs: contextSegments.map((item) => item.sourceRef),
    },
    capabilityRequirements: {
      protocols: [protocol],
      structuredOutput: true,
      reasoning,
      settlementRequired,
    },
    reasoningPolicy: { allowed: [reasoning], default: reasoning, reserveTokens: reasoningReserve(reasoning) },
    cachePolicy: { mode: 'disabled' },
    retryPolicy: { transportMaxAttempts: 1, contentRepairMaxAttempts: 0 },
    validateOutput: (input, output) => {
      const schema = checkAgainstSchema(options.definition.outputSchema, output);
      if (!schema.valid) throw new Error(`output invalid: ${(schema.errors ?? []).join('; ')}`);
      options.definition.validateOutput?.(input, output);
    },
  };
  let gatewayResult: ModelResult<Output> | undefined;
  const runtime = new ModelExecutionRuntime<Input, Output>({
    telemetry: options.telemetry,
    transport: {
      dispatch: async () => {
        gatewayResult = await options.gateway.generateStructured<Output>(
          {
            task: options.definition.id,
            prompt: options.prompt,
            system: options.definition.system,
            schema: options.definition.outputSchema,
            ...(options.definition.validateOutput
              ? { validateOutput: (output: unknown) => options.definition.validateOutput?.(options.input, output as Output) }
              : {}),
            ...(options.definition.repairTaskOutput ? { repairTaskOutput: true } : {}),
            model: options.model,
            maxTokens: options.route.maxTokens,
            maxCostCents: options.route.maxCostCents,
            reasoningEffort: options.route.reasoningEffort,
            signal: options.signal,
          },
          options.context,
        );
        return {
          output: gatewayResult.data,
          requestedAlias: options.model,
          resolvedAlias: options.model,
          reportedModel: gatewayResult.reportedModel,
          protocol,
          usage: {
            inputTokens: gatewayResult.usage?.inputTokens ?? 0,
            outputTokens: gatewayResult.usage?.outputTokens ?? 0,
          },
          ...(gatewayResult.usage?.gatewaySettlements?.at(-1)?.requestId
            ? { requestId: gatewayResult.usage.gatewaySettlements.at(-1)?.requestId ?? undefined }
            : {}),
          settlement: settlementRequired
            && (!gatewayResult.usage?.gatewaySettlements?.length
              || gatewayResult.usage.gatewaySettlements.some((item) => item.status === 'unknown'))
            ? 'unknown'
            : 'known',
        };
      },
    },
  });
  const promptMaterial = { system: options.definition.system ?? '', user: options.prompt };
  const result = await runtime.execute({
    executionId: `site-builder:${options.context.runId ?? options.context.workspaceId}:${options.definition.id}:${options.fallbackIndex}`,
    fallbackIndex: options.fallbackIndex,
    workspaceId: options.context.workspaceId,
    buildRunId: options.context.runId ?? options.context.workspaceId,
    contract,
    input: options.input,
    inputDigest: canonicalDigest(options.input),
    context,
    contextDigest: context.digest,
    promptVersion,
    schemaDigest: canonicalDigest(options.definition.outputSchema),
    requestedAlias: options.model,
    resolvedAlias: options.model,
    protocol,
    reasoning,
    sampling: {},
    locale: typeof (options.input as { locale?: unknown }).locale === 'string'
      ? (options.input as { locale: string }).locale
      : 'und',
    prompt: promptMaterial,
  });
  if (!gatewayResult) throw new Error('model runtime completed without a gateway observation');
  return {
    gatewayResult,
    runtime: {
      contractVersion,
      contextDigest: context.digest,
      promptDigest: canonicalDigest(promptMaterial),
      states: result.states,
      transportAttempts: result.transportAttempts,
      repairAttempts: result.repairAttempts,
      physicalCalls: gatewayResult.callCount ?? 1,
      gatewayRepairCalls: Math.max(0, (gatewayResult.callCount ?? 1) - 1),
      requestedAlias: options.model,
      runtimeResolvedAlias: options.model,
      gatewayResolvedModel: gatewayResult.model,
      provider: gatewayResult.provider,
      ...(gatewayResult.reportedModel ? { reportedModel: gatewayResult.reportedModel } : {}),
      ...(gatewayResult.modelResolutionSource
        ? { modelResolutionSource: gatewayResult.modelResolutionSource }
        : {}),
    },
  };
}
