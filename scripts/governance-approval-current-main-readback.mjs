import {
  hasExactKeys,
  isCanonicalInstant,
  isDigest,
  isGitSha,
  isPlainObject,
  isSafePositiveInteger,
  resultFromCodes,
} from './governance-approval-readback-common.mjs';

const READBACK_KEYS = Object.freeze([
  'repositoryId', 'prNumber', 'baseSha', 'authorizedHeadSha', 'prState',
  'resultCommitSha', 'observedMergeMethod', 'resultAssociatedWithPr',
  'headAssociatedWithResult', 'resultReachableFromCurrentMain', 'currentMain',
  'independentVerifier', 'preReadbackSha256', 'postReadbackSha256',
]);
const CURRENT_MAIN_KEYS = Object.freeze(['ref', 'sha', 'readAt']);
const VERIFIER_KEYS = Object.freeze(['repository', 'path', 'sha', 'runId', 'attempt', 'identity']);
const REPOSITORY_KEYS = Object.freeze(['id', 'full_name']);
const METHODS = new Set(['MERGE', 'SQUASH', 'REBASE']);
const shapeIssue = () => resultFromCodes(['APPROVAL_CURRENT_MAIN_READBACK_REQUIRED']);
const verifierValueValid = (value) => (
  hasExactKeys(value, VERIFIER_KEYS)
  && hasExactKeys(value.repository, REPOSITORY_KEYS)
  && isSafePositiveInteger(value.repository.id)
  && typeof value.repository.full_name === 'string'
  && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository.full_name)
  && Buffer.byteLength(value.repository.full_name, 'utf8') <= 256
  && /^\.github\/workflows\/[a-zA-Z0-9._-]+\.ya?ml$/.test(value.path)
  && isGitSha(value.sha)
  && isSafePositiveInteger(value.runId)
  && isSafePositiveInteger(value.attempt)
  && typeof value.identity === 'string'
  && Buffer.byteLength(value.identity, 'utf8') >= 1
  && Buffer.byteLength(value.identity, 'utf8') <= 256
);
const verifierMatchesConsumption = (actual, expected) => (
  actual.repository.id === expected.repository.id
  && actual.repository.full_name === expected.repository.full_name
  && actual.path === expected.path
  && actual.sha === expected.sha
  && actual.runId === expected.run_id
  && actual.attempt === expected.attempt
  && actual.identity === expected.identity
);
const verifierMatchesTask3 = (actual, expected) => (
  actual.repository.id === expected.repository_id
  && actual.repository.full_name === expected.repository_full_name
  && actual.path === expected.workflow_path
  && actual.sha === expected.workflow_sha
  && actual.runId === expected.run_id
  && actual.attempt === expected.attempt
  && actual.identity === expected.identity
);

export const validateCurrentMainMergeReadback = (readback, context) => {
  if (!isPlainObject(context)
    || !isPlainObject(context.grant)
    || !hasExactKeys(readback, READBACK_KEYS)
    || !hasExactKeys(readback.currentMain, CURRENT_MAIN_KEYS)
    || !verifierValueValid(readback.independentVerifier)
    || !isSafePositiveInteger(readback.repositoryId)
    || !isSafePositiveInteger(readback.prNumber)
    || !isGitSha(readback.baseSha)
    || !isGitSha(readback.authorizedHeadSha)
    || readback.prState !== 'MERGED'
    || !isGitSha(readback.resultCommitSha)
    || !METHODS.has(readback.observedMergeMethod)
    || readback.resultAssociatedWithPr !== true
    || readback.headAssociatedWithResult !== true
    || readback.resultReachableFromCurrentMain !== true
    || readback.currentMain.ref !== 'refs/heads/main'
    || !isGitSha(readback.currentMain.sha)
    || !isCanonicalInstant(readback.currentMain.readAt)
    || !isDigest(readback.preReadbackSha256)
    || !isDigest(readback.postReadbackSha256)) return shapeIssue();
  const grant = context.grant;
  const codes = [];
  if (readback.repositoryId !== grant.repository?.id
    || readback.prNumber !== grant.pr_number
    || readback.baseSha !== grant.base_sha
    || readback.authorizedHeadSha !== grant.head_sha
    || readback.observedMergeMethod !== grant.allowed_merge_method
    || Date.parse(readback.currentMain.readAt) < Date.parse(grant.authorized_at)
    || Date.parse(readback.currentMain.readAt) >= Date.parse(grant.expires_at)
    || (isCanonicalInstant(context.now)
      && Date.parse(readback.currentMain.readAt) > Date.parse(context.now))) {
    codes.push('APPROVAL_CURRENT_MAIN_READBACK_REQUIRED');
  }
  const consumption = context.consumption;
  if (isPlainObject(consumption) && (
    readback.resultCommitSha !== consumption.result_commit_sha
    || readback.observedMergeMethod !== consumption.observed_merge_method
    || readback.authorizedHeadSha !== consumption.authorized_head_sha
    || readback.currentMain.ref !== consumption.current_main?.ref
    || readback.currentMain.sha !== consumption.current_main?.sha
    || readback.currentMain.readAt !== consumption.current_main?.read_at
    || readback.preReadbackSha256 !== consumption.pre_readback_sha256
    || readback.postReadbackSha256 !== consumption.post_readback_sha256
    || Date.parse(consumption.consumed_at) > Date.parse(readback.currentMain.readAt)
  )) codes.push('APPROVAL_CURRENT_MAIN_READBACK_REQUIRED');
  if (isPlainObject(consumption)
    && !verifierMatchesConsumption(readback.independentVerifier, consumption.independent_verifier)) {
    codes.push('APPROVAL_INDEPENDENCE_NOT_PROVEN');
  }
  if (isPlainObject(context.task3Verifier)
    && !verifierMatchesTask3(readback.independentVerifier, context.task3Verifier)) {
    codes.push('APPROVAL_INDEPENDENCE_NOT_PROVEN');
  }
  return resultFromCodes(codes, {
    observedAt: readback.currentMain.readAt,
    resultCommitSha: readback.resultCommitSha,
    currentMainSha: readback.currentMain.sha,
  });
};
