import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compactVerify, createLocalJWKSet, decodeJwt } from "jose";
import { PlatformRevocationTrustRuntime } from "./platform-revocation-trust.runtime";
import { PlatformRevocationHttpService } from "./platform-revocation-http.service";
import { revocationFixture } from "./platform-revocation-http.test-fixture";
import { PLATFORM_REVOCATION_HTTP_PATH } from "./platform-revocation-http.contract";
import type { StoredFenceAck } from "./platform-fence-ack-delivery.repository";
import type { AuthenticatedPlatformRevocation } from "./platform-revocation-verifier";
import type { PlatformRevocationReceipt } from "./platform-revocation.repository";

describe("HTTP recovery assembly keeps actual verifier/receiver/ACK crypto", () => {
  let fixture: Awaited<ReturnType<typeof revocationFixture>>;
  beforeAll(async () => {
    fixture = await revocationFixture();
  }, 15000);
  afterAll(async () => fixture?.close());
  function setup() {
    fixture.clock.now = fixture.claims.iat;
    const trust = new PlatformRevocationTrustRuntime(
      fixture.env,
      () => fixture.clock.now,
    );
    let saved: StoredFenceAck | null = null,
      receipt: PlatformRevocationReceipt | null = null;
    const control = {
      admitted: true,
      limited: false,
      loseResponse: false,
      generation: 0,
    };
    let abort = new AbortController();
    const revocations = {
      apply: vi.fn(async (command: AuthenticatedPlatformRevocation) => {
        if (receipt) return { ...receipt, replay: true };
        if (command.expired) throw new Error("PLATFORM_REVOCATION_EXPIRED");
        control.generation++;
        receipt = {
          receiptId: "44444444-4444-4444-8444-444444444444",
          generation: "1",
          committedAt: new Date(fixture.clock.now * 1000),
          inFlightAttempts: "0",
          replay: false,
        };
        return receipt;
      }),
    };
    const deliveries = {
      read: vi.fn(async () => saved),
      store: vi.fn(async (value: StoredFenceAck) => {
        saved ??= value;
        if (control.loseResponse) abort.abort();
        return saved;
      }),
    };
    const limiter = { allow: vi.fn(async () => !control.limited) };
    const service = new PlatformRevocationHttpService({
      trust,
      revocations,
      deliveries,
      limiter,
      admitted: () => control.admitted,
    });
    const receive = (token = fixture.command(), duration = 25000) => {
      abort = new AbortController();
      const startedAt = performance.now(),
        deadlineAt = startedAt + duration;
      const body = Buffer.from(token);
      return service.receive(
        {
          method: "POST",
          originalUrl: PLATFORM_REVOCATION_HTTP_PATH,
          rawHeaders: [
            "Content-Type",
            "application/jose",
            "Content-Length",
            String(body.length),
          ],
          rawBody: body,
        },
        {
          startedAt,
          deadlineAt,
          signal: abort.signal,
          body,
          assertActive() {
            if (abort.signal.aborted) throw new Error("ABORTED");
          },
        },
      );
    };
    return {
      service,
      receive,
      control,
      revocations,
      deliveries,
      limiter,
      trust,
      get saved() {
        return saved;
      },
    };
  }
  it("recovers byte-identical expired ACK after committed response loss without another fence", async () => {
    const state = setup();
    state.control.loseResponse = true;
    await expect(state.receive()).rejects.toThrow(
      "PLATFORM_REVOCATION_UNAVAILABLE",
    );
    expect(state.saved).not.toBeNull();
    expect(state.control.generation).toBe(1);
    const material = (await state.trust.open(new AbortController().signal))
      .material;
    const original = material.cipher.decrypt(state.saved!, state.saved!);
    fixture.clock.now += 301;
    state.control.loseResponse = false;
    const replay = await state.receive();
    expect(replay.token).toBe(original);
    expect(state.control.generation).toBe(1);
    expect(state.deliveries.store).toHaveBeenCalledTimes(1);
    await compactVerify(
      replay.token,
      createLocalJWKSet({ keys: [...material.jwks.keys] }),
      { algorithms: ["RS256"] },
    );
    expect(decodeJwt(replay.token).exp).toBeLessThanOrEqual(fixture.clock.now);
    expect(state.limiter.allow).toHaveBeenCalledWith(
      fixture.env.EXECUTION_BUDGET_GRANT_ISSUER,
    );
  });
  it("rejects wrong families, expired new commands, missing own admission and authenticated issuer limits before mutation", async () => {
    const state = setup();
    state.control.admitted = false;
    await expect(state.receive()).rejects.toThrow(
      "PLATFORM_REVOCATION_UNAVAILABLE",
    );
    expect(state.revocations.apply).not.toHaveBeenCalled();
    state.control.admitted = true;
    await expect(
      state.receive(
        fixture.command(fixture.claims, "execution-budget-grant+jwt"),
      ),
    ).rejects.toThrow("PLATFORM_REVOCATION_INVALID");
    expect(state.limiter.allow).not.toHaveBeenCalled();
    state.control.limited = true;
    await expect(state.receive()).rejects.toThrow(
      "PLATFORM_REVOCATION_RATE_LIMITED",
    );
    expect(state.revocations.apply).not.toHaveBeenCalled();
    state.control.limited = false;
    fixture.clock.now += 301;
    await expect(state.receive()).rejects.toThrow(
      "PLATFORM_REVOCATION_EXPIRED",
    );
    expect(state.control.generation).toBe(0);
    expect(state.deliveries.read).not.toHaveBeenCalled();
  });
  it("rejects elapsed and oversized deadline scopes without starting a transaction", async () => {
    const state = setup();
    await expect(state.receive(fixture.command(), 0)).rejects.toThrow(
      "PLATFORM_REVOCATION_UNAVAILABLE",
    );
    await expect(state.receive(fixture.command(), 25001)).rejects.toThrow(
      "PLATFORM_REVOCATION_UNAVAILABLE",
    );
    expect(state.revocations.apply).not.toHaveBeenCalled();
  });
  it("shutdown rejects an in-flight request and does not resume writes after its dependency resolves", async () => {
    const state = setup();
    let release!: (value: boolean) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    state.limiter.allow.mockImplementationOnce(() => {
      entered();
      return new Promise<boolean>((resolve) => {
        release = resolve;
      });
    });
    const pending = state.receive();
    const rejected = expect(pending).rejects.toThrow(
      "PLATFORM_REVOCATION_UNAVAILABLE",
    );
    await started;
    state.service.onModuleDestroy();
    await rejected;
    release(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.revocations.apply).not.toHaveBeenCalled();
    await expect(state.receive()).rejects.toThrow(
      "PLATFORM_REVOCATION_UNAVAILABLE",
    );
  });
});
