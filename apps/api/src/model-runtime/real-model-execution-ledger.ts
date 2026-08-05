import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { canonicalDigest } from "./context-engine";
import type { ModelExecutionCampaignContract } from "./model-execution-ledger";
import {
  AUTHORIZATION_CLAIM_SCHEMA_VERSION,
  assertSafeAbsentOrFile,
  buildEnvelopes,
  claimDigest,
  eventCount,
  fail,
  frozen,
  openedEvent,
  parseClaims,
  parseLedger,
  readSecure,
  safeInteger,
  safeFileExists,
  validateAuthorization,
  validateCampaign,
  validateDigest,
  validateIdentifier,
  writeExclusive,
  type RealLedgerEnvelope,
  type RealLedgerEvent,
  type RealModelExecutionAuthorization,
  type RealModelExecutionLedgerSummary,
  type OperatorEvidenceAuthorizationInput,
} from "./real-model-execution-ledger-storage";
import type { ModelProtocol } from "./types";

export {
  REAL_MODEL_EXECUTION_LEDGER_SCHEMA_VERSION,
  type RealModelExecutionAuthorization,
  type RealModelExecutionLedgerSummary,
  type RealWireSettlementProof,
} from "./real-model-execution-ledger-storage";

const TRUSTED_REAL_MODEL_EXECUTION_LEDGERS = new WeakSet<object>();

export function isTrustedRealModelExecutionLedger(
  value: unknown,
): value is RealModelExecutionLedger {
  return (
    typeof value === "object" &&
    value !== null &&
    TRUSTED_REAL_MODEL_EXECUTION_LEDGERS.has(value)
  );
}

export class RealModelExecutionLedger {
  readonly evidenceClass = "gateway_settlement_claim_only" as const;
  private readonly lockPath: string;

  private constructor(
    readonly ledgerPath: string,
    readonly authorizationClaimPath: string,
    readonly campaign: ModelExecutionCampaignContract,
    readonly authorization: RealModelExecutionAuthorization,
    private readonly ledgerDevice: string,
    private readonly ledgerInode: string,
    private readonly claimDevice: string,
    private readonly claimInode: string,
  ) {
    this.lockPath = `${ledgerPath}.lock`;
  }

