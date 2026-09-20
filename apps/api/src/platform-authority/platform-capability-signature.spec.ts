import { beforeAll, describe, expect, it } from "vitest";
import {
  CompactSign,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
} from "jose";
import { verifyCapabilityEnvelope } from "./platform-capability-signature";
const NOW = 1_800_000_000_000;
let key: KeyLike;
let jwk: JWK;
const binding = () => ({
  issuer: "https://growthos.example.test",
  audience: "platform-automation-capability-read",
  nonce: "a".repeat(32),
  backendSha: "b".repeat(40),
  growthosSha: "c".repeat(40),
  policyDigest: "d".repeat(64),
});
const payload = () => ({
  ...binding(),
  iss: binding().issuer,
  aud: binding().audience,
  issuer: undefined,
  audience: undefined,
  iat: NOW / 1000,
  exp: NOW / 1000 + 30,
  namespace: "platform-automation",
  rows: [],
});
async function signed(
  value: unknown = payload(),
  headers: Record<string, unknown> = {},
) {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(value)))
    .setProtectedHeader({
      alg: "RS256",
      kid: "capability-1",
      typ: "platform-capability+jwt",
      ...headers,
    })
    .sign(key);
}
beforeAll(async () => {
  ({ privateKey: key } = await generateKeyPair("RS256", { extractable: true }));
  jwk = {
    ...(await exportJWK(key)),
    kid: "capability-1",
    alg: "RS256",
    use: "sig",
  };
  for (const name of ["d", "p", "q", "dp", "dq", "qi"]) delete jwk[name];
});
describe("capability envelope authenticated binding", () => {
  it("verifies a dedicated key and returns the signed snapshot without granting readiness", async () => {
    const result = await verifyCapabilityEnvelope(
      await signed(),
      binding(),
      { keys: [jwk] },
      ["capability-1"],
      NOW,
    );
    expect(result.namespace).toBe("platform-automation");
    expect(result.rows).toEqual([]);
  });
  it.each([
    "iss",
    "aud",
    "nonce",
    "backendSha",
    "growthosSha",
    "policyDigest",
    "namespace",
  ])("rejects wrong %s", async (field) => {
    await expect(
      verifyCapabilityEnvelope(
        await signed({ ...payload(), [field]: "wrong" }),
        binding(),
        { keys: [jwk] },
        ["capability-1"],
        NOW,
      ),
    ).rejects.toThrow("PLATFORM_CAPABILITY_INVALID");
  });
  it.each([
    { iat: NOW / 1000 + 1 },
    { exp: NOW / 1000 },
    { exp: NOW / 1000 + 31 },
    { iat: 0.5 },
    { extra: true },
  ])("rejects invalid claims %#", async (change) => {
    await expect(
      verifyCapabilityEnvelope(
        await signed({ ...payload(), ...change }),
        binding(),
        { keys: [jwk] },
        ["capability-1"],
        NOW,
      ),
    ).rejects.toThrow("PLATFORM_CAPABILITY_INVALID");
  });
  it.each([
    { jku: "https://attacker.test" },
    { x5u: "https://attacker.test" },
    { kid: "identity-key" },
    { typ: "JWT" },
  ])("rejects untrusted header %#", async (header) => {
    await expect(
      verifyCapabilityEnvelope(
        await signed(payload(), header),
        binding(),
        { keys: [jwk] },
        ["capability-1"],
        NOW,
      ),
    ).rejects.toThrow("PLATFORM_CAPABILITY_INVALID");
  });
  it("rejects duplicated or non-signing keys", async () => {
    const token = await signed();
    for (const keys of [[jwk, jwk], [{ ...jwk, use: "enc" }], []])
      await expect(
        verifyCapabilityEnvelope(
          token,
          binding(),
          { keys },
          ["capability-1"],
          NOW,
        ),
      ).rejects.toThrow("PLATFORM_CAPABILITY_INVALID");
  });
  it("rejects tampered signatures and oversized tokens", async () => {
    const token = await signed();
    const parts = token.split(".");
    parts[1] = Buffer.from(
      JSON.stringify({ ...payload(), nonce: "f".repeat(32) }),
    ).toString("base64url");
    for (const invalid of [parts.join("."), "x".repeat(16385)])
      await expect(
        verifyCapabilityEnvelope(
          invalid,
          binding(),
          { keys: [jwk] },
          ["capability-1"],
          NOW,
        ),
      ).rejects.toThrow("PLATFORM_CAPABILITY_INVALID");
  });
});

