import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  EXPECTED_MODEL_TASKS,
  EXPECTED_TOOL_IDS,
  verifyExecutionAuthorityPolicy,
} from './execution-authority-policy.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

test('inventory is locked to 18 Tools and 10 product Model tasks', () => {
  assert.equal(EXPECTED_TOOL_IDS.length, 18);
  assert.equal(EXPECTED_MODEL_TASKS.length, 10);
  assert.equal(new Set(EXPECTED_TOOL_IDS).size, 18);
  assert.equal(new Set(EXPECTED_MODEL_TASKS.map((entry) => entry.taskId)).size, 10);
});

test('pure contracts are complete while physical Router/ToolBroker wiring remains fenced', async () => {
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: repositoryRoot });
  assert.deepEqual(result.issues, []);
  assert.equal(result.toolCount, 18);
  assert.equal(result.modelTaskCount, 10);
  assert.equal(result.physicalExecutionWiring, 'NOT_WIRED');
});

test('policy errors enumerate exact paths and producers', async () => {
  const result = await verifyExecutionAuthorityPolicy({
    repoRoot: repositoryRoot,
    manifestPath: 'docs/governance/does-not-exist.json',
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) =>
    entry.code === 'EXECUTION_AUTHORITY_MANIFEST_MISSING' &&
    entry.path === 'docs/governance/does-not-exist.json'));
  for (const id of [...EXPECTED_TOOL_IDS, ...EXPECTED_MODEL_TASKS.map((entry) => entry.taskId)]) {
    assert.ok(result.issues.some((entry) => entry.producerId === id), id);
  }
});

