import { canonicalDigest } from "../../model-runtime/context-engine";
import type { ModelProtocol, ReasoningLevel } from "../../model-runtime/types";
import { COPY_EVALUATION_V2_CANDIDATES } from "./copy-evaluation-v2-candidates";
import { COPY_QUALITY_MATRIX_PLAN } from "./copy-quality-matrix-runner";

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,191}$/u;
const MAX_PROOF_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_SETTLEMENT_POLL_MS = 30_000;
const MATRIX_PURPOSE = "site_builder_copy_quality_matrix" as const;
const UNKNOWN_SETTLEMENT_POLICY = "freeze_matrix_and_stop_dispatch" as const;
const MAXIMUM_EXECUTIONS = 36 as const;
const MAXIMUM_WIRE_CALLS = 72 as const;
const MAXIMUM_REPAIRS = 1 as const;
const CANONICAL_DIGEST = canonicalDigest;

export interface CopyQualityMatrixExecutionScope {
  executionKey: string;
  alias: string;
  protocol: ModelProtocol;
  reasoning: ReasoningLevel;
  fixtureId: string;
  repeatIndex: number;
}

export interface CopyQualityMatrixCandidateScope {
  alias: string;
  protocol: ModelProtocol;
  reasoning: ReasoningLevel;
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

const EXECUTIONS: readonly CopyQualityMatrixExecutionScope[] =
  COPY_QUALITY_MATRIX_PLAN.executions.map(
    ({ executionKey, alias, protocol, reasoning, fixtureId, repeatIndex }) => ({
      executionKey,
      alias,
      protocol,
      reasoning,
      fixtureId,
      repeatIndex,
    }),
  );
const CANDIDATES: readonly CopyQualityMatrixCandidateScope[] =
  COPY_EVALUATION_V2_CANDIDATES.map(({ alias, protocol, reasoning }) => ({
    alias,
    protocol,
    reasoning,
  }));

function assertCanonicalMatrixPlan(): void {
  const executionKeys = EXECUTIONS.map(({ executionKey }) => executionKey);
  const executionTuples = EXECUTIONS.map(
    ({ alias, protocol, reasoning, fixtureId, repeatIndex }) =>
      `${alias}:${protocol}:${reasoning}:${fixtureId}:${repeatIndex}`,
  );
  const expectedExecutionKeys = [
    "alias",
    "executionKey",
    "fixtureId",
    "protocol",
    "reasoning",
    "repeatIndex",
  ];
  if (
    COPY_QUALITY_MATRIX_PLAN.schemaVersion !==
      "site-builder-copy-quality-matrix-plan/2026-08-06-v1" ||
    COPY_QUALITY_MATRIX_PLAN.planId !==
      "site-builder-copy-quality-matrix/2026-08-06-v1" ||
    COPY_QUALITY_MATRIX_PLAN.taskId !== "site_builder.copy" ||
    COPY_QUALITY_MATRIX_PLAN.plannedExecutions !== MAXIMUM_EXECUTIONS ||
    COPY_QUALITY_MATRIX_PLAN.maximumWireCalls !== MAXIMUM_WIRE_CALLS ||
    COPY_QUALITY_MATRIX_PLAN.maximumRepairCallsPerExecution !==
      MAXIMUM_REPAIRS ||
    COPY_QUALITY_MATRIX_PLAN.settlementPolicy !==
      "known_per_physical_call_required" ||
    EXECUTIONS.length !== MAXIMUM_EXECUTIONS ||
    new Set(executionKeys).size !== EXECUTIONS.length ||
    new Set(executionTuples).size !== EXECUTIONS.length ||
    CANDIDATES.some(
      ({ alias }) =>
        EXECUTIONS.filter((execution) => execution.alias === alias).length !==
        MAXIMUM_EXECUTIONS / CANDIDATES.length,
    ) ||
    EXECUTIONS.some(
      (execution) =>
        JSON.stringify(Object.keys(execution).sort()) !==
          JSON.stringify(expectedExecutionKeys) ||
        !IDENTIFIER.test(execution.executionKey) ||
        !IDENTIFIER.test(execution.fixtureId) ||
        ![0, 1].includes(execution.repeatIndex) ||
        !CANDIDATES.some(
          (candidate) =>
            candidate.alias === execution.alias &&
            candidate.protocol === execution.protocol &&
            candidate.reasoning === execution.reasoning,
        ),
    )
  ) {
    throw new Error("COPY_QUALITY_MATRIX_PLAN_INVALID");
  }
}

assertCanonicalMatrixPlan();

export const COPY_QUALITY_MATRIX_ADMISSION_SOURCE = deepFreeze({
  schemaVersion:
    "site-builder-copy-quality-matrix-admission-source/2026-08-06-v1" as const,
  taskId: "site_builder.copy" as const,
  purpose: MATRIX_PURPOSE,
  planId: COPY_QUALITY_MATRIX_PLAN.planId,
  planDigest: canonicalDigest(COPY_QUALITY_MATRIX_PLAN),
  dispatchAuthorization: "NOT_AUTHORIZED" as const,
  observedModelWireCalls: 0 as const,
  observedModelCost: { CNY: 0 as const, USD: 0 as const },
  plannedExecutions: MAXIMUM_EXECUTIONS,
  maximumWireCalls: MAXIMUM_WIRE_CALLS,
  maximumRepairCallsPerExecution: MAXIMUM_REPAIRS,
  unknownSettlementPolicy: UNKNOWN_SETTLEMENT_POLICY,
  requiredFollowup: Object.freeze([
    "SUCCESSFUL_CAPABILITY_PILOT_EVIDENCE",
    "SEPARATE_MATRIX_DISPATCH_AUTHORIZATION",
  ] as const),
  candidates: CANDIDATES,
  executions: EXECUTIONS,
});

export interface CopyQualityMatrixManifest {
  schemaVersion: "site-builder-copy-quality-matrix-manifest/2026-08-06-v1";
  manifestId: string;
  fixedSourceCommit: string;
  sourceBundleDigest: string;
  planDigest: string;
  dispatchAuthorization: "NOT_AUTHORIZED";
  taskId: "site_builder.copy";
  purpose: "site_builder_copy_quality_matrix";
  plannedExecutions: 36;
  maximumWireCalls: 72;
  maximumRepairCallsPerExecution: 1;
  executions: readonly CopyQualityMatrixExecutionScope[];
}

export interface CopyQualityMatrixSourceVerification {
  fixedSourceCommit: string;
  sourceBundleDigest: string;
  fixedCommitReachableFromExecutionHead: boolean;
  trackedSourceBytesMatch: boolean;
  compiledContractsMatch: boolean;
}

export interface CopyQualityMatrixCredentialAttestation {
  schemaVersion: "site-builder-copy-quality-matrix-credential-attestation/2026-08-06-v1";
  attestationId: string;
  capturedAt: string;
  expiresAt: string;
  gatewayOrigin: string;
  bearerTokenSha256: string;
  purpose: "site_builder_copy_quality_matrix";
  quotaMode: "limited";
  quotaCapPoints: number;
  remainingQuotaPoints: number;
  maximumQuotaPointsPerWire: number;
  reservedQuotaPoints: number;
  scopeExact: true;
  repairPayloadPolicy: "bounded_structured_prior_output_64k";
  candidates: readonly CopyQualityMatrixCandidateScope[];
  channels: readonly {
    alias: string;
    protocol: ModelProtocol;
    channelId: number;
  }[];
  resolverId: string;
}

export interface CopyQualityMatrixSettlementObserver {
  schemaVersion: "site-builder-copy-quality-matrix-settlement-observer/2026-08-06-v1";
  resolverId: string;
  status: "READY";
  observation: "request_bound_new_api_consume_log";
  requestIdentityHeader: "x-oneapi-request-id";
  requiredObservationPerPhysicalCall: true;
  maximumPollDurationMs: number;
  unknownSettlementPolicy: "freeze_matrix_and_stop_dispatch";
}

export interface CopyQualityMatrixPilotSeparationProof {
  schemaVersion: "site-builder-copy-quality-matrix-pilot-separation-proof/2026-08-06-v1";
  pilotPurpose: "site_builder_copy_capability_pilot";
  pilotMaximumExecutions: 3;
  pilotMaximumWireCalls: 6;
  pilotBearerTokenSha256: string;
  pilotAuthorizationIds: readonly string[];
  pilotReservationIds: readonly string[];
  pilotLedgerIdentityDigests: readonly string[];
}

export interface CopyQualityMatrixDispatchAuthorization {
  schemaVersion: "site-builder-copy-quality-matrix-dispatch-authorization/2026-08-06-v1";
  authorizationId: string;
  status: "AUTHORIZED";
  issuedAt: string;
  expiresAt: string;
  purpose: "site_builder_copy_quality_matrix";
  manifestDigest: string;
  credentialAttestationDigest: string;
  settlementObserverDigest: string;
  pilotSeparationProofDigest: string;
  reservationId: string;
  reservationDigest: string;
  reservationStatus: "RESERVED";
  reservedQuotaPoints: number;
  ledgerId: string;
  ledgerIdentityDigest: string;
  maximumExecutions: 36;
  maximumWireCalls: 72;
  maximumRepairCallsPerExecution: 1;
  unknownSettlementPolicy: "freeze_matrix_and_stop_dispatch";
}

export interface CopyQualityMatrixAdmissionInput {
  manifest: CopyQualityMatrixManifest;
  sourceVerification: CopyQualityMatrixSourceVerification;
  credential: CopyQualityMatrixCredentialAttestation;
  settlement: CopyQualityMatrixSettlementObserver;
  pilotSeparation: CopyQualityMatrixPilotSeparationProof;
  authorization: CopyQualityMatrixDispatchAuthorization;
}

export interface CopyQualityMatrixAdmissionValidation {
  schemaVersion: "site-builder-copy-quality-matrix-admission-validation/2026-08-06-v1";
  classification: "SOURCE_CONTRACT_VALIDATION_ONLY";
  dispatchCapable: false;
  taskId: "site_builder.copy";
  purpose: "site_builder_copy_quality_matrix";
  planDigest: string;
  manifestDigest: string;
  fixedSourceCommit: string;
  credentialAttestationDigest: string;
  settlementObserverDigest: string;
  pilotSeparationProofDigest: string;
  authorizationDigest: string;
  authorizationId: string;
  reservationId: string;
  reservationDigest: string;
  ledgerId: string;
  ledgerIdentityDigest: string;
  maximumExecutions: 36;
  maximumWireCalls: 72;
  maximumRepairCallsPerExecution: 1;
  unknownSettlementPolicy: "freeze_matrix_and_stop_dispatch";
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
    fail("COPY_QUALITY_MATRIX_PROOF_INVALID");
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
    fail("COPY_QUALITY_MATRIX_PROOF_EXPIRED");
  }
}

