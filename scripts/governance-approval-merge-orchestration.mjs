import {
  approvalError,
  deepFreeze,
  hasExactKeys,
  isCanonicalInstant,
  isDigest,
  isGitSha,
  isPlainObject,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
} from './governance-approval-readback-common.mjs';
import {
  validateProgramCMergeAuthorizationConsumption,
  validateProgramCMergeAuthorizationGrant,
} from './governance-approval-schema-validator.mjs';
import {
  canonicalApprovalDigest,
  isBoundedId,
  LEDGER_DURABILITY_CLASS,
  MERGE_CONSUMPTION_ID_PATTERN,
  MERGE_REQUEST_ID_PATTERN,
  MERGE_RESERVATION_ID_PATTERN,
  validateApprovalLedgerStream,
} from './governance-approval-ledger-stream.mjs';

const REQUEST_KEYS = Object.freeze([
  'requestId', 'reservationId', 'repositoryId', 'decisionAdr', 'decisionRevision',
  'policyRevision', 'stage', 'prNumber', 'baseSha', 'headSha', 'mergeMethod',
]);
const RESERVATION_KEYS = Object.freeze([
  'schemaVersion', 'key', 'grant', 'grantRawSha256', 'request',
  'reservedLedgerRevision', 'reservedAt',
]);
const KEY_KEYS = Object.freeze(['repositoryId', 'singleUseNonce']);
const READBACK_KEYS = Object.freeze([
  'repositoryId', 'prNumber', 'baseSha', 'authorizedHeadSha', 'prState',
  'resultCommitSha', 'observedMergeMethod', 'resultAssociatedWithPr',
  'headAssociatedWithResult', 'resultReachableFromCurrentMain', 'currentMain',
  'independentVerifier', 'preReadbackSha256', 'postReadbackSha256',
]);
const CURRENT_MAIN_KEYS = Object.freeze(['ref', 'sha', 'readAt']);
const VERIFIER_KEYS = Object.freeze(['repository', 'path', 'sha', 'runId', 'attempt', 'identity']);
const VERIFIER_REPOSITORY_KEYS = Object.freeze(['id', 'full_name']);
const freshDispatchCapabilities = new WeakSet();
const clone = (value) => structuredClone(value);
const frozenClone = (value) => deepFreeze(clone(value));
const nowIso = (now) => {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw approvalError('APPROVAL_NOW_INVALID');
  return now.toISOString();
};
const exactLedgerKey = (grant) => frozenClone({
  repositoryId: grant.repository.id,
  singleUseNonce: grant.single_use_nonce,
});
const ledgerPortValid = (ledger) => (
  ledger !== null
  && typeof ledger === 'object'
  && ledger.durabilityClass === LEDGER_DURABILITY_CLASS
  && typeof ledger.read === 'function'
  && typeof ledger.compareAndSwap === 'function'
);
const requireLedger = (ledger) => {
  if (!ledgerPortValid(ledger)) throw approvalError('APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED');
};
const ledgerRead = async (ledger, key) => {
  try {
    return await ledger.read(key);
  } catch {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED');
  }
};
const ledgerCas = async (ledger, input) => {
  try {
    return await ledger.compareAndSwap(input);
  } catch {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED');
  }
};
const committedAt = (result, revision) => (
  hasExactKeys(result, ['outcome', 'committedRevision'])
  && result.outcome === 'COMMITTED'
  && result.committedRevision === revision
);
const conflictRevision = (result, fallback) => (
  hasExactKeys(result, ['outcome', 'currentRevision'])
  && result.outcome === 'CONFLICT'
  && isSafeNonNegativeInteger(result.currentRevision)
    ? result.currentRevision
    : fallback
);
const bindingFromGrant = (grant, request) => ({
  grantId: grant.grant_id,
  grantRawSha256: canonicalApprovalDigest(grant),
  requestId: request.requestId,
  reservationId: request.reservationId,
  repositoryId: grant.repository.id,
  decisionAdr: grant.decision_adr,
  decisionRevision: grant.decision_revision,
  policyRevision: grant.policy_revision,
  stage: grant.stage,
  prNumber: grant.pr_number,
  baseSha: grant.base_sha,
  headSha: grant.head_sha,
  mergeMethod: grant.allowed_merge_method,
});
const immutableBindingMatches = (event, binding) => (
  event?.type === 'NONCE_RESERVED'
  && ['grantId', 'grantRawSha256', 'repositoryId', 'decisionAdr', 'decisionRevision',
    'policyRevision', 'stage', 'prNumber', 'baseSha', 'headSha', 'mergeMethod']
    .every((key) => event[key] === binding[key])
);
const requestBindingMatches = (event, binding) => (
  immutableBindingMatches(event, binding)
  && event.requestId === binding.requestId
  && event.reservationId === binding.reservationId
);
const reservationFrom = (grant, request, event) => frozenClone({
  schemaVersion: 'merge-authorization-reservation/v1',
  key: { repositoryId: grant.repository.id, singleUseNonce: grant.single_use_nonce },
  grant,
  grantRawSha256: canonicalApprovalDigest(grant),
  request,
  reservedLedgerRevision: event.ledgerRevision,
  reservedAt: event.reservedAt,
});
const validateGrantAndRequest = (grant, grantRawSha256, request, expectedRevision) => {
  if (!validateProgramCMergeAuthorizationGrant(grant).valid) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_GRANT_REQUIRED');
  }
  if (!isDigest(grantRawSha256) || grantRawSha256 !== canonicalApprovalDigest(grant)) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH');
  }
  const expected = isPlainObject(request) ? bindingFromGrant(grant, request) : {};
  if (!hasExactKeys(request, REQUEST_KEYS)
    || !isSafeNonNegativeInteger(expectedRevision)
    || !isBoundedId(request.requestId, MERGE_REQUEST_ID_PATTERN)
    || !isBoundedId(request.reservationId, MERGE_RESERVATION_ID_PATTERN)
    || request.repositoryId !== expected.repositoryId
    || request.decisionAdr !== expected.decisionAdr
    || request.decisionRevision !== expected.decisionRevision
    || request.policyRevision !== expected.policyRevision
    || request.stage !== expected.stage
    || request.prNumber !== expected.prNumber
    || request.baseSha !== expected.baseSha
    || request.headSha !== expected.headSha
    || request.mergeMethod !== expected.mergeMethod) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_REQUEST_INVALID');
  }
  const consumptionId = request.reservationId.replace(/^merge-reservation-/, 'program-c-consumption-');
  if (!isBoundedId(consumptionId, MERGE_CONSUMPTION_ID_PATTERN)) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_REQUEST_INVALID');
  }
};
const streamContext = (reservation, additions = {}) => ({
  key: reservation.key,
  grant: reservation.grant,
  grantRawSha256: reservation.grantRawSha256,
  request: reservation.request,
  ...additions,
});
const validStreamFacts = (stream, context) => {
  const result = validateApprovalLedgerStream(stream, context);
  if (!result.valid) throw approvalError('APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED');
  return result.facts;
};
const validateReservation = (reservation) => {
  if (!hasExactKeys(reservation, RESERVATION_KEYS)
    || reservation.schemaVersion !== 'merge-authorization-reservation/v1'
    || !hasExactKeys(reservation.key, KEY_KEYS)
    || !isPlainObject(reservation.grant)
    || !isPlainObject(reservation.request)
    || reservation.grantRawSha256 !== canonicalApprovalDigest(reservation.grant)
    || !isSafePositiveInteger(reservation.reservedLedgerRevision)
    || !isCanonicalInstant(reservation.reservedAt)) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_RESERVATION_REQUIRED');
  }
  validateGrantAndRequest(
    reservation.grant,
    reservation.grantRawSha256,
    reservation.request,
    reservation.reservedLedgerRevision - 1,
  );
};
const reservationStream = async (reservation, ledger) => {
  requireLedger(ledger);
  validateReservation(reservation);
  const stream = await ledgerRead(ledger, reservation.key);
  const facts = validStreamFacts(stream, streamContext(reservation));
  if (facts.reservation?.ledgerRevision !== reservation.reservedLedgerRevision
    || facts.reservation?.reservedAt !== reservation.reservedAt) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_REPLAYED');
  }
  return { stream, facts };
};
const holdExecution = (code) => frozenClone({ outcome: 'HOLD', blockingCode: code });
const holdReconciliation = (code, revision) => frozenClone({
  outcome: 'HOLD',
  blockingCode: code,
  consumption: null,
  consumptionRawSha256: null,
  committedLedgerRevision: revision,
});

