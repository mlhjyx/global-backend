import {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  ChildWorkflowFailure,
  DefaultFailureConverter,
  defaultPayloadConverter,
  ServerFailure,
  TerminatedFailure,
  TimeoutFailure,
  NexusOperationFailure,
  type ProtoFailure,
} from "@temporalio/common";
import { temporal } from "@temporalio/proto";
import { describe, expect, it, vi } from "vitest";
import {
  ExecutionControlError,
  isExecutionControlError,
} from "../execution-budget/execution-control-error";
import { failureConverter } from "./diagnostic-failure-converter";
import {
  DIAGNOSTIC_FAILURE_MESSAGE,
  DIAGNOSTIC_FAILURE_TYPE,
} from "./failure-boundary.contract";

const DIAGNOSTIC_CANARY = "synthetic-diagnostic-secret-canary";
const sdk = new DefaultFailureConverter();
function wire(failure: ProtoFailure): ProtoFailure {
  return temporal.api.failure.v1.Failure.decode(
    temporal.api.failure.v1.Failure.encode(failure).finish(),
  );
}
function roundtrip(error: unknown) {
  const proto = wire(
    failureConverter.errorToFailure(error, defaultPayloadConverter),
  );
  return { proto, error: sdk.failureToError(proto, defaultPayloadConverter) };
}

