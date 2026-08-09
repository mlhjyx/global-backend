import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { canonicalDigest } from "./context-engine";
import {
  normalizeModelResponseShape,
  type ModelProtocol,
  type ModelResponseShape,
} from "./types";

export const MODEL_EXECUTION_LEDGER_SCHEMA_VERSION =
  "model-execution-ledger/2026-08-05-v1" as const;

export type ModelExecutionEvidenceClass =
  | "fake_gateway_contract_only"
  | "gateway_settlement_claim_only"
  | "copy_gateway_settlement_candidate"
  | "real_gateway_settled";

export interface ModelExecutionCampaignContract {
  campaignId: string;
  taskId: string;
  planDigest: string;
  maximumExecutions: number;
  maximumWireCalls: number;
}

type LedgerEvent =
  | {
      kind: "campaign_opened";
      campaign: ModelExecutionCampaignContract;
      evidenceClass: ModelExecutionEvidenceClass;
    }
  | { kind: "execution_claimed"; executionId: string; planDigest: string }
  | {
      kind: "wire_claimed";
      executionId: string;
      wireId: string;
      requestDigest: string;
    }
  | {
      kind: "wire_observed";
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
      responseShape?: ModelResponseShape;
    }
  | {
      kind: "wire_observed";
      executionId: string;
      wireId: string;
      settlement: "unknown";
      requestId: string | null;
      reason: string;
      responseShape?: ModelResponseShape;
    }
  | { kind: "execution_completed"; executionId: string; outputDigest: string }
  | { kind: "campaign_frozen"; executionId: string; reason: string };

interface LedgerEnvelope {
  schemaVersion: typeof MODEL_EXECUTION_LEDGER_SCHEMA_VERSION;
  sequence: number;
  previousDigest: string | null;
  event: LedgerEvent;
  digest: string;
}

export interface ModelExecutionLedgerSummary {
  schemaVersion: typeof MODEL_EXECUTION_LEDGER_SCHEMA_VERSION;
  evidenceClass: ModelExecutionEvidenceClass;
  campaign: ModelExecutionCampaignContract;
  ledgerDigest: string;
  eventCount: number;
  executionClaims: number;
  wireClaims: number;
  knownWireSettlements: number;
  unknownWireSettlements: number;
  completedExecutions: number;
  frozen: boolean;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,191}$/u;
const TRUSTED_MODEL_EXECUTION_LEDGERS = new WeakSet<object>();

export function isTrustedModelExecutionLedger(
  value: unknown,
): value is AppendOnlyModelExecutionLedger {
  return (
    typeof value === "object" &&
    value !== null &&
    TRUSTED_MODEL_EXECUTION_LEDGERS.has(value)
  );
}

function fail(code: string): never {
  throw new Error(code);
}

function safeInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function validateCampaign(value: ModelExecutionCampaignContract): void {
  if (!IDENTIFIER.test(value.campaignId) || !IDENTIFIER.test(value.taskId)) {
    fail("MODEL_EXECUTION_CAMPAIGN_INVALID");
  }
  if (!SHA256.test(value.planDigest)) fail("MODEL_EXECUTION_CAMPAIGN_INVALID");
  if (
    !safeInteger(value.maximumExecutions, 1) ||
    !safeInteger(value.maximumWireCalls, 1)
  ) {
    fail("MODEL_EXECUTION_CAMPAIGN_INVALID");
  }
  if (value.maximumWireCalls < value.maximumExecutions) {
    fail("MODEL_EXECUTION_CAMPAIGN_INVALID");
  }
}

function envelopeDigest(input: Omit<LedgerEnvelope, "digest">): string {
  return canonicalDigest(input);
}

function validateEnvelope(
  value: unknown,
  index: number,
  previousDigest: string | null,
): LedgerEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("MODEL_EXECUTION_LEDGER_INVALID");
  }
  const candidate = value as Partial<LedgerEnvelope>;
  if (
    candidate.schemaVersion !== MODEL_EXECUTION_LEDGER_SCHEMA_VERSION ||
    candidate.sequence !== index + 1 ||
    candidate.previousDigest !== previousDigest ||
    !candidate.event ||
    typeof candidate.event !== "object" ||
    typeof candidate.digest !== "string"
  ) {
    return fail("MODEL_EXECUTION_LEDGER_INVALID");
  }
  const material = {
    schemaVersion: candidate.schemaVersion,
    sequence: candidate.sequence,
    previousDigest: candidate.previousDigest,
    event: candidate.event,
  };
  if (
    !SHA256.test(candidate.digest) ||
    envelopeDigest(material) !== candidate.digest
  ) {
    return fail("MODEL_EXECUTION_LEDGER_INVALID");
  }
  return candidate as LedgerEnvelope;
}

