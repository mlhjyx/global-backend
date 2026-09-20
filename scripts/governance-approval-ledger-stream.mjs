import { createHash } from 'node:crypto';
import {
  deepFreeze,
  hasExactKeys,
  isCanonicalInstant,
  isDigest,
  isGitSha,
  isPlainObject,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  resultFromCodes,
} from './governance-approval-readback-common.mjs';
import { validateProgramCMergeAuthorizationConsumption } from './governance-approval-schema-validator.mjs';

export const LEDGER_DURABILITY_CLASS = 'SHARED_DURABLE_CAS';
export const MAX_LEDGER_EVENTS = 64;
export const MERGE_REQUEST_ID_PATTERN = /^merge-request-[a-z0-9-]{4,96}$/;
export const MERGE_RESERVATION_ID_PATTERN = /^merge-reservation-[a-z0-9-]{4,96}$/;
export const MERGE_CONSUMPTION_ID_PATTERN = /^program-c-consumption-[a-z0-9-]{4,96}$/;
const DECISION_IDS = new Set(['ADR-026', 'ADR-027']);
const STAGES = new Set(['PROPOSAL_MERGE', 'ACCEPTANCE_MERGE']);
const METHODS = new Set(['MERGE', 'SQUASH', 'REBASE']);
const KEY_KEYS = Object.freeze(['repositoryId', 'singleUseNonce']);
const REQUEST_KEYS = Object.freeze([
  'requestId', 'reservationId', 'repositoryId', 'decisionAdr', 'decisionRevision',
  'policyRevision', 'stage', 'prNumber', 'baseSha', 'headSha', 'mergeMethod',
]);
const STREAM_KEYS = Object.freeze(['key', 'committedRevision', 'events']);
const SNAPSHOT_KEYS = Object.freeze(['durabilityClass', 'key', 'committedRevision', 'events']);
const EVENT_KEYS = Object.freeze({
  NONCE_RESERVED: ['type', 'grantId', 'grantRawSha256', 'requestId', 'reservationId', 'repositoryId', 'decisionAdr', 'decisionRevision', 'policyRevision', 'stage', 'prNumber', 'baseSha', 'headSha', 'mergeMethod', 'reservedAt', 'ledgerRevision'],
  GRANT_REVOKED: ['type', 'grantId', 'grantRawSha256', 'reasonCode', 'effectiveAt', 'ledgerRevision'],
  MERGE_ACK_UNKNOWN: ['type', 'reasonCode', 'observedAt', 'ledgerRevision'],
  MERGE_RESULT_OBSERVED: ['type', 'resultCommitSha', 'observedMergeMethod', 'observedAt', 'ledgerRevision'],
  CONSUMPTION_RECORDED: ['type', 'consumption', 'consumptionRawSha256', 'recordedAt', 'ledgerRevision'],
  BOUNDED_HOLD: ['type', 'reasonCode', 'observedAt', 'ledgerRevision'],
});
const EVENT_TYPES = new Set(Object.keys(EVENT_KEYS));
const GRANT_REVOCATION_REASONS = new Set(['AUTHORITY_REVOKED', 'POLICY_WITHDRAWN', 'SECURITY_INCIDENT']);
const clone = (value) => structuredClone(value);
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

