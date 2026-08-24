import type { ModelGateway } from '../model-gateway/model-gateway';
import { checkAgainstSchema } from '../model-gateway/schema-validate';
import type {
  AiContext,
  GenerateStructuredInput,
  ModelResolutionSource,
  ModelResult,
} from '../model-gateway/types';
import { canonicalDigest, ContextEngine } from './context-engine';
import { ModelExecutionRuntime, unwrapModelExecutionError } from './model-execution-runtime';
import type { ModelExecutionState, ModelProtocol, ReasoningLevel, RuntimeTelemetry, TaskModelContract } from './types';

const STRUCTURED_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

export interface StructuredTaskRuntimeMetadata {
  contractVersion: string;
  protocol: ModelProtocol;
  contextDigest: string;
  promptDigest: string;
  states: readonly ModelExecutionState[];
  transportAttempts: number;
  repairAttempts: number;
  physicalCalls: number;
  gatewayRepairCalls: number;
  requestedAlias: string;
  runtimeResolvedAlias: string;
  gatewayResolvedModel: string;
  provider: string;
  reportedModel?: string;
  modelResolutionSource?: ModelResolutionSource;
}

export type RuntimeStructuredModelResult<Output> = ModelResult<Output> & {
  runtimeExecution: StructuredTaskRuntimeMetadata;
};

export interface StructuredTaskRuntimeOptions {
  contractVersion?: string;
  protocol?: ModelProtocol;
  telemetry?: RuntimeTelemetry;
}

function reasoning(input: GenerateStructuredInput): ReasoningLevel {
  return input.reasoningEffort ?? 'none';
}

function reasoningReserve(level: ReasoningLevel): number {
  if (level === 'high') return 2_048;
  if (level === 'medium') return 1_024;
  if (level === 'low') return 256;
  return 0;
}

function estimatedTokens(content: unknown): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(content), 'utf8') / 3));
}

