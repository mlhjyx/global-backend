import { createHash } from 'node:crypto';

import { buildApprovalReceiptArtifact as buildSafeApprovalReceiptArtifact } from './governance-approval-safe-json.mjs';
const REPOSITORY_ID = 1291151138;
const REPOSITORY_FULL_NAME = 'mlhjyx/global-backend';
const MAX_ISSUES = 16;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const ID_PATTERN = /^[a-z][a-z0-9-]{7,127}$/;
const POLICY_REVISION_PATTERN = /^program-c\/policy-r[1-9][0-9]*$/;
const DECISION_REVISION_PATTERN = /^program-c\/decision-r[1-9][0-9]*$/;
const AUTHORITY_REVISION_PATTERN = /^approval-authorities\/r[1-9][0-9]*$/;
const NONCE_PATTERN = /^nonce-program-c-[a-z0-9-]{4,96}$/;
const CANONICAL_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REVIEW_COMMAND_PATTERN = /^APPROVE DECISION (ADR-042) REV (program-c\/policy-r[1-9][0-9]*) ROLE (OWN-PRODUCT|OWN-DATA-PRIVACY|OWN-QA-EVIDENCE|OWN-SECURITY) DIGEST (sha256:[0-9a-f]{64})$/;
const SECURITY_EVIDENCE_KEYS = Object.freeze([
  'schema_version',
  'evidence_id',
  'repository_id',
  'repository_full_name',
  'decision_adr',
  'decision_revision',
  'policy_revision',
  'proposal_pr_number',
  'base_sha',
  'head_sha',
  'decision_raw_sha256',
  'decision_semantic_sha256',
  'proposed_sidecar_path',
  'proposed_sidecar_raw_sha256',
  'role',
  'authority_revision',
  'authority_sha256',
  'actor_id',
  'actor_node_id',
  'actor_login',
  'review_id',
  'review_state',
  'review_commit_id',
  'review_command_sha256',
  'submitted_at',
  'independently_read_at',
  'scope',
  'revocation_status',
  'supersedes_evidence_id',
  'dismissed',
  'superseded',
  'later_changes_requested',
]);
const GRANT_KEYS = Object.freeze([
  'schema_version',
  'grant_id',
  'repository',
  'decision_adr',
  'decision_revision',
  'policy_revision',
  'stage',
  'pr_number',
  'base_sha',
  'head_sha',
  'decision_raw_sha256',
  'decision_semantic_sha256',
  'allowed_merge_method',
  'authority_role',
  'authority_actor_id',
  'authority_revision',
  'authority_sha256',
  'authority_receipt_id',
  'authority_receipt_core_sha256',
  'authority_receipt_raw_sha256',
  'authorized_at',
  'expires_at',
  'single_use_nonce',
]);
const REVOCATION_KEYS = Object.freeze([
  'schema_version',
  'receipt_id',
  'receipt_core_sha256',
  'receipt_raw_sha256',
  'authority_revision',
  'authority_sha256',
  'reason_code',
  'revoking_role',
  'revoking_actor_id',
  'effective_at',
]);
const SUPERSESSION_KEYS = Object.freeze([
  'schema_version',
  'predecessor',
  'successor',
  'authority_revision',
  'authority_sha256',
  'effective_at',
  'predecessor_chain',
]);

const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
);

const hasExactKeys = (value, keys) => (
  isPlainObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
);

const isSafePositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isSafeNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const isDigest = (value) => typeof value === 'string' && DIGEST_PATTERN.test(value);
const isGitSha = (value) => typeof value === 'string' && GIT_SHA_PATTERN.test(value);
const isId = (value) => typeof value === 'string' && ID_PATTERN.test(value);
const isCanonicalInstant = (value) => (
  typeof value === 'string'
  && CANONICAL_INSTANT_PATTERN.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value)).toISOString() === value
);
const instantValue = (value) => (isCanonicalInstant(value) ? Date.parse(value) : Number.NaN);

const sha256 = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const approvalError = (code) => new Error(code);

