import { canonicalDigest } from "../../model-runtime/context-engine";
import type { ModelProtocol, ReasoningLevel } from "../../model-runtime/types";
import { COPY_CAPABILITY_PILOT_PLAN } from "./copy-capability-pilot";

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,191}$/u;
const MAX_PROOF_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_SETTLEMENT_POLL_MS = 30_000;
const CANONICAL_DIGEST = canonicalDigest;

export interface CopyRealCapabilityExecutionScope {
  alias: string;
  protocol: ModelProtocol;
  reasoning: ReasoningLevel;
}

export interface CopyPilotChildCampaignScope extends CopyRealCapabilityExecutionScope {
  childSlotId: string;
  executionKey: string;
  maximumExecutions: 1;
  maximumWireCalls: 2;
  maximumRepairCallsPerExecution: 1;
  unknownSettlementPolicy: "freeze_selected_child_campaign";
  sharedDriftPolicy: "freeze_all_child_campaigns";
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

const EXECUTIONS = COPY_CAPABILITY_PILOT_PLAN.executions.map(
  ({ alias, protocol, reasoning }) => ({ alias, protocol, reasoning }),
);
const CHILD_CAMPAIGNS = COPY_CAPABILITY_PILOT_PLAN.childCampaigns.map(
  (child) => ({ ...child }),
);

export const COPY_REAL_CAPABILITY_ADMISSION_SOURCE = deepFreeze({
  schemaVersion:
    "site-builder-copy-real-capability-admission-source/2026-08-06-v4" as const,
  taskId: "site_builder.copy" as const,
  planId: COPY_CAPABILITY_PILOT_PLAN.planId,
  planDigest: canonicalDigest(COPY_CAPABILITY_PILOT_PLAN),
  dispatchAuthorization: "NOT_AUTHORIZED" as const,
  observedModelWireCalls: 0 as const,
  observedModelCost: { CNY: 0 as const, USD: 0 as const },
  plannedExecutions: 3 as const,
  maximumWireCalls: 6 as const,
  maximumRepairCallsPerExecution: 1 as const,
  unknownSettlementPolicy: "freeze_selected_child_campaign" as const,
  sharedDriftPolicy: "freeze_all_child_campaigns" as const,
  requiredFollowup: "POST_MERGE_CREATE_ONLY_MANIFEST" as const,
  executions: EXECUTIONS,
  childCampaigns: CHILD_CAMPAIGNS,
});

export interface CopyRealCapabilityManifest {
  schemaVersion: "site-builder-copy-real-capability-manifest/2026-08-05-v1";
  manifestId: string;
  fixedSourceCommit: string;
  sourceBundleDigest: string;
  planDigest: string;
  dispatchAuthorization: "NOT_AUTHORIZED";
  taskId: "site_builder.copy";
  plannedExecutions: 3;
  maximumWireCalls: 6;
  maximumRepairCallsPerExecution: 1;
  executions: readonly CopyRealCapabilityExecutionScope[];
}

export interface CopyRealCapabilitySourceVerification {
  fixedSourceCommit: string;
  sourceBundleDigest: string;
  fixedCommitReachableFromExecutionHead: boolean;
  trackedSourceBytesMatch: boolean;
  compiledContractsMatch: boolean;
}

export interface CopyPilotCredentialAttestation {
  schemaVersion: "site-builder-copy-pilot-credential-attestation/2026-08-05-v3";
  attestationId: string;
  capturedAt: string;
  expiresAt: string;
  gatewayOrigin: string;
  bearerTokenSha256: string;
  purpose: "site_builder_copy_capability_pilot";
  quotaMode: "limited";
  quotaCapPoints: number;
  remainingQuotaPoints: number;
  maximumQuotaPointsPerWire: number;
  reservedQuotaPoints: number;
  scopeExact: true;
  repairPayloadPolicy: "bounded_structured_prior_output_64k";
  executions: readonly CopyRealCapabilityExecutionScope[];
  channels: readonly {
    alias: string;
    protocol: ModelProtocol;
    channelId: number;
  }[];
  resolverId: string;
}

export interface CopyPilotSettlementObserver {
  schemaVersion: "site-builder-copy-pilot-settlement-observer/2026-08-06-v2";
  resolverId: string;
  status: "READY";
  observation: "request_bound_new_api_consume_log";
  requestIdentityHeader: "x-oneapi-request-id";
  requiredObservationPerPhysicalCall: true;
  maximumPollDurationMs: number;
  unknownSettlementPolicy: "freeze_selected_child_campaign";
}

export interface CopyPilotAuthorizedChildSlot extends CopyPilotChildCampaignScope {
  campaignId: string;
  authorizationId: string;
  reservationId: string;
  ledgerIdentityDigest: string;
  reservedQuotaPoints: number;
}

export interface CopyPilotDispatchAuthorization {
  schemaVersion: "site-builder-copy-pilot-global-dispatch-authorization/2026-08-06-v2";
  authorizationId: string;
  status: "AUTHORIZED";
  issuedAt: string;
  expiresAt: string;
  manifestDigest: string;
  credentialAttestationDigest: string;
  settlementObserverDigest: string;
  reservationStatus: "RESERVED";
  maximumExecutions: 3;
  maximumWireCalls: 6;
  maximumRepairCallsPerExecution: 1;
  unknownSettlementPolicy: "freeze_selected_child_campaign";
  sharedDriftPolicy: "freeze_all_child_campaigns";
  children: readonly CopyPilotAuthorizedChildSlot[];
}

export interface CopyPilotChildDispatchAuthorization {
  schemaVersion: "site-builder-copy-pilot-child-dispatch-authorization/2026-08-06-v1";
  globalAuthorizationDigest: string;
  childSlotId: string;
  executionKey: string;
  campaignId: string;
  authorizationId: string;
  status: "AUTHORIZED";
  issuedAt: string;
  expiresAt: string;
  manifestDigest: string;
  credentialAttestationDigest: string;
  settlementObserverDigest: string;
  ledgerIdentityDigest: string;
  reservationId: string;
  reservationDigest: string;
  reservationStatus: "RESERVED";
  maximumExecutions: 1;
  maximumWireCalls: 2;
  maximumRepairCallsPerExecution: 1;
}

export interface CopyRealCapabilityAdmissionInput {
  manifest: CopyRealCapabilityManifest;
  sourceVerification: CopyRealCapabilitySourceVerification;
  credential: CopyPilotCredentialAttestation;
  settlement: CopyPilotSettlementObserver;
  authorization: CopyPilotDispatchAuthorization;
  childAuthorization: CopyPilotChildDispatchAuthorization;
  selectedExecutionKey: string;
}

export interface CopyRealCapabilityAdmissionValidation {
  schemaVersion: "site-builder-copy-real-capability-admission-validation/2026-08-06-v2";
  classification: "SOURCE_CONTRACT_VALIDATION_ONLY";
  dispatchCapable: false;
  taskId: "site_builder.copy";
  manifestDigest: string;
  fixedSourceCommit: string;
  credentialAttestationDigest: string;
  settlementObserverDigest: string;
  globalAuthorizationDigest: string;
  childAuthorizationDigest: string;
  selectedExecutionKey: string;
  childCampaignId: string;
  authorizationId: string;
  ledgerIdentityDigest: string;
  reservationId: string;
  reservationDigest: string;
  maximumExecutions: 1;
  maximumWireCalls: 2;
  globalMaximumExecutions: 3;
  globalMaximumWireCalls: 6;
  unknownSettlementPolicy: "freeze_selected_child_campaign";
  sharedDriftPolicy: "freeze_all_child_campaigns";
}

function fail(code: string): never {
  throw new Error(code);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function safePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function instant(value: string): number {
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail("COPY_REAL_CAPABILITY_PROOF_INVALID");
  }
  return milliseconds;
}

function validateLifetime(
  capturedAt: string,
  expiresAt: string,
  now: Date,
): void {
  const captured = instant(capturedAt);
  const expires = instant(expiresAt);
  if (
    captured > now.getTime() ||
    expires <= now.getTime() ||
    expires <= captured ||
    expires - captured > MAX_PROOF_LIFETIME_MS
  ) {
    fail("COPY_REAL_CAPABILITY_PROOF_EXPIRED");
  }
}

function validateGatewayOrigin(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail("COPY_REAL_CAPABILITY_CREDENTIAL_INVALID");
  }
  const loopbackHttp =
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !loopbackHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.origin !== value
  ) {
    fail("COPY_REAL_CAPABILITY_CREDENTIAL_INVALID");
  }
}

