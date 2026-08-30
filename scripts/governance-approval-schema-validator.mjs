import { readFileSync } from 'node:fs';
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

const issue = (schema_path, instance_path, stable_code) => Object.freeze({ schema_path, instance_path, stable_code });
const success = Object.freeze({ valid: true, issues: Object.freeze([]) });
const freezeIssues = (issues) => Object.freeze(issues.map(({ schema_path, instance_path, stable_code }) => issue(schema_path, instance_path, stable_code)));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const schemaIssues = (errors = []) => errors.map((error) => issue(
  error.schemaPath,
  error.instancePath,
  `AJV_${String(error.keyword).toUpperCase()}`,
));

const validate = (compiledValidator, value, extraChecks = () => []) => {
  const valid = compiledValidator(value);
  const issues = valid ? extraChecks(value) : schemaIssues(compiledValidator.errors);
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
    : [issue('#/actor_policy', '/roles', 'DISTINCT_ACTORS_REQUIRED')];
};

const evidenceManifestIssues = (value) => {
  if (!isObject(value)) return [];
  const issues = [];
  if (value.attestation_subject_sha256 !== value.receipt_raw_sha256) {
    issues.push(issue('#/attestation_subject_sha256', '/attestation_subject_sha256', 'ATTESTATION_SUBJECT_MUST_EQUAL_RECEIPT_RAW'));
  }
  const rawDigest = typeof value.receipt_raw_sha256 === 'string' ? value.receipt_raw_sha256.slice('sha256:'.length) : '';
  if (value.attestation_bundle?.path !== `sha256-${rawDigest}.jsonl`) {
    issues.push(issue('#/attestation_bundle/path', '/attestation_bundle/path', 'ATTESTATION_PATH_MUST_BIND_RECEIPT_RAW'));
  }
  const paths = Array.isArray(value.files) ? value.files.map(({ path }) => path) : [];
  if (new Set(paths).size !== paths.length) {
    issues.push(issue('#/files', '/files', 'EVIDENCE_FILE_PATHS_MUST_BE_UNIQUE'));
  }
  return issues;
};

const supersessionIssues = (value) => {
  if (!isObject(value)) return [];
  const issues = [];
  const predecessorId = value.predecessor?.receipt_id;
  const successorId = value.successor?.receipt_id;
  if (predecessorId === successorId) {
    issues.push(issue('#/predecessor', '/predecessor/receipt_id', 'PREDECESSOR_AND_SUCCESSOR_MUST_DIFFER'));
  }
  if (value.predecessor_chain?.[0] !== predecessorId) {
    issues.push(issue('#/predecessor_chain', '/predecessor_chain/0', 'PREDECESSOR_CHAIN_MUST_START_WITH_PREDECESSOR'));
  }
  if (Array.isArray(value.predecessor_chain) && value.predecessor_chain.includes(successorId)) {
    issues.push(issue('#/predecessor_chain', '/predecessor_chain', 'SUPERSESSION_CHAIN_MUST_BE_ACYCLIC'));
  }
  return issues;
};

const grantIssues = (value) => {
  if (!isObject(value)) return [];
  return Date.parse(value.expires_at) > Date.parse(value.authorized_at)
    ? []
    : [issue('#/expires_at', '/expires_at', 'GRANT_EXPIRY_MUST_FOLLOW_AUTHORIZATION')];
};

const consumptionIssues = (value) => {
  if (!isObject(value)) return [];
  const expectedLedgerKey = `program-c-merge:${value.single_use_nonce}`;
  return value.nonce_ledger_key === expectedLedgerKey
    ? []
    : [issue('#/nonce_ledger_key', '/nonce_ledger_key', 'NONCE_LEDGER_KEY_MUST_BIND_NONCE')];
};

export const validateApprovalAuthorities = (value) => validate(compiled.authorities, value, duplicateActorIssues);
export const validateApprovalReceipt = (value) => validate(compiled.receipt, value);
export const validateApprovalEvidenceManifest = (value) => validate(compiled.evidenceManifest, value, evidenceManifestIssues);
export const validateApprovalRevocation = (value) => validate(compiled.revocation, value);
export const validateApprovalSupersession = (value) => validate(compiled.supersession, value, supersessionIssues);
export const validateProgramCMergeAuthorizationGrant = (value) => validate(compiled.grant, value, grantIssues);
export const validateProgramCMergeAuthorizationConsumption = (value) => validate(compiled.consumption, value, consumptionIssues);
