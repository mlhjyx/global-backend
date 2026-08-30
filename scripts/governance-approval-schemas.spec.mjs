import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateApprovalAuthorities,
  validateApprovalReceipt,
  validateApprovalEvidenceManifest,
  validateApprovalRevocation,
  validateApprovalSupersession,
  validateProgramCMergeAuthorizationGrant,
  validateProgramCMergeAuthorizationConsumption,
} from './governance-approval-schema-validator.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const RECEIPT_ID = 'approval-receipt-0001';
const OTHER_RECEIPT_ID = 'approval-receipt-0002';
const INSTANT = '2026-08-30T00:00:00.000Z';
const LATER_INSTANT = '2026-08-30T01:00:00.000Z';
const REPOSITORY = { id: 1291151138, full_name: 'mlhjyx/global-backend' };
const ROLES = [
  'OWN-PRODUCT',
  'OWN-DATA-PRIVACY',
  'OWN-QA-EVIDENCE',
  'OWN-SECURITY',
  'LEGAL-REVIEW',
  'MERGE-AUTHORIZER',
];

const clone = (value) => structuredClone(value);
const expectValid = (validator, value) => assert.deepEqual(validator(value), { valid: true, issues: [] });
const expectInvalid = (validator, value) => {
  const result = validator(value);
  assert.equal(result.valid, false);
  assert.ok(result.issues.length > 0);
  assert.ok(Object.isFrozen(result));
  for (const issue of result.issues) {
    assert.ok(Object.isFrozen(issue));
    assert.deepEqual(Object.keys(issue).sort(), ['instance_path', 'schema_path', 'stable_code']);
  }
};

const authorities = () => ({
  schema_version: 'approval-authorities/v1',
  repository: clone(REPOSITORY),
  revision: 'approval-authorities/initial-unassigned',
  actor_policy: 'DISTINCT_ACTORS_REQUIRED',
  roles: ROLES.map((role) => ({ role, status: 'UNASSIGNED' })),
});

const assignedAuthorities = () => ({
  ...authorities(),
  revision: 'approval-authorities/r2',
  roles: ROLES.map((role, index) => ({ role, actor_id: index + 1, status: 'ASSIGNED' })),
});

const receipt = () => ({
  schema_version: 'product-privacy-approval-readback-receipt/v1',
  receipt_id: RECEIPT_ID,
  repository: clone(REPOSITORY),
  authority_revision: 'approval-authorities/r2',
  authority_sha256: DIGEST,
  role: 'OWN-PRODUCT',
  actor_id: 1,
  actor_login: 'product-owner',
  decision_adr: 'ADR-042',
  decision_revision: 'program-c/decision-r2',
  policy_revision: 'program-c/policy-r2',
  pr_number: 42,
  base_sha: 'a'.repeat(40),
  head_sha: 'b'.repeat(40),
  approved_at: INSTANT,
  independence: 'INDEPENDENT',
  semantic_sha256: DIGEST,
  raw_sha256: OTHER_DIGEST,
});

const evidenceManifest = () => ({
  schema_version: 'trusted-approval-evidence-manifest/v1',
  receipt_id: RECEIPT_ID,
  receipt_core_sha256: DIGEST,
  receipt_raw_sha256: OTHER_DIGEST,
  attestation_subject_sha256: OTHER_DIGEST,
  files: [
    { path: 'receipt.json', sha256: DIGEST },
    { path: 'receipt.raw.json', sha256: OTHER_DIGEST },
  ],
  attestation_bundle: { path: `sha256-${'b'.repeat(64)}.jsonl`, sha256: DIGEST },
  trusted_root: {
    path: 'trusted_root.jsonl',
    sha256: DIGEST,
    acquired_at: INSTANT,
    gh_path: '/opt/global/toolchains/gh/2.89.0/bin/gh',
    gh_version: '2.89.0',
    tuf_source: 'GH_ATTESTATION_TRUSTED_ROOT',
  },
});

const revocation = () => ({
  schema_version: 'trusted-approval-revocation/v1',
  receipt_id: RECEIPT_ID,
  receipt_core_sha256: DIGEST,
  receipt_raw_sha256: OTHER_DIGEST,
  authority_revision: 'approval-authorities/r2',
  authority_sha256: DIGEST,
  reason_code: 'AUTHORITY_REVOKED',
  revoking_role: 'OWN-SECURITY',
  revoking_actor_id: 4,
  effective_at: INSTANT,
});

