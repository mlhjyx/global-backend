import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import * as approvalState from '../../../governance-approval-state.mjs';
import { approvalVerifiedLegalState } from '../../../governance-approval-legal-policy.mjs';
import { deepFreeze } from '../../../governance-approval-readback-common.mjs';
import { buildTask3AcceptanceEvidence } from './task3-acceptance-evidence.mjs';
import { buildSyntheticTrustedReceiptArtifact } from '../synthetic-trusted-receipt.mjs';

export const NOW = new Date('2026-08-30T08:30:00.000Z');
export const REVOCATION_NOW = new Date('2026-08-30T08:31:00.000Z');

const clone = (value) => structuredClone(value);
const frozenClone = (value) => deepFreeze(clone(value));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
};

export const digest = (value) => (
  `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
);
const rawDigest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

const ROOT = new URL('./', import.meta.url);
const grant = JSON.parse(await readFile(new URL('valid-grant.json', ROOT), 'utf8'));
const currentMainReadback = JSON.parse(
  await readFile(new URL('current-main-readback.json', ROOT), 'utf8'),
);

const receiptSource = buildTask3AcceptanceEvidence();
receiptSource.candidate.receipt_subject.phase = 'REVIEW';
const receiptArtifact = buildSyntheticTrustedReceiptArtifact(
  receiptSource.candidate,
  null,
  '2026-08-30T08:29:00.000Z',
);
const targetReceipt = Object.freeze({
  envelope: receiptArtifact.envelope,
  receipt_raw_sha256: receiptArtifact.receiptRawSha256,
});

const receiptSummary = () => ({
  receiptId: receiptArtifact.envelope.core.receipt_id,
  receiptCoreSha256: receiptArtifact.envelope.receipt_core_sha256,
  receiptRawSha256: receiptArtifact.receiptRawSha256,
  trustState: 'INDEPENDENT_EXTERNAL_VERIFIED',
  validUntil: '2026-08-30T10:00:00.000Z',
});

export const approvalPolicy = () => {
  const task3 = buildTask3AcceptanceEvidence();
  const commandDigest = (role) => rawDigest(
    `APPROVE DECISION ADR-027 REV program-c/policy-r1 ROLE ${role} `
      + `DIGEST sha256:${'1'.repeat(64)}`,
  );
  return {
    repository: { id: 1291151138, fullName: 'mlhjyx/global-backend' },
    decisionId: 'ADR-027',
    decisionRevision: 'program-c/decision-r1',
    policyRevision: 'program-c/policy-r1',
    currentBaseSha: 'a'.repeat(40),
    currentHeadSha: 'b'.repeat(40),
    decisionRawSha256: `sha256:${'1'.repeat(64)}`,
    decisionSemanticSha256: `sha256:${'2'.repeat(64)}`,
    sidecarRawSha256: `sha256:${'8'.repeat(64)}`,
    proposalResultCommitSha: 'f'.repeat(40),
    authorityRevision: 'approval-authorities/r1',
    authoritySha256: `sha256:${'3'.repeat(64)}`,
    authorityRawSha256: digest(task3.authority),
    authorityEffectiveFrom: '2026-08-30T07:00:00.000Z',
    authorityEffectiveUntil: '2026-08-30T10:00:00.000Z',
    legalScope: 'PROGRAM_C_SUPPRESSION',
    legalDigest: digest(task3.candidate.legal_input),
    actorPolicy: task3.candidate.policy.actor_policy,
    dualRoleExceptionSha256: null,
    liveRulesetSha256: `sha256:${'b'.repeat(64)}`,
    acceptanceAllowlist: [
      {
        path: 'docs/adr/027-program-c-suppression.md',
        sha256: `sha256:${'c'.repeat(64)}`,
      },
      { path: 'docs/adr/registry.md', sha256: `sha256:${'d'.repeat(64)}` },
    ],
    requiredReviews: [
      ['PRODUCT', commandDigest('OWN-PRODUCT')],
      ['PRIVACY', commandDigest('OWN-DATA-PRIVACY')],
      ['CODEOWNER', rawDigest('CODEOWNER_REPOSITORY_REVIEW')],
      ['QA', commandDigest('OWN-QA-EVIDENCE')],
      ['SECURITY', commandDigest('OWN-SECURITY')],
    ].map(([slot, commandDigestValue]) => ({ slot, commandDigest: commandDigestValue })),
    requiredMachineChecks: [{
      context: 'approval-readback',
      appId: 42700,
      workflowPath: '.github/workflows/approval-readback.yml',
      workflowSha: 'd'.repeat(40),
      baseBlobSha: 'e'.repeat(40),
      signerIdentity: 'github-app:427',
    }],
    freshnessMs: 3_600_000,
  };
};

const requestFor = (grantValue) => ({
  requestId: 'merge-request-task4-0001',
  reservationId: 'merge-reservation-task4-0001',
  repositoryId: grantValue.repository.id,
  decisionAdr: grantValue.decision_adr,
  decisionRevision: grantValue.decision_revision,
  policyRevision: grantValue.policy_revision,
  stage: grantValue.stage,
  prNumber: grantValue.pr_number,
  baseSha: grantValue.base_sha,
  headSha: grantValue.head_sha,
  mergeMethod: grantValue.allowed_merge_method,
});

const consumptionFor = (grantRawSha256) => ({
  schema_version: 'program-c-merge-authorization-consumption/v1',
  consumption_id: 'program-c-consumption-task4-0001',
  grant_id: grant.grant_id,
  grant_raw_sha256: grantRawSha256,
  single_use_nonce: grant.single_use_nonce,
  repository: clone(grant.repository),
  decision_adr: grant.decision_adr,
  decision_revision: grant.decision_revision,
  policy_revision: grant.policy_revision,
  stage: grant.stage,
  pr_number: grant.pr_number,
  authorized_head_sha: grant.head_sha,
  result_commit_sha: currentMainReadback.resultCommitSha,
  observed_merge_method: currentMainReadback.observedMergeMethod,
  consumed_at: currentMainReadback.currentMain.readAt,
  nonce_ledger_key: `program-c-merge:${grant.single_use_nonce}`,
  nonce_ledger_reserved_revision: 1,
  independent_verifier: {
    repository: clone(currentMainReadback.independentVerifier.repository),
    path: currentMainReadback.independentVerifier.path,
    sha: currentMainReadback.independentVerifier.sha,
    run_id: currentMainReadback.independentVerifier.runId,
    attempt: currentMainReadback.independentVerifier.attempt,
    identity: currentMainReadback.independentVerifier.identity,
  },
  current_main: {
    ref: currentMainReadback.currentMain.ref,
    sha: currentMainReadback.currentMain.sha,
    read_at: currentMainReadback.currentMain.readAt,
  },
  pre_readback_sha256: currentMainReadback.preReadbackSha256,
  post_readback_sha256: currentMainReadback.postReadbackSha256,
});

const refreshAcceptanceTransaction = (evidence) => {
  const transaction = {
    currentPullRequest: evidence.currentPullRequest,
    acceptanceDiff: evidence.acceptanceDiff,
    reviews: evidence.reviews,
    authority: evidence.authority,
    legal: evidence.legal,
    ruleset: evidence.ruleset,
    machineChecks: evidence.machineChecks,
    receipt: evidence.receipt,
    proposalMain: evidence.proposalMain,
    mergeAuthorization: evidence.mergeAuthorization,
    task3: evidence.task3,
  };
  evidence.preAcceptanceRead = clone(transaction);
  evidence.postAcceptanceRead = clone(transaction);
  evidence.preAcceptanceReadSha256 = digest(transaction);
  evidence.postAcceptanceReadSha256 = digest(transaction);
  return evidence;
};

const append = (state, event, policy, now) => approvalState.appendApprovalDecisionEvent(state, {
  schemaVersion: 'approval-event-append/v1',
  expectedHistorySha256: digest(state.eventHistory),
  appendedAt: now.toISOString(),
  event,
}, policy, now);

export const buildStateFromEvents = (events, policy, now = NOW) => {
  if (typeof approvalState.initializeApprovalDecisionState !== 'function') {
    return approvalState.reduceApprovalDecisionState(events, policy, now);
  }
  let state = approvalState.initializeApprovalDecisionState(
    policy,
    events.length === 0 ? now : new Date(events[0].observedAt),
  );
  for (const event of events) {
    state = append(state, event, policy, new Date(event.observedAt));
  }
  return state;
};

const buildRound4Scenario = () => {
  const policy = approvalPolicy();
  const task3 = buildTask3AcceptanceEvidence();
  const grantRawSha256 = digest(grant);
  const consumption = consumptionFor(grantRawSha256);
  const consumptionRawSha256 = digest(consumption);
  const request = requestFor(grant);
  const reservation = {
    type: 'NONCE_RESERVED',
    grantId: grant.grant_id,
    grantRawSha256,
    requestId: request.requestId,
    reservationId: request.reservationId,
    repositoryId: grant.repository.id,
    stage: grant.stage,
    decisionAdr: grant.decision_adr,
    decisionRevision: grant.decision_revision,
    policyRevision: grant.policy_revision,
    prNumber: grant.pr_number,
    baseSha: grant.base_sha,
    headSha: grant.head_sha,
    mergeMethod: grant.allowed_merge_method,
    reservedAt: '2026-08-30T08:10:00.000Z',
    ledgerRevision: 1,
  };
  const ledgerSnapshot = {
    durabilityClass: 'SHARED_DURABLE_CAS',
    key: { repositoryId: grant.repository.id, singleUseNonce: grant.single_use_nonce },
    committedRevision: 4,
    events: [
      reservation,
      {
        type: 'MERGE_ACK_UNKNOWN',
        reasonCode: 'PHYSICAL_REQUEST_DISPATCHING',
        observedAt: '2026-08-30T08:11:00.000Z',
        ledgerRevision: 2,
      },
      {
        type: 'MERGE_RESULT_OBSERVED',
        resultCommitSha: currentMainReadback.resultCommitSha,
        observedMergeMethod: currentMainReadback.observedMergeMethod,
        observedAt: currentMainReadback.currentMain.readAt,
        ledgerRevision: 3,
      },
      {
        type: 'CONSUMPTION_RECORDED',
        consumption: clone(consumption),
        consumptionRawSha256,
        recordedAt: currentMainReadback.currentMain.readAt,
        ledgerRevision: 4,
      },
    ],
  };
  const mergeAuthorization = {
    grantId: grant.grant_id,
    grantRawSha256,
    consumptionId: consumption.consumption_id,
    consumptionRawSha256,
    reservedLedgerRevision: 1,
    ledgerState: 'CONSUMED',
  };
  const evidence = refreshAcceptanceTransaction({
    schemaVersion: 'approval-acceptance-evidence/v1',
    task3,
    readAt: '2026-08-30T08:29:00.000Z',
    currentPullRequest: {
      number: grant.pr_number,
      state: 'MERGED',
      baseSha: grant.base_sha,
      headSha: grant.head_sha,
    },
    acceptanceDiff: { complete: true, files: clone(policy.acceptanceAllowlist) },
    reviews: policy.requiredReviews.map((required) => {
      const source = {
        PRODUCT: task3.candidate.product_review,
        PRIVACY: task3.candidate.privacy_review,
        CODEOWNER: task3.candidate.codeowner_review,
        QA: task3.candidate.qa_review,
        SECURITY: task3.candidate.security_review,
      }[required.slot];
      return {
        slot: required.slot,
        reviewId: source.review_id,
        actorId: source.actor?.id ?? source.actor_id,
        state: 'APPROVED',
        headSha: policy.currentHeadSha,
        submittedAt: source.submitted_at,
        commandDigest: required.commandDigest,
      };
    }),
    authority: {
      revision: policy.authorityRevision,
      sha256: policy.authoritySha256,
      rawSha256: policy.authorityRawSha256,
      effectiveFrom: policy.authorityEffectiveFrom,
      effectiveUntil: policy.authorityEffectiveUntil,
      assignmentsCurrent: true,
      revocationStatus: 'ACTIVE',
      reassigned: false,
    },
    legal: {
      status: 'NO_BLOCKER_RECORDED',
      scope: policy.legalScope,
      digest: policy.legalDigest,
      validFrom: '2026-08-30T07:00:00.000Z',
      validUntil: '2026-08-30T10:00:00.000Z',
      revocationStatus: 'ACTIVE',
    },
    ruleset: {
      normalizedSha256: policy.liveRulesetSha256,
      bypassActors: [],
      observedAt: '2026-08-30T08:28:00.000Z',
    },
    machineChecks: policy.requiredMachineChecks.map((required) => ({
      ...clone(required),
      checkRunId: 7001,
      checkSuiteId: 7002,
      workflowRunId: 7003,
      headSha: policy.currentBaseSha,
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      checkRunSuiteAssociated: true,
      suiteRunAssociated: true,
      runHeadAssociated: true,
    })),
    receipt: {
      ...receiptSummary(),
      priorReceiptIds: [],
      revoked: false,
      superseded: false,
    },
    proposalMain: {
      proposalResultCommitSha: policy.proposalResultCommitSha,
      currentMainSha: currentMainReadback.currentMain.sha,
      resultReachableFromCurrentMain: true,
      approvedDecisionRawSha256: policy.decisionRawSha256,
      approvedDecisionSemanticSha256: policy.decisionSemanticSha256,
      approvedSidecarRawSha256: policy.sidecarRawSha256,
    },
    mergeAuthorization: {
      grant: clone(grant),
      grantRawSha256,
      request,
      currentMainReadback: clone(currentMainReadback),
      consumption,
      consumptionRawSha256,
      ledgerSnapshot,
    },
  });
  const verifiedEvents = [
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
    {
      type: 'PROPOSAL_RENDERED',
      headSha: policy.currentHeadSha,
      observedAt: '2026-08-30T07:10:00.000Z',
    },
    {
      type: 'PRODUCT_REVIEW_VERIFIED',
      headSha: policy.currentHeadSha,
      observedAt: '2026-08-30T07:20:00.000Z',
    },
    {
      type: 'RECEIPT_VERIFIED',
      headSha: policy.currentHeadSha,
      receipt: receiptSummary(),
      mergeAuthorization,
      observedAt: '2026-08-30T08:25:00.000Z',
    },
  ];
  return { evidence, mergeAuthorization, policy, verifiedEvents };
};

const initialSyntheticProjection = (policy) => ({
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
  acceptanceCheckedAt: null,
});

const syntheticTransitionEvent = (transition, scenario) => {
  const verifiedEvent = scenario.verifiedEvents.find(({ type }) => type === transition);
  if (verifiedEvent) return verifiedEvent;
  if (transition === 'ACCEPTANCE_REVALIDATED') {
    return {
      type: 'ACCEPTANCE_REVALIDATED',
      evidence: scenario.evidence,
      evidenceSha256: digest(scenario.evidence),
      observedAt: scenario.evidence.readAt,
      checkedAt: NOW.toISOString(),
    };
  }
  if (transition === 'RECEIPT_SUPERSEDED') {
    return {
      type: 'RECEIPT_SUPERSEDED',
      predecessorReceiptId: receiptSummary().receiptId,
      successor: {
        ...receiptSummary(),
        receiptId: 'approval-receipt-task4-0002',
      },
      validation: {
        valid: false,
        issues: [{ stable_code: 'APPROVAL_INDEPENDENCE_NOT_PROVEN' }],
        trustEligible: false,
      },
      observedAt: '2026-08-30T08:26:00.000Z',
    };
  }
  throw new Error('SYNTHETIC_APPROVAL_TRANSITION_UNKNOWN');
};

export const buildSyntheticApprovalStateKernelInput = ({
  currentProjection = null,
  event = null,
  observedAt = NOW.toISOString(),
  policySnapshot = null,
  transition = 'AUTHORITIES_ASSIGNED',
} = {}) => {
  const scenario = buildRound4Scenario();
  const closedPolicy = policySnapshot ?? scenario.policy;
  return frozenClone({
    currentProjection: currentProjection ?? initialSyntheticProjection(closedPolicy),
    event: event ?? syntheticTransitionEvent(transition, scenario),
    policySnapshot: closedPolicy,
    observedAt,
  });
};

const syntheticStateFromProjection = (projection, eventHistory, policySnapshot) => frozenClone({
  ...projection,
  eventHistory,
  policySnapshot,
});

export const buildSyntheticVerifiedApprovalStateFixture = ({
  mergeAuthorization = null,
  policySnapshot = null,
  receipt = null,
} = {}) => {
  const scenario = buildRound4Scenario();
  const closedPolicy = policySnapshot ?? scenario.policy;
  const receiptEvent = {
    ...clone(scenario.verifiedEvents.at(-1)),
    headSha: closedPolicy.currentHeadSha,
    receipt: receipt ?? scenario.verifiedEvents.at(-1).receipt,
    mergeAuthorization: mergeAuthorization ?? scenario.mergeAuthorization,
  };
  return syntheticStateFromProjection({
    ...initialSyntheticProjection(closedPolicy),
    state: 'VERIFIED',
    legalState: approvalVerifiedLegalState({
      decisionAdr: closedPolicy.decisionId,
      actorPolicy: closedPolicy.actorPolicy,
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
    receipt: receiptEvent.receipt,
    mergeAuthorization: receiptEvent.mergeAuthorization,
    blockingCodes: ['APPROVAL_ACCEPTANCE_REVALIDATION_REQUIRED'],
  }, [
    ...scenario.verifiedEvents.slice(0, -1),
    receiptEvent,
  ], closedPolicy);
};

export const buildRound4AcceptedState = () => {
  const { evidence, mergeAuthorization, policy } = buildRound4Scenario();
  const verified = buildSyntheticVerifiedApprovalStateFixture({
    mergeAuthorization,
    policySnapshot: policy,
  });
  const acceptanceEvent = {
    type: 'ACCEPTANCE_REVALIDATED',
    evidence,
    evidenceSha256: digest(evidence),
    observedAt: evidence.readAt,
    checkedAt: NOW.toISOString(),
  };
  const accepted = syntheticStateFromProjection(
    {
      ...verified,
      state: 'ACCEPTED',
      blockingCodes: [],
      acceptanceCheckedAt: NOW.toISOString(),
    },
    [...verified.eventHistory, acceptanceEvent],
    policy,
  );
  return { accepted, evidence, policy, synthetic: true, verified };
};

export const buildSyntheticMergeReconciliationKernelInput = ({
  observedAt = NOW.toISOString(),
  streamFacts = {},
} = {}) => {
  const grantRawSha256 = digest(grant);
  const request = requestFor(grant);
  const reservationEvent = {
    type: 'NONCE_RESERVED',
    grantId: grant.grant_id,
    grantRawSha256,
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
    reservedAt: '2026-08-30T08:10:00.000Z',
    ledgerRevision: 1,
  };
  return frozenClone({
    reservation: {
      schemaVersion: 'merge-authorization-reservation/v1',
      key: {
        repositoryId: grant.repository.id,
        singleUseNonce: grant.single_use_nonce,
      },
      grant,
      grantRawSha256,
      request,
      reservedLedgerRevision: 1,
      reservedAt: reservationEvent.reservedAt,
    },
    readback: currentMainReadback,
    streamFacts: {
      reservation: reservationEvent,
      acknowledgement: null,
      result: null,
      consumptionEvent: null,
      revocations: [],
      holds: [],
      ...streamFacts,
    },
    observedAt,
  });
};

export const revocationEvent = (overrides = {}) => {
  const authority = buildTask3AcceptanceEvidence().authority;
  const observedAt = overrides.observedAt ?? REVOCATION_NOW.toISOString();
  const revocation = {
    schema_version: 'trusted-approval-revocation/v1',
    receipt_id: receiptArtifact.envelope.core.receipt_id,
    receipt_core_sha256: receiptArtifact.envelope.receipt_core_sha256,
    receipt_raw_sha256: receiptArtifact.receiptRawSha256,
    authority_revision: authority.revision,
    authority_sha256: authority.sha256,
    reason_code: 'POLICY_WITHDRAWN',
    revoking_role: 'OWN-PRODUCT',
    revoking_actor_id: 8101,
    effective_at: observedAt,
  };
  return {
    type: 'RECEIPT_REVOKED',
    observedAt,
    revocation,
    targetReceipt: clone(targetReceipt),
    authority,
    authorityRawSha256: digest(authority),
    ...overrides,
  };
};
