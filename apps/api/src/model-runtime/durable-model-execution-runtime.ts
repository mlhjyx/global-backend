import { canonicalDigest } from "./context-engine";
import {
  AppendOnlyModelExecutionLedger,
  isTrustedModelExecutionLedger,
  type ModelExecutionEvidenceClass,
} from "./model-execution-ledger";
import { ModelExecutionRuntime } from "./model-execution-runtime";
import type {
  ExactResultCache,
  ModelExecutionPlan,
  ModelExecutionResult,
  ModelObservation,
  ModelTransport,
  RuntimeTelemetry,
} from "./types";

interface DurableRuntimeDependencies<Input, Output> {
  ledger: AppendOnlyModelExecutionLedger;
  transport: ModelTransport<Input, Output>;
  cache?: ExactResultCache;
  telemetry?: RuntimeTelemetry;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

export interface DurableModelExecutionAttestation {
  evidenceClass: ModelExecutionEvidenceClass;
  campaignId: string;
  executionId: string;
  ledgerDigest: string;
  wireCount: number;
  outputDigest: string;
}

const DURABLE_MODEL_EXECUTION_RESULTS = new WeakMap<
  object,
  DurableModelExecutionAttestation
>();
const CLAIM_EXECUTION = AppendOnlyModelExecutionLedger.prototype.claimExecution;
const CLAIM_WIRE = AppendOnlyModelExecutionLedger.prototype.claimWire;
const OBSERVE_WIRE = AppendOnlyModelExecutionLedger.prototype.observeWire;
const COMPLETE_EXECUTION =
  AppendOnlyModelExecutionLedger.prototype.completeExecution;
const FREEZE_EXECUTION =
  AppendOnlyModelExecutionLedger.prototype.freezeExecution;
const LEDGER_SUMMARY = AppendOnlyModelExecutionLedger.prototype.summary;

export function getDurableModelExecutionAttestation(
  result: ModelExecutionResult<unknown>,
): DurableModelExecutionAttestation | undefined {
  return DURABLE_MODEL_EXECUTION_RESULTS.get(result);
}

function planDigest<Input, Output>(
  plan: ModelExecutionPlan<Input, Output>,
): string {
  return canonicalDigest({
    executionId: plan.executionId,
    workspaceId: plan.workspaceId,
    buildRunId: plan.buildRunId,
    taskId: plan.contract.taskId,
    taskVersion: plan.contract.version,
    inputDigest: plan.inputDigest,
    contextDigest: plan.contextDigest,
    promptVersion: plan.promptVersion,
    schemaDigest: plan.schemaDigest,
    requestedAlias: plan.requestedAlias,
    resolvedAlias: plan.resolvedAlias,
    protocol: plan.protocol,
    reasoning: plan.reasoning,
    sampling: plan.sampling,
    locale: plan.locale,
    promptDigest: canonicalDigest(plan.prompt),
    ...(plan.repair == null ? {} : { repair: plan.repair }),
  });
}

function requestDigest<Input, Output>(
  plan: ModelExecutionPlan<Input, Output>,
  wireOrdinal: number,
): string {
  return canonicalDigest({
    planDigest: planDigest(plan),
    wireOrdinal,
    promptDigest: canonicalDigest(plan.prompt),
    repair: plan.repair ?? null,
  });
}

function completeObservation<Output>(
  observation: ModelObservation<Output>,
): observation is ModelObservation<Output> & {
  requestId: string;
  reportedModel: string;
  usageComplete: true;
  settlement: "known";
} {
  return (
    observation.settlement === "known" &&
    typeof observation.requestId === "string" &&
    observation.requestId.trim().length > 0 &&
    typeof observation.reportedModel === "string" &&
    observation.reportedModel.trim().length > 0 &&
    observation.usageComplete === true &&
    Number.isSafeInteger(observation.usage.inputTokens) &&
    observation.usage.inputTokens >= 0 &&
    Number.isSafeInteger(observation.usage.outputTokens) &&
    observation.usage.outputTokens >= 0
  );
}

export class DurableModelExecutionRuntime<Input = unknown, Output = unknown> {
  private readonly ledger: AppendOnlyModelExecutionLedger;
  private readonly transport: ModelTransport<Input, Output>;
  private readonly cache?: ExactResultCache;
  private readonly telemetry?: RuntimeTelemetry;
  private readonly sleep?: (milliseconds: number) => Promise<void>;
  private readonly random?: () => number;

