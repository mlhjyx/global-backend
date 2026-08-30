import {
  approvalError,
  deepFreeze,
  hasExactKeys,
  isCanonicalInstant,
  isCausalOrder,
  isDigest,
  isPlainObject,
  isSafePositiveInteger,
} from './governance-approval-readback-common.mjs';
import { canonicalApprovalDigest } from './governance-approval-ledger-stream.mjs';
import { validateReceiptRevocation } from './governance-approval-readback.mjs';
import {
  validateApprovalReceipt,
  validateApprovalRevocation,
} from './governance-approval-schema-validator.mjs';
import {
  approvalGraphUnsafe,
  inspectApprovalValueGraph,
} from './governance-approval-safe-traversal.mjs';

const LIVE_KEYS = Object.freeze([
  'type', 'observedAt', 'revocation', 'targetReceipt', 'authority',
  'authorityRawSha256',
]);
const STORED_KEYS = Object.freeze([
  'type', 'observedAt', 'revocation', 'targetReceipt', 'authority',
  'validationSha256', 'evidenceSha256',
]);
const TARGET_INPUT_KEYS = Object.freeze(['envelope', 'receipt_raw_sha256']);
const TARGET_FACT_KEYS = Object.freeze([
  'receiptId', 'receiptCoreSha256', 'receiptRawSha256', 'envelopeSha256',
]);
const AUTHORITY_ROOT_KEYS = Object.freeze([
  'schema_version', 'repository', 'revision', 'sha256', 'roles',
]);
const AUTHORITY_ROLE_KEYS = Object.freeze([
  'role', 'status', 'actor_id', 'actor_node_id', 'actor_login', 'effective_from',
  'effective_until', 'scope', 'revocation_status', 'superseded_by',
]);
const AUTHORITY_SCOPE_KEYS = Object.freeze([
  'repository_id', 'decision_adr', 'policy_revision', 'purpose',
]);
const AUTHORITY_FACT_KEYS = Object.freeze([
  'revision', 'sha256', 'rawSha256', 'role', 'actorId', 'effectiveFrom',
  'effectiveUntil', 'scope', 'revocationStatus', 'supersededBy',
]);
const AUTHORITY_FACT_SCOPE_KEYS = Object.freeze([
  'repositoryId', 'decisionId', 'policyRevision', 'purpose',
]);
const AUTHORITY_ROLES = new Set([
  'OWN-PRODUCT', 'OWN-DATA-PRIVACY', 'OWN-QA-EVIDENCE', 'OWN-SECURITY',
  'LEGAL-REVIEW', 'MERGE-AUTHORIZER',
]);
const PURPOSE_BY_ROLE = Object.freeze({
  'OWN-PRODUCT': 'DECISION_REVIEW',
  'OWN-DATA-PRIVACY': 'DECISION_REVIEW',
  'OWN-QA-EVIDENCE': 'QA_EVIDENCE_REVIEW',
  'OWN-SECURITY': 'SECURITY_REVIEW',
  'LEGAL-REVIEW': 'LEGAL_REVIEW',
  'MERGE-AUTHORIZER': 'MERGE_AUTHORIZATION',
});
const MAX_REVOCATION_EVIDENCE_BYTES = 262_144;
const RECEIPT_ID_PATTERN = /^[a-z][a-z0-9-]{7,127}$/;

