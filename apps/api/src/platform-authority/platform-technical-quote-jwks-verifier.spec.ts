import { CompactSign, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK, KeyLike } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  PLATFORM_TECHNICAL_QUOTE_READER_PRINCIPAL,
  PLATFORM_TECHNICAL_QUOTE_READ_SCOPE,
  PlatformTechnicalQuoteServiceAuthenticationDeniedError,
  PlatformTechnicalQuoteServiceAuthenticationUnavailableError,
  type PlatformTechnicalQuoteServiceAuthenticationRequest,
} from "./platform-technical-quote-service-auth";
import {
  JwksPlatformTechnicalQuoteServiceAuthenticationVerifier,
  validatePlatformTechnicalQuoteJwksVerifierConfiguration,
} from "./platform-technical-quote-jwks-verifier";

const NOW = new Date("2026-09-05T12:00:00.500Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const ISSUER = "https://growthos.example.test/";
const AUDIENCE = "global-backend:platform-technical-quote";
const TOKEN_TYPE = "platform-technical-quote-access+jwt";
const JTI = "aaaaaaaa-1111-4111-8111-111111111111";
const TEST_ENV = Object.freeze({
  APP_ENVIRONMENT: "test",
  NODE_ENV: "test",
  PLATFORM_TECHNICAL_QUOTE_AUTH_JWKS_URI:
    "https://growthos.example.test/.well-known/jwks.json",
  PLATFORM_TECHNICAL_QUOTE_AUTH_ISSUER: ISSUER,
});

interface SigningKey {
  readonly kid: string;
  readonly privateKey: KeyLike;
  readonly publicJwk: JWK;
}

let currentKey: SigningKey;
let rotationKey: SigningKey;
let unknownKey: SigningKey;

async function signingKey(kid: string): Promise<SigningKey> {
  const pair = await generateKeyPair("RS256");
  return Object.freeze({
    kid,
    privateKey: pair.privateKey,
    publicJwk: Object.freeze({
      ...(await exportJWK(pair.publicKey)),
      alg: "RS256",
      use: "sig",
      kid,
    }),
  });
}

beforeAll(async () => {
  [currentKey, rotationKey, unknownKey] = await Promise.all([
    signingKey("identity-current"),
    signingKey("identity-verify-only"),
    signingKey("identity-unknown"),
  ]);
});

interface TokenOptions {
  readonly key?: SigningKey;
  readonly header?: Readonly<Record<string, unknown>>;
  readonly claims?: Readonly<Record<string, unknown>>;
}

function validClaims(): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: PLATFORM_TECHNICAL_QUOTE_READER_PRINCIPAL,
    scope: PLATFORM_TECHNICAL_QUOTE_READ_SCOPE,
    jti: JTI,
    iat: NOW_SECONDS,
    nbf: NOW_SECONDS,
    exp: NOW_SECONDS + 300,
  };
}

async function signedToken(options: TokenOptions = {}): Promise<string> {
  const key = options.key ?? currentKey;
  return new SignJWT({ ...validClaims(), ...options.claims })
    .setProtectedHeader({
      alg: "RS256",
      kid: key.kid,
      typ: TOKEN_TYPE,
      ...options.header,
    })
    .sign(key.privateKey);
}

async function signedRawPayload(
  rawPayload: string,
  key: SigningKey = currentKey,
): Promise<string> {
  return new CompactSign(Buffer.from(rawPayload, "utf8"))
    .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: TOKEN_TYPE })
    .sign(key.privateKey);
}

function compact(
  protectedHeader: string | Uint8Array,
  payload: string | Uint8Array,
  signature = "AA",
): string {
  const headerBytes =
    typeof protectedHeader === "string"
      ? Buffer.from(protectedHeader, "utf8")
      : Buffer.from(protectedHeader);
  const payloadBytes =
    typeof payload === "string"
      ? Buffer.from(payload, "utf8")
      : Buffer.from(payload);
  return `${headerBytes.toString("base64url")}.${payloadBytes.toString("base64url")}.${signature}`;
}

function request(
  token: string,
): PlatformTechnicalQuoteServiceAuthenticationRequest {
  return Object.freeze({
    method: "POST" as const,
    normalizedPath: "/api/v1/platform-authority/technical-quote" as const,
    headers: Object.freeze({ authorization: `Bearer ${token}` }),
  });
}

function jwksFetcher(
  document: () => unknown,
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(document()), {
        status: 200,
        headers: { "Content-Type": "application/jwk-set+json" },
      }),
  );
}

