import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PlatformTargetReaderJwksVerifier,
  PlatformTargetReaderDeniedError,
  PlatformTargetReaderUnavailableError,
} from "./platform-target-reader-jwks-verifier";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "identity-current",
  alg: "RS256",
  use: "sig",
};
const rotation = {
  ...other.publicKey.export({ format: "jwk" }),
  kid: "identity-previous",
  alg: "RS256",
  use: "sig",
};
const NOW = 1788830000;
const env = {
  PLATFORM_AUTHORITY_TARGET_READER_JWKS_URI:
    "https://growthos.example/.well-known/jwks.json",
  PLATFORM_AUTHORITY_TARGET_READER_ISSUER: "https://growthos.example/",
  PLATFORM_AUTHORITY_TARGET_READER_SUBJECT: "growthos:control-plane",
  PLATFORM_AUTHORITY_TARGET_READER_TARGET_ISSUER:
    "https://growthos-grants.example/",
};
const claims = {
  iss: env.PLATFORM_AUTHORITY_TARGET_READER_ISSUER,
  aud: "global-backend:platform-authority-target-read",
  sub: env.PLATFORM_AUTHORITY_TARGET_READER_SUBJECT,
  scope: "platform-authority.target.read",
  jti: "11111111-1111-4111-8111-111111111111",
  iat: NOW,
  nbf: NOW,
  exp: NOW + 300,
};
const header = {
  alg: "RS256",
  kid: jwk.kid,
  typ: "platform-authority-target-reader+jwt",
};
function raw(
  payload: string | Buffer,
  protectedHeader: string | Buffer = JSON.stringify(header),
  key = pair.privateKey,
): string {
  const input =
    Buffer.from(protectedHeader).toString("base64url") +
    "." +
    Buffer.from(payload).toString("base64url");
  return (
    input +
    "." +
    sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")
  );
}
const token = (patch = {}, head = {}) =>
  raw(
    JSON.stringify({ ...claims, ...patch }),
    JSON.stringify({ ...header, ...head }),
  );
const response = (
  body: string = JSON.stringify({ keys: [jwk, rotation] }),
  status = 200,
  contentType = "application/jwk-set+json",
) => new Response(body, { status, headers: { "content-type": contentType } });
const fetcher = () => vi.fn<typeof fetch>(async () => response());
const verifier = (
  fetcher: typeof fetch,
  config: NodeJS.ProcessEnv = env,
  dependencies = {},
) =>
  new PlatformTargetReaderJwksVerifier(config, {
    fetcher,
    now: () => new Date(NOW * 1000),
    monotonicNow: () => 100,
    ...dependencies,
  });
afterEach(() => vi.useRealTimers());