export async function executeStructuredTaskWithRuntime<Output>(
  gateway: ModelGateway,
  input: GenerateStructuredInput,
  context: AiContext,
  options: StructuredTaskRuntimeOptions = {},
): Promise<RuntimeStructuredModelResult<Output>> {
  const contractVersion = options.contractVersion ?? `structured-task-contract/${input.task}/v1`;
  const protocol = options.protocol ?? 'openai_chat_completions';
  const requestedAlias = input.model ?? 'gateway-default';
  const effort = reasoning(input);
  const requestMaterial = {
    task: input.task,
    prompt: input.prompt,
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.model === undefined ? {} : { model: input.model }),
  };
  const policy = {
    task: input.task,
    contractVersion,
    system: input.system ?? '',
    model: requestedAlias,
    protocol,
    gatewayRepair: 'single_closed_repair',
  };
  const refs = {
    policy: `task-policy:${input.task}@${contractVersion}`,
    schema: `task-schema:${input.task}@${contractVersion}`,
    request: `task-request:${input.task}@${canonicalDigest(requestMaterial)}`,
  };
  const segments = [
    {
      kind: 'policy' as const,
      sourceRef: refs.policy,
      sourceDigest: canonicalDigest(policy),
      sensitivity: 'public' as const,
      cacheClass: 'stable-prefix' as const,
      estimatedTokens: estimatedTokens(policy),
      content: policy,
    },
    {
      kind: 'schema' as const,
      sourceRef: refs.schema,
      sourceDigest: canonicalDigest(input.schema),
      sensitivity: 'public' as const,
      cacheClass: 'stable-prefix' as const,
      estimatedTokens: estimatedTokens(input.schema),
      content: input.schema,
    },
    {
      kind: 'request' as const,
      sourceRef: refs.request,
      sourceDigest: canonicalDigest(requestMaterial),
      sensitivity: 'workspace' as const,
      cacheClass: 'request-local' as const,
      estimatedTokens: estimatedTokens(requestMaterial),
      content: requestMaterial,
    },
  ];
  const envelope = new ContextEngine().assemble({
    workspaceId: context.workspaceId,
    policy: { version: `${contractVersion}/context-v1`, allowedSourceRefs: Object.values(refs) },
    segments,
    budget: {
      contextWindow: STRUCTURED_CONTEXT_WINDOW,
      outputReserve: input.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      reasoningReserve: reasoningReserve(effort),
    },
  });
  const taskInput = requestMaterial;
  const settlementRequired = context.paidCost !== undefined;
  let gatewayResult: ModelResult<Output> | undefined;
  const contract: TaskModelContract<typeof taskInput, Output> = {
    taskId: input.task,
    version: contractVersion,
    executionMode: 'generative',
    inputSchema: { type: 'object' },
    outputSchema: input.schema,
    contextPolicy: { version: `${contractVersion}/context-v1`, allowedSourceRefs: Object.values(refs) },
    capabilityRequirements: {
      protocols: [protocol],
      structuredOutput: true,
      reasoning: effort,
      settlementRequired,
    },
    reasoningPolicy: { allowed: [effort], default: effort, reserveTokens: reasoningReserve(effort) },
    cachePolicy: { mode: 'disabled' },
    retryPolicy: { transportMaxAttempts: 1, contentRepairMaxAttempts: 0 },
    validateOutput: (_taskInput, output) => {
      const validation = checkAgainstSchema(input.schema, output);
      if (!validation.valid) throw new Error(`output invalid: ${(validation.errors ?? []).join('; ')}`);
      input.validateOutput?.(output);
    },
  };
  const runtime = new ModelExecutionRuntime<typeof taskInput, Output>({
    telemetry: options.telemetry,
    transport: {
      dispatch: async () => {
        gatewayResult = await gateway.generateStructured<Output>(input, context);
        return {
          output: gatewayResult.data,
          requestedAlias,
          resolvedAlias: requestedAlias,
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
  try {
    const prompt = { system: input.system ?? '', user: input.prompt };
    const result = await runtime.execute({
      executionId: `structured:${context.runId ?? context.correlationId ?? context.workspaceId}:${input.task}:${canonicalDigest(requestMaterial).slice(0, 16)}`,
      fallbackIndex: 0,
      workspaceId: context.workspaceId,
      buildRunId: context.runId ?? context.correlationId ?? context.workspaceId,
      contract,
      input: taskInput,
      inputDigest: canonicalDigest(taskInput),
      context: envelope,
      contextDigest: envelope.digest,
      promptVersion: `${contractVersion}/prompt-v1`,
      schemaDigest: canonicalDigest(input.schema),
      requestedAlias,
      resolvedAlias: requestedAlias,
      protocol,
      reasoning: effort,
      sampling: {},
      locale: 'und',
      prompt,
    });
    if (!gatewayResult) throw new Error('model runtime completed without a gateway observation');
    return {
      ...gatewayResult,
      runtimeExecution: {
        contractVersion,
        protocol,
        contextDigest: envelope.digest,
        promptDigest: canonicalDigest(prompt),
        states: result.states,
        transportAttempts: result.transportAttempts,
        repairAttempts: result.repairAttempts,
        physicalCalls: gatewayResult.callCount ?? 1,
        gatewayRepairCalls: Math.max(0, (gatewayResult.callCount ?? 1) - 1),
        requestedAlias,
        runtimeResolvedAlias: requestedAlias,
        gatewayResolvedModel: gatewayResult.model,
        provider: gatewayResult.provider,
        ...(gatewayResult.reportedModel ? { reportedModel: gatewayResult.reportedModel } : {}),
        ...(gatewayResult.modelResolutionSource
          ? { modelResolutionSource: gatewayResult.modelResolutionSource }
          : {}),
      },
    };
  } catch (error) {
    throw unwrapModelExecutionError(error);
  }
}
