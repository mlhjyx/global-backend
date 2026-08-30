import assert from 'node:assert/strict';
import test from 'node:test';

import * as approvalState from './governance-approval-state.mjs';
import {
  NOW,
  REVOCATION_NOW,
  appendRevocation,
  approvalPolicy,
  buildRound4AcceptedState,
  buildStateFromEvents,
  digest,
  revocationEvent,
} from './fixtures/approval-readback/merge-authorization/task4-round4-state-fixture.mjs';

const clone = (value) => structuredClone(value);

const append = (state, event, policy, now) => approvalState.appendApprovalDecisionEvent(
  state,
  {
    schemaVersion: 'approval-event-append/v1',
    expectedHistorySha256: digest(state.eventHistory),
    appendedAt: now.toISOString(),
    event,
  },
  policy,
  now,
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

test('round5 admitted history is bound to one closed policy snapshot and mismatch cannot alter status', () => {
  const { accepted, policy } = buildRound4AcceptedState();
  const replacement = clone(policy);
  replacement.repository.fullName = 'attacker/false-repository';

  const reduced = approvalState.reduceApprovalDecisionState(
    accepted.eventHistory,
    replacement,
    NOW,
  );
  assert.deepEqual(holdSummary(reduced), expectedHold('APPROVAL_STATE_POLICY_MISMATCH'));
  assert.equal(reduced.policySnapshot.repository.fullName, policy.repository.fullName);
  assert.equal(
    approvalState.renderApprovalStatusReadModel(reduced).repository.fullName,
    policy.repository.fullName,
  );

  const appendMismatch = append(
    accepted,
    revocationEvent(),
    replacement,
    REVOCATION_NOW,
  );
  assert.deepEqual(
    holdSummary(appendMismatch),
    expectedHold('APPROVAL_STATE_POLICY_MISMATCH'),
  );

  const revoked = appendRevocation(accepted, clone(policy), revocationEvent());
  assert.equal(revoked.state, 'REVOKED');
  assert.equal(
    approvalState.reduceApprovalDecisionState(revoked.eventHistory, clone(policy), REVOCATION_NOW).state,
    'REVOKED',
  );
});

test('round5 successful append consumes exactly one parent and cannot mint contradictory branches', () => {
  const { evidence, policy, verified } = buildRound4AcceptedState();
  const parent = buildStateFromEvents(verified.eventHistory, policy, NOW);
  const accepted = append(parent, {
    type: 'ACCEPTANCE_REVALIDATED',
    evidence: clone(evidence),
    observedAt: evidence.readAt,
  }, policy, NOW);
  assert.equal(accepted.state, 'ACCEPTED');

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
    approvalState.reduceApprovalDecisionState(accepted.eventHistory, policy, NOW).state,
    'ACCEPTED',
  );
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
    asciiOversize: capturePolicyInitialization(asciiOversize),
    multibyteOversize: capturePolicyInitialization(multibyteOversize),
  }, {
    cyclic: 'APPROVAL_STATE_POLICY_GRAPH_INVALID',
    deep: 'APPROVAL_STATE_POLICY_GRAPH_INVALID',
    hugeGraph: 'APPROVAL_STATE_POLICY_GRAPH_INVALID',
    unknown: 'APPROVAL_STATE_POLICY_INVALID',
    nestedUnknown: 'APPROVAL_STATE_POLICY_INVALID',
    incomplete: 'APPROVAL_STATE_POLICY_INVALID',
    asciiOversize: 'APPROVAL_STATE_POLICY_OVERSIZE',
    multibyteOversize: 'APPROVAL_STATE_POLICY_OVERSIZE',
  });
});

test('round5 cloned, JSON, and duplicate-module histories still remain external HOLD', async () => {
  const { accepted, policy } = buildRound4AcceptedState();
  const duplicateModule = await import(
    new URL('./governance-approval-state.mjs?round5-duplicate-module', import.meta.url)
  );
  const outcomes = [
    approvalState.reduceApprovalDecisionState(clone(accepted.eventHistory), policy, NOW),
    approvalState.reduceApprovalDecisionState(
      JSON.parse(JSON.stringify(accepted.eventHistory)),
      policy,
      NOW,
    ),
    duplicateModule.reduceApprovalDecisionState(accepted.eventHistory, policy, NOW),
  ].map(holdSummary);
  assert.deepEqual(outcomes, Array.from(
    { length: 3 },
    () => expectedHold('APPROVAL_STATE_HISTORY_NOT_ADMITTED'),
  ));
});
