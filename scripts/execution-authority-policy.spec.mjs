import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  EXPECTED_MODEL_TASKS,
  EXPECTED_MODEL_GATEWAY_BOUNDARIES,
  EXPECTED_NON_TOOL_INVOKE_BOUNDARIES,
  EXPECTED_PROTECTED_WIRING_PATHS,
  EXPECTED_TOOL_CALLSITES,
  EXPECTED_TOOL_IDS,
  inspectExecutionAuthoritySource,
  verifyExecutionAuthorityPolicy,
} from './execution-authority-policy.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

test('inventory is locked to 18 Tools and 10 product Model tasks', () => {
  assert.equal(EXPECTED_TOOL_IDS.length, 18);
  assert.equal(EXPECTED_MODEL_TASKS.length, 10);
  assert.equal(new Set(EXPECTED_TOOL_IDS).size, 18);
  assert.equal(new Set(EXPECTED_MODEL_TASKS.map((entry) => entry.taskId)).size, 10);
  assert.deepEqual(EXPECTED_MODEL_GATEWAY_BOUNDARIES, [
    'apps/api/src/model-runtime/site-builder-ai-task-bridge.ts#generateStructured#1',
    'apps/api/src/model-runtime/structured-task-runtime-bridge.ts#generateStructured#1',
  ]);
  assert.deepEqual(EXPECTED_PROTECTED_WIRING_PATHS, [
    'apps/api/src/model-gateway/model-gateway.module.ts',
    'apps/api/src/model-gateway/router-model-gateway.ts',
    'apps/api/src/tools/tool-broker.factory.ts',
    'apps/api/src/tools/tool-broker.ts',
  ]);
  assert.equal(EXPECTED_TOOL_CALLSITES.length, 36);
  assert.deepEqual(EXPECTED_NON_TOOL_INVOKE_BOUNDARIES, [
    'apps/api/src/site-builder/eval/copy-sonnet-recovery-zero-call-preflight.ts#input.pricingBroker#1',
  ]);
});

test('an empty or incomplete protected-path fence cannot self-disable the guard', async () => {
  const manifest = JSON.parse(await readFile(
    new URL('../docs/governance/durable-result-strategies.json', import.meta.url),
    'utf8',
  ));
  const result = await verifyExecutionAuthorityPolicy({
    repoRoot: repositoryRoot,
    manifest: {
      ...manifest,
      physicalExecutionWiring: {
        ...manifest.physicalExecutionWiring,
        protectedFiles: [],
      },
    },
  });
  assert.ok(result.issues.some((entry) =>
    entry.code === 'EXECUTION_AUTHORITY_WIRING_FENCE_INVALID'));
});

test('AST inspection sees aliased gateway calls, Tool calls and BigQuery aliases', () => {
  const execution = inspectExecutionAuthoritySource('synthetic.ts', `
    await arbitrary.generateStructured({ task: 'new.task' }, context);
    await broker.invoke("google_patents.search", input, context);
  `);
  assert.deepEqual(execution.modelMethods, ['generateStructured']);
  assert.deepEqual(execution.toolIds, ['google_patents.search']);
  assert.deepEqual(execution.dynamicInvokeReceivers, []);
  const resolvedConstant = inspectExecutionAuthoritySource('synthetic.ts', `
    const TOOL = 'smtp.rcpt_probe';
    await broker.invoke(TOOL, input, context);
    await anotherBroker.invoke(toolId, input, context);
  `);
  assert.deepEqual(resolvedConstant.toolIds, ['smtp.rcpt_probe']);
  assert.deepEqual(resolvedConstant.dynamicInvokeReceivers, ['anotherBroker']);
  const bigQuery = inspectExecutionAuthoritySource('synthetic.ts', `
    import { bigqueryPatents as patents } from "../adapters/bigquery-patents";
    await patents.searchPatentsByAssignee('Acme', options);
  `);
  assert.equal(bigQuery.constructsBigQuery, true);
});

test('pure contracts are complete while physical Router/ToolBroker wiring remains fenced', async () => {
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: repositoryRoot });
  assert.deepEqual(result.issues, []);
  assert.equal(result.toolCount, 18);
  assert.equal(result.modelTaskCount, 10);
  assert.equal(result.physicalExecutionWiring, 'NOT_WIRED');
  assert.equal(result.physicalToolCallsiteCount, 36);
  assert.equal(result.modelGatewayBoundaryCount, 2);
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
