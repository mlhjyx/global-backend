import assert from 'node:assert/strict';
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

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;
const DIGEST_D = `sha256:${'d'.repeat(64)}`;
const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const MERGE_BASE_SHA = '3'.repeat(40);
const RESULT_SHA = '4'.repeat(40);
const WORKFLOW_SHA = '5'.repeat(40);
const SIGNER_SHA = '6'.repeat(40);
const NOW = '2026-08-30T12:00:00.000Z';
const REPOSITORY = Object.freeze({ id: 1291151138, full_name: 'mlhjyx/global-backend' });

const clone = (value) => structuredClone(value);

const commandLine = (role, digest = DIGEST_A) => (
  `APPROVE DECISION ADR-042 REV program-c/policy-r2 ROLE ${role} DIGEST ${digest}`
);

const parsedCommand = (role) => parseApprovalReviewCommand(commandLine(role));

const actor = (id, login) => ({
  id,
  node_id: `MDQ6VXNlcj${id}`,
  login,
  type: 'User',
});

const authorityRole = (role, id, login, purpose) => ({
  role,
  status: 'ASSIGNED',
  actor_id: id,
  actor_node_id: `MDQ6VXNlcj${id}`,
  actor_login: login,
  effective_from: '2026-08-30T00:00:00.000Z',
  effective_until: '2026-08-31T00:00:00.000Z',
  scope: {
    repository_id: REPOSITORY.id,
    decision_adr: 'ADR-042',
    policy_revision: 'program-c/policy-r2',
    purpose,
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

const dualRoleAuthority = () => {
  const value = authority();
  value.roles[1].actor_id = value.roles[0].actor_id;
  value.roles[1].actor_node_id = value.roles[0].actor_node_id;
  value.roles[1].actor_login = value.roles[0].actor_login;
  return value;
};

const review = (role, id, actorValue) => ({
  role,
  review_id: id,
  review_state: 'APPROVED',
  review_commit_id: HEAD_SHA,
  submitted_at: '2026-08-30T10:00:00.000Z',
  independently_read_at: '2026-08-30T11:00:00.000Z',
  actor: clone(actorValue),
  command: parsedCommand(role),
  dismissed: false,
  superseded: false,
  later_changes_requested: false,
});

const securityEvidence = () => ({
  schema_version: 'program-c-security-review-evidence/v1',
  evidence_id: 'security-evidence-0001',
  repository_id: REPOSITORY.id,
  repository_full_name: REPOSITORY.full_name,
  decision_adr: 'ADR-042',
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
  actor_node_id: 'MDQ6VXNlcj104',
  actor_login: 'security-owner',
  review_id: 2004,
  review_state: 'APPROVED',
  review_commit_id: HEAD_SHA,
  review_command_sha256: parsedCommand('OWN-SECURITY').command_sha256,
  submitted_at: '2026-08-30T10:00:00.000Z',
  independently_read_at: '2026-08-30T11:00:00.000Z',
  scope: 'SECURITY_REVIEW',
  revocation_status: 'ACTIVE',
  supersedes_evidence_id: null,
  dismissed: false,
  superseded: false,
  later_changes_requested: false,
});

const legalInput = () => ({
  input_id: 'legal-input-0001',
  status: 'NO_BLOCKER_RECORDED',
  actor_id: 105,
  actor_node_id: 'MDQ6VXNlcj105',
  actor_login: 'legal-owner',
  authority_revision: 'approval-authorities/r2',
  authority_sha256: DIGEST_B,
  reviewed_head_sha: HEAD_SHA,
  decision_raw_sha256: DIGEST_A,
  decision_semantic_sha256: DIGEST_C,
  effective_at: '2026-08-30T09:00:00.000Z',
  valid_until: '2026-08-31T00:00:00.000Z',
  revocation_status: 'ACTIVE',
});

const machineCheck = () => ({
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
  actions_run_head_sha: HEAD_SHA,
  actions_run_conclusion: 'success',
  reusable_signer: {
    workflow_id: 61002,
    workflow_path: '.github/workflows/approval-signer.yml',
    workflow_sha: SIGNER_SHA,
  },
});

const policy = () => ({
  schema_version: 'approval-readback-policy/v1',
  repository: clone(REPOSITORY),
  actor_policy: 'DISTINCT_ACTORS_REQUIRED',
  dual_role_exception: null,
  required_machine_checks: [{
    github_app_id: 15368,
    github_app_slug: 'github-actions',
    context: 'approval/readback',
    workflow_id: 61001,
    workflow_path: '.github/workflows/approval-readback.yml',
    trusted_base_workflow_blob_sha: WORKFLOW_SHA,
    reusable_signer: {
      workflow_id: 61002,
      workflow_path: '.github/workflows/approval-signer.yml',
      workflow_sha: SIGNER_SHA,
    },
  }],
  pr_readable_paths: [
    'docs/governance/decisions/adr-042-r2.md',
    'docs/governance/decisions/adr-042-r2.manifest.json',
  ],
  live_ruleset_sha256: DIGEST_D,
  receipt_validity_ms: 3_600_000,
  maximum_receipt_validity_ms: 86_400_000,
  minimum_distinct_human_actors: 3,
  independent_verifier: {
    repository_id: 99887766,
    repository_full_name: 'mlhjyx/global-governance-verifier',
    workflow_id: 91001,
    workflow_path: '.github/workflows/verify-approval.yml',
    workflow_sha: '7'.repeat(40),
  },
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
  read_at: '2026-08-30T11:30:00.000Z',
});

const readbackSnapshot = () => ({
  head_sha: HEAD_SHA,
  base_sha: BASE_SHA,
  authority_sha256: DIGEST_B,
  ruleset_sha256: DIGEST_D,
  decision_raw_sha256: DIGEST_A,
  decision_semantic_sha256: DIGEST_C,
});

const candidate = () => {
  const policyValue = policy();
  return {
    schema_version: 'trusted-approval-candidate/v1',
    repository: clone(REPOSITORY),
    decision: {
      adr: 'ADR-042',
      revision: 'program-c/decision-r2',
      policy_revision: 'program-c/policy-r2',
      raw_sha256: DIGEST_A,
      semantic_sha256: DIGEST_C,
      proposed_sidecar_path: 'docs/governance/decisions/adr-042-r2.md',
      proposed_sidecar_raw_sha256: DIGEST_D,
    },
    pull_request: {
      number: 427,
      base_sha: BASE_SHA,
      head_sha: HEAD_SHA,
      merge_base_sha: MERGE_BASE_SHA,
      state: 'OPEN',
      draft: false,
      author: actor(900, 'proposal-author'),
    },
    authority_revision: 'approval-authorities/r2',
    authority_sha256: DIGEST_B,
    product_review: review('OWN-PRODUCT', 2001, actor(101, 'product-owner')),
    privacy_review: review('OWN-DATA-PRIVACY', 2002, actor(102, 'privacy-owner')),
    qa_review: review('OWN-QA-EVIDENCE', 2003, actor(103, 'qa-owner')),
    codeowner_review: review('OWN-QA-EVIDENCE', 2005, actor(107, 'codeowner-reviewer')),
    security_review: securityEvidence(),
    legal_input: legalInput(),
    review_pagination_complete: true,
    machine_checks: [machineCheck()],
    ruleset: { normalized_sha256: DIGEST_D, bypass_actors: [] },
    pre_read: readbackSnapshot(),
    post_read: readbackSnapshot(),
    verifier: verifier(),
    receipt_subject: {
      receipt_id: 'approval-receipt-0003',
      phase: 'REVIEW',
      role: 'OWN-PRODUCT',
      prior_receipt_ids: [],
      revoked_receipt_ids: [],
      superseded_receipt_ids: [],
    },
    policy: policyValue,
  };
};

const dualRoleCandidate = () => {
  const value = candidate();
  value.policy.actor_policy = 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER';
  value.policy.dual_role_exception = {
    decision_adr: 'ADR-042',
    valid_from: '2026-08-30T00:00:00.000Z',
    valid_until: '2026-08-31T00:00:00.000Z',
    coapprover_role: 'OWN-QA-EVIDENCE',
    minimum_distinct_human_actors: 2,
    cannot_authorize_merge: true,
    cannot_authorize_release: true,
  };
  value.privacy_review.actor = clone(value.product_review.actor);
  const privacyAuthority = value.policy.actor_policy;
  assert.equal(privacyAuthority, 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER');
  return value;
};

const mergeEvidence = () => {
  const grant = {
    schema_version: 'program-c-merge-authorization-grant/v1',
    grant_id: 'program-c-grant-0001',
    repository: clone(REPOSITORY),
    decision_adr: 'ADR-042',
    decision_revision: 'program-c/decision-r2',
    policy_revision: 'program-c/policy-r2',
    stage: 'PROPOSAL_MERGE',
    pr_number: 427,
    base_sha: BASE_SHA,
    head_sha: HEAD_SHA,
    decision_raw_sha256: DIGEST_A,
    decision_semantic_sha256: DIGEST_C,
    allowed_merge_method: 'SQUASH',
    authority_role: 'MERGE-AUTHORIZER',
    authority_actor_id: 106,
    authority_revision: 'approval-authorities/r2',
    authority_sha256: DIGEST_B,
    authority_receipt_id: 'merge-authority-receipt-0001',
    authority_receipt_core_sha256: DIGEST_C,
    authority_receipt_raw_sha256: DIGEST_D,
    authorized_at: '2026-08-30T11:00:00.000Z',
    expires_at: '2026-08-30T13:00:00.000Z',
    single_use_nonce: 'nonce-program-c-0001',
  };
  const consumption = {
    schema_version: 'program-c-merge-authorization-consumption/v1',
    consumption_id: 'program-c-consumption-0001',
    grant_id: grant.grant_id,
    grant_raw_sha256: DIGEST_A,
    single_use_nonce: grant.single_use_nonce,
    repository: clone(REPOSITORY),
    decision_adr: grant.decision_adr,
    decision_revision: grant.decision_revision,
    policy_revision: grant.policy_revision,
    stage: grant.stage,
    pr_number: grant.pr_number,
    authorized_head_sha: grant.head_sha,
    result_commit_sha: RESULT_SHA,
    observed_merge_method: grant.allowed_merge_method,
    consumed_at: '2026-08-30T11:45:00.000Z',
    nonce_ledger_key: `program-c-merge:${grant.single_use_nonce}`,
    nonce_ledger_reserved_revision: 17,
    independent_verifier: {
      repository: clone(REPOSITORY),
      path: '.github/workflows/verify.yml',
      sha: WORKFLOW_SHA,
      run_id: 3001,
      attempt: 1,
      identity: 'github-actions[bot]',
    },
    current_main: { ref: 'refs/heads/main', sha: RESULT_SHA, read_at: NOW },
    pre_readback_sha256: DIGEST_B,
    post_readback_sha256: DIGEST_C,
  };
  return {
    grant,
    grant_raw_sha256: DIGEST_A,
    consumption,
    consumption_raw_sha256: DIGEST_B,
    grant_revocations: [],
    ledger_snapshot: {
      schema_version: 'approval-nonce-ledger-snapshot/v1',
      durability_class: 'SHARED_DURABLE_CAS',
      committed_revision: 19,
      reservations: [{
        key: consumption.nonce_ledger_key,
        grant_id: grant.grant_id,
        grant_raw_sha256: DIGEST_A,
        single_use_nonce: grant.single_use_nonce,
        reserved_revision: 17,
        state: 'CONSUMED',
      }],
    },
  };
};

const expectIssue = (result, stableCode) => {
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(({ stable_code: code }) => code === stableCode), stableCode);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.issues));
  assert.ok(result.issues.every(({ stable_code: code }) => code.startsWith('APPROVAL_')));
  assert.ok(JSON.stringify(result).length < 16_384);
};

const mutationRuns = new Map();
const runMutation = (name, base, mutate, validate, expectedCode) => {
  assert.equal(mutationRuns.has(name), false, `duplicate mutation ${name}`);
  mutationRuns.set(name, 1);
  const value = base();
  mutate(value);
  expectIssue(validate(value), expectedCode);
};

test('review command grammar accepts only the canonical bounded single line', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/approval-readback/review-commands.json', import.meta.url), 'utf8'));
  const parsed = parseApprovalReviewCommand(fixture.canonical);
  assert.deepEqual(parsed, {
    decision_adr: 'ADR-042',
    policy_revision: 'program-c/policy-r2',
    role: 'OWN-PRODUCT',
    decision_raw_sha256: DIGEST_A,
    command_sha256: parsed.command_sha256,
  });
  assert.match(parsed.command_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(parsed));
  assert.equal(Object.hasOwn(parsed, 'body'), false);

  const rejected = [
    ...fixture.representative_invalid,
    `**${fixture.canonical}**`,
    `${fixture.canonical}\u202e`,
    `<p>${fixture.canonical}</p>`,
    `${fixture.canonical} @owner`,
    `${fixture.canonical}; true`,
    fixture.canonical.replace('OWN-PRODUCT', 'PRODUCT-OWNER'),
    fixture.canonical.replace('ADR-042', 'ADR-42'),
    fixture.canonical.replace('program-c/policy-r2', 'program-c/policy-r02'),
    fixture.canonical.replace(' DIGEST ', '\tDIGEST '),
    fixture.canonical.replace(DIGEST_A, 'sha256:abc'),
    `${fixture.canonical} ` + '${{ secrets.X }}',
  ];
  for (const body of rejected) {
    assert.throws(
      () => parseApprovalReviewCommand(body),
      (error) => error.message === 'APPROVAL_REVIEW_COMMAND_INVALID' && !error.message.includes(body),
    );
  }
});