const fail = (code) => {
  throw approvalError(code);
};
const validationCode = (result, fallback) => (
  result.issues[0]?.stable_code ?? fallback
);
const byteLengthWithin = (value, limit) => {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= limit;
  } catch {
    return false;
  }
};
const receiptIdValid = (value) => (
  typeof value === 'string' && RECEIPT_ID_PATTERN.test(value)
);
const registryRoleClosed = (role) => (
  hasExactKeys(role, AUTHORITY_ROLE_KEYS)
  && AUTHORITY_ROLES.has(role.role)
  && role.status === 'ASSIGNED'
  && isSafePositiveInteger(role.actor_id)
  && typeof role.actor_node_id === 'string'
  && Buffer.byteLength(role.actor_node_id, 'utf8') <= 256
  && typeof role.actor_login === 'string'
  && Buffer.byteLength(role.actor_login, 'utf8') <= 256
  && isCanonicalInstant(role.effective_from)
  && isCanonicalInstant(role.effective_until)
  && Date.parse(role.effective_from) < Date.parse(role.effective_until)
  && hasExactKeys(role.scope, AUTHORITY_SCOPE_KEYS)
  && isSafePositiveInteger(role.scope.repository_id)
  && ['ADR-026', 'ADR-027'].includes(role.scope.decision_adr)
  && /^program-c\/policy-r[1-9][0-9]*$/.test(role.scope.policy_revision)
  && PURPOSE_BY_ROLE[role.role] === role.scope.purpose
  && ['ACTIVE', 'REVOKED'].includes(role.revocation_status)
  && (role.superseded_by === null
    || /^approval-authorities\/r[1-9][0-9]*$/.test(role.superseded_by))
);
const authorityRegistryClosed = (authority) => (
  hasExactKeys(authority, AUTHORITY_ROOT_KEYS)
  && authority.schema_version === 'approval-authority-readback/v1'
  && hasExactKeys(authority.repository, ['id', 'full_name'])
  && isSafePositiveInteger(authority.repository.id)
  && typeof authority.repository.full_name === 'string'
  && Buffer.byteLength(authority.repository.full_name, 'utf8') <= 256
  && /^approval-authorities\/r[1-9][0-9]*$/.test(authority.revision)
  && isDigest(authority.sha256)
  && Array.isArray(authority.roles)
  && authority.roles.length === AUTHORITY_ROLES.size
  && authority.roles.every(registryRoleClosed)
  && new Set(authority.roles.map(({ role }) => role)).size === AUTHORITY_ROLES.size
  && [...AUTHORITY_ROLES].every(
    (requiredRole) => authority.roles.some(({ role }) => role === requiredRole),
  )
);
const targetFactClosed = (target) => (
  hasExactKeys(target, TARGET_FACT_KEYS)
  && receiptIdValid(target.receiptId)
  && isDigest(target.receiptCoreSha256)
  && isDigest(target.receiptRawSha256)
  && isDigest(target.envelopeSha256)
);
const authorityFactClosed = (authority) => (
  hasExactKeys(authority, AUTHORITY_FACT_KEYS)
  && /^approval-authorities\/r[1-9][0-9]*$/.test(authority.revision)
  && isDigest(authority.sha256)
  && isDigest(authority.rawSha256)
  && AUTHORITY_ROLES.has(authority.role)
  && isSafePositiveInteger(authority.actorId)
  && isCanonicalInstant(authority.effectiveFrom)
  && isCanonicalInstant(authority.effectiveUntil)
  && Date.parse(authority.effectiveFrom) < Date.parse(authority.effectiveUntil)
  && hasExactKeys(authority.scope, AUTHORITY_FACT_SCOPE_KEYS)
  && isSafePositiveInteger(authority.scope.repositoryId)
  && ['ADR-026', 'ADR-027'].includes(authority.scope.decisionId)
  && /^program-c\/policy-r[1-9][0-9]*$/.test(authority.scope.policyRevision)
  && PURPOSE_BY_ROLE[authority.role] === authority.scope.purpose
  && ['ACTIVE', 'REVOKED'].includes(authority.revocationStatus)
  && (authority.supersededBy === null
    || /^approval-authorities\/r[1-9][0-9]*$/.test(authority.supersededBy))
);
const targetFact = (targetReceipt) => ({
  receiptId: targetReceipt.envelope.core.receipt_id,
  receiptCoreSha256: targetReceipt.envelope.receipt_core_sha256,
  receiptRawSha256: targetReceipt.receipt_raw_sha256,
  envelopeSha256: canonicalApprovalDigest(targetReceipt.envelope),
});
const authorityFact = (authority, rawSha256, roleName) => {
  const role = authority.roles.find(({ role: value }) => value === roleName);
  if (!role) fail('APPROVAL_ROLE_AUTHORITY_STALE');
  return {
    revision: authority.revision,
    sha256: authority.sha256,
    rawSha256,
    role: role.role,
    actorId: role.actor_id,
    effectiveFrom: role.effective_from,
    effectiveUntil: role.effective_until,
    scope: {
      repositoryId: role.scope.repository_id,
      decisionId: role.scope.decision_adr,
      policyRevision: role.scope.policy_revision,
      purpose: role.scope.purpose,
    },
    revocationStatus: role.revocation_status,
    supersededBy: role.superseded_by,
  };
};
const evidenceSubject = (revocation, target, authority) => ({
  schemaVersion: 'approval-receipt-revocation-evidence/v1',
  revocation,
  targetReceipt: target,
  authority,
});
const validationSubject = (revocation, target, authority, observedAt) => ({
  schemaVersion: 'approval-receipt-revocation-validation/v1',
  state: 'REVOKED',
  receiptId: target.receiptId,
  receiptCoreSha256: target.receiptCoreSha256,
  receiptRawSha256: target.receiptRawSha256,
  effectiveAt: revocation.effective_at,
  observedAt,
  authority,
});
const receiptBindingsMatch = (revocation, target) => (
  revocation.receipt_id === target.receiptId
  && revocation.receipt_core_sha256 === target.receiptCoreSha256
  && revocation.receipt_raw_sha256 === target.receiptRawSha256
);
const stateReceiptMatches = (state, target) => (
  state.receipt?.receiptId === target.receiptId
  && state.receipt?.receiptCoreSha256 === target.receiptCoreSha256
  && state.receipt?.receiptRawSha256 === target.receiptRawSha256
);
const authorityBindingsMatch = (revocation, authority, policy, state) => (
  revocation.authority_revision === authority.revision
  && revocation.authority_sha256 === authority.sha256
  && revocation.revoking_role === authority.role
  && revocation.revoking_actor_id === authority.actorId
  && authority.revision === policy.authorityRevision
  && authority.sha256 === policy.authoritySha256
  && authority.rawSha256 === policy.authorityRawSha256
  && authority.scope.repositoryId === state.repository.id
  && authority.scope.decisionId === state.decisionId
  && authority.scope.policyRevision === state.policyRevision
  && authority.scope.purpose === PURPOSE_BY_ROLE[authority.role]
  && authority.revocationStatus === 'ACTIVE'
  && authority.supersededBy === null
);
const authorityTimeValid = (revocation, authority, observedAt) => (
  isCausalOrder(authority.effectiveFrom, revocation.effective_at, observedAt)
  && Date.parse(revocation.effective_at) < Date.parse(authority.effectiveUntil)
  && Date.parse(observedAt) < Date.parse(authority.effectiveUntil)
);

