import { canonicalDigest } from "../../model-runtime/context-engine";
import type { ModelProtocol, ReasoningLevel } from "../../model-runtime/types";
import {
  COPY_SONNET_RECOVERY_EXECUTION,
  COPY_SONNET_RECOVERY_PLAN,
  COPY_SONNET_RECOVERY_PLAN_DIGEST,
  COPY_SONNET_RECOVERY_RUNTIME_MANIFEST_ID,
  COPY_SONNET_RECOVERY_V16_IDENTITY_PREFIXES,
} from "./copy-sonnet-recovery-contract";

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,191}$/u;
const MAX_PROOF_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_SETTLEMENT_POLL_MS = 30_000;
const CANONICAL_DIGEST = canonicalDigest;

function versionedIdentity(value: string, prefix: string): boolean {
  return (
    IDENTIFIER.test(value) &&
    value.length > prefix.length &&
    value.startsWith(prefix)
  );
}

export interface CopySonnetRecoveryExecutionScope {
  executionKey: string;
  sourcePilotExecutionKey: string;
  alias: string;
  protocol: ModelProtocol;
  reasoning: ReasoningLevel;
}

export interface CopySonnetRecoveryChildCampaignScope extends CopySonnetRecoveryExecutionScope {
  childSlotId: string;
  maximumExecutions: 1;
  maximumWireCalls: 2;
  maximumRepairCallsPerExecution: 1;
  unknownSettlementPolicy: "freeze_selected_child_campaign";
  sharedDriftPolicy: "freeze_selected_child_campaign";
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

const EXECUTIONS = Object.freeze([
  Object.freeze({ ...COPY_SONNET_RECOVERY_EXECUTION }),
] as const);
const CHILD_CAMPAIGN = Object.freeze({
  ...COPY_SONNET_RECOVERY_EXECUTION,
  childSlotId: "copy-sonnet-recovery-v16-child-claude-sonnet-5",
  maximumExecutions: 1 as const,
  maximumWireCalls: 2 as const,
  maximumRepairCallsPerExecution: 1 as const,
  unknownSettlementPolicy: "freeze_selected_child_campaign" as const,
  sharedDriftPolicy: "freeze_selected_child_campaign" as const,
});

export const COPY_SONNET_RECOVERY_ADMISSION_SOURCE = deepFreeze({
  schemaVersion:
    "site-builder-copy-sonnet-recovery-admission-source/2026-08-08-v1" as const,
  taskId: "site_builder.copy" as const,
  planId: COPY_SONNET_RECOVERY_PLAN.planId,
  planDigest: COPY_SONNET_RECOVERY_PLAN_DIGEST,
  dispatchAuthorization: "NOT_AUTHORIZED" as const,
  observedModelWireCalls: 0 as const,
  observedModelCost: { CNY: 0 as const, USD: 0 as const },
  plannedExecutions: 1 as const,
  maximumWireCalls: 2 as const,
  maximumRepairCallsPerExecution: 1 as const,
  unknownSettlementPolicy: "freeze_selected_child_campaign" as const,
  sharedDriftPolicy: "freeze_selected_child_campaign" as const,
  executions: EXECUTIONS,
  childCampaign: CHILD_CAMPAIGN,
});

export interface CopySonnetRecoveryRuntimeManifest {
  schemaVersion: "site-builder-copy-sonnet-recovery-runtime-manifest/2026-08-08-v1";
  manifestId: string;
  recoveryManifestArtifactDigest: string;
  recoveryManifestDigest: string;
  fixedSourceCommit: string;
  sourceBundleDigest: string;
  planDigest: string;
  dispatchAuthorization: "NOT_AUTHORIZED";
  taskId: "site_builder.copy";
  plannedExecutions: 1;
  maximumWireCalls: 2;
  maximumRepairCallsPerExecution: 1;
  executions: readonly CopySonnetRecoveryExecutionScope[];
}

export interface CopySonnetRecoverySourceVerification {
  fixedSourceCommit: string;
  sourceBundleDigest: string;
  fixedCommitReachableFromExecutionHead: boolean;
  trackedSourceBytesMatch: boolean;
  compiledContractsMatch: boolean;
}

export interface CopySonnetRecoveryCredentialAttestation {
  schemaVersion: "site-builder-copy-sonnet-recovery-credential-attestation/2026-08-08-v1";
  attestationId: string;
  capturedAt: string;
  expiresAt: string;
  gatewayOrigin: string;
  bearerTokenSha256: string;
  purpose: "site_builder_copy_sonnet_recovery";
  quotaMode: "limited";
  quotaCapPoints: number;
  remainingQuotaPoints: number;
  maximumQuotaPointsPerWire: number;
  reservedQuotaPoints: number;
  scopeExact: true;
  repairPayloadPolicy: "bounded_structured_prior_output_64k";
  executions: readonly CopySonnetRecoveryExecutionScope[];
  channels: readonly {
    alias: string;
    protocol: ModelProtocol;
    channelId: number;
  }[];
  resolverId: string;
}

export interface CopySonnetRecoverySettlementObserver {
  schemaVersion: "site-builder-copy-sonnet-recovery-settlement-observer/2026-08-08-v1";
  resolverId: string;
  status: "READY";
  observation: "request_bound_new_api_consume_log";
  requestIdentityHeader: "x-oneapi-request-id";
  requiredObservationPerPhysicalCall: true;
  maximumPollDurationMs: number;
  unknownSettlementPolicy: "freeze_selected_child_campaign";
}

export interface CopySonnetRecoveryAuthorizedChildSlot extends CopySonnetRecoveryChildCampaignScope {
  campaignId: string;
  authorizationId: string;
  reservationId: string;
  ledgerIdentityDigest: string;
  reservedQuotaPoints: number;
}

export interface CopySonnetRecoveryDispatchAuthorization {
  schemaVersion: "site-builder-copy-sonnet-recovery-dispatch-authorization/2026-08-08-v1";
  authorizationId: string;
  status: "AUTHORIZED";
  issuedAt: string;
  expiresAt: string;
  manifestDigest: string;
  credentialAttestationDigest: string;
  settlementObserverDigest: string;
  reservationStatus: "RESERVED";
  maximumExecutions: 1;
  maximumWireCalls: 2;
  maximumRepairCallsPerExecution: 1;
  unknownSettlementPolicy: "freeze_selected_child_campaign";
  sharedDriftPolicy: "freeze_selected_child_campaign";
  children: readonly CopySonnetRecoveryAuthorizedChildSlot[];
}

export interface CopySonnetRecoveryChildDispatchAuthorization {
  schemaVersion: "site-builder-copy-sonnet-recovery-child-dispatch-authorization/2026-08-08-v1";
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

export interface CopySonnetRecoveryAdmissionInput {
  manifest: CopySonnetRecoveryRuntimeManifest;
  sourceVerification: CopySonnetRecoverySourceVerification;
  credential: CopySonnetRecoveryCredentialAttestation;
  settlement: CopySonnetRecoverySettlementObserver;
  authorization: CopySonnetRecoveryDispatchAuthorization;
  childAuthorization: CopySonnetRecoveryChildDispatchAuthorization;
  selectedExecutionKey: string;
}

export interface CopySonnetRecoveryAdmissionValidation {
  schemaVersion: "site-builder-copy-sonnet-recovery-admission-validation/2026-08-08-v1";
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
  globalMaximumExecutions: 1;
  globalMaximumWireCalls: 2;
  unknownSettlementPolicy: "freeze_selected_child_campaign";
  sharedDriftPolicy: "freeze_selected_child_campaign";
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
    fail("COPY_SONNET_RECOVERY_PROOF_INVALID");
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
    fail("COPY_SONNET_RECOVERY_PROOF_EXPIRED");
  }
}

function validateGatewayOrigin(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail("COPY_SONNET_RECOVERY_CREDENTIAL_INVALID");
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
    fail("COPY_SONNET_RECOVERY_CREDENTIAL_INVALID");
  }
}

