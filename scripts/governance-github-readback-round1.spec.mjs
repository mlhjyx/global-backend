import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectGitHubApprovalEvidence,
  createGitHubReadbackClient,
} from './governance-github-readback.mjs';
import {
  API_VERSION,
  AUTH_SENTINEL,
  HEAD_SHA,
  OTHER_SHA,
  PROPOSAL_MANIFEST_BLOB_SHA,
  PROPOSAL_SIDECAR_BLOB_SHA,
  REPOSITORY_ID,
  collect,
  encodeBlob,
  expectCode,
  fixtureFetch,
  fixtureState,
  jsonResponse,
  limits,
  policy,
  request,
} from './fixtures/approval-readback/task5-github-readback-fixture.mjs';

const OTHER_WORKFLOW_PATH = '.github/workflows/other-readback.yml';
const OTHER_SIGNER_PATH = '.github/workflows/other-signer.yml';
const OTHER_WORKFLOW_SHA = 'a'.repeat(40);
const OTHER_SIGNER_SHA = 'b'.repeat(40);

const addSecondMachineTuple = (state) => {
  const firstCheck = state.checkPages[0][0];
  state.checkPages[0].push({
    ...structuredClone(firstCheck),
    id: 81002,
    name: 'other/context',
    app: { ...firstCheck.app, id: 15369 },
    check_suite: { id: 71002 },
  });
  const firstSuite = state.checkSuites.get(71001);
  state.checkSuites.set(71002, {
    ...structuredClone(firstSuite),
    id: 71002,
    app: { ...firstSuite.app, id: 15369 },
  });
  const firstRun = state.actionRunPages[0][0];
  state.actionRunPages[0].push({
    ...structuredClone(firstRun),
    id: 51002,
    workflow_id: 61003,
    path: OTHER_WORKFLOW_PATH,
    check_suite_id: 71002,
    referenced_workflows: [{
      workflow_id: 61004,
      path: OTHER_SIGNER_PATH,
      sha: OTHER_SIGNER_SHA,
    }],
  });
  state.workflows.set(61003, {
    id: 61003,
    node_id: 'W_61003',
    path: OTHER_WORKFLOW_PATH,
    state: 'active',
  });
  state.workflows.set(61004, {
    id: 61004,
    node_id: 'W_61004',
    path: OTHER_SIGNER_PATH,
    state: 'active',
  });
  state.baseTree.tree.push(
    { path: OTHER_WORKFLOW_PATH, mode: '100644', type: 'blob', sha: OTHER_WORKFLOW_SHA },
    { path: OTHER_SIGNER_PATH, mode: '100644', type: 'blob', sha: OTHER_SIGNER_SHA },
  );
  state.blobs.set(OTHER_WORKFLOW_SHA, {
    sha: OTHER_WORKFLOW_SHA,
    ...encodeBlob('name: other readback\n'),
  });
  state.blobs.set(OTHER_SIGNER_SHA, {
    sha: OTHER_SIGNER_SHA,
    ...encodeBlob('name: other signer\n'),
  });
  const trustedPolicy = policy();
  trustedPolicy.allowedCheckContexts.push('other/context');
  trustedPolicy.allowedActionsAppIds.push(15369);
  trustedPolicy.allowedWorkflowIds.push(61003);
  trustedPolicy.allowedWorkflowPaths.push(OTHER_WORKFLOW_PATH);
  trustedPolicy.allowedReusableSignerWorkflowIds.push(61004);
  trustedPolicy.allowedReusableSignerWorkflowPaths.push(OTHER_SIGNER_PATH);
  return trustedPolicy;
};

const codeownerEvent = (state, overrides = {}) => ({
  id: 2006,
  node_id: 'PRR_2006',
  user: structuredClone(state.reviewPages[1][2].user),
  body: 'CODEOWNER REVIEW',
  state: 'CHANGES_REQUESTED',
  commit_id: HEAD_SHA,
  submitted_at: '2026-08-30T11:00:00.000Z',
  ...overrides,
});

const forceFirstReviewLink = (state, mutateUrl) => {
  state.forced = {
    predicate: (url) => url.pathname.endsWith('/pulls/427/reviews')
      && url.searchParams.get('page') === '1',
    response: (url) => {
      const next = new URL(url);
      mutateUrl(next);
      return jsonResponse(state.reviewPages[0], {
        headers: { link: `<${next.href}>; rel="next"` },
      });
    },
  };
};

test('F1 snapshots closed request, policy tuples, and limits before the first await', async (t) => {
  await t.test('caller mutation inside injected fetch cannot change the validated subject', async () => {
    const state = fixtureState();
    const callerRequest = request();
    const callerPolicy = policy();
    const callerLimits = limits();
    state.forced = {
      predicate: (url) => url.pathname === `/repositories/${REPOSITORY_ID}`,
      response: () => {
        callerRequest.repository.full_name = 'attacker/other';
        callerRequest.expectedHeadSha = OTHER_SHA;
        callerRequest.proposalManifestPath = 'docs/governance/decisions/other.json';
        callerPolicy.allowedRepoPaths.splice(0, callerPolicy.allowedRepoPaths.length, 'other.json');
        callerPolicy.allowedCheckContexts[0] = 'attacker/context';
        callerPolicy.allowedActionsAppIds[0] = 999;
        callerPolicy.allowedWorkflowIds[0] = 999;
        callerPolicy.allowedWorkflowPaths[0] = OTHER_WORKFLOW_PATH;
        callerLimits.maxItems = 1;
        return jsonResponse(state.repository);
      },
    };
    const { evidence } = await collect(state, {
      request: callerRequest,
      policy: callerPolicy,
      limits: callerLimits,
    });
    assert.equal(evidence.pull_request.head_sha, HEAD_SHA);
    assert.equal(evidence.machine_checks[0].context, 'approval/readback');
  });

  await t.test('post-validation limit elevation cannot widen response bytes', async () => {
    const state = fixtureState();
    const callerLimits = limits({ maxResponseBytes: 512 });
    state.forced = {
      predicate: (url) => url.pathname === `/repositories/${REPOSITORY_ID}`,
      response: () => {
        callerLimits.maxResponseBytes = 2_097_152;
        return jsonResponse({ ...state.repository, padding: 'x'.repeat(2_000) });
      },
    };
    await expectCode(
      () => collect(state, { limits: callerLimits }),
      'APPROVAL_GITHUB_RESPONSE_TOO_LARGE',
    );
  });
});

