import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RealModelExecutionLedger } from "./real-model-execution-ledger";

const temporaryDirectories: string[] = [];
const digest = (character: string) => character.repeat(64);

const campaign = Object.freeze({
  campaignId: "copy-real-capability-pilot",
  taskId: "site_builder.copy",
  planDigest: digest("1"),
  maximumExecutions: 3,
  maximumWireCalls: 6,
});

const authorization = Object.freeze({
  schemaVersion:
    "site-builder-copy-pilot-dispatch-authorization/2026-08-05-v1" as const,
  authorizationId: "copy-pilot-authorization-20260805",
  status: "AUTHORIZED" as const,
  issuedAt: "2026-08-05T00:00:00.000Z",
  expiresAt: "2026-08-06T00:00:00.000Z",
  manifestDigest: digest("2"),
  credentialAttestationDigest: digest("3"),
  settlementObserverDigest: digest("4"),
  ledgerIdentityDigest: digest("5"),
  reservationId: "copy-pilot-reservation-20260805",
  reservationDigest: digest("6"),
  reservationStatus: "RESERVED" as const,
  maximumExecutions: 3 as const,
  maximumWireCalls: 6 as const,
  maximumRepairCallsPerExecution: 1 as const,
});

interface LedgerPaths {
  directory: string;
  ledgerPath: string;
  authorizationClaimPath: string;
}

