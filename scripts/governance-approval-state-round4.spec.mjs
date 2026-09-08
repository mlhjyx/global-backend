import assert from 'node:assert/strict';
import test from 'node:test';

import * as approvalState from './governance-approval-state.mjs';
import { deepFreeze } from './governance-approval-readback-common.mjs';
import { renderApprovalStatusReadModel } from './governance-approval-state.mjs';
import { planApprovalStateTransition } from './governance-approval-state-kernel.mjs';
import {
  buildStoredReceiptRevocationEvent,
  storedReceiptRevocationIssue,
} from './governance-approval-state-revocation.mjs';
import {
  NOW,
  REVOCATION_NOW,
  approvalPolicy,
  buildRound4AcceptedState,
  buildSyntheticApprovalStateKernelInput,
  digest,
  revocationEvent,
} from './fixtures/approval-readback/merge-authorization/task4-round4-state-fixture.mjs';
import {
  buildSyntheticVerifiedApprovalStateForTests,
} from './fixtures/approval-readback/synthetic-verified-state.mjs';

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
const historyOutcome = (events, policy, now = NOW) => {
  try {
    const state = approvalState.reduceApprovalDecisionState(events, policy, now);
    return {
      state: state.state,
      evidenceTrustState: state.evidenceTrustState,
      blockingCodes: state.blockingCodes,
      eventCount: state.eventHistory.length,
    };
  } catch (error) {
    return { threw: error.message };
  }
};

test('pure state kernel plans supersession and revocation projections without private history', async () => {
  let currentProjection = null;
  for (const transition of [
    'AUTHORITIES_ASSIGNED',
    'PROPOSAL_RENDERED',
    'PRODUCT_REVIEW_VERIFIED',
    'RECEIPT_VERIFIED',
  ]) {
    currentProjection = planApprovalStateTransition(
      buildSyntheticApprovalStateKernelInput({ currentProjection, transition }),
    ).nextProjection;
  }
  const verifiedProjection = currentProjection;
  const supersession = planApprovalStateTransition(
    buildSyntheticApprovalStateKernelInput({
      currentProjection: verifiedProjection,
      transition: 'RECEIPT_SUPERSEDED',
    }),
  );
  assert.equal(supersession.nextProjection.state, 'STALE_AFTER_PUSH');
  assert.equal(supersession.nextProjection.evidenceTrustState, 'EXTERNAL_UNVERIFIED');
  assert.equal(supersession.nextProjection.supersessionStatus, 'SUPERSEDED_WITH_CURRENT_SUCCESSOR');
  assert.equal(supersession.nextProjection.receiptHistory[0].lifecycleState, 'SUPERSEDED');

  const acceptanceInput = buildSyntheticApprovalStateKernelInput({
    currentProjection: verifiedProjection,
    transition: 'ACCEPTANCE_REVALIDATED',
  });
  const acceptedProjection = planApprovalStateTransition(acceptanceInput).nextProjection;
  const storedRevocation = buildStoredReceiptRevocationEvent(
    revocationEvent(),
    acceptedProjection,
    acceptanceInput.policySnapshot,
    REVOCATION_NOW.toISOString(),
  );
  const revocation = planApprovalStateTransition(
    buildSyntheticApprovalStateKernelInput({
      currentProjection: acceptedProjection,
      event: storedRevocation,
      observedAt: REVOCATION_NOW.toISOString(),
      policySnapshot: acceptanceInput.policySnapshot,
    }),
  );
  assert.equal(revocation.nextProjection.state, 'REVOKED');
  assert.equal(revocation.nextProjection.revocationStatus, 'REVOKED');
  assert.deepEqual(revocation.nextProjection.blockingCodes, ['APPROVAL_POLICY_REVOKED']);
  assert.equal(Object.hasOwn(revocation.nextProjection, 'eventHistory'), false);
});