const resultFromCodes = (codes, facts) => {
  const unique = [...new Set(codes.filter((code) => typeof code === 'string' && code.startsWith('APPROVAL_')))].slice(0, MAX_ISSUES);
  if (codes.length > MAX_ISSUES && unique.length === MAX_ISSUES) {
    unique[MAX_ISSUES - 1] = 'APPROVAL_ISSUE_OVERFLOW';
  }
  const result = {
    valid: unique.length === 0,
    issues: unique.map((stableCode) => ({ stable_code: stableCode })),
  };
  if (unique.length === 0 && facts !== undefined) result.facts = facts;
  return deepFreeze(result);
};

const repositoryMatches = (value) => (
  isPlainObject(value)
  && value.id === REPOSITORY_ID
  && value.full_name === REPOSITORY_FULL_NAME
);

const authorityRole = (authority, role) => (
  Array.isArray(authority?.roles)
    ? authority.roles.find((entry) => entry?.role === role)
    : undefined
);

const authorityIsCurrent = (entry, now, purpose, candidate) => (
  entry?.status === 'ASSIGNED'
  && isSafePositiveInteger(entry.actor_id)
  && typeof entry.actor_node_id === 'string'
  && entry.actor_node_id.length > 0
  && typeof entry.actor_login === 'string'
  && entry.actor_login.length > 0
  && isCanonicalInstant(entry.effective_from)
  && isCanonicalInstant(entry.effective_until)
  && instantValue(entry.effective_from) <= instantValue(now)
  && instantValue(now) < instantValue(entry.effective_until)
  && entry.scope?.repository_id === candidate?.repository?.id
  && entry.scope?.decision_adr === candidate?.decision?.adr
  && entry.scope?.policy_revision === candidate?.decision?.policy_revision
  && entry.scope?.purpose === purpose
  && entry.revocation_status === 'ACTIVE'
  && entry.superseded_by === null
);

const authorityIntervalContains = (entry, instant) => (
  isCanonicalInstant(instant)
  && isCanonicalInstant(entry?.effective_from)
  && isCanonicalInstant(entry?.effective_until)
  && instantValue(entry.effective_from) <= instantValue(instant)
  && instantValue(instant) < instantValue(entry.effective_until)
);

const commandFromParsed = (parsed) => (
  isPlainObject(parsed)
    ? `APPROVE DECISION ${parsed.decision_adr} REV ${parsed.policy_revision} ROLE ${parsed.role} DIGEST ${parsed.decision_raw_sha256}`
    : ''
);

const parsedCommandMatches = (parsed, role, candidate) => (
  isPlainObject(parsed)
  && parsed.decision_adr === candidate.decision.adr
  && parsed.policy_revision === candidate.decision.policy_revision
  && parsed.role === role
  && parsed.decision_raw_sha256 === candidate.decision.raw_sha256
  && isDigest(parsed.command_sha256)
  && parsed.command_sha256 === sha256(commandFromParsed(parsed))
  && hasExactKeys(parsed, [
    'decision_adr',
    'policy_revision',
    'role',
    'decision_raw_sha256',
    'command_sha256',
  ])
);

const validateReview = (candidate, authority, review, role, purpose, policy) => {
  const codes = [];
  const assigned = authorityRole(authority, role);
  if (assigned?.status !== 'ASSIGNED') codes.push('APPROVAL_OWNER_UNASSIGNED');
  else if (
    !authorityIsCurrent(assigned, review?.submitted_at, purpose, candidate)
    || !authorityIntervalContains(assigned, review?.independently_read_at)
  ) codes.push('APPROVAL_ROLE_AUTHORITY_STALE');
  if (!isPlainObject(review)) return [...codes, 'APPROVAL_REVIEW_REQUIRED'];
  if (review.role !== role || !parsedCommandMatches(review.command, role, candidate)) {
    codes.push(review.role !== role ? 'APPROVAL_REVIEW_ROLE_MISMATCH' : 'APPROVAL_REVIEW_COMMAND_INVALID');
  }
  if (review.review_state !== 'APPROVED') codes.push('APPROVAL_REVIEW_REQUIRED');
  if (review.dismissed === true) codes.push('APPROVAL_REVIEW_DISMISSED');
  if (review.superseded === true || review.later_changes_requested === true) codes.push('APPROVAL_REVIEW_STALE');
  if (review.review_commit_id !== candidate.pull_request.head_sha) codes.push('APPROVAL_REVIEW_STALE');
  const dualPrivacy = (
    role === 'OWN-DATA-PRIVACY'
    && policy.actor_policy === 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER'
    && review.actor?.id === candidate.product_review?.actor?.id
  );
  const actorMismatch = (
    !isPlainObject(review.actor)
    || !isSafePositiveInteger(review.actor.id)
    || review.actor.type !== 'User'
    || review.actor.id === candidate.pull_request.author?.id
    || (!dualPrivacy && (
      review.actor.id !== assigned?.actor_id
      || review.actor.node_id !== assigned?.actor_node_id
      || review.actor.login !== assigned?.actor_login
    ))
  );
  if (actorMismatch) codes.push('APPROVAL_REVIEW_ACTOR_MISMATCH');
  if (!isSafePositiveInteger(review.review_id) || !isCanonicalInstant(review.submitted_at) || !isCanonicalInstant(review.independently_read_at)) {
    codes.push('APPROVAL_REVIEW_STALE');
  }
  return codes;
};

