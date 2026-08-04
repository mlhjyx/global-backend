import { canonicalDigest, verifyContextEnvelope } from './context-engine';
import type {
  ExactResultCache,
  ExactResultCacheIdentity,
  ModelExecutionPlan,
  ModelExecutionResult,
  ModelExecutionState,
  ModelObservation,
  ModelTransport,
  RetryPolicy,
  RuntimeTelemetry,
} from './types';

export class TransportDispatchError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, options: { retryable: boolean; retryAfterMs?: number; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TransportDispatchError';
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class ModelExecutionError extends Error {
  readonly states: readonly ModelExecutionState[];

  constructor(message: string, states: readonly ModelExecutionState[], options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ModelExecutionError';
    this.states = [...states];
  }
}

export function unwrapModelExecutionError(error: unknown): unknown {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof ModelExecutionError && current.cause !== undefined && !seen.has(current)) {
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
}

function cacheIdentity<Input, Output>(plan: ModelExecutionPlan<Input, Output>): ExactResultCacheIdentity {
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

export class ModelExecutionRuntime<Input = unknown, Output = unknown> {
  constructor(private readonly dependencies: RuntimeDependencies<Input, Output>) {}

  private async waitBeforeRetry(error: TransportDispatchError, logicalAttempt: number, policy: RetryPolicy): Promise<void> {
    const backoff = policy.transportBackoff;
    const maximum = backoff?.maximumDelayMs ?? Number.MAX_SAFE_INTEGER;
    const exponential = backoff ? backoff.baseDelayMs * (2 ** Math.max(0, logicalAttempt - 1)) : 0;
    const sourceDelay = error.retryAfterMs ?? exponential;
    const jitterRatio = error.retryAfterMs === undefined ? (backoff?.jitterRatio ?? 0) : 0;
    const random = this.dependencies.random?.() ?? Math.random();
    const jitter = sourceDelay * jitterRatio * ((random * 2) - 1);
    const delay = Math.max(0, Math.min(maximum, Math.round(sourceDelay + jitter)));
    if (delay > 0) await (this.dependencies.sleep ?? defaultSleep)(delay);
  }

  async execute(plan: ModelExecutionPlan<Input, Output>): Promise<ModelExecutionResult<Output>> {
    const states: ModelExecutionState[] = [];
    let transportAttempts = 0;
    let repairAttempts = 0;
    const transition = (state: ModelExecutionState, detail?: Readonly<Record<string, string | number | boolean>>): void => {
      states.push(state);
      try {
        void Promise.resolve(this.dependencies.telemetry?.emit({
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
        })).catch(() => undefined);
      } catch {
        // Telemetry is deliberately fail-open and never controls execution.
      }
    };

    transition('planned');
    if (!plan.workspaceId || !plan.executionId) {
      transition('frozen');
      throw new ModelExecutionError('execution identity is incomplete', states);
    }
    if (!Number.isSafeInteger(plan.contract.retryPolicy.transportMaxAttempts)
      || plan.contract.retryPolicy.transportMaxAttempts < 1
      || !Number.isSafeInteger(plan.contract.retryPolicy.contentRepairMaxAttempts)
      || plan.contract.retryPolicy.contentRepairMaxAttempts < 0) {
      transition('frozen');
      throw new ModelExecutionError('execution retry policy is invalid', states);
    }
    try {
      verifyContextEnvelope(plan.context);
      if (plan.context.workspaceId !== plan.workspaceId || plan.context.digest !== plan.contextDigest) {
        throw new Error('context envelope execution identity mismatch');
      }
      if (canonicalDigest(plan.input) !== plan.inputDigest) throw new Error('input digest mismatch');
      if (canonicalDigest(plan.contract.outputSchema) !== plan.schemaDigest) throw new Error('schema digest mismatch');
      canonicalDigest(plan.prompt);
    } catch (error) {
      transition('frozen');
      throw new ModelExecutionError('execution provenance validation failed', states, { cause: error });
    }
    if (!plan.contract.reasoningPolicy.allowed.includes(plan.reasoning)) {
      transition('frozen');
      throw new ModelExecutionError('execution reasoning is not allowed by the task contract', states);
    }
    if (plan.contract.capabilityRequirements.protocols
      && !plan.contract.capabilityRequirements.protocols.includes(plan.protocol)) {
      transition('frozen');
      throw new ModelExecutionError('execution protocol is not allowed by the task contract', states);
    }
    if (plan.contract.capabilityRequirements.reasoning
      && plan.contract.capabilityRequirements.reasoning !== plan.reasoning) {
      transition('frozen');
      throw new ModelExecutionError('execution reasoning does not satisfy the task capability requirement', states);
    }
    transition('admitted');

    if (plan.contract.executionMode === 'deterministic') {
      if (!plan.deterministicExecutor) {
        transition('frozen');
        throw new ModelExecutionError('deterministic task is missing its local executor', states);
      }
      const output = await plan.deterministicExecutor(plan.input);
      try {
        plan.contract.validateOutput(plan.input, output);
      } catch (error) {
        transition('frozen');
        throw new ModelExecutionError('deterministic output validation failed', states, { cause: error });
      }
      transition('validated');
      transition('completed');
      return { output, states, transportAttempts, repairAttempts, cacheHit: false };
    }

    const identity = cacheIdentity(plan);
    if (plan.contract.cachePolicy.mode !== 'disabled' && this.dependencies.cache) {
      const cached = await this.dependencies.cache.get<Output>(identity);
      if (cached) {
        try {
          plan.contract.validateOutput(plan.input, cached.output);
        } catch (error) {
          transition('frozen');
          throw new ModelExecutionError('cached model output validation failed', states, { cause: error });
        }
        transition('validated', { cacheHit: true });
        transition('completed', { cacheHit: true });
        return { output: cached.output, states, transportAttempts, repairAttempts, cacheHit: true };
      }
    }

    let currentPlan = plan;
    let observation: ModelObservation<Output> | undefined;
    while (true) {
      let logicalAttempts = 0;
      while (true) {
        logicalAttempts += 1;
        transportAttempts += 1;
        transition('dispatched', { transportAttempt: transportAttempts, repairAttempt: repairAttempts });
        try {
          observation = await this.dependencies.transport.dispatch(currentPlan);
          break;
        } catch (error) {
          const canRetry = error instanceof TransportDispatchError
            && error.retryable
            && logicalAttempts < plan.contract.retryPolicy.transportMaxAttempts;
          if (canRetry) {
            await this.waitBeforeRetry(
              error,
              logicalAttempts,
              plan.contract.retryPolicy,
            );
            continue;
          }
          transition('frozen');
          throw new ModelExecutionError('model transport failed', states, { cause: error });
        }
      }

      transition('observed', {
        ...(observation.reportedModel === undefined ? {} : { reportedModel: observation.reportedModel }),
        ...(observation.requestId === undefined ? {} : { requestId: observation.requestId }),
        inputTokens: observation.usage.inputTokens,
        outputTokens: observation.usage.outputTokens,
        settlement: observation.settlement,
      });
      if (observation.requestedAlias !== currentPlan.requestedAlias
        || observation.resolvedAlias !== currentPlan.resolvedAlias
        || observation.protocol !== currentPlan.protocol) {
        transition('frozen');
        throw new ModelExecutionError('model observation identity does not match the execution plan', states);
      }
      if (observation.settlement !== 'known') {
        transition('frozen');
        throw new ModelExecutionError('model settlement is unknown', states);
      }

      try {
        plan.contract.validateOutput(plan.input, observation.output);
      } catch (error) {
        if (repairAttempts >= plan.contract.retryPolicy.contentRepairMaxAttempts) {
          transition('frozen');
          throw new ModelExecutionError('model output validation failed', states, { cause: error });
        }
        repairAttempts += 1;
        transition('repaired', { repairAttempt: repairAttempts });
        const finding = error instanceof Error ? error.message : String(error);
        currentPlan = {
          ...plan,
          repair: {
            priorOutputDigest: canonicalDigest(observation.output),
            findingsDigest: canonicalDigest(finding),
            originalInputDigest: plan.inputDigest,
            originalContextDigest: plan.contextDigest,
          },
        };
        continue;
      }
      transition('validated');
      break;
    }

    transition('settled', { settlement: observation.settlement });
    if (plan.contract.cachePolicy.mode !== 'disabled' && this.dependencies.cache) {
      const entry = { output: observation.output, settlement: 'known' as const, validated: true };
      if (currentPlan.repair) {
        await this.dependencies.cache.putRepair(identity, cacheIdentity(currentPlan), entry);
      } else {
        await this.dependencies.cache.put(identity, entry);
      }
    }
    transition('completed');
    return { output: observation.output, observation, states, transportAttempts, repairAttempts, cacheHit: false };
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
