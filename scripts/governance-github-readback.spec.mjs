import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  collectGitHubApprovalEvidence,
  createGitHubReadbackClient,
} from './governance-github-readback.mjs';

const REPOSITORY_ID = 1291151138;
const REPOSITORY_FULL_NAME = 'mlhjyx/global-backend';
const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const MERGE_BASE_SHA = '3'.repeat(40);
const AUTHORITY_BLOB_SHA = '4'.repeat(40);
const PROPOSAL_MANIFEST_BLOB_SHA = '5'.repeat(40);
const PROPOSAL_SIDECAR_BLOB_SHA = '6'.repeat(40);
const WORKFLOW_BLOB_SHA = '7'.repeat(40);
const SIGNER_BLOB_SHA = '8'.repeat(40);
const OTHER_SHA = '9'.repeat(40);
const AUTHORITY_PATH = 'docs/governance/approval-authorities.json';
const PROPOSAL_MANIFEST_PATH = 'docs/governance/decisions/adr-027-r2.manifest.json';
const PROPOSAL_SIDECAR_PATH = 'docs/governance/decisions/adr-027-r2.sidecar.json';
const WORKFLOW_PATH = '.github/workflows/approval-readback.yml';
const SIGNER_PATH = '.github/workflows/approval-signer.yml';
const OBSERVED_AT = '2026-08-30T12:00:00.000Z';
const DECISION_RAW_SHA256 = `sha256:${'a'.repeat(64)}`;
const DECISION_SEMANTIC_SHA256 = `sha256:${'b'.repeat(64)}`;
const AUTH_SENTINEL = 'fixture-auth-must-never-escape';
const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const ROLES = Object.freeze([
  'OWN-PRODUCT',
  'OWN-DATA-PRIVACY',
  'OWN-QA-EVIDENCE',
  'OWN-SECURITY',
]);

const commandLine = (role) => (
  `APPROVE DECISION ADR-027 REV program-c/policy-r2 ROLE ${role} DIGEST sha256:${'a'.repeat(64)}`
);

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const actor = (id, login) => ({
  id,
  node_id: `U_${id}`,
  login,
  type: 'User',
});

const review = (role, id, actorValue) => ({
  id,
  node_id: `PRR_${id}`,
  user: structuredClone(actorValue),
  body: commandLine(role),
  state: 'APPROVED',
  commit_id: HEAD_SHA,
  submitted_at: `2026-08-30T10:0${id - 2001}:00.000Z`,
  html_url: `https://github.example/reviews/${id}?private=free-form`,
});

const encodeBlob = (value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return {
    content: bytes.toString('base64'),
    encoding: 'base64',
    size: bytes.length,
  };
};

const jsonResponse = (value, init = {}) => new Response(
  JSON.stringify(value),
  {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  },
);

