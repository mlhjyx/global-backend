import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PlatformTargetLookupService,
  PlatformTargetLookupInvalidError,
  PlatformTargetLookupNotFoundError,
  PlatformTargetLookupRateLimitedError,
  PlatformTargetLookupScopeMismatchError,
  PlatformTargetLookupUnavailableError,
  type PlatformTargetLookupInput,
} from "./platform-target-lookup.service";
import {
  PlatformTargetReaderDeniedError,
  PlatformTargetReaderUnavailableError,
  type VerifiedPlatformTargetReaderIdentity,
} from "./platform-target-reader-jwks-verifier";

const PATH = "/api/v1/platform-authority/target-lookup";
const SYNTHETIC_COMPACT_JWS = "test.header.signature";
const NOW = 1788830000;
const request = {
  target_issuer: "https://growthos.example/",
  target_jti: "22222222-2222-4222-8222-222222222222",
  schedule_id: "acq-sweep",
  workflow_run_id: "33333333-3333-4333-8333-333333333333",
  nonce: "0123456789abcdef0123456789abcdef",
};
const identity: VerifiedPlatformTargetReaderIdentity = Object.freeze({
  authenticationMode: "SERVICE_ONLY",
  issuer: "https://identity.example/",
  subject: "growthos:control-plane",
  targetIssuer: request.target_issuer,
  scope: "platform-authority.target.read",
});
function input(
  patch: Partial<PlatformTargetLookupInput> = {},
): PlatformTargetLookupInput {
  return {
    method: "POST",
    originalUrl: PATH,
    rawHeaders: [
      "Host",
      "backend.example",
      "Authorization",
      "Bearer " + SYNTHETIC_COMPACT_JWS,
      "Content-Type",
      "application/json",
    ],
    rawBody: Buffer.from(JSON.stringify(request)),
    ...patch,
  };
}
function setup() {
  let monotonic = 100;
  let admitted = true;
  const verifier = {
    verify: vi.fn(async (_token: string, _deadline: number) => identity),
  };
  const repository = {
    lookup: vi.fn(async (_request: unknown, _deadline: number) => true),
  };
  const limiter = {
    allow: vi.fn(async (_identity: unknown, _deadline: number) => true),
  };
  const admission = vi.fn(() => admitted);
  const service = new PlatformTargetLookupService({
    verifier,
    repository,
    limiter,
    admitted: admission,
    monotonicNow: () => monotonic,
    now: () => new Date(NOW * 1000),
  });
  return {
    service,
    verifier,
    repository,
    limiter,
    admission,
    advance: (value: number) => {
      monotonic = value;
    },
    revoke: () => {
      admitted = false;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("bounded target lookup HTTP core", () => {
  it("admits a 4096-byte request but refuses a valid multibyte tuple whose observation would exceed 4096 bytes", async () => {
    const state = setup();
    await expect(
      state.service.read(
        input({
          rawBody: Buffer.from(JSON.stringify(request).padEnd(4096, " ")),
        }),
      ),
    ).resolves.toMatchObject({ found: true });
    const oversized = {
      ...request,
      target_issuer: "https://growthos.example/" + "é".repeat(1890),
    };
    const rawBody = Buffer.from(JSON.stringify(oversized));
    expect(rawBody.length).toBeLessThanOrEqual(4096);
    state.verifier.verify.mockResolvedValue({
      ...identity,
      targetIssuer: oversized.target_issuer,
    });
    await expect(state.service.read(input({ rawBody }))).rejects.toBeInstanceOf(
      PlatformTargetLookupUnavailableError,
    );
  });

  it("returns only the exact nonce/tuple and server observation after purpose-bound identity, limit and read-only lookup", async () => {
    const state = setup();
    await expect(state.service.read(input())).resolves.toEqual({
      schema_version: "platform-authority-target-observation/v1",
      ...request,
      found: true,
      observed_at: NOW,
    });
    expect(state.verifier.verify).toHaveBeenCalledExactlyOnceWith(SYNTHETIC_COMPACT_JWS, 2100);
    expect(state.limiter.allow).toHaveBeenCalledExactlyOnceWith(
      {
        issuer: "https://identity.example/",
        subject: "growthos:control-plane",
      },
      2100,
    );
    expect(state.repository.lookup).toHaveBeenCalledExactlyOnceWith(
      request,
      2100,
    );
    expect(state.verifier.verify.mock.invocationCallOrder[0]).toBeLessThan(
      state.limiter.allow.mock.invocationCallOrder[0]!,
    );
    expect(state.limiter.allow.mock.invocationCallOrder[0]).toBeLessThan(
      state.repository.lookup.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    { method: "GET" },
    { method: "post" },
    { originalUrl: PATH + "?target=other" },
    { originalUrl: PATH + "/" },
    { originalUrl: "https://attacker.example" + PATH },
    { originalUrl: "/api/v1/platform-authority/%74arget-lookup" },
    { rawBody: Buffer.alloc(4097, 32) },
    { rawBody: Buffer.alloc(0) },
    { rawBody: Buffer.from([0xc0, 0xaf]) },
    { rawBody: Buffer.from("\ufeff" + JSON.stringify(request)) },
    {
      rawBody: Buffer.from(
        JSON.stringify({ ...request, workspace_id: "tenant" }),
      ),
    },
    { rawBody: Buffer.from(JSON.stringify({ ...request, target_jti: "bad" })) },
    {
      rawBody: Buffer.from(
        JSON.stringify({ ...request, nonce: "A".repeat(32) }),
      ),
    },
    { rawBody: Buffer.from(JSON.stringify({ ...request, nonce: 123 })) },
    { rawBody: Buffer.from(JSON.stringify(request) + "{}") },
    {
      rawBody: Buffer.from(
        JSON.stringify(request).replace('"nonce":', '"nonce":"wrong","nonce":'),
      ),
    },
    {
      rawBody: Buffer.from(
        JSON.stringify(request).replace(
          '"nonce":',
          '"n\\u006fnce":"wrong","nonce":',
        ),
      ),
    },
  ])(
    "rejects malformed/expanded raw input before verification or any lookup: %j",
    async (patch) => {
      const state = setup();
      await expect(state.service.read(input(patch))).rejects.toBeInstanceOf(
        PlatformTargetLookupInvalidError,
      );
      expect(state.verifier.verify).not.toHaveBeenCalled();
      expect(state.limiter.allow).not.toHaveBeenCalled();
      expect(state.repository.lookup).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "Authorization",
      "Bearer " + SYNTHETIC_COMPACT_JWS,
      "authorization",
      "Bearer " + SYNTHETIC_COMPACT_JWS,
      "Content-Type",
      "application/json",
    ],
    [
      "Authorization",
      "Bearer " + SYNTHETIC_COMPACT_JWS,
      "Content-Type",
      "application/json",
      "content-type",
      "application/json",
    ],
    [
      "Authorization",
      "Bearer " + SYNTHETIC_COMPACT_JWS,
      "Content-Type",
      "application/json",
      "Cookie",
      "session=secret",
    ],
    [
      "Authorization",
      "Bearer " + SYNTHETIC_COMPACT_JWS,
      "Content-Type",
      "application/json",
      "Content-Encoding",
      "gzip",
    ],
    [
      "Authorization",
      "Bearer " + SYNTHETIC_COMPACT_JWS,
      "Content-Type",
      "application/json",
      "Transfer-Encoding",
      "chunked",
    ],
    ["Authorization", "Bearer " + SYNTHETIC_COMPACT_JWS, "Content-Type", "text/plain"],
    [
      "Authorization",
      "Bearer " + SYNTHETIC_COMPACT_JWS,
      "Content-Type",
      "application/json; charset=iso-8859-1",
    ],
    [
      "Authorization",
      "Bearer " + SYNTHETIC_COMPACT_JWS,
      "Content-Type",
      "application/json; other=ignored",
    ],
    [
      "Authorization",
      "Bearer " + SYNTHETIC_COMPACT_JWS,
      "Content-Type",
      "application/json",
      "X-Header",
      "bad\r\ninjection",
    ],
    ["Bad Header", "value"],
    ["Odd"],
    Array.from({ length: 130 }, (_, index) => "x" + index),
    ["X-Large", "x".repeat(32769)],
    [
      "Authorization",
      "Bearer " + SYNTHETIC_COMPACT_JWS,
      "Content-Type",
      "application/json",
      "Content-Length",
      "1",
    ],
  ])(
    "rejects ambiguous/unbounded/encoded headers before dependencies: %j",
    async (rawHeaders) => {
      const state = setup();
      await expect(
        state.service.read(input({ rawHeaders })),
      ).rejects.toBeInstanceOf(PlatformTargetLookupInvalidError);
      expect(state.verifier.verify).not.toHaveBeenCalled();
      expect(state.repository.lookup).not.toHaveBeenCalled();
    },
  );

  it.each([
    "",
    "Basic secret",
    "Bearer",
    "Bearer ",
    "Bearer " + SYNTHETIC_COMPACT_JWS + "," + SYNTHETIC_COMPACT_JWS,
    "Bearer " + SYNTHETIC_COMPACT_JWS + " ",
    "Bearer " + "a".repeat(16385),
  ])(
    "rejects missing or malformed bearer %s without forwarding credentials",
    async (authorization) => {
      const state = setup();
      await expect(
        state.service.read(
          input({
            rawHeaders: [
              "Content-Type",
              "application/json",
              ...(authorization ? ["Authorization", authorization] : []),
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(PlatformTargetReaderDeniedError);
      expect(state.verifier.verify).not.toHaveBeenCalled();
      expect(state.repository.lookup).not.toHaveBeenCalled();
    },
  );

  it("accepts case-insensitive HTTP auth names/scheme and explicit identity/UTF-8 with exact length", async () => {
    const state = setup();
    const body = Buffer.from(JSON.stringify(request));
    await expect(
      state.service.read(
        input({
          rawBody: body,
          rawHeaders: [
            "aUtHoRiZaTiOn",
            "bEaReR " + SYNTHETIC_COMPACT_JWS,
            "CONTENT-TYPE",
            "application/json; charset=utf-8",
            "Content-Encoding",
            "identity",
            "Content-Length",
            String(body.length),
          ],
        }),
      ),
    ).resolves.toMatchObject({ found: true });
    expect(state.verifier.verify).toHaveBeenCalledWith(SYNTHETIC_COMPACT_JWS, 2100);
  });

  it("fails independent admission closed without consulting aggregate Worker readiness", async () => {
    const state = setup();
    state.revoke();
    await expect(state.service.read(input())).rejects.toBeInstanceOf(
      PlatformTargetLookupUnavailableError,
    );
    expect(state.verifier.verify).not.toHaveBeenCalled();
    expect(state.repository.lookup).not.toHaveBeenCalled();
  });

  it("preserves bounded authentication denial but treats unknown dependency diagnostics as unavailable", async () => {
    for (const error of [
      new PlatformTargetReaderDeniedError(),
      new PlatformTargetReaderUnavailableError(),
      new Error("must-not-leak:" + SYNTHETIC_COMPACT_JWS),
    ]) {
      const state = setup();
      state.verifier.verify.mockRejectedValue(error);
      const caught = await state.service.read(input()).catch((error) => error);
      expect(caught).toBeInstanceOf(
        error instanceof PlatformTargetReaderDeniedError
          ? PlatformTargetReaderDeniedError
          : PlatformTargetLookupUnavailableError,
      );
      expect(String(caught)).not.toContain(SYNTHETIC_COMPACT_JWS);
      expect(String(caught)).not.toContain("must-not-leak");
      expect(state.limiter.allow).not.toHaveBeenCalled();
      expect(state.repository.lookup).not.toHaveBeenCalled();
    }
  });

  it("rejects authenticated cross-issuer lookup before limiter/database", async () => {
    const state = setup();
    await expect(
      state.service.read(
        input({
          rawBody: Buffer.from(
            JSON.stringify({
              ...request,
              target_issuer: "https://other.example/",
            }),
          ),
        }),
      ),
    ).rejects.toBeInstanceOf(PlatformTargetLookupScopeMismatchError);
    expect(state.limiter.allow).not.toHaveBeenCalled();
    expect(state.repository.lookup).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { ...identity, authenticationMode: "USER" },
    { ...identity, scope: "platform-technical-quote.read" },
    { ...identity, issuer: "" },
    { ...identity, subject: 1 },
    { ...identity, targetIssuer: null },
  ])(
    "refuses malformed/future wrong-profile verifier output %j",
    async (result) => {
      const state = setup();
      state.verifier.verify.mockResolvedValue(
        result as VerifiedPlatformTargetReaderIdentity,
      );
      await expect(state.service.read(input())).rejects.toBeInstanceOf(
        PlatformTargetLookupUnavailableError,
      );
      expect(state.limiter.allow).not.toHaveBeenCalled();
      expect(state.repository.lookup).not.toHaveBeenCalled();
    },
  );

  it("separates rate-limited, not-found and unknown from found observations", async () => {
    const limited = setup();
    limited.limiter.allow.mockResolvedValue(false);
    await expect(limited.service.read(input())).rejects.toBeInstanceOf(
      PlatformTargetLookupRateLimitedError,
    );
    expect(limited.repository.lookup).not.toHaveBeenCalled();
    const absent = setup();
    absent.repository.lookup.mockResolvedValue(false);
    await expect(absent.service.read(input())).rejects.toBeInstanceOf(
      PlatformTargetLookupNotFoundError,
    );
    for (const boundary of ["limiter", "repository"] as const) {
      const state = setup();
      const mock =
        boundary === "limiter" ? state.limiter.allow : state.repository.lookup;
      mock.mockResolvedValue(undefined as unknown as boolean);
      await expect(state.service.read(input())).rejects.toBeInstanceOf(
        PlatformTargetLookupUnavailableError,
      );
      mock.mockRejectedValue(new Error("must-not-leak:" + SYNTHETIC_COMPACT_JWS));
      await expect(state.service.read(input())).rejects.toThrow(
        "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE",
      );
    }
  });

  it.each(["verifier", "limiter", "repository"] as const)(
    "does not progress or return success after a late %s result or revoked admission",
    async (boundary) => {
      for (const invalidate of ["deadline", "admission"]) {
        const state = setup();
        const invalidateState = () =>
          invalidate === "deadline" ? state.advance(2100) : state.revoke();
        if (boundary === "verifier")
          state.verifier.verify.mockImplementation(async () => {
            invalidateState();
            return identity;
          });
        if (boundary === "limiter")
          state.limiter.allow.mockImplementation(async () => {
            invalidateState();
            return true;
          });
        if (boundary === "repository")
          state.repository.lookup.mockImplementation(async () => {
            invalidateState();
            return true;
          });
        await expect(state.service.read(input())).rejects.toBeInstanceOf(
          PlatformTargetLookupUnavailableError,
        );
        if (boundary === "verifier")
          expect(state.limiter.allow).not.toHaveBeenCalled();
        if (boundary !== "repository")
          expect(state.repository.lookup).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["verifier", "limiter"] as const)(
    "actively ends a stalled %s and fences its eventual result from starting DB",
    async (boundary) => {
      vi.useFakeTimers();
      const state = setup();
      let finish!: () => void;
      if (boundary === "verifier")
        state.verifier.verify.mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = () => resolve(identity);
            }),
        );
      else
        state.limiter.allow.mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = () => resolve(true);
            }),
        );
      const pending = expect(
        state.service.read(input()),
      ).rejects.toBeInstanceOf(PlatformTargetLookupUnavailableError);
      await vi.advanceTimersByTimeAsync(2001);
      await pending;
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(state.repository.lookup).not.toHaveBeenCalled();
      if (boundary === "verifier")
        expect(state.limiter.allow).not.toHaveBeenCalled();
    },
  );

  it("keeps an immutable request snapshot through async verification and uses default server clocks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const state = setup();
    const received = input();
    state.verifier.verify.mockImplementation(async () => {
      received.rawBody.fill(32);
      return identity;
    });
    const service = new PlatformTargetLookupService({
      verifier: state.verifier,
      repository: state.repository,
      limiter: state.limiter,
      admitted: () => true,
    });
    const observation = await service.read(received);
    expect(observation).toEqual({
      schema_version: "platform-authority-target-observation/v1",
      ...request,
      found: true,
      observed_at: NOW,
    });
    expect(Object.isFrozen(state.repository.lookup.mock.calls[0]![0])).toBe(
      true,
    );
    expect(Object.isFrozen(observation)).toBe(true);
    expect(JSON.stringify(observation)).not.toContain(SYNTHETIC_COMPACT_JWS);
  });
});