const validateDualRolePolicy = (candidate, policy, now) => {
  const codes = [];
  const productActor = candidate.product_review?.actor?.id;
  const privacyActor = candidate.privacy_review?.actor?.id;
  if (policy.actor_policy === 'DISTINCT_ACTORS_REQUIRED') {
    if (productActor === privacyActor) codes.push('APPROVAL_DISTINCT_ACTORS_REQUIRED');
    return codes;
  }
  if (policy.actor_policy !== 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER') {
    return ['APPROVAL_DISTINCT_ACTORS_REQUIRED'];
  }
  const exception = policy.dual_role_exception;
  const exceptionDuration = instantValue(exception?.valid_until) - instantValue(exception?.valid_from);
  if (
    !isPlainObject(exception)
    || exception.decision_adr !== candidate.decision.adr
    || !isCanonicalInstant(exception.valid_from)
    || !isCanonicalInstant(exception.valid_until)
    || instantValue(exception.valid_from) > instantValue(now)
    || instantValue(now) >= instantValue(exception.valid_until)
    || exceptionDuration <= 0
    || exceptionDuration > 30 * 24 * 60 * 60 * 1000
    || !['OWN-QA-EVIDENCE', 'LEGAL-REVIEW'].includes(exception.coapprover_role)
    || exception.minimum_distinct_human_actors !== 2
    || exception.cannot_authorize_merge !== true
    || exception.cannot_authorize_release !== true
    || candidate.legal_input?.status !== 'NO_BLOCKER_RECORDED'
  ) {
    codes.push('APPROVAL_DISTINCT_ACTORS_REQUIRED');
  }
  const coapproverActor = exception?.coapprover_role === 'LEGAL-REVIEW'
    ? candidate.legal_input?.actor_id
    : candidate.qa_review?.actor?.id;
  if (productActor === privacyActor && (coapproverActor === productActor || !isSafePositiveInteger(coapproverActor))) {
    codes.push('APPROVAL_DISTINCT_ACTORS_REQUIRED');
  }
  return codes;
};

