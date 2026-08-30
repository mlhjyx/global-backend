import { createHash } from 'node:crypto';

export const API_ORIGIN = 'https://api.github.com';
export const API_VERSION = '2026-03-10';
export const REPOSITORY_ID = 1291151138;
export const REPOSITORY_FULL_NAME = 'mlhjyx/global-backend';
export const REPOSITORY_SEGMENTS = Object.freeze(['repos', 'mlhjyx', 'global-backend']);
export const MAX_OUTPUT_BYTES = 8_388_608;
export const ROLES = Object.freeze([
  'OWN-PRODUCT',
  'OWN-DATA-PRIVACY',
  'OWN-QA-EVIDENCE',
  'OWN-SECURITY',
]);

const MAX_PAGES = 100;
const MAX_ITEMS = 10_000;
const MAX_BLOB_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 8_388_608;
const MAX_TIMEOUT_MS = 30_000;
const MAX_JSON_NESTING = 128;
const PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]{1,512}$/;
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
const POLICY_REVISION_PATTERN = /^program-c\/policy-r[1-9][0-9]*$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?(?:e-?[1-9]\d*)?$/;
const REVIEW_COMMAND_PATTERN = /^APPROVE DECISION (ADR-026|ADR-027) REV (program-c\/policy-r[1-9][0-9]*) ROLE (OWN-PRODUCT|OWN-DATA-PRIVACY|OWN-QA-EVIDENCE|OWN-SECURITY) DIGEST (sha256:[0-9a-f]{64})$/;
const LIMIT_KEYS = Object.freeze([
  'timeoutMs', 'maxPages', 'maxItems', 'maxResponseBytes', 'maxBlobBytes',
]);
const POLICY_KEYS = Object.freeze([
  'repositoryId', 'allowedRepoPaths', 'allowedCheckContexts', 'allowedActionsAppIds',
  'allowedWorkflowIds', 'allowedWorkflowPaths', 'allowedReusableSignerWorkflowIds',
  'allowedReusableSignerWorkflowPaths', 'requiredRuleset',
]);
const REQUIRED_RULESET_KEYS = Object.freeze([
  'doNotEnforceOnCreate', 'pullRequest', 'deletionProtection',
  'nonFastForwardProtection',
]);
const REQUIRED_PULL_REQUEST_KEYS = Object.freeze([
  'requiredApprovingReviewCount', 'dismissStaleReviewsOnPush', 'requiredReviewers',
  'requireCodeOwnerReview', 'requireLastPushApproval', 'requiredReviewThreadResolution',
  'requireExtraApprovalForUnattributedChanges', 'allowedMergeMethods',
]);
const REQUEST_KEYS = Object.freeze([
  'repository', 'prNumber', 'expectedBaseSha', 'expectedHeadSha', 'rulesetId',
  'authorityPath', 'proposalManifestPath', 'proposalSidecarPath', 'codeownerReviewId',
  'decisionId', 'policyRevision', 'expectedDecisionRawSha256',
  'expectedDecisionSemanticSha256', 'observedAt',
]);

export const approvalError = (code) => new Error(code);
export const requireCondition = (condition, code) => {
  if (!condition) throw approvalError(code);
};
export const isFixedApprovalError = (error) => (
  typeof error?.message === 'string' && /^APPROVAL_[A-Z0-9_]+$/.test(error.message)
);
export const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
);
export const hasExactKeys = (value, keys) => (
  isPlainObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
);
export const isSafePositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
export const isGitSha = (value) => typeof value === 'string' && GIT_SHA_PATTERN.test(value);
export const isDigest = (value) => typeof value === 'string' && DIGEST_PATTERN.test(value);
export const isCanonicalInstant = (value) => (
  typeof value === 'string'
  && INSTANT_PATTERN.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value)).toISOString() === value
);
export const isSafeString = (value, maximum) => (
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximum
);
export const isRepoPath = (value) => typeof value === 'string' && PATH_PATTERN.test(value);
export const isWorkflowPath = (value) => (
  typeof value === 'string' && WORKFLOW_PATH_PATTERN.test(value)
);
export const arrayIsUnique = (values) => new Set(values).size === values.length;
export const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export const assertSafeParsedValue = (value, depth = 0) => {
  requireCondition(depth <= MAX_JSON_NESTING, 'APPROVAL_GITHUB_PROPOSAL_INVALID');
  if (Array.isArray(value)) {
    value.forEach((item) => assertSafeParsedValue(item, depth + 1));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    requireCondition(
      !['__proto__', 'prototype', 'constructor'].includes(key),
      'APPROVAL_GITHUB_PROPOSAL_INVALID',
    );
    assertSafeParsedValue(child, depth + 1);
  }
};

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
};
export const stableJson = (value) => JSON.stringify(stableValue(value));
export const sameJson = (left, right) => stableJson(left) === stableJson(right);