function campaignEvent(
  events: readonly LedgerEnvelope[],
): Extract<LedgerEvent, { kind: "campaign_opened" }> {
  const opened = events[0]?.event;
  if (opened?.kind !== "campaign_opened")
    fail("MODEL_EXECUTION_LEDGER_INVALID");
  validateCampaign(opened.campaign);
  if (opened.evidenceClass !== "fake_gateway_contract_only") {
    fail("MODEL_EXECUTION_LEDGER_INVALID");
  }
  return opened;
}

function hasFrozen(events: readonly LedgerEnvelope[]): boolean {
  return events.some(({ event }) => event.kind === "campaign_frozen");
}

function eventCount(
  events: readonly LedgerEnvelope[],
  kind: LedgerEvent["kind"],
): number {
  return events.filter(({ event }) => event.kind === kind).length;
}

function validateIdentifier(value: string, code: string): void {
  if (!IDENTIFIER.test(value)) fail(code);
}

function validateDigest(value: string, code: string): void {
  if (!SHA256.test(value)) fail(code);
}

async function readSecureFile(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail("MODEL_EXECUTION_LEDGER_UNSAFE");
  }
  try {
    const status = await handle.stat();
    if (!status.isFile() || (status.mode & 0o077) !== 0) {
      fail("MODEL_EXECUTION_LEDGER_UNSAFE");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function parseLedger(path: string): Promise<readonly LedgerEnvelope[]> {
  const raw = await readSecureFile(path);
  if (raw === null || raw === "") return [];
  if (!raw.endsWith("\n")) fail("MODEL_EXECUTION_LEDGER_INVALID");
  let previousDigest: string | null = null;
  return raw
    .slice(0, -1)
    .split("\n")
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return fail("MODEL_EXECUTION_LEDGER_INVALID");
      }
      const envelope = validateEnvelope(parsed, index, previousDigest);
      previousDigest = envelope.digest;
      return envelope;
    });
}