function exactExecutionScope(value: unknown): boolean {
  try {
    return canonicalDigest(value) === canonicalDigest(EXECUTIONS);
  } catch {
    return false;
  }
}

function validateManifest(
  manifest: CopyRealCapabilityManifest,
  source: CopyRealCapabilitySourceVerification,
): void {
  if (
    !exactKeys(manifest, [
      "schemaVersion",
      "manifestId",
      "fixedSourceCommit",
      "sourceBundleDigest",
      "planDigest",
      "dispatchAuthorization",
      "taskId",
      "plannedExecutions",
      "maximumWireCalls",
      "maximumRepairCallsPerExecution",
      "executions",
    ]) ||
    manifest.schemaVersion !==
      "site-builder-copy-real-capability-manifest/2026-08-05-v1" ||
    !IDENTIFIER.test(manifest.manifestId) ||
    !GIT_COMMIT.test(manifest.fixedSourceCommit) ||
    !SHA256.test(manifest.sourceBundleDigest) ||
    manifest.planDigest !== COPY_REAL_CAPABILITY_ADMISSION_SOURCE.planDigest ||
    manifest.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    manifest.taskId !== COPY_REAL_CAPABILITY_ADMISSION_SOURCE.taskId ||
    manifest.plannedExecutions !== 3 ||
    manifest.maximumWireCalls !== 6 ||
    manifest.maximumRepairCallsPerExecution !== 1 ||
    !exactExecutionScope(manifest.executions)
  ) {
    fail("COPY_REAL_CAPABILITY_MANIFEST_INVALID");
  }
  if (manifest.fixedSourceCommit !== source.fixedSourceCommit) {
    fail("COPY_REAL_CAPABILITY_FIXED_COMMIT_MISMATCH");
  }
  if (
    !exactKeys(source, [
      "fixedSourceCommit",
      "sourceBundleDigest",
      "fixedCommitReachableFromExecutionHead",
      "trackedSourceBytesMatch",
      "compiledContractsMatch",
    ]) ||
    manifest.sourceBundleDigest !== source.sourceBundleDigest ||
    !source.fixedCommitReachableFromExecutionHead ||
    !source.trackedSourceBytesMatch ||
    !source.compiledContractsMatch
  ) {
    fail("COPY_REAL_CAPABILITY_SOURCE_BUNDLE_UNVERIFIED");
  }
}