const isJsonWhitespace = (character) => (
  character === ' ' || character === '\t' || character === '\n' || character === '\r'
);
const skipWhitespace = (text, start) => {
  let index = start;
  while (index < text.length && isJsonWhitespace(text[index])) index += 1;
  return index;
};
const scanString = (text, start) => {
  requireCondition(text[start] === '"', 'APPROVAL_JSON_SYNTAX');
  let index = start + 1;
  while (index < text.length) {
    const codePoint = text.charCodeAt(index);
    if (text[index] === '"') return index + 1;
    requireCondition(codePoint >= 0x20, 'APPROVAL_JSON_SYNTAX');
    if (text[index] === '\\') {
      const escape = text[index + 1];
      requireCondition(escape !== undefined, 'APPROVAL_JSON_SYNTAX');
      if (escape === 'u') {
        requireCondition(/^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6)), 'APPROVAL_JSON_SYNTAX');
        index += 6;
        continue;
      }
      requireCondition('"\\/bfnrt'.includes(escape), 'APPROVAL_JSON_SYNTAX');
      index += 2;
      continue;
    }
    index += 1;
  }
  throw approvalError('APPROVAL_JSON_SYNTAX');
};
const scanNumber = (text, start) => {
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  number.lastIndex = start;
  const match = number.exec(text);
  requireCondition(match !== null, 'APPROVAL_JSON_SYNTAX');
  const token = match[0].toLowerCase().replace('e+', 'e');
  requireCondition(JSON_NUMBER_PATTERN.test(token), 'APPROVAL_JSON_NUMBER_LEXEME');
  return start + match[0].length;
};
const scanValue = (text, start, depth) => {
  requireCondition(depth <= MAX_JSON_NESTING, 'APPROVAL_JSON_NESTING');
  const index = skipWhitespace(text, start);
  requireCondition(index < text.length, 'APPROVAL_JSON_SYNTAX');
  if (text[index] === '"') return scanString(text, index);
  if (text[index] === '{') {
    const keys = new Set();
    let next = skipWhitespace(text, index + 1);
    if (text[next] === '}') return next + 1;
    while (next < text.length) {
      const keyStart = next;
      next = scanString(text, next);
      const key = JSON.parse(text.slice(keyStart, next));
      requireCondition(!keys.has(key), 'APPROVAL_JSON_DUPLICATE_KEY');
      keys.add(key);
      next = skipWhitespace(text, next);
      requireCondition(text[next] === ':', 'APPROVAL_JSON_SYNTAX');
      next = skipWhitespace(text, scanValue(text, next + 1, depth + 1));
      if (text[next] === '}') return next + 1;
      requireCondition(text[next] === ',', 'APPROVAL_JSON_SYNTAX');
      next = skipWhitespace(text, next + 1);
    }
  }
  if (text[index] === '[') {
    let next = skipWhitespace(text, index + 1);
    if (text[next] === ']') return next + 1;
    while (next < text.length) {
      next = skipWhitespace(text, scanValue(text, next, depth + 1));
      if (text[next] === ']') return next + 1;
      requireCondition(text[next] === ',', 'APPROVAL_JSON_SYNTAX');
      next = skipWhitespace(text, next + 1);
    }
  }
  if (text[index] === '-' || /[0-9]/.test(text[index])) return scanNumber(text, index);
  for (const literal of ['true', 'false', 'null']) {
    if (text.startsWith(literal, index)) return index + literal.length;
  }
  throw approvalError('APPROVAL_JSON_SYNTAX');
};
const assertSafeNumbers = (value, depth = 0) => {
  requireCondition(depth <= MAX_JSON_NESTING, 'APPROVAL_JSON_NESTING');
  if (typeof value === 'number') {
    requireCondition(Number.isFinite(value) && !Object.is(value, -0), 'APPROVAL_JSON_NUMBER');
    requireCondition(!Number.isInteger(value) || Number.isSafeInteger(value), 'APPROVAL_JSON_NUMBER');
  } else if (Array.isArray(value)) {
    value.forEach((item) => assertSafeNumbers(item, depth + 1));
  } else if (isPlainObject(value)) {
    Object.values(value).forEach((item) => assertSafeNumbers(item, depth + 1));
  }
};

