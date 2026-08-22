import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModelGateway } from './model-gateway';
import { ModelRouter } from './model-router';
import { ModelProvider } from './model-provider';
import { AiTraceSink } from './ai-trace.sink';
import {
  assertModelOutputSchemaCompiles,
  checkAgainstSchema } from './schema-validate';
import { BudgetLedger, BudgetExceededError, DEFAULT_LLM_EST_CENTS } from '../tools/budget';
import {
  BudgetOperationReplayError,
  InMemoryBudgetStoreAdapter,
  TOOL_BUDGET_STORE,
  UnavailableBudgetStore,
  type BudgetStore,
} from '../tools/budget-store';
import {
  projectModelResultForReplay,
  restoreModelResultFromReplay,
} from '../durable-results/model-result-replay';
import {
  ExternalActionDeniedError,
  ProviderIdentityError,
  ProviderOutputError,
  TaskOutputValidationError,
} from './providers/provider-output-error';
import {
  modelCostMeasurement,
  paidOperationKey,
  PaidCallDeniedError,
  PaidOperationUnknownError,
  type PaidCostMeasurement,
  type PaidOperationReservation,
  type SiteBuildCostLedger,
} from '../site-builder/site-build-cost-ledger';
import type { SiteBuildCostReconciliationCatalog } from '../site-builder/site-build-cost-reconciliation-resolver';

/**
 * provider 不上报 costUsd 时按 token 折算实际成本（复审 HIGH 修复）：否则 settle 恒按
 * 声明上限（15-20¢/次 vs 真实 ~0.05-0.5¢）记账，$20 run 预算实为 ~100 次调用的硬顶，
 * 规模 run 中后段 fit 判定被静默截断。保守混合价 env 可调（LLM_CENTS_PER_MTOK，默认
 * 100¢/M tok ≈ $1/M——对 flash 档仍高估数倍，作预算上界足够诚实）。
 */