const fixtureState = () => {
  const actors = {
    'OWN-PRODUCT': actor(101, 'product-owner'),
    'OWN-DATA-PRIVACY': actor(102, 'privacy-owner'),
    'OWN-QA-EVIDENCE': actor(103, 'qa-owner'),
    'OWN-SECURITY': actor(104, 'security-owner'),
  };
  const authorityValue = {
    schema_version: 'approval-authorities/v1',
    repository: { id: REPOSITORY_ID, full_name: REPOSITORY_FULL_NAME },
    revision: 'approval-authorities/r2',
    roles: ROLES.map((role) => ({
      role,
      status: 'ASSIGNED',
      actor_id: actors[role].id,
      actor_node_id: actors[role].node_id,
      actor_login: actors[role].login,
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
      {
        path: PROPOSAL_MANIFEST_PATH,
        mode: '100644',
        type: 'blob',
        sha: PROPOSAL_MANIFEST_BLOB_SHA,
        size: manifestBytes.length,
      },
      {
        path: PROPOSAL_SIDECAR_PATH,
        mode: '100644',
        type: 'blob',
        sha: PROPOSAL_SIDECAR_BLOB_SHA,
        size: sidecarBytes.length,
      },
    ],
  };
  const baseTree = {
    sha: '8'.repeat(40),
    truncated: false,
    tree: [
      {
        path: AUTHORITY_PATH,
        mode: '100644',
        type: 'blob',
        sha: AUTHORITY_BLOB_SHA,
        size: authorityBytes.length,
      },
      {
        path: WORKFLOW_PATH,
        mode: '100644',
        type: 'blob',
        sha: WORKFLOW_BLOB_SHA,
        size: workflowBytes.length,
      },
      {
        path: SIGNER_PATH,
        mode: '100644',
        type: 'blob',
        sha: SIGNER_BLOB_SHA,
        size: signerBytes.length,
      },
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
        {
          ...review('OWN-PRODUCT', 2005, actor(105, 'codeowner-reviewer')),
          body: 'CODEOWNER REVIEW',
        },
      ],
    ],
    checkPages: [[{
      id: 81001,
      node_id: 'CR_81001',
      name: 'approval/readback',
      head_sha: HEAD_SHA,
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
      head_sha: HEAD_SHA,
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
      head_sha: HEAD_SHA,
      workflow_id: 61001,
      path: WORKFLOW_PATH,
      check_suite_id: 71001,
      referenced_workflows: [{
        workflow_id: 61002,
        path: SIGNER_PATH,
        sha: SIGNER_BLOB_SHA,
      }],
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
      rules: [{
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: 'approval/readback', integration_id: 15368 }],
        },
      }],
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

const request = (_state) => ({
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

const policy = () => ({
  repositoryId: REPOSITORY_ID,
  allowedRepoPaths: [AUTHORITY_PATH, PROPOSAL_MANIFEST_PATH, PROPOSAL_SIDECAR_PATH],
  allowedCheckContexts: ['approval/readback'],
  allowedActionsAppIds: [15368],
  allowedWorkflowIds: [61001],
  allowedWorkflowPaths: [WORKFLOW_PATH],
  allowedReusableSignerWorkflowIds: [61002],
  allowedReusableSignerWorkflowPaths: [SIGNER_PATH],
});

const limits = (overrides = {}) => ({
  timeoutMs: 1_000,
  maxPages: 100,
  maxItems: 10_000,
  maxResponseBytes: 1_048_576,
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

const fixtureFetch = (state) => {
  const calls = [];
  let prReads = 0;
  let headTreeReads = 0;
  let baseTreeReads = 0;
  let rulesetReads = 0;
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url: url.href, init });
    if (state.rejectWith) throw state.rejectWith;
    if (state.forced?.predicate(url, init)) {
      return state.forced.response(url, init);
    }
    const prefix = '/repos/mlhjyx/global-backend';
    if (url.pathname === `/repositories/${REPOSITORY_ID}`) return jsonResponse(state.repository);
    if (url.pathname === `${prefix}/pulls/427`) {
      prReads += 1;
      return jsonResponse(prReads > 1 && state.postPullRequest ? state.postPullRequest : state.pullRequest);
    }
    if (url.pathname === `${prefix}/pulls/427/reviews`) {
      const pages = state.reviewPages;
      const link = nextLink(url, pages, state);
      return jsonResponse(pages[pageNumber(url) - 1] ?? [], { headers: link ? { link } : {} });
    }
    if (url.pathname === `${prefix}/commits/${HEAD_SHA}/pulls`) return jsonResponse(state.associatedPulls);
    if (url.pathname === `${prefix}/compare/${BASE_SHA}...${HEAD_SHA}`) return jsonResponse(state.compare);
    if (url.pathname === `${prefix}/commits/${HEAD_SHA}/check-runs`) {
      const pages = state.checkPages;
      const link = nextLink(url, pages, state);
      const checkRuns = pages[pageNumber(url) - 1] ?? [];
      return jsonResponse({ total_count: pages.flat().length, check_runs: checkRuns }, { headers: link ? { link } : {} });
    }
    if (url.pathname.startsWith(`${prefix}/check-suites/`)) {
      const id = Number(url.pathname.split('/').at(-1));
      return jsonResponse(state.checkSuites.get(id));
    }
    if (url.pathname === `${prefix}/actions/runs`) {
      const pages = state.actionRunPages;
      const link = nextLink(url, pages, state);
      const workflowRuns = pages[pageNumber(url) - 1] ?? [];
      return jsonResponse({ total_count: pages.flat().length, workflow_runs: workflowRuns }, { headers: link ? { link } : {} });
    }
    if (url.pathname.startsWith(`${prefix}/actions/workflows/`)) {
      const id = Number(url.pathname.split('/').at(-1));
      return jsonResponse(state.workflows.get(id));
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
      const sha = url.pathname.split('/').at(-1);
      return jsonResponse(state.blobs.get(sha));
    }
    return jsonResponse({ message: `unhandled fixture path ${url.pathname}` }, { status: 404 });
  };
  return { fetch, calls };
};

const collect = async (state, options = {}) => {
  const fixture = fixtureFetch(state);
  const client = createGitHubReadbackClient({
    fetch: fixture.fetch,
    token: AUTH_SENTINEL,
    apiVersion: API_VERSION,
  });
  const evidence = await collectGitHubApprovalEvidence(
    client,
    options.request ?? request(state),
    options.limits ?? limits(),
    options.policy ?? policy(),
  );
  return { evidence, ...fixture, client };
};

const expectCode = async (operation, code) => {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.message, code);
    assert.match(error?.message ?? '', /^APPROVAL_[A-Z0-9_]+$/);
    assert.doesNotMatch(error?.message ?? '', /github-token|free-form|private|untrusted/i);
    return true;
  });
};

test('collects frozen bounded observed evidence without claiming complete approval', async () => {
  const state = fixtureState();
  const { evidence, calls, client } = await collect(state);

  assert.equal(evidence.schema_version, 'github-approval-evidence/v1');
  assert.equal(evidence.assembly_state, 'HOLD_LOCAL_CONTEXT_REQUIRED');
  assert.equal(evidence.api_version, API_VERSION);
  assert.deepEqual(evidence.repository, {
    id: REPOSITORY_ID,
    full_name: REPOSITORY_FULL_NAME,
    default_branch: 'main',
  });
  assert.deepEqual(evidence.pull_request, {
    number: 427,
    state: 'OPEN',
    draft: false,
    base_sha: BASE_SHA,
    head_sha: HEAD_SHA,
    merge_base_sha: MERGE_BASE_SHA,
    author: actor(900, 'proposal-author'),
  });
  assert.equal(evidence.review_pagination_complete, true);
  assert.deepEqual(
    [evidence.product_review.role, evidence.privacy_review.role, evidence.qa_review.role, evidence.security_review.role],
    ROLES,
  );
  assert.equal(evidence.codeowner_review.role, 'CODEOWNER');
  assert.equal(evidence.codeowner_review.review_id, 2005);
  assert.deepEqual(evidence.machine_checks, [{
    github_app_id: 15368,
    github_app_slug: 'github-actions',
    check_run_id: 81001,
    check_suite_id: 71001,
    context: 'approval/readback',
    workflow_id: 61001,
    workflow_path: WORKFLOW_PATH,
    trusted_base_workflow_blob_sha: WORKFLOW_BLOB_SHA,
    actions_run_id: 51001,
    actions_run_attempt: 1,
    actions_run_event: 'pull_request_target',
    actions_run_head_sha: HEAD_SHA,
    actions_run_conclusion: 'success',
    reusable_signer: {
      workflow_id: 61002,
      workflow_path: SIGNER_PATH,
      workflow_sha: SIGNER_BLOB_SHA,
    },
  }]);
  assert.deepEqual(evidence.authority_file, {
    path: AUTHORITY_PATH,
    commit_sha: BASE_SHA,
    blob_sha: AUTHORITY_BLOB_SHA,
    mode: '100644',
    size_bytes: state.blobs.get(AUTHORITY_BLOB_SHA).size,
    raw_sha256: digest(Buffer.from(state.blobs.get(AUTHORITY_BLOB_SHA).content, 'base64')),
    value: JSON.parse(Buffer.from(state.blobs.get(AUTHORITY_BLOB_SHA).content, 'base64').toString('utf8')),
  });
  assert.deepEqual(
    evidence.proposal_files.map(({ path, commit_sha, blob_sha, mode }) => ({ path, commit_sha, blob_sha, mode })),
    [
      { path: PROPOSAL_MANIFEST_PATH, commit_sha: HEAD_SHA, blob_sha: PROPOSAL_MANIFEST_BLOB_SHA, mode: '100644' },
      { path: PROPOSAL_SIDECAR_PATH, commit_sha: HEAD_SHA, blob_sha: PROPOSAL_SIDECAR_BLOB_SHA, mode: '100644' },
    ],
  );
  assert.deepEqual(evidence.proposal_files[0].value, {
    schema_version: 'approval-proposal-manifest/v1',
    decision_id: 'ADR-027',
    policy_revision: 'program-c/policy-r2',
    decision_raw_sha256: DECISION_RAW_SHA256,
    decision_semantic_sha256: DECISION_SEMANTIC_SHA256,
    sidecar_path: PROPOSAL_SIDECAR_PATH,
  });
  assert.equal(evidence.ruleset.id, 777);
  assert.deepEqual(evidence.ruleset.bypass_actors, []);
  assert.deepEqual(evidence.ruleset.required_status_checks, [{ context: 'approval/readback', integration_id: 15368 }]);
  assert.match(evidence.ruleset.normalized_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(evidence.readback.pre, {
    base_sha: BASE_SHA,
    head_sha: HEAD_SHA,
    authority_blob_sha: AUTHORITY_BLOB_SHA,
    ruleset_sha256: evidence.ruleset.normalized_sha256,
  });
  assert.deepEqual(evidence.readback.post, evidence.readback.pre);
  assert.equal(evidence.observed_at, OBSERVED_AT);
  assert.ok(Object.isFrozen(evidence));
  assert.ok(Object.isFrozen(evidence.machine_checks[0].reusable_signer));
  assert.ok(Object.isFrozen(evidence.proposal_files[0]));
  assert.ok(Object.isFrozen(evidence.proposal_files[0].value));
  assert.ok(Object.isFrozen(client));
  assert.equal(Object.hasOwn(client, 'token'), false);

  const retained = JSON.stringify(evidence);
  for (const forbidden of [AUTH_SENTINEL, 'free-form', 'untrusted PR', 'details-only-claim', 'external-id']) {
    assert.equal(retained.includes(forbidden), false, `retained forbidden value ${forbidden}`);
  }
  for (const forbiddenField of ['valid', 'verified', 'accepted', 'legal_input', 'verifier', 'receipt_subject']) {
    assert.equal(Object.hasOwn(evidence, forbiddenField), false);
  }
  for (const role of ROLES) {
    const key = role === 'OWN-PRODUCT' ? 'product_review'
      : role === 'OWN-DATA-PRIVACY' ? 'privacy_review'
        : role === 'OWN-QA-EVIDENCE' ? 'qa_review' : 'security_review';
    assert.equal(Object.hasOwn(evidence[key], 'body'), false);
    assert.equal(evidence[key].review_commit_id, HEAD_SHA);
    assert.match(evidence[key].review_command_sha256, /^sha256:[0-9a-f]{64}$/);
  }

  const reviewCalls = calls.filter(({ url }) => new URL(url).pathname.endsWith('/reviews'));
  assert.equal(reviewCalls.length, 2);
  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(url.origin, API_ORIGIN);
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.headers.Authorization, `Bearer ${AUTH_SENTINEL}`);
    assert.equal(call.init.headers.Accept, 'application/vnd.github+json');
    assert.equal(call.init.headers['X-GitHub-Api-Version'], API_VERSION);
    assert.ok(call.init.signal instanceof AbortSignal);
  }
});

