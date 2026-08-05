import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { canonicalDigest } from "./context-engine";
import type {
  ModelExecutionCampaignContract,
  ModelExecutionLedgerSummary,
} from "./model-execution-ledger";
import type { ModelProtocol } from "./types";

export const REAL_MODEL_EXECUTION_LEDGER_SCHEMA_VERSION =
  "real-model-execution-ledger/2026-08-05-v1" as const;
export const AUTHORIZATION_CLAIM_SCHEMA_VERSION =
  "real-model-execution-authorization-claim/2026-08-05-v1" as const;

const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,191}$/u;

export interface RealModelExecutionAuthorization {
  authorizationId: string;
  reservationId: string;
  manifestDigest: string;
  credentialAttestationDigest: string;
  settlementObserverDigest: string;
  ledgerIdentityDigest: string;
  reservationDigest: string;
  maximumExecutions: number;
  maximumWireCalls: number;
  maximumRepairCallsPerExecution: number;
}

export interface RealWireSettlementProof {
  resolverId: string;
  receiptDigest: string;
  channelId: number;
  quota: number;
}

export interface OperatorEvidenceAuthorizationInput {
  authorizationId: string;
  keyId: string;
  payloadDigest: string;
  signatureDigest: string;
  candidateReceiptDigest: string;
  executionId: string;
  outputDigest: string;
  candidateLedgerDigest: string;
}

export type RealLedgerEvent =
  | {
      kind: "campaign_opened";
      campaign: ModelExecutionCampaignContract;
      authorization: RealModelExecutionAuthorization;
      evidenceClass: "gateway_settlement_claim_only";
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
      receiptDigest: string;
      quota: number;
      resolverId?: string;
      channelId?: number;
    }
  | {
      kind: "wire_observed";
      executionId: string;
      wireId: string;
      settlement: "unknown";
      requestId: string | null;
      reason: string;
    }
  | {
      kind: "repair_planned";
      executionId: string;
      wireId: string;
      bindingDigest: string;
      priorOutputDigest: string;
      findingsDigest: string;
    }
  | { kind: "execution_completed"; executionId: string; outputDigest: string }
  | ({
      kind: "operator_evidence_authorization_consumed";
    } & OperatorEvidenceAuthorizationInput)
  | { kind: "campaign_frozen"; executionId: string; reason: string };

export interface RealLedgerEnvelope {
  schemaVersion: typeof REAL_MODEL_EXECUTION_LEDGER_SCHEMA_VERSION;
  sequence: number;
  previousDigest: string | null;
  event: RealLedgerEvent;
  digest: string;
}

export interface AuthorizationClaim {
  schemaVersion: typeof AUTHORIZATION_CLAIM_SCHEMA_VERSION;
  authorizationId: string;
  reservationId: string;
  authorizationDigest: string;
  campaignDigest: string;
  ledgerPath: string;
  ledgerDevice: string;
  ledgerInode: string;
  ledgerSize: number;
  ledgerDigest: string;
  previousClaimDigest: string | null;
  digest: string;
}

export interface RealModelExecutionLedgerSummary extends ModelExecutionLedgerSummary {
  evidenceClass: "gateway_settlement_claim_only";
  authorizationDigest: string;
  repairPlans: number;
  operatorEvidenceAuthorizations: number;
}

export function fail(code: string): never {
  throw new Error(code);
}

export function safeInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

export function validateIdentifier(value: string, code: string): void {
  if (!IDENTIFIER.test(value)) fail(code);
}

export function validateDigest(value: string, code: string): void {
  if (!SHA256.test(value)) fail(code);
}

export function validateCampaign(value: ModelExecutionCampaignContract): void {
  validateIdentifier(value.campaignId, "REAL_MODEL_EXECUTION_CAMPAIGN_INVALID");
  validateIdentifier(value.taskId, "REAL_MODEL_EXECUTION_CAMPAIGN_INVALID");
  validateDigest(value.planDigest, "REAL_MODEL_EXECUTION_CAMPAIGN_INVALID");
  if (
    !safeInteger(value.maximumExecutions, 1) ||
    !safeInteger(value.maximumWireCalls, value.maximumExecutions)
  ) {
    fail("REAL_MODEL_EXECUTION_CAMPAIGN_INVALID");
  }
}

export function validateAuthorization(
  value: RealModelExecutionAuthorization,
  campaign: ModelExecutionCampaignContract,
): void {
  validateIdentifier(value.authorizationId, "REAL_MODEL_AUTHORIZATION_INVALID");
  validateIdentifier(value.reservationId, "REAL_MODEL_AUTHORIZATION_INVALID");
  for (const digest of [
    value.manifestDigest,
    value.credentialAttestationDigest,
    value.settlementObserverDigest,
    value.ledgerIdentityDigest,
    value.reservationDigest,
  ]) {
    validateDigest(digest, "REAL_MODEL_AUTHORIZATION_INVALID");
  }
  if (
    value.maximumExecutions !== campaign.maximumExecutions ||
    value.maximumWireCalls !== campaign.maximumWireCalls ||
    value.maximumRepairCallsPerExecution !== 1
  ) {
    fail("REAL_MODEL_AUTHORIZATION_MISMATCH");
  }
}