const supersession = () => ({
  schema_version: 'trusted-approval-supersession/v1',
  predecessor: { receipt_id: RECEIPT_ID, receipt_core_sha256: DIGEST, receipt_raw_sha256: OTHER_DIGEST },
  successor: { receipt_id: OTHER_RECEIPT_ID, receipt_core_sha256: OTHER_DIGEST, receipt_raw_sha256: DIGEST },
  authority_revision: 'approval-authorities/r2',
  authority_sha256: DIGEST,
  effective_at: INSTANT,
  predecessor_chain: [RECEIPT_ID],
});

const grant = () => ({
  schema_version: 'program-c-merge-authorization-grant/v1',
  grant_id: 'program-c-grant-0001',
  repository: clone(REPOSITORY),
  decision_adr: 'ADR-042',
  decision_revision: 'program-c/decision-r2',
  policy_revision: 'program-c/policy-r2',
  stage: 'PROPOSAL_MERGE',
  pr_number: 42,
  base_sha: 'a'.repeat(40),
  head_sha: 'b'.repeat(40),
  decision_raw_sha256: DIGEST,
  decision_semantic_sha256: OTHER_DIGEST,
  allowed_merge_method: 'SQUASH',
  authority_role: 'MERGE-AUTHORIZER',
  authority_actor_id: 6,
  authority_revision: 'approval-authorities/r2',
  authority_sha256: DIGEST,
  authorized_at: INSTANT,
  expires_at: LATER_INSTANT,
  single_use_nonce: 'nonce-program-c-0001',
});

const consumption = () => ({
  schema_version: 'program-c-merge-authorization-consumption/v1',
  consumption_id: 'program-c-consumption-0001',
  grant_id: 'program-c-grant-0001',
  grant_raw_sha256: DIGEST,
  single_use_nonce: 'nonce-program-c-0001',
  repository: clone(REPOSITORY),
  decision_adr: 'ADR-042',
  decision_revision: 'program-c/decision-r2',
  policy_revision: 'program-c/policy-r2',
  stage: 'PROPOSAL_MERGE',
  pr_number: 42,
  authorized_head_sha: 'b'.repeat(40),
  result_commit_sha: 'c'.repeat(40),
  observed_merge_method: 'SQUASH',
  consumed_at: INSTANT,
  nonce_ledger_key: 'program-c-merge:nonce-program-c-0001',
  nonce_ledger_reserved_revision: 1,
  independent_verifier: {
    repository: clone(REPOSITORY),
    path: '.github/workflows/verify.yml',
    sha: 'd'.repeat(40),
    run_id: 99,
    attempt: 1,
    identity: 'github-actions[bot]',
  },
  current_main: { ref: 'refs/heads/main', sha: 'c'.repeat(40), read_at: LATER_INSTANT },
  pre_readback_sha256: DIGEST,
  post_readback_sha256: OTHER_DIGEST,
});

test('approval authorities are closed, exact, and honestly unassigned', () => {
  expectValid(validateApprovalAuthorities, authorities());
  for (const mutate of [
    (value) => { value.repository = undefined; },
    (value) => { value.roles[0] = { role: value.roles[0].role, status: 'UNASSIGNED', actor_id: 1 }; },
    (value) => { value.roles = value.roles.filter(({ role }) => role !== 'OWN-SECURITY'); },
    (value) => { value.roles = value.roles.filter(({ role }) => role !== 'MERGE-AUTHORIZER'); },
    (value) => { value.roles[1].role = 'OWN-PRODUCT'; },
    (value) => { value.roles.reverse(); },
    (value) => { value.roles[0].role = 'PRODUCT-OWNER'; },
    (value) => { value.extra = true; },
  ]) {
    const value = authorities(); mutate(value); expectInvalid(validateApprovalAuthorities, value);
  }
  const assigned = assignedAuthorities(); assigned.roles[1].actor_id = 1;
  expectInvalid(validateApprovalAuthorities, assigned);
});

