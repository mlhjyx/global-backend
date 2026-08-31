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
import { buildSyntheticMergeReconciliationKernelInput } from './fixtures/approval-readback/merge-authorization/task4-round4-state-fixture.mjs';

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

test('pure reconciliation kernel plans result, consumption, and idempotent replay without a ledger port', async () => {
  const { planMergeAuthorizationReconciliation } = await import(
    './governance-approval-merge-reconciliation-kernel.mjs'
  );
  const input = buildSyntheticMergeReconciliationKernelInput();
  const inputSnapshot = clone(input);
  const first = planMergeAuthorizationReconciliation(input);
  assert.deepEqual(input, inputSnapshot);
  assert.equal(first.schemaVersion, 'merge-authorization-reconciliation-plan/v1');
  assert.equal(first.outcome, 'READY_TO_APPLY');
  assert.equal(first.blockingCode, null);
  assert.deepEqual(first.resultEvent, {
    type: 'MERGE_RESULT_OBSERVED',
    resultCommitSha: input.readback.resultCommitSha,
    observedMergeMethod: input.readback.observedMergeMethod,
    observedAt: input.readback.currentMain.readAt,
  });
  assert.equal(first.consumption.result_commit_sha, input.readback.resultCommitSha);
  assert.equal(first.consumptionRawSha256, digest(first.consumption));
  assert.equal(Object.hasOwn(first, 'ledger'), false);

  const descendantInput = clone(input);
  descendantInput.readback.currentMain.sha = 'e'.repeat(40);
  descendantInput.readback.resultReachableFromCurrentMain = true;
  const descendant = planMergeAuthorizationReconciliation(descendantInput);
  assert.equal(descendant.outcome, 'READY_TO_APPLY');
  assert.equal(descendant.consumption.result_commit_sha, input.readback.resultCommitSha);
  assert.equal(descendant.consumption.current_main.sha, descendantInput.readback.currentMain.sha);

  const resultEvent = { ...clone(first.resultEvent), ledgerRevision: 2 };
  const afterResult = planMergeAuthorizationReconciliation(
    buildSyntheticMergeReconciliationKernelInput({ streamFacts: { result: resultEvent } }),
  );
  assert.equal(afterResult.outcome, 'READY_TO_APPLY');
  assert.equal(afterResult.resultEvent, null);
  assert.deepEqual(afterResult.consumption, first.consumption);
  assert.equal(afterResult.consumptionRawSha256, first.consumptionRawSha256);

  const consumptionEvent = {
    type: 'CONSUMPTION_RECORDED',
    consumption: clone(first.consumption),
    consumptionRawSha256: first.consumptionRawSha256,
    recordedAt: input.observedAt,
    ledgerRevision: 3,
  };
  const replay = planMergeAuthorizationReconciliation(
    buildSyntheticMergeReconciliationKernelInput({
      streamFacts: { result: resultEvent, consumptionEvent },
    }),
  );
  assert.equal(replay.outcome, 'CONSUMPTION_ALREADY_RECORDED');
  assert.equal(replay.resultEvent, null);
  assert.deepEqual(replay.consumption, first.consumption);
  assert.equal(replay.consumptionRawSha256, first.consumptionRawSha256);
  assert.equal(Object.isFrozen(replay), true);

  const conflictingResult = planMergeAuthorizationReconciliation(
    buildSyntheticMergeReconciliationKernelInput({
      streamFacts: {
        result: { ...clone(resultEvent), resultCommitSha: 'e'.repeat(40) },
      },
    }),
  );
  assert.equal(conflictingResult.outcome, 'HOLD');
  assert.equal(conflictingResult.blockingCode, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED');
  assert.equal(conflictingResult.resultEvent, null);

  const revoked = planMergeAuthorizationReconciliation(
    buildSyntheticMergeReconciliationKernelInput({
      streamFacts: {
        revocations: [{ effectiveAt: '2026-08-30T08:25:00.000Z' }],
      },
    }),
  );
  assert.equal(revoked.outcome, 'HOLD');
  assert.equal(revoked.blockingCode, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
  assert.equal(revoked.resultEvent, null);
});

// Mutation caught: weakening exact readback shape/binding checks or throwing on malformed kernel fields.
test('pure reconciliation kernel returns stable HOLD plans for malformed and stale boundaries', async () => {
  const { planMergeAuthorizationReconciliation } = await import(
    './governance-approval-merge-reconciliation-kernel.mjs'
  );
  const exact = buildSyntheticMergeReconciliationKernelInput();
  const missingReadbackKey = clone(exact);
  delete missingReadbackKey.readback.preReadbackSha256;
  const extraReadbackKey = clone(exact);
  extraReadbackKey.readback.callerDeclaredAdmission = true;
  const staleReservationBinding = clone(exact);
  staleReservationBinding.reservation.grant.head_sha = 'e'.repeat(40);
  const staleReadbackBinding = clone(exact);
  staleReadbackBinding.readback.repositoryId += 1;
  const malformedReservation = clone(exact);
  malformedReservation.reservation = null;
  const malformedReadback = clone(exact);
  malformedReadback.readback = null;
  const malformedStreamFacts = clone(exact);
  malformedStreamFacts.streamFacts = null;
  const malformedObservedAt = clone(exact);
  malformedObservedAt.observedAt = 'not-a-canonical-instant';
  const cases = [
    [missingReadbackKey, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED'],
    [extraReadbackKey, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED'],
    [staleReservationBinding, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE'],
    [staleReadbackBinding, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE'],
    [malformedReservation, 'APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED'],
    [malformedReadback, 'APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED'],
    [malformedStreamFacts, 'APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED'],
    [malformedObservedAt, 'APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED'],
  ];
  for (const [input, blockingCode] of cases) {
    const plan = planMergeAuthorizationReconciliation(input);
    assert.equal(plan.outcome, 'HOLD');
    assert.equal(plan.blockingCode, blockingCode);
    assert.equal(plan.resultEvent, null);
    assert.equal(plan.consumption, null);
  }
});

// Mutation caught: applying a result before a malformed derived consumption is rejected.
test('pure reconciliation kernel isolates an invalid derived consumption as RESULT_READY_THEN_HOLD', async () => {
  const { planMergeAuthorizationReconciliation } = await import(
    './governance-approval-merge-reconciliation-kernel.mjs'
  );
  const input = clone(buildSyntheticMergeReconciliationKernelInput());
  input.reservation.request.reservationId = 'caller-controlled-consumption-id';
  const plan = planMergeAuthorizationReconciliation(input);
  assert.equal(plan.outcome, 'RESULT_READY_THEN_HOLD');
  assert.equal(
    plan.blockingCode,
    'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH',
  );
  assert.equal(plan.resultEvent.type, 'MERGE_RESULT_OBSERVED');
  assert.equal(plan.consumption, null);
  assert.equal(plan.consumptionRawSha256, null);
});

// Mutation caught: allowing durable read/stream validation failures to escape or append a write.
test('public reconciliation returns stable no-write HOLDs for durable read and stream failures', async () => {
  const grant = await readJson('valid-grant.json');
  const readback = await readJson('current-main-readback.json');
  const sourceLedger = new Ledger();
  const fresh = await reserve(sourceLedger, grant);
  let readCalls = 0;
  let casCalls = 0;
  const readFailurePort = {
    durabilityClass: 'SHARED_DURABLE_CAS',
    read: async () => { readCalls += 1; throw new Error('untrusted durable read detail'); },
    compareAndSwap: async () => { casCalls += 1; return { outcome: 'COMMITTED', committedRevision: 2 }; },
  };
  const readFailure = await reconcileMergeAuthorizationReservation(
    fresh.reservation,
    readback,
    readFailurePort,
    NOW,
  );
  assert.deepEqual(readFailure, {
    outcome: 'HOLD',
    blockingCode: 'APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED',
    consumption: null,
    consumptionRawSha256: null,
    committedLedgerRevision: 0,
  });
  assert.deepEqual({ readCalls, casCalls }, { readCalls: 1, casCalls: 0 });

  const malformedSnapshot = sourceLedger.snapshot();
  malformedSnapshot[0].committedRevision += 1;
  const malformedLedger = new Ledger(malformedSnapshot);
  const malformedStream = await reconcileMergeAuthorizationReservation(
    fresh.reservation,
    readback,
    malformedLedger,
    NOW,
  );
  assert.equal(malformedStream.outcome, 'HOLD');
  assert.equal(
    malformedStream.blockingCode,
    'APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED',
  );
  assert.equal(malformedStream.committedLedgerRevision, 0);
  assert.deepEqual(
    { readCalls: malformedLedger.readCalls, casCalls: malformedLedger.casCalls },
    { readCalls: 1, casCalls: 0 },
  );
});

// Mutation caught: validating the clock before the mandatory durable read or leaking a native throw.
test('invalid reconciliation clock reads durable state then returns a stable no-write HOLD', async () => {
  const grant = await readJson('valid-grant.json');
  const readback = await readJson('current-main-readback.json');
  const ledger = new Ledger();
  const fresh = await reserve(ledger, grant);
  const before = ledger.snapshot()[0];
  const readCallsBefore = ledger.readCalls;
  const casCallsBefore = ledger.casCalls;
  const result = await reconcileMergeAuthorizationReservation(
    fresh.reservation,
    readback,
    ledger,
    new Date(Number.NaN),
  );
  assert.deepEqual(result, {
    outcome: 'HOLD',
    blockingCode: 'APPROVAL_NOW_INVALID',
    consumption: null,
    consumptionRawSha256: null,
    committedLedgerRevision: before.committedRevision,
  });
  assert.equal(ledger.readCalls, readCallsBefore + 1);
  assert.equal(ledger.casCalls, casCallsBefore);
  const after = ledger.snapshot()[0];
  assert.equal(after.committedRevision, before.committedRevision);
  assert.equal(after.events.some(({ type }) => type === 'BOUNDED_HOLD'), false);
  assert.equal(after.events.some(({ type }) => type === 'MERGE_RESULT_OBSERVED'), false);
  assert.equal(after.events.some(({ type }) => type === 'CONSUMPTION_RECORDED'), false);
});

test('caller-owned current-main capability cannot authorize public durable reconciliation', async () => {
  const grant = await readJson('valid-grant.json');
  const readback = await readJson('current-main-readback.json');
  const fakeCapability = Object.freeze({ kind: 'caller-declared-admission' });
  const callerOwnedCapabilities = [
    fakeCapability,
    structuredClone(fakeCapability),
    JSON.parse(JSON.stringify(fakeCapability)),
  ];

  for (const capability of callerOwnedCapabilities) {
    const ledger = new Ledger();
    const fresh = await reserve(ledger, grant);
    const result = await reconcileMergeAuthorizationReservation(
      fresh.reservation,
      structuredClone(readback),
      ledger,
      NOW,
      capability,
    );
    assert.equal(result.outcome, 'HOLD');
    assert.equal(result.blockingCode, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED');
    const stream = await ledger.read(fresh.reservation.key);
    assert.equal(stream.events.some(({ type }) => type === 'MERGE_RESULT_OBSERVED'), false);
    assert.equal(stream.events.some(({ type }) => type === 'CONSUMPTION_RECORDED'), false);

    const repeated = await reconcileMergeAuthorizationReservation(
      fresh.reservation,
      structuredClone(readback),
      ledger,
      NOW,
      capability,
    );
    assert.equal(repeated.outcome, 'HOLD');
    assert.equal(repeated.blockingCode, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED');
    const repeatedStream = await ledger.read(fresh.reservation.key);
    assert.equal(
      repeatedStream.events.filter(
        ({ type, reasonCode }) => type === 'BOUNDED_HOLD'
          && reasonCode === 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED',
      ).length,
      1,
    );
  }
});

test('public current-main readback remains HOLD after controlled collection intrinsic mutation', async () => {
  const grant = await readJson('valid-grant.json');
  const readback = await readJson('current-main-readback.json');
  const ledger = new Ledger();
  const fresh = await reserve(ledger, grant);
  const callerOwnedValue = Object.freeze({ kind: 'caller-owned-readback-value' });
  const originalWeakSetHas = WeakSet.prototype.has;
  let result;
  WeakSet.prototype.has = function controlledWeakSetHas(value) {
    if (value === callerOwnedValue) return true;
    return Reflect.apply(originalWeakSetHas, this, [value]);
  };
  try {
    result = await reconcileMergeAuthorizationReservation(
      fresh.reservation,
      structuredClone(readback),
      ledger,
      NOW,
      callerOwnedValue,
    );
  } finally {
    WeakSet.prototype.has = originalWeakSetHas;
  }
  assert.equal(result.outcome, 'HOLD');
  assert.equal(result.blockingCode, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED');
  const stream = await ledger.read(fresh.reservation.key);
  assert.equal(stream.events.some(({ type }) => type === 'MERGE_RESULT_OBSERVED'), false);
  assert.equal(stream.events.some(({ type }) => type === 'CONSUMPTION_RECORDED'), false);
  assert.equal(
    stream.events.filter(
      ({ type, reasonCode }) => type === 'BOUNDED_HOLD'
        && reasonCode === 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED',
    ).length,
    1,
  );
});

test('public reconciliation denies a later current-main descendant without private admission', async () => {
  const grant = await readJson('valid-grant.json');
  const readback = await readJson('current-main-readback.json');
  readback.currentMain.sha = 'e'.repeat(40);
  readback.resultReachableFromCurrentMain = true;
  const ledger = new Ledger();
  const fresh = await reserve(ledger, grant);
  const result = await reconcileMergeAuthorizationReservation(fresh.reservation, readback, ledger, NOW);
  assert.equal(result.outcome, 'HOLD');
  assert.equal(result.blockingCode, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED');
  const stream = await ledger.read(fresh.reservation.key);
  assert.equal(stream.events.some(({ type }) => type === 'MERGE_RESULT_OBSERVED'), false);
  assert.equal(stream.events.some(({ type }) => type === 'CONSUMPTION_RECORDED'), false);
});

test('malformed verifier repository names HOLD without appending merge result or consumption', async () => {
  const grant = await readJson('valid-grant.json');
  const readback = await readJson('current-main-readback.json');
  const malformedNames = [42, null, {}, [], '', 'x'.repeat(257), 'not-a-repository-name'];
  for (const fullName of malformedNames) {
    const changed = clone(readback);
    changed.independentVerifier.repository.full_name = fullName;
    const ledger = new Ledger();
    const reservation = await reserve(ledger, grant);
    const result = await reconcileMergeAuthorizationReservation(
      reservation.reservation,
      changed,
      ledger,
      NOW,
    );
    assert.equal(result.outcome, 'HOLD');
    assert.equal(result.blockingCode, 'APPROVAL_INDEPENDENCE_NOT_PROVEN');
    const stream = await ledger.read(reservation.reservation.key);
    assert.equal(stream.events.some(({ type }) => type === 'MERGE_RESULT_OBSERVED'), false);
    assert.equal(stream.events.some(({ type }) => type === 'CONSUMPTION_RECORDED'), false);
  }
});

test('public reconciliation prioritizes stale and revoked facts before private admission', async () => {
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
  const unadmitted = await reconcileMergeAuthorizationReservation(
    reservation.reservation,
    readback,
    ledger,
    NOW,
  );
  assert.equal(unadmitted.outcome, 'HOLD');
  assert.equal(unadmitted.blockingCode, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED');
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
  const stream = await ledger.read(key);
  assert.equal(stream.events.some(({ type }) => type === 'MERGE_RESULT_OBSERVED'), false);
  assert.equal(stream.events.some(({ type }) => type === 'CONSUMPTION_RECORDED'), false);
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
