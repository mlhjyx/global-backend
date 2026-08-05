import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertCompiledRuntimeGuardCurrent,
  type CompiledRuntimeGuard,
  createCompiledRuntimeGuard,
  getCompiledRuntimeGuardAttestation,
} from "../../model-runtime/compiled-runtime-guard";
import {
  canonicalDigest,
  ContextEngine,
} from "../../model-runtime/context-engine";
import {
  DurableModelExecutionRuntime,
  getDurableModelExecutionAttestation,
} from "../../model-runtime/durable-model-execution-runtime";
import {
  AppendOnlyModelExecutionLedger,
  type ModelExecutionLedgerSummary,
} from "../../model-runtime/model-execution-ledger";
import { getTrustedModelExecutionMetadata } from "../../model-runtime/model-execution-runtime";
import type {
  ModelContentRepairCompiler,
  ModelExecutionPlan,
  ModelExecutionResult,
  ModelObservation,
  ModelProtocol,
  ModelTransport,
  ReasoningLevel,
  TaskModelContract,
} from "../../model-runtime/types";
// Direct adapter imports keep the compiled proof closure explicit and narrow.
import { AiSdkAnthropicMessagesAdapter } from "../../model-runtime/adapters/ai-sdk-anthropic-messages.adapter";
import type {
  AiSdkNativeAdapterSettings,
  NativeModelAdapter,
  NativeReasoningEffort,
} from "../../model-runtime/adapters/ai-sdk-native-adapter.contract";
import { AiSdkOpenAiResponsesAdapter } from "../../model-runtime/adapters/ai-sdk-openai-responses.adapter";
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

export const COPY_CAPABILITY_OPERATIONAL_ARTIFACT_PATHS = Object.freeze([
  "apps/api/dist/model-gateway/new-api-request-bound-settlement.js",
  "apps/api/dist/model-runtime/adapters/ai-sdk-adapter-result.js",
  "apps/api/dist/model-runtime/adapters/ai-sdk-anthropic-messages.adapter.js",
  "apps/api/dist/model-runtime/adapters/ai-sdk-native-adapter.contract.js",
  "apps/api/dist/model-runtime/adapters/ai-sdk-openai-responses.adapter.js",
  "apps/api/dist/model-runtime/compiled-runtime-guard.js",
  "apps/api/dist/model-runtime/context-engine.js",
  "apps/api/dist/model-runtime/durable-model-execution-runtime.js",
  "apps/api/dist/model-runtime/immutable.js",
  "apps/api/dist/model-runtime/model-execution-ledger.js",
  "apps/api/dist/model-runtime/model-execution-runtime.js",
  "apps/api/dist/model-runtime/real-model-execution-ledger-storage.js",
  "apps/api/dist/model-runtime/real-model-execution-ledger.js",
  "apps/api/dist/model-runtime/types.js",
  "apps/api/dist/site-builder/agents/copy.js",
  "apps/api/dist/site-builder/copy-bundle.service.js",
  "apps/api/dist/site-builder/eval/copy-assembly-eval.js",
  "apps/api/dist/site-builder/eval/copy-capability-pilot-runner.js",
  "apps/api/dist/site-builder/eval/copy-capability-pilot.js",
  "apps/api/dist/site-builder/eval/copy-evaluation-v2-candidates.js",
  "apps/api/dist/site-builder/eval/copy-quality-rubric.js",
  "packages/contracts/dist/index.js",
  "packages/contracts/dist/site-builder/component-content-budget.js",
  "packages/contracts/dist/site-builder/component-qualification.js",
  "packages/contracts/dist/site-builder/component-schema.js",
  "packages/contracts/dist/site-builder/copy-bundle.js",
  "packages/contracts/dist/site-builder/design-brief.js",
  "packages/contracts/dist/site-builder/design-catalog-v2.js",
  "packages/contracts/dist/site-builder/design-catalog.js",
  "packages/contracts/dist/site-builder/design-dna.js",
  "packages/contracts/dist/site-builder/design-evaluation.js",
  "packages/contracts/dist/site-builder/design-integrity.js",
  "packages/contracts/dist/site-builder/design-observation.js",
  "packages/contracts/dist/site-builder/design-source.js",
  "packages/contracts/dist/site-builder/evidence.js",
  "packages/contracts/dist/site-builder/inquiry.js",
  "packages/contracts/dist/site-builder/locales.js",
  "packages/contracts/dist/site-builder/media-foundation.js",
  "packages/contracts/dist/site-builder/model-policy.js",
  "packages/contracts/dist/site-builder/site-spec-validation.js",
  "packages/contracts/dist/site-builder/site-spec.js",
  "packages/contracts/dist/site-builder/template-family.js",
] as const);

