import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createNativeModelEvaluationCostSafetyAttestation } from "./model-evaluation-native-cost-safety";
import type { NativeModelEvaluationAuthorizationLedger } from "./native-model-evaluation-authorization-ledger";
import { createDesignSpecV2NativeExecutionRunner } from "./design-spec-v2-native-execution";
import {
  createDesignSpecV6NativeExecutionAttestation,
  isTrustedDesignSpecV6NativeExecutionAttestation,
} from "./design-spec-v6-native-execution-preflight";

const evidence = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "../../../../../docs/evidence/site-builder/m1-g-design-spec-v6-native-fee-card-2026-08-04.json",
    ),
    "utf8",
  ),
);

function input() {
  const bearerToken = "limited-evaluation-token";
  return {
    authorization: {
      authorizationId: "design-spec-v6-native-authorization",
      ledgerId: "design-spec-v6-native-ledger",
      ledgerDirectorySha256: "a".repeat(64),
      approvedAt: "2026-08-04T00:00:00.000Z",
      approvedMaximumsByCurrency: {
        CNY: "11276659000000",
        USD: "3458427840000",
      },
      approvedDispatchExecutions: 73,
      approvedWireCalls: 146,
      preparedFixedCommitSha: "b".repeat(40),
    },
    credential: {
      attestationId: "design-spec-v6-native-credential",
      observedAt: "2026-08-04T00:00:00.000Z",
      snapshotSha256: "c".repeat(64),
      bearerTokenSha256: createHash("sha256").update(bearerToken).digest("hex"),
      gatewayOrigin: "http://127.0.0.1:3001",
      purpose: "site_builder_model_evaluation" as const,
      quotaMode: "limited" as const,
      scopeExact: true,
      allowedDispatches: [
        {
          mode: "target" as const,
          alias: "gpt-5.6-terra",
          protocol: "openai-responses" as const,
          currency: "CNY" as const,
        },
        {
          mode: "target" as const,
          alias: "gpt-5.5",
          protocol: "openai-responses" as const,
          currency: "CNY" as const,
        },
        {
          mode: "target" as const,
          alias: "claude-sonnet-5",
          protocol: "anthropic-messages" as const,
          currency: "USD" as const,
        },
      ],
      gatewaySettlement: {
        purposeGroup: "design-spec-eval" as const,
        tokenLogPath: "/api/log/token" as const,
        routes: [
          {
            alias: "gpt-5.6-terra",
            protocol: "openai-responses" as const,
            channelId: 11,
          },
          {
            alias: "gpt-5.5",
            protocol: "openai-responses" as const,
            channelId: 12,
          },
          {
            alias: "claude-sonnet-5",
            protocol: "anthropic-messages" as const,
            channelId: 13,
          },
        ],
      },
    },
    feeCardEvidence: evidence,
  };
}

describe("design_spec v6 native execution preflight", () => {
  it("brands only an attestation bound to the committed v6 public price evidence", () => {
    const attestation = createDesignSpecV6NativeExecutionAttestation(input());

    expect(isTrustedDesignSpecV6NativeExecutionAttestation(attestation)).toBe(
      true,
    );
    expect(attestation.authorization.preparedManifestSha256).toBe(
      "1a74fab9ac803bfc50636fdb51ab7ac1b04623a8053c8d17a37a60294c99facd",
    );
    expect(attestation.pricing.capturedAt).toBe("2026-08-03T22:34:29.485Z");
  });

  it("rejects a modified or non-zero-call price evidence wrapper before any runner exists", () => {
    const modifiedCard = structuredClone(input());
    modifiedCard.feeCardEvidence.card.entries[0].effectiveInputRateMicrounitsPerMillionTokens = 1;
    expect(() =>
      createDesignSpecV6NativeExecutionAttestation(modifiedCard),
    ).toThrow("design_spec v6 fee-card evidence is invalid");

    const nonZeroCall = structuredClone(input());
    nonZeroCall.feeCardEvidence.modelWireCalls = 1;
    expect(() =>
      createDesignSpecV6NativeExecutionAttestation(nonZeroCall),
    ).toThrow("design_spec v6 fee-card evidence is invalid");
  });

  it("rejects a generic native attestation at the execution entry point", () => {
    const v6Attestation = createDesignSpecV6NativeExecutionAttestation(input());
    const genericAttestation = createNativeModelEvaluationCostSafetyAttestation(
      structuredClone(v6Attestation),
    );

    expect(
      isTrustedDesignSpecV6NativeExecutionAttestation(genericAttestation),
    ).toBe(false);
    expect(() =>
      createDesignSpecV2NativeExecutionRunner({
        attestation: genericAttestation,
        credential: {} as never,
        ledger: {} as NativeModelEvaluationAuthorizationLedger,
        fetch: fetch as typeof fetch,
      }),
    ).toThrow("trusted v6 native model evaluation cost safety is required");
  });

  it("rejects a v6-branded non-HEAD attestation before claiming its ledger", () => {
    const v6Attestation = createDesignSpecV6NativeExecutionAttestation(input());
    const claim = vi.fn(() => true);
    const ledger = {
      ledgerId: v6Attestation.authorization.ledgerId,
      directorySha256: v6Attestation.authorization.ledgerDirectorySha256,
      claim,
    } as unknown as NativeModelEvaluationAuthorizationLedger;

    expect(() =>
      createDesignSpecV2NativeExecutionRunner({
        attestation: v6Attestation,
        credential: {
          attestationId: v6Attestation.credential.attestationId,
          snapshotSha256: v6Attestation.credential.snapshotSha256,
          bearerTokenSha256: v6Attestation.credential.bearerTokenSha256,
          gatewayOrigin: v6Attestation.credential.gatewayOrigin,
          bearerToken: "limited-evaluation-token",
        },
        ledger,
        fetch: vi.fn() as unknown as typeof fetch,
      }),
    ).toThrow("native evaluation credential or ledger does not match");
    expect(claim).not.toHaveBeenCalled();
  });
});
