import {
  ApplicationFailure,
  defaultFailureConverter,
  defaultPayloadConverter,
} from "@temporalio/common";
import { temporal } from "@temporalio/proto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/workflow", async () => ({
  ...(await import("./testing/temporal-workflow.mock")),
}));
import { acts, resetActivities } from "./testing/temporal-workflow.mock";
import { backlogSweepWorkflow } from "./backlog.workflow";
import { externalIntentSweepWorkflow } from "./external-intent.workflow";
import { failureConverter } from "./diagnostic-failure-converter";
import {
  DIAGNOSTIC_FAILURE_MESSAGE,
  DIAGNOSTIC_FAILURE_TYPE,
} from "./failure-boundary.contract";

const AUTH = "EXECUTION_BUDGET_PLATFORM_AUTHORITY_REQUIRED";
function encoded(error: unknown): Error {
  const proto = failureConverter.errorToFailure(error, defaultPayloadConverter);
  const wire = temporal.api.failure.v1.Failure.decode(
    temporal.api.failure.v1.Failure.encode(proto).finish(),
  );
  return defaultFailureConverter.failureToError(wire, defaultPayloadConverter);
}
function nested(error: Error, depth: number): Error {
  for (let i = 0; i < depth; i++)
    error = ApplicationFailure.create({
      type: "Error",
      message: "dependency failure",
      cause: error,
    });
  return error;
}
async function backlogStops(error: unknown): Promise<boolean> {
  resetActivities();
  acts.qualifyFitBacklog.mockRejectedValue(error);
  acts.scoreCandidates.mockResolvedValue({ scored: 0 });
  let stopped = false;
  try {
    await backlogSweepWorkflow({
      workspaceId: "workspace",
      icpId: "icp",
      maxFitRounds: 1,
      maxEnrichRounds: 0,
      maxSignalRounds: 0,
      maxWatchRounds: 0,
      maxContactRounds: 0,
      maxGuessRounds: 0,
    });
  } catch {
    stopped = true;
  }
  if (stopped) expect(acts.scoreCandidates).not.toHaveBeenCalled();
  else expect(acts.scoreCandidates).toHaveBeenCalledTimes(1);
  return stopped;
}
async function intentStops(error: unknown): Promise<boolean> {
  resetActivities();
  acts.listExternalIntentTargets.mockResolvedValue({
    targets: [],
    tedEnabled: true,
    openfdaEnabled: false,
    samgovEnabled: false,
  });
  acts.expireStaleSignals.mockResolvedValue({ expired: 0 });
  acts.ingestExternalSignals.mockRejectedValue(error);
  acts.recomputeExpiredIntent.mockResolvedValue({
    workspacesRecomputed: 0,
    companiesRebuilt: 0,
    companiesCleared: 0,
    truncated: 0,
  });
  acts.liveProviderState.mockResolvedValue({
    ted: false,
    openfda: false,
    samgov: false,
  });
  let stopped = false;
  try {
    await externalIntentSweepWorkflow({});
  } catch {
    stopped = true;
  }
  if (stopped) expect(acts.recomputeExpiredIntent).not.toHaveBeenCalled();
  else expect(acts.recomputeExpiredIntent).toHaveBeenCalledTimes(1);
  return stopped;
}
beforeEach(() => resetActivities());