const validateSecurity = (candidate, authority) => {
  const codes = [];
  const evidence = candidate.security_review;
  const assigned = authorityRole(authority, 'OWN-SECURITY');
  if (assigned?.status !== 'ASSIGNED') codes.push('APPROVAL_SECURITY_OWNER_UNASSIGNED');
  else if (assigned.revocation_status !== 'ACTIVE' || assigned.superseded_by !== null) codes.push('APPROVAL_SECURITY_AUTHORITY_REVOKED');
  else if (
    !authorityIsCurrent(assigned, evidence?.submitted_at, 'SECURITY_REVIEW', candidate)
    || !authorityIntervalContains(assigned, evidence?.independently_read_at)
  ) codes.push('APPROVAL_SECURITY_AUTHORITY_STALE');
  if (!hasExactKeys(evidence, SECURITY_EVIDENCE_KEYS)) return [...codes, 'APPROVAL_SECURITY_REVIEW_REQUIRED'];

  const otherHumanActors = [
    candidate.product_review?.actor?.id,
    candidate.privacy_review?.actor?.id,
    candidate.qa_review?.actor?.id,
    candidate.codeowner_review?.actor?.id,
  ];
  const machineChecks = Array.isArray(candidate.machine_checks) ? candidate.machine_checks : [];
  const otherEvidenceIds = [
    candidate.product_review?.review_id,
    candidate.privacy_review?.review_id,
    candidate.qa_review?.review_id,
    candidate.codeowner_review?.review_id,
    ...machineChecks.map((check) => check?.check_run_id),
    ...machineChecks.map((check) => check?.check_suite_id),
  ];
  if (otherHumanActors.includes(evidence.actor_id) || otherEvidenceIds.includes(evidence.review_id)) {
    codes.push('APPROVAL_SECURITY_REVIEW_REUSED');
  }
  if (
    evidence.actor_id !== assigned?.actor_id
    || evidence.actor_node_id !== assigned?.actor_node_id
    || evidence.actor_login !== assigned?.actor_login
  ) {
    codes.push('APPROVAL_SECURITY_REVIEW_ACTOR_MISMATCH');
  }
  if (
    evidence.review_state !== 'APPROVED'
    || evidence.dismissed !== false
    || evidence.superseded !== false
    || evidence.later_changes_requested !== false
    || evidence.revocation_status !== 'ACTIVE'
  ) {
    codes.push('APPROVAL_SECURITY_REVIEW_REQUIRED');
  }
  const expectedCommand = parseApprovalReviewCommand(commandFromParsed({
    decision_adr: candidate.decision.adr,
    policy_revision: candidate.decision.policy_revision,
    role: 'OWN-SECURITY',
    decision_raw_sha256: candidate.decision.raw_sha256,
  }));
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
  ) {
    codes.push('APPROVAL_SECURITY_REVIEW_HEAD_MISMATCH');
  }
  return codes;
};

const validateLegal = (candidate, authority, now) => {
  const input = candidate.legal_input;
  if (!isPlainObject(input) || input.status !== 'NO_BLOCKER_RECORDED') return ['APPROVAL_LEGAL_INPUT_REQUIRED'];
  if (input.revocation_status !== 'ACTIVE') return ['APPROVAL_LEGAL_INPUT_REVOKED'];
  const assigned = authorityRole(authority, 'LEGAL-REVIEW');
  if (
    !authorityIsCurrent(assigned, input.effective_at, 'LEGAL_REVIEW', candidate)
    || input.authority_revision !== candidate.authority_revision
    || input.authority_sha256 !== candidate.authority_sha256
    || input.actor_id !== assigned?.actor_id
    || input.actor_node_id !== assigned?.actor_node_id
    || input.actor_login !== assigned?.actor_login
    || input.reviewed_head_sha !== candidate.pull_request.head_sha
    || input.decision_raw_sha256 !== candidate.decision.raw_sha256
    || input.decision_semantic_sha256 !== candidate.decision.semantic_sha256
    || !isCanonicalInstant(input.valid_until)
    || instantValue(now) >= instantValue(input.valid_until)
  ) return ['APPROVAL_LEGAL_INPUT_STALE'];
  return [];
};

const validateMachineChecks = (candidate, policy) => {
  const codes = [];
  if (Object.hasOwn(policy, 'allowedCheckRunIds') || Object.hasOwn(policy, 'allowedCheckSuiteIds')) {
    codes.push('APPROVAL_CHECK_WORKFLOW_MISMATCH');
  }
  if (!Array.isArray(policy.required_machine_checks) || !Array.isArray(candidate.machine_checks)) {
    return [...codes, 'APPROVAL_CHECK_REQUIRED'];
  }
  for (const required of policy.required_machine_checks) {
    const matching = candidate.machine_checks.filter((check) => check?.context === required.context);
    if (matching.length === 0) {
      codes.push('APPROVAL_CHECK_REQUIRED');
      continue;
    }
    if (matching.length !== 1) {
      codes.push('APPROVAL_CHECK_AMBIGUOUS');
      continue;
    }
    const check = matching[0];
    const dynamicEvidencePresent = (
      isSafePositiveInteger(check.check_run_id)
      && isSafePositiveInteger(check.check_suite_id)
      && isSafePositiveInteger(check.actions_run_id)
      && isSafePositiveInteger(check.actions_run_attempt)
    );
    if (!dynamicEvidencePresent || check.actions_run_conclusion !== 'success') codes.push('APPROVAL_CHECK_REQUIRED');
    const signerMatches = required.reusable_signer === null
      ? check.reusable_signer === null
      : (
        isPlainObject(check.reusable_signer)
        && check.reusable_signer.workflow_id === required.reusable_signer.workflow_id
        && check.reusable_signer.workflow_path === required.reusable_signer.workflow_path
        && check.reusable_signer.workflow_sha === required.reusable_signer.workflow_sha
      );
    if (
      check.github_app_id !== required.github_app_id
      || check.github_app_slug !== required.github_app_slug
      || check.workflow_id !== required.workflow_id
      || check.workflow_path !== required.workflow_path
      || check.trusted_base_workflow_blob_sha !== required.trusted_base_workflow_blob_sha
      || check.actions_run_event !== 'pull_request_target'
      || check.actions_run_head_sha !== candidate.pull_request.head_sha
      || !signerMatches
    ) codes.push('APPROVAL_CHECK_WORKFLOW_MISMATCH');
  }
  return codes;
};

