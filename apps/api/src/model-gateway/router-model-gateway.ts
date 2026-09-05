import { Inject, Injectable, Optional } from "@nestjs/common";
import { ModelGateway } from "./model-gateway";
import { ModelRouter } from "./model-router";
import { ModelProvider } from "./model-provider";
import { AiTraceSink } from "./ai-trace.sink";
import {
  assertModelOutputSchemaCompiles,
  checkAgainstSchema,
} from "./schema-validate";
import { DEFAULT_LLM_EST_CENTS } from "../tools/budget";
import {
  BudgetExceededError,
  BudgetOperationReplayError,
  TOOL_BUDGET_STORE,
  UnavailableBudgetStore,
  type BudgetStore,
} from "../tools/budget-store";
import {
  projectModelResultForReplay,
  restoreModelResultFromReplay,
} from "../durable-results/model-result-replay";
import {
  ExternalActionDeniedError,
  ProviderIdentityError,
  ProviderOutputError,
  ProviderSettlementError,
  ProviderWireInFlightError,
  TaskOutputValidationError,
} from "./providers/provider-output-error";
import {
  modelCostMeasurement,
  paidOperationKey,
  PaidCallDeniedError,
  PaidOperationUnknownError,
  SITE_BUILD_DURABLE_TOKEN_MAXIMUM,
  type PaidCostMeasurement,
  type PaidOperationReservation,
  type SiteBuildCostLedger,
} from "../site-builder/site-build-cost-ledger";
import type { SiteBuildCostReconciliationCatalog } from "../site-builder/site-build-cost-reconciliation-resolver";
import {
  NEW_API_REQUEST_BOUND_RESOLVER_ID,
  type NewApiRequestBoundSettlementResolver,
} from "./new-api-request-bound-settlement";
import {
  settlementWireIdentities,
  type SettlementDerivationKeyring,
  type SettlementWireIdentity,
} from "./settlement-wire-identity";
import {
  createProviderTransportObservation,
  modelSettlementErrorCode,
  type ProviderGatewayIdState,
  type ProviderPayloadState,
} from "./provider-transport-observation";
import type {
  GatewaySettlementObservation,
  PaidModelPhysicalWireRuntime,
} from "./paid-model-settlement";
import { modelExecutionReceiptFacts } from "../durable-results/execution-receipt-facts";
import { centsToMicrousd, usdToMicrousdCeil } from "../tools/microusd";

/**
 * provider 不上报 costUsd 时按 token 折算实际成本（复审 HIGH 修复）：否则 settle 恒按
 * 声明上限（15-20¢/次 vs 真实 ~0.05-0.5¢）记账，$20 run 预算实为 ~100 次调用的硬顶，
 * 规模 run 中后段 fit 判定被静默截断。保守混合价 env 可调（LLM_CENTS_PER_MTOK，默认
 * 100¢/M tok ≈ $1/M——对 flash 档仍高估数倍，作预算上界足够诚实）。
 */
function centsFromTokens(usage?: {
  inputTokens?: number;
  outputTokens?: number;
}): number | null {
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  if (tokens <= 0) return null;
  const env = Number(process.env.LLM_CENTS_PER_MTOK);
  const perMtok = Number.isFinite(env) && env > 0 ? env : 100;
  return Math.max(1, Math.ceil((tokens * perMtok) / 1_000_000));
}

function providerReportedMicrousd(usage?: ModelUsage): bigint | null {
  const costUsd = usage?.costUsd;
  if (!Number.isFinite(costUsd) || (costUsd as number) < 0) return null;
  return usdToMicrousdCeil(String(costUsd));
}

/**
 * 合并首调 + 修复重试的 usage（FIX 1）：校验-修复路径无论成功还是失败，都要把两次已消耗 token 汇总，
 * 让网关 catch 按 centsFromTokens 结算真实消耗——否则修复抛错只带修复 usage（漏首调）、recheck 失败
 * 抛裸 Error（记 0¢），都绕过改动 2 的硬预算上界「凡消耗 token 的调用都不该 settle 0¢」。
 */
function mergeStructuredUsage(a?: ModelUsage, b?: ModelUsage): ModelUsage {
  const bothReported =
    Number.isFinite(a?.costUsd) && Number.isFinite(b?.costUsd);
  const gatewaySettlements = [
    ...(a?.gatewaySettlements ?? []),
    ...(b?.gatewaySettlements ?? []),
  ];
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
    ...(bothReported ? { costUsd: a!.costUsd! + b!.costUsd! } : {}),
    ...(a?.gatewaySettlements || b?.gatewaySettlements
      ? { gatewaySettlements }
      : {}),
  };
}
import {
  AiContext,
  EmbedInput,
  GenerateStructuredInput,
  GenerateTextInput,
  ModelOp,
  ModelResult,
  ModelUsage,
  ReviewVisionInput,
} from "./types";
import { MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND } from "./model-execution-envelope";
import { snapshotVisionReviewInput } from "./vision-review-input";
import {
  canonicalReportedModelIdentifier,
  hasTrustedModelIdentity,
  resolveReportedModelIdentity,
} from "./model-identity";
import { CANDIDATE_GATEWAY_VISION_TRANSPORTS } from "./model-transports";
import { boundedModelUsage } from "./model-usage-boundary";

type FrozenSettlementContext = NonNullable<
  ReturnType<SiteBuildCostReconciliationCatalog["resolveContext"]>
>;

/**
 * Routes each call across the provider chain, falling back on failure (PRD 9.5).
 * Adds the gateway-level guarantees business code relies on:
 * - every call is traced (ai_trace + usage_ledger, PRD 9.10) — fire-and-forget
 * - structured outputs are validated against the task schema, with ONE repair
 *   retry that feeds schema errors, or an explicitly opted-in task-gate error,
 *   back to the same model (PRD 9.6)
 */
@Injectable()
export class RouterModelGateway extends ModelGateway {
  private readonly unavailableBudgetStore = new UnavailableBudgetStore(
    "RouterModelGateway requires an authoritative BudgetStore",
  );
  budgetStore: BudgetStore;

