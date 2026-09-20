import {
  approvalError,
  authorityIsCurrent,
  authorityRole,
  deepFreeze,
  hasExactKeys,
  instantValue,
  isCanonicalInstant,
  isCausalOrder,
  isDigest,
  isPlainObject,
  isSafePositiveInteger,
  sha256,
} from './governance-approval-readback-common.mjs';
import { approvalLegalEvidenceRequired } from './governance-approval-legal-policy.mjs';

const REVIEW_COMMAND_PATTERN = /^APPROVE DECISION (ADR-026|ADR-027) REV (program-c\/policy-r[1-9][0-9]*) ROLE (OWN-PRODUCT|OWN-DATA-PRIVACY|OWN-QA-EVIDENCE|OWN-SECURITY) DIGEST (sha256:[0-9a-f]{64})$/;
const PARSED_COMMAND_KEYS = Object.freeze([
  'decision_adr', 'policy_revision', 'role', 'decision_raw_sha256', 'command_sha256',
]);
const CODEOWNER_KEYS = Object.freeze([
  'evidence_kind', 'review_id', 'review_state', 'review_commit_id', 'submitted_at',
  'independently_read_at', 'actor', 'dismissed', 'superseded', 'later_changes_requested',
]);
const ACTOR_KEYS = Object.freeze(['id', 'node_id', 'login', 'type']);
const SECURITY_EVIDENCE_KEYS = Object.freeze([
  'schema_version', 'evidence_id', 'repository_id', 'repository_full_name', 'decision_adr',
  'decision_revision', 'policy_revision', 'proposal_pr_number', 'base_sha', 'head_sha',
  'decision_raw_sha256', 'decision_semantic_sha256', 'proposed_sidecar_path',
  'proposed_sidecar_raw_sha256', 'role', 'authority_revision', 'authority_sha256',
  'actor_id', 'actor_node_id', 'actor_login', 'review_id', 'review_state',
  'review_commit_id', 'review_command_sha256', 'submitted_at', 'independently_read_at',
  'scope', 'revocation_status', 'supersedes_evidence_id', 'dismissed', 'superseded',
  'later_changes_requested',
]);

export const CODEOWNER_ACTOR_SHARING_POLICY = deepFreeze({
  schema_version: 'codeowner-actor-sharing-policy/v1',
  codeowner_actor_reuse: 'ALLOWED_WITH_DISTINCT_EVIDENCE_IDS',
  evidence_id_uniqueness: 'ALL_HUMAN_AND_MACHINE_EVIDENCE_IDS_DISTINCT',
  dual_role_coapprover: 'DISTINCT_LEGAL_OR_QA_REQUIRED',
  minimum_distinct_humans: 2,
  security_actor_isolation_roles: ['OWN-PRODUCT', 'OWN-DATA-PRIVACY', 'OWN-QA-EVIDENCE'],
});

export const parseApprovalReviewCommand = (body) => {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 512) {
    throw approvalError('APPROVAL_REVIEW_COMMAND_INVALID');
  }
  const match = REVIEW_COMMAND_PATTERN.exec(body);
  if (match === null) throw approvalError('APPROVAL_REVIEW_COMMAND_INVALID');
  return deepFreeze({
    decision_adr: match[1],
    policy_revision: match[2],
    role: match[3],
    decision_raw_sha256: match[4],
    command_sha256: sha256(body),
  });
};

const commandFromParsed = (parsed) => (
  isPlainObject(parsed)
    ? `APPROVE DECISION ${parsed.decision_adr} REV ${parsed.policy_revision} ROLE ${parsed.role} DIGEST ${parsed.decision_raw_sha256}`
    : ''
);

const parsedCommandMatches = (parsed, role, candidate) => (
  hasExactKeys(parsed, PARSED_COMMAND_KEYS)
  && parsed.decision_adr === candidate.decision.adr
  && parsed.policy_revision === candidate.decision.policy_revision
  && parsed.role === role
  && parsed.decision_raw_sha256 === candidate.decision.raw_sha256
  && isDigest(parsed.command_sha256)
  && parsed.command_sha256 === sha256(commandFromParsed(parsed))
);

const actorMatchesAuthority = (actor, assigned) => (
  hasExactKeys(actor, ACTOR_KEYS)
  && isSafePositiveInteger(actor.id)
  && actor.type === 'User'
  && actor.id === assigned?.actor_id
  && actor.node_id === assigned?.actor_node_id
  && actor.login === assigned?.actor_login
);