const snapshotsMatch = (candidate) => {
  if (
    !isPlainObject(candidate.pull_request)
    || !isPlainObject(candidate.ruleset)
    || !isPlainObject(candidate.decision)
  ) return false;
  const expected = {
    head_sha: candidate.pull_request.head_sha,
    base_sha: candidate.pull_request.base_sha,
    authority_sha256: candidate.authority_sha256,
    ruleset_sha256: candidate.ruleset.normalized_sha256,
    decision_raw_sha256: candidate.decision.raw_sha256,
    decision_semantic_sha256: candidate.decision.semantic_sha256,
  };
  return JSON.stringify(candidate.pre_read) === JSON.stringify(expected)
    && JSON.stringify(candidate.post_read) === JSON.stringify(expected);
};

const verifierMatches = (candidate, policy) => {
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
  );
};

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

  codes.push(...validateReview(candidate, authority, candidate.product_review, 'OWN-PRODUCT', 'DECISION_REVIEW', policy));
  codes.push(...validateReview(candidate, authority, candidate.privacy_review, 'OWN-DATA-PRIVACY', 'DECISION_REVIEW', policy));
  codes.push(...validateReview(candidate, authority, candidate.qa_review, 'OWN-QA-EVIDENCE', 'QA_EVIDENCE_REVIEW', policy));
  if (!isPlainObject(candidate.codeowner_review)) codes.push('APPROVAL_CODEOWNER_REVIEW_REQUIRED');
  if (!isPlainObject(candidate.qa_review)) codes.push('APPROVAL_QA_REVIEW_REQUIRED');
  codes.push(...validateDualRolePolicy(candidate, policy, now));
  codes.push(...validateSecurity(candidate, authority));
  codes.push(...validateLegal(candidate, authority, now));
  codes.push(...validateMachineChecks(candidate, policy));
  const expectedManifestPath = typeof candidate.decision.proposed_sidecar_path === 'string'
    ? candidate.decision.proposed_sidecar_path.replace(/\.md$/, '.manifest.json')
    : '';
  if (
    !Array.isArray(policy.pr_readable_paths)
    || !policy.pr_readable_paths.includes(candidate.decision.proposed_sidecar_path)
    || !policy.pr_readable_paths.includes(expectedManifestPath)
  ) codes.push('APPROVAL_PROPOSED_SIDECAR_REQUIRED');

  const roleReviewIds = [
    candidate.product_review?.review_id,
    candidate.privacy_review?.review_id,
    candidate.qa_review?.review_id,
    candidate.codeowner_review?.review_id,
    candidate.security_review?.review_id,
  ];
  if (new Set(roleReviewIds).size !== roleReviewIds.length) codes.push('APPROVAL_EVIDENCE_SLOT_REUSE');
  const humanActors = new Set([
    candidate.product_review?.actor?.id,
    candidate.privacy_review?.actor?.id,
    candidate.qa_review?.actor?.id,
    candidate.security_review?.actor_id,
  ].filter(isSafePositiveInteger));
  if (humanActors.size < policy.minimum_distinct_human_actors) codes.push('APPROVAL_DISTINCT_ACTORS_REQUIRED');
  if (candidate.review_pagination_complete !== true) codes.push('APPROVAL_PAGINATION_INCOMPLETE');
  if (candidate.ruleset?.normalized_sha256 !== policy.live_ruleset_sha256) codes.push('APPROVAL_RULESET_DRIFT');
  if (!Array.isArray(candidate.ruleset?.bypass_actors) || candidate.ruleset.bypass_actors.length !== 0) {
    codes.push('APPROVAL_RULESET_BYPASS_PRESENT');
  }
  if (!snapshotsMatch(candidate)) codes.push('APPROVAL_TOCTOU_DETECTED');
  if (!verifierMatches(candidate, policy)) codes.push('APPROVAL_INDEPENDENCE_NOT_PROVEN');
  if (candidate.receipt_subject?.prior_receipt_ids?.includes(candidate.receipt_subject?.receipt_id)) {
    codes.push('APPROVAL_RECEIPT_REPLAYED');
  }
  if (candidate.receipt_subject?.revoked_receipt_ids?.includes(candidate.receipt_subject?.receipt_id)) {
    codes.push('APPROVAL_POLICY_REVOKED');
  }
  if (
    !Number.isSafeInteger(policy.receipt_validity_ms)
    || !Number.isSafeInteger(policy.maximum_receipt_validity_ms)
    || policy.receipt_validity_ms <= 0
    || policy.receipt_validity_ms > policy.maximum_receipt_validity_ms
  ) codes.push('APPROVAL_RECEIPT_EXPIRED');
  return resultFromCodes(codes);
};

