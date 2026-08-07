import { canonicalDigest } from "./context-engine";
import {
  AppendOnlyModelExecutionLedger,
  isTrustedModelExecutionLedger,
  type ModelExecutionEvidenceClass,
} from "./model-execution-ledger";
import {
  isTrustedRealModelExecutionLedger,
  RealModelExecutionLedger,
} from "./real-model-execution-ledger";
import { ModelExecutionRuntime } from "./model-execution-runtime";
import type {
  ExactResultCache,
  ModelCompletionGuard,
  ModelContentRepairCompiler,
  ModelExecutionPlan,
  ModelExecutionResult,
  ModelObservation,
  ModelPostWireGuard,
  ModelRepairPlannedGuard,
  ModelTransport,
  RuntimeTelemetry,
} from "./types";

interface DurableRuntimeDependencies<Input, Output> {
  ledger: AppendOnlyModelExecutionLedger | RealModelExecutionLedger;
  expectedEvidenceClass?: ModelExecutionEvidenceClass;
  transport: ModelTransport<Input, Output>;
  cache?: ExactResultCache;
  telemetry?: RuntimeTelemetry;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  postWireGuard?: ModelPostWireGuard<Input, Output>;
  completionGuard?: ModelCompletionGuard<Input, Output>;
  repairCompiler?: ModelContentRepairCompiler<Input, Output>;
  repairPlannedGuard?: ModelRepairPlannedGuard<Input, Output>;
  preWireGuard?: (
    plan: ModelExecutionPlan<Input, Output>,
  ) => void | Promise<void>;
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
const REAL_CLAIM_EXECUTION = RealModelExecutionLedger.prototype.claimExecution;
const REAL_CLAIM_WIRE = RealModelExecutionLedger.prototype.claimWire;
const REAL_OBSERVE_WIRE = RealModelExecutionLedger.prototype.observeWire;
const REAL_PLAN_REPAIR = RealModelExecutionLedger.prototype.planRepair;
const REAL_COMPLETE_EXECUTION =
  RealModelExecutionLedger.prototype.completeExecution;
const REAL_FREEZE_EXECUTION =
  RealModelExecutionLedger.prototype.freezeExecution;
const REAL_LEDGER_SUMMARY = RealModelExecutionLedger.prototype.summary;

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

const NATIVE_API_UNKNOWN_SETTLEMENT_REASON =
  /^native_api_failure_http_(?:[1-5][0-9]{2}|unknown):(?:request_id_missing|log_unavailable|log_ambiguous|log_invalid|model_mismatch|channel_mismatch|settlement_proof_invalid)(?::body_sha256_[0-9a-f]{64})?(?::bytes_(?:0|[1-9][0-9]{0,15}))?$/u;

function unknownSettlementReason<Output>(
  observation: ModelObservation<Output>,
): string {
  const reason = observation.settlementUnknownReason?.trim();
  return reason != null &&
    reason.length <= 160 &&
    NATIVE_API_UNKNOWN_SETTLEMENT_REASON.test(reason)
    ? reason
    : "observation_or_settlement_incomplete";
}

interface GatewaySettlementClaim {
  requestId: string;
  alias: string;
  protocol: string;
  channelId: number;
  quota: number;
  inputTokens: number;
  outputTokens: number;
  receiptDigest: string;
  resolverId: string;
}

function gatewaySettlementClaim(
  value: unknown,
): GatewaySettlementClaim | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const claim = value as Partial<GatewaySettlementClaim>;
  return typeof claim.requestId === "string" &&
    typeof claim.alias === "string" &&
    typeof claim.protocol === "string" &&
    Number.isSafeInteger(claim.channelId) &&
    Number(claim.channelId) > 0 &&
    Number.isSafeInteger(claim.quota) &&
    Number(claim.quota) >= 0 &&
    Number.isSafeInteger(claim.inputTokens) &&
    Number(claim.inputTokens) >= 0 &&
    Number.isSafeInteger(claim.outputTokens) &&
    Number(claim.outputTokens) >= 0 &&
    typeof claim.receiptDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(claim.receiptDigest) &&
    typeof claim.resolverId === "string"
    ? (claim as GatewaySettlementClaim)
    : undefined;
}

export class DurableModelExecutionRuntime<Input = unknown, Output = unknown> {
  private readonly ledger:
    AppendOnlyModelExecutionLedger | RealModelExecutionLedger;
  private readonly expectedEvidenceClass: ModelExecutionEvidenceClass;
  private readonly transport: ModelTransport<Input, Output>;
  private readonly cache?: ExactResultCache;
  private readonly telemetry?: RuntimeTelemetry;
  private readonly sleep?: (milliseconds: number) => Promise<void>;
  private readonly random?: () => number;
  private readonly postWireGuard?: ModelPostWireGuard<Input, Output>;
  private readonly completionGuard?: ModelCompletionGuard<Input, Output>;
  private readonly repairCompiler?: ModelContentRepairCompiler<Input, Output>;
  private readonly repairPlannedGuard?: ModelRepairPlannedGuard<Input, Output>;
  private readonly preWireGuard?: (
    plan: ModelExecutionPlan<Input, Output>,
  ) => void | Promise<void>;

