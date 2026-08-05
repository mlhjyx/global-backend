import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify as verifySignature,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertCopyOperatorEvidenceAuthorizationCurrent,
  canonicalCopyOperatorEvidenceSigningBytes,
  copyOperatorEvidenceAuthorizationIsCurrentAt,
  getCopyOperatorEvidenceAuthorizationAttestation,
  verifyCopyOperatorEvidenceAuthorization,
} from "./copy-operator-evidence-authorization";
import {
  COPY_OPERATOR_EVIDENCE_KEY_ID,
  COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_PEM,
  COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_SHA256,
} from "./copy-operator-evidence-key";

const SIGNING_DOMAIN =
  "site-builder-copy-operator-evidence-authorization/2026-08-05-v1\0";
const SIGNATURE =
  "-7Xw6OOH0IYy35npgA8vHKguMy5r41kBTzbwu2WfdDMZlYKQiz8dkLqc7BExkpzmebl6R2EFP1umbTi6VtPNBg";

const PAYLOAD = Object.freeze({
  schemaVersion:
    "site-builder-copy-operator-evidence-authorization/2026-08-05-v1" as const,
  purpose: "site_builder_copy_gateway_settlement_evidence" as const,
  keyId: "copy-evidence-operator-2026-08-v1" as const,
  algorithm: "Ed25519" as const,
  authorizationId: "copy-evidence-auth-test-001",
  issuedAt: "2026-08-05T10:00:00.000Z",
  expiresAt: "2026-08-05T10:15:00.000Z",
  candidateReceiptDigest: "a".repeat(64),
});

function signedAuthorization(
  input: {
    payload?: Record<string, unknown>;
    signatureBase64Url?: string;
  } = {},
) {
  return {
    payload: input.payload ?? PAYLOAD,
    signatureBase64Url: input.signatureBase64Url ?? SIGNATURE,
  };
}

function authorize(
  input: {
    signedPayload?: Record<string, unknown>;
    expectedPayload?: Record<string, unknown>;
    signatureBase64Url?: string;
  } = {},
) {
  return verifyCopyOperatorEvidenceAuthorization({
    signedAuthorization: signedAuthorization({
      payload: input.signedPayload,
      signatureBase64Url: input.signatureBase64Url,
    }),
    expectedPayload: input.expectedPayload ?? PAYLOAD,
  });
}

