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
  BASE_SHA,
  HEAD_SHA,
  OTHER_SHA,
  PROPOSAL_MANIFEST_BLOB_SHA,
  PROPOSAL_SIDECAR_BLOB_SHA,
  REPOSITORY_ID,
  canonicalProposalSidecarBytes,
  SIGNER_BLOB_SHA,
  SIGNER_PATH,
  WORKFLOW_BLOB_SHA,
  WORKFLOW_PATH,
  actor,
  collect,
  commandLine,
  digest,
  encodeBlob,
  expectCode,
  fixtureFetch,
  fixtureState,
  limits,
  mutateAuthorityRole,
  policy,
  request,
  review,
} from './fixtures/approval-readback/task5-github-readback-fixture.mjs';

const replaceProposalManifest = (state, mutate) => {
  const blob = state.blobs.get(PROPOSAL_MANIFEST_BLOB_SHA);
  const value = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
  mutate(value);
  state.blobs.set(PROPOSAL_MANIFEST_BLOB_SHA, {
    sha: PROPOSAL_MANIFEST_BLOB_SHA,
    ...encodeBlob(`${JSON.stringify(value)}\n`),
  });
};

const replaceProposalSidecar = (state, bytes, { bindManifest = false } = {}) => {
  state.blobs.set(PROPOSAL_SIDECAR_BLOB_SHA, {
    sha: PROPOSAL_SIDECAR_BLOB_SHA,
    ...encodeBlob(bytes),
  });
  if (bindManifest) {
    replaceProposalManifest(state, (value) => {
      value.proposed_sidecar_byte_length = bytes.length;
      value.proposed_sidecar_raw_sha256 = digest(bytes);
    });
  }
};

test('pull_request_target binds the PR head separately from its trusted base execution', async () => {
  const state = fixtureState();
  state.actionRunPages[0][0].head_sha = BASE_SHA;
  state.actionRunPages[0][0].pull_requests = [{
    number: 427,
    head: { sha: HEAD_SHA },
    base: { sha: BASE_SHA },
  }];
  state.checkSuites.get(71001).head_sha = BASE_SHA;
  state.checkPages[0][0].head_sha = BASE_SHA;

  const { calls, evidence } = await collect(state);

  assert.equal(evidence.machine_checks[0].actions_run_head_sha, BASE_SHA);
  const runsRequest = calls.find(({ url }) => new URL(url).pathname.endsWith('/actions/runs'));
  assert.equal(new URL(runsRequest.url).searchParams.has('head_sha'), false);
  assert.equal(calls.some(({ url }) => (
    new URL(url).pathname.endsWith('/check-suites/71001/check-runs')
  )), true);
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
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_PAGINATION_INVALID');
  });
});

test('rejects stale or wrongly scoped hosted authority for every exact review role', async (t) => {
  const wrongPurpose = {
    'OWN-PRODUCT': 'SECURITY_REVIEW',
    'OWN-DATA-PRIVACY': 'QA_EVIDENCE_REVIEW',
    'OWN-QA-EVIDENCE': 'DECISION_REVIEW',
    'OWN-SECURITY': 'DECISION_REVIEW',
  };
  for (const role of [
    'OWN-PRODUCT',
    'OWN-DATA-PRIVACY',
    'OWN-QA-EVIDENCE',
    'OWN-SECURITY',
  ]) {
    for (const [condition, mutate] of [
      ['unassigned', (entry) => {
        entry.status = 'UNASSIGNED';
        for (const field of [
          'actor_id',
          'actor_node_id',
          'actor_login',
          'effective_from',
          'effective_until',
          'scope',
          'assignment_evidence',
          'revocation_status',
          'superseded_by',
        ]) delete entry[field];
      }],
      ['revoked', (entry) => { entry.revocation_status = 'REVOKED'; }],
      ['superseded', (entry) => { entry.superseded_by = 'approval-authorities/r3'; }],
      ['repository mismatch', (entry) => { entry.scope.repository_id = REPOSITORY_ID + 1; }],
      ['decision mismatch', (entry) => { entry.scope.decision_adr = 'ADR-026'; }],
      ['policy mismatch', (entry) => { entry.scope.policy_revision = 'program-c/policy-r3'; }],
      ['purpose mismatch', (entry) => { entry.scope.purpose = wrongPurpose[role]; }],
    ]) {
      await t.test(`${role}: ${condition}`, async () => {
        const state = fixtureState();
        mutateAuthorityRole(state, role, mutate);
        await expectCode(
          () => collect(state),
          'APPROVAL_GITHUB_AUTHORITY_CURRENTNESS_MISMATCH',
        );
      });
    }
  }
});

test('classifies simultaneous hosted repository scope drift as authority currentness', async () => {
  const state = fixtureState();
  for (const role of ['OWN-PRODUCT', 'OWN-DATA-PRIVACY']) {
    mutateAuthorityRole(state, role, (entry) => {
      entry.scope.repository_id = REPOSITORY_ID + 1;
    });
  }

  await expectCode(
    () => collect(state),
    'APPROVAL_GITHUB_AUTHORITY_CURRENTNESS_MISMATCH',
  );
});

