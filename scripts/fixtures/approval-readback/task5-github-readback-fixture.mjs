import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  collectGitHubApprovalEvidence,
  createGitHubReadbackClient,
} from '../../governance-github-readback.mjs';

export const REPOSITORY_ID = 1291151138;
export const REPOSITORY_FULL_NAME = 'mlhjyx/global-backend';
export const BASE_SHA = '1'.repeat(40);
export const HEAD_SHA = '2'.repeat(40);
export const MERGE_BASE_SHA = '3'.repeat(40);
export const AUTHORITY_BLOB_SHA = '4'.repeat(40);
export const PROPOSAL_MANIFEST_BLOB_SHA = '5'.repeat(40);
export const PROPOSAL_SIDECAR_BLOB_SHA = '6'.repeat(40);
export const WORKFLOW_BLOB_SHA = '7'.repeat(40);
export const SIGNER_BLOB_SHA = '8'.repeat(40);
export const OTHER_SHA = '9'.repeat(40);
export const AUTHORITY_PATH = 'docs/governance/approval-authorities.json';
export const PROPOSAL_MANIFEST_PATH = 'docs/governance/decisions/adr-027-r2.manifest.json';
export const PROPOSAL_SIDECAR_PATH = 'docs/governance/decisions/adr-027-r2.sidecar.json';
export const WORKFLOW_PATH = '.github/workflows/approval-readback.yml';
export const SIGNER_PATH = '.github/workflows/approval-signer.yml';
export const OBSERVED_AT = '2026-08-30T12:00:00.000Z';
export const DECISION_RAW_SHA256 = `sha256:${'a'.repeat(64)}`;
export const DECISION_SEMANTIC_SHA256 = `sha256:${'b'.repeat(64)}`;
export const AUTH_SENTINEL = 'fixture-auth-must-never-escape';
export const API_ORIGIN = 'https://api.github.com';
export const API_VERSION = '2026-03-10';
export const ROLES = Object.freeze([
  'OWN-PRODUCT',
  'OWN-DATA-PRIVACY',
  'OWN-QA-EVIDENCE',
  'OWN-SECURITY',
]);
const AUTHORITY_ROLES = Object.freeze([
  ...ROLES,
  'LEGAL-REVIEW',
  'MERGE-AUTHORIZER',
]);
const PURPOSE_BY_ROLE = Object.freeze({
  'OWN-PRODUCT': 'DECISION_REVIEW',
  'OWN-DATA-PRIVACY': 'DECISION_REVIEW',
  'OWN-QA-EVIDENCE': 'QA_EVIDENCE_REVIEW',
  'OWN-SECURITY': 'SECURITY_REVIEW',
  'LEGAL-REVIEW': 'LEGAL_REVIEW',
  'MERGE-AUTHORIZER': 'MERGE_AUTHORIZATION',
});

export const commandLine = (role) => (
  `APPROVE DECISION ADR-027 REV program-c/policy-r2 ROLE ${role} DIGEST sha256:${'a'.repeat(64)}`
);
export const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const actor = (id, login) => ({ id, node_id: `U_${id}`, login, type: 'User' });
export const review = (role, id, actorValue) => ({
  id,
  node_id: `PRR_${id}`,
  user: structuredClone(actorValue),
  body: commandLine(role),
  state: 'APPROVED',
  commit_id: HEAD_SHA,
  submitted_at: `2026-08-30T10:0${id - 2001}:00.000Z`,
  html_url: `https://github.example/reviews/${id}?private=free-form`,
});
export const encodeBlob = (value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return { content: bytes.toString('base64'), encoding: 'base64', size: bytes.length };
};

export const jsonResponse = (value, init = {}) => new Response(
  JSON.stringify(value),
  {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  },
);

