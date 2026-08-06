import {
  AppendOnlyModelExecutionLedger,
  canonicalDigest,
  ContextEngine,
  DurableModelExecutionRuntime,
  type ModelContentRepairCompiler,
  type ModelExecutionLedgerSummary,
  type ModelExecutionPlan,
  type ModelExecutionResult,
  type ModelProtocol,
  type ModelTransport,
  type ReasoningLevel,
  type TaskModelContract,
} from "../../model-runtime";
import {
  COPY_TASK,
  type CopyTaskInput,
  type CopyTaskOutput,
} from "../agents/copy";
import {
  COPY_ASSEMBLY_EVAL_FIXTURES,
  evaluateCopyAssemblyOutput,
  prepareCopyAssemblyEvalFixture,
  type PreparedCopyAssemblyEvalFixture,
} from "./copy-assembly-eval";
import { COPY_EVALUATION_V2_CANDIDATES } from "./copy-evaluation-v2-candidates";

export const COPY_QUALITY_MATRIX_SCHEMA_VERSION =
  "site-builder-copy-quality-matrix-plan/2026-08-06-v1" as const;

const PLAN_ID = "site-builder-copy-quality-matrix/2026-08-06-v1" as const;
// The quality evaluator's stable repeat identity is zero-based. Keep the
// execution plan aligned with `observeCopyQualityExecution` instead of
// introducing a second 1/2 numbering convention at the dispatch boundary.
const REPEATS = Object.freeze([0, 1] as const);
const MAXIMUM_OUTPUT_TOKENS = 4_000;
const TIMEOUT_MS = 90_000;
const CONTEXT_WINDOW = 16_384;
const REASONING_RESERVE = 1_024;

const COPY_CONTRACT_VERSION = (() => {
  if (!COPY_TASK.contractVersion) {
    throw new Error("COPY_QUALITY_MATRIX_TASK_CONTRACT_VERSION_MISSING");
  }
  return COPY_TASK.contractVersion;
})();

const COPY_VALIDATE_OUTPUT = (() => {
  if (!COPY_TASK.validateOutput) {
    throw new Error("COPY_QUALITY_MATRIX_TASK_VALIDATOR_MISSING");
  }
  return COPY_TASK.validateOutput;
})();

