import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { compactVerify } from "jose";
import { PlatformAuthorityFenceAckClaimsSchema, PLATFORM_AUTHORITY_FENCE_ACK_TYPE } from "@global/contracts/execution-budget";
import { PlatformFenceAckCipher, PlatformFenceAckSigner } from "./platform-fence-ack-crypto";

const receiptId = "11111111-1111-4111-8111-111111111111";
const context = { receiptId, commandSha256: "a".repeat(64), ackSha256: "b".repeat(64), signingKeyId: "ack-1" };
describe("dedicated encrypted fence acknowledgements", () => {
  it("encrypts with a separate key and authenticates all delivery binding fields", () => {
    const key = Buffer.alloc(32, 7);
    const cipher = new PlatformFenceAckCipher("delivery-1", new Map([["delivery-1", key]]));
    key.fill(0);
    const token = ["header", "payload", "signature"].join(".");
    const encrypted = cipher.encrypt(context, token);
    expect(encrypted.ciphertext.includes(Buffer.from(token))).toBe(false);
    expect(cipher.decrypt(context, encrypted)).toBe(token);
    for (const mutation of [{ receiptId: "22222222-2222-4222-8222-222222222222" },
      { commandSha256: "c".repeat(64) }, { ackSha256: "d".repeat(64) }, { signingKeyId: "ack-2" }]) {
      expect(() => cipher.decrypt({ ...context, ...mutation }, encrypted)).toThrow("PLATFORM_FENCE_ACK_CIPHER_INVALID");
    }
    const tampered = Buffer.from(encrypted.ciphertext); tampered[tampered.length - 1] ^= 1;
    expect(() => cipher.decrypt(context, { ...encrypted, ciphertext: tampered })).toThrow("PLATFORM_FENCE_ACK_CIPHER_INVALID");
  });
  it("supports old decryption keys without encrypting with them or inventing missing keys", () => {
    const old = new PlatformFenceAckCipher("old", new Map([["old", Buffer.alloc(32, 1)]]));
    const rotated = new PlatformFenceAckCipher("new", new Map([["old", Buffer.alloc(32, 1)], ["new", Buffer.alloc(32, 2)]]));
    const token = ["header", "payload", "signature"].join(".");
    expect(rotated.decrypt(context, old.encrypt(context, token))).toBe(token);
    expect(rotated.encrypt(context, token).keyId).toBe("new");
    expect(() => old.decrypt(context, rotated.encrypt(context, token))).toThrow("PLATFORM_FENCE_ACK_CIPHER_INVALID");
  });
  it("requires real independent AES keys and bounded compact delivery", () => {
    expect(() => new PlatformFenceAckCipher("missing", new Map())).toThrow();
    expect(() => new PlatformFenceAckCipher("key", new Map([["key", Buffer.alloc(31)]]))).toThrow();
    const cipher = new PlatformFenceAckCipher("key", new Map([["key", Buffer.alloc(32)]]));
    for (const token of ["", "not a token", "a".repeat(16385)]) expect(() => cipher.encrypt(context, token)).toThrow();
    expect(() => cipher.decrypt(context, { keyId: "key", ciphertext: Buffer.alloc(28) })).toThrow();
  });
  it("signs only the dedicated ACK type with exact committed receipt and command binding", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signer = new PlatformFenceAckSigner("https://backend.example", "ack-1", privateKey, () => 1788830000);
    const value = signer.sign({ receiptId, generation: "2", committedAt: new Date(1788829999000), inFlightAttempts: "1", replay: false },
      { revocationJti: "33333333-3333-4333-8333-333333333333", tokenSha256: "a".repeat(64), scheduleId: "acq-sweep", fenceSequence: "1" });
    const checked = await compactVerify(value.token, publicKey, { algorithms: ["RS256"] });
    expect(checked.protectedHeader).toEqual({ alg: "RS256", typ: PLATFORM_AUTHORITY_FENCE_ACK_TYPE, kid: "ack-1" });
    const claims = PlatformAuthorityFenceAckClaimsSchema.parse(JSON.parse(Buffer.from(checked.payload).toString("utf8")));
    expect(claims.command_sha256).toBe("a".repeat(64));
    expect(claims.jti).toBe(receiptId);
    expect(claims.backend_generation).toBe("2");
    expect(claims.committed_at).toBe(1788829999);
    expect(claims.exp - claims.iat).toBe(300);
    expect(value.tokenSha256).toMatch(/^[0-9a-f]{64}$/);
    if (process.env.PLATFORM_ACK_TEST_ARTIFACT) {
      writeFileSync(process.env.PLATFORM_ACK_TEST_ARTIFACT, JSON.stringify({
        schema_version: "platform-backend-ack-test-artifact/v1", now: 1788830000,
        ack_jws: value.token, ack_jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "ack-1", alg: "RS256", use: "sig" }] },
        revocation_jti: claims.revocation_jti, command_sha256: claims.command_sha256,
        schedule_id: claims.schedule_id, fence_sequence: claims.fence_sequence,
      }), { flag: "wx", mode: 0o600 });
    }
  });
});