const LOADED_REPOSITORY_ROOT = resolve(__dirname, "../../../../..");
const COMPILED_OPERATIONAL_ENTRYPOINT = resolve(
  LOADED_REPOSITORY_ROOT,
  "apps/api/dist/site-builder/eval/copy-capability-pilot-runner.js",
);

function assertCompiledOperationalEntrypoint(): void {
  let loadedEntrypoint: string;
  let compiledEntrypoint: string;
  try {
    loadedEntrypoint = realpathSync(__filename);
    compiledEntrypoint = realpathSync(COMPILED_OPERATIONAL_ENTRYPOINT);
  } catch {
    throw new Error("COPY_CAPABILITY_COMPILED_ENTRYPOINT_REQUIRED");
  }
  if (loadedEntrypoint !== compiledEntrypoint) {
    throw new Error("COPY_CAPABILITY_COMPILED_ENTRYPOINT_REQUIRED");
  }
}

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

export function createCopyCapabilityTaskContract(input: {
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
        "copy-capability:repair",
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
      contentRepairMaxAttempts: 1,
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
  workspaceId: string,
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
    workspaceId,
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

export interface CopyCapabilityOperationalProofReceipt {
  classification: "OPERATIONAL_PROOF_ONLY";
  evidenceClass: "fake_gateway_contract_only";
  campaignId: string;
  executionId: string;
  alias: string;
  protocol: ModelProtocol;
  reasoning: ReasoningLevel;
  wireCount: number;
  ledgerDigest: string;
  outputDigest: string;
  compiledRuntimeDigest: string;
  compiledBindingDigest: string;
  compiledRuntimeSchemaVersion: "compiled-runtime-guard/2026-08-05-v1";
  compiledArtifactCount: number;
}

const OPERATIONAL_PROOF_RECEIPTS = new WeakMap<
  object,
  CopyCapabilityOperationalProofReceipt
>();
const ASSERT_COMPILED_RUNTIME_CURRENT = assertCompiledRuntimeGuardCurrent;
const CREATE_COMPILED_RUNTIME_GUARD = createCompiledRuntimeGuard;
const GET_COMPILED_RUNTIME_ATTESTATION = getCompiledRuntimeGuardAttestation;
const GET_DURABLE_ATTESTATION = getDurableModelExecutionAttestation;
const GET_TRUSTED_METADATA = getTrustedModelExecutionMetadata;
const FREEZE_EXECUTION =
  AppendOnlyModelExecutionLedger.prototype.freezeExecution;

export function getCopyCapabilityOperationalProofReceipt(
  result: ModelExecutionResult<unknown>,
): CopyCapabilityOperationalProofReceipt | undefined {
  return OPERATIONAL_PROOF_RECEIPTS.get(result);
}

export function createCopyCapabilityRepairCompiler(): ModelContentRepairCompiler<
  CopyTaskInput,
  CopyTaskOutput
> {
  const compiler: ModelContentRepairCompiler<CopyTaskInput, CopyTaskOutput> = {
    findings: () =>
      Object.freeze([
        Object.freeze({
          code: "COPY_CAPABILITY_OUTPUT_INVALID",
          path: "$",
        }),
      ]),
    compile: ({ originalPlan, findings, binding, priorOutput }) => {
      if (Buffer.byteLength(JSON.stringify(priorOutput), "utf8") > 64 * 1024) {
        throw new Error("COPY_CAPABILITY_PRIOR_OUTPUT_TOO_LARGE");
      }
      const repairMaterial = Object.freeze({
        binding,
        findings,
        priorOutput,
      });
      const repairContext = new ContextEngine().assemble({
        workspaceId: originalPlan.workspaceId,
        policy: originalPlan.contract.contextPolicy,
        segments: [
          ...originalPlan.context.segments,
          {
            kind: "repair" as const,
            sourceRef: "copy-capability:repair",
            sourceDigest: canonicalDigest(repairMaterial),
            sensitivity: "workspace" as const,
            cacheClass: "never-cache" as const,
            estimatedTokens: 256,
            content: repairMaterial,
          },
        ],
        budget: {
          contextWindow: 16_384,
          outputReserve: 4_000,
          reasoningReserve: 1_024,
        },
      });
      return Object.freeze({
        ...originalPlan,
        context: repairContext,
        contextDigest: repairContext.digest,
        prompt: Object.freeze({
          ...originalPlan.prompt,
          repair: repairMaterial,
        }),
        repair: binding,
      });
    },
  };
  return Object.freeze(compiler);
}

interface RunnerInput {
  ledgerPath: string;
  campaignId: string;
  gateway: AiSdkNativeAdapterSettings;
  compiledRuntimeGuard?: CompiledRuntimeGuard;
}

export function createCopyCapabilityExecutionPlan(input: {
  executionKey: string;
  campaignId: string;
  workspaceId: string;
}): ModelExecutionPlan<CopyTaskInput, CopyTaskOutput> {
  const execution = COPY_CAPABILITY_PILOT_PLAN.executions.find(
    (candidate) => candidate.executionKey === input.executionKey,
  );
  if (!execution) throw new Error("COPY_CAPABILITY_EXECUTION_NOT_IN_PLAN");
  const taskContract = createCopyCapabilityTaskContract({
    protocol: execution.protocol,
    reasoning: execution.reasoning,
  });
  const context = contextFor(taskContract, input.workspaceId);
  return Object.freeze({
    executionId: execution.executionKey,
    workspaceId: input.workspaceId,
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
    prompt: Object.freeze({
      system: COPY_TASK.system,
      user: COPY_TASK.buildPrompt(FIXTURE.input),
    }),
  });
}

function copyOperationalRuntimeBinding(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: "copy-capability-operational-runtime/2026-08-05-v1",
    taskId: COPY_TASK.id,
    taskContractVersion: COPY_CONTRACT_VERSION,
    pilotPlanDigest: canonicalDigest(COPY_CAPABILITY_PILOT_PLAN),
    inputDigest: canonicalDigest(FIXTURE.input),
    outputSchemaDigest: canonicalDigest(COPY_TASK.outputSchema),
    systemPromptDigest: canonicalDigest(COPY_TASK.system),
    artifactPathsDigest: canonicalDigest(
      COPY_CAPABILITY_OPERATIONAL_ARTIFACT_PATHS,
    ),
  });
}

