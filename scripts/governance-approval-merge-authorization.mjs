import {
  validateApprovalReceipt,
  validateProgramCMergeAuthorizationConsumption,
  validateProgramCMergeAuthorizationGrant,
} from './governance-approval-schema-validator.mjs';
import {
  authorityIsCurrent,
  authorityRole,
  hasExactKeys,
  instantValue,
  isCausalOrder,
  isDigest,
  isPlainObject,
  isSafeNonNegativeInteger,
  resultFromCodes,
  sameJson,
} from './governance-approval-readback-common.mjs';

const EVIDENCE_KEYS = Object.freeze([
  'grant', 'grant_raw_sha256', 'consumption', 'consumption_raw_sha256',
  'authority_receipt', 'authority_receipt_raw_sha256', 'grant_revocations', 'ledger_snapshot',
]);
const REVOCATION_KEYS = Object.freeze([
  'schema_version', 'grant_id', 'grant_raw_sha256', 'reason_code', 'effective_at',
]);
const LEDGER_KEYS = Object.freeze([
  'schema_version', 'durability_class', 'repository_id', 'committed_revision', 'reservations',
]);
const RESERVATION_KEYS = Object.freeze([
  'key', 'grant_id', 'grant_raw_sha256', 'single_use_nonce', 'reserved_revision', 'state', 'request_binding',
]);
const REQUEST_BINDING_KEYS = Object.freeze([
  'repository_id', 'decision_adr', 'decision_revision', 'policy_revision', 'stage', 'pr_number', 'head_sha',
]);

export const mergeStageForPhase = (phase) => {
  if (phase === 'REVIEW') return null;
  if (phase === 'POST_MERGE') return 'PROPOSAL_MERGE';
  if (phase === 'ACCEPTANCE_REVALIDATION') return 'ACCEPTANCE_MERGE';
  return undefined;
};

const candidateBinding = (candidate, stage) => ({
  repository_id: candidate.repository.id,
  decision_adr: candidate.decision.adr,
  decision_revision: candidate.decision.revision,
  policy_revision: candidate.decision.policy_revision,
  stage,
  pr_number: candidate.pull_request.number,
  head_sha: candidate.pull_request.head_sha,
});

const schemaCode = (kind) => (
  kind === 'grant'
    ? 'APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH'
    : 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH'
);

