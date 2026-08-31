import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import * as approvalState from './governance-approval-state.mjs';
import { deepFreeze } from './governance-approval-readback-common.mjs';
import { planApprovalStateTransition } from './governance-approval-state-kernel.mjs';
import { buildStoredReceiptRevocationEvent } from './governance-approval-state-revocation.mjs';
import {
  NOW,
  REVOCATION_NOW,
  approvalPolicy,
  buildRound4AcceptedState,
  buildStateFromEvents,
  buildSyntheticApprovalStateKernelInput,
  digest,
  revocationEvent,
} from './fixtures/approval-readback/merge-authorization/task4-round4-state-fixture.mjs';

const clone = (value) => structuredClone(value);
const projectStateForKernel = ({
  eventHistory: _eventHistory,
  policySnapshot: _policySnapshot,
  ...state
}) => state;
const appendRevocation = (state, policy, event, now = REVOCATION_NOW) => {
  const storedEvent = buildStoredReceiptRevocationEvent(
    event,
    state,
    policy,
    now.toISOString(),
  );
  const plan = planApprovalStateTransition({
    currentProjection: projectStateForKernel(state),
    event: storedEvent,
    policySnapshot: policy,
    observedAt: now.toISOString(),
  });
  return deepFreeze({
    ...plan.nextProjection,
    eventHistory: [...state.eventHistory, storedEvent],
    policySnapshot: clone(policy),
  });
};

const append = (state, event, policy, now, receiptCapability) => (
  approvalState.appendApprovalDecisionEvent(
    state,
    {
      schemaVersion: 'approval-event-append/v1',
      expectedHistorySha256: digest(state.eventHistory),
      appendedAt: now.toISOString(),
      event,
    },
    policy,
    now,
    receiptCapability,
  )
);

const holdSummary = (state) => ({
  state: state.state,
  evidenceTrustState: state.evidenceTrustState,
  blockingCodes: state.blockingCodes,
  eventCount: state.eventHistory.length,
  repository: state.repository,
});

const expectedHold = (code) => ({
  state: 'OWNER_ASSIGNMENT_REQUIRED',
  evidenceTrustState: 'EXTERNAL_UNVERIFIED',
  blockingCodes: [code],
  eventCount: 0,
  repository: { id: 1291151138, fullName: 'mlhjyx/global-backend' },
});

const capturePolicyInitialization = (policy) => {
  try {
    approvalState.initializeApprovalDecisionState(policy, NOW);
    return 'UNSAFE_ADMISSION';
  } catch (error) {
    return error instanceof RangeError ? 'RangeError' : error.message;
  }
};

test('round5 pure state plan is deterministic and cannot mint a privately admitted history', async () => {
  const { planApprovalStateTransition } = await import('./governance-approval-state-kernel.mjs');
  const input = buildSyntheticApprovalStateKernelInput();
  const before = clone(input);
  const first = planApprovalStateTransition(input);
  const second = planApprovalStateTransition(clone(input));
  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
  assert.equal(first.schemaVersion, 'approval-state-transition-plan/v1');
  assert.equal(Object.hasOwn(first, 'eventHistory'), false);
  assert.equal(Object.hasOwn(first.nextProjection, 'eventHistory'), false);
  assert.equal(Object.hasOwn(first.nextProjection, 'policySnapshot'), false);

  const callerHistory = [clone(input.event)];
  const publicResult = approvalState.reduceApprovalDecisionState(
    callerHistory,
    clone(input.policySnapshot),
    NOW,
  );
  assert.deepEqual(
    holdSummary(publicResult),
    expectedHold('APPROVAL_STATE_HISTORY_NOT_ADMITTED'),
  );
});

