import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalDigest, ContextEngine } from "./context-engine";
import {
  DurableModelExecutionRuntime,
  getDurableModelExecutionAttestation,
} from "./durable-model-execution-runtime";
import { AppendOnlyModelExecutionLedger } from "./model-execution-ledger";
import { ModelExecutionRuntime } from "./model-execution-runtime";
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
        evidenceClass: "real_gateway_settled",
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

  it("durably freezes unknown post-dispatch settlement and blocks later executions", async () => {
    const durableLedger = await ledger();
    const runtime = new DurableModelExecutionRuntime<Input, Output>({
      ledger: durableLedger,
      transport: {
        dispatch: vi.fn().mockResolvedValue({
          ...observation({ headline: "Unknown" }),
          requestId: undefined,
          settlement: "unknown",
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
    await expect(
      runtime.execute(executionPlan("copy-after-unknown")),
    ).rejects.toThrow("MODEL_EXECUTION_CAMPAIGN_FROZEN");
  });
});