test('requires the exact API version and injected fetch without exposing configuration secrets', () => {
  assert.throws(
    () => createGitHubReadbackClient({ fetch: async () => {}, token: AUTH_SENTINEL, apiVersion: '2022-11-28' }),
    { message: 'APPROVAL_GITHUB_API_VERSION_INVALID' },
  );
  assert.throws(
    () => createGitHubReadbackClient({ fetch: null, token: AUTH_SENTINEL, apiVersion: API_VERSION }),
    { message: 'APPROVAL_GITHUB_CLIENT_INVALID' },
  );
  assert.throws(
    () => createGitHubReadbackClient({ fetch: async () => {}, token: '', apiVersion: API_VERSION }),
    { message: 'APPROVAL_GITHUB_CLIENT_INVALID' },
  );
});

test('rejects a non-allowlisted proposal path before the first request', async () => {
  const state = fixtureState();
  const fixture = fixtureFetch(state);
  const client = createGitHubReadbackClient({ fetch: fixture.fetch, token: AUTH_SENTINEL, apiVersion: API_VERSION });
  const unsafe = request(state);
  unsafe.proposalSidecarPath = '../secrets.json';
  await expectCode(
    () => collectGitHubApprovalEvidence(client, unsafe, limits(), policy()),
    'APPROVAL_GITHUB_REPO_PATH_FORBIDDEN',
  );
  assert.equal(fixture.calls.length, 0);
});

