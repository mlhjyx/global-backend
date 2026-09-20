import { beforeAll, describe, expect, it } from "vitest";
import { CompactSign, generateKeyPair, type CryptoKey } from "jose";
import { createHash } from "node:crypto";
import { PlatformRevocationVerifier } from "./platform-revocation-verifier";

const NOW = 1788830000;
const claims = {
  schema_version: "PlatformExecutionBudgetAuthorityRevoked/v1", iss: "https://growthos.example",
  aud: "global-backend:execution-budget", revocation_jti: "11111111-1111-4111-8111-111111111111",
  target_issuer: "https://growthos.example", target_jti: "22222222-2222-4222-8222-222222222222",
  schedule_id: "acq-sweep", workflow_run_id: "33333333-3333-4333-8333-333333333333",
  fence_sequence: "1", reason_code: "POLICY_DISABLED", iat: NOW, nbf: NOW, exp: NOW + 300,
};
let privateKey: CryptoKey;
let publicKey: CryptoKey;
beforeAll(async () => { ({ privateKey, publicKey } = await generateKeyPair("RS256")); });
async function signed(payload = JSON.stringify(claims), header: Record<string, unknown> = {}) {
  return new CompactSign(new TextEncoder().encode(payload))
    .setProtectedHeader({ alg: "RS256", typ: "execution-budget-authority-revocation+jwt", kid: "revocation-1", ...header })
    .sign(privateKey);
}
function verifier(now = NOW) {
  return new PlatformRevocationVerifier({ issuer: claims.iss, keyResolver: async () => publicKey, now: () => now });
}
describe("platform revocation authenticated command inspection", () => {
  it("verifies a real RS256 signature and returns only claims and token digest", async () => {
    const compact = await signed();
    const result = await verifier().inspect(compact);
    expect(result.claims).toEqual(claims);
    expect(result.tokenSha256).toBe(createHash("sha256").update(compact).digest("hex"));
    expect(result.expired).toBe(false);
    expect(JSON.stringify(result)).not.toContain(compact);
    expect(Object.isFrozen(result.claims)).toBe(true);
  });
  it("marks expired authenticated commands replay-only without extending their expiry", async () => {
    const result = await verifier(NOW + 300).inspect(await signed());
    expect(result.expired).toBe(true);
    expect(result.claims.exp).toBe(NOW + 300);
  });
  it.each([
    { typ: "execution-budget-grant+jwt" }, { kid: "" }, { kid: "x\n" },
    { jwk: {} },
  ])("rejects incorrect or expanded protected headers %j", async header => {
    await expect(verifier().inspect(await signed(undefined, header))).rejects.toThrow("PLATFORM_REVOCATION_INVALID");
  });
  it.each([
    () => JSON.stringify({ ...claims, aud: "global-backend" }),
    () => JSON.stringify({ ...claims, iss: "https://other.example", target_issuer: "https://other.example" }),
    () => JSON.stringify({ ...claims, nbf: NOW + 61 }),
    () => JSON.stringify(claims).replace('"fence_sequence":"1"', '"fence_sequence":"2","fence_sequence":"1"'),
    () => JSON.stringify(claims) + "{}",
    () => JSON.stringify({ ...claims, extra: true }),
  ])("rejects invalid signed payload without trusting the signer to validate shape", async payload => {
    await expect(verifier().inspect(await signed(payload()))).rejects.toThrow("PLATFORM_REVOCATION_INVALID");
  });
  it("rejects altered signatures and noncompact/oversized inputs", async () => {
    const compact = await signed();
    for (const invalid of [compact + "x", " " + compact, "x".repeat(16385), "not-a-jws"]) {
      await expect(verifier().inspect(invalid)).rejects.toThrow("PLATFORM_REVOCATION_INVALID");
    }
  });
  it("fails closed without an available trust resolver", async () => {
    const unavailable = new PlatformRevocationVerifier({ issuer: claims.iss, keyResolver: async () => { throw new Error("secret provider diagnostic"); }, now: () => NOW });
    await expect(unavailable.inspect(await signed())).rejects.toThrow("PLATFORM_REVOCATION_VERIFICATION_UNAVAILABLE");
  });
  it.each([
    "", "[]", "null", "{}{}", "{", '{"x"}', '{"x":}', '{"x":1,}',
    '{"x":01}', '{"x":-1}', '{"x":1.5}', '{"x":1e2}', '{"x":9007199254740993}',
    '{"x":true}', '{"x":null}', '{"x":[]}', '{"x":{}}', '{"x":1 "y":2}',
    '{"x":"\\ud800"}', '{"x":"\\udc00"}', '\ufeff{}',
    '{"x":"a","\\u0078":"b"}', '{"x":"a\nb"}',
  ])("rejects malformed or non-flat authenticated JSON %s", async payload => {
    await expect(verifier().inspect(await signed(payload))).rejects.toThrow("PLATFORM_REVOCATION_INVALID");
  });
  it("accepts normal whitespace but never exposes unknown claims", async () => {
    const result = await verifier().inspect(await signed(JSON.stringify(claims, null, 2)));
    expect(result.claims).toEqual(claims);
  });
  it("classifies an invalid clock as unavailable rather than authorizing", async () => {
    await expect(verifier(Number.NaN).inspect(await signed())).rejects.toThrow("PLATFORM_REVOCATION_VERIFICATION_UNAVAILABLE");
  });
  it("rejects invalid UTF-8 even when the signature is authentic", async () => {
    const compact = await new CompactSign(new Uint8Array([0xc0, 0xaf]))
      .setProtectedHeader({ alg: "RS256", typ: "execution-budget-authority-revocation+jwt", kid: "revocation-1" }).sign(privateKey);
    await expect(verifier().inspect(compact)).rejects.toThrow("PLATFORM_REVOCATION_INVALID");
  });
});
