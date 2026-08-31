import {
  deepFreeze,
  hasExactKeys,
  isGitSha,
  isPlainObject,
  isSafePositiveInteger,
} from './governance-approval-readback-common.mjs';

export const MACHINE_CHECK_KEYS = Object.freeze([
  'github_app_id', 'github_app_slug', 'check_run_id', 'check_suite_id', 'context',
  'workflow_id', 'workflow_path', 'trusted_base_workflow_blob_sha', 'actions_run_id',
  'actions_run_attempt', 'actions_run_event', 'actions_run_head_sha',
  'actions_run_conclusion', 'reusable_signer',
]);
export const SIGNER_KEYS = Object.freeze(['workflow_id', 'workflow_path', 'workflow_sha']);
const REQUIRED_CHECK_KEYS = Object.freeze([
  'github_app_id', 'github_app_slug', 'context', 'workflow_id', 'workflow_path',
  'trusted_base_workflow_blob_sha', 'reusable_signer',
]);

const signerMatches = (actual, required) => {
  if (required === null) return actual === null;
  return (
    hasExactKeys(actual, SIGNER_KEYS)
    && hasExactKeys(required, SIGNER_KEYS)
    && actual.workflow_id === required.workflow_id
    && actual.workflow_path === required.workflow_path
    && actual.workflow_sha === required.workflow_sha
  );
};

export const validateMachineChecks = (candidate, policy) => {
  const codes = [];
  if (Object.hasOwn(policy, 'allowedCheckRunIds') || Object.hasOwn(policy, 'allowedCheckSuiteIds')) {
    codes.push('APPROVAL_CHECK_WORKFLOW_MISMATCH');
  }
  if (
    !Array.isArray(policy.required_machine_checks)
    || policy.required_machine_checks.length < 1
    || policy.required_machine_checks.length > 16
    || !Array.isArray(candidate.machine_checks)
    || candidate.machine_checks.length < 1
    || candidate.machine_checks.length > 16
  ) return [...codes, 'APPROVAL_CHECK_REQUIRED'];
  for (const required of policy.required_machine_checks) {
    if (!hasExactKeys(required, REQUIRED_CHECK_KEYS)) {
      codes.push('APPROVAL_CHECK_WORKFLOW_MISMATCH');
      continue;
    }
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
    if (!hasExactKeys(check, MACHINE_CHECK_KEYS)) {
      codes.push('APPROVAL_CHECK_REQUIRED');
      continue;
    }
    const dynamicEvidencePresent = (
      isSafePositiveInteger(check.check_run_id)
      && isSafePositiveInteger(check.check_suite_id)
      && isSafePositiveInteger(check.actions_run_id)
      && isSafePositiveInteger(check.actions_run_attempt)
    );
    if (!dynamicEvidencePresent || check.actions_run_conclusion !== 'success') {
      codes.push('APPROVAL_CHECK_REQUIRED');
    }
    if (
      check.github_app_id !== required.github_app_id
      || check.github_app_slug !== required.github_app_slug
      || check.workflow_id !== required.workflow_id
      || check.workflow_path !== required.workflow_path
      || check.trusted_base_workflow_blob_sha !== required.trusted_base_workflow_blob_sha
      || check.actions_run_event !== 'pull_request_target'
      || check.actions_run_head_sha !== candidate.pull_request.base_sha
      || !signerMatches(check.reusable_signer, required.reusable_signer)
    ) codes.push('APPROVAL_CHECK_WORKFLOW_MISMATCH');
  }
  const contexts = candidate.machine_checks.map(({ context }) => context);
  if (new Set(contexts).size !== contexts.length) codes.push('APPROVAL_CHECK_AMBIGUOUS');
  const requiredContexts = policy.required_machine_checks.map(({ context }) => context);
  const requiredSet = new Set(requiredContexts);
  const candidateSet = new Set(contexts);
  if (
    requiredSet.size !== requiredContexts.length
    || candidateSet.size !== contexts.length
    || requiredSet.size !== candidateSet.size
    || contexts.some((context) => !requiredSet.has(context))
  ) codes.push('APPROVAL_CHECK_WORKFLOW_MISMATCH');
  const dynamicIds = candidate.machine_checks.flatMap((check) => [check.check_run_id, check.check_suite_id]);
  if (new Set(dynamicIds).size !== dynamicIds.length) codes.push('APPROVAL_CHECK_AMBIGUOUS');
  return codes;
};

const copySigner = (signer) => (signer === null ? null : {
  workflow_id: signer.workflow_id,
  workflow_path: signer.workflow_path,
  workflow_sha: signer.workflow_sha,
});

const copyCheck = (check) => ({
  github_app_id: check.github_app_id,
  github_app_slug: check.github_app_slug,
  check_run_id: check.check_run_id,
  check_suite_id: check.check_suite_id,
  context: check.context,
  workflow_id: check.workflow_id,
  workflow_path: check.workflow_path,
  trusted_base_workflow_blob_sha: check.trusted_base_workflow_blob_sha,
  actions_run_id: check.actions_run_id,
  actions_run_attempt: check.actions_run_attempt,
  actions_run_event: check.actions_run_event,
  actions_run_head_sha: check.actions_run_head_sha,
  actions_run_conclusion: check.actions_run_conclusion,
  reusable_signer: copySigner(check.reusable_signer),
});

const compareChecks = (left, right) => {
  if (left.context < right.context) return -1;
  if (left.context > right.context) return 1;
  return left.check_run_id - right.check_run_id;
};

export const normalizeMachineCheckEvidence = (checks) => deepFreeze(
  checks
    .map(copyCheck)
    .sort(compareChecks),
);

export const normalizePolicyMachineCheckEvidence = (candidate, policy) => {
  const requiredContexts = new Set(policy.required_machine_checks.map(({ context }) => context));
  return normalizeMachineCheckEvidence(
    candidate.machine_checks.filter(({ context }) => requiredContexts.has(context)),
  );
};

export const isMachineEvidenceItem = (value) => (
  hasExactKeys(value, MACHINE_CHECK_KEYS)
  && isSafePositiveInteger(value.github_app_id)
  && typeof value.github_app_slug === 'string'
  && value.github_app_slug.length >= 1
  && value.github_app_slug.length <= 128
  && isSafePositiveInteger(value.check_run_id)
  && isSafePositiveInteger(value.check_suite_id)
  && typeof value.context === 'string'
  && value.context.length >= 1
  && value.context.length <= 256
  && isSafePositiveInteger(value.workflow_id)
  && typeof value.workflow_path === 'string'
  && /^\.github\/workflows\/[a-zA-Z0-9._-]+\.ya?ml$/.test(value.workflow_path)
  && isGitSha(value.trusted_base_workflow_blob_sha)
  && isSafePositiveInteger(value.actions_run_id)
  && isSafePositiveInteger(value.actions_run_attempt)
  && value.actions_run_event === 'pull_request_target'
  && isGitSha(value.actions_run_head_sha)
  && value.actions_run_conclusion === 'success'
  && (value.reusable_signer === null || (
    isPlainObject(value.reusable_signer)
    && hasExactKeys(value.reusable_signer, SIGNER_KEYS)
    && isSafePositiveInteger(value.reusable_signer.workflow_id)
    && /^\.github\/workflows\/[a-zA-Z0-9._-]+\.ya?ml$/.test(value.reusable_signer.workflow_path)
    && isGitSha(value.reusable_signer.workflow_sha)
  ))
);