  /** Worker installs the durable R4-B ledger; paid contexts fail closed without it. */
  paidLedger?: SiteBuildCostLedger;
  /**
   * Versioned product pricing/channel catalog. Absence never fabricates an
   * exact amount: output remains conservatively charged and reconciliation is
   * UNRESOLVED until trusted product configuration is installed.
   */
  costReconciliationCatalog?: SiteBuildCostReconciliationCatalog;
  /** Strict startup snapshots required by every new paid physical wire. */
  settlementDerivationKeyring?: SettlementDerivationKeyring;
  settlementReadbackResolver?: NewApiRequestBoundSettlementResolver;

  constructor(
    private readonly router: ModelRouter,
    @Optional() private readonly trace?: AiTraceSink,
    @Optional() @Inject(TOOL_BUDGET_STORE) budgetStore?: BudgetStore,
  ) {
    super();
    this.budgetStore = budgetStore ?? this.unavailableBudgetStore;
  }

  generateText(
    input: GenerateTextInput,
    ctx: AiContext,
  ): Promise<ModelResult<string>> {
    return this.run("generateText", input, ctx, async (p, runCtx) =>
      p.generateText(input, await this.withPhysicalWire(runCtx, 1)),
    );
  }

  generateStructured<T = unknown>(
    input: GenerateStructuredInput,
    ctx: AiContext,
  ): Promise<ModelResult<T>> {
    return this.run("generateStructured", input, ctx, async (p, runCtx) => {
      const validateTaskOutput = (result: ModelResult<T>): ModelResult<T> => {
        try {
          input.validateOutput?.(result.data);
          return result;
        } catch (err) {
          throw new TaskOutputValidationError(
            `task output hard gate rejected: ${err instanceof Error ? err.message : String(err)}`,
            result.usage,
            {
              cause: err,
              callCount: result.callCount ?? 1,
              provider: result.provider,
              model: result.model,
              reportedModel: result.reportedModel,
              modelResolutionSource: result.modelResolutionSource,
            },
          );
        }
      };
      const first = await p.generateStructured<T>(
        input,
        await this.withPhysicalWire(runCtx, 1),
      );
      const initialSettlementUnknown = first.usage?.gatewaySettlements?.some(
        (observation) => observation.status === "unknown",
      );
      const check = checkAgainstSchema(input.schema, first.data);
      let repairReason: string;
      let repairKind: "JSON Schema" | "任务确定性硬门";
      if (check.valid) {
        try {
          return validateTaskOutput(first);
        } catch (error) {
          if (
            !input.repairTaskOutput ||
            !(error instanceof TaskOutputValidationError)
          ) {
            throw error;
          }
          repairKind = "任务确定性硬门";
          repairReason = error.message;
        }
      } else {
        repairKind = "JSON Schema";
        repairReason = (check.errors ?? []).join("\n");
      }
      if (initialSettlementUnknown) {
        // A valid output can proceed under an upper-bound charge. An unusable
        // output must not trigger a second physical request while the first
        // call's exact settlement remains unresolved.
        throw new ProviderOutputError(
          "initial structured output is unusable and settlement is unresolved; repair suppressed",
          first.usage,
          {
            callCount: 1,
            provider: first.provider,
            model: first.model,
            reportedModel: first.reportedModel,
            modelResolutionSource: first.modelResolutionSource,
          },
        );
      }
      // 修复重试：schema 或任务硬门只共享这唯一一次调用，绝不形成开放循环。
      let repair: ModelResult<T>;
      try {
        if (runCtx.authorizeExternalAction) {
          await this.assertExternalActionAuthorized(runCtx, first.usage, {
            callCount: 1,
            provider: first.provider,
            model: first.model,
            reportedModel: first.reportedModel,
            modelResolutionSource: first.modelResolutionSource,
          });
        }
        repair = await p.generateStructured<T>(
          {
            ...input,
            prompt: `${input.prompt}\n\n上一次输出未通过${repairKind}校验，错误：\n${repairReason}\n请只修正被拒字段，不得新增、猜测或放宽任何事实；重新只输出同时通过 JSON Schema 和任务硬门的合法 JSON。`,
          },
          await this.withPhysicalWire(runCtx, 2),
        );
      } catch (err) {
        if (err instanceof ExternalActionDeniedError) throw err;
        // FIX 1：修复调用抛错也要带上首调已消耗的 token（否则网关 catch 只结算修复那次、漏首调，少记绕硬顶）。
        throw new ProviderOutputError(
          `repair call failed: ${String(err)}`,
          mergeStructuredUsage(
            first.usage,
            err instanceof ProviderOutputError ? err.usage : undefined,
          ),
          {
            cause: err,
            callCount:
              1 + (err instanceof ProviderOutputError ? err.callCount : 1),
            provider:
              err instanceof ProviderOutputError
                ? (err.provider ?? first.provider)
                : first.provider,
            model:
              err instanceof ProviderOutputError
                ? (err.model ?? first.model)
                : first.model,
            reportedModel:
              err instanceof ProviderOutputError
                ? (err.reportedModel ?? first.reportedModel)
                : first.reportedModel,
            modelResolutionSource:
              err instanceof ProviderOutputError
                ? (err.modelResolutionSource ?? first.modelResolutionSource)
                : first.modelResolutionSource,
          },
        );
      }
      const recheck = checkAgainstSchema(input.schema, repair.data);
      if (!recheck.valid) {
        // FIX 1：修复后仍不过 schema → 抛 ProviderOutputError 携首调+修复合并 usage（原为裸 Error →
        // 网关 catch 记 0¢，两次调用白烧、绕过硬预算上界）。
        throw new ProviderOutputError(
          `structured output failed schema validation after repair: ${(recheck.errors ?? []).join("; ")}`,
          mergeStructuredUsage(first.usage, repair.usage),
          {
            callCount: 2,
            provider: repair.provider,
            model: repair.model,
            reportedModel: repair.reportedModel,
            modelResolutionSource: repair.modelResolutionSource,
          },
        );
      }
      // usage 合并：重试消耗也要入账。callCount=2 → 无 usage 上报时 settle 按**两次**兜底（否则少记一次、
      // 退还预留的另一半，40¢ 上限跑一个修复过的 20¢ 任务仍剩 20¢，硬上界失效，#82 P2）。
      return validateTaskOutput({
        ...repair,
        usage: mergeStructuredUsage(first.usage, repair.usage),
        callCount: 2,
      });
    });
  }

