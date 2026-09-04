import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadSettlementDerivationKeyring,
  parseSettlementDerivationKeyring,
  settlementWireIdentities,
  settlementWireNonce,
  toDurableSettlementWireIdentity,
} from "./settlement-wire-identity";

const ACTIVE_KEY = "A".repeat(43);
const OLD_KEY = "E".repeat(43);
const OPERATION_KEY = "c".repeat(64);

function keyring(
  entries = [
    `settlement-2026-09 ACTIVE ${ACTIVE_KEY}`,
    `settlement-2026-08 VERIFY_ONLY ${OLD_KEY}`,
  ],
) {
  return `schema=site-build-settlement-derivation-keyring/v1\n${entries.join("\n")}\n`;
}

describe("settlement wire identity keyring", () => {
  it("derives two independent opaque values for each preallocated wire", () => {
    const parsed = parseSettlementDerivationKeyring(Buffer.from(keyring()));

    const identities = settlementWireIdentities(parsed, OPERATION_KEY, 2);

    expect(identities).toHaveLength(2);
    expect(identities[0]).toMatchObject({
      schemaVersion: "site-build-settlement-wire-identity/v1",
      physicalWireAttempt: 1,
      derivationKeyId: "settlement-2026-09",
      requestId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      nonceSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(identities[0]!.requestId).not.toBe(identities[0]!.nonce);
    expect(identities[1]!.requestId).not.toBe(identities[0]!.requestId);
    expect(Object.isFrozen(identities)).toBe(true);
    expect(Object.isFrozen(identities[0])).toBe(true);
  });

  it("reconstructs a nonce with the recorded key id and verifies its digest", () => {
    const parsed = parseSettlementDerivationKeyring(Buffer.from(keyring()));
    const original = settlementWireIdentities(parsed, OPERATION_KEY, 1)[0]!;

    expect(
      settlementWireNonce(parsed, {
        operationKey: OPERATION_KEY,
        physicalWireAttempt: 1,
        derivationKeyId: original.derivationKeyId,
        nonceSha256: original.nonceSha256,
      }),
    ).toBe(original.nonce);
    expect(
      settlementWireNonce(parsed, {
        operationKey: OPERATION_KEY,
        physicalWireAttempt: 1,
        derivationKeyId: original.derivationKeyId,
        nonceSha256: "0".repeat(64),
      }),
    ).toBeNull();
  });

  it("persists no plaintext nonce or derivation secret", () => {
    const parsed = parseSettlementDerivationKeyring(Buffer.from(keyring()));
    const identity = settlementWireIdentities(parsed, OPERATION_KEY, 1)[0]!;

    const durable = toDurableSettlementWireIdentity(identity);

    expect(durable).toEqual({
      schemaVersion: "site-build-settlement-wire-identity/v1",
      physicalWireAttempt: 1,
      derivationKeyId: "settlement-2026-09",
      requestId: identity.requestId,
      nonceSha256: identity.nonceSha256,
    });
    expect(JSON.stringify(durable)).not.toContain(identity.nonce);
    expect(JSON.stringify(durable)).not.toContain(ACTIVE_KEY);
  });

  it.each([
    ["missing trailing newline", keyring().trimEnd()],
    [
      "two active keys",
      keyring([
        `settlement-a ACTIVE ${ACTIVE_KEY}`,
        `settlement-b ACTIVE ${OLD_KEY}`,
      ]),
    ],
    [
      "duplicate key id",
      keyring([
        `settlement-a ACTIVE ${ACTIVE_KEY}`,
        `settlement-a VERIFY_ONLY ${OLD_KEY}`,
      ]),
    ],
    ["wrong schema", keyring().replace("/v1", "/v2")],
    ["short secret", keyring(["settlement-a ACTIVE short"])],
    ["unknown status", keyring([`settlement-a RETIRED ${ACTIVE_KEY}`])],
  ])("rejects %s", (_case, raw) => {
    expect(() => parseSettlementDerivationKeyring(Buffer.from(raw))).toThrow(
      "SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_INVALID",
    );
  });

  it("loads only an absolute mode-0600 regular file", () => {
    const root = mkdtempSync(join(tmpdir(), "settlement-keyring-"));
    const file = join(root, "keyring");
    const link = join(root, "keyring-link");
    try {
      writeFileSync(file, keyring(), { mode: 0o600 });

      expect(loadSettlementDerivationKeyring(file).activeKeyId).toBe(
        "settlement-2026-09",
      );
      chmodSync(file, 0o644);
      expect(() => loadSettlementDerivationKeyring(file)).toThrow(
        "SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_INVALID",
      );
      chmodSync(file, 0o600);
      symlinkSync(file, link);
      expect(() => loadSettlementDerivationKeyring(link)).toThrow(
        "SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_INVALID",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid operation keys and wire counts", () => {
    const parsed = parseSettlementDerivationKeyring(Buffer.from(keyring()));

    expect(() => settlementWireIdentities(parsed, "not-a-sha", 1)).toThrow(
      "SITE_BUILD_SETTLEMENT_WIRE_IDENTITY_INVALID",
    );
    expect(() => settlementWireIdentities(parsed, OPERATION_KEY, 0)).toThrow(
      "SITE_BUILD_SETTLEMENT_WIRE_IDENTITY_INVALID",
    );
    expect(() => settlementWireIdentities(parsed, OPERATION_KEY, 3)).toThrow(
      "SITE_BUILD_SETTLEMENT_WIRE_IDENTITY_INVALID",
    );
  });
});