describe("real workflow decisions across failure serialization", () => {
  it.each([
    Object.assign(new Error("BUDGET_STORE_UNAVAILABLE"), { code: AUTH }),
    Object.assign(new Error("BUDGET_OPERATION_REPLAY_UNAVAILABLE"), {
      type: AUTH,
    }),
    ApplicationFailure.retryable("BUDGET_STORE_UNAVAILABLE", AUTH),
    ApplicationFailure.nonRetryable(AUTH, "BUDGET_STORE_UNAVAILABLE"),
    Object.assign(new Error("dependency failure"), {
      name: "BudgetOperationReplayError",
      code: AUTH,
    }),
  ])(
    "does not drop either stop decision when control categories conflict",
    async (error) => {
      expect(await backlogStops(error)).toBe(true);
      expect(await intentStops(error)).toBe(true);
      const result = encoded(error);
      if (error instanceof ApplicationFailure) {
        expect(result).toBeInstanceOf(ApplicationFailure);
        expect((result as ApplicationFailure).type).toBe(error.type);
        expect((result as ApplicationFailure).nonRetryable).toBe(
          error.nonRetryable,
        );
      }
      expect(await backlogStops(result)).toBe(true);
      expect(await intentStops(result)).toBe(true);
    },
  );
  it.each(Array.from({ length: 14 }, (_, i) => i))(
    "preserves backlog authority decision at cause depth %i",
    async (depth) => {
      const error = nested(ApplicationFailure.retryable(AUTH, "Error"), depth);
      expect(await backlogStops(error)).toBe(depth <= 12);
      expect(await backlogStops(encoded(error))).toBe(depth <= 12);
    },
  );
  it.each(["code", "type", "message"] as const)(
    "preserves backlog authority in %s",
    async (key) => {
      const error = Object.assign(new Error("dependency failure"), {
        [key]: AUTH,
      });
      expect(await backlogStops(error)).toBe(true);
      expect(await backlogStops(encoded(error))).toBe(true);
    },
  );
  it("does not promote a backlog name-only token into authority rejection", async () => {
    const error = Object.assign(new Error("dependency failure"), {
      name: AUTH,
    });
    expect(await backlogStops(error)).toBe(false);
    expect(await backlogStops(encoded(error))).toBe(false);
  });
  it.each(["BUDGET_STORE_UNAVAILABLE", "BUDGET_OPERATION_REPLAY_UNAVAILABLE"])(
    "preserves intent budget cause-depth cutoff for %s",
    async (code) => {
      for (let depth = 0; depth <= 5; depth++) {
        const error = nested(
          ApplicationFailure.retryable(code, "Error"),
          depth,
        );
        expect(await intentStops(error)).toBe(depth <= 4);
        expect(await intentStops(encoded(error))).toBe(depth <= 4);
      }
    },
  );
  it.each(["code", "type", "name", "message"] as const)(
    "preserves intent budget tokens in %s",
    async (key) => {
      const error = Object.assign(new Error("dependency failure"), {
        [key]: "BUDGET_STORE_UNAVAILABLE",
      });
      expect(await intentStops(error)).toBe(true);
      expect(await intentStops(encoded(error))).toBe(true);
    },
  );
  it("new converter fallback stops both consumers, but ordinary dependency text cannot claim its type", async () => {
    const malformed = ApplicationFailure.retryable(
      "private diagnostic",
      "Error",
    );
    Object.defineProperty(malformed, "message", {
      get() {
        throw new Error("must not run");
      },
    });
    const fallback = encoded(malformed);
    expect(fallback).toMatchObject({ type: DIAGNOSTIC_FAILURE_TYPE });
    expect(await backlogStops(fallback)).toBe(true);
    expect(await intentStops(fallback)).toBe(true);
    const ordinary = ApplicationFailure.retryable(
      DIAGNOSTIC_FAILURE_MESSAGE,
      "Error",
    );
    expect(await backlogStops(encoded(ordinary))).toBe(false);
    expect(await intentStops(encoded(ordinary))).toBe(false);
  });
  it("promotes only conversion truncation to a root stop marker beyond either consumer depth limit", async () => {
    const deep = nested(
      ApplicationFailure.retryable("dependency failure", "Error"),
      40,
    );
    const result = encoded(deep);
    expect(result).toMatchObject({
      type: DIAGNOSTIC_FAILURE_TYPE,
      message: DIAGNOSTIC_FAILURE_MESSAGE,
    });
    expect(await backlogStops(result)).toBe(true);
    expect(await intentStops(result)).toBe(true);
  });
});