  async reviewVision<T = unknown>(
    input: ReviewVisionInput,
    ctx: AiContext,
  ): Promise<ModelResult<T>> {
    const snapshot = snapshotVisionReviewInput(input);
    assertModelOutputSchemaCompiles(snapshot.schema);
    if (
      snapshot.images.some(
        (image) =>
          image.materialClass === "workspace_site_screenshot" &&
          image.workspaceId !== ctx.workspaceId,
      )
    ) {
      throw new Error("VISION_REVIEW_WORKSPACE_MISMATCH");
    }
    return this.run("reviewVision", snapshot, ctx, async (provider, runCtx) => {
      const result = await provider.reviewVision<T>(
        snapshot,
        await this.withPhysicalWire(runCtx, 1),
      );
      if (
        result.modelResolutionSource !== "upstream_response" ||
        !hasTrustedModelIdentity({
          requestedModel: snapshot.model,
          reportedModel: result.reportedModel,
          resolvedModel: result.model,
          transport: CANDIDATE_GATEWAY_VISION_TRANSPORTS[snapshot.model],
        })
      ) {
        throw new ProviderIdentityError(
          "VISION_REVIEW_MODEL_IDENTITY_MISMATCH",
          result.usage,
          {
            provider: result.provider,
            model: result.model,
            reportedModel: result.reportedModel,
            modelResolutionSource: result.modelResolutionSource,
          },
        );
      }
      const check = checkAgainstSchema(snapshot.schema, result.data);
      if (!check.valid) {
        throw new ProviderOutputError(
          `VISION_REVIEW_SCHEMA_INVALID: ${(check.errors ?? []).join("; ")}`,
          result.usage,
          {
            provider: result.provider,
            model: result.model,
            reportedModel: result.reportedModel,
            modelResolutionSource: result.modelResolutionSource,
          },
        );
      }
      try {
        snapshot.validateOutput?.(result.data);
      } catch (error) {
        throw new TaskOutputValidationError(
          `vision review hard gate rejected: ${error instanceof Error ? error.message : String(error)}`,
          result.usage,
          {
            cause: error,
            provider: result.provider,
            model: result.model,
            reportedModel: result.reportedModel,
            modelResolutionSource: result.modelResolutionSource,
          },
        );
      }
      return result;
    });
  }

  embed(input: EmbedInput, ctx: AiContext): Promise<ModelResult<number[][]>> {
    return this.run("embed", input, ctx, (p, runCtx) => p.embed(input, runCtx));
  }

