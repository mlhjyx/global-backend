import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  executeReservedMerge,
  reconcileMergeAuthorizationReservation,
  reduceApprovalDecisionState,
  renderApprovalStatusReadModel,
  reserveMergeAuthorizationNonce,
  revalidateApprovalAtAcceptance,
} from './governance-approval-state.mjs';

const NOW = new Date('2026-08-30T08:30:00.000Z');
const ROOT = new URL('./fixtures/approval-readback/merge-authorization/', import.meta.url);
const clone = (value) => structuredClone(value);
const readJson = async (name) => JSON.parse(await readFile(new URL(name, ROOT), 'utf8'));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

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
  reserveMergeAuthorizationNonce(grant, digest(grant), request, expectedRevision, ledger, NOW)
);

const approvalPolicy = () => ({
  repository: { id: 1291151138, fullName: 'mlhjyx/global-backend' },
  decisionId: 'ADR-042',
  decisionRevision: 'program-c/decision-r1',
  policyRevision: 'program-c/policy-r1',
  currentBaseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  currentHeadSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  decisionRawSha256: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  decisionSemanticSha256: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  sidecarRawSha256: 'sha256:8888888888888888888888888888888888888888888888888888888888888888',
  authorityRevision: 'approval-authorities/r1',
  authoritySha256: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
  authorityRawSha256: 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
  authorityEffectiveFrom: '2026-08-30T07:00:00.000Z',
  authorityEffectiveUntil: '2026-08-30T10:00:00.000Z',
  legalScope: 'PROGRAM_C_SUPPRESSION',
  legalDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  liveRulesetSha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  acceptanceAllowlist: [
    { path: 'docs/adr/027-program-c-suppression.md', sha256: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' },
    { path: 'docs/adr/registry.md', sha256: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' },
  ],
  requiredReviews: [
    ['PRODUCT', 'sha256:1010101010101010101010101010101010101010101010101010101010101010'],
    ['PRIVACY', 'sha256:2020202020202020202020202020202020202020202020202020202020202020'],
    ['CODEOWNER', 'sha256:3030303030303030303030303030303030303030303030303030303030303030'],
    ['QA', 'sha256:4040404040404040404040404040404040404040404040404040404040404040'],
    ['SECURITY', 'sha256:5050505050505050505050505050505050505050505050505050505050505050'],
  ].map(([slot, commandDigest]) => ({ slot, commandDigest })),
  requiredMachineChecks: [{
    context: 'approval-readback', appId: 42700,
    workflowPath: '.github/workflows/approval-readback.yml',
    workflowSha: 'dddddddddddddddddddddddddddddddddddddddd',
    baseBlobSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', signerIdentity: 'github-app:427',
  }],
  freshnessMs: 3_600_000,
});

const receiptSummary = () => ({
  receiptId: 'approval-receipt-task4-0001',
  receiptCoreSha256: 'sha256:abababababababababababababababababababababababababababababababab',
  receiptRawSha256: 'sha256:bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc',
  trustState: 'INDEPENDENT_EXTERNAL_VERIFIED',
  validUntil: '2026-08-30T10:00:00.000Z',
});

const verifiedState = (policy, merge) => reduceApprovalDecisionState([
  { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
  { type: 'PROPOSAL_RENDERED', headSha: policy.currentHeadSha, observedAt: '2026-08-30T07:10:00.000Z' },
  { type: 'PRODUCT_REVIEW_VERIFIED', headSha: policy.currentHeadSha, observedAt: '2026-08-30T07:20:00.000Z' },
  {
    type: 'RECEIPT_VERIFIED', headSha: policy.currentHeadSha,
    receipt: receiptSummary(), mergeAuthorization: merge,
    observedAt: '2026-08-30T08:25:00.000Z',
  },
], policy, NOW);

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

const acceptanceEvidence = async () => {
  const policy = approvalPolicy();
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
  const snapshot = {
    headSha: policy.currentHeadSha, baseSha: policy.currentBaseSha,
    decisionRawSha256: policy.decisionRawSha256, sidecarRawSha256: policy.sidecarRawSha256,
    authoritySha256: policy.authoritySha256, authorityRawSha256: policy.authorityRawSha256,
    legalDigest: policy.legalDigest, rulesetDigest: policy.liveRulesetSha256,
  };
  const evidence = {
    readAt: '2026-08-30T08:29:00.000Z',
    preRead: clone(snapshot), postRead: clone(snapshot),
    currentPullRequest: {
      number: grant.pr_number, state: 'MERGED', baseSha: grant.base_sha, headSha: grant.head_sha,
    },
    acceptanceDiff: { complete: true, files: clone(policy.acceptanceAllowlist) },
    reviews: policy.requiredReviews.map((required, index) => ({
      slot: required.slot, reviewId: 9000 + index, actorId: 8000 + index,
      state: 'APPROVED', headSha: policy.currentHeadSha,
      submittedAt: `2026-08-30T08:0${index}:00.000Z`, commandDigest: required.commandDigest,
      validation: { valid: true, issues: [], externalCompletenessObserved: true },
    })),
    authority: {
      revision: policy.authorityRevision, sha256: policy.authoritySha256,
      rawSha256: policy.authorityRawSha256, effectiveFrom: policy.authorityEffectiveFrom,
      effectiveUntil: policy.authorityEffectiveUntil, assignmentsCurrent: true,
      revocationStatus: 'ACTIVE', reassigned: false,
      validation: { valid: true, issues: [], externalCompletenessObserved: true },
    },
    legal: {
      status: 'NO_BLOCKER_RECORDED', scope: policy.legalScope, digest: policy.legalDigest,
      validFrom: '2026-08-30T07:00:00.000Z', validUntil: '2026-08-30T10:00:00.000Z',
      revocationStatus: 'ACTIVE', validation: { valid: true, issues: [], externalCompletenessObserved: true },
    },
    ruleset: { normalizedSha256: policy.liveRulesetSha256, bypassActors: [], observedAt: '2026-08-30T08:28:00.000Z' },
    machineChecks: policy.requiredMachineChecks.map((required) => ({
      ...clone(required), checkRunId: 7001, checkSuiteId: 7002, workflowRunId: 7003,
      headSha: policy.currentHeadSha, status: 'COMPLETED', conclusion: 'SUCCESS',
      checkRunSuiteAssociated: true, suiteRunAssociated: true, runHeadAssociated: true,
    })),
    receipt: {
      ...receiptSummary(), priorReceiptIds: [], revoked: false, superseded: false,
      lifecycleValidation: {
        valid: true, issues: [], trustEligible: true,
        externalCompletenessCapability: 'INDEPENDENT_EXTERNAL_READBACK',
      },
    },
    proposalMain: {
      proposalResultCommitSha: readback.resultCommitSha,
      currentMainSha: readback.currentMain.sha, resultReachableFromCurrentMain: true,
      approvedDecisionRawSha256: policy.decisionRawSha256,
      approvedDecisionSemanticSha256: policy.decisionSemanticSha256,
      approvedSidecarRawSha256: policy.sidecarRawSha256,
    },
    mergeAuthorization: {
      grant, grantRawSha256, consumption, consumptionRawSha256,
      validation: { valid: true, issues: [], externalCompletenessObserved: true },
      ledgerSnapshot,
    },
  };
  return { evidence, grant, mergeAuthorization, policy, readback };
};

test('reducer exhaustively moves through every normative state without mutating prior receipt facts', async () => {
  const { mergeAuthorization, policy } = await acceptanceEvidence();
  const owner = reduceApprovalDecisionState([], policy, NOW);
  assert.equal(owner.state, 'OWNER_ASSIGNMENT_REQUIRED');
  const proposed = reduceApprovalDecisionState([
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
  ], policy, NOW);
  assert.equal(proposed.state, 'PROPOSED');
  const product = reduceApprovalDecisionState([
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
    { type: 'PROPOSAL_RENDERED', headSha: policy.currentHeadSha, observedAt: '2026-08-30T07:10:00.000Z' },
  ], policy, NOW);
  assert.equal(product.state, 'AWAITING_PRODUCT_REVIEW');
  const privacy = reduceApprovalDecisionState([
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
    { type: 'PROPOSAL_RENDERED', headSha: policy.currentHeadSha, observedAt: '2026-08-30T07:10:00.000Z' },
    { type: 'PRODUCT_REVIEW_VERIFIED', headSha: policy.currentHeadSha, observedAt: '2026-08-30T07:20:00.000Z' },
  ], policy, NOW);
  assert.equal(privacy.state, 'AWAITING_PRIVACY_REVIEW');
  const verified = verifiedState(policy, mergeAuthorization);
  assert.equal(verified.state, 'VERIFIED');
  const stale = reduceApprovalDecisionState([
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
    { type: 'HEAD_CHANGED', headSha: 'ffffffffffffffffffffffffffffffffffffffff', observedAt: '2026-08-30T07:06:00.000Z' },
  ], policy, NOW);
  assert.equal(stale.state, 'STALE_AFTER_PUSH');
  const rejected = reduceApprovalDecisionState([
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
    { type: 'PROPOSAL_RENDERED', headSha: policy.currentHeadSha, observedAt: '2026-08-30T07:10:00.000Z' },
    { type: 'REVIEW_REJECTED', observedAt: '2026-08-30T07:11:00.000Z' },
  ], policy, NOW);
  assert.equal(rejected.state, 'REJECTED');

  const successor = { ...receiptSummary(), receiptId: 'approval-receipt-task4-0002' };
  const superseded = reduceApprovalDecisionState([
    { type: 'AUTHORITIES_ASSIGNED', observedAt: '2026-08-30T07:05:00.000Z' },
    { type: 'PROPOSAL_RENDERED', headSha: policy.currentHeadSha, observedAt: '2026-08-30T07:10:00.000Z' },
    { type: 'PRODUCT_REVIEW_VERIFIED', headSha: policy.currentHeadSha, observedAt: '2026-08-30T07:20:00.000Z' },
    { type: 'RECEIPT_VERIFIED', headSha: policy.currentHeadSha, receipt: receiptSummary(), mergeAuthorization, observedAt: '2026-08-30T08:20:00.000Z' },
    { type: 'RECEIPT_SUPERSEDED', predecessorReceiptId: receiptSummary().receiptId, successor, observedAt: '2026-08-30T08:21:00.000Z' },
  ], policy, NOW);
  assert.equal(superseded.receipt.receiptId, successor.receiptId);
  assert.equal(superseded.receiptHistory[0].receiptId, receiptSummary().receiptId);
  assert.equal(superseded.receiptHistory[0].lifecycleState, 'SUPERSEDED');
  assert.equal(superseded.supersessionStatus, 'SUPERSEDED_WITH_CURRENT_SUCCESSOR');

  const revoked = reduceApprovalDecisionState([
    ...verified.eventHistory,
    { type: 'POLICY_REVOKED', observedAt: '2026-08-30T08:29:00.000Z' },
  ], policy, NOW);
  assert.equal(revoked.state, 'REVOKED');
  assert.throws(
    () => reduceApprovalDecisionState([{ type: 'FORCE_ACCEPT' }], policy, NOW),
    /APPROVAL_STATE_EVENT_UNSUPPORTED/,
  );
});

test('fresh acceptance revalidation is the only route from VERIFIED to ACCEPTED', async () => {
  const { evidence, mergeAuthorization, policy } = await acceptanceEvidence();
  const state = verifiedState(policy, mergeAuthorization);
  const validation = revalidateApprovalAtAcceptance(state, evidence, NOW);
  assert.equal(validation.valid, true);
  const accepted = reduceApprovalDecisionState([
    ...state.eventHistory,
    { type: 'ACCEPTANCE_REVALIDATED', validation, observedAt: evidence.readAt },
  ], policy, NOW);
  assert.equal(accepted.state, 'ACCEPTED');
  assert.equal(Object.isFrozen(accepted), true);
  assert.throws(
    () => reduceApprovalDecisionState([
      ...state.eventHistory,
      { type: 'ACCEPTANCE_REVALIDATED', validation: { valid: false, issues: [{ stable_code: 'APPROVAL_ACCEPTANCE_REVALIDATION_STALE' }] }, observedAt: evidence.readAt },
    ], policy, NOW),
    /APPROVAL_ACCEPTANCE_REVALIDATION_STALE/,
  );
});

test('acceptance revalidation mutation matrix fails closed on every fresh-read requirement', async () => {
  const { evidence, mergeAuthorization, policy } = await acceptanceEvidence();
  const state = verifiedState(policy, mergeAuthorization);
  const cases = [
    ['stale review', (v) => { v.reviews[0].submittedAt = '2026-08-29T08:00:00.000Z'; }, 'APPROVAL_REVIEW_STALE'],
    ['authority reassigned', (v) => { v.authority.reassigned = true; }, 'APPROVAL_ROLE_AUTHORITY_STALE'],
    ['authority revoked', (v) => { v.authority.revocationStatus = 'REVOKED'; }, 'APPROVAL_ROLE_AUTHORITY_STALE'],
    ['expired legal', (v) => { v.legal.validUntil = '2026-08-30T08:00:00.000Z'; }, 'APPROVAL_LEGAL_INPUT_STALE'],
    ['ruleset drift', (v) => { v.ruleset.normalizedSha256 = 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; }, 'APPROVAL_RULESET_DRIFT'],
    ['ruleset bypass', (v) => { v.ruleset.bypassActors = [{ actorId: 1 }]; }, 'APPROVAL_RULESET_BYPASS_PRESENT'],
    ['diff outside allowlist', (v) => { v.acceptanceDiff.files.push({ path: 'apps/api/src/forbidden.ts', sha256: policy.decisionRawSha256 }); }, 'APPROVAL_ACCEPTANCE_DIFF_OUTSIDE_ALLOWLIST'],
    ['sidecar byte changed', (v) => { v.proposalMain.approvedSidecarRawSha256 = policy.decisionRawSha256; }, 'APPROVAL_ACCEPTANCE_SIDECAR_MISMATCH'],
    ['receipt replay', (v) => { v.receipt.priorReceiptIds.push(v.receipt.receiptId); }, 'APPROVAL_RECEIPT_REPLAYED'],
    ['receipt revoked', (v) => { v.receipt.revoked = true; }, 'APPROVAL_POLICY_REVOKED'],
    ['receipt superseded', (v) => { v.receipt.superseded = true; }, 'APPROVAL_RECEIPT_SUPERSEDED'],
    ['pre post TOCTOU', (v) => { v.postRead.headSha = 'ffffffffffffffffffffffffffffffffffffffff'; }, 'APPROVAL_TOCTOU_DETECTED'],
    ['machine dynamic association', (v) => { v.machineChecks[0].runHeadAssociated = false; }, 'APPROVAL_CHECK_DYNAMIC_ASSOCIATION_MISMATCH'],
    ['proposal result absent from main', (v) => { v.proposalMain.resultReachableFromCurrentMain = false; }, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED'],
    ['consumption absent', (v) => { v.mergeAuthorization.consumption = null; }, 'APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED'],
    ['ledger key stage-qualified', (v) => { v.mergeAuthorization.ledgerSnapshot.key.stage = 'ACCEPTANCE_MERGE'; }, 'APPROVAL_MERGE_AUTHORIZATION_NONCE_KEY_INVALID'],
    ['synthetic lifecycle result', (v) => { v.receipt.lifecycleValidation.trustEligible = false; v.receipt.lifecycleValidation.externalCompletenessCapability = null; }, 'APPROVAL_INDEPENDENCE_NOT_PROVEN'],
  ];
  for (const [name, mutate, code] of cases) {
    const value = clone(evidence);
    mutate(value);
    const result = revalidateApprovalAtAcceptance(state, value, NOW);
    assert.equal(result.valid, false, name);
    assert.ok(result.issues.some((entry) => entry.stable_code === code), `${name}: ${code}`);
  }
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
      return { acknowledgement: 'ACKNOWLEDGED' };
    },
  };
  assert.equal((await executeReservedMerge(fresh.reservation, mergeRequester, ledger)).outcome, 'ACKNOWLEDGED');
  assert.equal((await executeReservedMerge(fresh.reservation, mergeRequester, ledger)).outcome, 'HOLD');
  const retry = await reserve(ledger, grant);
  assert.equal(retry.outcome, 'IDEMPOTENT_EXISTING');
  assert.equal((await executeReservedMerge(retry.reservation, mergeRequester, ledger)).outcome, 'HOLD');
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
    const result = await executeReservedMerge(fresh.reservation, mergeRequester, ledger);
    assert.deepEqual(result, { outcome: 'ACK_UNKNOWN', blockingCode: 'APPROVAL_MERGE_ACK_UNKNOWN' });
    assert.equal((await executeReservedMerge(fresh.reservation, mergeRequester, ledger)).outcome, 'HOLD');
    assert.equal(physicalRequests, 1);
  }
});

test('ACK_UNKNOWN reconciles exact current-main facts into separate immutable consumption', async () => {
  const grant = await readJson('valid-grant.json');
  const readback = await readJson('current-main-readback.json');
  const ledger = new SharedDurableCasLedgerHarness();
  const fresh = await reserve(ledger, grant);
  await executeReservedMerge(fresh.reservation, { requestMerge: async () => { throw new Error('timeout'); } }, ledger);
  const result = await reconcileMergeAuthorizationReservation(fresh.reservation, readback, ledger, NOW);
  assert.equal(result.outcome, 'CONSUMPTION_RECORDED');
  assert.equal(result.consumption.grant_id, grant.grant_id);
  assert.equal(result.consumption.grant_raw_sha256, digest(grant));
  assert.equal(result.consumption.nonce_ledger_reserved_revision, fresh.reservedLedgerRevision);
  assert.equal(result.consumptionRawSha256, digest(result.consumption));
  const retried = await reconcileMergeAuthorizationReservation(fresh.reservation, readback, ledger, NOW);
  assert.deepEqual(retried.consumption, result.consumption);
  assert.equal(retried.committedLedgerRevision, result.committedLedgerRevision);
});

test('current-main lag, wrong facts, or stale grant bindings HOLD without nonce release', async () => {
  const grant = await readJson('valid-grant.json');
  const baseReadback = await readJson('current-main-readback.json');
  const cases = [
    (value) => { value.resultReachableFromCurrentMain = false; },
    (value) => { value.resultCommitSha = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; },
    (value) => { value.observedMergeMethod = 'MERGE'; },
    (value) => { value.authorizedHeadSha = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; },
    (value) => { value.baseSha = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; },
  ];
  for (const mutate of cases) {
    const ledger = new SharedDurableCasLedgerHarness();
    const fresh = await reserve(ledger, grant);
    const readback = clone(baseReadback);
    mutate(readback);
    const result = await reconcileMergeAuthorizationReservation(fresh.reservation, readback, ledger, NOW);
    assert.equal(result.outcome, 'HOLD');
    assert.equal(result.consumption, null);
    const stream = ledger.snapshot()[0];
    assert.equal(stream.events[0].type, 'NONCE_RESERVED');
    assert.equal(stream.events.some(({ type }) => type === 'NONCE_RELEASED'), false);
  }
});

test('grant revocation before reservation denies; after reservation reconciles HOLD and remains reserved', async () => {
  const grant = await readJson('valid-grant.json');
  const grantRawSha256 = digest(grant);
  const key = { repositoryId: grant.repository.id, singleUseNonce: grant.single_use_nonce };
  const before = new SharedDurableCasLedgerHarness([{
    key, committedRevision: 1,
    events: [{ type: 'GRANT_REVOKED', grantId: grant.grant_id, grantRawSha256, reasonCode: 'POLICY_WITHDRAWN', effectiveAt: '2026-08-30T08:01:00.000Z', ledgerRevision: 1 }],
  }]);
  await assert.rejects(reserve(before, grant, requestFor(grant), 1), /APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE/);

  const ledger = new SharedDurableCasLedgerHarness();
  const fresh = await reserve(ledger, grant);
  await ledger.compareAndSwap({
    key, expectedRevision: 1,
    event: { type: 'GRANT_REVOKED', grantId: grant.grant_id, grantRawSha256, reasonCode: 'POLICY_WITHDRAWN', effectiveAt: '2026-08-30T08:12:00.000Z' },
  });
  const readback = await readJson('current-main-readback.json');
  const result = await reconcileMergeAuthorizationReservation(fresh.reservation, readback, ledger, NOW);
  assert.equal(result.outcome, 'HOLD');
  assert.equal(result.blockingCode, 'APPROVAL_MERGE_AUTHORIZATION_GRANT_STALE');
  assert.equal(ledger.snapshot()[0].events[0].type, 'NONCE_RESERVED');
});

test('restart snapshot preserves idempotency, consumption, and repository-wide nonce uniqueness', async () => {
  const grant = await readJson('valid-grant.json');
  const readback = await readJson('current-main-readback.json');
  const firstProcess = new SharedDurableCasLedgerHarness();
  const fresh = await reserve(firstProcess, grant);
  await executeReservedMerge(fresh.reservation, { requestMerge: async () => ({ acknowledgement: 'ACKNOWLEDGED' }) }, firstProcess);
  await reconcileMergeAuthorizationReservation(fresh.reservation, readback, firstProcess, NOW);

  const restarted = new SharedDurableCasLedgerHarness(firstProcess.snapshot());
  const existing = await reserve(restarted, grant, requestFor(grant), restarted.snapshot()[0].committedRevision);
  assert.equal(existing.outcome, 'IDEMPOTENT_EXISTING');
  let calls = 0;
  assert.equal((await executeReservedMerge(existing.reservation, { requestMerge: async () => { calls += 1; } }, restarted)).outcome, 'HOLD');
  const reconciled = await reconcileMergeAuthorizationReservation(existing.reservation, readback, restarted, NOW);
  assert.equal(reconciled.outcome, 'CONSUMPTION_RECORDED');
  assert.equal(calls, 0);
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
});

test('status read model is frozen, bounded, and redacts nonce and free-form facts', async () => {
  const { mergeAuthorization, policy } = await acceptanceEvidence();
  const state = {
    ...verifiedState(policy, mergeAuthorization),
    singleUseNonce: 'nonce-program-c-must-not-render',
    reviewBody: 'must-not-render-review',
    legalContent: 'must-not-render-legal',
  };
  const model = renderApprovalStatusReadModel(state);
  const serialized = JSON.stringify(model);
  assert.equal(Object.isFrozen(model), true);
  assert.equal(serialized.includes('nonce-program-c'), false);
  assert.equal(serialized.includes('must-not-render'), false);
  assert.equal(model.mergeAuthorization.grantId, mergeAuthorization.grantId);
  assert.equal(model.mergeAuthorization.consumptionId, mergeAuthorization.consumptionId);
  assert.equal(model.highestPriorityBlocker, 'APPROVAL_ACCEPTANCE_REVALIDATION_REQUIRED');
});