  constructor(dependencies: DurableRuntimeDependencies<Input, Output>) {
    if (
      !isTrustedModelExecutionLedger(dependencies.ledger) &&
      !isTrustedRealModelExecutionLedger(dependencies.ledger)
    ) {
      throw new Error("MODEL_EXECUTION_LEDGER_UNTRUSTED");
    }
    this.ledger = dependencies.ledger;
    this.expectedEvidenceClass =
      dependencies.expectedEvidenceClass ?? "fake_gateway_contract_only";
    if (this.ledger.evidenceClass !== this.expectedEvidenceClass) {
      throw new Error("MODEL_EXECUTION_EVIDENCE_CLASS_MISMATCH");
    }
    this.transport = dependencies.transport;
    this.cache = dependencies.cache;
    this.telemetry = dependencies.telemetry;
    this.sleep = dependencies.sleep;
    this.random = dependencies.random;
    this.postWireGuard = dependencies.postWireGuard;
    this.completionGuard = dependencies.completionGuard;
    this.repairCompiler = dependencies.repairCompiler;
    this.repairPlannedGuard = dependencies.repairPlannedGuard;
    this.preWireGuard = dependencies.preWireGuard;
  }

  private realLedger(): RealModelExecutionLedger | undefined {
    return isTrustedRealModelExecutionLedger(this.ledger)
      ? this.ledger
      : undefined;
  }

  private claimExecution(input: {
    executionId: string;
    planDigest: string;
  }): Promise<void> {
    const realLedger = this.realLedger();
    return realLedger != null
      ? REAL_CLAIM_EXECUTION.call(realLedger, input)
      : CLAIM_EXECUTION.call(this.ledger, input);
  }

  private claimWire(input: {
    executionId: string;
    wireId: string;
    requestDigest: string;
  }): Promise<void> {
    const realLedger = this.realLedger();
    return realLedger != null
      ? REAL_CLAIM_WIRE.call(realLedger, input)
      : CLAIM_WIRE.call(this.ledger, input);
  }

  private observeUnknown(input: {
    executionId: string;
    wireId: string;
    settlement: "unknown";
    requestId: string | null;
    reason: string;
  }): Promise<void> {
    const realLedger = this.realLedger();
    return realLedger != null
      ? REAL_OBSERVE_WIRE.call(realLedger, input)
      : OBSERVE_WIRE.call(this.ledger, input);
  }

  private observeKnown<ObservedOutput>(input: {
    executionId: string;
    wireId: string;
    observation: ModelObservation<ObservedOutput> & {
      requestId: string;
      reportedModel: string;
      usageComplete: true;
      settlement: "known";
    };
  }): Promise<void> {
    const observation = input.observation;
    const common = {
      executionId: input.executionId,
      wireId: input.wireId,
      settlement: "known" as const,
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
    };
    const realLedger = this.realLedger();
    if (realLedger != null) {
      const proof = gatewaySettlementClaim(observation.settlementProof);
      if (
        proof == null ||
        proof.requestId !== observation.requestId ||
        proof.alias !== observation.resolvedAlias ||
        proof.protocol !== observation.protocol ||
        proof.inputTokens !== observation.usage.inputTokens ||
        proof.outputTokens !== observation.usage.outputTokens
      ) {
        throw new Error("MODEL_EXECUTION_REAL_SETTLEMENT_PROOF_MISSING");
      }
      return REAL_OBSERVE_WIRE.call(realLedger, {
        ...common,
        receiptDigest: proof.receiptDigest,
        quota: proof.quota,
        resolverId: proof.resolverId,
        channelId: proof.channelId,
      });
    }
    return OBSERVE_WIRE.call(this.ledger, common);
  }

  private completeExecution(input: {
    executionId: string;
    outputDigest: string;
  }): Promise<void> {
    const realLedger = this.realLedger();
    return realLedger != null
      ? REAL_COMPLETE_EXECUTION.call(realLedger, input)
      : COMPLETE_EXECUTION.call(this.ledger, input);
  }

  private freezeExecution(executionId: string, reason: string): Promise<void> {
    const realLedger = this.realLedger();
    return realLedger != null
      ? REAL_FREEZE_EXECUTION.call(realLedger, executionId, reason)
      : FREEZE_EXECUTION.call(this.ledger, executionId, reason);
  }