  private async run<T>(
    op: ModelOp,
    input: {
      task: string;
      model?: string;
      maxCostCents?: number;
      maxTokens?: number;
      prompt?: string;
      system?: string;
      schema?: Record<string, unknown>;
      signal?: AbortSignal;
    },
    ctx: AiContext,
    call: (p: ModelProvider, runCtx: AiContext) => Promise<ModelResult<T>>,
  ): Promise<ModelResult<T>> {
    const chain = this.router.route(op, input.task);
    if (chain.length === 0)
      throw new Error(`no model provider for ${op}/${input.task}`);

    // 预算门（收口② D）：task.maxCostCents 从纯声明变真闸——reserve-then-settle，
    // 账户（runId ?? workspaceId）超限即抛 BudgetExceededError（调用不发生=真拦截）。
    // settle 优先级：costUsd（按实）→ token 折算（centsFromTokens）→ est 兜底。
    const registeredTask =
      input.maxCostCents === undefined
        ? (await import("../ai-tasks/task-registry")).getTask(input.task)
        : undefined;
    const baseCents =
      input.maxCostCents ??
      registeredTask?.maxCostCents ??
      DEFAULT_LLM_EST_CENTS;
    // generateStructured 可能做一次校验-修复重试（第二次模型调用，见下）——预留**两次**上限，否则账户仅够
    // 一次时修复仍会执行、settle 后把账户打成负数（#51 P2）。settle 兜底仍用单次 baseCents（无 usage 时不高估）。
    const reserveCents =
      op === "generateStructured"
        ? baseCents * MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND
        : baseCents;
    if (ctx.paidCost) {
      return this.runPersistent(op, input, ctx, chain, call, reserveCents);
    }
    const accountKey = ctx.runId ?? ctx.workspaceId;
    const operationKey = paidOperationKey([
      accountKey,
      "model-budget",
      op,
      input.task,
      input.model ?? "",
      ctx.correlationId ?? "",
      input.prompt ?? "",
      input.system ?? "",
      input.schema ? JSON.stringify(input.schema) : "",
    ]);
    let reservation;
    try {
      reservation = await this.budgetStore.reserve({
        workspaceId: ctx.workspaceId,
        accountKey,
        operationKey,
        estimatedMicrousd: centsToMicrousd(reserveCents),
      });
      if (reservation.replay) {
        const replay =
          reservation.replayResult?.resultStrategy === "typed_projection"
            ? reservation.replayResult.projection
            : undefined;
        if (
          replay &&
          replay.kind === "model" &&
          ctx.durableResultSchema &&
          replay.schema === ctx.durableResultSchema
        ) {
          try {
            const restored = restoreModelResultFromReplay(
              ctx.durableResultSchema,
              replay,
            ) as ModelResult<T>;
            const returned = reservation.receipt
              ? { ...restored, durableReceipt: reservation.receipt }
              : restored;
            if (returned.durableReceipt) {
              ctx.onDurableReceipt?.(input.task, returned.durableReceipt);
            }
            return returned;
          } catch {
            throw new BudgetOperationReplayError(operationKey);
          }
        }
        throw new BudgetOperationReplayError(operationKey);
      }
    } catch (err) {
      // 预算拒绝必须可审计（对齐 ToolBroker 的 DENIED trace）：否则截断完全不可观测。
      if (err instanceof BudgetExceededError) {
        this.trace?.record({
          workspaceId: ctx.workspaceId,
          task: input.task,
          op,
          provider: "budget-gate",
          model: input.model ?? "n/a",
          status: "ERROR",
          errorMessage: `budget exceeded (DENIED before call): ${err.message.slice(0, 300)}`,
          latencyMs: 0,
          correlationId: ctx.correlationId,
          modelPolicy: ctx.modelPolicy,
        });
      }
      throw err;
    }
    const provider = chain[0]!;
    const started = Date.now();
    let result: ModelResult<T>;
    try {
      if (ctx.authorizeExternalAction) {
        await this.assertExternalActionAuthorized(ctx);
      }
      result = await call(provider, ctx);
    } catch (err) {
      const failedUsage =
        err instanceof ProviderOutputError ? err.usage : undefined;
      if (
        err instanceof ExternalActionDeniedError &&
        err.callCount === 0 &&
        !err.usage
      ) {
        await this.budgetStore.release(reservation);
      } else {
        // Once a provider may have been called, an unusable output or unknown ACK is
        // conservatively charged to the reservation and never falls through to a
        // second physical model request.
        const observedMicrousd =
          err instanceof ProviderOutputError
            ? (providerReportedMicrousd(err.usage) ??
              centsToMicrousd(
                centsFromTokens(err.usage) ?? baseCents * err.callCount,
              ))
            : centsToMicrousd(reserveCents);
        await this.budgetStore.settle(reservation, observedMicrousd);
      }
      this.trace?.record({
        workspaceId: ctx.workspaceId,
        task: input.task,
        op,
        provider: provider.id,
        model: input.model ?? "unknown",
        status: "ERROR",
        errorMessage: err instanceof Error ? err.name : "model call failed",
        latencyMs: Date.now() - started,
        inputTokens: failedUsage?.inputTokens,
        outputTokens: failedUsage?.outputTokens,
        correlationId: ctx.correlationId,
        modelPolicy: ctx.modelPolicy,
      });
      throw err;
    }

    let projection;
    try {
      projection = ctx.durableResultSchema
        ? projectModelResultForReplay(
            ctx.durableResultSchema,
            result as ModelResult<unknown>,
          )
        : undefined;
    } catch {
      // A valid provider output exists, but it cannot be represented by the
      // approved durable contract. Keep the operation unresolved so a retry
      // cannot issue a second physical request or settle an empty result.
      throw new BudgetOperationReplayError(operationKey);
    }
    const reservedMicrousd = reservation.estimatedMicrousd;
    const reportedMicrousd = providerReportedMicrousd(result.usage);
    const tokenPricedCents =
      reportedMicrousd === null ? centsFromTokens(result.usage) : null;
    const observedMicrousd =
      reportedMicrousd ??
      centsToMicrousd(tokenPricedCents ?? baseCents * (result.callCount ?? 1));
    const chargedMicrousd =
      observedMicrousd < reservation.estimatedMicrousd
        ? observedMicrousd
        : reservation.estimatedMicrousd;
    const receiptFacts =
      projection && ctx.durableResultSchema
        ? modelExecutionReceiptFacts({
            taskId: input.task,
            resultSchema: ctx.durableResultSchema,
            result: result as ModelResult<unknown>,
            reservedMicrousd,
            chargedMicrousd,
          })
        : undefined;
    const settlement = [
      reservation,
      observedMicrousd,
      projection,
      receiptFacts,
    ] as const;
    let settled;
    try {
      settled = await this.budgetStore.settle(...settlement);
    } catch {
      // The first failure may be an ACK loss after commit. Repeating the exact
      // same operation/cost/projection is safe; PostgreSQL rejects any drift.
      settled = await this.budgetStore.settle(...settlement);
    }
    const returnedResult = settled?.receipt
      ? { ...result, durableReceipt: settled.receipt }
      : result;
    this.trace?.record({
      workspaceId: ctx.workspaceId,
      task: input.task,
      op,
      provider: result.provider,
      model: result.model,
      status: "OK",
      latencyMs: Date.now() - started,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      costUsd: result.usage?.costUsd,
      correlationId: ctx.correlationId,
      modelPolicy: ctx.modelPolicy,
    });
    if (returnedResult.durableReceipt) {
      ctx.onDurableReceipt?.(input.task, returnedResult.durableReceipt);
    }
    return returnedResult;
  }

