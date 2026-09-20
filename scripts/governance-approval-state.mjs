import {
  AUTHORITY_REVISION_PATTERN,
  DECISION_REVISION_PATTERN,
  POLICY_REVISION_PATTERN,
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
import {
  approvalGraphUnsafe,
  inspectApprovalValueGraph,
} from './governance-approval-safe-traversal.mjs';
import {
  buildStoredReceiptRevocationEvent,
  isClosedStoredReceiptRevocationEvent,
} from './governance-approval-state-revocation.mjs';
import { planApprovalStateTransition } from './governance-approval-state-kernel.mjs';

export {
  executeReservedMerge,
  reconcileMergeAuthorizationReservation,
  reserveMergeAuthorizationNonce,
} from './governance-approval-merge-orchestration.mjs';
export { revalidateApprovalAtAcceptance };

const DECISION_IDS = new Set(['ADR-026', 'ADR-027']);
const EVENT_TYPES = new Set([
  'AUTHORITIES_ASSIGNED', 'PROPOSAL_RENDERED', 'PRODUCT_REVIEW_VERIFIED',
  'RECEIPT_VERIFIED', 'HEAD_CHANGED', 'REVIEW_REJECTED', 'RECEIPT_SUPERSEDED',
  'ACCEPTANCE_REVALIDATED', 'RECEIPT_REVOKED',
]);
const STATE_VALUES = new Set([
  'OWNER_ASSIGNMENT_REQUIRED', 'PROPOSED', 'AWAITING_PRODUCT_REVIEW',
  'AWAITING_PRIVACY_REVIEW', 'STALE_AFTER_PUSH', 'VERIFIED', 'ACCEPTED',
  'REVOKED', 'REJECTED',
]);
const TRUST_VALUES = new Set(['EXTERNAL_UNVERIFIED', 'INDEPENDENT_EXTERNAL_VERIFIED']);
const ACTOR_POLICIES = new Set([
  'DISTINCT_ACTORS_REQUIRED',
  'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER',
]);
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
const MAX_ACCEPTANCE_EVENT_BYTES = 262_144;
const ACCEPTANCE_LIVE_KEYS = Object.freeze(['type', 'evidence', 'observedAt']);
const ACCEPTANCE_STORED_KEYS = Object.freeze([
  'type', 'evidence', 'evidenceSha256', 'observedAt', 'checkedAt',
]);
const APPEND_KEYS = Object.freeze([
  'schemaVersion', 'expectedHistorySha256', 'appendedAt', 'event',
]);
const POLICY_KEYS = Object.freeze([
  'repository', 'decisionId', 'decisionRevision', 'policyRevision', 'currentBaseSha',
  'currentHeadSha', 'decisionRawSha256', 'decisionSemanticSha256', 'sidecarRawSha256',
  'proposalResultCommitSha', 'authorityRevision', 'authoritySha256', 'authorityRawSha256',
  'authorityEffectiveFrom', 'authorityEffectiveUntil', 'legalScope', 'legalDigest',
  'actorPolicy', 'dualRoleExceptionSha256',
  'liveRulesetSha256', 'acceptanceAllowlist', 'requiredReviews',
  'requiredMachineChecks', 'freshnessMs',
]);
const POLICY_FILE_KEYS = Object.freeze(['path', 'sha256']);
const POLICY_REVIEW_KEYS = Object.freeze(['slot', 'commandDigest']);
const POLICY_MACHINE_CHECK_KEYS = Object.freeze([
  'context', 'appId', 'workflowPath', 'workflowSha', 'baseBlobSha', 'signerIdentity',
]);
const POLICY_REVIEW_SLOTS = new Set(['PRODUCT', 'PRIVACY', 'CODEOWNER', 'QA', 'SECURITY']);
const MAX_POLICY_BYTES = 32_768;
const MAX_POLICY_NODES = 2_048;
const MAX_POLICY_DEPTH = 32;
const HISTORY_ACTIVE = 'ACTIVE';
const HISTORY_APPENDING = 'APPENDING';
const HISTORY_CONSUMED = 'CONSUMED';
const approvalHistoryBindings = new WeakMap();
const hasApprovalHistoryBinding = WeakMap.prototype.has.bind(approvalHistoryBindings);
const getApprovalHistoryBinding = WeakMap.prototype.get.bind(approvalHistoryBindings);
const setApprovalHistoryBinding = WeakMap.prototype.set.bind(approvalHistoryBindings);
const clone = (value) => structuredClone(value);
const frozenClone = (value) => deepFreeze(clone(value));
const prepareApprovalHistory = (events) => {
  const history = events.map((event) => deepFreeze(clone(event)));
  deepFreeze(history);
  return history;
};
const historyBinding = (policySnapshot, policySha256, capabilityState) => Object.freeze({
  policySnapshot,
  policySha256,
  capabilityState,
});
const activateApprovalHistory = (history, binding) => {
  setApprovalHistoryBinding(history, historyBinding(
    binding.policySnapshot,
    binding.policySha256,
    HISTORY_ACTIVE,
  ));
  return history;
};
const nowIso = (now) => {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw approvalError('APPROVAL_NOW_INVALID');
  return now.toISOString();
};
const transitionError = (code = 'APPROVAL_STATE_TRANSITION_INVALID') => {
  throw approvalError(code);
};
const receiptSummaryShapeValid = (receipt) => (
  hasExactKeys(receipt, RECEIPT_KEYS)
  && isBoundedId(receipt.receiptId, /^[a-z][a-z0-9-]{7,127}$/)
  && isDigest(receipt.receiptCoreSha256)
  && isDigest(receipt.receiptRawSha256)
  && receipt.trustState === 'INDEPENDENT_EXTERNAL_VERIFIED'
  && isCanonicalInstant(receipt.validUntil)
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
  const live = hasExactKeys(event, ACCEPTANCE_LIVE_KEYS);
  const stored = hasExactKeys(event, ACCEPTANCE_STORED_KEYS);
  if ((!live && !stored)
    || !isClosedApprovalAcceptanceEvidence(event.evidence)
    || approvalAcceptanceEvidenceHasForbiddenContent(event.evidence)) return false;
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(event.evidence), 'utf8');
  } catch {
    return false;
  }
  if (bytes > MAX_ACCEPTANCE_EVENT_BYTES) return false;
  return !stored || (
    isDigest(event.evidenceSha256)
    && event.evidenceSha256 === canonicalApprovalDigest(event.evidence)
    && isCanonicalInstant(event.checkedAt)
    && Date.parse(event.observedAt) <= Date.parse(event.checkedAt)
  );
};
const boundedPolicyString = (value, maximumBytes, pattern) => (
  typeof value === 'string'
  && Buffer.byteLength(value, 'utf8') > 0
  && Buffer.byteLength(value, 'utf8') <= maximumBytes
  && (pattern === undefined || pattern.test(value))
);
const policyStringHasControlCharacter = (value) => [...value].some((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint <= 31 || codePoint === 127;
});
const safePolicyPath = (value, maximumBytes = 512) => (
  boundedPolicyString(value, maximumBytes)
  && !value.startsWith('/')
  && !value.includes('\\')
  && !value.split('/').includes('..')
  && !policyStringHasControlCharacter(value)
);
const hasExactPolicyKeys = (value, keys) => {
  if (!isPlainObject(value)) return false;
  try {
    const ownKeys = Reflect.ownKeys(value);
    return ownKeys.length === keys.length
      && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
      && keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined
          && descriptor.enumerable === true
          && Object.hasOwn(descriptor, 'value');
      });
  } catch {
    return false;
  }
};
const closedPolicyArray = (value, minimumLength, maximumLength) => {
  if (!Array.isArray(value)
    || value.length < minimumLength
    || value.length > maximumLength) return false;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) return false;
    return Array.from({ length: value.length }, (_unused, index) => String(index))
      .every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined
          && descriptor.enumerable === true
          && Object.hasOwn(descriptor, 'value');
      });
  } catch {
    return false;
  }
};
const policyShapeValid = (policy) => {
  if (!hasExactPolicyKeys(policy, POLICY_KEYS)
    || !hasExactPolicyKeys(policy.repository, ['id', 'fullName'])
    || !isSafePositiveInteger(policy.repository.id)
    || !boundedPolicyString(
      policy.repository.fullName,
      256,
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    )
    || !DECISION_IDS.has(policy.decisionId)
    || !DECISION_REVISION_PATTERN.test(policy.decisionRevision)
    || !POLICY_REVISION_PATTERN.test(policy.policyRevision)
    || !isGitSha(policy.currentBaseSha)
    || !isGitSha(policy.currentHeadSha)
    || !isDigest(policy.decisionRawSha256)
    || !isDigest(policy.decisionSemanticSha256)
    || !isDigest(policy.sidecarRawSha256)
    || !isGitSha(policy.proposalResultCommitSha)
    || !AUTHORITY_REVISION_PATTERN.test(policy.authorityRevision)
    || !isDigest(policy.authoritySha256)
    || !isDigest(policy.authorityRawSha256)
    || !isCanonicalInstant(policy.authorityEffectiveFrom)
    || !isCanonicalInstant(policy.authorityEffectiveUntil)
    || Date.parse(policy.authorityEffectiveFrom) >= Date.parse(policy.authorityEffectiveUntil)
    || !boundedPolicyString(policy.legalScope, 128, /^[A-Z][A-Z0-9_]*$/)
    || !isDigest(policy.legalDigest)
    || !ACTOR_POLICIES.has(policy.actorPolicy)
    || (policy.actorPolicy === 'DISTINCT_ACTORS_REQUIRED'
      ? policy.dualRoleExceptionSha256 !== null
      : !isDigest(policy.dualRoleExceptionSha256))
    || !isDigest(policy.liveRulesetSha256)
    || !Number.isSafeInteger(policy.freshnessMs)
    || policy.freshnessMs <= 0
    || policy.freshnessMs > 86_400_000) return false;

  if (!closedPolicyArray(policy.acceptanceAllowlist, 1, 32)
    || !policy.acceptanceAllowlist.every((file) => (
      hasExactPolicyKeys(file, POLICY_FILE_KEYS)
      && safePolicyPath(file.path)
      && isDigest(file.sha256)
    ))
    || new Set(policy.acceptanceAllowlist.map(({ path }) => path)).size
      !== policy.acceptanceAllowlist.length) return false;

  if (!closedPolicyArray(
    policy.requiredReviews,
    POLICY_REVIEW_SLOTS.size,
    POLICY_REVIEW_SLOTS.size,
  )
    || !policy.requiredReviews.every((review) => (
      hasExactPolicyKeys(review, POLICY_REVIEW_KEYS)
      && POLICY_REVIEW_SLOTS.has(review.slot)
      && isDigest(review.commandDigest)
    ))
    || new Set(policy.requiredReviews.map(({ slot }) => slot)).size
      !== POLICY_REVIEW_SLOTS.size) return false;

  return closedPolicyArray(policy.requiredMachineChecks, 1, 16)
    && policy.requiredMachineChecks.every((check) => (
      hasExactPolicyKeys(check, POLICY_MACHINE_CHECK_KEYS)
      && boundedPolicyString(check.context, 128, /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/)
      && isSafePositiveInteger(check.appId)
      && safePolicyPath(check.workflowPath)
      && isGitSha(check.workflowSha)
      && isGitSha(check.baseBlobSha)
      && boundedPolicyString(check.signerIdentity, 256, /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/)
    ))
    && new Set(policy.requiredMachineChecks.map(({ context }) => context)).size
      === policy.requiredMachineChecks.length;
};
const policyValidationCode = (policy) => {
  const inspection = inspectApprovalValueGraph(policy, {
    maxNodes: MAX_POLICY_NODES,
    maxDepth: MAX_POLICY_DEPTH,
    maxBytes: MAX_POLICY_BYTES,
  });
  if (approvalGraphUnsafe(inspection)) return 'APPROVAL_STATE_POLICY_GRAPH_INVALID';
  if (inspection.byteOverflow) return 'APPROVAL_STATE_POLICY_OVERSIZE';
  try {
    if (!policyShapeValid(policy)) return 'APPROVAL_STATE_POLICY_INVALID';
    return Buffer.byteLength(JSON.stringify(policy), 'utf8') <= MAX_POLICY_BYTES
      ? null
      : 'APPROVAL_STATE_POLICY_OVERSIZE';
  } catch {
    return 'APPROVAL_STATE_POLICY_INVALID';
  }
};
const createPolicyBinding = (policy) => {
  const validationCode = policyValidationCode(policy);
  if (validationCode !== null) throw approvalError(validationCode);
  let policySnapshot;
  try {
    policySnapshot = frozenClone(policy);
  } catch {
    throw approvalError('APPROVAL_STATE_POLICY_INVALID');
  }
  return historyBinding(
    policySnapshot,
    canonicalApprovalDigest(policySnapshot),
    HISTORY_ACTIVE,
  );
};
const callerPolicyMatches = (policy, binding) => {
  if (policyValidationCode(policy) !== null) return false;
  try {
    return canonicalApprovalDigest(policy) === binding.policySha256;
  } catch {
    return false;
  }
};
const baseState = (policy, eventHistory = []) => ({
  schemaVersion: 'approval-decision-state/v1',
  repository: policy.repository,
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
  eventHistory,
  policySnapshot: policy,
  acceptanceCheckedAt: null,
});