async function appendEnvelopes(
  path: string,
  envelopes: readonly LedgerEnvelope[],
): Promise<void> {
  if (envelopes.length === 0) return;
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    fail("MODEL_EXECUTION_LEDGER_UNSAFE");
  }
  try {
    const status = await handle.stat();
    if (!status.isFile() || (status.mode & 0o077) !== 0) {
      fail("MODEL_EXECUTION_LEDGER_UNSAFE");
    }
    await handle.writeFile(
      `${envelopes.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class AppendOnlyModelExecutionLedger {
  readonly evidenceClass = "fake_gateway_contract_only" as const;
  private readonly lockPath: string;

  private constructor(
    readonly ledgerPath: string,
    readonly campaign: ModelExecutionCampaignContract,
  ) {
    this.lockPath = `${ledgerPath}.lock`;
  }

  static async openTestOnly(input: {
    ledgerPath: string;
    campaign: ModelExecutionCampaignContract;
  }): Promise<AppendOnlyModelExecutionLedger> {
    if (!isAbsolute(input.ledgerPath)) fail("MODEL_EXECUTION_LEDGER_UNSAFE");
    validateCampaign(input.campaign);
    try {
      const status = await lstat(input.ledgerPath);
      if (status.isSymbolicLink()) fail("MODEL_EXECUTION_LEDGER_UNSAFE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const ledger = new AppendOnlyModelExecutionLedger(
      input.ledgerPath,
      Object.freeze({ ...input.campaign }),
    );
    TRUSTED_MODEL_EXECUTION_LEDGERS.add(ledger);
    await ledger.mutate((events) => {
      if (events.length === 0) {
        return [
          {
            kind: "campaign_opened",
            campaign: ledger.campaign,
            evidenceClass: ledger.evidenceClass,
          },
        ];
      }
      const opened = campaignEvent(events);
      if (
        canonicalDigest(opened.campaign) !== canonicalDigest(ledger.campaign)
      ) {
        fail("MODEL_EXECUTION_CAMPAIGN_MISMATCH");
      }
      return [];
    });
    Object.freeze(ledger);
    return ledger;
  }

  private async mutate(
    buildEvents: (events: readonly LedgerEnvelope[]) => readonly LedgerEvent[],
  ): Promise<readonly LedgerEnvelope[]> {
    let lock;
    try {
      lock = await open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        fail("MODEL_EXECUTION_LEDGER_BUSY");
      }
      fail("MODEL_EXECUTION_LEDGER_UNSAFE");
    }
    try {
      await lock.writeFile(`${process.pid}\n`, "utf8");
      await lock.sync();
      const existing = await parseLedger(this.ledgerPath);
      const additions = buildEvents(existing);
      let previousDigest = existing.at(-1)?.digest ?? null;
      const envelopes = additions.map((event, index) => {
        const material = {
          schemaVersion: MODEL_EXECUTION_LEDGER_SCHEMA_VERSION,
          sequence: existing.length + index + 1,
          previousDigest,
          event,
        } as const;
        const envelope = Object.freeze({
          ...material,
          digest: envelopeDigest(material),
        });
        previousDigest = envelope.digest;
        return envelope;
      });
      await appendEnvelopes(this.ledgerPath, envelopes);
      return [...existing, ...envelopes];
    } finally {
      await lock.close();
      await unlink(this.lockPath).catch(() => undefined);
    }
  }

  async claimExecution(input: {
    executionId: string;
    planDigest: string;
  }): Promise<void> {
    validateIdentifier(input.executionId, "MODEL_EXECUTION_ID_INVALID");
    validateDigest(input.planDigest, "MODEL_EXECUTION_PLAN_DIGEST_INVALID");
    await this.mutate((events) => {
      const opened = campaignEvent(events);
      if (hasFrozen(events)) fail("MODEL_EXECUTION_CAMPAIGN_FROZEN");
      if (
        events.some(
          ({ event }) =>
            event.kind === "execution_claimed" &&
            event.executionId === input.executionId,
        )
      ) {
        fail("MODEL_EXECUTION_ALREADY_CLAIMED");
      }
      if (
        eventCount(events, "execution_claimed") >=
        opened.campaign.maximumExecutions
      ) {
        fail("MODEL_EXECUTION_CAP_EXHAUSTED");
      }
      return [{ kind: "execution_claimed", ...input }];
    });
  }

  async claimWire(input: {
    executionId: string;
    wireId: string;
    requestDigest: string;
  }): Promise<void> {
    validateIdentifier(input.executionId, "MODEL_EXECUTION_ID_INVALID");
    validateIdentifier(input.wireId, "MODEL_EXECUTION_WIRE_ID_INVALID");
    validateDigest(
      input.requestDigest,
      "MODEL_EXECUTION_REQUEST_DIGEST_INVALID",
    );
    await this.mutate((events) => {
      const opened = campaignEvent(events);
      if (hasFrozen(events)) fail("MODEL_EXECUTION_CAMPAIGN_FROZEN");
      if (
        !events.some(
          ({ event }) =>
            event.kind === "execution_claimed" &&
            event.executionId === input.executionId,
        )
      ) {
        fail("MODEL_EXECUTION_NOT_CLAIMED");
      }
      if (
        events.some(
          ({ event }) =>
            event.kind === "execution_completed" &&
            event.executionId === input.executionId,
        )
      ) {
        fail("MODEL_EXECUTION_ALREADY_COMPLETED");
      }
      if (
        events.some(
          ({ event }) =>
            event.kind === "wire_claimed" && event.wireId === input.wireId,
        )
      ) {
        fail("MODEL_EXECUTION_WIRE_ALREADY_CLAIMED");
      }
      if (
        eventCount(events, "wire_claimed") >= opened.campaign.maximumWireCalls
      ) {
        fail("MODEL_EXECUTION_WIRE_CAP_EXHAUSTED");
      }
      const claimedForExecution = events.filter(
        ({ event }) =>
          event.kind === "wire_claimed" &&
          event.executionId === input.executionId,
      );
      if (claimedForExecution.length >= 2)
        fail("MODEL_EXECUTION_WIRE_CAP_EXHAUSTED");
      const observedWireIds = new Set(
        events.flatMap(({ event }) =>
          event.kind === "wire_observed" ? [event.wireId] : [],
        ),
      );
      if (
        claimedForExecution.some(
          ({ event }) =>
            event.kind === "wire_claimed" && !observedWireIds.has(event.wireId),
        )
      ) {
        fail("MODEL_EXECUTION_WIRE_UNSETTLED");
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
          responseShape?: ModelResponseShape;
        }
      | {
          executionId: string;
          wireId: string;
          settlement: "unknown";
          requestId: string | null;
          reason: string;
          responseShape?: ModelResponseShape;
        },
  ): Promise<void> {
    validateIdentifier(input.executionId, "MODEL_EXECUTION_ID_INVALID");
    validateIdentifier(input.wireId, "MODEL_EXECUTION_WIRE_ID_INVALID");
    await this.mutate((events) => {
      campaignEvent(events);
      if (
        !events.some(
          ({ event }) =>
            event.kind === "wire_claimed" &&
            event.wireId === input.wireId &&
            event.executionId === input.executionId,
        )
      ) {
        fail("MODEL_EXECUTION_WIRE_NOT_CLAIMED");
      }
      if (
        events.some(
          ({ event }) =>
            event.kind === "wire_observed" && event.wireId === input.wireId,
        )
      ) {
        fail("MODEL_EXECUTION_WIRE_ALREADY_OBSERVED");
      }
      if (input.settlement === "known") {
        validateIdentifier(
          input.requestId,
          "MODEL_EXECUTION_REQUEST_ID_INVALID",
        );
        validateIdentifier(
          input.requestedAlias,
          "MODEL_EXECUTION_ALIAS_INVALID",
        );
        validateIdentifier(
          input.resolvedAlias,
          "MODEL_EXECUTION_ALIAS_INVALID",
        );
        validateIdentifier(
          input.reportedModel,
          "MODEL_EXECUTION_MODEL_INVALID",
        );
        validateDigest(
          input.outputDigest,
          "MODEL_EXECUTION_OUTPUT_DIGEST_INVALID",
        );
        if (
          !safeInteger(input.usage.inputTokens, 0) ||
          !safeInteger(input.usage.outputTokens, 0)
        ) {
          fail("MODEL_EXECUTION_USAGE_INVALID");
        }
        const responseShape =
          input.responseShape == null
            ? undefined
            : normalizeModelResponseShape(input.responseShape);
        if (input.responseShape != null && responseShape == null) {
          fail("MODEL_EXECUTION_RESPONSE_SHAPE_INVALID");
        }
        return [
          {
            kind: "wire_observed",
            ...input,
            ...(responseShape == null ? {} : { responseShape }),
          },
        ];
      }
      const reason = input.reason.trim();
      if (!reason || reason.length > 160)
        fail("MODEL_EXECUTION_UNKNOWN_REASON_INVALID");
      const responseShape =
        input.responseShape == null
          ? undefined
          : normalizeModelResponseShape(input.responseShape);
      if (input.responseShape != null && responseShape == null) {
        fail("MODEL_EXECUTION_RESPONSE_SHAPE_INVALID");
      }
      return [
        {
          kind: "wire_observed",
          ...input,
          reason,
          ...(responseShape == null ? {} : { responseShape }),
        },
        { kind: "campaign_frozen", executionId: input.executionId, reason },
      ];
    });
  }

  async completeExecution(input: {
    executionId: string;
    outputDigest: string;
  }): Promise<void> {
    validateIdentifier(input.executionId, "MODEL_EXECUTION_ID_INVALID");
    validateDigest(input.outputDigest, "MODEL_EXECUTION_OUTPUT_DIGEST_INVALID");
    await this.mutate((events) => {
      campaignEvent(events);
      if (hasFrozen(events)) fail("MODEL_EXECUTION_CAMPAIGN_FROZEN");
      const wireClaims = events.filter(
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
      if (
        wireClaims.length === 0 ||
        observations.length !== wireClaims.length
      ) {
        fail("MODEL_EXECUTION_WIRE_UNSETTLED");
      }
      const last = observations.at(-1);
      if (
        last?.settlement !== "known" ||
        last.outputDigest !== input.outputDigest
      ) {
        fail("MODEL_EXECUTION_COMPLETION_MISMATCH");
      }
      return [{ kind: "execution_completed", ...input }];
    });
  }

  async freezeExecution(executionId: string, reason: string): Promise<void> {
    validateIdentifier(executionId, "MODEL_EXECUTION_ID_INVALID");
    const normalized = reason.trim().slice(0, 160);
    if (!normalized) fail("MODEL_EXECUTION_FREEZE_REASON_INVALID");
    await this.mutate((events) => {
      campaignEvent(events);
      if (hasFrozen(events)) return [];
      return [{ kind: "campaign_frozen", executionId, reason: normalized }];
    });
  }

  async summary(): Promise<ModelExecutionLedgerSummary> {
    const events = await parseLedger(this.ledgerPath);
    const opened = campaignEvent(events);
    return Object.freeze({
      schemaVersion: MODEL_EXECUTION_LEDGER_SCHEMA_VERSION,
      evidenceClass: opened.evidenceClass,
      campaign: Object.freeze({ ...opened.campaign }),
      ledgerDigest:
        events.at(-1)?.digest ?? fail("MODEL_EXECUTION_LEDGER_INVALID"),
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
      completedExecutions: eventCount(events, "execution_completed"),
      frozen: hasFrozen(events),
    });
  }
}
