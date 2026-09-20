/**
 * provider 消费了 token 但结构化输出不可用（空输出 / finish_reason=length 截断 / JSON 解析失败）
 * 时抛出。携带 `usage` 让网关 catch（router-model-gateway）能按真实消耗结算预算，而非静默记 0¢——
 * 否则「reasoning 预算耗尽/截断」这类**花了 token 却失败**的调用会绕过硬预算上界（M1-b fast-follow 改动 2）。
 */
export class ProviderOutputError extends Error {
  readonly usage?: ModelUsage;
  /** Number of provider requests represented by this error (schema repair may be two). */
  readonly callCount: number;
  readonly provider?: string;
  readonly model?: string;
  readonly reportedModel?: string;
  readonly modelResolutionSource?: ModelResolutionSource;

  constructor(
    message: string,
    usage?: ModelUsage,
    opts?: { cause?: unknown; callCount?: number } & ProviderErrorProvenance,
  ) {
    super(message, opts);
    this.name = "ProviderOutputError";
    this.usage = usage;
    this.callCount = opts?.callCount ?? 1;
    this.provider = opts?.provider;
    this.model = opts?.model;
    this.reportedModel = opts?.reportedModel;
    this.modelResolutionSource = opts?.modelResolutionSource;
  }
}

/**
 * A provider returned a schema-valid artifact, but the caller's deterministic
 * business gate rejected it. Unlike a provider-format failure, retrying another
 * provider (especially the dev stub) cannot make that same model attempt valid;
 * the error must return to the AiTask model fallback loop after trace/settle.
 */
export class TaskOutputValidationError extends ProviderOutputError {
  constructor(
    message: string,
    usage?: ModelUsage,
    opts?: { cause?: unknown; callCount?: number } & ProviderErrorProvenance,
  ) {
    super(message, usage, opts);
    this.name = "TaskOutputValidationError";
  }
}

/** A response cannot prove it came from the exact requested model. */
export class ProviderIdentityError extends ProviderOutputError {
  constructor(
    message: string,
    usage?: ModelUsage,
    opts?: { cause?: unknown; callCount?: number } & ProviderErrorProvenance,
  ) {
    super(message, usage, opts);
    this.name = "ProviderIdentityError";
  }
}

/**
 * A paid physical wire could not produce both a usable payload and an exact
 * settlement fact. The stable code is safe for persistence and user-facing
 * diagnostics; raw transport errors and provider bodies are never embedded.
 */
export class ProviderSettlementError extends ProviderOutputError {
  constructor(
    public readonly errorCode:
      | "MODEL_SETTLEMENT_GATEWAY_UNAVAILABLE"
      | "MODEL_SETTLEMENT_UPSTREAM_ACK_UNKNOWN"
      | "MODEL_SETTLEMENT_PAYLOAD_UNAVAILABLE"
      | "MODEL_SETTLEMENT_GATEWAY_LOG_MISSING"
      | "MODEL_SETTLEMENT_GATEWAY_LOG_UNAVAILABLE"
      | "MODEL_SETTLEMENT_LOG_AMBIGUOUS"
      | "MODEL_SETTLEMENT_LOG_INVALID"
      | "MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN",
    usage?: ModelUsage,
    opts?: { callCount?: number } & ProviderErrorProvenance,
  ) {
    super(`paid model settlement failed: ${errorCode}`, usage, opts);
    this.name = "ProviderSettlementError";
  }
}

/**
 * Another worker owns the already-started physical wire. A replay must not
 * dispatch, probe, settle, or terminalize that live owner's attempt.
 */
export class ProviderWireInFlightError extends Error {
  readonly errorCode = "MODEL_WIRE_IN_FLIGHT" as const;

  constructor() {
    super("provider wire is owned by an in-flight dispatch");
    this.name = "ProviderWireInFlightError";
  }
}

/**
 * A workspace suppression fact denied an acquisition external action at the
 * final wire boundary. This is terminal: model fallback/repair must not turn a
 * compliance denial into another provider call. It carries prior-call usage
 * when a denial arrives between an initial structured call and its repair.
 */
export class ExternalActionDeniedError extends ProviderOutputError {
  readonly decision = "suppression_action_gate";

  constructor(
    usage?: ModelUsage,
    opts?: { cause?: unknown; callCount?: number } & ProviderErrorProvenance,
  ) {
    super("external action denied: suppression_action_gate", usage, {
      ...opts,
      callCount: opts?.callCount ?? 0,
    });
    this.name = "ExternalActionDeniedError";
  }
}

/** Stable HTTP status surface used by capability probes and unavailable mapping. */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly provider: string;
  readonly model: string;

  constructor(input: {
    status: number;
    provider: string;
    model: string;
  }) {
    super(`${input.provider} ${input.model}: HTTP ${input.status}`);
    this.name = "ProviderHttpError";
    this.status = input.status;
    this.provider = input.provider;
    this.model = input.model;
  }
}
import type { ModelResolutionSource, ModelUsage } from "../types";

export interface ProviderErrorProvenance {
  provider?: string;
  model?: string;
  reportedModel?: string;
  modelResolutionSource?: ModelResolutionSource;
}
