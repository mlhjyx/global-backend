import {
  validateApprovalReceipt,
  validateApprovalRevocation,
  validateApprovalSupersession,
} from './governance-approval-schema-validator.mjs';
import {
  authorityIsCurrent,
  authorityRole,
  hasExactKeys,
  isCausalOrder,
  isDigest,
  isPlainObject,
  resultFromCodes,
} from './governance-approval-readback-common.mjs';

const RECEIPT_ENTRY_KEYS = Object.freeze(['envelope', 'receipt_raw_sha256']);
const SNAPSHOT_KEYS = Object.freeze(['schema_version', 'receipts', 'revocations', 'supersessions']);
const PURPOSE_BY_ROLE = Object.freeze({
  'OWN-PRODUCT': 'DECISION_REVIEW',
  'OWN-DATA-PRIVACY': 'DECISION_REVIEW',
  'OWN-QA-EVIDENCE': 'QA_EVIDENCE_REVIEW',
  'OWN-SECURITY': 'SECURITY_REVIEW',
  'LEGAL-REVIEW': 'LEGAL_REVIEW',
  'MERGE-AUTHORIZER': 'MERGE_AUTHORIZATION',
});
const POLICY_REVOCATION_ROLES = new Set([
  'OWN-PRODUCT', 'OWN-DATA-PRIVACY', 'LEGAL-REVIEW',
]);

const receiptRef = (receipt) => ({
  receipt_id: receipt?.envelope?.core?.receipt_id,
  receipt_core_sha256: receipt?.envelope?.receipt_core_sha256,
  receipt_raw_sha256: receipt?.receipt_raw_sha256,
});

const receiptReferenceMatches = (reference, receipt) => {
  const actual = receiptRef(receipt);
  return reference?.receipt_id === actual.receipt_id
    && reference?.receipt_core_sha256 === actual.receipt_core_sha256
    && reference?.receipt_raw_sha256 === actual.receipt_raw_sha256;
};

const receiptEntryValid = (entry) => (
  hasExactKeys(entry, RECEIPT_ENTRY_KEYS)
  && isDigest(entry.receipt_raw_sha256)
  && validateApprovalReceipt(entry.envelope).valid
);

const snapshotValid = (snapshot) => {
  if (
    !hasExactKeys(snapshot, SNAPSHOT_KEYS)
    || snapshot.schema_version !== 'approval-receipt-lifecycle-snapshot/v1'
    || !Array.isArray(snapshot.receipts)
    || !Array.isArray(snapshot.revocations)
    || !Array.isArray(snapshot.supersessions)
    || snapshot.receipts.length < 1
    || snapshot.receipts.length > 64
    || snapshot.revocations.length > 64
    || snapshot.supersessions.length > 64
    || snapshot.receipts.some((receipt) => !receiptEntryValid(receipt))
    || snapshot.revocations.some((revocation) => !validateApprovalRevocation(revocation).valid)
    || snapshot.supersessions.some((supersession) => !validateApprovalSupersession(supersession).valid)
  ) return false;
  const ids = snapshot.receipts.map((receipt) => receipt.envelope.core.receipt_id);
  if (new Set(ids).size !== ids.length) return false;
  const byId = new Map(snapshot.receipts.map((receipt) => [receipt.envelope.core.receipt_id, receipt]));
  return snapshot.revocations.every((revocation) => receiptReferenceMatches(revocation, byId.get(revocation.receipt_id)))
    && snapshot.supersessions.every((edge) => (
      receiptReferenceMatches(edge.predecessor, byId.get(edge.predecessor.receipt_id))
      && receiptReferenceMatches(edge.successor, byId.get(edge.successor.receipt_id))
    ));
};

const candidateFromReceipt = (receipt) => ({
  repository: receipt.envelope.core.repository,
  decision: {
    adr: receipt.envelope.core.decision_adr,
    policy_revision: receipt.envelope.core.policy_revision,
  },
});

