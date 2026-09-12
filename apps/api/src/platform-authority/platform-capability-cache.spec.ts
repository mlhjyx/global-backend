import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type KeyLike,
} from "jose";
import { createCapabilityCache } from "./platform-capability-cache";
const NOW = 1_800_000_000_000;
let privateKey: KeyLike;
let publicJwk: JWK;
const expected = {
  issuer: "https://growthos.example.test",
  audience: "platform-automation-capability-read",
  backendSha: "b".repeat(40),
  growthosSha: "c".repeat(40),
  policyDigest: "d".repeat(64),
};
const schedules = [
  {
    scheduleId: "acq-sweep",
    workflowType: "acquisitionSweepWorkflow",
    taskQueue: "understanding",
    mode: "ENABLED",
  },
] as const;
let now = NOW;
const fact = () => ({ status: "ok", observedAt: NOW, validUntil: NOW + 1000 });
const config = () => ({
  expected,
  schedules,
  jwks: { keys: [publicJwk] },
  allowedKids: ["capability-1"],
});
async function token(nonce: string) {
  return new SignJWT({
    nonce,
    backendSha: expected.backendSha,
    growthosSha: expected.growthosSha,
    policyDigest: expected.policyDigest,
    namespace: "platform-automation",
    rows: schedules.map((row) => ({
      ...row,
      temporalPermission: fact(),
      issuer: fact(),
      revocationConsumer: fact(),
      undeliveredCount: 0,
      oldestUndeliveredCreatedAt: null,
    })),
  })
    .setProtectedHeader({
      alg: "RS256",
      kid: "capability-1",
      typ: "platform-capability+jwt",
    })
    .setIssuer(expected.issuer)
    .setAudience(expected.audience)
    .setIssuedAt(NOW / 1000)
    .setExpirationTime(NOW / 1000 + 30)
    .sign(privateKey);
}
beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  publicJwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "capability-1",
    alg: "RS256",
    use: "sig",
  };
});
afterEach(() => {
  now = NOW;
  vi.useRealTimers();
});
describe("verified capability cache lifecycle", () => {
  it("starts closed, opens only after verification, expires on underlying lease", async () => {
    const cache = createCapabilityCache(
      config(),
      async (nonce) => token(nonce),
      () => now,
    );
    expect(cache.check("acq-sweep").status).toBe("failed");
    await cache.refresh();
    expect(cache.check("acq-sweep").status).toBe("ok");
    now = NOW + 1000;
    expect(cache.check("acq-sweep").status).toBe("failed");
    cache.stop();
  });
  it("deduplicates concurrent refresh and clears previously good cache on failure", async () => {
    let fail = false;
    const transport = vi.fn(async (nonce: string) => {
      if (fail) throw new Error("secret");
      return token(nonce);
    });
    const cache = createCapabilityCache(config(), transport, () => now);
    const first = cache.refresh();
    expect(cache.refresh()).toBe(first);
    await first;
    expect(transport).toHaveBeenCalledTimes(1);
    fail = true;
    await cache.refresh();
    expect(cache.check("acq-sweep")).toEqual({
      status: "failed",
      code: "PLATFORM_CAPABILITY_UNAVAILABLE",
    });
    cache.stop();
  });
  it("rejects a replayed nonce response", async () => {
    let previous = "";
    const cache = createCapabilityCache(
      config(),
      async (nonce) => {
        if (previous) return previous;
        previous = await token(nonce);
        return previous;
      },
      () => now,
    );
    await cache.refresh();
    expect(cache.check("acq-sweep").status).toBe("ok");
    await cache.refresh();
    expect(cache.check("acq-sweep").status).toBe("failed");
    cache.stop();
  });
  it("bounds an unresponsive transport and aborts it", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const cache = createCapabilityCache(
      config(),
      (_nonce, s) => {
        signal = s;
        return new Promise(() => {});
      },
      () => now,
    );
    const pending = cache.refresh();
    await vi.advanceTimersByTimeAsync(3000);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(cache.check("acq-sweep").status).toBe("failed");
    cache.stop();
  });
  it("never republishes an in-flight result after stop", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = createCapabilityCache(
      config(),
      async (nonce) => {
        await gate;
        return token(nonce);
      },
      () => now,
    );
    const pending = cache.refresh();
    cache.stop();
    release();
    await pending;
    expect(cache.check("acq-sweep").status).toBe("failed");
  });
});

it("refreshes every ten seconds and stops all future refreshes", async () => {
  vi.useFakeTimers();
  const transport = vi.fn(async (nonce) => token(nonce));
  const cache = createCapabilityCache(config(), transport, () => now);
  cache.start();
  cache.start();
  await cache.refresh();
  expect(transport).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10000);
  await cache.refresh();
  expect(transport).toHaveBeenCalledTimes(2);
  cache.stop();
  await cache.refresh();
  await vi.advanceTimersByTimeAsync(30000);
  expect(transport).toHaveBeenCalledTimes(2);
});
it("rejects unknown schedules and clears cache after a clock rollback", async () => {
  const cache = createCapabilityCache(
    config(),
    async (nonce) => token(nonce),
    () => now,
  );
  await cache.refresh();
  expect(cache.check("unknown").status).toBe("failed");
  now = NOW - 1;
  expect(cache.check("acq-sweep").status).toBe("failed");
  now = NOW;
  expect(cache.check("acq-sweep").status).toBe("failed");
  cache.stop();
});
it("snapshots caller-owned trust configuration before asynchronous transport", async () => {
  const supplied = config();
  const cache = createCapabilityCache(
    supplied,
    async (nonce) => token(nonce),
    () => now,
  );
  supplied.allowedKids[0] = "attacker";
  supplied.jwks.keys.length = 0;
  await cache.refresh();
  expect(cache.check("acq-sweep").status).toBe("ok");
  cache.stop();
});

it("accepts a real signed non-whole-second observation and expires at the exact fact deadline", async () => {
  now = NOW + 500;
  const cache = createCapabilityCache(
    config(),
    async (nonce) => {
      const baseline = await token(nonce);
      const claims = JSON.parse(
        Buffer.from(baseline.split(".")[1], "base64url").toString("utf8"),
      );
      for (const field of [
        "temporalPermission",
        "issuer",
        "revocationConsumer",
      ]) {
        claims.rows[0][field].observedAt = NOW + 500;
        claims.rows[0][field].validUntil = NOW + 1000;
      }
      return new SignJWT(claims)
        .setProtectedHeader({
          alg: "RS256",
          kid: "capability-1",
          typ: "platform-capability+jwt",
        })
        .sign(privateKey);
    },
    () => now,
  );
  await cache.refresh();
  expect(cache.check("acq-sweep").status).toBe("ok");
  now = NOW + 1000;
  expect(cache.check("acq-sweep").status).toBe("failed");
  cache.stop();
});