function validateGatewayOrigin(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail("COPY_QUALITY_MATRIX_CREDENTIAL_INVALID");
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
    fail("COPY_QUALITY_MATRIX_CREDENTIAL_INVALID");
  }
}

function sameDigest(left: unknown, right: unknown): boolean {
  try {
    return canonicalDigest(left) === canonicalDigest(right);
  } catch {
    return false;
  }
}

function validateManifest(
  manifest: CopyQualityMatrixManifest,
  source: CopyQualityMatrixSourceVerification,
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
      "purpose",
      "plannedExecutions",
      "maximumWireCalls",
      "maximumRepairCallsPerExecution",
      "executions",
    ]) ||
    manifest.schemaVersion !==
      "site-builder-copy-quality-matrix-manifest/2026-08-06-v1" ||
    !IDENTIFIER.test(manifest.manifestId) ||
    !GIT_COMMIT.test(manifest.fixedSourceCommit) ||
    !SHA256.test(manifest.sourceBundleDigest) ||
    manifest.planDigest !== canonicalDigest(COPY_QUALITY_MATRIX_PLAN) ||
    manifest.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    manifest.taskId !== "site_builder.copy" ||
    manifest.purpose !== MATRIX_PURPOSE ||
    manifest.plannedExecutions !== MAXIMUM_EXECUTIONS ||
    manifest.maximumWireCalls !== MAXIMUM_WIRE_CALLS ||
    manifest.maximumRepairCallsPerExecution !== MAXIMUM_REPAIRS ||
    !sameDigest(manifest.executions, EXECUTIONS)
  ) {
    fail("COPY_QUALITY_MATRIX_MANIFEST_INVALID");
  }
  if (manifest.fixedSourceCommit !== source.fixedSourceCommit) {
    fail("COPY_QUALITY_MATRIX_FIXED_COMMIT_MISMATCH");
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
    fail("COPY_QUALITY_MATRIX_SOURCE_BUNDLE_UNVERIFIED");
  }
}