const validateReview = (candidate, authority, review, role, purpose, policy, now) => {
  const codes = [];
  const assigned = authorityRole(authority, role);
  if (assigned?.status !== 'ASSIGNED') codes.push('APPROVAL_OWNER_UNASSIGNED');
  else if (!authorityIsCurrent(
    assigned,
    [review?.submitted_at, review?.independently_read_at, now],
    purpose,
    candidate,
  )) codes.push('APPROVAL_ROLE_AUTHORITY_STALE');
  if (!isPlainObject(review)) return [...codes, 'APPROVAL_REVIEW_REQUIRED'];
  if (review.role !== role || !parsedCommandMatches(review.command, role, candidate)) {
    codes.push(review.role !== role ? 'APPROVAL_REVIEW_ROLE_MISMATCH' : 'APPROVAL_REVIEW_COMMAND_INVALID');
  }
  if (review.review_state !== 'APPROVED') codes.push('APPROVAL_REVIEW_REQUIRED');
  if (review.dismissed === true) codes.push('APPROVAL_REVIEW_DISMISSED');
  if (review.superseded === true || review.later_changes_requested === true) codes.push('APPROVAL_REVIEW_STALE');
  if (review.review_commit_id !== candidate.pull_request.head_sha) codes.push('APPROVAL_REVIEW_STALE');
  if (!isCausalOrder(review.submitted_at, review.independently_read_at, candidate.verifier?.read_at, now)) {
    codes.push('APPROVAL_REVIEW_STALE');
  }
  const dualPrivacy = (
    role === 'OWN-DATA-PRIVACY'
    && policy.actor_policy === 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER'
    && review.actor?.id === candidate.product_review?.actor?.id
  );
  const actorMismatch = (
    !hasExactKeys(review.actor, ACTOR_KEYS)
    || !isSafePositiveInteger(review.actor.id)
    || review.actor.type !== 'User'
    || review.actor.id === candidate.pull_request.author?.id
    || (!dualPrivacy && !actorMatchesAuthority(review.actor, assigned))
  );
  if (actorMismatch) codes.push('APPROVAL_REVIEW_ACTOR_MISMATCH');
  if (!isSafePositiveInteger(review.review_id)) codes.push('APPROVAL_REVIEW_STALE');
  return codes;
};

const validateDualRolePolicy = (candidate, policy, now) => {
  const productActor = candidate.product_review?.actor?.id;
  const privacyActor = candidate.privacy_review?.actor?.id;
  if (policy.actor_policy === 'DISTINCT_ACTORS_REQUIRED') {
    return productActor === privacyActor ? ['APPROVAL_DISTINCT_ACTORS_REQUIRED'] : [];
  }
  if (policy.actor_policy !== 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER') {
    return ['APPROVAL_DISTINCT_ACTORS_REQUIRED'];
  }
  const exception = policy.dual_role_exception;
  const duration = instantValue(exception?.valid_until) - instantValue(exception?.valid_from);
  const coapprover = exception?.coapprover_role === 'LEGAL-REVIEW'
    ? candidate.legal_input?.actor_id
    : candidate.qa_review?.actor?.id;
  if (
    !isPlainObject(exception)
    || exception.decision_adr !== candidate.decision.adr
    || !isCausalOrder(exception.valid_from, now, exception.valid_until)
    || duration <= 0
    || duration > 30 * 24 * 60 * 60 * 1000
    || !['OWN-QA-EVIDENCE', 'LEGAL-REVIEW'].includes(exception.coapprover_role)
    || exception.minimum_distinct_human_actors !== CODEOWNER_ACTOR_SHARING_POLICY.minimum_distinct_humans
    || exception.cannot_authorize_merge !== true
    || exception.cannot_authorize_release !== true
    || (
      exception.coapprover_role === 'LEGAL-REVIEW'
      && candidate.legal_input?.status !== 'NO_BLOCKER_RECORDED'
    )
    || (
      CODEOWNER_ACTOR_SHARING_POLICY.dual_role_coapprover === 'DISTINCT_LEGAL_OR_QA_REQUIRED'
      && productActor === privacyActor
      && (coapprover === productActor || !isSafePositiveInteger(coapprover))
    )
  ) return ['APPROVAL_DISTINCT_ACTORS_REQUIRED'];
  return [];
};

const validateCodeowner = (candidate, now) => {
  const evidence = candidate.codeowner_review;
  if (!hasExactKeys(evidence, CODEOWNER_KEYS) || !hasExactKeys(evidence?.actor, ACTOR_KEYS)) {
    return ['APPROVAL_CODEOWNER_REVIEW_REQUIRED'];
  }
  if (
    evidence.evidence_kind !== 'CODEOWNER_REPOSITORY_REVIEW'
    || !isSafePositiveInteger(evidence.review_id)
    || evidence.review_state !== 'APPROVED'
    || evidence.review_commit_id !== candidate.pull_request.head_sha
    || evidence.actor.type !== 'User'
    || !isSafePositiveInteger(evidence.actor.id)
    || evidence.actor.id === candidate.pull_request.author?.id
    || evidence.dismissed !== false
    || evidence.superseded !== false
    || evidence.later_changes_requested !== false
    || !isCausalOrder(evidence.submitted_at, evidence.independently_read_at, candidate.verifier?.read_at, now)
  ) return ['APPROVAL_CODEOWNER_REVIEW_REQUIRED'];
  return [];
};

