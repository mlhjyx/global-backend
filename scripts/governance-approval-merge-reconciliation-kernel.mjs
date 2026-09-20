import {
  deepFreeze,
  hasExactKeys,
  isCanonicalInstant,
  isDigest,
  isGitSha,
  isPlainObject,
  isSafePositiveInteger,
  verifierRepositoryNameValid,
} from './governance-approval-readback-common.mjs';
import { validateProgramCMergeAuthorizationConsumption } from './governance-approval-schema-validator.mjs';
import {
  canonicalApprovalDigest,
  isBoundedId,
  MERGE_CONSUMPTION_ID_PATTERN,
} from './governance-approval-ledger-stream.mjs';

const READBACK_KEYS = Object.freeze([
  'repositoryId', 'prNumber', 'baseSha', 'authorizedHeadSha', 'prState',
  'resultCommitSha', 'observedMergeMethod', 'resultAssociatedWithPr',
  'headAssociatedWithResult', 'resultReachableFromCurrentMain', 'currentMain',
  'independentVerifier', 'preReadbackSha256', 'postReadbackSha256',
]);
const CURRENT_MAIN_KEYS = Object.freeze(['ref', 'sha', 'readAt']);
const VERIFIER_KEYS = Object.freeze(['repository', 'path', 'sha', 'runId', 'attempt', 'identity']);
const VERIFIER_REPOSITORY_KEYS = Object.freeze(['id', 'full_name']);
const clone = (value) => structuredClone(value);
const frozenPlan = ({
  outcome,
  blockingCode = null,
  resultEvent = null,
  consumption = null,
  consumptionRawSha256 = null,
}) => deepFreeze({
  schemaVersion: 'merge-authorization-reconciliation-plan/v1',
  outcome,
  blockingCode,
  resultEvent,
  consumption,
  consumptionRawSha256,
});

const readbackCode = (reservation, readback, observedAt) => {
  const grant = reservation.grant;
  if (!hasExactKeys(readback, READBACK_KEYS)
    || !hasExactKeys(readback.currentMain, CURRENT_MAIN_KEYS)
    || !hasExactKeys(readback.independentVerifier, VERIFIER_KEYS)
    || !hasExactKeys(readback.independentVerifier.repository, VERIFIER_REPOSITORY_KEYS)) {
    return 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED';
  }
  if (readback.repositoryId !== grant.repository.id
    || readback.prNumber !== grant.pr_number
    || readback.baseSha !== grant.base_sha
    || readback.authorizedHeadSha !== grant.head_sha) {
    return 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE';
  }
  if (!isCanonicalInstant(readback.currentMain?.readAt)
    || Date.parse(readback.currentMain.readAt) < Date.parse(grant.authorized_at)
    || Date.parse(readback.currentMain.readAt) >= Date.parse(grant.expires_at)) {
    return 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE';
  }
  if (readback.prState !== 'MERGED'
    || !isGitSha(readback.resultCommitSha)
    || readback.observedMergeMethod !== grant.allowed_merge_method
    || readback.resultAssociatedWithPr !== true
    || readback.headAssociatedWithResult !== true
    || readback.resultReachableFromCurrentMain !== true
    || readback.currentMain.ref !== 'refs/heads/main'
    || !isGitSha(readback.currentMain.sha)
    || Date.parse(readback.currentMain.readAt) > Date.parse(observedAt)
    || !isDigest(readback.preReadbackSha256)
    || !isDigest(readback.postReadbackSha256)) return 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED';
  const verifier = readback.independentVerifier;
  if (verifier.repository.id === grant.repository.id
    || !isSafePositiveInteger(verifier.repository.id)
    || !verifierRepositoryNameValid(verifier.repository.full_name)
    || !/^\.github\/workflows\/[a-zA-Z0-9._-]+\.ya?ml$/.test(verifier.path)
    || !isGitSha(verifier.sha)
    || !isSafePositiveInteger(verifier.runId)
    || !isSafePositiveInteger(verifier.attempt)
    || typeof verifier.identity !== 'string'
    || Buffer.byteLength(verifier.identity, 'utf8') > 256) {
    return 'APPROVAL_INDEPENDENCE_NOT_PROVEN';
  }
  return null;
};

