import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  EXPECTED_MODEL_TASKS,
  EXPECTED_MODEL_GATEWAY_BOUNDARIES,
  EXPECTED_NON_TOOL_INVOKE_BOUNDARIES,
  EXPECTED_PROTECTED_WIRING_PATHS,
  EXPECTED_TOOL_CALLSITES,
  EXPECTED_TOOL_IDS,
  declaresMapping,
  inspectExecutionAuthoritySource,
  modelTaskIdsInSource,
  resolvePlatformContractReferences,
  sourceConstants,
  verifyExecutionAuthorityPolicy,
} from './execution-authority-policy.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

test('inventory is locked to 18 Tools and 11 product Model tasks', () => {
  assert.equal(EXPECTED_TOOL_IDS.length, 18);
  assert.equal(EXPECTED_MODEL_TASKS.length, 11);
  assert.equal(new Set(EXPECTED_TOOL_IDS).size, 18);
  assert.equal(new Set(EXPECTED_MODEL_TASKS.map((entry) => entry.taskId)).size, 11);
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
  const namespaceBigQuery = inspectExecutionAuthoritySource('synthetic.ts', `
    import * as patents from "../adapters/bigquery-patents";
    await patents.bigqueryPatents.searchPatentsByAssignee('Acme', options);
  `);
  assert.equal(namespaceBigQuery.constructsBigQuery, true);
  const elementAccess = inspectExecutionAuthoritySource('synthetic.ts', `
    await gateway["generateStructured"]({ task: 'new.task' }, context);
    await broker['invoke']('http.get', input, context);
  `);
  assert.deepEqual(elementAccess.modelMethods, ['generateStructured']);
  assert.deepEqual(elementAccess.toolIds, ['http.get']);
});

test('source constants resolve as-const, multi-line and aliased declarations', () => {
  const constants = sourceConstants([
    'export const DIRECT = 3_000_000 as const;',
    'export const TEXT =',
    '  "214748364800" as const;',
    'export const ALIAS =',
    '  DIRECT;',
    "const TASK = 'discovery.classify_trade_role' as const;",
    'const LOOP_A = LOOP_B;',
    'const LOOP_B = LOOP_A;',
  ].join('\n'));
  assert.equal(constants.get('DIRECT'), 3_000_000);
  assert.equal(constants.get('TEXT'), '214748364800');
  assert.equal(constants.get('ALIAS'), 3_000_000);
  assert.equal(constants.get('TASK'), 'discovery.classify_trade_role');
  assert.equal(constants.has('LOOP_A'), false);
});

test('platform execution contract references resolve to the contract tool id and schema', () => {
  const contract = [
    'toolContracts: [',
    '  { toolId: "crawl4ai.render", version: "1.0.0", resultSchema: "crawl4ai-render/v1" },',
    '  { toolId: "google_patents.search", version: "1.0.0", resultSchema: "google-patents-search/v1" },',
    ']',
  ].join('\n');
  const resolved = resolvePlatformContractReferences([
    'const render = platformExecutionToolContract("crawl4ai.render");',
    'export const tool = { id: render.toolId, durableResultStrategy: { kind: "artifact_reference", schema: render.resultSchema } };',
    "const projections = { 'google_patents.search': platformExecutionToolContract('google_patents.search').resultSchema };",
    'const unknown = platformExecutionToolContract("not.declared");',
    'export const other = { id: unknown.toolId, schema: unknown.resultSchema };',
  ].join('\n'), contract);
  assert.match(resolved, /id: "crawl4ai\.render"/);
  assert.match(resolved, /schema: "crawl4ai-render\/v1"/);
  assert.equal(declaresMapping(resolved, 'google_patents.search', 'google-patents-search/v1'), true);
  assert.match(resolved, /schema: unknown\.resultSchema/);
});

test('a declared mapping is found in either quote style and only for the exact key and value', () => {
  assert.equal(declaresMapping('"icp.design": "icp-design/v1",', 'icp.design', 'icp-design/v1'), true);
  assert.equal(declaresMapping("'icp.design': 'icp-design/v1',", 'icp.design', 'icp-design/v1'), true);
  assert.equal(declaresMapping('"icp.design": "icp-design/v2",', 'icp.design', 'icp-design/v1'), false);
  assert.equal(declaresMapping('"icpXdesign": "icp-design/v1",', 'icp.design', 'icp-design/v1'), false);
});

test('getTask through a same-file string constant joins the Model task inventory', () => {
  const { taskIds, unresolved } = modelTaskIdsInSource([
    "export const TASK = 'discovery.classify_trade_role' as const;",
    'getTask(TASK);',
    "getTask('icp.design');",
    'getTask(input.task);',
    'getTask(taskId);',
    'getTask(MISSING_TASK);',
  ].join('\n'));
  assert.deepEqual(taskIds, ['discovery.classify_trade_role', 'icp.design']);
  assert.deepEqual(unresolved, ['MISSING_TASK']);
});

test('pure contracts preserve typed authority wiring and the artifact pre-wire hold', async () => {
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: repositoryRoot });
  assert.deepEqual(result.issues, []);
  assert.equal(result.toolCount, 18);
  assert.equal(result.modelTaskCount, 11);
  assert.equal(result.physicalExecutionWiring, 'PARTIAL_HOLD');
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

test('artifact execution is bound per call: only a subject-bound call may reach a wire (G3 5.1)', async () => {
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, 'docs/governance/durable-result-strategies.json'), 'utf8'));
  assert.equal(manifest.artifactPhysicalExecution.status, 'PER_CALL_SUBJECT_BINDING');
  for (const status of ['SUBJECT_BINDING_HOLD', 'OPEN']) {
    const result = await verifyExecutionAuthorityPolicy({
      repoRoot: repositoryRoot,
      manifest: { ...manifest, artifactPhysicalExecution: { ...manifest.artifactPhysicalExecution, status } },
    });
    assert.ok(result.issues.some((entry) => entry.code === 'EXECUTION_AUTHORITY_ARTIFACT_WIRING_HOLD_INVALID'), status);
  }
  const fallback = await verifyExecutionAuthorityPolicy({
    repoRoot: repositoryRoot,
    manifest: { ...manifest, artifactPhysicalExecution: { ...manifest.artifactPhysicalExecution, inlineFallbackAllowed: true } },
  });
  assert.ok(fallback.issues.some((entry) => entry.code === 'EXECUTION_AUTHORITY_ARTIFACT_WIRING_HOLD_INVALID'));
});
