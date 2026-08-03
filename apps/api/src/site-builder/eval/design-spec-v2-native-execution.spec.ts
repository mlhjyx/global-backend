import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DESIGN_SPEC_TASK } from "../design/design-brief-producer";
import {
  assessCanonicalTaskArtifact,
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
} from "./model-evaluation-harness";
import {
  createNativeModelEvaluationAuthorizationLedger,
  initializeNativeModelEvaluationAuthorizationLedgerDirectory,
} from "./native-model-evaluation-authorization-ledger";
import {
  createDesignSpecV2NativeExecutionRunner,
} from "./design-spec-v2-native-execution";
import {
  createNativeModelEvaluationCostSafetyAttestation,
  nativeModelEvaluationPricingFeeCardSha256,
  type NativeModelEvaluationCostSafetyInput,
} from "./model-evaluation-native-cost-safety";

const EXECUTION_ID = "design-spec-native-execution-0001";
const REQUEST_ID = "req_12345678";
const directories: string[] = [];

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

function attestation(
  ledgerDirectorySha256: string,
) {
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
  input.authorization.preparedFeeCardSha256 =
    nativeModelEvaluationPricingFeeCardSha256(input.pricing);
  return createNativeModelEvaluationCostSafetyAttestation(input);
}

function acceptedOutput() {
  const plan = buildTaskEvaluationPlan("site_builder.design_spec");
  const evaluationCase = buildCanonicalModelEvaluationCase(
    plan,
    plan.evaluationSuite!.fixtureIds[0]!,
  );
  const selected = (evaluationCase.payload.taskInput as {
    candidates: Array<{
      id: string;
      industryMatchCount: number;
      userAssetCoverage: number;
      demoFallbackCount: number;
    }>;
  }).candidates[0]!;
  return {
    fixtureId: evaluationCase.contract.fixtureId,
    output: {
      candidateId: selected.id,
      reasons: [
        `selectedCandidateId=${selected.id}`,
        `industryMatchCount=${selected.industryMatchCount}`,
        `userAssetCoverage=${selected.userAssetCoverage}`,
        `demoFallbackCount=${selected.demoFallbackCount}`,
      ],
      warnings: [],
    },
  };
}