function exactExecutionScope(value: unknown): boolean {
  try {
    return CANONICAL_DIGEST(value) === CANONICAL_DIGEST(EXECUTIONS);
  } catch {
    return false;
  }
}

function validateManifest(
  manifest: CopySonnetRecoveryRuntimeManifest,
  source: CopySonnetRecoverySourceVerification,
): void {
  if (
    !exactKeys(manifest, [
      "schemaVersion",
      "manifestId",
      "recoveryManifestArtifactDigest",
      "recoveryManifestDigest",
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
      "site-builder-copy-sonnet-recovery-runtime-manifest/2026-08-08-v1" ||
    manifest.manifestId !== COPY_SONNET_RECOVERY_RUNTIME_MANIFEST_ID ||
    !SHA256.test(manifest.recoveryManifestArtifactDigest) ||
    !SHA256.test(manifest.recoveryManifestDigest) ||
    !GIT_COMMIT.test(manifest.fixedSourceCommit) ||
    !SHA256.test(manifest.sourceBundleDigest) ||
    manifest.planDigest !== COPY_SONNET_RECOVERY_ADMISSION_SOURCE.planDigest ||
    manifest.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    manifest.taskId !== "site_builder.copy" ||
    manifest.plannedExecutions !== 1 ||
    manifest.maximumWireCalls !== 2 ||
    manifest.maximumRepairCallsPerExecution !== 1 ||
    !exactExecutionScope(manifest.executions)
  ) {
    fail("COPY_SONNET_RECOVERY_MANIFEST_INVALID");
  }
  if (manifest.fixedSourceCommit !== source.fixedSourceCommit) {
    fail("COPY_SONNET_RECOVERY_FIXED_COMMIT_MISMATCH");
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
    fail("COPY_SONNET_RECOVERY_SOURCE_BUNDLE_UNVERIFIED");
  }
}

function validateCredential(
  credential: CopySonnetRecoveryCredentialAttestation,
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
      "site-builder-copy-sonnet-recovery-credential-attestation/2026-08-08-v1" ||
    !IDENTIFIER.test(credential.attestationId) ||
    !IDENTIFIER.test(credential.resolverId) ||
    !SHA256.test(credential.bearerTokenSha256) ||
    credential.purpose !== "site_builder_copy_sonnet_recovery" ||
    credential.quotaMode !== "limited" ||
    credential.scopeExact !== true ||
    credential.repairPayloadPolicy !== "bounded_structured_prior_output_64k" ||
    !safePositiveInteger(credential.quotaCapPoints) ||
    !safePositiveInteger(credential.remainingQuotaPoints) ||
    !safePositiveInteger(credential.maximumQuotaPointsPerWire) ||
    !safePositiveInteger(credential.reservedQuotaPoints) ||
    credential.reservedQuotaPoints !==
      credential.maximumQuotaPointsPerWire * 2 ||
    credential.remainingQuotaPoints > credential.quotaCapPoints ||
    credential.remainingQuotaPoints < credential.reservedQuotaPoints
  ) {
    fail("COPY_SONNET_RECOVERY_CREDENTIAL_INVALID");
  }
  validateGatewayOrigin(credential.gatewayOrigin);
  validateLifetime(credential.capturedAt, credential.expiresAt, now);
  if (!exactExecutionScope(credential.executions)) {
    fail("COPY_SONNET_RECOVERY_SCOPE_MISMATCH");
  }
  const expected = EXECUTIONS[0]!;
  if (
    credential.channels.length !== 1 ||
    credential.channels[0]?.alias !== expected.alias ||
    credential.channels[0]?.protocol !== expected.protocol ||
    !safePositiveInteger(credential.channels[0]?.channelId)
  ) {
    fail("COPY_SONNET_RECOVERY_SCOPE_MISMATCH");
  }
}

function validateSettlement(
  settlement: CopySonnetRecoverySettlementObserver,
  credential: CopySonnetRecoveryCredentialAttestation,
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
      "site-builder-copy-sonnet-recovery-settlement-observer/2026-08-08-v1" ||
    settlement.resolverId !== credential.resolverId ||
    settlement.status !== "READY" ||
    settlement.observation !== "request_bound_new_api_consume_log" ||
    settlement.requestIdentityHeader !== "x-oneapi-request-id" ||
    settlement.requiredObservationPerPhysicalCall !== true ||
    !safePositiveInteger(settlement.maximumPollDurationMs) ||
    settlement.maximumPollDurationMs > MAX_SETTLEMENT_POLL_MS ||
    settlement.unknownSettlementPolicy !== "freeze_selected_child_campaign"
  ) {
    fail("COPY_SONNET_RECOVERY_SETTLEMENT_UNAVAILABLE");
  }
}

