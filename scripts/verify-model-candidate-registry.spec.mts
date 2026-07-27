import assert from 'node:assert/strict';
import test from 'node:test';

import { modelPolicyRegistry } from '../apps/api/src/site-builder/agents/model-policy.registry';
import { verifyModelCandidateRegistry } from './verify-model-candidate-registry.mts';

test('registry candidate generator exactly matches the machine baseline', () => {
  assert.doesNotThrow(() => verifyModelCandidateRegistry());
});

test('empty registry candidate generator fails closed', () => {
  assert.throws(
    () => verifyModelCandidateRegistry(() => []),
    /actual registry candidates differ from the machine baseline/,
  );
});

test('cross-wired registry profile fails closed', () => {
  const structured = modelPolicyRegistry.getCandidates('structured.default');
  assert.throws(
    () =>
      verifyModelCandidateRegistry((profile) =>
        profile === 'structured.workspace_materials'
          ? structured
          : modelPolicyRegistry.getCandidates(profile),
      ),
    /structured\.workspace_materials actual registry candidates differ/,
  );
});