test('rejects static policy check-run and check-suite allowlists before the first request', async () => {
  for (const field of ['allowedCheckRunIds', 'allowedCheckSuiteIds', 'allowed_check_run_ids', 'allowed_check_suite_ids']) {
    const state = fixtureState();
    const fixture = fixtureFetch(state);
    const client = createGitHubReadbackClient({ fetch: fixture.fetch, token: AUTH_SENTINEL, apiVersion: API_VERSION });
    const unsafePolicy = policy();
    unsafePolicy[field] = [81001];
    await expectCode(
      () => collectGitHubApprovalEvidence(client, request(state), limits(), unsafePolicy),
      'APPROVAL_GITHUB_STATIC_DYNAMIC_ID_FORBIDDEN',
    );
    assert.equal(fixture.calls.length, 0);
  }
});

test('rejects redirects and cross-origin pagination without forwarding Authorization or replaying the request', async () => {
  {
    const state = fixtureState();
    state.forced = {
      predicate: (url) => url.pathname === `/repositories/${REPOSITORY_ID}`,
      response: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
    };
    const fixture = fixtureFetch(state);
    const client = createGitHubReadbackClient({ fetch: fixture.fetch, token: AUTH_SENTINEL, apiVersion: API_VERSION });
    await expectCode(
      () => collectGitHubApprovalEvidence(client, request(state), limits(), policy()),
      'APPROVAL_GITHUB_REDIRECT_REJECTED',
    );
    assert.equal(fixture.calls.length, 1);
    assert.equal(new URL(fixture.calls[0].url).origin, API_ORIGIN);
  }
  {
    const state = fixtureState();
    state.crossOriginLink = 'https://evil.example/reviews?page=2';
    const fixture = fixtureFetch(state);
    const client = createGitHubReadbackClient({ fetch: fixture.fetch, token: AUTH_SENTINEL, apiVersion: API_VERSION });
    await expectCode(
      () => collectGitHubApprovalEvidence(client, request(state), limits(), policy()),
      'APPROVAL_GITHUB_ORIGIN_FORBIDDEN',
    );
    assert.equal(fixture.calls.some(({ url }) => new URL(url).origin !== API_ORIGIN), false);
  }
});

