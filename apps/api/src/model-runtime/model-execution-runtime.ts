import { canonicalDigest, verifyContextEnvelope } from "./context-engine";
import { deepFreeze } from "./immutable";
import type {
  ExactResultCache,
  ExactResultCacheIdentity,
  ModelContentRepairCompiler,
  ModelExecutionPlan,
  ModelExecutionResult,
  ModelExecutionState,
  ModelObservation,
  ModelTransport,
  RetryPolicy,
  RuntimeTelemetry,
  ModelValidationFinding,
  ModelRepairPlannedGuard,
} from "./types";

export class TransportDispatchError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { retryable: boolean; retryAfterMs?: number; cause?: unknown },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "TransportDispatchError";
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class ModelExecutionError extends Error {
  readonly states: readonly ModelExecutionState[];

  constructor(
    message: string,
    states: readonly ModelExecutionState[],
    options?: { cause?: unknown },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ModelExecutionError";
    this.states = [...states];
  }
}

export function unwrapModelExecutionError(error: unknown): unknown {
  let current = error;
  const seen = new Set<unknown>();
  while (
    current instanceof ModelExecutionError &&
    current.cause !== undefined &&
    !seen.has(current)
  ) {
    seen.add(current);
    current = current.cause;
  }
  return current;
}

interface RuntimeDependencies<Input, Output> {
  transport: ModelTransport<Input, Output>;
  cache?: ExactResultCache;
  telemetry?: RuntimeTelemetry;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  repairCompiler?: ModelContentRepairCompiler<Input, Output>;
  repairPlannedGuard?: ModelRepairPlannedGuard<Input, Output>;
}

export interface TrustedModelExecutionMetadata {
  executionId: string;
  taskId: string;
  taskVersion: string;
  requestedAlias: string;
  resolvedAlias: string;
  reportedModel?: string;
  protocol: ModelExecutionPlan<unknown, unknown>["protocol"];
  reasoning: ModelExecutionPlan<unknown, unknown>["reasoning"];
  cacheMode: ModelExecutionPlan<
    unknown,
    unknown
  >["contract"]["cachePolicy"]["mode"];
  settlement: "known" | "unknown" | "not_applicable";
  outputDigest: string;
  cacheHit: boolean;
}

const TRUSTED_MODEL_EXECUTION_RESULTS = new WeakMap<
  object,
  TrustedModelExecutionMetadata
>();

export function getTrustedModelExecutionMetadata(
  result: ModelExecutionResult<unknown>,
): TrustedModelExecutionMetadata | undefined {
  return TRUSTED_MODEL_EXECUTION_RESULTS.get(result);
}

function completeExecutionResult<Input, Output>(
  plan: ModelExecutionPlan<Input, Output>,
  result: ModelExecutionResult<Output>,
): ModelExecutionResult<Output> {
  const completed = Object.freeze({
    ...result,
    states: Object.freeze([...result.states]),
  });
  TRUSTED_MODEL_EXECUTION_RESULTS.set(
    completed,
    Object.freeze({
      executionId: plan.executionId,
      taskId: plan.contract.taskId,
      taskVersion: plan.contract.version,
      requestedAlias: plan.requestedAlias,
      resolvedAlias: plan.resolvedAlias,
      ...(result.observation?.reportedModel === undefined
        ? {}
        : { reportedModel: result.observation.reportedModel }),
      protocol: plan.protocol,
      reasoning: plan.reasoning,
      cacheMode: plan.contract.cachePolicy.mode,
      settlement:
        result.observation?.settlement ??
        (plan.contract.executionMode === "deterministic"
          ? "not_applicable"
          : "unknown"),
      outputDigest: canonicalDigest(result.output),
      cacheHit: result.cacheHit,
    }),
  );
  return completed;
}