test('round4 synthetic, cloned, deserialized, and caller-built histories remain external HOLD', () => {
  const { accepted, policy } = buildRound4AcceptedState();
  const expectedHold = {
    state: 'OWNER_ASSIGNMENT_REQUIRED',
    evidenceTrustState: 'EXTERNAL_UNVERIFIED',
    blockingCodes: ['APPROVAL_STATE_HISTORY_NOT_ADMITTED'],
    eventCount: 0,
  };
  const callerBuilt = accepted.eventHistory.map((event) => ({ ...clone(event) }));
  const outcomes = {
    synthetic: historyOutcome(accepted.eventHistory, policy),
    plain: historyOutcome([...accepted.eventHistory], policy),
    cloned: historyOutcome(clone(accepted.eventHistory), policy),
    deserialized: historyOutcome(JSON.parse(JSON.stringify(accepted.eventHistory)), policy),
    callerBuilt: historyOutcome(callerBuilt, policy),
  };
  assert.deepEqual(outcomes, {
    synthetic: expectedHold,
    plain: expectedHold,
    cloned: expectedHold,
    deserialized: expectedHold,
    callerBuilt: expectedHold,
  });

  const rawSentinel = 'caller-raw-value-must-not-leak';
  const hostile = clone(accepted.eventHistory);
  hostile[0].freeform = rawSentinel;
  assert.doesNotMatch(JSON.stringify(
    approvalState.reduceApprovalDecisionState(hostile, policy, NOW),
  ), new RegExp(rawSentinel));
});

