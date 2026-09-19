import {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  ChildWorkflowFailure,
  DefaultFailureConverter,
  ServerFailure,
  TemporalFailure,
  TerminatedFailure,
  TimeoutFailure,
  defaultPayloadConverter,
  type PayloadConverter,
  type ProtoFailure,
  type RetryState,
  type SerializationContext,
  type TimeoutType,
} from "@temporalio/common";
import {
  ExecutionControlError,
  isExecutionControlError,
} from "../execution-budget/execution-control-error";
import {
  DIAGNOSTIC_FAILURE_MESSAGE,
  DIAGNOSTIC_FAILURE_TYPE,
} from "./failure-boundary.contract";

const MAX_DEPTH = 16;
const MAX_BYTES = 16_384;
const CONTROL = DIAGNOSTIC_FAILURE_MESSAGE;
const CONTROL_TOKEN = "EXECUTIONCONTROLERROR";
const MESSAGE = "Temporal execution failed";
const SDK = new DefaultFailureConverter();
type Fields = Record<string, unknown>;
type ScalarKind = "string" | "boolean" | "number" | "int64";
type Shape = { readonly [key: string]: ScalarKind | Shape };

function fields(value: unknown): Fields {
  if (!value || typeof value !== "object") throw new Error(CONTROL);
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  if (Reflect.ownKeys(descriptors).length > 32) throw new Error(CONTROL);
  const out: Fields = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]!;
    // The SDK and V8 both permit a lazy stack. It is never evaluated or copied.
    if (key === "stack") continue;
    if (!("value" in descriptor)) throw new Error(CONTROL);
    if (typeof key === "string") out[key] = descriptor.value;
  }
  return out;
}

function inheritedData(value: object, key: PropertyKey): unknown {
  let current: object | null = value;
  const seen = new Set<object>();
  for (let i = 0; current && i < 8; i++) {
    if (seen.has(current)) throw new Error(CONTROL);
    seen.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if (!("value" in descriptor)) throw new Error(CONTROL);
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current);
  }
  if (current) throw new Error(CONTROL);
  return undefined;
}

function budgetToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (
    value.includes("BUDGET_OPERATION_REPLAY") ||
    value === "BudgetOperationReplayError"
  )
    return "BUDGET_OPERATION_REPLAY_UNAVAILABLE";
  if (value.includes("BUDGET_STORE_")) return "BUDGET_STORE_UNAVAILABLE";
  return undefined;
}

function message(
  values: Fields,
  control = false,
  preservedType?: unknown,
): string {
  const tokens = [values.code, values.type, values.name, values.message].filter(
    (value): value is string => typeof value === "string",
  );
  const budget = tokens.map(budgetToken).find((value) => value !== undefined);
  const authority = [values.code, values.type, values.message].includes(
    "EXECUTION_BUDGET_PLATFORM_AUTHORITY_REQUIRED",
  );
  if (budget && authority) {
    // One message must not erase another consumer's stop token. Keep both only
    // when the unchanged application type carries the second category.
    if (preservedType === "EXECUTION_BUDGET_PLATFORM_AUTHORITY_REQUIRED")
      return budget;
    if (budgetToken(preservedType))
      return "EXECUTION_BUDGET_PLATFORM_AUTHORITY_REQUIRED";
    throw new Error(CONTROL);
  }
  if (budget) return budget;
  if (authority) return "EXECUTION_BUDGET_PLATFORM_AUTHORITY_REQUIRED";
  if (control) return CONTROL_TOKEN;
  for (const token of tokens) {
    try {
      new ExecutionControlError(token);
      return CONTROL_TOKEN;
    } catch {
      /* Not a machine control token. */
    }
  }
  return MESSAGE;
}

function fallback(nonRetryable = true): ProtoFailure {
  return {
    message: CONTROL,
    source: "TypeScriptSDK",
    stackTrace: "",
    applicationFailureInfo: { type: DIAGNOSTIC_FAILURE_TYPE, nonRetryable },
  };
}

