import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../../model-runtime";
import { COPY_CAPABILITY_PILOT_PLAN } from "./copy-capability-pilot";
import {
  COPY_REAL_CAPABILITY_ADMISSION_SOURCE,
  validateCopyRealCapabilityAdmissionEnvelope,
  type CopyRealCapabilityAdmissionInput,
} from "./copy-real-capability-admission";

const NOW = "2026-08-05T06:00:00.000Z";
const SOURCE_COMMIT = "a".repeat(40);
const SOURCE_BUNDLE_DIGEST = "b".repeat(64);
const TOKEN_DIGEST = "c".repeat(64);
const LEDGER_DIGEST = "d".repeat(64);
const RESERVATION_DIGEST = "e".repeat(64);

function validInput(): CopyRealCapabilityAdmissionInput {
  const manifest = {
    schemaVersion:
      "site-builder-copy-real-capability-manifest/2026-08-05-v1" as const,
    manifestId: "site-builder-copy-real-capability/2026-08-05-v1",
    fixedSourceCommit: SOURCE_COMMIT,
    sourceBundleDigest: SOURCE_BUNDLE_DIGEST,
    planDigest: canonicalDigest(COPY_CAPABILITY_PILOT_PLAN),
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    taskId: "site_builder.copy" as const,
    plannedExecutions: 3 as const,
    maximumWireCalls: 6 as const,
    maximumRepairCallsPerExecution: 1 as const,
    executions: COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions,
  };
  const credential = {
    schemaVersion:
      "site-builder-copy-pilot-credential-attestation/2026-08-05-v3" as const,
    attestationId: "copy-pilot-credential-attestation-20260805",
    capturedAt: "2026-08-05T05:55:00.000Z",
    expiresAt: "2026-08-05T07:00:00.000Z",
    gatewayOrigin: "https://gateway.internal.example",
    bearerTokenSha256: TOKEN_DIGEST,
    purpose: "site_builder_copy_capability_pilot" as const,
    quotaMode: "limited" as const,
    quotaCapPoints: 10_000,
    remainingQuotaPoints: 10_000,
    maximumQuotaPointsPerWire: 1_000,
    reservedQuotaPoints: 6_000,
    scopeExact: true as const,
    repairPayloadPolicy: "bounded_structured_prior_output_64k" as const,
    executions: COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions,
    channels: COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions.map(
      ({ alias, protocol }, index) => ({
        alias,
        protocol,
        channelId: index + 10,
      }),
    ),
    resolverId: "copy-pilot-new-api-log-resolver-v1",
  };
  const settlement = {
    schemaVersion:
      "site-builder-copy-pilot-settlement-observer/2026-08-05-v1" as const,
    resolverId: credential.resolverId,
    status: "READY" as const,
    observation: "request_bound_new_api_consume_log" as const,
    requestIdentityHeader: "x-oneapi-request-id" as const,
    requiredObservationPerPhysicalCall: true as const,
    maximumPollDurationMs: 5_000,
    unknownSettlementPolicy: "freeze_campaign" as const,
  };
  const authorization = {
    schemaVersion:
      "site-builder-copy-pilot-dispatch-authorization/2026-08-05-v1" as const,
    authorizationId: "copy-pilot-authorization-20260805",
    status: "AUTHORIZED" as const,
    issuedAt: "2026-08-05T05:58:00.000Z",
    expiresAt: "2026-08-05T07:00:00.000Z",
    manifestDigest: canonicalDigest(manifest),
    credentialAttestationDigest: canonicalDigest(credential),
    settlementObserverDigest: canonicalDigest(settlement),
    ledgerIdentityDigest: LEDGER_DIGEST,
    reservationId: "copy-pilot-reservation-20260805",
    reservationDigest: RESERVATION_DIGEST,
    reservationStatus: "RESERVED" as const,
    maximumExecutions: 3 as const,
    maximumWireCalls: 6 as const,
    maximumRepairCallsPerExecution: 1 as const,
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
    authorization,
  };
}