test('maps HTTP failures, timeout, and oversized responses to fixed non-reflective codes', async (t) => {
  for (const [status, code] of [
    [301, 'APPROVAL_GITHUB_REDIRECT_REJECTED'],
    [403, 'APPROVAL_GITHUB_FORBIDDEN'],
    [404, 'APPROVAL_GITHUB_NOT_FOUND'],
    [409, 'APPROVAL_GITHUB_CONFLICT'],
    [429, 'APPROVAL_GITHUB_RATE_LIMITED'],
    [500, 'APPROVAL_GITHUB_REQUEST_FAILED'],
  ]) {
    await t.test(`HTTP ${status}`, async () => {
      const state = fixtureState();
      state.forced = {
        predicate: (url) => url.pathname === `/repositories/${REPOSITORY_ID}`,
        response: () => jsonResponse({ message: `${TOKEN} private free-form` }, { status }),
      };
      await expectCode(() => collect(state), code);
    });
  }
  await t.test('timeout', async () => {
    const state = fixtureState();
    state.rejectWith = new DOMException('private timeout details', 'TimeoutError');
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_TIMEOUT');
  });
  await t.test('response byte bound', async () => {
    const state = fixtureState();
    await expectCode(
      () => collect(state, { limits: limits({ maxResponseBytes: 32 }) }),
      'APPROVAL_GITHUB_RESPONSE_TOO_LARGE',
    );
  });
});