  constructor(dependencies: DurableRuntimeDependencies<Input, Output>) {
    if (!isTrustedModelExecutionLedger(dependencies.ledger)) {
      throw new Error("MODEL_EXECUTION_LEDGER_UNTRUSTED");
    }
    this.ledger = dependencies.ledger;
    this.transport = dependencies.transport;
    this.cache = dependencies.cache;
    this.telemetry = dependencies.telemetry;
    this.sleep = dependencies.sleep;
    this.random = dependencies.random;
  }

  async execute(
    plan: ModelExecutionPlan<Input, Output>,
  ): Promise<ModelExecutionResult<Output>> {
    if (plan.contract.taskId !== this.ledger.campaign.taskId) {
      throw new Error("MODEL_EXECUTION_TASK_MISMATCH");
    }
    const executionPlanDigest = planDigest(plan);
    await CLAIM_EXECUTION.call(this.ledger, {
      executionId: plan.executionId,
      planDigest: executionPlanDigest,
    });
    let wireCount = 0;
    const durableTransport: ModelTransport<Input, Output> = {
      dispatch: async (currentPlan) => {
        wireCount += 1;
        const wireId = `${plan.executionId}:wire:${wireCount}`;
        await CLAIM_WIRE.call(this.ledger, {
          executionId: plan.executionId,
          wireId,
          requestDigest: requestDigest(currentPlan, wireCount),
        });
        let observation: ModelObservation<Output>;
        try {
          observation = await this.transport.dispatch(currentPlan);
        } catch (error) {
          await OBSERVE_WIRE.call(this.ledger, {
            executionId: plan.executionId,
            wireId,
            settlement: "unknown",
            requestId: null,
            reason: "transport_failed_after_dispatch",
          });
          throw error;
        }
        if (!completeObservation(observation)) {
          await OBSERVE_WIRE.call(this.ledger, {
            executionId: plan.executionId,
            wireId,
            settlement: "unknown",
            requestId: observation.requestId ?? null,
            reason: "observation_or_settlement_incomplete",
          });
          return observation;
        }
        await OBSERVE_WIRE.call(this.ledger, {
          executionId: plan.executionId,
          wireId,
          settlement: "known",
          requestId: observation.requestId,
          requestedAlias: observation.requestedAlias,
          resolvedAlias: observation.resolvedAlias,
          reportedModel: observation.reportedModel,
          protocol: observation.protocol,
          usage: {
            inputTokens: observation.usage.inputTokens,
            outputTokens: observation.usage.outputTokens,
          },
          outputDigest: canonicalDigest(observation.output),
        });
        return observation;
      },
    };
    const runtime = new ModelExecutionRuntime<Input, Output>({
      transport: durableTransport,
      ...(this.cache == null ? {} : { cache: this.cache }),
      ...(this.telemetry == null ? {} : { telemetry: this.telemetry }),
      ...(this.sleep == null ? {} : { sleep: this.sleep }),
      ...(this.random == null ? {} : { random: this.random }),
    });
    let result: ModelExecutionResult<Output>;
    try {
      result = await runtime.execute(plan);
    } catch (error) {
      await FREEZE_EXECUTION.call(
        this.ledger,
        plan.executionId,
        "runtime_rejected_after_execution_claim",
      );
      throw error;
    }
    const outputDigest = canonicalDigest(result.output);
    try {
      await COMPLETE_EXECUTION.call(this.ledger, {
        executionId: plan.executionId,
        outputDigest,
      });
    } catch (error) {
      await FREEZE_EXECUTION.call(
        this.ledger,
        plan.executionId,
        "durable_completion_failed",
      );
      throw error;
    }
    const summary = await LEDGER_SUMMARY.call(this.ledger);
    if (summary.evidenceClass !== "fake_gateway_contract_only") {
      await FREEZE_EXECUTION.call(
        this.ledger,
        plan.executionId,
        "test_only_evidence_class_mismatch",
      );
      throw new Error("MODEL_EXECUTION_EVIDENCE_CLASS_MISMATCH");
    }
    const attestation = Object.freeze({
      evidenceClass: summary.evidenceClass,
      campaignId: summary.campaign.campaignId,
      executionId: plan.executionId,
      ledgerDigest: summary.ledgerDigest,
      wireCount,
      outputDigest,
    });
    DURABLE_MODEL_EXECUTION_RESULTS.set(result, attestation);
    return result;
  }
}