function scalar(value: unknown, kind: ScalarKind): unknown {
  if (kind === "string" && typeof value === "string" && value.length <= 4096)
    return value;
  if (kind === "boolean" && typeof value === "boolean") return value;
  if (
    (kind === "number" || kind === "int64") &&
    typeof value === "number" &&
    Number.isSafeInteger(value)
  )
    return value;
  if (kind !== "int64") throw new Error(CONTROL);
  // protobufjs Long values are copied as data, never retained with their prototype.
  const long = fields(value);
  if (
    typeof long.low !== "number" ||
    !Number.isInteger(long.low) ||
    long.low < -2147483648 ||
    long.low > 2147483647 ||
    typeof long.high !== "number" ||
    !Number.isInteger(long.high) ||
    long.high < -2147483648 ||
    long.high > 2147483647 ||
    typeof long.unsigned !== "boolean"
  )
    throw new Error(CONTROL);
  return { low: long.low, high: long.high, unsigned: long.unsigned };
}

function pick(value: unknown, shape: Shape): Fields {
  const input = fields(value);
  const out: Fields = {};
  for (const [key, nested] of Object.entries(shape)) {
    if (input[key] != null)
      out[key] =
        typeof nested === "string"
          ? scalar(input[key], nested)
          : pick(input[key], nested);
  }
  return out;
}

const INFO: Readonly<Record<string, Shape>> = {
  applicationFailureInfo: {
    type: "string",
    nonRetryable: "boolean",
    nextRetryDelay: { seconds: "int64", nanos: "number" },
    category: "number",
  },
  activityFailureInfo: {
    scheduledEventId: "int64",
    startedEventId: "int64",
    identity: "string",
    activityType: { name: "string" },
    activityId: "string",
    retryState: "number",
  },
  childWorkflowExecutionFailureInfo: {
    namespace: "string",
    workflowExecution: { workflowId: "string", runId: "string" },
    workflowType: { name: "string" },
    initiatedEventId: "int64",
    startedEventId: "int64",
    retryState: "number",
  },
  timeoutFailureInfo: { timeoutType: "number" },
  serverFailureInfo: { nonRetryable: "boolean" },
  canceledFailureInfo: {},
  terminatedFailureInfo: {},
  resetWorkflowFailureInfo: {},
};

function scrubProto(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): ProtoFailure {
  if (
    depth >= MAX_DEPTH ||
    !value ||
    typeof value !== "object" ||
    seen.has(value)
  )
    return fallback();
  seen.add(value);
  const input = fields(value);
  if (
    Object.keys(input).some(
      (key) => key.endsWith("FailureInfo") && !Object.hasOwn(INFO, key),
    )
  )
    return fallback();
  const app = input.applicationFailureInfo
    ? fields(input.applicationFailureInfo)
    : {};
  if (
    app.type === DIAGNOSTIC_FAILURE_TYPE &&
    input.message === DIAGNOSTIC_FAILURE_MESSAGE
  )
    return fallback(boolean(app.nonRetryable) ?? true);
  if (Object.keys(INFO).filter((key) => input[key] != null).length > 1)
    return fallback();
  const out: Fields = {
    message: message(
      { message: input.message, type: app.type },
      false,
      app.type,
    ),
    stackTrace: "",
    source: "TypeScriptSDK",
  };
  for (const [key, shape] of Object.entries(INFO)) {
    if (input[key] != null) out[key] = pick(input[key], shape);
  }
  if (input.cause != null) out.cause = scrubProto(input.cause, seen, depth + 1);
  return out as ProtoFailure;
}

function string(value: unknown, required = false): string | undefined {
  if (value == null && !required) return undefined;
  if (typeof value !== "string" || (required && !value) || value.length > 4096)
    throw new Error(CONTROL);
  return value;
}

function boolean(value: unknown): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== "boolean") throw new Error(CONTROL);
  return value;
}

const RETRY = new Set([
  "IN_PROGRESS",
  "NON_RETRYABLE_FAILURE",
  "TIMEOUT",
  "MAXIMUM_ATTEMPTS_REACHED",
  "RETRY_POLICY_NOT_SET",
  "INTERNAL_SERVER_ERROR",
  "CANCEL_REQUESTED",
]);
const TIMEOUT = new Set([
  "START_TO_CLOSE",
  "SCHEDULE_TO_START",
  "SCHEDULE_TO_CLOSE",
  "HEARTBEAT",
]);
function enumValue<T extends string>(
  value: unknown,
  values: Set<string>,
  required = false,
): T | undefined {
  if (value == null && !required) return undefined;
  if (typeof value !== "string" || !values.has(value)) throw new Error(CONTROL);
  return value as T;
}

