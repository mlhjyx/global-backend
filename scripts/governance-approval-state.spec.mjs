import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as approvalStateModule from './governance-approval-state.mjs';
import { deepFreeze } from './governance-approval-readback-common.mjs';
import {
  executeReservedMerge,
  reconcileMergeAuthorizationReservation,
  reduceApprovalDecisionState,
  reserveMergeAuthorizationNonce,
  revalidateApprovalAtAcceptance,
} from './governance-approval-state.mjs';
import { planApprovalStateTransition } from './governance-approval-state-kernel.mjs';
import { buildStoredReceiptRevocationEvent } from './governance-approval-state-revocation.mjs';
import { runApprovalStatusCli } from './governance-approval-status.mjs';
import {
  buildSyntheticVerifiedApprovalStateForTests,
} from './fixtures/approval-readback/synthetic-verified-state.mjs';
import { buildTask3AcceptanceEvidence } from './fixtures/approval-readback/merge-authorization/task3-acceptance-evidence.mjs';
import {
  REVOCATION_NOW,
  buildStateFromEvents,
  buildSyntheticApprovalStateKernelInput,
  revocationEvent,
} from './fixtures/approval-readback/merge-authorization/task4-round4-state-fixture.mjs';
const NOW = new Date('2026-08-30T08:30:00.000Z');
const RESERVATION_NOW = new Date('2026-08-30T08:10:00.000Z');
const DISPATCH_NOW = new Date('2026-08-30T08:11:00.000Z');
const ROOT = new URL('./fixtures/approval-readback/merge-authorization/', import.meta.url);
const clone = (value) => structuredClone(value);
const projectStateForKernel = ({
  eventHistory: _eventHistory,
  policySnapshot: _policySnapshot,
  ...state
}) => state;
const appendRevocation = (state, policy, event, now = REVOCATION_NOW) => {
  const storedEvent = buildStoredReceiptRevocationEvent(
    event,
    state,
    policy,
    now.toISOString(),
  );
  const plan = planApprovalStateTransition({
    currentProjection: projectStateForKernel(state),
    event: storedEvent,
    policySnapshot: policy,
    observedAt: now.toISOString(),
  });
  return deepFreeze({
    ...plan.nextProjection,
    eventHistory: [...state.eventHistory, storedEvent],
    policySnapshot: clone(policy),
  });
};
const readJson = async (name) => JSON.parse(await readFile(new URL(name, ROOT), 'utf8'));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
const rawDigest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
class SharedDurableCasLedgerHarness {
  durabilityClass = 'SHARED_DURABLE_CAS';
  constructor(snapshot = []) {
    this.streams = new Map(snapshot.map((stream) => [this.#id(stream.key), clone(stream)]));
    this.casCalls = [];
  }
  #id(key) {
    return `${key.repositoryId}:${key.singleUseNonce}`;
  }
  async read(key) {
    const stream = this.streams.get(this.#id(key));
    return stream === undefined ? null : clone(stream);
  }
  async compareAndSwap(input) {
    this.casCalls.push(clone(input));
    const id = this.#id(input.key);
    const current = this.streams.get(id) ?? {
      key: clone(input.key),
      committedRevision: 0,
      events: [],
    };
    if (current.committedRevision !== input.expectedRevision) {
      return { outcome: 'CONFLICT', currentRevision: current.committedRevision };
    }
    const committedRevision = current.committedRevision + 1;
    this.streams.set(id, {
      key: clone(current.key),
      committedRevision,
      events: [...current.events, { ...clone(input.event), ledgerRevision: committedRevision }],
    });
    return { outcome: 'COMMITTED', committedRevision };
  }
  snapshot() {
    return [...this.streams.values()].map(clone);
  }
}
const requestFor = (grant, overrides = {}) => ({
  requestId: 'merge-request-task4-0001',
  reservationId: 'merge-reservation-task4-0001',
  repositoryId: grant.repository.id,
  decisionAdr: grant.decision_adr,
  decisionRevision: grant.decision_revision,
  policyRevision: grant.policy_revision,
  stage: grant.stage,
  prNumber: grant.pr_number,
  baseSha: grant.base_sha,
  headSha: grant.head_sha,
  mergeMethod: grant.allowed_merge_method,
  ...overrides,
});
const reserve = async (ledger, grant, request = requestFor(grant), expectedRevision = 0) => (
  reserveMergeAuthorizationNonce(
    grant,
    digest(grant),
    request,
    expectedRevision,
    ledger,
    RESERVATION_NOW,
  )
);
const approvalPolicy = () => {
  const task3 = buildTask3AcceptanceEvidence();
  const commandDigest = (role) => rawDigest(
    `APPROVE DECISION ADR-027 REV program-c/policy-r1 ROLE ${role} DIGEST sha256:${'1'.repeat(64)}`,
  );
  return ({
  repository: { id: 1291151138, fullName: 'mlhjyx/global-backend' },
  decisionId: 'ADR-027',
  decisionRevision: 'program-c/decision-r1',
  policyRevision: 'program-c/policy-r1',
  currentBaseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  currentHeadSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  decisionRawSha256: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  decisionSemanticSha256: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  sidecarRawSha256: 'sha256:8888888888888888888888888888888888888888888888888888888888888888',
  proposalResultCommitSha: 'ffffffffffffffffffffffffffffffffffffffff',
  authorityRevision: 'approval-authorities/r1',
  authoritySha256: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
  authorityRawSha256: digest(task3.authority),
  authorityEffectiveFrom: '2026-08-30T07:00:00.000Z',
  authorityEffectiveUntil: '2026-08-30T10:00:00.000Z',
  legalScope: 'PROGRAM_C_SUPPRESSION',
  legalDigest: digest(task3.candidate.legal_input),
  actorPolicy: task3.candidate.policy.actor_policy,
  dualRoleExceptionSha256: null,
  liveRulesetSha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  acceptanceAllowlist: [
    { path: 'docs/adr/027-program-c-suppression.md', sha256: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' },
    { path: 'docs/adr/registry.md', sha256: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' },
  ],
  requiredReviews: [
    ['PRODUCT', commandDigest('OWN-PRODUCT')],
    ['PRIVACY', commandDigest('OWN-DATA-PRIVACY')],
    ['CODEOWNER', rawDigest('CODEOWNER_REPOSITORY_REVIEW')],
    ['QA', commandDigest('OWN-QA-EVIDENCE')],
    ['SECURITY', commandDigest('OWN-SECURITY')],
  ].map(([slot, commandDigest]) => ({ slot, commandDigest })),
  requiredMachineChecks: [{
    context: 'approval-readback', appId: 42700,
    workflowPath: '.github/workflows/approval-readback.yml',
    workflowSha: 'dddddddddddddddddddddddddddddddddddddddd',
    baseBlobSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', signerIdentity: 'github-app:427',
  }],
  freshnessMs: 3_600_000,
  });
};
const receiptTarget = revocationEvent().targetReceipt;
const receiptSummary = () => ({
  receiptId: receiptTarget.envelope.core.receipt_id,
  receiptCoreSha256: receiptTarget.envelope.receipt_core_sha256,
  receiptRawSha256: receiptTarget.receipt_raw_sha256,
  trustState: 'INDEPENDENT_EXTERNAL_VERIFIED',
  validUntil: '2026-08-30T10:00:00.000Z',
});
const verifiedState = (policy, merge) => buildSyntheticVerifiedApprovalStateForTests({
  mergeAuthorization: merge,
  policySnapshot: policy,
  receipt: receiptSummary(),
}).state;
const consumptionFor = (grant, grantRawSha, readback, reservedRevision) => ({
  schema_version: 'program-c-merge-authorization-consumption/v1',
  consumption_id: 'program-c-consumption-task4-0001',
  grant_id: grant.grant_id,
  grant_raw_sha256: grantRawSha,
  single_use_nonce: grant.single_use_nonce,
  repository: clone(grant.repository),
  decision_adr: grant.decision_adr,
  decision_revision: grant.decision_revision,
  policy_revision: grant.policy_revision,
  stage: grant.stage,
  pr_number: grant.pr_number,
  authorized_head_sha: grant.head_sha,
  result_commit_sha: readback.resultCommitSha,
  observed_merge_method: readback.observedMergeMethod,
  consumed_at: readback.currentMain.readAt,
  nonce_ledger_key: `program-c-merge:${grant.single_use_nonce}`,
  nonce_ledger_reserved_revision: reservedRevision,
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
const refreshAcceptanceTransaction = (evidence) => {
  const acceptanceTransaction = {
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
  evidence.preAcceptanceRead = clone(acceptanceTransaction);
  evidence.postAcceptanceRead = clone(acceptanceTransaction);
  evidence.preAcceptanceReadSha256 = digest(acceptanceTransaction);
  evidence.postAcceptanceReadSha256 = digest(acceptanceTransaction);
  return evidence;
};
const configureDualRoleAcceptance = (evidence, policy, { bindState = true } = {}) => {
  const exception = {
    decision_adr: 'ADR-027',
    valid_from: '2026-08-30T00:00:00.000Z',
    valid_until: '2026-08-31T00:00:00.000Z',
    coapprover_role: 'OWN-QA-EVIDENCE',
    minimum_distinct_human_actors: 2,
    cannot_authorize_merge: true,
    cannot_authorize_release: true,
  };
  for (const task3Policy of [evidence.task3.candidate.policy, evidence.task3.policy]) {
    task3Policy.actor_policy = 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER';
    task3Policy.dual_role_exception = clone(exception);
  }
  evidence.task3.candidate.privacy_review.actor = clone(
    evidence.task3.candidate.product_review.actor,
  );
  const productAuthority = evidence.task3.authority.roles.find(
    ({ role }) => role === 'OWN-PRODUCT',
  );
  const privacyAuthority = evidence.task3.authority.roles.find(
    ({ role }) => role === 'OWN-DATA-PRIVACY',
  );
  privacyAuthority.actor_id = productAuthority.actor_id;
  privacyAuthority.actor_node_id = productAuthority.actor_node_id;
  privacyAuthority.actor_login = productAuthority.actor_login;
  evidence.reviews.find(({ slot }) => slot === 'PRIVACY').actorId = productAuthority.actor_id;
  policy.authorityRawSha256 = digest(evidence.task3.authority);
  evidence.authority.rawSha256 = policy.authorityRawSha256;
  if (bindState) {
    policy.actorPolicy = 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER';
    policy.dualRoleExceptionSha256 = digest(exception);
  }
  refreshAcceptanceTransaction(evidence);
  return exception;
};
const appendAcceptance = (state, evidence, policy, now) => {
  const validation = revalidateApprovalAtAcceptance(state, evidence, now);
  if (!validation.valid) {
    throw new Error(
      validation.issues[0]?.stable_code ?? 'APPROVAL_ACCEPTANCE_REVALIDATION_STALE',
    );
  }
  const event = {
    type: 'ACCEPTANCE_REVALIDATED',
    evidence: clone(evidence),
    evidenceSha256: validation.evidenceSha256,
    observedAt: evidence.readAt,
    checkedAt: validation.checkedAt,
  };
  const plan = planApprovalStateTransition({
    currentProjection: projectStateForKernel(state),
    event,
    policySnapshot: policy,
    observedAt: now.toISOString(),
  });
  return deepFreeze({
    ...plan.nextProjection,
    eventHistory: [...state.eventHistory, event],
    policySnapshot: clone(policy),
  });
};
const appendStateEvent = (state, event, policy, now, receiptCapability) => (
  approvalStateModule.appendApprovalDecisionEvent(state, {
    schemaVersion: 'approval-event-append/v1',
    expectedHistorySha256: digest(state.eventHistory),
    appendedAt: now.toISOString(),
    event,
  }, policy, now, receiptCapability)
);
const buildPublicPrivacyReviewState = (policy) => [
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
].reduce(
  (state, event) => appendStateEvent(state, event, policy, new Date(event.observedAt)),
  approvalStateModule.initializeApprovalDecisionState(
    policy,
    new Date('2026-08-30T07:05:00.000Z'),
  ),
);
const acceptanceEvidence = async () => {
  const policy = approvalPolicy();
  const task3 = buildTask3AcceptanceEvidence();
  const grant = await readJson('valid-grant.json');
  const readback = await readJson('current-main-readback.json');
  const grantRawSha256 = digest(grant);
  const consumption = consumptionFor(grant, grantRawSha256, readback, 1);
  const consumptionRawSha256 = digest(consumption);
  const reservation = {
    type: 'NONCE_RESERVED', grantId: grant.grant_id, grantRawSha256,
    requestId: 'merge-request-task4-0001', reservationId: 'merge-reservation-task4-0001',
    repositoryId: grant.repository.id, stage: grant.stage, decisionAdr: grant.decision_adr,
    decisionRevision: grant.decision_revision, policyRevision: grant.policy_revision,
    prNumber: grant.pr_number, baseSha: grant.base_sha, headSha: grant.head_sha,
    mergeMethod: grant.allowed_merge_method, reservedAt: '2026-08-30T08:10:00.000Z', ledgerRevision: 1,
  };
  const ledgerSnapshot = {
    durabilityClass: 'SHARED_DURABLE_CAS',
    key: { repositoryId: grant.repository.id, singleUseNonce: grant.single_use_nonce },
    committedRevision: 4,
    events: [
      reservation,
      { type: 'MERGE_ACK_UNKNOWN', reasonCode: 'PHYSICAL_REQUEST_DISPATCHING', observedAt: '2026-08-30T08:11:00.000Z', ledgerRevision: 2 },
      { type: 'MERGE_RESULT_OBSERVED', resultCommitSha: readback.resultCommitSha, observedMergeMethod: readback.observedMergeMethod, observedAt: readback.currentMain.readAt, ledgerRevision: 3 },
      { type: 'CONSUMPTION_RECORDED', consumption: clone(consumption), consumptionRawSha256, recordedAt: readback.currentMain.readAt, ledgerRevision: 4 },
    ],
  };
  const mergeAuthorization = {
    grantId: grant.grant_id, grantRawSha256,
    consumptionId: consumption.consumption_id, consumptionRawSha256,
    reservedLedgerRevision: 1, ledgerState: 'CONSUMED',
  };
  const request = requestFor(grant, {
    requestId: reservation.requestId,
    reservationId: reservation.reservationId,
  });
  const evidence = {
    schemaVersion: 'approval-acceptance-evidence/v1',
    task3,
    readAt: '2026-08-30T08:29:00.000Z',
    currentPullRequest: {
      number: grant.pr_number, state: 'MERGED', baseSha: grant.base_sha, headSha: grant.head_sha,
    },
    acceptanceDiff: { complete: true, files: clone(policy.acceptanceAllowlist) },
    reviews: policy.requiredReviews.map((required) => {
      const raw = {
        PRODUCT: task3.candidate.product_review,
        PRIVACY: task3.candidate.privacy_review,
        CODEOWNER: task3.candidate.codeowner_review,
        QA: task3.candidate.qa_review,
        SECURITY: task3.candidate.security_review,
      }[required.slot];
      return ({
      slot: required.slot,
      reviewId: raw.review_id,
      actorId: raw.actor?.id ?? raw.actor_id,
      state: 'APPROVED', headSha: policy.currentHeadSha,
      submittedAt: raw.submitted_at,
      commandDigest: required.commandDigest,
    });
    }),
    authority: {
      revision: policy.authorityRevision, sha256: policy.authoritySha256,
      rawSha256: policy.authorityRawSha256, effectiveFrom: policy.authorityEffectiveFrom,
      effectiveUntil: policy.authorityEffectiveUntil, assignmentsCurrent: true,
      revocationStatus: 'ACTIVE', reassigned: false,
    },
    legal: {
      status: 'NO_BLOCKER_RECORDED', scope: policy.legalScope, digest: policy.legalDigest,
      validFrom: '2026-08-30T07:00:00.000Z', validUntil: '2026-08-30T10:00:00.000Z',
      revocationStatus: 'ACTIVE',
    },
    ruleset: { normalizedSha256: policy.liveRulesetSha256, bypassActors: [], observedAt: '2026-08-30T08:28:00.000Z' },
    machineChecks: policy.requiredMachineChecks.map((required) => ({
      ...clone(required), checkRunId: 7001, checkSuiteId: 7002, workflowRunId: 7003,
      headSha: policy.currentBaseSha, status: 'COMPLETED', conclusion: 'SUCCESS',
      checkRunSuiteAssociated: true, suiteRunAssociated: true, runHeadAssociated: true,
    })),
    receipt: {
      ...receiptSummary(), priorReceiptIds: [], revoked: false, superseded: false,
    },
    proposalMain: {
      proposalResultCommitSha: policy.proposalResultCommitSha,
      currentMainSha: readback.currentMain.sha, resultReachableFromCurrentMain: true,
      approvedDecisionRawSha256: policy.decisionRawSha256,
      approvedDecisionSemanticSha256: policy.decisionSemanticSha256,
      approvedSidecarRawSha256: policy.sidecarRawSha256,
    },
    mergeAuthorization: {
      grant, grantRawSha256, request,
      currentMainReadback: clone(readback),
      consumption, consumptionRawSha256,
      ledgerSnapshot,
    },
  };
  refreshAcceptanceTransaction(evidence);
  return { evidence, grant, mergeAuthorization, policy, readback };
};

test('caller-owned receipt capability cannot promote public approval state', async () => {
  const { mergeAuthorization, policy } = await acceptanceEvidence();
  const fakeCapability = Object.freeze({ kind: 'caller-declared-receipt-verification' });
  const callerOwnedCapabilities = [
    fakeCapability,
    clone(fakeCapability),
    JSON.parse(JSON.stringify(fakeCapability)),
  ];
  const outcomes = callerOwnedCapabilities.map((capability) => {
    const privacy = buildPublicPrivacyReviewState(policy);
    assert.equal(privacy.state, 'AWAITING_PRIVACY_REVIEW');
    try {
      return appendStateEvent(privacy, {
        type: 'RECEIPT_VERIFIED',
        headSha: policy.currentHeadSha,
        receipt: receiptSummary(),
        mergeAuthorization,
        observedAt: '2026-08-30T08:25:00.000Z',
      }, policy, new Date('2026-08-30T08:25:00.000Z'), capability).state;
    } catch (error) {
      return error.message;
    }
  });

  assert.deepEqual(
    outcomes,
    Array.from({ length: callerOwnedCapabilities.length }, () => (
      'APPROVAL_INDEPENDENCE_NOT_PROVEN'
    )),
  );
});

test('pure state kernel plans VERIFIED and ACCEPTED projections without admitting history', () => {
  const transitions = [
    'AUTHORITIES_ASSIGNED',
    'PROPOSAL_RENDERED',
    'PRODUCT_REVIEW_VERIFIED',
    'RECEIPT_VERIFIED',
    'ACCEPTANCE_REVALIDATED',
  ];
  const projectedStates = [];
  let currentProjection = null;
  let finalPlan = null;
  for (const transition of transitions) {
    const input = buildSyntheticApprovalStateKernelInput({ currentProjection, transition });
    const inputSnapshot = clone(input);
    finalPlan = planApprovalStateTransition(input);
    currentProjection = finalPlan.nextProjection;
    projectedStates.push(currentProjection.state);
    assert.deepEqual(input, inputSnapshot);
  }
  assert.deepEqual(projectedStates, [
    'PROPOSED',
    'AWAITING_PRODUCT_REVIEW',
    'AWAITING_PRIVACY_REVIEW',
    'VERIFIED',
    'ACCEPTED',
  ]);
  assert.equal(finalPlan.schemaVersion, 'approval-state-transition-plan/v1');
  assert.equal(Object.hasOwn(finalPlan, 'eventHistory'), false);
  assert.equal(Object.hasOwn(finalPlan.nextProjection, 'eventHistory'), false);
  assert.equal(Object.hasOwn(finalPlan.nextProjection, 'policySnapshot'), false);
  assert.equal(Object.isFrozen(finalPlan), true);
  assert.equal(Object.isFrozen(finalPlan.nextProjection), true);
});

test('pure state kernel rejects reserved receipt summaries, invalid clocks, and unknown events', () => {
  let privacyProjection = null;
  for (const transition of [
    'AUTHORITIES_ASSIGNED',
    'PROPOSAL_RENDERED',
    'PRODUCT_REVIEW_VERIFIED',
  ]) {
    privacyProjection = planApprovalStateTransition(
      buildSyntheticApprovalStateKernelInput({
        currentProjection: privacyProjection,
        transition,
      }),
    ).nextProjection;
  }

  const reservedReceipt = clone(buildSyntheticApprovalStateKernelInput({
    currentProjection: privacyProjection,
    transition: 'RECEIPT_VERIFIED',
  }));
  reservedReceipt.event.mergeAuthorization.ledgerState = 'RESERVED';
  reservedReceipt.event.mergeAuthorization.consumptionId = null;
  reservedReceipt.event.mergeAuthorization.consumptionRawSha256 = null;
  assert.throws(
    () => planApprovalStateTransition(reservedReceipt),
    /APPROVAL_RECEIPT_REQUIRED/,
  );

  const invalidClock = clone(buildSyntheticApprovalStateKernelInput());
  invalidClock.observedAt = 'not-a-canonical-instant';
  assert.throws(
    () => planApprovalStateTransition(invalidClock),
    /APPROVAL_STATE_EVENT_TIME_INVALID/,
  );

  const futureEvent = clone(buildSyntheticApprovalStateKernelInput());
  futureEvent.event.observedAt = '2026-08-30T08:31:00.000Z';
  assert.throws(
    () => planApprovalStateTransition(futureEvent),
    /APPROVAL_STATE_EVENT_TIME_INVALID/,
  );

  const unknownEvent = clone(buildSyntheticApprovalStateKernelInput());
  unknownEvent.event = {
    type: 'UNKNOWN_CALLER_EVENT',
    observedAt: unknownEvent.observedAt,
  };
  assert.throws(
    () => planApprovalStateTransition(unknownEvent),
    /APPROVAL_STATE_EVENT_UNSUPPORTED/,
  );
});

test('pure state kernel derives Legal projection from decision and actor policy', () => {
  const basePolicy = clone(buildSyntheticApprovalStateKernelInput().policySnapshot);
  const cases = [
    ['ADR-027 distinct actors', basePolicy, 'PENDING'],
    [
      'ADR-027 dual role',
      {
        ...clone(basePolicy),
        actorPolicy: 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER',
        dualRoleExceptionSha256: `sha256:${'f'.repeat(64)}`,
      },
      'NO_BLOCKER_RECORDED',
    ],
    ['ADR-026', { ...clone(basePolicy), decisionId: 'ADR-026' }, 'NO_BLOCKER_RECORDED'],
  ];

  for (const [name, policySnapshot, expectedLegalState] of cases) {
    let currentProjection = null;
    for (const transition of [
      'AUTHORITIES_ASSIGNED',
      'PROPOSAL_RENDERED',
      'PRODUCT_REVIEW_VERIFIED',
      'RECEIPT_VERIFIED',
    ]) {
      currentProjection = planApprovalStateTransition(
        buildSyntheticApprovalStateKernelInput({
          currentProjection,
          policySnapshot,
          transition,
        }),
      ).nextProjection;
    }
    assert.equal(currentProjection.legalState, expectedLegalState, name);
  }
});

test('public source states and pure kernel cover every normative state without mutating receipt facts', async () => {
  const { mergeAuthorization, policy } = await acceptanceEvidence();
  const owner = buildStateFromEvents([], policy, NOW);
  assert.equal(owner.state, 'OWNER_ASSIGNMENT_REQUIRED');
  const proposed = buildStateFromEvents([
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
  ], policy, NOW);
  assert.equal(proposed.state, 'PROPOSED');
  const product = buildStateFromEvents([
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
    { type: 'PROPOSAL_RENDERED', headSha: policy.currentHeadSha, observedAt: '2026-08-30T07:10:00.000Z' },
  ], policy, NOW);
  assert.equal(product.state, 'AWAITING_PRODUCT_REVIEW');
  const privacy = buildStateFromEvents([
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
    { type: 'PROPOSAL_RENDERED', headSha: policy.currentHeadSha, observedAt: '2026-08-30T07:10:00.000Z' },
    { type: 'PRODUCT_REVIEW_VERIFIED', headSha: policy.currentHeadSha, observedAt: '2026-08-30T07:20:00.000Z' },
  ], policy, NOW);
  assert.equal(privacy.state, 'AWAITING_PRIVACY_REVIEW');
  const verified = verifiedState(policy, mergeAuthorization);
  assert.equal(verified.state, 'VERIFIED');
  const stale = buildStateFromEvents([
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
    { type: 'HEAD_CHANGED', headSha: 'ffffffffffffffffffffffffffffffffffffffff', observedAt: '2026-08-30T07:06:00.000Z' },
  ], policy, NOW);
  assert.equal(stale.state, 'STALE_AFTER_PUSH');
  const rejected = buildStateFromEvents([
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
    { type: 'PROPOSAL_RENDERED', headSha: policy.currentHeadSha, observedAt: '2026-08-30T07:10:00.000Z' },
    { type: 'REVIEW_REJECTED', observedAt: '2026-08-30T07:11:00.000Z' },
  ], policy, NOW);
  assert.equal(rejected.state, 'REJECTED');

  const superseded = planApprovalStateTransition(
    buildSyntheticApprovalStateKernelInput({
      currentProjection: projectStateForKernel(verified),
      policySnapshot: policy,
      transition: 'RECEIPT_SUPERSEDED',
    }),
  ).nextProjection;
  const successor = superseded.receipt;
  assert.equal(superseded.receipt.receiptId, successor.receiptId);
  assert.equal(superseded.receiptHistory[0].receiptId, receiptSummary().receiptId);
  assert.equal(superseded.receiptHistory[0].lifecycleState, 'SUPERSEDED');
  assert.equal(superseded.supersessionStatus, 'SUPERSEDED_WITH_CURRENT_SUCCESSOR');
  assert.equal(superseded.state, 'STALE_AFTER_PUSH');
  assert.equal(superseded.evidenceTrustState, 'EXTERNAL_UNVERIFIED');
  assert.deepEqual(superseded.blockingCodes, ['APPROVAL_INDEPENDENCE_NOT_PROVEN']);

  const revoked = appendRevocation(verified, policy, revocationEvent(), REVOCATION_NOW);
  assert.equal(revoked.state, 'REVOKED');

  const driftedReceiptInput = clone(buildSyntheticApprovalStateKernelInput({
    currentProjection: projectStateForKernel(privacy),
    policySnapshot: policy,
    transition: 'RECEIPT_VERIFIED',
  }));
  driftedReceiptInput.event.receipt.receiptRawSha256 = (
    driftedReceiptInput.event.receipt.receiptRawSha256.slice(0, -1)
    + 'g'
  );
  assert.throws(
    () => planApprovalStateTransition(driftedReceiptInput),
    /APPROVAL_RECEIPT_REQUIRED/,
  );
});

test('fresh acceptance revalidation is the only route from VERIFIED to ACCEPTED', async () => {
  const { evidence, mergeAuthorization, policy } = await acceptanceEvidence();
  const state = verifiedState(policy, mergeAuthorization);
  const validation = revalidateApprovalAtAcceptance(state, evidence, NOW);
  assert.equal(validation.valid, true);
  const accepted = appendAcceptance(state, evidence, policy, NOW);
  assert.equal(accepted.state, 'ACCEPTED');
  assert.equal(Object.isFrozen(accepted), true);
  const output = [];
  assert.equal(await runApprovalStatusCli(['--decision', 'ADR-027', '--format', 'json'], {
    loadDecisionState: async () => accepted,
    writeStdout: (value) => output.push(value),
    writeStderr: () => assert.fail('accepted ADR-027 state must render'),
  }), 0);
  assert.equal(JSON.parse(output.join('')).decisionId, 'ADR-027');
  const stale = { ...evidence, readAt: '2026-08-29T08:00:00.000Z' };
  const staleParent = verifiedState(policy, mergeAuthorization);
  assert.throws(
    () => appendAcceptance(staleParent, stale, policy, NOW),
    /APPROVAL_ACCEPTANCE_REVALIDATION_STALE/,
  );
});

test('ADR-027 acceptance preserves Legal PENDING with an unassigned Legal authority', async () => {
  const { evidence, mergeAuthorization, policy } = await acceptanceEvidence();
  const legalAuthority = evidence.task3.authority.roles.find(
    ({ role }) => role === 'LEGAL-REVIEW',
  );
  legalAuthority.status = 'UNASSIGNED';
  evidence.task3.candidate.legal_input.status = 'PENDING';
  evidence.legal.status = 'PENDING';
  evidence.legal.digest = digest(evidence.task3.candidate.legal_input);
  policy.authorityRawSha256 = digest(evidence.task3.authority);
  evidence.authority.rawSha256 = policy.authorityRawSha256;
  refreshAcceptanceTransaction(evidence);

  const verified = verifiedState(policy, mergeAuthorization);
  assert.equal(verified.legalState, 'PENDING');
  const validation = revalidateApprovalAtAcceptance(verified, evidence, NOW);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.issues, []);
  assert.equal(validation.checkedAt, NOW.toISOString());
  assert.match(validation.evidenceSha256, /^sha256:[0-9a-f]{64}$/);
  const accepted = appendAcceptance(verified, evidence, policy, NOW);
  assert.equal(accepted.state, 'ACCEPTED');
  assert.equal(accepted.legalState, 'PENDING');
  assert.equal(approvalStateModule.renderApprovalStatusReadModel(accepted).legalState, 'PENDING');
});

test('dual-role state cross-binding requires current Legal clearance and fails closed on actor-policy or exception-digest drift', async () => {
  const current = await acceptanceEvidence();
  configureDualRoleAcceptance(current.evidence, current.policy);
  const verified = verifiedState(current.policy, current.mergeAuthorization);
  assert.equal(verified.legalState, 'NO_BLOCKER_RECORDED');
  assert.equal(revalidateApprovalAtAcceptance(verified, current.evidence, NOW).valid, true);
  assert.equal(
    appendAcceptance(verified, current.evidence, current.policy, NOW).legalState,
    'NO_BLOCKER_RECORDED',
  );

  const pending = await acceptanceEvidence();
  configureDualRoleAcceptance(pending.evidence, pending.policy);
  pending.evidence.task3.candidate.legal_input.status = 'PENDING';
  pending.evidence.legal.status = 'PENDING';
  pending.policy.legalDigest = digest(pending.evidence.task3.candidate.legal_input);
  pending.evidence.legal.digest = pending.policy.legalDigest;
  refreshAcceptanceTransaction(pending.evidence);
  const pendingValidation = revalidateApprovalAtAcceptance(
    verifiedState(pending.policy, pending.mergeAuthorization),
    pending.evidence,
    NOW,
  );
  assert.equal(pendingValidation.valid, false);
  assert.equal(
    pendingValidation.issues.some(
      ({ stable_code: code }) => code === 'APPROVAL_LEGAL_INPUT_REQUIRED',
    ),
    true,
  );

  const dualStateDistinctTask3 = await acceptanceEvidence();
  dualStateDistinctTask3.policy.actorPolicy = 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER';
  dualStateDistinctTask3.policy.dualRoleExceptionSha256 = digest({ explicit: true });
  const actorModeMismatch = revalidateApprovalAtAcceptance(
    verifiedState(dualStateDistinctTask3.policy, dualStateDistinctTask3.mergeAuthorization),
    dualStateDistinctTask3.evidence,
    NOW,
  );
  assert.equal(actorModeMismatch.valid, false);
  assert.equal(actorModeMismatch.issues.some(
    ({ stable_code: code }) => code === 'APPROVAL_DECISION_SEMANTIC_DIGEST_MISMATCH',
  ), true);

  const distinctStateDualTask3 = await acceptanceEvidence();
  configureDualRoleAcceptance(
    distinctStateDualTask3.evidence,
    distinctStateDualTask3.policy,
    { bindState: false },
  );
  const reverseModeMismatch = revalidateApprovalAtAcceptance(
    verifiedState(distinctStateDualTask3.policy, distinctStateDualTask3.mergeAuthorization),
    distinctStateDualTask3.evidence,
    NOW,
  );
  assert.equal(reverseModeMismatch.valid, false);
  assert.equal(reverseModeMismatch.issues.some(
    ({ stable_code: code }) => code === 'APPROVAL_DECISION_SEMANTIC_DIGEST_MISMATCH',
  ), true);

  const exceptionDigestDrift = await acceptanceEvidence();
  configureDualRoleAcceptance(exceptionDigestDrift.evidence, exceptionDigestDrift.policy);
  const originalExceptionDigest = exceptionDigestDrift.policy.dualRoleExceptionSha256;
  exceptionDigestDrift.policy.dualRoleExceptionSha256 = originalExceptionDigest.slice(0, -1)
    + (originalExceptionDigest.endsWith('0') ? '1' : '0');
  const digestMismatch = revalidateApprovalAtAcceptance(
    verifiedState(exceptionDigestDrift.policy, exceptionDigestDrift.mergeAuthorization),
    exceptionDigestDrift.evidence,
    NOW,
  );
  assert.equal(digestMismatch.valid, false);
  assert.equal(digestMismatch.issues.some(
    ({ stable_code: code }) => code === 'APPROVAL_DECISION_SEMANTIC_DIGEST_MISMATCH',
  ), true);

  const invalidActorPolicy = {
    ...approvalPolicy(),
    actorPolicy: 'DISTINCT_ACTORS_REQUIREC',
  };
  assert.throws(
    () => buildStateFromEvents([], invalidActorPolicy, NOW),
    /APPROVAL_STATE_POLICY_INVALID/,
  );
  assert.throws(
    () => buildStateFromEvents([], {
      ...approvalPolicy(),
      dualRoleExceptionSha256: digest({ forbidden: true }),
    }, NOW),
    /APPROVAL_STATE_POLICY_INVALID/,
  );
  assert.throws(
    () => buildStateFromEvents([], {
      ...approvalPolicy(),
      actorPolicy: 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER',
      dualRoleExceptionSha256: null,
    }, NOW),
    /APPROVAL_STATE_POLICY_INVALID/,
  );
});

test('reviewer C1 counterexample cannot promote caller-declared receipt or validation booleans', async () => {
  const policy = approvalPolicy();
  const events = [
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
    { type: 'PROPOSAL_RENDERED', headSha: policy.currentHeadSha, observedAt: '2026-08-30T07:10:00.000Z' },
    { type: 'PRODUCT_REVIEW_VERIFIED', headSha: policy.currentHeadSha, observedAt: '2026-08-30T07:20:00.000Z' },
    {
      type: 'RECEIPT_VERIFIED', headSha: policy.currentHeadSha,
      receipt: { ...receiptSummary(), trustState: 'CALLER_DECLARED' },
      mergeAuthorization: null, observedAt: '1970-01-01T00:00:00.000Z',
    },
    {
      type: 'ACCEPTANCE_REVALIDATED',
      validation: { valid: true, issues: [] },
      observedAt: '1970-01-01T00:00:00.000Z',
    },
  ];
  let callerAccepted;
  try {
    callerAccepted = reduceApprovalDecisionState(events, policy, NOW).state === 'ACCEPTED';
  } catch {
    callerAccepted = false;
  }
  const { evidence, mergeAuthorization } = await acceptanceEvidence();
  const state = verifiedState(policy, mergeAuthorization);
  const clonedResult = clone(revalidateApprovalAtAcceptance(state, evidence, NOW));
  assert.equal(clonedResult.valid, true);
  let clonedAccepted;
  try {
    clonedAccepted = reduceApprovalDecisionState([
      ...state.eventHistory,
      { type: 'ACCEPTANCE_REVALIDATED', validation: clonedResult, observedAt: evidence.readAt },
    ], policy, new Date('2026-08-30T10:31:00.000Z')).state === 'ACCEPTED';
  } catch {
    clonedAccepted = false;
  }
  assert.equal(callerAccepted, false);
  assert.equal(clonedAccepted, false);
});

test('round2 I3 current-main readback stays closed and semantically bound after outer digest refresh', async () => {
  const { evidence, mergeAuthorization, policy } = await acceptanceEvidence();
  const failures = [];
  const cases = [
    ['missing verifier', (v) => { delete v.mergeAuthorization.currentMainReadback.independentVerifier; }],
    ['unknown readback key', (v) => { v.mergeAuthorization.currentMainReadback.extra = true; }],
    ['pre-read digest mismatch', (v) => { v.mergeAuthorization.currentMainReadback.preReadbackSha256 = policy.legalDigest; }],
    ['post-read digest mismatch', (v) => { v.mergeAuthorization.currentMainReadback.postReadbackSha256 = policy.legalDigest; }],
    ['Task3 verifier mismatch', (v) => { v.mergeAuthorization.currentMainReadback.independentVerifier.runId += 1; }],
  ];
  for (const [name, mutate] of cases) {
    const value = clone(evidence); mutate(value); refreshAcceptanceTransaction(value);
    if (revalidateApprovalAtAcceptance(verifiedState(policy, mergeAuthorization), value, NOW).valid) failures.push(name);
  }

  const mismatch = clone(evidence);
  mismatch.mergeAuthorization.consumption.independent_verifier.identity = 'github-app:unrelated-valid-verifier';
  const consumptionRawSha256 = digest(mismatch.mergeAuthorization.consumption);
  mismatch.mergeAuthorization.consumptionRawSha256 = consumptionRawSha256;
  const ledgerEvent = mismatch.mergeAuthorization.ledgerSnapshot.events.find(({ type }) => type === 'CONSUMPTION_RECORDED');
  ledgerEvent.consumption = clone(mismatch.mergeAuthorization.consumption);
  ledgerEvent.consumptionRawSha256 = consumptionRawSha256;
  refreshAcceptanceTransaction(mismatch);
  const mismatchSummary = { ...mergeAuthorization, consumptionRawSha256 };
  const mismatchState = verifiedState(policy, mismatchSummary);
  const validation = revalidateApprovalAtAcceptance(mismatchState, mismatch, NOW);
  let reducerAccepted;
  try {
    reducerAccepted = appendAcceptance(mismatchState, mismatch, policy, NOW).state === 'ACCEPTED';
  } catch {
    reducerAccepted = false;
  }
  assert.deepEqual({ failures, verifierMismatchValid: validation.valid, reducerAccepted }, {
    failures: [], verifierMismatchValid: false, reducerAccepted: false,
  });
});

test('round2 I6 pure lifecycle projects revocation while synthetic histories remain unadmitted', async () => {
  const { evidence, mergeAuthorization, policy } = await acceptanceEvidence();
  const verified = verifiedState(policy, mergeAuthorization);
  const accepted = appendAcceptance(verified, evidence, policy, NOW);
  const acceptanceEvent = accepted.eventHistory.find(({ type }) => type === 'ACCEPTANCE_REVALIDATED');
  const replay = (history) => {
    try {
      const state = reduceApprovalDecisionState(history, policy, REVOCATION_NOW);
      return state.blockingCodes.includes('APPROVAL_STATE_HISTORY_NOT_ADMITTED')
        ? 'HOLD'
        : state.state;
    } catch {
      return 'THREW';
    }
  };
  const revoked = appendRevocation(accepted, policy, revocationEvent(), REVOCATION_NOW);
  const variants = ['evidence', 'digest', 'oversize', 'freeform', 'nonce'].map((kind) => {
    const history = clone(accepted.eventHistory);
    const event = history.find(({ type }) => type === 'ACCEPTANCE_REVALIDATED');
    if (!event.evidence) return 'MISSING_EVIDENCE';
    if (kind === 'evidence') event.evidence.readAt = '2026-08-30T08:28:00.000Z';
    if (kind === 'digest') event.evidenceSha256 = policy.legalDigest;
    if (kind === 'oversize') { event.evidence.task3.candidate.decision.proposed_sidecar_path = 'x'.repeat(300_000); event.evidenceSha256 = digest(event.evidence); }
    if (kind === 'freeform') event.freeform = 'forbidden';
    if (kind === 'nonce') event.singleUseNonce = 'nonce-program-c-forbidden-history';
    return replay(history);
  });
  const stdout = [];
  const stderr = [];
  const statusCode = await runApprovalStatusCli(['--decision', 'ADR-027', '--format', 'json'], {
    loadDecisionState: async () => accepted,
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
  });
  assert.equal(statusCode, 0, stderr.join(''));
  assert.deepEqual({
    acceptanceKeys: Object.keys(acceptanceEvent).sort(),
    revokedState: revoked.state,
    replay: replay(revoked.eventHistory),
    variants,
    projectedDigest: JSON.parse(stdout.join('')).acceptanceEvidenceSha256,
  }, {
    acceptanceKeys: ['checkedAt', 'evidence', 'evidenceSha256', 'observedAt', 'type'],
    revokedState: 'REVOKED',
    replay: 'HOLD',
    variants: ['HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD'],
    projectedDigest: acceptanceEvent.evidenceSha256,
  });
});

test('round3 pure historical acceptance stays closed while synthetic public histories remain unadmitted', async () => {
  const { evidence, mergeAuthorization, policy } = await acceptanceEvidence();
  const verified = verifiedState(policy, mergeAuthorization);
  const accepted = appendAcceptance(verified, evidence, policy, NOW);
  const later = new Date('2026-08-31T12:00:00.000Z');
  const outcome = (events, reducerNow = later) => {
    try {
      return reduceApprovalDecisionState(events, policy, reducerNow).state;
    } catch (error) {
      return `THREW:${error.message}`;
    }
  };
  let future = 'UNSAFE_ACCEPT';
  try {
    approvalStateModule.appendApprovalDecisionEvent(accepted, {
      schemaVersion: 'approval-event-append/v1',
      expectedHistorySha256: digest(accepted.eventHistory),
      appendedAt: '2026-09-01T00:00:00.000Z',
      event: revocationEvent({ observedAt: '2026-09-01T00:00:00.000Z' }),
    }, policy, later);
  } catch (error) {
    future = `THREW:${error.message}`;
  }
  const revokedState = appendRevocation(accepted, policy, revocationEvent(), REVOCATION_NOW);
  const revoked = revokedState.state;
  const nonmonotonic = clone(accepted.eventHistory);
  nonmonotonic[1].observedAt = '2026-08-30T06:00:00.000Z';
  const duplicate = [...accepted.eventHistory, clone(accepted.eventHistory.at(-1))];
  const insertedOld = [
    ...accepted.eventHistory,
    { type: 'RECEIPT_REVOKED', observedAt: '2026-08-30T08:00:00.000Z' },
  ];
  let backdatedAppend = 'UNSAFE_ACCEPT';
  const backdatedParent = verifiedState(policy, mergeAuthorization);
  try {
    appendAcceptance(backdatedParent, evidence, policy, later);
  } catch (error) {
    backdatedAppend = `THREW:${error.message}`;
  }
  assert.deepEqual({
    revoked,
    future,
    nonmonotonic: outcome(nonmonotonic),
    duplicate: outcome(duplicate),
    insertedOld: outcome(insertedOld),
    backdatedAppend,
  }, {
    revoked: 'REVOKED',
    future: 'THREW:APPROVAL_STATE_APPEND_INVALID',
    nonmonotonic: 'OWNER_ASSIGNMENT_REQUIRED',
    duplicate: 'OWNER_ASSIGNMENT_REQUIRED',
    insertedOld: 'OWNER_ASSIGNMENT_REQUIRED',
    backdatedAppend: 'THREW:APPROVAL_ACCEPTANCE_REVALIDATION_STALE',
  });
});

test('round3 cyclic acceptance evidence returns stable approval denial without native recursion failure', async () => {
  const { evidence, mergeAuthorization, policy } = await acceptanceEvidence();
  const cyclic = clone(evidence);
  cyclic.task3.candidate.policy = cyclic.task3.candidate;
  const verified = verifiedState(policy, mergeAuthorization);
  const capture = (operation) => {
    try {
      const value = operation();
      return value?.valid === false && value.issues.every(({ stable_code: code }) => code.startsWith('APPROVAL_'))
        ? 'APPROVAL_DENIAL'
        : 'UNSAFE_ACCEPT';
    } catch (error) {
      return error.message?.startsWith('APPROVAL_') ? 'APPROVAL_DENIAL' : error.name;
    }
  };
  assert.deepEqual({
    direct: capture(() => revalidateApprovalAtAcceptance(verified, cyclic, NOW)),
    append: capture(() => appendAcceptance(verified, cyclic, policy, NOW)),
  }, { direct: 'APPROVAL_DENIAL', append: 'APPROVAL_DENIAL' });
});

test('acceptance revalidation mutation matrix fails closed on every fresh-read requirement', async () => {
  const { evidence, mergeAuthorization, policy } = await acceptanceEvidence();
  const state = verifiedState(policy, mergeAuthorization);
  const cases = [
    ['stale review', (v) => { v.reviews[0].submittedAt = '2026-08-29T08:00:00.000Z'; }, 'APPROVAL_REVIEW_STALE'],
    ['authority reassigned', (v) => { v.authority.reassigned = true; }, 'APPROVAL_ROLE_AUTHORITY_STALE'],
    ['authority revoked', (v) => { v.authority.revocationStatus = 'REVOKED'; }, 'APPROVAL_ROLE_AUTHORITY_STALE'],
    ['optional legal transaction drift', (v) => { v.legal.validUntil = '2026-08-30T08:00:00.000Z'; }, 'APPROVAL_TOCTOU_DETECTED'],
    ['free-form legal content', (v) => { v.legal.content = 'must never enter the acceptance boundary'; }, 'APPROVAL_ACCEPTANCE_FORBIDDEN_CONTENT'],
    ['ruleset drift', (v) => { v.ruleset.normalizedSha256 = 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; }, 'APPROVAL_RULESET_DRIFT'],
    ['ruleset bypass', (v) => { v.ruleset.bypassActors = [{ actorId: 1 }]; }, 'APPROVAL_RULESET_BYPASS_PRESENT'],
    ['diff outside allowlist', (v) => { v.acceptanceDiff.files.push({ path: 'apps/api/src/forbidden.ts', sha256: policy.decisionRawSha256 }); }, 'APPROVAL_ACCEPTANCE_DIFF_OUTSIDE_ALLOWLIST'],
    ['sidecar byte changed', (v) => { v.proposalMain.approvedSidecarRawSha256 = policy.decisionRawSha256; }, 'APPROVAL_ACCEPTANCE_SIDECAR_MISMATCH'],
    ['receipt replay', (v) => { v.receipt.priorReceiptIds.push(v.receipt.receiptId); }, 'APPROVAL_RECEIPT_REPLAYED'],
    ['receipt revoked', (v) => { v.receipt.revoked = true; }, 'APPROVAL_POLICY_REVOKED'],
    ['receipt superseded', (v) => { v.receipt.superseded = true; }, 'APPROVAL_RECEIPT_SUPERSEDED'],
    ['pre post TOCTOU', (v) => { v.postAcceptanceRead.currentPullRequest.headSha = 'ffffffffffffffffffffffffffffffffffffffff'; }, 'APPROVAL_TOCTOU_DETECTED'],
    ['machine dynamic association', (v) => { v.machineChecks[0].runHeadAssociated = false; }, 'APPROVAL_CHECK_DYNAMIC_ASSOCIATION_MISMATCH'],
    ['machine static identity', (v) => { v.machineChecks[0].appId += 1; }, 'APPROVAL_CHECK_IDENTITY_MISMATCH'],
    ['proposal result absent from main', (v) => { v.proposalMain.resultReachableFromCurrentMain = false; }, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED'],
    ['acceptance result absent from main', (v) => { v.mergeAuthorization.currentMainReadback.resultReachableFromCurrentMain = false; }, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED'],
    ['decision bytes changed', (v) => { v.proposalMain.approvedDecisionRawSha256 = policy.sidecarRawSha256; }, 'APPROVAL_DECISION_SEMANTIC_DIGEST_MISMATCH'],
    ['receipt expired', (v) => { v.receipt.validUntil = '2026-08-30T08:00:00.000Z'; }, 'APPROVAL_RECEIPT_EXPIRED'],
    ['review evidence reused', (v) => { v.reviews[1].reviewId = v.reviews[0].reviewId; }, 'APPROVAL_EVIDENCE_SLOT_REUSE'],
    ['acceptance readback stale', (v) => { v.readAt = '2026-08-29T08:00:00.000Z'; }, 'APPROVAL_ACCEPTANCE_REVALIDATION_STALE'],
    ['grant absent', (v) => { v.mergeAuthorization = null; }, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_REQUIRED'],
    ['consumption absent', (v) => { v.mergeAuthorization.consumption = null; }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED'],
    ['consumption digest changed', (v) => { v.mergeAuthorization.consumptionRawSha256 = policy.decisionRawSha256; }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH'],
    ['ledger key stage-qualified', (v) => { v.mergeAuthorization.ledgerSnapshot.key.stage = 'ACCEPTANCE_MERGE'; }, 'APPROVAL_MERGE_AUTHORIZATION_NONCE_KEY_INVALID'],
    ['ledger reservation binding changed', (v) => { v.mergeAuthorization.ledgerSnapshot.events[0].stage = 'PROPOSAL_MERGE'; }, 'APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT'],
    ['ledger reservation head changed', (v) => { v.mergeAuthorization.ledgerSnapshot.events[0].headSha = 'e'.repeat(40); }, 'APPROVAL_LEDGER_STREAM_INVALID'],
    ['ledger reservation base changed', (v) => { v.mergeAuthorization.ledgerSnapshot.events[0].baseSha = 'e'.repeat(40); }, 'APPROVAL_LEDGER_STREAM_INVALID'],
    ['ledger reservation method changed', (v) => { v.mergeAuthorization.ledgerSnapshot.events[0].mergeMethod = 'MERGE'; }, 'APPROVAL_LEDGER_STREAM_INVALID'],
    ['ledger nested consumption changed', (v) => { v.mergeAuthorization.ledgerSnapshot.events[3].consumption.result_commit_sha = 'e'.repeat(40); }, 'APPROVAL_LEDGER_STREAM_INVALID'],
    ['ledger revision duplicated', (v) => { v.mergeAuthorization.ledgerSnapshot.events[2].ledgerRevision = 2; }, 'APPROVAL_LEDGER_STREAM_INVALID'],
    ['ledger revision gap', (v) => { v.mergeAuthorization.ledgerSnapshot.events[2].ledgerRevision = 7; }, 'APPROVAL_LEDGER_STREAM_INVALID'],
    ['ledger events reordered', (v) => { [v.mergeAuthorization.ledgerSnapshot.events[2], v.mergeAuthorization.ledgerSnapshot.events[3]] = [v.mergeAuthorization.ledgerSnapshot.events[3], v.mergeAuthorization.ledgerSnapshot.events[2]]; }, 'APPROVAL_LEDGER_STREAM_INVALID'],
    ['ledger ACK backdated', (v) => { v.mergeAuthorization.ledgerSnapshot.events[1].observedAt = '2026-08-30T08:09:00.000Z'; }, 'APPROVAL_LEDGER_STREAM_INVALID'],
    ['ledger result backdated', (v) => { v.mergeAuthorization.ledgerSnapshot.events[2].observedAt = '2026-08-30T08:09:00.000Z'; }, 'APPROVAL_LEDGER_STREAM_INVALID'],
    ['ledger consumption backdated', (v) => { v.mergeAuthorization.ledgerSnapshot.events[3].consumption.consumed_at = '2026-08-30T08:09:00.000Z'; v.mergeAuthorization.ledgerSnapshot.events[3].consumptionRawSha256 = digest(v.mergeAuthorization.ledgerSnapshot.events[3].consumption); }, 'APPROVAL_LEDGER_STREAM_INVALID'],
    ['ledger committed revision drift', (v) => { v.mergeAuthorization.ledgerSnapshot.committedRevision = 99; }, 'APPROVAL_LEDGER_STREAM_INVALID'],
    ['ledger oversized', (v) => { for (let revision = 5; revision <= 65; revision += 1) v.mergeAuthorization.ledgerSnapshot.events.push({ type: 'BOUNDED_HOLD', reasonCode: 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED', observedAt: v.readAt, ledgerRevision: revision }); v.mergeAuthorization.ledgerSnapshot.committedRevision = 65; }, 'APPROVAL_LEDGER_STREAM_INVALID'],
    ['ledger consumption absent', (v) => { v.mergeAuthorization.ledgerSnapshot.events.pop(); }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED'],
    ['extra review slot', (v) => { v.reviews.push({ ...clone(v.reviews[0]), slot: 'OTHER', reviewId: 99991 }); }, 'APPROVAL_ACCEPTANCE_EVIDENCE_SHAPE_INVALID'],
    ['extra machine check', (v) => { v.machineChecks.push({ ...clone(v.machineChecks[0]), context: 'other', checkRunId: 99992, checkSuiteId: 99993, workflowRunId: 99994 }); }, 'APPROVAL_ACCEPTANCE_EVIDENCE_SHAPE_INVALID'],
    ['caller-declared task3 validation', (v) => { v.task3.candidate.decision.raw_sha256 = policy.sidecarRawSha256; }, 'APPROVAL_DECISION_SEMANTIC_DIGEST_MISMATCH'],
    ['synthetic lifecycle result', (v) => { v.task3.candidate.receipt_subject.superseded_receipt_ids.push(v.receipt.receiptId); }, 'APPROVAL_RECEIPT_REPLAYED'],
  ];
  const failures = [];
  for (const [name, mutate, code] of cases) {
    const value = clone(evidence);
    mutate(value);
    const result = revalidateApprovalAtAcceptance(state, value, NOW);
    if (result.valid || !result.issues.some((entry) => entry.stable_code === code)) {
      failures.push({ name, code, result });
    }
  }
  assert.deepEqual(failures, []);
});

test('concurrent nonce reservation has one fresh winner and key excludes stage', async () => {
  const grant = await readJson('valid-grant.json');
  const ledger = new SharedDurableCasLedgerHarness();
  const firstRequest = requestFor(grant, { requestId: 'merge-request-task4-concurrent-1', reservationId: 'merge-reservation-task4-concurrent-1' });
  const secondRequest = requestFor(grant, { requestId: 'merge-request-task4-concurrent-2', reservationId: 'merge-reservation-task4-concurrent-2' });
  const results = await Promise.allSettled([
    reserve(ledger, grant, firstRequest),
    reserve(ledger, grant, secondRequest),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  const loser = results.find(({ status }) => status === 'rejected');
  assert.match(loser.reason.message, /APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT/);
  assert.deepEqual(ledger.casCalls[0].key, {
    repositoryId: grant.repository.id,
    singleUseNonce: grant.single_use_nonce,
  });
  assert.equal(Object.hasOwn(ledger.casCalls[0].key, 'stage'), false);
});

test('identical retry is readback-only and a successful reservation dispatches at most once', async () => {
  const grant = await readJson('valid-grant.json');
  const ledger = new SharedDurableCasLedgerHarness();
  const originalGrantBytes = JSON.stringify(grant);
  const fresh = await reserve(ledger, grant);
  assert.equal(fresh.outcome, 'RESERVED');
  let physicalRequests = 0;
  const mergeRequester = {
    async requestMerge() {
      physicalRequests += 1;
      assert.deepEqual(ledger.snapshot()[0].events.map(({ type }) => type), ['NONCE_RESERVED', 'MERGE_ACK_UNKNOWN']);
      return { acknowledgement: 'ACKNOWLEDGED' };
    },
  };
  assert.equal((await executeReservedMerge(fresh.reservation, mergeRequester, ledger, DISPATCH_NOW)).outcome, 'ACKNOWLEDGED');
  assert.equal((await executeReservedMerge(fresh.reservation, mergeRequester, ledger, DISPATCH_NOW)).outcome, 'HOLD');
  const retry = await reserve(ledger, grant);
  assert.equal(retry.outcome, 'IDEMPOTENT_EXISTING');
  assert.equal((await executeReservedMerge(retry.reservation, mergeRequester, ledger, DISPATCH_NOW)).outcome, 'HOLD');
  assert.equal(physicalRequests, 1);
  assert.equal(JSON.stringify(grant), originalGrantBytes);
  assert.equal(digest(grant), fresh.reservation.grantRawSha256);
});

test('same nonce with any different immutable binding is replayed without merge', async () => {
  const grant = await readJson('valid-grant.json');
  const mutations = [
    (value) => { value.stage = 'PROPOSAL_MERGE'; },
    (value) => { value.pr_number += 1; },
    (value) => { value.head_sha = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; },
    (value) => { value.allowed_merge_method = 'MERGE'; },
    (value) => { value.grant_id = 'program-c-grant-task4-replayed'; },
  ];
  for (const mutate of mutations) {
    const ledger = new SharedDurableCasLedgerHarness();
    await reserve(ledger, grant);
    const changed = clone(grant);
    mutate(changed);
    await assert.rejects(
      reserve(ledger, changed, requestFor(changed)),
      /APPROVAL_MERGE_AUTHORIZATION_REPLAYED/,
    );
  }
});

test('response loss before or after provider ACK becomes durable ACK_UNKNOWN and never retries merge', async () => {
  const grant = await readJson('valid-grant.json');
  for (const providerAckReceived of [false, true]) {
    const ledger = new SharedDurableCasLedgerHarness();
    const fresh = await reserve(ledger, grant);
    let physicalRequests = 0;
    const mergeRequester = {
      async requestMerge() {
        physicalRequests += 1;
        const error = new Error('bounded response loss');
        error.providerAckReceived = providerAckReceived;
        throw error;
      },
    };
    const result = await executeReservedMerge(fresh.reservation, mergeRequester, ledger, DISPATCH_NOW);
    assert.deepEqual(result, { outcome: 'ACK_UNKNOWN', blockingCode: 'APPROVAL_MERGE_ACK_UNKNOWN' });
    assert.equal((await executeReservedMerge(fresh.reservation, mergeRequester, ledger, DISPATCH_NOW)).outcome, 'HOLD');
    assert.equal(physicalRequests, 1);
  }
});

test('ACK_UNKNOWN requires admitted current-main readback before durable result or consumption', async () => {
  const grant = await readJson('valid-grant.json');
  const readback = await readJson('current-main-readback.json');
  const ledger = new SharedDurableCasLedgerHarness();
  const fresh = await reserve(ledger, grant);
  await executeReservedMerge(fresh.reservation, { requestMerge: async () => { throw new Error('timeout'); } }, ledger, DISPATCH_NOW);
  const result = await reconcileMergeAuthorizationReservation(fresh.reservation, readback, ledger, NOW);
  assert.equal(result.outcome, 'HOLD');
  assert.equal(result.blockingCode, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED');
  assert.equal(result.consumption, null);
  assert.equal(result.consumptionRawSha256, null);
  const retried = await reconcileMergeAuthorizationReservation(fresh.reservation, readback, ledger, NOW);
  assert.deepEqual(retried, result);
  assert.equal(retried.committedLedgerRevision, result.committedLedgerRevision);
  const stream = ledger.snapshot()[0];
  assert.equal(stream.events.some(({ type }) => type === 'MERGE_RESULT_OBSERVED'), false);
  assert.equal(stream.events.some(({ type }) => type === 'CONSUMPTION_RECORDED'), false);
  assert.equal(stream.events.filter(({ type }) => type === 'BOUNDED_HOLD').length, 1);
});

test('missing, process-memory-only, workflow-artifact-only, and non-CAS ledgers fail before merge', async () => {
  const grant = await readJson('valid-grant.json');
  const invalid = [
    null,
    { durabilityClass: 'PROCESS_MEMORY', read: async () => null, compareAndSwap: async () => ({ outcome: 'COMMITTED', committedRevision: 1 }) },
    { durabilityClass: 'WORKFLOW_ARTIFACT', read: async () => null, compareAndSwap: async () => ({ outcome: 'COMMITTED', committedRevision: 1 }) },
    { durabilityClass: 'SHARED_DURABLE', read: async () => null, compareAndSwap: async () => ({ outcome: 'COMMITTED', committedRevision: 1 }) },
  ];
  for (const ledger of invalid) {
    await assert.rejects(reserve(ledger, grant), /APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED/);
  }
  const throwing = {
    durabilityClass: 'SHARED_DURABLE_CAS',
    read: async () => { throw new Error('do-not-reflect-ledger-detail'); },
    compareAndSwap: async () => { throw new Error('do-not-reflect-ledger-detail'); },
  };
  await assert.rejects(reserve(throwing, grant), /APPROVAL_MERGE_AUTHORIZATION_LEDGER_REQUIRED/);
});

test('reducer holds unadmitted histories and acceptance rejects malformed boundaries', async () => {
  const policy = approvalPolicy();
  assert.throws(() => reduceApprovalDecisionState(null, policy, NOW), /APPROVAL_STATE_INPUT_INVALID/);
  const hold = reduceApprovalDecisionState([
    { type: 'PROPOSAL_RENDERED', headSha: policy.currentHeadSha },
  ], policy, NOW);
  assert.equal(hold.state, 'OWNER_ASSIGNMENT_REQUIRED');
  assert.equal(hold.evidenceTrustState, 'EXTERNAL_UNVERIFIED');
  assert.deepEqual(hold.blockingCodes, ['APPROVAL_STATE_HISTORY_NOT_ADMITTED']);
  const result = revalidateApprovalAtAcceptance({ state: 'ACCEPTED' }, null, NOW);
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].stable_code, 'APPROVAL_ACCEPTANCE_REVALIDATION_REQUIRED');
});
