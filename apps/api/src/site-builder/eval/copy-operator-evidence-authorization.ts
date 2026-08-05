import {
  createHash,
  createPublicKey,
  verify as nodeVerifySignature,
} from "node:crypto";

import {
  COPY_OPERATOR_EVIDENCE_KEY_ID,
  COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_PEM,
  COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_SHA256,
} from "./copy-operator-evidence-key";

const SCHEMA_VERSION =
  "site-builder-copy-operator-evidence-authorization/2026-08-05-v1" as const;
const PURPOSE = "site_builder_copy_gateway_settlement_evidence" as const;
const ALGORITHM = "Ed25519" as const;
const TRUSTED_KEY_ID = "copy-evidence-operator-2026-08-v1" as const;
const TRUSTED_PUBLIC_KEY_SHA256 =
  "90a80a686b217df4a524a709d940ca9cc133348722e8d611aa4cb2549b21dca7" as const;
const SIGNING_DOMAIN = `${SCHEMA_VERSION}\0`;
const MAX_LIFETIME_MS = 15 * 60 * 1_000;
const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,191}$/u;
const CANONICAL_BASE64URL = /^[A-Za-z0-9_-]{86}$/u;
const FREEZE_OBJECT = Object.freeze.bind(Object);
const OBJECT_IS_FROZEN = Object.isFrozen.bind(Object);
const ARRAY_IS_ARRAY = Array.isArray.bind(Array);
const OWN_KEYS = Reflect.ownKeys.bind(Reflect);
const OWN_DESCRIPTOR = Object.getOwnPropertyDescriptor.bind(Object);
const JSON_STRINGIFY = JSON.stringify.bind(JSON);
const BUFFER_FROM = Buffer.from.bind(Buffer);
const BUFFER_TO_STRING = Function.call.bind(Buffer.prototype.toString) as (
  value: Buffer,
  encoding: BufferEncoding,
) => string;
const DATE_PARSE = Date.parse.bind(Date);
const DATE_TO_ISO_STRING = Function.call.bind(Date.prototype.toISOString) as (
  value: Date,
) => string;
const TRUSTED_DATE = Date;
const CURRENT_TIME_MILLISECONDS = Date.now.bind(Date);
const NUMBER_IS_FINITE = Number.isFinite.bind(Number);
const SHA256_TEST = SHA256.test.bind(SHA256);
const IDENTIFIER_TEST = IDENTIFIER.test.bind(IDENTIFIER);
const CANONICAL_BASE64URL_TEST =
  CANONICAL_BASE64URL.test.bind(CANONICAL_BASE64URL);
const PAYLOAD_KEYS = FREEZE_OBJECT([
  "schemaVersion",
  "purpose",
  "keyId",
  "algorithm",
  "authorizationId",
  "issuedAt",
  "expiresAt",
  "candidateReceiptDigest",
] as const);

export interface CopyOperatorEvidencePayload {
  schemaVersion: typeof SCHEMA_VERSION;
  purpose: typeof PURPOSE;
  keyId: typeof COPY_OPERATOR_EVIDENCE_KEY_ID;
  algorithm: typeof ALGORITHM;
  authorizationId: string;
  issuedAt: string;
  expiresAt: string;
  candidateReceiptDigest: string;
}

export interface SignedCopyOperatorEvidenceAuthorization {
  payload: CopyOperatorEvidencePayload;
  signatureBase64Url: string;
}

export interface VerifiedCopyOperatorEvidenceAuthorization {
  readonly classification: "OPAQUE_VERIFIED_OPERATOR_AUTHORIZATION";
}

export interface CopyOperatorEvidenceAuthorizationAttestation {
  authorizationId: string;
  keyId: typeof COPY_OPERATOR_EVIDENCE_KEY_ID;
  publicKeySha256: string;
  candidateReceiptDigest: string;
  payloadDigest: string;
  signatureDigest: string;
  issuedAt: string;
  expiresAt: string;
}

const VERIFIED_AUTHORIZATIONS = new WeakMap<
  object,
  CopyOperatorEvidenceAuthorizationAttestation