describe("capability trust root and encoding boundaries", () => {
  it("rejects invalid clocks, trust bindings, key lists and token framing", async () => {
    const token = await signed();
    for (const now of [NaN, -1, Infinity])
      await expect(
        verifyCapabilityEnvelope(
          token,
          binding(),
          { keys: [jwk] },
          ["capability-1"],
          now,
        ),
      ).rejects.toThrow("PLATFORM_CAPABILITY_INVALID");
    for (const change of [
      { nonce: "bad" },
      { backendSha: "bad" },
      { growthosSha: "bad" },
      { policyDigest: "bad" },
      { issuer: "" },
      { audience: "wrong" },
    ])
      await expect(
        verifyCapabilityEnvelope(
          token,
          { ...binding(), ...change },
          { keys: [jwk] },
          ["capability-1"],
          NOW,
        ),
      ).rejects.toThrow("PLATFORM_CAPABILITY_INVALID");
    for (const kids of [[], ["capability-1", "capability-1"], ["bad key"]])
      await expect(
        verifyCapabilityEnvelope(token, binding(), { keys: [jwk] }, kids, NOW),
      ).rejects.toThrow("PLATFORM_CAPABILITY_INVALID");
    for (const invalid of ["", null, "x.y", "a=.b.c", "a..c"])
      await expect(
        verifyCapabilityEnvelope(
          invalid,
          binding(),
          { keys: [jwk] },
          ["capability-1"],
          NOW,
        ),
      ).rejects.toThrow("PLATFORM_CAPABILITY_INVALID");
  });
  it("rejects wrong algorithm, private key material and key operations", async () => {
    const token = await signed();
    for (const change of [
      { alg: "RS512" },
      { kty: "EC" },
      { d: "private" },
      { key_ops: ["sign"] },
      { key_ops: ["verify", "sign"] },
    ])
      await expect(
        verifyCapabilityEnvelope(
          token,
          binding(),
          { keys: [{ ...jwk, ...change }] },
          ["capability-1"],
          NOW,
        ),
      ).rejects.toThrow("PLATFORM_CAPABILITY_INVALID");
  });
  it("rejects duplicate JSON members even when signed by the right key", async () => {
    const raw = JSON.stringify(payload()).replace(
      '"iss":',
      '"iss":"duplicate","iss":',
    );
    const token = await new CompactSign(Buffer.from(raw))
      .setProtectedHeader({
        alg: "RS256",
        kid: "capability-1",
        typ: "platform-capability+jwt",
      })
      .sign(key);
    await expect(
      verifyCapabilityEnvelope(
        token,
        binding(),
        { keys: [jwk] },
        ["capability-1"],
        NOW,
      ),
    ).rejects.toThrow("PLATFORM_CAPABILITY_INVALID");
  });
  it("rejects malformed row container and unsafe date numbers", async () => {
    for (const change of [
      { rows: {} },
      { rows: [1, 2, 3, 4, 5] },
      { iat: -1 },
      { exp: 0.5 },
    ])
      await expect(
        verifyCapabilityEnvelope(
          await signed({ ...payload(), ...change }),
          binding(),
          { keys: [jwk] },
          ["capability-1"],
          NOW,
        ),
      ).rejects.toThrow("PLATFORM_CAPABILITY_INVALID");
  });
});

it("rejects signed UTF-8 BOM rather than silently rewriting the wire bytes", async () => {
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify(payload())),
  ]);
  const token = await new CompactSign(bytes)
    .setProtectedHeader({
      alg: "RS256",
      kid: "capability-1",
      typ: "platform-capability+jwt",
    })
    .sign(key);
  await expect(
    verifyCapabilityEnvelope(
      token,
      binding(),
      { keys: [jwk] },
      ["capability-1"],
      NOW,
    ),
  ).rejects.toThrow("PLATFORM_CAPABILITY_INVALID");
});
