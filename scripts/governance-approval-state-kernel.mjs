import {
  approvalError,
  deepFreeze,
  hasExactKeys,
  isCanonicalInstant,
  isDigest,
  isGitSha,
  isPlainObject,
  isSafePositiveInteger,
} from './governance-approval-readback-common.mjs';
import {
  canonicalApprovalDigest,
  isBoundedId,
  MERGE_CONSUMPTION_ID_PATTERN,
} from './governance-approval-ledger-stream.mjs';
import {
  approvalAcceptanceEvidenceHasForbiddenContent,
  isClosedApprovalAcceptanceEvidence,
  revalidateApprovalAtAcceptance,
} from './governance-approval-acceptance.mjs';
import { storedReceiptRevocationIssue } from './governance-approval-state-revocation.mjs';
import { approvalVerifiedLegalState } from './governance-approval-legal-policy.mjs';

const RECEIPT_KEYS = Object.freeze([
  'receiptId', 'receiptCoreSha256', 'receiptRawSha256', 'trustState', 'validUntil',
]);
const MERGE_SUMMARY_KEYS = Object.freeze([
  'grantId', 'grantRawSha256', 'consumptionId', 'consumptionRawSha256',
  'reservedLedgerRevision', 'ledgerState',
]);
const ACCEPTANCE_STORED_KEYS = Object.freeze([
  'type', 'evidence', 'evidenceSha256', 'observedAt', 'checkedAt',
]);
const MAX_ACCEPTANCE_EVENT_BYTES = 262_144;
const clone = (value) => structuredClone(value);
const transitionError = (code = 'APPROVAL_STATE_TRANSITION_INVALID') => {
  throw approvalError(code);
};
const observedAtValid = (value, observedAt) => (
  isCanonicalInstant(value) && Date.parse(value) <= Date.parse(observedAt)
);
const receiptSummaryShapeValid = (receipt) => (
  hasExactKeys(receipt, RECEIPT_KEYS)
  && isBoundedId(receipt.receiptId, /^[a-z][a-z0-9-]{7,127}$/)
  && isDigest(receipt.receiptCoreSha256)
  && isDigest(receipt.receiptRawSha256)
  && receipt.trustState === 'INDEPENDENT_EXTERNAL_VERIFIED'
  && isCanonicalInstant(receipt.validUntil)
);
const receiptSummaryValid = (receipt, observedAt) => (
  receiptSummaryShapeValid(receipt) && Date.parse(observedAt) < Date.parse(receipt.validUntil)
);
const mergeSummaryValid = (summary, requireConsumed = false) => (
  hasExactKeys(summary, MERGE_SUMMARY_KEYS)
  && isBoundedId(summary.grantId, /^[a-z][a-z0-9-]{7,127}$/)
  && isDigest(summary.grantRawSha256)
  && isSafePositiveInteger(summary.reservedLedgerRevision)
  && (summary.ledgerState === 'CONSUMED'
    ? isBoundedId(summary.consumptionId, MERGE_CONSUMPTION_ID_PATTERN)
      && isDigest(summary.consumptionRawSha256)
    : summary.ledgerState === 'RESERVED'
      && summary.consumptionId === null
      && summary.consumptionRawSha256 === null)
  && (!requireConsumed || summary.ledgerState === 'CONSUMED')
);
const acceptanceEventEvidenceValid = (event) => {
  if (!hasExactKeys(event, ACCEPTANCE_STORED_KEYS)
    || !isClosedApprovalAcceptanceEvidence(event.evidence)
    || approvalAcceptanceEvidenceHasForbiddenContent(event.evidence)) return false;
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(event.evidence), 'utf8');
  } catch {
    return false;
  }
  return bytes <= MAX_ACCEPTANCE_EVENT_BYTES
    && isDigest(event.evidenceSha256)
    && event.evidenceSha256 === canonicalApprovalDigest(event.evidence)
    && isCanonicalInstant(event.checkedAt)
    && Date.parse(event.observedAt) <= Date.parse(event.checkedAt);
};
const transitionClock = (event, observedAt) => {
  if (!isCanonicalInstant(observedAt)
    || !isCanonicalInstant(event?.observedAt)) {
    transitionError('APPROVAL_STATE_EVENT_TIME_INVALID');
  }
  const eventTime = event.type === 'ACCEPTANCE_REVALIDATED'
    ? event.checkedAt
    : event.observedAt;
  if (!isCanonicalInstant(eventTime) || Date.parse(eventTime) > Date.parse(observedAt)) {
    transitionError('APPROVAL_STATE_EVENT_TIME_INVALID');
  }
  return eventTime;
};
const closedProjection = (currentProjection) => {
  if (!isPlainObject(currentProjection)) transitionError();
  const {
    eventHistory: _eventHistory,
    policySnapshot: _policySnapshot,
    ...projection
  } = clone(currentProjection);
  return projection;
};