function envelopeDigest(input: Omit<RealLedgerEnvelope, "digest">): string {
  return canonicalDigest(input);
}

export function claimDigest(input: Omit<AuthorizationClaim, "digest">): string {
  return canonicalDigest(input);
}

export async function assertSafeAbsentOrFile(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile()) {
      fail("REAL_MODEL_EXECUTION_LEDGER_UNSAFE");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function safeFileExists(path: string): Promise<boolean> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile()) {
      fail("REAL_MODEL_EXECUTION_LEDGER_UNSAFE");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readSecure(path: string): Promise<{
  raw: string;
  device: string;
  inode: string;
  size: number;
}> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return fail("REAL_MODEL_EXECUTION_LEDGER_UNSAFE");
  }
  try {
    const status = await handle.stat();
    if (!status.isFile() || (status.mode & 0o077) !== 0) {
      fail("REAL_MODEL_EXECUTION_LEDGER_UNSAFE");
    }
    return {
      raw: await handle.readFile("utf8"),
      device: String(status.dev),
      inode: String(status.ino),
      size: status.size,
    };
  } finally {
    await handle.close();
  }
}

export function parseLedger(raw: string): readonly RealLedgerEnvelope[] {
  if (!raw.endsWith("\n")) fail("REAL_MODEL_EXECUTION_LEDGER_INVALID");
  let previousDigest: string | null = null;
  return raw
    .slice(0, -1)
    .split("\n")
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return fail("REAL_MODEL_EXECUTION_LEDGER_INVALID");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return fail("REAL_MODEL_EXECUTION_LEDGER_INVALID");
      }
      const envelope = value as RealLedgerEnvelope;
      const material = {
        schemaVersion: envelope.schemaVersion,
        sequence: envelope.sequence,
        previousDigest: envelope.previousDigest,
        event: envelope.event,
      };
      if (
        envelope.schemaVersion !== REAL_MODEL_EXECUTION_LEDGER_SCHEMA_VERSION ||
        envelope.sequence !== index + 1 ||
        envelope.previousDigest !== previousDigest ||
        !SHA256.test(envelope.digest) ||
        envelope.digest !== envelopeDigest(material)
      ) {
        return fail("REAL_MODEL_EXECUTION_LEDGER_INVALID");
      }
      previousDigest = envelope.digest;
      return envelope;
    });
}

export function parseClaims(raw: string): readonly AuthorizationClaim[] {
  if (!raw.endsWith("\n")) fail("REAL_MODEL_AUTHORIZATION_CLAIM_INVALID");
  let previousClaimDigest: string | null = null;
  return raw
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return fail("REAL_MODEL_AUTHORIZATION_CLAIM_INVALID");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return fail("REAL_MODEL_AUTHORIZATION_CLAIM_INVALID");
      }
      const claim = value as AuthorizationClaim;
      const { digest, ...material } = claim;
      if (
        claim.schemaVersion !== AUTHORIZATION_CLAIM_SCHEMA_VERSION ||
        claim.previousClaimDigest !== previousClaimDigest ||
        !SHA256.test(digest) ||
        digest !== claimDigest(material)
      ) {
        return fail("REAL_MODEL_AUTHORIZATION_CLAIM_INVALID");
      }
      previousClaimDigest = digest;
      return claim;
    });
}

export function openedEvent(
  events: readonly RealLedgerEnvelope[],
): Extract<RealLedgerEvent, { kind: "campaign_opened" }> {
  const opened = events[0]?.event;
  if (opened?.kind !== "campaign_opened") {
    return fail("REAL_MODEL_EXECUTION_LEDGER_INVALID");
  }
  validateCampaign(opened.campaign);
  validateAuthorization(opened.authorization, opened.campaign);
  if (opened.evidenceClass !== "gateway_settlement_claim_only") {
    fail("REAL_MODEL_EXECUTION_LEDGER_INVALID");
  }
  return opened;
}

export function eventCount(
  events: readonly RealLedgerEnvelope[],
  kind: RealLedgerEvent["kind"],
): number {
  return events.filter(({ event }) => event.kind === kind).length;
}

export function frozen(events: readonly RealLedgerEnvelope[]): boolean {
  return events.some(({ event }) => event.kind === "campaign_frozen");
}

export function buildEnvelopes(
  existing: readonly RealLedgerEnvelope[],
  additions: readonly RealLedgerEvent[],
): readonly RealLedgerEnvelope[] {
  let previousDigest = existing.at(-1)?.digest ?? null;
  return additions.map((event, index) => {
    const material = {
      schemaVersion: REAL_MODEL_EXECUTION_LEDGER_SCHEMA_VERSION,
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
}

export async function writeExclusive(
  path: string,
  value: string,
): Promise<void> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    return fail("REAL_MODEL_EXECUTION_LEDGER_UNSAFE");
  }
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