function validateCredential(
  credential: CopyQualityMatrixCredentialAttestation,
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
      "candidates",
      "channels",
      "resolverId",
    ]) ||
    credential.schemaVersion !==
      "site-builder-copy-quality-matrix-credential-attestation/2026-08-06-v1" ||
    !IDENTIFIER.test(credential.attestationId) ||
    !IDENTIFIER.test(credential.resolverId) ||
    !SHA256.test(credential.bearerTokenSha256) ||
    credential.purpose !== MATRIX_PURPOSE ||
    credential.quotaMode !== "limited" ||
    credential.scopeExact !== true ||
    credential.repairPayloadPolicy !== "bounded_structured_prior_output_64k" ||
    !safePositiveInteger(credential.quotaCapPoints) ||
    !safePositiveInteger(credential.remainingQuotaPoints) ||
    !safePositiveInteger(credential.maximumQuotaPointsPerWire) ||
    !safePositiveInteger(credential.reservedQuotaPoints) ||
    credential.reservedQuotaPoints !==
      credential.maximumQuotaPointsPerWire * MAXIMUM_WIRE_CALLS ||
    !Number.isSafeInteger(credential.reservedQuotaPoints) ||
    credential.remainingQuotaPoints > credential.quotaCapPoints ||
    credential.remainingQuotaPoints < credential.reservedQuotaPoints ||
    credential.quotaCapPoints < credential.reservedQuotaPoints
  ) {
    fail("COPY_QUALITY_MATRIX_CREDENTIAL_INVALID");
  }
  validateGatewayOrigin(credential.gatewayOrigin);
  validateLifetime(credential.capturedAt, credential.expiresAt, now);
  if (
    !sameDigest(credential.candidates, CANDIDATES) ||
    credential.candidates.some(
      (candidate) => !exactKeys(candidate, ["alias", "protocol", "reasoning"]),
    ) ||
    credential.channels.length !== CANDIDATES.length ||
    credential.channels.some(
      (channel, index) =>
        !exactKeys(channel, ["alias", "protocol", "channelId"]) ||
        channel.alias !== CANDIDATES[index]?.alias ||
        channel.protocol !== CANDIDATES[index]?.protocol ||
        !safePositiveInteger(channel.channelId),
    )
  ) {
    fail("COPY_QUALITY_MATRIX_SCOPE_MISMATCH");
  }
}