const validateSecurity = (candidate, authority, now) => {
  const codes = [];
  const evidence = candidate.security_review;
  const assigned = authorityRole(authority, 'OWN-SECURITY');
  if (assigned?.status !== 'ASSIGNED') codes.push('APPROVAL_SECURITY_OWNER_UNASSIGNED');
  else if (assigned.revocation_status !== 'ACTIVE' || assigned.superseded_by !== null) {
    codes.push('APPROVAL_SECURITY_AUTHORITY_REVOKED');
  } else if (!authorityIsCurrent(
    assigned,
    [evidence?.submitted_at, evidence?.independently_read_at, now],
    'SECURITY_REVIEW',
    candidate,
  )) codes.push('APPROVAL_SECURITY_AUTHORITY_STALE');
  if (!hasExactKeys(evidence, SECURITY_EVIDENCE_KEYS)) return [...codes, 'APPROVAL_SECURITY_REVIEW_REQUIRED'];
  if (
    evidence.actor_id !== assigned?.actor_id
    || evidence.actor_node_id !== assigned?.actor_node_id
    || evidence.actor_login !== assigned?.actor_login
  ) codes.push('APPROVAL_SECURITY_REVIEW_ACTOR_MISMATCH');
  if (
    evidence.review_state !== 'APPROVED'
    || evidence.dismissed !== false
    || evidence.superseded !== false
    || evidence.later_changes_requested !== false
    || evidence.revocation_status !== 'ACTIVE'
    || !isCausalOrder(evidence.submitted_at, evidence.independently_read_at, candidate.verifier?.read_at, now)
  ) codes.push('APPROVAL_SECURITY_REVIEW_REQUIRED');
  const expectedCommand = parseApprovalReviewCommand(
    `APPROVE DECISION ${candidate.decision.adr} REV ${candidate.decision.policy_revision} ROLE OWN-SECURITY DIGEST ${candidate.decision.raw_sha256}`,
  );
  if (
    evidence.schema_version !== 'program-c-security-review-evidence/v1'
    || evidence.repository_id !== candidate.repository.id
    || evidence.repository_full_name !== candidate.repository.full_name
    || evidence.decision_adr !== candidate.decision.adr
    || evidence.decision_revision !== candidate.decision.revision
    || evidence.policy_revision !== candidate.decision.policy_revision
    || evidence.proposal_pr_number !== candidate.pull_request.number
    || evidence.base_sha !== candidate.pull_request.base_sha
    || evidence.head_sha !== candidate.pull_request.head_sha
    || evidence.review_commit_id !== candidate.pull_request.head_sha
    || evidence.decision_raw_sha256 !== candidate.decision.raw_sha256
    || evidence.decision_semantic_sha256 !== candidate.decision.semantic_sha256
    || evidence.proposed_sidecar_path !== candidate.decision.proposed_sidecar_path
    || evidence.proposed_sidecar_raw_sha256 !== candidate.decision.proposed_sidecar_raw_sha256
    || evidence.role !== 'OWN-SECURITY'
    || evidence.authority_revision !== candidate.authority_revision
    || evidence.authority_sha256 !== candidate.authority_sha256
    || evidence.review_command_sha256 !== expectedCommand.command_sha256
    || evidence.scope !== 'SECURITY_REVIEW'
  ) codes.push('APPROVAL_SECURITY_REVIEW_HEAD_MISMATCH');
  return codes;
};

const validateLegal = (candidate, authority, now) => {
  const input = candidate.legal_input;
  if (!isPlainObject(input) || input.status !== 'NO_BLOCKER_RECORDED') return ['APPROVAL_LEGAL_INPUT_REQUIRED'];
  if (input.revocation_status !== 'ACTIVE') return ['APPROVAL_LEGAL_INPUT_REVOKED'];
  const assigned = authorityRole(authority, 'LEGAL-REVIEW');
  if (
    !authorityIsCurrent(assigned, [input.effective_at, now], 'LEGAL_REVIEW', candidate)
    || input.authority_revision !== candidate.authority_revision
    || input.authority_sha256 !== candidate.authority_sha256
    || input.actor_id !== assigned?.actor_id
    || input.actor_node_id !== assigned?.actor_node_id
    || input.actor_login !== assigned?.actor_login
    || input.reviewed_head_sha !== candidate.pull_request.head_sha
    || input.decision_raw_sha256 !== candidate.decision.raw_sha256
    || input.decision_semantic_sha256 !== candidate.decision.semantic_sha256
    || !isCanonicalInstant(input.valid_until)
    || !isCausalOrder(input.effective_at, candidate.verifier?.read_at, now, input.valid_until)
  ) return ['APPROVAL_LEGAL_INPUT_STALE'];
  return [];
};