test('distinct and dual-role synthetic candidates validate with frozen bounded output', () => {
  for (const [value, authorityValue] of [[candidate(), authority()], [dualRoleCandidate(), dualRoleAuthority()]]) {
    const result = validateApprovalReadback(value, authorityValue, value.policy, NOW);
    assert.deepEqual(result, { valid: true, issues: [] });
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.issues));
  }
});

test('approval readback executes each required trust mutation exactly once', () => {
  const validate = (value) => validateApprovalReadback(value, authority(), value.policy, NOW);
  const cases = [
    ['owner-actor-mismatch', (v) => { v.product_review.actor.id = 999; }, 'APPROVAL_REVIEW_ACTOR_MISMATCH'],
    ['bot-reviewer', (v) => { v.product_review.actor.type = 'Bot'; }, 'APPROVAL_REVIEW_ACTOR_MISMATCH'],
    ['pr-author-reviewer', (v) => { v.product_review.actor = clone(v.pull_request.author); }, 'APPROVAL_REVIEW_ACTOR_MISMATCH'],
    ['same-actor-without-exception', (v) => { v.privacy_review.actor = clone(v.product_review.actor); }, 'APPROVAL_DISTINCT_ACTORS_REQUIRED'],
    ['missing-third-human', (v) => { v.security_review.actor_id = v.qa_review.actor.id; v.security_review.actor_node_id = v.qa_review.actor.node_id; v.security_review.actor_login = v.qa_review.actor.login; }, 'APPROVAL_SECURITY_REVIEW_REUSED'],
    ['wrong-review-state', (v) => { v.product_review.review_state = 'COMMENTED'; }, 'APPROVAL_REVIEW_REQUIRED'],
    ['wrong-review-head', (v) => { v.product_review.review_commit_id = BASE_SHA; }, 'APPROVAL_REVIEW_STALE'],
    ['dismissed-review', (v) => { v.product_review.dismissed = true; }, 'APPROVAL_REVIEW_DISMISSED'],
    ['later-changes-requested', (v) => { v.product_review.later_changes_requested = true; }, 'APPROVAL_REVIEW_STALE'],
    ['check-ambiguity', (v) => { v.machine_checks.push(clone(v.machine_checks[0])); }, 'APPROVAL_CHECK_AMBIGUOUS'],
    ['ruleset-drift', (v) => { v.ruleset.normalized_sha256 = DIGEST_A; }, 'APPROVAL_RULESET_DRIFT'],
    ['ruleset-bypass', (v) => { v.ruleset.bypass_actors = [101]; }, 'APPROVAL_RULESET_BYPASS_PRESENT'],
    ['toctou-head', (v) => { v.post_read.head_sha = BASE_SHA; }, 'APPROVAL_TOCTOU_DETECTED'],
    ['decision-raw-drift', (v) => { v.post_read.decision_raw_sha256 = DIGEST_B; }, 'APPROVAL_TOCTOU_DETECTED'],
    ['decision-semantic-drift', (v) => { v.post_read.decision_semantic_sha256 = DIGEST_B; }, 'APPROVAL_TOCTOU_DETECTED'],
    ['legal-pending', (v) => { v.legal_input.status = 'PENDING'; }, 'APPROVAL_LEGAL_INPUT_REQUIRED'],
    ['receipt-replay', (v) => { v.receipt_subject.prior_receipt_ids.push(v.receipt_subject.receipt_id); }, 'APPROVAL_RECEIPT_REPLAYED'],
    ['revoked-receipt', (v) => { v.receipt_subject.revoked_receipt_ids.push(v.receipt_subject.receipt_id); }, 'APPROVAL_POLICY_REVOKED'],
    ['independence-overclaim', (v) => { v.verifier.independently_governed = false; }, 'APPROVAL_INDEPENDENCE_NOT_PROVEN'],
    ['pagination-incomplete', (v) => { v.review_pagination_complete = false; }, 'APPROVAL_PAGINATION_INCOMPLETE'],
    ['policy-static-run-id', (v) => { v.policy.allowedCheckRunIds = [81001]; }, 'APPROVAL_CHECK_WORKFLOW_MISMATCH'],
    ['policy-static-suite-id', (v) => { v.policy.allowedCheckSuiteIds = [71001]; }, 'APPROVAL_CHECK_WORKFLOW_MISMATCH'],
    ['name-only-check', (v) => { delete v.machine_checks[0].check_run_id; }, 'APPROVAL_CHECK_REQUIRED'],
    ['url-only-check', (v) => { v.machine_checks[0] = { context: 'approval/readback', url: 'https://example.invalid/check' }; }, 'APPROVAL_CHECK_REQUIRED'],
    ['workflow-id-mismatch', (v) => { v.machine_checks[0].workflow_id = 999; }, 'APPROVAL_CHECK_WORKFLOW_MISMATCH'],
    ['workflow-path-mismatch', (v) => { v.machine_checks[0].workflow_path = '.github/workflows/other.yml'; }, 'APPROVAL_CHECK_WORKFLOW_MISMATCH'],
    ['workflow-blob-mismatch', (v) => { v.machine_checks[0].trusted_base_workflow_blob_sha = BASE_SHA; }, 'APPROVAL_CHECK_WORKFLOW_MISMATCH'],
    ['actions-app-mismatch', (v) => { v.machine_checks[0].github_app_id = 1; }, 'APPROVAL_CHECK_WORKFLOW_MISMATCH'],
    ['actions-run-head-mismatch', (v) => { v.machine_checks[0].actions_run_head_sha = BASE_SHA; }, 'APPROVAL_CHECK_WORKFLOW_MISMATCH'],
    ['actions-run-conclusion', (v) => { v.machine_checks[0].actions_run_conclusion = 'failure'; }, 'APPROVAL_CHECK_REQUIRED'],
    ['signer-mismatch', (v) => { v.machine_checks[0].reusable_signer.workflow_sha = BASE_SHA; }, 'APPROVAL_CHECK_WORKFLOW_MISMATCH'],
    ['sidecar-path-not-allowlisted', (v) => { v.policy.pr_readable_paths = ['docs/governance/decisions/adr-042-r2.manifest.json']; }, 'APPROVAL_PROPOSED_SIDECAR_REQUIRED'],
    ['machine-check-array-missing', (v) => { delete v.machine_checks; }, 'APPROVAL_CHECK_REQUIRED'],
  ];
  for (const [name, mutate, code] of cases) runMutation(name, candidate, mutate, validate, code);
});

