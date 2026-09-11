import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { PlatformFenceAckCipher, PlatformFenceAckSigner } from "./platform-fence-ack-crypto";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_BYTES = 65536;
function invalid(): never { throw new Error("PLATFORM_FENCE_ACK_KEYRING_INVALID"); }
function readSecret(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || path !== path.trim()) return invalid();
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || (before.mode & 0o7777n) !== 0o600n || before.size < 1n || before.size > BigInt(MAX_BYTES)) return invalid();
    const bytes = Buffer.alloc(MAX_BYTES + 1); let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (BigInt(length) !== before.size || length > MAX_BYTES || before.dev !== after.dev || before.ino !== after.ino ||
      before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return invalid();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function records(text: string, purpose: string): string[][] {
  const lines = text.split("\n");
  if (lines[0] !== purpose || lines.at(-1) !== "" || lines.length < 3 || lines.length > 5) return invalid();
  const result = lines.slice(1, -1).map(line => line.split(" "));
  const ids = new Set<string>();
  for (const parts of result) {
    if (parts.length !== 3 || !KEY_ID.test(parts[0]) || ids.has(parts[0])) return invalid();
    ids.add(parts[0]);
  }
  return result;
}
function material(encoded: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return invalid();
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.toString("base64") !== encoded) return invalid();
  return bytes;
}
function rsa(key: KeyObject): void {
  if (key.asymmetricKeyType !== "rsa" || !key.asymmetricKeyDetails?.modulusLength ||
      key.asymmetricKeyDetails.modulusLength < 2048 || key.asymmetricKeyDetails.modulusLength > 8192) invalid();
}
export interface PlatformFenceAckMaterial {
  readonly signer: PlatformFenceAckSigner;
  readonly cipher: PlatformFenceAckCipher;
  readonly jwks: { readonly keys: readonly { readonly kid: string; readonly kty: "RSA"; readonly n: string; readonly e: string; readonly use: "sig"; readonly alg: "RS256" }[] };
}

/** Purpose-bound secret files only. Mode/FD checks do not attest trusted ownership or
 * parent-directory provenance. Those and cross-family key independence remain runtime
 * admission checks; loading this material alone does not establish readiness. */
export function loadPlatformFenceAckMaterial(options: {
  readonly signingKeyringFile: string; readonly cipherKeyringFile: string;
  readonly issuer: string; readonly now: () => number;
}): PlatformFenceAckMaterial {
  try {
    const issuer = new URL(options.issuer);
    if (typeof options.now !== "function" || !options.issuer || options.issuer.length > 2048 || /[\p{Cc}\p{Z}]/u.test(options.issuer) ||
      options.issuer.includes("?") || options.issuer.includes("#") || issuer.username || issuer.password ||
      !(issuer.protocol === "https:" || issuer.protocol === "http:" && ["localhost", "127.0.0.1"].includes(issuer.hostname))) return invalid();
    const keys: PlatformFenceAckMaterial["jwks"]["keys"][number][] = [];
    const fingerprints = new Set<string>();
    let active: { id: string; key: KeyObject } | undefined;
    for (const [id, state, encoded] of records(readSecret(options.signingKeyringFile), "platform-fence-ack-signing-keyring/v1")) {
      if (state !== "ACTIVE" && state !== "VERIFY_ONLY") return invalid();
      const der = material(encoded);
      const key = state === "ACTIVE" ? createPrivateKey({ key: der, format: "der", type: "pkcs8" })
        : createPublicKey({ key: der, format: "der", type: "spki" });
      rsa(key);
      // OpenSSL import alone accepts trailing bytes. This file contract requires
      // exactly one canonical DER object, including for verification-only keys.
      const canonicalDer = state === "ACTIVE" ? key.export({ format: "der", type: "pkcs8" }) : key.export({ format: "der", type: "spki" });
      if (!der.equals(canonicalDer)) return invalid();
      const publicKey = key.type === "private" ? createPublicKey(key) : key;
      const fingerprint = createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex");
      if (fingerprints.has(fingerprint)) return invalid(); fingerprints.add(fingerprint);
      if (state === "ACTIVE") { if (active) return invalid(); active = { id, key }; }
      const jwk = publicKey.export({ format: "jwk" });
      if (typeof jwk.n !== "string" || typeof jwk.e !== "string") return invalid();
      keys.push(Object.freeze({ kid: id, kty: "RSA", n: jwk.n, e: jwk.e, use: "sig", alg: "RS256" }));
    }
    if (!active) return invalid();
    const cipherKeys = new Map<string, Buffer>(); const cipherFingerprints = new Set<string>();
    let activeCipher: string | undefined;
    for (const [id, state, encoded] of records(readSecret(options.cipherKeyringFile), "platform-fence-ack-cipher-keyring/v1")) {
      if (state !== "ACTIVE" && state !== "DECRYPT_ONLY") return invalid();
      const bytes = material(encoded); if (bytes.length !== 32) return invalid();
      const fingerprint = createHash("sha256").update(bytes).digest("hex");
      if (cipherFingerprints.has(fingerprint)) return invalid(); cipherFingerprints.add(fingerprint);
      if (state === "ACTIVE") { if (activeCipher) return invalid(); activeCipher = id; }
      cipherKeys.set(id, bytes);
    }
    if (!activeCipher) return invalid();
    return Object.freeze({ signer: new PlatformFenceAckSigner(options.issuer, active.id, active.key, options.now),
      cipher: new PlatformFenceAckCipher(activeCipher, cipherKeys), jwks: Object.freeze({ keys: Object.freeze(keys) }) });
  } catch { return invalid(); }
}
