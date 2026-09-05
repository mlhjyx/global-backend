import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";

const KEYRING_SCHEMA = "schema=site-build-settlement-derivation-keyring/v1";
const MAXIMUM_KEYRING_BYTES = 4_096;
const MAXIMUM_KEYS = 3;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;
const KEY_MATERIAL = /^[A-Za-z0-9_-]{43}$/u;
const OPERATION_KEY = /^[0-9a-f]{64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAXIMUM_PHYSICAL_WIRES = 2;

type KeyStatus = "ACTIVE" | "VERIFY_ONLY";

interface KeyEntry {
  id: string;
  status: KeyStatus;
  material: Buffer;
}

export interface SettlementWireIdentity {
  schemaVersion: "site-build-settlement-wire-identity/v1";
  physicalWireAttempt: 1 | 2;
  derivationKeyId: string;
  requestId: string;
  /** Transient only. Never include this object in persisted metadata. */
  nonce: string;
  nonceSha256: string;
}

export type DurableSettlementWireIdentity = Omit<
  SettlementWireIdentity,
  "nonce"
>;

function invalidKeyring(): never {
  throw new Error("SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_INVALID");
}

function invalidWireIdentity(): never {
  throw new Error("SITE_BUILD_SETTLEMENT_WIRE_IDENTITY_INVALID");
}

function decodeKey(value: string): Buffer {
  if (!KEY_MATERIAL.test(value)) invalidKeyring();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    invalidKeyring();
  }
  return decoded;
}

function derive(
  material: Buffer,
  label: "request-id" | "nonce",
  operationKey: string,
  physicalWireAttempt: number,
): string {
  return createHmac("sha256", material)
    .update(`${label}\0${operationKey}\0${physicalWireAttempt}`, "utf8")
    .digest("base64url");
}

export class SettlementDerivationKeyring {
  readonly activeKeyId: string;
  private readonly entries: ReadonlyMap<string, KeyEntry>;

  constructor(entries: readonly KeyEntry[]) {
    const active = entries.find((entry) => entry.status === "ACTIVE");
    if (!active) invalidKeyring();
    this.activeKeyId = active.id;
    this.entries = new Map(
      entries.map((entry) => [
        entry.id,
        Object.freeze({
          id: entry.id,
          status: entry.status,
          material: Buffer.from(entry.material),
        }),
      ]),
    );
    Object.freeze(this);
  }

  deriveOpaque(input: {
    keyId: string;
    label: "request-id" | "nonce";
    operationKey: string;
    physicalWireAttempt: number;
  }): string | null {
    const entry = this.entries.get(input.keyId);
    if (!entry) return null;
    return derive(
      entry.material,
      input.label,
      input.operationKey,
      input.physicalWireAttempt,
    );
  }
}

export function parseSettlementDerivationKeyring(
  raw: Uint8Array,
): SettlementDerivationKeyring {
  if (
    raw.byteLength === 0 ||
    raw.byteLength > MAXIMUM_KEYRING_BYTES ||
    raw[raw.byteLength - 1] !== 0x0a ||
    raw.includes(0)
  ) {
    invalidKeyring();
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return invalidKeyring();
  }
  const lines = decoded.split("\n");
  if (lines.length < 3 || lines[0] !== KEYRING_SCHEMA || lines.at(-1) !== "") {
    invalidKeyring();
  }
  const records = lines.slice(1, -1);
  if (records.length < 1 || records.length > MAXIMUM_KEYS) invalidKeyring();

  const seen = new Set<string>();
  const entries: KeyEntry[] = [];
  let active = 0;
  for (const record of records) {
    const parts = record.split(" ");
    if (
      parts.length !== 3 ||
      !KEY_ID.test(parts[0]!) ||
      (parts[1] !== "ACTIVE" && parts[1] !== "VERIFY_ONLY") ||
      seen.has(parts[0]!)
    ) {
      invalidKeyring();
    }
    const id = parts[0]!;
    const status = parts[1] as KeyStatus;
    seen.add(id);
    if (status === "ACTIVE") active += 1;
    entries.push({ id, status, material: decodeKey(parts[2]!) });
  }
  if (active !== 1) invalidKeyring();
  return new SettlementDerivationKeyring(entries);
}

