import assert from 'node:assert/strict';
import test from 'node:test';
import { runApprovalStatusCli } from './governance-approval-status.mjs';
import { renderApprovalStatusReadModel } from './governance-approval-state.mjs';

const DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const cliState = () => ({
  schemaVersion: 'approval-decision-state/v1',
  repository: { id: 1291151138, fullName: 'mlhjyx/global-backend' },
  decisionId: 'ADR-027',
  decisionRevision: 'program-c/decision-r1',
  policyRevision: 'program-c/policy-r1',
  state: 'VERIFIED',
  currentHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  currentBaseSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  legalState: 'NO_BLOCKER_RECORDED',
  evidenceTrustState: 'INDEPENDENT_EXTERNAL_VERIFIED',
  evidenceSlots: {
    product: 'VERIFIED', privacy: 'VERIFIED', codeowner: 'VERIFIED',
    qa: 'VERIFIED', security: 'VERIFIED', machine: 'VERIFIED',
  },
  receipt: {
    receiptId: 'approval-receipt-task4-0001',
    receiptCoreSha256: DIGEST,
    receiptRawSha256: DIGEST,
    trustState: 'INDEPENDENT_EXTERNAL_VERIFIED',
    validUntil: '2026-08-30T10:00:00.000Z',
  },
  receiptHistory: [],
  mergeAuthorization: {
    grantId: 'program-c-grant-task4-0001', grantRawSha256: DIGEST,
    consumptionId: null, consumptionRawSha256: null,
    reservedLedgerRevision: 1, ledgerState: 'RESERVED',
  },
  revocationStatus: 'ACTIVE',
  supersessionStatus: 'CURRENT',
  blockingCodes: ['APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_REQUIRED'],
  eventHistory: [],
});

const dependencies = (state = cliState()) => {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    value: {
      loadDecisionState: async (decisionId) => (decisionId === 'ADR-027' ? state : null),
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    },
  };
};

test('CLI supports only the exact ADR-027 JSON and text decisions', async () => {
  const json = dependencies();
  assert.equal(await runApprovalStatusCli(['--decision', 'ADR-027', '--format', 'json'], json.value), 0);
  const parsed = JSON.parse(json.stdout.join(''));
  assert.equal(parsed.decisionId, 'ADR-027');
  assert.equal(parsed.state, 'VERIFIED');
  assert.equal(JSON.stringify(parsed).includes('singleUseNonce'), false);

  const text = dependencies();
  assert.equal(await runApprovalStatusCli(['--decision', 'ADR-027', '--format', 'text'], text.value), 0);
  assert.match(text.stdout.join(''), /^决策: ADR-027\n状态: VERIFIED\n/);
  assert.match(text.stdout.join(''), /不会重复合并或自动放行/);
  assert.equal(text.stdout.join('').includes('nonce-program-c'), false);
});

test('CLI rejects unsupported decision IDs, formats, argument shapes, and missing evidence', async () => {
  const cases = [
    ['unsupported decision', ['--decision', 'ADR-026', '--format', 'json'], dependencies()],
    ['unsupported format', ['--decision', 'ADR-027', '--format', 'yaml'], dependencies()],
    ['missing format', ['--decision', 'ADR-027'], dependencies()],
    ['missing evidence', ['--decision', 'ADR-027', '--format', 'json'], dependencies(null)],
  ];
  for (const [name, argv, deps] of cases) {
    assert.equal(await runApprovalStatusCli(argv, deps.value), 1, name);
    assert.match(deps.stderr.join(''), /^APPROVAL_/);
    assert.equal(deps.stdout.length, 0);
  }
  const failedRead = dependencies();
  failedRead.value.loadDecisionState = async () => { throw new Error('do-not-reflect-adapter-detail'); };
  assert.equal(await runApprovalStatusCli(['--decision', 'ADR-027', '--format', 'json'], failedRead.value), 1);
  assert.equal(failedRead.stderr.join(''), 'APPROVAL_STATUS_EVIDENCE_REQUIRED\n');
  assert.equal(await runApprovalStatusCli(null, failedRead.value), 1);
});

test('CLI rejects free-form review or Legal content instead of silently redacting boundary input', async () => {
  for (const mutate of [
    (state) => { state.reviewBody = 'free form review'; },
    (state) => { state.legal = { content: 'free form legal advice' }; },
  ]) {
    const state = cliState();
    mutate(state);
    const deps = dependencies(state);
    assert.equal(await runApprovalStatusCli(['--decision', 'ADR-027', '--format', 'json'], deps.value), 1);
    assert.match(deps.stderr.join(''), /APPROVAL_STATUS_FORBIDDEN_CONTENT/);
    assert.equal(deps.stdout.length, 0);
  }
});

test('I5 renderer and CLI reject nested nonce, extra projected keys, and multibyte overflow', async () => {
  const mutations = [
    (state) => { state.repository.singleUseNonce = 'nonce-program-c-never-output'; },
    (state) => { state.repository.extra = true; },
    (state) => { state.evidenceSlots.extra = 'VERIFIED'; },
    (state) => { state.evidenceSlots.product = 'nonce-program-c-never-output'; },
  ];
  for (const mutate of mutations) {
    const state = cliState();
    mutate(state);
    assert.throws(() => renderApprovalStatusReadModel(state), /APPROVAL_STATUS_/);
    const deps = dependencies(state);
    assert.equal(await runApprovalStatusCli(['--decision', 'ADR-027', '--format', 'json'], deps.value), 1);
    assert.equal(deps.stdout.length, 0);
  }

  const multibyte = cliState();
  multibyte.decisionRevision = `program-c/decision-${'界'.repeat(12_000)}`;
  const deps = dependencies(multibyte);
  assert.equal(await runApprovalStatusCli(['--decision', 'ADR-027', '--format', 'json'], deps.value), 1);
  assert.equal(deps.stdout.length, 0);
  const valid = renderApprovalStatusReadModel(cliState());
  assert.ok(Buffer.byteLength(JSON.stringify(valid), 'utf8') <= 32_768);
});

test('CLI rejects every force-accept spelling and never loads decision evidence', async () => {
  const spellings = [
    ['--decision', 'ADR-027', '--format', 'json', '--force-accept'],
    ['--decision', 'ADR-027', '--format', 'json', '--force_accept'],
    ['--decision', 'ADR-027', '--format', 'json', '--forceAccept'],
    ['--decision', 'ADR-027', '--format', 'json', 'force', 'accept'],
    ['--decision', 'ADR-027', '--format', 'json', '--accept', '--force'],
  ];
  for (const argv of spellings) {
    let loads = 0;
    const deps = dependencies();
    deps.value.loadDecisionState = async () => { loads += 1; return cliState(); };
    assert.equal(await runApprovalStatusCli(argv, deps.value), 1);
    assert.match(deps.stderr.join(''), /APPROVAL_FORCE_ACCEPT_FORBIDDEN/);
    assert.equal(loads, 0);
  }
});