test('fails closed on malformed, looping, over-page, and over-item pagination', async (t) => {
  await t.test('malformed Link', async () => {
    const state = fixtureState();
    state.malformedLink = 'https://api.github.com/no-angle; rel="next"';
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_PAGINATION_INVALID');
  });
  await t.test('pagination loop', async () => {
    const state = fixtureState();
    state.loopLink = true;
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_PAGINATION_LOOP');
  });
  await t.test('page bound', async () => {
    const state = fixtureState();
    await expectCode(
      () => collect(state, { limits: limits({ maxPages: 1 }) }),
      'APPROVAL_GITHUB_PAGE_LIMIT_EXCEEDED',
    );
  });
  await t.test('item bound', async () => {
    const state = fixtureState();
    await expectCode(
      () => collect(state, { limits: limits({ maxItems: 3 }) }),
      'APPROVAL_GITHUB_ITEM_LIMIT_EXCEEDED',
    );
  });
});

test('requires complete exact-head Product, Privacy, QA, and numeric OWN-SECURITY approvals', async (t) => {
  await t.test('missing page loses Security', async () => {
    const state = fixtureState();
    state.reviewPages = [state.reviewPages[0]];
    await expectCode(() => collect(state), 'APPROVAL_REVIEW_REQUIRED');
  });
  await t.test('wrong admitted Security actor', async () => {
    const state = fixtureState();
    state.reviewPages[1][1].user = actor(999, 'security-owner');
    await expectCode(() => collect(state), 'APPROVAL_REVIEW_ACTOR_MISMATCH');
  });
  await t.test('dismissed Security review', async () => {
    const state = fixtureState();
    state.reviewPages[1][1].state = 'DISMISSED';
    await expectCode(() => collect(state), 'APPROVAL_REVIEW_DISMISSED');
  });
  await t.test('superseded Security review', async () => {
    const state = fixtureState();
    const changes = review('OWN-SECURITY', 2006, state.actors['OWN-SECURITY']);
    changes.state = 'CHANGES_REQUESTED';
    changes.submitted_at = '2026-08-30T11:00:00.000Z';
    state.reviewPages[1].push(changes);
    await expectCode(() => collect(state), 'APPROVAL_REVIEW_STALE');
  });
  await t.test('wrong-head Product review', async () => {
    const state = fixtureState();
    state.reviewPages[0][0].commit_id = OTHER_SHA;
    await expectCode(() => collect(state), 'APPROVAL_REVIEW_STALE');
  });
  await t.test('wrong role command for OWN-SECURITY', async () => {
    const state = fixtureState();
    state.reviewPages[1][1].body = commandLine('OWN-QA-EVIDENCE');
    await expectCode(() => collect(state), 'APPROVAL_REVIEW_COMMAND_INVALID');
  });
  await t.test('cross-slot review ID reuse', async () => {
    const state = fixtureState();
    state.reviewPages[1][1].id = 2001;
    await expectCode(() => collect(state), 'APPROVAL_EVIDENCE_SLOT_REUSE');
  });
});