  static async open(input: {
    ledgerPath: string;
    authorizationClaimPath: string;
    campaign: ModelExecutionCampaignContract;
    authorization: RealModelExecutionAuthorization;
  }): Promise<RealModelExecutionLedger> {
    if (
      !isAbsolute(input.ledgerPath) ||
      !isAbsolute(input.authorizationClaimPath) ||
      input.ledgerPath === input.authorizationClaimPath
    ) {
      fail("REAL_MODEL_EXECUTION_LEDGER_UNSAFE");
    }
    validateCampaign(input.campaign);
    validateAuthorization(input.authorization, input.campaign);
    await assertSafeAbsentOrFile(input.ledgerPath);
    await assertSafeAbsentOrFile(input.authorizationClaimPath);
    const [ledgerExists, claimExists] = await Promise.all([
      safeFileExists(input.ledgerPath),
      safeFileExists(input.authorizationClaimPath),
    ]);
    if (ledgerExists !== claimExists) {
      fail("REAL_MODEL_LEDGER_IDENTITY_MISMATCH");
    }

    const lockPath = `${input.ledgerPath}.lock`;
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch {
      return fail("REAL_MODEL_EXECUTION_LEDGER_BUSY");
    }
    try {
      await lock.writeFile(`${process.pid}\n`, "utf8");
      await lock.sync();
      let ledgerIdentity: Awaited<ReturnType<typeof readSecure>>;
      let events: readonly RealLedgerEnvelope[];
      try {
        ledgerIdentity = await readSecure(input.ledgerPath);
        events = parseLedger(ledgerIdentity.raw);
      } catch (error) {
        if ((error as Error).message !== "REAL_MODEL_EXECUTION_LEDGER_UNSAFE") {
          throw error;
        }
        const opened = buildEnvelopes(
          [],
          [
            {
              kind: "campaign_opened",
              campaign: Object.freeze({ ...input.campaign }),
              authorization: Object.freeze({ ...input.authorization }),
              evidenceClass: "gateway_settlement_claim_only",
            },
          ],
        );
        await writeExclusive(
          input.ledgerPath,
          `${JSON.stringify(opened[0])}\n`,
        );
        ledgerIdentity = await readSecure(input.ledgerPath);
        events = parseLedger(ledgerIdentity.raw);
      }
      const opened = openedEvent(events);
      if (
        canonicalDigest(opened.campaign) !== canonicalDigest(input.campaign)
      ) {
        fail("REAL_MODEL_LEDGER_IDENTITY_MISMATCH");
      }
      if (
        canonicalDigest(opened.authorization) !==
        canonicalDigest(input.authorization)
      ) {
        if (
          opened.authorization.reservationId !==
          input.authorization.reservationId
        ) {
          fail("REAL_MODEL_RESERVATION_MISMATCH");
        }
        fail("REAL_MODEL_AUTHORIZATION_MISMATCH");
      }
      const ledgerDigest = events.at(-1)?.digest;
      if (!ledgerDigest) fail("REAL_MODEL_EXECUTION_LEDGER_INVALID");
      let claimIdentity: Awaited<ReturnType<typeof readSecure>> | undefined;
      try {
        claimIdentity = await readSecure(input.authorizationClaimPath);
      } catch (error) {
        if ((error as Error).message !== "REAL_MODEL_EXECUTION_LEDGER_UNSAFE") {
          throw error;
        }
      }
      if (claimIdentity == null) {
        const material = {
          schemaVersion: AUTHORIZATION_CLAIM_SCHEMA_VERSION,
          authorizationId: input.authorization.authorizationId,
          reservationId: input.authorization.reservationId,
          authorizationDigest: canonicalDigest(input.authorization),
          campaignDigest: canonicalDigest(input.campaign),
          ledgerPath: input.ledgerPath,
          ledgerDevice: ledgerIdentity.device,
          ledgerInode: ledgerIdentity.inode,
          ledgerSize: ledgerIdentity.size,
          ledgerDigest,
          previousClaimDigest: null,
        } as const;
        const claim = { ...material, digest: claimDigest(material) };
        await writeExclusive(
          input.authorizationClaimPath,
          `${JSON.stringify(claim)}\n`,
        );
        claimIdentity = await readSecure(input.authorizationClaimPath);
      } else {
        const latest = parseClaims(claimIdentity.raw).at(-1);
        if (latest == null || latest.ledgerPath !== input.ledgerPath) {
          fail("REAL_MODEL_AUTHORIZATION_ALREADY_CLAIMED");
        }
        if (
          latest.authorizationDigest !== canonicalDigest(input.authorization)
        ) {
          if (latest.reservationId !== undefined) {
            fail("REAL_MODEL_RESERVATION_MISMATCH");
          }
          fail("REAL_MODEL_AUTHORIZATION_MISMATCH");
        }
        if (
          latest.campaignDigest !== canonicalDigest(input.campaign) ||
          latest.ledgerDevice !== ledgerIdentity.device ||
          latest.ledgerInode !== ledgerIdentity.inode
        ) {
          fail("REAL_MODEL_LEDGER_IDENTITY_MISMATCH");
        }
      }
      if (claimIdentity == null) {
        fail("REAL_MODEL_AUTHORIZATION_CLAIM_INVALID");
      }
      const ledger = new RealModelExecutionLedger(
        input.ledgerPath,
        input.authorizationClaimPath,
        Object.freeze({ ...input.campaign }),
        Object.freeze({ ...input.authorization }),
        ledgerIdentity.device,
        ledgerIdentity.inode,
        claimIdentity.device,
        claimIdentity.inode,
      );
      TRUSTED_REAL_MODEL_EXECUTION_LEDGERS.add(ledger);
      Object.freeze(ledger);
      return ledger;
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async mutate(
    buildEvents: (
      events: readonly RealLedgerEnvelope[],
    ) => readonly RealLedgerEvent[],
  ): Promise<string | null> {
    let lock;
    try {
      lock = await open(this.lockPath, "wx", 0o600);
    } catch {
      return fail("REAL_MODEL_EXECUTION_LEDGER_BUSY");
    }
    try {
      await lock.writeFile(`${process.pid}\n`, "utf8");
      await lock.sync();
      const ledgerIdentity = await readSecure(this.ledgerPath);
      if (
        ledgerIdentity.device !== this.ledgerDevice ||
        ledgerIdentity.inode !== this.ledgerInode
      ) {
        fail("REAL_MODEL_EXECUTION_LEDGER_REPLACED");
      }
      const existing = parseLedger(ledgerIdentity.raw);
      const claimIdentity = await readSecure(this.authorizationClaimPath);
      if (
        claimIdentity.device !== this.claimDevice ||
        claimIdentity.inode !== this.claimInode
      ) {
        fail("REAL_MODEL_AUTHORIZATION_CLAIM_REPLACED");
      }
      const latestClaim = parseClaims(claimIdentity.raw).at(-1);
      if (
        latestClaim == null ||
        latestClaim.authorizationDigest !==
          canonicalDigest(this.authorization) ||
        latestClaim.campaignDigest !== canonicalDigest(this.campaign) ||
        latestClaim.ledgerPath !== this.ledgerPath ||
        latestClaim.ledgerDevice !== this.ledgerDevice ||
        latestClaim.ledgerInode !== this.ledgerInode
      ) {
        fail("REAL_MODEL_AUTHORIZATION_CLAIM_MISMATCH");
      }
      const additions = buildEnvelopes(existing, buildEvents(existing));
      if (additions.length === 0) return null;

      let ledgerHandle;
      try {
        ledgerHandle = await open(
          this.ledgerPath,
          constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
        );
      } catch {
        return fail("REAL_MODEL_EXECUTION_LEDGER_UNSAFE");
      }
      try {
        const before = await ledgerHandle.stat();
        if (
          String(before.dev) !== this.ledgerDevice ||
          String(before.ino) !== this.ledgerInode
        ) {
          fail("REAL_MODEL_EXECUTION_LEDGER_REPLACED");
        }
        await ledgerHandle.writeFile(
          `${additions.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
          "utf8",
        );
        await ledgerHandle.sync();
      } finally {
        await ledgerHandle.close();
      }
      return (
        additions.at(-1)?.digest ?? fail("REAL_MODEL_EXECUTION_LEDGER_INVALID")
      );
    } finally {
      await lock.close();
      await unlink(this.lockPath).catch(() => undefined);
    }
  }

  async claimExecution(input: {
    executionId: string;
    planDigest: string;
  }): Promise<void> {
    validateIdentifier(input.executionId, "REAL_MODEL_EXECUTION_ID_INVALID");
    validateDigest(
      input.planDigest,
      "REAL_MODEL_EXECUTION_PLAN_DIGEST_INVALID",
    );
    await this.mutate((events) => {
      if (frozen(events)) fail("REAL_MODEL_EXECUTION_CAMPAIGN_FROZEN");
      if (
        events.some(
          ({ event }) =>
            event.kind === "execution_claimed" &&
            event.executionId === input.executionId,
        )
      ) {
        fail("REAL_MODEL_EXECUTION_ALREADY_CLAIMED");
      }
      if (
        eventCount(events, "execution_claimed") >=
        this.campaign.maximumExecutions
      ) {
        fail("REAL_MODEL_EXECUTION_CAP_EXHAUSTED");
      }
      return [{ kind: "execution_claimed", ...input }];
    });
  }

  async claimWire(input: {
    executionId: string;
    wireId: string;
    requestDigest: string;
  }): Promise<void> {
    validateIdentifier(input.executionId, "REAL_MODEL_EXECUTION_ID_INVALID");
    validateIdentifier(input.wireId, "REAL_MODEL_EXECUTION_WIRE_ID_INVALID");
    validateDigest(
      input.requestDigest,
      "REAL_MODEL_EXECUTION_REQUEST_DIGEST_INVALID",
    );
    await this.mutate((events) => {
      if (frozen(events)) fail("REAL_MODEL_EXECUTION_CAMPAIGN_FROZEN");
      const claimed = events.some(
        ({ event }) =>
          event.kind === "execution_claimed" &&
          event.executionId === input.executionId,
      );
      if (!claimed) fail("REAL_MODEL_EXECUTION_NOT_CLAIMED");
      if (
        events.some(
          ({ event }) =>
            event.kind === "execution_completed" &&
            event.executionId === input.executionId,
        )
      ) {
        fail("REAL_MODEL_EXECUTION_ALREADY_COMPLETED");
      }
      if (
        events.some(
          ({ event }) =>
            event.kind === "wire_claimed" && event.wireId === input.wireId,
        )
      ) {
        fail("REAL_MODEL_EXECUTION_WIRE_ALREADY_CLAIMED");
      }
      if (
        eventCount(events, "wire_claimed") >= this.campaign.maximumWireCalls
      ) {
        fail("REAL_MODEL_EXECUTION_WIRE_CAP_EXHAUSTED");
      }
      const executionWires = events.filter(
        ({ event }) =>
          event.kind === "wire_claimed" &&
          event.executionId === input.executionId,
      );
      if (executionWires.length >= 2) {
        fail("REAL_MODEL_EXECUTION_WIRE_CAP_EXHAUSTED");
      }
      const observed = new Set(
        events.flatMap(({ event }) =>
          event.kind === "wire_observed" ? [event.wireId] : [],
        ),
      );
      if (
        executionWires.some(
          ({ event }) =>
            event.kind === "wire_claimed" && !observed.has(event.wireId),
        )
      ) {
        fail("REAL_MODEL_EXECUTION_WIRE_UNSETTLED");
      }
      if (
        executionWires.length === 1 &&
        !events.some(
          ({ event }) =>
            event.kind === "repair_planned" &&
            event.executionId === input.executionId,
        )
      ) {
        fail("REAL_MODEL_EXECUTION_REPAIR_NOT_PLANNED");
      }
      return [{ kind: "wire_claimed", ...input }];
    });
  }

  async observeWire(
    input:
      | {
          executionId: string;
          wireId: string;
          settlement: "known";
          requestId: string;
          requestedAlias: string;
          resolvedAlias: string;
          reportedModel: string;
          protocol: ModelProtocol;
          usage: { inputTokens: number; outputTokens: number };
          outputDigest: string;
          receiptDigest: string;
          quota: number;
          resolverId?: string;
          channelId?: number;
        }
      | {
          executionId: string;
          wireId: string;
          settlement: "unknown";
          requestId: string | null;
          reason: string;
        },
  ): Promise<void> {
    validateIdentifier(input.executionId, "REAL_MODEL_EXECUTION_ID_INVALID");
    validateIdentifier(input.wireId, "REAL_MODEL_EXECUTION_WIRE_ID_INVALID");
    await this.mutate((events) => {
      if (
        !events.some(
          ({ event }) =>
            event.kind === "wire_claimed" &&
            event.executionId === input.executionId &&
            event.wireId === input.wireId,
        )
      ) {
        fail("REAL_MODEL_EXECUTION_WIRE_NOT_CLAIMED");
      }
      if (
        events.some(
          ({ event }) =>
            event.kind === "wire_observed" && event.wireId === input.wireId,
        )
      ) {
        fail("REAL_MODEL_EXECUTION_WIRE_ALREADY_OBSERVED");
      }
      if (input.settlement === "known") {
        for (const value of [
          input.requestId,
          input.requestedAlias,
          input.resolvedAlias,
          input.reportedModel,
          input.resolverId ?? "request-bound-settlement",
        ]) {
          validateIdentifier(value, "REAL_MODEL_EXECUTION_OBSERVATION_INVALID");
        }
        validateDigest(
          input.outputDigest,
          "REAL_MODEL_EXECUTION_OBSERVATION_INVALID",
        );
        validateDigest(
          input.receiptDigest,
          "REAL_MODEL_EXECUTION_OBSERVATION_INVALID",
        );
        if (
          !safeInteger(input.usage.inputTokens, 0) ||
          !safeInteger(input.usage.outputTokens, 0) ||
          (input.channelId !== undefined && !safeInteger(input.channelId, 1)) ||
          !safeInteger(input.quota, 0)
        ) {
          fail("REAL_MODEL_EXECUTION_OBSERVATION_INVALID");
        }
        return [{ kind: "wire_observed", ...input }];
      }
      const reason = input.reason.trim().slice(0, 160);
      if (!reason) fail("REAL_MODEL_EXECUTION_UNKNOWN_REASON_INVALID");
      return [
        { kind: "wire_observed", ...input, reason },
        { kind: "campaign_frozen", executionId: input.executionId, reason },
      ];
    });
  }

  async planRepair(input: {
    executionId: string;
    wireId: string;
    bindingDigest: string;
    priorOutputDigest: string;
    findingsDigest: string;
  }): Promise<void> {
    validateIdentifier(input.executionId, "REAL_MODEL_EXECUTION_ID_INVALID");
    validateIdentifier(input.wireId, "REAL_MODEL_EXECUTION_WIRE_ID_INVALID");
    for (const value of [
      input.bindingDigest,
      input.priorOutputDigest,
      input.findingsDigest,
    ]) {
      validateDigest(value, "REAL_MODEL_EXECUTION_REPAIR_INVALID");
    }
    await this.mutate((events) => {
      if (frozen(events)) fail("REAL_MODEL_EXECUTION_CAMPAIGN_FROZEN");
      if (
        events.some(
          ({ event }) =>
            event.kind === "execution_completed" &&
            event.executionId === input.executionId,
        )
      ) {
        fail("REAL_MODEL_EXECUTION_ALREADY_COMPLETED");
      }
      const observation = events
        .flatMap(({ event }) =>
          event.kind === "wire_observed" &&
          event.executionId === input.executionId
            ? [event]
            : [],
        )
        .at(-1);
      if (
        observation?.kind !== "wire_observed" ||
        observation.settlement !== "known"
      ) {
        fail("REAL_MODEL_EXECUTION_REPAIR_UNSETTLED");
      }
      if (observation.outputDigest !== input.priorOutputDigest) {
        fail("REAL_MODEL_EXECUTION_REPAIR_INVALID");
      }
      if (
        events.some(
          ({ event }) =>
            event.kind === "repair_planned" &&
            event.executionId === input.executionId,
        )
      ) {
        fail("REAL_MODEL_EXECUTION_REPAIR_CAP_EXHAUSTED");
      }
      return [{ kind: "repair_planned", ...input }];
    });
  }

  async completeExecution(input: {
    executionId: string;
    outputDigest: string;
  }): Promise<void> {
    validateIdentifier(input.executionId, "REAL_MODEL_EXECUTION_ID_INVALID");
    validateDigest(
      input.outputDigest,
      "REAL_MODEL_EXECUTION_OUTPUT_DIGEST_INVALID",
    );
    await this.mutate((events) => {
      if (frozen(events)) fail("REAL_MODEL_EXECUTION_CAMPAIGN_FROZEN");
      if (
        events.some(
          ({ event }) =>
            event.kind === "execution_completed" &&
            event.executionId === input.executionId,
        )
      ) {
        fail("REAL_MODEL_EXECUTION_ALREADY_COMPLETED");
      }
      const claims = events.filter(
        ({ event }) =>
          event.kind === "wire_claimed" &&
          event.executionId === input.executionId,
      );
      const observations = events.flatMap(({ event }) =>
        event.kind === "wire_observed" &&
        event.executionId === input.executionId
          ? [event]
          : [],
      );
      const last = observations.at(-1);
      if (
        claims.length === 0 ||
        claims.length !== observations.length ||
        last?.settlement !== "known" ||
        last.outputDigest !== input.outputDigest
      ) {
        fail("REAL_MODEL_EXECUTION_COMPLETION_MISMATCH");
      }
      return [{ kind: "execution_completed", ...input }];
    });
  }

  private validateOperatorEvidenceAuthorization(
    input: OperatorEvidenceAuthorizationInput,
  ): void {
    validateIdentifier(
      input.authorizationId,
      "REAL_MODEL_OPERATOR_AUTHORIZATION_INVALID",
    );
    validateIdentifier(
      input.keyId,
      "REAL_MODEL_OPERATOR_AUTHORIZATION_INVALID",
    );
    validateIdentifier(
      input.executionId,
      "REAL_MODEL_OPERATOR_AUTHORIZATION_INVALID",
    );
    for (const value of [
      input.payloadDigest,
      input.signatureDigest,
      input.candidateReceiptDigest,
      input.outputDigest,
      input.candidateLedgerDigest,
    ]) {
      validateDigest(value, "REAL_MODEL_OPERATOR_AUTHORIZATION_INVALID");
    }
  }

  async operatorEvidenceAuthorizationDigest(
    input: OperatorEvidenceAuthorizationInput,
  ): Promise<string | undefined> {
    this.validateOperatorEvidenceAuthorization(input);
    const ledgerIdentity = await readSecure(this.ledgerPath);
    if (
      ledgerIdentity.device !== this.ledgerDevice ||
      ledgerIdentity.inode !== this.ledgerInode
    ) {
      fail("REAL_MODEL_EXECUTION_LEDGER_REPLACED");
    }
    return parseLedger(ledgerIdentity.raw).find(
      ({ event }) =>
        event.kind === "operator_evidence_authorization_consumed" &&
        canonicalDigest(event) ===
          canonicalDigest({
            kind: "operator_evidence_authorization_consumed",
            ...input,
          }),
    )?.digest;
  }

  async consumeOperatorEvidenceAuthorization(
    input: OperatorEvidenceAuthorizationInput,
  ): Promise<string> {
    this.validateOperatorEvidenceAuthorization(input);
    const evidenceLedgerDigest = await this.mutate((events) => {
      const operatorEvent = {
        kind: "operator_evidence_authorization_consumed" as const,
        ...input,
      };
      const existingAuthorization = events.find(
        ({ event }) =>
          event.kind === "operator_evidence_authorization_consumed" &&
          (event.authorizationId === input.authorizationId ||
            event.executionId === input.executionId),
      );
      if (existingAuthorization != null) {
        if (
          canonicalDigest(existingAuthorization.event) !==
          canonicalDigest(operatorEvent)
        ) {
          fail("REAL_MODEL_OPERATOR_AUTHORIZATION_ALREADY_CONSUMED");
        }
        return [];
      }
      if (frozen(events)) fail("REAL_MODEL_EXECUTION_CAMPAIGN_FROZEN");
      const completed = events.find(
        ({ event }) =>
          event.kind === "execution_completed" &&
          event.executionId === input.executionId,
      )?.event;
      if (
        events.at(-1)?.digest !== input.candidateLedgerDigest ||
        completed?.kind !== "execution_completed" ||
        completed.outputDigest !== input.outputDigest ||
        events.some(
          ({ event }) =>
            event.kind === "wire_observed" &&
            event.executionId === input.executionId &&
            event.settlement === "unknown",
        )
      ) {
        fail("REAL_MODEL_OPERATOR_AUTHORIZATION_BINDING_MISMATCH");
      }
      return [operatorEvent];
    });
    if (evidenceLedgerDigest != null) return evidenceLedgerDigest;
    const existing = await this.operatorEvidenceAuthorizationDigest(input);
    return (
      existing ?? fail("REAL_MODEL_OPERATOR_AUTHORIZATION_BINDING_MISMATCH")
    );
  }

  async freezeExecution(executionId: string, reason: string): Promise<void> {
    validateIdentifier(executionId, "REAL_MODEL_EXECUTION_ID_INVALID");
    const normalized = reason.trim().slice(0, 160);
    if (!normalized) fail("REAL_MODEL_EXECUTION_FREEZE_REASON_INVALID");
    await this.mutate((events) =>
      frozen(events)
        ? []
        : [
            {
              kind: "campaign_frozen",
              executionId,
              reason: normalized,
            },
          ],
    );
  }

  async summary(): Promise<RealModelExecutionLedgerSummary> {
    const ledgerIdentity = await readSecure(this.ledgerPath);
    if (
      ledgerIdentity.device !== this.ledgerDevice ||
      ledgerIdentity.inode !== this.ledgerInode
    ) {
      fail("REAL_MODEL_EXECUTION_LEDGER_REPLACED");
    }
    const events = parseLedger(ledgerIdentity.raw);
    const opened = openedEvent(events);
    const claimIdentity = await readSecure(this.authorizationClaimPath);
    if (
      claimIdentity.device !== this.claimDevice ||
      claimIdentity.inode !== this.claimInode
    ) {
      fail("REAL_MODEL_AUTHORIZATION_CLAIM_REPLACED");
    }
    const claim = parseClaims(claimIdentity.raw).at(-1);
    if (
      claim == null ||
      claim.authorizationDigest !== canonicalDigest(this.authorization) ||
      claim.campaignDigest !== canonicalDigest(this.campaign) ||
      claim.ledgerPath !== this.ledgerPath ||
      claim.ledgerDevice !== this.ledgerDevice ||
      claim.ledgerInode !== this.ledgerInode
    ) {
      fail("REAL_MODEL_AUTHORIZATION_CLAIM_MISMATCH");
    }
    return Object.freeze({
      schemaVersion: "model-execution-ledger/2026-08-05-v1" as const,
      evidenceClass: "gateway_settlement_claim_only" as const,
      campaign: Object.freeze({ ...opened.campaign }),
      authorizationDigest: canonicalDigest(opened.authorization),
      ledgerDigest:
        events.at(-1)?.digest ?? fail("REAL_MODEL_EXECUTION_LEDGER_INVALID"),
      eventCount: events.length,
      executionClaims: eventCount(events, "execution_claimed"),
      wireClaims: eventCount(events, "wire_claimed"),
      knownWireSettlements: events.filter(
        ({ event }) =>
          event.kind === "wire_observed" && event.settlement === "known",
      ).length,
      unknownWireSettlements: events.filter(
        ({ event }) =>
          event.kind === "wire_observed" && event.settlement === "unknown",
      ).length,
      repairPlans: eventCount(events, "repair_planned"),
      operatorEvidenceAuthorizations: eventCount(
        events,
        "operator_evidence_authorization_consumed",
      ),
      completedExecutions: eventCount(events, "execution_completed"),
      frozen: frozen(events),
    });
  }
}