export const reserveMergeAuthorizationNonce = async (
  grant,
  grantRawSha256,
  request,
  expectedLedgerRevision,
  ledger,
  now,
) => {
  requireLedger(ledger);
  const observedAt = nowIso(now);
  validateGrantAndRequest(grant, grantRawSha256, request, expectedLedgerRevision);
  if (Date.parse(grant.authorized_at) > Date.parse(observedAt)
    || Date.parse(observedAt) >= Date.parse(grant.expires_at)) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
  }
  const key = exactLedgerKey(grant);
  const existing = await ledgerRead(ledger, key);
  const binding = bindingFromGrant(grant, request);
  if (existing !== null) {
    const result = validateApprovalLedgerStream(existing, { key, grant, grantRawSha256, request });
    if (!result.valid) {
      const reservationEvent = existing?.events?.find?.(({ type }) => type === 'NONCE_RESERVED');
      if (reservationEvent && !immutableBindingMatches(reservationEvent, binding)) {
        throw approvalError('APPROVAL_MERGE_AUTHORIZATION_REPLAYED');
      }
      if (reservationEvent && !requestBindingMatches(reservationEvent, binding)) {
        throw approvalError('APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT');
      }
      throw approvalError('APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED');
    }
    if (result.facts.revocations.length > 0) throw approvalError('APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
    if (!result.facts.reservation) throw approvalError('APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT');
    const reservation = reservationFrom(grant, request, result.facts.reservation);
    return deepFreeze({
      outcome: 'IDEMPOTENT_EXISTING',
      reservation,
      reservedLedgerRevision: reservation.reservedLedgerRevision,
    });
  }
  const event = frozenClone({ type: 'NONCE_RESERVED', ...binding, reservedAt: observedAt });
  const expectedCommittedRevision = expectedLedgerRevision + 1;
  const result = await ledgerCas(ledger, { expectedRevision: expectedLedgerRevision, key, event });
  if (!committedAt(result, expectedCommittedRevision)) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT');
  }
  const stream = await ledgerRead(ledger, key);
  const facts = validStreamFacts(stream, { key, grant, grantRawSha256, request });
  if (facts.reservation?.ledgerRevision !== expectedCommittedRevision) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT');
  }
  const reservation = reservationFrom(grant, request, facts.reservation);
  freshDispatchCapabilities.add(reservation);
  return deepFreeze({ outcome: 'RESERVED', reservation, reservedLedgerRevision: expectedCommittedRevision });
};

