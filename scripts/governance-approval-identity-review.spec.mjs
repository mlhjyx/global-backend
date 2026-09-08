import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { APPROVAL_SCHEMA_CATALOG } from './governance-approval-schema-catalog.mjs';
import {
  validateProgramCMergeAuthorizationConsumption,
  validateProgramCMergeAuthorizationGrant,
} from './governance-approval-schema-validator.mjs';
import { parseApprovalReviewCommand } from './governance-approval-role-evidence.mjs';

const ROOT = new URL('./fixtures/approval-readback/merge-authorization/', import.meta.url);
const clone = (value) => structuredClone(value);
const readJson = async (name) => JSON.parse(await readFile(new URL(name, ROOT), 'utf8'));

const consumptionFor = (grant) => ({
  schema_version: 'program-c-merge-authorization-consumption/v1',
  consumption_id: 'program-c-consumption-identity-0001',
  grant_id: grant.grant_id,
  grant_raw_sha256: `sha256:${'a'.repeat(64)}`,
  single_use_nonce: grant.single_use_nonce,
  repository: clone(grant.repository),
  decision_adr: grant.decision_adr,
  decision_revision: grant.decision_revision,
  policy_revision: grant.policy_revision,
  stage: grant.stage,
  pr_number: grant.pr_number,
  authorized_head_sha: grant.head_sha,
  result_commit_sha: 'c'.repeat(40),
  observed_merge_method: grant.allowed_merge_method,
  consumed_at: '2026-08-30T08:20:00.000Z',
  nonce_ledger_key: `program-c-merge:${grant.single_use_nonce}`,
  nonce_ledger_reserved_revision: 1,
  independent_verifier: {
    repository: { id: 4270001, full_name: 'mlhjyx/global-governance-verifier' },
    path: '.github/workflows/approval-readback.yml',
    sha: 'd'.repeat(40),
    run_id: 42701,
    attempt: 1,
    identity: 'github-app:427',
  },
  current_main: { ref: 'refs/heads/main', sha: 'e'.repeat(40), read_at: '2026-08-30T08:30:00.000Z' },
  pre_readback_sha256: `sha256:${'b'.repeat(64)}`,
  post_readback_sha256: `sha256:${'c'.repeat(64)}`,
});

test('I4 schemas admit exactly ADR-026 and ADR-027 and reject the invented ADR-042 alias', async () => {
  const base = await readJson('valid-grant.json');
  const admitted = [];
  for (const decisionAdr of ['ADR-026', 'ADR-027']) {
    const grant = { ...clone(base), decision_adr: decisionAdr };
    admitted.push({
      decisionAdr,
      grant: validateProgramCMergeAuthorizationGrant(grant).valid,
      consumption: validateProgramCMergeAuthorizationConsumption(consumptionFor(grant)).valid,
    });
  }
  const invented = { ...clone(base), decision_adr: 'ADR-042' };
  assert.equal(validateProgramCMergeAuthorizationGrant(invented).valid, false);
  assert.equal(validateProgramCMergeAuthorizationConsumption(consumptionFor(invented)).valid, false);
  assert.equal(JSON.stringify(APPROVAL_SCHEMA_CATALOG).includes('ADR-042'), false);
  assert.deepEqual(admitted, [
    { decisionAdr: 'ADR-026', grant: true, consumption: true },
    { decisionAdr: 'ADR-027', grant: true, consumption: true },
  ]);
});

test('I4 review command grammar uses the same closed ADR-026 or ADR-027 identity', () => {
  const digest = `sha256:${'1'.repeat(64)}`;
  const results = [];
  for (const decisionAdr of ['ADR-026', 'ADR-027']) {
    try {
      const parsed = parseApprovalReviewCommand(
        `APPROVE DECISION ${decisionAdr} REV program-c/policy-r1 ROLE OWN-PRODUCT DIGEST ${digest}`,
      );
      results.push(parsed.decision_adr);
    } catch {
      results.push('REJECTED');
    }
  }
  assert.throws(
    () => parseApprovalReviewCommand(`APPROVE DECISION ADR-042 REV program-c/policy-r1 ROLE OWN-PRODUCT DIGEST ${digest}`),
    /APPROVAL_REVIEW_COMMAND_INVALID/,
  );
  assert.deepEqual(results, ['ADR-026', 'ADR-027']);
});