describe("Copy real capability pilot admission", () => {
  it("publishes a zero-call exact-scope source contract", () => {
    expect(COPY_REAL_CAPABILITY_ADMISSION_SOURCE).toMatchObject({
      schemaVersion:
        "site-builder-copy-real-capability-admission-source/2026-08-05-v3",
      taskId: "site_builder.copy",
      dispatchAuthorization: "NOT_AUTHORIZED",
      observedModelWireCalls: 0,
      observedModelCost: { CNY: 0, USD: 0 },
      plannedExecutions: 3,
      maximumWireCalls: 6,
      maximumRepairCallsPerExecution: 1,
      requiredFollowup: "POST_MERGE_CREATE_ONLY_MANIFEST",
    });
    expect(COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions).toEqual([
      {
        alias: "gpt-5.6-terra",
        protocol: "openai_responses",
        reasoning: "medium",
      },
      {
        alias: "gpt-5.6-sol",
        protocol: "openai_responses",
        reasoning: "high",
      },
      {
        alias: "claude-sonnet-5",
        protocol: "anthropic_messages",
        reasoning: "medium",
      },
    ]);
    expect(Object.isFrozen(COPY_REAL_CAPABILITY_ADMISSION_SOURCE)).toBe(true);
    expect(
      Object.isFrozen(COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions),
    ).toBe(true);
  });

  it("returns only a non-dispatch validation when every declared gate is bound", () => {
    const input = validInput();
    const validation = validateCopyRealCapabilityAdmissionEnvelope(
      input,
      new Date(NOW),
    );

    expect(validation).toEqual({
      schemaVersion:
        "site-builder-copy-real-capability-admission-validation/2026-08-05-v1",
      classification: "SOURCE_CONTRACT_VALIDATION_ONLY",
      dispatchCapable: false,
      taskId: "site_builder.copy",
      manifestDigest: canonicalDigest(input.manifest),
      fixedSourceCommit: SOURCE_COMMIT,
      credentialAttestationDigest: canonicalDigest(input.credential),
      settlementObserverDigest: canonicalDigest(input.settlement),
      authorizationId: input.authorization.authorizationId,
      ledgerIdentityDigest: LEDGER_DIGEST,
      reservationId: input.authorization.reservationId,
      reservationDigest: RESERVATION_DIGEST,
      maximumExecutions: 3,
      maximumWireCalls: 6,
    });
    expect(Object.isFrozen(validation)).toBe(true);
  });

  it("rejects secret-bearing input shapes", () => {
    const secretBearing = validInput();
    const forbiddenSecretField = ["api", "Key"].join("");
    secretBearing.credential = {
      ...secretBearing.credential,
      [forbiddenSecretField]: "fixture-extra-field",
    } as typeof secretBearing.credential;
    expect(() =>
      validateCopyRealCapabilityAdmissionEnvelope(secretBearing, new Date(NOW)),
    ).toThrow("COPY_REAL_CAPABILITY_CREDENTIAL_INVALID");
  });

  it.each([
    [
      "COPY_REAL_CAPABILITY_FIXED_COMMIT_MISMATCH",
      (input: CopyRealCapabilityAdmissionInput) => ({
        ...input,
        sourceVerification: {
          ...input.sourceVerification,
          fixedSourceCommit: "e".repeat(40),
        },
      }),
    ],
    [
      "COPY_REAL_CAPABILITY_SOURCE_BUNDLE_UNVERIFIED",
      (input: CopyRealCapabilityAdmissionInput) => ({
        ...input,
        sourceVerification: {
          ...input.sourceVerification,
          trackedSourceBytesMatch: false,
        },
      }),
    ],
    [
      "COPY_REAL_CAPABILITY_SCOPE_MISMATCH",
      (input: CopyRealCapabilityAdmissionInput) => ({
        ...input,
        credential: {
          ...input.credential,
          executions: input.credential.executions.slice(0, 2),
        },
      }),
    ],
    [
      "COPY_REAL_CAPABILITY_CREDENTIAL_INVALID",
      (input: CopyRealCapabilityAdmissionInput) => ({
        ...input,
        credential: { ...input.credential, quotaMode: "unlimited" as never },
      }),
    ],
    [
      "COPY_REAL_CAPABILITY_CREDENTIAL_INVALID",
      (input: CopyRealCapabilityAdmissionInput) => ({
        ...input,
        credential: {
          ...input.credential,
          reservedQuotaPoints: 1,
        },
      }),
    ],
    [
      "COPY_REAL_CAPABILITY_SETTLEMENT_UNAVAILABLE",
      (input: CopyRealCapabilityAdmissionInput) => ({
        ...input,
        settlement: { ...input.settlement, status: "UNAVAILABLE" as never },
      }),
    ],
    [
      "COPY_REAL_CAPABILITY_AUTHORIZATION_MISMATCH",
      (input: CopyRealCapabilityAdmissionInput) => ({
        ...input,
        authorization: {
          ...input.authorization,
          maximumWireCalls: 7 as never,
        },
      }),
    ],
  ])("fails closed with %s", (code, mutate) => {
    expect(() =>
      validateCopyRealCapabilityAdmissionEnvelope(
        mutate(validInput()),
        new Date(NOW),
      ),
    ).toThrow(code);
  });

  it("rejects expired proofs and any unbound digest", () => {
    const expired = validInput();
    expect(() =>
      validateCopyRealCapabilityAdmissionEnvelope(
        expired,
        new Date("2026-08-05T08:00:00.000Z"),
      ),
    ).toThrow("COPY_REAL_CAPABILITY_PROOF_EXPIRED");

    const unbound = validInput();
    unbound.authorization = {
      ...unbound.authorization,
      credentialAttestationDigest: "f".repeat(64),
    };
    expect(() =>
      validateCopyRealCapabilityAdmissionEnvelope(unbound, new Date(NOW)),
    ).toThrow("COPY_REAL_CAPABILITY_AUTHORIZATION_MISMATCH");
  });
});