export const planApprovalStateTransition = ({
  currentProjection,
  event,
  policySnapshot,
  observedAt,
}) => {
  if (!isPlainObject(event) || !isPlainObject(policySnapshot)) transitionError();
  const eventTime = transitionClock(event, observedAt);
  const eventClock = eventTime;
  const state = closedProjection(currentProjection);
  let nextProjection;

  if (event.type === 'AUTHORITIES_ASSIGNED') {
    if (!hasExactKeys(event, ['type', 'observedAt'])
      || !observedAtValid(event.observedAt, eventClock)
      || state.state !== 'OWNER_ASSIGNMENT_REQUIRED') transitionError();
    nextProjection = {
      ...state,
      state: 'PROPOSED',
      blockingCodes: [],
      revocationStatus: 'ACTIVE',
    };
  } else if (event.type === 'PROPOSAL_RENDERED') {
    if (!hasExactKeys(event, ['type', 'headSha', 'observedAt'])
      || !observedAtValid(event.observedAt, eventClock)
      || !['PROPOSED', 'STALE_AFTER_PUSH'].includes(state.state)
      || event.headSha !== policySnapshot.currentHeadSha) transitionError();
    nextProjection = {
      ...state,
      state: 'AWAITING_PRODUCT_REVIEW',
      currentHeadSha: event.headSha,
      blockingCodes: ['APPROVAL_REVIEW_REQUIRED'],
    };
  } else if (event.type === 'PRODUCT_REVIEW_VERIFIED') {
    if (!hasExactKeys(event, ['type', 'headSha', 'observedAt'])
      || !observedAtValid(event.observedAt, eventClock)
      || state.state !== 'AWAITING_PRODUCT_REVIEW'
      || event.headSha !== state.currentHeadSha) transitionError();
    nextProjection = {
      ...state,
      state: 'AWAITING_PRIVACY_REVIEW',
      evidenceSlots: { ...state.evidenceSlots, product: 'VERIFIED' },
      blockingCodes: ['APPROVAL_REVIEW_REQUIRED'],
    };
  } else if (event.type === 'RECEIPT_VERIFIED') {
    if (!hasExactKeys(event, ['type', 'headSha', 'receipt', 'mergeAuthorization', 'observedAt'])
      || !observedAtValid(event.observedAt, eventClock)
      || state.state !== 'AWAITING_PRIVACY_REVIEW'
      || event.headSha !== state.currentHeadSha
      || !receiptSummaryValid(event.receipt, eventClock)
      || !mergeSummaryValid(event.mergeAuthorization, true)) {
      transitionError('APPROVAL_RECEIPT_REQUIRED');
    }
    nextProjection = {
      ...state,
      state: 'VERIFIED',
      legalState: approvalVerifiedLegalState({
        decisionAdr: state.decisionId,
        actorPolicy: policySnapshot.actorPolicy,
      }),
      evidenceTrustState: 'INDEPENDENT_EXTERNAL_VERIFIED',
      evidenceSlots: {
        product: 'VERIFIED',
        privacy: 'VERIFIED',
        codeowner: 'VERIFIED',
        qa: 'VERIFIED',
        security: 'VERIFIED',
        machine: 'VERIFIED',
      },
      receipt: clone(event.receipt),
      mergeAuthorization: clone(event.mergeAuthorization),
      blockingCodes: ['APPROVAL_ACCEPTANCE_REVALIDATION_REQUIRED'],
    };
  } else if (event.type === 'HEAD_CHANGED') {
    if (!hasExactKeys(event, ['type', 'headSha', 'observedAt'])
      || !observedAtValid(event.observedAt, eventClock)
      || !isGitSha(event.headSha)
      || ['ACCEPTED', 'REVOKED'].includes(state.state)) transitionError();
    nextProjection = {
      ...state,
      state: 'STALE_AFTER_PUSH',
      currentHeadSha: event.headSha,
      evidenceTrustState: 'EXTERNAL_UNVERIFIED',
      receipt: null,
      mergeAuthorization: null,
      blockingCodes: ['APPROVAL_HEAD_MISMATCH'],
    };
  } else if (event.type === 'REVIEW_REJECTED') {
    if (!hasExactKeys(event, ['type', 'observedAt'])
      || !observedAtValid(event.observedAt, eventClock)
      || !['AWAITING_PRODUCT_REVIEW', 'AWAITING_PRIVACY_REVIEW', 'VERIFIED'].includes(state.state)) {
      transitionError();
    }
    nextProjection = {
      ...state,
      state: 'REJECTED',
      blockingCodes: ['APPROVAL_REVIEW_REJECTED'],
    };
  } else if (event.type === 'RECEIPT_SUPERSEDED') {
    if (!hasExactKeys(event, [
      'type', 'predecessorReceiptId', 'successor', 'validation', 'observedAt',
    ])
      || !observedAtValid(event.observedAt, eventClock)
      || !state.receipt
      || state.receipt.receiptId !== event.predecessorReceiptId
      || !receiptSummaryValid(event.successor, eventClock)
      || event.validation?.valid !== false
      || !event.validation?.issues?.some?.(
        ({ stable_code: code }) => code === 'APPROVAL_INDEPENDENCE_NOT_PROVEN',
      )) transitionError();
    nextProjection = {
      ...state,
      state: 'STALE_AFTER_PUSH',
      receiptHistory: [
        ...state.receiptHistory,
        { ...clone(state.receipt), lifecycleState: 'SUPERSEDED' },
      ],
      receipt: clone(event.successor),
      evidenceTrustState: 'EXTERNAL_UNVERIFIED',
      mergeAuthorization: null,
      supersessionStatus: 'SUPERSEDED_WITH_CURRENT_SUCCESSOR',
      blockingCodes: ['APPROVAL_INDEPENDENCE_NOT_PROVEN'],
    };
  } else if (event.type === 'ACCEPTANCE_REVALIDATED') {
    if (!acceptanceEventEvidenceValid(event)
      || state.state !== 'VERIFIED'
      || event.observedAt !== event.evidence?.readAt
      || !observedAtValid(event.observedAt, eventClock)) {
      transitionError('APPROVAL_ACCEPTANCE_REVALIDATION_STALE');
    }
    const validation = revalidateApprovalAtAcceptance(
      { ...state, policySnapshot },
      event.evidence,
      new Date(eventClock),
    );
    if (!validation.valid || validation.checkedAt !== event.checkedAt) {
      transitionError(validation.issues[0]?.stable_code ?? 'APPROVAL_ACCEPTANCE_REVALIDATION_STALE');
    }
    nextProjection = {
      ...state,
      state: 'ACCEPTED',
      blockingCodes: [],
      acceptanceCheckedAt: validation.checkedAt,
    };
  } else if (event.type === 'RECEIPT_REVOKED') {
    const issue = storedReceiptRevocationIssue(event, state, policySnapshot);
    if (issue) transitionError(issue);
    if (!observedAtValid(event.observedAt, eventClock)
      || !['VERIFIED', 'ACCEPTED'].includes(state.state)) transitionError();
    nextProjection = {
      ...state,
      state: 'REVOKED',
      revocationStatus: 'REVOKED',
      blockingCodes: ['APPROVAL_POLICY_REVOKED'],
    };
  } else {
    transitionError('APPROVAL_STATE_EVENT_UNSUPPORTED');
  }

  return deepFreeze({
    schemaVersion: 'approval-state-transition-plan/v1',
    nextProjection,
  });
};