test('OWN-SECURITY remains a closed exact-head independent human evidence slot', () => {
  const validate = (value) => validateApprovalReadback(value, authority(), value.policy, NOW);
  const validateWithAuthorityMutation = (mutateAuthority) => (value) => {
    const authorityValue = authority();
    mutateAuthority(authorityValue);
    return validateApprovalReadback(value, authorityValue, value.policy, NOW);
  };
  const candidateCases = [
    ['security-missing', (v) => { v.security_review = null; }, 'APPROVAL_SECURITY_REVIEW_REQUIRED'],
    ['security-wrong-pr', (v) => { v.security_review.proposal_pr_number = 1; }, 'APPROVAL_SECURITY_REVIEW_HEAD_MISMATCH'],
    ['security-wrong-base', (v) => { v.security_review.base_sha = MERGE_BASE_SHA; }, 'APPROVAL_SECURITY_REVIEW_HEAD_MISMATCH'],
    ['security-wrong-head', (v) => { v.security_review.head_sha = BASE_SHA; }, 'APPROVAL_SECURITY_REVIEW_HEAD_MISMATCH'],
    ['security-wrong-decision', (v) => { v.security_review.decision_adr = 'ADR-043'; }, 'APPROVAL_SECURITY_REVIEW_HEAD_MISMATCH'],
    ['security-command-digest', (v) => { v.security_review.review_command_sha256 = DIGEST_A; }, 'APPROVAL_SECURITY_REVIEW_HEAD_MISMATCH'],
    ['security-wrong-actor', (v) => { v.security_review.actor_id = 999; }, 'APPROVAL_SECURITY_REVIEW_ACTOR_MISMATCH'],
    ['security-wrong-review-id', (v) => { v.security_review.review_id = v.product_review.review_id; }, 'APPROVAL_SECURITY_REVIEW_REUSED'],
    ['security-wrong-state', (v) => { v.security_review.review_state = 'CHANGES_REQUESTED'; }, 'APPROVAL_SECURITY_REVIEW_REQUIRED'],
    ['security-wrong-commit', (v) => { v.security_review.review_commit_id = BASE_SHA; }, 'APPROVAL_SECURITY_REVIEW_HEAD_MISMATCH'],
    ['security-wrong-timestamp', (v) => { v.security_review.submitted_at = '2026-08-31T01:00:00.000Z'; }, 'APPROVAL_SECURITY_AUTHORITY_STALE'],
    ['security-readback-outside-authority', (v) => { v.security_review.independently_read_at = '2026-08-31T01:00:00.000Z'; }, 'APPROVAL_SECURITY_AUTHORITY_STALE'],
    ['security-dismissed', (v) => { v.security_review.dismissed = true; }, 'APPROVAL_SECURITY_REVIEW_REQUIRED'],
    ['security-superseded', (v) => { v.security_review.superseded = true; }, 'APPROVAL_SECURITY_REVIEW_REQUIRED'],
    ['security-free-form-body', (v) => { v.security_review.review_body = 'secret candidate'; }, 'APPROVAL_SECURITY_REVIEW_REQUIRED'],
    ['security-product-actor-reuse', (v) => { v.security_review.actor_id = 101; v.security_review.actor_node_id = 'MDQ6VXNlcj101'; v.security_review.actor_login = 'product-owner'; }, 'APPROVAL_SECURITY_REVIEW_REUSED'],
    ['security-privacy-actor-reuse', (v) => { v.security_review.actor_id = 102; v.security_review.actor_node_id = 'MDQ6VXNlcj102'; v.security_review.actor_login = 'privacy-owner'; }, 'APPROVAL_SECURITY_REVIEW_REUSED'],
    ['security-codeowner-actor-reuse', (v) => { v.security_review.actor_id = 107; v.security_review.actor_node_id = 'MDQ6VXNlcj107'; v.security_review.actor_login = 'codeowner-reviewer'; }, 'APPROVAL_SECURITY_REVIEW_REUSED'],
    ['security-qa-actor-reuse', (v) => { v.security_review.actor_id = 103; v.security_review.actor_node_id = 'MDQ6VXNlcj103'; v.security_review.actor_login = 'qa-owner'; }, 'APPROVAL_SECURITY_REVIEW_REUSED'],
    ['security-machine-id-reuse', (v) => { v.security_review.review_id = v.machine_checks[0].check_run_id; }, 'APPROVAL_SECURITY_REVIEW_REUSED'],
  ];
  for (const [name, mutate, code] of candidateCases) runMutation(name, candidate, mutate, validate, code);
  const authorityCases = [
    ['security-unassigned', (a) => { a.roles[3] = { role: 'OWN-SECURITY', status: 'UNASSIGNED' }; }, 'APPROVAL_SECURITY_OWNER_UNASSIGNED'],
    ['security-authority-stale', (a) => { a.roles[3].effective_until = '2026-08-30T09:00:00.000Z'; }, 'APPROVAL_SECURITY_AUTHORITY_STALE'],
    ['security-authority-revoked', (a) => { a.roles[3].revocation_status = 'REVOKED'; }, 'APPROVAL_SECURITY_AUTHORITY_REVOKED'],
    ['security-authority-superseded', (a) => { a.roles[3].superseded_by = 'approval-authorities/r3'; }, 'APPROVAL_SECURITY_AUTHORITY_REVOKED'],
    ['security-authority-scope', (a) => { a.roles[3].scope.purpose = 'QA_EVIDENCE_REVIEW'; }, 'APPROVAL_SECURITY_AUTHORITY_STALE'],
  ];
  for (const [name, mutate, code] of authorityCases) {
    runMutation(name, candidate, () => {}, validateWithAuthorityMutation(mutate), code);
  }
});

