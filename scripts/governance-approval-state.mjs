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
import { revalidateApprovalAtAcceptance } from './governance-approval-acceptance.mjs';

export {
  executeReservedMerge,
  reconcileMergeAuthorizationReservation,
  reserveMergeAuthorizationNonce,
} from './governance-approval-merge-orchestration.mjs';
export { revalidateApprovalAtAcceptance };

const DECISION_IDS = new Set(['ADR-026', 'ADR-027']);
const STATE_VALUES = new Set([
  'OWNER_ASSIGNMENT_REQUIRED', 'PROPOSED', 'AWAITING_PRODUCT_REVIEW',
  'AWAITING_PRIVACY_REVIEW', 'STALE_AFTER_PUSH', 'VERIFIED', 'ACCEPTED',
  'REVOKED', 'REJECTED',
]);
const TRUST_VALUES = new Set(['EXTERNAL_UNVERIFIED', 'INDEPENDENT_EXTERNAL_VERIFIED']);
const SLOT_KEYS = Object.freeze(['product', 'privacy', 'codeowner', 'qa', 'security', 'machine']);
const RECEIPT_KEYS = Object.freeze([
  'receiptId', 'receiptCoreSha256', 'receiptRawSha256', 'trustState', 'validUntil',
]);
const MERGE_SUMMARY_KEYS = Object.freeze([
  'grantId', 'grantRawSha256', 'consumptionId', 'consumptionRawSha256',
  'reservedLedgerRevision', 'ledgerState',
]);
const STATE_KEYS = new Set([
  'schemaVersion', 'repository', 'decisionId', 'decisionRevision', 'policyRevision',
  'state', 'currentHeadSha', 'currentBaseSha', 'legalState', 'evidenceTrustState',
  'evidenceSlots', 'receipt', 'receiptHistory', 'mergeAuthorization',
  'revocationStatus', 'supersessionStatus', 'blockingCodes', 'eventHistory',
  'policySnapshot', 'acceptanceCheckedAt',
]);
const POLICY_KEYS = Object.freeze([
  'repository', 'decisionId', 'decisionRevision', 'policyRevision', 'currentBaseSha',
  'currentHeadSha', 'decisionRawSha256', 'decisionSemanticSha256', 'sidecarRawSha256',
  'proposalResultCommitSha', 'authorityRevision', 'authoritySha256', 'authorityRawSha256',
  'authorityEffectiveFrom', 'authorityEffectiveUntil', 'legalScope', 'legalDigest',
  'liveRulesetSha256', 'acceptanceAllowlist', 'requiredReviews',
  'requiredMachineChecks', 'freshnessMs',
]);
const clone = (value) => structuredClone(value);
const frozenClone = (value) => deepFreeze(clone(value));
const nowIso = (now) => {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw approvalError('APPROVAL_NOW_INVALID');
  return now.toISOString();
};
const transitionError = (code = 'APPROVAL_STATE_TRANSITION_INVALID') => {
  throw approvalError(code);
};
const observedAtValid = (value, now) => (
  isCanonicalInstant(value) && Date.parse(value) <= now.getTime()
);
const receiptSummaryShapeValid = (receipt) => (
  hasExactKeys(receipt, RECEIPT_KEYS)
  && isBoundedId(receipt.receiptId, /^[a-z][a-z0-9-]{7,127}$/)
  && isDigest(receipt.receiptCoreSha256)
  && isDigest(receipt.receiptRawSha256)
  && receipt.trustState === 'INDEPENDENT_EXTERNAL_VERIFIED'
  && isCanonicalInstant(receipt.validUntil)
);
const receiptSummaryValid = (receipt, now) => (
  receiptSummaryShapeValid(receipt) && now.getTime() < Date.parse(receipt.validUntil)
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
const safeEventRecord = (event) => {
  if (event.type === 'ACCEPTANCE_REVALIDATED') {
    return {
      type: event.type,
      observedAt: event.observedAt,
      evidenceSha256: canonicalApprovalDigest(event.evidence),
    };
  }
  return clone(event);
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
  evidenceSlots: {
    product: 'MISSING',
    privacy: 'MISSING',
    codeowner: 'MISSING',
    qa: 'MISSING',
    security: 'MISSING',
    machine: 'MISSING',
  },
  receipt: null,
  receiptHistory: [],
  mergeAuthorization: null,
  revocationStatus: 'ACTIVE',
  supersessionStatus: 'CURRENT',
  blockingCodes: ['APPROVAL_OWNER_ASSIGNMENT_REQUIRED'],
  eventHistory: [],
  policySnapshot: clone(policy),
  acceptanceCheckedAt: null,
});

