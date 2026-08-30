import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  executeReservedMerge,
  reconcileMergeAuthorizationReservation,
  reserveMergeAuthorizationNonce,
} from './governance-approval-state.mjs';
import { validateProgramCMergeAuthorizationGrant } from './governance-approval-schema-validator.mjs';

const NOW = new Date('2026-08-30T08:30:00.000Z');
const RESERVATION_NOW = new Date('2026-08-30T08:10:00.000Z');
const ROOT = new URL('./fixtures/approval-readback/merge-authorization/', import.meta.url);
const clone = (value) => structuredClone(value);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
const readJson = async (name) => JSON.parse(await readFile(new URL(name, ROOT), 'utf8'));

class Ledger {
  durabilityClass = 'SHARED_DURABLE_CAS';

  constructor(snapshot = []) {
    this.streams = new Map(snapshot.map((stream) => [this.id(stream.key), clone(stream)]));
    this.readCalls = 0;
    this.casCalls = 0;
  }

  id(key) {
    return `${key.repositoryId}:${key.singleUseNonce}`;
  }

  async read(key) {
    this.readCalls += 1;
    return clone(this.streams.get(this.id(key)) ?? null);
  }

  async compareAndSwap(input) {
    this.casCalls += 1;
    const id = this.id(input.key);
    const current = this.streams.get(id) ?? { key: clone(input.key), committedRevision: 0, events: [] };
    if (current.committedRevision !== input.expectedRevision) {
      return { outcome: 'CONFLICT', currentRevision: current.committedRevision };
    }
    const committedRevision = current.committedRevision + 1;
    this.streams.set(id, {
      key: clone(current.key),
      committedRevision,
      events: [...current.events, { ...clone(input.event), ledgerRevision: committedRevision }],
    });
    return { outcome: 'COMMITTED', committedRevision };
  }

  snapshot() {
    return [...this.streams.values()].map(clone);
  }
}

const requestFor = (grant, overrides = {}) => ({
  requestId: 'merge-request-task4-review-0001',
  reservationId: 'merge-reservation-task4-review-0001',
  repositoryId: grant.repository.id,
  decisionAdr: grant.decision_adr,
  decisionRevision: grant.decision_revision,
  policyRevision: grant.policy_revision,
  stage: grant.stage,
  prNumber: grant.pr_number,
  baseSha: grant.base_sha,
  headSha: grant.head_sha,
  mergeMethod: grant.allowed_merge_method,
  ...overrides,
});
const reserve = async (ledger, grant, request = requestFor(grant)) => (
  reserveMergeAuthorizationNonce(grant, digest(grant), request, 0, ledger, RESERVATION_NOW)
);

test('unsafe PR numbers fail before ledger read or CAS while the safe maximum remains valid', async () => {
  const valid = await readJson('valid-grant.json');
  const safeMaximum = clone(valid);
  safeMaximum.pr_number = Number.MAX_SAFE_INTEGER;
  assert.equal(validateProgramCMergeAuthorizationGrant(safeMaximum).valid, true);

  const unsafe = clone(valid);
  unsafe.pr_number = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(validateProgramCMergeAuthorizationGrant(unsafe).valid, false);
  const ledger = new Ledger();
  await assert.rejects(
    reserveMergeAuthorizationNonce(
      unsafe,
      digest(unsafe),
      requestFor(unsafe),
      0,
      ledger,
      RESERVATION_NOW,
    ),
    /^Error: APPROVAL_/,
  );
  assert.deepEqual({ readCalls: ledger.readCalls, casCalls: ledger.casCalls }, {
    readCalls: 0,
    casCalls: 0,
  });
});

test('reviewer C2 restart counterexample cannot restore fresh physical-dispatch authority from JSON', async () => {
  const grant = await readJson('valid-grant.json');
  const first = new Ledger();
  const fresh = await reserve(first, grant);
  const restarted = new Ledger(first.snapshot());
  const restoredReservation = JSON.parse(JSON.stringify(fresh.reservation));
  let physicalCalls = 0;
  const result = await executeReservedMerge(
    restoredReservation,
    { requestMerge: async () => { physicalCalls += 1; return { acknowledgement: 'ACKNOWLEDGED' }; } },
    restarted,
    NOW,
  );
  assert.equal(result.outcome, 'HOLD');
  assert.equal(physicalCalls, 0);
  assert.deepEqual(restarted.snapshot()[0].events.map(({ type }) => type), ['NONCE_RESERVED']);
});