test('round5 admitted history is bound to one closed policy snapshot and mismatch cannot alter status', () => {
  const { accepted, policy } = buildRound4AcceptedState();
  const admitted = buildStateFromEvents([
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
    {
      type: 'PROPOSAL_RENDERED',
      headSha: policy.currentHeadSha,
      observedAt: '2026-08-30T07:10:00.000Z',
    },
    {
      type: 'PRODUCT_REVIEW_VERIFIED',
      headSha: policy.currentHeadSha,
      observedAt: '2026-08-30T07:20:00.000Z',
    },
  ], policy, NOW);
  const replacement = clone(policy);
  replacement.repository.fullName = 'attacker/false-repository';

  const reduced = approvalState.reduceApprovalDecisionState(
    admitted.eventHistory,
    replacement,
    NOW,
  );
  assert.deepEqual(holdSummary(reduced), expectedHold('APPROVAL_STATE_POLICY_MISMATCH'));
  assert.equal(reduced.policySnapshot.repository.fullName, policy.repository.fullName);
  assert.equal(Object.isFrozen(accepted.policySnapshot), true);
  assert.equal(Object.isFrozen(accepted.policySnapshot.repository), true);
  assert.equal(Object.isFrozen(accepted.policySnapshot.acceptanceAllowlist), true);
  assert.equal(accepted.policySnapshot.acceptanceAllowlist.every(Object.isFrozen), true);
  assert.equal(
    approvalState.renderApprovalStatusReadModel(reduced).repository.fullName,
    policy.repository.fullName,
  );

  const appendMismatch = append(
    admitted,
    { type: 'HEAD_CHANGED', headSha: 'c'.repeat(40), observedAt: REVOCATION_NOW.toISOString() },
    replacement,
    REVOCATION_NOW,
  );
  assert.deepEqual(
    holdSummary(appendMismatch),
    expectedHold('APPROVAL_STATE_POLICY_MISMATCH'),
  );

  const revoked = appendRevocation(accepted, clone(policy), revocationEvent());
  assert.equal(revoked.state, 'REVOKED');
  assert.deepEqual(
    holdSummary(approvalState.reduceApprovalDecisionState(
      revoked.eventHistory,
      clone(policy),
      REVOCATION_NOW,
    )),
    expectedHold('APPROVAL_STATE_HISTORY_NOT_ADMITTED'),
  );
});

test('round5 successful append consumes exactly one parent and cannot mint contradictory branches', () => {
  const policy = approvalPolicy();
  const parent = buildStateFromEvents([
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
    {
      type: 'PROPOSAL_RENDERED',
      headSha: policy.currentHeadSha,
      observedAt: '2026-08-30T07:10:00.000Z',
    },
  ], policy, NOW);
  const privacyReview = append(parent, {
    type: 'PRODUCT_REVIEW_VERIFIED',
    headSha: policy.currentHeadSha,
    observedAt: '2026-08-30T07:20:00.000Z',
  }, policy, new Date('2026-08-30T07:20:00.000Z'));
  assert.equal(privacyReview.state, 'AWAITING_PRIVACY_REVIEW');

  const rejectedBranch = append(parent, {
    type: 'REVIEW_REJECTED',
    observedAt: NOW.toISOString(),
  }, policy, NOW);
  assert.deepEqual(
    holdSummary(rejectedBranch),
    expectedHold('APPROVAL_STATE_HISTORY_CONSUMED'),
  );
  assert.deepEqual(
    holdSummary(approvalState.reduceApprovalDecisionState(parent.eventHistory, policy, NOW)),
    expectedHold('APPROVAL_STATE_HISTORY_CONSUMED'),
  );
  assert.equal(
    approvalState.reduceApprovalDecisionState(privacyReview.eventHistory, policy, NOW).state,
    'AWAITING_PRIVACY_REVIEW',
  );
});

