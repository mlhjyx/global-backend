import {
  AppendOnlyModelExecutionLedger,
  canonicalDigest,
  ContextEngine,
  DurableModelExecutionRuntime,
  type ModelExecutionLedgerSummary,
  type ModelExecutionPlan,
  type ModelExecutionResult,
  type ModelObservation,
  type ModelProtocol,
  type ModelTransport,
  type ReasoningLevel,
  type TaskModelContract,
} from "../../model-runtime";
import {
  AiSdkAnthropicMessagesAdapter,
  AiSdkOpenAiResponsesAdapter,
  type AiSdkNativeAdapterSettings,
  type NativeModelAdapter,
  type NativeReasoningEffort,
} from "../../model-runtime/adapters";
import {
  COPY_TASK,
  type CopyTaskInput,
  type CopyTaskOutput,
} from "../agents/copy";
import {
  COPY_ASSEMBLY_EVAL_FIXTURES,
  evaluateCopyAssemblyOutput,
  prepareCopyAssemblyEvalFixture,
} from "./copy-assembly-eval";
import {
  COPY_CAPABILITY_PILOT_PLAN,
  validateCopyCapabilityPilotPlan,
} from "./copy-capability-pilot";

const FIXTURE = (() => {
  const source = COPY_ASSEMBLY_EVAL_FIXTURES.find(
    ({ fixtureId }) =>
      fixtureId === COPY_CAPABILITY_PILOT_PLAN.source.fixtureId,
  );
  if (!source) throw new Error("COPY_CAPABILITY_PILOT_FIXTURE_MISSING");
  return prepareCopyAssemblyEvalFixture(source);
})();

const COPY_CONTRACT_VERSION = (() => {
  if (!COPY_TASK.contractVersion) {
    throw new Error("COPY_CAPABILITY_TASK_CONTRACT_VERSION_MISSING");
  }
  return COPY_TASK.contractVersion;
})();

const COPY_VALIDATE_OUTPUT = (() => {
  if (!COPY_TASK.validateOutput) {
    throw new Error("COPY_CAPABILITY_TASK_VALIDATOR_MISSING");
  }
  return COPY_TASK.validateOutput;
})();

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FAKE_GATEWAY_FIXTURE_KEY = "fixture-not-a-credential";

function assertLoopbackGateway(settings: AiSdkNativeAdapterSettings): void {
  for (const value of [settings.baseUrl, settings.canonicalGatewayBaseUrl]) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("COPY_CAPABILITY_FAKE_GATEWAY_MUST_BE_LOOPBACK");
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new Error("COPY_CAPABILITY_FAKE_GATEWAY_MUST_BE_LOOPBACK");
    }
  }
  if (settings.apiKey !== FAKE_GATEWAY_FIXTURE_KEY) {
    throw new Error("COPY_CAPABILITY_FAKE_GATEWAY_REQUIRES_FIXTURE_KEY");
  }
}

function nativeProtocol(
  protocol: ModelProtocol,
): NativeModelAdapter["protocol"] {
  if (protocol === "openai_responses") return "openai-responses";
  if (protocol === "anthropic_messages") return "anthropic-messages";
  throw new Error("COPY_CAPABILITY_PROTOCOL_NOT_SUPPORTED");
}

function nativeReasoning(reasoning: ReasoningLevel): NativeReasoningEffort {
  if (reasoning === "max") {
    throw new Error("COPY_CAPABILITY_REASONING_NOT_SUPPORTED");
  }
  return reasoning;
}

function runtimeProtocol(
  protocol: NativeModelAdapter["protocol"],
): ModelProtocol {
  if (protocol === "openai-responses") return "openai_responses";
  return "anthropic_messages";
}

function completeUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
}): usage is { inputTokens: number; outputTokens: number } {
  return (
    Number.isSafeInteger(usage.inputTokens) &&
    Number(usage.inputTokens) >= 0 &&
    Number.isSafeInteger(usage.outputTokens) &&
    Number(usage.outputTokens) >= 0
  );
}