export const buildStoredReceiptRevocationEvent = (event, state, policy, appendedAt) => {
  const inspection = inspectApprovalValueGraph(event);
  if (approvalGraphUnsafe(inspection)
    || !hasExactKeys(event, LIVE_KEYS)
    || event.type !== 'RECEIPT_REVOKED'
    || event.observedAt !== appendedAt
    || !isCanonicalInstant(event.observedAt)
    || !isPlainObject(event.revocation)
    || !hasExactKeys(event.targetReceipt, TARGET_INPUT_KEYS)
    || !authorityRegistryClosed(event.authority)
    || !isDigest(event.authorityRawSha256)
    || !byteLengthWithin(event, MAX_REVOCATION_EVIDENCE_BYTES)) {
    fail('APPROVAL_STATE_REVOCATION_INVALID');
  }
  const revocationSchema = validateApprovalRevocation(event.revocation);
  if (!revocationSchema.valid) {
    fail(validationCode(revocationSchema, 'APPROVAL_STATE_REVOCATION_INVALID'));
  }
  const receiptSchema = validateApprovalReceipt(event.targetReceipt.envelope);
  if (!receiptSchema.valid) {
    fail(validationCode(receiptSchema, 'APPROVAL_RECEIPT_DIGEST_MISMATCH'));
  }
  if (!isDigest(event.targetReceipt.receipt_raw_sha256)) {
    fail('APPROVAL_RECEIPT_DIGEST_MISMATCH');
  }
  if (event.authorityRawSha256 !== canonicalApprovalDigest(event.authority)) {
    fail('APPROVAL_ROLE_AUTHORITY_STALE');
  }
  const target = targetFact(event.targetReceipt);
  const authority = authorityFact(
    event.authority,
    event.authorityRawSha256,
    event.revocation.revoking_role,
  );
  if (!receiptBindingsMatch(event.revocation, target)
    || !stateReceiptMatches(state, target)
    || event.targetReceipt.envelope.core.repository.id !== state.repository.id
    || event.targetReceipt.envelope.core.repository.full_name !== state.repository.fullName
    || event.targetReceipt.envelope.core.decision_adr !== state.decisionId
    || event.targetReceipt.envelope.core.policy_revision !== state.policyRevision
    || event.targetReceipt.envelope.core.head_sha !== state.currentHeadSha) {
    fail('APPROVAL_RECEIPT_DIGEST_MISMATCH');
  }
  if (event.authority.repository.id !== state.repository.id
    || event.authority.repository.full_name !== state.repository.fullName
    || !authorityBindingsMatch(event.revocation, authority, policy, state)
    || !authorityTimeValid(event.revocation, authority, event.observedAt)) {
    fail('APPROVAL_ROLE_AUTHORITY_STALE');
  }
  const validation = validateReceiptRevocation(
    event.revocation,
    event.targetReceipt,
    event.authority,
    appendedAt,
  );
  if (!validation.valid) {
    fail(validationCode(validation, 'APPROVAL_STATE_REVOCATION_INVALID'));
  }
  const evidenceSha256 = canonicalApprovalDigest(
    evidenceSubject(event.revocation, target, authority),
  );
  const validationSha256 = canonicalApprovalDigest(
    validationSubject(event.revocation, target, authority, event.observedAt),
  );
  return deepFreeze({
    type: 'RECEIPT_REVOKED',
    observedAt: event.observedAt,
    revocation: structuredClone(event.revocation),
    targetReceipt: target,
    authority,
    validationSha256,
    evidenceSha256,
  });
};