const stateProjection = (state) => {
  const {
    eventHistory: _eventHistory,
    policySnapshot: _policySnapshot,
    ...projection
  } = state;
  return projection;
};
const admitTransitionPlan = (plan, eventHistory, policySnapshot) => deepFreeze({
  ...plan.nextProjection,
  eventHistory,
  policySnapshot,
});

const reduceBoundApprovalDecisionState = (events, binding, now) => {
  const reductionNow = nowIso(now);
  if (!Array.isArray(events)
    || events.length > 128) {
    throw approvalError('APPROVAL_STATE_INPUT_INVALID');
  }
  const policy = binding.policySnapshot;
  let state = deepFreeze(baseState(policy, events));
  let priorEventTime = null;
  const eventDigests = new Set();
  for (const rawEvent of events) {
    if (!isPlainObject(rawEvent) || !EVENT_TYPES.has(rawEvent.type)) {
      transitionError('APPROVAL_STATE_EVENT_UNSUPPORTED');
    }
    const inspection = inspectApprovalValueGraph(rawEvent);
    if (approvalGraphUnsafe(inspection)) transitionError('APPROVAL_STATE_EVENT_REPLAYED');
    const event = clone(rawEvent);
    if (!isCanonicalInstant(event.observedAt)) transitionError('APPROVAL_STATE_EVENT_TIME_INVALID');
    const eventTime = event.type === 'ACCEPTANCE_REVALIDATED'
      ? event.checkedAt
      : event.observedAt;
    if (!isCanonicalInstant(eventTime)
      || Date.parse(eventTime) > Date.parse(reductionNow)
      || (priorEventTime !== null && Date.parse(eventTime) < Date.parse(priorEventTime))) {
      transitionError('APPROVAL_STATE_EVENT_TIME_INVALID');
    }
    const eventDigest = canonicalApprovalDigest(event);
    if (eventDigests.has(eventDigest)) transitionError('APPROVAL_STATE_EVENT_REPLAYED');
    eventDigests.add(eventDigest);
    priorEventTime = eventTime;
    const plan = planApprovalStateTransition({
      currentProjection: stateProjection(state),
      event,
      policySnapshot: policy,
      observedAt: reductionNow,
    });
    state = admitTransitionPlan(plan, events, policy);
  }
  return state;
};

