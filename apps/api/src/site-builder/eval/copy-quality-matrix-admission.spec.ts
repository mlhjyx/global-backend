import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../../model-runtime";
import { COPY_EVALUATION_V2_CANDIDATES } from "./copy-evaluation-v2-candidates";
import { COPY_QUALITY_MATRIX_PLAN } from "./copy-quality-matrix-runner";
import {
  COPY_QUALITY_MATRIX_ADMISSION_SOURCE,
  copyQualityMatrixReservationDigest,
  validateCopyQualityMatrixAdmissionEnvelope,
  type CopyQualityMatrixAdmissionInput,
  type CopyQualityMatrixDispatchAuthorization,
} from "./copy-quality-matrix-admission";

const NOW = "2026-08-06T06:00:00.000Z";
const SOURCE_COMMIT = "a".repeat(40);
const SOURCE_BUNDLE_DIGEST = "b".repeat(64);
const MATRIX_TOKEN_DIGEST = "c".repeat(64);
const PILOT_TOKEN_DIGEST = "d".repeat(64);
const MATRIX_LEDGER_DIGEST = "e".repeat(64);
const PILOT_LEDGER_DIGEST = "f".repeat(64);

function validInput(): CopyQualityMatrixAdmissionInput {
  const manifest = {
    schemaVersion:
      "site-builder-copy-quality-matrix-manifest/2026-08-07-v2" as const,
    manifestId: "site-builder-copy-quality-matrix/2026-08-07-v2-test",
    fixedSourceCommit: SOURCE_COMMIT,
    sourceBundleDigest: SOURCE_BUNDLE_DIGEST,
    planDigest: canonicalDigest(COPY_QUALITY_MATRIX_PLAN),
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    taskId: "site_builder.copy" as const,
    purpose: "site_builder_copy_quality_matrix" as const,
    plannedExecutions: 36 as const,
    maximumWireCalls: 72 as const,
    maximumRepairCallsPerExecution: 1 as const,
    ledgerTopology: "shared_campaign_ledger" as const,
    acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted" as const,
    evidenceKind: "quality_matrix" as const,
    outputReplayPolicy:
      "git_reviewed_canonical_output_bytes_consume_once" as const,
    executions: COPY_QUALITY_MATRIX_ADMISSION_SOURCE.executions,
  };
  const credential = {
    schemaVersion:
      "site-builder-copy-quality-matrix-credential-attestation/2026-08-06-v1" as const,
    attestationId: "copy-quality-matrix-credential-attestation-test",
    capturedAt: "2026-08-06T05:55:00.000Z",
    expiresAt: "2026-08-06T07:00:00.000Z",
    gatewayOrigin: "https://gateway.internal.example",
    bearerTokenSha256: MATRIX_TOKEN_DIGEST,
    purpose: "site_builder_copy_quality_matrix" as const,
    quotaMode: "limited" as const,
    quotaCapPoints: 100_000,
    remainingQuotaPoints: 100_000,
    maximumQuotaPointsPerWire: 1_000,
    reservedQuotaPoints: 72_000,
    scopeExact: true as const,
    repairPayloadPolicy: "bounded_structured_prior_output_64k" as const,
    candidates: COPY_EVALUATION_V2_CANDIDATES.map(
      ({ alias, protocol, reasoning }) => ({ alias, protocol, reasoning }),
    ),
    channels: COPY_EVALUATION_V2_CANDIDATES.map(
      ({ alias, protocol }, index) => ({
        alias,
        protocol,
        channelId: index + 10,
      }),
    ),
    resolverId: "copy-quality-matrix-new-api-log-resolver-v1",
  };
  const settlement = {
    schemaVersion:
      "site-builder-copy-quality-matrix-settlement-observer/2026-08-06-v1" as const,
    resolverId: credential.resolverId,
    status: "READY" as const,
    observation: "request_bound_new_api_consume_log" as const,
    requestIdentityHeader: "x-oneapi-request-id" as const,
    requiredObservationPerPhysicalCall: true as const,
    maximumPollDurationMs: 5_000,
    unknownSettlementPolicy: "freeze_matrix_and_stop_dispatch" as const,
  };
  const pilotSeparation = {
    schemaVersion:
      "site-builder-copy-quality-matrix-pilot-separation-proof/2026-08-06-v1" as const,
    pilotPurpose: "site_builder_copy_capability_pilot" as const,
    pilotMaximumExecutions: 3 as const,
    pilotMaximumWireCalls: 6 as const,
    pilotBearerTokenSha256: PILOT_TOKEN_DIGEST,
    pilotAuthorizationIds: ["copy-pilot-global-authorization-test"],
    pilotReservationIds: ["copy-pilot-reservation-test"],
    pilotLedgerIdentityDigests: [PILOT_LEDGER_DIGEST],
  };
  const authorizationWithoutReservationDigest = {
    schemaVersion:
      "site-builder-copy-quality-matrix-dispatch-authorization/2026-08-06-v1" as const,
    authorizationId: "copy-quality-matrix-authorization-test",
    status: "AUTHORIZED" as const,
    issuedAt: "2026-08-06T05:58:00.000Z",
    expiresAt: "2026-08-06T07:00:00.000Z",
    purpose: "site_builder_copy_quality_matrix" as const,
    manifestDigest: canonicalDigest(manifest),
    credentialAttestationDigest: canonicalDigest(credential),
    settlementObserverDigest: canonicalDigest(settlement),
    pilotSeparationProofDigest: canonicalDigest(pilotSeparation),
    reservationId: "copy-quality-matrix-reservation-test",
    reservationStatus: "RESERVED" as const,
    reservedQuotaPoints: 72_000,
    ledgerId: "copy-quality-matrix-ledger-test",
    ledgerIdentityDigest: MATRIX_LEDGER_DIGEST,
    maximumExecutions: 36 as const,
    maximumWireCalls: 72 as const,
    maximumRepairCallsPerExecution: 1 as const,
    unknownSettlementPolicy: "freeze_matrix_and_stop_dispatch" as const,
  };
  const authorization: CopyQualityMatrixDispatchAuthorization = {
    ...authorizationWithoutReservationDigest,
    reservationDigest: copyQualityMatrixReservationDigest(
      authorizationWithoutReservationDigest,
    ),
  };
  return {
    manifest,
    sourceVerification: {
      fixedSourceCommit: SOURCE_COMMIT,
      sourceBundleDigest: SOURCE_BUNDLE_DIGEST,
      fixedCommitReachableFromExecutionHead: true,
      trackedSourceBytesMatch: true,
      compiledContractsMatch: true,
    },
    credential,
    settlement,
    pilotSeparation,
    authorization,
  };
}

