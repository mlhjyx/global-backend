import assert from 'node:assert/strict';
import test from 'node:test';

import * as approvalState from './governance-approval-state.mjs';
import { renderApprovalStatusReadModel } from './governance-approval-state.mjs';
import { storedReceiptRevocationIssue } from './governance-approval-state-revocation.mjs';
import {
  NOW,
  REVOCATION_NOW,
  appendRevocation,
  buildRound4AcceptedState,
  digest,
  revocationEvent,
} from './fixtures/approval-readback/merge-authorization/task4-round4-state-fixture.mjs';

const clone = (value) => structuredClone(value);
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

test('round4 plain, cloned, deserialized, and caller-built histories remain external HOLD', () => {
  const { accepted, policy } = buildRound4AcceptedState();
  const expectedHold = {
    state: 'OWNER_ASSIGNMENT_REQUIRED',
    evidenceTrustState: 'EXTERNAL_UNVERIFIED',
    blockingCodes: ['APPROVAL_STATE_HISTORY_NOT_ADMITTED'],
    eventCount: 0,
  };
  const callerBuilt = accepted.eventHistory.map((event) => ({ ...clone(event) }));
  const outcomes = {
    admitted: historyOutcome(accepted.eventHistory, policy),
    plain: historyOutcome([...accepted.eventHistory], policy),
    cloned: historyOutcome(clone(accepted.eventHistory), policy),
    deserialized: historyOutcome(JSON.parse(JSON.stringify(accepted.eventHistory)), policy),
    callerBuilt: historyOutcome(callerBuilt, policy),
  };
  assert.deepEqual(outcomes, {
    admitted: {
      state: 'ACCEPTED',
      evidenceTrustState: 'INDEPENDENT_EXTERNAL_VERIFIED',
      blockingCodes: [],
      eventCount: 5,
    },
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

test('round4 initializer and append return new frozen admitted histories without projecting capability', () => {
  assert.equal(typeof approvalState.initializeApprovalDecisionState, 'function');
  const { accepted, policy, verified } = buildRound4AcceptedState();
  assert.notEqual(accepted.eventHistory, verified.eventHistory);
  assert.equal(Object.isFrozen(accepted.eventHistory), true);
  assert.equal(accepted.eventHistory.every(Object.isFrozen), true);
  assert.deepEqual(historyOutcome(verified.eventHistory, policy), {
    state: 'OWNER_ASSIGNMENT_REQUIRED',
    evidenceTrustState: 'EXTERNAL_UNVERIFIED',
    blockingCodes: ['APPROVAL_STATE_HISTORY_CONSUMED'],
    eventCount: 0,
  });

  const projected = renderApprovalStatusReadModel(accepted);
  assert.equal(Object.hasOwn(projected, 'eventHistory'), false);
  assert.equal(Object.hasOwn(projected, 'historyBrand'), false);
  assert.equal(Object.hasOwn(projected, 'historyCapability'), false);
  assert.doesNotMatch(JSON.stringify(projected), /history.?brand|history.?capability/i);

  const clonedState = { ...accepted, eventHistory: clone(accepted.eventHistory) };
  assert.throws(
    () => appendRevocation(clonedState, policy, revocationEvent()),
    /APPROVAL_STATE_APPEND_INVALID/,
  );
  assert.throws(
    () => approvalState.appendApprovalDecisionEvent(accepted, {
      schemaVersion: 'approval-event-append/v1',
      expectedHistorySha256: digest([]),
      appendedAt: REVOCATION_NOW.toISOString(),
      event: revocationEvent(),
    }, policy, REVOCATION_NOW),
    /APPROVAL_STATE_APPEND_INVALID/,
  );
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
  assert.equal(replayedLater.state, 'REVOKED');
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
