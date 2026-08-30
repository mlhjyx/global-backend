import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  validateApprovalAuthorities,
  validateApprovalReceipt,
  validateApprovalEvidenceManifest,
  validateApprovalRevocation,
  validateApprovalSupersession,
  validateProgramCMergeAuthorizationGrant,
  validateProgramCMergeAuthorizationConsumption,
  validateProgramCMergeAuthorizationConsumptionContext,
  inspectSyntheticProgramCMergeAuthorizationConsumptionContext,
} from './governance-approval-schema-validator.mjs';
import { buildApprovalReceiptArtifact, renderApprovalReceiptCore, sha256Prefixed } from './governance-approval-safe-json.mjs';

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
const receiptCoreDigest = (value) => sha256Prefixed(renderApprovalReceiptCore(value));
const canonicalize = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const canonicalDigest = (value) => `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
const schemaCatalogFilenames = [
  'approval-authorities.schema.json',
  'trusted-approval-readback.schema.json',
  'trusted-approval-evidence-manifest.schema.json',
  'trusted-approval-revocation.schema.json',
  'trusted-approval-supersession.schema.json',
  'program-c-merge-authorization-grant.schema.json',
  'program-c-merge-authorization-consumption.schema.json',
];
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

const receipt = () => {
  const core = {
    receipt_id: RECEIPT_ID,
    repository: clone(REPOSITORY),
    authority_revision: 'approval-authorities/r2',
    authority_sha256: DIGEST,
    role: 'OWN-PRODUCT',
    actor_id: 1,
    actor_login: 'product-owner',
    decision_adr: 'ADR-027',
    decision_revision: 'program-c/decision-r2',
    policy_revision: 'program-c/policy-r2',
    pr_number: 42,
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
    approved_at: INSTANT,
    trust_class: 'TRUSTED_BASE_VERIFIED',
    machine_check_evidence: [{
      github_app_id: 15368,
      github_app_slug: 'github-actions',
      check_run_id: 81001,
      check_suite_id: 71001,
      context: 'approval/readback',
      workflow_id: 61001,
      workflow_path: '.github/workflows/approval-readback.yml',
      trusted_base_workflow_blob_sha: 'c'.repeat(40),
      actions_run_id: 51001,
      actions_run_attempt: 1,
      actions_run_event: 'pull_request_target',
      actions_run_head_sha: 'b'.repeat(40),
      actions_run_conclusion: 'success',
      reusable_signer: null,
    }],
  };
  return {
    schema_version: 'product-privacy-approval-readback-receipt/v1',
    core,
    receipt_core_sha256: receiptCoreDigest(core),
  };
};

const mergeAuthorityReceipt = () => {
  const value = receipt();
  value.core.role = 'MERGE-AUTHORIZER';
  value.core.actor_id = 6;
  value.core.actor_login = 'merge-authorizer';
  value.receipt_core_sha256 = receiptCoreDigest(value.core);
  return value;
};

const evidenceManifest = () => ({
  schema_version: 'trusted-approval-evidence-manifest/v1',
  path_bytes_bound: false,
  receipt_id: RECEIPT_ID,
  receipt_core_sha256: DIGEST,
  receipt_raw_sha256: OTHER_DIGEST,
  attestation_subject_sha256: OTHER_DIGEST,
  files: [
    { path: 'receipt-core.json', sha256: DIGEST },
    { path: 'receipt.json', sha256: OTHER_DIGEST },
  ],
  attestation_bundle: { path: `sha256-${'b'.repeat(64)}.jsonl`, sha256: DIGEST },
  trusted_root: {
    path: 'trusted_root.jsonl',
    sha256: DIGEST,
    acquired_at: INSTANT,
    gh_path: '/opt/global/toolchains/gh/2.89.0/bin/gh',
    gh_version: '2.89.0',
    gh_binary_sha256: DIGEST,
    owner_uid: 0,
    owner_gid: 0,
    mode: '0755',
    file_identity: {
      device: '2049',
      inode: '427001',
      size: 48_000_000,
      mtime_ns: '1788087600000000000',
      ctime_ns: '1788087600000000000',
    },
    observed_at: INSTANT,
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
  reason_code: 'POLICY_WITHDRAWN',
  revoking_role: 'OWN-PRODUCT',
  revoking_actor_id: 1,
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
  decision_adr: 'ADR-027',
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
  authority_receipt_id: RECEIPT_ID,
  authority_receipt_core_sha256: mergeAuthorityReceipt().receipt_core_sha256,
  authority_receipt_raw_sha256: OTHER_DIGEST,
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
  decision_adr: 'ADR-027',
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
    repository: { id: 99887766, full_name: 'mlhjyx/global-governance-verifier' },
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

test('Task 1 in-memory catalog exactly mirrors authoritative JSON schemas and canonical digests', async () => {
  const { APPROVAL_SCHEMA_CATALOG } = await import('./governance-approval-schema-catalog.mjs');
  assert.deepEqual(Object.keys(APPROVAL_SCHEMA_CATALOG).sort(), schemaCatalogFilenames.toSorted());
  for (const filename of schemaCatalogFilenames) {
    const json = JSON.parse(await readFile(new URL(`../docs/governance/${filename}`, import.meta.url), 'utf8'));
    assert.deepEqual(APPROVAL_SCHEMA_CATALOG[filename].schema, json, filename);
    assert.equal(APPROVAL_SCHEMA_CATALOG[filename].canonical_sha256, canonicalDigest(json), filename);
  }
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
    (value) => { delete value.core.repository; },
    (value) => { delete value.core.actor_id; },
    (value) => { value.core.actor_id = 'product-owner'; },
    (value) => { value.core.role = 'UNASSIGNED'; },
    (value) => { value.core.decision_adr = 'adr-027'; },
    (value) => { value.core.authority_revision = 'approval-authorities/stale'; },
    (value) => { value.core.head_sha = 'A'.repeat(40); },
    (value) => { value.core.approved_at = '2026-08-30T00:00:00Z'; },
    (value) => { value.semantic_sha256 = DIGEST; },
    (value) => { value.raw_sha256 = OTHER_DIGEST; },
    (value) => { value.receipt_raw_sha256 = OTHER_DIGEST; },
    (value) => { value.receipt_core_sha256 = DIGEST; },
    (value) => { value.extra = true; },
    (value) => { value.core.trust_class = 'INDEPENDENT_EXTERNAL_VERIFIED'; },
  ]) {
    const value = receipt(); mutate(value); expectInvalid(validateApprovalReceipt, value);
  }
});

test('Task 1 receipt validation uses the Task 2 schema-ordered renderer and accepts built artifacts', () => {
  for (const decisionAdr of ['ADR-026', 'ADR-027']) {
    const core = { ...receipt().core, decision_adr: decisionAdr };
    const artifact = buildApprovalReceiptArtifact(core);
    assert.equal(artifact.receiptCoreSha256, sha256Prefixed(renderApprovalReceiptCore(core)));
    expectValid(validateApprovalReceipt, artifact.envelope);
  }
});

test('receipt schema permits only a complete closed merge authorization evidence reference set', () => {
  const mergeAuthorizationEvidence = {
    stage: 'ACCEPTANCE_MERGE',
    grant_id: 'program-c-grant-0001',
    grant_raw_sha256: DIGEST,
    single_use_nonce: 'nonce-program-c-0001',
    consumption_id: 'program-c-consumption-0001',
    consumption_raw_sha256: OTHER_DIGEST,
    reserved_ledger_revision: 17,
  };
  const merged = buildApprovalReceiptArtifact({
    ...receipt().core,
    merge_authorization_evidence: mergeAuthorizationEvidence,
  });
  expectValid(validateApprovalReceipt, merged.envelope);

  for (const mutate of [
    (value) => { delete value.consumption_raw_sha256; },
    (value) => { value.mutable_status = 'CONSUMED'; },
    (value) => { value.grant_digest = value.grant_raw_sha256; },
    (value) => { value.grant = grant(); },
    (value) => { value.consumption = consumption(); },
  ]) {
    const evidence = clone(mergeAuthorizationEvidence);
    mutate(evidence);
    const value = receipt();
    value.core.merge_authorization_evidence = evidence;
    expectInvalid(validateApprovalReceipt, value);
  }
});

test('Task 1 receipt validation and Task 2 construction agree on actor_login Unicode code points', () => {
  const envelope = buildApprovalReceiptArtifact({
    ...receipt().core,
    actor_login: '😀'.repeat(256),
  }).envelope;
  expectValid(validateApprovalReceipt, envelope);
});

test('evidence manifests cryptographically bind a closed receipt evidence set', () => {
  expectValid(validateApprovalEvidenceManifest, evidenceManifest());
  for (const mutate of [
    (value) => { value.files.push({ path: 'unexpected.txt', sha256: DIGEST }); },
    (value) => { value.files.reverse(); },
    (value) => { value.files[0].path = 'receipt-core.json/../receipt-core.json'; },
    (value) => { value.files[1].path = 'receipt-core.json'; },
    (value) => { value.files[0].sha256 = OTHER_DIGEST; },
    (value) => { value.files[1].sha256 = DIGEST; },
    (value) => { value.attestation_subject_sha256 = DIGEST; },
    (value) => { value.attestation_bundle.path = 'sha256-not-the-raw-digest.jsonl'; },
    (value) => { value.path_bytes_bound = true; },
    (value) => { value.trusted_root.path = 'root.jsonl'; },
    (value) => { value.trusted_root.gh_version = '2.88.0'; },
    (value) => { delete value.trusted_root.gh_binary_sha256; },
    (value) => { value.trusted_root.owner_uid = 1000; },
    (value) => { value.trusted_root.owner_gid = 1000; },
    (value) => { value.trusted_root.mode = '0777'; },
    (value) => { value.trusted_root.file_identity.inode = '0'; },
    (value) => { value.trusted_root.file_identity.extra = 'caller'; },
    (value) => { value.trusted_root.observed_at = '2026-08-30T00:00:00Z'; },
    (value) => { value.trusted_root.acquired_at = '2026-08-30T00:00:00Z'; },
  ]) {
    const value = evidenceManifest(); mutate(value); expectInvalid(validateApprovalEvidenceManifest, value);
  }

  const legacy = evidenceManifest();
  delete legacy.path_bytes_bound;
  for (const key of [
    'gh_binary_sha256', 'owner_uid', 'owner_gid', 'mode', 'file_identity', 'observed_at',
  ]) delete legacy.trusted_root[key];
  expectInvalid(validateApprovalEvidenceManifest, legacy);
});

test('revocations and supersessions retain immutable receipt provenance', () => {
  expectValid(validateApprovalRevocation, revocation());
  expectValid(validateApprovalSupersession, supersession());
  for (const role of ['OWN-QA-EVIDENCE', 'OWN-SECURITY', 'MERGE-AUTHORIZER']) {
    const value = revocation();
    value.revoking_role = role;
    expectInvalid(validateApprovalRevocation, value);
  }
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
    (value) => { value.independent_verifier.repository = clone(REPOSITORY); },
    (value) => { value.grant = { ...grant(), status: 'CONSUMED' }; },
    (value) => { value.schema_version = 'program-c-merge-authorization/v1'; },
  ]) {
    const value = consumption(); mutate(value); expectInvalid(validateProgramCMergeAuthorizationConsumption, value);
  }
});

test('review remediation requires bounded APPROVAL issues and a closed receipt envelope', () => {
  const flatReceipt = {
    schema_version: 'product-privacy-approval-readback-receipt/v1',
    ...receipt().core,
    semantic_sha256: DIGEST,
    raw_sha256: OTHER_DIGEST,
  };
  expectInvalid(validateApprovalReceipt, flatReceipt);

  const atLimit = receipt();
  Object.assign(atLimit.core, Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`unknown_${index}`, true])));
  const atLimitResult = validateApprovalReceipt(atLimit);
  assert.equal(atLimitResult.valid, false);
  assert.equal(atLimitResult.issues.length, 16);
  assert.equal(atLimitResult.issues.some(({ stable_code }) => stable_code === 'APPROVAL_ISSUE_OVERFLOW'), false);
  assert.ok(atLimitResult.issues.every(({ stable_code }) => stable_code.startsWith('APPROVAL_')));

  const overLimit = receipt();
  Object.assign(overLimit.core, Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`untrusted_${index}`, true])));
  const overLimitResult = validateApprovalReceipt(overLimit);
  assert.equal(overLimitResult.valid, false);
  assert.equal(overLimitResult.issues.length, 16);
  assert.equal(overLimitResult.issues.at(-1).stable_code, 'APPROVAL_ISSUE_OVERFLOW');
  assert.ok(overLimitResult.issues.every(({ stable_code }) => stable_code.startsWith('APPROVAL_')));
  assert.ok(overLimitResult.issues.every(({ instance_path, schema_path }) => instance_path.length <= 160 && schema_path.length <= 160));
});

test('program c cross-document seam binds grant, authority, revocation, expiry, and nonce reservation', () => {
  const authoritiesValue = assignedAuthorities();
  const authoritySha = canonicalDigest(authoritiesValue);
  const authorityReceipt = mergeAuthorityReceipt();
  authorityReceipt.core.authority_sha256 = authoritySha;
  authorityReceipt.receipt_core_sha256 = receiptCoreDigest(authorityReceipt.core);
  const grantValue = {
    ...grant(),
    authority_sha256: authoritySha,
    authority_receipt_id: authorityReceipt.core.receipt_id,
    authority_receipt_core_sha256: authorityReceipt.receipt_core_sha256,
    authority_receipt_raw_sha256: OTHER_DIGEST,
  };
  const grantRawSha = canonicalDigest(grantValue);
  const consumptionValue = { ...consumption(), grant_raw_sha256: grantRawSha };
  const context = () => ({
    grant: clone(grantValue),
    grant_raw_sha256: grantRawSha,
    consumption: clone(consumptionValue),
    authorities: clone(authoritiesValue),
    authority_sha256: authoritySha,
    now: '2026-08-30T00:30:00.000Z',
    authority_receipt: clone(authorityReceipt),
    authority_receipt_core_sha256: authorityReceipt.receipt_core_sha256,
    authority_receipt_raw_sha256: OTHER_DIGEST,
    approval_receipts: [{ receipt: clone(authorityReceipt), receipt_raw_sha256: OTHER_DIGEST }],
    revocations: [],
    supersessions: [],
    ledger_snapshot: {
      schema_version: 'approval-nonce-ledger-snapshot/v1',
      durability_class: 'SHARED_DURABLE_CAS',
      repository_id: REPOSITORY.id,
      reservations: [{
        key: consumptionValue.nonce_ledger_key,
        single_use_nonce: consumptionValue.single_use_nonce,
        reserved_revision: consumptionValue.nonce_ledger_reserved_revision,
        grant_id: grantValue.grant_id,
        grant_raw_sha256: grantRawSha,
        request_binding: {
          repository_id: REPOSITORY.id,
          decision_adr: grantValue.decision_adr,
          decision_revision: grantValue.decision_revision,
          policy_revision: grantValue.policy_revision,
          stage: grantValue.stage,
          pr_number: grantValue.pr_number,
          head_sha: grantValue.head_sha,
        },
        state: 'RESERVED',
      }],
    },
  });
  const positive = inspectSyntheticProgramCMergeAuthorizationConsumptionContext(context());
  assert.equal(positive.synthetic_consistent, true);
  assert.equal(positive.evidence_trust_state, 'EXTERNAL_UNVERIFIED');
  assert.equal(positive.trust_eligible, false);
  assert.equal(positive.external_receipt_bytes_observed, false);
  assert.equal(positive.durable_ledger_readback_observed, false);
  assert.equal(positive.issues.at(-1).stable_code, 'APPROVAL_INDEPENDENCE_NOT_PROVEN');
  const legacy = validateProgramCMergeAuthorizationConsumptionContext(context());
  assert.deepEqual(legacy, positive);
  for (const mutate of [
    (value) => { delete value.now; },
    (value) => { value.now = '2026-08-30T00:30:00Z'; },
    (value) => { delete value.authority_receipt; },
    (value) => { delete value.authority_receipt_core_sha256; },
    (value) => { delete value.authority_receipt_raw_sha256; },
    (value) => { delete value.revocations; },
    (value) => { delete value.supersessions; },
    (value) => { delete value.ledger_snapshot; },
    (value) => { value.untrusted_extra = true; },
    (value) => { value.consumption.grant_raw_sha256 = DIGEST; },
    (value) => { value.consumption.single_use_nonce = 'nonce-program-c-other'; value.consumption.nonce_ledger_key = 'program-c-merge:nonce-program-c-other'; },
    (value) => { value.consumption.stage = 'ACCEPTANCE_MERGE'; },
    (value) => { value.consumption.decision_adr = 'ADR-999'; },
    (value) => { value.consumption.policy_revision = 'program-c/policy-r9'; },
    (value) => { value.consumption.pr_number = 99; },
    (value) => { value.consumption.authorized_head_sha = 'e'.repeat(40); },
    (value) => { value.consumption.observed_merge_method = 'REBASE'; },
    (value) => { value.authorities.roles[5].actor_id = 99; },
    (value) => { value.revocations.push({ ...revocation(), receipt_core_sha256: value.authority_receipt_core_sha256, receipt_raw_sha256: value.authority_receipt_raw_sha256 }); },
    (value) => { value.supersessions.push({ ...supersession(), predecessor: { receipt_id: RECEIPT_ID, receipt_core_sha256: value.authority_receipt_core_sha256, receipt_raw_sha256: value.authority_receipt_raw_sha256 } }); },
    (value) => { value.now = '2026-08-30T02:00:00.000Z'; },
    (value) => { value.ledger_snapshot.reservations[0].state = 'CONSUMED'; },
    (value) => { value.ledger_snapshot.reservations.push(clone(value.ledger_snapshot.reservations[0])); },
    (value) => { value.ledger_snapshot.reservations[0].reserved_revision = 2; },
    (value) => { value.ledger_snapshot.durability_class = 'PROCESS_MEMORY'; },
    (value) => {
      const duplicate = { ...value.authority_receipt, core: { ...value.authority_receipt.core, role: 'OWN-SECURITY' } };
      duplicate.receipt_core_sha256 = receiptCoreDigest(duplicate.core);
      value.approval_receipts.push({ receipt: duplicate, receipt_raw_sha256: OTHER_DIGEST });
    },
    (value) => { value.grant.head_sha = 'e'.repeat(40); },
  ]) {
    const value = context(); mutate(value);
    const result = inspectSyntheticProgramCMergeAuthorizationConsumptionContext(value);
    assert.equal(result.synthetic_consistent, false);
    assert.equal(result.trust_eligible, false);
    assert.equal(result.evidence_trust_state, 'EXTERNAL_UNVERIFIED');
    assert.ok(result.issues.every(({ stable_code }) => stable_code.startsWith('APPROVAL_')));
  }
});