const boundHistoryHold = (binding, code) => deepFreeze({
  ...baseState(binding.policySnapshot),
  evidenceTrustState: 'EXTERNAL_UNVERIFIED',
  blockingCodes: [code],
  eventHistory: [],
});

export const reduceApprovalDecisionState = (events, policy, now) => {
  nowIso(now);
  if (!Array.isArray(events)) throw approvalError('APPROVAL_STATE_INPUT_INVALID');
  const binding = getApprovalHistoryBinding(events);
  if (binding === undefined) {
    return boundHistoryHold(
      createPolicyBinding(policy),
      'APPROVAL_STATE_HISTORY_NOT_ADMITTED',
    );
  }
  if (!callerPolicyMatches(policy, binding)) {
    return boundHistoryHold(binding, 'APPROVAL_STATE_POLICY_MISMATCH');
  }
  const currentBinding = getApprovalHistoryBinding(events);
  if (currentBinding?.capabilityState !== HISTORY_ACTIVE) {
    return boundHistoryHold(currentBinding ?? binding, 'APPROVAL_STATE_HISTORY_CONSUMED');
  }
  return reduceBoundApprovalDecisionState(events, currentBinding, now);
};

export const initializeApprovalDecisionState = (policy, now) => {
  nowIso(now);
  const binding = createPolicyBinding(policy);
  const history = activateApprovalHistory(prepareApprovalHistory([]), binding);
  return reduceBoundApprovalDecisionState(history, binding, now);
};