test('round4 public source histories stay admitted while synthetic verified state has no provenance', () => {
  assert.equal(typeof approvalState.initializeApprovalDecisionState, 'function');
  const policy = approvalPolicy();
  const root = approvalState.initializeApprovalDecisionState(
    policy,
    new Date('2026-08-30T07:05:00.000Z'),
  );
  const proposed = approvalState.appendApprovalDecisionEvent(root, {
    schemaVersion: 'approval-event-append/v1',
    expectedHistorySha256: digest(root.eventHistory),
    appendedAt: '2026-08-30T07:05:00.000Z',
    event: { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
  }, policy, new Date('2026-08-30T07:05:00.000Z'));
  assert.equal(proposed.state, 'PROPOSED');
  assert.equal(Object.isFrozen(proposed.eventHistory), true);
  assert.equal(proposed.eventHistory.every(Object.isFrozen), true);
  assert.deepEqual(historyOutcome(root.eventHistory, policy), {
    state: 'OWNER_ASSIGNMENT_REQUIRED',
    evidenceTrustState: 'EXTERNAL_UNVERIFIED',
    blockingCodes: ['APPROVAL_STATE_HISTORY_CONSUMED'],
    eventCount: 0,
  });

  const synthetic = buildSyntheticVerifiedApprovalStateForTests({ policySnapshot: policy });
  assert.equal(synthetic.synthetic, true);
  assert.deepEqual(Object.keys(synthetic).sort(), ['state', 'synthetic']);
  const projected = renderApprovalStatusReadModel(synthetic.state);
  assert.equal(Object.hasOwn(projected, 'eventHistory'), false);
  assert.equal(Object.hasOwn(projected, 'historyBrand'), false);
  assert.equal(Object.hasOwn(projected, 'historyCapability'), false);
  assert.doesNotMatch(JSON.stringify(projected), /history.?brand|history.?capability/i);

  for (const state of [
    synthetic.state,
    clone(synthetic.state),
    JSON.parse(JSON.stringify(synthetic.state)),
  ]) {
    assert.throws(
      () => approvalState.appendApprovalDecisionEvent(state, {
        schemaVersion: 'approval-event-append/v1',
        expectedHistorySha256: digest(state.eventHistory),
        appendedAt: REVOCATION_NOW.toISOString(),
        event: { type: 'HEAD_CHANGED', headSha: 'c'.repeat(40), observedAt: REVOCATION_NOW.toISOString() },
      }, policy, REVOCATION_NOW),
      /APPROVAL_STATE_APPEND_INVALID/,
    );
  }
});

test('round4 revocation append validates Task1 receipt/revocation and Task3 current authority', () => {
  const { accepted, policy } = buildRound4AcceptedState();
  const revoked = appendRevocation(accepted, policy, revocationEvent());
  assert.equal(revoked.state, 'REVOKED');
  assert.equal(revoked.revocationStatus, 'REVOKED');
  assert.equal(Object.isFrozen(revoked.eventHistory), true);
  const stored = revoked.eventHistory.at(-1);
  assert.deepEqual(Object.keys(stored).sort(), [
    'authority',
    'evidenceSha256',
    'observedAt',
    'revocation',
    'targetReceipt',
    'type',
    'validationSha256',
  ]);
  assert.match(stored.validationSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(stored.evidenceSha256, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(stored), /freeform|single.?use.?nonce|nonce-program-c/i);
  assert.equal(storedReceiptRevocationIssue(stored, accepted, policy), null);

  const replayedLater = approvalState.reduceApprovalDecisionState(
    revoked.eventHistory,
    policy,
    new Date('2026-08-31T12:00:00.000Z'),
  );
  assert.deepEqual(historyOutcome(revoked.eventHistory, policy), {
    state: 'OWNER_ASSIGNMENT_REQUIRED',
    evidenceTrustState: 'EXTERNAL_UNVERIFIED',
    blockingCodes: ['APPROVAL_STATE_HISTORY_NOT_ADMITTED'],
    eventCount: 0,
  });
  assert.equal(replayedLater.state, 'OWNER_ASSIGNMENT_REQUIRED');
});

test('round4 accepted policy rejects QA, Security, and merge-authorizer revocation authority', () => {
  for (const roleName of ['OWN-QA-EVIDENCE', 'OWN-SECURITY', 'MERGE-AUTHORIZER']) {
    const { accepted, policy } = buildRound4AcceptedState();
    const event = revocationEvent();
    const role = event.authority.roles.find(({ role: value }) => value === roleName);
    event.revocation.revoking_role = roleName;
    event.revocation.revoking_actor_id = role.actor_id;

    assert.throws(
      () => appendRevocation(accepted, policy, event),
      /^Error: APPROVAL_/,
      `${roleName} must not revoke accepted policy truth`,
    );
  }
});

test('round4 revocation rejects arbitrary denial, wrong bindings, stale authority, tamper, and replay', () => {
  const { accepted, policy } = buildRound4AcceptedState();
  assert.deepEqual(historyOutcome([
    ...accepted.eventHistory,
    { type: 'RECEIPT_REVOKED', observedAt: REVOCATION_NOW.toISOString() },
  ], policy, REVOCATION_NOW), {
    state: 'OWNER_ASSIGNMENT_REQUIRED',
    evidenceTrustState: 'EXTERNAL_UNVERIFIED',
    blockingCodes: ['APPROVAL_STATE_HISTORY_NOT_ADMITTED'],
    eventCount: 0,
  });

  const cases = [
    ['revocation schema', (event) => { event.revocation.reason_code = 'FREEFORM_REASON'; }],
    ['receipt schema', (event) => { event.targetReceipt.envelope.core.actor_id += 1; }],
    ['wrong receipt', (event) => { event.revocation.receipt_raw_sha256 = `sha256:${'e'.repeat(64)}`; }],
    ['wrong actor', (event) => { event.revocation.revoking_actor_id += 1; }],
    ['wrong authority repository', (event) => { event.authority.repository.id += 1; }],
    ['revoked authority', (event) => { event.authority.roles[0].revocation_status = 'REVOKED'; }],
    ['expired authority', (event) => { event.authority.roles[0].effective_until = REVOCATION_NOW.toISOString(); }],
    ['wrong scope', (event) => { event.authority.roles[0].scope.policy_revision = 'program-c/policy-r9'; }],
    ['future effective time', (event) => { event.revocation.effective_at = '2026-08-30T08:32:00.000Z'; }],
    ['wrong authority digest', (event) => { event.authorityRawSha256 = `sha256:${'f'.repeat(64)}`; }],
    ['freeform', (event) => { event.freeform = 'forbidden'; }],
    ['nonce', (event) => { event.singleUseNonce = 'nonce-program-c-forbidden'; }],
  ];
  const failures = [];
  for (const [name, mutate] of cases) {
    const event = revocationEvent();
    mutate(event);
    try {
      appendRevocation(accepted, policy, event);
      failures.push({ name, outcome: 'REVOKED' });
    } catch (error) {
      if (!error.message.startsWith('APPROVAL_') || /forbidden|nonce-program-c/i.test(error.message)) {
        failures.push({ name, outcome: error.message });
      }
    }
  }
  assert.deepEqual(failures, []);

  const revoked = appendRevocation(accepted, policy, revocationEvent());
  assert.throws(
    () => appendRevocation(revoked, policy, revocationEvent()),
    /^Error: APPROVAL_/,
  );
  const tampered = clone(revoked.eventHistory);
  tampered.at(-1).validationSha256 = `sha256:${'0'.repeat(64)}`;
  assert.equal(
    storedReceiptRevocationIssue(tampered.at(-1), accepted, policy),
    'APPROVAL_STATE_REVOCATION_DIGEST_MISMATCH',
  );
  const wrongTargetState = {
    ...accepted,
    receipt: { ...accepted.receipt, receiptRawSha256: `sha256:${'9'.repeat(64)}` },
  };
  assert.equal(
    storedReceiptRevocationIssue(revoked.eventHistory.at(-1), wrongTargetState, policy),
    'APPROVAL_RECEIPT_DIGEST_MISMATCH',
  );
  assert.equal(
    approvalState.reduceApprovalDecisionState(tampered, policy, REVOCATION_NOW).evidenceTrustState,
    'EXTERNAL_UNVERIFIED',
  );
});