function validChildShape(
  child: CopySonnetRecoveryAuthorizedChildSlot,
  expectedReservation: number,
): boolean {
  const expected = CHILD_CAMPAIGN;
  return (
    exactKeys(child, [
      "executionKey",
      "sourcePilotExecutionKey",
      "alias",
      "protocol",
      "reasoning",
      "childSlotId",
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
    CANONICAL_DIGEST({
      executionKey: child.executionKey,
      sourcePilotExecutionKey: child.sourcePilotExecutionKey,
      alias: child.alias,
      protocol: child.protocol,
      reasoning: child.reasoning,
      childSlotId: child.childSlotId,
      maximumExecutions: child.maximumExecutions,
      maximumWireCalls: child.maximumWireCalls,
      maximumRepairCallsPerExecution: child.maximumRepairCallsPerExecution,
      unknownSettlementPolicy: child.unknownSettlementPolicy,
      sharedDriftPolicy: child.sharedDriftPolicy,
    }) === CANONICAL_DIGEST(expected) &&
    versionedIdentity(
      child.campaignId,
      COPY_SONNET_RECOVERY_V16_IDENTITY_PREFIXES.campaignId,
    ) &&
    versionedIdentity(
      child.authorizationId,
      COPY_SONNET_RECOVERY_V16_IDENTITY_PREFIXES.childAuthorizationId,
    ) &&
    versionedIdentity(
      child.reservationId,
      COPY_SONNET_RECOVERY_V16_IDENTITY_PREFIXES.reservationId,
    ) &&
    SHA256.test(child.ledgerIdentityDigest) &&
    child.reservedQuotaPoints === expectedReservation
  );
}

function validateAuthorization(
  authorization: CopySonnetRecoveryDispatchAuthorization,
  input: CopySonnetRecoveryAdmissionInput,
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
      "site-builder-copy-sonnet-recovery-dispatch-authorization/2026-08-08-v1" ||
    !versionedIdentity(
      authorization.authorizationId,
      COPY_SONNET_RECOVERY_V16_IDENTITY_PREFIXES.globalAuthorizationId,
    ) ||
    authorization.status !== "AUTHORIZED" ||
    authorization.reservationStatus !== "RESERVED" ||
    authorization.maximumExecutions !== 1 ||
    authorization.maximumWireCalls !== 2 ||
    authorization.maximumRepairCallsPerExecution !== 1 ||
    authorization.unknownSettlementPolicy !==
      "freeze_selected_child_campaign" ||
    authorization.sharedDriftPolicy !== "freeze_selected_child_campaign" ||
    authorization.manifestDigest !== CANONICAL_DIGEST(input.manifest) ||
    authorization.credentialAttestationDigest !==
      CANONICAL_DIGEST(input.credential) ||
    authorization.settlementObserverDigest !==
      CANONICAL_DIGEST(input.settlement)
  ) {
    fail("COPY_SONNET_RECOVERY_AUTHORIZATION_MISMATCH");
  }
  validateLifetime(authorization.issuedAt, authorization.expiresAt, now);
  if (instant(authorization.expiresAt) > instant(input.credential.expiresAt)) {
    fail("COPY_SONNET_RECOVERY_AUTHORIZATION_MISMATCH");
  }
  const expectedReservation = input.credential.maximumQuotaPointsPerWire * 2;
  if (
    authorization.children.length !== 1 ||
    !validChildShape(authorization.children[0]!, expectedReservation) ||
    authorization.children[0]?.reservedQuotaPoints !==
      input.credential.reservedQuotaPoints
  ) {
    fail("COPY_SONNET_RECOVERY_CHILD_SCOPE_MISMATCH");
  }
}

export function copySonnetRecoveryReservationDigest(
  authorization: Omit<
    CopySonnetRecoveryChildDispatchAuthorization,
    "reservationDigest"
  >,
): string {
  return CANONICAL_DIGEST({
    bindingSchemaVersion:
      "copy-sonnet-recovery-child-reservation-binding/2026-08-08-v1",
    authorization,
  });
}

function validateChildAuthorization(
  input: CopySonnetRecoveryAdmissionInput,
  now: Date,
): void {
  const child = input.childAuthorization;
  const globalDigest = CANONICAL_DIGEST(input.authorization);
  const slot = input.authorization.children[0];
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
      "site-builder-copy-sonnet-recovery-child-dispatch-authorization/2026-08-08-v1" ||
    child.globalAuthorizationDigest !== globalDigest ||
    child.childSlotId !== slot.childSlotId ||
    child.executionKey !== slot.executionKey ||
    !versionedIdentity(
      child.campaignId,
      COPY_SONNET_RECOVERY_V16_IDENTITY_PREFIXES.campaignId,
    ) ||
    !versionedIdentity(
      child.authorizationId,
      COPY_SONNET_RECOVERY_V16_IDENTITY_PREFIXES.childAuthorizationId,
    ) ||
    !versionedIdentity(
      child.reservationId,
      COPY_SONNET_RECOVERY_V16_IDENTITY_PREFIXES.reservationId,
    ) ||
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
    child.maximumRepairCallsPerExecution !== 1 ||
    input.selectedExecutionKey !== slot.executionKey
  ) {
    fail("COPY_SONNET_RECOVERY_CHILD_AUTHORIZATION_MISMATCH");
  }
  const { reservationDigest, ...withoutReservationDigest } = child;
  if (
    !SHA256.test(reservationDigest) ||
    reservationDigest !==
      copySonnetRecoveryReservationDigest(withoutReservationDigest)
  ) {
    fail("COPY_SONNET_RECOVERY_CHILD_AUTHORIZATION_MISMATCH");
  }
  validateLifetime(child.issuedAt, child.expiresAt, now);
}