test('merge grant, separate consumption, and durable ledger evidence fail closed', () => {
  const validate = (value) => validateMergeAuthorizationGrantForCandidate(value, candidate(), authority(), NOW);
  assert.deepEqual(validate(mergeEvidence()), { valid: true, issues: [] });
  const cases = [
    ['grant-missing-authority', (v) => { v.grant.authority_role = 'OWN-PRODUCT'; }, 'APPROVAL_MERGE_AUTHORIZER_UNASSIGNED'],
    ['grant-stage', (v) => { v.grant.stage = 'ACCEPTANCE_MERGE'; }, 'APPROVAL_MERGE_AUTHORIZATION_STAGE_MISMATCH'],
    ['grant-pr', (v) => { v.grant.pr_number = 1; }, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE'],
    ['grant-base', (v) => { v.grant.base_sha = MERGE_BASE_SHA; }, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE'],
    ['grant-head', (v) => { v.grant.head_sha = BASE_SHA; }, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE'],
    ['grant-decision-digest', (v) => { v.grant.decision_raw_sha256 = DIGEST_B; }, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH'],
    ['grant-merge-method', (v) => { v.grant.allowed_merge_method = 'REBASE'; }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH'],
    ['grant-authority-revision', (v) => { v.grant.authority_revision = 'approval-authorities/r9'; }, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE'],
    ['grant-expired', (v) => { v.grant.expires_at = '2026-08-30T11:59:59.999Z'; }, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE'],
    ['grant-revoked', (v) => { v.grant_revocations.push({ grant_id: v.grant.grant_id, grant_raw_sha256: v.grant_raw_sha256 }); }, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE'],
    ['grant-nonce-mismatch', (v) => { v.consumption.single_use_nonce = 'nonce-program-c-0002'; }, 'APPROVAL_MERGE_AUTHORIZATION_REPLAYED'],
    ['grant-ledger-key', (v) => { v.consumption.nonce_ledger_key = 'program-c-merge:nonce-program-c-0002'; }, 'APPROVAL_MERGE_AUTHORIZATION_REPLAYED'],
    ['grant-consumption-absent', (v) => { v.consumption = null; }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED'],
    ['grant-ledger-absent', (v) => { v.ledger_snapshot.reservations = []; }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED'],
    ['grant-consumption-digest', (v) => { v.consumption.grant_raw_sha256 = DIGEST_D; }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH'],
    ['grant-ledger-revision', (v) => { v.ledger_snapshot.reservations[0].reserved_revision = 18; }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH'],
    ['grant-authority-actor', (v) => { v.grant.authority_actor_id = 999; }, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE'],
  ];
  for (const [name, mutate, code] of cases) runMutation(name, mergeEvidence, mutate, validate, code);
});

test('receipt core and Task 2 artifact keep raw digest external and merge evidence referential', () => {
  const value = candidate();
  const core = buildApprovalReceiptCore(value, authority(), verifier(), null, NOW);
  const artifact = buildApprovalReceiptArtifact(core);
  assert.equal(Object.hasOwn(core, 'merge_authorization_evidence'), false);
  assert.equal(Object.hasOwn(artifact.envelope, 'receipt_raw_sha256'), false);
  assert.equal(Object.hasOwn(artifact.envelope.core, 'receipt_raw_sha256'), false);
  assert.match(artifact.receiptRawSha256, /^sha256:[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(core));
  assert.ok(Object.isFrozen(artifact));

  const mergeValue = mergeEvidence();
  const mergeCore = buildApprovalReceiptCore(value, authority(), verifier(), mergeValue, NOW);
  assert.deepEqual(mergeCore.merge_authorization_evidence, {
    stage: 'PROPOSAL_MERGE',
    grant_id: 'program-c-grant-0001',
    grant_raw_sha256: DIGEST_A,
    single_use_nonce: 'nonce-program-c-0001',
    consumption_id: 'program-c-consumption-0001',
    consumption_raw_sha256: DIGEST_B,
    reserved_ledger_revision: 17,
  });
  assert.equal(Object.hasOwn(mergeCore.merge_authorization_evidence, 'grant'), false);
  assert.equal(Object.hasOwn(mergeCore.merge_authorization_evidence, 'consumption'), false);
  assert.doesNotThrow(() => buildApprovalReceiptArtifact(mergeCore));

  const mutatedGrant = mergeEvidence();
  mutatedGrant.grant.status = 'CONSUMED';
  assert.throws(
    () => buildApprovalReceiptCore(value, authority(), verifier(), mutatedGrant, NOW),
    (error) => error.message === 'APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH',
  );
});

test('revocation and supersession validation returns append-only bound state facts', () => {
  const core = buildApprovalReceiptCore(candidate(), authority(), verifier(), null, NOW);
  const artifact = buildApprovalReceiptArtifact(core);
  const receipt = { envelope: artifact.envelope, receipt_raw_sha256: artifact.receiptRawSha256 };
  const revocation = {
    schema_version: 'trusted-approval-revocation/v1',
    receipt_id: core.receipt_id,
    receipt_core_sha256: artifact.receiptCoreSha256,
    receipt_raw_sha256: artifact.receiptRawSha256,
    authority_revision: 'approval-authorities/r2',
    authority_sha256: DIGEST_B,
    reason_code: 'POLICY_WITHDRAWN',
    revoking_role: 'OWN-PRODUCT',
    revoking_actor_id: 101,
    effective_at: NOW,
  };
  const revoked = validateReceiptRevocation(revocation, receipt, authority(), NOW);
  assert.equal(revoked.valid, true);
  assert.deepEqual(revoked.facts, {
    state: 'REVOKED',
    receipt_id: core.receipt_id,
    receipt_core_sha256: artifact.receiptCoreSha256,
    receipt_raw_sha256: artifact.receiptRawSha256,
    effective_at: NOW,
  });

  const successorCandidate = candidate();
  successorCandidate.receipt_subject.receipt_id = 'approval-receipt-0004';
  successorCandidate.receipt_subject.phase = 'POST_MERGE';
  const successorArtifact = buildApprovalReceiptArtifact(
    buildApprovalReceiptCore(successorCandidate, authority(), verifier(), null, NOW),
  );
  const successor = {
    envelope: successorArtifact.envelope,
    receipt_raw_sha256: successorArtifact.receiptRawSha256,
  };
  const supersession = {
    schema_version: 'trusted-approval-supersession/v1',
    predecessor: {
      receipt_id: core.receipt_id,
      receipt_core_sha256: artifact.receiptCoreSha256,
      receipt_raw_sha256: artifact.receiptRawSha256,
    },
    successor: {
      receipt_id: successor.envelope.core.receipt_id,
      receipt_core_sha256: successorArtifact.receiptCoreSha256,
      receipt_raw_sha256: successorArtifact.receiptRawSha256,
    },
    authority_revision: 'approval-authorities/r2',
    authority_sha256: DIGEST_B,
    effective_at: NOW,
    predecessor_chain: [core.receipt_id],
  };
  const superseded = validateReceiptSupersession(supersession, [receipt, successor], authority(), NOW);
  assert.equal(superseded.valid, true);
  assert.deepEqual(superseded.facts, {
    state: 'SUPERSEDED',
    predecessor_receipt_id: core.receipt_id,
    successor_receipt_id: successor.envelope.core.receipt_id,
    effective_at: NOW,
  });

  runMutation(
    'supersession-cycle',
    () => supersession,
    (v) => { v.predecessor_chain.push(v.successor.receipt_id); },
    (v) => validateReceiptSupersession(v, [receipt, successor], authority(), NOW),
    'APPROVAL_RECEIPT_REPLAYED',
  );
  runMutation(
    'revocation-receipt-digest',
    () => revocation,
    (v) => { v.receipt_raw_sha256 = DIGEST_A; },
    (v) => validateReceiptRevocation(v, receipt, authority(), NOW),
    'APPROVAL_RECEIPT_DIGEST_MISMATCH',
  );
});

test('mutation inventory is unique and every declared mutation ran exactly once', () => {
  assert.equal(mutationRuns.size, 77);
  assert.ok([...mutationRuns.values()].every((count) => count === 1));
});

test('errors never reflect raw candidate values or non-canonical code aliases', () => {
  const value = candidate();
  value.product_review.actor.login = 'sensitive-raw-candidate-value';
  value.product_review.actor.id = 999;
  const result = validateApprovalReadback(value, authority(), value.policy, NOW);
  expectIssue(result, 'APPROVAL_REVIEW_ACTOR_MISMATCH');
  assert.doesNotMatch(JSON.stringify(result), /sensitive-raw-candidate-value/);
  for (const alias of ['READBACK_REVIEW_REQUIRED', 'RULESET_DRIFT', 'HOLD_REVIEW_REQUIRED']) {
    assert.equal(result.issues.some(({ stable_code: code }) => code === alias), false);
  }
});

test('malformed normalized candidates fail closed instead of throwing', () => {
  for (const value of [{}, { repository: clone(REPOSITORY) }, null, []]) {
    assert.doesNotThrow(() => validateApprovalReadback(value, authority(), policy(), NOW));
    const result = validateApprovalReadback(value, authority(), policy(), NOW);
    assert.equal(result.valid, false);
    assert.ok(result.issues.every(({ stable_code: code }) => code.startsWith('APPROVAL_')));
  }
});