test('rejects duplicate checks and claims backed only by a name, details URL, workflow path, or App slug', async (t) => {
  await t.test('duplicate context', async () => {
    const state = fixtureState();
    state.checkPages[0].push({ ...structuredClone(state.checkPages[0][0]), id: 81002 });
    await expectCode(() => collect(state), 'APPROVAL_CHECK_AMBIGUOUS');
  });
  for (const [name, mutate] of [
    ['name-only', (state) => { delete state.checkPages[0][0].check_suite.id; }],
    ['details-URL-only', (state) => { delete state.checkPages[0][0].id; }],
    ['workflow-path-only', (state) => { delete state.actionRunPages[0][0].workflow_id; }],
    ['App-slug-only', (state) => { delete state.checkPages[0][0].app.id; }],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      mutate(state);
      await expectCode(() => collect(state), 'APPROVAL_CHECK_WORKFLOW_MISMATCH');
    });
  }
});

test('binds dynamic run and suite IDs to exact App, suite, workflow, run, base blob, and reusable signer identities', async (t) => {
  for (const [name, mutate] of [
    ['App ID', (state) => { state.checkPages[0][0].app.id = 999; }],
    ['suite head', (state) => { state.checkSuites.get(71001).head_sha = OTHER_SHA; }],
    ['run suite', (state) => { state.actionRunPages[0][0].check_suite_id = 999; }],
    ['workflow ID/path readback', (state) => { state.workflows.get(61001).path = '.github/workflows/other.yml'; }],
    ['run event', (state) => { state.actionRunPages[0][0].event = 'pull_request'; }],
    ['run head', (state) => { state.actionRunPages[0][0].head_sha = OTHER_SHA; }],
    ['run conclusion', (state) => { state.actionRunPages[0][0].conclusion = 'failure'; }],
    ['run attempt', (state) => { state.actionRunPages[0][0].run_attempt = 0; }],
    ['reusable signer workflow ID', (state) => { state.actionRunPages[0][0].referenced_workflows[0].workflow_id = 999; }],
    ['reusable signer blob SHA', (state) => { state.actionRunPages[0][0].referenced_workflows[0].sha = OTHER_SHA; }],
    ['trusted base workflow blob mode', (state) => { state.baseTree.tree[1].mode = '100755'; }],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      mutate(state);
      await expectCode(() => collect(state), 'APPROVAL_CHECK_WORKFLOW_MISMATCH');
    });
  }
});

test('rejects executable, symlink, gitlink, tree, and absent proposal entries before parsing content', async (t) => {
  for (const [name, mutate] of [
    ['executable', (entry) => { entry.mode = '100755'; }],
    ['symlink', (entry) => { entry.mode = '120000'; }],
    ['submodule', (entry) => { entry.mode = '160000'; }],
    ['tree mode', (entry) => { entry.mode = '040000'; entry.type = 'tree'; }],
    ['wrong type', (entry) => { entry.type = 'tree'; }],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      mutate(state.headTree.tree[0]);
      await expectCode(() => collect(state), 'APPROVAL_GITHUB_TREE_ENTRY_INVALID');
    });
  }
  await t.test('absent', async () => {
    const state = fixtureState();
    state.headTree.tree = [];
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_TREE_ENTRY_INVALID');
  });
});

