import { buildApprovalReceiptArtifact as buildRawApprovalReceiptArtifact } from './governance-approval-safe-json.mjs';
import {
  AUTHORITY_REVISION_PATTERN,
  DECISION_REVISION_PATTERN,
  POLICY_REVISION_PATTERN,
  approvalError,
  deepFreeze,
  hasExactKeys,
  isCanonicalInstant,
  isDigest,
  isGitSha,
  isId,
  isPlainObject,
  isSafePositiveInteger,
  repositoryMatches,
  resultFromCodes,
  sameJson,
} from './governance-approval-readback-common.mjs';
import {
  normalizeMachineCheckEvidence,
  validateMachineChecks,
} from './governance-approval-machine-policy.mjs';
import {
  mergeReceiptReference,
  mergeStageForPhase,
  validateMergeAuthorizationEvidence,
} from './governance-approval-merge-authorization.mjs';
import {
  validateReceiptRevocation as validateLifecycleRevocation,
  validateReceiptSupersession as validateLifecycleSupersession,
} from './governance-approval-receipt-lifecycle.mjs';
import {
  parseApprovalReviewCommand,
  validateRoleEvidence,
} from './governance-approval-role-evidence.mjs';

const RECEIPT_SUBJECT_KEYS = Object.freeze([
  'receipt_id', 'phase', 'role', 'prior_receipt_ids', 'revoked_receipt_ids', 'superseded_receipt_ids',
]);
const RECEIPT_PHASES = new Set(['REVIEW', 'POST_MERGE', 'ACCEPTANCE_REVALIDATION']);
const RECEIPT_ROLES = new Set(['OWN-PRODUCT', 'OWN-DATA-PRIVACY', 'OWN-QA-EVIDENCE', 'OWN-SECURITY']);
const issuedValidatedCores = new WeakSet();

const snapshotsMatch = (candidate) => {
  if (!isPlainObject(candidate.pull_request) || !isPlainObject(candidate.ruleset) || !isPlainObject(candidate.decision)) {
    return false;
  }
  const expected = {
    head_sha: candidate.pull_request.head_sha,
    base_sha: candidate.pull_request.base_sha,
    authority_sha256: candidate.authority_sha256,
    ruleset_sha256: candidate.ruleset.normalized_sha256,
    decision_raw_sha256: candidate.decision.raw_sha256,
    decision_semantic_sha256: candidate.decision.semantic_sha256,
  };
  return sameJson(candidate.pre_read, expected) && sameJson(candidate.post_read, expected);
};

const verifierMatches = (candidate, policy, now) => {
  const verifier = candidate.verifier;
  const allowed = policy.independent_verifier;
  return (
    isPlainObject(verifier)
    && verifier.trust_class === 'INDEPENDENT_EXTERNAL_VERIFIED'
    && verifier.independently_governed === true
    && verifier.repository_id !== candidate.repository?.id
    && verifier.repository_id === allowed?.repository_id
    && verifier.repository_full_name === allowed?.repository_full_name
    && verifier.workflow_id === allowed?.workflow_id
    && verifier.workflow_path === allowed?.workflow_path
    && verifier.workflow_sha === allowed?.workflow_sha
    && isSafePositiveInteger(verifier.run_id)
    && isSafePositiveInteger(verifier.attempt)
    && verifier.event === 'workflow_call'
    && verifier.runner_environment === 'github-hosted'
    && isCanonicalInstant(verifier.read_at)
    && Date.parse(verifier.read_at) <= Date.parse(now)
  );
};

