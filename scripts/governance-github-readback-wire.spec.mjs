import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureState, collect, REPOSITORY_FULL_NAME, SIGNER_PATH, BASE_SHA } from './fixtures/approval-readback/task5-github-readback-fixture.mjs';

test('GitHub seconds-precision review times normalize to canonical internal instants', async () => {
 const state=fixtureState();
 for(const review of state.reviewPages.flat()) review.submitted_at=review.submitted_at.replace('.000Z','Z');
 const {evidence}=await collect(state);
 assert.equal(evidence.assembly_state,'HOLD_LOCAL_CONTEXT_REQUIRED');
 assert.match(evidence.product_review.submitted_at,/\.000Z$/);
});
test('GitHub workflow reference uses repository path and commit identity', async () => {
 const state=fixtureState();
 state.actionRunPages[0][0].path+='@main';
 state.actionRunPages[0][0].referenced_workflows=[{path:`${REPOSITORY_FULL_NAME}/${SIGNER_PATH}@main`,sha:BASE_SHA,ref:'refs/heads/main'}];
 assert.equal((await collect(state)).evidence.assembly_state,'HOLD_LOCAL_CONTEXT_REQUIRED');
});

for (const value of ['2026-02-30T00:00:00Z', '2026-08-30T12:00:00+00:00', 'garbage', '2026-08-30T12:00:00.0000Z']) {
 test(`invalid wire timestamp remains rejected: ${value}`, async () => {
  const state=fixtureState();
  state.reviewPages[0][0].submitted_at=value;
  await assert.rejects(()=>collect(state));
 });
}
test('SHA-pinned signer without ref still binds to trusted base', async () => {
 const state=fixtureState();
 state.actionRunPages[0][0].referenced_workflows=[{path:`${REPOSITORY_FULL_NAME}/${SIGNER_PATH}@${BASE_SHA}`,sha:BASE_SHA}];
 assert.equal((await collect(state)).evidence.assembly_state,'HOLD_LOCAL_CONTEXT_REQUIRED');
});
for (const [name, mutate] of [
 ['foreign repository', r=>{r.path=`attacker/repo/${SIGNER_PATH}@main`;}],
 ['wrong commit', r=>{r.sha='f'.repeat(40);}],
 ['wrong file', r=>{r.path=`${REPOSITORY_FULL_NAME}/.github/workflows/other.yml@main`;}],
 ['contradictory ref', r=>{r.ref='refs/heads/other';}],
 ['unbound ref', r=>{r.path=`${REPOSITORY_FULL_NAME}/${SIGNER_PATH}@other`;}],
]) {
 test(`signer rejects ${name}`, async()=>{
  const state=fixtureState(); mutate(state.actionRunPages[0][0].referenced_workflows[0]);
  await assert.rejects(()=>collect(state),/APPROVAL_CHECK_WORKFLOW_MISMATCH/);
 });
}