>();
const GET_VERIFIED_AUTHORIZATION = VERIFIED_AUTHORIZATIONS.get.bind(
  VERIFIED_AUTHORIZATIONS,
);
const SET_VERIFIED_AUTHORIZATION = VERIFIED_AUTHORIZATIONS.set.bind(
  VERIFIED_AUTHORIZATIONS,
);
const VERIFY_SIGNATURE = nodeVerifySignature;
const PUBLIC_KEY = createPublicKey(COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_PEM);
const PUBLIC_KEY_SHA256 = createHash("sha256")
  .update(PUBLIC_KEY.export({ format: "der", type: "spki" }))
  .digest("hex");
if (
  COPY_OPERATOR_EVIDENCE_KEY_ID !== TRUSTED_KEY_ID ||
  COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_SHA256 !== TRUSTED_PUBLIC_KEY_SHA256 ||
  PUBLIC_KEY_SHA256 !== TRUSTED_PUBLIC_KEY_SHA256
) {
  throw new Error("COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_DRIFT");
}
function fail(code: string): never {
  throw new Error(code);
}

function ownData(value: object, key: string): unknown {
  const descriptor = OWN_DESCRIPTOR(value, key);
  if (!descriptor?.enumerable || !("value" in descriptor)) {
    return fail("COPY_OPERATOR_EVIDENCE_PAYLOAD_INVALID");
  }
  return descriptor.value;
}

function canonicalPayloadJson(payload: CopyOperatorEvidencePayload): string {
  return `{"algorithm":${JSON_STRINGIFY(payload.algorithm)},"authorizationId":${JSON_STRINGIFY(payload.authorizationId)},"candidateReceiptDigest":${JSON_STRINGIFY(payload.candidateReceiptDigest)},"expiresAt":${JSON_STRINGIFY(payload.expiresAt)},"issuedAt":${JSON_STRINGIFY(payload.issuedAt)},"keyId":${JSON_STRINGIFY(payload.keyId)},"purpose":${JSON_STRINGIFY(payload.purpose)},"schemaVersion":${JSON_STRINGIFY(payload.schemaVersion)}}`;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactPayload(value: unknown): CopyOperatorEvidencePayload {
  if (!value || typeof value !== "object" || ARRAY_IS_ARRAY(value)) {
    return fail("COPY_OPERATOR_EVIDENCE_PAYLOAD_INVALID");
  }
  const keys = OWN_KEYS(value);
  if (keys.length !== PAYLOAD_KEYS.length) {
    return fail("COPY_OPERATOR_EVIDENCE_PAYLOAD_INVALID");
  }
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex];
    if (typeof key !== "string") {
      return fail("COPY_OPERATOR_EVIDENCE_PAYLOAD_INVALID");
    }
    let allowed = false;
    for (
      let expectedIndex = 0;
      expectedIndex < PAYLOAD_KEYS.length;
      expectedIndex += 1
    ) {
      const expected = PAYLOAD_KEYS[expectedIndex];
      if (key === expected) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return fail("COPY_OPERATOR_EVIDENCE_PAYLOAD_INVALID");
  }
  const normalized = {
    schemaVersion: ownData(value, "schemaVersion"),
    purpose: ownData(value, "purpose"),
    keyId: ownData(value, "keyId"),
    algorithm: ownData(value, "algorithm"),
    authorizationId: ownData(value, "authorizationId"),
    issuedAt: ownData(value, "issuedAt"),
    expiresAt: ownData(value, "expiresAt"),
    candidateReceiptDigest: ownData(value, "candidateReceiptDigest"),
  } as CopyOperatorEvidencePayload;
  if (
    normalized.schemaVersion !== SCHEMA_VERSION ||
    normalized.purpose !== PURPOSE ||
    typeof normalized.authorizationId !== "string" ||
    !IDENTIFIER_TEST(normalized.authorizationId) ||
    typeof normalized.issuedAt !== "string" ||
    typeof normalized.expiresAt !== "string" ||
    typeof normalized.candidateReceiptDigest !== "string" ||
    !SHA256_TEST(normalized.candidateReceiptDigest)
  ) {
    return fail("COPY_OPERATOR_EVIDENCE_PAYLOAD_INVALID");
  }
  if (normalized.keyId !== TRUSTED_KEY_ID) {
    return fail("COPY_OPERATOR_EVIDENCE_KEY_INVALID");
  }
  if (normalized.algorithm !== ALGORITHM) {
    return fail("COPY_OPERATOR_EVIDENCE_ALGORITHM_INVALID");
  }
  return FREEZE_OBJECT({ ...normalized });
}