const receiptSubjectCodes = (subject) => {
  if (
    !hasExactKeys(subject, RECEIPT_SUBJECT_KEYS)
    || !isId(subject.receipt_id)
    || !RECEIPT_PHASES.has(subject.phase)
    || !RECEIPT_ROLES.has(subject.role)
    || !Array.isArray(subject.prior_receipt_ids)
    || !Array.isArray(subject.revoked_receipt_ids)
    || !Array.isArray(subject.superseded_receipt_ids)
  ) return ['APPROVAL_RECEIPT_REQUIRED'];
  const arrays = [subject.prior_receipt_ids, subject.revoked_receipt_ids, subject.superseded_receipt_ids];
  if (arrays.some((values) => (
    values.length > 64
    || values.some((value) => !isId(value))
    || new Set(values).size !== values.length
  ))) return ['APPROVAL_RECEIPT_REQUIRED'];
  const codes = [];
  if (subject.prior_receipt_ids.includes(subject.receipt_id)) codes.push('APPROVAL_RECEIPT_REPLAYED');
  if (subject.revoked_receipt_ids.includes(subject.receipt_id)) codes.push('APPROVAL_POLICY_REVOKED');
  if (subject.superseded_receipt_ids.includes(subject.receipt_id)) codes.push('APPROVAL_RECEIPT_REPLAYED');
  return codes;
};

export { parseApprovalReviewCommand };

export const validateApprovalReadback = (candidate, authority, policy, now) => {
  const codes = [];
  if (!isPlainObject(candidate) || !isPlainObject(authority) || !isPlainObject(policy) || !isCanonicalInstant(now)) {
    return resultFromCodes(['APPROVAL_REVIEW_REQUIRED']);
  }
  if (!repositoryMatches(candidate.repository) || !repositoryMatches(authority.repository) || !repositoryMatches(policy.repository)) {
    codes.push('APPROVAL_REPOSITORY_MISMATCH');
  }
  if (
    candidate.pull_request?.state !== 'OPEN'
    || candidate.pull_request?.draft !== false
    || !isSafePositiveInteger(candidate.pull_request?.number)
  ) codes.push('APPROVAL_PR_NOT_ELIGIBLE');
  if (!isGitSha(candidate.pull_request?.base_sha)) codes.push('APPROVAL_BASE_MISMATCH');
  if (!isGitSha(candidate.pull_request?.head_sha)) codes.push('APPROVAL_HEAD_MISMATCH');
  if (
    candidate.decision?.adr !== 'ADR-042'
    || !DECISION_REVISION_PATTERN.test(candidate.decision?.revision ?? '')
    || !POLICY_REVISION_PATTERN.test(candidate.decision?.policy_revision ?? '')
    || !isDigest(candidate.decision?.raw_sha256)
    || !isDigest(candidate.decision?.semantic_sha256)
  ) codes.push('APPROVAL_DECISION_SEMANTIC_DIGEST_MISMATCH');
  if (
    candidate.authority_revision !== authority.revision
    || candidate.authority_sha256 !== authority.sha256
    || !AUTHORITY_REVISION_PATTERN.test(candidate.authority_revision ?? '')
    || !isDigest(candidate.authority_sha256)
  ) codes.push('APPROVAL_ROLE_AUTHORITY_STALE');
  if (!isPlainObject(candidate.pull_request) || !isPlainObject(candidate.decision)) {
    return resultFromCodes([...codes, 'APPROVAL_REVIEW_REQUIRED']);
  }

  codes.push(...validateRoleEvidence(candidate, authority, policy, now));
  codes.push(...validateMachineChecks(candidate, policy));
  codes.push(...receiptSubjectCodes(candidate.receipt_subject));
  const expectedManifestPath = typeof candidate.decision.proposed_sidecar_path === 'string'
    ? candidate.decision.proposed_sidecar_path.replace(/\.md$/, '.manifest.json')
    : '';
  if (
    !Array.isArray(policy.pr_readable_paths)
    || !policy.pr_readable_paths.includes(candidate.decision.proposed_sidecar_path)
    || !policy.pr_readable_paths.includes(expectedManifestPath)
  ) codes.push('APPROVAL_PROPOSED_SIDECAR_REQUIRED');
  if (candidate.review_pagination_complete !== true) codes.push('APPROVAL_PAGINATION_INCOMPLETE');
  if (candidate.ruleset?.normalized_sha256 !== policy.live_ruleset_sha256) codes.push('APPROVAL_RULESET_DRIFT');
  if (!Array.isArray(candidate.ruleset?.bypass_actors) || candidate.ruleset.bypass_actors.length !== 0) {
    codes.push('APPROVAL_RULESET_BYPASS_PRESENT');
  }
  if (!snapshotsMatch(candidate)) codes.push('APPROVAL_TOCTOU_DETECTED');
  if (!verifierMatches(candidate, policy, now)) codes.push('APPROVAL_INDEPENDENCE_NOT_PROVEN');
  if (
    !Number.isSafeInteger(policy.receipt_validity_ms)
    || !Number.isSafeInteger(policy.maximum_receipt_validity_ms)
    || policy.receipt_validity_ms <= 0
    || policy.receipt_validity_ms > policy.maximum_receipt_validity_ms
  ) codes.push('APPROVAL_RECEIPT_EXPIRED');
  return resultFromCodes(codes);
};