/** Pure admission boundary. It never reads secrets or dispatches a request. */
export function validateCopySonnetRecoveryAdmissionEnvelope(
  input: CopySonnetRecoveryAdmissionInput,
  now: Date = new Date(),
): CopySonnetRecoveryAdmissionValidation {
  validateManifest(input.manifest, input.sourceVerification);
  validateCredential(input.credential, now);
  validateSettlement(input.settlement, input.credential);
  validateAuthorization(input.authorization, input, now);
  validateChildAuthorization(input, now);

  return Object.freeze({
    schemaVersion:
      "site-builder-copy-sonnet-recovery-admission-validation/2026-08-08-v1" as const,
    classification: "SOURCE_CONTRACT_VALIDATION_ONLY" as const,
    dispatchCapable: false as const,
    taskId: "site_builder.copy" as const,
    manifestDigest: CANONICAL_DIGEST(input.manifest),
    fixedSourceCommit: input.manifest.fixedSourceCommit,
    credentialAttestationDigest: CANONICAL_DIGEST(input.credential),
    settlementObserverDigest: CANONICAL_DIGEST(input.settlement),
    globalAuthorizationDigest: CANONICAL_DIGEST(input.authorization),
    childAuthorizationDigest: CANONICAL_DIGEST(input.childAuthorization),
    selectedExecutionKey: input.selectedExecutionKey,
    childCampaignId: input.childAuthorization.campaignId,
    authorizationId: input.childAuthorization.authorizationId,
    ledgerIdentityDigest: input.childAuthorization.ledgerIdentityDigest,
    reservationId: input.childAuthorization.reservationId,
    reservationDigest: input.childAuthorization.reservationDigest,
    maximumExecutions: 1 as const,
    maximumWireCalls: 2 as const,
    globalMaximumExecutions: 1 as const,
    globalMaximumWireCalls: 2 as const,
    unknownSettlementPolicy: "freeze_selected_child_campaign" as const,
    sharedDriftPolicy: "freeze_selected_child_campaign" as const,
  });
}