function validateCredential(
  credential: CopyPilotCredentialAttestation,
  now: Date,
): void {
  if (
    !exactKeys(credential, [
      "schemaVersion",
      "attestationId",
      "capturedAt",
      "expiresAt",
      "gatewayOrigin",
      "bearerTokenSha256",
      "purpose",
      "quotaMode",
      "quotaCapPoints",
      "remainingQuotaPoints",
      "maximumQuotaPointsPerWire",
      "reservedQuotaPoints",
      "scopeExact",
      "repairPayloadPolicy",
      "executions",
      "channels",
      "resolverId",
    ]) ||
    credential.schemaVersion !==
      "site-builder-copy-pilot-credential-attestation/2026-08-05-v3" ||
    !IDENTIFIER.test(credential.attestationId) ||
    !IDENTIFIER.test(credential.resolverId) ||
    !SHA256.test(credential.bearerTokenSha256) ||
    credential.purpose !== "site_builder_copy_capability_pilot" ||
    credential.quotaMode !== "limited" ||
    credential.scopeExact !== true ||
    credential.repairPayloadPolicy !== "bounded_structured_prior_output_64k" ||
    !safePositiveInteger(credential.quotaCapPoints) ||
    !safePositiveInteger(credential.remainingQuotaPoints) ||
    !safePositiveInteger(credential.maximumQuotaPointsPerWire) ||
    !safePositiveInteger(credential.reservedQuotaPoints) ||
    credential.reservedQuotaPoints !==
      credential.maximumQuotaPointsPerWire *
        COPY_CAPABILITY_PILOT_PLAN.maximumWireCalls ||
    !Number.isSafeInteger(credential.reservedQuotaPoints) ||
    credential.remainingQuotaPoints > credential.quotaCapPoints ||
    credential.remainingQuotaPoints < credential.reservedQuotaPoints ||
    credential.quotaCapPoints < credential.reservedQuotaPoints
  ) {
    fail("COPY_REAL_CAPABILITY_CREDENTIAL_INVALID");
  }
  validateGatewayOrigin(credential.gatewayOrigin);
  validateLifetime(credential.capturedAt, credential.expiresAt, now);
  if (!exactExecutionScope(credential.executions)) {
    fail("COPY_REAL_CAPABILITY_SCOPE_MISMATCH");
  }
  if (
    credential.channels.length !== EXECUTIONS.length ||
    credential.channels.some(
      (channel, index) =>
        channel.alias !== EXECUTIONS[index]?.alias ||
        channel.protocol !== EXECUTIONS[index]?.protocol ||
        !safePositiveInteger(channel.channelId),
    )
  ) {
    fail("COPY_REAL_CAPABILITY_SCOPE_MISMATCH");
  }
}