  private pricedSettlementMicrousd(
    context: FrozenSettlementContext,
    inputTokens: number,
    outputTokens: number,
  ): number | null {
    const numerator =
      BigInt(inputTokens) *
        BigInt(context.inputPriceMicrounitsPerMillionTokens) +
      BigInt(outputTokens) *
        BigInt(context.outputPriceMicrounitsPerMillionTokens);
    const denominator = 1_000_000_000_000n;
    const cost =
      (numerator * BigInt(context.ledgerMicrousdPerPricingUnit) +
        denominator -
        1n) /
      denominator;
    return cost <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cost) : null;
  }

  private unknownPhysicalWireObservation(input: {
    identity: SettlementWireIdentity;
    reason: Extract<
      GatewaySettlementObservation,
      { status: "unknown" }
    >["reason"];
    finalPhase:
      | "gateway_unavailable"
      | "upstream_ack_unknown"
      | "payload_unavailable"
      | "gateway_log_missing"
      | "gateway_log_unavailable"
      | "gateway_log_invalid"
      | "database_ack_unknown";
    gatewayIdState: ProviderGatewayIdState;
    payloadState: ProviderPayloadState;
    readbackProbes?: Extract<
      Awaited<ReturnType<NewApiRequestBoundSettlementResolver["resolve"]>>,
      { status: "unknown" }
    >["readbackProbes"];
  }): GatewaySettlementObservation {
    return {
      status: "unknown",
      physicalWireAttempt: input.identity.physicalWireAttempt,
      resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
      reason: input.reason,
      transportObservation: createProviderTransportObservation({
        physicalWireAttempt: input.identity.physicalWireAttempt,
        finalPhase: input.finalPhase,
        gatewayIdState: input.gatewayIdState,
        upstreamIdState: "unknown",
        payloadState: input.payloadState,
        readbackProbes: input.readbackProbes ?? [],
      }),
    };
  }

  private async physicalWireRuntime(input: {
    scope: PaidOperationReservation;
    wireAttemptId: string;
    identity: SettlementWireIdentity;
    context: FrozenSettlementContext;
  }): Promise<PaidModelPhysicalWireRuntime> {
    const ledger = this.paidLedger!;
    const resolver = this.settlementReadbackResolver!;
    const runtime: PaidModelPhysicalWireRuntime = {
      identity: input.identity,
      begin: () =>
        ledger.beginModelPhysicalWire({
          workspaceId: input.scope.workspaceId,
          wireAttemptId: input.wireAttemptId,
          fenceToken: input.scope.fenceToken,
        }),
      resolve: async (transportInput) => {
        const readback = await resolver.resolve({
          requestId: input.identity.requestId,
          nonce: input.identity.nonce,
          alias: input.context.alias,
          protocol: input.context.protocol,
          expectedChannelId: input.context.expectedChannelId,
          usage: transportInput.usage,
          maxOutputTokens: input.context.maxOutputTokensPerCall,
          maximumQuotaPoints: input.context.gatewayCredentialQuotaCapPoints,
          maximumProbeCount: 1,
          probeAuthority: {
            claim: (sequence) =>
              ledger.claimModelReadbackProbe({
                workspaceId: input.scope.workspaceId,
                wireAttemptId: input.wireAttemptId,
                sequence,
              }),
            record: ({ probeId, probe, observedAt }) =>
              ledger.recordModelReadbackProbe({
                workspaceId: input.scope.workspaceId,
                probeId,
                probe,
                observedAt,
              }),
          },
        });

        let observation: GatewaySettlementObservation;
        if (
          readback.status === "settled" &&
          transportInput.payloadState === "available" &&
          !transportInput.upstreamAckUnknown
        ) {
          const costMicrousd = this.pricedSettlementMicrousd(
            input.context,
            readback.inputTokens,
            readback.outputTokens,
          );
          observation =
            costMicrousd === null
              ? this.unknownPhysicalWireObservation({
                  identity: input.identity,
                  reason: "log_invalid",
                  finalPhase: "gateway_log_invalid",
                  gatewayIdState: transportInput.gatewayIdState,
                  payloadState: transportInput.payloadState,
                  readbackProbes: readback.readbackProbes,
                })
              : {
                  status: "settled",
                  physicalWireAttempt: input.identity.physicalWireAttempt,
                  resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
                  alias: input.context.alias,
                  protocol: input.context.protocol,
                  channelId: readback.channelId,
                  basis: "openox_catalog_token_pricing",
                  quota: readback.quota,
                  costMicrousd,
                  inputTokens: readback.inputTokens,
                  outputTokens: readback.outputTokens,
                  upstreamIdState: readback.upstreamIdState,
                  transportObservation: createProviderTransportObservation({
                    physicalWireAttempt: input.identity.physicalWireAttempt,
                    finalPhase: "gateway_request_id_observed",
                    gatewayIdState: transportInput.gatewayIdState,
                    upstreamIdState: readback.upstreamIdState,
                    payloadState: "available",
                    readbackProbes: readback.readbackProbes,
                  }),
                };
        } else {
          const payloadUnavailable =
            transportInput.payloadState !== "available";
          const finalPhase = payloadUnavailable
            ? "payload_unavailable"
            : transportInput.upstreamAckUnknown
              ? "upstream_ack_unknown"
              : readback.status === "unknown" &&
                  readback.reason === "gateway_log_missing"
                ? "gateway_log_missing"
                : readback.status === "unknown" &&
                    readback.reason === "gateway_log_unavailable"
                  ? "gateway_log_unavailable"
                  : "gateway_log_invalid";
          const reason = payloadUnavailable
            ? "payload_unavailable"
            : transportInput.upstreamAckUnknown
              ? "upstream_ack_unknown"
              : readback.status === "unknown"
                ? readback.reason === "request_id_missing" ||
                  readback.reason === "nonce_missing"
                  ? "gateway_unavailable"
                  : readback.reason
                : "payload_unavailable";
          observation = this.unknownPhysicalWireObservation({
            identity: input.identity,
            reason,
            finalPhase,
            gatewayIdState: transportInput.gatewayIdState,
            payloadState: transportInput.payloadState,
            readbackProbes: readback.readbackProbes,
          });
        }

        const observedAt = new Date();
        try {
          if (
            observation.status === "settled" &&
            readback.status === "settled"
          ) {
            await ledger.recordModelPhysicalWireReceipt({
              workspaceId: input.scope.workspaceId,
              wireAttemptId: input.wireAttemptId,
              observation,
              receiptDigest: readback.receiptDigest,
              observedAt,
            });
          }
          await ledger.finalizeModelPhysicalWire({
            workspaceId: input.scope.workspaceId,
            wireAttemptId: input.wireAttemptId,
            observation,
            observedAt,
          });
          return observation;
        } catch {
          return this.unknownPhysicalWireObservation({
            identity: input.identity,
            reason: "database_ack_unknown",
            finalPhase: "database_ack_unknown",
            gatewayIdState: transportInput.gatewayIdState,
            payloadState: transportInput.payloadState,
            readbackProbes: readback.readbackProbes,
          });
        }
      },
    };
    return Object.freeze(runtime);
  }

  private async withPhysicalWire(
    ctx: AiContext,
    attempt: 1 | 2,
  ): Promise<AiContext> {
    if (!ctx.paidCost) return ctx;
    const runtime =
      attempt === 1
        ? ctx.paidCost.settlementPhysicalWire
        : await ctx.paidCost.allocateSettlementRepairWire?.();
    if (!runtime || runtime.identity.physicalWireAttempt !== attempt) {
      throw new PaidCallDeniedError("MODEL_WIRE_RUNTIME_UNAVAILABLE");
    }
    return {
      ...ctx,
      paidCost: {
        ...ctx.paidCost,
        settlementPhysicalWire: runtime,
      },
    };
  }

  private async runPersistent<T>(
    op: ModelOp,
    input: {
      task: string;
      model?: string;
      maxCostCents?: number;
      maxTokens?: number;
      prompt?: string;
      system?: string;
      schema?: Record<string, unknown>;
      signal?: AbortSignal;
    },
    ctx: AiContext,
    chain: readonly ModelProvider[],
    call: (
      provider: ModelProvider,
      runCtx: AiContext,
    ) => Promise<ModelResult<T>>,
    reserveCents: number,
  ): Promise<ModelResult<T>> {
    const paid = ctx.paidCost!;
    if (
      !this.paidLedger ||
      !ctx.runId ||
      !this.costReconciliationCatalog ||
      !this.settlementDerivationKeyring ||
      !this.settlementReadbackResolver
    ) {
      throw new PaidCallDeniedError("PERSISTENT_LEDGER_UNAVAILABLE");
    }
    for (const [providerIndex, provider] of chain.entries()) {
      const requestedModel = input.model ?? "provider-default";
      const settlementContext =
        this.costReconciliationCatalog?.resolveContext({
          providerId: provider.id,
          taskId: input.task,
          alias: requestedModel,
          maxOutputTokens: input.maxTokens,
        }) ?? null;
      if (!settlementContext || !input.maxTokens) {
        throw new PaidCallDeniedError(
          "COST_RECONCILIATION_CONTEXT_UNAVAILABLE",
        );
      }
      const operationKey = paidOperationKey([
        ctx.runId,
        paid.scopeKey,
        op,
        provider.id,
        String(providerIndex),
        requestedModel,
      ]);
      const maximumWireCalls =
        op === "generateStructured"
          ? (MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND as 2)
          : (1 as const);
      const firstIdentity = settlementWireIdentities(
        this.settlementDerivationKeyring,
        operationKey,
        1,
      )[0]!;
      const promptUtf8Bytes = Buffer.byteLength(
        `${input.system ?? ""}\0${input.prompt ?? ""}\0${
          input.schema ? JSON.stringify(input.schema) : ""
        }`,
        "utf8",
      );
      const scope: PaidOperationReservation = {
        workspaceId: ctx.workspaceId,
        siteId: paid.siteId,
        buildRunId: ctx.runId,
        taskAttemptId: paid.taskAttemptId,
        fenceToken: paid.fenceToken,
        operationKey,
        kind: "model",
        taskId: input.task,
        subject: `${requestedModel}@${provider.id}`,
        reservationMicrousd: reserveCents * 10_000,
        meta: {
          op,
          provider: provider.id,
          requestedModel,
          ...(ctx.modelPolicy ? { modelPolicy: ctx.modelPolicy } : {}),
        },
      };
      let decision;
      try {
        decision = await this.paidLedger.reserveModelOperation({
          ...scope,
          kind: "model",
          wire: {
            wireIdentity: firstIdentity,
            protocol: settlementContext.protocol,
            requestedAlias: settlementContext.alias,
            expectedChannelId: settlementContext.expectedChannelId,
            promptUtf8Bytes,
            maximumWireCalls,
            actualMaxOutputTokens: input.maxTokens,
            catalogMaxOutputTokens: settlementContext.maxOutputTokensPerCall,
            maximumQuotaPoints:
              settlementContext.gatewayCredentialQuotaCapPoints,
            catalogId: settlementContext.catalogId,
            catalogSha256: settlementContext.catalogSha256,
            pricingSnapshotSha256: settlementContext.pricingSnapshotSha256,
            inputPriceMicrounitsPerMillionTokens:
              settlementContext.inputPriceMicrounitsPerMillionTokens,
            outputPriceMicrounitsPerMillionTokens:
              settlementContext.outputPriceMicrounitsPerMillionTokens,
            ledgerMicrousdPerPricingUnit:
              settlementContext.ledgerMicrousdPerPricingUnit,
          },
        });
      } catch (error) {
        if (error instanceof PaidCallDeniedError) {
          this.trace?.record({
            workspaceId: ctx.workspaceId,
            task: input.task,
            op,
            provider: "budget-gate",
            model: requestedModel,
            status: "ERROR",
            errorMessage: `paid call denied before execution: ${error.decision}`,
            latencyMs: 0,
            correlationId: ctx.correlationId,
            modelPolicy: ctx.modelPolicy,
          });
        }
        throw error;
      }
      if (decision.kind === "replay") {
        if (
          decision.status === "SUCCEEDED" &&
          decision.result &&
          Object.prototype.hasOwnProperty.call(decision.result, "data")
        ) {
          return decision.result as unknown as ModelResult<T>;
        }
        if (decision.status === "SUCCEEDED") {
          throw new PaidOperationUnknownError(
            scope.operationKey,
            "DURABLE_REPLAY_UNAVAILABLE",
          );
        }
        throw new PaidOperationUnknownError(
          scope.operationKey,
          decision.errorCode ?? `RECORDED_${decision.status}`,
        );
      }

      const started = Date.now();
      let result: ModelResult<T>;
      const firstRuntime = await this.physicalWireRuntime({
        scope,
        wireAttemptId: decision.wireAttemptId,
        identity: firstIdentity,
        context: settlementContext,
      });
      const executionCtx: AiContext = {
        ...ctx,
        paidCost: {
          ...paid,
          settlementPhysicalWire: firstRuntime,
          allocateSettlementRepairWire: async () => {
            const secondIdentity = settlementWireIdentities(
              this.settlementDerivationKeyring!,
              operationKey,
              2,
            )[1]!;
            const allocated = await this.paidLedger!.allocateModelPhysicalWire({
              scope,
              spendId: decision.spendId,
              wireIdentity: secondIdentity,
            });
            return this.physicalWireRuntime({
              scope,
              wireAttemptId: allocated.wireAttemptId,
              identity: secondIdentity,
              context: settlementContext,
            });
          },
        },
      };
      try {
        if (executionCtx.authorizeExternalAction) {
          await this.assertExternalActionAuthorized(executionCtx);
        }
        result = await call(provider, executionCtx);
        result = result.usage
          ? { ...result, usage: boundedModelUsage(result.usage) }
          : result;
        const safeReportedModel = canonicalReportedModelIdentifier(
          result.reportedModel,
        );
        const trustedReportedModel = safeReportedModel
          ? resolveReportedModelIdentity(
              requestedModel,
              safeReportedModel,
              settlementContext.protocol,
            )
          : undefined;
        if (
          result.provider !== provider.id ||
          result.model !== requestedModel ||
          (result.reportedModel !== undefined &&
            trustedReportedModel !== requestedModel) ||
          (result.modelResolutionSource === "upstream_response" &&
            trustedReportedModel !== requestedModel)
        ) {
          throw new ProviderIdentityError(
            "MODEL_IDENTITY_MISMATCH",
            result.usage,
            {
              provider: provider.id,
              model: requestedModel,
              ...(trustedReportedModel === requestedModel && safeReportedModel
                ? { reportedModel: safeReportedModel }
                : {}),
              modelResolutionSource: "requested_fallback",
            },
          );
        }
      } catch (error) {
        if (error instanceof ProviderWireInFlightError) {
          this.trace?.record({
            workspaceId: ctx.workspaceId,
            task: input.task,
            op,
            provider: provider.id,
            model: requestedModel,
            status: "ERROR",
            errorMessage: error.errorCode,
            latencyMs: Date.now() - started,
            correlationId: ctx.correlationId,
            modelPolicy: ctx.modelPolicy,
          });
          throw new PaidOperationUnknownError(
            scope.operationKey,
            error.errorCode,
          );
        }
        const providerError =
          error instanceof ProviderOutputError ? error : null;
        if (providerError?.callCount === 0 && !providerError.usage) {
          await this.paidLedger.finalizeModelPhysicalWireNotDispatched({
            workspaceId: scope.workspaceId,
            wireAttemptId: decision.wireAttemptId,
          });
          const suppressionDenied = error instanceof ExternalActionDeniedError;
          await this.settlePersistentOperation({
            scope,
            status: "RELEASED",
            measurement: this.notIncurredModelMeasurement(
              suppressionDenied
                ? "suppression_action_gate"
                : "provider_pre_dispatch_unavailable",
            ),
            meta: {
              provider: provider.id,
              requestedModel,
            },
            errorCode: suppressionDenied
              ? "SUPPRESSION_ACTION_GATE"
              : error instanceof ProviderSettlementError
                ? error.errorCode
                : "PROVIDER_PRE_DISPATCH_UNAVAILABLE",
          });
          this.trace?.record({
            workspaceId: ctx.workspaceId,
            task: input.task,
            op,
            provider: provider.id,
            model: requestedModel,
            status: "ERROR",
            errorMessage: this.safeProviderErrorCode(error),
            latencyMs: Date.now() - started,
            correlationId: ctx.correlationId,
            modelPolicy: ctx.modelPolicy,
          });
          throw error;
        }
        const providerSettlementUnknown =
          providerError?.usage?.gatewaySettlements?.some(
            (observation) => observation.status === "unknown",
          );
        const lastUnknownSettlement = providerError?.usage?.gatewaySettlements
          ?.filter((observation) => observation.status === "unknown")
          .at(-1);
        const unknownSettlementErrorCode = lastUnknownSettlement
          ? modelSettlementErrorCode(
              lastUnknownSettlement.transportObservation,
              lastUnknownSettlement.reason,
            )
          : "MODEL_SETTLEMENT_GATEWAY_UNAVAILABLE";
        const measurement = providerSettlementUnknown
          ? this.unknownModelMeasurement(
              scope.reservationMicrousd,
              providerError!.usage,
              providerError!.callCount,
            )
          : providerError?.usage
            ? modelCostMeasurement({
                taskId: input.task,
                requestedModel,
                resolvedModel: providerError.model,
                usage: providerError.usage,
                callCount: providerError.callCount,
                reservationMicrousd: scope.reservationMicrousd,
              })
            : this.unknownModelMeasurement(
                scope.reservationMicrousd,
                undefined,
                providerError?.callCount,
              );
        const safeReportedModel = canonicalReportedModelIdentifier(
          providerError?.reportedModel,
        );
        const trustedReportedModel =
          safeReportedModel &&
          resolveReportedModelIdentity(
            requestedModel,
            safeReportedModel,
            settlementContext.protocol,
          ) === requestedModel
            ? safeReportedModel
            : undefined;
        const trustedResolvedModel =
          providerError?.model === requestedModel ? requestedModel : undefined;
        await this.settlePersistentOperation({
          scope,
          status: measurement.basis === "unknown" ? "UNKNOWN" : "FAILED",
          measurement,
          meta: {
            provider: provider.id,
            requestedModel,
            ...(trustedResolvedModel
              ? { resolvedModel: trustedResolvedModel }
              : {}),
            ...(trustedReportedModel
              ? { reportedModel: trustedReportedModel }
              : {}),
            ...(trustedResolvedModel && providerError?.modelResolutionSource
              ? {
                  modelResolutionSource: providerError.modelResolutionSource,
                }
              : {}),
          },
          errorCode:
            error instanceof ExternalActionDeniedError
              ? "SUPPRESSION_ACTION_GATE"
              : error instanceof ProviderSettlementError
                ? error.errorCode
                : measurement.basis === "unknown"
                  ? unknownSettlementErrorCode
                  : providerError
                    ? "PROVIDER_OUTPUT_ERROR"
                    : "PROVIDER_CALL_ERROR",
        });
        this.trace?.record({
          workspaceId: ctx.workspaceId,
          task: input.task,
          op,
          provider: provider.id,
          model: requestedModel,
          status: "ERROR",
          errorMessage: this.safeProviderErrorCode(error),
          latencyMs: Date.now() - started,
          inputTokens: providerError?.usage?.inputTokens,
          outputTokens: providerError?.usage?.outputTokens,
          correlationId: ctx.correlationId,
          modelPolicy: ctx.modelPolicy,
        });
        throw error;
      }

      // Keep provider execution and success settlement in separate failure
      // domains: a database ACK failure must never be rewritten as a provider
      // failure (which would double-settle or trigger a second paid call).
      const measurement = modelCostMeasurement({
        taskId: input.task,
        requestedModel,
        resolvedModel: result.model,
        usage: result.usage,
        callCount: result.callCount,
        reservationMicrousd: scope.reservationMicrousd,
      });
      let durableResult: Record<string, unknown> | undefined;
      try {
        durableResult = paid.durableReplayResult?.(
          result as unknown as Record<string, unknown>,
        );
      } catch (error) {
        await this.settlePersistentOperation({
          scope,
          status: "FAILED",
          measurement,
          meta: {
            provider: result.provider,
            requestedModel,
            resolvedModel: result.model,
            ...(result.reportedModel
              ? { reportedModel: result.reportedModel }
              : {}),
            ...(result.modelResolutionSource
              ? { modelResolutionSource: result.modelResolutionSource }
              : {}),
          },
          errorCode: "DURABLE_REPLAY_REJECTED",
        });
        throw error;
      }
      await this.settlePersistentOperation({
        scope,
        status: "SUCCEEDED",
        measurement,
        result: durableResult,
        meta: {
          provider: result.provider,
          requestedModel,
          resolvedModel: result.model,
          ...(result.reportedModel
            ? { reportedModel: result.reportedModel }
            : {}),
          ...(result.modelResolutionSource
            ? { modelResolutionSource: result.modelResolutionSource }
            : {}),
        },
      });
      this.trace?.record({
        workspaceId: ctx.workspaceId,
        task: input.task,
        op,
        provider: result.provider,
        model: result.model,
        status: "OK",
        latencyMs: Date.now() - started,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        costUsd: result.usage?.costUsd,
        correlationId: ctx.correlationId,
        modelPolicy: ctx.modelPolicy,
      });
      return result;
    }
    throw new Error(`all paid providers failed for ${input.task}`);
  }

  private async assertExternalActionAuthorized(
    ctx: AiContext,
    usage?: ModelUsage,
    provenance?: {
      callCount?: number;
      provider?: string;
      model?: string;
      reportedModel?: string;
      modelResolutionSource?: ModelResult<unknown>["modelResolutionSource"];
    },
  ): Promise<void> {
    // Stable acquisition compliance decision: suppression_action_gate.
    if (!ctx.authorizeExternalAction) return;
    try {
      if ((await ctx.authorizeExternalAction()) === true) return;
    } catch (cause) {
      throw new ExternalActionDeniedError(usage, { ...provenance, cause });
    }
    throw new ExternalActionDeniedError(usage, provenance);
  }

  private notIncurredModelMeasurement(reason: string): PaidCostMeasurement {
    return {
      basis: "not_incurred",
      budgetChargeMicrousd: 0,
      reportedCostMicrousd: null,
      calculatedCostMicrousd: null,
      estimatedCostMicrousd: null,
      inputTokens: null,
      outputTokens: null,
      callCount: 0,
      meta: { reason },
    };
  }

  private safeProviderErrorCode(error: unknown): string {
    if (error instanceof ProviderSettlementError) return error.errorCode;
    if (error instanceof ProviderWireInFlightError) return error.errorCode;
    if (error instanceof ExternalActionDeniedError) {
      return "SUPPRESSION_ACTION_GATE";
    }
    if (error instanceof ProviderIdentityError)
      return "MODEL_IDENTITY_MISMATCH";
    if (error instanceof ProviderOutputError) return "PROVIDER_OUTPUT_ERROR";
    return "PROVIDER_CALL_ERROR";
  }

  private unknownModelMeasurement(
    reservationMicrousd: number,
    usage?: ModelUsage,
    callCount = 1,
  ): PaidCostMeasurement {
    return {
      basis: "unknown",
      budgetChargeMicrousd: reservationMicrousd,
      reportedCostMicrousd: null,
      calculatedCostMicrousd: null,
      estimatedCostMicrousd: null,
      inputTokens:
        Number.isSafeInteger(usage?.inputTokens) &&
        usage!.inputTokens! >= 0 &&
        usage!.inputTokens! <= SITE_BUILD_DURABLE_TOKEN_MAXIMUM
          ? usage!.inputTokens!
          : null,
      outputTokens:
        Number.isSafeInteger(usage?.outputTokens) &&
        usage!.outputTokens! >= 0 &&
        usage!.outputTokens! <= SITE_BUILD_DURABLE_TOKEN_MAXIMUM
          ? usage!.outputTokens!
          : null,
      callCount: Math.max(1, Math.floor(callCount)),
      meta: {
        reason: "model_output_or_ack_unavailable",
        // 这里只保留闭合 resolver/transport/probe 状态；可恢复 request identity
        // 只存在于专用 provider-wire authority 表，绝不进入 Spend meta 或再次 dispatch。
        ...(usage?.gatewaySettlements?.length
          ? { gatewaySettlements: [...usage.gatewaySettlements] }
          : {}),
      },
    };
  }

  private async settlePersistentOperation(
    input: Parameters<SiteBuildCostLedger["settleOperation"]>[0],
  ): Promise<void> {
    const disablePaidCallsReason =
      input.measurement.basis === "unknown"
        ? (input.errorCode ?? "MODEL_SETTLEMENT_GATEWAY_UNAVAILABLE")
        : undefined;
    const settle = () =>
      this.paidLedger!.settleOperation({
        ...input,
        ...(disablePaidCallsReason ? { disablePaidCallsReason } : {}),
      });
    let decision: string;
    try {
      decision = await settle();
    } catch {
      try {
        // The operation key and every settlement byte are unchanged. A second
        // database-only call recovers commit-before-ACK without another model
        // wire; the SQL function returns REPLAY for the identical terminal row.
        decision = await settle();
      } catch (error) {
        return this.freezeUnknownSettlement(
          input.scope,
          error instanceof PaidOperationUnknownError
            ? error.errorCode
            : "MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN",
        );
      }
    }
    // Exact provider cost may exceed the admitted reservation while the
    // physical call and durable output are fully known. The database records
    // CAP_VARIANCE and disables further paid calls, but this is not an ACK
    // ambiguity and must not discard the valid output.
    if (
      decision === "OVER_RESERVATION" ||
      decision === "SETTLED" ||
      decision === "REPLAY"
    ) {
      if (disablePaidCallsReason) {
        throw new PaidOperationUnknownError(
          input.scope.operationKey,
          disablePaidCallsReason,
        );
      }
      return;
    }
    return this.freezeUnknownSettlement(input.scope, `SETTLEMENT_${decision}`);
  }

  private async freezeUnknownSettlement(
    scope: PaidOperationReservation,
    errorCode: string,
  ): Promise<never> {
    try {
      await this.paidLedger!.disablePaidCalls(
        scope.workspaceId,
        scope.buildRunId,
        errorCode,
      );
    } catch {
      throw new PaidOperationUnknownError(
        scope.operationKey,
        "UNKNOWN_FREEZE_ACK_UNKNOWN",
      );
    }
    throw new PaidOperationUnknownError(scope.operationKey, errorCode);
  }
}