export const fixtureState = () => {
  const actors = {
    'OWN-PRODUCT': actor(101, 'product-owner'),
    'OWN-DATA-PRIVACY': actor(102, 'privacy-owner'),
    'OWN-QA-EVIDENCE': actor(103, 'qa-owner'),
    'OWN-SECURITY': actor(104, 'security-owner'),
    'LEGAL-REVIEW': actor(105, 'legal-owner'),
    'MERGE-AUTHORIZER': actor(106, 'merge-authorizer'),
  };
  const authorityValue = {
    schema_version: 'approval-authorities/v1',
    repository: { id: REPOSITORY_ID, full_name: REPOSITORY_FULL_NAME },
    revision: 'approval-authorities/r2',
    actor_policy: 'DISTINCT_ACTORS_REQUIRED',
    roles: AUTHORITY_ROLES.map((role) => ({
      role,
      status: 'ASSIGNED',
      actor_id: actors[role].id,
      actor_node_id: actors[role].node_id,
      actor_login: actors[role].login,
      effective_from: '2026-08-30T08:00:00.000Z',
      effective_until: '2026-08-30T13:00:00.000Z',
      scope: {
        repository_id: REPOSITORY_ID,
        decision_adr: 'ADR-027',
        policy_revision: 'program-c/policy-r2',
        purpose: PURPOSE_BY_ROLE[role],
      },
      assignment_evidence: {
        evidence_kind: 'BASE_REGISTRY_ASSIGNMENT',
        assignment_pr_number: actors[role].id,
        assignment_head_sha: BASE_SHA,
        observed_at: '2026-08-30T08:00:00.000Z',
        evidence_sha256: DECISION_RAW_SHA256,
      },
      revocation_status: 'ACTIVE',
      superseded_by: null,
    })),
  };
  const manifestValue = {
    schema_version: 'approval-proposal-manifest/v1',
    decision_id: 'ADR-027',
    policy_revision: 'program-c/policy-r2',
    decision_raw_sha256: DECISION_RAW_SHA256,
    decision_semantic_sha256: DECISION_SEMANTIC_SHA256,
    sidecar_path: PROPOSAL_SIDECAR_PATH,
  };
  const sidecarValue = {
    schema_version: 'approval-proposal-sidecar/v1',
    decision_id: 'ADR-027',
    policy_revision: 'program-c/policy-r2',
    decision_raw_sha256: DECISION_RAW_SHA256,
    decision_semantic_sha256: DECISION_SEMANTIC_SHA256,
  };
  const authorityBytes = Buffer.from(`${JSON.stringify(authorityValue)}\n`, 'utf8');
  const manifestBytes = Buffer.from(`${JSON.stringify(manifestValue)}\n`, 'utf8');
  const sidecarBytes = Buffer.from(`${JSON.stringify(sidecarValue)}\n`, 'utf8');
  const workflowBytes = Buffer.from('name: approval readback\n', 'utf8');
  const signerBytes = Buffer.from('name: approval signer\n', 'utf8');
  const headTree = {
    sha: '7'.repeat(40),
    truncated: false,
    tree: [
      { path: PROPOSAL_MANIFEST_PATH, mode: '100644', type: 'blob', sha: PROPOSAL_MANIFEST_BLOB_SHA, size: manifestBytes.length },
      { path: PROPOSAL_SIDECAR_PATH, mode: '100644', type: 'blob', sha: PROPOSAL_SIDECAR_BLOB_SHA, size: sidecarBytes.length },
    ],
  };
  const baseTree = {
    sha: '8'.repeat(40),
    truncated: false,
    tree: [
      { path: AUTHORITY_PATH, mode: '100644', type: 'blob', sha: AUTHORITY_BLOB_SHA, size: authorityBytes.length },
      { path: WORKFLOW_PATH, mode: '100644', type: 'blob', sha: WORKFLOW_BLOB_SHA, size: workflowBytes.length },
      { path: SIGNER_PATH, mode: '100644', type: 'blob', sha: SIGNER_BLOB_SHA, size: signerBytes.length },
    ],
  };
  return {
    actors,
    repository: {
      id: REPOSITORY_ID,
      node_id: 'R_global_backend',
      full_name: REPOSITORY_FULL_NAME,
      default_branch: 'main',
      private: true,
      description: 'must not be retained',
    },
    pullRequest: {
      number: 427,
      node_id: 'PR_427',
      state: 'open',
      draft: false,
      user: actor(900, 'proposal-author'),
      base: { sha: BASE_SHA, repo: { id: REPOSITORY_ID } },
      head: { sha: HEAD_SHA },
      body: 'untrusted PR free text must not be retained',
    },
    postPullRequest: null,
    reviewPages: [
      [review('OWN-PRODUCT', 2001, actors['OWN-PRODUCT']), review('OWN-DATA-PRIVACY', 2002, actors['OWN-DATA-PRIVACY'])],
      [
        review('OWN-QA-EVIDENCE', 2003, actors['OWN-QA-EVIDENCE']),
        review('OWN-SECURITY', 2004, actors['OWN-SECURITY']),
        { ...review('OWN-PRODUCT', 2005, actor(105, 'codeowner-reviewer')), body: 'CODEOWNER REVIEW' },
      ],
    ],
    checkPages: [[{
      id: 81001,
      node_id: 'CR_81001',
      name: 'approval/readback',
      head_sha: BASE_SHA,
      status: 'completed',
      conclusion: 'success',
      details_url: 'https://example.invalid/details-only-claim',
      external_id: 'free-form-external-id',
      app: { id: 15368, slug: 'github-actions', name: 'GitHub Actions' },
      check_suite: { id: 71001 },
    }]],
    checkSuites: new Map([[71001, {
      id: 71001,
      node_id: 'CS_71001',
      head_sha: BASE_SHA,
      status: 'completed',
      conclusion: 'success',
      app: { id: 15368, slug: 'github-actions' },
      pull_requests: [{ number: 427, head: { sha: HEAD_SHA } }],
    }]]),
    actionRunPages: [[{
      id: 51001,
      run_attempt: 1,
      event: 'pull_request_target',
      status: 'completed',
      conclusion: 'success',
      head_sha: BASE_SHA,
      workflow_id: 61001,
      path: WORKFLOW_PATH,
      check_suite_id: 71001,
      pull_requests: [{
        number: 427,
        head: { sha: HEAD_SHA },
        base: { sha: BASE_SHA },
      }],
      referenced_workflows: [{ workflow_id: 61002, path: SIGNER_PATH, sha: SIGNER_BLOB_SHA }],
      display_title: 'untrusted free-form title',
    }]],
    workflows: new Map([
      [61001, { id: 61001, node_id: 'W_61001', path: WORKFLOW_PATH, state: 'active', name: 'free text' }],
      [61002, { id: 61002, node_id: 'W_61002', path: SIGNER_PATH, state: 'active', name: 'free text' }],
    ]),
    ruleset: {
      id: 777,
      source_type: 'Repository',
      source: REPOSITORY_FULL_NAME,
      enforcement: 'active',
      bypass_actors: [],
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: true,
            do_not_enforce_on_create: false,
            required_status_checks: [{ context: 'approval/readback', integration_id: 15368 }],
          },
        },
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 0,
            dismiss_stale_reviews_on_push: true,
            required_reviewers: [],
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: true,
            require_extra_approval_for_unattributed_changes: true,
            allowed_merge_methods: ['squash', 'merge', 'rebase'],
          },
        },
        { type: 'deletion' },
        { type: 'non_fast_forward' },
      ],
      name: 'free-form ruleset name',
    },
    associatedPulls: [{ number: 427, head: { sha: HEAD_SHA }, base: { sha: BASE_SHA } }],
    compare: { merge_base_commit: { sha: MERGE_BASE_SHA } },
    headTree,
    postHeadTree: null,
    baseTree,
    postBaseTree: null,
    postRuleset: null,
    blobs: new Map([
      [AUTHORITY_BLOB_SHA, { sha: AUTHORITY_BLOB_SHA, ...encodeBlob(authorityBytes) }],
      [PROPOSAL_MANIFEST_BLOB_SHA, { sha: PROPOSAL_MANIFEST_BLOB_SHA, ...encodeBlob(manifestBytes) }],
      [PROPOSAL_SIDECAR_BLOB_SHA, { sha: PROPOSAL_SIDECAR_BLOB_SHA, ...encodeBlob(sidecarBytes) }],
      [WORKFLOW_BLOB_SHA, { sha: WORKFLOW_BLOB_SHA, ...encodeBlob(workflowBytes) }],
      [SIGNER_BLOB_SHA, { sha: SIGNER_BLOB_SHA, ...encodeBlob(signerBytes) }],
    ]),
    forced: null,
    malformedLink: null,
    crossOriginLink: null,
    loopLink: false,
    rejectWith: null,
  };
};

