import { afterEach, describe, expect, it, vi } from "vitest";
import { defer, firstValueFrom, Observable, of } from "rxjs";
import * as candidate from "./development-candidate";
import { CandidateOperationInterceptor } from "./development-candidate-operation.interceptor";

const WS = "10000000-0000-4000-8000-000000000001";
const EXPIRY = Date.parse("2026-11-16T14:00:00.000Z");
const context = {
  instanceId: "pump-ab",
  workspaceIds: [WS],
  validUntil: new Date(EXPIRY).toISOString(),
  authorizationSha256: "a".repeat(64),
};
const execution = {
  switchToHttp: () => ({
    getRequest: () => ({ requestContext: { workspaceId: WS } }),
  }),
} as never;
afterEach(() => vi.restoreAllMocks());
function fixture() {
  let now = EXPIRY - 1;
  const gate = new candidate.CandidateOperationGate(context, () => now);
  vi.spyOn(candidate, "runtimeCandidateContext").mockReturnValue(context);
  vi.spyOn(candidate, "runCandidateOperation").mockImplementation(
    (action, workspaceId) => gate.run(action, workspaceId),
  );
  return {
    gate,
    expire: () => {
      now = EXPIRY + 1;
    },
    interceptor: new CandidateOperationInterceptor(),
  };
}
describe("candidate HTTP operation scope", () => {
  it("retains admitted scope across asynchronous result persistence, then closes it", async () => {
    const f = fixture();
    const result = f.interceptor.intercept(execution, {
      handle: () =>
        defer(async () => {
          await Promise.resolve();
          f.expire();
          f.gate.assertTenant(WS);
          return "persisted";
        }),
    });
    await expect(firstValueFrom(result)).resolves.toBe("persisted");
    expect(() => f.gate.assertTenant(WS)).toThrow();
  });
  it("propagates the original controller error and closes the scope", async () => {
    const f = fixture();
    const failure = new Error("fixture failed");
    const result = f.interceptor.intercept(execution, {
      handle: () =>
        defer(async () => {
          f.expire();
          f.gate.assertTenant(WS);
          throw failure;
        }),
    });
    await expect(firstValueFrom(result)).rejects.toBe(failure);
    expect(() => f.gate.assertTenant(WS)).toThrow();
  });
  it("unsubscribe cannot leave an expired permission in async descendants", async () => {
    const f = fixture();
    let release!: () => void;
    let descendant!: Promise<void>;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = f.interceptor.intercept(execution, {
      handle: () =>
        new Observable(() => {
          descendant = delayed.then(() => f.gate.assertTenant(WS));
        }),
    });
    const subscription = result.subscribe();
    subscription.unsubscribe();
    await Promise.resolve();
    f.expire();
    release();
    await expect(descendant).rejects.toThrow();
  });
  it("ordinary releases keep the normal observable path", async () => {
    vi.spyOn(candidate, "runtimeCandidateContext").mockReturnValue(undefined);
    const run = vi.spyOn(candidate, "runCandidateOperation");
    await expect(
      firstValueFrom(
        new CandidateOperationInterceptor().intercept(execution, {
          handle: () => of("ordinary"),
        }),
      ),
    ).resolves.toBe("ordinary");
    expect(run).not.toHaveBeenCalled();
  });
});

it("rejecting an HTTP operation at entry never invokes the controller", async () => {
  vi.spyOn(candidate, "runtimeCandidateContext").mockReturnValue(context);
  const failure = new Error("admission expired");
  vi.spyOn(candidate, "runCandidateOperation").mockRejectedValue(failure);
  const handle = vi.fn(() => of("must not execute"));
  await expect(
    firstValueFrom(
      new CandidateOperationInterceptor().intercept(execution, { handle }),
    ),
  ).rejects.toBe(failure);
  expect(handle).not.toHaveBeenCalled();
});
