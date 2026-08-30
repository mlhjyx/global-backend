import { createHash } from 'node:crypto';
import {
  deepFreeze,
  hasExactKeys,
  isCanonicalInstant,
  isGitSha,
  isPlainObject,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  sameJson,
} from './governance-approval-readback-common.mjs';
import {
  validateProgramCMergeAuthorizationConsumption,
  validateProgramCMergeAuthorizationGrant,
} from './governance-approval-schema-validator.mjs';

const LEDGER_CLASS = 'SHARED_DURABLE_CAS';
const KEY_KEYS = Object.freeze(['repositoryId', 'singleUseNonce']);
const SNAPSHOT_KEYS = Object.freeze([
  'headSha', 'baseSha', 'decisionRawSha256', 'sidecarRawSha256',
  'authoritySha256', 'authorityRawSha256', 'legalDigest', 'rulesetDigest',
]);
const EVENT_KEYS = Object.freeze({
  NONCE_RESERVED: ['type', 'grantId', 'grantRawSha256', 'requestId', 'reservationId', 'repositoryId', 'decisionAdr', 'decisionRevision', 'policyRevision', 'stage', 'prNumber', 'baseSha', 'headSha', 'mergeMethod', 'reservedAt', 'ledgerRevision'],
  GRANT_REVOKED: ['type', 'grantId', 'grantRawSha256', 'reasonCode', 'effectiveAt', 'ledgerRevision'],
  MERGE_ACK_UNKNOWN: ['type', 'reasonCode', 'observedAt', 'ledgerRevision'],
  MERGE_RESULT_OBSERVED: ['type', 'resultCommitSha', 'observedMergeMethod', 'observedAt', 'ledgerRevision'],
  CONSUMPTION_RECORDED: ['type', 'consumption', 'consumptionRawSha256', 'recordedAt', 'ledgerRevision'],
  BOUNDED_HOLD: ['type', 'reasonCode', 'observedAt', 'ledgerRevision'],
});
const clone = (value) => structuredClone(value);
const frozenClone = (value) => deepFreeze(clone(value));
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const canonicalDigest = (value) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
const nowIso = (now) => {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('APPROVAL_NOW_INVALID');
  return now.toISOString();
};
const containsForbiddenContent = (value) => {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsForbiddenContent);
  return Object.entries(value).some(([key, child]) => (
    ['body', 'content', 'reviewbody', 'legalcontent', 'freeform', 'free_form'].includes(key.toLowerCase())
    || containsForbiddenContent(child)
  ));
};
const pushIssue = (codes, code) => { if (typeof code === 'string' && code.startsWith('APPROVAL_')) codes.push(code); };
const completeValidation = (value) => (
  value?.valid === true
  && Array.isArray(value.issues)
  && value.issues.length === 0
  && value.externalCompletenessObserved === true
);
const freshInstant = (value, now, maximumAge) => (
  isCanonicalInstant(value)
  && Date.parse(value) <= now.getTime()
  && now.getTime() - Date.parse(value) <= maximumAge
);
const sortedFiles = (files) => Array.isArray(files)
  ? [...files].sort((left, right) => left.path.localeCompare(right.path))
  : [];
