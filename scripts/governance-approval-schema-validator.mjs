import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schemaPath = (filename) => fileURLToPath(new URL(`../docs/governance/${filename}`, import.meta.url));
const loadSchema = (filename) => JSON.parse(readFileSync(schemaPath(filename), 'utf8'));
const schemas = Object.freeze({
  authorities: loadSchema('approval-authorities.schema.json'),
  receipt: loadSchema('trusted-approval-readback.schema.json'),
  evidenceManifest: loadSchema('trusted-approval-evidence-manifest.schema.json'),
  revocation: loadSchema('trusted-approval-revocation.schema.json'),
  supersession: loadSchema('trusted-approval-supersession.schema.json'),
  grant: loadSchema('program-c-merge-authorization-grant.schema.json'),
  consumption: loadSchema('program-c-merge-authorization-consumption.schema.json'),
});

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(ajv);
ajv.addFormat('iso-instant', {
  type: 'string',
  validate: (value) => (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value
  ),
});

const compiled = Object.freeze({
  authorities: ajv.compile(schemas.authorities),
  receipt: ajv.compile(schemas.receipt),
  evidenceManifest: ajv.compile(schemas.evidenceManifest),
  revocation: ajv.compile(schemas.revocation),
  supersession: ajv.compile(schemas.supersession),
  grant: ajv.compile(schemas.grant),
  consumption: ajv.compile(schemas.consumption),
});

