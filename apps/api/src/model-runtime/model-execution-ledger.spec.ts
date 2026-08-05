import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppendOnlyModelExecutionLedger,
  MODEL_EXECUTION_LEDGER_SCHEMA_VERSION,
} from "./model-execution-ledger";

const temporaryDirectories: string[] = [];

async function temporaryLedgerPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "model-execution-ledger-"));
  temporaryDirectories.push(directory);
  return join(directory, "ledger.jsonl");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function openLedger(input?: {
  maximumExecutions?: number;
  maximumWireCalls?: number;
}) {
  return AppendOnlyModelExecutionLedger.openTestOnly({
    ledgerPath: await temporaryLedgerPath(),
    campaign: {
      campaignId: "copy-pilot-test",
      taskId: "site_builder.copy",
      planDigest: "a".repeat(64),
      maximumExecutions: input?.maximumExecutions ?? 3,
      maximumWireCalls: input?.maximumWireCalls ?? 6,
    },
  });
}

describe("AppendOnlyModelExecutionLedger", () => {
  it("durably binds execution, unique wire observation, completion, and hash chain", async () => {
    const ledger = await openLedger();

    await ledger.claimExecution({
      executionId: "copy-terra",
      planDigest: "b".repeat(64),
    });
    await ledger.claimWire({
      executionId: "copy-terra",
      wireId: "copy-terra:1",
      requestDigest: "c".repeat(64),
    });
    await ledger.observeWire({
      executionId: "copy-terra",
      wireId: "copy-terra:1",
      settlement: "known",
      requestId: "request-copy-terra",
      requestedAlias: "gpt-5.6-terra",
      resolvedAlias: "gpt-5.6-terra",
      reportedModel: "gpt-5.6-terra",
      protocol: "openai_responses",
      usage: { inputTokens: 12, outputTokens: 7 },
      outputDigest: "d".repeat(64),
    });
    await ledger.completeExecution({
      executionId: "copy-terra",
      outputDigest: "d".repeat(64),
    });

    const summary = await ledger.summary();
    expect(summary).toMatchObject({
      schemaVersion: MODEL_EXECUTION_LEDGER_SCHEMA_VERSION,
      evidenceClass: "fake_gateway_contract_only",
      eventCount: 5,
      executionClaims: 1,
      wireClaims: 1,
      knownWireSettlements: 1,
      unknownWireSettlements: 0,
      completedExecutions: 1,
      frozen: false,
    });
    expect(summary.ledgerDigest).toMatch(/^[0-9a-f]{64}$/u);
    const raw = await readFile(ledger.ledgerPath, "utf8");
    expect(raw).not.toContain("prompt");
    expect(raw).not.toContain("Bearer");
  });

  it("rejects duplicate execution and wire claims before another dispatch", async () => {
    const ledger = await openLedger();
    await ledger.claimExecution({
      executionId: "copy-terra",
      planDigest: "b".repeat(64),
    });
    await expect(
      ledger.claimExecution({
        executionId: "copy-terra",
        planDigest: "b".repeat(64),
      }),
    ).rejects.toThrow("MODEL_EXECUTION_ALREADY_CLAIMED");
    await ledger.claimWire({
      executionId: "copy-terra",
      wireId: "copy-terra:1",
      requestDigest: "c".repeat(64),
    });
    await expect(
      ledger.claimWire({
        executionId: "copy-terra",
        wireId: "copy-terra:1",
        requestDigest: "c".repeat(64),
      }),
    ).rejects.toThrow("MODEL_EXECUTION_WIRE_ALREADY_CLAIMED");
  });

  it("enforces campaign execution and physical-wire caps", async () => {
    const ledger = await openLedger({
      maximumExecutions: 1,
      maximumWireCalls: 1,
    });
    await ledger.claimExecution({
      executionId: "copy-terra",
      planDigest: "b".repeat(64),
    });
    await ledger.claimWire({
      executionId: "copy-terra",
      wireId: "copy-terra:1",
      requestDigest: "c".repeat(64),
    });

    await expect(
      ledger.claimExecution({
        executionId: "copy-sol",
        planDigest: "e".repeat(64),
      }),
    ).rejects.toThrow("MODEL_EXECUTION_CAP_EXHAUSTED");
    await expect(
      ledger.claimWire({
        executionId: "copy-terra",
        wireId: "copy-terra:2",
        requestDigest: "f".repeat(64),
      }),
    ).rejects.toThrow("MODEL_EXECUTION_WIRE_CAP_EXHAUSTED");
  });

  it("freezes unknown settlement and prevents every later claim", async () => {
    const ledger = await openLedger();
    await ledger.claimExecution({
      executionId: "copy-terra",
      planDigest: "b".repeat(64),
    });
    await ledger.claimWire({
      executionId: "copy-terra",
      wireId: "copy-terra:1",
      requestDigest: "c".repeat(64),
    });
    await ledger.observeWire({
      executionId: "copy-terra",
      wireId: "copy-terra:1",
      settlement: "unknown",
      requestId: null,
      reason: "transport_failed_after_dispatch",
    });

    await expect(
      ledger.claimExecution({
        executionId: "copy-sol",
        planDigest: "e".repeat(64),
      }),
    ).rejects.toThrow("MODEL_EXECUTION_CAMPAIGN_FROZEN");
    expect(await ledger.summary()).toMatchObject({
      unknownWireSettlements: 1,
      frozen: true,
    });
  });

  it("detects ledger tampering and refuses symlink or busy lock targets", async () => {
    const ledger = await openLedger();
    await appendFile(ledger.ledgerPath, '{"forged":true}\n', "utf8");
    await expect(ledger.summary()).rejects.toThrow(
      "MODEL_EXECUTION_LEDGER_INVALID",
    );

    const target = await temporaryLedgerPath();
    await writeFile(target, "", { mode: 0o600 });
    const link = `${target}.link`;
    await symlink(target, link);
    await expect(
      AppendOnlyModelExecutionLedger.openTestOnly({
        ledgerPath: link,
        campaign: {
          campaignId: "copy-link-test",
          taskId: "site_builder.copy",
          planDigest: "a".repeat(64),
          maximumExecutions: 1,
          maximumWireCalls: 1,
        },
      }),
    ).rejects.toThrow(/MODEL_EXECUTION_LEDGER_(INVALID|UNSAFE)/u);

    const busyPath = await temporaryLedgerPath();
    await writeFile(`${busyPath}.lock`, "busy", { mode: 0o600 });
    await expect(
      AppendOnlyModelExecutionLedger.openTestOnly({
        ledgerPath: busyPath,
        campaign: {
          campaignId: "copy-busy-test",
          taskId: "site_builder.copy",
          planDigest: "a".repeat(64),
          maximumExecutions: 1,
          maximumWireCalls: 1,
        },
      }),
    ).rejects.toThrow("MODEL_EXECUTION_LEDGER_BUSY");
  });
});