export interface CopyQualityMatrixExecution {
  executionKey: string;
  alias: string;
  protocol: ModelProtocol;
  reasoning: ReasoningLevel;
  fixtureId: string;
  repeatIndex: 0 | 1;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function executionKey(input: {
  ordinal: number;
  alias: string;
  fixtureId: string;
  repeatIndex: 0 | 1;
}): string {
  return [
    "copy-quality",
    String(input.ordinal).padStart(3, "0"),
    input.alias,
    input.fixtureId,
    `r${input.repeatIndex}`,
  ].join("-");
}

const EXECUTIONS = (() => {
  let ordinal = 0;
  return COPY_EVALUATION_V2_CANDIDATES.flatMap((candidate) =>
    COPY_ASSEMBLY_EVAL_FIXTURES.flatMap((fixture) =>
      REPEATS.map((repeatIndex) => {
        ordinal += 1;
        return {
          executionKey: executionKey({
            ordinal,
            alias: candidate.alias,
            fixtureId: fixture.fixtureId,
            repeatIndex,
          }),
          alias: candidate.alias,
          protocol: candidate.protocol,
          reasoning: candidate.reasoning,
          fixtureId: fixture.fixtureId,
          repeatIndex,
        } satisfies CopyQualityMatrixExecution;
      }),
    ),
  );
})();

const PLAN = {
  schemaVersion: COPY_QUALITY_MATRIX_SCHEMA_VERSION,
  planId: PLAN_ID,
  taskId: COPY_TASK.id,
  executionStatus: "BLOCKED_BEFORE_CAPABILITY_PILOT_RESULT",
  dispatchAuthorization: "NOT_AUTHORIZED",
  plannedExecutions: 36,
  maximumWireCalls: 72,
  maximumRepairCallsPerExecution: 1,
  cachePolicy: "disabled",
  settlementPolicy: "known_per_physical_call_required",
  executions: EXECUTIONS,
} as const;

export const COPY_QUALITY_MATRIX_PLAN = deepFreeze(PLAN);

if (
  COPY_QUALITY_MATRIX_PLAN.executions.length !==
    COPY_EVALUATION_V2_CANDIDATES.length *
      COPY_ASSEMBLY_EVAL_FIXTURES.length *
      REPEATS.length ||
  COPY_QUALITY_MATRIX_PLAN.executions.length !==
    COPY_QUALITY_MATRIX_PLAN.plannedExecutions ||
  COPY_QUALITY_MATRIX_PLAN.maximumWireCalls !==
    COPY_QUALITY_MATRIX_PLAN.plannedExecutions *
      (1 + COPY_QUALITY_MATRIX_PLAN.maximumRepairCallsPerExecution) ||
  new Set(
    COPY_QUALITY_MATRIX_PLAN.executions.map(({ executionKey }) => executionKey),
  ).size !== COPY_QUALITY_MATRIX_PLAN.executions.length
) {
  throw new Error("COPY_QUALITY_MATRIX_PLAN_INVALID");
}

const COPY_QUALITY_MATRIX_PLAN_DIGEST = canonicalDigest(
  COPY_QUALITY_MATRIX_PLAN,
);

export function validateCopyQualityMatrixPlan(value: unknown): void {
  let digest: string;
  try {
    digest = canonicalDigest(value);
  } catch {
    throw new Error("COPY_QUALITY_MATRIX_PLAN_DRIFT");
  }
  if (digest !== COPY_QUALITY_MATRIX_PLAN_DIGEST) {
    throw new Error("COPY_QUALITY_MATRIX_PLAN_DRIFT");
  }
}

function matrixExecution(
  executionKeyValue: string,
): CopyQualityMatrixExecution {
  const execution = COPY_QUALITY_MATRIX_PLAN.executions.find(
    (candidate) => candidate.executionKey === executionKeyValue,
  );
  if (!execution) {
    throw new Error("COPY_QUALITY_MATRIX_EXECUTION_NOT_IN_PLAN");
  }
  return execution;
}

function preparedFixture(fixtureId: string): PreparedCopyAssemblyEvalFixture {
  const fixture = COPY_ASSEMBLY_EVAL_FIXTURES.find(
    (candidate) => candidate.fixtureId === fixtureId,
  );
  if (!fixture) throw new Error("COPY_QUALITY_MATRIX_FIXTURE_MISSING");
  return prepareCopyAssemblyEvalFixture(fixture);
}

function createTaskContract(input: {
  execution: CopyQualityMatrixExecution;
  prepared: PreparedCopyAssemblyEvalFixture;
}): TaskModelContract<CopyTaskInput, CopyTaskOutput> {
  return Object.freeze({
    taskId: COPY_TASK.id,
    version: COPY_CONTRACT_VERSION,
    executionMode: "generative" as const,
    inputSchema: COPY_TASK.inputSchema,
    outputSchema: COPY_TASK.outputSchema,
    contextPolicy: Object.freeze({
      version: `${PLAN_ID}/context-v1`,
      allowedSourceRefs: Object.freeze([
        "copy-quality:policy",
        "copy-quality:schema",
        "copy-quality:facts",
        "copy-quality:brand",
        "copy-quality:request",
        "copy-quality:repair",
      ]),
    }),
    capabilityRequirements: Object.freeze({
      protocols: Object.freeze([input.execution.protocol]),
      structuredOutput: true,
      reasoning: input.execution.reasoning,
      reportsUsage: true,
      reportsModel: true,
      reportsRequestId: true,
      exactReportedModel: true,
      forbidWarnings: true,
      settlementRequired: true,
    }),
    reasoningPolicy: Object.freeze({
      allowed: Object.freeze([input.execution.reasoning]),
      default: input.execution.reasoning,
      reserveTokens: REASONING_RESERVE,
    }),
    cachePolicy: Object.freeze({ mode: "disabled" as const }),
    retryPolicy: Object.freeze({
      transportMaxAttempts: 1,
      contentRepairMaxAttempts: 1,
    }),
    validateOutput: (taskInput: CopyTaskInput, output: CopyTaskOutput) => {
      if (
        canonicalDigest(taskInput) !== canonicalDigest(input.prepared.input)
      ) {
        throw new Error("COPY_QUALITY_MATRIX_FIXTURE_INPUT_DRIFT");
      }
      COPY_VALIDATE_OUTPUT(input.prepared.input, output);
      const outcome = evaluateCopyAssemblyOutput(input.prepared, output);
      // `evaluateCopyAssemblyOutput` throws on production validation failure;
      // a returned outcome therefore only needs the remaining factuality gate.
      if (!outcome.factualSlotContentMatches) {
        throw new Error("COPY_QUALITY_MATRIX_OUTPUT_HARD_GATE_FAILED");
      }
    },
  });
}

function assembleContext(input: {
  taskContract: TaskModelContract<CopyTaskInput, CopyTaskOutput>;
  prepared: PreparedCopyAssemblyEvalFixture;
  workspaceId: string;
}) {
  const taskInput = input.prepared.input;
  const sources = [
    {
      kind: "policy" as const,
      sourceRef: "copy-quality:policy",
      sensitivity: "public" as const,
      cacheClass: "stable-prefix" as const,
      estimatedTokens: 128,
      content: { system: COPY_TASK.system },
    },
    {
      kind: "schema" as const,
      sourceRef: "copy-quality:schema",
      sensitivity: "public" as const,
      cacheClass: "stable-prefix" as const,
      estimatedTokens: 512,
      content: COPY_TASK.outputSchema,
    },
    {
      kind: "facts" as const,
      sourceRef: "copy-quality:facts",
      sensitivity: "workspace" as const,
      cacheClass: "request-local" as const,
      estimatedTokens: 512,
      relevance: 1,
      content: {
        snapshotDigest: taskInput.snapshotDigest,
        claims: taskInput.claims,
      },
    },
    {
      kind: "brand" as const,
      sourceRef: "copy-quality:brand",
      sensitivity: "workspace" as const,
      cacheClass: "request-local" as const,
      estimatedTokens: 256,
      relevance: 1,
      content: taskInput.context,
    },
    {
      kind: "request" as const,
      sourceRef: "copy-quality:request",
      sensitivity: "workspace" as const,
      cacheClass: "request-local" as const,
      estimatedTokens: 512,
      content: {
        locale: taskInput.locale,
        sourceLocale: taskInput.sourceLocale,
        slots: taskInput.slots,
      },
    },
  ];
  return new ContextEngine().assemble({
    workspaceId: input.workspaceId,
    policy: input.taskContract.contextPolicy,
    segments: sources.map((source) => ({
      ...source,
      sourceDigest: canonicalDigest(source.content),
    })),
    budget: {
      contextWindow: CONTEXT_WINDOW,
      outputReserve: MAXIMUM_OUTPUT_TOKENS,
      reasoningReserve: REASONING_RESERVE,
    },
  });
}

export function createCopyQualityMatrixExecutionPlan(input: {
  executionKey: string;
  campaignId: string;
  workspaceId: string;
}): ModelExecutionPlan<CopyTaskInput, CopyTaskOutput> {
  validateCopyQualityMatrixPlan(COPY_QUALITY_MATRIX_PLAN);
  const execution = matrixExecution(input.executionKey);
  const prepared = preparedFixture(execution.fixtureId);
  const taskContract = createTaskContract({ execution, prepared });
  const context = assembleContext({
    taskContract,
    prepared,
    workspaceId: input.workspaceId,
  });
  return Object.freeze({
    executionId: execution.executionKey,
    workspaceId: input.workspaceId,
    buildRunId: input.campaignId,
    contract: taskContract,
    input: prepared.input,
    inputDigest: canonicalDigest(prepared.input),
    context,
    contextDigest: context.digest,
    promptVersion: PLAN_ID,
    schemaDigest: canonicalDigest(taskContract.outputSchema),
    requestedAlias: execution.alias,
    resolvedAlias: execution.alias,
    protocol: execution.protocol,
    reasoning: execution.reasoning,
    sampling: Object.freeze({
      maximumOutputTokens: MAXIMUM_OUTPUT_TOKENS,
      timeoutMs: TIMEOUT_MS,
      repeatIndex: execution.repeatIndex,
    }),
    locale: prepared.input.locale,
    prompt: Object.freeze({
      system: COPY_TASK.system,
      user: COPY_TASK.buildPrompt(prepared.input),
    }),
  });
}

export function createCopyQualityMatrixRepairCompiler(): ModelContentRepairCompiler<
  CopyTaskInput,
  CopyTaskOutput
> {
  const compiler: ModelContentRepairCompiler<CopyTaskInput, CopyTaskOutput> = {
    findings: () =>
      Object.freeze([
        Object.freeze({
          code: "COPY_QUALITY_OUTPUT_INVALID",
          path: "$",
        }),
      ]),
    compile: ({ originalPlan, findings, binding, priorOutput }) => {
      if (Buffer.byteLength(JSON.stringify(priorOutput), "utf8") > 64 * 1024) {
        throw new Error("COPY_QUALITY_MATRIX_PRIOR_OUTPUT_TOO_LARGE");
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
            sourceRef: "copy-quality:repair",
            sourceDigest: canonicalDigest(repairMaterial),
            sensitivity: "workspace" as const,
            cacheClass: "never-cache" as const,
            estimatedTokens: 256,
            content: repairMaterial,
          },
        ],
        budget: {
          contextWindow: CONTEXT_WINDOW,
          outputReserve: MAXIMUM_OUTPUT_TOKENS,
          reasoningReserve: REASONING_RESERVE,
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

export interface CopyQualityMatrixFakeTransportRunner {
  execute(executionKey: string): Promise<ModelExecutionResult<CopyTaskOutput>>;
  summary(): Promise<ModelExecutionLedgerSummary>;
}

/**
 * Zero-network contract runner. The caller supplies the fake transport; this
 * module has no provider adapter, gateway URL, credential or raw fetch path.
 * Its durable attestations remain `fake_gateway_contract_only`.
 */
export async function createCopyQualityMatrixFakeTransportRunner(input: {
  ledgerPath: string;
  campaignId: string;
  workspaceId: string;
  transport: ModelTransport<CopyTaskInput, CopyTaskOutput>;
}): Promise<CopyQualityMatrixFakeTransportRunner> {
  validateCopyQualityMatrixPlan(COPY_QUALITY_MATRIX_PLAN);
  const ledger = await AppendOnlyModelExecutionLedger.openTestOnly({
    ledgerPath: input.ledgerPath,
    campaign: {
      campaignId: input.campaignId,
      taskId: COPY_QUALITY_MATRIX_PLAN.taskId,
      planDigest: COPY_QUALITY_MATRIX_PLAN_DIGEST,
      maximumExecutions: COPY_QUALITY_MATRIX_PLAN.plannedExecutions,
      maximumWireCalls: COPY_QUALITY_MATRIX_PLAN.maximumWireCalls,
    },
  });
  const runtime = new DurableModelExecutionRuntime<
    CopyTaskInput,
    CopyTaskOutput
  >({
    ledger,
    expectedEvidenceClass: "fake_gateway_contract_only",
    transport: input.transport,
    repairCompiler: createCopyQualityMatrixRepairCompiler(),
  });

  return Object.freeze({
    execute: async (executionKeyValue: string) => {
      matrixExecution(executionKeyValue);
      validateCopyQualityMatrixPlan(COPY_QUALITY_MATRIX_PLAN);
      return runtime.execute(
        createCopyQualityMatrixExecutionPlan({
          executionKey: executionKeyValue,
          campaignId: input.campaignId,
          workspaceId: input.workspaceId,
        }),
      );
    },
    summary: () => ledger.summary(),
  });
}
