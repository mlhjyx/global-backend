import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectGitHubApprovalEvidence,
  createGitHubReadbackClient,
} from './governance-github-readback.mjs';
import {
  snapshotGitHubReadbackInputs,
} from './governance-github-readback-common.mjs';
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
  PROPOSAL_RENDERER_SOURCE_SHA256,
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
  encodeBlob,
  expectCode,
  fixtureFetch,
  fixtureState,
  jsonResponse,
  limits,
  mutateAuthorityRole,
  policy,
  request,
} from './fixtures/approval-readback/task5-github-readback-fixture.mjs';

const mutateProposalManifest = (state, mutate) => {
  const blob = state.blobs.get(PROPOSAL_MANIFEST_BLOB_SHA);
  const value = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
  mutate(value);
  state.blobs.set(PROPOSAL_MANIFEST_BLOB_SHA, {
    sha: PROPOSAL_MANIFEST_BLOB_SHA,
    ...encodeBlob(`${JSON.stringify(value)}\n`),
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
    actions_run_head_sha: BASE_SHA,
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
  assert.deepEqual(evidence.proposal_files, [
    {
      path: PROPOSAL_MANIFEST_PATH,
      commit_sha: HEAD_SHA,
      blob_sha: PROPOSAL_MANIFEST_BLOB_SHA,
      mode: '100644',
      size_bytes: state.blobs.get(PROPOSAL_MANIFEST_BLOB_SHA).size,
      raw_sha256: digest(Buffer.from(state.blobs.get(PROPOSAL_MANIFEST_BLOB_SHA).content, 'base64')),
      semantic_sha256: DECISION_SEMANTIC_SHA256,
      trusted_renderer: {
        schema_version: 'approval-sidecar-renderer/v1',
        source_sha256: PROPOSAL_RENDERER_SOURCE_SHA256,
      },
    },
    {
      path: PROPOSAL_SIDECAR_PATH,
      commit_sha: HEAD_SHA,
      blob_sha: PROPOSAL_SIDECAR_BLOB_SHA,
      mode: '100644',
      size_bytes: state.blobs.get(PROPOSAL_SIDECAR_BLOB_SHA).size,
      raw_sha256: digest(Buffer.from(state.blobs.get(PROPOSAL_SIDECAR_BLOB_SHA).content, 'base64')),
      semantic_sha256: DECISION_SEMANTIC_SHA256,
      trusted_renderer: {
        schema_version: 'approval-sidecar-renderer/v1',
        source_sha256: PROPOSAL_RENDERER_SOURCE_SHA256,
      },
    },
  ]);
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
  assert.ok(Object.isFrozen(evidence.proposal_files[0].trusted_renderer));
  assert.ok(Object.isFrozen(client));
  assert.equal(Object.hasOwn(client, 'token'), false);

  const retained = JSON.stringify(evidence);
  for (const forbidden of [
    AUTH_SENTINEL,
    'free-form',
    'untrusted PR',
    'details-only-claim',
    'external-id',
    'WORKSPACE_COMPLIANCE_HOLD',
  ]) {
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

test('requires each hosted role authority to cover its selected review and request observation', async (t) => {
  const reviewSubmittedAt = (state, role) => state.reviewPages
    .flat()
    .find((entry) => entry.user.id === state.actors[role].id)?.submitted_at;

  await t.test('all four exact role assignments cover both observation boundaries', async () => {
    const state = fixtureState();
    for (const role of ROLES) {
      mutateAuthorityRole(state, role, (entry) => {
        entry.effective_from = reviewSubmittedAt(state, role);
        entry.assignment_evidence.observed_at = reviewSubmittedAt(state, role);
      });
    }
    const { evidence } = await collect(state);
    assert.deepEqual(
      [
        evidence.product_review.role,
        evidence.privacy_review.role,
        evidence.qa_review.role,
        evidence.security_review.role,
      ],
      ROLES,
    );
  });

  for (const role of ROLES) {
    for (const [boundary, mutate] of [
      ['effective_from after selected review', (entry, submittedAt) => {
        entry.effective_from = new Date(Date.parse(submittedAt) + 1).toISOString();
      }],
      ['effective_from after request observation', (entry) => {
        entry.effective_from = new Date(Date.parse(OBSERVED_AT) + 1).toISOString();
      }],
      ['effective_until equal to selected review', (entry, submittedAt) => {
        entry.effective_until = submittedAt;
      }],
      ['effective_until before selected review', (entry, submittedAt) => {
        entry.effective_until = new Date(Date.parse(submittedAt) - 1).toISOString();
      }],
      ['effective_until equal to request observation', (entry) => {
        entry.effective_until = OBSERVED_AT;
      }],
      ['effective_until before request observation', (entry) => {
        entry.effective_until = new Date(Date.parse(OBSERVED_AT) - 1).toISOString();
      }],
      ['assignment observed after selected review', (entry, submittedAt) => {
        entry.assignment_evidence.observed_at = new Date(Date.parse(submittedAt) + 1).toISOString();
      }],
      ['assignment observed after request observation', (entry) => {
        entry.assignment_evidence.observed_at = new Date(Date.parse(OBSERVED_AT) + 1).toISOString();
      }],
      ['assignment observed before its effective interval', (entry) => {
        entry.assignment_evidence.observed_at = new Date(Date.parse(entry.effective_from) - 1).toISOString();
      }],
    ]) {
      await t.test(`${role}: ${boundary}`, async () => {
        const state = fixtureState();
        mutateAuthorityRole(state, role, (entry) => mutate(entry, reviewSubmittedAt(state, role)));
        await expectCode(
          () => collect(state),
          'APPROVAL_GITHUB_AUTHORITY_CURRENTNESS_MISMATCH',
        );
      });
    }
  }
});

test('backdated request provenance cannot rescue authority expired at collector readback', async () => {
  const state = fixtureState();
  for (const role of ROLES) {
    mutateAuthorityRole(state, role, (entry) => {
      entry.effective_until = '2026-08-31T00:00:00.000Z';
    });
  }

  await expectCode(
    () => collect(state, {
      collectorObservedAt: '2026-08-31T17:44:00.691Z',
      request: request(),
    }),
    'APPROVAL_GITHUB_AUTHORITY_CURRENTNESS_MISMATCH',
  );
});

test('binds the proposal manifest identity and trusted renderer before reading Markdown', async (t) => {
  for (const [name, mutate] of [
    ['decision ID', (value) => { value.decision_id = 'ADR-026'; }],
    ['policy revision', (value) => { value.policy_revision = 'program-c/policy-r3'; }],
    ['decision raw digest', (value) => { value.decision_raw_sha256 = `sha256:${'d'.repeat(64)}`; }],
    ['decision semantic digest', (value) => { value.decision_semantic_sha256 = `sha256:${'d'.repeat(64)}`; }],
    ['sidecar path allowlist', (value) => {
      value.proposed_sidecar_path = 'docs/governance/decisions/adr-027-other.md';
    }],
    ['renderer schema', (value) => { value.renderer_schema_version = 'approval-sidecar-renderer/v2'; }],
    ['renderer source', (value) => { value.renderer_source_sha256 = `sha256:${'d'.repeat(64)}`; }],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      mutateProposalManifest(state, mutate);
      await expectCode(() => collect(state), 'APPROVAL_GITHUB_PROPOSAL_MISMATCH');
    });
  }

  await t.test('sidecar path drift fails before the sidecar blob read', async () => {
    const state = fixtureState();
    mutateProposalManifest(state, (value) => {
      value.proposed_sidecar_path = 'docs/governance/decisions/adr-027-other.md';
    });
    const fixture = fixtureFetch(state);
    const client = createGitHubReadbackClient({
      fetch: fixture.fetch,
      token: AUTH_SENTINEL,
      apiVersion: API_VERSION,
    });
    await expectCode(
      () => collectGitHubApprovalEvidence(client, request(), limits(), policy()),
      'APPROVAL_GITHUB_PROPOSAL_MISMATCH',
    );
    assert.equal(fixture.calls.some(({ url }) => (
      new URL(url).pathname.endsWith(`/git/blobs/${PROPOSAL_SIDECAR_BLOB_SHA}`)
    )), false);
  });
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

test('snapshots and deep-freezes the closed trusted proposal renderer policy before reads', () => {
  const sourcePolicy = policy();
  const snapshot = snapshotGitHubReadbackInputs(request(), limits(), sourcePolicy);

  assert.deepEqual(snapshot.policy.proposalRenderer, {
    schemaVersion: 'approval-sidecar-renderer/v1',
    sourceSha256: `sha256:${'c'.repeat(64)}`,
  });
  assert.ok(Object.isFrozen(snapshot.policy.proposalRenderer));
  sourcePolicy.proposalRenderer.sourceSha256 = `sha256:${'d'.repeat(64)}`;
  assert.equal(snapshot.policy.proposalRenderer.sourceSha256, `sha256:${'c'.repeat(64)}`);

  for (const mutate of [
    (value) => { delete value.proposalRenderer; },
    (value) => { delete value.proposalRenderer.schemaVersion; },
    (value) => { value.proposalRenderer.extra = true; },
    (value) => { value.proposalRenderer.sourceSha256 = `sha256:${'C'.repeat(64)}`; },
  ]) {
    const unsafe = policy();
    mutate(unsafe);
    assert.throws(
      () => snapshotGitHubReadbackInputs(request(), limits(), unsafe),
      { message: 'APPROVAL_GITHUB_POLICY_INVALID' },
    );
  }
});

test('collector rejects every malformed proposal renderer policy before its first remote read', async (t) => {
  for (const [name, mutate] of [
    ['missing tuple', (value) => { delete value.proposalRenderer; }],
    ['partial tuple', (value) => { delete value.proposalRenderer.sourceSha256; }],
    ['extra tuple field', (value) => { value.proposalRenderer.extra = true; }],
    ['non-canonical source digest', (value) => { value.proposalRenderer.sourceSha256 = `sha256:${'C'.repeat(64)}`; }],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      const fixture = fixtureFetch(state);
      const client = createGitHubReadbackClient({
        fetch: fixture.fetch,
        token: AUTH_SENTINEL,
        apiVersion: API_VERSION,
      });
      const unsafe = policy();
      mutate(unsafe);

      await expectCode(
        () => collectGitHubApprovalEvidence(client, request(), limits(), unsafe),
        'APPROVAL_GITHUB_POLICY_INVALID',
      );
      assert.equal(fixture.calls.length, 0);
    });
  }
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
await import('./governance-github-readback-round2.spec.mjs');
await import('./governance-github-readback-round3.spec.mjs');