export const reduceApprovalDecisionState = (events, policy, now) => {
  const reductionNow = nowIso(now);
  if (!Array.isArray(events)
    || events.length > 128
    || !isPlainObject(policy)
    || !hasExactKeys(policy.repository, ['id', 'fullName'])
    || !isSafePositiveInteger(policy.repository.id)
    || typeof policy.repository.fullName !== 'string'
    || !DECISION_IDS.has(policy.decisionId)) {
    throw approvalError('APPROVAL_STATE_INPUT_INVALID');
  }
  let state = baseState(policy);
  for (const rawEvent of events) {
    if (!isPlainObject(rawEvent) || typeof rawEvent.type !== 'string') transitionError();
    const event = clone(rawEvent);
    if (event.type === 'AUTHORITIES_ASSIGNED') {
      if (!hasExactKeys(event, ['type', 'observedAt'])
        || !observedAtValid(event.observedAt, now)
        || !['OWNER_ASSIGNMENT_REQUIRED', 'REVOKED', 'REJECTED'].includes(state.state)) transitionError();
      state = { ...state, state: 'PROPOSED', blockingCodes: [], revocationStatus: 'ACTIVE' };
    } else if (event.type === 'PROPOSAL_RENDERED') {
      if (!hasExactKeys(event, ['type', 'headSha', 'observedAt'])
        || !observedAtValid(event.observedAt, now)
        || !['PROPOSED', 'STALE_AFTER_PUSH'].includes(state.state)
        || event.headSha !== policy.currentHeadSha) transitionError();
      state = {
        ...state,
        state: 'AWAITING_PRODUCT_REVIEW',
        currentHeadSha: event.headSha,
        blockingCodes: ['APPROVAL_REVIEW_REQUIRED'],
      };
    } else if (event.type === 'PRODUCT_REVIEW_VERIFIED') {
      if (!hasExactKeys(event, ['type', 'headSha', 'observedAt'])
        || !observedAtValid(event.observedAt, now)
        || state.state !== 'AWAITING_PRODUCT_REVIEW'
        || event.headSha !== state.currentHeadSha) transitionError();
      state = {
        ...state,
        state: 'AWAITING_PRIVACY_REVIEW',
        evidenceSlots: { ...state.evidenceSlots, product: 'VERIFIED' },
        blockingCodes: ['APPROVAL_REVIEW_REQUIRED'],
      };
    } else if (event.type === 'RECEIPT_VERIFIED') {
      if (!hasExactKeys(event, ['type', 'headSha', 'receipt', 'mergeAuthorization', 'observedAt'])
        || !observedAtValid(event.observedAt, now)
        || state.state !== 'AWAITING_PRIVACY_REVIEW'
        || event.headSha !== state.currentHeadSha
        || !receiptSummaryValid(event.receipt, now)
        || !mergeSummaryValid(event.mergeAuthorization, true)) {
        transitionError('APPROVAL_RECEIPT_REQUIRED');
      }
      state = {
        ...state,
        state: 'VERIFIED',
        legalState: 'NO_BLOCKER_RECORDED',
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
        || !observedAtValid(event.observedAt, now)
        || !isGitSha(event.headSha)
        || ['ACCEPTED', 'REVOKED'].includes(state.state)) transitionError();
      state = {
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
        || !observedAtValid(event.observedAt, now)
        || !['AWAITING_PRODUCT_REVIEW', 'AWAITING_PRIVACY_REVIEW', 'VERIFIED'].includes(state.state)) {
        transitionError();
      }
      state = { ...state, state: 'REJECTED', blockingCodes: ['APPROVAL_REVIEW_REJECTED'] };
    } else if (event.type === 'RECEIPT_SUPERSEDED') {
      if (!hasExactKeys(event, [
        'type', 'predecessorReceiptId', 'successor', 'validation', 'observedAt',
      ])
        || !observedAtValid(event.observedAt, now)
        || !state.receipt
        || state.receipt.receiptId !== event.predecessorReceiptId
        || !receiptSummaryValid(event.successor, now)
        || event.validation?.valid !== false
        || !event.validation?.issues?.some?.(
          ({ stable_code: code }) => code === 'APPROVAL_INDEPENDENCE_NOT_PROVEN',
        )) transitionError();
      state = {
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
      if (!hasExactKeys(event, ['type', 'evidence', 'observedAt'])
        || state.state !== 'VERIFIED'
        || event.observedAt !== event.evidence?.readAt
        || !observedAtValid(event.observedAt, now)) {
        transitionError('APPROVAL_ACCEPTANCE_REVALIDATION_STALE');
      }
      const validation = revalidateApprovalAtAcceptance(state, event.evidence, now);
      if (!validation.valid || validation.checkedAt !== reductionNow) {
        transitionError(validation.issues[0]?.stable_code ?? 'APPROVAL_ACCEPTANCE_REVALIDATION_STALE');
      }
      state = {
        ...state,
        state: 'ACCEPTED',
        blockingCodes: [],
        acceptanceCheckedAt: validation.checkedAt,
      };
    } else if (event.type === 'RECEIPT_REVOKED') {
      if (!hasExactKeys(event, ['type', 'observedAt'])
        || !observedAtValid(event.observedAt, now)
        || !['VERIFIED', 'ACCEPTED'].includes(state.state)) transitionError();
      state = {
        ...state,
        state: 'REVOKED',
        revocationStatus: 'REVOKED',
        blockingCodes: ['APPROVAL_POLICY_REVOKED'],
      };
    } else {
      transitionError('APPROVAL_STATE_EVENT_UNSUPPORTED');
    }
    state = { ...state, eventHistory: [...state.eventHistory, safeEventRecord(event)] };
  }
  return frozenClone(state);
};

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
const containsNonce = (value, seen = new Set()) => {
  if (typeof value === 'string') return /nonce-program-c-/i.test(value);
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsNonce(entry, seen));
  return Object.entries(value).some(([key, child]) => (
    /nonce/i.test(key) || containsNonce(child, seen)
  ));
};
const readStateClosed = (state) => (
  isPlainObject(state)
  && Object.keys(state).every((key) => STATE_KEYS.has(key))
  && state.schemaVersion === 'approval-decision-state/v1'
  && hasExactKeys(state.repository, ['id', 'fullName'])
  && isSafePositiveInteger(state.repository.id)
  && typeof state.repository.fullName === 'string'
  && Buffer.byteLength(state.repository.fullName, 'utf8') <= 256
  && DECISION_IDS.has(state.decisionId)
  && /^program-c\/decision-r[1-9][0-9]*$/.test(state.decisionRevision)
  && /^program-c\/policy-r[1-9][0-9]*$/.test(state.policyRevision)
  && STATE_VALUES.has(state.state)
  && isGitSha(state.currentHeadSha)
  && isGitSha(state.currentBaseSha)
  && ['PENDING', 'NO_BLOCKER_RECORDED'].includes(state.legalState)
  && TRUST_VALUES.has(state.evidenceTrustState)
  && hasExactKeys(state.evidenceSlots, SLOT_KEYS)
  && SLOT_KEYS.every((key) => ['MISSING', 'VERIFIED'].includes(state.evidenceSlots[key]))
  && (state.receipt === null || receiptSummaryShapeValid(state.receipt))
  && (state.mergeAuthorization === null || mergeSummaryValid(state.mergeAuthorization))
  && Array.isArray(state.receiptHistory)
  && state.receiptHistory.length <= 64
  && Array.isArray(state.blockingCodes)
  && state.blockingCodes.length <= 16
  && state.blockingCodes.every((code) => /^APPROVAL_[A-Z0-9_]{1,120}$/.test(code))
  && Array.isArray(state.eventHistory)
  && state.eventHistory.length <= 128
  && (state.policySnapshot === undefined
    || hasExactKeys(state.policySnapshot, POLICY_KEYS))
  && (state.acceptanceCheckedAt === undefined
    || state.acceptanceCheckedAt === null
    || isCanonicalInstant(state.acceptanceCheckedAt))
  && ['ACTIVE', 'REVOKED'].includes(state.revocationStatus)
  && ['CURRENT', 'SUPERSEDED_WITH_CURRENT_SUCCESSOR'].includes(state.supersessionStatus)
  && !containsNonce(state)
);

export const renderApprovalStatusReadModel = (state) => {
  if (!readStateClosed(state) || !STATUS_COPY[state.state]) {
    throw approvalError(containsNonce(state)
      ? 'APPROVAL_STATUS_NONCE_FORBIDDEN'
      : 'APPROVAL_STATUS_EVIDENCE_REQUIRED');
  }
  const [messageKey, message, recoveryAction] = STATUS_COPY[state.state];
  const blockingCodes = state.blockingCodes.slice();
  const model = frozenClone({
    schemaVersion: 'approval-status-read-model/v1',
    repository: { id: state.repository.id, fullName: state.repository.fullName },
    decisionId: state.decisionId,
    decisionRevision: state.decisionRevision,
    policyRevision: state.policyRevision,
    state: state.state,
    legalState: state.legalState,
    evidenceTrustState: state.evidenceTrustState,
    evidenceSlots: Object.fromEntries(SLOT_KEYS.map((key) => [key, state.evidenceSlots[key]])),
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
  if (Buffer.byteLength(JSON.stringify(model), 'utf8') > 32_768) {
    throw approvalError('APPROVAL_STATUS_OUTPUT_OVERFLOW');
  }
  return model;
};