test('keeps mixed hosted scope and malformed registry issues on the generic authority code', async () => {
  const state = fixtureState();
  for (const role of ['OWN-PRODUCT', 'OWN-DATA-PRIVACY']) {
    mutateAuthorityRole(state, role, (entry) => {
      entry.scope.repository_id = REPOSITORY_ID + 1;
      if (role === 'OWN-PRODUCT') entry.scope.untrusted_extra = true;
    });
  }

  await expectCode(
    () => collect(state),
    'APPROVAL_GITHUB_AUTHORITY_MISMATCH',
  );
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
    ['run suite', (state) => {
      state.actionRunPages[0][0].check_suite_id = 999;
      state.checkSuites.set(999, { ...structuredClone(state.checkSuites.get(71001)), id: 999 });
    }],
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
    state.workflows.set(999, { id: 999, state: 'active', path: '.github/workflows/other-signer.yml' });
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

test('rejects free-form root and role fields in the closed authority registry', async (t) => {
  for (const [name, mutate] of [
    ['root field', (authority) => { authority.private_notes = 'authority-free-form'; }],
    ['role field', (authority) => { authority.roles[0].free_text = 'role-free-form'; }],
  ]) await t.test(name, async () => {
    const state = fixtureState();
    const blob = state.blobs.get('4'.repeat(40));
    const authority = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
    mutate(authority);
    state.blobs.set('4'.repeat(40), {
      sha: '4'.repeat(40),
      ...encodeBlob(JSON.stringify(authority)),
    });
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_AUTHORITY_MISMATCH');
  });
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
    replaceProposalSidecar(
      state,
      Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:deadbeef\nsize 1\n', 'utf8'),
    );
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_LFS_POINTER_FORBIDDEN');
  });
  await t.test('one byte over 1 MiB', async () => {
    const state = fixtureState();
    const bytes = Buffer.alloc(1_048_577, 0x20);
    replaceProposalSidecar(state, bytes);
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_BLOB_TOO_LARGE');
  });
  await t.test('fatal UTF-8', async () => {
    const state = fixtureState();
    replaceProposalSidecar(state, Buffer.from([0x23, 0x20, 0xff, 0x0a]));
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

test('binds exact Markdown bytes and rejects non-canonical line endings', async (t) => {
  const canonical = canonicalProposalSidecarBytes();
  for (const [name, bytes, bindManifest, code] of [
    ['one changed UTF-8 byte', Buffer.from(canonical).fill(0x58, 2, 3), false, 'APPROVAL_GITHUB_PROPOSAL_MISMATCH'],
    ['one inserted space', Buffer.concat([canonical.subarray(0, -1), Buffer.from(' \n')]), false, 'APPROVAL_GITHUB_PROPOSAL_MISMATCH'],
    ['CRLF instead of LF', Buffer.from(canonical.toString('utf8').replaceAll('\n', '\r\n')), true, 'APPROVAL_GITHUB_PROPOSAL_TEXT_INVALID'],
    ['no terminal newline', canonical.subarray(0, -1), true, 'APPROVAL_GITHUB_PROPOSAL_TEXT_INVALID'],
    ['two terminal newlines', Buffer.concat([canonical, Buffer.from('\n')]), true, 'APPROVAL_GITHUB_PROPOSAL_TEXT_INVALID'],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      replaceProposalSidecar(state, bytes, { bindManifest });
      await expectCode(() => collect(state), code);
    });
  }
});

test('rejects manifest sidecar byte-length and raw-digest drift', async (t) => {
  for (const [name, mutate] of [
    ['byte length', (value) => { value.proposed_sidecar_byte_length += 1; }],
    ['raw digest', (value) => { value.proposed_sidecar_raw_sha256 = `sha256:${'d'.repeat(64)}`; }],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      replaceProposalManifest(state, mutate);
      await expectCode(() => collect(state), 'APPROVAL_GITHUB_PROPOSAL_MISMATCH');
    });
  }
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

test('complete ruleset facts detect review, deletion, and non-fast-forward drift', async (t) => {
  for (const [name, mutate] of [
    ['missing pull request rule', (ruleset) => {
      ruleset.rules = ruleset.rules.filter(({ type }) => type !== 'pull_request');
    }],
    ['missing deletion protection', (ruleset) => {
      ruleset.rules = ruleset.rules.filter(({ type }) => type !== 'deletion');
    }],
    ['missing non-fast-forward protection', (ruleset) => {
      ruleset.rules = ruleset.rules.filter(({ type }) => type !== 'non_fast_forward');
    }],
    ['review-thread resolution disabled', (ruleset) => {
      ruleset.rules.find(({ type }) => type === 'pull_request')
        .parameters.required_review_thread_resolution = false;
    }],
    ['last-push approval drift', (ruleset) => {
      ruleset.rules.find(({ type }) => type === 'pull_request')
        .parameters.require_last_push_approval = true;
    }],
  ]) await t.test(name, async () => {
    const state = fixtureState();
    mutate(state.ruleset);
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
    const client = createGitHubReadbackClient({ fetch: fixture.fetch, token: AUTH_SENTINEL, apiVersion: API_VERSION });
    await expectCode(
      () => collectGitHubApprovalEvidence(client, request(state), unsafeLimits, policy()),
      'APPROVAL_GITHUB_LIMIT_INVALID',
    );
    assert.equal(fixture.calls.length, 0);
  }
});