const MAX_ISSUES = 16;
const MAX_PATH_LENGTH = 160;
const boundedPath = (value) => (typeof value === 'string' && value.length <= MAX_PATH_LENGTH ? value : '/<redacted>');
const issue = (schema_path, instance_path, stable_code) => Object.freeze({
  schema_path: boundedPath(schema_path),
  instance_path: boundedPath(instance_path),
  stable_code,
});
const success = Object.freeze({ valid: true, issues: Object.freeze([]) });
const freezeIssues = (issues) => Object.freeze(issues.map(({ schema_path, instance_path, stable_code }) => issue(schema_path, instance_path, stable_code)));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonicalize = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const canonicalDigest = (value) => `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;

const schemaIssues = (errors = []) => errors.map((error) => issue(
  error.schemaPath,
  error.instancePath,
  `APPROVAL_SCHEMA_${String(error.keyword).toUpperCase()}`,
));

const boundedIssues = (issues) => {
  if (issues.length <= MAX_ISSUES) return issues;
  return [...issues.slice(0, MAX_ISSUES - 1), issue('#/issues', '', 'APPROVAL_ISSUE_OVERFLOW')];
};

const validate = (compiledValidator, value, extraChecks = () => []) => {
  const valid = compiledValidator(value);
  const issues = boundedIssues(valid ? extraChecks(value) : schemaIssues(compiledValidator.errors));
  return issues.length === 0
    ? success
    : Object.freeze({ valid: false, issues: freezeIssues(issues) });
};

const duplicateActorIssues = (value) => {
  if (!isObject(value) || !Array.isArray(value.roles)) return [];
  const actorIds = value.roles
    .filter((role) => isObject(role) && role.status === 'ASSIGNED')
    .map((role) => role.actor_id);
  return new Set(actorIds).size === actorIds.length
    ? []
    : [issue('#/actor_policy', '/roles', 'APPROVAL_DISTINCT_ACTORS_REQUIRED')];
};

const receiptIssues = (value) => value.receipt_core_sha256 === canonicalDigest(value.core)
  ? []
  : [issue('#/receipt_core_sha256', '/receipt_core_sha256', 'APPROVAL_RECEIPT_CORE_DIGEST_MISMATCH')];

const evidenceManifestIssues = (value) => {
  if (!isObject(value)) return [];
  const issues = [];
  if (value.attestation_subject_sha256 !== value.receipt_raw_sha256) {
    issues.push(issue('#/attestation_subject_sha256', '/attestation_subject_sha256', 'APPROVAL_ATTESTATION_SUBJECT_MISMATCH'));
  }
  const rawDigest = typeof value.receipt_raw_sha256 === 'string' ? value.receipt_raw_sha256.slice('sha256:'.length) : '';
  if (value.attestation_bundle?.path !== `sha256-${rawDigest}.jsonl`) {
    issues.push(issue('#/attestation_bundle/path', '/attestation_bundle/path', 'APPROVAL_ATTESTATION_PATH_MISMATCH'));
  }
  if (value.files?.[0]?.sha256 !== value.receipt_core_sha256) {
    issues.push(issue('#/files/0/sha256', '/files/0/sha256', 'APPROVAL_MANIFEST_CORE_DIGEST_UNBOUND'));
  }
  if (value.files?.[1]?.sha256 !== value.receipt_raw_sha256) {
    issues.push(issue('#/files/1/sha256', '/files/1/sha256', 'APPROVAL_MANIFEST_RAW_DIGEST_UNBOUND'));
  }
  return issues;
};

const supersessionIssues = (value) => {
  if (!isObject(value)) return [];
  const issues = [];
  const predecessorId = value.predecessor?.receipt_id;
  const successorId = value.successor?.receipt_id;
  if (predecessorId === successorId) {
    issues.push(issue('#/predecessor', '/predecessor/receipt_id', 'APPROVAL_PREDECESSOR_SUCCESSOR_IDENTITY_COLLISION'));
  }
  if (value.predecessor_chain?.[0] !== predecessorId) {
    issues.push(issue('#/predecessor_chain', '/predecessor_chain/0', 'APPROVAL_PREDECESSOR_CHAIN_MISMATCH'));
  }
  if (Array.isArray(value.predecessor_chain) && value.predecessor_chain.includes(successorId)) {
    issues.push(issue('#/predecessor_chain', '/predecessor_chain', 'APPROVAL_SUPERSESSION_CYCLE'));
  }
  return issues;
};

const grantIssues = (value) => {
  if (!isObject(value)) return [];
  return Date.parse(value.expires_at) > Date.parse(value.authorized_at)
    ? []
    : [issue('#/expires_at', '/expires_at', 'APPROVAL_GRANT_EXPIRY_INVALID')];
};

const consumptionIssues = (value) => {
  if (!isObject(value)) return [];
  const expectedLedgerKey = `program-c-merge:${value.single_use_nonce}`;
  return value.nonce_ledger_key === expectedLedgerKey
    ? []
    : [issue('#/nonce_ledger_key', '/nonce_ledger_key', 'APPROVAL_NONCE_LEDGER_KEY_MISMATCH')];
};

const contextIssue = (code, path) => issue('#/cross-document-context', path, code);
const same = (left, right) => canonicalize(left) === canonicalize(right);
const contextIssues = (value) => {
  if (!isObject(value)) return [contextIssue('APPROVAL_CONTEXT_INVALID', '')];
  const { grant, consumption, authorities, authority_sha256: authoritySha, grant_raw_sha256: grantRawSha } = value;
  const basicResults = [
    validateProgramCMergeAuthorizationGrant(grant),
    validateProgramCMergeAuthorizationConsumption(consumption),
    validateApprovalAuthorities(authorities),
  ];
  const failed = basicResults.find((result) => !result.valid);
  if (failed) return [...failed.issues];
  const issues = [];
  const expectedGrantRaw = canonicalDigest(grant);
  if (grantRawSha !== expectedGrantRaw || consumption.grant_raw_sha256 !== expectedGrantRaw) {
    issues.push(contextIssue('APPROVAL_GRANT_RAW_DIGEST_MISMATCH', '/grant_raw_sha256'));
  }
  if (grant.authority_sha256 !== authoritySha || authoritySha !== canonicalDigest(authorities)) {
    issues.push(contextIssue('APPROVAL_AUTHORITY_DIGEST_MISMATCH', '/authority_sha256'));
  }
  const mergeAuthority = authorities.roles.find(({ role }) => role === 'MERGE-AUTHORIZER');
  if (
    grant.authority_revision !== authorities.revision
    || grant.authority_role !== 'MERGE-AUTHORIZER'
    || mergeAuthority?.status !== 'ASSIGNED'
    || mergeAuthority.actor_id !== grant.authority_actor_id
  ) {
    issues.push(contextIssue('APPROVAL_AUTHORITY_BINDING_MISMATCH', '/authorities'));
  }
  const pairs = [
    ['grant_id', grant.grant_id, consumption.grant_id],
    ['single_use_nonce', grant.single_use_nonce, consumption.single_use_nonce],
    ['repository', grant.repository, consumption.repository],
    ['decision_adr', grant.decision_adr, consumption.decision_adr],
    ['decision_revision', grant.decision_revision, consumption.decision_revision],
    ['policy_revision', grant.policy_revision, consumption.policy_revision],
    ['stage', grant.stage, consumption.stage],
    ['pr_number', grant.pr_number, consumption.pr_number],
    ['head_sha', grant.head_sha, consumption.authorized_head_sha],
    ['allowed_merge_method', grant.allowed_merge_method, consumption.observed_merge_method],
  ];
  for (const [name, expected, actual] of pairs) {
    if (!same(expected, actual)) issues.push(contextIssue('APPROVAL_GRANT_CONSUMPTION_BINDING_MISMATCH', `/consumption/${name}`));
  }
  if (value.revoked_receipt_ids?.includes(grant.authority_receipt_id)) {
    issues.push(contextIssue('APPROVAL_REVOKED_RECEIPT_REUSED', '/revoked_receipt_ids'));
  }
  if (Date.parse(consumption.consumed_at) > Date.parse(grant.expires_at) || Date.parse(value.now) > Date.parse(grant.expires_at)) {
    issues.push(contextIssue('APPROVAL_GRANT_EXPIRED', '/now'));
  }
  if (value.consumed_nonces?.includes(grant.single_use_nonce)) {
    issues.push(contextIssue('APPROVAL_NONCE_REPLAY', '/consumed_nonces'));
  }
  const reservations = Array.isArray(value.nonce_reservations) ? value.nonce_reservations.filter((reservation) => (
    isObject(reservation)
    && reservation.key === consumption.nonce_ledger_key
    && reservation.nonce === grant.single_use_nonce
    && reservation.grant_id === grant.grant_id
    && reservation.grant_raw_sha256 === expectedGrantRaw
  )) : [];
  if (
    reservations.length !== 1
    || reservations[0].reserved_revision !== consumption.nonce_ledger_reserved_revision
  ) {
    issues.push(contextIssue('APPROVAL_NONCE_RESERVATION_MISMATCH', '/nonce_reservations'));
  }
  return issues;
};

export const validateApprovalAuthorities = (value) => validate(compiled.authorities, value, duplicateActorIssues);
export const validateApprovalReceipt = (value) => validate(compiled.receipt, value, receiptIssues);
export const validateApprovalEvidenceManifest = (value) => validate(compiled.evidenceManifest, value, evidenceManifestIssues);
export const validateApprovalRevocation = (value) => validate(compiled.revocation, value);
export const validateApprovalSupersession = (value) => validate(compiled.supersession, value, supersessionIssues);
export const validateProgramCMergeAuthorizationGrant = (value) => validate(compiled.grant, value, grantIssues);
export const validateProgramCMergeAuthorizationConsumption = (value) => validate(compiled.consumption, value, consumptionIssues);
export const validateProgramCMergeAuthorizationConsumptionContext = (value) => {
  const issues = boundedIssues(contextIssues(value));
  return issues.length === 0 ? success : Object.freeze({ valid: false, issues: freezeIssues(issues) });
};
