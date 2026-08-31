import { mergeReceiptReference, mergeStageForPhase } from '../../governance-approval-merge-authorization.mjs';
import { normalizePolicyMachineCheckEvidence } from '../../governance-approval-machine-policy.mjs';
import { deepFreeze } from '../../governance-approval-readback-common.mjs';
import { buildApprovalReceiptArtifact } from '../../governance-approval-safe-json.mjs';

const reviewForRole = (candidate) => {
  if (candidate.receipt_subject.role === 'OWN-PRODUCT') return candidate.product_review;
  if (candidate.receipt_subject.role === 'OWN-DATA-PRIVACY') return candidate.privacy_review;
  if (candidate.receipt_subject.role === 'OWN-QA-EVIDENCE') return candidate.qa_review;
  if (candidate.receipt_subject.role === 'OWN-SECURITY') {
    return {
      actor: {
        id: candidate.security_review.actor_id,
        login: candidate.security_review.actor_login,
      },
    };
  }
  throw new Error('SYNTHETIC_RECEIPT_ROLE_UNSUPPORTED');
};

export const buildSyntheticTrustedReceiptCore = (
  candidate,
  mergeAuthorizationEvidence,
  approvedAt,
) => {
  const review = reviewForRole(candidate);
  const core = {
    receipt_id: candidate.receipt_subject.receipt_id,
    repository: {
      id: candidate.repository.id,
      full_name: candidate.repository.full_name,
    },
    authority_revision: candidate.authority_revision,
    authority_sha256: candidate.authority_sha256,
    role: candidate.receipt_subject.role,
    actor_id: review.actor.id,
    actor_login: review.actor.login,
    decision_adr: candidate.decision.adr,
    decision_revision: candidate.decision.revision,
    policy_revision: candidate.decision.policy_revision,
    pr_number: candidate.pull_request.number,
    base_sha: candidate.pull_request.base_sha,
    head_sha: candidate.pull_request.head_sha,
    approved_at: approvedAt,
    trust_class: 'TRUSTED_BASE_VERIFIED',
    machine_check_evidence: normalizePolicyMachineCheckEvidence(candidate, candidate.policy),
  };
  if (mergeStageForPhase(candidate.receipt_subject.phase) !== null) {
    core.merge_authorization_evidence = mergeReceiptReference(mergeAuthorizationEvidence);
  }
  return deepFreeze(core);
};

export const buildSyntheticTrustedReceiptArtifact = (
  candidate,
  mergeAuthorizationEvidence,
  approvedAt,
) => buildApprovalReceiptArtifact(
  buildSyntheticTrustedReceiptCore(candidate, mergeAuthorizationEvidence, approvedAt),
);