export const request = () => ({
  repository: { id: REPOSITORY_ID, full_name: REPOSITORY_FULL_NAME },
  prNumber: 427,
  expectedBaseSha: BASE_SHA,
  expectedHeadSha: HEAD_SHA,
  rulesetId: 777,
  authorityPath: AUTHORITY_PATH,
  proposalManifestPath: PROPOSAL_MANIFEST_PATH,
  proposalSidecarPath: PROPOSAL_SIDECAR_PATH,
  codeownerReviewId: 2005,
  decisionId: 'ADR-027',
  policyRevision: 'program-c/policy-r2',
  expectedDecisionRawSha256: DECISION_RAW_SHA256,
  expectedDecisionSemanticSha256: DECISION_SEMANTIC_SHA256,
  observedAt: OBSERVED_AT,
});
export const policy = () => ({
  repositoryId: REPOSITORY_ID,
  allowedRepoPaths: [AUTHORITY_PATH, PROPOSAL_MANIFEST_PATH, PROPOSAL_SIDECAR_PATH],
  allowedCheckContexts: ['approval/readback'],
  allowedActionsAppIds: [15368],
  allowedWorkflowIds: [61001],
  allowedWorkflowPaths: [WORKFLOW_PATH],
  allowedReusableSignerWorkflowIds: [61002],
  allowedReusableSignerWorkflowPaths: [SIGNER_PATH],
  requiredRuleset: {
    doNotEnforceOnCreate: false,
    pullRequest: {
      requiredApprovingReviewCount: 0,
      dismissStaleReviewsOnPush: true,
      requiredReviewers: [],
      requireCodeOwnerReview: false,
      requireLastPushApproval: false,
      requiredReviewThreadResolution: true,
      requireExtraApprovalForUnattributedChanges: true,
      allowedMergeMethods: ['merge', 'rebase', 'squash'],
    },
    deletionProtection: true,
    nonFastForwardProtection: true,
  },
});
export const limits = (overrides = {}) => ({
  timeoutMs: 1_000,
  maxPages: 100,
  maxItems: 10_000,
  maxResponseBytes: 2_097_152,
  maxBlobBytes: 1_048_576,
  ...overrides,
});

