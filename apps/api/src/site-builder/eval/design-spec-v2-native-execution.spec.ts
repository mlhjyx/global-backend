import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
} from "./model-evaluation-harness";
import {
  createNativeModelEvaluationAuthorizationLedger,
  initializeNativeModelEvaluationAuthorizationLedgerDirectory,
} from "./native-model-evaluation-authorization-ledger";
import { createDesignSpecV2NativeExecutionRunner } from "./design-spec-v2-native-execution";
import type { NativeModelEvaluationCostSafetyInput } from "./model-evaluation-native-cost-safety";
import { createDesignSpecV5NativeExecutionAttestation } from "./design-spec-v5-native-execution-preflight";

const directories: string[] = [];
const v5FeeCardEvidence = Object.freeze(
  JSON.parse(
    readFileSync(
      join(
        __dirname,
        "../../../../../docs/evidence/site-builder/m1-g-design-spec-v5-native-fee-card-2026-08-04.json",
      ),
      "utf8",
    ),
  ),
);

function testBearerToken(): string {
  return ["limited", "evaluation", "token"].join("-");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryLedgerDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "design-spec-native-ledger-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  return directory;
}

function attestation(ledgerDirectorySha256: string) {
  const plan = buildTaskEvaluationPlan("site_builder.design_spec");
  const canonicalCase = buildCanonicalModelEvaluationCase(
    plan,
    plan.evaluationSuite!.fixtureIds[0]!,
  );
  const input: NativeModelEvaluationCostSafetyInput = {
    contractId:
      "site-builder-model-evaluation-native-cost-safety/2026-08-03-v2",
    authorization: {
      authorizationId: "design-spec-native-authorization-20260803",
      ledgerId: "design-spec-native-ledger",
      ledgerDirectorySha256,
      approvedAt: "2026-08-03T08:00:00.000Z",
      approvedMaximumsByCurrency: {
        CNY: "11276659000000",
        USD: "3458427840000",
      },
      approvedDispatchExecutions: 73,
      approvedWireCalls: 146,
      preparedFixedCommitSha: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      preparedManifestSha256: "c".repeat(64),
      preparedFeeCardSha256: "d".repeat(64),
      preparedSuiteId: canonicalCase.contract.suiteId,
      preparedSourceBundleContractId:
        canonicalCase.contract.sourceBundleContractId,
      preparedSourceBundleSha256: canonicalCase.contract.sourceBundleSha256,
    },
    credential: {
      attestationId: "design-spec-native-credential-20260803",
      observedAt: "2026-08-03T08:00:00.000Z",
      snapshotSha256: "f".repeat(64),
      bearerTokenSha256: createHash("sha256")
        .update(testBearerToken())
        .digest("hex"),
      gatewayOrigin: "http://127.0.0.1:3001",
      purpose: "site_builder_model_evaluation",
      quotaMode: "limited",
      scopeExact: true,
      allowedDispatches: [
        {
          mode: "target",
          alias: "gpt-5.6-terra",
          protocol: "openai-responses",
          currency: "CNY",
        },
        {
          mode: "target",
          alias: "gpt-5.5",
          protocol: "openai-responses",
          currency: "CNY",
        },
        {
          mode: "target",
          alias: "claude-sonnet-5",
          protocol: "anthropic-messages",
          currency: "USD",
        },
      ],
      gatewaySettlement: {
        purposeGroup: "design-spec-eval",
        tokenLogPath: "/api/log/token",
        routes: [
          {
            alias: "gpt-5.6-terra",
            protocol: "openai-responses",
            channelId: 11,
          },
          { alias: "gpt-5.5", protocol: "openai-responses", channelId: 12 },
          {
            alias: "claude-sonnet-5",
            protocol: "anthropic-messages",
            channelId: 13,
          },
        ],
      },
    },
    pricing: {
      authority: "openox_model_marketplace",
      catalogEndpoint: "https://openox.tech/api/public/pricing-catalog",
      capturedAt: "2026-08-03T08:00:00.000Z",
      catalogResponseSha256: "2".repeat(64),
      noForeignExchangeConversion: true,
      entries: [
        {
          alias: "gpt-5.6-terra",
          protocol: "openai-responses",
          currency: "CNY",
          inputRateMicrounitsPerMillionTokens: 2_000_000,
          outputRateMicrounitsPerMillionTokens: 12_000_000,
        },
        {
          alias: "gpt-5.5",
          protocol: "openai-responses",
          currency: "CNY",
          inputRateMicrounitsPerMillionTokens: 5_000_000,
          outputRateMicrounitsPerMillionTokens: 30_000_000,
        },
        {
          alias: "claude-sonnet-5",
          protocol: "anthropic-messages",
          currency: "USD",
          inputRateMicrounitsPerMillionTokens: 2_520_000,
          outputRateMicrounitsPerMillionTokens: 12_600_000,
        },
      ],
    },
    limits: {
      maximumsByCurrency: {
        CNY: "11276659000000",
        USD: "3458427840000",
      },
      maxDispatchExecutions: 73,
      maxWireCalls: 146,
      maxInitialPromptUtf8Bytes: 2342,
      maxRepairPromptUtf8Bytes: 6649,
      maxInputTokensInitialWire: 6438,
      maxInputTokensRepairWire: 10745,
      maxOutputTokensPerWire: 4000,
    },
    settlement: {
      requestIdentityField: "executionId",
      requireVerifiedRequestSettlement: true,
      unknownSettlementPolicy: "freeze_campaign",
    },
  };
  return createDesignSpecV5NativeExecutionAttestation({
    authorization: input.authorization,
    credential: input.credential,
    feeCardEvidence: v5FeeCardEvidence,
  });
}

describe("design_spec v2 native execution", () => {
  it("rejects the stale v5 source bundle before it can claim a ledger or dispatch a wire", () => {
    const directory = temporaryLedgerDirectory();
    const identity =
      initializeNativeModelEvaluationAuthorizationLedgerDirectory(directory);
    const ledger = createNativeModelEvaluationAuthorizationLedger({
      ledgerId: "design-spec-native-ledger",
      directory,
      expectedDirectorySha256: identity.directorySha256,
    });
    const safety = attestation(identity.directorySha256);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    expect(() =>
      createDesignSpecV2NativeExecutionRunner({
        attestation: safety,
        credential: {
          attestationId: safety.credential.attestationId,
          snapshotSha256: safety.credential.snapshotSha256,
          bearerTokenSha256: safety.credential.bearerTokenSha256,
          gatewayOrigin: safety.credential.gatewayOrigin,
          bearerToken: testBearerToken(),
        },
        ledger,
        fetch: fetchImpl,
      }),
    ).toThrow("native evaluation credential or ledger does not match");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => ledger.snapshot(safety.authorization.authorizationId)).toThrow(
      "native evaluation authorization is not claimed",
    );
  });
});