export const revalidateApprovalAtAcceptance = (state, evidence, now) => {
  const checkedAt = nowIso(now);
  const codes = [];
  const policy = state?.policySnapshot;
  if (!isPlainObject(state) || state.state !== 'VERIFIED' || !isPlainObject(evidence)) {
    pushIssue(codes, 'APPROVAL_ACCEPTANCE_REVALIDATION_REQUIRED');
  }
  const effectivePolicy = policy;
  if (!isPlainObject(effectivePolicy)) pushIssue(codes, 'APPROVAL_ACCEPTANCE_REVALIDATION_REQUIRED');
  if (codes.length > 0) return frozenClone({ valid: false, checkedAt, issues: [...new Set(codes)].map((stable_code) => ({ stable_code })) });
  if (containsForbiddenContent(evidence)) pushIssue(codes, 'APPROVAL_ACCEPTANCE_FORBIDDEN_CONTENT');
  const freshnessMs = effectivePolicy.freshnessMs;
  if (!Number.isSafeInteger(freshnessMs) || freshnessMs <= 0 || !freshInstant(evidence.readAt, now, freshnessMs)) {
    pushIssue(codes, 'APPROVAL_ACCEPTANCE_REVALIDATION_STALE');
  }
  const expectedSnapshot = {
    headSha: effectivePolicy.currentHeadSha,
    baseSha: effectivePolicy.currentBaseSha,
    decisionRawSha256: effectivePolicy.decisionRawSha256,
    sidecarRawSha256: effectivePolicy.sidecarRawSha256,
    authoritySha256: effectivePolicy.authoritySha256,
    authorityRawSha256: effectivePolicy.authorityRawSha256,
    legalDigest: effectivePolicy.legalDigest,
    rulesetDigest: effectivePolicy.liveRulesetSha256,
  };
  if (!hasExactKeys(evidence.preRead, SNAPSHOT_KEYS)
    || !hasExactKeys(evidence.postRead, SNAPSHOT_KEYS)
    || !sameJson(evidence.preRead, evidence.postRead)
    || !sameJson(evidence.preRead, expectedSnapshot)) pushIssue(codes, 'APPROVAL_TOCTOU_DETECTED');

  const merge = evidence.mergeAuthorization;
  const grant = merge?.grant;
  const currentPr = evidence.currentPullRequest;
  if (!isPlainObject(currentPr)
    || currentPr.state !== 'MERGED'
    || currentPr.baseSha !== effectivePolicy.currentBaseSha
    || currentPr.headSha !== effectivePolicy.currentHeadSha
    || currentPr.number !== grant?.pr_number) pushIssue(codes, 'APPROVAL_HEAD_MISMATCH');

  const expectedFiles = sortedFiles(effectivePolicy.acceptanceAllowlist);
  if (evidence.acceptanceDiff?.complete !== true
    || !sameJson(sortedFiles(evidence.acceptanceDiff?.files), expectedFiles)) {
    pushIssue(codes, 'APPROVAL_ACCEPTANCE_DIFF_OUTSIDE_ALLOWLIST');
  }

  const reviews = Array.isArray(evidence.reviews) ? evidence.reviews : [];
  const reviewIds = new Set();
  const distinctRoleActors = new Set();
  for (const required of effectivePolicy.requiredReviews ?? []) {
    const matching = reviews.filter(({ slot }) => slot === required.slot);
    const review = matching[0];
    if (matching.length !== 1 || !review
      || review.state !== 'APPROVED'
      || review.headSha !== effectivePolicy.currentHeadSha
      || review.commandDigest !== required.commandDigest
      || !freshInstant(review.submittedAt, now, freshnessMs)
      || !completeValidation(review.validation)) pushIssue(codes, 'APPROVAL_REVIEW_STALE');
    if (reviewIds.has(review?.reviewId)) pushIssue(codes, 'APPROVAL_EVIDENCE_SLOT_REUSE');
    reviewIds.add(review?.reviewId);
    if (required.slot !== 'CODEOWNER') {
      if (distinctRoleActors.has(review?.actorId)) pushIssue(codes, 'APPROVAL_DISTINCT_ACTORS_REQUIRED');
      distinctRoleActors.add(review?.actorId);
    }
  }

  const authority = evidence.authority;
  if (!isPlainObject(authority)
    || authority.revision !== effectivePolicy.authorityRevision
    || authority.sha256 !== effectivePolicy.authoritySha256
    || authority.rawSha256 !== effectivePolicy.authorityRawSha256
    || authority.effectiveFrom !== effectivePolicy.authorityEffectiveFrom
    || authority.effectiveUntil !== effectivePolicy.authorityEffectiveUntil
    || Date.parse(authority.effectiveFrom) > now.getTime()
    || now.getTime() >= Date.parse(authority.effectiveUntil)
    || authority.assignmentsCurrent !== true
    || authority.revocationStatus !== 'ACTIVE'
    || authority.reassigned !== false
    || !completeValidation(authority.validation)) pushIssue(codes, 'APPROVAL_ROLE_AUTHORITY_STALE');

  const legal = evidence.legal;
  if (!isPlainObject(legal)
    || legal.status !== 'NO_BLOCKER_RECORDED'
    || legal.scope !== effectivePolicy.legalScope
    || legal.digest !== effectivePolicy.legalDigest
    || !isCanonicalInstant(legal.validFrom)
    || !isCanonicalInstant(legal.validUntil)
    || Date.parse(legal.validFrom) > now.getTime()
    || now.getTime() >= Date.parse(legal.validUntil)
    || legal.revocationStatus !== 'ACTIVE'
    || !completeValidation(legal.validation)) pushIssue(codes, 'APPROVAL_LEGAL_INPUT_STALE');

  if (evidence.ruleset?.normalizedSha256 !== effectivePolicy.liveRulesetSha256) pushIssue(codes, 'APPROVAL_RULESET_DRIFT');
  if (!Array.isArray(evidence.ruleset?.bypassActors) || evidence.ruleset.bypassActors.length !== 0) {
    pushIssue(codes, 'APPROVAL_RULESET_BYPASS_PRESENT');
  }
  if (!freshInstant(evidence.ruleset?.observedAt, now, freshnessMs)) pushIssue(codes, 'APPROVAL_RULESET_DRIFT');

  const machineChecks = Array.isArray(evidence.machineChecks) ? evidence.machineChecks : [];
  for (const required of effectivePolicy.requiredMachineChecks ?? []) {
    const matching = machineChecks.filter(({ context }) => context === required.context);
    const check = matching[0];
    const staticMatch = matching.length === 1
      && ['appId', 'workflowPath', 'workflowSha', 'baseBlobSha', 'signerIdentity']
        .every((key) => check?.[key] === required[key]);
    if (!staticMatch) pushIssue(codes, 'APPROVAL_CHECK_IDENTITY_MISMATCH');
    if (!check
      || !isSafePositiveInteger(check.checkRunId)
      || !isSafePositiveInteger(check.checkSuiteId)
      || !isSafePositiveInteger(check.workflowRunId)
      || check.headSha !== effectivePolicy.currentHeadSha
      || check.status !== 'COMPLETED'
      || check.conclusion !== 'SUCCESS'
      || check.checkRunSuiteAssociated !== true
      || check.suiteRunAssociated !== true
      || check.runHeadAssociated !== true) pushIssue(codes, 'APPROVAL_CHECK_DYNAMIC_ASSOCIATION_MISMATCH');
  }

  const receipt = evidence.receipt;
  if (!isPlainObject(receipt)
    || receipt.receiptId !== state.receipt?.receiptId
    || receipt.receiptCoreSha256 !== state.receipt?.receiptCoreSha256
    || receipt.receiptRawSha256 !== state.receipt?.receiptRawSha256
    || receipt.trustState !== 'INDEPENDENT_EXTERNAL_VERIFIED'
    || !isCanonicalInstant(receipt.validUntil)
    || now.getTime() >= Date.parse(receipt.validUntil)) pushIssue(codes, 'APPROVAL_RECEIPT_EXPIRED');
  if (receipt?.priorReceiptIds?.includes(receipt?.receiptId)) pushIssue(codes, 'APPROVAL_RECEIPT_REPLAYED');
  if (receipt?.revoked === true) pushIssue(codes, 'APPROVAL_POLICY_REVOKED');
  if (receipt?.superseded === true) pushIssue(codes, 'APPROVAL_RECEIPT_SUPERSEDED');
  if (receipt?.lifecycleValidation?.valid !== true
    || !Array.isArray(receipt?.lifecycleValidation?.issues)
    || receipt.lifecycleValidation.issues.length !== 0) pushIssue(codes, 'APPROVAL_INDEPENDENCE_NOT_PROVEN');

  const proposal = evidence.proposalMain;
  if (!isPlainObject(proposal)
    || proposal.proposalResultCommitSha !== effectivePolicy.proposalResultCommitSha
    || !isGitSha(proposal.currentMainSha)
    || proposal.resultReachableFromCurrentMain !== true
  ) pushIssue(codes, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED');
  if (proposal?.approvedDecisionRawSha256 !== effectivePolicy.decisionRawSha256
    || proposal?.approvedDecisionSemanticSha256 !== effectivePolicy.decisionSemanticSha256) {
    pushIssue(codes, 'APPROVAL_DECISION_SEMANTIC_DIGEST_MISMATCH');
  }
  if (proposal?.approvedSidecarRawSha256 !== effectivePolicy.sidecarRawSha256) pushIssue(codes, 'APPROVAL_ACCEPTANCE_SIDECAR_MISMATCH');

  if (!isPlainObject(merge) || !isPlainObject(grant)) {
    pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_REQUIRED');
  } else {
    if (!validateProgramCMergeAuthorizationGrant(grant).valid
      || merge.grantRawSha256 !== canonicalDigest(grant)
      || grant.stage !== 'ACCEPTANCE_MERGE'
      || grant.repository.id !== state.repository.id
      || grant.decision_adr !== state.decisionId
      || grant.decision_revision !== state.decisionRevision
      || grant.policy_revision !== state.policyRevision
      || grant.base_sha !== effectivePolicy.currentBaseSha
      || grant.head_sha !== effectivePolicy.currentHeadSha
      || grant.decision_raw_sha256 !== effectivePolicy.decisionRawSha256
      || grant.decision_semantic_sha256 !== effectivePolicy.decisionSemanticSha256) {
      pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
    }
    if (Date.parse(grant.authorized_at) > now.getTime() || now.getTime() >= Date.parse(grant.expires_at)) {
      pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
    }
    const consumption = merge.consumption;
    if (!isPlainObject(consumption)) {
      pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED');
    } else if (!validateProgramCMergeAuthorizationConsumption(consumption).valid
      || merge.consumptionRawSha256 !== canonicalDigest(consumption)
      || consumption.grant_id !== grant.grant_id
      || consumption.grant_raw_sha256 !== merge.grantRawSha256
      || consumption.stage !== grant.stage
      || consumption.nonce_ledger_reserved_revision !== state.mergeAuthorization?.reservedLedgerRevision
      || consumption.current_main.sha !== proposal?.currentMainSha) {
      pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH');
    }
    if (!completeValidation(merge.validation)) pushIssue(codes, 'APPROVAL_INDEPENDENCE_NOT_PROVEN');
    const ledger = merge.ledgerSnapshot;
    if (!isPlainObject(ledger)
      || ledger.durabilityClass !== LEDGER_CLASS
      || !hasExactKeys(ledger.key, KEY_KEYS)
      || ledger.key.repositoryId !== grant.repository.id
      || ledger.key.singleUseNonce !== grant.single_use_nonce
      || !isSafeNonNegativeInteger(ledger.committedRevision)
      || !Array.isArray(ledger.events)
      || ledger.events.some((event) => !hasExactKeys(event, EVENT_KEYS[event.type] ?? []))) {
      pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_NONCE_KEY_INVALID');
    } else {
      const reservations = ledger.events.filter(({ type }) => type === 'NONCE_RESERVED');
      const consumptions = ledger.events.filter(({ type }) => type === 'CONSUMPTION_RECORDED');
      const revocations = ledger.events.filter(({ type, grantId, grantRawSha256 }) => (
        type === 'GRANT_REVOKED' && grantId === grant.grant_id && grantRawSha256 === merge.grantRawSha256
      ));
      const reservedRevision = state.mergeAuthorization?.reservedLedgerRevision;
      if (reservations.length !== 1
        || reservations[0].repositoryId !== grant.repository.id
        || reservations[0].stage !== grant.stage
        || reservations[0].grantId !== grant.grant_id
        || reservations[0].grantRawSha256 !== merge.grantRawSha256
        || reservations[0].ledgerRevision !== reservedRevision) {
        pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT');
      }
      if (consumptions.length !== 1
        || consumptions[0].consumptionRawSha256 !== merge.consumptionRawSha256
        || consumptions[0].ledgerRevision > ledger.committedRevision) {
        pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED');
      }
      if (revocations.length > 0) pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
    }
    if (state.mergeAuthorization?.grantId !== grant.grant_id
      || state.mergeAuthorization?.grantRawSha256 !== merge.grantRawSha256
      || state.mergeAuthorization?.consumptionId !== merge.consumption?.consumption_id
      || state.mergeAuthorization?.consumptionRawSha256 !== merge.consumptionRawSha256
      || state.mergeAuthorization?.ledgerState !== 'CONSUMED') {
      pushIssue(codes, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH');
    }
  }
  const unique = [...new Set(codes)].slice(0, 16);
  return frozenClone({
    valid: unique.length === 0,
    checkedAt,
    issues: unique.map((stable_code) => ({ stable_code })),
  });
};