function validateSettlement(
  settlement: CopyPilotSettlementObserver,
  credential: CopyPilotCredentialAttestation,
): void {
  if (
    !exactKeys(settlement, [
      "schemaVersion",
      "resolverId",
      "status",
      "observation",
      "requestIdentityHeader",
      "requiredObservationPerPhysicalCall",
      "maximumPollDurationMs",
      "unknownSettlementPolicy",
    ]) ||
    settlement.schemaVersion !==
      "site-builder-copy-pilot-settlement-observer/2026-08-06-v2" ||
    settlement.resolverId !== credential.resolverId ||
    settlement.status !== "READY" ||
    settlement.observation !== "request_bound_new_api_consume_log" ||
    settlement.requestIdentityHeader !== "x-oneapi-request-id" ||
    settlement.requiredObservationPerPhysicalCall !== true ||
    !safePositiveInteger(settlement.maximumPollDurationMs) ||
    settlement.maximumPollDurationMs > MAX_SETTLEMENT_POLL_MS ||
    settlement.unknownSettlementPolicy !== "freeze_selected_child_campaign"
  ) {
    fail("COPY_REAL_CAPABILITY_SETTLEMENT_UNAVAILABLE");
  }
}

function validChildShape(
  child: CopyPilotAuthorizedChildSlot,
  expected: CopyPilotChildCampaignScope,
  expectedReservation: number,
): boolean {
  return (
    exactKeys(child, [
      "childSlotId",
      "executionKey",
      "alias",
      "protocol",
      "reasoning",
      "maximumExecutions",
      "maximumWireCalls",
      "maximumRepairCallsPerExecution",
      "unknownSettlementPolicy",
      "sharedDriftPolicy",
      "campaignId",
      "authorizationId",
      "reservationId",
      "ledgerIdentityDigest",
      "reservedQuotaPoints",
    ]) &&
    child.childSlotId === expected.childSlotId &&
    child.executionKey === expected.executionKey &&
    child.alias === expected.alias &&
    child.protocol === expected.protocol &&
    child.reasoning === expected.reasoning &&
    child.maximumExecutions === 1 &&
    child.maximumWireCalls === 2 &&
    child.maximumRepairCallsPerExecution === 1 &&
    child.unknownSettlementPolicy === "freeze_selected_child_campaign" &&
    child.sharedDriftPolicy === "freeze_all_child_campaigns" &&
    IDENTIFIER.test(child.campaignId) &&
    IDENTIFIER.test(child.authorizationId) &&
    IDENTIFIER.test(child.reservationId) &&
    SHA256.test(child.ledgerIdentityDigest) &&
    child.reservedQuotaPoints === expectedReservation
  );
}