function validateSettlement(
  settlement: CopyQualityMatrixSettlementObserver,
  credential: CopyQualityMatrixCredentialAttestation,
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
      "site-builder-copy-quality-matrix-settlement-observer/2026-08-06-v1" ||
    settlement.resolverId !== credential.resolverId ||
    settlement.status !== "READY" ||
    settlement.observation !== "request_bound_new_api_consume_log" ||
    settlement.requestIdentityHeader !== "x-oneapi-request-id" ||
    settlement.requiredObservationPerPhysicalCall !== true ||
    !safePositiveInteger(settlement.maximumPollDurationMs) ||
    settlement.maximumPollDurationMs > MAX_SETTLEMENT_POLL_MS ||
    settlement.unknownSettlementPolicy !== UNKNOWN_SETTLEMENT_POLICY
  ) {
    fail("COPY_QUALITY_MATRIX_SETTLEMENT_UNAVAILABLE");
  }
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validatePilotSeparationProof(
  proof: CopyQualityMatrixPilotSeparationProof,
): void {
  if (
    !exactKeys(proof, [
      "schemaVersion",
      "pilotPurpose",
      "pilotMaximumExecutions",
      "pilotMaximumWireCalls",
      "pilotBearerTokenSha256",
      "pilotAuthorizationIds",
      "pilotReservationIds",
      "pilotLedgerIdentityDigests",
    ]) ||
    proof.schemaVersion !==
      "site-builder-copy-quality-matrix-pilot-separation-proof/2026-08-06-v1" ||
    proof.pilotPurpose !== "site_builder_copy_capability_pilot" ||
    proof.pilotMaximumExecutions !== 3 ||
    proof.pilotMaximumWireCalls !== 6 ||
    !SHA256.test(proof.pilotBearerTokenSha256) ||
    proof.pilotAuthorizationIds.length === 0 ||
    proof.pilotReservationIds.length === 0 ||
    proof.pilotLedgerIdentityDigests.length === 0 ||
    !proof.pilotAuthorizationIds.every((value) => IDENTIFIER.test(value)) ||
    !proof.pilotReservationIds.every((value) => IDENTIFIER.test(value)) ||
    !proof.pilotLedgerIdentityDigests.every((value) => SHA256.test(value)) ||
    !unique(proof.pilotAuthorizationIds) ||
    !unique(proof.pilotReservationIds) ||
    !unique(proof.pilotLedgerIdentityDigests)
  ) {
    fail("COPY_QUALITY_MATRIX_PILOT_SEPARATION_INVALID");
  }
}

