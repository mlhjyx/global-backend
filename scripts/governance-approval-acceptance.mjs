import {
  deepFreeze,
  hasExactKeys,
  isCanonicalInstant,
  isDigest,
  isGitSha,
  isPlainObject,
} from './governance-approval-readback-common.mjs';
import { validateApprovalReadback } from './governance-approval-readback.mjs';
import {
  validateProgramCMergeAuthorizationConsumption,
  validateProgramCMergeAuthorizationGrant,
} from './governance-approval-schema-validator.mjs';
import {
  approvalValuesEqual,
  canonicalApprovalDigest,
  validateApprovalLedgerStream,
} from './governance-approval-ledger-stream.mjs';

const EVIDENCE_KEYS = Object.freeze([
  'schemaVersion', 'task3', 'readAt', 'preAcceptanceRead', 'postAcceptanceRead',
  'preAcceptanceReadSha256', 'postAcceptanceReadSha256', 'currentPullRequest',
  'acceptanceDiff', 'reviews', 'authority', 'legal', 'ruleset', 'machineChecks',
  'receipt', 'proposalMain', 'mergeAuthorization',
]);
const TRANSACTION_KEYS = Object.freeze([
  'currentPullRequest', 'acceptanceDiff', 'reviews', 'authority', 'legal',
  'ruleset', 'machineChecks', 'receipt', 'proposalMain', 'mergeAuthorization', 'task3',
]);
const REVIEW_KEYS = Object.freeze([
  'slot', 'reviewId', 'actorId', 'state', 'headSha', 'submittedAt', 'commandDigest',
]);
const AUTHORITY_KEYS = Object.freeze([
  'revision', 'sha256', 'rawSha256', 'effectiveFrom', 'effectiveUntil',
  'assignmentsCurrent', 'revocationStatus', 'reassigned',
]);
const LEGAL_KEYS = Object.freeze([
  'status', 'scope', 'digest', 'validFrom', 'validUntil', 'revocationStatus',
]);
const RULESET_KEYS = Object.freeze(['normalizedSha256', 'bypassActors', 'observedAt']);
const MACHINE_KEYS = Object.freeze([
  'context', 'appId', 'workflowPath', 'workflowSha', 'baseBlobSha', 'signerIdentity',
  'checkRunId', 'checkSuiteId', 'workflowRunId', 'headSha', 'status', 'conclusion',
  'checkRunSuiteAssociated', 'suiteRunAssociated', 'runHeadAssociated',
]);
const RECEIPT_KEYS = Object.freeze([
  'receiptId', 'receiptCoreSha256', 'receiptRawSha256', 'trustState', 'validUntil',
  'priorReceiptIds', 'revoked', 'superseded',
]);
const PROPOSAL_KEYS = Object.freeze([
  'proposalResultCommitSha', 'currentMainSha', 'resultReachableFromCurrentMain',
  'approvedDecisionRawSha256', 'approvedDecisionSemanticSha256',
  'approvedSidecarRawSha256',
]);
const MERGE_KEYS = Object.freeze([
  'grant', 'grantRawSha256', 'request', 'currentMainReadback', 'consumption',
  'consumptionRawSha256', 'ledgerSnapshot',
]);
const CURRENT_PR_KEYS = Object.freeze(['number', 'state', 'baseSha', 'headSha']);
const ACCEPTANCE_DIFF_KEYS = Object.freeze(['complete', 'files']);
const FILE_KEYS = Object.freeze(['path', 'sha256']);
const TASK3_KEYS = Object.freeze(['candidate', 'authority', 'policy']);
const clone = (value) => structuredClone(value);
const frozenClone = (value) => deepFreeze(clone(value));
const nowIso = (now) => {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('APPROVAL_NOW_INVALID');
  return now.toISOString();
};
const pushIssue = (codes, code) => {
  if (typeof code === 'string' && code.startsWith('APPROVAL_')) codes.push(code);
};
const freshInstant = (value, now, maximumAge) => (
  isCanonicalInstant(value)
  && Date.parse(value) <= now.getTime()
  && now.getTime() - Date.parse(value) <= maximumAge
);
const sortedFiles = (files) => Array.isArray(files)
  ? [...files].sort((left, right) => left.path.localeCompare(right.path))
  : [];
