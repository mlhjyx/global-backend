import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildApprovalReceiptArtifact,
  buildApprovalReceiptCore,
  parseApprovalReviewCommand,
  validateApprovalReadback,
  validateMergeAuthorizationGrantForCandidate,
  validateReceiptRevocation,
  validateReceiptSupersession,
} from './governance-approval-readback.mjs';
import {
  validateApprovalReceipt,
  validateProgramCMergeAuthorizationConsumption,
  validateProgramCMergeAuthorizationGrant,
} from './governance-approval-schema-validator.mjs';
import { buildApprovalReceiptArtifact as buildRawApprovalReceiptArtifact } from './governance-approval-safe-json.mjs';
import { canonicalApprovalDigest } from './governance-approval-ledger-stream.mjs';
import {
  buildSyntheticTrustedReceiptArtifact,
  buildSyntheticTrustedReceiptCore,
} from './fixtures/approval-readback/synthetic-trusted-receipt.mjs';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;
const DIGEST_D = `sha256:${'d'.repeat(64)}`;
const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const RESULT_SHA = '4'.repeat(40);
const WORKFLOW_SHA = '5'.repeat(40);
const SIGNER_SHA = '6'.repeat(40);
const NOW = '2026-08-30T12:00:00.000Z';
const REPOSITORY = { id: 1291151138, full_name: 'mlhjyx/global-backend' };
const MANIFEST_URL = new URL('./fixtures/approval-readback/mutation-manifest.json', import.meta.url);
const MANIFEST = JSON.parse(await readFile(MANIFEST_URL, 'utf8'));