async function paths(): Promise<LedgerPaths> {
  const directory = await mkdtemp(join(tmpdir(), "real-model-ledger-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    ledgerPath: join(directory, "ledger.jsonl"),
    authorizationClaimPath: join(directory, "authorization.claim.json"),
  };
}

async function openLedger(input: LedgerPaths) {
  return RealModelExecutionLedger.open({
    ledgerPath: input.ledgerPath,
    authorizationClaimPath: input.authorizationClaimPath,
    campaign,
    authorization,
  });
}

async function claimAndSettle(
  ledger: RealModelExecutionLedger,
  input: { executionId: string; wireNumber: 1 | 2; alias?: string },
): Promise<void> {
  const alias = input.alias ?? "gpt-5.6-terra";
  const wireId = `${input.executionId}:${input.wireNumber}`;
  await ledger.claimWire({
    executionId: input.executionId,
    wireId,
    requestDigest: digest(input.wireNumber === 1 ? "7" : "8"),
  });
  await ledger.observeWire({
    executionId: input.executionId,
    wireId,
    settlement: "known",
    requestId: `req-${input.executionId}-${input.wireNumber}`,
    requestedAlias: alias,
    resolvedAlias: alias,
    reportedModel: alias,
    protocol:
      alias === "claude-sonnet-5" ? "anthropic_messages" : "openai_responses",
    usage: { inputTokens: 120, outputTokens: 30 },
    outputDigest: digest(input.wireNumber === 1 ? "9" : "a"),
    receiptDigest: digest(input.wireNumber === 1 ? "b" : "c"),
    quota: 1_250,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RealModelExecutionLedger", () => {
  it("claims one authorization and reservation, then resumes the same durable campaign", async () => {
    const target = await paths();
    const first = await openLedger(target);
    const originalClaim = await readFile(target.authorizationClaimPath);

    await first.claimExecution({
      executionId: "copy-terra",
      planDigest: campaign.planDigest,
    });
    await claimAndSettle(first, {
      executionId: "copy-terra",
      wireNumber: 1,
    });

    const resumed = await openLedger(target);
    expect(await readFile(target.authorizationClaimPath)).toEqual(
      originalClaim,
    );
    expect(await resumed.summary()).toMatchObject({
      evidenceClass: "gateway_settlement_claim_only",
      executionClaims: 1,
      wireClaims: 1,
      knownWireSettlements: 1,
      frozen: false,
    });

    await resumed.planRepair({
      executionId: "copy-terra",
      wireId: "copy-terra:2",
      bindingDigest: digest("d"),
      priorOutputDigest: digest("9"),
      findingsDigest: digest("e"),
    });
    await claimAndSettle(resumed, {
      executionId: "copy-terra",
      wireNumber: 2,
    });
    await resumed.completeExecution({
      executionId: "copy-terra",
      outputDigest: digest("a"),
    });

    expect(await resumed.summary()).toMatchObject({
      executionClaims: 1,
      wireClaims: 2,
      knownWireSettlements: 2,
      completedExecutions: 1,
      frozen: false,
    });
    await expect(
      resumed.completeExecution({
        executionId: "copy-terra",
        outputDigest: digest("a"),
      }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_ALREADY_COMPLETED");
    await expect(
      resumed.planRepair({
        executionId: "copy-terra",
        wireId: "copy-terra:3",
        bindingDigest: digest("d"),
        priorOutputDigest: digest("a"),
        findingsDigest: digest("e"),
      }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_ALREADY_COMPLETED");
  });

  it("rejects reuse of the claimed authorization or reservation for another ledger", async () => {
    const target = await paths();
    await openLedger(target);

    await expect(
      RealModelExecutionLedger.open({
        ledgerPath: join(target.directory, "second-ledger.jsonl"),
        authorizationClaimPath: target.authorizationClaimPath,
        campaign,
        authorization,
      }),
    ).rejects.toThrow(
      /REAL_MODEL_(AUTHORIZATION|RESERVATION)_ALREADY_CLAIMED|REAL_MODEL_LEDGER_IDENTITY_MISMATCH/u,
    );

    await expect(
      RealModelExecutionLedger.open({
        ledgerPath: target.ledgerPath,
        authorizationClaimPath: target.authorizationClaimPath,
        campaign,
        authorization: {
          ...authorization,
          reservationId: "copy-pilot-reservation-replacement",
        },
      }),
    ).rejects.toThrow(/REAL_MODEL_(AUTHORIZATION|RESERVATION)_MISMATCH/u);
  });

  it("rejects authorization bindings or 3/6/1 reservation caps that drift on resume", async () => {
    const target = await paths();
    await openLedger(target);
    const driftedAuthorizations = [
      { ...authorization, manifestDigest: digest("7") },
      { ...authorization, credentialAttestationDigest: digest("7") },
      { ...authorization, settlementObserverDigest: digest("7") },
      { ...authorization, ledgerIdentityDigest: digest("7") },
      { ...authorization, reservationDigest: digest("7") },
      { ...authorization, maximumExecutions: 4 as const },
      { ...authorization, maximumWireCalls: 7 as const },
      { ...authorization, maximumRepairCallsPerExecution: 2 as const },
    ];

    for (const drifted of driftedAuthorizations) {
      await expect(
        RealModelExecutionLedger.open({
          ledgerPath: target.ledgerPath,
          authorizationClaimPath: target.authorizationClaimPath,
          campaign,
          authorization: drifted,
        }),
      ).rejects.toThrow(
        /REAL_MODEL_(AUTHORIZATION|RESERVATION|LEDGER).*MISMATCH/u,
      );
    }
  });

  it("enforces the exact 3 execution, 6 wire, and 2 wires per execution caps", async () => {
    const ledger = await openLedger(await paths());
    const executions = [
      ["copy-terra", "gpt-5.6-terra"],
      ["copy-sol", "gpt-5.6-sol"],
      ["copy-sonnet", "claude-sonnet-5"],
    ] as const;

    for (const [executionId, alias] of executions) {
      await ledger.claimExecution({
        executionId,
        planDigest: campaign.planDigest,
      });
      await claimAndSettle(ledger, { executionId, wireNumber: 1, alias });
      await ledger.planRepair({
        executionId,
        wireId: `${executionId}:2`,
        bindingDigest: digest("d"),
        priorOutputDigest: digest("9"),
        findingsDigest: digest("e"),
      });
      await claimAndSettle(ledger, { executionId, wireNumber: 2, alias });
    }

    await expect(
      ledger.claimExecution({
        executionId: "copy-fourth",
        planDigest: campaign.planDigest,
      }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_CAP_EXHAUSTED");
    await expect(
      ledger.claimWire({
        executionId: "copy-terra",
        wireId: "copy-terra:3",
        requestDigest: digest("f"),
      }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_WIRE_CAP_EXHAUSTED");
    expect(await ledger.summary()).toMatchObject({
      executionClaims: 3,
      wireClaims: 6,
      knownWireSettlements: 6,
    });
  });

  it("permits exactly one bound repair plan per execution", async () => {
    const ledger = await openLedger(await paths());
    await ledger.claimExecution({
      executionId: "copy-terra",
      planDigest: campaign.planDigest,
    });
    await claimAndSettle(ledger, {
      executionId: "copy-terra",
      wireNumber: 1,
    });
    const repair = {
      executionId: "copy-terra",
      wireId: "copy-terra:2",
      bindingDigest: digest("d"),
      priorOutputDigest: digest("9"),
      findingsDigest: digest("e"),
    } as const;

    await ledger.planRepair(repair);
    await expect(
      ledger.planRepair({ ...repair, wireId: "copy-terra:3" }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_REPAIR_CAP_EXHAUSTED");
  });

  it("consumes one operator evidence authorization in the candidate ledger chain", async () => {
    const target = await paths();
    const ledger = await openLedger(target);
    await ledger.claimExecution({
      executionId: "copy-terra",
      planDigest: campaign.planDigest,
    });
    await claimAndSettle(ledger, {
      executionId: "copy-terra",
      wireNumber: 1,
    });
    await ledger.completeExecution({
      executionId: "copy-terra",
      outputDigest: digest("9"),
    });
    const candidate = await ledger.summary();
    const authorizationInput = {
      authorizationId: "copy-evidence-auth-001",
      keyId: "copy-evidence-operator-2026-08-v1",
      payloadDigest: digest("d"),
      signatureDigest: digest("e"),
      candidateReceiptDigest: digest("f"),
      executionId: "copy-terra",
      outputDigest: digest("9"),
      candidateLedgerDigest: candidate.ledgerDigest,
    } as const;

    const evidenceLedgerDigest =
      await ledger.consumeOperatorEvidenceAuthorization(authorizationInput);

    expect(evidenceLedgerDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(evidenceLedgerDigest).not.toBe(candidate.ledgerDigest);
    expect(await ledger.summary()).toMatchObject({
      operatorEvidenceAuthorizations: 1,
      ledgerDigest: evidenceLedgerDigest,
      frozen: false,
    });
    await expect(
      ledger.consumeOperatorEvidenceAuthorization(authorizationInput),
    ).resolves.toBe(evidenceLedgerDigest);
    expect(await ledger.summary()).toMatchObject({
      operatorEvidenceAuthorizations: 1,
      ledgerDigest: evidenceLedgerDigest,
    });
    const resumed = await openLedger(target);
    await expect(
      resumed.consumeOperatorEvidenceAuthorization(authorizationInput),
    ).resolves.toBe(evidenceLedgerDigest);
    expect(await resumed.summary()).toMatchObject({
      operatorEvidenceAuthorizations: 1,
      ledgerDigest: evidenceLedgerDigest,
    });
    await resumed.freezeExecution("copy-sonnet", "later_execution_failed");
    await expect(
      resumed.consumeOperatorEvidenceAuthorization(authorizationInput),
    ).resolves.toBe(evidenceLedgerDigest);
    await expect(
      ledger.consumeOperatorEvidenceAuthorization({
        ...authorizationInput,
        signatureDigest: digest("0"),
      }),
    ).rejects.toThrow("REAL_MODEL_OPERATOR_AUTHORIZATION_ALREADY_CONSUMED");
  });

  it("rejects operator evidence authorization drift before appending", async () => {
    const ledger = await openLedger(await paths());
    await ledger.claimExecution({
      executionId: "copy-terra",
      planDigest: campaign.planDigest,
    });
    await claimAndSettle(ledger, {
      executionId: "copy-terra",
      wireNumber: 1,
    });
    await ledger.completeExecution({
      executionId: "copy-terra",
      outputDigest: digest("9"),
    });
    const candidate = await ledger.summary();

    await expect(
      ledger.consumeOperatorEvidenceAuthorization({
        authorizationId: "copy-evidence-auth-002",
        keyId: "copy-evidence-operator-2026-08-v1",
        payloadDigest: digest("d"),
        signatureDigest: digest("e"),
        candidateReceiptDigest: digest("f"),
        executionId: "copy-terra",
        outputDigest: digest("a"),
        candidateLedgerDigest: candidate.ledgerDigest,
      }),
    ).rejects.toThrow("REAL_MODEL_OPERATOR_AUTHORIZATION_BINDING_MISMATCH");
    expect(await ledger.summary()).toMatchObject({
      operatorEvidenceAuthorizations: 0,
      ledgerDigest: candidate.ledgerDigest,
    });
  });

  it("durably freezes unknown settlement across a process restart", async () => {
    const target = await paths();
    const ledger = await openLedger(target);
    await ledger.claimExecution({
      executionId: "copy-terra",
      planDigest: campaign.planDigest,
    });
    await ledger.claimWire({
      executionId: "copy-terra",
      wireId: "copy-terra:1",
      requestDigest: digest("7"),
    });
    await ledger.observeWire({
      executionId: "copy-terra",
      wireId: "copy-terra:1",
      settlement: "unknown",
      requestId: "req-copy-terra-1",
      reason: "request_bound_consume_log_unavailable",
    });

    const resumed = await openLedger(target);
    expect(await resumed.summary()).toMatchObject({
      unknownWireSettlements: 1,
      frozen: true,
    });
    await expect(
      resumed.claimExecution({
        executionId: "copy-sol",
        planDigest: campaign.planDigest,
      }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_CAMPAIGN_FROZEN");
  });

  it.each(["ledger", "authorization claim"] as const)(
    "rejects a same-byte %s file replacement",
    async (kind) => {
      const target = await paths();
      const ledger = await openLedger(target);
      const originalPath =
        kind === "ledger" ? target.ledgerPath : target.authorizationClaimPath;
      const replacementBytes = await readFile(originalPath);
      await rename(originalPath, `${originalPath}.replaced`);
      await writeFile(originalPath, replacementBytes, { mode: 0o600 });

      await expect(ledger.summary()).rejects.toThrow(
        kind === "ledger"
          ? "REAL_MODEL_EXECUTION_LEDGER_REPLACED"
          : "REAL_MODEL_AUTHORIZATION_CLAIM_REPLACED",
      );
    },
  );
});