export const executeReservedMerge = async (reservation, mergeRequester, ledger, now) => {
  let dispatchAt;
  try {
    dispatchAt = nowIso(now);
  } catch {
    return holdExecution('APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
  }
  if (!freshDispatchCapabilities.has(reservation)) {
    return holdExecution('APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT');
  }
  if (typeof mergeRequester?.requestMerge !== 'function') {
    return holdExecution('APPROVAL_MERGE_AUTHORIZATION_REQUEST_INVALID');
  }
  let observed;
  try {
    observed = await reservationStream(reservation, ledger);
  } catch (error) {
    const code = error?.message?.startsWith('APPROVAL_')
      ? error.message
      : 'APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED';
    return holdExecution(code);
  }
  freshDispatchCapabilities.delete(reservation);
  if (Date.parse(reservation.grant.authorized_at) > Date.parse(dispatchAt)
    || Date.parse(dispatchAt) >= Date.parse(reservation.grant.expires_at)) {
    return holdExecution('APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
  }
  const laterEvents = observed.stream.events.filter(
    ({ ledgerRevision }) => ledgerRevision > reservation.reservedLedgerRevision,
  );
  if (laterEvents.length > 0) {
    return holdExecution(laterEvents.some(({ type }) => type === 'GRANT_REVOKED')
      ? 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE'
      : 'APPROVAL_MERGE_ACK_UNKNOWN');
  }
  const guardRevision = observed.stream.committedRevision + 1;
  const guard = frozenClone({
    type: 'MERGE_ACK_UNKNOWN',
    reasonCode: 'PHYSICAL_REQUEST_DISPATCHING',
    observedAt: dispatchAt,
  });
  const result = await ledgerCas(ledger, {
    expectedRevision: observed.stream.committedRevision,
    key: reservation.key,
    event: guard,
  });
  if (!committedAt(result, guardRevision)) {
    return holdExecution('APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT');
  }
  let guarded;
  try {
    guarded = await reservationStream(reservation, ledger);
  } catch {
    return holdExecution('APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED');
  }
  if (guarded.stream.committedRevision !== guardRevision
    || guarded.facts.acknowledgement?.ledgerRevision !== guardRevision
    || guarded.facts.acknowledgement?.observedAt !== dispatchAt) {
    return holdExecution('APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT');
  }
  try {
    const response = await mergeRequester.requestMerge(frozenClone({
      requestId: reservation.request.requestId,
      repositoryId: reservation.request.repositoryId,
      prNumber: reservation.request.prNumber,
      baseSha: reservation.request.baseSha,
      headSha: reservation.request.headSha,
      mergeMethod: reservation.request.mergeMethod,
    }));
    return response?.acknowledgement === 'ACKNOWLEDGED'
      ? frozenClone({ outcome: 'ACKNOWLEDGED' })
      : frozenClone({ outcome: 'ACK_UNKNOWN', blockingCode: 'APPROVAL_MERGE_ACK_UNKNOWN' });
  } catch {
    return frozenClone({ outcome: 'ACK_UNKNOWN', blockingCode: 'APPROVAL_MERGE_ACK_UNKNOWN' });
  }
};

const readbackCode = (reservation, readback, now) => {
  const grant = reservation.grant;
  if (!hasExactKeys(readback, READBACK_KEYS)
    || !hasExactKeys(readback.currentMain, CURRENT_MAIN_KEYS)
    || !hasExactKeys(readback.independentVerifier, VERIFIER_KEYS)
    || !hasExactKeys(readback.independentVerifier.repository, VERIFIER_REPOSITORY_KEYS)) {
    return 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED';
  }
  if (readback.repositoryId !== grant.repository.id
    || readback.prNumber !== grant.pr_number
    || readback.baseSha !== grant.base_sha
    || readback.authorizedHeadSha !== grant.head_sha) return 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE';
  if (!isCanonicalInstant(readback.currentMain?.readAt)
    || Date.parse(readback.currentMain.readAt) < Date.parse(grant.authorized_at)
    || Date.parse(readback.currentMain.readAt) >= Date.parse(grant.expires_at)) {
    return 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE';
  }
  if (readback.prState !== 'MERGED'
    || !isGitSha(readback.resultCommitSha)
    || readback.observedMergeMethod !== grant.allowed_merge_method
    || readback.resultAssociatedWithPr !== true
    || readback.headAssociatedWithResult !== true
    || readback.resultReachableFromCurrentMain !== true
    || readback.currentMain.ref !== 'refs/heads/main'
    || !isGitSha(readback.currentMain.sha)
    || Date.parse(readback.currentMain.readAt) > now.getTime()
    || !isDigest(readback.preReadbackSha256)
    || !isDigest(readback.postReadbackSha256)) return 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED';
  const verifier = readback.independentVerifier;
  if (verifier.repository.id === grant.repository.id
    || !isSafePositiveInteger(verifier.repository.id)
    || Buffer.byteLength(verifier.repository.full_name, 'utf8') > 256
    || !/^\.github\/workflows\/[a-zA-Z0-9._-]+\.ya?ml$/.test(verifier.path)
    || !isGitSha(verifier.sha)
    || !isSafePositiveInteger(verifier.runId)
    || !isSafePositiveInteger(verifier.attempt)
    || typeof verifier.identity !== 'string'
    || Buffer.byteLength(verifier.identity, 'utf8') > 256) return 'APPROVAL_INDEPENDENCE_NOT_PROVEN';
  return null;
};
const consumptionFrom = (reservation, readback) => ({
  schema_version: 'program-c-merge-authorization-consumption/v1',
  consumption_id: reservation.request.reservationId.replace(/^merge-reservation-/, 'program-c-consumption-'),
  grant_id: reservation.grant.grant_id,
  grant_raw_sha256: reservation.grantRawSha256,
  single_use_nonce: reservation.grant.single_use_nonce,
  repository: clone(reservation.grant.repository),
  decision_adr: reservation.grant.decision_adr,
  decision_revision: reservation.grant.decision_revision,
  policy_revision: reservation.grant.policy_revision,
  stage: reservation.grant.stage,
  pr_number: reservation.grant.pr_number,
  authorized_head_sha: reservation.grant.head_sha,
  result_commit_sha: readback.resultCommitSha,
  observed_merge_method: readback.observedMergeMethod,
  consumed_at: readback.currentMain.readAt,
  nonce_ledger_key: `program-c-merge:${reservation.grant.single_use_nonce}`,
  nonce_ledger_reserved_revision: reservation.reservedLedgerRevision,
  independent_verifier: {
    repository: clone(readback.independentVerifier.repository),
    path: readback.independentVerifier.path,
    sha: readback.independentVerifier.sha,
    run_id: readback.independentVerifier.runId,
    attempt: readback.independentVerifier.attempt,
    identity: readback.independentVerifier.identity,
  },
  current_main: {
    ref: readback.currentMain.ref,
    sha: readback.currentMain.sha,
    read_at: readback.currentMain.readAt,
  },
  pre_readback_sha256: readback.preReadbackSha256,
  post_readback_sha256: readback.postReadbackSha256,
});
const appendHold = async (reservation, stream, facts, ledger, code, observedAt) => {
  if (facts.holds.some(({ reasonCode }) => reasonCode === code)) {
    return holdReconciliation(code, stream.committedRevision);
  }
  const nextRevision = stream.committedRevision + 1;
  const result = await ledgerCas(ledger, {
    expectedRevision: stream.committedRevision,
    key: reservation.key,
    event: frozenClone({ type: 'BOUNDED_HOLD', reasonCode: code, observedAt }),
  });
  return holdReconciliation(code, committedAt(result, nextRevision)
    ? nextRevision
    : conflictRevision(result, stream.committedRevision));
};

export const reconcileMergeAuthorizationReservation = async (
  reservation,
  readback,
  ledger,
  now,
) => {
  const observedAt = nowIso(now);
  let observed;
  try {
    observed = await reservationStream(reservation, ledger);
  } catch (error) {
    return holdReconciliation(
      error?.message?.startsWith('APPROVAL_') ? error.message : 'APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED',
      0,
    );
  }
  const effectiveRevocation = observed.facts.revocations.find(
    ({ effectiveAt }) => Date.parse(effectiveAt) <= Date.parse(observedAt),
  );
  if (effectiveRevocation) {
    return appendHold(
      reservation,
      observed.stream,
      observed.facts,
      ledger,
      'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE',
      observedAt,
    );
  }
  if (observed.facts.consumptionEvent) {
    const event = observed.facts.consumptionEvent;
    return frozenClone({
      outcome: 'CONSUMPTION_RECORDED',
      consumption: event.consumption,
      consumptionRawSha256: event.consumptionRawSha256,
      committedLedgerRevision: observed.stream.committedRevision,
    });
  }
  const code = readbackCode(reservation, readback, now);
  if (code) return appendHold(reservation, observed.stream, observed.facts, ledger, code, observedAt);
  let stream = observed.stream;
  let facts = observed.facts;
  if (facts.result && (
    facts.result.resultCommitSha !== readback.resultCommitSha
    || facts.result.observedMergeMethod !== readback.observedMergeMethod
  )) return appendHold(reservation, stream, facts, ledger, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED', observedAt);
  if (!facts.result) {
    const nextRevision = stream.committedRevision + 1;
    const result = await ledgerCas(ledger, {
      expectedRevision: stream.committedRevision,
      key: reservation.key,
      event: frozenClone({
        type: 'MERGE_RESULT_OBSERVED',
        resultCommitSha: readback.resultCommitSha,
        observedMergeMethod: readback.observedMergeMethod,
        observedAt: readback.currentMain.readAt,
      }),
    });
    if (!committedAt(result, nextRevision)) {
      return holdReconciliation(
        'APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT',
        conflictRevision(result, stream.committedRevision),
      );
    }
    stream = await ledgerRead(ledger, reservation.key);
    facts = validStreamFacts(stream, streamContext(reservation));
    if (facts.result?.ledgerRevision !== nextRevision) {
      return holdReconciliation('APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT', stream.committedRevision);
    }
  }
  const consumption = consumptionFrom(reservation, readback);
  if (!validateProgramCMergeAuthorizationConsumption(consumption).valid
    || !isBoundedId(consumption.consumption_id, MERGE_CONSUMPTION_ID_PATTERN)) {
    return appendHold(
      reservation,
      stream,
      facts,
      ledger,
      'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH',
      observedAt,
    );
  }
  const consumptionRawSha256 = canonicalApprovalDigest(consumption);
  const nextRevision = stream.committedRevision + 1;
  const result = await ledgerCas(ledger, {
    expectedRevision: stream.committedRevision,
    key: reservation.key,
    event: frozenClone({
      type: 'CONSUMPTION_RECORDED', consumption, consumptionRawSha256, recordedAt: observedAt,
    }),
  });
  if (!committedAt(result, nextRevision)) {
    const refreshed = await ledgerRead(ledger, reservation.key);
    const validation = validateApprovalLedgerStream(refreshed, streamContext(reservation, {
      expectedConsumption: consumption,
      expectedConsumptionRawSha256: consumptionRawSha256,
    }));
    if (validation.valid && validation.facts.consumptionEvent) {
      return frozenClone({
        outcome: 'CONSUMPTION_RECORDED',
        consumption: validation.facts.consumptionEvent.consumption,
        consumptionRawSha256: validation.facts.consumptionEvent.consumptionRawSha256,
        committedLedgerRevision: refreshed.committedRevision,
      });
    }
    return holdReconciliation(
      'APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT',
      conflictRevision(result, stream.committedRevision),
    );
  }
  const committed = await ledgerRead(ledger, reservation.key);
  const validation = validateApprovalLedgerStream(committed, streamContext(reservation, {
    expectedConsumption: consumption,
    expectedConsumptionRawSha256: consumptionRawSha256,
  }));
  if (!validation.valid || validation.facts.consumptionEvent?.ledgerRevision !== nextRevision) {
    return holdReconciliation('APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED', committed?.committedRevision ?? nextRevision);
  }
  return frozenClone({
    outcome: 'CONSUMPTION_RECORDED',
    consumption,
    consumptionRawSha256,
    committedLedgerRevision: nextRevision,
  });
};
