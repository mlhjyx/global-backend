import { createHash } from "node:crypto";
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
  type GitAcceptedOutputReplayConsumeInput,
  type GitAcceptedOutputReplayInput,
  type GitEvidenceAcceptanceInput,
  type RealCompletedExecutionSnapshot,
  type RealKnownSettlementEvidence,
  type RealLedgerEnvelope,
  type RealLedgerEvent,
  type RealModelExecutionAuthorization,
  type RealModelExecutionLedgerSummary,
  type OperatorEvidenceAuthorizationInput,
} from "./real-model-execution-ledger-storage";
import type { ModelProtocol } from "./types";

const CREATE_HASH = createHash;
const BUFFER_FROM = Buffer.from.bind(Buffer);
const OBJECT_KEYS = Object.keys.bind(Object);
const OBJECT_HAS_OWN = Object.hasOwn.bind(Object);

export {
  REAL_MODEL_EXECUTION_LEDGER_SCHEMA_VERSION,
  REAL_MODEL_SHARED_CAMPAIGN_BINDING_SCHEMA_VERSION,
  type GitAcceptedOutputReplayConsumeInput,
  type GitAcceptedOutputReplayInput,
  type GitEvidenceAcceptanceInput,
  type RealCompletedExecutionSnapshot,
  type RealKnownSettlementEvidence,
  type RealModelExecutionAuthorization,
  type RealModelExecutionLedgerSummary,
  type RealModelSharedCampaignBinding,
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

interface RealModelExecutionLedgerOpenInput {
  ledgerPath: string;
  authorizationClaimPath: string;
  campaign: ModelExecutionCampaignContract;
  authorization: RealModelExecutionAuthorization;
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

  static async open(
    input: RealModelExecutionLedgerOpenInput,
  ): Promise<RealModelExecutionLedger> {
    return this.openWithMode(input, false);
  }

  static async reopen(
    input: RealModelExecutionLedgerOpenInput,
  ): Promise<RealModelExecutionLedger> {
    return this.openWithMode(input, true);
  }

  private static async openWithMode(
    input: RealModelExecutionLedgerOpenInput,
    existingOnly: boolean,
  ): Promise<RealModelExecutionLedger> {
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
    if (existingOnly && !ledgerExists) {
      fail("REAL_MODEL_EXECUTION_LEDGER_REOPEN_REQUIRED");
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
        if (existingOnly) throw error;
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
        if (existingOnly) {
          fail("REAL_MODEL_EXECUTION_LEDGER_REOPEN_REQUIRED");
        }
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
    if (
      this.authorization.evidenceBinding != null &&
      (input.executionId !== this.authorization.evidenceBinding.executionId ||
        input.planDigest !==
          this.authorization.evidenceBinding.executionPlanDigest)
    ) {
      fail("REAL_MODEL_EXECUTION_EVIDENCE_BINDING_MISMATCH");
    }
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

  private knownSettlementEvidenceFromEvents(
    events: readonly RealLedgerEnvelope[],
    executionId: string,
    expectedPlanDigest?: string,
  ): RealKnownSettlementEvidence {
    const executionClaims = events.flatMap(({ event }) =>
      event.kind === "execution_claimed" && event.executionId === executionId
        ? [event]
        : [],
    );
    const claims = events.flatMap(({ event }) =>
      event.kind === "wire_claimed" && event.executionId === executionId
        ? [event]
        : [],
    );
    const observations = events.flatMap(({ event }) =>
      event.kind === "wire_observed" && event.executionId === executionId
        ? [event]
        : [],
    );
    const knownObservations = observations.flatMap((observation) =>
      observation.settlement === "known" ? [observation] : [],
    );
    const repairPlans = events.flatMap(({ event }) =>
      event.kind === "repair_planned" && event.executionId === executionId
        ? [event]
        : [],
    );
    const completed = events.flatMap(({ event }) =>
      event.kind === "execution_completed" && event.executionId === executionId
        ? [event]
        : [],
    )[0];
    const claimedWireIds = claims.map(({ wireId }) => wireId);
    const observedWireIds = knownObservations.map(({ wireId }) => wireId);
    const lastObservation = knownObservations.at(-1);
    if (
      executionClaims.length !== 1 ||
      (expectedPlanDigest != null &&
        executionClaims[0]?.planDigest !== expectedPlanDigest) ||
      claims.length === 0 ||
      claims.length !== observations.length ||
      observations.length !== knownObservations.length ||
      completed == null ||
      repairPlans.length !== claims.length - 1 ||
      repairPlans.some(
        (repair, index) => repair.wireId !== claims[index + 1]?.wireId,
      ) ||
      new Set(claimedWireIds).size !== claimedWireIds.length ||
      new Set(observedWireIds).size !== observedWireIds.length ||
      claimedWireIds.some(
        (wireId, index) => wireId !== observedWireIds[index],
      ) ||
      lastObservation?.settlement !== "known" ||
      lastObservation.outputDigest !== completed.outputDigest
    ) {
      fail("REAL_MODEL_GIT_ACCEPTANCE_BINDING_MISMATCH");
    }
    const material = Object.freeze({
      schemaVersion:
        "real-model-known-settlement-evidence/2026-08-07-v1" as const,
      executionId,
      executionClaim: Object.freeze({
        planDigest: executionClaims[0]!.planDigest,
      }),
      wires: Object.freeze(
        claims.map((claim, index) => {
          const observation = knownObservations[index]!;
          const repairPlan = index === 0 ? undefined : repairPlans[index - 1];
          return Object.freeze({
            wireIndex: index + 1,
            claim: Object.freeze({
              wireId: claim.wireId,
              requestDigest: claim.requestDigest,
            }),
            ...(repairPlan == null
              ? {}
              : {
                  repairPlan: Object.freeze({
                    wireId: repairPlan.wireId,
                    bindingDigest: repairPlan.bindingDigest,
                    priorOutputDigest: repairPlan.priorOutputDigest,
                    findingsDigest: repairPlan.findingsDigest,
                  }),
                }),
            observation: Object.freeze({
              settlement: "known" as const,
              requestIdDigest: canonicalDigest(observation.requestId),
              requestedAlias: observation.requestedAlias,
              resolvedAlias: observation.resolvedAlias,
              reportedModel: observation.reportedModel,
              protocol: observation.protocol,
              usage: Object.freeze({ ...observation.usage }),
              outputDigest: observation.outputDigest,
              receiptDigest: observation.receiptDigest,
              quota: observation.quota,
              ...(observation.resolverId == null
                ? {}
                : { resolverId: observation.resolverId }),
              ...(observation.channelId == null
                ? {}
                : { channelId: observation.channelId }),
            }),
          });
        }),
      ),
      completion: Object.freeze({ outputDigest: completed.outputDigest }),
    });
    return Object.freeze({ ...material, digest: canonicalDigest(material) });
  }

  private knownSettlementDigestFromEvents(
    events: readonly RealLedgerEnvelope[],
    executionId: string,
    expectedPlanDigest?: string,
  ): string {
    return this.knownSettlementEvidenceFromEvents(
      events,
      executionId,
      expectedPlanDigest,
    ).digest;
  }

  private completedExecutionSnapshotFromEvents(
    events: readonly RealLedgerEnvelope[],
    executionId: string,
    expectedPlanDigest: string | undefined,
    failureCode: string,
  ): RealCompletedExecutionSnapshot {
    let settlement: RealKnownSettlementEvidence;
    try {
      settlement = this.knownSettlementEvidenceFromEvents(
        events,
        executionId,
        expectedPlanDigest,
      );
    } catch {
      return fail(failureCode);
    }
    const completionEnvelopes = events.filter(
      ({ event }) =>
        event.kind === "execution_completed" &&
        event.executionId === executionId,
    );
    const observations = events.flatMap(({ event }) =>
      event.kind === "wire_observed" && event.executionId === executionId
        ? [event]
        : [],
    );
    const firstObservation = observations[0];
    if (
      completionEnvelopes.length !== 1 ||
      firstObservation?.kind !== "wire_observed" ||
      firstObservation.settlement !== "known" ||
      observations.some(
        (observation) =>
          observation.settlement !== "known" ||
          observation.requestedAlias !== firstObservation.requestedAlias ||
          observation.resolvedAlias !== firstObservation.resolvedAlias ||
          observation.requestedAlias !== observation.resolvedAlias ||
          observation.protocol !== firstObservation.protocol,
      )
    ) {
      return fail(failureCode);
    }
    const completion = completionEnvelopes[0]!;
    return Object.freeze({
      schemaVersion:
        "real-model-completed-execution-snapshot/2026-08-07-v1" as const,
      executionId,
      completionSequence: completion.sequence,
      planDigest: settlement.executionClaim.planDigest,
      outputDigest: settlement.completion.outputDigest,
      ledgerDigest: completion.digest,
      knownSettlementDigest: settlement.digest,
      alias: firstObservation.resolvedAlias,
      protocol: firstObservation.protocol,
      wireCount: observations.length,
    });
  }

  async completedExecutionSnapshot(
    executionId: string,
    expectedPlanDigest?: string,
  ): Promise<RealCompletedExecutionSnapshot> {
    validateIdentifier(executionId, "REAL_MODEL_EXECUTION_ID_INVALID");
    if (expectedPlanDigest != null) {
      validateDigest(
        expectedPlanDigest,
        "REAL_MODEL_EXECUTION_PLAN_DIGEST_INVALID",
      );
    }
    const ledgerIdentity = await readSecure(this.ledgerPath);
    if (
      ledgerIdentity.device !== this.ledgerDevice ||
      ledgerIdentity.inode !== this.ledgerInode
    ) {
      fail("REAL_MODEL_EXECUTION_LEDGER_REPLACED");
    }
    return this.completedExecutionSnapshotFromEvents(
      parseLedger(ledgerIdentity.raw),
      executionId,
      expectedPlanDigest,
      "REAL_MODEL_COMPLETED_EXECUTION_SNAPSHOT_MISMATCH",
    );
  }

  async executionKnownSettlementEvidence(
    executionId: string,
    expectedPlanDigest?: string,
  ): Promise<RealKnownSettlementEvidence> {
    validateIdentifier(executionId, "REAL_MODEL_EXECUTION_ID_INVALID");
    if (expectedPlanDigest != null) {
      validateDigest(
        expectedPlanDigest,
        "REAL_MODEL_EXECUTION_PLAN_DIGEST_INVALID",
      );
    }
    const ledgerIdentity = await readSecure(this.ledgerPath);
    if (
      ledgerIdentity.device !== this.ledgerDevice ||
      ledgerIdentity.inode !== this.ledgerInode
    ) {
      fail("REAL_MODEL_EXECUTION_LEDGER_REPLACED");
    }
    return this.knownSettlementEvidenceFromEvents(
      parseLedger(ledgerIdentity.raw),
      executionId,
      expectedPlanDigest,
    );
  }

  async executionKnownSettlementDigest(
    executionId: string,
    expectedPlanDigest?: string,
  ): Promise<string> {
    return (
      await this.executionKnownSettlementEvidence(
        executionId,
        expectedPlanDigest,
      )
    ).digest;
  }

  private validateGitEvidenceAcceptance(
    input: GitEvidenceAcceptanceInput,
  ): void {
    for (const value of [
      input.acceptanceId,
      input.acceptedEvidenceClass,
      input.evidenceKind,
      input.executionId,
      input.alias,
      input.protocol,
      input.reasoning,
    ]) {
      validateIdentifier(value, "REAL_MODEL_GIT_ACCEPTANCE_INVALID");
    }
    for (const value of [
      input.artifactDigest,
      input.candidateReceiptDigest,
      input.planDigest,
      input.outputDigest,
      input.candidateLedgerDigest,
      input.sourceBundleDigest,
      input.manifestDigest,
      input.compiledRuntimeDigest,
      input.compiledBindingDigest,
      input.settlementObserverDigest,
      input.knownSettlementDigest,
    ]) {
      validateDigest(value, "REAL_MODEL_GIT_ACCEPTANCE_INVALID");
    }
    if (
      !/^[0-9a-f]{40}$/u.test(input.artifactCommit) ||
      !/^[0-9a-f]{40}$/u.test(input.mergeCommit) ||
      !/^[0-9a-f]{40}$/u.test(input.fixedSourceCommit) ||
      !safeInteger(input.pullRequestNumber, 1)
    ) {
      fail("REAL_MODEL_GIT_ACCEPTANCE_INVALID");
    }
  }

  async gitEvidenceAcceptanceDigest(
    input: GitEvidenceAcceptanceInput,
  ): Promise<string | undefined> {
    this.validateGitEvidenceAcceptance(input);
    const ledgerIdentity = await readSecure(this.ledgerPath);
    if (
      ledgerIdentity.device !== this.ledgerDevice ||
      ledgerIdentity.inode !== this.ledgerInode
    ) {
      fail("REAL_MODEL_EXECUTION_LEDGER_REPLACED");
    }
    return parseLedger(ledgerIdentity.raw).find(
      ({ event }) =>
        event.kind === "git_evidence_acceptance_consumed" &&
        canonicalDigest(event) ===
          canonicalDigest({
            kind: "git_evidence_acceptance_consumed",
            ...input,
          }),
    )?.digest;
  }

  async consumeGitEvidenceAcceptance(
    input: GitEvidenceAcceptanceInput,
  ): Promise<string> {
    this.validateGitEvidenceAcceptance(input);
    const evidenceLedgerDigest = await this.mutate((events) => {
      const acceptanceEvent = {
        kind: "git_evidence_acceptance_consumed" as const,
        ...input,
      };
      const existingAcceptance = events.find(
        ({ event }) =>
          (event.kind === "git_evidence_acceptance_consumed" ||
            event.kind === "git_accepted_output_replay_consumed") &&
          (event.acceptanceId === input.acceptanceId ||
            event.executionId === input.executionId ||
            event.artifactDigest === input.artifactDigest),
      );
      if (existingAcceptance != null) {
        if (
          existingAcceptance.event.kind !==
            "git_evidence_acceptance_consumed" ||
          canonicalDigest(existingAcceptance.event) !==
            canonicalDigest(acceptanceEvent)
        ) {
          fail("REAL_MODEL_GIT_ACCEPTANCE_ALREADY_CONSUMED");
        }
        return [];
      }
      if (frozen(events)) fail("REAL_MODEL_EXECUTION_CAMPAIGN_FROZEN");
      const completed = events.find(
        ({ event }) =>
          event.kind === "execution_completed" &&
          event.executionId === input.executionId,
      )?.event;
      const observations = events.flatMap(({ event }) =>
        event.kind === "wire_observed" &&
        event.executionId === input.executionId
          ? [event]
          : [],
      );
      const knownObservations = observations.filter(
        (observation) => observation.settlement === "known",
      );
      if (
        events.at(-1)?.digest !== input.candidateLedgerDigest ||
        completed?.kind !== "execution_completed" ||
        completed.outputDigest !== input.outputDigest ||
        observations.length === 0 ||
        observations.length !== knownObservations.length ||
        knownObservations.some(
          (observation) =>
            observation.resolvedAlias !== input.alias ||
            observation.protocol !== input.protocol,
        ) ||
        this.knownSettlementDigestFromEvents(
          events,
          input.executionId,
          input.planDigest,
        ) !== input.knownSettlementDigest
      ) {
        fail("REAL_MODEL_GIT_ACCEPTANCE_BINDING_MISMATCH");
      }
      return [acceptanceEvent];
    });
    if (evidenceLedgerDigest != null) return evidenceLedgerDigest;
    const existing = await this.gitEvidenceAcceptanceDigest(input);
    return existing ?? fail("REAL_MODEL_GIT_ACCEPTANCE_BINDING_MISMATCH");
  }

  private validateGitAcceptedOutputReplay(
    input: GitAcceptedOutputReplayInput,
  ): void {
    this.validateGitEvidenceAcceptance(input);
    validateIdentifier(input.fixtureId, "REAL_MODEL_GIT_OUTPUT_REPLAY_INVALID");
    validateDigest(
      input.outputBytesDigest,
      "REAL_MODEL_GIT_OUTPUT_REPLAY_INVALID",
    );
    validateDigest(
      input.admissionDigest,
      "REAL_MODEL_GIT_OUTPUT_REPLAY_INVALID",
    );
    if (
      input.acceptedEvidenceClass !==
        "git_reviewed_gateway_settlement_accepted" ||
      input.evidenceKind !== "quality_matrix" ||
      !safeInteger(input.completionSequence, 1) ||
      ![0, 1].includes(input.repeatIndex) ||
      !safeInteger(input.outputByteLength, 1) ||
      input.outputByteLength > 64 * 1024
    ) {
      fail("REAL_MODEL_GIT_OUTPUT_REPLAY_INVALID");
    }
  }

  private outputReplayEventInput(
    input: GitAcceptedOutputReplayConsumeInput,
  ): GitAcceptedOutputReplayInput {
    const eventInput: GitAcceptedOutputReplayInput = {
      acceptanceId: input.acceptanceId,
      artifactDigest: input.artifactDigest,
      artifactCommit: input.artifactCommit,
      mergeCommit: input.mergeCommit,
      pullRequestNumber: input.pullRequestNumber,
      acceptedEvidenceClass: input.acceptedEvidenceClass,
      evidenceKind: input.evidenceKind,
      candidateReceiptDigest: input.candidateReceiptDigest,
      executionId: input.executionId,
      planDigest: input.planDigest,
      outputDigest: input.outputDigest,
      candidateLedgerDigest: input.candidateLedgerDigest,
      fixedSourceCommit: input.fixedSourceCommit,
      sourceBundleDigest: input.sourceBundleDigest,
      manifestDigest: input.manifestDigest,
      admissionDigest: input.admissionDigest,
      compiledRuntimeDigest: input.compiledRuntimeDigest,
      compiledBindingDigest: input.compiledBindingDigest,
      settlementObserverDigest: input.settlementObserverDigest,
      knownSettlementDigest: input.knownSettlementDigest,
      alias: input.alias,
      protocol: input.protocol,
      reasoning: input.reasoning,
      completionSequence: input.completionSequence,
      fixtureId: input.fixtureId,
      repeatIndex: input.repeatIndex,
      outputBytesDigest: input.outputBytesDigest,
      outputByteLength: input.outputByteLength,
    };
    const eventKeys = new Set(OBJECT_KEYS(eventInput));
    const inputKeys = OBJECT_KEYS(input);
    if (
      inputKeys.length !== eventKeys.size + 1 ||
      !OBJECT_HAS_OWN(input, "outputBytes") ||
      inputKeys.some((key) => key !== "outputBytes" && !eventKeys.has(key)) ||
      !(input.outputBytes instanceof Uint8Array)
    ) {
      fail("REAL_MODEL_GIT_OUTPUT_REPLAY_INVALID");
    }
    this.validateGitAcceptedOutputReplay(eventInput);
    const outputBytes = BUFFER_FROM(input.outputBytes);
    const observedByteLength = outputBytes.byteLength;
    const observedBytesDigest = CREATE_HASH("sha256")
      .update(outputBytes)
      .digest("hex");
    if (
      observedByteLength !== eventInput.outputByteLength ||
      observedByteLength < 1 ||
      observedByteLength > 64 * 1024 ||
      observedBytesDigest !== eventInput.outputBytesDigest ||
      eventInput.outputBytesDigest !== eventInput.outputDigest
    ) {
      fail("REAL_MODEL_GIT_OUTPUT_REPLAY_BINDING_MISMATCH");
    }
    return eventInput;
  }

  async gitAcceptedOutputReplayDigest(
    input: GitAcceptedOutputReplayInput,
  ): Promise<string | undefined> {
    this.validateGitAcceptedOutputReplay(input);
    const ledgerIdentity = await readSecure(this.ledgerPath);
    if (
      ledgerIdentity.device !== this.ledgerDevice ||
      ledgerIdentity.inode !== this.ledgerInode
    ) {
      fail("REAL_MODEL_EXECUTION_LEDGER_REPLACED");
    }
    return parseLedger(ledgerIdentity.raw).find(
      ({ event }) =>
        event.kind === "git_accepted_output_replay_consumed" &&
        canonicalDigest(event) ===
          canonicalDigest({
            kind: "git_accepted_output_replay_consumed",
            ...input,
          }),
    )?.digest;
  }

  async consumeGitAcceptedOutputReplay(
    input: GitAcceptedOutputReplayConsumeInput,
  ): Promise<string> {
    const eventInput = this.outputReplayEventInput(input);
    const replayLedgerDigest = await this.mutate((events) => {
      const replayEvent = {
        kind: "git_accepted_output_replay_consumed" as const,
        ...eventInput,
      };
      const existingReplay = events.find(
        ({ event }) =>
          (event.kind === "git_evidence_acceptance_consumed" ||
            event.kind === "git_accepted_output_replay_consumed") &&
          (event.acceptanceId === eventInput.acceptanceId ||
            event.executionId === eventInput.executionId ||
            event.artifactDigest === eventInput.artifactDigest),
      );
      if (existingReplay != null) {
        if (
          existingReplay.event.kind !== "git_accepted_output_replay_consumed" ||
          canonicalDigest(existingReplay.event) !== canonicalDigest(replayEvent)
        ) {
          fail("REAL_MODEL_GIT_OUTPUT_REPLAY_ALREADY_CONSUMED");
        }
        return [];
      }
      if (frozen(events)) fail("REAL_MODEL_EXECUTION_CAMPAIGN_FROZEN");
      const snapshot = this.completedExecutionSnapshotFromEvents(
        events,
        eventInput.executionId,
        eventInput.planDigest,
        "REAL_MODEL_GIT_OUTPUT_REPLAY_BINDING_MISMATCH",
      );
      const binding = this.authorization.evidenceBinding;
      const sharedCampaignBinding = this.authorization.sharedCampaignBinding;
      if (
        (binding == null && sharedCampaignBinding == null) ||
        snapshot.completionSequence !== eventInput.completionSequence ||
        snapshot.outputDigest !== eventInput.outputDigest ||
        snapshot.ledgerDigest !== eventInput.candidateLedgerDigest ||
        snapshot.knownSettlementDigest !== eventInput.knownSettlementDigest ||
        snapshot.alias !== eventInput.alias ||
        snapshot.protocol !== eventInput.protocol ||
        eventInput.manifestDigest !== this.authorization.manifestDigest ||
        eventInput.settlementObserverDigest !==
          this.authorization.settlementObserverDigest ||
        (binding != null &&
          (binding.executionId !== eventInput.executionId ||
            binding.executionPlanDigest !== eventInput.planDigest ||
            binding.alias !== eventInput.alias ||
            binding.protocol !== eventInput.protocol ||
            binding.reasoning !== eventInput.reasoning ||
            binding.fixtureId !== eventInput.fixtureId ||
            binding.fixedSourceCommit !== eventInput.fixedSourceCommit ||
            binding.sourceBundleDigest !== eventInput.sourceBundleDigest ||
            binding.manifestDigest !== eventInput.manifestDigest ||
            binding.admissionDigest !== eventInput.admissionDigest ||
            binding.compiledRuntimeDigest !==
              eventInput.compiledRuntimeDigest ||
            binding.compiledBindingDigest !==
              eventInput.compiledBindingDigest)) ||
        (sharedCampaignBinding != null &&
          (sharedCampaignBinding.taskId !== this.campaign.taskId ||
            sharedCampaignBinding.planDigest !== this.campaign.planDigest ||
            sharedCampaignBinding.fixedSourceCommit !==
              eventInput.fixedSourceCommit ||
            sharedCampaignBinding.sourceBundleDigest !==
              eventInput.sourceBundleDigest ||
            sharedCampaignBinding.manifestDigest !==
              eventInput.manifestDigest ||
            sharedCampaignBinding.admissionDigest !==
              eventInput.admissionDigest ||
            sharedCampaignBinding.credentialAttestationDigest !==
              this.authorization.credentialAttestationDigest ||
            sharedCampaignBinding.settlementObserverDigest !==
              eventInput.settlementObserverDigest ||
            sharedCampaignBinding.compiledRuntimeDigest !==
              eventInput.compiledRuntimeDigest ||
            sharedCampaignBinding.compiledBindingDigest !==
              eventInput.compiledBindingDigest ||
            sharedCampaignBinding.maximumExecutions !==
              this.campaign.maximumExecutions ||
            sharedCampaignBinding.maximumExecutions !==
              this.authorization.maximumExecutions ||
            sharedCampaignBinding.maximumWireCalls !==
              this.campaign.maximumWireCalls ||
            sharedCampaignBinding.maximumWireCalls !==
              this.authorization.maximumWireCalls ||
            sharedCampaignBinding.maximumRepairCallsPerExecution !==
              this.authorization.maximumRepairCallsPerExecution))
      ) {
        fail("REAL_MODEL_GIT_OUTPUT_REPLAY_BINDING_MISMATCH");
      }
      return [replayEvent];
    });
    if (replayLedgerDigest != null) return replayLedgerDigest;
    const existing = await this.gitAcceptedOutputReplayDigest(eventInput);
    return existing ?? fail("REAL_MODEL_GIT_OUTPUT_REPLAY_BINDING_MISMATCH");
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
      gitEvidenceAcceptances: eventCount(
        events,
        "git_evidence_acceptance_consumed",
      ),
      gitAcceptedOutputReplays: eventCount(
        events,
        "git_accepted_output_replay_consumed",
      ),
      completedExecutions: eventCount(events, "execution_completed"),
      frozen: frozen(events),
    });
  }
}