export function loadSettlementDerivationKeyring(
  path: string,
): SettlementDerivationKeyring {
  if (!path || path !== path.trim() || !isAbsolute(path)) invalidKeyring();
  let descriptor: number | undefined;
  try {
    // Open exactly once. NOFOLLOW rejects a symlink atomically; NONBLOCK lets
    // fstat reject a FIFO without waiting for an attacker-controlled writer.
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      (before.mode & 0o077n) !== 0n ||
      before.size < 1n ||
      before.size > BigInt(MAXIMUM_KEYRING_BYTES)
    ) {
      invalidKeyring();
    }
    const raw = Buffer.alloc(MAXIMUM_KEYRING_BYTES + 1);
    let length = 0;
    while (length < raw.byteLength) {
      const count = readSync(
        descriptor,
        raw,
        length,
        raw.byteLength - length,
        null,
      );
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      length > MAXIMUM_KEYRING_BYTES ||
      BigInt(length) !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.gid !== before.gid ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      invalidKeyring();
    }
    return parseSettlementDerivationKeyring(raw.subarray(0, length));
  } catch {
    return invalidKeyring();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertWireInput(
  operationKey: string,
  physicalWireAttempt: number,
): void {
  if (
    !OPERATION_KEY.test(operationKey) ||
    !Number.isSafeInteger(physicalWireAttempt) ||
    physicalWireAttempt < 1 ||
    physicalWireAttempt > MAXIMUM_PHYSICAL_WIRES
  ) {
    invalidWireIdentity();
  }
}

export function settlementWireIdentities(
  keyring: SettlementDerivationKeyring,
  operationKey: string,
  maximumWireCalls: number,
): readonly SettlementWireIdentity[] {
  assertWireInput(operationKey, maximumWireCalls);
  const identities: SettlementWireIdentity[] = [];
  for (
    let physicalWireAttempt = 1;
    physicalWireAttempt <= maximumWireCalls;
    physicalWireAttempt += 1
  ) {
    const requestId = keyring.deriveOpaque({
      keyId: keyring.activeKeyId,
      label: "request-id",
      operationKey,
      physicalWireAttempt,
    });
    const nonce = keyring.deriveOpaque({
      keyId: keyring.activeKeyId,
      label: "nonce",
      operationKey,
      physicalWireAttempt,
    });
    if (!requestId || !nonce) invalidWireIdentity();
    identities.push(
      Object.freeze({
        schemaVersion: "site-build-settlement-wire-identity/v1" as const,
        physicalWireAttempt: physicalWireAttempt as 1 | 2,
        derivationKeyId: keyring.activeKeyId,
        requestId,
        nonce,
        nonceSha256: createHash("sha256").update(nonce).digest("hex"),
      }),
    );
  }
  return Object.freeze(identities);
}

export function toDurableSettlementWireIdentity(
  identity: SettlementWireIdentity,
): DurableSettlementWireIdentity {
  return Object.freeze({
    schemaVersion: identity.schemaVersion,
    physicalWireAttempt: identity.physicalWireAttempt,
    derivationKeyId: identity.derivationKeyId,
    requestId: identity.requestId,
    nonceSha256: identity.nonceSha256,
  });
}

export function settlementWireNonce(
  keyring: SettlementDerivationKeyring,
  input: {
    operationKey: string;
    physicalWireAttempt: number;
    derivationKeyId: string;
    nonceSha256: string;
  },
): string | null {
  assertWireInput(input.operationKey, input.physicalWireAttempt);
  if (!KEY_ID.test(input.derivationKeyId) || !SHA256.test(input.nonceSha256)) {
    return null;
  }
  const nonce = keyring.deriveOpaque({
    keyId: input.derivationKeyId,
    label: "nonce",
    operationKey: input.operationKey,
    physicalWireAttempt: input.physicalWireAttempt,
  });
  if (!nonce) return null;
  const actual = Buffer.from(
    createHash("sha256").update(nonce).digest("hex"),
    "hex",
  );
  const expected = Buffer.from(input.nonceSha256, "hex");
  return timingSafeEqual(actual, expected) ? nonce : null;
}
