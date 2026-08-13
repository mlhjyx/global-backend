import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RealModelExecutionLedger } from "./real-model-execution-ledger";

const temporaryDirectories: string[] = [];
const digest = (character: string) => character.repeat(64);
const bytesDigest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

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

const qualityCampaign = Object.freeze({
  ...campaign,
  campaignId: "copy-quality-shared-campaign",
  maximumExecutions: 36,
  maximumWireCalls: 72,
});
const qualityExecutionPlanDigest = digest("8");

const qualitySharedCampaignBinding = Object.freeze({
  schemaVersion: "real-model-shared-campaign-binding/2026-08-07-v1" as const,
  purpose: "site_builder_copy_quality_matrix",
  ledgerTopology: "shared_campaign_ledger",
  taskId: qualityCampaign.taskId,
  planDigest: qualityCampaign.planDigest,
  fixedSourceCommit: "3".repeat(40),
  sourceBundleDigest: digest("4"),
  manifestDigest: authorization.manifestDigest,
  admissionDigest: digest("a"),
  credentialAttestationDigest: authorization.credentialAttestationDigest,
  settlementObserverDigest: authorization.settlementObserverDigest,
  compiledRuntimeDigest: digest("6"),
  compiledBindingDigest: digest("7"),
  maximumExecutions: 36,
  maximumWireCalls: 72,
  maximumRepairCallsPerExecution: 1,
});