const expectedMergeStage = (candidate) => (
  candidate.receipt_subject?.phase === 'ACCEPTANCE_REVALIDATION'
    ? 'ACCEPTANCE_MERGE'
    : 'PROPOSAL_MERGE'
);

export const validateMergeAuthorizationGrantForCandidate = (evidence, candidate, authority, now) => {
  const codes = [];
  if (!isPlainObject(evidence) || !isPlainObject(evidence.grant)) {
    return resultFromCodes(['APPROVAL_MERGE_AUTHORIZATION_GRANT_REQUIRED']);
  }
  const grant = evidence.grant;
  if (!hasExactKeys(grant, GRANT_KEYS)) codes.push('APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH');
  const mergeAuthority = authorityRole(authority, 'MERGE-AUTHORIZER');
  if (grant.authority_role !== 'MERGE-AUTHORIZER' || mergeAuthority?.status !== 'ASSIGNED') {
    codes.push('APPROVAL_MERGE_AUTHORIZER_UNASSIGNED');
  }
  const expectedStage = expectedMergeStage(candidate);
  if (grant.stage !== expectedStage) codes.push('APPROVAL_MERGE_AUTHORIZATION_STAGE_MISMATCH');
  if (
    grant.schema_version !== 'program-c-merge-authorization-grant/v1'
    || !isId(grant.grant_id)
    || !repositoryMatches(grant.repository)
    || grant.decision_adr !== candidate.decision.adr
    || grant.decision_revision !== candidate.decision.revision
    || grant.policy_revision !== candidate.decision.policy_revision
    || grant.pr_number !== candidate.pull_request.number
    || grant.base_sha !== candidate.pull_request.base_sha
    || grant.head_sha !== candidate.pull_request.head_sha
    || grant.authority_actor_id !== mergeAuthority?.actor_id
    || grant.authority_revision !== authority.revision
    || grant.authority_sha256 !== authority.sha256
    || !authorityIsCurrent(mergeAuthority, grant.authorized_at, 'MERGE_AUTHORIZATION', candidate)
    || !isCanonicalInstant(grant.expires_at)
    || instantValue(now) >= instantValue(grant.expires_at)
    || !NONCE_PATTERN.test(grant.single_use_nonce ?? '')
  ) codes.push('APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
  if (
    grant.decision_raw_sha256 !== candidate.decision.raw_sha256
    || grant.decision_semantic_sha256 !== candidate.decision.semantic_sha256
    || !isDigest(evidence.grant_raw_sha256)
  ) codes.push('APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH');
  if (evidence.grant_revocations?.some((item) => (
    item?.grant_id === grant.grant_id && item?.grant_raw_sha256 === evidence.grant_raw_sha256
  ))) codes.push('APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');

  const consumption = evidence.consumption;
  if (!isPlainObject(consumption)) {
    codes.push('APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED');
  } else {
    if (consumption.single_use_nonce !== grant.single_use_nonce || consumption.nonce_ledger_key !== `program-c-merge:${grant.single_use_nonce}`) {
      codes.push('APPROVAL_MERGE_AUTHORIZATION_REPLAYED');
    }
    if (
      consumption.schema_version !== 'program-c-merge-authorization-consumption/v1'
      || consumption.grant_id !== grant.grant_id
      || consumption.grant_raw_sha256 !== evidence.grant_raw_sha256
      || consumption.repository?.id !== candidate.repository.id
      || consumption.decision_adr !== grant.decision_adr
      || consumption.decision_revision !== grant.decision_revision
      || consumption.policy_revision !== grant.policy_revision
      || consumption.stage !== grant.stage
      || consumption.pr_number !== grant.pr_number
      || consumption.authorized_head_sha !== grant.head_sha
      || consumption.observed_merge_method !== grant.allowed_merge_method
      || !isDigest(evidence.consumption_raw_sha256)
      || !isSafeNonNegativeInteger(consumption.nonce_ledger_reserved_revision)
    ) codes.push('APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH');
  }

  const reservation = evidence.ledger_snapshot?.reservations?.filter((item) => (
    item?.key === consumption?.nonce_ledger_key
    && item?.grant_id === grant.grant_id
    && item?.grant_raw_sha256 === evidence.grant_raw_sha256
    && item?.single_use_nonce === grant.single_use_nonce
  ));
  if (
    evidence.ledger_snapshot?.durability_class !== 'SHARED_DURABLE_CAS'
    || !isSafeNonNegativeInteger(evidence.ledger_snapshot?.committed_revision)
    || !Array.isArray(reservation)
    || reservation.length !== 1
    || reservation[0]?.state !== 'CONSUMED'
  ) codes.push('APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED');
  else if (
    reservation[0].reserved_revision !== consumption?.nonce_ledger_reserved_revision
    || evidence.ledger_snapshot.committed_revision < reservation[0].reserved_revision
  ) codes.push('APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH');
  return resultFromCodes(codes);
};

const reviewForReceiptRole = (candidate) => {
  if (candidate.receipt_subject.role === 'OWN-PRODUCT') return candidate.product_review;
  if (candidate.receipt_subject.role === 'OWN-DATA-PRIVACY') return candidate.privacy_review;
  if (candidate.receipt_subject.role === 'OWN-QA-EVIDENCE') return candidate.qa_review;
  if (candidate.receipt_subject.role === 'OWN-SECURITY') {
    return {
      actor: {
        id: candidate.security_review.actor_id,
        login: candidate.security_review.actor_login,
      },
      submitted_at: candidate.security_review.submitted_at,
    };
  }
  return undefined;
};

export const buildApprovalReceiptCore = (candidate, authority, verifier, mergeAuthorizationEvidence, now) => {
  const validation = validateApprovalReadback(candidate, authority, candidate?.policy, now);
  if (!validation.valid) throw approvalError(validation.issues[0].stable_code);
  if (JSON.stringify(verifier) !== JSON.stringify(candidate.verifier)) {
    throw approvalError('APPROVAL_INDEPENDENCE_NOT_PROVEN');
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
  };
  if (mergeAuthorizationEvidence !== null && mergeAuthorizationEvidence !== undefined) {
    const mergeValidation = validateMergeAuthorizationGrantForCandidate(
      mergeAuthorizationEvidence,
      candidate,
      authority,
      now,
    );
    if (!mergeValidation.valid) throw approvalError(mergeValidation.issues[0].stable_code);
    const { grant, consumption } = mergeAuthorizationEvidence;
    core.merge_authorization_evidence = {
      stage: grant.stage,
      grant_id: grant.grant_id,
      grant_raw_sha256: mergeAuthorizationEvidence.grant_raw_sha256,
      single_use_nonce: grant.single_use_nonce,
      consumption_id: consumption.consumption_id,
      consumption_raw_sha256: mergeAuthorizationEvidence.consumption_raw_sha256,
      reserved_ledger_revision: consumption.nonce_ledger_reserved_revision,
    };
  }
  return deepFreeze(core);
};

export const buildApprovalReceiptArtifact = (core) => buildSafeApprovalReceiptArtifact(core);

const receiptRef = (receipt) => ({
  receipt_id: receipt?.envelope?.core?.receipt_id,
  receipt_core_sha256: receipt?.envelope?.receipt_core_sha256,
  receipt_raw_sha256: receipt?.receipt_raw_sha256,
});

const receiptReferenceMatches = (reference, receipt) => {
  const actual = receiptRef(receipt);
  return reference?.receipt_id === actual.receipt_id
    && reference?.receipt_core_sha256 === actual.receipt_core_sha256
    && reference?.receipt_raw_sha256 === actual.receipt_raw_sha256;
};

export const validateReceiptRevocation = (revocation, receipt, authority, now) => {
  const codes = [];
  if (!hasExactKeys(revocation, REVOCATION_KEYS)) return resultFromCodes(['APPROVAL_RECEIPT_DIGEST_MISMATCH']);
  if (!receiptReferenceMatches(revocation, receipt)) codes.push('APPROVAL_RECEIPT_DIGEST_MISMATCH');
  const assigned = authorityRole(authority, revocation.revoking_role);
  if (
    revocation.schema_version !== 'trusted-approval-revocation/v1'
    || revocation.authority_revision !== authority.revision
    || revocation.authority_sha256 !== authority.sha256
    || assigned?.status !== 'ASSIGNED'
    || assigned.actor_id !== revocation.revoking_actor_id
    || !['AUTHORITY_REVOKED', 'EVIDENCE_INVALID', 'POLICY_WITHDRAWN', 'SECURITY_INCIDENT'].includes(revocation.reason_code)
    || !isCanonicalInstant(revocation.effective_at)
    || instantValue(revocation.effective_at) > instantValue(now)
  ) codes.push('APPROVAL_ROLE_AUTHORITY_STALE');
  return resultFromCodes(codes, {
    state: 'REVOKED',
    receipt_id: revocation.receipt_id,
    receipt_core_sha256: revocation.receipt_core_sha256,
    receipt_raw_sha256: revocation.receipt_raw_sha256,
    effective_at: revocation.effective_at,
  });
};

export const validateReceiptSupersession = (supersession, receipts, authority, now) => {
  const codes = [];
  if (!hasExactKeys(supersession, SUPERSESSION_KEYS) || !Array.isArray(receipts)) {
    return resultFromCodes(['APPROVAL_RECEIPT_DIGEST_MISMATCH']);
  }
  const predecessor = receipts.find((receipt) => receipt?.envelope?.core?.receipt_id === supersession.predecessor?.receipt_id);
  const successor = receipts.find((receipt) => receipt?.envelope?.core?.receipt_id === supersession.successor?.receipt_id);
  if (!receiptReferenceMatches(supersession.predecessor, predecessor) || !receiptReferenceMatches(supersession.successor, successor)) {
    codes.push('APPROVAL_RECEIPT_DIGEST_MISMATCH');
  }
  if (
    supersession.predecessor?.receipt_id === supersession.successor?.receipt_id
    || !Array.isArray(supersession.predecessor_chain)
    || supersession.predecessor_chain[0] !== supersession.predecessor?.receipt_id
    || new Set(supersession.predecessor_chain).size !== supersession.predecessor_chain.length
    || supersession.predecessor_chain.includes(supersession.successor?.receipt_id)
  ) codes.push('APPROVAL_RECEIPT_REPLAYED');
  if (
    supersession.schema_version !== 'trusted-approval-supersession/v1'
    || supersession.authority_revision !== authority.revision
    || supersession.authority_sha256 !== authority.sha256
    || !isCanonicalInstant(supersession.effective_at)
    || instantValue(supersession.effective_at) > instantValue(now)
  ) codes.push('APPROVAL_ROLE_AUTHORITY_STALE');
  return resultFromCodes(codes, {
    state: 'SUPERSEDED',
    predecessor_receipt_id: supersession.predecessor.receipt_id,
    successor_receipt_id: supersession.successor.receipt_id,
    effective_at: supersession.effective_at,
  });
};