describe("design_spec v2 native execution", () => {
  it("uses canonical input, settles a request-bound receipt, and returns redacted evidence", async () => {
    const directory = temporaryLedgerDirectory();
    const identity = initializeNativeModelEvaluationAuthorizationLedgerDirectory(
      directory,
    );
    const ledger = createNativeModelEvaluationAuthorizationLedger({
      ledgerId: "design-spec-native-ledger",
      directory,
      expectedDirectorySha256: identity.directorySha256,
    });
    const safety = attestation(identity.directorySha256);
    const accepted = acceptedOutput();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname === "/v1/responses") {
        return new Response(
          JSON.stringify({
            status: "completed",
            model: "gpt-5.5",
            output_text: JSON.stringify(accepted.output),
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
          { headers: { "x-oneapi-request-id": REQUEST_ID } },
        );
      }
      if (url.pathname === "/api/log/token") {
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                request_id: REQUEST_ID,
                type: 2,
                model_name: "gpt-5.5",
                channel: 12,
                group: "design-spec-eval",
                quota: 1,
                prompt_tokens: 100,
                completion_tokens: 50,
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const runner = createDesignSpecV2NativeExecutionRunner({
      attestation: safety,
      credential: {
        attestationId: safety.credential.attestationId,
        snapshotSha256: safety.credential.snapshotSha256,
        bearerTokenSha256: safety.credential.bearerTokenSha256,
        gatewayOrigin: safety.credential.gatewayOrigin,
        bearerToken: testBearerToken(),
      },
      ledger,
      fetch: fetchImpl as typeof fetch,
    });
    const result = await runner.execute({
      executionId: EXECUTION_ID,
      alias: "gpt-5.5",
      protocol: "openai-responses",
      fixtureId: accepted.fixtureId,
      attempt: 1,
    });

    expect(result).toMatchObject({
      executionId: EXECUTION_ID,
      outcome: "accepted",
      artifactRetention: "digest_only",
      costSettlement: {
        state: "settled",
        currency: "CNY",
        nativePicoUnits: "2000000000",
      },
    });
    expect(result).not.toHaveProperty("artifact");
    expect(ledger.snapshot(safety.authorization.authorizationId)).toMatchObject({
      frozen: false,
      dispatchExecutions: 1,
      wireCalls: 2,
      totalsByCurrency: {
        CNY: { committedPicoUnits: "2000000000", reservedPicoUnits: "0" },
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      assessCanonicalTaskArtifact(
        buildTaskEvaluationPlan("site_builder.design_spec"),
        buildCanonicalModelEvaluationCase(
          buildTaskEvaluationPlan("site_builder.design_spec"),
          accepted.fixtureId,
        ).payload,
        accepted.output,
      ).qualityPassed,
    ).toBe(true);
    expect(DESIGN_SPEC_TASK.outputSchema).toBeDefined();
  });

  it("freezes the authorization when a dispatched wire has no verified token-log settlement", async () => {
    const directory = temporaryLedgerDirectory();
    const identity = initializeNativeModelEvaluationAuthorizationLedgerDirectory(
      directory,
    );
    const ledger = createNativeModelEvaluationAuthorizationLedger({
      ledgerId: "design-spec-native-ledger",
      directory,
      expectedDirectorySha256: identity.directorySha256,
    });
    const safety = attestation(identity.directorySha256);
    const accepted = acceptedOutput();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname === "/v1/responses") {
        return new Response(
          JSON.stringify({
            status: "completed",
            model: "gpt-5.5",
            output_text: JSON.stringify(accepted.output),
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
          { headers: { "x-oneapi-request-id": REQUEST_ID } },
        );
      }
      if (url.pathname === "/api/log/token") {
        return new Response(JSON.stringify({ success: true, data: [] }));
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const runner = createDesignSpecV2NativeExecutionRunner({
      attestation: safety,
      credential: {
        attestationId: safety.credential.attestationId,
        snapshotSha256: safety.credential.snapshotSha256,
        bearerTokenSha256: safety.credential.bearerTokenSha256,
        gatewayOrigin: safety.credential.gatewayOrigin,
        bearerToken: testBearerToken(),
      },
      ledger,
      fetch: fetchImpl as typeof fetch,
    });

    await expect(
      runner.execute({
        executionId: EXECUTION_ID,
        alias: "gpt-5.5",
        protocol: "openai-responses",
        fixtureId: accepted.fixtureId,
        attempt: 1,
      }),
    ).rejects.toThrow("native design_spec settlement was rejected");
    expect(ledger.snapshot(safety.authorization.authorizationId)).toMatchObject({
      frozen: true,
      freezeReason: "unknown_settlement",
      dispatchExecutions: 1,
      wireCalls: 2,
    });
  });

  it("permits one validator-bound repair and settles both physical wires together", async () => {
    const directory = temporaryLedgerDirectory();
    const identity = initializeNativeModelEvaluationAuthorizationLedgerDirectory(
      directory,
    );
    const ledger = createNativeModelEvaluationAuthorizationLedger({
      ledgerId: "design-spec-native-ledger",
      directory,
      expectedDirectorySha256: identity.directorySha256,
    });
    const safety = attestation(identity.directorySha256);
    const accepted = acceptedOutput();
    const repairRequestId = "req_repair123";
    let wire = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname === "/v1/responses") {
        wire += 1;
        return new Response(
          JSON.stringify({
            status: "completed",
            model: "gpt-5.5",
            output_text: JSON.stringify(wire === 1 ? {} : accepted.output),
            usage:
              wire === 1
                ? { input_tokens: 100, output_tokens: 50 }
                : { input_tokens: 25, output_tokens: 10 },
          }),
          {
            headers: {
              "x-oneapi-request-id":
                wire === 1 ? REQUEST_ID : repairRequestId,
            },
          },
        );
      }
      if (url.pathname === "/api/log/token") {
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                request_id: REQUEST_ID,
                type: 2,
                model_name: "gpt-5.5",
                channel: 12,
                group: "design-spec-eval",
                quota: 1,
                prompt_tokens: 100,
                completion_tokens: 50,
              },
              {
                request_id: repairRequestId,
                type: 2,
                model_name: "gpt-5.5",
                channel: 12,
                group: "design-spec-eval",
                quota: 1,
                prompt_tokens: 25,
                completion_tokens: 10,
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const runner = createDesignSpecV2NativeExecutionRunner({
      attestation: safety,
      credential: {
        attestationId: safety.credential.attestationId,
        snapshotSha256: safety.credential.snapshotSha256,
        bearerTokenSha256: safety.credential.bearerTokenSha256,
        gatewayOrigin: safety.credential.gatewayOrigin,
        bearerToken: testBearerToken(),
      },
      ledger,
      fetch: fetchImpl as typeof fetch,
    });

    await expect(
      runner.execute({
        executionId: EXECUTION_ID,
        alias: "gpt-5.5",
        protocol: "openai-responses",
        fixtureId: accepted.fixtureId,
        attempt: 1,
      }),
    ).resolves.toMatchObject({
      outcome: "accepted",
      usage: { inputTokens: 125, outputTokens: 60, callCount: 2 },
      costSettlement: { state: "settled", nativePicoUnits: "2425000000" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("freezes rather than settling only the initial wire after a repair may have dispatched", async () => {
    const directory = temporaryLedgerDirectory();
    const identity = initializeNativeModelEvaluationAuthorizationLedgerDirectory(
      directory,
    );
    const ledger = createNativeModelEvaluationAuthorizationLedger({
      ledgerId: "design-spec-native-ledger",
      directory,
      expectedDirectorySha256: identity.directorySha256,
    });
    const safety = attestation(identity.directorySha256);
    const accepted = acceptedOutput();
    let wire = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname === "/v1/responses") {
        wire += 1;
        if (wire === 2) {
          return new Response("gateway failure", {
            status: 500,
            headers: { "x-oneapi-request-id": "req_repair500" },
          });
        }
        return new Response(
          JSON.stringify({
            status: "completed",
            model: "gpt-5.5",
            output_text: JSON.stringify({}),
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
          { headers: { "x-oneapi-request-id": REQUEST_ID } },
        );
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const runner = createDesignSpecV2NativeExecutionRunner({
      attestation: safety,
      credential: {
        attestationId: safety.credential.attestationId,
        snapshotSha256: safety.credential.snapshotSha256,
        bearerTokenSha256: safety.credential.bearerTokenSha256,
        gatewayOrigin: safety.credential.gatewayOrigin,
        bearerToken: testBearerToken(),
      },
      ledger,
      fetch: fetchImpl as typeof fetch,
    });

    await expect(
      runner.execute({
        executionId: EXECUTION_ID,
        alias: "gpt-5.5",
        protocol: "openai-responses",
        fixtureId: accepted.fixtureId,
        attempt: 1,
      }),
    ).rejects.toThrow("evaluation transport HTTP 500");
    expect(ledger.snapshot(safety.authorization.authorizationId)).toMatchObject({
      frozen: true,
      freezeReason: "unknown_settlement",
      dispatchExecutions: 1,
      wireCalls: 2,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

});