function contract(input: {
  protocol: ModelProtocol;
  reasoning: ReasoningLevel;
}): TaskModelContract<CopyTaskInput, CopyTaskOutput> {
  return Object.freeze({
    taskId: COPY_TASK.id,
    version: COPY_CONTRACT_VERSION,
    executionMode: "generative" as const,
    inputSchema: COPY_TASK.inputSchema,
    outputSchema: COPY_TASK.outputSchema,
    contextPolicy: Object.freeze({
      version: `${COPY_CAPABILITY_PILOT_PLAN.planId}/context-v1`,
      allowedSourceRefs: Object.freeze([
        "copy-capability:policy",
        "copy-capability:schema",
        "copy-capability:facts",
        "copy-capability:brand",
        "copy-capability:request",
      ]),
    }),
    capabilityRequirements: Object.freeze({
      protocols: Object.freeze([input.protocol]),
      structuredOutput: true,
      reasoning: input.reasoning,
      reportsUsage: true,
      reportsModel: true,
      reportsRequestId: true,
      exactReportedModel: true,
      forbidWarnings: true,
      settlementRequired: true,
    }),
    reasoningPolicy: Object.freeze({
      allowed: Object.freeze([input.reasoning]),
      default: input.reasoning,
      reserveTokens: 1_024,
    }),
    cachePolicy: Object.freeze({ mode: "disabled" as const }),
    retryPolicy: Object.freeze({
      transportMaxAttempts: 1,
      contentRepairMaxAttempts: 0,
    }),
    validateOutput: (_taskInput: CopyTaskInput, output: CopyTaskOutput) => {
      COPY_VALIDATE_OUTPUT(FIXTURE.input, output);
      const outcome = evaluateCopyAssemblyOutput(FIXTURE, output);
      if (!outcome.hardGatePassed || !outcome.productionValidationPassed) {
        throw new Error("COPY_CAPABILITY_OUTPUT_HARD_GATE_FAILED");
      }
    },
  });
}

function contextFor(
  taskContract: TaskModelContract<CopyTaskInput, CopyTaskOutput>,
) {
  const sources = [
    {
      kind: "policy" as const,
      sourceRef: "copy-capability:policy",
      sensitivity: "public" as const,
      cacheClass: "stable-prefix" as const,
      estimatedTokens: 128,
      content: { system: COPY_TASK.system },
    },
    {
      kind: "schema" as const,
      sourceRef: "copy-capability:schema",
      sensitivity: "public" as const,
      cacheClass: "stable-prefix" as const,
      estimatedTokens: 512,
      content: COPY_TASK.outputSchema,
    },
    {
      kind: "facts" as const,
      sourceRef: "copy-capability:facts",
      sensitivity: "workspace" as const,
      cacheClass: "request-local" as const,
      estimatedTokens: 512,
      relevance: 1,
      content: {
        snapshotDigest: FIXTURE.input.snapshotDigest,
        claims: FIXTURE.input.claims,
      },
    },
    {
      kind: "brand" as const,
      sourceRef: "copy-capability:brand",
      sensitivity: "workspace" as const,
      cacheClass: "request-local" as const,
      estimatedTokens: 256,
      relevance: 1,
      content: FIXTURE.input.context,
    },
    {
      kind: "request" as const,
      sourceRef: "copy-capability:request",
      sensitivity: "workspace" as const,
      cacheClass: "request-local" as const,
      estimatedTokens: 512,
      content: {
        locale: FIXTURE.input.locale,
        sourceLocale: FIXTURE.input.sourceLocale,
        slots: FIXTURE.input.slots,
      },
    },
  ];
  return new ContextEngine().assemble({
    workspaceId: "copy-capability-fake-gateway",
    policy: taskContract.contextPolicy,
    segments: sources.map((source) => ({
      ...source,
      sourceDigest: canonicalDigest(source.content),
    })),
    budget: {
      contextWindow: 16_384,
      outputReserve: 4_000,
      reasoningReserve: 1_024,
    },
  });
}

function warningText(warning: {
  type: string;
  feature?: string;
  details?: string;
}): string {
  return [warning.type, warning.feature, warning.details]
    .filter(Boolean)
    .join(":");
}

export interface CopyCapabilityPilotFakeGatewayRunner {
  execute(executionKey: string): Promise<ModelExecutionResult<CopyTaskOutput>>;
  summary(): Promise<ModelExecutionLedgerSummary>;
}