function validateAuthorization(
  authorization: CopyPilotDispatchAuthorization,
  input: CopyRealCapabilityAdmissionInput,
  now: Date,
): void {
  if (
    !exactKeys(authorization, [
      "schemaVersion",
      "authorizationId",
      "status",
      "issuedAt",
      "expiresAt",
      "manifestDigest",
      "credentialAttestationDigest",
      "settlementObserverDigest",
      "reservationStatus",
      "maximumExecutions",
      "maximumWireCalls",
      "maximumRepairCallsPerExecution",
      "unknownSettlementPolicy",
      "sharedDriftPolicy",
      "children",
    ]) ||
    authorization.schemaVersion !==
      "site-builder-copy-pilot-global-dispatch-authorization/2026-08-06-v2" ||
    !IDENTIFIER.test(authorization.authorizationId) ||
    authorization.status !== "AUTHORIZED" ||
    authorization.reservationStatus !== "RESERVED" ||
    authorization.maximumExecutions !== 3 ||
    authorization.maximumWireCalls !== 6 ||
    authorization.maximumRepairCallsPerExecution !== 1 ||
    authorization.unknownSettlementPolicy !==
      "freeze_selected_child_campaign" ||
    authorization.sharedDriftPolicy !== "freeze_all_child_campaigns" ||
    authorization.manifestDigest !== canonicalDigest(input.manifest) ||
    authorization.credentialAttestationDigest !==
      canonicalDigest(input.credential) ||
    authorization.settlementObserverDigest !== canonicalDigest(input.settlement)
  ) {
    fail("COPY_REAL_CAPABILITY_AUTHORIZATION_MISMATCH");
  }
  validateLifetime(authorization.issuedAt, authorization.expiresAt, now);
  if (instant(authorization.expiresAt) > instant(input.credential.expiresAt)) {
    fail("COPY_REAL_CAPABILITY_AUTHORIZATION_MISMATCH");
  }
  const expectedReservation = input.credential.maximumQuotaPointsPerWire * 2;
  const unique = <T>(values: readonly T[]) =>
    new Set(values).size === values.length;
  if (
    authorization.children.length !== CHILD_CAMPAIGNS.length ||
    authorization.children.some(
      (child, index) =>
        !validChildShape(child, CHILD_CAMPAIGNS[index]!, expectedReservation),
    ) ||
    !unique(authorization.children.map(({ childSlotId }) => childSlotId)) ||
    !unique(authorization.children.map(({ executionKey }) => executionKey)) ||
    !unique(authorization.children.map(({ campaignId }) => campaignId)) ||
    !unique(
      authorization.children.map(({ authorizationId }) => authorizationId),
    ) ||
    !unique(authorization.children.map(({ reservationId }) => reservationId)) ||
    !unique(
      authorization.children.map(
        ({ ledgerIdentityDigest }) => ledgerIdentityDigest,
      ),
    ) ||
    authorization.children.reduce(
      (total, child) => total + child.reservedQuotaPoints,
      0,
    ) !== input.credential.reservedQuotaPoints
  ) {
    fail("COPY_REAL_CAPABILITY_GLOBAL_CHILDREN_MISMATCH");
  }
}

export function copyPilotChildReservationDigest(
  authorization: Omit<CopyPilotChildDispatchAuthorization, "reservationDigest">,
): string {
  return CANONICAL_DIGEST({
    bindingSchemaVersion: "copy-pilot-child-reservation-binding/2026-08-06-v1",
    authorization,
  });
}