test('F2 ruleset status checks must match the exact indexed context-App tuple', async () => {
  const state = fixtureState();
  const trustedPolicy = addSecondMachineTuple(state);
  state.ruleset.rules[0].parameters.required_status_checks = [
    { context: 'approval/readback', integration_id: 15369 },
    { context: 'other/context', integration_id: 15368 },
  ];
  await expectCode(
    () => collect(state, { policy: trustedPolicy }),
    'APPROVAL_GITHUB_RULESET_MISMATCH',
  );
});

test('F3 ruleset ref include/exclude is exact, closed, and part of TOCTOU identity', async (t) => {
  await t.test('post-read default-branch exclusion drift', async () => {
    const state = fixtureState();
    state.postRuleset = structuredClone(state.ruleset);
    state.postRuleset.conditions.ref_name.exclude = ['refs/heads/main'];
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_HEAD_DRIFT');
  });
  for (const [name, mutate] of [
    ['default excluded', (state) => { state.ruleset.conditions.ref_name.exclude = ['refs/heads/main']; }],
    ['include glob', (state) => { state.ruleset.conditions.ref_name.include.push('refs/heads/*'); }],
    ['include alias', (state) => { state.ruleset.conditions.ref_name.include.push('refs/heads/main'); }],
    ['extra exclusion', (state) => { state.ruleset.conditions.ref_name.exclude.push('refs/heads/release'); }],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      mutate(state);
      await expectCode(() => collect(state), 'APPROVAL_GITHUB_RULESET_MISMATCH');
    });
  }
});

test('F4 requested CODEOWNER review must be the canonical latest actor event', async (t) => {
  for (const [name, event] of [
    ['later changes requested', (state) => codeownerEvent(state)],
    ['later dismissed', (state) => codeownerEvent(state, { state: 'DISMISSED' })],
    ['same-time higher ID reversal', (state) => codeownerEvent(state, {
      submitted_at: state.reviewPages[1][2].submitted_at,
    })],
    ['malformed later timestamp', (state) => codeownerEvent(state, { submitted_at: 'not-an-instant' })],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      state.reviewPages[1].push(event(state));
      await expectCode(() => collect(state), 'APPROVAL_CODEOWNER_REVIEW_REQUIRED');
    });
  }
});

test('F5 review pagination requires exact next page/query and globally unique raw IDs', async (t) => {
  await t.test('page jump', async () => {
    const state = fixtureState();
    forceFirstReviewLink(state, (next) => next.searchParams.set('page', '3'));
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_PAGINATION_INVALID');
  });
  for (const key of ['page', 'per_page']) {
    await t.test(`duplicate ${key} query`, async () => {
      const state = fixtureState();
      forceFirstReviewLink(state, (next) => {
        next.searchParams.set('page', '2');
        next.searchParams.append(key, key === 'page' ? '3' : '99');
      });
      await expectCode(() => collect(state), 'APPROVAL_GITHUB_PAGINATION_INVALID');
    });
  }
  await t.test('duplicate review ID across pages', async () => {
    const state = fixtureState();
    state.reviewPages[1][1].id = state.reviewPages[0][0].id;
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_PAGINATION_INVALID');
  });
  await t.test('duplicate page content', async () => {
    const state = fixtureState();
    state.reviewPages[1] = structuredClone(state.reviewPages[0]);
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_PAGINATION_INVALID');
  });
});

test('F6 proposal schemas reject extra PR-controlled fields before public projection', async (t) => {
  for (const blobSha of [PROPOSAL_MANIFEST_BLOB_SHA, PROPOSAL_SIDECAR_BLOB_SHA]) {
    await t.test(blobSha === PROPOSAL_MANIFEST_BLOB_SHA ? 'manifest extra key' : 'sidecar extra key', async () => {
      const state = fixtureState();
      const blob = state.blobs.get(blobSha);
      const value = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
      value.padding = 'PR free-form must not escape';
      state.blobs.set(blobSha, { sha: blobSha, ...encodeBlob(JSON.stringify(value)) });
      await expectCode(() => collect(state), 'APPROVAL_GITHUB_PROPOSAL_MISMATCH');
    });
  }
});

test('F1 invalid caller objects stay rejected by the public facade', async () => {
  const state = fixtureState();
  const fixture = fixtureFetch(state);
  const client = createGitHubReadbackClient({
    fetch: fixture.fetch,
    token: AUTH_SENTINEL,
    apiVersion: API_VERSION,
  });
  const invalidRequest = request();
  invalidRequest.repository = { ...invalidRequest.repository, extra: true };
  await expectCode(
    () => collectGitHubApprovalEvidence(client, invalidRequest, limits(), policy()),
    'APPROVAL_GITHUB_REQUEST_INVALID',
  );
  assert.equal(fixture.calls.length, 0);
});