const consumptionFrom = (reservation, readback) => ({
  schema_version: 'program-c-merge-authorization-consumption/v1',
  consumption_id: reservation.request.reservationId.replace(
    /^merge-reservation-/,
    'program-c-consumption-',
  ),
  grant_id: reservation.grant.grant_id,
  grant_raw_sha256: reservation.grantRawSha256,
  single_use_nonce: reservation.grant.single_use_nonce,
  repository: clone(reservation.grant.repository),
  decision_adr: reservation.grant.decision_adr,
  decision_revision: reservation.grant.decision_revision,
  policy_revision: reservation.grant.policy_revision,
  stage: reservation.grant.stage,
  pr_number: reservation.grant.pr_number,
  authorized_head_sha: reservation.grant.head_sha,
  result_commit_sha: readback.resultCommitSha,
  observed_merge_method: readback.observedMergeMethod,
  consumed_at: readback.currentMain.readAt,
  nonce_ledger_key: `program-c-merge:${reservation.grant.single_use_nonce}`,
  nonce_ledger_reserved_revision: reservation.reservedLedgerRevision,
  independent_verifier: {
    repository: clone(readback.independentVerifier.repository),
    path: readback.independentVerifier.path,
    sha: readback.independentVerifier.sha,
    run_id: readback.independentVerifier.runId,
    attempt: readback.independentVerifier.attempt,
    identity: readback.independentVerifier.identity,
  },
  current_main: {
    ref: readback.currentMain.ref,
    sha: readback.currentMain.sha,
    read_at: readback.currentMain.readAt,
  },
  pre_readback_sha256: readback.preReadbackSha256,
  post_readback_sha256: readback.postReadbackSha256,
});

export const planMergeAuthorizationReconciliation = ({
  reservation,
  readback,
  streamFacts,
  observedAt,
}) => {
  if (!isPlainObject(reservation)
    || !isPlainObject(readback)
    || !isPlainObject(streamFacts)
    || !isCanonicalInstant(observedAt)
    || !Array.isArray(streamFacts.revocations)) {
    return frozenPlan({
      outcome: 'HOLD',
      blockingCode: 'APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED',
    });
  }
  const effectiveRevocation = streamFacts.revocations.find(
    ({ effectiveAt }) => Date.parse(effectiveAt) <= Date.parse(observedAt),
  );
  if (effectiveRevocation) {
    return frozenPlan({
      outcome: 'HOLD',
      blockingCode: 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE',
    });
  }
  if (streamFacts.consumptionEvent) {
    return frozenPlan({
      outcome: 'CONSUMPTION_ALREADY_RECORDED',
      consumption: clone(streamFacts.consumptionEvent.consumption),
      consumptionRawSha256: streamFacts.consumptionEvent.consumptionRawSha256,
    });
  }
  const code = readbackCode(reservation, readback, observedAt);
  if (code) return frozenPlan({ outcome: 'HOLD', blockingCode: code });
  if (streamFacts.result && (
    streamFacts.result.resultCommitSha !== readback.resultCommitSha
    || streamFacts.result.observedMergeMethod !== readback.observedMergeMethod
  )) {
    return frozenPlan({
      outcome: 'HOLD',
      blockingCode: 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED',
    });
  }
  const resultEvent = streamFacts.result
    ? null
    : {
      type: 'MERGE_RESULT_OBSERVED',
      resultCommitSha: readback.resultCommitSha,
      observedMergeMethod: readback.observedMergeMethod,
      observedAt: readback.currentMain.readAt,
    };
  const consumption = consumptionFrom(reservation, readback);
  if (!validateProgramCMergeAuthorizationConsumption(consumption).valid
    || !isBoundedId(consumption.consumption_id, MERGE_CONSUMPTION_ID_PATTERN)) {
    return frozenPlan({
      outcome: resultEvent === null ? 'HOLD' : 'RESULT_READY_THEN_HOLD',
      blockingCode: 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH',
      resultEvent,
    });
  }
  return frozenPlan({
    outcome: 'READY_TO_APPLY',
    resultEvent,
    consumption,
    consumptionRawSha256: canonicalApprovalDigest(consumption),
  });
};
