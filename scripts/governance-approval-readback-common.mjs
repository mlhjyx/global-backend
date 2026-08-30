import { createHash } from 'node:crypto';

export const REPOSITORY_ID = 1291151138;
export const REPOSITORY_FULL_NAME = 'mlhjyx/global-backend';
export const MAX_ISSUES = 16;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const ID_PATTERN = /^[a-z][a-z0-9-]{7,127}$/;
export const POLICY_REVISION_PATTERN = /^program-c\/policy-r[1-9][0-9]*$/;
export const DECISION_REVISION_PATTERN = /^program-c\/decision-r[1-9][0-9]*$/;
export const AUTHORITY_REVISION_PATTERN = /^approval-authorities\/r[1-9][0-9]*$/;
export const NONCE_PATTERN = /^nonce-program-c-[a-z0-9-]{4,96}$/;
export const CANONICAL_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
export const isSafeNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
export const isDigest = (value) => typeof value === 'string' && DIGEST_PATTERN.test(value);
export const isGitSha = (value) => typeof value === 'string' && GIT_SHA_PATTERN.test(value);
export const isId = (value) => typeof value === 'string' && ID_PATTERN.test(value);
export const isCanonicalInstant = (value) => (
  typeof value === 'string'
  && CANONICAL_INSTANT_PATTERN.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value)).toISOString() === value
);
export const instantValue = (value) => (isCanonicalInstant(value) ? Date.parse(value) : Number.NaN);
export const isCausalOrder = (...instants) => (
  instants.every(isCanonicalInstant)
  && instants.every((instant, index) => index === 0 || instantValue(instants[index - 1]) <= instantValue(instant))
);

export const sha256 = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

export const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export const approvalError = (code) => new Error(code);

export const resultFromCodes = (codes, facts) => {
  const eligible = codes.filter((code) => typeof code === 'string' && code.startsWith('APPROVAL_'));
  const unique = [...new Set(eligible)].slice(0, MAX_ISSUES);
  if (eligible.length > MAX_ISSUES && unique.length === MAX_ISSUES) unique[MAX_ISSUES - 1] = 'APPROVAL_ISSUE_OVERFLOW';
  const result = {
    valid: unique.length === 0,
    issues: unique.map((stableCode) => ({ stable_code: stableCode })),
  };
  if (unique.length === 0 && facts !== undefined) result.facts = facts;
  return deepFreeze(result);
};

export const repositoryMatches = (value) => (
  isPlainObject(value)
  && value.id === REPOSITORY_ID
  && value.full_name === REPOSITORY_FULL_NAME
);

export const authorityRole = (authority, role) => (
  Array.isArray(authority?.roles)
    ? authority.roles.find((entry) => entry?.role === role)
    : undefined
);

export const authorityIntervalContains = (entry, instant) => (
  isCanonicalInstant(instant)
  && isCanonicalInstant(entry?.effective_from)
  && isCanonicalInstant(entry?.effective_until)
  && instantValue(entry.effective_from) <= instantValue(instant)
  && instantValue(instant) < instantValue(entry.effective_until)
);

export const authorityIsCurrent = (entry, instants, purpose, candidate) => (
  entry?.status === 'ASSIGNED'
  && isSafePositiveInteger(entry.actor_id)
  && typeof entry.actor_node_id === 'string'
  && entry.actor_node_id.length > 0
  && typeof entry.actor_login === 'string'
  && entry.actor_login.length > 0
  && instants.every((instant) => authorityIntervalContains(entry, instant))
  && entry.scope?.repository_id === candidate?.repository?.id
  && entry.scope?.decision_adr === candidate?.decision?.adr
  && entry.scope?.policy_revision === candidate?.decision?.policy_revision
  && entry.scope?.purpose === purpose
  && entry.revocation_status === 'ACTIVE'
  && entry.superseded_by === null
);

export const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