const qualityAuthorization = Object.freeze({
  ...authorization,
  maximumExecutions: 36,
  maximumWireCalls: 72,
  sharedCampaignBinding: qualitySharedCampaignBinding,
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

async function openQualityLedger(input: LedgerPaths) {
  return RealModelExecutionLedger.open({
    ledgerPath: input.ledgerPath,
    authorizationClaimPath: input.authorizationClaimPath,
    campaign: qualityCampaign,
    authorization: qualityAuthorization,
  });
}

async function claimAndSettle(
  ledger: RealModelExecutionLedger,
  input: {
    executionId: string;
    wireNumber: 1 | 2;
    alias?: string;
    reportedModel?: string;
    outputDigest?: string;
  },
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
    reportedModel: input.reportedModel ?? alias,
    protocol:
      alias === "claude-sonnet-5" ? "anthropic_messages" : "openai_responses",
    usage: { inputTokens: 120, outputTokens: 30 },
    outputDigest:
      input.outputDigest ?? digest(input.wireNumber === 1 ? "9" : "a"),
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
  it("fails closed for unsafe paths, partial identity state, and an existing writer lock", async () => {
    const target = await paths();
    await expect(
      RealModelExecutionLedger.open({
        ledgerPath: "relative-ledger.jsonl",
        authorizationClaimPath: target.authorizationClaimPath,
        campaign,
        authorization,
      }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_LEDGER_UNSAFE");
    await expect(
      RealModelExecutionLedger.open({
        ledgerPath: target.ledgerPath,
        authorizationClaimPath: target.ledgerPath,
        campaign,
        authorization,
      }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_LEDGER_UNSAFE");

    await writeFile(target.ledgerPath, "orphan", { mode: 0o600 });
    await expect(openLedger(target)).rejects.toThrow("REAL_MODEL_LEDGER_IDENTITY_MISMATCH");
    await rm(target.ledgerPath);
    await writeFile(`${target.ledgerPath}.lock`, "busy", { mode: 0o600 });
    await expect(openLedger(target)).rejects.toThrow("REAL_MODEL_EXECUTION_LEDGER_BUSY");
  });

  it("enforces claim, observation, repair, and completion state transitions before appending", async () => {
    const ledger = await openLedger(await paths());
    await expect(
      ledger.claimWire({ executionId: "copy-terra", wireId: "copy-terra:1", requestDigest: digest("7") }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_NOT_CLAIMED");
    await ledger.claimExecution({ executionId: "copy-terra", planDigest: campaign.planDigest });
    await expect(
      ledger.claimExecution({ executionId: "copy-terra", planDigest: campaign.planDigest }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_ALREADY_CLAIMED");
    await expect(
      ledger.planRepair({
        executionId: "copy-terra",
        wireId: "copy-terra:2",
        bindingDigest: digest("d"),
        priorOutputDigest: digest("9"),
        findingsDigest: digest("e"),
      }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_REPAIR_UNSETTLED");

    await ledger.claimWire({ executionId: "copy-terra", wireId: "copy-terra:1", requestDigest: digest("7") });
    await expect(
      ledger.completeExecution({ executionId: "copy-terra", outputDigest: digest("9") }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_COMPLETION_MISMATCH");
    await expect(
      ledger.observeWire({
        executionId: "copy-terra",
        wireId: "copy-terra:1",
        settlement: "known",
        requestId: "req-1",
        requestedAlias: "gpt-5.6-terra",
        resolvedAlias: "gpt-5.6-terra",
        reportedModel: "gpt-5.6-terra",
        protocol: "openai_responses",
        usage: { inputTokens: -1, outputTokens: 0 },
        outputDigest: digest("9"),
        receiptDigest: digest("b"),
        quota: 0,
      }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_OBSERVATION_INVALID");
    await expect(
      ledger.observeWire({
        executionId: "copy-terra",
        wireId: "copy-terra:1",
        settlement: "unknown",
        requestId: null,
        reason: "   ",
      }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_UNKNOWN_REASON_INVALID");

    await ledger.observeWire({
      executionId: "copy-terra",
      wireId: "copy-terra:1",
      settlement: "known",
      requestId: "req-copy-terra-1",
      requestedAlias: "gpt-5.6-terra",
      resolvedAlias: "gpt-5.6-terra",
      reportedModel: "gpt-5.6-terra",
      protocol: "openai_responses",
      usage: { inputTokens: 120, outputTokens: 30 },
      outputDigest: digest("9"),
      receiptDigest: digest("b"),
      quota: 1_250,
    });
    await expect(
      ledger.observeWire({
        executionId: "copy-terra",
        wireId: "copy-terra:1",
        settlement: "unknown",
        requestId: null,
        reason: "later duplicate",
      }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_WIRE_ALREADY_OBSERVED");
    await expect(
      ledger.claimWire({ executionId: "copy-terra", wireId: "copy-terra:2", requestDigest: digest("8") }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_REPAIR_NOT_PLANNED");
    await expect(
      ledger.planRepair({
        executionId: "copy-terra",
        wireId: "copy-terra:2",
        bindingDigest: digest("d"),
        priorOutputDigest: digest("0"),
        findingsDigest: digest("e"),
      }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_REPAIR_INVALID");
  });

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

  it("reopens only an existing ledger and never creates evidence state", async () => {
    const target = await paths();
    await expect(
      RealModelExecutionLedger.reopen({
        ledgerPath: target.ledgerPath,
        authorizationClaimPath: target.authorizationClaimPath,
        campaign,
        authorization,
      }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_LEDGER_REOPEN_REQUIRED");
    await expect(readFile(target.ledgerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const opened = await openLedger(target);
    const beforeLedger = await readFile(target.ledgerPath);
    const beforeClaim = await readFile(target.authorizationClaimPath);
    const reopened = await RealModelExecutionLedger.reopen({
      ledgerPath: target.ledgerPath,
      authorizationClaimPath: target.authorizationClaimPath,
      campaign,
      authorization,
    });

    expect(await reopened.summary()).toEqual(await opened.summary());
    expect(await readFile(target.ledgerPath)).toEqual(beforeLedger);
    expect(await readFile(target.authorizationClaimPath)).toEqual(beforeClaim);
  });

  it("binds the claimed execution to the persisted evidence projection", async () => {
    const target = await paths();
    const executionPlanDigest = digest("7");
    const ledger = await RealModelExecutionLedger.open({
      ledgerPath: target.ledgerPath,
      authorizationClaimPath: target.authorizationClaimPath,
      campaign,
      authorization: {
        ...authorization,
        evidenceBinding: {
          schemaVersion: "real-model-execution-evidence-binding/2026-08-07-v1",
          executionId: "copy-terra-bound",
          childSlotId: "copy-child-terra-bound",
          alias: "gpt-5.6-terra",
          protocol: "openai_responses",
          reasoning: "medium",
          fixtureId: "copy-factual-claims",
          executionPlanDigest,
          inputDigest: digest("8"),
          contextDigest: digest("9"),
          promptDigest: digest("a"),
          fixedSourceCommit: "b".repeat(40),
          sourceBundleDigest: digest("c"),
          manifestDigest: authorization.manifestDigest,
          admissionDigest: digest("d"),
          globalAuthorizationDigest: digest("e"),
          childAuthorizationDigest: digest("f"),
          compiledRuntimeDigest: digest("0"),
          compiledBindingDigest: digest("a"),
        },
      },
    });

    await expect(
      ledger.claimExecution({
        executionId: "copy-terra-forged",
        planDigest: executionPlanDigest,
      }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_EVIDENCE_BINDING_MISMATCH");
    await expect(
      ledger.claimExecution({
        executionId: "copy-terra-bound",
        planDigest: digest("6"),
      }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_EVIDENCE_BINDING_MISMATCH");
    await expect(
      ledger.claimExecution({
        executionId: "copy-terra-bound",
        planDigest: executionPlanDigest,
      }),
    ).resolves.toBeUndefined();
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

  it("validates a versioned shared campaign binding against campaign and authorization truth", async () => {
    await expect(openQualityLedger(await paths())).resolves.toBeInstanceOf(
      RealModelExecutionLedger,
    );

    const driftedBindings = [
      {
        ...qualitySharedCampaignBinding,
        schemaVersion: "real-model-shared-campaign-binding/forged",
      },
      { ...qualitySharedCampaignBinding, purpose: "x" },
      { ...qualitySharedCampaignBinding, ledgerTopology: "x" },
      { ...qualitySharedCampaignBinding, taskId: "site_builder.other" },
      { ...qualitySharedCampaignBinding, planDigest: digest("0") },
      { ...qualitySharedCampaignBinding, fixedSourceCommit: "g".repeat(40) },
      { ...qualitySharedCampaignBinding, sourceBundleDigest: "invalid" },
      { ...qualitySharedCampaignBinding, manifestDigest: digest("0") },
      { ...qualitySharedCampaignBinding, admissionDigest: "invalid" },
      {
        ...qualitySharedCampaignBinding,
        credentialAttestationDigest: digest("0"),
      },
      {
        ...qualitySharedCampaignBinding,
        settlementObserverDigest: digest("0"),
      },
      { ...qualitySharedCampaignBinding, compiledRuntimeDigest: "invalid" },
      { ...qualitySharedCampaignBinding, compiledBindingDigest: "invalid" },
      { ...qualitySharedCampaignBinding, maximumExecutions: 37 },
      { ...qualitySharedCampaignBinding, maximumWireCalls: 73 },
      {
        ...qualitySharedCampaignBinding,
        maximumRepairCallsPerExecution: 2,
      },
    ];

    for (const sharedCampaignBinding of driftedBindings) {
      const target = await paths();
      await expect(
        RealModelExecutionLedger.open({
          ledgerPath: target.ledgerPath,
          authorizationClaimPath: target.authorizationClaimPath,
          campaign: qualityCampaign,
          authorization: {
            ...qualityAuthorization,
            sharedCampaignBinding,
          } as unknown as Parameters<
            typeof RealModelExecutionLedger.open
          >[0]["authorization"],
        }),
      ).rejects.toThrow(/REAL_MODEL_AUTHORIZATION_(INVALID|MISMATCH)/u);
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

  it("consumes one Git-reviewed evidence acceptance with the exact known-settlement chain", async () => {
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
    const knownSettlementDigest =
      await ledger.executionKnownSettlementDigest("copy-terra");
    const acceptanceInput = {
      acceptanceId: "copy-git-acceptance-001",
      artifactDigest: digest("d"),
      artifactCommit: "1".repeat(40),
      mergeCommit: "2".repeat(40),
      pullRequestNumber: 401,
      acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
      evidenceKind: "capability_pilot",
      candidateReceiptDigest: digest("e"),
      executionId: "copy-terra",
      planDigest: campaign.planDigest,
      outputDigest: digest("9"),
      candidateLedgerDigest: candidate.ledgerDigest,
      fixedSourceCommit: "3".repeat(40),
      sourceBundleDigest: digest("4"),
      manifestDigest: authorization.manifestDigest,
      compiledRuntimeDigest: digest("6"),
      compiledBindingDigest: digest("7"),
      settlementObserverDigest: authorization.settlementObserverDigest,
      knownSettlementDigest,
      alias: "gpt-5.6-terra",
      protocol: "openai_responses",
      reasoning: "medium",
    } as const;

    const evidenceLedgerDigest =
      await ledger.consumeGitEvidenceAcceptance(acceptanceInput);

    expect(evidenceLedgerDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(evidenceLedgerDigest).not.toBe(candidate.ledgerDigest);
    expect(await ledger.summary()).toMatchObject({
      gitEvidenceAcceptances: 1,
      operatorEvidenceAuthorizations: 0,
      ledgerDigest: evidenceLedgerDigest,
      frozen: false,
    });
    await expect(
      ledger.consumeGitEvidenceAcceptance(acceptanceInput),
    ).resolves.toBe(evidenceLedgerDigest);

    const resumed = await openLedger(target);
    await expect(
      resumed.consumeGitEvidenceAcceptance(acceptanceInput),
    ).resolves.toBe(evidenceLedgerDigest);
    expect(await resumed.summary()).toMatchObject({
      gitEvidenceAcceptances: 1,
      ledgerDigest: evidenceLedgerDigest,
    });
  });

  it("accepts the completed snapshot of an earlier execution after a later execution", async () => {
    const target = await paths();
    const ledger = await openQualityLedger(target);
    const outputBytes = Buffer.from('{"slots":{}}', "utf8");
    const outputDigest = bytesDigest(outputBytes);
    await ledger.claimExecution({
      executionId: "copy-terra-historical",
      planDigest: qualityExecutionPlanDigest,
    });
    await claimAndSettle(ledger, {
      executionId: "copy-terra-historical",
      wireNumber: 1,
      outputDigest,
    });
    await ledger.completeExecution({
      executionId: "copy-terra-historical",
      outputDigest,
    });
    const historicalCandidate = await ledger.completedExecutionSnapshot(
      "copy-terra-historical",
      qualityExecutionPlanDigest,
    );

    await ledger.claimExecution({
      executionId: "copy-sol-later",
      planDigest: qualityExecutionPlanDigest,
    });
    await claimAndSettle(ledger, {
      executionId: "copy-sol-later",
      wireNumber: 1,
      alias: "gpt-5.6-sol",
    });
    await ledger.completeExecution({
      executionId: "copy-sol-later",
      outputDigest: digest("9"),
    });
    const laterTail = (await ledger.summary()).ledgerDigest;
    expect(historicalCandidate).toMatchObject({
      executionId: "copy-terra-historical",
      planDigest: qualityExecutionPlanDigest,
      outputDigest,
      alias: "gpt-5.6-terra",
      protocol: "openai_responses",
      completionSequence: expect.any(Number),
      ledgerDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      knownSettlementDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(historicalCandidate.ledgerDigest).not.toBe(laterTail);

    const acceptance = {
      acceptanceId: "copy-git-acceptance-historical",
      artifactDigest: digest("d"),
      artifactCommit: "1".repeat(40),
      mergeCommit: "2".repeat(40),
      pullRequestNumber: 403,
      acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
      evidenceKind: "quality_matrix",
      candidateReceiptDigest: digest("e"),
      executionId: "copy-terra-historical",
      planDigest: qualityExecutionPlanDigest,
      outputDigest,
      candidateLedgerDigest: historicalCandidate.ledgerDigest,
      fixedSourceCommit: qualitySharedCampaignBinding.fixedSourceCommit,
      sourceBundleDigest: qualitySharedCampaignBinding.sourceBundleDigest,
      manifestDigest: qualitySharedCampaignBinding.manifestDigest,
      admissionDigest: qualitySharedCampaignBinding.admissionDigest,
      compiledRuntimeDigest: qualitySharedCampaignBinding.compiledRuntimeDigest,
      compiledBindingDigest: qualitySharedCampaignBinding.compiledBindingDigest,
      settlementObserverDigest:
        qualitySharedCampaignBinding.settlementObserverDigest,
      knownSettlementDigest: historicalCandidate.knownSettlementDigest,
      alias: "gpt-5.6-terra",
      protocol: "openai_responses",
      reasoning: "medium",
      completionSequence: historicalCandidate.completionSequence,
      fixtureId: "copy-factual-claims",
      repeatIndex: 1,
      outputBytesDigest: outputDigest,
      outputByteLength: outputBytes.byteLength,
      outputBytes,
    } as const;

    const acceptedDigest =
      await ledger.consumeGitAcceptedOutputReplay(acceptance);
    expect(acceptedDigest).toMatch(/^[0-9a-f]{64}$/u);
    await expect(
      ledger.consumeGitAcceptedOutputReplay(acceptance),
    ).resolves.toBe(acceptedDigest);
    await ledger.freezeExecution(
      "copy-quality-after-acceptance",
      "later_failure",
    );
    await expect(
      ledger.consumeGitAcceptedOutputReplay(acceptance),
    ).resolves.toBe(acceptedDigest);
    await expect(
      ledger.consumeGitAcceptedOutputReplay({
        ...acceptance,
        fixtureId: "copy-brand-voice-en",
      }),
    ).rejects.toThrow("REAL_MODEL_GIT_OUTPUT_REPLAY_ALREADY_CONSUMED");
    expect(await ledger.summary()).toMatchObject({
      gitAcceptedOutputReplays: 1,
    });
    expect(await readFile(target.ledgerPath, "utf8")).not.toContain(
      '"outputBytes":',
    );
  });

  it("rejects output replay binding drift before appending", async () => {
    const ledger = await openQualityLedger(await paths());
    const outputBytes = Buffer.from('{"slots":{"hero":{}}}', "utf8");
    const outputDigest = bytesDigest(outputBytes);
    await ledger.claimExecution({
      executionId: "copy-quality-drift",
      planDigest: qualityExecutionPlanDigest,
    });
    await claimAndSettle(ledger, {
      executionId: "copy-quality-drift",
      wireNumber: 1,
      outputDigest,
    });
    await ledger.completeExecution({
      executionId: "copy-quality-drift",
      outputDigest,
    });
    const snapshot = await ledger.completedExecutionSnapshot(
      "copy-quality-drift",
      qualityExecutionPlanDigest,
    );
    const acceptance = {
      acceptanceId: "copy-git-output-replay-drift",
      artifactDigest: digest("d"),
      artifactCommit: "1".repeat(40),
      mergeCommit: "2".repeat(40),
      pullRequestNumber: 404,
      acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
      evidenceKind: "quality_matrix",
      candidateReceiptDigest: digest("e"),
      executionId: "copy-quality-drift",
      planDigest: qualityExecutionPlanDigest,
      outputDigest,
      candidateLedgerDigest: snapshot.ledgerDigest,
      fixedSourceCommit: qualitySharedCampaignBinding.fixedSourceCommit,
      sourceBundleDigest: qualitySharedCampaignBinding.sourceBundleDigest,
      manifestDigest: qualitySharedCampaignBinding.manifestDigest,
      admissionDigest: qualitySharedCampaignBinding.admissionDigest,
      compiledRuntimeDigest: qualitySharedCampaignBinding.compiledRuntimeDigest,
      compiledBindingDigest: qualitySharedCampaignBinding.compiledBindingDigest,
      settlementObserverDigest:
        qualitySharedCampaignBinding.settlementObserverDigest,
      knownSettlementDigest: snapshot.knownSettlementDigest,
      alias: "gpt-5.6-terra",
      protocol: "openai_responses",
      reasoning: "medium",
      completionSequence: snapshot.completionSequence,
      fixtureId: "copy-factual-claims",
      repeatIndex: 0,
      outputBytesDigest: outputDigest,
      outputByteLength: outputBytes.byteLength,
      outputBytes,
    } as const;

    await expect(
      ledger.consumeGitAcceptedOutputReplay({
        ...acceptance,
        outputBytes: Buffer.from('{"slots":{"other":{}}}', "utf8"),
      }),
    ).rejects.toThrow("REAL_MODEL_GIT_OUTPUT_REPLAY_BINDING_MISMATCH");
    await expect(
      ledger.consumeGitAcceptedOutputReplay({
        ...acceptance,
        outputByteLength: outputBytes.byteLength + 1,
      }),
    ).rejects.toThrow("REAL_MODEL_GIT_OUTPUT_REPLAY_BINDING_MISMATCH");
    for (const outputByteLength of [0, 65_537, 1.5]) {
      await expect(
        ledger.consumeGitAcceptedOutputReplay({
          ...acceptance,
          outputByteLength,
        }),
      ).rejects.toThrow("REAL_MODEL_GIT_OUTPUT_REPLAY_INVALID");
    }
    await expect(
      ledger.consumeGitAcceptedOutputReplay({
        ...acceptance,
        rawProviderText: "must never enter the ledger",
      } as unknown as Parameters<
        typeof ledger.consumeGitAcceptedOutputReplay
      >[0]),
    ).rejects.toThrow("REAL_MODEL_GIT_OUTPUT_REPLAY_INVALID");

    for (const drifted of [
      { ...acceptance, planDigest: digest("0") },
      { ...acceptance, outputDigest: digest("0") },
      { ...acceptance, candidateLedgerDigest: digest("0") },
      { ...acceptance, knownSettlementDigest: digest("0") },
      { ...acceptance, fixedSourceCommit: "4".repeat(40) },
      { ...acceptance, sourceBundleDigest: digest("0") },
      { ...acceptance, manifestDigest: digest("0") },
      { ...acceptance, admissionDigest: digest("0") },
      { ...acceptance, compiledRuntimeDigest: digest("0") },
      { ...acceptance, compiledBindingDigest: digest("0") },
      { ...acceptance, settlementObserverDigest: digest("0") },
      { ...acceptance, alias: "gpt-5.6-sol" },
      { ...acceptance, protocol: "anthropic_messages" as const },
      { ...acceptance, completionSequence: snapshot.completionSequence + 1 },
      { ...acceptance, outputBytesDigest: digest("0") },
    ]) {
      await expect(
        ledger.consumeGitAcceptedOutputReplay(drifted),
      ).rejects.toThrow("REAL_MODEL_GIT_OUTPUT_REPLAY_BINDING_MISMATCH");
    }
    expect(await ledger.summary()).toMatchObject({
      gitAcceptedOutputReplays: 0,
    });
  });

  it("requires either a singular or shared authorization binding for output replay", async () => {
    const ledger = await openLedger(await paths());
    const executionId = "copy-quality-unbound";
    const outputBytes = Buffer.from('{"slots":{"unbound":{}}}', "utf8");
    const outputDigest = bytesDigest(outputBytes);
    await ledger.claimExecution({
      executionId,
      planDigest: campaign.planDigest,
    });
    await claimAndSettle(ledger, {
      executionId,
      wireNumber: 1,
      outputDigest,
    });
    await ledger.completeExecution({ executionId, outputDigest });
    const snapshot = await ledger.completedExecutionSnapshot(
      executionId,
      campaign.planDigest,
    );

    await expect(
      ledger.consumeGitAcceptedOutputReplay({
        acceptanceId: "copy-git-output-replay-unbound",
        artifactDigest: digest("d"),
        artifactCommit: "1".repeat(40),
        mergeCommit: "2".repeat(40),
        pullRequestNumber: 410,
        acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
        evidenceKind: "quality_matrix",
        candidateReceiptDigest: digest("e"),
        executionId,
        planDigest: campaign.planDigest,
        outputDigest,
        candidateLedgerDigest: snapshot.ledgerDigest,
        fixedSourceCommit: "3".repeat(40),
        sourceBundleDigest: digest("4"),
        manifestDigest: authorization.manifestDigest,
        admissionDigest: digest("5"),
        compiledRuntimeDigest: digest("6"),
        compiledBindingDigest: digest("7"),
        settlementObserverDigest: authorization.settlementObserverDigest,
        knownSettlementDigest: snapshot.knownSettlementDigest,
        alias: "gpt-5.6-terra",
        protocol: "openai_responses",
        reasoning: "medium",
        completionSequence: snapshot.completionSequence,
        fixtureId: "copy-factual-claims",
        repeatIndex: 0,
        outputBytesDigest: outputDigest,
        outputByteLength: outputBytes.byteLength,
        outputBytes,
      }),
    ).rejects.toThrow("REAL_MODEL_GIT_OUTPUT_REPLAY_BINDING_MISMATCH");
  });

  it("rejects every replay provenance field that drifts from the authorization binding", async () => {
    const target = await paths();
    const executionId = "copy-quality-provenance-bound";
    const fixedSourceCommit = "b".repeat(40);
    const sourceBundleDigest = digest("c");
    const compiledRuntimeDigest = digest("0");
    const compiledBindingDigest = digest("a");
    const boundAuthorization = {
      ...authorization,
      evidenceBinding: {
        schemaVersion:
          "real-model-execution-evidence-binding/2026-08-07-v1" as const,
        executionId,
        childSlotId: "copy-quality-provenance-child",
        alias: "gpt-5.6-terra",
        protocol: "openai_responses" as const,
        reasoning: "medium" as const,
        fixtureId: "copy-factual-claims",
        executionPlanDigest: campaign.planDigest,
        inputDigest: digest("7"),
        contextDigest: digest("8"),
        promptDigest: digest("9"),
        fixedSourceCommit,
        sourceBundleDigest,
        manifestDigest: authorization.manifestDigest,
        admissionDigest: digest("d"),
        globalAuthorizationDigest: digest("e"),
        childAuthorizationDigest: digest("f"),
        compiledRuntimeDigest,
        compiledBindingDigest,
      },
    };
    const ledger = await RealModelExecutionLedger.open({
      ledgerPath: target.ledgerPath,
      authorizationClaimPath: target.authorizationClaimPath,
      campaign,
      authorization: boundAuthorization,
    });
    const outputBytes = Buffer.from('{"slots":{"bound":{}}}', "utf8");
    const outputDigest = bytesDigest(outputBytes);
    await ledger.claimExecution({
      executionId,
      planDigest: campaign.planDigest,
    });
    await claimAndSettle(ledger, {
      executionId,
      wireNumber: 1,
      outputDigest,
    });
    await ledger.completeExecution({ executionId, outputDigest });
    const snapshot = await ledger.completedExecutionSnapshot(
      executionId,
      campaign.planDigest,
    );
    const acceptance = {
      acceptanceId: "copy-git-provenance-bound",
      artifactDigest: digest("1"),
      artifactCommit: "1".repeat(40),
      mergeCommit: "2".repeat(40),
      pullRequestNumber: 409,
      acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
      evidenceKind: "quality_matrix",
      candidateReceiptDigest: digest("2"),
      executionId,
      planDigest: campaign.planDigest,
      outputDigest,
      candidateLedgerDigest: snapshot.ledgerDigest,
      fixedSourceCommit,
      sourceBundleDigest,
      manifestDigest: authorization.manifestDigest,
      admissionDigest: boundAuthorization.evidenceBinding.admissionDigest,
      compiledRuntimeDigest,
      compiledBindingDigest,
      settlementObserverDigest: authorization.settlementObserverDigest,
      knownSettlementDigest: snapshot.knownSettlementDigest,
      alias: "gpt-5.6-terra",
      protocol: "openai_responses",
      reasoning: "medium",
      completionSequence: snapshot.completionSequence,
      fixtureId: "copy-factual-claims",
      repeatIndex: 0,
      outputBytesDigest: outputDigest,
      outputByteLength: outputBytes.byteLength,
      outputBytes,
    } as const;

    for (const drifted of [
      { ...acceptance, fixedSourceCommit: "c".repeat(40) },
      { ...acceptance, sourceBundleDigest: digest("1") },
      { ...acceptance, manifestDigest: digest("1") },
      { ...acceptance, admissionDigest: digest("1") },
      { ...acceptance, compiledRuntimeDigest: digest("1") },
      { ...acceptance, compiledBindingDigest: digest("1") },
      { ...acceptance, settlementObserverDigest: digest("1") },
    ]) {
      await expect(
        ledger.consumeGitAcceptedOutputReplay(drifted),
      ).rejects.toThrow("REAL_MODEL_GIT_OUTPUT_REPLAY_BINDING_MISMATCH");
    }
    expect(await ledger.summary()).toMatchObject({
      gitAcceptedOutputReplays: 0,
    });
    await expect(
      ledger.consumeGitAcceptedOutputReplay(acceptance),
    ).resolves.toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects a first output replay acceptance after the campaign freezes", async () => {
    const ledger = await openQualityLedger(await paths());
    const outputBytes = Buffer.from('{"slots":{"cta":{}}}', "utf8");
    const outputDigest = bytesDigest(outputBytes);
    await ledger.claimExecution({
      executionId: "copy-quality-before-freeze",
      planDigest: qualityExecutionPlanDigest,
    });
    await claimAndSettle(ledger, {
      executionId: "copy-quality-before-freeze",
      wireNumber: 1,
      outputDigest,
    });
    await ledger.completeExecution({
      executionId: "copy-quality-before-freeze",
      outputDigest,
    });
    const snapshot = await ledger.completedExecutionSnapshot(
      "copy-quality-before-freeze",
      qualityExecutionPlanDigest,
    );
    await ledger.freezeExecution("copy-quality-later", "later_failure");

    await expect(
      ledger.consumeGitAcceptedOutputReplay({
        acceptanceId: "copy-git-output-replay-frozen",
        artifactDigest: digest("d"),
        artifactCommit: "1".repeat(40),
        mergeCommit: "2".repeat(40),
        pullRequestNumber: 405,
        acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
        evidenceKind: "quality_matrix",
        candidateReceiptDigest: digest("e"),
        executionId: "copy-quality-before-freeze",
        planDigest: qualityExecutionPlanDigest,
        outputDigest,
        candidateLedgerDigest: snapshot.ledgerDigest,
        fixedSourceCommit: qualitySharedCampaignBinding.fixedSourceCommit,
        sourceBundleDigest: qualitySharedCampaignBinding.sourceBundleDigest,
        manifestDigest: qualitySharedCampaignBinding.manifestDigest,
        admissionDigest: qualitySharedCampaignBinding.admissionDigest,
        compiledRuntimeDigest:
          qualitySharedCampaignBinding.compiledRuntimeDigest,
        compiledBindingDigest:
          qualitySharedCampaignBinding.compiledBindingDigest,
        settlementObserverDigest:
          qualitySharedCampaignBinding.settlementObserverDigest,
        knownSettlementDigest: snapshot.knownSettlementDigest,
        alias: "gpt-5.6-terra",
        protocol: "openai_responses",
        reasoning: "medium",
        completionSequence: snapshot.completionSequence,
        fixtureId: "copy-factual-claims",
        repeatIndex: 0,
        outputBytesDigest: outputDigest,
        outputByteLength: outputBytes.byteLength,
        outputBytes,
      }),
    ).rejects.toThrow("REAL_MODEL_EXECUTION_CAMPAIGN_FROZEN");
  });

  it("rejects shared Git acceptance identities across evidence event kinds", async () => {
    const settled = async (suffix: string) => {
      const ledger = await openQualityLedger(await paths());
      const outputBytes = Buffer.from(`{"slots":{"${suffix}":{}}}`, "utf8");
      const outputDigest = bytesDigest(outputBytes);
      const executionId = `copy-quality-cross-kind-${suffix}`;
      await ledger.claimExecution({
        executionId,
        planDigest: qualityExecutionPlanDigest,
      });
      await claimAndSettle(ledger, {
        executionId,
        wireNumber: 1,
        outputDigest,
      });
      await ledger.completeExecution({ executionId, outputDigest });
      const snapshot = await ledger.completedExecutionSnapshot(
        executionId,
        qualityExecutionPlanDigest,
      );
      const shared = {
        acceptanceId: `copy-git-cross-kind-${suffix}`,
        artifactDigest: bytesDigest(Buffer.from(`artifact-${suffix}`)),
        artifactCommit: "1".repeat(40),
        mergeCommit: "2".repeat(40),
        pullRequestNumber: suffix === "old-first" ? 406 : 407,
        acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
        candidateReceiptDigest: digest("e"),
        executionId,
        planDigest: qualityExecutionPlanDigest,
        outputDigest,
        candidateLedgerDigest: snapshot.ledgerDigest,
        fixedSourceCommit: qualitySharedCampaignBinding.fixedSourceCommit,
        sourceBundleDigest: qualitySharedCampaignBinding.sourceBundleDigest,
        manifestDigest: qualitySharedCampaignBinding.manifestDigest,
        compiledRuntimeDigest:
          qualitySharedCampaignBinding.compiledRuntimeDigest,
        compiledBindingDigest:
          qualitySharedCampaignBinding.compiledBindingDigest,
        settlementObserverDigest:
          qualitySharedCampaignBinding.settlementObserverDigest,
        knownSettlementDigest: snapshot.knownSettlementDigest,
        alias: "gpt-5.6-terra",
        protocol: "openai_responses" as const,
        reasoning: "medium" as const,
      };
      return {
        ledger,
        oldAcceptance: {
          ...shared,
          evidenceKind: "capability_pilot",
        },
        outputReplay: {
          ...shared,
          evidenceKind: "quality_matrix",
          admissionDigest: qualitySharedCampaignBinding.admissionDigest,
          completionSequence: snapshot.completionSequence,
          fixtureId: "copy-factual-claims",
          repeatIndex: 0 as const,
          outputBytesDigest: outputDigest,
          outputByteLength: outputBytes.byteLength,
          outputBytes,
        },
      };
    };

    const oldFirst = await settled("old-first");
    await oldFirst.ledger.consumeGitEvidenceAcceptance(oldFirst.oldAcceptance);
    await expect(
      oldFirst.ledger.consumeGitAcceptedOutputReplay(oldFirst.outputReplay),
    ).rejects.toThrow("REAL_MODEL_GIT_OUTPUT_REPLAY_ALREADY_CONSUMED");

    const newFirst = await settled("new-first");
    await newFirst.ledger.consumeGitAcceptedOutputReplay(newFirst.outputReplay);
    await expect(
      newFirst.ledger.consumeGitEvidenceAcceptance(newFirst.oldAcceptance),
    ).rejects.toThrow("REAL_MODEL_GIT_ACCEPTANCE_ALREADY_CONSUMED");
  });

  it("allows a normalized reported model while binding requested and resolved alias", async () => {
    const ledger = await openQualityLedger(await paths());
    const outputBytes = Buffer.from('{"slots":{"normalized":{}}}', "utf8");
    const outputDigest = bytesDigest(outputBytes);
    await ledger.claimExecution({
      executionId: "copy-quality-normalized-model",
      planDigest: qualityExecutionPlanDigest,
    });
    await claimAndSettle(ledger, {
      executionId: "copy-quality-normalized-model",
      wireNumber: 1,
      outputDigest,
      reportedModel: "gpt-5.6-terra-2026-08-01",
    });
    await ledger.completeExecution({
      executionId: "copy-quality-normalized-model",
      outputDigest,
    });
    const snapshot = await ledger.completedExecutionSnapshot(
      "copy-quality-normalized-model",
      qualityExecutionPlanDigest,
    );

    await expect(
      ledger.consumeGitAcceptedOutputReplay({
        acceptanceId: "copy-git-normalized-model",
        artifactDigest: digest("d"),
        artifactCommit: "1".repeat(40),
        mergeCommit: "2".repeat(40),
        pullRequestNumber: 408,
        acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
        evidenceKind: "quality_matrix",
        candidateReceiptDigest: digest("e"),
        executionId: "copy-quality-normalized-model",
        planDigest: qualityExecutionPlanDigest,
        outputDigest,
        candidateLedgerDigest: snapshot.ledgerDigest,
        fixedSourceCommit: qualitySharedCampaignBinding.fixedSourceCommit,
        sourceBundleDigest: qualitySharedCampaignBinding.sourceBundleDigest,
        manifestDigest: qualitySharedCampaignBinding.manifestDigest,
        admissionDigest: qualitySharedCampaignBinding.admissionDigest,
        compiledRuntimeDigest:
          qualitySharedCampaignBinding.compiledRuntimeDigest,
        compiledBindingDigest:
          qualitySharedCampaignBinding.compiledBindingDigest,
        settlementObserverDigest:
          qualitySharedCampaignBinding.settlementObserverDigest,
        knownSettlementDigest: snapshot.knownSettlementDigest,
        alias: "gpt-5.6-terra",
        protocol: "openai_responses",
        reasoning: "medium",
        completionSequence: snapshot.completionSequence,
        fixtureId: "copy-factual-claims",
        repeatIndex: 0,
        outputBytesDigest: outputDigest,
        outputByteLength: outputBytes.byteLength,
        outputBytes,
      }),
    ).resolves.toMatch(/^[0-9a-f]{64}$/u);
  });

  it("binds sanitized known-settlement evidence to the plan, wire chain, and completion", async () => {
    const settle = async (input: {
      requestDigest: string;
      receiptDigest: string;
    }): Promise<string> => {
      const ledger = await openLedger(await paths());
      await ledger.claimExecution({
        executionId: "copy-terra",
        planDigest: campaign.planDigest,
      });
      await ledger.claimWire({
        executionId: "copy-terra",
        wireId: "copy-terra:1",
        requestDigest: input.requestDigest,
      });
      await ledger.observeWire({
        executionId: "copy-terra",
        wireId: "copy-terra:1",
        settlement: "known",
        requestId: "req-copy-terra-1",
        requestedAlias: "gpt-5.6-terra",
        resolvedAlias: "gpt-5.6-terra",
        reportedModel: "gpt-5.6-terra",
        protocol: "openai_responses",
        usage: { inputTokens: 120, outputTokens: 30 },
        outputDigest: digest("9"),
        receiptDigest: input.receiptDigest,
        quota: 1_250,
      });
      await ledger.completeExecution({
        executionId: "copy-terra",
        outputDigest: digest("9"),
      });
      return ledger.executionKnownSettlementDigest("copy-terra");
    };

    const baseline = await settle({
      requestDigest: digest("7"),
      receiptDigest: digest("b"),
    });
    const [requestDrift, receiptDrift] = await Promise.all([
      settle({ requestDigest: digest("8"), receiptDigest: digest("b") }),
      settle({ requestDigest: digest("7"), receiptDigest: digest("c") }),
    ]);
    expect(requestDrift).not.toBe(baseline);
    expect(receiptDrift).not.toBe(baseline);

    const ledger = await openLedger(await paths());
    await ledger.claimExecution({
      executionId: "copy-auditable",
      planDigest: campaign.planDigest,
    });
    await claimAndSettle(ledger, {
      executionId: "copy-auditable",
      wireNumber: 1,
    });
    await ledger.completeExecution({
      executionId: "copy-auditable",
      outputDigest: digest("9"),
    });
    const evidence = await ledger.executionKnownSettlementEvidence(
      "copy-auditable",
      campaign.planDigest,
    );
    expect(evidence).toMatchObject({
      schemaVersion: "real-model-known-settlement-evidence/2026-08-07-v1",
      executionClaim: { planDigest: campaign.planDigest },
      wires: [
        {
          wireIndex: 1,
          claim: { requestDigest: digest("7") },
          observation: {
            settlement: "known",
            requestIdDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
            resolvedAlias: "gpt-5.6-terra",
            outputDigest: digest("9"),
          },
        },
      ],
      completion: { outputDigest: digest("9") },
      digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(JSON.stringify(evidence)).not.toContain("req-copy-auditable-1");
    await expect(
      ledger.executionKnownSettlementEvidence("copy-auditable", digest("0")),
    ).rejects.toThrow("REAL_MODEL_GIT_ACCEPTANCE_BINDING_MISMATCH");
  });

  it("rejects Git acceptance replay, cross-candidate reuse, and settlement drift", async () => {
    const ledger = await openLedger(await paths());
    await ledger.claimExecution({
      executionId: "copy-sonnet",
      planDigest: campaign.planDigest,
    });
    await claimAndSettle(ledger, {
      executionId: "copy-sonnet",
      wireNumber: 1,
      alias: "claude-sonnet-5",
    });
    await ledger.completeExecution({
      executionId: "copy-sonnet",
      outputDigest: digest("9"),
    });
    const candidate = await ledger.summary();
    const acceptance = {
      acceptanceId: "copy-git-acceptance-002",
      artifactDigest: digest("d"),
      artifactCommit: "1".repeat(40),
      mergeCommit: "2".repeat(40),
      pullRequestNumber: 402,
      acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
      evidenceKind: "capability_pilot",
      candidateReceiptDigest: digest("e"),
      executionId: "copy-sonnet",
      planDigest: campaign.planDigest,
      outputDigest: digest("9"),
      candidateLedgerDigest: candidate.ledgerDigest,
      fixedSourceCommit: "3".repeat(40),
      sourceBundleDigest: digest("4"),
      manifestDigest: digest("5"),
      compiledRuntimeDigest: digest("6"),
      compiledBindingDigest: digest("7"),
      settlementObserverDigest: digest("8"),
      knownSettlementDigest:
        await ledger.executionKnownSettlementDigest("copy-sonnet"),
      alias: "claude-sonnet-5",
      protocol: "anthropic_messages",
      reasoning: "medium",
    } as const;

    await expect(
      ledger.consumeGitEvidenceAcceptance({
        ...acceptance,
        knownSettlementDigest: digest("0"),
      }),
    ).rejects.toThrow("REAL_MODEL_GIT_ACCEPTANCE_BINDING_MISMATCH");
    expect(await ledger.summary()).toMatchObject({ gitEvidenceAcceptances: 0 });

    const acceptedDigest =
      await ledger.consumeGitEvidenceAcceptance(acceptance);
    await expect(
      ledger.consumeGitEvidenceAcceptance({
        ...acceptance,
        artifactDigest: digest("f"),
      }),
    ).rejects.toThrow("REAL_MODEL_GIT_ACCEPTANCE_ALREADY_CONSUMED");
    await expect(
      ledger.consumeGitEvidenceAcceptance({
        ...acceptance,
        acceptanceId: "copy-git-acceptance-cross-candidate",
        candidateReceiptDigest: digest("f"),
      }),
    ).rejects.toThrow("REAL_MODEL_GIT_ACCEPTANCE_ALREADY_CONSUMED");
    expect(await ledger.summary()).toMatchObject({
      gitEvidenceAcceptances: 1,
      ledgerDigest: acceptedDigest,
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