const containsForbiddenContent = (value) => {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsForbiddenContent);
  return Object.entries(value).some(([key, child]) => (
    ['body', 'content', 'reviewbody', 'legalcontent', 'freeform', 'free_form'].includes(key.toLowerCase())
    || containsForbiddenContent(child)
  ));
};
const shapeValid = (evidence) => (
  hasExactKeys(evidence, EVIDENCE_KEYS)
  && evidence.schemaVersion === 'approval-acceptance-evidence/v1'
  && hasExactKeys(evidence.task3, TASK3_KEYS)
  && hasExactKeys(evidence.currentPullRequest, CURRENT_PR_KEYS)
  && hasExactKeys(evidence.acceptanceDiff, ACCEPTANCE_DIFF_KEYS)
  && Array.isArray(evidence.acceptanceDiff.files)
  && evidence.acceptanceDiff.files.every((file) => hasExactKeys(file, FILE_KEYS))
  && Array.isArray(evidence.reviews)
  && evidence.reviews.every((review) => hasExactKeys(review, REVIEW_KEYS))
  && hasExactKeys(evidence.authority, AUTHORITY_KEYS)
  && hasExactKeys(evidence.legal, LEGAL_KEYS)
  && hasExactKeys(evidence.ruleset, RULESET_KEYS)
  && Array.isArray(evidence.machineChecks)
  && evidence.machineChecks.every((check) => hasExactKeys(check, MACHINE_KEYS))
  && hasExactKeys(evidence.receipt, RECEIPT_KEYS)
  && hasExactKeys(evidence.proposalMain, PROPOSAL_KEYS)
  && hasExactKeys(evidence.mergeAuthorization, MERGE_KEYS)
  && hasExactKeys(evidence.preAcceptanceRead, TRANSACTION_KEYS)
  && hasExactKeys(evidence.postAcceptanceRead, TRANSACTION_KEYS)
  && isDigest(evidence.preAcceptanceReadSha256)
  && isDigest(evidence.postAcceptanceReadSha256)
);
const transactionFrom = (evidence) => Object.fromEntries(
  TRANSACTION_KEYS.map((key) => [key, evidence[key]]),
);
const transactionValid = (evidence) => {
  const current = transactionFrom(evidence);
  return evidence.preAcceptanceReadSha256 === canonicalApprovalDigest(evidence.preAcceptanceRead)
    && evidence.postAcceptanceReadSha256 === canonicalApprovalDigest(evidence.postAcceptanceRead)
    && evidence.preAcceptanceReadSha256 === evidence.postAcceptanceReadSha256
    && approvalValuesEqual(evidence.preAcceptanceRead, evidence.postAcceptanceRead)
    && approvalValuesEqual(evidence.postAcceptanceRead, current);
};
const rawReviewFor = (candidate, slot) => {
  if (slot === 'PRODUCT') return candidate.product_review;
  if (slot === 'PRIVACY') return candidate.privacy_review;
  if (slot === 'QA') return candidate.qa_review;
  if (slot === 'SECURITY') return candidate.security_review;
  if (slot === 'CODEOWNER') return candidate.codeowner_review;
  return null;
};
const rawReviewMatches = (review, raw, required) => (
  raw !== null
  && review.reviewId === raw.review_id
  && review.actorId === (raw.actor?.id ?? raw.actor_id)
  && review.state === raw.review_state
  && review.headSha === (raw.review_commit_id ?? raw.head_sha)
  && review.submittedAt === raw.submitted_at
  && review.commandDigest === required.commandDigest
  && (review.slot === 'CODEOWNER'
    || review.commandDigest === (raw.command?.command_sha256 ?? raw.review_command_sha256))
);
const authorityMatchesTask3 = (evidence, policy) => {
  const raw = evidence.task3.authority;
  return evidence.authority.revision === raw.revision
    && evidence.authority.sha256 === raw.sha256
    && evidence.authority.rawSha256 === canonicalApprovalDigest(raw)
    && evidence.authority.revision === policy.authorityRevision
    && evidence.authority.sha256 === policy.authoritySha256
    && evidence.authority.rawSha256 === policy.authorityRawSha256
    && raw.roles?.length === 6
    && raw.roles.every((role) => role.status === 'ASSIGNED'
      && role.revocation_status === 'ACTIVE'
      && role.superseded_by === null);
};
const machineMatchesTask3 = (check, raw, required, candidate) => (
  raw !== null
  && check.context === raw.context
  && check.appId === raw.github_app_id
  && check.workflowPath === raw.workflow_path
  && check.workflowSha === raw.reusable_signer?.workflow_sha
  && check.baseBlobSha === raw.trusted_base_workflow_blob_sha
  && check.signerIdentity === candidate.verifier.identity
  && check.checkRunId === raw.check_run_id
  && check.checkSuiteId === raw.check_suite_id
  && check.workflowRunId === raw.actions_run_id
  && check.headSha === raw.actions_run_head_sha
  && check.status === 'COMPLETED'
  && check.conclusion === 'SUCCESS'
  && check.checkRunSuiteAssociated === true
  && check.suiteRunAssociated === true
  && check.runHeadAssociated === true
  && ['appId', 'workflowPath', 'workflowSha', 'baseBlobSha', 'signerIdentity']
    .every((key) => check[key] === required[key])
);

