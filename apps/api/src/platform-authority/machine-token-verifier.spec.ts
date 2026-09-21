import { beforeAll, describe, expect, it } from "vitest";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { createHash } from "node:crypto";
import {
  verifyMachineTokenResponse,
  type MachineTokenTrust,
} from "./machine-token-verifier";

const NOW = 1_790_000_000;
const NONCE = "01".repeat(16);
const REVISION = "ab".repeat(32);
let privateKey: CryptoKey;
let trust: MachineTokenTrust;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  trust = {
    profile: "temporal-customer-worker",
    issuer: "https://growthos.test",
    audience: "temporal-runtime",
    subject: "backend-customer-worker",
    configurationRevision: REVISION,
    jwks: {
      keys: [
        {
          ...(await exportJWK(pair.publicKey)),
          kid: "active",
          alg: "RS256",
          use: "sig",
        },
      ],
    },
  };
});

async function response(
  overrides: Record<string, unknown> = {},
  envelope: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) {
  const claims = {
    iss: trust.issuer,
    aud: trust.audience,
    sub: trust.subject,
    jti: "3f0daec5-eac6-47af-8aa7-419b6cf9c50f",
    iat: NOW,
    nbf: NOW,
    exp: NOW + 300,
    profile: trust.profile,
    permissions: ["default:worker"],
    ...overrides,
  };
  const token = await new CompactSign(Buffer.from(JSON.stringify(claims)))
    .setProtectedHeader({
      alg: "RS256",
      kid: "active",
      typ: "temporal-runtime+jwt",
      ...header,
    })
    .sign(privateKey);
  const body = Buffer.from(
    JSON.stringify({
      schemaVersion: "platform-machine-token/v1",
      profile: trust.profile,
      nonce: NONCE,
      subject: trust.subject,
      issuedAt: NOW,
      expiresAt: NOW + 300,
      configurationRevision: REVISION,
      token,
      ...envelope,
    }),
  );
  return { body, digest: createHash("sha256").update(token).digest("hex") };
}