function cleanError(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): Error {
  if (
    depth >= MAX_DEPTH ||
    !value ||
    typeof value !== "object" ||
    seen.has(value)
  ) {
    return ApplicationFailure.nonRetryable(CONTROL, DIAGNOSTIC_FAILURE_TYPE);
  }
  seen.add(value);
  const input = fields(value);
  if (Object.hasOwn(input, "originalFailure")) throw new Error(CONTROL);
  const marked = (kind: string) =>
    inheritedData(value, Symbol.for(`__temporal_is${kind}`)) === true;
  const application = marked("ApplicationFailure");
  const text = message(
    {
      code: input.code,
      type: input.type,
      message: input.message,
      name: inheritedData(value, "name"),
    },
    isExecutionControlError(value),
    application ? input.type : undefined,
  );
  if (input.failure != null) {
    // Bypass the SDK's raw cached-proto shortcut using an already-clean cache.
    const cleaned = scrubProto(input.failure);
    const cached = SDK.failureToError(
      cleaned,
      defaultPayloadConverter,
    ) as TemporalFailure;
    cached.failure = cleaned;
    return cached;
  }
  const cause =
    input.cause == null ? undefined : cleanError(input.cause, seen, depth + 1);
  let error: Error;
  if (marked("NexusOperationFailure") || marked("NexusHandlerFailure"))
    throw new Error(CONTROL);
  if (application) {
    const delay = input.nextRetryDelay;
    if (delay != null && typeof delay !== "string" && typeof delay !== "number")
      throw new Error(CONTROL);
    const category = enumValue<"BENIGN">(input.category, new Set(["BENIGN"]));
    error = new ApplicationFailure(
      text,
      string(input.type),
      boolean(input.nonRetryable),
      undefined,
      cause,
      delay as ConstructorParameters<typeof ApplicationFailure>[5],
      category,
    );
  } else if (marked("ActivityFailure")) {
    error = new ActivityFailure(
      text,
      string(input.activityType, true)!,
      string(input.activityId),
      enumValue<NonNullable<RetryState>>(input.retryState, RETRY),
      string(input.identity),
      cause,
    );
  } else if (marked("ChildWorkflowFailure")) {
    error = new ChildWorkflowFailure(
      string(input.namespace),
      pick(input.execution, { workflowId: "string", runId: "string" }),
      string(input.workflowType, true)!,
      enumValue<NonNullable<RetryState>>(input.retryState, RETRY),
      cause,
    );
  } else if (marked("TimeoutFailure")) {
    error = new TimeoutFailure(
      text,
      undefined,
      enumValue<NonNullable<TimeoutType>>(input.timeoutType, TIMEOUT, true)!,
    );
  } else if (marked("CancelledFailure")) {
    error = new CancelledFailure(text, [], cause);
  } else if (marked("ServerFailure")) {
    error = new ServerFailure(
      text,
      boolean(input.nonRetryable) ?? false,
      cause,
    );
  } else if (marked("TerminatedFailure")) {
    error = new TerminatedFailure(text, cause);
  } else if (marked("TemporalFailure")) {
    error = new TemporalFailure(text, cause);
  } else {
    // Activity errors already arrive normalized by the SDK. Preserve the default
    // non-Application representation for plain Workflow Task failures.
    // Start with a fixed diagnostic. The common assignment below installs only
    // the closed control token selected by message(), never the input message.
    error = new Error("TEMPORAL_FAILURE", { cause });
  }
  error.message = text;
  Object.defineProperty(error, "cause", {
    value: cause,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  error.stack = "";
  return error;
}

/** Outgoing diagnostic redaction only. Inbound historical decoding stays SDK-default. */
export class DiagnosticFailureConverter extends DefaultFailureConverter {
  override errorToFailure(
    error: unknown,
    payloadConverter: PayloadConverter,
    context?: SerializationContext,
  ): ProtoFailure {
    try {
      const cleaned = cleanError(error);
      const result = scrubProto(
        super.errorToFailure(cleaned, payloadConverter, context),
      );
      for (
        let current: ProtoFailure | null | undefined = result;
        current;
        current = current.cause
      ) {
        if (
          current.applicationFailureInfo?.type === DIAGNOSTIC_FAILURE_TYPE &&
          current.message === DIAGNOSTIC_FAILURE_MESSAGE
        )
          return fallback();
      }
      // Unsafe/truncated failures must never turn a control-plane stop into continuation.
      if (
        isExecutionControlError(error) &&
        !isExecutionControlError(
          SDK.failureToError(result, defaultPayloadConverter),
        )
      )
        return fallback();
      if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_BYTES)
        return fallback();
      return result;
    } catch {
      return fallback();
    }
  }
}

export const failureConverter = new DiagnosticFailureConverter();