const clone = (value) => structuredClone(value);
const actor = (id, login) => ({ id, node_id: `NODE-${id}`, login, type: 'User' });
const command = (role) => parseApprovalReviewCommand(
  `APPROVE DECISION ADR-027 REV program-c/policy-r2 ROLE ${role} DIGEST ${DIGEST_A}`,
);
const authorityRole = (role, id, login, purpose) => ({
  role,
  status: 'ASSIGNED',
  actor_id: id,
  actor_node_id: `NODE-${id}`,
  actor_login: login,
  effective_from: '2026-08-30T00:00:00.000Z',
  effective_until: '2026-08-31T00:00:00.000Z',
  scope: { repository_id: REPOSITORY.id, decision_adr: 'ADR-027', policy_revision: 'program-c/policy-r2', purpose },
  assignment_evidence: {
    evidence_kind: 'BASE_REGISTRY_ASSIGNMENT',
    assignment_pr_number: id,
    assignment_head_sha: BASE_SHA,
    observed_at: '2026-08-30T00:00:00.000Z',
    evidence_sha256: DIGEST_D,
  },
  revocation_status: 'ACTIVE',
  superseded_by: null,
});
const authority = () => ({
  schema_version: 'approval-authority-readback/v1',
  repository: clone(REPOSITORY),
  revision: 'approval-authorities/r2',
  sha256: DIGEST_B,
  roles: [
    authorityRole('OWN-PRODUCT', 101, 'product-owner', 'DECISION_REVIEW'),
    authorityRole('OWN-DATA-PRIVACY', 102, 'privacy-owner', 'DECISION_REVIEW'),
    authorityRole('OWN-QA-EVIDENCE', 103, 'qa-owner', 'QA_EVIDENCE_REVIEW'),
    authorityRole('OWN-SECURITY', 104, 'security-owner', 'SECURITY_REVIEW'),
    authorityRole('LEGAL-REVIEW', 105, 'legal-owner', 'LEGAL_REVIEW'),
    authorityRole('MERGE-AUTHORIZER', 106, 'merge-authorizer', 'MERGE_AUTHORIZATION'),
  ],
});
const review = (role, id, actorValue) => ({
  role,
  review_id: id,
  review_state: 'APPROVED',
  review_commit_id: HEAD_SHA,
  submitted_at: '2026-08-30T10:00:00.000Z',
  independently_read_at: '2026-08-30T11:00:00.000Z',
  actor: clone(actorValue),
  command: command(role),
  dismissed: false,
  superseded: false,
  later_changes_requested: false,
});
const codeownerReview = () => ({
  evidence_kind: 'CODEOWNER_REPOSITORY_REVIEW',
  review_id: 2005,
  review_state: 'APPROVED',
  review_commit_id: HEAD_SHA,
  submitted_at: '2026-08-30T10:00:00.000Z',
  independently_read_at: '2026-08-30T11:00:00.000Z',
  actor: actor(107, 'codeowner-reviewer'),
  dismissed: false,
  superseded: false,
  later_changes_requested: false,
});
const securityReview = () => ({
  schema_version: 'program-c-security-review-evidence/v1',
  evidence_id: 'security-evidence-0001',
  repository_id: REPOSITORY.id,
  repository_full_name: REPOSITORY.full_name,
  decision_adr: 'ADR-027',
  decision_revision: 'program-c/decision-r2',
  policy_revision: 'program-c/policy-r2',
  proposal_pr_number: 427,
  base_sha: BASE_SHA,
  head_sha: HEAD_SHA,
  decision_raw_sha256: DIGEST_A,
  decision_semantic_sha256: DIGEST_C,
  proposed_sidecar_path: 'docs/governance/decisions/adr-042-r2.md',
  proposed_sidecar_raw_sha256: DIGEST_D,
  role: 'OWN-SECURITY',
  authority_revision: 'approval-authorities/r2',
  authority_sha256: DIGEST_B,
  actor_id: 104,
  actor_node_id: 'NODE-104',
  actor_login: 'security-owner',
  review_id: 2004,
  review_state: 'APPROVED',
  review_commit_id: HEAD_SHA,
  review_command_sha256: command('OWN-SECURITY').command_sha256,
  submitted_at: '2026-08-30T10:00:00.000Z',
  independently_read_at: '2026-08-30T11:00:00.000Z',
  scope: 'SECURITY_REVIEW',
  revocation_status: 'ACTIVE',
  supersedes_evidence_id: null,
  dismissed: false,
  superseded: false,
  later_changes_requested: false,
});
const machineCheck = (overrides = {}) => ({
  github_app_id: 15368,
  github_app_slug: 'github-actions',
  check_run_id: 81001,
  check_suite_id: 71001,
  context: 'approval/readback',
  workflow_id: 61001,
  workflow_path: '.github/workflows/approval-readback.yml',
  trusted_base_workflow_blob_sha: WORKFLOW_SHA,
  actions_run_id: 51001,
  actions_run_attempt: 1,
  actions_run_event: 'pull_request_target',
  actions_run_head_sha: BASE_SHA,
  actions_run_conclusion: 'success',
  reusable_signer: {
    workflow_id: 61002,
    workflow_path: '.github/workflows/approval-signer.yml',
    workflow_sha: SIGNER_SHA,
  },
  ...overrides,
});
const requiredCheck = (check) => ({
  github_app_id: check.github_app_id,
  github_app_slug: check.github_app_slug,
  context: check.context,
  workflow_id: check.workflow_id,
  workflow_path: check.workflow_path,
  trusted_base_workflow_blob_sha: check.trusted_base_workflow_blob_sha,
  reusable_signer: clone(check.reusable_signer),
});
const verifier = () => ({
  trust_class: 'INDEPENDENT_EXTERNAL_VERIFIED',
  independently_governed: true,
  repository_id: 99887766,
  repository_full_name: 'mlhjyx/global-governance-verifier',
  workflow_id: 91001,
  workflow_path: '.github/workflows/verify-approval.yml',
  workflow_sha: '7'.repeat(40),
  run_id: 92001,
  attempt: 1,
  event: 'workflow_call',
  runner_environment: 'github-hosted',
  api_version: '2022-11-28',
  identity: 'github-actions[bot]',
  read_at: '2026-08-30T11:30:00.000Z',
});
const candidate = () => {
  const check = machineCheck();
  const value = {
    schema_version: 'trusted-approval-candidate/v1',
    repository: clone(REPOSITORY),
    decision: {
      adr: 'ADR-027', revision: 'program-c/decision-r2', policy_revision: 'program-c/policy-r2',
      raw_sha256: DIGEST_A, semantic_sha256: DIGEST_C,
      proposed_sidecar_path: 'docs/governance/decisions/adr-042-r2.md', proposed_sidecar_raw_sha256: DIGEST_D,
    },
    pull_request: {
      number: 427, base_sha: BASE_SHA, head_sha: HEAD_SHA, merge_base_sha: '3'.repeat(40),
      state: 'OPEN', draft: false, author: actor(900, 'proposal-author'),
    },
    authority_revision: 'approval-authorities/r2',
    authority_sha256: DIGEST_B,
    product_review: review('OWN-PRODUCT', 2001, actor(101, 'product-owner')),
    privacy_review: review('OWN-DATA-PRIVACY', 2002, actor(102, 'privacy-owner')),
    qa_review: review('OWN-QA-EVIDENCE', 2003, actor(103, 'qa-owner')),
    codeowner_review: codeownerReview(),
    security_review: securityReview(),
    legal_input: {
      input_id: 'legal-input-0001', status: 'NO_BLOCKER_RECORDED', actor_id: 105,
      actor_node_id: 'NODE-105', actor_login: 'legal-owner', authority_revision: 'approval-authorities/r2',
      authority_sha256: DIGEST_B, reviewed_head_sha: HEAD_SHA, decision_raw_sha256: DIGEST_A,
      decision_semantic_sha256: DIGEST_C, effective_at: '2026-08-30T09:00:00.000Z',
      valid_until: '2026-08-31T00:00:00.000Z', revocation_status: 'ACTIVE',
    },
    review_pagination_complete: true,
    machine_checks: [check],
    ruleset: { normalized_sha256: DIGEST_D, bypass_actors: [] },
    verifier: verifier(),
    receipt_subject: {
      receipt_id: 'approval-receipt-0003', phase: 'REVIEW', role: 'OWN-PRODUCT',
      prior_receipt_ids: [], revoked_receipt_ids: [], superseded_receipt_ids: [],
    },
    policy: {
      schema_version: 'approval-readback-policy/v1', repository: clone(REPOSITORY),
      actor_policy: 'DISTINCT_ACTORS_REQUIRED', dual_role_exception: null,
      required_machine_checks: [requiredCheck(check)],
      pr_readable_paths: [
        'docs/governance/decisions/adr-042-r2.md',
        'docs/governance/decisions/adr-042-r2.manifest.json',
      ],
      live_ruleset_sha256: DIGEST_D, receipt_validity_ms: 3_600_000,
      maximum_receipt_validity_ms: 86_400_000, minimum_distinct_human_actors: 3,
      independent_verifier: {
        repository_id: 99887766, repository_full_name: 'mlhjyx/global-governance-verifier',
        workflow_id: 91001, workflow_path: '.github/workflows/verify-approval.yml', workflow_sha: '7'.repeat(40),
      },
    },
  };
  const snapshot = {
    head_sha: HEAD_SHA, base_sha: BASE_SHA, authority_sha256: DIGEST_B,
    ruleset_sha256: DIGEST_D, decision_raw_sha256: DIGEST_A, decision_semantic_sha256: DIGEST_C,
  };
  value.pre_read = clone(snapshot);
  value.post_read = clone(snapshot);
  return value;
};
const mergeEvidence = () => {
  const authorityReceiptArtifact = buildRawApprovalReceiptArtifact({
    receipt_id: 'merge-authority-receipt-0001',
    repository: clone(REPOSITORY),
    authority_revision: 'approval-authorities/r2',
    authority_sha256: DIGEST_B,
    role: 'MERGE-AUTHORIZER',
    actor_id: 106,
    actor_login: 'merge-authorizer',
    decision_adr: 'ADR-027',
    decision_revision: 'program-c/decision-r2',
    policy_revision: 'program-c/policy-r2',
    pr_number: 427,
    base_sha: BASE_SHA,
    head_sha: HEAD_SHA,
    approved_at: '2026-08-30T10:30:00.000Z',
    trust_class: 'TRUSTED_BASE_VERIFIED',
    machine_check_evidence: [machineCheck()],
  });
  const grant = {
    schema_version: 'program-c-merge-authorization-grant/v1', grant_id: 'program-c-grant-0001',
    repository: clone(REPOSITORY), decision_adr: 'ADR-027', decision_revision: 'program-c/decision-r2',
    policy_revision: 'program-c/policy-r2', stage: 'PROPOSAL_MERGE', pr_number: 427,
    base_sha: BASE_SHA, head_sha: HEAD_SHA, decision_raw_sha256: DIGEST_A,
    decision_semantic_sha256: DIGEST_C, allowed_merge_method: 'SQUASH', authority_role: 'MERGE-AUTHORIZER',
    authority_actor_id: 106, authority_revision: 'approval-authorities/r2', authority_sha256: DIGEST_B,
    authority_receipt_id: authorityReceiptArtifact.envelope.core.receipt_id,
    authority_receipt_core_sha256: authorityReceiptArtifact.receiptCoreSha256,
    authority_receipt_raw_sha256: authorityReceiptArtifact.receiptRawSha256,
    authorized_at: '2026-08-30T11:00:00.000Z',
    expires_at: '2026-08-30T13:00:00.000Z', single_use_nonce: 'nonce-program-c-0001',
  };
  const grantRawSha256 = canonicalApprovalDigest(grant);
  const consumption = {
    schema_version: 'program-c-merge-authorization-consumption/v1', consumption_id: 'program-c-consumption-0001',
    grant_id: grant.grant_id, grant_raw_sha256: grantRawSha256, single_use_nonce: grant.single_use_nonce,
    repository: clone(REPOSITORY), decision_adr: grant.decision_adr, decision_revision: grant.decision_revision,
    policy_revision: grant.policy_revision, stage: grant.stage, pr_number: grant.pr_number,
    authorized_head_sha: grant.head_sha, result_commit_sha: RESULT_SHA, observed_merge_method: 'SQUASH',
    consumed_at: '2026-08-30T11:20:00.000Z', nonce_ledger_key: `program-c-merge:${grant.single_use_nonce}`,
    nonce_ledger_reserved_revision: 17,
    independent_verifier: {
      repository: { id: 99887766, full_name: 'mlhjyx/global-governance-verifier' },
      path: '.github/workflows/verify-approval.yml', sha: '7'.repeat(40),
      run_id: 92001, attempt: 1, identity: 'github-actions[bot]',
    },
    current_main: { ref: 'refs/heads/main', sha: RESULT_SHA, read_at: '2026-08-30T11:40:00.000Z' },
    pre_readback_sha256: DIGEST_B, post_readback_sha256: DIGEST_C,
  };
  return {
    grant,
    grant_raw_sha256: grantRawSha256,
    consumption,
    consumption_raw_sha256: DIGEST_B,
    authority_receipt: authorityReceiptArtifact.envelope,
    authority_receipt_raw_sha256: authorityReceiptArtifact.receiptRawSha256,
    grant_revocations: [],
    ledger_snapshot: {
      schema_version: 'approval-nonce-ledger-snapshot/v1', durability_class: 'SHARED_DURABLE_CAS',
      repository_id: REPOSITORY.id, committed_revision: 19,
      reservations: [{
        key: consumption.nonce_ledger_key, grant_id: grant.grant_id, grant_raw_sha256: grantRawSha256,
        single_use_nonce: grant.single_use_nonce, reserved_revision: 17, state: 'CONSUMED',
        request_binding: {
          repository_id: REPOSITORY.id, decision_adr: grant.decision_adr,
          decision_revision: grant.decision_revision, policy_revision: grant.policy_revision,
          stage: grant.stage, pr_number: grant.pr_number, head_sha: grant.head_sha,
        },
      }],
    },
  };
};