export const canonicalApprovalDigest = (value) => (
  `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
);
export const approvalValuesEqual = (left, right) => canonical(left) === canonical(right);
export const isBoundedId = (value, pattern) => (
  typeof value === 'string'
  && Buffer.byteLength(value, 'utf8') <= 128
  && pattern.test(value)
);
const eventBytesBounded = (event) => {
  try {
    return Buffer.byteLength(JSON.stringify(event), 'utf8') <= 32_768;
  } catch {
    return false;
  }
};
const requestBindingMatches = (event, grant, grantRawSha256, request) => (
  event.grantId === grant.grant_id
  && event.grantRawSha256 === grantRawSha256
  && event.repositoryId === grant.repository.id
  && event.decisionAdr === grant.decision_adr
  && event.decisionRevision === grant.decision_revision
  && event.policyRevision === grant.policy_revision
  && event.stage === grant.stage
  && event.prNumber === grant.pr_number
  && event.baseSha === grant.base_sha
  && event.headSha === grant.head_sha
  && event.mergeMethod === grant.allowed_merge_method
  && (request === undefined || (
    event.requestId === request.requestId
    && event.reservationId === request.reservationId
  ))
);
const requestContextValid = (request, grant) => (
  hasExactKeys(request, REQUEST_KEYS)
  && isBoundedId(request.requestId, MERGE_REQUEST_ID_PATTERN)
  && isBoundedId(request.reservationId, MERGE_RESERVATION_ID_PATTERN)
  && request.repositoryId === grant.repository.id
  && request.decisionAdr === grant.decision_adr
  && request.decisionRevision === grant.decision_revision
  && request.policyRevision === grant.policy_revision
  && request.stage === grant.stage
  && request.prNumber === grant.pr_number
  && request.baseSha === grant.base_sha
  && request.headSha === grant.head_sha
  && request.mergeMethod === grant.allowed_merge_method
);
const reservationValueValid = (event) => (
  isBoundedId(event.grantId, /^[a-z][a-z0-9-]{7,127}$/)
  && isDigest(event.grantRawSha256)
  && isBoundedId(event.requestId, MERGE_REQUEST_ID_PATTERN)
  && isBoundedId(event.reservationId, MERGE_RESERVATION_ID_PATTERN)
  && isSafePositiveInteger(event.repositoryId)
  && DECISION_IDS.has(event.decisionAdr)
  && /^program-c\/decision-r[1-9][0-9]*$/.test(event.decisionRevision)
  && /^program-c\/policy-r[1-9][0-9]*$/.test(event.policyRevision)
  && STAGES.has(event.stage)
  && isSafePositiveInteger(event.prNumber)
  && isGitSha(event.baseSha)
  && isGitSha(event.headSha)
  && METHODS.has(event.mergeMethod)
  && isCanonicalInstant(event.reservedAt)
);
const eventValueValid = (event) => {
  if (!isPlainObject(event) || !EVENT_TYPES.has(event.type) || !hasExactKeys(event, EVENT_KEYS[event.type])) return false;
  if (!isSafePositiveInteger(event.ledgerRevision) || !eventBytesBounded(event)) return false;
  if (event.type === 'NONCE_RESERVED') return reservationValueValid(event);
  if (event.type === 'GRANT_REVOKED') {
    return isBoundedId(event.grantId, /^[a-z][a-z0-9-]{7,127}$/)
      && isDigest(event.grantRawSha256)
      && GRANT_REVOCATION_REASONS.has(event.reasonCode)
      && isCanonicalInstant(event.effectiveAt);
  }
  if (event.type === 'MERGE_ACK_UNKNOWN') {
    return event.reasonCode === 'PHYSICAL_REQUEST_DISPATCHING' && isCanonicalInstant(event.observedAt);
  }
  if (event.type === 'MERGE_RESULT_OBSERVED') {
    return isGitSha(event.resultCommitSha)
      && METHODS.has(event.observedMergeMethod)
      && isCanonicalInstant(event.observedAt);
  }
  if (event.type === 'CONSUMPTION_RECORDED') {
    return validateProgramCMergeAuthorizationConsumption(event.consumption).valid
      && isDigest(event.consumptionRawSha256)
      && event.consumptionRawSha256 === canonicalApprovalDigest(event.consumption)
      && isCanonicalInstant(event.recordedAt);
  }
  return /^APPROVAL_[A-Z0-9_]{1,120}$/.test(event.reasonCode)
    && isCanonicalInstant(event.observedAt);
};
const issueResult = () => resultFromCodes(['APPROVAL_LEDGER_STREAM_INVALID']);

export const validateApprovalLedgerStream = (stream, context) => {
  if (!isPlainObject(context)
    || !isPlainObject(context.key)
    || !isPlainObject(context.grant)
    || !isDigest(context.grantRawSha256)
    || (context.request !== undefined && !requestContextValid(context.request, context.grant))
    || (!hasExactKeys(stream, STREAM_KEYS) && !hasExactKeys(stream, SNAPSHOT_KEYS))
    || (Object.hasOwn(stream, 'durabilityClass')
      && stream.durabilityClass !== LEDGER_DURABILITY_CLASS)
    || !hasExactKeys(stream.key, KEY_KEYS)
    || stream.key.repositoryId !== context.key.repositoryId
    || stream.key.singleUseNonce !== context.key.singleUseNonce
    || stream.key.repositoryId !== context.grant.repository?.id
    || stream.key.singleUseNonce !== context.grant.single_use_nonce
    || !isSafeNonNegativeInteger(stream.committedRevision)
    || !Array.isArray(stream.events)
    || stream.events.length < 1
    || stream.events.length > MAX_LEDGER_EVENTS
    || stream.events.some((event) => !eventValueValid(event))) return issueResult();
  for (let index = 1; index < stream.events.length; index += 1) {
    if (stream.events[index].ledgerRevision !== stream.events[index - 1].ledgerRevision + 1) return issueResult();
  }
  if (stream.committedRevision !== stream.events.at(-1).ledgerRevision) return issueResult();
  const reservations = stream.events.filter(({ type }) => type === 'NONCE_RESERVED');
  const acknowledgements = stream.events.filter(({ type }) => type === 'MERGE_ACK_UNKNOWN');
  const results = stream.events.filter(({ type }) => type === 'MERGE_RESULT_OBSERVED');
  const consumptions = stream.events.filter(({ type }) => type === 'CONSUMPTION_RECORDED');
  const revocations = stream.events.filter(({ type }) => type === 'GRANT_REVOKED');
  if (reservations.length > 1 || acknowledgements.length > 1 || results.length > 1 || consumptions.length > 1) return issueResult();
  const reservation = reservations[0] ?? null;
  if (reservation && !requestBindingMatches(
    reservation,
    context.grant,
    context.grantRawSha256,
    context.request,
  )) return issueResult();
  if (reservation && (Date.parse(reservation.reservedAt) < Date.parse(context.grant.authorized_at)
    || Date.parse(reservation.reservedAt) >= Date.parse(context.grant.expires_at))) return issueResult();
  if (revocations.some((event) => (
    event.grantId !== context.grant.grant_id || event.grantRawSha256 !== context.grantRawSha256
  ))) return issueResult();
  const reservationIndex = reservation ? stream.events.indexOf(reservation) : -1;
  if (reservation && revocations.some((event) => (
    stream.events.indexOf(event) < reservationIndex
    || Date.parse(event.effectiveAt) <= Date.parse(reservation.reservedAt)
  ))) return issueResult();
  const acknowledgement = acknowledgements[0] ?? null;
  const result = results[0] ?? null;
  const consumptionEvent = consumptions[0] ?? null;
  if ((acknowledgement || result || consumptionEvent) && reservation === null) return issueResult();
  if (acknowledgement && stream.events.indexOf(acknowledgement) <= reservationIndex) return issueResult();
  if (acknowledgement
    && Date.parse(acknowledgement.observedAt) < Date.parse(reservation.reservedAt)) return issueResult();
  if (result && (
    stream.events.indexOf(result) <= reservationIndex
    || result.observedMergeMethod !== context.grant.allowed_merge_method
    || Date.parse(result.observedAt) < Date.parse(reservation.reservedAt)
    || Date.parse(result.observedAt) < Date.parse(context.grant.authorized_at)
    || Date.parse(result.observedAt) >= Date.parse(context.grant.expires_at)
  )) return issueResult();
  if (acknowledgement && result && stream.events.indexOf(result) <= stream.events.indexOf(acknowledgement)) return issueResult();
  if (acknowledgement && result
    && Date.parse(acknowledgement.observedAt) > Date.parse(result.observedAt)) return issueResult();
  if (consumptionEvent && (!result || stream.events.indexOf(consumptionEvent) <= stream.events.indexOf(result))) return issueResult();
  if (consumptionEvent) {
    const consumption = consumptionEvent.consumption;
    if (consumption.grant_id !== context.grant.grant_id
      || consumption.grant_raw_sha256 !== context.grantRawSha256
      || consumption.single_use_nonce !== context.grant.single_use_nonce
      || consumption.repository.id !== context.grant.repository.id
      || consumption.decision_adr !== context.grant.decision_adr
      || consumption.decision_revision !== context.grant.decision_revision
      || consumption.policy_revision !== context.grant.policy_revision
      || consumption.stage !== context.grant.stage
      || consumption.pr_number !== context.grant.pr_number
      || consumption.authorized_head_sha !== context.grant.head_sha
      || consumption.observed_merge_method !== context.grant.allowed_merge_method
      || consumption.nonce_ledger_reserved_revision !== reservation.ledgerRevision
      || consumption.result_commit_sha !== result.resultCommitSha
      || Date.parse(result.observedAt) > Date.parse(consumption.consumed_at)
      || Date.parse(consumption.consumed_at) > Date.parse(consumption.current_main.read_at)
      || Date.parse(consumption.current_main.read_at) > Date.parse(consumptionEvent.recordedAt)
      || Date.parse(consumption.consumed_at) < Date.parse(context.grant.authorized_at)
      || Date.parse(consumption.consumed_at) >= Date.parse(context.grant.expires_at)
      || (context.expectedConsumption !== undefined && !approvalValuesEqual(consumption, context.expectedConsumption))
      || (context.expectedConsumptionRawSha256 !== undefined
        && consumptionEvent.consumptionRawSha256 !== context.expectedConsumptionRawSha256)) return issueResult();
  }
  return resultFromCodes([], {
    reservation: reservation === null ? null : clone(reservation),
    acknowledgement: acknowledgement === null ? null : clone(acknowledgement),
    result: result === null ? null : clone(result),
    consumptionEvent: consumptionEvent === null ? null : clone(consumptionEvent),
    revocations: clone(revocations),
    holds: clone(stream.events.filter(({ type }) => type === 'BOUNDED_HOLD')),
  });
};

export const requireValidApprovalLedgerStream = (stream, context) => {
  const result = validateApprovalLedgerStream(stream, context);
  if (!result.valid) throw new Error(result.issues[0].stable_code);
  return deepFreeze(result.facts);
};