export const parseApprovalJson = (text) => {
  requireCondition(
    typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= MAX_BLOB_BYTES,
    'APPROVAL_JSON_INPUT_TOO_LARGE',
  );
  const end = scanValue(text, 0, 0);
  requireCondition(skipWhitespace(text, end) === text.length, 'APPROVAL_JSON_SYNTAX');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw approvalError('APPROVAL_JSON_SYNTAX');
  }
  assertSafeNumbers(value);
  return deepFreeze(value);
};

export const parseApprovalReviewCommand = (body) => {
  requireCondition(
    typeof body === 'string' && Buffer.byteLength(body, 'utf8') <= 512,
    'APPROVAL_REVIEW_COMMAND_INVALID',
  );
  const match = REVIEW_COMMAND_PATTERN.exec(body);
  requireCondition(match !== null, 'APPROVAL_REVIEW_COMMAND_INVALID');
  return deepFreeze({
    decision_adr: match[1],
    policy_revision: match[2],
    role: match[3],
    decision_raw_sha256: match[4],
    command_sha256: sha256(Buffer.from(body, 'utf8')),
  });
};

const dynamicPolicyKey = (key) => {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return compact.includes('checkrunid') || compact.includes('checksuiteid');
};
const validStringList = (values, validator, maximum, allowEmpty = false) => (
  Array.isArray(values)
  && values.length >= (allowEmpty ? 0 : 1)
  && values.length <= maximum
  && values.every(validator)
  && arrayIsUnique(values)
);
const validIdList = (values, maximum, allowEmpty = false) => (
  Array.isArray(values)
  && values.length >= (allowEmpty ? 0 : 1)
  && values.length <= maximum
  && values.every(isSafePositiveInteger)
  && arrayIsUnique(values)
);

const validRequiredRuleset = (value) => (
  hasExactKeys(value, REQUIRED_RULESET_KEYS)
  && typeof value.doNotEnforceOnCreate === 'boolean'
  && typeof value.deletionProtection === 'boolean'
  && typeof value.nonFastForwardProtection === 'boolean'
  && hasExactKeys(value.pullRequest, REQUIRED_PULL_REQUEST_KEYS)
  && Number.isSafeInteger(value.pullRequest.requiredApprovingReviewCount)
  && value.pullRequest.requiredApprovingReviewCount >= 0
  && value.pullRequest.requiredApprovingReviewCount <= 10
  && typeof value.pullRequest.dismissStaleReviewsOnPush === 'boolean'
  && Array.isArray(value.pullRequest.requiredReviewers)
  && value.pullRequest.requiredReviewers.length === 0
  && typeof value.pullRequest.requireCodeOwnerReview === 'boolean'
  && typeof value.pullRequest.requireLastPushApproval === 'boolean'
  && typeof value.pullRequest.requiredReviewThreadResolution === 'boolean'
  && typeof value.pullRequest.requireExtraApprovalForUnattributedChanges === 'boolean'
  && validStringList(
    value.pullRequest.allowedMergeMethods,
    (method) => ['merge', 'rebase', 'squash'].includes(method),
    3,
  )
);