describe("Copy operator evidence authorization", () => {
  it("verifies the fixed Ed25519 trust key and returns an opaque authorization handle", () => {
    expect(COPY_OPERATOR_EVIDENCE_KEY_ID).toBe(PAYLOAD.keyId);
    expect(COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_SHA256).toBe(
      "90a80a686b217df4a524a709d940ca9cc133348722e8d611aa4cb2549b21dca7",
    );

    const handle = authorize();
    expect(
      getCopyOperatorEvidenceAuthorizationAttestation(handle),
    ).toMatchObject({
      authorizationId: PAYLOAD.authorizationId,
      keyId: COPY_OPERATOR_EVIDENCE_KEY_ID,
      publicKeySha256: COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_SHA256,
      candidateReceiptDigest: PAYLOAD.candidateReceiptDigest,
    });
  });

  it("domain-separates the recursively canonical payload bytes", () => {
    const signingBytes = Buffer.from(
      canonicalCopyOperatorEvidenceSigningBytes(PAYLOAD),
    );
    const signature = Buffer.from(SIGNATURE, "base64url");
    const publicKey = createPublicKey(COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_PEM);

    expect(
      signingBytes.subarray(0, Buffer.byteLength(SIGNING_DOMAIN)).toString(),
    ).toBe(SIGNING_DOMAIN);
    expect(verifySignature(null, signingBytes, publicKey, signature)).toBe(
      true,
    );
    expect(
      verifySignature(
        null,
        signingBytes.subarray(Buffer.byteLength(SIGNING_DOMAIN)),
        publicKey,
        signature,
      ),
    ).toBe(false);

    const reordered = {
      candidateReceiptDigest: PAYLOAD.candidateReceiptDigest,
      expiresAt: PAYLOAD.expiresAt,
      issuedAt: PAYLOAD.issuedAt,
      authorizationId: PAYLOAD.authorizationId,
      algorithm: PAYLOAD.algorithm,
      keyId: PAYLOAD.keyId,
      purpose: PAYLOAD.purpose,
      schemaVersion: PAYLOAD.schemaVersion,
    };
    expect(
      Buffer.from(canonicalCopyOperatorEvidenceSigningBytes(reordered)),
    ).toEqual(signingBytes);
  });

  it.each([
    ["expired", new Date(PAYLOAD.expiresAt)],
    ["issued in the future", new Date("2026-08-05T09:59:59.999Z")],
  ])("rejects a valid signature that is %s", (_name, now) => {
    const handle = authorize();
    const attestation =
      getCopyOperatorEvidenceAuthorizationAttestation(handle)!;
    expect(
      copyOperatorEvidenceAuthorizationIsCurrentAt(
        attestation,
        now.getTime(),
      ),
    ).toBe(false);
  });

  it("rejects a proof lifetime longer than fifteen minutes", () => {
    expect(() =>
      authorize({
        signedPayload: {
          ...PAYLOAD,
          expiresAt: "2026-08-05T10:15:00.001Z",
        },
        expectedPayload: {
          ...PAYLOAD,
          expiresAt: "2026-08-05T10:15:00.001Z",
        },
      }),
    ).toThrow("COPY_OPERATOR_EVIDENCE_LIFETIME_INVALID");
  });

  it.each([
    ["unknown key", { keyId: "copy-evidence-operator-attacker" }],
    ["wrong algorithm", { algorithm: "RSA-PSS" }],
  ])("rejects %s before accepting a signature", (_name, override) => {
    const payload = { ...PAYLOAD, ...override };
    expect(() =>
      authorize({ signedPayload: payload, expectedPayload: payload }),
    ).toThrow(/COPY_OPERATOR_EVIDENCE_(KEY|ALGORITHM)_/u);
  });

  it.each([
    ["padding", `${SIGNATURE}=`],
    ["standard base64 alphabet", SIGNATURE.replace("-", "+")],
    ["leading whitespace", ` ${SIGNATURE}`],
    ["trailing newline", `${SIGNATURE}\n`],
  ])("rejects a non-canonical base64url signature with %s", (_name, value) => {
    expect(() => authorize({ signatureBase64Url: value })).toThrow(
      "COPY_OPERATOR_EVIDENCE_SIGNATURE_INVALID",
    );
  });

  it("rejects a self-signed authorization even when it claims the trusted key id", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const attackerSignature = sign(
      null,
      canonicalCopyOperatorEvidenceSigningBytes(PAYLOAD),
      privateKey,
    ).toString("base64url");

    expect(() => authorize({ signatureBase64Url: attackerSignature })).toThrow(
      "COPY_OPERATOR_EVIDENCE_SIGNATURE_INVALID",
    );
  });

  it("rejects any candidate receipt digest drift after signing", () => {
    const drifted = {
      ...PAYLOAD,
      candidateReceiptDigest: "b".repeat(64),
    };
    expect(() =>
      authorize({ signedPayload: drifted, expectedPayload: drifted }),
    ).toThrow("COPY_OPERATOR_EVIDENCE_SIGNATURE_INVALID");
    expect(() => authorize({ expectedPayload: drifted })).toThrow(
      "COPY_OPERATOR_EVIDENCE_PAYLOAD_MISMATCH",
    );
  });

  it.each([
    ["extra key", { ...PAYLOAD, publicKey: "attacker-inline-key" }],
    [
      "missing key",
      Object.fromEntries(
        Object.entries(PAYLOAD).filter(([key]) => key !== "purpose"),
      ),
    ],
  ])("rejects a payload with an inexact shape: %s", (_name, payload) => {
    expect(() =>
      authorize({ signedPayload: payload, expectedPayload: PAYLOAD }),
    ).toThrow(/COPY_OPERATOR_EVIDENCE_PAYLOAD_/u);
  });

  it("does not trust a structured clone of the opaque authorization handle", () => {
    const handle = authorize();
    const cloned = structuredClone(handle);

    expect(
      getCopyOperatorEvidenceAuthorizationAttestation(handle),
    ).toBeDefined();
    expect(
      getCopyOperatorEvidenceAuthorizationAttestation(cloned),
    ).toBeUndefined();
  });

  it("rechecks expiry when the verified authorization is consumed", () => {
    const handle = authorize();
    expect(() =>
      assertCopyOperatorEvidenceAuthorizationCurrent(handle),
    ).toThrow("COPY_OPERATOR_EVIDENCE_LIFETIME_INVALID");
  });
});
