import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectGitHubApprovalEvidence,
  createGitHubReadbackClient,
} from './governance-github-readback.mjs';
import {
  API_ORIGIN,
  API_VERSION,
  AUTHORITY_BLOB_SHA,
  AUTHORITY_PATH,
  AUTH_SENTINEL,
  BASE_SHA,
  DECISION_RAW_SHA256,
  DECISION_SEMANTIC_SHA256,
  HEAD_SHA,
  MERGE_BASE_SHA,
  OBSERVED_AT,
  PROPOSAL_MANIFEST_BLOB_SHA,
  PROPOSAL_MANIFEST_PATH,
  PROPOSAL_SIDECAR_BLOB_SHA,
  PROPOSAL_SIDECAR_PATH,
  REPOSITORY_FULL_NAME,
  REPOSITORY_ID,
  ROLES,
  SIGNER_BLOB_SHA,
  SIGNER_PATH,
  WORKFLOW_BLOB_SHA,
  WORKFLOW_PATH,
  actor,
  collect,
  digest,
  expectCode,
  fixtureFetch,
  fixtureState,
  jsonResponse,
  limits,
  policy,
  request,
} from './fixtures/approval-readback/task5-github-readback-fixture.mjs';

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
  assert.equal(Object.hasOwn(evidence.proposal_files[0], 'value'), false);
  assert.deepEqual(evidence.proposal_files[0].subject, {
    schema_version: 'approval-proposal-manifest/v1',
    decision_id: 'ADR-027',
    policy_revision: 'program-c/policy-r2',
    decision_raw_sha256: DECISION_RAW_SHA256,
    decision_semantic_sha256: DECISION_SEMANTIC_SHA256,
    sidecar_path: PROPOSAL_SIDECAR_PATH,
  });
  assert.match(evidence.proposal_files[0].semantic_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(evidence.ruleset.id, 777);
  assert.deepEqual(evidence.ruleset.bypass_actors, []);
  assert.deepEqual(evidence.ruleset.required_status_checks, [{ context: 'approval/readback', integration_id: 15368 }]);
  assert.deepEqual(evidence.ruleset.ref_name, {
    include: ['~DEFAULT_BRANCH'],
    exclude: [],
  });
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
  assert.ok(Object.isFrozen(evidence.proposal_files[0].subject));
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

  assert.equal(calls.filter(({ url }) => new URL(url).pathname.endsWith('/reviews')).length, 2);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, API_ORIGIN);
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.headers.Authorization, `Bearer ${AUTH_SENTINEL}`);
    assert.equal(call.init.headers.Accept, 'application/vnd.github+json');
    assert.equal(call.init.headers['X-GitHub-Api-Version'], API_VERSION);
    assert.ok(call.init.signal instanceof AbortSignal);
  }
});

test('requires the exact API version and injected fetch', () => {
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
  const unsafe = request();
  unsafe.proposalSidecarPath = '../secrets.json';
  await expectCode(
    () => collectGitHubApprovalEvidence(client, unsafe, limits(), policy()),
    'APPROVAL_GITHUB_REPO_PATH_FORBIDDEN',
  );
  assert.equal(fixture.calls.length, 0);
});

test('rejects caller base URLs and local assembly context before the first request', async () => {
  for (const [field, value] of [
    ['baseUrl', 'https://api.github.example'],
    ['legal_input', { status: 'NO_BLOCKER_RECORDED' }],
    ['verifier', { trust_class: 'INDEPENDENT_EXTERNAL_VERIFIED' }],
  ]) {
    const state = fixtureState();
    const fixture = fixtureFetch(state);
    const client = createGitHubReadbackClient({ fetch: fixture.fetch, token: AUTH_SENTINEL, apiVersion: API_VERSION });
    const unsafe = request();
    unsafe[field] = value;
    await expectCode(
      () => collectGitHubApprovalEvidence(client, unsafe, limits(), policy()),
      'APPROVAL_GITHUB_REQUEST_INVALID',
    );
    assert.equal(fixture.calls.length, 0);
  }
});