describe("machine bootstrap signed response", () => {
  it("checks future NumericDates even when transport metadata agrees exactly", async () => {
    const wire = await response(
      { iat: NOW + 61, nbf: NOW + 61, exp: NOW + 361 },
      { issuedAt: NOW + 61, expiresAt: NOW + 361 },
    );
    await expect(
      verifyMachineTokenResponse(wire.body, NONCE, trust, NOW).then(
        () => undefined,
      ),
    ).rejects.toThrow("PLATFORM_MACHINE_TOKEN_DENIED");
  });
  it("accepts only a signed worker credential bound to the request and trusted manifest", async () => {
    const wire = await response();
    const result = await verifyMachineTokenResponse(
      wire.body,
      NONCE,
      trust,
      NOW,
    );
    expect(result.subject).toBe("backend-customer-worker");
    expect(result.expiresAt).toBe(NOW + 300);
    expect(createHash("sha256").update(result.token).digest("hex")).toBe(
      wire.digest,
    );
  });

  it.each([
    { iss: "https://other.test" },
    { aud: "global-backend" },
    { sub: "other-worker" },
    { profile: "temporal-platform-worker" },
    { permissions: ["platform-automation:worker"] },
    { permissions: ["default:worker", "default:write"] },
    { permissions: "default:worker" },
    { jti: "not-a-uuid" },
    { iat: NOW + 61, nbf: NOW + 61, exp: NOW + 361 },
    { exp: NOW + 301 },
    { nbf: NOW - 1 },
    { extra: "claim" },
  ])("rejects an invalid signed claim without exposing it", async (claims) => {
    const wire = await response(claims);
    await expect(
      verifyMachineTokenResponse(wire.body, NONCE, trust, NOW),
    ).rejects.toThrow(/^PLATFORM_MACHINE_TOKEN_DENIED$/);
  });

  it.each([
    { nonce: "02".repeat(16) },
    { configurationRevision: "cd".repeat(32) },
    { subject: "other" },
    { expiresAt: NOW + 301 },
    { issuedAt: NOW - 1 },
    { profile: "temporal-platform-worker" },
    { extra: "response" },
  ])("rejects unbound transport metadata", async (envelope) => {
    const wire = await response({}, envelope);
    await expect(
      verifyMachineTokenResponse(wire.body, NONCE, trust, NOW),
    ).rejects.toThrow("PLATFORM_MACHINE_TOKEN_DENIED");
  });

  it("rejects an expired credential even with a valid signature", async () => {
    const wire = await response();
    await expect(
      verifyMachineTokenResponse(wire.body, NONCE, trust, NOW + 300),
    ).rejects.toThrow("PLATFORM_MACHINE_TOKEN_DENIED");
  });
  it("rejects identity-token header substitution", async () => {
    const wire = await response({}, {}, { typ: "JWT" });
    await expect(
      verifyMachineTokenResponse(wire.body, NONCE, trust, NOW),
    ).rejects.toThrow("PLATFORM_MACHINE_TOKEN_DENIED");
  });

  it.each([
    ["temporal-platform-worker", ["platform-automation:worker"]],
    ["temporal-customer-client", ["default:read", "default:write"]],
  ] as const)(
    "accepts the distinct %s profile without exchanging its purpose",
    async (profile, permissions) => {
      const wire = await response({ profile, permissions }, { profile });
      const verified = await verifyMachineTokenResponse(
        wire.body,
        NONCE,
        { ...trust, profile },
        NOW,
      );
      expect(verified.subject).toBe(trust.subject);
      await expect(
        verifyMachineTokenResponse(wire.body, NONCE, trust, NOW),
      ).rejects.toThrow("PLATFORM_MACHINE_TOKEN_DENIED");
    },
  );

  it("retains the existing capability identity claims instead of accepting temporal tokens", async () => {
    const wire = await response(
      {
        aud: "platform-automation-capability-read",
        scope: "platform-automation-capability-read",
        profile: undefined,
        permissions: undefined,
      },
      { profile: "capability-request" },
      { typ: "platform-automation-capability-reader+jwt" },
    );
    const verified = await verifyMachineTokenResponse(
      wire.body,
      NONCE,
      {
        ...trust,
        profile: "capability-request",
        audience: "platform-automation-capability-read",
      },
      NOW,
    );
    expect(verified.expiresAt).toBe(NOW + 300);
    await expect(
      verifyMachineTokenResponse(wire.body, NONCE, trust, NOW),
    ).rejects.toThrow("PLATFORM_MACHINE_TOKEN_DENIED");
  });

  it("verifies the cryptographic signature, not only signed-looking fields", async () => {
    const wire = await response();
    const pair = await generateKeyPair("RS256", { modulusLength: 2048 });
    const untrusted = {
      ...trust,
      jwks: {
        keys: [
          {
            ...(await exportJWK(pair.publicKey)),
            kid: "active",
            alg: "RS256",
            use: "sig",
          },
        ],
      },
    };
    await expect(
      verifyMachineTokenResponse(wire.body, NONCE, untrusted, NOW),
    ).rejects.toThrow("PLATFORM_MACHINE_TOKEN_DENIED");
  });

  it("accepts a retained verification key but refuses it after removal", async () => {
    const wire = await response();
    const pair = await generateKeyPair("RS256", { modulusLength: 2048 });
    const next = {
      ...(await exportJWK(pair.publicKey)),
      kid: "next",
      alg: "RS256",
      use: "sig",
    };
    const old = (trust.jwks as { keys: unknown[] }).keys;
    const verified = await verifyMachineTokenResponse(
      wire.body,
      NONCE,
      { ...trust, jwks: { keys: [...old, next] } },
      NOW,
    );
    expect(verified.subject).toBe(trust.subject);
    await expect(
      verifyMachineTokenResponse(
        wire.body,
        NONCE,
        { ...trust, jwks: { keys: [next] } },
        NOW,
      ),
    ).rejects.toThrow("PLATFORM_MACHINE_TOKEN_DENIED");
  });

  it("rejects duplicate response metadata before JSON member overwrite", async () => {
    const wire = await response();
    const duplicate = Buffer.from(
      wire.body.toString().replace("{", '{"nonce":"' + NONCE + '",'),
    );
    await expect(
      verifyMachineTokenResponse(duplicate, NONCE, trust, NOW),
    ).rejects.toThrow("PLATFORM_MACHINE_TOKEN_DENIED");
  });

  it.each([
    Buffer.alloc(24 * 1024 + 1, 32),
    Buffer.from([0xff]),
    Buffer.from("{}"),
    Buffer.from("[]"),
  ])("rejects oversized or malformed response bytes", async (body) => {
    await expect(
      verifyMachineTokenResponse(body, NONCE, trust, NOW),
    ).rejects.toThrow("PLATFORM_MACHINE_TOKEN_DENIED");
  });
});
