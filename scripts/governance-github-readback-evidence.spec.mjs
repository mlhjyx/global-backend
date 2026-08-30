import assert from 'node:assert/strict';
import test from 'node:test';

import { parseApprovalJson } from './governance-github-readback-common.mjs';
import {
  collectGitHubApprovalEvidence,
  createGitHubReadbackClient,
} from './governance-github-readback.mjs';
import {
  API_VERSION,
  AUTH_SENTINEL,
  OTHER_SHA,
  PROPOSAL_MANIFEST_BLOB_SHA,
  SIGNER_BLOB_SHA,
  SIGNER_PATH,
  WORKFLOW_BLOB_SHA,
  WORKFLOW_PATH,
  actor,
  collect,
  commandLine,
  encodeBlob,
  expectCode,
  fixtureFetch,
  fixtureState,
  limits,
  policy,
  request,
  review,
} from './fixtures/approval-readback/task5-github-readback-fixture.mjs';

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
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_PAGINATION_INVALID');
  });
});

test('rejects duplicate checks and weak name, URL, path, or slug-only claims', async (t) => {
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

test('binds dynamic IDs to exact App, workflow, run, base blob, and signer identities', async (t) => {
  for (const [name, mutate] of [
    ['App ID', (state) => { state.checkPages[0][0].app.id = 999; }],
    ['suite head', (state) => { state.checkSuites.get(71001).head_sha = OTHER_SHA; }],
    ['run suite', (state) => { state.actionRunPages[0][0].check_suite_id = 999; }],
    ['workflow ID/path', (state) => { state.workflows.get(61001).path = '.github/workflows/other.yml'; }],
    ['run event', (state) => { state.actionRunPages[0][0].event = 'pull_request'; }],
    ['run head', (state) => { state.actionRunPages[0][0].head_sha = OTHER_SHA; }],
    ['run conclusion', (state) => { state.actionRunPages[0][0].conclusion = 'failure'; }],
    ['run attempt', (state) => { state.actionRunPages[0][0].run_attempt = 0; }],
    ['signer workflow ID', (state) => { state.actionRunPages[0][0].referenced_workflows[0].workflow_id = 999; }],
    ['signer blob SHA', (state) => { state.actionRunPages[0][0].referenced_workflows[0].sha = OTHER_SHA; }],
    ['base workflow mode', (state) => { state.baseTree.tree[1].mode = '100755'; }],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      mutate(state);
      await expectCode(() => collect(state), 'APPROVAL_CHECK_WORKFLOW_MISMATCH');
    });
  }
});

test('rejects cross-pair recombination inside multi-entry static tuple allowlists', async (t) => {
  const addBasePaths = (state) => {
    state.baseTree.tree.push(
      { path: '.github/workflows/other.yml', mode: '100644', type: 'blob', sha: WORKFLOW_BLOB_SHA },
      { path: '.github/workflows/other-signer.yml', mode: '100644', type: 'blob', sha: SIGNER_BLOB_SHA },
    );
  };
  await t.test('workflow tuple', async () => {
    const state = fixtureState();
    addBasePaths(state);
    const unsafe = policy();
    unsafe.allowedCheckContexts = ['approval/readback', 'other/context'];
    unsafe.allowedActionsAppIds = [15368, 999];
    unsafe.allowedWorkflowIds = [999, 61001];
    unsafe.allowedWorkflowPaths = [WORKFLOW_PATH, '.github/workflows/other.yml'];
    unsafe.allowedReusableSignerWorkflowIds = [61002, 999];
    unsafe.allowedReusableSignerWorkflowPaths = [SIGNER_PATH, '.github/workflows/other-signer.yml'];
    await expectCode(() => collect(state, { policy: unsafe }), 'APPROVAL_CHECK_WORKFLOW_MISMATCH');
  });
  await t.test('signer tuple', async () => {
    const state = fixtureState();
    addBasePaths(state);
    const unsafe = policy();
    unsafe.allowedCheckContexts = ['approval/readback', 'other/context'];
    unsafe.allowedActionsAppIds = [15368, 999];
    unsafe.allowedWorkflowIds = [61001, 999];
    unsafe.allowedWorkflowPaths = [WORKFLOW_PATH, '.github/workflows/other.yml'];
    unsafe.allowedReusableSignerWorkflowIds = [999, 61002];
    unsafe.allowedReusableSignerWorkflowPaths = [SIGNER_PATH, '.github/workflows/other-signer.yml'];
    await expectCode(() => collect(state, { policy: unsafe }), 'APPROVAL_CHECK_WORKFLOW_MISMATCH');
  });
});

test('normalizes authority identities without forwarding free-form authority fields', async () => {
  const state = fixtureState();
  const blob = state.blobs.get('4'.repeat(40));
  const authority = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
  authority.private_notes = 'authority-free-form-must-not-escape';
  authority.roles[0].free_text = 'role-free-form-must-not-escape';
  state.blobs.set('4'.repeat(40), { sha: '4'.repeat(40), ...encodeBlob(JSON.stringify(authority)) });
  const { evidence } = await collect(state);
  const retained = JSON.stringify(evidence.authority_file);
  assert.equal(retained.includes('authority-free-form'), false);
  assert.equal(retained.includes('role-free-form'), false);
});

test('rejects executable, symlink, gitlink, tree, and absent proposal entries', async (t) => {
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

test('enforces blob identity, 1 MiB, LFS, fatal UTF-8, and strict JSON', async (t) => {
  await t.test('strict parser accepts exactly 1 MiB of valid JSON', () => {
    const value = { schema_version: 'parser-boundary/v1' };
    value.padding = '';
    const empty = Buffer.from(JSON.stringify(value), 'utf8');
    value.padding = 'x'.repeat(1_048_576 - empty.length);
    const bytes = Buffer.from(JSON.stringify(value), 'utf8');
    assert.equal(bytes.length, 1_048_576);
    assert.equal(parseApprovalJson(bytes.toString('utf8')).padding.length > 0, true);
  });
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

test('detects PR, tree, trusted workflow, and ruleset pre/post drift', async (t) => {
  for (const [name, mutate] of [
    ['PR', (state) => { state.postPullRequest = structuredClone(state.pullRequest); state.postPullRequest.head.sha = OTHER_SHA; }],
    ['proposal', (state) => { state.postHeadTree = structuredClone(state.headTree); state.postHeadTree.tree[0].sha = OTHER_SHA; }],
    ['workflow', (state) => { state.postBaseTree = structuredClone(state.baseTree); state.postBaseTree.tree[1].sha = OTHER_SHA; }],
    ['ruleset', (state) => { state.postRuleset = structuredClone(state.ruleset); state.postRuleset.enforcement = 'disabled'; }],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      mutate(state);
      await expectCode(() => collect(state), 'APPROVAL_GITHUB_HEAD_DRIFT');
    });
  }
});

test('requires ruleset and commit-associated PR identity', async (t) => {
  await t.test('commit association', async () => {
    const state = fixtureState();
    state.associatedPulls = [];
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_PR_ASSOCIATION_MISMATCH');
  });
  for (const [name, mutate] of [
    ['context', (state) => { state.ruleset.rules[0].parameters.required_status_checks[0].context = 'other/context'; }],
    ['bypass', (state) => { state.ruleset.bypass_actors = [{ actor_id: 999, actor_type: 'RepositoryRole', bypass_mode: 'always' }]; }],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      mutate(state);
      await expectCode(() => collect(state), 'APPROVAL_GITHUB_RULESET_MISMATCH');
    });
  }
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
    const client = createGitHubReadbackClient({ fetch: fixture.fetch, token: AUTH_SENTINEL, apiVersion: API_VERSION });
    await expectCode(
      () => collectGitHubApprovalEvidence(client, request(state), unsafeLimits, policy()),
      'APPROVAL_GITHUB_LIMIT_INVALID',
    );
    assert.equal(fixture.calls.length, 0);
  }
});