describe("diagnostic failure serialization boundary", () => {
  it("removes application diagnostics before invoking the payload converter while retaining retry fields", () => {
    const error = ApplicationFailure.create({
      message: DIAGNOSTIC_CANARY,
      type: "KB_DOCUMENT_INVALID",
      nonRetryable: true,
      details: [{ secret: DIAGNOSTIC_CANARY }],
      nextRetryDelay: 7000,
      category: "BENIGN",
      cause: ApplicationFailure.retryable(
        DIAGNOSTIC_CANARY,
        "DEPENDENCY_UNAVAILABLE",
        DIAGNOSTIC_CANARY,
      ),
    });
    error.stack = DIAGNOSTIC_CANARY;
    const toPayload = vi.spyOn(defaultPayloadConverter, "toPayload");
    let proto: ProtoFailure;
    try {
      proto = failureConverter.errorToFailure(error, defaultPayloadConverter);
      expect(toPayload).not.toHaveBeenCalled();
    } finally {
      toPayload.mockRestore();
    }
    expect(JSON.stringify(proto)).not.toContain(DIAGNOSTIC_CANARY);
    expect(proto.applicationFailureInfo).toMatchObject({
      type: "KB_DOCUMENT_INVALID",
      nonRetryable: true,
      category: 1,
    });
    expect(
      Number(wire(proto).applicationFailureInfo?.nextRetryDelay?.seconds),
    ).toBe(7);
    const decoded = sdk.failureToError(
      wire(proto),
      defaultPayloadConverter,
    ) as ApplicationFailure;
    expect(decoded).toBeInstanceOf(ApplicationFailure);
    expect(decoded.nonRetryable).toBe(true);
    expect(decoded.details).toEqual([]);
    expect(decoded.cause).toBeInstanceOf(ApplicationFailure);
  });

  it("does not lose nonRetryable when a diagnostic details value cannot be serialized", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = roundtrip(
      ApplicationFailure.nonRetryable(DIAGNOSTIC_CANARY, "INPUT_INVALID", cyclic),
    );
    expect(result.error).toMatchObject({
      type: "INPUT_INVALID",
      nonRetryable: true,
    });
    expect(JSON.stringify(result.proto)).not.toContain(DIAGNOSTIC_CANARY);
  });

  it.each([
    new ActivityFailure(
      DIAGNOSTIC_CANARY,
      "cleanupStagingAssetObject",
      "1",
      "MAXIMUM_ATTEMPTS_REACHED",
      "worker@local",
      ApplicationFailure.retryable(DIAGNOSTIC_CANARY, "Error"),
    ),
    new ChildWorkflowFailure(
      "default",
      { workflowId: "child", runId: "run" },
      "assetObjectCleanupWorkflow",
      "NON_RETRYABLE_FAILURE",
      ApplicationFailure.nonRetryable(DIAGNOSTIC_CANARY, "INPUT_INVALID"),
    ),
    new TimeoutFailure(DIAGNOSTIC_CANARY, { secret: DIAGNOSTIC_CANARY }, "START_TO_CLOSE"),
    new CancelledFailure(DIAGNOSTIC_CANARY, [{ secret: DIAGNOSTIC_CANARY }]),
    new ServerFailure(DIAGNOSTIC_CANARY, true),
    new TerminatedFailure(DIAGNOSTIC_CANARY),
  ])("retains the SDK failure kind and control fields for $name", (error) => {
    const original = wire(sdk.errorToFailure(error, defaultPayloadConverter));
    const result = roundtrip(error);
    expect(result.error.constructor).toBe(error.constructor);
    expect(JSON.stringify(result.proto)).not.toContain(DIAGNOSTIC_CANARY);
    for (const key of [
      "activityFailureInfo",
      "childWorkflowExecutionFailureInfo",
      "serverFailureInfo",
      "terminatedFailureInfo",
    ] as const) {
      if (original[key])
        expect(result.proto[key]).toMatchObject(original[key] as object);
    }
    if (error instanceof TimeoutFailure)
      expect((result.error as TimeoutFailure).timeoutType).toBe(
        error.timeoutType,
      );
  });

  it("redacts cached failure protos and encoded attributes instead of using the SDK cache shortcut", () => {
    const error = sdk.failureToError(
      {
        message: DIAGNOSTIC_CANARY,
        stackTrace: DIAGNOSTIC_CANARY,
        encodedAttributes: defaultPayloadConverter.toPayload({
          message: DIAGNOSTIC_CANARY,
          stack_trace: DIAGNOSTIC_CANARY,
        }),
        applicationFailureInfo: {
          type: "INPUT_INVALID",
          nonRetryable: true,
          details: {
            payloads: [defaultPayloadConverter.toPayload({ secret: DIAGNOSTIC_CANARY })],
          },
        },
        cause: { message: DIAGNOSTIC_CANARY, applicationFailureInfo: { type: "Error" } },
      },
      defaultPayloadConverter,
    );
    expect(JSON.stringify(roundtrip(error).proto)).not.toContain(DIAGNOSTIC_CANARY);
    expect(error.message).toBe(DIAGNOSTIC_CANARY);
  });

  it("leaves historical decoding unchanged", () => {
    const proto: ProtoFailure = {
      message: "Encoded failure",
      stackTrace: "",
      encodedAttributes: defaultPayloadConverter.toPayload({
        message: DIAGNOSTIC_CANARY,
        stack_trace: DIAGNOSTIC_CANARY,
      }),
      applicationFailureInfo: {
        type: "Error",
        nonRetryable: true,
        details: {
          payloads: [defaultPayloadConverter.toPayload("historical detail")],
        },
      },
    };
    const decoded = failureConverter.failureToError(
      proto,
      defaultPayloadConverter,
    ) as ApplicationFailure;
    expect(decoded.message).toBe(DIAGNOSTIC_CANARY);
    expect(decoded.stack).toBe(DIAGNOSTIC_CANARY);
    expect(decoded.details).toEqual(["historical detail"]);
  });

  it.each([
    "DOMAIN_ACK_CONSUMER_BINDING_MISSING",
    "BUDGET_STORE_UNAVAILABLE",
    "EXECUTION_BUDGET_PLATFORM_AUTHORITY_REQUIRED",
  ])("preserves control rejection for %s", (code) => {
    for (const error of [
      new ExecutionControlError(code),
      ApplicationFailure.fromError(new ExecutionControlError(code)),
      ApplicationFailure.retryable(code, "Error"),
    ]) {
      expect(isExecutionControlError(error)).toBe(true);
      expect(isExecutionControlError(roundtrip(error).error)).toBe(true);
    }
  });

  it("keeps ordinary application failures ordinary", () => {
    const error = ApplicationFailure.retryable(DIAGNOSTIC_CANARY, "ValidationError");
    expect(isExecutionControlError(error)).toBe(false);
    expect(isExecutionControlError(roundtrip(error).error)).toBe(false);
  });

  it.each(["message", "cause", "details", "type"] as const)(
    "does not execute a %s accessor and does not unblock malformed failures",
    (key) => {
      const error = ApplicationFailure.retryable(DIAGNOSTIC_CANARY, "Error");
      const read = vi.fn(() => {
        throw new Error("getter must not run");
      });
      Object.defineProperty(error, key, { get: read });
      expect(isExecutionControlError(roundtrip(error).error)).toBe(true);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("bounds cyclic and deep causes while retaining fail-closed classification", () => {
    const cyclic = ApplicationFailure.retryable(DIAGNOSTIC_CANARY, "Error");
    Object.assign(cyclic, { cause: cyclic });
    let deep: Error = ApplicationFailure.retryable(DIAGNOSTIC_CANARY, "Error");
    for (let i = 0; i < 40; i++)
      deep = ApplicationFailure.create({
        message: DIAGNOSTIC_CANARY,
        type: "Error",
        cause: deep,
      });
    for (const error of [cyclic, deep]) {
      expect(isExecutionControlError(error)).toBe(true);
      const result = roundtrip(error);
      expect(isExecutionControlError(result.error)).toBe(true);
      expect(JSON.stringify(result.proto)).not.toContain(DIAGNOSTIC_CANARY);
      expect(JSON.stringify(result.proto).length).toBeLessThan(16000);
    }
  });

  it("preserves cached 64-bit scheduling identities without carrying unknown fields", () => {
    const proto = temporal.api.failure.v1.Failure.fromObject({
      message: DIAGNOSTIC_CANARY,
      stackTrace: DIAGNOSTIC_CANARY,
      activityFailureInfo: {
        scheduledEventId: "9007199254740993",
        startedEventId: "9007199254740995",
        activityType: { name: "cleanupStagingAssetObject" },
        activityId: "owned-activity",
        identity: "worker@local",
        retryState: 4,
      },
      cause: {
        message: DIAGNOSTIC_CANARY,
        applicationFailureInfo: { type: "INPUT_INVALID", nonRetryable: true },
      },
    });
    Object.assign(proto.activityFailureInfo!, { arbitraryDiagnostic: DIAGNOSTIC_CANARY });
    const error = sdk.failureToError(proto, defaultPayloadConverter);
    const result = roundtrip(error).proto;
    expect(String(result.activityFailureInfo?.scheduledEventId)).toBe(
      "9007199254740993",
    );
    expect(String(result.activityFailureInfo?.startedEventId)).toBe(
      "9007199254740995",
    );
    expect(JSON.stringify(result)).not.toContain(DIAGNOSTIC_CANARY);
  });

  it.each([
    new NexusOperationFailure(
      DIAGNOSTIC_CANARY,
      1,
      "endpoint",
      "service",
      "operation",
      DIAGNOSTIC_CANARY,
    ),
    Object.assign(new Error(DIAGNOSTIC_CANARY), { originalFailure: { message: DIAGNOSTIC_CANARY } }),
  ])(
    "fails closed for unsupported Nexus paths without serializing their original failure",
    (error) => {
      const result = roundtrip(error);
      expect(result.error).toMatchObject({
        type: DIAGNOSTIC_FAILURE_TYPE,
        message: DIAGNOSTIC_FAILURE_MESSAGE,
        nonRetryable: true,
      });
      expect(JSON.stringify(result.proto)).not.toContain(DIAGNOSTIC_CANARY);
    },
  );

  it.each([
    { applicationFailureInfo: { type: "Error", nonRetryable: DIAGNOSTIC_CANARY } },
    { applicationFailureInfo: { type: "Error" }, canceledFailureInfo: {} },
    { nexusHandlerFailureInfo: { type: DIAGNOSTIC_CANARY } },
    { futureFailureInfo: { diagnostic: DIAGNOSTIC_CANARY } },
    {
      activityFailureInfo: {
        scheduledEventId: { low: 2 ** 40, high: 0, unsigned: false },
        activityType: { name: "cleanup" },
      },
    },
  ])("rejects malformed or unsupported cached metadata", (proto) => {
    const error = ApplicationFailure.retryable(DIAGNOSTIC_CANARY, "Error");
    Object.assign(error, { failure: proto });
    expect(roundtrip(error).error).toMatchObject({
      type: DIAGNOSTIC_FAILURE_TYPE,
      message: DIAGNOSTIC_FAILURE_MESSAGE,
    });
  });

  it("preserves an explicitly attached timeout cause and is deterministic without mutating input", () => {
    const error = new TimeoutFailure(
      DIAGNOSTIC_CANARY,
      { checkpoint: DIAGNOSTIC_CANARY },
      "HEARTBEAT",
    );
    Object.assign(error, {
      cause: ApplicationFailure.nonRetryable(
        "EXECUTION_BUDGET_PLATFORM_AUTHORITY_REQUIRED",
        "Error",
      ),
    });
    const before = sdk.errorToFailure(error, defaultPayloadConverter);
    const first = failureConverter.errorToFailure(
      error,
      defaultPayloadConverter,
    );
    expect(first).toEqual(
      failureConverter.errorToFailure(error, defaultPayloadConverter),
    );
    expect(first.cause?.message).toBe(
      "EXECUTION_BUDGET_PLATFORM_AUTHORITY_REQUIRED",
    );
    expect(sdk.errorToFailure(error, defaultPayloadConverter)).toEqual(before);
  });

  it("bounds total output even when each protocol identifier is individually valid", () => {
    let error: Error = ApplicationFailure.retryable(DIAGNOSTIC_CANARY, "Error");
    for (let i = 0; i < 10; i++)
      error = new ActivityFailure(
        DIAGNOSTIC_CANARY,
        "a".repeat(4000),
        "b".repeat(4000),
        "MAXIMUM_ATTEMPTS_REACHED",
        "worker",
        error,
      );
    const result = roundtrip(error);
    expect(result.error).toMatchObject({
      type: DIAGNOSTIC_FAILURE_TYPE,
      message: DIAGNOSTIC_FAILURE_MESSAGE,
    });
    expect(JSON.stringify(result.proto).length).toBeLessThan(1024);
  });
});