describe("Copy quality matrix admission", () => {
  it("publishes one immutable matrix-only 36/72 contract", () => {
    expect(COPY_QUALITY_MATRIX_ADMISSION_SOURCE).toMatchObject({
      schemaVersion:
        "site-builder-copy-quality-matrix-admission-source/2026-08-07-v2",
      taskId: "site_builder.copy",
      purpose: "site_builder_copy_quality_matrix",
      dispatchAuthorization: "NOT_AUTHORIZED",
      plannedExecutions: 36,
      maximumWireCalls: 72,
      maximumRepairCallsPerExecution: 1,
      ledgerTopology: "shared_campaign_ledger",
      acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
      evidenceKind: "quality_matrix",
      outputReplayPolicy: "git_reviewed_canonical_output_bytes_consume_once",
      unknownSettlementPolicy: "freeze_matrix_and_stop_dispatch",
    });
    expect(COPY_QUALITY_MATRIX_ADMISSION_SOURCE.executions).toHaveLength(36);
    expect(COPY_QUALITY_MATRIX_ADMISSION_SOURCE.requiredFollowup).toEqual([
      "SUCCESSFUL_CAPABILITY_PILOT_EVIDENCE",
      "SEPARATE_MATRIX_DISPATCH_AUTHORIZATION",
    ]);
    expect(Object.isFrozen(COPY_QUALITY_MATRIX_ADMISSION_SOURCE)).toBe(true);
    expect(
      Object.isFrozen(COPY_QUALITY_MATRIX_ADMISSION_SOURCE.executions),
    ).toBe(true);
  });

  it("admits the exact Terra/Sol/Sonnet matrix with finite reserved quota", () => {
    const input = validInput();
    const validation = validateCopyQualityMatrixAdmissionEnvelope(
      input,
      new Date(NOW),
    );

    expect(validation).toMatchObject({
      schemaVersion:
        "site-builder-copy-quality-matrix-admission-validation/2026-08-07-v2",
      classification: "SOURCE_CONTRACT_VALIDATION_ONLY",
      dispatchCapable: false,
      taskId: "site_builder.copy",
      purpose: "site_builder_copy_quality_matrix",
      maximumExecutions: 36,
      maximumWireCalls: 72,
      maximumRepairCallsPerExecution: 1,
      ledgerTopology: "shared_campaign_ledger",
      acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
      evidenceKind: "quality_matrix",
      outputReplayPolicy: "git_reviewed_canonical_output_bytes_consume_once",
      unknownSettlementPolicy: "freeze_matrix_and_stop_dispatch",
      authorizationId: input.authorization.authorizationId,
      reservationId: input.authorization.reservationId,
      ledgerIdentityDigest: MATRIX_LEDGER_DIGEST,
    });
    expect(validation.planDigest).toBe(
      canonicalDigest(COPY_QUALITY_MATRIX_PLAN),
    );
    expect(Object.isFrozen(validation)).toBe(true);
  });

  it.each([
    [
      "COPY_QUALITY_MATRIX_MANIFEST_INVALID",
      (input: CopyQualityMatrixAdmissionInput) => ({
        ...input,
        manifest: {
          ...input.manifest,
          plannedExecutions: 3 as never,
          maximumWireCalls: 6 as never,
        },
      }),
    ],
    [
      "COPY_QUALITY_MATRIX_CREDENTIAL_INVALID",
      (input: CopyQualityMatrixAdmissionInput) => ({
        ...input,
        credential: {
          ...input.credential,
          purpose: "site_builder_copy_capability_pilot" as never,
        },
      }),
    ],
    [
      "COPY_QUALITY_MATRIX_SCOPE_MISMATCH",
      (input: CopyQualityMatrixAdmissionInput) => ({
        ...input,
        credential: {
          ...input.credential,
          candidates: input.credential.candidates.map((candidate, index) =>
            index === 1
              ? { ...candidate, reasoning: "medium" as const }
              : candidate,
          ),
        },
      }),
    ],
    [
      "COPY_QUALITY_MATRIX_CREDENTIAL_INVALID",
      (input: CopyQualityMatrixAdmissionInput) => ({
        ...input,
        credential: { ...input.credential, quotaCapPoints: Infinity },
      }),
    ],
    [
      "COPY_QUALITY_MATRIX_AUTHORIZATION_MISMATCH",
      (input: CopyQualityMatrixAdmissionInput) => ({
        ...input,
        authorization: {
          ...input.authorization,
          maximumExecutions: 3 as never,
          maximumWireCalls: 6 as never,
        },
      }),
    ],
    [
      "COPY_QUALITY_MATRIX_SETTLEMENT_UNAVAILABLE",
      (input: CopyQualityMatrixAdmissionInput) => ({
        ...input,
        settlement: {
          ...input.settlement,
          unknownSettlementPolicy: "continue" as never,
        },
      }),
    ],
  ])("fails closed with %s", (code, mutate) => {
    expect(() =>
      validateCopyQualityMatrixAdmissionEnvelope(
        mutate(validInput()),
        new Date(NOW),
      ),
    ).toThrow(code);
  });

  it.each([
    [
      "credential",
      (input: CopyQualityMatrixAdmissionInput) => ({
        ...input,
        credential: {
          ...input.credential,
          bearerTokenSha256: input.pilotSeparation.pilotBearerTokenSha256,
        },
      }),
    ],
    [
      "authorization",
      (input: CopyQualityMatrixAdmissionInput) => ({
        ...input,
        authorization: {
          ...input.authorization,
          authorizationId: input.pilotSeparation.pilotAuthorizationIds[0]!,
        },
      }),
    ],
    [
      "reservation",
      (input: CopyQualityMatrixAdmissionInput) => ({
        ...input,
        authorization: {
          ...input.authorization,
          reservationId: input.pilotSeparation.pilotReservationIds[0]!,
        },
      }),
    ],
    [
      "ledger",
      (input: CopyQualityMatrixAdmissionInput) => ({
        ...input,
        authorization: {
          ...input.authorization,
          ledgerIdentityDigest:
            input.pilotSeparation.pilotLedgerIdentityDigests[0]!,
        },
      }),
    ],
  ])("rejects reused capability pilot %s identity", (_name, mutate) => {
    expect(() =>
      validateCopyQualityMatrixAdmissionEnvelope(
        mutate(validInput()),
        new Date(NOW),
      ),
    ).toThrow("COPY_QUALITY_MATRIX_CAPABILITY_PILOT_REUSE");
  });

  it("rejects expired proofs and credential objects carrying a secret", () => {
    expect(() =>
      validateCopyQualityMatrixAdmissionEnvelope(
        validInput(),
        new Date("2026-08-06T08:00:00.000Z"),
      ),
    ).toThrow("COPY_QUALITY_MATRIX_PROOF_EXPIRED");

    const secretBearing = validInput();
    const forbiddenCredentialField = "api" + "Key";
    secretBearing.credential = {
      ...secretBearing.credential,
      [forbiddenCredentialField]: "redacted-test-value",
    } as never;
    expect(() =>
      validateCopyQualityMatrixAdmissionEnvelope(secretBearing, new Date(NOW)),
    ).toThrow("COPY_QUALITY_MATRIX_CREDENTIAL_INVALID");
  });
});