  private summary() {
    const realLedger = this.realLedger();
    return realLedger != null
      ? REAL_LEDGER_SUMMARY.call(realLedger)
      : LEDGER_SUMMARY.call(this.ledger);
  }

  async execute(
    plan: ModelExecutionPlan<Input, Output>,
  ): Promise<ModelExecutionResult<Output>> {
    if (plan.contract.taskId !== this.ledger.campaign.taskId) {
      throw new Error("MODEL_EXECUTION_TASK_MISMATCH");
    }
    const executionPlanDigest = planDigest(plan);
    await this.claimExecution({
      executionId: plan.executionId,
      planDigest: executionPlanDigest,
    });
    let wireCount = 0;
    let lastWireId: string | undefined;
    const durableTransport: ModelTransport<Input, Output> = {
      dispatch: async (currentPlan) => {
        await this.preWireGuard?.(currentPlan);
        wireCount += 1;
        const wireId = `${plan.executionId}:wire:${wireCount}`;
        lastWireId = wireId;
        await this.claimWire({
          executionId: plan.executionId,
          wireId,
          requestDigest: requestDigest(currentPlan, wireCount),
        });
        let observation: ModelObservation<Output>;
        try {
          observation = await this.transport.dispatch(currentPlan);
        } catch (error) {
          await this.observeUnknown({
            executionId: plan.executionId,
            wireId,
            settlement: "unknown",
            requestId: null,
            reason: "transport_failed_after_dispatch",
          });
          try {
            await this.postWireGuard?.({
              plan: currentPlan,
              dispatchError: error,
            });
          } catch (guardError) {
            throw new Error("model execution post-wire guard failed", {
              cause: guardError,
            });
          }
          throw error;
        }
        if (!completeObservation(observation)) {
          await this.observeUnknown({
            executionId: plan.executionId,
            wireId,
            settlement: "unknown",
            requestId: observation.requestId ?? null,
            reason: unknownSettlementReason(observation),
          });
          try {
            await this.postWireGuard?.({ plan: currentPlan, observation });
          } catch (guardError) {
            throw new Error("model execution post-wire guard failed", {
              cause: guardError,
            });
          }
          return observation;
        }
        await this.observeKnown({
          executionId: plan.executionId,
          wireId,
          observation,
        });
        try {
          await this.postWireGuard?.({ plan: currentPlan, observation });
        } catch (guardError) {
          throw new Error("model execution post-wire guard failed", {
            cause: guardError,
          });
        }
        return observation;
      },
    };
    const runtime = new ModelExecutionRuntime<Input, Output>({
      transport: durableTransport,
      ...(this.cache == null ? {} : { cache: this.cache }),
      ...(this.telemetry == null ? {} : { telemetry: this.telemetry }),
      ...(this.sleep == null ? {} : { sleep: this.sleep }),
      ...(this.random == null ? {} : { random: this.random }),
      ...(this.repairCompiler == null
        ? {}
        : { repairCompiler: this.repairCompiler }),
      repairPlannedGuard: async (repair) => {
        const realLedger = this.realLedger();
        if (realLedger != null) {
          if (lastWireId == null) {
            throw new Error("MODEL_EXECUTION_REPAIR_WIRE_MISSING");
          }
          await REAL_PLAN_REPAIR.call(realLedger, {
            executionId: plan.executionId,
            wireId: `${plan.executionId}:wire:${wireCount + 1}`,
            bindingDigest: canonicalDigest(repair.binding),
            priorOutputDigest: repair.binding.priorOutputDigest,
            findingsDigest: repair.binding.findingsDigest,
          });
        }
        await this.repairPlannedGuard?.(repair);
      },
    });
    let result: ModelExecutionResult<Output>;
    try {
      result = await runtime.execute(plan);
    } catch (error) {
      await this.freezeExecution(
        plan.executionId,
        "runtime_rejected_after_execution_claim",
      );
      throw error;
    }
    const outputDigest = canonicalDigest(result.output);
    try {
      await this.completionGuard?.({
        plan,
        result,
        wireCount,
        outputDigest,
      });
    } catch (error) {
      await this.freezeExecution(plan.executionId, "completion_guard_failed");
      throw new Error("model execution completion guard failed", {
        cause: error,
      });
    }
    try {
      await this.completeExecution({
        executionId: plan.executionId,
        outputDigest,
      });
    } catch (error) {
      await this.freezeExecution(plan.executionId, "durable_completion_failed");
      throw error;
    }
    const summary = await this.summary();
    if (summary.evidenceClass !== this.expectedEvidenceClass) {
      await this.freezeExecution(
        plan.executionId,
        "execution_evidence_class_mismatch",
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