async function createRunner(
  input: RunnerInput,
): Promise<CopyCapabilityPilotFakeGatewayRunner> {
  const compiledRuntimeGuard = input.compiledRuntimeGuard;
  if (compiledRuntimeGuard != null) {
    await ASSERT_COMPILED_RUNTIME_CURRENT(compiledRuntimeGuard);
  }
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
      if (compiledRuntimeGuard != null) {
        await ASSERT_COMPILED_RUNTIME_CURRENT(compiledRuntimeGuard);
      }
      const plan = createCopyCapabilityExecutionPlan({
        executionKey,
        campaignId: input.campaignId,
        workspaceId: "copy-capability-fake-gateway",
      });
      const adapter = adapters[execution.protocol];
      const transport: ModelTransport<CopyTaskInput, CopyTaskOutput> = {
        dispatch: async (
          currentPlan,
        ): Promise<ModelObservation<CopyTaskOutput>> => {
          if (adapter.protocol !== nativeProtocol(execution.protocol)) {
            throw new Error("COPY_CAPABILITY_ADAPTER_PROTOCOL_MISMATCH");
          }
          const userPrompt = currentPlan.prompt.user;
          if (typeof userPrompt !== "string") {
            throw new Error("COPY_CAPABILITY_PROMPT_INVALID");
          }
          const compiledPrompt =
            currentPlan.prompt.repair == null
              ? userPrompt
              : `${userPrompt}\n\nClosed repair payload:\n${JSON.stringify(
                  currentPlan.prompt.repair,
                )}`;
          const result = await adapter.execute<CopyTaskOutput>({
            alias: execution.alias,
            system:
              typeof currentPlan.prompt.system === "string"
                ? currentPlan.prompt.system
                : undefined,
            prompt: compiledPrompt,
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
      let completedProof:
        | {
            compiled: NonNullable<
              ReturnType<typeof GET_COMPILED_RUNTIME_ATTESTATION>
            >;
            metadata: NonNullable<ReturnType<typeof GET_TRUSTED_METADATA>>;
          }
        | undefined;
      const result = await new DurableModelExecutionRuntime<
        CopyTaskInput,
        CopyTaskOutput
      >({
        ledger,
        transport,
        repairCompiler: createCopyCapabilityRepairCompiler(),
        ...(compiledRuntimeGuard == null
          ? {}
          : {
              postWireGuard: () =>
                ASSERT_COMPILED_RUNTIME_CURRENT(compiledRuntimeGuard),
              completionGuard: async ({
                result: completedResult,
                wireCount,
                outputDigest,
              }) => {
                await ASSERT_COMPILED_RUNTIME_CURRENT(compiledRuntimeGuard);
                const metadata = GET_TRUSTED_METADATA(completedResult);
                const compiled =
                  GET_COMPILED_RUNTIME_ATTESTATION(compiledRuntimeGuard);
                if (
                  completedResult.repairAttempts !== 1 ||
                  completedResult.transportAttempts !== 2 ||
                  wireCount !== 2 ||
                  !completedResult.states.includes("repaired") ||
                  metadata == null ||
                  compiled == null ||
                  metadata.executionId !== execution.executionKey ||
                  metadata.resolvedAlias !== execution.alias ||
                  metadata.protocol !== execution.protocol ||
                  metadata.reasoning !== execution.reasoning ||
                  metadata.outputDigest !== outputDigest ||
                  compiled.schemaVersion !==
                    "compiled-runtime-guard/2026-08-05-v1" ||
                  compiled.artifactCount !==
                    COPY_CAPABILITY_OPERATIONAL_ARTIFACT_PATHS.length ||
                  compiled.bindingDigest !==
                    canonicalDigest(copyOperationalRuntimeBinding())
                ) {
                  throw new Error(
                    "COPY_CAPABILITY_OPERATIONAL_PROOF_INCOMPLETE",
                  );
                }
                completedProof = { compiled, metadata };
              },
            }),
      }).execute(plan);
      if (compiledRuntimeGuard != null) {
        try {
          await ASSERT_COMPILED_RUNTIME_CURRENT(compiledRuntimeGuard);
          const durable = GET_DURABLE_ATTESTATION(result);
          const metadata = completedProof?.metadata;
          const compiled = completedProof?.compiled;
          if (
            durable?.evidenceClass !== "fake_gateway_contract_only" ||
            metadata == null ||
            compiled == null ||
            metadata.executionId !== execution.executionKey ||
            metadata.resolvedAlias !== execution.alias ||
            metadata.protocol !== execution.protocol ||
            metadata.reasoning !== execution.reasoning ||
            durable.outputDigest !== metadata.outputDigest ||
            compiled.schemaVersion !== "compiled-runtime-guard/2026-08-05-v1" ||
            compiled.artifactCount !==
              COPY_CAPABILITY_OPERATIONAL_ARTIFACT_PATHS.length ||
            compiled.bindingDigest !==
              canonicalDigest(copyOperationalRuntimeBinding())
          ) {
            throw new Error("COPY_CAPABILITY_OPERATIONAL_PROOF_INCOMPLETE");
          }
          OPERATIONAL_PROOF_RECEIPTS.set(
            result,
            Object.freeze({
              classification: "OPERATIONAL_PROOF_ONLY" as const,
              evidenceClass: "fake_gateway_contract_only" as const,
              campaignId: durable.campaignId,
              executionId: durable.executionId,
              alias: metadata.resolvedAlias,
              protocol: metadata.protocol,
              reasoning: metadata.reasoning,
              wireCount: durable.wireCount,
              ledgerDigest: durable.ledgerDigest,
              outputDigest: durable.outputDigest,
              compiledRuntimeDigest: compiled.artifactTreeDigest,
              compiledBindingDigest: compiled.bindingDigest,
              compiledRuntimeSchemaVersion: compiled.schemaVersion,
              compiledArtifactCount: compiled.artifactCount,
            }),
          );
        } catch (error) {
          await FREEZE_EXECUTION.call(
            ledger,
            plan.executionId,
            "operational_receipt_failed",
          );
          throw error;
        }
      }
      return result;
    },
    summary: () => ledger.summary(),
  });
}

export async function createCopyCapabilityPilotFakeGatewayRunner(input: {
  ledgerPath: string;
  campaignId: string;
  gateway: AiSdkNativeAdapterSettings;
}): Promise<CopyCapabilityPilotFakeGatewayRunner> {
  return createRunner({
    ledgerPath: input.ledgerPath,
    campaignId: input.campaignId,
    gateway: input.gateway,
  });
}

export async function createCopyCapabilityPilotOperationalProofRunner(input: {
  ledgerPath: string;
  campaignId: string;
  gateway: AiSdkNativeAdapterSettings;
}): Promise<CopyCapabilityPilotFakeGatewayRunner> {
  assertCompiledOperationalEntrypoint();
  const compiledRuntimeGuard = await CREATE_COMPILED_RUNTIME_GUARD({
    repositoryRoot: LOADED_REPOSITORY_ROOT,
    artifactPaths: COPY_CAPABILITY_OPERATIONAL_ARTIFACT_PATHS,
    binding: copyOperationalRuntimeBinding(),
  });
  return createRunner({ ...input, compiledRuntimeGuard });
}