function instant(value: string): number {
  const milliseconds = DATE_PARSE(value);
  if (
    !NUMBER_IS_FINITE(milliseconds) ||
    DATE_TO_ISO_STRING(new TRUSTED_DATE(milliseconds)) !== value
  ) {
    return fail("COPY_OPERATOR_EVIDENCE_LIFETIME_INVALID");
  }
  return milliseconds;
}

export function canonicalCopyOperatorEvidenceSigningBytes(
  payload: unknown,
): Uint8Array {
  return BUFFER_FROM(
    `${SIGNING_DOMAIN}${canonicalPayloadJson(exactPayload(payload))}`,
    "utf8",
  );
}

function assertSignaturePrimitiveCurrent(): void {
  const knownPayload = FREEZE_OBJECT({
    schemaVersion: SCHEMA_VERSION,
    purpose: PURPOSE,
    keyId: TRUSTED_KEY_ID,
    algorithm: ALGORITHM,
    authorizationId: "copy-evidence-auth-test-001",
    issuedAt: "2026-08-05T10:00:00.000Z",
    expiresAt: "2026-08-05T10:15:00.000Z",
    candidateReceiptDigest: "a".repeat(64),
  });
  const signingBytes = canonicalCopyOperatorEvidenceSigningBytes(knownPayload);
  const signature = BUFFER_FROM(
    "-7Xw6OOH0IYy35npgA8vHKguMy5r41kBTzbwu2WfdDMZlYKQiz8dkLqc7BExkpzmebl6R2EFP1umbTi6VtPNBg",
    "base64url",
  );
  const tampered = BUFFER_FROM(signingBytes);
  tampered[tampered.length - 1] ^= 1;
  if (
    !VERIFY_SIGNATURE(null, signingBytes, PUBLIC_KEY, signature) ||
    VERIFY_SIGNATURE(null, tampered, PUBLIC_KEY, signature)
  ) {
    throw new Error("COPY_OPERATOR_EVIDENCE_CRYPTO_PRIMITIVE_DRIFT");
  }
}

function assertFreezePrimitiveCurrent(): void {
  const probe = { value: "unchanged" };
  FREEZE_OBJECT(probe);
  if (!OBJECT_IS_FROZEN(probe) || Reflect.set(probe, "value", "mutated")) {
    throw new Error("COPY_OPERATOR_EVIDENCE_OBJECT_PRIMITIVE_DRIFT");
  }
}

assertSignaturePrimitiveCurrent();
assertFreezePrimitiveCurrent();