function verifier(
  fetcher: typeof fetch,
  env: NodeJS.ProcessEnv = TEST_ENV,
): JwksPlatformTechnicalQuoteServiceAuthenticationVerifier {
  return new JwksPlatformTechnicalQuoteServiceAuthenticationVerifier(env, {
    fetcher,
    now: () => NOW,
  });
}

async function denied(
  subject: JwksPlatformTechnicalQuoteServiceAuthenticationVerifier,
  token: string,
): Promise<void> {
  const error = await subject
    .verify(request(token))
    .then(() => undefined)
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(
    PlatformTechnicalQuoteServiceAuthenticationDeniedError,
  );
  expect(JSON.stringify(error)).not.toContain(token);
}

async function unavailable(
  subject: JwksPlatformTechnicalQuoteServiceAuthenticationVerifier,
  token: string,
): Promise<void> {
  const error = await subject
    .verify(request(token))
    .then(() => undefined)
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(
    PlatformTechnicalQuoteServiceAuthenticationUnavailableError,
  );
  expect(JSON.stringify(error)).not.toContain(token);
}

describe("JwksPlatformTechnicalQuoteServiceAuthenticationVerifier", () => {
  it("accepts current and verify-only identity keys as one fixed service identity", async () => {
    const subject = verifier(
      jwksFetcher(() => ({
        keys: [currentKey.publicJwk, rotationKey.publicJwk],
      })),
    );

    await expect(subject.readiness()).resolves.toEqual({
      status: "ready",
      code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READY",
    });
    for (const key of [currentKey, rotationKey]) {
      await expect(
        subject.verify(request(await signedToken({ key }))),
      ).resolves.toEqual({
        authenticationMode: "SERVICE_ONLY",
        principalId: PLATFORM_TECHNICAL_QUOTE_READER_PRINCIPAL,
        scopes: [PLATFORM_TECHNICAL_QUOTE_READ_SCOPE],
      });
    }
  });

  it("does not let environment values redefine the fixed service token profile", async () => {
    const subject = verifier(
      jwksFetcher(() => ({ keys: [currentKey.publicJwk] })),
      {
        ...TEST_ENV,
        PLATFORM_TECHNICAL_QUOTE_AUTH_AUDIENCE: "attacker-audience",
        PLATFORM_TECHNICAL_QUOTE_AUTH_TYPE: "attacker+jwt",
        PLATFORM_TECHNICAL_QUOTE_AUTH_SUBJECT: "attacker",
        PLATFORM_TECHNICAL_QUOTE_AUTH_SCOPE: "platform-authority.issue",
        PLATFORM_TECHNICAL_QUOTE_AUTH_ALGORITHMS: "none,HS256",
      },
    );
    await expect(subject.verify(request(await signedToken()))).resolves.toEqual(
      {
        authenticationMode: "SERVICE_ONLY",
        principalId: PLATFORM_TECHNICAL_QUOTE_READER_PRINCIPAL,
        scopes: [PLATFORM_TECHNICAL_QUOTE_READ_SCOPE],
      },
    );
  });

  it("refreshes once for a rotated kid and fails closed when it remains unknown", async () => {
    let keys: readonly JWK[] = [currentKey.publicJwk];
    const fetcher = jwksFetcher(() => ({ keys }));
    const subject = verifier(fetcher);
    await expect(
      subject.verify(request(await signedToken({ key: currentKey }))),
    ).resolves.toBeDefined();

    keys = [currentKey.publicJwk, rotationKey.publicJwk];
    await expect(
      subject.verify(request(await signedToken({ key: rotationKey }))),
    ).resolves.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);

    await unavailable(subject, await signedToken({ key: unknownKey }));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("maps absent, unreachable and malformed trust configuration to stable unavailable", async () => {
    const missing = verifier(
      jwksFetcher(() => ({ keys: [] })),
      {},
    );
    await expect(missing.readiness()).resolves.toEqual({
      status: "not_ready",
      code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE",
    });
    await unavailable(missing, await signedToken());

    const networkFailure = verifier(
      vi.fn<typeof fetch>(async () => {
        throw new Error("secret upstream detail");
      }),
    );
    await expect(networkFailure.readiness()).resolves.toEqual({
      status: "not_ready",
      code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE",
    });
    await unavailable(networkFailure, await signedToken());

    const privateJwk = {
      ...currentKey.publicJwk,
      d: "forbidden-private-material",
    };
    const malformed = verifier(jwksFetcher(() => ({ keys: [privateJwk] })));
    await expect(malformed.readiness()).resolves.toEqual({
      status: "not_ready",
      code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE",
    });
  });

  it("rejects user identity and both budget-grant profiles before key lookup", async () => {
    const fetcher = jwksFetcher(() => ({ keys: [currentKey.publicJwk] }));
    const subject = verifier(fetcher);
    const substitutions = [
      await signedToken({
        header: { typ: "global-backend-access+jwt" },
        claims: {
          aud: "global-backend",
          sub: "22222222-2222-4222-8222-222222222222",
          workspace_id: "33333333-3333-4333-8333-333333333333",
          roles: ["ADMIN"],
          scope: undefined,
        },
      }),
      await signedToken({
        header: { typ: "site-build-budget-grant+jwt" },
        claims: { aud: "global-backend:site-builder-budget" },
      }),
      await signedToken({
        header: { typ: "execution-budget-grant+jwt" },
        claims: { aud: "global-backend:execution-budget" },
      }),
    ];
    for (const token of substitutions) await denied(subject, token);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps a wrong signature under a known kid to denial, not JWKS unavailability", async () => {
    const subject = verifier(
      jwksFetcher(() => ({ keys: [currentKey.publicJwk] })),
    );
    await denied(
      subject,
      await signedToken({
        key: unknownKey,
        header: { kid: currentKey.kid },
      }),
    );
  });

  it.each([
    ["wrong issuer", { claims: { iss: "https://attacker.example.test/" } }],
    ["audience array", { claims: { aud: [AUDIENCE] } }],
    ["wrong subject", { claims: { sub: "growthos:another-reader" } }],
    [
      "scope array",
      { claims: { scope: [PLATFORM_TECHNICAL_QUOTE_READ_SCOPE] } },
    ],
    [
      "extra scope",
      { claims: { scope: `${PLATFORM_TECHNICAL_QUOTE_READ_SCOPE} other` } },
    ],
    ["uppercase jti", { claims: { jti: JTI.toUpperCase() } }],
    ["missing jti", { claims: { jti: undefined } }],
    ["unknown claim", { claims: { unexpected: "forbidden" } }],
    ["roles claim", { claims: { roles: ["ADMIN"] } }],
    ["workspace claim", { claims: { workspace_id: JTI } }],
    ["fractional iat", { claims: { iat: NOW_SECONDS + 0.5 } }],
    ["iat after nbf", { claims: { iat: NOW_SECONDS + 1 } }],
    ["nbf equal exp", { claims: { nbf: NOW_SECONDS + 300 } }],
    ["ttl over five minutes", { claims: { exp: NOW_SECONDS + 301 } }],
    [
      "iat beyond skew",
      {
        claims: {
          iat: NOW_SECONDS + 61,
          nbf: NOW_SECONDS + 61,
          exp: NOW_SECONDS + 300,
        },
      },
    ],
    ["nbf beyond skew", { claims: { nbf: NOW_SECONDS + 61 } }],
    [
      "expired beyond skew",
      {
        claims: {
          iat: NOW_SECONDS - 361,
          nbf: NOW_SECONDS - 361,
          exp: NOW_SECONDS - 61,
        },
      },
    ],
    ["missing kid", { header: { kid: undefined } }],
    ["unbounded kid", { header: { kid: `k${"x".repeat(128)}` } }],
    ["wrong type", { header: { typ: "global-backend-access+jwt" } }],
    ["extra protected header", { header: { extra: "forbidden" } }],
  ] as const)(
    "rejects %s as an invalid service token",
    async (_label, options) => {
      const subject = verifier(
        jwksFetcher(() => ({ keys: [currentKey.publicJwk] })),
      );
      await denied(subject, await signedToken(options));
    },
  );

  it.each(["iss", "aud", "sub", "scope", "jti", "iat", "nbf", "exp"] as const)(
    "rejects a token missing the closed %s claim",
    async (claim) => {
      const subject = verifier(
        jwksFetcher(() => ({ keys: [currentKey.publicJwk] })),
      );
      await denied(
        subject,
        await signedToken({ claims: { [claim]: undefined } }),
      );
    },
  );

  it("accepts only the exact sixty-second clock-skew boundary", async () => {
    const subject = verifier(
      jwksFetcher(() => ({ keys: [currentKey.publicJwk] })),
    );
    await expect(
      subject.verify(
        request(
          await signedToken({
            claims: {
              iat: NOW_SECONDS + 60,
              nbf: NOW_SECONDS + 60,
              exp: NOW_SECONDS + 300,
            },
          }),
        ),
      ),
    ).resolves.toBeDefined();
  });

  it("rejects duplicate header and payload members plus malformed UTF-8", async () => {
    const subject = verifier(
      jwksFetcher(() => ({ keys: [currentKey.publicJwk] })),
    );
    const payload = JSON.stringify(validClaims());
    const duplicateHeader = compact(
      `{"alg":"RS256","kid":"${currentKey.kid}","typ":"${TOKEN_TYPE}","typ":"${TOKEN_TYPE}"}`,
      payload,
    );
    const duplicatePayload = await signedRawPayload(
      payload.replace(
        `"scope":"${PLATFORM_TECHNICAL_QUOTE_READ_SCOPE}"`,
        `"scope":"${PLATFORM_TECHNICAL_QUOTE_READ_SCOPE}","scope":"${PLATFORM_TECHNICAL_QUOTE_READ_SCOPE}"`,
      ),
    );
    const malformedUtf8 = compact(
      JSON.stringify({ alg: "RS256", kid: currentKey.kid, typ: TOKEN_TYPE }),
      Uint8Array.of(0xff),
    );
    for (const token of [duplicateHeader, duplicatePayload, malformedUtf8]) {
      await denied(subject, token);
    }
  });

  it("rejects the complete non-integer and hostile string JSON surface", async () => {
    const subject = verifier(
      jwksFetcher(() => ({ keys: [currentKey.publicJwk] })),
    );
    const payload = JSON.stringify(validClaims());
    const issuedAt = `"iat":${NOW_SECONDS}`;
    const scope = `"scope":"${PLATFORM_TECHNICAL_QUOTE_READ_SCOPE}"`;
    const hostilePayloads = [
      "{}",
      payload.replace(issuedAt, '"iat":0'),
      payload.replace(issuedAt, '"iat":-1'),
      payload.replace(issuedAt, '"iat":01'),
      payload.replace(issuedAt, '"iat":1.5'),
      payload.replace(issuedAt, '"iat":1e3'),
      payload.replace(issuedAt, '"iat":true'),
      payload.replace(issuedAt, '"iat":{}'),
      payload.replace(
        scope,
        `${scope},"\\u0073cope":"${PLATFORM_TECHNICAL_QUOTE_READ_SCOPE}"`,
      ),
      payload.replace(scope, '"scope":"\\ud800"'),
      payload.replace(scope, '"scope":"\\x"'),
      `${payload} trailing`,
    ];
    for (const rawPayload of hostilePayloads) {
      await denied(subject, await signedRawPayload(rawPayload));
    }
  });

  it("rejects unsigned, symmetric, noncanonical and oversized compact tokens", async () => {
    const subject = verifier(
      jwksFetcher(() => ({ keys: [currentKey.publicJwk] })),
    );
    const payload = JSON.stringify(validClaims());
    const invalidTokens = [
      compact(
        JSON.stringify({ alg: "none", kid: currentKey.kid, typ: TOKEN_TYPE }),
        payload,
        "",
      ),
      compact(
        JSON.stringify({ alg: "HS256", kid: currentKey.kid, typ: TOKEN_TYPE }),
        payload,
      ),
      ` ${await signedToken()}`,
      `${await signedToken()} `,
      `${await signedToken()}=`,
      "x".repeat(16_385),
    ];
    for (const token of invalidTokens) await denied(subject, token);
  });

  it("rejects missing, duplicated and non-Bearer authorization values", async () => {
    const subject = verifier(
      jwksFetcher(() => ({ keys: [currentKey.publicJwk] })),
    );
    for (const authorization of [
      undefined,
      "",
      "bearer token",
      "Bearer ",
      "Bearer one,two",
    ]) {
      const headers = authorization === undefined ? {} : { authorization };
      const error = await subject
        .verify(
          Object.freeze({
            method: "POST" as const,
            normalizedPath:
              "/api/v1/platform-authority/technical-quote" as const,
            headers: Object.freeze(headers),
          }),
        )
        .then(() => undefined)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(
        PlatformTechnicalQuoteServiceAuthenticationDeniedError,
      );
    }
  });

  it("rejects malformed JWKS documents and transport responses as unavailable", async () => {
    const publicJwk = currentKey.publicJwk;
    const malformedDocuments = [
      ["null", null],
      ["array root", []],
      ["missing keys", {}],
      ["empty keys", { keys: [] }],
      ["duplicate kid", { keys: [publicJwk, publicJwk] }],
      [
        "too many keys",
        {
          keys: [
            publicJwk,
            rotationKey.publicJwk,
            unknownKey.publicJwk,
            publicJwk,
          ],
        },
      ],
      ["extra member", { keys: [{ ...publicJwk, extra: "forbidden" }] }],
      ["wrong algorithm", { keys: [{ ...publicJwk, alg: "PS256" }] }],
      ["wrong use", { keys: [{ ...publicJwk, use: "enc" }] }],
      ["empty kid", { keys: [{ ...publicJwk, kid: "" }] }],
      ["short modulus", { keys: [{ ...publicJwk, n: "AQ" }] }],
      ["invalid exponent", { keys: [{ ...publicJwk, e: "=" }] }],
    ] as const;
    for (const [label, document] of malformedDocuments) {
      await expect(
        verifier(jwksFetcher(() => document)).readiness(),
        label,
      ).resolves.toEqual({
        status: "not_ready",
        code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE",
      });
    }

    const responses = [
      new Response(null, { status: 200 }),
      new Response("unavailable", {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
      new Response("x".repeat(65_537), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      new Response("{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ];
    for (const response of responses) {
      const subject = verifier(vi.fn<typeof fetch>(async () => response));
      await expect(subject.readiness()).resolves.toEqual({
        status: "not_ready",
        code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE",
      });
    }
  });

  it("coalesces concurrent JWKS readiness and reuses the bounded fresh cache", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async () => {
      await wait;
      return new Response(JSON.stringify({ keys: [currentKey.publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/jwk-set+json" },
      });
    });
    const subject = verifier(fetcher);
    const checks = [subject.readiness(), subject.readiness()];
    release();
    await expect(Promise.all(checks)).resolves.toEqual([
      {
        status: "ready",
        code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READY",
      },
      {
        status: "ready",
        code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READY",
      },
    ]);
    await expect(
      subject.verify(request(await signedToken())),
    ).resolves.toBeDefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("validatePlatformTechnicalQuoteJwksVerifierConfiguration", () => {
  it("pins only the trusted identity JWKS endpoint and exact issuer", () => {
    expect(
      validatePlatformTechnicalQuoteJwksVerifierConfiguration(TEST_ENV),
    ).toEqual({
      jwks: new URL(TEST_ENV.PLATFORM_TECHNICAL_QUOTE_AUTH_JWKS_URI),
      issuer: ISSUER,
    });
  });

  it.each([
    [
      "missing JWKS",
      { ...TEST_ENV, PLATFORM_TECHNICAL_QUOTE_AUTH_JWKS_URI: undefined },
    ],
    [
      "missing issuer",
      { ...TEST_ENV, PLATFORM_TECHNICAL_QUOTE_AUTH_ISSUER: undefined },
    ],
    [
      "credentialed JWKS",
      {
        ...TEST_ENV,
        PLATFORM_TECHNICAL_QUOTE_AUTH_JWKS_URI:
          "https://user:pass@growthos.example.test/jwks",
      },
    ],
    [
      "query JWKS",
      {
        ...TEST_ENV,
        PLATFORM_TECHNICAL_QUOTE_AUTH_JWKS_URI:
          "https://growthos.example.test/jwks?key=x",
      },
    ],
    [
      "remote HTTP",
      {
        ...TEST_ENV,
        PLATFORM_TECHNICAL_QUOTE_AUTH_JWKS_URI:
          "http://growthos.example.test/jwks",
      },
    ],
    [
      "noncanonical issuer",
      { ...TEST_ENV, PLATFORM_TECHNICAL_QUOTE_AUTH_ISSUER: `${ISSUER} ` },
    ],
  ] as const)("rejects %s", (_label, env) => {
    expect(() =>
      validatePlatformTechnicalQuoteJwksVerifierConfiguration(
        env as NodeJS.ProcessEnv,
      ),
    ).toThrow("PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_CONFIG_INVALID");
  });

  it("permits loopback HTTP only for development and isolated tests", () => {
    const loopback = {
      ...TEST_ENV,
      PLATFORM_TECHNICAL_QUOTE_AUTH_JWKS_URI:
        "http://127.0.0.1:18081/.well-known/jwks.json",
      PLATFORM_TECHNICAL_QUOTE_AUTH_ISSUER: "http://127.0.0.1:18081/",
    };
    expect(
      validatePlatformTechnicalQuoteJwksVerifierConfiguration(loopback),
    ).toBeDefined();
    expect(() =>
      validatePlatformTechnicalQuoteJwksVerifierConfiguration({
        ...loopback,
        APP_ENVIRONMENT: "production",
        NODE_ENV: "production",
      }),
    ).toThrow("PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_CONFIG_INVALID");
  });
});