type MatrixAuthorizationWithoutReservationDigest = Omit<
  CopyQualityMatrixDispatchAuthorization,
  "reservationDigest"
>;

export function copyQualityMatrixReservationDigest(
  authorization: MatrixAuthorizationWithoutReservationDigest,
): string {
  return CANONICAL_DIGEST({
    bindingSchemaVersion:
      "copy-quality-matrix-reservation-binding/2026-08-06-v1",
    authorization,
  });
}

function validateNoPilotReuse(input: CopyQualityMatrixAdmissionInput): void {
  const { pilotSeparation: pilot, credential, authorization } = input;
  if (
    credential.bearerTokenSha256 === pilot.pilotBearerTokenSha256 ||
    pilot.pilotAuthorizationIds.includes(authorization.authorizationId) ||
    pilot.pilotReservationIds.includes(authorization.reservationId) ||
    pilot.pilotLedgerIdentityDigests.includes(
      authorization.ledgerIdentityDigest,
    )
  ) {
    fail("COPY_QUALITY_MATRIX_CAPABILITY_PILOT_REUSE");
  }
}

function validateAuthorization(
  input: CopyQualityMatrixAdmissionInput,
  now: Date,
): void {
  const authorization = input.authorization;
  if (
    !exactKeys(authorization, [
      "schemaVersion",
      "authorizationId",
      "status",
      "issuedAt",
      "expiresAt",
      "purpose",
      "manifestDigest",
      "credentialAttestationDigest",
      "settlementObserverDigest",
      "pilotSeparationProofDigest",
      "reservationId",
      "reservationDigest",
      "reservationStatus",
      "reservedQuotaPoints",
      "ledgerId",
      "ledgerIdentityDigest",
      "maximumExecutions",
      "maximumWireCalls",
      "maximumRepairCallsPerExecution",
      "unknownSettlementPolicy",
    ]) ||
    authorization.schemaVersion !==
      "site-builder-copy-quality-matrix-dispatch-authorization/2026-08-06-v1" ||
    !IDENTIFIER.test(authorization.authorizationId) ||
    authorization.status !== "AUTHORIZED" ||
    authorization.purpose !== MATRIX_PURPOSE ||
    authorization.manifestDigest !== canonicalDigest(input.manifest) ||
    authorization.credentialAttestationDigest !==
      canonicalDigest(input.credential) ||
    authorization.settlementObserverDigest !==
      canonicalDigest(input.settlement) ||
    authorization.pilotSeparationProofDigest !==
      canonicalDigest(input.pilotSeparation) ||
    !IDENTIFIER.test(authorization.reservationId) ||
    authorization.reservationStatus !== "RESERVED" ||
    authorization.reservedQuotaPoints !==
      input.credential.reservedQuotaPoints ||
    !IDENTIFIER.test(authorization.ledgerId) ||
    !SHA256.test(authorization.ledgerIdentityDigest) ||
    authorization.maximumExecutions !== MAXIMUM_EXECUTIONS ||
    authorization.maximumWireCalls !== MAXIMUM_WIRE_CALLS ||
    authorization.maximumRepairCallsPerExecution !== MAXIMUM_REPAIRS ||
    authorization.unknownSettlementPolicy !== UNKNOWN_SETTLEMENT_POLICY
  ) {
    fail("COPY_QUALITY_MATRIX_AUTHORIZATION_MISMATCH");
  }
  const { reservationDigest, ...withoutReservationDigest } = authorization;
  if (
    !SHA256.test(reservationDigest) ||
    reservationDigest !==
      copyQualityMatrixReservationDigest(withoutReservationDigest)
  ) {
    fail("COPY_QUALITY_MATRIX_AUTHORIZATION_MISMATCH");
  }
  validateLifetime(authorization.issuedAt, authorization.expiresAt, now);
  if (instant(authorization.expiresAt) > instant(input.credential.expiresAt)) {
    fail("COPY_QUALITY_MATRIX_AUTHORIZATION_MISMATCH");
  }
}