test('approval receipts bind distinct numeric actors and canonical approval context', () => {
  expectValid(validateApprovalReceipt, receipt());
  for (const mutate of [
    (value) => { delete value.repository; },
    (value) => { delete value.actor_id; },
    (value) => { value.actor_id = 'product-owner'; },
    (value) => { value.role = 'UNASSIGNED'; },
    (value) => { value.decision_adr = 'adr-042'; },
    (value) => { value.authority_revision = 'approval-authorities/stale'; },
    (value) => { value.head_sha = 'A'.repeat(40); },
    (value) => { value.approved_at = '2026-08-30T00:00:00Z'; },
    (value) => { value.semantic_sha256 = `sha256:${'A'.repeat(64)}`; },
    (value) => { value.extra = true; },
    (value) => { value.independence = 'EXTERNAL_INDEPENDENT'; value.base_sha = 'f'.repeat(40); },
  ]) {
    const value = receipt(); mutate(value); expectInvalid(validateApprovalReceipt, value);
  }
});

test('evidence manifests cryptographically bind a closed receipt evidence set', () => {
  expectValid(validateApprovalEvidenceManifest, evidenceManifest());
  for (const mutate of [
    (value) => { value.files.push({ path: 'unexpected.txt', sha256: DIGEST }); },
    (value) => { value.attestation_subject_sha256 = DIGEST; },
    (value) => { value.attestation_bundle.path = 'sha256-not-the-raw-digest.jsonl'; },
    (value) => { value.trusted_root.path = 'root.jsonl'; },
    (value) => { value.trusted_root.gh_version = '2.88.0'; },
    (value) => { value.trusted_root.acquired_at = '2026-08-30T00:00:00Z'; },
  ]) {
    const value = evidenceManifest(); mutate(value); expectInvalid(validateApprovalEvidenceManifest, value);
  }
});

test('revocations and supersessions retain immutable receipt provenance', () => {
  expectValid(validateApprovalRevocation, revocation());
  expectValid(validateApprovalSupersession, supersession());
  for (const mutate of [
    (value) => { delete value.receipt_core_sha256; },
    (value) => { value.reason = 'free text is forbidden'; },
    (value) => { value.reason_code = 'OTHER'; },
    (value) => { value.effective_at = '2026-08-30T00:00:00Z'; },
  ]) {
    const value = revocation(); mutate(value); expectInvalid(validateApprovalRevocation, value);
  }
  for (const mutate of [
    (value) => { value.successor.receipt_id = RECEIPT_ID; },
    (value) => { value.predecessor_chain = [RECEIPT_ID, OTHER_RECEIPT_ID, RECEIPT_ID]; },
    (value) => { value.predecessor.receipt_id = 'wrong-predecessor'; },
    (value) => { value.authority_revision = 'approval-authorities/stale'; },
  ]) {
    const value = supersession(); mutate(value); expectInvalid(validateApprovalSupersession, value);
  }
});

test('program c merge grants are immutable closed single-use authorizations', () => {
  expectValid(validateProgramCMergeAuthorizationGrant, grant());
  for (const mutate of [
    (value) => { value.schema_version = 'program-c-merge-authorization/v1'; },
    (value) => { value.status = 'CONSUMED'; },
    (value) => { delete value.single_use_nonce; },
    (value) => { value.single_use_nonce = 'nonce'; },
    (value) => { value.stage = 'OTHER_STAGE'; },
    (value) => { value.decision_adr = 'ADR-000'; },
    (value) => { value.pr_number = 0; },
    (value) => { value.head_sha = 'A'.repeat(40); },
    (value) => { value.expires_at = INSTANT; },
    (value) => { value.authority_role = 'OWN-SECURITY'; },
    (value) => { value.consumption = consumption(); },
  ]) {
    const value = grant(); mutate(value); expectInvalid(validateProgramCMergeAuthorizationGrant, value);
  }
});

test('program c consumption is an append-only independent fact that cannot change its grant', () => {
  expectValid(validateProgramCMergeAuthorizationConsumption, consumption());
  for (const mutate of [
    (value) => { delete value.grant_raw_sha256; },
    (value) => { value.single_use_nonce = 'different-nonce'; },
    (value) => { value.nonce_ledger_key = 'wrong-key'; },
    (value) => { value.nonce_ledger_reserved_revision = -1; },
    (value) => { value.nonce_ledger_reserved_revision = 1.5; },
    (value) => { value.nonce_ledger_reserved_revision = Number.MAX_SAFE_INTEGER + 1; },
    (value) => { delete value.current_main; },
    (value) => { delete value.pre_readback_sha256; },
    (value) => { value.grant = { ...grant(), status: 'CONSUMED' }; },
    (value) => { value.schema_version = 'program-c-merge-authorization/v1'; },
  ]) {
    const value = consumption(); mutate(value); expectInvalid(validateProgramCMergeAuthorizationConsumption, value);
  }
});
