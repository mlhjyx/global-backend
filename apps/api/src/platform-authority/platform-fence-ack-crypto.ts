import { createCipheriv, createDecipheriv, createHash, randomBytes, sign, type KeyObject } from "node:crypto";
import { PlatformAuthorityFenceAckClaimsSchema, PLATFORM_AUTHORITY_FENCE_ACK_TYPE } from "@global/contracts/execution-budget";
import type { PlatformRevocationReceipt } from "./platform-revocation.repository";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid(): never { throw new Error("PLATFORM_FENCE_ACK_CIPHER_INVALID"); }
export interface FenceAckCipherContext {
  readonly receiptId: string;
  readonly commandSha256: string;
  readonly ackSha256: string;
  readonly signingKeyId: string;
}
export interface EncryptedFenceAck { readonly keyId: string; readonly ciphertext: Buffer }
function aad(context: FenceAckCipherContext, keyId: string): Buffer {
  if (!context || !UUID.test(context.receiptId) || !SHA.test(context.commandSha256) ||
      !SHA.test(context.ackSha256) || !ID.test(context.signingKeyId) || !ID.test(keyId)) return invalid();
  return Buffer.from(["platform-fence-ack-delivery/v1", keyId, context.receiptId, context.commandSha256,
    context.ackSha256, context.signingKeyId].join("\n"));
}
function compact(value: string): Buffer {
  if (typeof value !== "string" || value.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return invalid();
  return Buffer.from(value, "ascii");
}
export class PlatformFenceAckCipher {
  readonly #keys: ReadonlyMap<string, Buffer>;
  constructor(private readonly activeKeyId: string, keys: ReadonlyMap<string, Uint8Array>) {
    if (!ID.test(activeKeyId) || !keys || keys.size < 1 || keys.size > 3 || !keys.has(activeKeyId)) invalid();
    const snapshot = new Map<string, Buffer>();
    for (const [id, key] of keys) {
      if (!ID.test(id) || !(key instanceof Uint8Array) || key.byteLength !== 32) invalid();
      snapshot.set(id, Buffer.from(key));
    }
    this.#keys = snapshot;
  }
  encrypt(context: FenceAckCipherContext, token: string): EncryptedFenceAck {
    const bytes = compact(token);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#keys.get(this.activeKeyId)!, nonce);
    cipher.setAAD(aad(context, this.activeKeyId));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Object.freeze({ keyId: this.activeKeyId, ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]) });
  }
  decrypt(context: FenceAckCipherContext, delivery: EncryptedFenceAck): string {
    try {
      const key = this.#keys.get(delivery.keyId);
      const bytes = Buffer.from(delivery.ciphertext);
      if (!key || bytes.length < 29 || bytes.length > 16412) return invalid();
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAAD(aad(context, delivery.keyId)); cipher.setAuthTag(bytes.subarray(12, 28));
      const plain = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
      const token = new TextDecoder("utf-8", { fatal: true }).decode(plain);
      if (!compact(token).equals(plain)) return invalid();
      return token;
    } catch { return invalid(); }
  }
}

export interface FenceAckCommandBinding {
  readonly revocationJti: string;
  readonly tokenSha256: string;
  readonly scheduleId: string;
  readonly fenceSequence: string;
}
export class SignedFenceAck {
  readonly #token: string;
  constructor(token: string, readonly keyId: string, readonly tokenSha256: string) { this.#token = token; }
  get token(): string { return this.#token; }
  toJSON() { return { keyId: this.keyId, tokenSha256: this.tokenSha256 }; }
}
/** This key can only produce the dedicated ACK payload/type, never a Budget Grant. */
export class PlatformFenceAckSigner {
  constructor(private readonly issuer: string, private readonly keyId: string,
    private readonly key: KeyObject, private readonly now: () => number) {
    if (!ID.test(keyId) || key.type !== "private" || key.asymmetricKeyType !== "rsa" ||
      !key.asymmetricKeyDetails?.modulusLength || key.asymmetricKeyDetails.modulusLength < 2048 ||
      key.asymmetricKeyDetails.modulusLength > 8192) throw new Error("PLATFORM_FENCE_ACK_SIGNER_INVALID");
  }
  sign(receipt: PlatformRevocationReceipt, command: FenceAckCommandBinding): SignedFenceAck {
    try {
      const now = this.now();
      const claims = PlatformAuthorityFenceAckClaimsSchema.parse({
        schema_version: "PlatformExecutionBudgetFenceAcknowledged/v1", iss: this.issuer,
        aud: "growthos:platform-authority-fence-ack", jti: receipt.receiptId,
        revocation_jti: command.revocationJti, command_sha256: command.tokenSha256,
        schedule_id: command.scheduleId, fence_sequence: command.fenceSequence,
        backend_generation: receipt.generation, committed_at: Math.floor(receipt.committedAt.getTime() / 1000),
        in_flight_attempts: receipt.inFlightAttempts, iat: now, nbf: now, exp: now + 300,
      });
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: PLATFORM_AUTHORITY_FENCE_ACK_TYPE, kid: this.keyId })).toString("base64url");
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const preimage = `${header}.${payload}`;
      const token = `${preimage}.${sign("RSA-SHA256", Buffer.from(preimage), this.key).toString("base64url")}`;
      compact(token);
      return new SignedFenceAck(token, this.keyId, createHash("sha256").update(token).digest("hex"));
    } catch { throw new Error("PLATFORM_FENCE_ACK_SIGNER_INVALID"); }
  }
}
