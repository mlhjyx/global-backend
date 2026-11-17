import { describe, expect, it } from "vitest";
import { CandidateOperationGate } from "./development-candidate";

const WS = "10000000-0000-4000-8000-000000000001";
const EXPIRY = Date.parse("2026-11-16T14:00:00.000Z");
const context = {
  instanceId: "pump-ab",
  workspaceIds: [WS],
  validUntil: new Date(EXPIRY).toISOString(),
  authorizationSha256: "a".repeat(64),
};
describe("candidate admission across async operation boundaries", () => {
  it("allows an already admitted operation to save its result during bounded drain, but blocks new work at expiry", async () => {
    let now = EXPIRY - 1;
    const gate = new CandidateOperationGate(context, () => now);
    await gate.run(async () => {
      now = EXPIRY + 1;
      await Promise.resolve();
      expect(() => gate.assertTenant(WS)).not.toThrow();
      await expect(gate.run(async () => "new work", WS)).rejects.toThrow();
      expect(() => gate.assertTenant("outside")).toThrow();
    }, WS);
    expect(() => gate.assertTenant(WS)).toThrow();
  });
  it("does not let async descendants retain a completed operation permission", async () => {
    let now = EXPIRY - 1;
    const gate = new CandidateOperationGate(context, () => now);
    let later!: () => void;
    const delayed = new Promise<void>((resolve) => {
      later = resolve;
    });
    let descendant!: Promise<void>;
    await gate.run(async () => {
      descendant = delayed.then(() => {
        gate.assertTenant(WS);
      });
    }, WS);
    now = EXPIRY + 1;
    later();
    await expect(descendant).rejects.toThrow();
  });
  it("binds a known HTTP/activity workspace and bounds the lifetime of its drain permission", async () => {
    let now = EXPIRY - 1;
    const gate = new CandidateOperationGate(
      { ...context, workspaceIds: [WS, "other-approved"] },
      () => now,
    );
    await gate.run(async () => {
      expect(() => gate.assertTenant("other-approved")).toThrow();
      now += 16 * 60_000;
      expect(() => gate.assertTenant(WS)).toThrow();
    }, WS);
  });
});