const validateGrantRevocations = (revocations, grant, grantRawSha, now) => {
  if (!Array.isArray(revocations) || revocations.length > 64) return ['APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE'];
  const codes = [];
  for (const revocation of revocations) {
    if (
      !hasExactKeys(revocation, REVOCATION_KEYS)
      || revocation.schema_version !== 'program-c-merge-authorization-revocation/v1'
      || !isDigest(revocation.grant_raw_sha256)
      || !isCausalOrder(revocation.effective_at, now)
      || !['AUTHORITY_REVOKED', 'POLICY_WITHDRAWN', 'SECURITY_INCIDENT'].includes(revocation.reason_code)
    ) {
      codes.push('APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
      continue;
    }
    if (revocation.grant_id === grant.grant_id && revocation.grant_raw_sha256 === grantRawSha) {
      codes.push('APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
    }
  }
  return codes;
};

const validateLedger = (ledger, grant, grantRawSha, consumption, candidate) => {
  const codes = [];
  if (
    !hasExactKeys(ledger, LEDGER_KEYS)
    || ledger.schema_version !== 'approval-nonce-ledger-snapshot/v1'
    || ledger.durability_class !== 'SHARED_DURABLE_CAS'
    || ledger.repository_id !== candidate.repository.id
    || !isSafeNonNegativeInteger(ledger.committed_revision)
    || !Array.isArray(ledger.reservations)
    || ledger.reservations.length > 64
  ) return ['APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED'];
  const expectedBinding = candidateBinding(candidate, grant.stage);
  const matching = ledger.reservations.filter((reservation) => (
    reservation?.key === consumption.nonce_ledger_key
    && reservation?.grant_id === grant.grant_id
    && reservation?.grant_raw_sha256 === grantRawSha
    && reservation?.single_use_nonce === grant.single_use_nonce
  ));
  if (ledger.reservations.some((reservation) => (
    !hasExactKeys(reservation, RESERVATION_KEYS)
    || !hasExactKeys(reservation.request_binding, REQUEST_BINDING_KEYS)
  )) || matching.length !== 1) return ['APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED'];
  const reservation = matching[0];
  if (
    reservation.state !== 'CONSUMED'
    || reservation.reserved_revision !== consumption.nonce_ledger_reserved_revision
    || ledger.committed_revision < reservation.reserved_revision
    || !sameJson(reservation.request_binding, expectedBinding)
  ) codes.push('APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH');
  return codes;
};

export const validateMergeAuthorizationEvidence = (evidence, candidate, authority, now) => {
  const codes = [];
  if (!hasExactKeys(evidence, EVIDENCE_KEYS) || !isPlainObject(evidence.grant)) {
    return resultFromCodes(['APPROVAL_MERGE_AUTHORIZATION_GRANT_REQUIRED']);
  }
  const { grant, consumption } = evidence;
  const mergeAuthority = authorityRole(authority, 'MERGE-AUTHORIZER');
  if (grant.authority_role !== 'MERGE-AUTHORIZER' || mergeAuthority?.status !== 'ASSIGNED') {
    codes.push('APPROVAL_MERGE_AUTHORIZER_UNASSIGNED');
  }
  if (isPlainObject(consumption) && (
    consumption.single_use_nonce !== grant.single_use_nonce
    || consumption.nonce_ledger_key !== `program-c-merge:${grant.single_use_nonce}`
  )) codes.push('APPROVAL_MERGE_AUTHORIZATION_REPLAYED');
  if (!validateProgramCMergeAuthorizationGrant(grant).valid) codes.push(schemaCode('grant'));
  if (!isPlainObject(consumption)) {
    codes.push('APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED');
  } else if (!validateProgramCMergeAuthorizationConsumption(consumption).valid) {
    codes.push(schemaCode('consumption'));
  }
  if (codes.length > 0) return resultFromCodes(codes);

  const authorityReceipt = evidence.authority_receipt;
  if (
    !validateApprovalReceipt(authorityReceipt).valid
    || !isDigest(evidence.authority_receipt_raw_sha256)
    || authorityReceipt.receipt_core_sha256 !== grant.authority_receipt_core_sha256
    || evidence.authority_receipt_raw_sha256 !== grant.authority_receipt_raw_sha256
    || authorityReceipt.core.receipt_id !== grant.authority_receipt_id
    || authorityReceipt.core.role !== 'MERGE-AUTHORIZER'
    || authorityReceipt.core.actor_id !== grant.authority_actor_id
    || authorityReceipt.core.repository.id !== grant.repository.id
    || authorityReceipt.core.repository.full_name !== grant.repository.full_name
    || authorityReceipt.core.decision_adr !== grant.decision_adr
    || authorityReceipt.core.decision_revision !== grant.decision_revision
    || authorityReceipt.core.policy_revision !== grant.policy_revision
    || authorityReceipt.core.pr_number !== grant.pr_number
    || authorityReceipt.core.base_sha !== grant.base_sha
    || authorityReceipt.core.head_sha !== grant.head_sha
    || authorityReceipt.core.authority_revision !== grant.authority_revision
    || authorityReceipt.core.authority_sha256 !== grant.authority_sha256
    || !isCausalOrder(authorityReceipt.core.approved_at, grant.authorized_at)
  ) codes.push('APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH');

  const expectedStage = mergeStageForPhase(candidate.receipt_subject?.phase);
  if (expectedStage === undefined || expectedStage === null || grant.stage !== expectedStage) {
    codes.push('APPROVAL_MERGE_AUTHORIZATION_STAGE_MISMATCH');
  }
  if (
    !authorityIsCurrent(mergeAuthority, [grant.authorized_at, now], 'MERGE_AUTHORIZATION', candidate)
    || grant.repository.id !== candidate.repository.id
    || grant.repository.full_name !== candidate.repository.full_name
    || grant.decision_adr !== candidate.decision.adr
    || grant.decision_revision !== candidate.decision.revision
    || grant.policy_revision !== candidate.decision.policy_revision
    || grant.pr_number !== candidate.pull_request.number
    || grant.base_sha !== candidate.pull_request.base_sha
    || grant.head_sha !== candidate.pull_request.head_sha
    || grant.authority_actor_id !== mergeAuthority?.actor_id
    || grant.authority_revision !== authority.revision
    || grant.authority_sha256 !== authority.sha256
    || instantValue(grant.authorized_at) > instantValue(now)
    || instantValue(now) >= instantValue(grant.expires_at)
  ) codes.push('APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
  if (
    grant.decision_raw_sha256 !== candidate.decision.raw_sha256
    || grant.decision_semantic_sha256 !== candidate.decision.semantic_sha256
    || !isDigest(evidence.grant_raw_sha256)
  ) codes.push('APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH');
  codes.push(...validateGrantRevocations(evidence.grant_revocations, grant, evidence.grant_raw_sha256, now));

  if (consumption.grant_id !== grant.grant_id) codes.push('APPROVAL_MERGE_AUTHORIZATION_REPLAYED');
  if (consumption.grant_raw_sha256 !== evidence.grant_raw_sha256) {
    codes.push('APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH');
  }
  if (
    consumption.repository.id !== candidate.repository.id
    || consumption.repository.full_name !== candidate.repository.full_name
    || consumption.decision_adr !== grant.decision_adr
    || consumption.decision_revision !== grant.decision_revision
    || consumption.policy_revision !== grant.policy_revision
    || consumption.stage !== grant.stage
    || consumption.pr_number !== grant.pr_number
    || consumption.authorized_head_sha !== grant.head_sha
    || consumption.observed_merge_method !== grant.allowed_merge_method
    || consumption.current_main.ref !== 'refs/heads/main'
    || consumption.current_main.sha !== consumption.result_commit_sha
    || consumption.independent_verifier.repository.id !== candidate.verifier.repository_id
    || consumption.independent_verifier.repository.full_name !== candidate.verifier.repository_full_name
    || consumption.independent_verifier.path !== candidate.verifier.workflow_path
    || consumption.independent_verifier.sha !== candidate.verifier.workflow_sha
    || consumption.independent_verifier.run_id !== candidate.verifier.run_id
    || consumption.independent_verifier.attempt !== candidate.verifier.attempt
    || consumption.independent_verifier.identity !== candidate.verifier.identity
    || !isDigest(evidence.consumption_raw_sha256)
    || !isCausalOrder(grant.authorized_at, consumption.consumed_at, consumption.current_main.read_at, now)
    || instantValue(consumption.consumed_at) > instantValue(grant.expires_at)
  ) codes.push('APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH');
  codes.push(...validateLedger(evidence.ledger_snapshot, grant, evidence.grant_raw_sha256, consumption, candidate));
  return resultFromCodes(codes);
};

export const mergeReceiptReference = (evidence) => ({
  stage: evidence.grant.stage,
  grant_id: evidence.grant.grant_id,
  grant_raw_sha256: evidence.grant_raw_sha256,
  single_use_nonce: evidence.grant.single_use_nonce,
  consumption_id: evidence.consumption.consumption_id,
  consumption_raw_sha256: evidence.consumption_raw_sha256,
  reserved_ledger_revision: evidence.consumption.nonce_ledger_reserved_revision,
});