export const validatePolicy = (policy) => {
  if (isPlainObject(policy) && Object.keys(policy).some(dynamicPolicyKey)) {
    throw approvalError('APPROVAL_GITHUB_STATIC_DYNAMIC_ID_FORBIDDEN');
  }
  requireCondition(hasExactKeys(policy, POLICY_KEYS), 'APPROVAL_GITHUB_POLICY_INVALID');
  requireCondition(
    policy.repositoryId === REPOSITORY_ID
      && validStringList(policy.allowedRepoPaths, isRepoPath, 32)
      && validStringList(policy.allowedCheckContexts, (value) => isSafeString(value, 256), 16)
      && validIdList(policy.allowedActionsAppIds, 16)
      && validIdList(policy.allowedWorkflowIds, 16)
      && validStringList(policy.allowedWorkflowPaths, isWorkflowPath, 16)
      && validIdList(policy.allowedReusableSignerWorkflowIds, 16, true)
      && validStringList(policy.allowedReusableSignerWorkflowPaths, isWorkflowPath, 16, true)
      && policy.allowedCheckContexts.length === policy.allowedActionsAppIds.length
      && policy.allowedWorkflowIds.length === policy.allowedWorkflowPaths.length
      && policy.allowedCheckContexts.length === policy.allowedWorkflowIds.length
      && policy.allowedReusableSignerWorkflowIds.length
        === policy.allowedReusableSignerWorkflowPaths.length
      && validRequiredRuleset(policy.requiredRuleset)
      && (
        policy.allowedReusableSignerWorkflowIds.length === 0
        || policy.allowedReusableSignerWorkflowIds.length === policy.allowedCheckContexts.length
      ),
    'APPROVAL_GITHUB_POLICY_INVALID',
  );
  return policy;
};

export const validateLimits = (limits) => {
  requireCondition(hasExactKeys(limits, LIMIT_KEYS), 'APPROVAL_GITHUB_LIMIT_INVALID');
  requireCondition(
    Number.isSafeInteger(limits.timeoutMs) && limits.timeoutMs >= 1 && limits.timeoutMs <= MAX_TIMEOUT_MS
      && Number.isSafeInteger(limits.maxPages) && limits.maxPages >= 1 && limits.maxPages <= MAX_PAGES
      && Number.isSafeInteger(limits.maxItems) && limits.maxItems >= 1 && limits.maxItems <= MAX_ITEMS
      && Number.isSafeInteger(limits.maxResponseBytes)
      && limits.maxResponseBytes >= 1 && limits.maxResponseBytes <= MAX_RESPONSE_BYTES
      && Number.isSafeInteger(limits.maxBlobBytes)
      && limits.maxBlobBytes >= 1 && limits.maxBlobBytes <= MAX_BLOB_BYTES,
    'APPROVAL_GITHUB_LIMIT_INVALID',
  );
  return limits;
};

export const validateRequest = (request, policy) => {
  requireCondition(hasExactKeys(request, REQUEST_KEYS), 'APPROVAL_GITHUB_REQUEST_INVALID');
  requireCondition(
    hasExactKeys(request.repository, ['id', 'full_name'])
      && request.repository.id === REPOSITORY_ID
      && request.repository.full_name === REPOSITORY_FULL_NAME
      && isSafePositiveInteger(request.prNumber)
      && isGitSha(request.expectedBaseSha)
      && isGitSha(request.expectedHeadSha)
      && request.expectedBaseSha !== request.expectedHeadSha
      && isSafePositiveInteger(request.rulesetId)
      && isSafePositiveInteger(request.codeownerReviewId)
      && ['ADR-026', 'ADR-027'].includes(request.decisionId)
      && POLICY_REVISION_PATTERN.test(request.policyRevision)
      && isDigest(request.expectedDecisionRawSha256)
      && isDigest(request.expectedDecisionSemanticSha256)
      && isCanonicalInstant(request.observedAt),
    'APPROVAL_GITHUB_REQUEST_INVALID',
  );
  const paths = [request.authorityPath, request.proposalManifestPath, request.proposalSidecarPath];
  requireCondition(
    paths.every(isRepoPath)
      && arrayIsUnique(paths)
      && paths.every((path) => policy.allowedRepoPaths.includes(path)),
    'APPROVAL_GITHUB_REPO_PATH_FORBIDDEN',
  );
  return request;
};

const copyDataRecord = (value, keys, code) => {
  requireCondition(hasExactKeys(value, keys), code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireCondition(
    keys.every((key) => descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key], 'value')),
    code,
  );
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
};

const copyDenseArray = (value, maximum, code) => {
  requireCondition(Array.isArray(value) && value.length <= maximum, code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expectedKeys = Array.from({ length: value.length }, (_unused, index) => String(index));
  requireCondition(
    Object.keys(value).length === expectedKeys.length
      && expectedKeys.every((key) => (
        descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key], 'value')
      )),
    code,
  );
  return expectedKeys.map((key) => descriptors[key].value);
};