test('round5 rejected and revoked revisions stay terminal until a replacement policy starts a new root', () => {
  const policy = approvalPolicy();
  const rejected = buildStateFromEvents([
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
    {
      type: 'PROPOSAL_RENDERED',
      headSha: policy.currentHeadSha,
      observedAt: '2026-08-30T07:10:00.000Z',
    },
    { type: 'REVIEW_REJECTED', observedAt: '2026-08-30T07:11:00.000Z' },
  ], policy, NOW);
  const reassignment = {
    type: 'AUTHORITIES_ASSIGNED',
    observedAt: '2026-08-30T08:32:00.000Z',
  };

  assert.throws(
    () => append(rejected, reassignment, policy, new Date(reassignment.observedAt)),
    /APPROVAL_STATE_TRANSITION_INVALID/,
  );
  assert.equal(
    approvalState.reduceApprovalDecisionState(rejected.eventHistory, policy, NOW).state,
    'REJECTED',
  );

  const { accepted } = buildRound4AcceptedState();
  const revoked = appendRevocation(accepted, policy, revocationEvent(), REVOCATION_NOW);
  const retained = {
    receipt: clone(revoked.receipt),
    mergeAuthorization: clone(revoked.mergeAuthorization),
    evidenceTrustState: revoked.evidenceTrustState,
  };

  assert.throws(
    () => planApprovalStateTransition({
      currentProjection: projectStateForKernel(revoked),
      event: reassignment,
      policySnapshot: policy,
      observedAt: reassignment.observedAt,
    }),
    /APPROVAL_STATE_TRANSITION_INVALID/,
  );
  assert.deepEqual({
    state: revoked.state,
    revocationStatus: revoked.revocationStatus,
    receipt: revoked.receipt,
    mergeAuthorization: revoked.mergeAuthorization,
    evidenceTrustState: revoked.evidenceTrustState,
  }, {
    state: 'REVOKED',
    revocationStatus: 'REVOKED',
    ...retained,
  });

  const replacementPolicy = clone(policy);
  replacementPolicy.policyRevision = 'program-c/policy-r2';
  const replacement = approvalState.initializeApprovalDecisionState(
    replacementPolicy,
    new Date(reassignment.observedAt),
  );
  assert.equal(replacement.state, 'OWNER_ASSIGNMENT_REQUIRED');
  assert.equal(replacement.policySnapshot.policyRevision, 'program-c/policy-r2');
  assert.equal(replacement.receipt, null);
  assert.equal(replacement.mergeAuthorization, null);
  assert.equal(replacement.evidenceTrustState, 'EXTERNAL_UNVERIFIED');
});

test('round5 failed append leaves its parent active and each initializer mints an independent root', () => {
  const policy = approvalPolicy();
  const rootTime = new Date('2026-08-30T07:05:00.000Z');
  const firstRoot = approvalState.initializeApprovalDecisionState(policy, rootTime);
  const secondRoot = approvalState.initializeApprovalDecisionState(clone(policy), rootTime);
  assert.notEqual(firstRoot.eventHistory, secondRoot.eventHistory);

  assert.throws(
    () => approvalState.appendApprovalDecisionEvent(firstRoot, {
      schemaVersion: 'approval-event-append/v1',
      expectedHistorySha256: `sha256:${'0'.repeat(64)}`,
      appendedAt: rootTime.toISOString(),
      event: { type: 'AUTHORITIES_ASSIGNED', observedAt: rootTime.toISOString() },
    }, policy, rootTime),
    /APPROVAL_STATE_APPEND_INVALID/,
  );

  const firstProposed = append(firstRoot, {
    type: 'AUTHORITIES_ASSIGNED',
    observedAt: rootTime.toISOString(),
  }, policy, rootTime);
  const secondProposed = append(secondRoot, {
    type: 'AUTHORITIES_ASSIGNED',
    observedAt: rootTime.toISOString(),
  }, clone(policy), rootTime);
  assert.deepEqual([firstProposed.state, secondProposed.state], ['PROPOSED', 'PROPOSED']);
});

test('round5 failed privileged append preserves parent for a safe append', () => {
  const policy = approvalPolicy();
  const privacy = buildStateFromEvents([
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
    {
      type: 'PROPOSAL_RENDERED',
      headSha: policy.currentHeadSha,
      observedAt: '2026-08-30T07:10:00.000Z',
    },
    {
      type: 'PRODUCT_REVIEW_VERIFIED',
      headSha: policy.currentHeadSha,
      observedAt: '2026-08-30T07:20:00.000Z',
    },
  ], policy, NOW);
  const parentSnapshot = clone(privacy);
  const receiptEvent = clone(buildSyntheticApprovalStateKernelInput({
    transition: 'RECEIPT_VERIFIED',
  }).event);
  const receiptTime = new Date(receiptEvent.observedAt);
  let privilegedOutcome;
  try {
    privilegedOutcome = append(
      privacy,
      receiptEvent,
      policy,
      receiptTime,
      Object.freeze({ kind: 'caller-declared-receipt-verification' }),
    ).state;
  } catch (error) {
    privilegedOutcome = error.message;
  }
  const parentStateAfterFailure = approvalState.reduceApprovalDecisionState(
    privacy.eventHistory,
    policy,
    receiptTime,
  ).state;
  const headChangedAt = new Date('2026-08-30T08:26:00.000Z');
  const safeAppend = append(privacy, {
    type: 'HEAD_CHANGED',
    headSha: 'c'.repeat(40),
    observedAt: headChangedAt.toISOString(),
  }, policy, headChangedAt);

  assert.deepEqual({
    privilegedOutcome,
    parentStateAfterFailure,
    safeAppendState: safeAppend.state,
  }, {
    privilegedOutcome: 'APPROVAL_INDEPENDENCE_NOT_PROVEN',
    parentStateAfterFailure: 'AWAITING_PRIVACY_REVIEW',
    safeAppendState: 'STALE_AFTER_PUSH',
  });
  assert.deepEqual(privacy, parentSnapshot);
});