export function verifyCopyOperatorEvidenceAuthorization(input: {
  signedAuthorization: SignedCopyOperatorEvidenceAuthorization;
  expectedPayload: CopyOperatorEvidencePayload;
}): VerifiedCopyOperatorEvidenceAuthorization {
  const authorizationKeys =
    input.signedAuthorization &&
    typeof input.signedAuthorization === "object" &&
    !ARRAY_IS_ARRAY(input.signedAuthorization)
      ? OWN_KEYS(input.signedAuthorization)
      : [];
  if (
    !input.signedAuthorization ||
    typeof input.signedAuthorization !== "object" ||
    authorizationKeys.length !== 2
  ) {
    return fail("COPY_OPERATOR_EVIDENCE_AUTHORIZATION_INVALID");
  }
  for (let keyIndex = 0; keyIndex < authorizationKeys.length; keyIndex += 1) {
    const key = authorizationKeys[keyIndex];
    if (key !== "payload" && key !== "signatureBase64Url") {
      return fail("COPY_OPERATOR_EVIDENCE_AUTHORIZATION_INVALID");
    }
  }
  const payload = exactPayload(ownData(input.signedAuthorization, "payload"));
  const expected = exactPayload(input.expectedPayload);
  if (canonicalPayloadJson(payload) !== canonicalPayloadJson(expected)) {
    return fail("COPY_OPERATOR_EVIDENCE_PAYLOAD_MISMATCH");
  }
  const issuedAt = instant(payload.issuedAt);
  const expiresAt = instant(payload.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_LIFETIME_MS) {
    return fail("COPY_OPERATOR_EVIDENCE_LIFETIME_INVALID");
  }
  const signatureBase64Url = ownData(
    input.signedAuthorization,
    "signatureBase64Url",
  );
  if (
    typeof signatureBase64Url !== "string" ||
    !CANONICAL_BASE64URL_TEST(signatureBase64Url)
  ) {
    return fail("COPY_OPERATOR_EVIDENCE_SIGNATURE_INVALID");
  }
  const signature = BUFFER_FROM(signatureBase64Url, "base64url");
  if (
    signature.length !== 64 ||
    BUFFER_TO_STRING(signature, "base64url") !== signatureBase64Url ||
    !VERIFY_SIGNATURE(
      null,
      canonicalCopyOperatorEvidenceSigningBytes(payload),
      PUBLIC_KEY,
      signature,
    )
  ) {
    return fail("COPY_OPERATOR_EVIDENCE_SIGNATURE_INVALID");
  }
  const handle = FREEZE_OBJECT({
    classification: "OPAQUE_VERIFIED_OPERATOR_AUTHORIZATION" as const,
  });
  SET_VERIFIED_AUTHORIZATION(
    handle,
    FREEZE_OBJECT({
      authorizationId: payload.authorizationId,
      keyId: TRUSTED_KEY_ID,
      publicKeySha256: TRUSTED_PUBLIC_KEY_SHA256,
      candidateReceiptDigest: payload.candidateReceiptDigest,
      payloadDigest: sha256(canonicalCopyOperatorEvidenceSigningBytes(payload)),
      signatureDigest: sha256(signature),
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
    }),
  );
  return handle;
}

export function getCopyOperatorEvidenceAuthorizationAttestation(
  handle: VerifiedCopyOperatorEvidenceAuthorization,
): CopyOperatorEvidenceAuthorizationAttestation | undefined {
  return GET_VERIFIED_AUTHORIZATION(handle);
}

export function assertCopyOperatorEvidenceAuthorizationCurrent(
  handle: VerifiedCopyOperatorEvidenceAuthorization,
): CopyOperatorEvidenceAuthorizationAttestation {
  const attestation = GET_VERIFIED_AUTHORIZATION(handle);
  if (!attestation)
    return fail("COPY_OPERATOR_EVIDENCE_AUTHORIZATION_REQUIRED");
  if (
    !copyOperatorEvidenceAuthorizationIsCurrentAt(
      attestation,
      CURRENT_TIME_MILLISECONDS(),
    )
  ) {
    return fail("COPY_OPERATOR_EVIDENCE_LIFETIME_INVALID");
  }
  return attestation;
}

export function copyOperatorEvidenceAuthorizationIsCurrentAt(
  attestation: CopyOperatorEvidenceAuthorizationAttestation,
  nowMilliseconds: number,
): boolean {
  return (
    NUMBER_IS_FINITE(nowMilliseconds) &&
    nowMilliseconds >= instant(attestation.issuedAt) &&
    nowMilliseconds < instant(attestation.expiresAt)
  );
}

// Production dispatch loads this file through the compiled CommonJS runner.
// Freeze the completed export table so a preload cannot replace the verifier
// or WeakMap-backed attestation accessors after initialization.
if (typeof module !== "undefined") FREEZE_OBJECT(module.exports);