const copyPolicy = (value) => {
  if (isPlainObject(value) && Object.keys(value).some(dynamicPolicyKey)) {
    throw approvalError('APPROVAL_GITHUB_STATIC_DYNAMIC_ID_FORBIDDEN');
  }
  const source = copyDataRecord(value, POLICY_KEYS, 'APPROVAL_GITHUB_POLICY_INVALID');
  const requiredRuleset = copyDataRecord(
    source.requiredRuleset,
    REQUIRED_RULESET_KEYS,
    'APPROVAL_GITHUB_POLICY_INVALID',
  );
  const pullRequest = copyDataRecord(
    requiredRuleset.pullRequest,
    REQUIRED_PULL_REQUEST_KEYS,
    'APPROVAL_GITHUB_POLICY_INVALID',
  );
  return {
    repositoryId: source.repositoryId,
    allowedRepoPaths: copyDenseArray(source.allowedRepoPaths, 32, 'APPROVAL_GITHUB_POLICY_INVALID'),
    allowedCheckContexts: copyDenseArray(source.allowedCheckContexts, 16, 'APPROVAL_GITHUB_POLICY_INVALID'),
    allowedActionsAppIds: copyDenseArray(source.allowedActionsAppIds, 16, 'APPROVAL_GITHUB_POLICY_INVALID'),
    allowedWorkflowIds: copyDenseArray(source.allowedWorkflowIds, 16, 'APPROVAL_GITHUB_POLICY_INVALID'),
    allowedWorkflowPaths: copyDenseArray(source.allowedWorkflowPaths, 16, 'APPROVAL_GITHUB_POLICY_INVALID'),
    allowedReusableSignerWorkflowIds: copyDenseArray(
      source.allowedReusableSignerWorkflowIds,
      16,
      'APPROVAL_GITHUB_POLICY_INVALID',
    ),
    allowedReusableSignerWorkflowPaths: copyDenseArray(
      source.allowedReusableSignerWorkflowPaths,
      16,
      'APPROVAL_GITHUB_POLICY_INVALID',
    ),
    requiredRuleset: {
      doNotEnforceOnCreate: requiredRuleset.doNotEnforceOnCreate,
      pullRequest: {
        requiredApprovingReviewCount: pullRequest.requiredApprovingReviewCount,
        dismissStaleReviewsOnPush: pullRequest.dismissStaleReviewsOnPush,
        requiredReviewers: copyDenseArray(
          pullRequest.requiredReviewers,
          10,
          'APPROVAL_GITHUB_POLICY_INVALID',
        ),
        requireCodeOwnerReview: pullRequest.requireCodeOwnerReview,
        requireLastPushApproval: pullRequest.requireLastPushApproval,
        requiredReviewThreadResolution: pullRequest.requiredReviewThreadResolution,
        requireExtraApprovalForUnattributedChanges:
          pullRequest.requireExtraApprovalForUnattributedChanges,
        allowedMergeMethods: copyDenseArray(
          pullRequest.allowedMergeMethods,
          3,
          'APPROVAL_GITHUB_POLICY_INVALID',
        ),
      },
      deletionProtection: requiredRuleset.deletionProtection,
      nonFastForwardProtection: requiredRuleset.nonFastForwardProtection,
    },
  };
};

const copyLimits = (value) => copyDataRecord(value, LIMIT_KEYS, 'APPROVAL_GITHUB_LIMIT_INVALID');

const copyRequest = (value) => {
  const source = copyDataRecord(value, REQUEST_KEYS, 'APPROVAL_GITHUB_REQUEST_INVALID');
  return {
    ...source,
    repository: copyDataRecord(
      source.repository,
      ['id', 'full_name'],
      'APPROVAL_GITHUB_REQUEST_INVALID',
    ),
  };
};

export const snapshotGitHubReadbackInputs = (requestValue, limitValue, policyValue) => {
  const policy = copyPolicy(policyValue);
  const limits = copyLimits(limitValue);
  const request = copyRequest(requestValue);
  validatePolicy(policy);
  validateLimits(limits);
  validateRequest(request, policy);
  return deepFreeze({ request, limits, policy });
};
