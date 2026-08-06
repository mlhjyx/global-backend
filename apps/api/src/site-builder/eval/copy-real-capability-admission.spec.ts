import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../../model-runtime";
import { COPY_CAPABILITY_PILOT_PLAN } from "./copy-capability-pilot";
import {
  COPY_REAL_CAPABILITY_ADMISSION_SOURCE,
  copyPilotChildReservationDigest,
  validateCopyRealCapabilityAdmissionEnvelope,
  type CopyPilotChildDispatchAuthorization,
  type CopyPilotDispatchAuthorization,
  type CopyRealCapabilityAdmissionInput,
} from "./copy-real-capability-admission";

const NOW = "2026-08-06T06:00:00.000Z";
const SOURCE_COMMIT = "a".repeat(40);
const SOURCE_BUNDLE_DIGEST = "b".repeat(64);
const TOKEN_DIGEST = "c".repeat(64);

function validInput(
  selectedExecutionKey = COPY_CAPABILITY_PILOT_PLAN.executions[0]!.executionKey,
): CopyRealCapabilityAdmissionInput {
  const manifest = {
    schemaVersion:
      "site-builder-copy-real-capability-manifest/2026-08-05-v1" as const,
    manifestId: "site-builder-copy-real-capability/2026-08-06-v7-test",
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
    attestationId: "copy-pilot-credential-attestation-isolated-test",
    capturedAt: "2026-08-06T05:55:00.000Z",
    expiresAt: "2026-08-06T07:00:00.000Z",
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
    resolverId: "copy-pilot-new-api-log-resolver-isolated-v1",
  };
  const settlement = {
    schemaVersion:
      "site-builder-copy-pilot-settlement-observer/2026-08-06-v2" as const,
    resolverId: credential.resolverId,
    status: "READY" as const,
    observation: "request_bound_new_api_consume_log" as const,
    requestIdentityHeader: "x-oneapi-request-id" as const,
    requiredObservationPerPhysicalCall: true as const,
    maximumPollDurationMs: 5_000,
    unknownSettlementPolicy: "freeze_selected_child_campaign" as const,
  };
  const children = COPY_CAPABILITY_PILOT_PLAN.childCampaigns.map(
    (child, index) => ({
      ...child,
      campaignId: `copy-isolated-campaign-${index + 1}`,
      authorizationId: `copy-isolated-authorization-${index + 1}`,
      reservationId: `copy-isolated-reservation-${index + 1}`,
      ledgerIdentityDigest: String(index + 1).repeat(64),
      reservedQuotaPoints: 2_000,
    }),
  );
  const authorization: CopyPilotDispatchAuthorization = {
    schemaVersion:
      "site-builder-copy-pilot-global-dispatch-authorization/2026-08-06-v2",
    authorizationId: "copy-pilot-global-authorization-isolated-test",
    status: "AUTHORIZED",
    issuedAt: "2026-08-06T05:58:00.000Z",
    expiresAt: "2026-08-06T07:00:00.000Z",
    manifestDigest: canonicalDigest(manifest),
    credentialAttestationDigest: canonicalDigest(credential),
    settlementObserverDigest: canonicalDigest(settlement),
    reservationStatus: "RESERVED",
    maximumExecutions: 3,
    maximumWireCalls: 6,
    maximumRepairCallsPerExecution: 1,
    unknownSettlementPolicy: "freeze_selected_child_campaign",
    sharedDriftPolicy: "freeze_all_child_campaigns",
    children,
  };
  const selected = children.find(
    (child) => child.executionKey === selectedExecutionKey,
  )!;
  const childWithoutDigest = {
    schemaVersion:
      "site-builder-copy-pilot-child-dispatch-authorization/2026-08-06-v1" as const,
    globalAuthorizationDigest: canonicalDigest(authorization),
    childSlotId: selected.childSlotId,
    executionKey: selected.executionKey,
    campaignId: selected.campaignId,
    authorizationId: selected.authorizationId,
    status: "AUTHORIZED" as const,
    issuedAt: authorization.issuedAt,
    expiresAt: authorization.expiresAt,
    manifestDigest: authorization.manifestDigest,
    credentialAttestationDigest: authorization.credentialAttestationDigest,
    settlementObserverDigest: authorization.settlementObserverDigest,
    ledgerIdentityDigest: selected.ledgerIdentityDigest,
    reservationId: selected.reservationId,
    reservationStatus: "RESERVED" as const,
    maximumExecutions: 1 as const,
    maximumWireCalls: 2 as const,
    maximumRepairCallsPerExecution: 1 as const,
  };
  const childAuthorization: CopyPilotChildDispatchAuthorization = {
    ...childWithoutDigest,
    reservationDigest: copyPilotChildReservationDigest(childWithoutDigest),
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
    childAuthorization,
    selectedExecutionKey,
  };
}

