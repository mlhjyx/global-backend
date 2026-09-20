const DUAL_ROLE = 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER';

export const approvalLegalEvidenceRequired = ({ decisionAdr, actorPolicy }) => (
  decisionAdr === 'ADR-026' || actorPolicy === DUAL_ROLE
);

export const approvalVerifiedLegalState = (input) => (
  approvalLegalEvidenceRequired(input) ? 'NO_BLOCKER_RECORDED' : 'PENDING'
);