export const appendApprovalDecisionEvent = (
  state,
  append,
  policy,
  now,
) => {
  const appendedAt = nowIso(now);
  if (!isPlainObject(state)) transitionError('APPROVAL_STATE_APPEND_INVALID');
  const history = state.eventHistory;
  if (!Array.isArray(history)
    || !hasApprovalHistoryBinding(history)) {
    transitionError('APPROVAL_STATE_APPEND_INVALID');
  }
  const binding = getApprovalHistoryBinding(history);
  if (binding.capabilityState !== HISTORY_ACTIVE) {
    return boundHistoryHold(binding, 'APPROVAL_STATE_HISTORY_CONSUMED');
  }
  setApprovalHistoryBinding(history, historyBinding(
    binding.policySnapshot,
    binding.policySha256,
    HISTORY_APPENDING,
  ));
  let committed = false;
  try {
    if (!callerPolicyMatches(policy, binding)) {
      return boundHistoryHold(binding, 'APPROVAL_STATE_POLICY_MISMATCH');
    }
    if (!hasExactKeys(append, APPEND_KEYS)
      || append.schemaVersion !== 'approval-event-append/v1'
      || append.appendedAt !== appendedAt
      || !isDigest(append.expectedHistorySha256)
      || append.expectedHistorySha256 !== canonicalApprovalDigest(history)
      || !isPlainObject(append.event)) transitionError('APPROVAL_STATE_APPEND_INVALID');
    const inspection = inspectApprovalValueGraph(append.event);
    if (approvalGraphUnsafe(inspection)) transitionError('APPROVAL_STATE_APPEND_INVALID');
    if (append.event.type === 'RECEIPT_VERIFIED') {
      transitionError('APPROVAL_INDEPENDENCE_NOT_PROVEN');
    }
    const currentState = reduceBoundApprovalDecisionState(history, binding, now);
    let event;
    if (append.event.type === 'ACCEPTANCE_REVALIDATED') {
      if (!hasExactKeys(append.event, ACCEPTANCE_LIVE_KEYS)
        || !acceptanceEventEvidenceValid(append.event)
        || append.event.observedAt !== append.event.evidence.readAt) {
        transitionError('APPROVAL_ACCEPTANCE_REVALIDATION_STALE');
      }
      const validation = revalidateApprovalAtAcceptance(currentState, append.event.evidence, now);
      if (!validation.valid) {
        transitionError(validation.issues[0]?.stable_code ?? 'APPROVAL_ACCEPTANCE_REVALIDATION_STALE');
      }
      event = {
        ...clone(append.event),
        checkedAt: validation.checkedAt,
        evidenceSha256: canonicalApprovalDigest(append.event.evidence),
      };
    } else if (append.event.type === 'RECEIPT_REVOKED') {
      event = buildStoredReceiptRevocationEvent(
        append.event,
        currentState,
        binding.policySnapshot,
        appendedAt,
      );
    } else {
      if (append.event.observedAt !== appendedAt) transitionError('APPROVAL_STATE_EVENT_TIME_INVALID');
      event = clone(append.event);
    }
    const nextHistory = prepareApprovalHistory([...history, event]);
    const nextState = reduceBoundApprovalDecisionState(nextHistory, binding, now);
    setApprovalHistoryBinding(history, historyBinding(
      binding.policySnapshot,
      binding.policySha256,
      HISTORY_CONSUMED,
    ));
    activateApprovalHistory(nextHistory, binding);
    committed = true;
    return nextState;
  } finally {
    if (!committed
      && getApprovalHistoryBinding(history)?.capabilityState === HISTORY_APPENDING) {
      activateApprovalHistory(history, binding);
    }
  }
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
const containsNonce = (value) => {
  const inspection = inspectApprovalValueGraph(value, { checkNonce: true });
  return approvalGraphUnsafe(inspection) || inspection.nonce;
};
const HISTORY_EVENT_KEYS = Object.freeze({
  AUTHORITIES_ASSIGNED: ['type', 'observedAt'],
  PROPOSAL_RENDERED: ['type', 'headSha', 'observedAt'],
  PRODUCT_REVIEW_VERIFIED: ['type', 'headSha', 'observedAt'],
  RECEIPT_VERIFIED: ['type', 'headSha', 'receipt', 'mergeAuthorization', 'observedAt'],
  HEAD_CHANGED: ['type', 'headSha', 'observedAt'],
  REVIEW_REJECTED: ['type', 'observedAt'],
  RECEIPT_SUPERSEDED: ['type', 'predecessorReceiptId', 'successor', 'validation', 'observedAt'],
});
const eventHistoryValid = (events) => (
  Array.isArray(events)
  && events.length <= 128
  && events.every((event) => {
    if (event?.type === 'ACCEPTANCE_REVALIDATED') {
      return hasExactKeys(event, ACCEPTANCE_STORED_KEYS)
        && acceptanceEventEvidenceValid(event);
    }
    if (event?.type === 'RECEIPT_REVOKED') {
      return isClosedStoredReceiptRevocationEvent(event);
    }
    const keys = HISTORY_EVENT_KEYS[event?.type];
    if (!keys || !hasExactKeys(event, keys) || containsNonce(event)) return false;
    try {
      return Buffer.byteLength(JSON.stringify(event), 'utf8') <= 32_768;
    } catch {
      return false;
    }
  })
);
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
  && eventHistoryValid(state.eventHistory)
  && (state.policySnapshot === undefined || policyShapeValid(state.policySnapshot))
  && (state.acceptanceCheckedAt === undefined
    || state.acceptanceCheckedAt === null
    || isCanonicalInstant(state.acceptanceCheckedAt))
  && ['ACTIVE', 'REVOKED'].includes(state.revocationStatus)
  && ['CURRENT', 'SUPERSEDED_WITH_CURRENT_SUCCESSOR'].includes(state.supersessionStatus)
  && !containsNonce({ ...state, eventHistory: [] })
);

export const renderApprovalStatusReadModel = (state) => {
  if (!readStateClosed(state) || !STATUS_COPY[state.state]) {
    throw approvalError(containsNonce(state)
      ? 'APPROVAL_STATUS_NONCE_FORBIDDEN'
      : 'APPROVAL_STATUS_EVIDENCE_REQUIRED');
  }
  const [messageKey, message, recoveryAction] = STATUS_COPY[state.state];
  const blockingCodes = state.blockingCodes.slice();
  const acceptanceEvidenceSha256 = [...state.eventHistory]
    .reverse()
    .find(({ type }) => type === 'ACCEPTANCE_REVALIDATED')?.evidenceSha256 ?? null;
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
    acceptanceEvidenceSha256,
  });
  if (Buffer.byteLength(JSON.stringify(model), 'utf8') > 32_768) {
    throw approvalError('APPROVAL_STATUS_OUTPUT_OVERFLOW');
  }
  return model;
};
