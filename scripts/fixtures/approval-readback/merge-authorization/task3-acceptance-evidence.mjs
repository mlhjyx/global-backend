import { createHash } from 'node:crypto';

const REPOSITORY = Object.freeze({ id: 1291151138, full_name: 'mlhjyx/global-backend' });
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const RAW_DIGEST = `sha256:${'1'.repeat(64)}`;
const SEMANTIC_DIGEST = `sha256:${'2'.repeat(64)}`;
const AUTHORITY_DIGEST = `sha256:${'3'.repeat(64)}`;
const SIDECAR_DIGEST = `sha256:${'8'.repeat(64)}`;
const RULESET_DIGEST = `sha256:${'b'.repeat(64)}`;
const WORKFLOW_SHA = 'd'.repeat(40);
const BASE_BLOB_SHA = 'e'.repeat(40);
const clone = (value) => structuredClone(value);
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

const actor = (id, login) => ({ id, node_id: `node-${id}`, login, type: 'User' });
const command = (role) => {
  const line = `APPROVE DECISION ADR-027 REV program-c/policy-r1 ROLE ${role} DIGEST ${RAW_DIGEST}`;
  return {
    decision_adr: 'ADR-027',
    policy_revision: 'program-c/policy-r1',
    role,
    decision_raw_sha256: RAW_DIGEST,
    command_sha256: sha256(line),
  };
};
const review = (role, reviewId, actorId, login) => ({
  role,
  review_id: reviewId,
  review_state: 'APPROVED',
  review_commit_id: HEAD_SHA,
  submitted_at: '2026-08-30T08:00:00.000Z',
  independently_read_at: '2026-08-30T08:20:00.000Z',
  actor: actor(actorId, login),
  command: command(role),
  dismissed: false,
  superseded: false,
  later_changes_requested: false,
});
const authorityRole = (role, actorId, login, purpose) => ({
  role,
  status: 'ASSIGNED',
  actor_id: actorId,
  actor_node_id: `node-${actorId}`,
  actor_login: login,
  effective_from: '2026-08-30T07:00:00.000Z',
  effective_until: '2026-08-30T10:00:00.000Z',
  scope: {
    repository_id: REPOSITORY.id,
    decision_adr: 'ADR-027',
    policy_revision: 'program-c/policy-r1',
    purpose,
  },
  assignment_evidence: {
    evidence_kind: 'BASE_REGISTRY_ASSIGNMENT',
    assignment_pr_number: actorId,
    assignment_head_sha: BASE_SHA,
    observed_at: '2026-08-30T07:00:00.000Z',
    evidence_sha256: RAW_DIGEST,
  },
  revocation_status: 'ACTIVE',
  superseded_by: null,
});
const machineCheck = () => ({
  github_app_id: 42700,
  github_app_slug: 'approval-readback-app',
  check_run_id: 7001,
  check_suite_id: 7002,
  context: 'approval-readback',
  workflow_id: 42701,
  workflow_path: '.github/workflows/approval-readback.yml',
  trusted_base_workflow_blob_sha: BASE_BLOB_SHA,
  actions_run_id: 7003,
  actions_run_attempt: 1,
  actions_run_event: 'pull_request_target',
  actions_run_head_sha: HEAD_SHA,
  actions_run_conclusion: 'success',
  reusable_signer: {
    workflow_id: 42702,
    workflow_path: '.github/workflows/approval-signer.yml',
    workflow_sha: WORKFLOW_SHA,
  },
});
const verifier = () => ({
  trust_class: 'INDEPENDENT_EXTERNAL_VERIFIED',
  independently_governed: true,
  repository_id: 4270001,
  repository_full_name: 'mlhjyx/global-governance-verifier',
  workflow_id: 42703,
  workflow_path: '.github/workflows/verify-approval.yml',
  workflow_sha: WORKFLOW_SHA,
  run_id: 42704,
  attempt: 1,
  event: 'workflow_call',
  runner_environment: 'github-hosted',
  api_version: '2022-11-28',
  identity: 'github-app:427',
  read_at: '2026-08-30T08:25:00.000Z',
});
const snapshot = () => ({
  head_sha: HEAD_SHA,
  base_sha: BASE_SHA,
  authority_sha256: AUTHORITY_DIGEST,
  ruleset_sha256: RULESET_DIGEST,
  decision_raw_sha256: RAW_DIGEST,
  decision_semantic_sha256: SEMANTIC_DIGEST,
});