function validateChildAuthorization(
  input: CopyRealCapabilityAdmissionInput,
  now: Date,
): void {
  const child = input.childAuthorization;
  const globalDigest = canonicalDigest(input.authorization);
  const slot = input.authorization.children.find(
    ({ executionKey }) => executionKey === input.selectedExecutionKey,
  );
  if (
    !slot ||
    !exactKeys(child, [
      "schemaVersion",
      "globalAuthorizationDigest",
      "childSlotId",
      "executionKey",
      "campaignId",
      "authorizationId",
      "status",
      "issuedAt",
      "expiresAt",
      "manifestDigest",
      "credentialAttestationDigest",
      "settlementObserverDigest",
      "ledgerIdentityDigest",
      "reservationId",
      "reservationDigest",
      "reservationStatus",
      "maximumExecutions",
      "maximumWireCalls",
      "maximumRepairCallsPerExecution",
    ]) ||
    child.schemaVersion !==
      "site-builder-copy-pilot-child-dispatch-authorization/2026-08-06-v1" ||
    child.globalAuthorizationDigest !== globalDigest ||
    child.childSlotId !== slot.childSlotId ||
    child.executionKey !== slot.executionKey ||
    child.campaignId !== slot.campaignId ||
    child.authorizationId !== slot.authorizationId ||
    child.status !== "AUTHORIZED" ||
    child.issuedAt !== input.authorization.issuedAt ||
    child.expiresAt !== input.authorization.expiresAt ||
    child.manifestDigest !== input.authorization.manifestDigest ||
    child.credentialAttestationDigest !==
      input.authorization.credentialAttestationDigest ||
    child.settlementObserverDigest !==
      input.authorization.settlementObserverDigest ||
    child.ledgerIdentityDigest !== slot.ledgerIdentityDigest ||
    child.reservationId !== slot.reservationId ||
    child.reservationStatus !== "RESERVED" ||
    child.maximumExecutions !== 1 ||
    child.maximumWireCalls !== 2 ||
    child.maximumRepairCallsPerExecution !== 1
  ) {
    fail("COPY_REAL_CAPABILITY_CHILD_AUTHORIZATION_MISMATCH");
  }
  const { reservationDigest, ...withoutReservationDigest } = child;
  if (
    !SHA256.test(reservationDigest) ||
    reservationDigest !==
      copyPilotChildReservationDigest(withoutReservationDigest)
  ) {
    fail("COPY_REAL_CAPABILITY_CHILD_AUTHORIZATION_MISMATCH");
  }
  validateLifetime(child.issuedAt, child.expiresAt, now);
}

/** Pure admission boundary. It never reads secrets or dispatches a request. */
export function validateCopyRealCapabilityAdmissionEnvelope(
  input: CopyRealCapabilityAdmissionInput,
  now: Date = new Date(),
): CopyRealCapabilityAdmissionValidation {
  validateManifest(input.manifest, input.sourceVerification);
  validateCredential(input.credential, now);
  validateSettlement(input.settlement, input.credential);
  validateAuthorization(input.authorization, input, now);
  validateChildAuthorization(input, now);

  return Object.freeze({
    schemaVersion:
      "site-builder-copy-real-capability-admission-validation/2026-08-06-v2" as const,
    classification: "SOURCE_CONTRACT_VALIDATION_ONLY" as const,
    dispatchCapable: false as const,
    taskId: "site_builder.copy" as const,
    manifestDigest: canonicalDigest(input.manifest),
    fixedSourceCommit: input.manifest.fixedSourceCommit,
    credentialAttestationDigest: canonicalDigest(input.credential),
    settlementObserverDigest: canonicalDigest(input.settlement),
    globalAuthorizationDigest: canonicalDigest(input.authorization),
    childAuthorizationDigest: canonicalDigest(input.childAuthorization),
    selectedExecutionKey: input.selectedExecutionKey,
    childCampaignId: input.childAuthorization.campaignId,
    authorizationId: input.childAuthorization.authorizationId,
    ledgerIdentityDigest: input.childAuthorization.ledgerIdentityDigest,
    reservationId: input.childAuthorization.reservationId,
    reservationDigest: input.childAuthorization.reservationDigest,
    maximumExecutions: 1 as const,
    maximumWireCalls: 2 as const,
    globalMaximumExecutions: 3 as const,
    globalMaximumWireCalls: 6 as const,
    unknownSettlementPolicy: "freeze_selected_child_campaign" as const,
    sharedDriftPolicy: "freeze_all_child_campaigns" as const,
  });
}