const validateGlobalIsolation = (candidate, _policy) => {
  const codes = [];
  const humanIds = [
    candidate.product_review?.review_id,
    candidate.privacy_review?.review_id,
    candidate.qa_review?.review_id,
    candidate.security_review?.review_id,
    candidate.codeowner_review?.review_id,
  ];
  const machineIds = Array.isArray(candidate.machine_checks)
    ? candidate.machine_checks.flatMap((check) => [check?.check_run_id, check?.check_suite_id])
    : [];
  const allIds = [...humanIds, ...machineIds];
  if (
    CODEOWNER_ACTOR_SHARING_POLICY.evidence_id_uniqueness
      === 'ALL_HUMAN_AND_MACHINE_EVIDENCE_IDS_DISTINCT'
    && (allIds.some((id) => !isSafePositiveInteger(id)) || new Set(allIds).size !== allIds.length)
  ) {
    codes.push('APPROVAL_EVIDENCE_SLOT_REUSE');
  }
  if (
    humanIds.slice(0, 3).includes(candidate.security_review?.review_id)
    || machineIds.includes(candidate.security_review?.review_id)
  ) codes.push('APPROVAL_SECURITY_REVIEW_REUSED');

  const actors = [
    candidate.product_review?.actor?.id,
    candidate.privacy_review?.actor?.id,
    candidate.qa_review?.actor?.id,
    candidate.security_review?.actor_id,
    candidate.codeowner_review?.actor?.id,
  ];
  const actorByRole = new Map([
    ['OWN-PRODUCT', actors[0]],
    ['OWN-DATA-PRIVACY', actors[1]],
    ['OWN-QA-EVIDENCE', actors[2]],
  ]);
  const securityConflicts = CODEOWNER_ACTOR_SHARING_POLICY.security_actor_isolation_roles
    .map((role) => actorByRole.get(role))
    .includes(actors[3]);
  const codeownerSharesRoleActor = actors.slice(0, 4).includes(actors[4]);
  if (
    codeownerSharesRoleActor
    && CODEOWNER_ACTOR_SHARING_POLICY.codeowner_actor_reuse
      !== 'ALLOWED_WITH_DISTINCT_EVIDENCE_IDS'
  ) codes.push('APPROVAL_EVIDENCE_SLOT_REUSE');
  if (securityConflicts) {
    codes.push('APPROVAL_EVIDENCE_SLOT_REUSE');
    codes.push('APPROVAL_SECURITY_REVIEW_REUSED');
  }
  return codes;
};

export const validateRoleEvidence = (candidate, authority, policy, now) => {
  const codes = [];
  codes.push(...validateReview(candidate, authority, candidate.product_review, 'OWN-PRODUCT', 'DECISION_REVIEW', policy, now));
  codes.push(...validateReview(candidate, authority, candidate.privacy_review, 'OWN-DATA-PRIVACY', 'DECISION_REVIEW', policy, now));
  codes.push(...validateReview(candidate, authority, candidate.qa_review, 'OWN-QA-EVIDENCE', 'QA_EVIDENCE_REVIEW', policy, now));
  codes.push(...validateDualRolePolicy(candidate, policy, now));
  codes.push(...validateCodeowner(candidate, now));
  codes.push(...validateSecurity(candidate, authority, now));
  if (approvalLegalEvidenceRequired({
    decisionAdr: candidate.decision?.adr,
    actorPolicy: policy.actor_policy,
  })) {
    codes.push(...validateLegal(candidate, authority, now));
  }
  codes.push(...validateGlobalIsolation(candidate, policy));
  const humanActors = new Set([
    candidate.product_review?.actor?.id,
    candidate.privacy_review?.actor?.id,
    candidate.qa_review?.actor?.id,
    candidate.security_review?.actor_id,
    candidate.codeowner_review?.actor?.id,
  ].filter(isSafePositiveInteger));
  const minimumHumans = policy.actor_policy === 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER'
    ? Math.max(policy.minimum_distinct_human_actors, CODEOWNER_ACTOR_SHARING_POLICY.minimum_distinct_humans)
    : policy.minimum_distinct_human_actors;
  if (humanActors.size < minimumHumans) codes.push('APPROVAL_DISTINCT_ACTORS_REQUIRED');
  return codes;
};
