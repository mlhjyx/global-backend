import { canonicalDigest } from "../../model-runtime/context-engine";
import { describe, expect, it } from "vitest";

import {
  COPY_SONNET_RECOVERY_ADMISSION_SOURCE,
  copySonnetRecoveryReservationDigest,
  validateCopySonnetRecoveryAdmissionEnvelope,
  type CopySonnetRecoveryAdmissionInput,
} from "./copy-sonnet-recovery-admission";

function admission(): CopySonnetRecoveryAdmissionInput {
  const issuedAt = "2026-08-08T15:00:00.000Z";
  const expiresAt = "2026-08-08T16:00:00.000Z";
  const manifest = {
    schemaVersion:
      "site-builder-copy-sonnet-recovery-runtime-manifest/2026-08-08-v1" as const,
    manifestId: "site-builder-copy-sonnet-recovery-runtime/2026-08-09-v14-v1",
    recoveryManifestArtifactDigest: "a".repeat(64),
    recoveryManifestDigest: "b".repeat(64),
    fixedSourceCommit: "c".repeat(40),
    sourceBundleDigest: "d".repeat(64),
    planDigest: COPY_SONNET_RECOVERY_ADMISSION_SOURCE.planDigest,
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    taskId: "site_builder.copy" as const,
    plannedExecutions: 1 as const,
    maximumWireCalls: 2 as const,
    maximumRepairCallsPerExecution: 1 as const,
    executions: COPY_SONNET_RECOVERY_ADMISSION_SOURCE.executions,
  };
  const credential = {
    schemaVersion:
      "site-builder-copy-sonnet-recovery-credential-attestation/2026-08-08-v1" as const,
    attestationId: "copy-sonnet-recovery-credential-v1",
    capturedAt: issuedAt,
    expiresAt,
    gatewayOrigin: "http://127.0.0.1:3001",
    bearerTokenSha256: "e".repeat(64),
    purpose: "site_builder_copy_sonnet_recovery" as const,
    quotaMode: "limited" as const,
    quotaCapPoints: 1_000,
    remainingQuotaPoints: 1_000,
    maximumQuotaPointsPerWire: 500,
    reservedQuotaPoints: 1_000,
    scopeExact: true as const,
    repairPayloadPolicy: "bounded_structured_prior_output_64k" as const,
    executions: COPY_SONNET_RECOVERY_ADMISSION_SOURCE.executions,
    channels: [
      {
        alias: "claude-sonnet-5",
        protocol: "anthropic_messages" as const,
        channelId: 22,
      },
    ],
    resolverId: "copy-sonnet-recovery-resolver-v1",
  };
  const settlement = {
    schemaVersion:
      "site-builder-copy-sonnet-recovery-settlement-observer/2026-08-08-v1" as const,
    resolverId: credential.resolverId,
    status: "READY" as const,
    observation: "request_bound_new_api_consume_log" as const,
    requestIdentityHeader: "x-oneapi-request-id" as const,
    requiredObservationPerPhysicalCall: true as const,
    maximumPollDurationMs: 2_000,
    unknownSettlementPolicy: "freeze_selected_child_campaign" as const,
  };
  const child = {
    ...COPY_SONNET_RECOVERY_ADMISSION_SOURCE.childCampaign,
    campaignId: "copy-sonnet-recovery-v14-campaign-admission-test",
    authorizationId:
      "copy-sonnet-recovery-v14-child-authorization-admission-test",
    reservationId: "copy-sonnet-recovery-v14-child-reservation-admission-test",
    ledgerIdentityDigest: "f".repeat(64),
    reservedQuotaPoints: 1_000,
  };
  const authorization = {
    schemaVersion:
      "site-builder-copy-sonnet-recovery-dispatch-authorization/2026-08-08-v1" as const,
    authorizationId:
      "copy-sonnet-recovery-v14-global-authorization-admission-test",
    status: "AUTHORIZED" as const,
    issuedAt,
    expiresAt,
    manifestDigest: canonicalDigest(manifest),
    credentialAttestationDigest: canonicalDigest(credential),
    settlementObserverDigest: canonicalDigest(settlement),
    reservationStatus: "RESERVED" as const,
    maximumExecutions: 1 as const,
    maximumWireCalls: 2 as const,
    maximumRepairCallsPerExecution: 1 as const,
    unknownSettlementPolicy: "freeze_selected_child_campaign" as const,
    sharedDriftPolicy: "freeze_selected_child_campaign" as const,
    children: [child] as const,
  };
  const childWithoutDigest = {
    schemaVersion:
      "site-builder-copy-sonnet-recovery-child-dispatch-authorization/2026-08-08-v1" as const,
    globalAuthorizationDigest: canonicalDigest(authorization),
    childSlotId: child.childSlotId,
    executionKey: child.executionKey,
    campaignId: child.campaignId,
    authorizationId: child.authorizationId,
    status: "AUTHORIZED" as const,
    issuedAt,
    expiresAt,
    manifestDigest: authorization.manifestDigest,
    credentialAttestationDigest: authorization.credentialAttestationDigest,
    settlementObserverDigest: authorization.settlementObserverDigest,
    ledgerIdentityDigest: child.ledgerIdentityDigest,
    reservationId: child.reservationId,
    reservationStatus: "RESERVED" as const,
    maximumExecutions: 1 as const,
    maximumWireCalls: 2 as const,
    maximumRepairCallsPerExecution: 1 as const,
  };
  return {
    manifest,
    sourceVerification: {
      fixedSourceCommit: manifest.fixedSourceCommit,
      sourceBundleDigest: manifest.sourceBundleDigest,
      fixedCommitReachableFromExecutionHead: true,
      trackedSourceBytesMatch: true,
      compiledContractsMatch: true,
    },
    credential,
    settlement,
    authorization,
    childAuthorization: {
      ...childWithoutDigest,
      reservationDigest:
        copySonnetRecoveryReservationDigest(childWithoutDigest),
    },
    selectedExecutionKey: child.executionKey,
  };
}