export const storedReceiptRevocationIssue = (event, state, policy) => {
  const inspection = inspectApprovalValueGraph(event, { checkNonce: true });
  if (approvalGraphUnsafe(inspection)
    || inspection.nonce
    || !hasExactKeys(event, STORED_KEYS)
    || event.type !== 'RECEIPT_REVOKED'
    || !isCanonicalInstant(event.observedAt)
    || !targetFactClosed(event.targetReceipt)
    || !authorityFactClosed(event.authority)
    || !isDigest(event.validationSha256)
    || !isDigest(event.evidenceSha256)
    || !byteLengthWithin(event, 32_768)) {
    return 'APPROVAL_STATE_REVOCATION_INVALID';
  }
  const schema = validateApprovalRevocation(event.revocation);
  if (!schema.valid) return validationCode(schema, 'APPROVAL_STATE_REVOCATION_INVALID');
  if (!receiptBindingsMatch(event.revocation, event.targetReceipt)
    || !stateReceiptMatches(state, event.targetReceipt)) {
    return 'APPROVAL_RECEIPT_DIGEST_MISMATCH';
  }
  if (!authorityBindingsMatch(event.revocation, event.authority, policy, state)
    || !authorityTimeValid(event.revocation, event.authority, event.observedAt)) {
    return 'APPROVAL_ROLE_AUTHORITY_STALE';
  }
  if (event.evidenceSha256 !== canonicalApprovalDigest(
    evidenceSubject(event.revocation, event.targetReceipt, event.authority),
  ) || event.validationSha256 !== canonicalApprovalDigest(
    validationSubject(
      event.revocation,
      event.targetReceipt,
      event.authority,
      event.observedAt,
    ),
  )) return 'APPROVAL_STATE_REVOCATION_DIGEST_MISMATCH';
  return null;
};

export const isClosedStoredReceiptRevocationEvent = (event) => {
  const inspection = inspectApprovalValueGraph(event, { checkNonce: true });
  if (approvalGraphUnsafe(inspection)
    || inspection.nonce
    || !hasExactKeys(event, STORED_KEYS)
    || event.type !== 'RECEIPT_REVOKED'
    || !isCanonicalInstant(event.observedAt)
    || !targetFactClosed(event.targetReceipt)
    || !authorityFactClosed(event.authority)
    || !isDigest(event.validationSha256)
    || !isDigest(event.evidenceSha256)
    || !byteLengthWithin(event, 32_768)) return false;
  return validateApprovalRevocation(event.revocation).valid
    && receiptBindingsMatch(event.revocation, event.targetReceipt)
    && event.revocation.authority_revision === event.authority.revision
    && event.revocation.authority_sha256 === event.authority.sha256
    && event.revocation.revoking_role === event.authority.role
    && event.revocation.revoking_actor_id === event.authority.actorId
    && authorityTimeValid(event.revocation, event.authority, event.observedAt)
    && event.evidenceSha256 === canonicalApprovalDigest(
      evidenceSubject(event.revocation, event.targetReceipt, event.authority),
    )
    && event.validationSha256 === canonicalApprovalDigest(
      validationSubject(
        event.revocation,
        event.targetReceipt,
        event.authority,
        event.observedAt,
      ),
    );
};