function cacheIdentity<Input, Output>(
  plan: ModelExecutionPlan<Input, Output>,
): ExactResultCacheIdentity {
  return {
    workspaceId: plan.workspaceId,
    buildRunId: plan.buildRunId,
    taskId: plan.contract.taskId,
    taskContractVersion: plan.contract.version,
    promptVersion: plan.promptVersion,
    schemaDigest: plan.schemaDigest,
    inputDigest: plan.inputDigest,
    contextDigest: plan.contextDigest,
    promptDigest: canonicalDigest(plan.prompt),
    resolvedAlias: plan.resolvedAlias,
    protocol: plan.protocol,
    reasoning: plan.reasoning,
    sampling: plan.sampling,
    locale: plan.locale,
    ...(plan.repair
      ? {
          priorOutputDigest: plan.repair.priorOutputDigest,
          findingsDigest: plan.repair.findingsDigest,
        }
      : {}),
  };
}

function validateContextSources<Input, Output>(
  plan: ModelExecutionPlan<Input, Output>,
): void {
  const allowed = new Set(plan.contract.contextPolicy.allowedSourceRefs);
  if (plan.context.policyVersion !== plan.contract.contextPolicy.version) {
    throw new Error("context policy version mismatch");
  }
  for (const segment of plan.context.segments) {
    if (!allowed.has(segment.sourceRef)) {
      throw new Error(`context source is not allowed: ${segment.sourceRef}`);
    }
  }
}

function validateFindings(value: readonly ModelValidationFinding[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error("repair findings are invalid");
  }
  for (const finding of value) {
    if (
      !finding ||
      typeof finding !== "object" ||
      Object.keys(finding).sort().join(",") !== "code,path" ||
      typeof finding.code !== "string" ||
      finding.code.length < 1 ||
      finding.code.length > 96 ||
      typeof finding.path !== "string" ||
      finding.path.length < 1 ||
      finding.path.length > 192
    ) {
      throw new Error("repair findings are invalid");
    }
  }
  canonicalDigest(value);
}

function validateRepairPlan<Input, Output>(input: {
  originalPlan: ModelExecutionPlan<Input, Output>;
  currentPlan: ModelExecutionPlan<Input, Output>;
  repairPlan: ModelExecutionPlan<Input, Output>;
  findings: readonly ModelValidationFinding[];
  priorOutput: Output;
  binding: ModelExecutionPlan<Input, Output>["repair"];
}): void {
  const {
    originalPlan,
    currentPlan,
    repairPlan,
    findings,
    priorOutput,
    binding,
  } = input;
  if (
    binding == null ||
    canonicalDigest(repairPlan.repair) !== canonicalDigest(binding)
  ) {
    throw new Error("repair binding mismatch");
  }
  const invariant = {
    executionId: originalPlan.executionId,
    workspaceId: originalPlan.workspaceId,
    buildRunId: originalPlan.buildRunId,
    contract: originalPlan.contract,
    input: originalPlan.input,
    inputDigest: originalPlan.inputDigest,
    promptVersion: originalPlan.promptVersion,
    schemaDigest: originalPlan.schemaDigest,
    requestedAlias: originalPlan.requestedAlias,
    resolvedAlias: originalPlan.resolvedAlias,
    protocol: originalPlan.protocol,
    reasoning: originalPlan.reasoning,
    sampling: originalPlan.sampling,
    locale: originalPlan.locale,
  };
  for (const [key, expected] of Object.entries(invariant)) {
    if (repairPlan[key as keyof typeof repairPlan] !== expected) {
      throw new Error(`repair plan changed ${key}`);
    }
  }
  if (
    currentPlan.repair != null ||
    repairPlan.contextDigest === originalPlan.contextDigest
  ) {
    throw new Error("repair plan context is not a single repair");
  }
  verifyContextEnvelope(repairPlan.context);
  validateContextSources(repairPlan);
  if (
    repairPlan.context.workspaceId !== originalPlan.workspaceId ||
    repairPlan.context.digest !== repairPlan.contextDigest
  ) {
    throw new Error("repair context identity mismatch");
  }
  const repairSegments = repairPlan.context.segments.filter(
    ({ kind }) => kind === "repair",
  );
  const preservedSegments = repairPlan.context.segments.filter(
    ({ kind }) => kind !== "repair",
  );
  const repairMaterial = { binding, findings, priorOutput };
  const { repair: repairPromptMaterial, ...preservedPrompt } =
    repairPlan.prompt;
  if (
    canonicalDigest(preservedSegments) !==
      canonicalDigest(originalPlan.context.segments) ||
    repairPlan.context.outputReserve !== originalPlan.context.outputReserve ||
    repairPlan.context.reasoningReserve !==
      originalPlan.context.reasoningReserve ||
    canonicalDigest(preservedPrompt) !== canonicalDigest(originalPlan.prompt) ||
    canonicalDigest(priorOutput) !== binding.priorOutputDigest ||
    canonicalDigest(repairPlan.input) !== repairPlan.inputDigest ||
    canonicalDigest(repairPlan.contract.outputSchema) !==
      repairPlan.schemaDigest ||
    repairSegments.length !== 1 ||
    repairSegments[0]?.cacheClass !== "never-cache" ||
    repairSegments[0]?.sourceDigest !== canonicalDigest(repairMaterial) ||
    canonicalDigest(repairSegments[0]?.content) !==
      canonicalDigest(repairMaterial) ||
    canonicalDigest(repairPromptMaterial) !== canonicalDigest(repairMaterial)
  ) {
    throw new Error("repair payload is not digest-bound");
  }
}

