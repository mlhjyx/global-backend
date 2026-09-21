import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { chmodSync } from "node:fs";
import { CapabilityRuntime } from "./platform-capability-runtime";
import { RuntimeReadinessContributorRegistry } from "../runtime/runtime-readiness-registry";
import type { RuntimeReleaseIdentity } from "../runtime/runtime-release-identity";
import { capabilityRuntimeFixture } from "./platform-capability-runtime.test-fixture";

describe("shared capability lifecycle fail-closed composition", () => {
  let fixture: Awaited<ReturnType<typeof capabilityRuntimeFixture>>;
  beforeAll(async () => {
    fixture = await capabilityRuntimeFixture();
  }, 15000);
  afterAll(async () => fixture?.close());
  beforeEach(() => {
    fixture.state.mode = "good";
    fixture.state.mints = 0;
    fixture.state.reads = 0;
    fixture.state.authorized = 0;
    fixture.state.factExpiry = Date.now() + 25000;
  });
  it("registers bounded schedule facts before bootstrap and unregisters on stop", async () => {
    const registry = new RuntimeReadinessContributorRegistry();
    const runtime = new CapabilityRuntime({
      registry,
      identity: { attested: false } as RuntimeReleaseIdentity,
      admitted: () => false,
      env: {},
    });
    expect(await registry.check("platform_acq_sweep_temporal_proof")).toEqual({
      status: "failed",
      code: "PLATFORM_CAPABILITY_UNAVAILABLE",
    });
    await runtime.refresh();
    expect(await registry.check("platform_acq_sweep_issuer")).toEqual({
      status: "failed",
      code: "PLATFORM_CAPABILITY_UNAVAILABLE",
    });
    runtime.start();
    runtime.stop();
    await runtime.refresh();
    expect(await registry.check("platform_acq_sweep_issuer")).toEqual({
      status: "failed",
      code: "READINESS_CONTRIBUTOR_MISSING",
    });
  });
  it("uses real mTLS bootstrap and dedicated signed HTTPS snapshots without aggregate readiness", async () => {
    const registry = new RuntimeReadinessContributorRegistry();
    const runtime = new CapabilityRuntime({
      registry,
      identity: fixture.identity,
      admitted: () => true,
      env: fixture.env,
    });
    try {
      await Promise.all([runtime.refresh(), runtime.refresh()]);
      expect({
        mints: fixture.state.mints,
        authorized: fixture.state.authorized,
        reads: fixture.state.reads,
      }).toEqual({ mints: 1, authorized: 1, reads: 1 });
      expect(await registry.check("platform_acq_sweep_temporal_proof")).toEqual(
        { status: "ok" },
      );
      expect(await registry.check("platform_intent_sweep_issuer")).toEqual({
        status: "ok",
      });
      expect(fixture.state.mints).toBe(1);
      expect(fixture.state.authorized).toBe(1);
      expect(fixture.state.reads).toBe(1);
      expect(fixture.state.lastNonce).toMatch(/^[a-f0-9]{32}$/);
      expect(fixture.state.bodyBytes).toBeLessThanOrEqual(4096);
      fixture.state.mode = "denied";
      await runtime.refresh();
      expect(
        (await registry.check("platform_acq_sweep_temporal_proof")).status,
      ).toBe("failed");
      fixture.state.mode = "good";
      await runtime.refresh();
      expect(
        (await registry.check("platform_acq_sweep_temporal_proof")).status,
      ).toBe("ok");
      fixture.state.mode = "enableDisabled";
      await runtime.refresh();
      expect(
        (await registry.check("platform_acq_sweep_temporal_proof")).status,
      ).toBe("failed");
    } finally {
      runtime.stop();
      fixture.state.mode = "good";
    }
  });
  it.each([
    "nonce",
    "crossFamily",
    "jwksFailure",
    "denied",
    "redirect",
    "type",
    "oversize",
    "enableDisabled",
  ])(
    "clears the previously valid fact on %s without another mint",
    async (mode) => {
      const registry = new RuntimeReadinessContributorRegistry();
      const runtime = new CapabilityRuntime({
        registry,
        identity: fixture.identity,
        admitted: () => true,
        env: fixture.env,
      });
      try {
        await runtime.refresh();
        expect((await registry.check("platform_acq_sweep_issuer")).status).toBe(
          "ok",
        );
        fixture.state.mode = mode;
        await runtime.refresh();
        expect((await registry.check("platform_acq_sweep_issuer")).status).toBe(
          "failed",
        );
        expect(fixture.state.mints).toBe(1);
      } finally {
        runtime.stop();
      }
    },
  );
  it("honors exact fact expiry independently of still-valid machine access token and does no IO on check", async () => {
    let testNow = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => testNow);
    const registry = new RuntimeReadinessContributorRegistry();
    const runtime = new CapabilityRuntime({
      registry,
      identity: fixture.identity,
      admitted: () => true,
      env: fixture.env,
    });
    try {
      await runtime.refresh();
      const calls = fixture.state.reads;
      testNow = fixture.state.factExpiry;
      expect(
        (await registry.check("platform_acq_sweep_revocation_delivery")).status,
      ).toBe("failed");
      expect(fixture.state.reads).toBe(calls);
      expect(fixture.state.mints).toBe(1);
    } finally {
      runtime.stop();
      now.mockRestore();
    }
  });
  it("closes immediately on source/config/file/admission changes and restart begins unknown", async () => {
    const registry = new RuntimeReadinessContributorRegistry();
    const env = { ...fixture.env };
    let admitted = true;
    const runtime = new CapabilityRuntime({
      registry,
      identity: fixture.identity,
      admitted: () => admitted,
      env,
    });
    try {
      await runtime.refresh();
      expect((await registry.check("platform_acq_sweep_issuer")).status).toBe(
        "ok",
      );
      env.PLATFORM_CAPABILITY_GROWTHOS_SHA = "f".repeat(40);
      expect((await registry.check("platform_acq_sweep_issuer")).status).toBe(
        "failed",
      );
      await runtime.refresh();
      expect((await registry.check("platform_acq_sweep_issuer")).status).toBe(
        "ok",
      );
      chmodSync(fixture.files.ca, 0o644);
      expect((await registry.check("platform_acq_sweep_issuer")).status).toBe(
        "failed",
      );
      chmodSync(fixture.files.ca, 0o600);
      await runtime.refresh();
      admitted = false;
      expect((await registry.check("platform_acq_sweep_issuer")).status).toBe(
        "failed",
      );
    } finally {
      chmodSync(fixture.files.ca, 0o600);
      runtime.stop();
    }
    const restarted = new CapabilityRuntime({
      registry,
      identity: fixture.identity,
      admitted: () => true,
      env: fixture.env,
    });
    try {
      expect((await registry.check("platform_acq_sweep_issuer")).status).toBe(
        "failed",
      );
    } finally {
      restarted.stop();
    }
  });
  it("bounds a slow response and stop prevents a late publication", async () => {
    const registry = new RuntimeReadinessContributorRegistry();
    const runtime = new CapabilityRuntime({
      registry,
      identity: fixture.identity,
      admitted: () => true,
      env: fixture.env,
    });
    try {
      fixture.state.mode = "slow";
      const started = performance.now();
      await runtime.refresh();
      expect(performance.now() - started).toBeLessThan(4500);
      expect((await registry.check("platform_acq_sweep_issuer")).status).toBe(
        "failed",
      );
      const pending = runtime.refresh();
      runtime.stop();
      await pending;
      expect((await registry.check("platform_acq_sweep_issuer")).code).toBe(
        "READINESS_CONTRIBUTOR_MISSING",
      );
    } finally {
      runtime.stop();
    }
  }, 8000);
  it.each([
    {},
    { PLATFORM_CAPABILITY_GROWTHOS_SHA: "bad" },
    { CAPABILITY_MACHINE_AUDIENCE: "wrong" },
    { PLATFORM_CAPABILITY_ORIGIN: "http://127.0.0.1/" },
  ])("keeps bad deployment configuration unavailable", async (delta) => {
    const registry = new RuntimeReadinessContributorRegistry();
    const runtime = new CapabilityRuntime({
      registry,
      identity: fixture.identity,
      admitted: () => true,
      env: Object.keys(delta).length ? { ...fixture.env, ...delta } : {},
    });
    try {
      await runtime.refresh();
      expect((await registry.check("platform_acq_sweep_issuer")).status).toBe(
        "failed",
      );
    } finally {
      runtime.stop();
    }
  });
  it("rolls back only its registrations when another producer already owns a fact", () => {
    const registry = new RuntimeReadinessContributorRegistry();
    const remove = registry.register("platform_acq_sweep_issuer", () => ({
      status: "ok",
    }));
    expect(
      () =>
        new CapabilityRuntime({
          registry,
          identity: fixture.identity,
          admitted: () => true,
          env: fixture.env,
        }),
    ).toThrow("already registered");
    remove();
  });
});