export const validateReceiptRevocation = (revocation, receipt, authority, now) => {
  const codes = [];
  if (!validateApprovalRevocation(revocation).valid || !receiptEntryValid(receipt)) {
    return resultFromCodes(['APPROVAL_RECEIPT_DIGEST_MISMATCH']);
  }
  if (!POLICY_REVOCATION_ROLES.has(revocation.revoking_role)) {
    return resultFromCodes(['APPROVAL_ROLE_AUTHORITY_STALE']);
  }
  if (!receiptReferenceMatches(revocation, receipt)) codes.push('APPROVAL_RECEIPT_DIGEST_MISMATCH');
  const assigned = authorityRole(authority, revocation.revoking_role);
  const candidate = candidateFromReceipt(receipt);
  if (
    revocation.authority_revision !== authority.revision
    || revocation.authority_sha256 !== authority.sha256
    || assigned?.actor_id !== revocation.revoking_actor_id
    || !authorityIsCurrent(
      assigned,
      [revocation.effective_at, now],
      PURPOSE_BY_ROLE[revocation.revoking_role],
      candidate,
    )
    || !isCausalOrder(revocation.effective_at, now)
  ) codes.push('APPROVAL_ROLE_AUTHORITY_STALE');
  return resultFromCodes(codes, {
    state: 'REVOKED',
    receipt_id: revocation.receipt_id,
    receipt_core_sha256: revocation.receipt_core_sha256,
    receipt_raw_sha256: revocation.receipt_raw_sha256,
    effective_at: revocation.effective_at,
  });
};

const adjacencyFrom = (supersessions) => {
  const adjacency = new Map();
  for (const edge of supersessions) {
    const predecessor = edge.predecessor.receipt_id;
    const successors = adjacency.get(predecessor) ?? new Set();
    successors.add(edge.successor.receipt_id);
    adjacency.set(predecessor, successors);
  }
  return adjacency;
};

const isReachable = (adjacency, start, target) => {
  const pending = [start];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) pending.push(next);
  }
  return false;
};

export const inspectSyntheticReceiptSupersession = (supersession, snapshot, authority, now) => {
  const codes = [];
  if (!snapshotValid(snapshot)) {
    return resultFromCodes(['APPROVAL_RECEIPT_LIFECYCLE_SNAPSHOT_INVALID']);
  }
  if (!validateApprovalSupersession(supersession).valid) {
    const callerCycle = (
      supersession?.predecessor?.receipt_id === supersession?.successor?.receipt_id
      || supersession?.predecessor_chain?.includes(supersession?.successor?.receipt_id)
    );
    return resultFromCodes([callerCycle ? 'APPROVAL_RECEIPT_REPLAYED' : 'APPROVAL_RECEIPT_DIGEST_MISMATCH']);
  }
  const byId = new Map(snapshot.receipts.map((receipt) => [receipt.envelope.core.receipt_id, receipt]));
  const predecessor = byId.get(supersession.predecessor.receipt_id);
  const successor = byId.get(supersession.successor.receipt_id);
  if (!receiptReferenceMatches(supersession.predecessor, predecessor) || !receiptReferenceMatches(supersession.successor, successor)) {
    codes.push('APPROVAL_RECEIPT_DIGEST_MISMATCH');
  }
  const adjacency = adjacencyFrom(snapshot.supersessions);
  if (
    supersession.predecessor.receipt_id === supersession.successor.receipt_id
    || isReachable(adjacency, supersession.successor.receipt_id, supersession.predecessor.receipt_id)
  ) codes.push('APPROVAL_RECEIPT_REPLAYED');
  if (
    supersession.authority_revision !== authority.revision
    || supersession.authority_sha256 !== authority.sha256
    || !isCausalOrder(supersession.effective_at, now)
  ) codes.push('APPROVAL_ROLE_AUTHORITY_STALE');
  return resultFromCodes(codes, {
    state: 'SUPERSEDED',
    predecessor_receipt_id: supersession.predecessor.receipt_id,
    successor_receipt_id: supersession.successor.receipt_id,
    effective_at: supersession.effective_at,
  });
};

export const validateReceiptSupersession = (supersession, snapshot, authority, now) => {
  const synthetic = inspectSyntheticReceiptSupersession(supersession, snapshot, authority, now);
  return resultFromCodes([
    ...synthetic.issues.map(({ stable_code: stableCode }) => stableCode),
    'APPROVAL_INDEPENDENCE_NOT_PROVEN',
  ]);
};

export const isLifecycleSnapshot = (value) => isPlainObject(value) && snapshotValid(value);