/** Pure admission boundary. It neither reads credentials nor dispatches a wire. */
export function validateCopyQualityMatrixAdmissionEnvelope(
  input: CopyQualityMatrixAdmissionInput,
  now: Date = new Date(),
): CopyQualityMatrixAdmissionValidation {
  if (
    !exactKeys(input, [
      "manifest",
      "sourceVerification",
      "credential",
      "settlement",
      "pilotSeparation",
      "authorization",
    ])
  ) {
    fail("COPY_QUALITY_MATRIX_ENVELOPE_INVALID");
  }
  validateManifest(input.manifest, input.sourceVerification);
  validateCredential(input.credential, now);
  validateSettlement(input.settlement, input.credential);
  validatePilotSeparationProof(input.pilotSeparation);
  validateNoPilotReuse(input);
  validateAuthorization(input, now);

  return Object.freeze({
    schemaVersion:
      "site-builder-copy-quality-matrix-admission-validation/2026-08-06-v1" as const,
    classification: "SOURCE_CONTRACT_VALIDATION_ONLY" as const,
    dispatchCapable: false as const,
    taskId: "site_builder.copy" as const,
    purpose: MATRIX_PURPOSE,
    planDigest: canonicalDigest(COPY_QUALITY_MATRIX_PLAN),
    manifestDigest: canonicalDigest(input.manifest),
    fixedSourceCommit: input.manifest.fixedSourceCommit,
    credentialAttestationDigest: canonicalDigest(input.credential),
    settlementObserverDigest: canonicalDigest(input.settlement),
    pilotSeparationProofDigest: canonicalDigest(input.pilotSeparation),
    authorizationDigest: canonicalDigest(input.authorization),
    authorizationId: input.authorization.authorizationId,
    reservationId: input.authorization.reservationId,
    reservationDigest: input.authorization.reservationDigest,
    ledgerId: input.authorization.ledgerId,
    ledgerIdentityDigest: input.authorization.ledgerIdentityDigest,
    maximumExecutions: MAXIMUM_EXECUTIONS,
    maximumWireCalls: MAXIMUM_WIRE_CALLS,
    maximumRepairCallsPerExecution: MAXIMUM_REPAIRS,
    unknownSettlementPolicy: UNKNOWN_SETTLEMENT_POLICY,
  });
}