const pageNumber = (url) => Number(url.searchParams.get('page') ?? '1');
const nextLink = (url, pages, state) => {
  const page = pageNumber(url);
  if (state.crossOriginLink && page === 1) return `<${state.crossOriginLink}>; rel="next"`;
  if (state.malformedLink && page === 1) return state.malformedLink;
  if (state.loopLink && page === 1) return `<${url.href}>; rel="next"`;
  if (page >= pages.length) return null;
  const next = new URL(url);
  next.searchParams.set('page', String(page + 1));
  return `<${next.href}>; rel="next", <${next.href}>; rel="last"`;
};

export const fixtureFetch = (state) => {
  const calls = [];
  let prReads = 0;
  let headTreeReads = 0;
  let baseTreeReads = 0;
  let rulesetReads = 0;
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url: url.href, init });
    if (state.rejectWith) throw state.rejectWith;
    if (state.forced?.predicate(url, init)) return state.forced.response(url, init);
    const prefix = '/repos/mlhjyx/global-backend';
    if (url.pathname === `/repositories/${REPOSITORY_ID}`) return jsonResponse(state.repository);
    if (url.pathname === `${prefix}/pulls/427`) {
      prReads += 1;
      return jsonResponse(prReads > 1 && state.postPullRequest ? state.postPullRequest : state.pullRequest);
    }
    if (url.pathname === `${prefix}/pulls/427/reviews`) {
      const link = nextLink(url, state.reviewPages, state);
      return jsonResponse(state.reviewPages[pageNumber(url) - 1] ?? [], { headers: link ? { link } : {} });
    }
    if (url.pathname === `${prefix}/commits/${HEAD_SHA}/pulls`) return jsonResponse(state.associatedPulls);
    if (url.pathname === `${prefix}/compare/${BASE_SHA}...${HEAD_SHA}`) return jsonResponse(state.compare);
    if (url.pathname === `${prefix}/commits/${HEAD_SHA}/check-runs`) {
      const link = nextLink(url, state.checkPages, state);
      return jsonResponse(
        { total_count: state.checkPages.flat().length, check_runs: state.checkPages[pageNumber(url) - 1] ?? [] },
        { headers: link ? { link } : {} },
      );
    }
    if (url.pathname.startsWith(`${prefix}/check-suites/`)) {
      if (url.pathname.endsWith('/check-runs')) {
        const link = nextLink(url, state.checkPages, state);
        return jsonResponse(
          {
            total_count: state.checkPages.flat().length,
            check_runs: state.checkPages[pageNumber(url) - 1] ?? [],
          },
          { headers: link ? { link } : {} },
        );
      }
      return jsonResponse(state.checkSuites.get(Number(url.pathname.split('/').at(-1))));
    }
    if (url.pathname === `${prefix}/actions/runs`) {
      const link = nextLink(url, state.actionRunPages, state);
      return jsonResponse(
        { total_count: state.actionRunPages.flat().length, workflow_runs: state.actionRunPages[pageNumber(url) - 1] ?? [] },
        { headers: link ? { link } : {} },
      );
    }
    if (url.pathname.startsWith(`${prefix}/actions/workflows/`)) {
      return jsonResponse(state.workflows.get(Number(url.pathname.split('/').at(-1))));
    }
    if (url.pathname === `${prefix}/rulesets/777`) {
      rulesetReads += 1;
      return jsonResponse(rulesetReads > 1 && state.postRuleset ? state.postRuleset : state.ruleset);
    }
    if (url.pathname === `${prefix}/git/trees/${HEAD_SHA}`) {
      headTreeReads += 1;
      return jsonResponse(headTreeReads > 1 && state.postHeadTree ? state.postHeadTree : state.headTree);
    }
    if (url.pathname === `${prefix}/git/trees/${BASE_SHA}`) {
      baseTreeReads += 1;
      return jsonResponse(baseTreeReads > 1 && state.postBaseTree ? state.postBaseTree : state.baseTree);
    }
    if (url.pathname.startsWith(`${prefix}/git/blobs/`)) {
      return jsonResponse(state.blobs.get(url.pathname.split('/').at(-1)));
    }
    return jsonResponse({ message: `unhandled fixture path ${url.pathname}` }, { status: 404 });
  };
  return { fetch, calls };
};

export const collect = async (state, options = {}) => {
  const fixture = fixtureFetch(state);
  const client = createGitHubReadbackClient({
    fetch: fixture.fetch,
    token: AUTH_SENTINEL,
    apiVersion: API_VERSION,
  });
  const evidence = await collectGitHubApprovalEvidence(
    client,
    options.request ?? request(),
    options.limits ?? limits(),
    options.policy ?? policy(),
  );
  return { evidence, ...fixture, client };
};

export const expectCode = async (operation, code) => {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.message, code);
    assert.match(error?.message ?? '', /^APPROVAL_[A-Z0-9_]+$/);
    assert.doesNotMatch(error?.message ?? '', /github-token|free-form|private|untrusted/i);
    return true;
  });
};