export const validateMergeAuthorizationGrantForCandidate = (evidence, candidate, authority, now) => (
  validateMergeAuthorizationEvidence(evidence, candidate, authority, now)
);

const reviewForReceiptRole = (candidate) => {
  if (candidate.receipt_subject.role === 'OWN-PRODUCT') return candidate.product_review;
  if (candidate.receipt_subject.role === 'OWN-DATA-PRIVACY') return candidate.privacy_review;
  if (candidate.receipt_subject.role === 'OWN-QA-EVIDENCE') return candidate.qa_review;
  if (candidate.receipt_subject.role === 'OWN-SECURITY') {
    return {
      actor: { id: candidate.security_review.actor_id, login: candidate.security_review.actor_login },
      submitted_at: candidate.security_review.submitted_at,
    };
  }
  return undefined;
};

export const buildApprovalReceiptCore = (candidate, authority, verifier, mergeAuthorizationEvidence, now) => {
  const validation = validateApprovalReadback(candidate, authority, candidate?.policy, now);
  if (!validation.valid) throw approvalError(validation.issues[0].stable_code);
  if (!sameJson(verifier, candidate.verifier)) throw approvalError('APPROVAL_INDEPENDENCE_NOT_PROVEN');
  const stage = mergeStageForPhase(candidate.receipt_subject.phase);
  if (stage === null && mergeAuthorizationEvidence !== null && mergeAuthorizationEvidence !== undefined) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_STAGE_MISMATCH');
  }
  if (stage !== null && (mergeAuthorizationEvidence === null || mergeAuthorizationEvidence === undefined)) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED');
  }
  if (stage !== null) {
    const mergeValidation = validateMergeAuthorizationEvidence(mergeAuthorizationEvidence, candidate, authority, now);
    if (!mergeValidation.valid) throw approvalError(mergeValidation.issues[0].stable_code);
  }
  const review = reviewForReceiptRole(candidate);
  if (!review) throw approvalError('APPROVAL_REVIEW_REQUIRED');
  const core = {
    receipt_id: candidate.receipt_subject.receipt_id,
    repository: { id: candidate.repository.id, full_name: candidate.repository.full_name },
    authority_revision: candidate.authority_revision,
    authority_sha256: candidate.authority_sha256,
    role: candidate.receipt_subject.role,
    actor_id: review.actor.id,
    actor_login: review.actor.login,
    decision_adr: candidate.decision.adr,
    decision_revision: candidate.decision.revision,
    policy_revision: candidate.decision.policy_revision,
    pr_number: candidate.pull_request.number,
    base_sha: candidate.pull_request.base_sha,
    head_sha: candidate.pull_request.head_sha,
    approved_at: now,
    trust_class: 'TRUSTED_BASE_VERIFIED',
    machine_check_evidence: normalizeMachineCheckEvidence(candidate.machine_checks),
  };
  if (stage !== null) core.merge_authorization_evidence = mergeReceiptReference(mergeAuthorizationEvidence);
  const frozenCore = deepFreeze(core);
  issuedValidatedCores.add(frozenCore);
  return frozenCore;
};

export const buildApprovalReceiptArtifact = (core) => {
  if (!issuedValidatedCores.has(core)) throw approvalError('APPROVAL_RECEIPT_REQUIRED');
  return buildRawApprovalReceiptArtifact(core);
};

export const validateReceiptRevocation = (revocation, receipt, authority, now) => (
  validateLifecycleRevocation(revocation, receipt, authority, now)
);

export const validateReceiptSupersession = (supersession, snapshot, authority, now) => (
  validateLifecycleSupersession(supersession, snapshot, authority, now)
);