test('round5 append rejects accessor reentry without invoking it or consuming the parent', () => {
  const policy = approvalPolicy();
  const rootTime = new Date('2026-08-30T07:05:00.000Z');
  const root = approvalState.initializeApprovalDecisionState(policy, rootTime);
  const accessorPolicy = clone(policy);
  let accessorCalls = 0;
  let reentrantState = null;
  Object.defineProperty(accessorPolicy, 'decisionRevision', {
    enumerable: true,
    get() {
      accessorCalls += 1;
      reentrantState = append(root, {
        type: 'AUTHORITIES_ASSIGNED',
        observedAt: rootTime.toISOString(),
      }, policy, rootTime);
      return policy.decisionRevision;
    },
  });

  const outer = append(root, {
    type: 'AUTHORITIES_ASSIGNED',
    observedAt: rootTime.toISOString(),
  }, accessorPolicy, rootTime);
  assert.deepEqual(holdSummary(outer), expectedHold('APPROVAL_STATE_POLICY_MISMATCH'));
  assert.equal(accessorCalls, 0);
  assert.equal(reentrantState, null);

  const proposed = append(root, {
    type: 'AUTHORITIES_ASSIGNED',
    observedAt: rootTime.toISOString(),
  }, policy, rootTime);
  assert.equal(proposed.state, 'PROPOSED');
});

test('round5 in-progress capability prevents proxy reentry from minting a sibling', () => {
  const policy = approvalPolicy();
  const rootTime = new Date('2026-08-30T07:05:00.000Z');
  const root = approvalState.initializeApprovalDecisionState(policy, rootTime);
  const event = { type: 'AUTHORITIES_ASSIGNED', observedAt: rootTime.toISOString() };
  let reentrantState = null;
  let reentered = false;
  const proxyPolicy = new Proxy(clone(policy), {
    ownKeys(target) {
      if (!reentered) {
        reentered = true;
        reentrantState = append(root, event, policy, rootTime);
      }
      return Reflect.ownKeys(target);
    },
  });

  const proposed = append(root, event, proxyPolicy, rootTime);
  assert.equal(proposed.state, 'PROPOSED');
  assert.deepEqual(
    holdSummary(reentrantState),
    expectedHold('APPROVAL_STATE_HISTORY_CONSUMED'),
  );
  assert.deepEqual(
    holdSummary(approvalState.reduceApprovalDecisionState(root.eventHistory, policy, rootTime)),
    expectedHold('APPROVAL_STATE_HISTORY_CONSUMED'),
  );
});