test('rejects static check-run and check-suite policy IDs before requests', async () => {
  for (const field of ['allowedCheckRunIds', 'allowedCheckSuiteIds', 'allowed_check_run_ids', 'allowed_check_suite_ids']) {
    const state = fixtureState();
    const fixture = fixtureFetch(state);
    const client = createGitHubReadbackClient({ fetch: fixture.fetch, token: AUTH_SENTINEL, apiVersion: API_VERSION });
    const unsafePolicy = policy();
    unsafePolicy[field] = [81001];
    await expectCode(
      () => collectGitHubApprovalEvidence(client, request(), limits(), unsafePolicy),
      'APPROVAL_GITHUB_STATIC_DYNAMIC_ID_FORBIDDEN',
    );
    assert.equal(fixture.calls.length, 0);
  }
});

test('rejects redirects and cross-origin pagination without credential replay', async () => {
  const redirectState = fixtureState();
  redirectState.forced = {
    predicate: (url) => url.pathname === `/repositories/${REPOSITORY_ID}`,
    response: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
  };
  const redirectFixture = fixtureFetch(redirectState);
  const redirectClient = createGitHubReadbackClient({
    fetch: redirectFixture.fetch,
    token: AUTH_SENTINEL,
    apiVersion: API_VERSION,
  });
  await expectCode(
    () => collectGitHubApprovalEvidence(redirectClient, request(), limits(), policy()),
    'APPROVAL_GITHUB_REDIRECT_REJECTED',
  );
  assert.equal(redirectFixture.calls.length, 1);

  const linkState = fixtureState();
  linkState.crossOriginLink = 'https://evil.example/reviews?page=2';
  const linkFixture = fixtureFetch(linkState);
  const linkClient = createGitHubReadbackClient({ fetch: linkFixture.fetch, token: AUTH_SENTINEL, apiVersion: API_VERSION });
  await expectCode(
    () => collectGitHubApprovalEvidence(linkClient, request(), limits(), policy()),
    'APPROVAL_GITHUB_ORIGIN_FORBIDDEN',
  );
  assert.equal(linkFixture.calls.some(({ url }) => new URL(url).origin !== API_ORIGIN), false);
});

test('maps HTTP, timeout, and response-size failures to fixed codes', async (t) => {
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
        response: () => jsonResponse({ message: `${AUTH_SENTINEL} private free-form` }, { status }),
      };
      await expectCode(() => collect(state), code);
    });
  }
  await t.test('timeout', async () => {
    const state = fixtureState();
    state.rejectWith = new DOMException('private timeout details', 'TimeoutError');
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_TIMEOUT');
  });
  await t.test('injected fetch ignores AbortSignal', async () => {
    const state = fixtureState();
    state.forced = {
      predicate: (url) => url.pathname === `/repositories/${REPOSITORY_ID}`,
      response: () => new Promise(() => {}),
    };
    await expectCode(
      () => collect(state, { limits: limits({ timeoutMs: 5 }) }),
      'APPROVAL_GITHUB_TIMEOUT',
    );
  });
  await t.test('response byte bound', async () => {
    await expectCode(
      () => collect(fixtureState(), { limits: limits({ maxResponseBytes: 32 }) }),
      'APPROVAL_GITHUB_RESPONSE_TOO_LARGE',
    );
  });
});

test('fails closed on malformed, looping, over-page, and over-item pagination', async (t) => {
  for (const [name, mutate, code, override] of [
    ['malformed', (state) => { state.malformedLink = 'https://api.github.com/no-angle; rel="next"'; }, 'APPROVAL_GITHUB_PAGINATION_INVALID'],
    ['loop', (state) => { state.loopLink = true; }, 'APPROVAL_GITHUB_PAGINATION_LOOP'],
    ['page', () => {}, 'APPROVAL_GITHUB_PAGE_LIMIT_EXCEEDED', { limits: limits({ maxPages: 1 }) }],
    ['item', () => {}, 'APPROVAL_GITHUB_ITEM_LIMIT_EXCEEDED', { limits: limits({ maxItems: 3 }) }],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      mutate(state);
      await expectCode(() => collect(state, override), code);
    });
  }
});

await import('./governance-github-readback-evidence.spec.mjs');
await import('./governance-github-readback-round1.spec.mjs');