export const buildTask3AcceptanceEvidence = () => {
  const policy = {
    schema_version: 'approval-readback-policy/v1',
    repository: clone(REPOSITORY),
    actor_policy: 'DISTINCT_ACTORS_REQUIRED',
    dual_role_exception: null,
    required_machine_checks: [{
      github_app_id: 42700,
      github_app_slug: 'approval-readback-app',
      context: 'approval-readback',
      workflow_id: 42701,
      workflow_path: '.github/workflows/approval-readback.yml',
      trusted_base_workflow_blob_sha: BASE_BLOB_SHA,
      reusable_signer: {
        workflow_id: 42702,
        workflow_path: '.github/workflows/approval-signer.yml',
        workflow_sha: WORKFLOW_SHA,
      },
    }],
    pr_readable_paths: [
      'docs/governance/decisions/adr-027-r1.md',
      'docs/governance/decisions/adr-027-r1.manifest.json',
    ],
    live_ruleset_sha256: RULESET_DIGEST,
    receipt_validity_ms: 3_600_000,
    maximum_receipt_validity_ms: 86_400_000,
    minimum_distinct_human_actors: 3,
    independent_verifier: {
      repository_id: 4270001,
      repository_full_name: 'mlhjyx/global-governance-verifier',
      workflow_id: 42703,
      workflow_path: '.github/workflows/verify-approval.yml',
      workflow_sha: WORKFLOW_SHA,
    },
  };
  const authority = {
    schema_version: 'approval-authority-readback/v1',
    repository: clone(REPOSITORY),
    revision: 'approval-authorities/r1',
    sha256: AUTHORITY_DIGEST,
    roles: [
      authorityRole('OWN-PRODUCT', 8101, 'product-owner', 'DECISION_REVIEW'),
      authorityRole('OWN-DATA-PRIVACY', 8102, 'privacy-owner', 'DECISION_REVIEW'),
      authorityRole('OWN-QA-EVIDENCE', 8103, 'qa-owner', 'QA_EVIDENCE_REVIEW'),
      authorityRole('OWN-SECURITY', 8104, 'security-owner', 'SECURITY_REVIEW'),
      authorityRole('LEGAL-REVIEW', 8105, 'legal-owner', 'LEGAL_REVIEW'),
      authorityRole('MERGE-AUTHORIZER', 8106, 'merge-authorizer', 'MERGE_AUTHORIZATION'),
    ],
  };
  const candidate = {
    schema_version: 'trusted-approval-candidate/v1',
    repository: clone(REPOSITORY),
    decision: {
      adr: 'ADR-027',
      revision: 'program-c/decision-r1',
      policy_revision: 'program-c/policy-r1',
      raw_sha256: RAW_DIGEST,
      semantic_sha256: SEMANTIC_DIGEST,
      proposed_sidecar_path: 'docs/governance/decisions/adr-027-r1.md',
      proposed_sidecar_raw_sha256: SIDECAR_DIGEST,
    },
    pull_request: {
      number: 427,
      base_sha: BASE_SHA,
      head_sha: HEAD_SHA,
      merge_base_sha: 'f'.repeat(40),
      state: 'OPEN',
      draft: false,
      author: actor(8999, 'proposal-author'),
    },
    authority_revision: 'approval-authorities/r1',
    authority_sha256: AUTHORITY_DIGEST,
    product_review: review('OWN-PRODUCT', 9001, 8101, 'product-owner'),
    privacy_review: review('OWN-DATA-PRIVACY', 9002, 8102, 'privacy-owner'),
    qa_review: review('OWN-QA-EVIDENCE', 9003, 8103, 'qa-owner'),
    codeowner_review: {
      evidence_kind: 'CODEOWNER_REPOSITORY_REVIEW',
      review_id: 9005,
      review_state: 'APPROVED',
      review_commit_id: HEAD_SHA,
      submitted_at: '2026-08-30T08:00:00.000Z',
      independently_read_at: '2026-08-30T08:20:00.000Z',
      actor: actor(8107, 'codeowner-reviewer'),
      dismissed: false,
      superseded: false,
      later_changes_requested: false,
    },
    security_review: {
      schema_version: 'program-c-security-review-evidence/v1',
      evidence_id: 'security-evidence-task4-0001',
      repository_id: REPOSITORY.id,
      repository_full_name: REPOSITORY.full_name,
      decision_adr: 'ADR-027',
      decision_revision: 'program-c/decision-r1',
      policy_revision: 'program-c/policy-r1',
      proposal_pr_number: 427,
      base_sha: BASE_SHA,
      head_sha: HEAD_SHA,
      decision_raw_sha256: RAW_DIGEST,
      decision_semantic_sha256: SEMANTIC_DIGEST,
      proposed_sidecar_path: 'docs/governance/decisions/adr-027-r1.md',
      proposed_sidecar_raw_sha256: SIDECAR_DIGEST,
      role: 'OWN-SECURITY',
      authority_revision: 'approval-authorities/r1',
      authority_sha256: AUTHORITY_DIGEST,
      actor_id: 8104,
      actor_node_id: 'node-8104',
      actor_login: 'security-owner',
      review_id: 9004,
      review_state: 'APPROVED',
      review_commit_id: HEAD_SHA,
      review_command_sha256: command('OWN-SECURITY').command_sha256,
      submitted_at: '2026-08-30T08:00:00.000Z',
      independently_read_at: '2026-08-30T08:20:00.000Z',
      scope: 'SECURITY_REVIEW',
      revocation_status: 'ACTIVE',
      supersedes_evidence_id: null,
      dismissed: false,
      superseded: false,
      later_changes_requested: false,
    },
    legal_input: {
      input_id: 'legal-input-task4-0001',
      status: 'NO_BLOCKER_RECORDED',
      actor_id: 8105,
      actor_node_id: 'node-8105',
      actor_login: 'legal-owner',
      authority_revision: 'approval-authorities/r1',
      authority_sha256: AUTHORITY_DIGEST,
      reviewed_head_sha: HEAD_SHA,
      decision_raw_sha256: RAW_DIGEST,
      decision_semantic_sha256: SEMANTIC_DIGEST,
      effective_at: '2026-08-30T07:30:00.000Z',
      valid_until: '2026-08-30T10:00:00.000Z',
      revocation_status: 'ACTIVE',
    },
    review_pagination_complete: true,
    machine_checks: [machineCheck()],
    ruleset: { normalized_sha256: RULESET_DIGEST, bypass_actors: [] },
    pre_read: snapshot(),
    post_read: snapshot(),
    verifier: verifier(),
    receipt_subject: {
      receipt_id: 'approval-receipt-task4-0001',
      phase: 'ACCEPTANCE_REVALIDATION',
      role: 'OWN-PRODUCT',
      prior_receipt_ids: [],
      revoked_receipt_ids: [],
      superseded_receipt_ids: [],
    },
    policy,
  };
  return { candidate, authority, policy };
};