export class ModelExecutionRuntime<Input = unknown, Output = unknown> {
  constructor(
    private readonly dependencies: RuntimeDependencies<Input, Output>,
  ) {}

  private async waitBeforeRetry(
    error: TransportDispatchError,
    logicalAttempt: number,
    policy: RetryPolicy,
  ): Promise<void> {
    const backoff = policy.transportBackoff;
    const maximum = backoff?.maximumDelayMs ?? Number.MAX_SAFE_INTEGER;
    const exponential = backoff
      ? backoff.baseDelayMs * 2 ** Math.max(0, logicalAttempt - 1)
      : 0;
    const sourceDelay = error.retryAfterMs ?? exponential;
    const jitterRatio =
      error.retryAfterMs === undefined ? (backoff?.jitterRatio ?? 0) : 0;
    const random = this.dependencies.random?.() ?? Math.random();
    const jitter = sourceDelay * jitterRatio * (random * 2 - 1);
    const delay = Math.max(
      0,
      Math.min(maximum, Math.round(sourceDelay + jitter)),
    );
    if (delay > 0) await (this.dependencies.sleep ?? defaultSleep)(delay);
  }

  async execute(
    plan: ModelExecutionPlan<Input, Output>,
  ): Promise<ModelExecutionResult<Output>> {
    deepFreeze(plan);
    const states: ModelExecutionState[] = [];
    let transportAttempts = 0;
    let repairAttempts = 0;
    const transition = (
      state: ModelExecutionState,
      detail?: Readonly<Record<string, string | number | boolean>>,
    ): void => {
      states.push(state);
      try {
        void Promise.resolve(
          this.dependencies.telemetry?.emit({
            executionId: plan.executionId,
            state,
            taskId: plan.contract.taskId,
            taskVersion: plan.contract.version,
            workspaceId: plan.workspaceId,
            contextDigest: plan.contextDigest,
            requestedAlias: plan.requestedAlias,
            resolvedAlias: plan.resolvedAlias,
            protocol: plan.protocol,
            reasoning: plan.reasoning,
            fallbackIndex: plan.fallbackIndex ?? 0,
            detail,
          }),
        ).catch(() => undefined);
      } catch {
        // Telemetry is deliberately fail-open and never controls execution.
      }
    };

    transition("planned");
    if (!plan.workspaceId || !plan.executionId) {
      transition("frozen");
      throw new ModelExecutionError("execution identity is incomplete", states);
    }
    if (
      !Number.isSafeInteger(plan.contract.retryPolicy.transportMaxAttempts) ||
      plan.contract.retryPolicy.transportMaxAttempts < 1 ||
      !Number.isSafeInteger(
        plan.contract.retryPolicy.contentRepairMaxAttempts,
      ) ||
      plan.contract.retryPolicy.contentRepairMaxAttempts < 0 ||
      plan.contract.retryPolicy.contentRepairMaxAttempts > 1
    ) {
      transition("frozen");
      throw new ModelExecutionError(
        "execution retry policy is invalid",
        states,
      );
    }
    try {
      verifyContextEnvelope(plan.context);
      validateContextSources(plan);
      if (
        plan.repair != null ||
        plan.context.segments.some(({ kind }) => kind === "repair")
      ) {
        throw new Error("root execution cannot start from a repair payload");
      }
      if (
        plan.context.workspaceId !== plan.workspaceId ||
        plan.context.digest !== plan.contextDigest
      ) {
        throw new Error("context envelope execution identity mismatch");
      }
      if (canonicalDigest(plan.input) !== plan.inputDigest)
        throw new Error("input digest mismatch");
      if (canonicalDigest(plan.contract.outputSchema) !== plan.schemaDigest)
        throw new Error("schema digest mismatch");
      canonicalDigest(plan.prompt);
    } catch (error) {
      transition("frozen");
      throw new ModelExecutionError(
        "execution provenance validation failed",
        states,
        { cause: error },
      );
    }
    if (!plan.contract.reasoningPolicy.allowed.includes(plan.reasoning)) {
      transition("frozen");
      throw new ModelExecutionError(
        "execution reasoning is not allowed by the task contract",
        states,
      );
    }
    if (
      plan.contract.capabilityRequirements.protocols &&
      !plan.contract.capabilityRequirements.protocols.includes(plan.protocol)
    ) {
      transition("frozen");
      throw new ModelExecutionError(
        "execution protocol is not allowed by the task contract",
        states,
      );
    }
    if (
      plan.contract.capabilityRequirements.reasoning &&
      plan.contract.capabilityRequirements.reasoning !== plan.reasoning
    ) {
      transition("frozen");
      throw new ModelExecutionError(
        "execution reasoning does not satisfy the task capability requirement",
        states,
      );
    }
    transition("admitted");

    if (plan.contract.executionMode === "deterministic") {
      if (!plan.deterministicExecutor) {
        transition("frozen");
        throw new ModelExecutionError(
          "deterministic task is missing its local executor",
          states,
        );
      }
      const output = await plan.deterministicExecutor(plan.input);
      try {
        plan.contract.validateOutput(plan.input, output);
      } catch (error) {
        transition("frozen");
        throw new ModelExecutionError(
          "deterministic output validation failed",
          states,
          { cause: error },
        );
      }
      transition("validated");
      transition("completed");
      return completeExecutionResult(plan, {
        output,
        states,
        transportAttempts,
        repairAttempts,
        cacheHit: false,
      });
    }

    const identity = cacheIdentity(plan);
    if (
      plan.contract.cachePolicy.mode !== "disabled" &&
      this.dependencies.cache
    ) {
      const cached = await this.dependencies.cache.get<Output>(identity);
      if (cached) {
        try {
          plan.contract.validateOutput(plan.input, cached.output);
        } catch (error) {
          transition("frozen");
          throw new ModelExecutionError(
            "cached model output validation failed",
            states,
            { cause: error },
          );
        }
        transition("validated", { cacheHit: true });
        transition("completed", { cacheHit: true });
        return completeExecutionResult(plan, {
          output: cached.output,
          states,
          transportAttempts,
          repairAttempts,
          cacheHit: true,
        });
      }
    }

    let currentPlan = plan;
    let observation: ModelObservation<Output> | undefined;
    while (true) {
      let logicalAttempts = 0;
      while (true) {
        logicalAttempts += 1;
        transportAttempts += 1;
        transition("dispatched", {
          transportAttempt: transportAttempts,
          repairAttempt: repairAttempts,
        });
        try {
          observation = await this.dependencies.transport.dispatch(currentPlan);
          break;
        } catch (error) {
          const canRetry =
            error instanceof TransportDispatchError &&
            error.retryable &&
            logicalAttempts < plan.contract.retryPolicy.transportMaxAttempts;
          if (canRetry) {
            await this.waitBeforeRetry(
              error,
              logicalAttempts,
              plan.contract.retryPolicy,
            );
            continue;
          }
          transition("frozen");
          throw new ModelExecutionError("model transport failed", states, {
            cause: error,
          });
        }
      }

      transition("observed", {
        ...(observation.reportedModel === undefined
          ? {}
          : { reportedModel: observation.reportedModel }),
        ...(observation.requestId === undefined
          ? {}
          : { requestId: observation.requestId }),
        inputTokens: observation.usage.inputTokens,
        outputTokens: observation.usage.outputTokens,
        settlement: observation.settlement,
      });
      if (
        observation.requestedAlias !== currentPlan.requestedAlias ||
        observation.resolvedAlias !== currentPlan.resolvedAlias ||
        observation.protocol !== currentPlan.protocol
      ) {
        transition("frozen");
        throw new ModelExecutionError(
          "model observation identity does not match the execution plan",
          states,
        );
      }
      if (observation.settlement !== "known") {
        transition("frozen");
        throw new ModelExecutionError("model settlement is unknown", states);
      }
      if (
        plan.contract.capabilityRequirements.reportsRequestId &&
        (typeof observation.requestId !== "string" ||
          observation.requestId.trim().length === 0)
      ) {
        transition("frozen");
        throw new ModelExecutionError(
          "model observation is missing a request ID",
          states,
        );
      }
      if (
        plan.contract.capabilityRequirements.reportsUsage &&
        observation.usageComplete !== true
      ) {
        transition("frozen");
        throw new ModelExecutionError(
          "model observation usage is incomplete",
          states,
        );
      }
      if (
        plan.contract.capabilityRequirements.reportsModel &&
        (typeof observation.reportedModel !== "string" ||
          observation.reportedModel.trim().length === 0)
      ) {
        transition("frozen");
        throw new ModelExecutionError(
          "model observation is missing the reported model",
          states,
        );
      }
      if (
        plan.contract.capabilityRequirements.exactReportedModel &&
        observation.reportedModel !== currentPlan.resolvedAlias
      ) {
        transition("frozen");
        throw new ModelExecutionError(
          "model observation reported model is not exact",
          states,
        );
      }
      if (
        plan.contract.capabilityRequirements.forbidWarnings &&
        observation.warnings?.length
      ) {
        transition("frozen");
        throw new ModelExecutionError(
          "model observation contains provider warnings",
          states,
        );
      }

      try {
        currentPlan.contract.validateOutput(
          currentPlan.input,
          observation.output,
        );
      } catch (error) {
        const compiler = this.dependencies.repairCompiler;
        if (
          compiler == null ||
          repairAttempts >= plan.contract.retryPolicy.contentRepairMaxAttempts
        ) {
          transition("frozen");
          throw new ModelExecutionError(
            "model output validation failed; Runtime content repair is not admitted",
            states,
            { cause: error },
          );
        }
        try {
          const findings = Object.freeze(
            [...compiler.findings(error)].map((finding) =>
              Object.freeze({ ...finding }),
            ),
          );
          validateFindings(findings);
          const priorOutput = deepFreeze(observation.output);
          const binding = Object.freeze({
            priorOutputDigest: canonicalDigest(priorOutput),
            findingsDigest: canonicalDigest(findings),
            originalInputDigest: plan.inputDigest,
            originalContextDigest: plan.contextDigest,
          });
          const repairPlan = compiler.compile({
            originalPlan: plan,
            currentPlan,
            priorOutput,
            findings,
            binding,
            repairAttempt: repairAttempts + 1,
          });
          validateRepairPlan({
            originalPlan: plan,
            currentPlan,
            repairPlan,
            findings,
            priorOutput,
            binding,
          });
          await this.dependencies.repairPlannedGuard?.({
            originalPlan: plan,
            repairPlan,
            binding,
            findings,
          });
          currentPlan = repairPlan;
          repairAttempts += 1;
          transition("repaired", { repairAttempt: repairAttempts });
          continue;
        } catch (repairError) {
          transition("frozen");
          throw new ModelExecutionError(
            "repair plan validation failed",
            states,
            {
              cause: repairError,
            },
          );
        }
      }
      transition("validated");
      break;
    }

    transition("settled", { settlement: observation.settlement });
    if (
      plan.contract.cachePolicy.mode !== "disabled" &&
      this.dependencies.cache
    ) {
      const entry = {
        output: observation.output,
        settlement: "known" as const,
        validated: true,
      };
      if (currentPlan.repair) {
        await this.dependencies.cache.putRepair(
          identity,
          cacheIdentity(currentPlan),
          entry,
        );
      } else {
        await this.dependencies.cache.put(identity, entry);
      }
    }
    transition("completed");
    return completeExecutionResult(plan, {
      output: observation.output,
      observation,
      states,
      transportAttempts,
      repairAttempts,
      cacheHit: false,
    });
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
