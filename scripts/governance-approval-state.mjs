import { createHash } from 'node:crypto';
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
  sameJson,
} from './governance-approval-readback-common.mjs';
import {
  validateProgramCMergeAuthorizationConsumption,
  validateProgramCMergeAuthorizationGrant,
} from './governance-approval-schema-validator.mjs';
const LEDGER_CLASS = 'SHARED_DURABLE_CAS';
const MAX_LEDGER_EVENTS = 64;
const REQUEST_KEYS = Object.freeze([
  'requestId', 'reservationId', 'repositoryId', 'decisionAdr', 'decisionRevision',
  'policyRevision', 'stage', 'prNumber', 'baseSha', 'headSha', 'mergeMethod',
]);
const KEY_KEYS = Object.freeze(['repositoryId', 'singleUseNonce']);
const READBACK_KEYS = Object.freeze([
  'repositoryId', 'prNumber', 'baseSha', 'authorizedHeadSha', 'prState',
  'resultCommitSha', 'observedMergeMethod', 'resultAssociatedWithPr',
  'headAssociatedWithResult', 'resultReachableFromCurrentMain', 'currentMain',
  'independentVerifier', 'preReadbackSha256', 'postReadbackSha256',
]);
const EVENT_TYPES = new Set([
  'NONCE_RESERVED', 'GRANT_REVOKED', 'MERGE_ACK_UNKNOWN',
  'MERGE_RESULT_OBSERVED', 'CONSUMPTION_RECORDED', 'BOUNDED_HOLD',
]);
const EVENT_KEYS = Object.freeze({
  NONCE_RESERVED: ['type', 'grantId', 'grantRawSha256', 'requestId', 'reservationId', 'repositoryId', 'decisionAdr', 'decisionRevision', 'policyRevision', 'stage', 'prNumber', 'baseSha', 'headSha', 'mergeMethod', 'reservedAt', 'ledgerRevision'],
  GRANT_REVOKED: ['type', 'grantId', 'grantRawSha256', 'reasonCode', 'effectiveAt', 'ledgerRevision'],
  MERGE_ACK_UNKNOWN: ['type', 'reasonCode', 'observedAt', 'ledgerRevision'],
  MERGE_RESULT_OBSERVED: ['type', 'resultCommitSha', 'observedMergeMethod', 'observedAt', 'ledgerRevision'],
  CONSUMPTION_RECORDED: ['type', 'consumption', 'consumptionRawSha256', 'recordedAt', 'ledgerRevision'],
  BOUNDED_HOLD: ['type', 'reasonCode', 'observedAt', 'ledgerRevision'],
});
const clone = (value) => structuredClone(value);
const frozenClone = (value) => deepFreeze(clone(value));
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const canonicalDigest = (value) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
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
  && ledger.durabilityClass === LEDGER_CLASS
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
const streamValid = (stream, key) => (
  isPlainObject(stream)
  && hasExactKeys(stream.key, KEY_KEYS)
  && sameJson(stream.key, key)
  && isSafeNonNegativeInteger(stream.committedRevision)
  && Array.isArray(stream.events)
  && stream.events.length <= MAX_LEDGER_EVENTS
  && stream.events.every((event, index) => (
    isPlainObject(event)
    && EVENT_TYPES.has(event.type)
    && hasExactKeys(event, EVENT_KEYS[event.type])
    && isSafePositiveInteger(event.ledgerRevision)
    && (index === 0 || event.ledgerRevision > stream.events[index - 1].ledgerRevision)
  ))
  && (stream.events.length === 0
    ? stream.committedRevision === 0
    : stream.committedRevision === stream.events.at(-1).ledgerRevision)
);
const bindingFromGrant = (grant, request) => ({
  grantId: grant.grant_id,
  grantRawSha256: canonicalDigest(grant),
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
const reservationMatches = (event, binding) => (
  event.type === 'NONCE_RESERVED'
  && Object.entries(binding).every(([key, value]) => event[key] === value)
);
const immutableBindingMatches = (event, binding) => (
  event.type === 'NONCE_RESERVED'
  && [
    'grantId', 'grantRawSha256', 'repositoryId', 'decisionAdr', 'decisionRevision',
    'policyRevision', 'stage', 'prNumber', 'baseSha', 'headSha', 'mergeMethod',
  ].every((key) => event[key] === binding[key])
);
const reservationFrom = (grant, request, event, executionMode) => frozenClone({
  schemaVersion: 'merge-authorization-reservation/v1',
  key: { repositoryId: grant.repository.id, singleUseNonce: grant.single_use_nonce },
  grant,
  grantRawSha256: canonicalDigest(grant),
  request,
  reservedLedgerRevision: event.ledgerRevision,
  reservedAt: event.reservedAt,
  executionMode,
});
const throwFirstSchemaIssue = (validation, fallback) => {
  if (!validation.valid) throw approvalError(validation.issues[0]?.stable_code ?? fallback);
};
const validateGrantAndRequest = (grant, grantRawSha256, request, expectedRevision) => {
  throwFirstSchemaIssue(validateProgramCMergeAuthorizationGrant(grant), 'APPROVAL_MERGE_AUTHORIZATION_GRANT_REQUIRED');
  if (!isDigest(grantRawSha256) || grantRawSha256 !== canonicalDigest(grant)) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH');
  }
  if (!hasExactKeys(request, REQUEST_KEYS) || !isSafeNonNegativeInteger(expectedRevision)) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_REQUEST_INVALID');
  }
  const expected = bindingFromGrant(grant, request);
  if (!isSafePositiveInteger(request.repositoryId)
    || !isSafePositiveInteger(request.prNumber)
    || request.repositoryId !== expected.repositoryId
    || request.decisionAdr !== expected.decisionAdr
    || request.decisionRevision !== expected.decisionRevision
    || request.policyRevision !== expected.policyRevision
    || request.stage !== expected.stage
    || request.prNumber !== expected.prNumber
    || request.baseSha !== expected.baseSha
    || request.headSha !== expected.headSha
    || request.mergeMethod !== expected.mergeMethod
    || typeof request.requestId !== 'string'
    || typeof request.reservationId !== 'string') {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_REQUEST_INVALID');
  }
};
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
  if (Date.parse(grant.authorized_at) > Date.parse(observedAt) || Date.parse(observedAt) >= Date.parse(grant.expires_at)) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
  }
  const key = exactLedgerKey(grant);
  const existing = await ledgerRead(ledger, key);
  const binding = bindingFromGrant(grant, request);
  if (existing !== null) {
    if (!streamValid(existing, key)) throw approvalError('APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED');
    const reservationEvent = existing.events.find(({ type }) => type === 'NONCE_RESERVED');
    const revokedBeforeReservation = existing.events.some((event) => (
      event.type === 'GRANT_REVOKED'
      && (reservationEvent === undefined || event.ledgerRevision < reservationEvent.ledgerRevision)
      && event.grantId === grant.grant_id
      && event.grantRawSha256 === grantRawSha256
    ));
    if (revokedBeforeReservation) throw approvalError('APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
    if (reservationEvent === undefined) throw approvalError('APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT');
    if (!immutableBindingMatches(reservationEvent, binding)) {
      throw approvalError('APPROVAL_MERGE_AUTHORIZATION_REPLAYED');
    }
    if (!reservationMatches(reservationEvent, binding)) {
      throw approvalError('APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT');
    }
    return frozenClone({
      outcome: 'IDEMPOTENT_EXISTING',
      reservation: reservationFrom(grant, request, reservationEvent, 'READBACK_ONLY'),
      reservedLedgerRevision: reservationEvent.ledgerRevision,
    });
  }
  const event = {
    type: 'NONCE_RESERVED',
    ...binding,
    reservedAt: observedAt,
  };
  const result = await ledgerCas(ledger, {
    expectedRevision: expectedLedgerRevision,
    key,
    event: frozenClone(event),
  });
  if (result?.outcome !== 'COMMITTED' || !isSafePositiveInteger(result.committedRevision)) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT');
  }
  const committedEvent = { ...event, ledgerRevision: result.committedRevision };
  return frozenClone({
    outcome: 'RESERVED',
    reservation: reservationFrom(grant, request, committedEvent, 'FRESH_CAS_WINNER'),
    reservedLedgerRevision: result.committedRevision,
  });
};
const reservationStream = async (reservation, ledger) => {
  requireLedger(ledger);
  if (!isPlainObject(reservation)
    || reservation.schemaVersion !== 'merge-authorization-reservation/v1'
    || !hasExactKeys(reservation.key, KEY_KEYS)
    || !isPlainObject(reservation.grant)
    || !isPlainObject(reservation.request)
    || !isSafePositiveInteger(reservation.reservedLedgerRevision)) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_RESERVATION_REQUIRED');
  }
  const stream = await ledgerRead(ledger, reservation.key);
  if (!streamValid(stream, reservation.key)) throw approvalError('APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED');
  const event = stream.events.find(({ ledgerRevision }) => ledgerRevision === reservation.reservedLedgerRevision);
  const binding = bindingFromGrant(reservation.grant, reservation.request);
  if (!event || !reservationMatches(event, binding) || reservation.grantRawSha256 !== binding.grantRawSha256) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_REPLAYED');
  }
  return { stream, reservationEvent: event };
};
export const executeReservedMerge = async (reservation, mergeRequester, ledger) => {
  let observed;
  try {
    observed = await reservationStream(reservation, ledger);
  } catch (error) {
    if (error?.message === 'APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED') throw error;
    const code = typeof error?.message === 'string' && error.message.startsWith('APPROVAL_')
      ? error.message
      : 'APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED';
    return frozenClone({ outcome: 'HOLD', blockingCode: code });
  }
  if (reservation.executionMode !== 'FRESH_CAS_WINNER'
    || typeof mergeRequester?.requestMerge !== 'function') {
    return frozenClone({ outcome: 'HOLD', blockingCode: 'APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT' });
  }
  const laterEvents = observed.stream.events.filter((event) => event.ledgerRevision > reservation.reservedLedgerRevision);
  if (laterEvents.length > 0) {
    const revoked = laterEvents.some(({ type }) => type === 'GRANT_REVOKED');
    return frozenClone({
      outcome: 'HOLD',
      blockingCode: revoked
        ? 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE'
        : 'APPROVAL_MERGE_ACK_UNKNOWN',
    });
  }
  const dispatchGuard = await ledgerCas(ledger, {
    expectedRevision: observed.stream.committedRevision,
    key: reservation.key,
    event: frozenClone({
      type: 'MERGE_ACK_UNKNOWN',
      reasonCode: 'PHYSICAL_REQUEST_DISPATCHING',
      observedAt: reservation.reservedAt,
    }),
  });
  if (dispatchGuard?.outcome !== 'COMMITTED') {
    return frozenClone({ outcome: 'HOLD', blockingCode: 'APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT' });
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
const readbackCode = (reservation, readback) => {
  const grant = reservation.grant;
  if (!hasExactKeys(readback, READBACK_KEYS)
    || !isPlainObject(readback.currentMain)
    || !isPlainObject(readback.independentVerifier)) return 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED';
  if (readback.repositoryId !== grant.repository.id
    || readback.prNumber !== grant.pr_number
    || readback.baseSha !== grant.base_sha
    || readback.authorizedHeadSha !== grant.head_sha) return 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE';
  if (readback.prState !== 'MERGED'
    || !isGitSha(readback.resultCommitSha)
    || readback.observedMergeMethod !== grant.allowed_merge_method
    || readback.resultAssociatedWithPr !== true
    || readback.headAssociatedWithResult !== true
    || readback.resultReachableFromCurrentMain !== true
    || readback.currentMain.ref !== 'refs/heads/main'
    || readback.currentMain.sha !== readback.resultCommitSha
    || !isCanonicalInstant(readback.currentMain.readAt)
    || !isDigest(readback.preReadbackSha256)
    || !isDigest(readback.postReadbackSha256)) return 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED';
  const verifier = readback.independentVerifier;
  if (!isPlainObject(verifier.repository)
    || verifier.repository.id === grant.repository.id
    || !isSafePositiveInteger(verifier.repository.id)
    || typeof verifier.repository.full_name !== 'string'
    || !verifier.path?.startsWith('.github/workflows/')
    || !isGitSha(verifier.sha)
    || !isSafePositiveInteger(verifier.runId)
    || !isSafePositiveInteger(verifier.attempt)
    || typeof verifier.identity !== 'string') return 'APPROVAL_INDEPENDENCE_NOT_PROVEN';
  return null;
};
const consumptionFrom = (reservation, readback) => ({
  schema_version: 'program-c-merge-authorization-consumption/v1',
  consumption_id: reservation.request.reservationId.replace(/^merge-reservation/, 'program-c-consumption'),
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
const existingConsumption = (stream, reservation) => {
  const event = stream.events.find(({ type }) => type === 'CONSUMPTION_RECORDED');
  if (!event) return null;
  const valid = validateProgramCMergeAuthorizationConsumption(event.consumption);
  if (!valid.valid
    || event.consumption.grant_id !== reservation.grant.grant_id
    || event.consumption.grant_raw_sha256 !== reservation.grantRawSha256
    || event.consumptionRawSha256 !== canonicalDigest(event.consumption)) {
    throw approvalError('APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH');
  }
  return event;
};
const holdResult = (code, revision) => frozenClone({
  outcome: 'HOLD',
  blockingCode: code,
  consumption: null,
  consumptionRawSha256: null,
  committedLedgerRevision: revision,
});
export const reconcileMergeAuthorizationReservation = async (
  reservation,
  readback,
  ledger,
  now,
) => {
  const observedAt = nowIso(now);
  const { stream } = await reservationStream(reservation, ledger);
  const priorConsumption = existingConsumption(stream, reservation);
  if (priorConsumption) {
    return frozenClone({
      outcome: 'CONSUMPTION_RECORDED',
      consumption: priorConsumption.consumption,
      consumptionRawSha256: priorConsumption.consumptionRawSha256,
      committedLedgerRevision: stream.committedRevision,
    });
  }
  const revoked = stream.events.some((event) => (
    event.type === 'GRANT_REVOKED'
    && event.ledgerRevision > reservation.reservedLedgerRevision
    && event.grantId === reservation.grant.grant_id
    && event.grantRawSha256 === reservation.grantRawSha256
  ));
  const code = revoked ? 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE' : readbackCode(reservation, readback);
  if (code) {
    if (stream.events.some((event) => event.type === 'BOUNDED_HOLD' && event.reasonCode === code)) {
      return holdResult(code, stream.committedRevision);
    }
    const appended = await ledgerCas(ledger, {
      expectedRevision: stream.committedRevision,
      key: reservation.key,
      event: frozenClone({ type: 'BOUNDED_HOLD', reasonCode: code, observedAt }),
    });
    const revision = appended?.outcome === 'COMMITTED' ? appended.committedRevision : appended?.currentRevision;
    return holdResult(code, revision ?? stream.committedRevision);
  }
  let revision = stream.committedRevision;
  if (!stream.events.some(({ type }) => type === 'MERGE_RESULT_OBSERVED')) {
    const observed = await ledgerCas(ledger, {
      expectedRevision: revision,
      key: reservation.key,
      event: frozenClone({
        type: 'MERGE_RESULT_OBSERVED',
        resultCommitSha: readback.resultCommitSha,
        observedMergeMethod: readback.observedMergeMethod,
        observedAt: readback.currentMain.readAt,
      }),
    });
    if (observed?.outcome !== 'COMMITTED') {
      return holdResult('APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT', observed?.currentRevision ?? revision);
    }
    revision = observed.committedRevision;
  }
  const consumption = consumptionFrom(reservation, readback);
  throwFirstSchemaIssue(
    validateProgramCMergeAuthorizationConsumption(consumption),
    'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH',
  );
  const consumptionRawSha256 = canonicalDigest(consumption);
  const recorded = await ledgerCas(ledger, {
    expectedRevision: revision,
    key: reservation.key,
    event: frozenClone({
      type: 'CONSUMPTION_RECORDED', consumption, consumptionRawSha256, recordedAt: observedAt,
    }),
  });
  if (recorded?.outcome !== 'COMMITTED') {
    const refreshed = await ledgerRead(ledger, reservation.key);
    const raced = streamValid(refreshed, reservation.key) ? existingConsumption(refreshed, reservation) : null;
    if (raced) {
      return frozenClone({
        outcome: 'CONSUMPTION_RECORDED', consumption: raced.consumption,
        consumptionRawSha256: raced.consumptionRawSha256,
        committedLedgerRevision: refreshed.committedRevision,
      });
    }
    return holdResult('APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT', recorded?.currentRevision ?? revision);
  }
  return frozenClone({
    outcome: 'CONSUMPTION_RECORDED', consumption,
    consumptionRawSha256, committedLedgerRevision: recorded.committedRevision,
  });
};
const baseState = (policy) => ({
  schemaVersion: 'approval-decision-state/v1',
  repository: clone(policy.repository),
  decisionId: policy.decisionId,
  decisionRevision: policy.decisionRevision,
  policyRevision: policy.policyRevision,
  state: 'OWNER_ASSIGNMENT_REQUIRED',
  currentHeadSha: policy.currentHeadSha,
  currentBaseSha: policy.currentBaseSha,
  legalState: 'PENDING',
  evidenceTrustState: 'EXTERNAL_UNVERIFIED',
  evidenceSlots: { product: 'MISSING', privacy: 'MISSING', codeowner: 'MISSING', qa: 'MISSING', security: 'MISSING', machine: 'MISSING' },
  receipt: null,
  receiptHistory: [],
  mergeAuthorization: null,
  revocationStatus: 'ACTIVE',
  supersessionStatus: 'CURRENT',
  blockingCodes: ['APPROVAL_OWNER_ASSIGNMENT_REQUIRED'],
  eventHistory: [],
  policySnapshot: clone(policy),
});
const transitionError = (code = 'APPROVAL_STATE_TRANSITION_INVALID') => { throw approvalError(code); };
export const reduceApprovalDecisionState = (events, policy, now) => {
  nowIso(now);
  if (!Array.isArray(events) || !isPlainObject(policy) || !isPlainObject(policy.repository)) {
    throw approvalError('APPROVAL_STATE_INPUT_INVALID');
  }
  let state = baseState(policy);
  for (const rawEvent of events) {
    if (!isPlainObject(rawEvent) || typeof rawEvent.type !== 'string') transitionError();
    const event = clone(rawEvent);
    if (event.type === 'AUTHORITIES_ASSIGNED') {
      if (!['OWNER_ASSIGNMENT_REQUIRED', 'REVOKED', 'REJECTED'].includes(state.state)) transitionError();
      state = { ...state, state: 'PROPOSED', blockingCodes: [], revocationStatus: 'ACTIVE' };
    } else if (event.type === 'PROPOSAL_RENDERED') {
      if (!['PROPOSED', 'STALE_AFTER_PUSH'].includes(state.state) || event.headSha !== policy.currentHeadSha) transitionError();
      state = { ...state, state: 'AWAITING_PRODUCT_REVIEW', currentHeadSha: event.headSha, blockingCodes: ['APPROVAL_REVIEW_REQUIRED'] };
    } else if (event.type === 'PRODUCT_REVIEW_VERIFIED') {
      if (state.state !== 'AWAITING_PRODUCT_REVIEW' || event.headSha !== state.currentHeadSha) transitionError();
      state = { ...state, state: 'AWAITING_PRIVACY_REVIEW', evidenceSlots: { ...state.evidenceSlots, product: 'VERIFIED' }, blockingCodes: ['APPROVAL_REVIEW_REQUIRED'] };
    } else if (event.type === 'RECEIPT_VERIFIED') {
      if (state.state !== 'AWAITING_PRIVACY_REVIEW' || event.headSha !== state.currentHeadSha || !isPlainObject(event.receipt)) transitionError();
      state = {
        ...state,
        state: 'VERIFIED',
        legalState: 'NO_BLOCKER_RECORDED',
        evidenceTrustState: event.receipt.trustState,
        evidenceSlots: { product: 'VERIFIED', privacy: 'VERIFIED', codeowner: 'VERIFIED', qa: 'VERIFIED', security: 'VERIFIED', machine: 'VERIFIED' },
        receipt: clone(event.receipt),
        mergeAuthorization: clone(event.mergeAuthorization),
        blockingCodes: ['APPROVAL_ACCEPTANCE_REVALIDATION_REQUIRED'],
      };
    } else if (event.type === 'HEAD_CHANGED') {
      if (!isGitSha(event.headSha) || ['ACCEPTED', 'REVOKED'].includes(state.state)) transitionError();
      state = { ...state, state: 'STALE_AFTER_PUSH', currentHeadSha: event.headSha, evidenceTrustState: 'EXTERNAL_UNVERIFIED', receipt: null, mergeAuthorization: null, blockingCodes: ['APPROVAL_HEAD_MISMATCH'] };
    } else if (event.type === 'REVIEW_REJECTED') {
      if (!['AWAITING_PRODUCT_REVIEW', 'AWAITING_PRIVACY_REVIEW', 'VERIFIED'].includes(state.state)) transitionError();
      state = { ...state, state: 'REJECTED', blockingCodes: ['APPROVAL_REVIEW_REJECTED'] };
    } else if (event.type === 'RECEIPT_SUPERSEDED') {
      if (!state.receipt || state.receipt.receiptId !== event.predecessorReceiptId || !isPlainObject(event.successor)) transitionError();
      state = {
        ...state,
        state: 'STALE_AFTER_PUSH',
        receiptHistory: [...state.receiptHistory, { ...clone(state.receipt), lifecycleState: 'SUPERSEDED' }],
        receipt: clone(event.successor),
        evidenceTrustState: 'EXTERNAL_UNVERIFIED',
        mergeAuthorization: null,
        supersessionStatus: 'SUPERSEDED_WITH_CURRENT_SUCCESSOR',
        blockingCodes: ['APPROVAL_INDEPENDENCE_NOT_PROVEN'],
      };
    } else if (event.type === 'ACCEPTANCE_REVALIDATED') {
      if (state.state !== 'VERIFIED' || event.validation?.valid !== true || event.validation?.issues?.length !== 0) {
        transitionError('APPROVAL_ACCEPTANCE_REVALIDATION_STALE');
      }
      state = { ...state, state: 'ACCEPTED', blockingCodes: [] };
    } else if (event.type === 'RECEIPT_REVOKED') {
      if (!['VERIFIED', 'ACCEPTED'].includes(state.state)) transitionError();
      state = { ...state, state: 'REVOKED', revocationStatus: 'REVOKED', blockingCodes: ['APPROVAL_POLICY_REVOKED'] };
    } else {
      transitionError('APPROVAL_STATE_EVENT_UNSUPPORTED');
    }
    state = { ...state, eventHistory: [...state.eventHistory, event] };
  }
  return frozenClone(state);
};
export { revalidateApprovalAtAcceptance } from './governance-approval-acceptance.mjs';
const STATUS_COPY = Object.freeze({
  OWNER_ASSIGNMENT_REQUIRED: ['approval.owner_required', '审批责任人尚未完成可信指派，当前决策不能进入评审。', '查看缺失角色'],
  PROPOSED: ['approval.proposed', '决策提案已生成，尚未进入精确版本审核。', '打开提案'],
  AWAITING_PRODUCT_REVIEW: ['approval.product_review_required', '等待产品负责人审核当前版本。任何新提交都会使本轮审核失效。', '打开精确版本'],
  AWAITING_PRIVACY_REVIEW: ['approval.privacy_review_required', '产品方向已确认，正在等待隐私审核；当前政策尚未生效。', '查看隐私与 Legal 前置条件'],
  STALE_AFTER_PUSH: ['approval.readback_stale', '审批后内容或信任条件已变化，需要基于新版本重新审核。', '生成新修订并重新送审'],
  VERIFIED: ['approval.acceptance_revalidation_required', '独立验证已通过，但尚未取得本次合并授权。', '查看证据并请求合并授权'],
  ACCEPTED: ['approval.accepted', '决策已完成接受时复核并生效；其他运行与发布门仍保持独立。', '查看剩余门'],
  REVOKED: ['approval.policy_revoked', '当前政策已撤销，不可用于新的准入或放行。', '创建替代修订'],
  REJECTED: ['approval.review_rejected', '当前修订已被拒绝，不能继续复用既有审批。', '创建修订'],
});

export const renderApprovalStatusReadModel = (state) => {
  if (!isPlainObject(state) || !STATUS_COPY[state.state]) throw approvalError('APPROVAL_STATUS_EVIDENCE_REQUIRED');
  const [messageKey, message, recoveryAction] = STATUS_COPY[state.state];
  const blockingCodes = Array.isArray(state.blockingCodes)
    ? state.blockingCodes.filter((code) => typeof code === 'string' && code.startsWith('APPROVAL_')).slice(0, 16)
    : [];
  return frozenClone({
    schemaVersion: 'approval-status-read-model/v1',
    repository: clone(state.repository),
    decisionId: state.decisionId,
    decisionRevision: state.decisionRevision,
    policyRevision: state.policyRevision,
    state: state.state,
    legalState: state.legalState,
    evidenceTrustState: state.evidenceTrustState,
    evidenceSlots: clone(state.evidenceSlots),
    currentHeadSha: state.currentHeadSha,
    currentBaseSha: state.currentBaseSha,
    receipt: state.receipt === null ? null : {
      receiptId: state.receipt.receiptId,
      receiptCoreSha256: state.receipt.receiptCoreSha256,
      receiptRawSha256: state.receipt.receiptRawSha256,
    },
    mergeAuthorization: state.mergeAuthorization === null ? null : {
      grantId: state.mergeAuthorization.grantId,
      grantRawSha256: state.mergeAuthorization.grantRawSha256,
      consumptionId: state.mergeAuthorization.consumptionId,
      consumptionRawSha256: state.mergeAuthorization.consumptionRawSha256,
      reservedLedgerRevision: state.mergeAuthorization.reservedLedgerRevision,
      ledgerState: state.mergeAuthorization.ledgerState,
    },
    revocationStatus: state.revocationStatus,
    supersessionStatus: state.supersessionStatus,
    blockingCodes,
    highestPriorityBlocker: blockingCodes[0] ?? null,
    messageKey,
    message,
    recoveryAction,
  });
};
