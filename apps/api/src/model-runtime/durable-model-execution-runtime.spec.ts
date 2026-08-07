import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalDigest, ContextEngine } from "./context-engine";
import {
  DurableModelExecutionRuntime,
  getDurableModelExecutionAttestation,
} from "./durable-model-execution-runtime";
import { AppendOnlyModelExecutionLedger } from "./model-execution-ledger";
import { RealModelExecutionLedger } from "./real-model-execution-ledger";
import {
  ModelExecutionRuntime,
  unwrapModelExecutionError,
} from "./model-execution-runtime";
import type {
  ModelExecutionPlan,
  ModelObservation,
  TaskModelContract,
} from "./types";

interface Input {
  name: string;
}
interface Output {
  headline: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function ledger() {
  const directory = await mkdtemp(join(tmpdir(), "durable-model-runtime-"));
  temporaryDirectories.push(directory);
  return AppendOnlyModelExecutionLedger.openTestOnly({
    ledgerPath: join(directory, "ledger.jsonl"),
    campaign: {
      campaignId: "copy-runtime-test",
      taskId: "site_builder.copy",
      planDigest: "a".repeat(64),
      maximumExecutions: 3,
      maximumWireCalls: 6,
    },
  });
}

async function realLedger() {
  const directory = await mkdtemp(join(tmpdir(), "durable-real-runtime-"));
  temporaryDirectories.push(directory);
  return RealModelExecutionLedger.open({
    ledgerPath: join(directory, "ledger.jsonl"),
    authorizationClaimPath: join(directory, "authorization.claim.json"),
    campaign: {
      campaignId: "copy-runtime-test",
      taskId: "site_builder.copy",
      planDigest: "a".repeat(64),
      maximumExecutions: 3,
      maximumWireCalls: 6,
    },
    authorization: {
      authorizationId: "copy-runtime-real-authorization",
      reservationId: "copy-runtime-real-reservation",
      manifestDigest: "b".repeat(64),
      credentialAttestationDigest: "c".repeat(64),
      settlementObserverDigest: "d".repeat(64),
      ledgerIdentityDigest: "e".repeat(64),
      reservationDigest: "f".repeat(64),
      maximumExecutions: 3,
      maximumWireCalls: 6,
      maximumRepairCallsPerExecution: 1,
    },
  });
}

const contract: TaskModelContract<Input, Output> = {
  taskId: "site_builder.copy",
  version: "copy/v2",
  executionMode: "generative",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  contextPolicy: { version: "ctx/v1", allowedSourceRefs: ["request:v1"] },
  capabilityRequirements: {
    protocols: ["openai_responses"],
    reportsRequestId: true,
    reportsUsage: true,
    reportsModel: true,
    exactReportedModel: true,
    forbidWarnings: true,
  },
  reasoningPolicy: {
    allowed: ["medium"],
    default: "medium",
    reserveTokens: 100,
  },
  cachePolicy: { mode: "disabled" },
  retryPolicy: { transportMaxAttempts: 1, contentRepairMaxAttempts: 0 },
  validateOutput: (_input, output) => {
    if (!output.headline) throw new Error("headline missing");
  },
};

function executionPlan(executionId: string): ModelExecutionPlan<Input, Output> {
  const input = { name: "Acme" };
  const context = new ContextEngine().assemble({
    workspaceId: "workspace-test",
    policy: contract.contextPolicy,
    segments: [
      {
        kind: "request",
        sourceRef: "request:v1",
        sourceDigest: canonicalDigest(input),
        sensitivity: "workspace",
        cacheClass: "request-local",
        estimatedTokens: 10,
        content: input,
      },
    ],
    budget: { contextWindow: 1_000, outputReserve: 100, reasoningReserve: 100 },
  });
  return {
    executionId,
    workspaceId: "workspace-test",
    buildRunId: "build-test",
    contract,
    input,
    inputDigest: canonicalDigest(input),
    context,
    contextDigest: context.digest,
    promptVersion: "copy/v2",
    schemaDigest: canonicalDigest(contract.outputSchema),
    requestedAlias: "gpt-5.6-terra",
    resolvedAlias: "gpt-5.6-terra",
    protocol: "openai_responses",
    reasoning: "medium",
    sampling: {},
    locale: "en",
    prompt: { system: "policy", user: "request" },
  };
}

function observation(output: Output): ModelObservation<Output> {
  return {
    output,
    requestedAlias: "gpt-5.6-terra",
    resolvedAlias: "gpt-5.6-terra",
    reportedModel: "gpt-5.6-terra",
    protocol: "openai_responses",
    usage: { inputTokens: 10, outputTokens: 5 },
    usageComplete: true,
    requestId: "request-copy-runtime",
    settlement: "known",
    warnings: [],
  };
}

function realObservation(output: Output): ModelObservation<Output> {
  return {
    ...observation(output),
    settlementProof: {
      resolverId: "copy-runtime-request-bound-resolver",
      receiptDigest: "1".repeat(64),
      channelId: 21,
      quota: 400,
    },
  };
}

describe("DurableModelExecutionRuntime", () => {
  it("rejects an object that only forges the ledger prototype", () => {
    const forged = Object.create(AppendOnlyModelExecutionLedger.prototype);
    expect(
      () =>
        new DurableModelExecutionRuntime<Input, Output>({
          ledger: forged as AppendOnlyModelExecutionLedger,
          transport: { dispatch: vi.fn() },
        }),
    ).toThrow("MODEL_EXECUTION_LEDGER_UNTRUSTED");
  });

  it("does not let a prototype patch upgrade fake evidence classification", async () => {
    const durableLedger = await ledger();
    const originalSummary = await durableLedger.summary();
    const summaryPatch = vi
      .spyOn(AppendOnlyModelExecutionLedger.prototype, "summary")
      .mockResolvedValue({
        ...originalSummary,
        evidenceClass: "gateway_settlement_claim_only",
      });
    try {
      const runtime = new DurableModelExecutionRuntime<Input, Output>({
        ledger: durableLedger,
        transport: {
          dispatch: vi
            .fn()
            .mockResolvedValue(observation({ headline: "Precise" })),
        },
      });

      const result = await runtime.execute(executionPlan("copy-patched"));

      expect(getDurableModelExecutionAttestation(result)?.evidenceClass).toBe(
        "fake_gateway_contract_only",
      );
    } finally {
      summaryPatch.mockRestore();
    }
  });

  it("brands only a ledger-completed execution with a durable test-only attestation", async () => {
    const runtime = new DurableModelExecutionRuntime<Input, Output>({
      ledger: await ledger(),
      transport: {
        dispatch: vi
          .fn()
          .mockResolvedValue(observation({ headline: "Precise" })),
      },
    });

    const result = await runtime.execute(executionPlan("copy-terra"));

    expect(getDurableModelExecutionAttestation(result)).toMatchObject({
      evidenceClass: "fake_gateway_contract_only",
      campaignId: "copy-runtime-test",
      executionId: "copy-terra",
      wireCount: 1,
      outputDigest: canonicalDigest({ headline: "Precise" }),
    });
    expect(getDurableModelExecutionAttestation(result)?.ledgerDigest).toMatch(
      /^[0-9a-f]{64}$/u,
    );
  });

  it("rejects a structurally forged settlement proof from minting real evidence", async () => {
    const durableLedger = await realLedger();
    const runtime = new DurableModelExecutionRuntime<Input, Output>({
      ledger: durableLedger,
      expectedEvidenceClass: "gateway_settlement_claim_only",
      transport: {
        dispatch: vi
          .fn()
          .mockResolvedValue(realObservation({ headline: "Settled" })),
      },
    });

    const failure = await runtime
      .execute(executionPlan("copy-real-forged"))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(unwrapModelExecutionError(failure)).toMatchObject({
      message: "MODEL_EXECUTION_REAL_SETTLEMENT_PROOF_MISSING",
    });
    expect(getDurableModelExecutionAttestation({} as never)).toBeUndefined();
    expect(await durableLedger.summary()).toMatchObject({
      completedExecutions: 0,
      frozen: true,
    });
  });

  it("freezes a real ledger before completion when settlement proof is missing", async () => {
    const durableLedger = await realLedger();
    const runtime = new DurableModelExecutionRuntime<Input, Output>({
      ledger: durableLedger,
      expectedEvidenceClass: "gateway_settlement_claim_only",
      transport: {
        dispatch: vi
          .fn()
          .mockResolvedValue(observation({ headline: "Unproven" })),
      },
    });

    const failure = await runtime
      .execute(executionPlan("copy-real-unproven"))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(unwrapModelExecutionError(failure)).toMatchObject({
      message: "MODEL_EXECUTION_REAL_SETTLEMENT_PROOF_MISSING",
    });
    expect(await durableLedger.summary()).toMatchObject({
      completedExecutions: 0,
      frozen: true,
    });
  });

  it("does not trust an ordinary injectable Runtime transport result", async () => {
    const runtime = new ModelExecutionRuntime<Input, Output>({
      transport: {
        dispatch: vi
          .fn()
          .mockResolvedValue(observation({ headline: "Forged" })),
      },
    });

    const result = await runtime.execute(executionPlan("copy-forged"));

    expect(getDurableModelExecutionAttestation(result)).toBeUndefined();
  });

  it("rejects duplicate execution before a second physical dispatch", async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValue(observation({ headline: "Once" }));
    const runtime = new DurableModelExecutionRuntime<Input, Output>({
      ledger: await ledger(),
      transport: { dispatch },
    });
    const plan = executionPlan("copy-once");

    await runtime.execute(plan);
    await expect(runtime.execute(plan)).rejects.toThrow(
      "MODEL_EXECUTION_ALREADY_CLAIMED",
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("records known wire settlement then freezes a validator-rejected execution", async () => {
    const durableLedger = await ledger();
    const runtime = new DurableModelExecutionRuntime<Input, Output>({
      ledger: durableLedger,
      transport: {
        dispatch: vi.fn().mockResolvedValue(observation({ headline: "" })),
      },
    });

    await expect(
      runtime.execute(executionPlan("copy-invalid")),
    ).rejects.toThrow(/validation failed/u);
    expect(await durableLedger.summary()).toMatchObject({
      wireClaims: 1,
      knownWireSettlements: 1,
      completedExecutions: 0,
      frozen: true,
    });
  });

  it("records known billed failure settlement before warning freeze without content repair", async () => {
    const durableLedger = await ledger();
    const dispatch = vi.fn().mockResolvedValue({
      ...observation({ headline: "" }),
      warnings: ["native_api_failure_http_524:settled"],
    });
    const findings = vi.fn();
    const compile = vi.fn();
    const runtime = new DurableModelExecutionRuntime<Input, Output>({
      ledger: durableLedger,
      transport: { dispatch },
      repairCompiler: { findings, compile },
    });
    const plan = executionPlan("copy-known-api-failure");

    await expect(
      runtime.execute({
        ...plan,
        contract: {
          ...plan.contract,
          retryPolicy: {
            ...plan.contract.retryPolicy,
            contentRepairMaxAttempts: 1,
          },
        },
      }),
    ).rejects.toThrow(/provider warnings/u);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(findings).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
    expect(await durableLedger.summary()).toMatchObject({
      wireClaims: 1,
      knownWireSettlements: 1,
      unknownWireSettlements: 0,
      completedExecutions: 0,
      frozen: true,
    });
  });

  it("durably freezes unknown post-dispatch settlement and blocks later executions", async () => {
    const durableLedger = await ledger();
    const runtime = new DurableModelExecutionRuntime<Input, Output>({
      ledger: durableLedger,
      transport: {
        dispatch: vi.fn().mockResolvedValue({
          ...observation({ headline: "Unknown" }),
          requestId: undefined,
          settlement: "unknown",
          settlementUnknownReason: "Bearer must-not-enter-ledger",
        }),
      },
    });

    await expect(
      runtime.execute(executionPlan("copy-unknown")),
    ).rejects.toThrow(/settlement is unknown/u);
    expect(await durableLedger.summary()).toMatchObject({
      unknownWireSettlements: 1,
      frozen: true,
    });
    const ledgerText = await readFile(
      join(temporaryDirectories.at(-1)!, "ledger.jsonl"),
      "utf8",
    );
    expect(ledgerText).not.toContain("Bearer must-not-enter-ledger");
    expect(ledgerText).toContain("observation_or_settlement_incomplete");
    await expect(
      runtime.execute(executionPlan("copy-after-unknown")),
    ).rejects.toThrow("MODEL_EXECUTION_CAMPAIGN_FROZEN");
  });

  it("records known settlement before a failing post-wire guard freezes the campaign", async () => {
    const durableLedger = await ledger();
    const guard = vi
      .fn()
      .mockRejectedValue(new Error("compiled runtime drift"));
    const runtime = new DurableModelExecutionRuntime<Input, Output>({
      ledger: durableLedger,
      transport: {
        dispatch: vi
          .fn()
          .mockResolvedValue(observation({ headline: "Observed" })),
      },
      postWireGuard: guard,
    });

    const failure = await runtime.execute(executionPlan("copy-drift")).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(unwrapModelExecutionError(failure)).toMatchObject({
      message: "model execution post-wire guard failed",
    });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(await durableLedger.summary()).toMatchObject({
      wireClaims: 1,
      knownWireSettlements: 1,
      completedExecutions: 0,
      frozen: true,
    });
  });

  it("freezes before completion when the completion guard rejects the result", async () => {
    const durableLedger = await ledger();
    const completionGuard = vi
      .fn()
      .mockRejectedValue(new Error("operational proof incomplete"));
    const runtime = new DurableModelExecutionRuntime<Input, Output>({
      ledger: durableLedger,
      transport: {
        dispatch: vi
          .fn()
          .mockResolvedValue(observation({ headline: "Observed" })),
      },
      completionGuard,
    });

    await expect(
      runtime.execute(executionPlan("copy-completion-guard")),
    ).rejects.toThrow("model execution completion guard failed");
    expect(completionGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        wireCount: 1,
        outputDigest: canonicalDigest({ headline: "Observed" }),
      }),
    );
    expect(await durableLedger.summary()).toMatchObject({
      wireClaims: 1,
      knownWireSettlements: 1,
      completedExecutions: 0,
      frozen: true,
    });
  });
});