export async function createCopyCapabilityPilotFakeGatewayRunner(input: {
  ledgerPath: string;
  campaignId: string;
  gateway: AiSdkNativeAdapterSettings;
}): Promise<CopyCapabilityPilotFakeGatewayRunner> {
  validateCopyCapabilityPilotPlan(COPY_CAPABILITY_PILOT_PLAN);
  assertLoopbackGateway(input.gateway);

  const ledger = await AppendOnlyModelExecutionLedger.openTestOnly({
    ledgerPath: input.ledgerPath,
    campaign: {
      campaignId: input.campaignId,
      taskId: COPY_CAPABILITY_PILOT_PLAN.taskId,
      planDigest: canonicalDigest(COPY_CAPABILITY_PILOT_PLAN),
      maximumExecutions: COPY_CAPABILITY_PILOT_PLAN.plannedExecutions,
      maximumWireCalls: COPY_CAPABILITY_PILOT_PLAN.maximumWireCalls,
    },
  });
  const adapters = Object.freeze({
    openai_responses: new AiSdkOpenAiResponsesAdapter(input.gateway),
    anthropic_messages: new AiSdkAnthropicMessagesAdapter(input.gateway),
  });

  return Object.freeze({
    execute: async (executionKey: string) => {
      const execution = COPY_CAPABILITY_PILOT_PLAN.executions.find(
        (candidate) => candidate.executionKey === executionKey,
      );
      if (!execution) throw new Error("COPY_CAPABILITY_EXECUTION_NOT_IN_PLAN");
      const taskContract = contract({
        protocol: execution.protocol,
        reasoning: execution.reasoning,
      });
      const context = contextFor(taskContract);
      const prompt = Object.freeze({
        system: COPY_TASK.system,
        user: COPY_TASK.buildPrompt(FIXTURE.input),
      });
      const plan: ModelExecutionPlan<CopyTaskInput, CopyTaskOutput> =
        Object.freeze({
          executionId: execution.executionKey,
          workspaceId: "copy-capability-fake-gateway",
          buildRunId: input.campaignId,
          contract: taskContract,
          input: FIXTURE.input,
          inputDigest: canonicalDigest(FIXTURE.input),
          context,
          contextDigest: context.digest,
          promptVersion: COPY_CAPABILITY_PILOT_PLAN.planId,
          schemaDigest: canonicalDigest(taskContract.outputSchema),
          requestedAlias: execution.alias,
          resolvedAlias: execution.alias,
          protocol: execution.protocol,
          reasoning: execution.reasoning,
          sampling: Object.freeze({
            maximumOutputTokens: execution.maximumOutputTokens,
            timeoutMs: execution.timeoutMs,
          }),
          locale: FIXTURE.input.locale,
          prompt,
        });
      const adapter = adapters[execution.protocol];
      const transport: ModelTransport<CopyTaskInput, CopyTaskOutput> = {
        dispatch: async (): Promise<ModelObservation<CopyTaskOutput>> => {
          if (adapter.protocol !== nativeProtocol(execution.protocol)) {
            throw new Error("COPY_CAPABILITY_ADAPTER_PROTOCOL_MISMATCH");
          }
          const result = await adapter.execute<CopyTaskOutput>({
            alias: execution.alias,
            system: prompt.system,
            prompt: prompt.user,
            outputSchema: COPY_TASK.outputSchema,
            outputSchemaName: "copy_capability_output",
            reasoning: { effort: nativeReasoning(execution.reasoning) },
            maxOutputTokens: execution.maximumOutputTokens,
            abortSignal: AbortSignal.timeout(execution.timeoutMs),
          });
          const usageComplete = completeUsage(result.usage);
          return Object.freeze({
            output: result.output,
            requestedAlias: result.requestedModel,
            resolvedAlias: execution.alias,
            reportedModel: result.reportedModel,
            protocol: runtimeProtocol(result.protocol),
            usage: {
              inputTokens: result.usage.inputTokens ?? -1,
              outputTokens: result.usage.outputTokens ?? -1,
              ...(result.usage.cacheReadTokens == null
                ? {}
                : { cacheReadTokens: result.usage.cacheReadTokens }),
              ...(result.usage.cacheWriteTokens == null
                ? {}
                : { cacheCreationTokens: result.usage.cacheWriteTokens }),
            },
            usageComplete,
            ...(result.requestId == null
              ? {}
              : { requestId: result.requestId }),
            settlement: usageComplete
              ? ("known" as const)
              : ("unknown" as const),
            warnings: Object.freeze(result.warnings.map(warningText)),
          });
        },
      };
      return new DurableModelExecutionRuntime({ ledger, transport }).execute(
        plan,
      );
    },
    summary: () => ledger.summary(),
  });
}
