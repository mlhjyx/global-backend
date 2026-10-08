const REASON_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;
const LEADING_REASON_CODE = /^([A-Z][A-Z0-9_]{2,63})(?::|$)/u;
const UNCLASSIFIED_REASON_CODE = "PROVIDER_OUTPUT_UNCLASSIFIED";

/** An explicit code, else the message's leading CODE token; never free text. */
function providerOutputReasonCode(explicit: string | undefined, message: string): string {
  if (explicit !== undefined) {
    if (!REASON_CODE.test(explicit)) {
      throw new TypeError("PROVIDER_OUTPUT_REASON_CODE_INVALID");
    }
    return explicit;
  }
  return LEADING_REASON_CODE.exec(message)?.[1] ?? UNCLASSIFIED_REASON_CODE;
}

/**
 * provider 消费了 token 但结构化输出不可用（空输出 / finish_reason=length 截断 / JSON 解析失败）
 * 时抛出。携带 `usage` 让网关 catch（router-model-gateway）能按真实消耗结算预算，而非静默记 0¢——
 * 否则「reasoning 预算耗尽/截断」这类**花了 token 却失败**的调用会绕过硬预算上界（M1-b fast-follow 改动 2）。
 */
export class ProviderOutputError extends Error {
  readonly usage?: ModelUsage;
  /** Why the answer was unusable, safe to persist: it never carries model text. */
  readonly reasonCode: string;
  /** Number of provider requests represented by this error (schema repair may be two). */
  readonly callCount: number;
  readonly provider?: string;
  readonly model?: string;
  readonly reportedModel?: string;
  readonly modelResolutionSource?: ModelResolutionSource;

  constructor(
    message: string,
    usage?: ModelUsage,
    opts?: ProviderOutputErrorOptions,
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ProviderOutputError";
    this.reasonCode = providerOutputReasonCode(opts?.reasonCode, message);
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
    opts?: ProviderOutputErrorOptions,
  ) {
    super(message, usage, { ...opts, reasonCode: opts?.reasonCode ?? "TASK_OUTPUT_REJECTED" });
    this.name = "TaskOutputValidationError";
  }
}

/** A response cannot prove it came from the exact requested model. */
export class ProviderIdentityError extends ProviderOutputError {
  constructor(
    message: string,
    usage?: ModelUsage,
    opts?: ProviderOutputErrorOptions,
  ) {
    super(message, usage, opts);
    this.name = "ProviderIdentityError";
  }
}

/**
 * The transport failed before a complete answer arrived: an unreadable or cut
 * stream, a malformed event, an upstream error event or a body that is not
 * JSON. Like an HTTP error it usually hits every call of a run, so it fails
 * closed instead of letting each company's fallback absorb it.
 */
export class ProviderTransportError extends ProviderOutputError {
  constructor(
    message: string,
    usage?: ModelUsage,
    opts?: ProviderOutputErrorOptions,
  ) {
    super(message, usage, opts);
    this.name = "ProviderTransportError";
  }
}

/**
 * A structured-output repair could not run because the first call's settlement
 * is unresolved or the repair wire could not be prepared. The call's outcome is
 * not known, so this fails closed like an unknown settlement.
 */
export class ProviderOutputUnresolvedError extends ProviderOutputError {
  constructor(
    message: string,
    usage?: ModelUsage,
    opts?: ProviderOutputErrorOptions,
  ) {
    super(message, usage, opts);
    this.name = "ProviderOutputUnresolvedError";
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
    super(`paid model settlement failed: ${errorCode}`, usage, { ...opts, reasonCode: errorCode });
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
      reasonCode: "EXTERNAL_ACTION_DENIED",
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
import { registerRecoverableModelFailureClass } from "../../execution-budget/execution-control-error";

export interface ProviderErrorProvenance {
  provider?: string;
  model?: string;
  reportedModel?: string;
  modelResolutionSource?: ModelResolutionSource;
}

export type ProviderOutputErrorOptions = {
  cause?: unknown;
  callCount?: number;
  /** Stable code for traces; defaults to the message's leading CODE token. */
  reasonCode?: string;
} & ProviderErrorProvenance;

// One unusable answer (bad JSON, schema miss, task-gate rejection) is not a
// control decision, so a caller with a deterministic fallback may absorb it
// (isExecutionControlError). Every other subclass stays unregistered and fails
// closed: transport, identity and HTTP failures usually hit every call of a
// run, so absorbing them would end a run with nothing judged; unresolved
// outcomes, unknown settlements and compliance denials are control decisions.
registerRecoverableModelFailureClass(ProviderOutputError);
registerRecoverableModelFailureClass(TaskOutputValidationError);