function centsFromTokens(usage?: {
  inputTokens?: number;
  outputTokens?: number }): number | null {
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  if (tokens <= 0) return null;
  const env = Number(process.env.LLM_CENTS_PER_MTOK);
  const perMtok = Number.isFinite(env) && env > 0 ? env : 100;
  return Math.max(1, Math.ceil((tokens * perMtok) / 1_000_000));
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
    ...(b?.gatewaySettlements ?? [])];
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
} from './types';
import { snapshotVisionReviewInput } from './vision-review-input';
import { hasTrustedModelIdentity } from './model-identity';
import { CANDIDATE_GATEWAY_VISION_TRANSPORTS } from './model-transports';

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
    'RouterModelGateway requires an authoritative BudgetStore',
  );
  budgetStore: BudgetStore;

  /** Test-only compatibility surface: product composition injects BudgetStore. */
  set budget(ledger: BudgetLedger) {
    this.budgetStore = new InMemoryBudgetStoreAdapter(ledger);
  }
  /** Worker installs the durable R4-B ledger; paid contexts fail closed without it. */
  paidLedger?: SiteBuildCostLedger;
  /**
   * Versioned product pricing/channel catalog. Absence never fabricates an
   * exact amount: output remains conservatively charged and reconciliation is
   * UNRESOLVED until trusted product configuration is installed.
   */
  costReconciliationCatalog?: SiteBuildCostReconciliationCatalog;

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
    ctx: AiContext): Promise<ModelResult<string>> {
    return this.run('generateText', input, ctx, (p, runCtx) =>
      p.generateText(input, runCtx));
  }

  generateStructured<T = unknown>(
    input: GenerateStructuredInput,
    ctx: AiContext): Promise<ModelResult<T>> {
    return this.run('generateStructured', input, ctx, async (p, runCtx) => {
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
      const first = await p.generateStructured<T>(input, runCtx);
      const initialSettlementUnknown = first.usage?.gatewaySettlements?.some(
        (observation) => observation.status === 'unknown',
      );
      const check = checkAgainstSchema(input.schema, first.data);
      let repairReason: string;
      let repairKind: 'JSON Schema' | '任务确定性硬门';
      if (check.valid) {
        try {
          return validateTaskOutput(first);
        } catch (error) {
          if (!input.repairTaskOutput || !(error instanceof TaskOutputValidationError)) {
            throw error;
          }
          repairKind = '任务确定性硬门';
          repairReason = error.message;
        }
      } else {
        repairKind = 'JSON Schema';
        repairReason = (check.errors ?? []).join('\n');
      }
      if (initialSettlementUnknown) {
        // A valid output can proceed under an upper-bound charge. An unusable
        // output must not trigger a second physical request while the first
        // call's exact settlement remains unresolved.
        throw new ProviderOutputError(
          'initial structured output is unusable and settlement is unresolved; repair suppressed',
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
          runCtx,
        );
      } catch (err) {
        if (err instanceof ExternalActionDeniedError) throw err;
        // FIX 1：修复调用抛错也要带上首调已消耗的 token（否则网关 catch 只结算修复那次、漏首调，少记绕硬顶）。
        throw new ProviderOutputError(
          `repair call failed: ${String(err)}`,
          mergeStructuredUsage(first.usage, err instanceof ProviderOutputError ? err.usage : undefined),
          {
            cause: err,
            callCount: 1 + (err instanceof ProviderOutputError ? err.callCount : 1),
            provider: err instanceof ProviderOutputError ? (err.provider ?? first.provider) : first.provider,
            model: err instanceof ProviderOutputError ? (err.model ?? first.model) : first.model,
            reportedModel:
              err instanceof ProviderOutputError ? (err.reportedModel ?? first.reportedModel) : first.reportedModel,
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
          `structured output failed schema validation after repair: ${(recheck.errors ?? []).join('; ')}`,
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

  async reviewVision<T = unknown>(input: ReviewVisionInput, ctx: AiContext): Promise<ModelResult<T>> {
    const snapshot = snapshotVisionReviewInput(input);
    assertModelOutputSchemaCompiles(snapshot.schema);
    if (
      snapshot.images.some(
        (image) => image.materialClass === 'workspace_site_screenshot' && image.workspaceId !== ctx.workspaceId,
      )
    ) {
      throw new Error('VISION_REVIEW_WORKSPACE_MISMATCH');
    }
    return this.run('reviewVision', snapshot, ctx, async (provider, runCtx) => {
      const result = await provider.reviewVision<T>(snapshot, runCtx);
      if (
        result.modelResolutionSource !== 'upstream_response' ||
        !hasTrustedModelIdentity({
          requestedModel: snapshot.model,
          reportedModel: result.reportedModel,
          resolvedModel: result.model,
          transport: CANDIDATE_GATEWAY_VISION_TRANSPORTS[snapshot.model],
        })
      ) {
        throw new ProviderIdentityError(
          `VISION_REVIEW_MODEL_IDENTITY_MISMATCH: requested=${snapshot.model}, reported=${result.reportedModel ?? 'missing'}, resolved=${result.model}`,
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
          `VISION_REVIEW_SCHEMA_INVALID: ${(check.errors ?? []).join('; ')}`,
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
    return this.run('embed', input, ctx, (p, runCtx) => p.embed(input, runCtx));
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
    if (chain.length === 0) throw new Error(`no model provider for ${op}/${input.task}`);

    // 预算门（收口② D）：task.maxCostCents 从纯声明变真闸——reserve-then-settle，
    // 账户（runId ?? workspaceId）超限即抛 BudgetExceededError（调用不发生=真拦截）。
    // settle 优先级：costUsd（按实）→ token 折算（centsFromTokens）→ est 兜底。
    const registeredTask =
      input.maxCostCents === undefined ? (await import('../ai-tasks/task-registry')).getTask(input.task) : undefined;
    const baseCents = input.maxCostCents ?? registeredTask?.maxCostCents ?? DEFAULT_LLM_EST_CENTS;
    // generateStructured 可能做一次校验-修复重试（第二次模型调用，见下）——预留**两次**上限，否则账户仅够
    // 一次时修复仍会执行、settle 后把账户打成负数（#51 P2）。settle 兜底仍用单次 baseCents（无 usage 时不高估）。
    const reserveCents = op === 'generateStructured' ? baseCents * 2 : baseCents;
    if (ctx.paidCost) {
      return this.runPersistent(op, input, ctx, chain, call, reserveCents);
    }
    const accountKey = ctx.runId ?? ctx.workspaceId;
    const operationKey = paidOperationKey([
      accountKey,
      'model-budget',
      op,
      input.task,
      input.model ?? '',
      ctx.correlationId ?? '',
      input.prompt ?? '',
      input.system ?? '',
      input.schema ? JSON.stringify(input.schema) : '',
    ]);
    let reservation;
    try {
      reservation = await this.budgetStore.reserve({
        workspaceId: ctx.workspaceId,
        accountKey,
        operationKey,
        estimatedCents: reserveCents,
      });
      if (reservation.replay) {
        const replay = reservation.replayProjection;
        if (
          replay &&
          replay.kind === 'model' &&
          ctx.durableResultSchema &&
          replay.schema === ctx.durableResultSchema
        ) {
          try {
            return restoreModelResultFromReplay(
              ctx.durableResultSchema,
              replay,
            ) as ModelResult<T>;
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
          provider: 'budget-gate',
          model: input.model ?? 'n/a',
          status: 'ERROR',
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
      const failedUsage = err instanceof ProviderOutputError ? err.usage : undefined;
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
        const observedCents =
          err instanceof ProviderOutputError
            ? (centsFromTokens(err.usage) ?? baseCents * err.callCount)
            : reserveCents;
        await this.budgetStore.settle(reservation, observedCents);
      }
      this.trace?.record({
        workspaceId: ctx.workspaceId,
        task: input.task,
        op,
        provider: provider.id,
        model: input.model ?? 'unknown',
        status: 'ERROR',
        errorMessage: err instanceof Error ? err.name : 'model call failed',
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
    const costUsd = result.usage?.costUsd;
    const observedCents = costUsd != null
      ? Math.ceil(costUsd * 100)
      : (centsFromTokens(result.usage) ?? baseCents * (result.callCount ?? 1));
    const settlement = [reservation, observedCents, projection] as const;
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
      status: 'OK',
      latencyMs: Date.now() - started,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      costUsd: result.usage?.costUsd,
      correlationId: ctx.correlationId,
      modelPolicy: ctx.modelPolicy,
    });
    return returnedResult;
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
    call: (provider: ModelProvider, runCtx: AiContext) => Promise<ModelResult<T>>,
    reserveCents: number,
  ): Promise<ModelResult<T>> {
    const paid = ctx.paidCost!;
    if (!this.paidLedger || !ctx.runId) {
      throw new PaidCallDeniedError('PERSISTENT_LEDGER_UNAVAILABLE');
    }
    for (const [providerIndex, provider] of chain.entries()) {
      const requestedModel = input.model ?? 'provider-default';
      const settlementContext =
        this.costReconciliationCatalog?.resolveContext({
          providerId: provider.id,
          taskId: input.task,
          alias: requestedModel,
          maxOutputTokens: input.maxTokens,
        }) ?? null;
      if (this.costReconciliationCatalog && !settlementContext) {
        throw new PaidCallDeniedError(
          'COST_RECONCILIATION_CONTEXT_UNAVAILABLE',
        );
      }
      const scope: PaidOperationReservation = {
        workspaceId: ctx.workspaceId,
        siteId: paid.siteId,
        buildRunId: ctx.runId,
        taskAttemptId: paid.taskAttemptId,
        fenceToken: paid.fenceToken,
        operationKey: paidOperationKey([
          ctx.runId,
          paid.scopeKey,
          op,
          provider.id,
          String(providerIndex),
          requestedModel,
        ]),
        kind: 'model',
        taskId: input.task,
        subject: `${requestedModel}@${provider.id}`,
        reservationMicrousd: reserveCents * 10_000,
        meta: {
          op,
          provider: provider.id,
          requestedModel,
          ...(settlementContext ? { settlementContext } : {}),
          ...(ctx.modelPolicy ? { modelPolicy: ctx.modelPolicy } : {}),
        },
      };
      let decision;
      try {
        decision = await this.paidLedger.reserveOperation(scope);
      } catch (error) {
        if (error instanceof PaidCallDeniedError) {
          this.trace?.record({
            workspaceId: ctx.workspaceId,
            task: input.task,
            op,
            provider: 'budget-gate',
            model: requestedModel,
            status: 'ERROR',
            errorMessage: `paid call denied before execution: ${error.decision}`,
            latencyMs: 0,
            correlationId: ctx.correlationId,
            modelPolicy: ctx.modelPolicy,
          });
        }
        throw error;
      }
      if (decision.kind === 'replay') {
        if (
          decision.status === 'SUCCEEDED' &&
          decision.result &&
          Object.prototype.hasOwnProperty.call(decision.result, 'data')
        ) {
          return decision.result as unknown as ModelResult<T>;
        }
        if (decision.status === 'SUCCEEDED') {
          throw new PaidOperationUnknownError(scope.operationKey, 'DURABLE_REPLAY_UNAVAILABLE');
        }
        throw new PaidOperationUnknownError(
          scope.operationKey,
          decision.errorCode ?? `RECORDED_${decision.status}`,
        );
      }

      const started = Date.now();
      let result: ModelResult<T>;
      const executionCtx: AiContext = ctx;
      try {
        if (executionCtx.authorizeExternalAction) {
          await this.assertExternalActionAuthorized(executionCtx);
        }
        result = await call(provider, executionCtx);
      } catch (error) {
        const providerError = error instanceof ProviderOutputError ? error : null;
        if (error instanceof ExternalActionDeniedError && error.callCount === 0 && !error.usage) {
          await this.settlePersistentOperation({
            scope,
            status: 'RELEASED',
            measurement: this.notIncurredModelMeasurement('suppression_action_gate'),
            meta: {
              provider: provider.id,
              requestedModel,
            },
            errorCode: 'SUPPRESSION_ACTION_GATE',
          });
          this.trace?.record({
            workspaceId: ctx.workspaceId,
            task: input.task,
            op,
            provider: provider.id,
            model: requestedModel,
            status: 'ERROR',
            errorMessage: String(error),
            latencyMs: Date.now() - started,
            correlationId: ctx.correlationId,
            modelPolicy: ctx.modelPolicy,
          });
          throw error;
        }
        const providerSettlementUnknown =
          providerError?.usage?.gatewaySettlements?.some(
            (observation) => observation.status === 'unknown',
          );
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
        await this.settlePersistentOperation({
          scope,
          status: 'FAILED',
          measurement,
          meta: {
            provider: providerError?.provider ?? provider.id,
            requestedModel,
            ...(providerError?.model ? { resolvedModel: providerError.model } : {}),
            ...(providerError?.reportedModel ? { reportedModel: providerError.reportedModel } : {}),
            ...(providerError?.modelResolutionSource
              ? {
                  modelResolutionSource: providerError.modelResolutionSource,
                }
              : {}),
          },
          errorCode:
            error instanceof ExternalActionDeniedError
              ? 'SUPPRESSION_ACTION_GATE'
              : measurement.basis === 'unknown'
                ? 'MODEL_SETTLEMENT_UNKNOWN'
                : providerError
                  ? 'PROVIDER_OUTPUT_ERROR'
                  : 'PROVIDER_CALL_ERROR',
        });
        this.trace?.record({
          workspaceId: ctx.workspaceId,
          task: input.task,
          op,
          provider: provider.id,
          model: requestedModel,
          status: 'ERROR',
          errorMessage: String(error),
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
        durableResult = paid.durableReplayResult?.(result as unknown as Record<string, unknown>);
      } catch (error) {
        await this.settlePersistentOperation({
          scope,
          status: 'FAILED',
          measurement,
          meta: {
            provider: result.provider,
            requestedModel,
            resolvedModel: result.model,
            ...(result.reportedModel ? { reportedModel: result.reportedModel } : {}),
            ...(result.modelResolutionSource ? { modelResolutionSource: result.modelResolutionSource } : {}),
          },
          errorCode: 'DURABLE_REPLAY_REJECTED',
        });
        throw error;
      }
      await this.settlePersistentOperation({
        scope,
        status: 'SUCCEEDED',
        measurement,
        result: durableResult,
        meta: {
          provider: result.provider,
          requestedModel,
          resolvedModel: result.model,
          ...(result.reportedModel ? { reportedModel: result.reportedModel } : {}),
          ...(result.modelResolutionSource ? { modelResolutionSource: result.modelResolutionSource } : {}),
        },
      });
      this.trace?.record({
        workspaceId: ctx.workspaceId,
        task: input.task,
        op,
        provider: result.provider,
        model: result.model,
        status: 'OK',
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
      modelResolutionSource?: ModelResult<unknown>['modelResolutionSource'];
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
      basis: 'not_incurred',
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

  private unknownModelMeasurement(
    reservationMicrousd: number,
    usage?: ModelUsage,
    callCount = 1,
  ): PaidCostMeasurement {
    return {
      basis: 'unknown',
      budgetChargeMicrousd: reservationMicrousd,
      reportedCostMicrousd: null,
      calculatedCostMicrousd: null,
      estimatedCostMicrousd: null,
      inputTokens: Number.isInteger(usage?.inputTokens)
        ? usage!.inputTokens!
        : null,
      outputTokens: Number.isInteger(usage?.outputTokens)
        ? usage!.outputTokens!
        : null,
      callCount: Math.max(1, Math.floor(callCount)),
      meta: {
        reason: 'model_output_or_ack_unavailable',
        // 保留 provider 结算观测（含稳定 requestId/resolverId）：UNKNOWN
        // spend 不进自动 sweep，后续只能按 requestId/operationKey/fence
        // 做受控事实恢复，丢弃观测会让恢复无从定位物理调用。
        ...(usage?.gatewaySettlements?.length
          ? { gatewaySettlements: [...usage.gatewaySettlements] }
          : {}),
      },
    };
  }

  private async settlePersistentOperation(input: Parameters<SiteBuildCostLedger['settleOperation']>[0]): Promise<void> {
    const disablePaidCallsReason =
      input.measurement.basis === 'unknown' ? (input.errorCode ?? 'MODEL_SETTLEMENT_UNKNOWN') : undefined;
    let decision: string;
    try {
      decision = await this.paidLedger!.settleOperation({
        ...input,
        ...(disablePaidCallsReason ? { disablePaidCallsReason } : {}),
      });
    } catch (error) {
      return this.freezeUnknownSettlement(
        input.scope,
        error instanceof PaidOperationUnknownError ? error.errorCode : 'SETTLEMENT_ACK_UNKNOWN',
      );
    }
    // Exact provider cost may exceed the admitted reservation while the
    // physical call and durable output are fully known. The database records
    // CAP_VARIANCE and disables further paid calls, but this is not an ACK
    // ambiguity and must not discard the valid output.
    if (decision === 'OVER_RESERVATION') return;
    if (decision !== 'SETTLED') {
      return this.freezeUnknownSettlement(input.scope, `SETTLEMENT_${decision}`);
    }
    if (disablePaidCallsReason) {
      throw new PaidOperationUnknownError(input.scope.operationKey, disablePaidCallsReason);
    }
  }

  private async freezeUnknownSettlement(scope: PaidOperationReservation, errorCode: string): Promise<never> {
    try {
      await this.paidLedger!.disablePaidCalls(scope.workspaceId, scope.buildRunId, errorCode);
    } catch {
      throw new PaidOperationUnknownError(scope.operationKey, 'UNKNOWN_FREEZE_ACK_UNKNOWN');
    }
    throw new PaidOperationUnknownError(scope.operationKey, errorCode);
  }
}
