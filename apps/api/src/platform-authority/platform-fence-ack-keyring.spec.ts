import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { loadPlatformFenceAckMaterial } from "./platform-fence-ack-keyring";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "platform-ack-keyring-")); directories.push(directory);
  const signing = join(directory, "signing.keys"); const cipher = join(directory, "cipher.keys");
  const active = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const old = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateDer = active.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const publicDer = old.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const signingText = `platform-fence-ack-signing-keyring/v1\nack-current ACTIVE ${privateDer}\nack-old VERIFY_ONLY ${publicDer}\n`;
  const cipherText = `platform-fence-ack-cipher-keyring/v1\ncipher-current ACTIVE ${Buffer.alloc(32, 1).toString("base64")}\ncipher-old DECRYPT_ONLY ${Buffer.alloc(32, 2).toString("base64")}\n`;
  writeFileSync(signing, signingText, { mode: 0o600 }); writeFileSync(cipher, cipherText, { mode: 0o600 });
  return { directory, signing, cipher, signingText, cipherText, privateDer, publicDer };
}
const options = (files: ReturnType<typeof fixture>) => ({ signingKeyringFile: files.signing,
  cipherKeyringFile: files.cipher, issuer: "https://backend.example", now: () => 1788830000 });
describe("owner-only purpose-bound Backend ACK keyrings", () => {
  it("loads one active signer, preserves verification keys and projects public JWKS only", () => {
    const files = fixture(); const material = loadPlatformFenceAckMaterial(options(files));
    expect(material.jwks.keys.map(key => key.kid)).toEqual(["ack-current", "ack-old"]);
    for (const key of material.jwks.keys) expect(Object.keys(key).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
    expect(JSON.stringify(material.jwks)).not.toContain(files.privateDer);
    const context = { receiptId: "11111111-1111-4111-8111-111111111111", commandSha256: "a".repeat(64), ackSha256: "b".repeat(64), signingKeyId: "ack-current" };
    const token = ["header", "payload", "signature"].join(".");
    expect(material.cipher.decrypt(context, material.cipher.encrypt(context, token))).toBe(token);
  });
  it("rejects loose modes, symlinks and absent files without generating temporary keys", () => {
    const files = fixture(); chmodSync(files.signing, 0o644);
    expect(() => loadPlatformFenceAckMaterial(options(files))).toThrow("PLATFORM_FENCE_ACK_KEYRING_INVALID");
    chmodSync(files.signing, 0o600);
    const link = join(files.directory, "link"); symlinkSync(files.signing, link);
    expect(() => loadPlatformFenceAckMaterial({ ...options(files), signingKeyringFile: link })).toThrow();
    expect(() => loadPlatformFenceAckMaterial({ ...options(files), cipherKeyringFile: join(files.directory, "missing") })).toThrow();
  });
  it.each(["wrong-purpose", "no-active", "two-active", "duplicate-id", "duplicate-material", "extra-field", "bad-base64"])(
    "rejects invalid signing keyring %s", mutation => {
      const files = fixture();
      const changed = mutation === "wrong-purpose" ? files.signingText.replace("signing-keyring", "identity-keyring")
        : mutation === "no-active" ? `platform-fence-ack-signing-keyring/v1\nold VERIFY_ONLY ${files.publicDer}\n`
        : mutation === "two-active" ? files.signingText + `another ACTIVE ${files.privateDer}\n`
        : mutation === "duplicate-id" ? files.signingText.replace("ack-old", "ack-current")
        : mutation === "duplicate-material" ? files.signingText + `duplicate VERIFY_ONLY ${files.publicDer}\n`
        : mutation === "extra-field" ? files.signingText.replace(" ACTIVE ", " ACTIVE extra ")
        : files.signingText.replace(files.privateDer, "invalid!");
      writeFileSync(files.signing, changed);
      expect(() => loadPlatformFenceAckMaterial(options(files))).toThrow("PLATFORM_FENCE_ACK_KEYRING_INVALID");
    },
  );
  it("rejects cross-purpose cipher material and oversized files", () => {
    const files = fixture(); writeFileSync(files.cipher, files.cipherText.replace("cipher-keyring", "settlement-keyring"));
    expect(() => loadPlatformFenceAckMaterial(options(files))).toThrow();
    writeFileSync(files.cipher, "a".repeat(65537));
    expect(() => loadPlatformFenceAckMaterial(options(files))).toThrow();
  });
  it("rejects malformed issuer and cipher rotation configuration", () => {
    const files = fixture();
    expect(() => loadPlatformFenceAckMaterial({ ...options(files), issuer: "htt\nps://backend.example" })).toThrow();
    expect(() => loadPlatformFenceAckMaterial({ ...options(files), issuer: "http://remote.example" })).toThrow();
    for (const text of [files.cipherText.replace("DECRYPT_ONLY", "ACTIVE"),
      files.cipherText.replace("cipher-old", "cipher-current"),
      files.cipherText.replace(Buffer.alloc(32, 2).toString("base64"), Buffer.alloc(32, 1).toString("base64")),
      `platform-fence-ack-cipher-keyring/v1\nold DECRYPT_ONLY ${Buffer.alloc(32).toString("base64")}\n`]) {
      writeFileSync(files.cipher, text);
      expect(() => loadPlatformFenceAckMaterial(options(files))).toThrow("PLATFORM_FENCE_ACK_KEYRING_INVALID");
    }
  });
  it.each(["privateDer", "publicDer"] as const)("rejects trailing bytes after the declared DER object %s", field => {
    const files = fixture();
    const appended = Buffer.concat([Buffer.from(files[field], "base64"), Buffer.from("unexpected-tail")]).toString("base64");
    writeFileSync(files.signing, files.signingText.replace(files[field], appended));
    expect(() => loadPlatformFenceAckMaterial(options(files))).toThrow("PLATFORM_FENCE_ACK_KEYRING_INVALID");
  });
});