const fixMutationRuns = new Map();
const fixMutationFailures = new Map();
const mutation = (name, callback) => {
  assert.equal(fixMutationRuns.has(name), false, `duplicate mutation ${name}`);
  fixMutationRuns.set(name, 1);
  try {
    return callback();
  } catch (error) {
    fixMutationFailures.set(name, error);
    return undefined;
  }
};
const expectIssue = (result, code) => {
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(({ stable_code: stableCode }) => stableCode === code), code);
};
const validateCandidate = (value, authorityValue = authority()) => (
  validateApprovalReadback(value, authorityValue, value.policy, NOW)
);
const validateMerge = (value, candidateValue = candidate(), authorityValue = authority()) => (
  validateMergeAuthorizationGrantForCandidate(value, candidateValue, authorityValue, NOW)
);
const rebindMergeGrantDigest = (value) => {
  const grantRawSha256 = canonicalApprovalDigest(value.grant);
  value.grant_raw_sha256 = grantRawSha256;
  value.consumption.grant_raw_sha256 = grantRawSha256;
  value.ledger_snapshot.reservations[0].grant_raw_sha256 = grantRawSha256;
};

test('FIX1 merge path starts with Task 1 closed schemas and enforces causality', () => {
  const cases = [
    ['critical-merge-grant-schema', (v) => { v.grant.authority_receipt_id = 'x'; }, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH'],
    ['critical-merge-consumption-schema', (v) => { delete v.consumption.consumption_id; }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH'],
    ['merge-invalid-method', (v) => { v.grant.allowed_merge_method = 'ROOT'; v.consumption.observed_merge_method = 'ROOT'; }, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH'],
    ['merge-future-authorized', (v) => { v.grant.authorized_at = '2026-08-30T12:30:00.000Z'; rebindMergeGrantDigest(v); }, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE'],
    ['merge-future-consumed', (v) => { v.consumption.consumed_at = '2026-08-30T12:30:00.000Z'; }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH'],
    ['merge-future-readback', (v) => { v.consumption.current_main.read_at = '2026-08-30T12:30:00.000Z'; }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH'],
    ['merge-causal-order', (v) => { v.consumption.consumed_at = '2026-08-30T10:00:00.000Z'; }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH'],
    ['merge-revocation-shape', (v) => { v.grant_revocations.push({ grant_id: 'other-grant-0001', extra: true }); }, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE'],
    ['merge-ledger-shape', (v) => { v.ledger_snapshot.extra = true; }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED'],
    ['merge-candidate-binding', (v) => { v.consumption.current_main.ref = 'refs/heads/not-main'; }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH'],
    ['merge-authority-receipt-binding', (v) => { v.grant.authority_receipt_id = 'other-authority-receipt-0001'; }, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH'],
    ['merge-verifier-binding', (v) => { v.consumption.independent_verifier.run_id = 92002; }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH'],
    ['merge-verifier-subject-repo', (v) => { v.consumption.independent_verifier.repository = clone(REPOSITORY); }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH'],
  ];
  for (const [name, mutate, code] of cases) mutation(name, () => {
    const value = mergeEvidence();
    mutate(value);
    expectIssue(validateMerge(value), code);
  });
  assert.equal(validateProgramCMergeAuthorizationGrant(mergeEvidence().grant).valid, true);
  assert.equal(validateProgramCMergeAuthorizationConsumption(mergeEvidence().consumption).valid, true);
});

test('synchronized grant mutation cannot reuse its caller-declared digest', () => {
  const candidateValue = candidate();
  candidateValue.receipt_subject.phase = 'POST_MERGE';
  const changed = structuredClone(mergeEvidence());
  const originalDigest = changed.grant_raw_sha256;
  changed.grant.single_use_nonce = 'nonce-program-c-remediation-0002';
  changed.grant.allowed_merge_method = 'MERGE';
  changed.consumption.single_use_nonce = changed.grant.single_use_nonce;
  changed.consumption.nonce_ledger_key = `program-c-merge:${changed.grant.single_use_nonce}`;
  changed.consumption.observed_merge_method = changed.grant.allowed_merge_method;
  changed.consumption_raw_sha256 = canonicalApprovalDigest(changed.consumption);
  changed.ledger_snapshot.reservations[0].key = changed.consumption.nonce_ledger_key;
  changed.ledger_snapshot.reservations[0].single_use_nonce = changed.grant.single_use_nonce;
  assert.equal(changed.grant_raw_sha256, originalDigest);
  assert.notEqual(changed.grant_raw_sha256, canonicalApprovalDigest(changed.grant));
  assert.deepEqual(validateMerge(changed, candidateValue), {
    valid: false,
    issues: [{ stable_code: 'APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH' }],
  });
});

test('FIX2 receipt schema and renderer preserve deterministic machine evidence', () => {
  mutation('machine-receipt-preserved', () => {
    const value = candidate();
    const core = buildSyntheticTrustedReceiptCore(value, null, NOW);
    assert.deepEqual(core.machine_check_evidence, value.machine_checks);
    assert.doesNotThrow(() => buildRawApprovalReceiptArtifact(core));
  });
  mutation('machine-receipt-order', () => {
    const value = candidate();
    const second = machineCheck({
      context: 'approval/aaa', check_run_id: 81002, check_suite_id: 71002,
      workflow_id: 61003, workflow_path: '.github/workflows/approval-aaa.yml', actions_run_id: 51002,
    });
    value.machine_checks.push(second);
    value.policy.required_machine_checks.push(requiredCheck(second));
    const core = buildSyntheticTrustedReceiptCore(value, null, NOW);
    assert.deepEqual(core.machine_check_evidence.map(({ context }) => context), ['approval/aaa', 'approval/readback']);
  });
  mutation('machine-receipt-partial', () => {
    const core = buildSyntheticTrustedReceiptCore(candidate(), null, NOW);
    const partial = clone(core);
    delete partial.machine_check_evidence;
    assert.throws(() => buildRawApprovalReceiptArtifact(partial));
    const invalidEnvelope = clone(buildRawApprovalReceiptArtifact(core).envelope);
    delete invalidEnvelope.core.machine_check_evidence;
    expectIssue(validateApprovalReceipt(invalidEnvelope), 'APPROVAL_SCHEMA_REQUIRED');
  });
  mutation('machine-receipt-alias', () => {
    const core = buildSyntheticTrustedReceiptCore(candidate(), null, NOW);
    const alias = clone(core);
    alias.machine_check_evidence = [{ check_run_url: 'https://example.invalid' }];
    assert.throws(() => buildRawApprovalReceiptArtifact(alias));
  });
});

test('FIX3 Task 3 artifact builder requires its opaque validated-core capability', () => {
  mutation('artifact-forged-core', () => {
    const value = candidate();
    const core = buildSyntheticTrustedReceiptCore(value, null, NOW);
    assert.throws(
      () => buildApprovalReceiptCore(value, authority(), verifier(), null, NOW),
      (error) => error.message === 'APPROVAL_INDEPENDENCE_NOT_PROVEN',
    );
    assert.throws(
      () => buildApprovalReceiptArtifact(core),
      (error) => error.message === 'APPROVAL_RECEIPT_REQUIRED',
    );
    assert.doesNotThrow(() => buildRawApprovalReceiptArtifact(core));
  });
});

test('FIX4 CODEOWNER evidence and all evidence IDs/actors are globally disjoint', () => {
  const cases = [
    ['codeowner-empty', (v) => { v.codeowner_review = {}; }, 'APPROVAL_CODEOWNER_REVIEW_REQUIRED'],
    ['codeowner-wrong-head', (v) => { v.codeowner_review.review_commit_id = BASE_SHA; }, 'APPROVAL_CODEOWNER_REVIEW_REQUIRED'],
    ['codeowner-bot', (v) => { v.codeowner_review.actor.type = 'Bot'; }, 'APPROVAL_CODEOWNER_REVIEW_REQUIRED'],
    ['global-human-machine-id-reuse', (v) => { v.machine_checks[0].check_run_id = v.product_review.review_id; }, 'APPROVAL_EVIDENCE_SLOT_REUSE'],
    ['global-machine-machine-id-reuse', (v) => { v.machine_checks[0].check_suite_id = v.machine_checks[0].check_run_id; }, 'APPROVAL_EVIDENCE_SLOT_REUSE'],
  ];
  for (const [name, mutate, code] of cases) mutation(name, () => {
    const value = candidate();
    mutate(value);
    expectIssue(validateCandidate(value), code);
  });
});

test('FIX5 authority and evidence timestamps are current and causally ordered', () => {
  mutation('authority-expired-now', () => {
    const authorityValue = authority();
    for (const role of authorityValue.roles) role.effective_until = '2026-08-30T11:45:00.000Z';
    expectIssue(validateCandidate(candidate(), authorityValue), 'APPROVAL_ROLE_AUTHORITY_STALE');
  });
  const cases = [
    ['review-future', (v) => { v.product_review.submitted_at = '2026-08-30T11:45:00.000Z'; v.product_review.independently_read_at = '2026-08-30T12:15:00.000Z'; }, 'APPROVAL_REVIEW_STALE'],
    ['review-causal-order', (v) => { v.product_review.submitted_at = '2026-08-30T11:00:00.000Z'; v.product_review.independently_read_at = '2026-08-30T10:00:00.000Z'; }, 'APPROVAL_REVIEW_STALE'],
    ['legal-future', (v) => {
      v.policy.actor_policy = 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER';
      v.policy.dual_role_exception = {
        decision_adr: 'ADR-027',
        valid_from: '2026-08-30T00:00:00.000Z',
        valid_until: '2026-08-31T00:00:00.000Z',
        coapprover_role: 'LEGAL-REVIEW',
        minimum_distinct_human_actors: 2,
        cannot_authorize_merge: true,
        cannot_authorize_release: true,
      };
      v.privacy_review.actor = clone(v.product_review.actor);
      v.legal_input.effective_at = '2026-08-30T12:30:00.000Z';
    }, 'APPROVAL_LEGAL_INPUT_STALE'],
  ];
  for (const [name, mutate, code] of cases) mutation(name, () => {
    const value = candidate();
    mutate(value);
    expectIssue(validateCandidate(value), code);
  });
});

test('FIX6 receipt subject is closed and phase-to-merge mapping is exhaustive', () => {
  const validationCases = [
    ['receipt-subject-missing', (v) => { delete v.receipt_subject; }, 'APPROVAL_RECEIPT_REQUIRED'],
    ['receipt-subject-unknown-phase', (v) => { v.receipt_subject.phase = 'UNRECOGNIZED'; }, 'APPROVAL_RECEIPT_REQUIRED'],
    ['receipt-subject-unknown-role', (v) => { v.receipt_subject.role = 'ADMIN'; }, 'APPROVAL_RECEIPT_REQUIRED'],
    ['receipt-subject-open-shape', (v) => { v.receipt_subject.extra = true; }, 'APPROVAL_RECEIPT_REQUIRED'],
  ];
  for (const [name, mutate, code] of validationCases) mutation(name, () => {
    const value = candidate();
    mutate(value);
    expectIssue(validateCandidate(value), code);
  });
  mutation('ordinary-merge-evidence-forbidden', () => {
    assert.throws(
      () => buildApprovalReceiptCore(candidate(), authority(), verifier(), mergeEvidence(), NOW),
      (error) => error.message === 'APPROVAL_MERGE_AUTHORIZATION_STAGE_MISMATCH',
    );
  });
  mutation('merge-phase-evidence-required', () => {
    const value = candidate();
    value.receipt_subject.phase = 'POST_MERGE';
    assert.throws(
      () => buildApprovalReceiptCore(value, authority(), verifier(), null, NOW),
      (error) => error.message === 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED',
    );
  });
});

const receiptSet = () => {
  const firstArtifact = buildSyntheticTrustedReceiptArtifact(candidate(), null, NOW);
  const secondCandidate = candidate();
  secondCandidate.receipt_subject.receipt_id = 'approval-receipt-0004';
  const secondArtifact = buildSyntheticTrustedReceiptArtifact(secondCandidate, null, NOW);
  const receipt = (artifact) => ({ envelope: artifact.envelope, receipt_raw_sha256: artifact.receiptRawSha256 });
  return { first: receipt(firstArtifact), second: receipt(secondArtifact) };
};
const revocationFor = (receipt) => ({
  schema_version: 'trusted-approval-revocation/v1', receipt_id: receipt.envelope.core.receipt_id,
  receipt_core_sha256: receipt.envelope.receipt_core_sha256, receipt_raw_sha256: receipt.receipt_raw_sha256,
  authority_revision: 'approval-authorities/r2', authority_sha256: DIGEST_B,
  reason_code: 'POLICY_WITHDRAWN', revoking_role: 'OWN-PRODUCT', revoking_actor_id: 101, effective_at: NOW,
});
const supersessionFor = (first, second) => ({
  schema_version: 'trusted-approval-supersession/v1',
  predecessor: {
    receipt_id: first.envelope.core.receipt_id, receipt_core_sha256: first.envelope.receipt_core_sha256,
    receipt_raw_sha256: first.receipt_raw_sha256,
  },
  successor: {
    receipt_id: second.envelope.core.receipt_id, receipt_core_sha256: second.envelope.receipt_core_sha256,
    receipt_raw_sha256: second.receipt_raw_sha256,
  },
  authority_revision: 'approval-authorities/r2', authority_sha256: DIGEST_B,
  effective_at: NOW, predecessor_chain: [first.envelope.core.receipt_id],
});
const lifecycleSnapshot = (first, second) => ({
  schema_version: 'approval-receipt-lifecycle-snapshot/v1',
  receipts: [first, second],
  revocations: [],
  supersessions: [],
});

test('FIX7 lifecycle validation uses current authority and authoritative edges', () => {
  for (const [name, mutateAuthority, code] of [
    ['revocation-authority-revoked', (a) => { a.roles[0].revocation_status = 'REVOKED'; }, 'APPROVAL_ROLE_AUTHORITY_STALE'],
    ['revocation-authority-expired', (a) => { a.roles[0].effective_until = '2026-08-30T11:00:00.000Z'; }, 'APPROVAL_ROLE_AUTHORITY_STALE'],
    ['revocation-authority-scope', (a) => { a.roles[0].scope.policy_revision = 'program-c/policy-r9'; }, 'APPROVAL_ROLE_AUTHORITY_STALE'],
  ]) mutation(name, () => {
    const { first } = receiptSet();
    const authorityValue = authority();
    mutateAuthority(authorityValue);
    expectIssue(validateReceiptRevocation(revocationFor(first), first, authorityValue, NOW), code);
  });
  mutation('supersession-authoritative-cycle', () => {
    const { first, second } = receiptSet();
    const snapshot = lifecycleSnapshot(first, second);
    snapshot.supersessions.push(supersessionFor(second, first));
    expectIssue(
      validateReceiptSupersession(supersessionFor(first, second), snapshot, authority(), NOW),
      'APPROVAL_RECEIPT_REPLAYED',
    );
  });
  mutation('supersession-snapshot-open', () => {
    const { first, second } = receiptSet();
    const snapshot = lifecycleSnapshot(first, second);
    snapshot.extra = true;
    expectIssue(
      validateReceiptSupersession(supersessionFor(first, second), snapshot, authority(), NOW),
      'APPROVAL_RECEIPT_LIFECYCLE_SNAPSHOT_INVALID',
    );
  });
});

test('FIX2A machine checks are an exact policy-declared context set', () => {
  mutation('round2-machine-untrusted-extra', () => {
    const value = candidate();
    value.machine_checks.push(machineCheck({
      context: 'approval/untrusted-extra',
      check_run_id: 81099,
      check_suite_id: 71099,
      workflow_id: 61999,
      workflow_path: '.github/workflows/untrusted-extra.yml',
      actions_run_id: 51999,
    }));
    expectIssue(validateCandidate(value), 'APPROVAL_CHECK_WORKFLOW_MISMATCH');
    assert.throws(() => buildApprovalReceiptCore(value, authority(), verifier(), null, NOW));
  });
});

test('FIX2B caller lifecycle snapshots remain synthetic and trust-ineligible', () => {
  mutation('round2-lifecycle-caller-snapshot-untrusted', () => {
    const { first, second } = receiptSet();
    const result = validateReceiptSupersession(
      supersessionFor(first, second),
      lifecycleSnapshot(first, second),
      authority(),
      NOW,
    );
    expectIssue(result, 'APPROVAL_INDEPENDENCE_NOT_PROVEN');
  });
  mutation('round2-lifecycle-omitted-cycle-edge', () => {
    const { first, second } = receiptSet();
    const omittedReverseEdge = lifecycleSnapshot(first, second);
    const result = validateReceiptSupersession(
      supersessionFor(first, second),
      omittedReverseEdge,
      authority(),
      NOW,
    );
    expectIssue(result, 'APPROVAL_INDEPENDENCE_NOT_PROVEN');
    assert.equal(result.valid, false);
  });
});

test('FIX2D CODEOWNER actor sharing follows the 3.4 adjudication without evidence-ID reuse', () => {
  mutation('round2-dual-privacy-codeowner-actor-allowed', () => {
    const value = candidate();
    const authorityValue = authority();
    value.policy.actor_policy = 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER';
    value.policy.dual_role_exception = {
      decision_adr: 'ADR-027',
      valid_from: '2026-08-30T00:00:00.000Z',
      valid_until: '2026-08-31T00:00:00.000Z',
      coapprover_role: 'OWN-QA-EVIDENCE',
      minimum_distinct_human_actors: 2,
      cannot_authorize_merge: true,
      cannot_authorize_release: true,
    };
    authorityValue.roles[1].actor_id = value.codeowner_review.actor.id;
    authorityValue.roles[1].actor_node_id = value.codeowner_review.actor.node_id;
    authorityValue.roles[1].actor_login = value.codeowner_review.actor.login;
    value.privacy_review.actor = clone(value.codeowner_review.actor);
    const result = validateCandidate(value, authorityValue);
    assert.deepEqual(result, { valid: true, issues: [] });
    const ids = [
      value.privacy_review.review_id,
      value.codeowner_review.review_id,
      value.qa_review.review_id,
      value.security_review.review_id,
    ];
    assert.equal(new Set(ids).size, ids.length);
  });
  mutation('round2-dual-coapprover-reused', () => {
    const value = candidate();
    const authorityValue = authority();
    value.policy.actor_policy = 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER';
    value.policy.dual_role_exception = {
      decision_adr: 'ADR-027',
      valid_from: '2026-08-30T00:00:00.000Z',
      valid_until: '2026-08-31T00:00:00.000Z',
      coapprover_role: 'OWN-QA-EVIDENCE',
      minimum_distinct_human_actors: 2,
      cannot_authorize_merge: true,
      cannot_authorize_release: true,
    };
    for (const index of [1, 2]) {
      authorityValue.roles[index].actor_id = value.product_review.actor.id;
      authorityValue.roles[index].actor_node_id = value.product_review.actor.node_id;
      authorityValue.roles[index].actor_login = value.product_review.actor.login;
    }
    value.privacy_review.actor = clone(value.product_review.actor);
    value.qa_review.actor = clone(value.product_review.actor);
    expectIssue(validateCandidate(value, authorityValue), 'APPROVAL_DISTINCT_ACTORS_REQUIRED');
  });
  mutation('round2-codeowner-review-id-reuse', () => {
    const value = candidate();
    value.codeowner_review.review_id = value.privacy_review.review_id;
    expectIssue(validateCandidate(value), 'APPROVAL_EVIDENCE_SLOT_REUSE');
  });
});

test('FIX3 closed CODEOWNER actor-sharing policy contract governs role validation', async () => {
  const mutationId = 'round3-codeowner-actor-sharing-policy-contract';
  assert.equal(fixMutationRuns.has(mutationId), false);
  fixMutationRuns.set(mutationId, 1);
  try {
    const roleModule = await import('./governance-approval-role-evidence.mjs');
    const expectedContract = {
      schema_version: 'codeowner-actor-sharing-policy/v1',
      codeowner_actor_reuse: 'ALLOWED_WITH_DISTINCT_EVIDENCE_IDS',
      evidence_id_uniqueness: 'ALL_HUMAN_AND_MACHINE_EVIDENCE_IDS_DISTINCT',
      dual_role_coapprover: 'DISTINCT_LEGAL_OR_QA_REQUIRED',
      minimum_distinct_humans: 2,
      security_actor_isolation_roles: ['OWN-PRODUCT', 'OWN-DATA-PRIVACY', 'OWN-QA-EVIDENCE'],
    };
    assert.deepEqual(roleModule.CODEOWNER_ACTOR_SHARING_POLICY, expectedContract);
    assert.ok(Object.isFrozen(roleModule.CODEOWNER_ACTOR_SHARING_POLICY));
    assert.ok(Object.isFrozen(roleModule.CODEOWNER_ACTOR_SHARING_POLICY.security_actor_isolation_roles));

    const sharedSecurity = candidate();
    sharedSecurity.codeowner_review.actor = {
      id: sharedSecurity.security_review.actor_id,
      node_id: sharedSecurity.security_review.actor_node_id,
      login: sharedSecurity.security_review.actor_login,
      type: 'User',
    };
    assert.deepEqual(validateCandidate(sharedSecurity), { valid: true, issues: [] });
    assert.notEqual(sharedSecurity.codeowner_review.review_id, sharedSecurity.security_review.review_id);

    const reusedId = candidate();
    reusedId.codeowner_review.review_id = reusedId.security_review.review_id;
    expectIssue(validateCandidate(reusedId), 'APPROVAL_EVIDENCE_SLOT_REUSE');

    const reusedCoapprover = candidate();
    const reusedAuthority = authority();
    reusedCoapprover.policy.actor_policy = 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER';
    reusedCoapprover.policy.dual_role_exception = {
      decision_adr: 'ADR-027',
      valid_from: '2026-08-30T00:00:00.000Z',
      valid_until: '2026-08-31T00:00:00.000Z',
      coapprover_role: 'OWN-QA-EVIDENCE',
      minimum_distinct_human_actors: 2,
      cannot_authorize_merge: true,
      cannot_authorize_release: true,
    };
    for (const index of [1, 2]) {
      reusedAuthority.roles[index].actor_id = reusedCoapprover.product_review.actor.id;
      reusedAuthority.roles[index].actor_node_id = reusedCoapprover.product_review.actor.node_id;
      reusedAuthority.roles[index].actor_login = reusedCoapprover.product_review.actor.login;
    }
    reusedCoapprover.privacy_review.actor = clone(reusedCoapprover.product_review.actor);
    reusedCoapprover.qa_review.actor = clone(reusedCoapprover.product_review.actor);
    expectIssue(
      validateCandidate(reusedCoapprover, reusedAuthority),
      'APPROVAL_DISTINCT_ACTORS_REQUIRED',
    );

    const reusedSecurityRole = candidate();
    const securityAuthority = authority();
    securityAuthority.roles[3].actor_id = reusedSecurityRole.product_review.actor.id;
    securityAuthority.roles[3].actor_node_id = reusedSecurityRole.product_review.actor.node_id;
    securityAuthority.roles[3].actor_login = reusedSecurityRole.product_review.actor.login;
    reusedSecurityRole.security_review.actor_id = reusedSecurityRole.product_review.actor.id;
    reusedSecurityRole.security_review.actor_node_id = reusedSecurityRole.product_review.actor.node_id;
    reusedSecurityRole.security_review.actor_login = reusedSecurityRole.product_review.actor.login;
    expectIssue(
      validateCandidate(reusedSecurityRole, securityAuthority),
      'APPROVAL_SECURITY_REVIEW_REUSED',
    );

    const source = await readFile(new URL('./governance-approval-role-evidence.mjs', import.meta.url), 'utf8');
    assert.ok((source.match(/CODEOWNER_ACTOR_SHARING_POLICY/g) ?? []).length >= 3);
    assert.match(source, /CODEOWNER_ACTOR_SHARING_POLICY\.codeowner_actor_reuse/);
  } catch (error) {
    fixMutationFailures.set(mutationId, error);
  }
});

test('FIX2C importing the facade is filesystem-independent and the schema catalog is committed', async () => {
  assert.equal(fixMutationRuns.has('round2-facade-import-purity'), false);
  fixMutationRuns.set('round2-facade-import-purity', 1);
  try {
    const facadeUrl = new URL('./governance-approval-readback.mjs', import.meta.url).href;
    execFileSync(process.execPath, ['--input-type=module', '--eval', `
      await import('ajv/dist/2020.js');
      await import('ajv-formats');
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      fs.readFileSync = () => { throw new Error('EXPLICIT_FS_IO_DENIED'); };
      syncBuiltinESMExports();
      await import(${JSON.stringify(facadeUrl)});
    `], { stdio: 'pipe' });
  } catch (error) {
    fixMutationFailures.set('round2-facade-import-purity', error);
  }

  assert.equal(fixMutationRuns.has('round2-schema-catalog-present'), false);
  fixMutationRuns.set('round2-schema-catalog-present', 1);
  try {
    const catalog = await import('./governance-approval-schema-catalog.mjs');
    assert.ok(Object.isFrozen(catalog.APPROVAL_SCHEMA_CATALOG));
    const validatorSource = await readFile(
      new URL('./governance-approval-schema-validator.mjs', import.meta.url),
      'utf8',
    );
    assert.match(validatorSource, /governance-approval-schema-catalog\.mjs/);
    assert.doesNotMatch(validatorSource, /node:fs|fileURLToPath|readFileSync|\.schema\.json`, import\.meta\.url/);
  } catch (error) {
    fixMutationFailures.set('round2-schema-catalog-present', error);
  }
});

test('FIX9 public facade and focused internal executable modules remain bounded', async () => {
  assert.equal(fixMutationRuns.has('implementation-module-bounds'), false);
  fixMutationRuns.set('implementation-module-bounds', 1);
  try {
    for (const path of MANIFEST.implementation_files) {
      const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
      assert.ok(source.split('\n').length - 1 <= 800, path);
    }
  } catch (error) {
    fixMutationFailures.set('implementation-module-bounds', error);
    throw error;
  }
});

test('FIX8 manifest is a complete exact-once external requirement inventory', () => {
  const expected = MANIFEST.requirements
    .filter(({ spec_file: specFile }) => specFile === 'scripts/governance-approval-readback-fix.spec.mjs')
    .flatMap(({ mutation_ids: mutationIds }) => mutationIds)
    .sort();
  assert.deepEqual([...fixMutationRuns.keys()].sort(), expected);
  assert.ok([...fixMutationRuns.values()].every((count) => count === 1));
  assert.deepEqual(
    [...fixMutationFailures.keys()],
    [],
    `failing mutations: ${[...fixMutationFailures.entries()].map(([name, error]) => (
      `${name}=${error?.stderr?.toString('utf8') || error?.message || String(error)}`
    )).join('; ')}`,
  );
});