describe("Copy real capability candidate-isolated admission", () => {
  it("publishes one immutable 1/2 child slot per candidate under the 3/6 envelope", () => {
    expect(COPY_REAL_CAPABILITY_ADMISSION_SOURCE).toMatchObject({
      schemaVersion:
        "site-builder-copy-real-capability-admission-source/2026-08-06-v4",
      taskId: "site_builder.copy",
      dispatchAuthorization: "NOT_AUTHORIZED",
      plannedExecutions: 3,
      maximumWireCalls: 6,
      maximumRepairCallsPerExecution: 1,
      unknownSettlementPolicy: "freeze_selected_child_campaign",
      sharedDriftPolicy: "freeze_all_child_campaigns",
    });
    expect(COPY_REAL_CAPABILITY_ADMISSION_SOURCE.childCampaigns).toHaveLength(
      3,
    );
    expect(
      COPY_REAL_CAPABILITY_ADMISSION_SOURCE.childCampaigns.map(
        ({ maximumExecutions, maximumWireCalls }) => ({
          maximumExecutions,
          maximumWireCalls,
        }),
      ),
    ).toEqual([
      { maximumExecutions: 1, maximumWireCalls: 2 },
      { maximumExecutions: 1, maximumWireCalls: 2 },
      { maximumExecutions: 1, maximumWireCalls: 2 },
    ]);
    expect(Object.isFrozen(COPY_REAL_CAPABILITY_ADMISSION_SOURCE)).toBe(true);
    expect(
      Object.isFrozen(COPY_REAL_CAPABILITY_ADMISSION_SOURCE.childCampaigns),
    ).toBe(true);
  });

  it("admits exactly one child while retaining the global 3/6 authorization", () => {
    const input = validInput(
      COPY_CAPABILITY_PILOT_PLAN.executions[1]!.executionKey,
    );
    const validation = validateCopyRealCapabilityAdmissionEnvelope(
      input,
      new Date(NOW),
    );

    expect(validation).toMatchObject({
      schemaVersion:
        "site-builder-copy-real-capability-admission-validation/2026-08-06-v2",
      selectedExecutionKey: "copy-capability-2-gpt-5.6-sol",
      childCampaignId: "copy-isolated-campaign-2",
      maximumExecutions: 1,
      maximumWireCalls: 2,
      globalMaximumExecutions: 3,
      globalMaximumWireCalls: 6,
      unknownSettlementPolicy: "freeze_selected_child_campaign",
      sharedDriftPolicy: "freeze_all_child_campaigns",
    });
    expect(validation.globalAuthorizationDigest).toBe(
      canonicalDigest(input.authorization),
    );
    expect(validation.childAuthorizationDigest).toBe(
      canonicalDigest(input.childAuthorization),
    );
    expect(Object.isFrozen(validation)).toBe(true);
  });

  it("rejects the legacy v6 3/6 authorization shape", () => {
    const input = validInput();
    input.authorization = {
      ...input.authorization,
      schemaVersion:
        "site-builder-copy-pilot-dispatch-authorization/2026-08-05-v1",
    } as never;
    expect(() =>
      validateCopyRealCapabilityAdmissionEnvelope(input, new Date(NOW)),
    ).toThrow("COPY_REAL_CAPABILITY_AUTHORIZATION_MISMATCH");
  });

  it.each([
    [
      "COPY_REAL_CAPABILITY_GLOBAL_CHILDREN_MISMATCH",
      (input: CopyRealCapabilityAdmissionInput) => ({
        ...input,
        authorization: {
          ...input.authorization,
          children: input.authorization.children.slice(1),
        },
      }),
    ],
    [
      "COPY_REAL_CAPABILITY_GLOBAL_CHILDREN_MISMATCH",
      (input: CopyRealCapabilityAdmissionInput) => ({
        ...input,
        authorization: {
          ...input.authorization,
          children: input.authorization.children.map((child, index) =>
            index === 1
              ? {
                  ...child,
                  authorizationId:
                    input.authorization.children[0]!.authorizationId,
                }
              : child,
          ),
        },
      }),
    ],
    [
      "COPY_REAL_CAPABILITY_CHILD_AUTHORIZATION_MISMATCH",
      (input: CopyRealCapabilityAdmissionInput) => ({
        ...input,
        childAuthorization: {
          ...input.childAuthorization,
          executionKey: COPY_CAPABILITY_PILOT_PLAN.executions[1]!.executionKey,
        },
      }),
    ],
    [
      "COPY_REAL_CAPABILITY_CHILD_AUTHORIZATION_MISMATCH",
      (input: CopyRealCapabilityAdmissionInput) => ({
        ...input,
        childAuthorization: {
          ...input.childAuthorization,
          maximumWireCalls: 6 as never,
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
        credential: {
          ...input.credential,
          reservedQuotaPoints: 2_000,
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

  it("rejects expired proofs and secret-bearing credential shapes", () => {
    expect(() =>
      validateCopyRealCapabilityAdmissionEnvelope(
        validInput(),
        new Date("2026-08-06T08:00:00.000Z"),
      ),
    ).toThrow("COPY_REAL_CAPABILITY_PROOF_EXPIRED");

    const secretBearing = validInput();
    const forbiddenCredentialField = "api" + "Key";
    secretBearing.credential = {
      ...secretBearing.credential,
      [forbiddenCredentialField]: "redacted-test-value",
    } as never;
    expect(() =>
      validateCopyRealCapabilityAdmissionEnvelope(secretBearing, new Date(NOW)),
    ).toThrow("COPY_REAL_CAPABILITY_CREDENTIAL_INVALID");
  });
});