describe("Copy Sonnet recovery admission", () => {
  it("admits only the exact Sonnet Messages/medium 1/2/1 recovery scope", () => {
    const input = admission();
    const result = validateCopySonnetRecoveryAdmissionEnvelope(
      input,
      new Date("2026-08-08T15:30:00.000Z"),
    );

    expect(COPY_SONNET_RECOVERY_ADMISSION_SOURCE.executions).toEqual([
      {
        executionKey: "copy-sonnet-recovery-v14-claude-sonnet-5",
        sourcePilotExecutionKey: "copy-capability-3-claude-sonnet-5",
        alias: "claude-sonnet-5",
        protocol: "anthropic_messages",
        reasoning: "medium",
      },
    ]);
    expect(
      COPY_SONNET_RECOVERY_ADMISSION_SOURCE.childCampaign.childSlotId,
    ).toBe("copy-sonnet-recovery-v14-child-claude-sonnet-5");
    expect(JSON.stringify(input)).not.toMatch(/gpt-5\.6-(terra|sol)/u);
    expect(result).toMatchObject({
      classification: "SOURCE_CONTRACT_VALIDATION_ONLY",
      dispatchCapable: false,
      selectedExecutionKey: "copy-sonnet-recovery-v14-claude-sonnet-5",
      maximumExecutions: 1,
      maximumWireCalls: 2,
      globalMaximumExecutions: 1,
      globalMaximumWireCalls: 2,
    });
  });

  it("rejects any broadened model, protocol, channel, quota, or authorization scope", () => {
    const base = admission();
    const cases: CopySonnetRecoveryAdmissionInput[] = [
      {
        ...base,
        manifest: {
          ...base.manifest,
          executions: [
            {
              ...base.manifest.executions[0],
              alias: "gpt-5.6-terra",
            },
          ],
        },
      },
      {
        ...base,
        credential: {
          ...base.credential,
          channels: [
            ...base.credential.channels,
            {
              alias: "gpt-5.6-sol",
              protocol: "openai_chat_completions",
              channelId: 23,
            },
          ],
        },
      },
      {
        ...base,
        credential: {
          ...base.credential,
          reservedQuotaPoints: 1_001,
        },
      },
      {
        ...base,
        authorization: {
          ...base.authorization,
          maximumExecutions: 3,
        },
      },
    ];

    for (const candidate of cases) {
      expect(() =>
        validateCopySonnetRecoveryAdmissionEnvelope(
          candidate,
          new Date("2026-08-08T15:30:00.000Z"),
        ),
      ).toThrow(/COPY_SONNET_RECOVERY_/u);
    }
  });

  it("rejects stale proof and source/compiled binding drift before dispatch", () => {
    const base = admission();
    expect(() =>
      validateCopySonnetRecoveryAdmissionEnvelope(
        base,
        new Date("2026-08-08T17:00:00.000Z"),
      ),
    ).toThrow("COPY_SONNET_RECOVERY_PROOF_EXPIRED");

    expect(() =>
      validateCopySonnetRecoveryAdmissionEnvelope(
        {
          ...base,
          sourceVerification: {
            ...base.sourceVerification,
            compiledContractsMatch: false,
          },
        },
        new Date("2026-08-08T15:30:00.000Z"),
      ),
    ).toThrow("COPY_SONNET_RECOVERY_SOURCE_BUNDLE_UNVERIFIED");
  });

  it("rejects a v13 child slot even when its authorization digests are rebuilt", () => {
    const base = admission();
    const childSlotId = "copy-sonnet-recovery-child-claude-sonnet-5";
    const authorization = {
      ...base.authorization,
      children: base.authorization.children.map((child) => ({
        ...child,
        childSlotId,
      })),
    };
    const {
      reservationDigest: _reservationDigest,
      ...currentChildAuthorization
    } = base.childAuthorization;
    const childWithoutDigest = {
      ...currentChildAuthorization,
      globalAuthorizationDigest: canonicalDigest(authorization),
      childSlotId,
    };

    expect(() =>
      validateCopySonnetRecoveryAdmissionEnvelope(
        {
          ...base,
          authorization,
          childAuthorization: {
            ...childWithoutDigest,
            reservationDigest:
              copySonnetRecoveryReservationDigest(childWithoutDigest),
          },
        },
        new Date("2026-08-08T15:30:00.000Z"),
      ),
    ).toThrow(/COPY_SONNET_RECOVERY_(AUTHORIZATION|CHILD_SCOPE)_MISMATCH/u);
  });

  it("rejects a renamed runtime manifest even when every authorization digest is rebuilt", () => {
    const base = admission();
    const manifest = {
      ...base.manifest,
      manifestId: "site-builder-copy-sonnet-recovery-runtime/2026-08-09-v13-v1",
    };
    const authorization = {
      ...base.authorization,
      manifestDigest: canonicalDigest(manifest),
    };
    const {
      reservationDigest: _reservationDigest,
      ...currentChildAuthorization
    } = base.childAuthorization;
    const childWithoutDigest = {
      ...currentChildAuthorization,
      globalAuthorizationDigest: canonicalDigest(authorization),
      manifestDigest: authorization.manifestDigest,
    };

    expect(() =>
      validateCopySonnetRecoveryAdmissionEnvelope(
        {
          ...base,
          manifest,
          authorization,
          childAuthorization: {
            ...childWithoutDigest,
            reservationDigest:
              copySonnetRecoveryReservationDigest(childWithoutDigest),
          },
        },
        new Date("2026-08-08T15:30:00.000Z"),
      ),
    ).toThrow("COPY_SONNET_RECOVERY_MANIFEST_INVALID");
  });

  it.each(["v11", "v12", "v13"] as const)(
    "rejects consumed %s campaign and authorization identities even when every dependent digest is rebuilt",
    (version) => {
      const base = admission();
      const priorChild = {
        ...base.authorization.children[0]!,
        campaignId: `copy-sonnet-recovery-${version}-campaign-consumed`,
        authorizationId: `copy-sonnet-recovery-${version}-child-authorization-consumed`,
        reservationId: `copy-sonnet-recovery-${version}-child-reservation-consumed`,
      };
      const authorization = {
        ...base.authorization,
        authorizationId: `copy-sonnet-recovery-${version}-global-authorization-consumed`,
        children: [priorChild] as const,
      };
      const {
        reservationDigest: _reservationDigest,
        ...currentChildAuthorization
      } = base.childAuthorization;
      const childWithoutDigest = {
        ...currentChildAuthorization,
        globalAuthorizationDigest: canonicalDigest(authorization),
        campaignId: priorChild.campaignId,
        authorizationId: priorChild.authorizationId,
        reservationId: priorChild.reservationId,
      };

      expect(() =>
        validateCopySonnetRecoveryAdmissionEnvelope(
          {
            ...base,
            authorization,
            childAuthorization: {
              ...childWithoutDigest,
              reservationDigest:
                copySonnetRecoveryReservationDigest(childWithoutDigest),
            },
          },
          new Date("2026-08-08T15:30:00.000Z"),
        ),
      ).toThrow(
        /COPY_SONNET_RECOVERY_(AUTHORIZATION|CHILD_SCOPE|CHILD_AUTHORIZATION)_MISMATCH/u,
      );
    },
  );
});