test('C2 forged execution mode and malformed dispatch CAS cannot reach the merger', async () => {
  const grant = await readJson('valid-grant.json');
  const failures = [];
  for (const portKind of ['FORGED_MODE', 'MALFORMED_COMMITTED', 'READBACK_MISMATCH']) {
    const ledger = new Ledger();
    const fresh = await reserve(ledger, grant);
    let reservation = fresh.reservation;
    let port = ledger;
    if (portKind === 'FORGED_MODE') {
      const existing = await reserveMergeAuthorizationNonce(grant, digest(grant), requestFor(grant), 1, ledger, NOW);
      reservation = clone(existing.reservation);
      reservation.executionMode = 'FRESH_CAS_WINNER';
    } else {
      port = {
        durabilityClass: 'SHARED_DURABLE_CAS',
        read: (key) => ledger.read(key),
        compareAndSwap: async () => (portKind === 'MALFORMED_COMMITTED'
          ? { outcome: 'COMMITTED' }
          : { outcome: 'COMMITTED', committedRevision: 2 }),
      };
    }
    let physicalCalls = 0;
    const result = await executeReservedMerge(
      reservation,
      { requestMerge: async () => { physicalCalls += 1; return { acknowledgement: 'ACKNOWLEDGED' }; } },
      port,
      NOW,
    );
    if (result.outcome !== 'HOLD' || physicalCalls !== 0) {
      failures.push({ portKind, result, physicalCalls });
    }
  }
  assert.deepEqual(failures, []);
});