test('enforces exact blob identity, 1 MiB, LFS, fatal UTF-8, and strict JSON boundaries', async (t) => {
  await t.test('blob SHA mismatch', async () => {
    const state = fixtureState();
    state.blobs.get(PROPOSAL_MANIFEST_BLOB_SHA).sha = OTHER_SHA;
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_BLOB_IDENTITY_MISMATCH');
  });
  await t.test('Git LFS pointer', async () => {
    const state = fixtureState();
    state.blobs.set(PROPOSAL_MANIFEST_BLOB_SHA, {
      sha: PROPOSAL_MANIFEST_BLOB_SHA,
      ...encodeBlob('version https://git-lfs.github.com/spec/v1\noid sha256:deadbeef\nsize 1\n'),
    });
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_LFS_POINTER_FORBIDDEN');
  });
  await t.test('one byte over 1 MiB', async () => {
    const state = fixtureState();
    const bytes = Buffer.alloc(1_048_577, 0x20);
    state.blobs.set(PROPOSAL_MANIFEST_BLOB_SHA, { sha: PROPOSAL_MANIFEST_BLOB_SHA, ...encodeBlob(bytes) });
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_BLOB_TOO_LARGE');
  });
  await t.test('fatal UTF-8', async () => {
    const state = fixtureState();
    state.blobs.set(PROPOSAL_MANIFEST_BLOB_SHA, {
      sha: PROPOSAL_MANIFEST_BLOB_SHA,
      ...encodeBlob(Buffer.from([0x7b, 0xff, 0x7d])),
    });
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_BLOB_UTF8_INVALID');
  });
  await t.test('duplicate JSON key', async () => {
    const state = fixtureState();
    state.blobs.set(PROPOSAL_MANIFEST_BLOB_SHA, {
      sha: PROPOSAL_MANIFEST_BLOB_SHA,
      ...encodeBlob('{"decision":"ADR-027","decision":"ADR-026"}'),
    });
    await expectCode(() => collect(state), 'APPROVAL_JSON_DUPLICATE_KEY');
  });
});

test('detects PR head drift and proposal or trusted-base tree identity drift across pre/post reads', async (t) => {
  await t.test('PR post-read drift', async () => {
    const state = fixtureState();
    state.postPullRequest = structuredClone(state.pullRequest);
    state.postPullRequest.head.sha = OTHER_SHA;
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_HEAD_DRIFT');
  });
  await t.test('proposal blob post-read drift', async () => {
    const state = fixtureState();
    state.postHeadTree = structuredClone(state.headTree);
    state.postHeadTree.tree[0].sha = OTHER_SHA;
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_HEAD_DRIFT');
  });
  await t.test('trusted workflow post-read drift', async () => {
    const state = fixtureState();
    state.postBaseTree = structuredClone(state.baseTree);
    state.postBaseTree.tree[1].sha = OTHER_SHA;
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_HEAD_DRIFT');
  });
  await t.test('ruleset post-read drift', async () => {
    const state = fixtureState();
    state.postRuleset = structuredClone(state.ruleset);
    state.postRuleset.enforcement = 'disabled';
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_HEAD_DRIFT');
  });
});

test('requires ruleset and commit-associated PR readback to match the pinned repository, contexts, base, and head', async (t) => {
  await t.test('commit is not associated with PR', async () => {
    const state = fixtureState();
    state.associatedPulls = [];
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_PR_ASSOCIATION_MISMATCH');
  });
  await t.test('ruleset context drift', async () => {
    const state = fixtureState();
    state.ruleset.rules[0].parameters.required_status_checks[0].context = 'other/context';
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_RULESET_MISMATCH');
  });
  await t.test('ruleset bypass actor', async () => {
    const state = fixtureState();
    state.ruleset.bypass_actors = [{ actor_id: 999, actor_type: 'RepositoryRole', bypass_mode: 'always' }];
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_RULESET_MISMATCH');
  });
});

test('validates hard limit ceilings before making a request', async () => {
  for (const unsafeLimits of [
    limits({ maxPages: 101 }),
    limits({ maxItems: 10_001 }),
    limits({ maxBlobBytes: 1_048_577 }),
    limits({ timeoutMs: 0 }),
  ]) {
    const state = fixtureState();
    const fixture = fixtureFetch(state);
    const client = createGitHubReadbackClient({ fetch: fixture.fetch, token: TOKEN, apiVersion: API_VERSION });
    await expectCode(
      () => collectGitHubApprovalEvidence(client, request(state), unsafeLimits, policy()),
      'APPROVAL_GITHUB_LIMIT_INVALID',
    );
    assert.equal(fixture.calls.length, 0);
  }
});