test('round5 initializer rejects unsafe, oversized, incomplete, and unknown policy before admission', () => {
  const cyclic = approvalPolicy();
  cyclic.untrusted = cyclic;

  const deep = approvalPolicy();
  deep.untrusted = {};
  let cursor = deep.untrusted;
  for (let index = 0; index < 40; index += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }

  const hugeGraph = approvalPolicy();
  hugeGraph.untrusted = Array.from({ length: 2_100 }, () => ({}));

  const unknown = approvalPolicy();
  unknown.untrusted = 'caller-unknown-policy-field';

  const nestedUnknown = approvalPolicy();
  nestedUnknown.repository.untrusted = true;

  const incomplete = approvalPolicy();
  delete incomplete.requiredMachineChecks;

  const symbolUnknown = approvalPolicy();
  symbolUnknown[Symbol('untrusted')] = true;

  const hiddenUnknown = approvalPolicy();
  Object.defineProperty(hiddenUnknown, 'untrusted', { value: true });

  const arrayUnknown = approvalPolicy();
  arrayUnknown.acceptanceAllowlist.untrusted = true;

  const sparseArray = approvalPolicy();
  delete sparseArray.acceptanceAllowlist[0];

  const asciiOversize = approvalPolicy();
  asciiOversize.repository.fullName = `owner/${'a'.repeat(33_000)}`;

  const multibyteOversize = approvalPolicy();
  multibyteOversize.repository.fullName = `owner/${'界'.repeat(11_000)}`;

  assert.deepEqual({
    cyclic: capturePolicyInitialization(cyclic),
    deep: capturePolicyInitialization(deep),
    hugeGraph: capturePolicyInitialization(hugeGraph),
    unknown: capturePolicyInitialization(unknown),
    nestedUnknown: capturePolicyInitialization(nestedUnknown),
    incomplete: capturePolicyInitialization(incomplete),
    symbolUnknown: capturePolicyInitialization(symbolUnknown),
    hiddenUnknown: capturePolicyInitialization(hiddenUnknown),
    arrayUnknown: capturePolicyInitialization(arrayUnknown),
    sparseArray: capturePolicyInitialization(sparseArray),
    asciiOversize: capturePolicyInitialization(asciiOversize),
    multibyteOversize: capturePolicyInitialization(multibyteOversize),
  }, {
    cyclic: 'APPROVAL_STATE_POLICY_GRAPH_INVALID',
    deep: 'APPROVAL_STATE_POLICY_GRAPH_INVALID',
    hugeGraph: 'APPROVAL_STATE_POLICY_GRAPH_INVALID',
    unknown: 'APPROVAL_STATE_POLICY_INVALID',
    nestedUnknown: 'APPROVAL_STATE_POLICY_INVALID',
    incomplete: 'APPROVAL_STATE_POLICY_INVALID',
    symbolUnknown: 'APPROVAL_STATE_POLICY_INVALID',
    hiddenUnknown: 'APPROVAL_STATE_POLICY_INVALID',
    arrayUnknown: 'APPROVAL_STATE_POLICY_INVALID',
    sparseArray: 'APPROVAL_STATE_POLICY_INVALID',
    asciiOversize: 'APPROVAL_STATE_POLICY_OVERSIZE',
    multibyteOversize: 'APPROVAL_STATE_POLICY_OVERSIZE',
  });
});

test('round5 cloned, JSON, and duplicate-module histories still remain external HOLD', async () => {
  const { accepted, policy } = buildRound4AcceptedState();
  const outcomes = [
    approvalState.reduceApprovalDecisionState(clone(accepted.eventHistory), policy, NOW),
    approvalState.reduceApprovalDecisionState(
      JSON.parse(JSON.stringify(accepted.eventHistory)),
      policy,
      NOW,
    ),
  ].map(holdSummary);
  assert.deepEqual(outcomes, Array.from(
    { length: 2 },
    () => expectedHold('APPROVAL_STATE_HISTORY_NOT_ADMITTED'),
  ));

  const stateUrl = new URL('./governance-approval-state.mjs', import.meta.url);
  const duplicateDirectory = await mkdtemp(join(tmpdir(), 'approval-state-round5-'));
  try {
    const source = await readFile(stateUrl, 'utf8');
    const duplicateSource = source.replace(
      /from '(\.\/[^']+)'/g,
      (_match, specifier) => `from ${JSON.stringify(new URL(specifier, stateUrl).href)}`,
    );
    const duplicatePath = join(duplicateDirectory, 'governance-approval-state-duplicate.mjs');
    await writeFile(duplicatePath, duplicateSource, { encoding: 'utf8', flag: 'wx' });
    const duplicateModule = await import(pathToFileURL(duplicatePath).href);
    const duplicate = duplicateModule.reduceApprovalDecisionState(
      accepted.eventHistory,
      policy,
      NOW,
    );
    assert.deepEqual(
      holdSummary(duplicate),
      expectedHold('APPROVAL_STATE_HISTORY_NOT_ADMITTED'),
    );
  } finally {
    await rm(duplicateDirectory, { recursive: true });
  }
});