test('I2 dispatch rechecks the immutable grant interval at the canonical dispatch clock', async () => {
  const grant = await readJson('valid-grant.json');
  const ledger = new Ledger();
  const fresh = await reserve(ledger, grant);
  let physicalCalls = 0;
  const result = await executeReservedMerge(
    fresh.reservation,
    { requestMerge: async () => { physicalCalls += 1; return { acknowledgement: 'ACKNOWLEDGED' }; } },
    ledger,
    new Date(grant.expires_at),
  );
  assert.equal(result.outcome, 'HOLD');
  assert.equal(result.blockingCode, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
  assert.equal(physicalCalls, 0);
});

test('round2 I2 backdated dispatch cannot append a guard or consume fresh authority unsafely', async () => {
  const grant = await readJson('valid-grant.json');
  const ledger = new Ledger();
  const fresh = await reserve(ledger, grant);
  let physicalCalls = 0;
  const requester = {
    requestMerge: async () => { physicalCalls += 1; return { acknowledgement: 'ACKNOWLEDGED' }; },
  };
  const backdated = await executeReservedMerge(
    fresh.reservation,
    requester,
    ledger,
    new Date('2026-08-30T08:05:00.000Z'),
  );
  const afterBackdated = ledger.snapshot()[0];
  const validRetry = await executeReservedMerge(
    fresh.reservation,
    requester,
    ledger,
    new Date('2026-08-30T08:11:00.000Z'),
  );
  const replay = await executeReservedMerge(
    fresh.reservation,
    requester,
    ledger,
    new Date('2026-08-30T08:12:00.000Z'),
  );
  assert.deepEqual({
    backdated: backdated.outcome,
    afterBackdatedEvents: afterBackdated.events.map(({ type }) => type),
    validRetry: validRetry.outcome,
    replay: replay.outcome,
    physicalCalls,
  }, {
    backdated: 'HOLD',
    afterBackdatedEvents: ['NONCE_RESERVED'],
    validRetry: 'ACKNOWLEDGED',
    replay: 'HOLD',
    physicalCalls: 1,
  });
});

test('I1 reconciliation accepts a merge result reachable from a later current-main descendant', async () => {
  const grant = await readJson('valid-grant.json');
  const readback = await readJson('current-main-readback.json');
  readback.currentMain.sha = 'e'.repeat(40);
  readback.resultReachableFromCurrentMain = true;
  const ledger = new Ledger();
  const fresh = await reserve(ledger, grant);
  const result = await reconcileMergeAuthorizationReservation(fresh.reservation, readback, ledger, NOW);
  assert.equal(result.outcome, 'CONSUMPTION_RECORDED');
  assert.equal(result.consumption.result_commit_sha, readback.resultCommitSha);
  assert.equal(result.consumption.current_main.sha, readback.currentMain.sha);
});

test('I2 reconciliation HOLDs out-of-window readback and post-consumption revocation', async () => {
  const grant = await readJson('valid-grant.json');
  const lateReadback = await readJson('current-main-readback.json');
  lateReadback.currentMain.readAt = '2026-08-30T10:30:00.000Z';
  const lateLedger = new Ledger();
  const lateReservation = await reserve(lateLedger, grant);
  const late = await reconcileMergeAuthorizationReservation(
    lateReservation.reservation,
    lateReadback,
    lateLedger,
    new Date('2026-08-30T10:31:00.000Z'),
  );
  const readback = await readJson('current-main-readback.json');
  const ledger = new Ledger();
  const reservation = await reserve(ledger, grant);
  assert.equal((await reconcileMergeAuthorizationReservation(reservation.reservation, readback, ledger, NOW)).outcome, 'CONSUMPTION_RECORDED');
  const key = reservation.reservation.key;
  const revision = ledger.snapshot()[0].committedRevision;
  await ledger.compareAndSwap({
    key,
    expectedRevision: revision,
    event: {
      type: 'GRANT_REVOKED',
      grantId: grant.grant_id,
      grantRawSha256: digest(grant),
      reasonCode: 'POLICY_WITHDRAWN',
      effectiveAt: '2026-08-30T08:25:00.000Z',
    },
  });
  const revoked = await reconcileMergeAuthorizationReservation(reservation.reservation, readback, ledger, NOW);
  assert.equal(late.outcome, 'HOLD');
  assert.equal(late.blockingCode, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
  assert.equal(revoked.outcome, 'HOLD');
  assert.equal(revoked.blockingCode, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
});

test('M1 request and reservation identifiers fail before the first durable append', async () => {
  const grant = await readJson('valid-grant.json');
  const cases = [
    { requestId: '' },
    { requestId: `merge-request-${'x'.repeat(200)}` },
    { requestId: 'merge-request-😀😀😀😀' },
    { reservationId: '' },
    { reservationId: 'valid-but-wrong-prefix-0001' },
    { reservationId: `merge-reservation-${'x'.repeat(200)}` },
  ];
  const results = [];
  for (const override of cases) {
    const ledger = new Ledger();
    let error = null;
    try {
      await reserve(ledger, grant, requestFor(grant, override));
    } catch (caught) {
      error = caught;
    }
    results.push({ override, error: error?.message ?? null, snapshot: ledger.snapshot() });
  }
  assert.ok(results.every(({ error }) => error === 'APPROVAL_MERGE_AUTHORIZATION_REQUEST_INVALID'));
  assert.ok(results.every(({ snapshot }) => snapshot.length === 0));
});

test('round3 orchestration preserves bounded HOLD semantics across CAS races and repeated readback', async () => {
  const grant = await readJson('valid-grant.json');
  const readback = await readJson('current-main-readback.json');
  const resultRaceLedger = new Ledger();
  const resultRace = await reserve(resultRaceLedger, grant);
  const resultConflictPort = {
    durabilityClass: 'SHARED_DURABLE_CAS',
    read: (key) => resultRaceLedger.read(key),
    compareAndSwap: async () => ({ outcome: 'CONFLICT', currentRevision: 1 }),
  };
  const resultConflict = await reconcileMergeAuthorizationReservation(
    resultRace.reservation,
    readback,
    resultConflictPort,
    NOW,
  );

  const holdLedger = new Ledger();
  const holdReservation = await reserve(holdLedger, grant);
  const lag = clone(readback);
  lag.resultReachableFromCurrentMain = false;
  const firstHold = await reconcileMergeAuthorizationReservation(
    holdReservation.reservation,
    lag,
    holdLedger,
    NOW,
  );
  const revision = holdLedger.snapshot()[0].committedRevision;
  const repeatedHold = await reconcileMergeAuthorizationReservation(
    holdReservation.reservation,
    lag,
    holdLedger,
    NOW,
  );

  const observedLedger = new Ledger();
  const observedReservation = await reserve(observedLedger, grant);
  await observedLedger.compareAndSwap({
    key: observedReservation.reservation.key,
    expectedRevision: 1,
    event: {
      type: 'MERGE_RESULT_OBSERVED',
      resultCommitSha: readback.resultCommitSha,
      observedMergeMethod: readback.observedMergeMethod,
      observedAt: readback.currentMain.readAt,
    },
  });
  const wrongResult = clone(readback);
  wrongResult.resultCommitSha = 'e'.repeat(40);
  const mismatch = await reconcileMergeAuthorizationReservation(
    observedReservation.reservation,
    wrongResult,
    observedLedger,
    NOW,
  );
  assert.deepEqual({
    resultConflict: resultConflict.outcome,
    firstHold: firstHold.outcome,
    repeatedHold: repeatedHold.outcome,
    revisionStable: holdLedger.snapshot()[0].committedRevision === revision,
    mismatch: mismatch.outcome,
  }, {
    resultConflict: 'HOLD',
    firstHold: 'HOLD',
    repeatedHold: 'HOLD',
    revisionStable: true,
    mismatch: 'HOLD',
  });
});