describe("target reader public trust readiness", () => {
  it("validates the actual public keyset and fixed configuration without verifying or minting a token", async () => {
    const pull = fetcher();
    const subject = verifier(pull);
    const authenticate = vi.spyOn(subject, "verify");
    await expect(subject.readiness(2100)).resolves.toBe(true);
    expect(authenticate).not.toHaveBeenCalled();
    expect(pull).toHaveBeenCalledExactlyOnceWith(
      env.PLATFORM_AUTHORITY_TARGET_READER_JWKS_URI,
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(pull.mock.calls[0]![1]!.headers).toEqual({
      Accept: "application/jwk-set+json, application/json",
    });
    pull.mockResolvedValueOnce(response('{"keys":[]}'));
    await expect(subject.readiness(2100)).resolves.toBe(false);
    expect(pull).toHaveBeenCalledTimes(2);
  });
  it("returns false without network for missing identity/trust or invalid caller allocation", async () => {
    for (const name of Object.keys(env)) {
      const pull = fetcher();
      await expect(
        verifier(pull, { ...env, [name]: "" }).readiness(2100),
      ).resolves.toBe(false);
      expect(pull).not.toHaveBeenCalled();
    }
    const pull = fetcher();
    await expect(
      verifier(pull, {
        ...env,
        PLATFORM_AUTHORITY_TARGET_READER_JWKS_URI: "http://127.0.0.1/jwks",
      }).readiness(2100),
    ).resolves.toBe(false);
    for (const deadline of [NaN, Infinity, 100, 2101])
      await expect(verifier(pull).readiness(deadline)).resolves.toBe(false);
    expect(pull).not.toHaveBeenCalled();
  });
  it("never treats redirected, private, duplicate, oversized or unavailable JWKS as ready", async () => {
    for (const result of [
      response("redirect", 302),
      response(JSON.stringify({ keys: [{ ...jwk, d: "AA" }] })),
      response(JSON.stringify({ keys: [jwk, jwk] })),
      response(" ".repeat(65537)),
    ])
      await expect(verifier(async () => result).readiness(2100)).resolves.toBe(
        false,
      );
    await expect(
      verifier(async () => {
        throw new Error("must-not-leak");
      }).readiness(2100),
    ).resolves.toBe(false);
  });
  it("uses the same absolute deadline and cancels a fulfilled response that arrives after readiness timed out", async () => {
    vi.useFakeTimers();
    let resolveFetch!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    const subject = verifier(async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });
    const pending = subject.readiness(120);
    await vi.advanceTimersByTimeAsync(21);
    await expect(pending).resolves.toBe(false);
    expect(signal?.aborted).toBe(true);
    const cancel = vi.fn();
    resolveFetch(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("discards a valid keyset when retrieval consumes the remaining budget", async () => {
    let tick = 100;
    const subject = verifier(
      async () => {
        tick = 2100;
        return response();
      },
      env,
      { monotonicNow: () => tick },
    );
    await expect(subject.readiness(2100)).resolves.toBe(false);
  });
});

describe("fixed-purpose target reader authentication", () => {
  it("rechecks expiry after the final async completion boundary before returning identity", async () => {
    let wall = NOW;
    let reads = 0;
    const subject = verifier(fetcher(), env, {
      now: () => {
        reads += 1;
        if (reads === 2)
          queueMicrotask(() => {
            wall = NOW + 300;
          });
        return new Date(wall * 1000);
      },
    });
    await expect(subject.verify(token(), 2100)).rejects.toBeInstanceOf(
      PlatformTargetReaderDeniedError,
    );
  });

  it("uses real default clocks and preserves configured loopback issuer identifiers without HTTP JWKS", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const config = {
      ...env,
      PLATFORM_AUTHORITY_TARGET_READER_ISSUER: "http://127.0.0.1:18081",
      PLATFORM_AUTHORITY_TARGET_READER_TARGET_ISSUER: "http://localhost:18081",
    };
    const subject = new PlatformTargetReaderJwksVerifier(config, {
      fetcher: fetcher(),
    });
    await expect(
      subject.verify(
        token({ iss: config.PLATFORM_AUTHORITY_TARGET_READER_ISSUER }),
        performance.now() + 2000,
      ),
    ).resolves.toMatchObject({
      issuer: "http://127.0.0.1:18081",
      targetIssuer: "http://localhost:18081",
    });
  });

  it("rejects a duplicated RSA public key even if its modulus has another leading-zero representation", async () => {
    const duplicated = {
      ...jwk,
      kid: "same-key-other-spelling",
      n: Buffer.concat([
        Buffer.from([0]),
        Buffer.from(jwk.n!, "base64url"),
      ]).toString("base64url"),
    };
    await expect(
      verifier(async () =>
        response(JSON.stringify({ keys: [jwk, duplicated] })),
      ).verify(token(), 2100),
    ).rejects.toBeInstanceOf(PlatformTargetReaderUnavailableError);
  });

  it("does not start JWKS work when parsing exhausts the supplied allocation", async () => {
    let checks = 0;
    const pull = fetcher();
    await expect(
      verifier(pull, env, {
        monotonicNow: () => (checks++ === 0 ? 100 : 120),
      }).verify(token(), 120),
    ).rejects.toBeInstanceOf(PlatformTargetReaderUnavailableError);
    expect(pull).not.toHaveBeenCalled();
  });

  it("cancels a stalled body and a late response after the deadline has already rejected", async () => {
    vi.useFakeTimers();
    const bodyCancelled = vi.fn();
    const pendingBody = new Response(
      new ReadableStream({ cancel: bodyCancelled }),
      { headers: { "content-type": "application/json" } },
    );
    const bodyFailure = expect(
      verifier(async () => pendingBody).verify(token(), 120),
    ).rejects.toBeInstanceOf(PlatformTargetReaderUnavailableError);
    await vi.advanceTimersByTimeAsync(21);
    await bodyFailure;
    expect(bodyCancelled).toHaveBeenCalledOnce();
    let resolveFetch!: (response: Response) => void;
    const lateCancelled = vi.fn();
    const failure = expect(
      verifier(
        async () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ).verify(token(), 120),
    ).rejects.toBeInstanceOf(PlatformTargetReaderUnavailableError);
    await vi.advanceTimersByTimeAsync(21);
    await failure;
    resolveFetch(
      new Response(new ReadableStream({ cancel: lateCancelled }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(lateCancelled).toHaveBeenCalledOnce();
  });

  it("verifies real current/rotation signatures and returns only the server-owned issuer mapping", async () => {
    const pull = fetcher();
    const subject = verifier(pull);
    for (const compact of [
      token(),
      raw(
        JSON.stringify(claims),
        JSON.stringify({ ...header, kid: rotation.kid }),
        other.privateKey,
      ),
    ]) {
      await expect(subject.verify(compact, 2100)).resolves.toEqual({
        authenticationMode: "SERVICE_ONLY",
        issuer: env.PLATFORM_AUTHORITY_TARGET_READER_ISSUER,
        subject: "growthos:control-plane",
        targetIssuer: "https://growthos-grants.example/",
        scope: "platform-authority.target.read",
      });
    }
    expect(pull).toHaveBeenCalledWith(
      env.PLATFORM_AUTHORITY_TARGET_READER_JWKS_URI,
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(JSON.stringify(pull.mock.calls)).not.toContain(token());
  });
  it.each([
    { aud: "global-backend" },
    { aud: "global-backend:platform-technical-quote" },
    { aud: [claims.aud] },
    { scope: "platform-technical-quote.read" },
    { scope: claims.scope + " admin" },
    { sub: "user:admin" },
    { iss: "https://other.example/" },
    { target_issuer: "https://attacker.example/" },
    { role: "ADMIN" },
    { exp: NOW },
    { exp: NOW - 1 },
    { exp: NOW + 301 },
    { iat: NOW + 61, nbf: NOW + 61 },
    { nbf: NOW + 301 },
    { iat: -1 },
    { iat: 1.5 },
    { jti: "bad" },
    { exp: Number.MAX_SAFE_INTEGER + 1 },
  ])(
    "denies signed but unbound/expired claims before JWKS: %j",
    async (patch) => {
      const pull = fetcher();
      await expect(
        verifier(pull).verify(token(patch), 2100),
      ).rejects.toBeInstanceOf(PlatformTargetReaderDeniedError);
      expect(pull).not.toHaveBeenCalled();
    },
  );
  it.each([
    { typ: "global-backend-access+jwt" },
    { typ: "platform-technical-quote-access+jwt" },
    { typ: "execution-budget-authority-revocation+jwt" },
    { typ: "platform-authority-fence-ack+jwt" },
    { typ: "platform-capability+jwt" },
    { typ: "execution-budget-grant+jwt" },
    { alg: "HS256" },
    { alg: "none" },
    { kid: "" },
    { kid: "a".repeat(129) },
    { kid: "a b" },
    { jku: "https://attacker.example/" },
    { x5u: "https://attacker.example/" },
    { crit: ["new"] },
  ])(
    "denies every other header purpose/algorithm and caller-selected trust: %j",
    async (patch) => {
      const pull = fetcher();
      await expect(
        verifier(pull).verify(token({}, patch), 2100),
      ).rejects.toBeInstanceOf(PlatformTargetReaderDeniedError);
      expect(pull).not.toHaveBeenCalled();
    },
  );
  it("accepts future skew at exactly 60 seconds but not strict expiry equality", async () => {
    await expect(
      verifier(fetcher()).verify(
        token({ iat: NOW + 60, nbf: NOW + 60, exp: NOW + 360 }),
        2100,
      ),
    ).resolves.toBeDefined();
    await expect(
      verifier(fetcher()).verify(token({ exp: NOW }), 2100),
    ).rejects.toBeInstanceOf(PlatformTargetReaderDeniedError);
  });
  it("rejects corrupted signatures, unknown kid and real other key under the trusted kid", async () => {
    const valid = token();
    const parts = valid.split(".");
    const bytes = Buffer.from(parts[2]!, "base64url");
    bytes[0] ^= 1;
    await expect(
      verifier(fetcher()).verify(
        parts[0] + "." + parts[1] + "." + bytes.toString("base64url"),
        2100,
      ),
    ).rejects.toBeInstanceOf(PlatformTargetReaderDeniedError);
    await expect(
      verifier(fetcher()).verify(token({}, { kid: "unpublished" }), 2100),
    ).rejects.toBeInstanceOf(PlatformTargetReaderUnavailableError);
    await expect(
      verifier(fetcher()).verify(
        raw(JSON.stringify(claims), JSON.stringify(header), other.privateKey),
        2100,
      ),
    ).rejects.toBeInstanceOf(PlatformTargetReaderDeniedError);
  });
  it("rejects duplicate decoded keys, invalid UTF-8/BOM, unsafe integers, extra JSON and oversized compact wire", async () => {
    const body = JSON.stringify(claims);
    for (const compact of [
      raw(body.replace('"aud":', '"aud":"wrong","aud":')),
      raw(body.replace('"sub":', '"s\\u0075b":"wrong","sub":')),
      raw(
        body,
        JSON.stringify(header).replace('"kid":', '"kid":"other","kid":'),
      ),
      raw(Buffer.from([0xc0, 0xaf])),
      raw("\ufeff" + body),
      raw(body + "{}"),
      raw(body.replace('"iat":' + NOW, '"iat":1e2')),
      raw(body.replace('"iat":' + NOW, '"iat":9007199254740993')),
      raw(body.replace('"sub":"growthos:control-plane"', '"sub":"\\ud800"')),
      " " + token(),
      token() + "=",
      "abc.def",
      "a".repeat(16385),
    ])
      await expect(
        verifier(fetcher()).verify(compact, 2100),
      ).rejects.toBeInstanceOf(PlatformTargetReaderDeniedError);
  });
  it.each([
    "http://127.0.0.1:123/jwks",
    "http://localhost/jwks",
    "ftp://growthos.example/jwks",
    "https://user:pass@growthos.example/jwks",
    "https://growthos.example/jwks?root=x",
    "https://growthos.example/jwks#root",
    "not-a-url",
    "",
  ])(
    "never admits insecure/configurable trust URI %s in any managed environment",
    async (uri) => {
      for (const APP_ENVIRONMENT of ["test", "development", "production"]) {
        const pull = fetcher();
        await expect(
          verifier(pull, {
            ...env,
            APP_ENVIRONMENT,
            PLATFORM_AUTHORITY_TARGET_READER_JWKS_URI: uri,
          }).verify(token(), 2100),
        ).rejects.toBeInstanceOf(PlatformTargetReaderUnavailableError);
        expect(pull).not.toHaveBeenCalled();
      }
    },
  );
  it("fails closed on missing/malformed fixed identity configuration", async () => {
    for (const name of Object.keys(env)) {
      const pull = fetcher();
      await expect(
        verifier(pull, { ...env, [name]: "" }).verify(token(), 2100),
      ).rejects.toBeInstanceOf(PlatformTargetReaderUnavailableError);
      expect(pull).not.toHaveBeenCalled();
    }
  });
  it("rejects duplicate/private/weak/unbounded JWKS and malformed response encoding", async () => {
    const document = JSON.stringify({ keys: [jwk] });
    for (const body of [
      JSON.stringify({ keys: [jwk, jwk] }),
      JSON.stringify({ keys: [jwk, { ...jwk, kid: "duplicate-material" }] }),
      JSON.stringify({ keys: [{ ...jwk, d: "AA" }] }),
      JSON.stringify({ keys: [{ ...jwk, n: "AQAB" }] }),
      JSON.stringify({ keys: [{ ...jwk, alg: "RS512" }] }),
      JSON.stringify({ keys: [{ ...jwk, use: "enc" }] }),
      JSON.stringify({ keys: [] }),
      JSON.stringify({ keys: [jwk, rotation, jwk, rotation] }),
      document.replace('"keys":', '"keys":[],"keys":'),
      document.replace('"kid":', '"kid":"bad","kid":'),
      document.replace('"kid":', '"k\\u0069d":"bad","kid":'),
      document + "{}",
      "\ufeff" + document,
      " ".repeat(65537),
    ])
      await expect(
        verifier(async () => response(body)).verify(token(), 2100),
      ).rejects.toBeInstanceOf(PlatformTargetReaderUnavailableError);
    for (const result of [
      response("redirect", 302),
      response("not json", 200, "text/plain"),
      new Response(Buffer.from([0xc0, 0xaf]), {
        headers: { "content-type": "application/json" },
      }),
    ])
      await expect(
        verifier(async () => result).verify(token(), 2100),
      ).rejects.toBeInstanceOf(PlatformTargetReaderUnavailableError);
    await expect(
      verifier(async () => {
        throw new Error("TLS certificate must-not-leak");
      }).verify(token(), 2100),
    ).rejects.toThrow("PLATFORM_TARGET_READER_UNAVAILABLE");
  });
  it("rechecks expiration and remaining caller budget after asynchronous key retrieval", async () => {
    let wall = NOW;
    let monotonic = 100;
    const deps = {
      now: () => new Date(wall * 1000),
      monotonicNow: () => monotonic,
    };
    await expect(
      verifier(
        async () => {
          wall = NOW + 300;
          return response();
        },
        env,
        deps,
      ).verify(token(), 2100),
    ).rejects.toBeInstanceOf(PlatformTargetReaderDeniedError);
    wall = NOW;
    await expect(
      verifier(
        async () => {
          monotonic = 2100;
          return response();
        },
        env,
        deps,
      ).verify(token(), 2100),
    ).rejects.toBeInstanceOf(PlatformTargetReaderUnavailableError);
  });
  it("rejects absent/expired/oversized deadline allocation before network", async () => {
    for (const deadline of [NaN, Infinity, 100, 99, 2101]) {
      const pull = fetcher();
      await expect(
        verifier(pull).verify(token(), deadline),
      ).rejects.toBeInstanceOf(PlatformTargetReaderUnavailableError);
      expect(pull).not.toHaveBeenCalled();
    }
  });
  it("actively bounds stalled fetch and aborts the caller allocation without authorizing later completion", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = verifier(async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise(() => {});
    }).verify(token(), 120);
    const denied = expect(pending).rejects.toBeInstanceOf(
      PlatformTargetReaderUnavailableError,
    );
    await vi.advanceTimersByTimeAsync(21);
    await denied;
    expect(signal?.aborted).toBe(true);
  });
});