export const revalidateApprovalAtAcceptance = (state, evidence, now) => {
  const checkedAt = nowIso(now);
  const codes = [];
  const policy = state?.policySnapshot;
  if (!isPlainObject(state) || state.state !== 'VERIFIED' || !isPlainObject(policy)) {
    pushIssue(codes, 'APPROVAL_ACCEPTANCE_REVALIDATION_REQUIRED');
  }
  if (!isPlainObject(evidence) || !shapeValid(evidence)) {
    pushIssue(codes, 'APPROVAL_ACCEPTANCE_EVIDENCE_SHAPE_INVALID');
    if (isPlainObject(evidence) && containsForbiddenContent(evidence)) {
      pushIssue(codes, 'APPROVAL_ACCEPTANCE_FORBIDDEN_CONTENT');
    }
    if (evidence?.mergeAuthorization === null
      || evidence?.mergeAuthorization?.grant === null) {
      pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_REQUIRED');
    }
    if (evidence?.mergeAuthorization?.consumption === null) {
      pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED');
    }
  }
  if (codes.length > 0) {
    return frozenClone({
      valid: false,
      checkedAt,
      issues: [...new Set(codes)].map((stable_code) => ({ stable_code })),
    });
  }
  if (containsForbiddenContent(evidence)) pushIssue(codes, 'APPROVAL_ACCEPTANCE_FORBIDDEN_CONTENT');
  if (!transactionValid(evidence)) pushIssue(codes, 'APPROVAL_TOCTOU_DETECTED');
  const freshnessMs = policy.freshnessMs;
  if (!Number.isSafeInteger(freshnessMs)
    || freshnessMs <= 0
    || !freshInstant(evidence.readAt, now, freshnessMs)) {
    pushIssue(codes, 'APPROVAL_ACCEPTANCE_REVALIDATION_STALE');
  }

  const task3Result = validateApprovalReadback(
    evidence.task3.candidate,
    evidence.task3.authority,
    evidence.task3.policy,
    checkedAt,
  );
  for (const issue of task3Result.issues) pushIssue(codes, issue.stable_code);
  const candidate = evidence.task3.candidate;
  if (!approvalValuesEqual(candidate.policy, evidence.task3.policy)
    || candidate.decision?.adr !== state.decisionId
    || candidate.decision?.revision !== state.decisionRevision
    || candidate.decision?.policy_revision !== state.policyRevision
    || candidate.decision?.raw_sha256 !== policy.decisionRawSha256
    || candidate.decision?.semantic_sha256 !== policy.decisionSemanticSha256
    || candidate.decision?.proposed_sidecar_raw_sha256 !== policy.sidecarRawSha256) {
    pushIssue(codes, 'APPROVAL_DECISION_SEMANTIC_DIGEST_MISMATCH');
  }

  const grant = evidence.mergeAuthorization.grant;
  const currentPr = evidence.currentPullRequest;
  if (currentPr.state !== 'MERGED'
    || currentPr.baseSha !== policy.currentBaseSha
    || currentPr.headSha !== policy.currentHeadSha
    || currentPr.number !== grant?.pr_number
    || candidate.pull_request?.number !== currentPr.number
    || candidate.pull_request?.base_sha !== currentPr.baseSha
    || candidate.pull_request?.head_sha !== currentPr.headSha) {
    pushIssue(codes, 'APPROVAL_HEAD_MISMATCH');
  }
  const expectedFiles = sortedFiles(policy.acceptanceAllowlist);
  if (evidence.acceptanceDiff.complete !== true
    || !approvalValuesEqual(sortedFiles(evidence.acceptanceDiff.files), expectedFiles)) {
    pushIssue(codes, 'APPROVAL_ACCEPTANCE_DIFF_OUTSIDE_ALLOWLIST');
  }

  const requiredReviews = policy.requiredReviews ?? [];
  const requiredSlots = requiredReviews.map(({ slot }) => slot);
  const observedSlots = evidence.reviews.map(({ slot }) => slot);
  if (evidence.reviews.length !== requiredReviews.length
    || new Set(observedSlots).size !== observedSlots.length
    || requiredSlots.some((slot) => !observedSlots.includes(slot))) {
    pushIssue(codes, 'APPROVAL_ACCEPTANCE_EVIDENCE_SHAPE_INVALID');
  }
  const reviewIds = new Set();
  const distinctRoleActors = new Set();
  for (const required of requiredReviews) {
    const matching = evidence.reviews.filter(({ slot }) => slot === required.slot);
    const review = matching[0];
    const raw = rawReviewFor(candidate, required.slot);
    if (matching.length !== 1
      || !rawReviewMatches(review, raw, required)
      || !freshInstant(review?.submittedAt, now, freshnessMs)) pushIssue(codes, 'APPROVAL_REVIEW_STALE');
    if (reviewIds.has(review?.reviewId)) pushIssue(codes, 'APPROVAL_EVIDENCE_SLOT_REUSE');
    reviewIds.add(review?.reviewId);
    if (required.slot !== 'CODEOWNER') {
      if (distinctRoleActors.has(review?.actorId)) pushIssue(codes, 'APPROVAL_DISTINCT_ACTORS_REQUIRED');
      distinctRoleActors.add(review?.actorId);
    }
  }

  if (!authorityMatchesTask3(evidence, policy)
    || evidence.authority.effectiveFrom !== policy.authorityEffectiveFrom
    || evidence.authority.effectiveUntil !== policy.authorityEffectiveUntil
    || Date.parse(evidence.authority.effectiveFrom) > now.getTime()
    || now.getTime() >= Date.parse(evidence.authority.effectiveUntil)
    || evidence.authority.assignmentsCurrent !== true
    || evidence.authority.revocationStatus !== 'ACTIVE'
    || evidence.authority.reassigned !== false) pushIssue(codes, 'APPROVAL_ROLE_AUTHORITY_STALE');

  const rawLegal = candidate.legal_input;
  if (evidence.legal.status !== rawLegal?.status
    || evidence.legal.scope !== policy.legalScope
    || evidence.legal.digest !== canonicalApprovalDigest(rawLegal)
    || evidence.legal.digest !== policy.legalDigest
    || evidence.legal.validFrom !== evidence.task3.authority.roles[4].effective_from
    || evidence.legal.validUntil !== rawLegal?.valid_until
    || Date.parse(evidence.legal.validFrom) > now.getTime()
    || now.getTime() >= Date.parse(evidence.legal.validUntil)
    || evidence.legal.revocationStatus !== 'ACTIVE') pushIssue(codes, 'APPROVAL_LEGAL_INPUT_STALE');

  if (evidence.ruleset.normalizedSha256 !== policy.liveRulesetSha256
    || evidence.ruleset.normalizedSha256 !== candidate.ruleset?.normalized_sha256) {
    pushIssue(codes, 'APPROVAL_RULESET_DRIFT');
  }
  if (!Array.isArray(evidence.ruleset.bypassActors)
    || evidence.ruleset.bypassActors.length !== 0
    || !approvalValuesEqual(evidence.ruleset.bypassActors, candidate.ruleset?.bypass_actors)) {
    pushIssue(codes, 'APPROVAL_RULESET_BYPASS_PRESENT');
  }
  if (!freshInstant(evidence.ruleset.observedAt, now, freshnessMs)) {
    pushIssue(codes, 'APPROVAL_RULESET_DRIFT');
  }

  const requiredChecks = policy.requiredMachineChecks ?? [];
  if (evidence.machineChecks.length !== requiredChecks.length
    || candidate.machine_checks?.length !== requiredChecks.length) {
    pushIssue(codes, 'APPROVAL_ACCEPTANCE_EVIDENCE_SHAPE_INVALID');
  }
  for (const required of requiredChecks) {
    const matching = evidence.machineChecks.filter(({ context }) => context === required.context);
    const raw = candidate.machine_checks?.find(({ context }) => context === required.context) ?? null;
    const check = matching[0];
    if (!check || !['appId', 'workflowPath', 'workflowSha', 'baseBlobSha', 'signerIdentity']
      .every((key) => check[key] === required[key])) {
      pushIssue(codes, 'APPROVAL_CHECK_IDENTITY_MISMATCH');
    }
    if (matching.length !== 1 || !machineMatchesTask3(check, raw, required, candidate)) {
      pushIssue(codes, 'APPROVAL_CHECK_DYNAMIC_ASSOCIATION_MISMATCH');
    }
  }

  const receipt = evidence.receipt;
  const subject = candidate.receipt_subject;
  if (receipt.receiptId !== state.receipt?.receiptId
    || receipt.receiptId !== subject?.receipt_id
    || receipt.receiptCoreSha256 !== state.receipt?.receiptCoreSha256
    || receipt.receiptRawSha256 !== state.receipt?.receiptRawSha256
    || receipt.trustState !== 'INDEPENDENT_EXTERNAL_VERIFIED'
    || !isCanonicalInstant(receipt.validUntil)
    || now.getTime() >= Date.parse(receipt.validUntil)) pushIssue(codes, 'APPROVAL_RECEIPT_EXPIRED');
  if (!approvalValuesEqual(receipt.priorReceiptIds, subject?.prior_receipt_ids)) {
    pushIssue(codes, 'APPROVAL_RECEIPT_REPLAYED');
  }
  if (receipt.priorReceiptIds.includes(receipt.receiptId)) pushIssue(codes, 'APPROVAL_RECEIPT_REPLAYED');
  if (receipt.revoked !== subject?.revoked_receipt_ids?.includes(receipt.receiptId)
    || receipt.revoked === true) pushIssue(codes, 'APPROVAL_POLICY_REVOKED');
  if (receipt.superseded !== subject?.superseded_receipt_ids?.includes(receipt.receiptId)
    || receipt.superseded === true) pushIssue(codes, 'APPROVAL_RECEIPT_SUPERSEDED');

  const proposal = evidence.proposalMain;
  if (proposal.proposalResultCommitSha !== policy.proposalResultCommitSha
    || !isGitSha(proposal.currentMainSha)
    || proposal.resultReachableFromCurrentMain !== true) {
    pushIssue(codes, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED');
  }
  if (proposal.approvedDecisionRawSha256 !== policy.decisionRawSha256
    || proposal.approvedDecisionSemanticSha256 !== policy.decisionSemanticSha256) {
    pushIssue(codes, 'APPROVAL_DECISION_SEMANTIC_DIGEST_MISMATCH');
  }
  if (proposal.approvedSidecarRawSha256 !== policy.sidecarRawSha256) {
    pushIssue(codes, 'APPROVAL_ACCEPTANCE_SIDECAR_MISMATCH');
  }

  const merge = evidence.mergeAuthorization;
  if (!validateProgramCMergeAuthorizationGrant(grant).valid
    || merge.grantRawSha256 !== canonicalApprovalDigest(grant)
    || grant.stage !== 'ACCEPTANCE_MERGE'
    || grant.repository.id !== state.repository.id
    || grant.decision_adr !== state.decisionId
    || grant.decision_revision !== state.decisionRevision
    || grant.policy_revision !== state.policyRevision
    || grant.base_sha !== policy.currentBaseSha
    || grant.head_sha !== policy.currentHeadSha
    || grant.decision_raw_sha256 !== policy.decisionRawSha256
    || grant.decision_semantic_sha256 !== policy.decisionSemanticSha256
    || Date.parse(grant.authorized_at) > now.getTime()
    || now.getTime() >= Date.parse(grant.expires_at)) {
    pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
  }
  const consumption = merge.consumption;
  const mergeReadback = merge.currentMainReadback;
  if (!isPlainObject(mergeReadback)
    || mergeReadback.repositoryId !== grant.repository.id
    || mergeReadback.prNumber !== grant.pr_number
    || mergeReadback.baseSha !== grant.base_sha
    || mergeReadback.authorizedHeadSha !== grant.head_sha
    || mergeReadback.prState !== 'MERGED'
    || mergeReadback.resultCommitSha !== consumption?.result_commit_sha
    || mergeReadback.observedMergeMethod !== grant.allowed_merge_method
    || mergeReadback.resultAssociatedWithPr !== true
    || mergeReadback.headAssociatedWithResult !== true
    || mergeReadback.resultReachableFromCurrentMain !== true
    || mergeReadback.currentMain?.ref !== 'refs/heads/main'
    || mergeReadback.currentMain?.sha !== consumption?.current_main?.sha
    || mergeReadback.currentMain?.readAt !== consumption?.current_main?.read_at) {
    pushIssue(codes, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED');
  }
  if (!isPlainObject(consumption)) {
    pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED');
  } else if (!validateProgramCMergeAuthorizationConsumption(consumption).valid
    || merge.consumptionRawSha256 !== canonicalApprovalDigest(consumption)
    || consumption.grant_id !== grant.grant_id
    || consumption.grant_raw_sha256 !== merge.grantRawSha256
    || consumption.stage !== grant.stage
    || consumption.nonce_ledger_reserved_revision !== state.mergeAuthorization?.reservedLedgerRevision
    || consumption.current_main.sha !== proposal.currentMainSha
    || Date.parse(consumption.consumed_at) < Date.parse(grant.authorized_at)
    || Date.parse(consumption.consumed_at) >= Date.parse(grant.expires_at)) {
    pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH');
  }
  const ledgerResult = validateApprovalLedgerStream(merge.ledgerSnapshot, {
    key: {
      repositoryId: grant.repository.id,
      singleUseNonce: grant.single_use_nonce,
    },
    grant,
    grantRawSha256: merge.grantRawSha256,
    request: merge.request,
    expectedConsumption: consumption,
    expectedConsumptionRawSha256: merge.consumptionRawSha256,
  });
  if (!ledgerResult.valid) {
    pushIssue(codes, 'APPROVAL_LEDGER_STREAM_INVALID');
    if (!hasExactKeys(merge.ledgerSnapshot?.key, ['repositoryId', 'singleUseNonce'])) {
      pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_NONCE_KEY_INVALID');
    }
    const ledgerReservation = merge.ledgerSnapshot?.events?.find?.(
      ({ type }) => type === 'NONCE_RESERVED',
    );
    if (ledgerReservation && ledgerReservation.stage !== grant.stage) {
      pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT');
    }
    if (!merge.ledgerSnapshot?.events?.some?.(({ type }) => type === 'CONSUMPTION_RECORDED')) {
      pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED');
    }
  } else {
    if (!ledgerResult.facts.reservation
      || !ledgerResult.facts.result
      || !ledgerResult.facts.consumptionEvent
      || ledgerResult.facts.revocations.length > 0) pushIssue(codes, 'APPROVAL_LEDGER_STREAM_INVALID');
  }
  if (state.mergeAuthorization?.grantId !== grant.grant_id
    || state.mergeAuthorization?.grantRawSha256 !== merge.grantRawSha256
    || state.mergeAuthorization?.consumptionId !== consumption?.consumption_id
    || state.mergeAuthorization?.consumptionRawSha256 !== merge.consumptionRawSha256
    || state.mergeAuthorization?.ledgerState !== 'CONSUMED') {
    pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH');
  }

  const unique = [...new Set(codes)].slice(0, 16);
  return frozenClone({
    valid: unique.length === 0,
    checkedAt,
    evidenceSha256: canonicalApprovalDigest(evidence),
    issues: unique.map((stable_code) => ({ stable_code })),
  });
};
