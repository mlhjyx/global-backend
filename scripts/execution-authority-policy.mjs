import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SCRIPT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_MANIFEST_PATH = 'docs/governance/durable-result-strategies.json';
const TOOL_SOURCE_PATHS = Object.freeze([
  'apps/api/src/tools/builtin-tools.ts',
  'apps/api/src/tools/source-tools.ts',
]);
const RECEIPT_PATH = 'apps/api/src/durable-results/durable-execution-receipt.ts';
const ACK_PATH = 'apps/api/src/durable-results/domain-ack-contract.ts';

export const EXPECTED_TOOL_IDS = Object.freeze([
  'searxng.search', 'crawl4ai.fetch', 'wikidata.sparql', 'osm.overpass',
  'smtp.rcpt_probe', 'crawl4ai.render', 'http.get', 'wikidata.entity',
  'gleif.fetch', 'ted.search', 'openfda.search', 'companies_house.search',
  'inpi_rne.search', 'google_patents.search', 'tradefair.algolia',
  'mapyourshow.fetch', 'samgov.search', 'sanctions.download',
]);

export const EXPECTED_MODEL_TASKS = Object.freeze([
  Object.freeze({ path: 'apps/api/src/temporal/understanding.activities.ts', taskId: 'company_understanding.extract_claims', schema: 'understanding-claims/v1' }),
  Object.freeze({ path: 'apps/api/src/temporal/understanding.activities.ts', taskId: 'company_understanding.extract_profile', schema: 'understanding-profile/v1' }),
  Object.freeze({ path: 'apps/api/src/temporal/understanding.activities.ts', taskId: 'company_understanding.extract_offerings', schema: 'understanding-offerings/v1' }),
  Object.freeze({ path: 'apps/api/src/icp/icp.service.ts', taskId: 'icp.design', schema: 'icp-design/v1' }),
  Object.freeze({ path: 'apps/api/src/icp/icp.service.ts', taskId: 'discovery.query_plan', schema: 'icp-query-plan/v1' }),
  Object.freeze({ path: 'apps/api/src/discovery/taxonomy-resolver.ts', taskId: 'taxonomy.normalize', schema: 'taxonomy-code/v1' }),
  Object.freeze({ path: 'apps/api/src/discovery/fit-judge.ts', taskId: 'discovery.qualify_fit', schema: 'fit-judgment/v1' }),
  Object.freeze({ path: 'apps/api/src/discovery/providers/public-web.provider.ts', taskId: 'discovery.extract_company', schema: 'discovery-extract-company/v1' }),
  Object.freeze({ path: 'apps/api/src/discovery/providers/directory.provider.ts', taskId: 'discovery.extract_list', schema: 'discovery-extract-list/v1' }),
  Object.freeze({ path: 'apps/api/src/discovery/providers/decision-maker.provider.ts', taskId: 'contact.find_decision_makers', schema: 'contact-decision-makers/v1' }),
]);

export const EXPECTED_MODEL_GATEWAY_BOUNDARIES = Object.freeze([
  'apps/api/src/model-runtime/site-builder-ai-task-bridge.ts#generateStructured#1',
  'apps/api/src/model-runtime/structured-task-runtime-bridge.ts#generateStructured#1',
]);

export const EXPECTED_PROTECTED_WIRING_PATHS = Object.freeze([
  'apps/api/src/model-gateway/model-gateway.module.ts',
  'apps/api/src/model-gateway/router-model-gateway.ts',
  'apps/api/src/tools/tool-broker.factory.ts',
  'apps/api/src/tools/tool-broker.ts',
]);

export const EXPECTED_TOOL_CALLSITES = Object.freeze([
  'apps/api/src/acquisition/adapters/mapyourshow.source.ts#mapyourshow.fetch#1',
  'apps/api/src/acquisition/adapters/trade-fair.source.ts#tradefair.algolia#1',
  'apps/api/src/discovery/providers/bigquery-patents.provider.ts#google_patents.search#1',
  'apps/api/src/discovery/providers/companies-house.provider.ts#companies_house.search#1',
  'apps/api/src/discovery/providers/companies-house.provider.ts#companies_house.search#2',
  'apps/api/src/discovery/providers/decision-maker.provider.ts#crawl4ai.fetch#1',
  'apps/api/src/discovery/providers/decision-maker.provider.ts#crawl4ai.fetch#2',
  'apps/api/src/discovery/providers/digital-footprint.provider.ts#crawl4ai.render#1',
  'apps/api/src/discovery/providers/directory.provider.ts#crawl4ai.fetch#1',
  'apps/api/src/discovery/providers/directory.provider.ts#searxng.search#1',
  'apps/api/src/discovery/providers/email-verify.provider.ts#smtp.rcpt_probe#1',
  'apps/api/src/discovery/providers/gleif.provider.ts#gleif.fetch#1',
  'apps/api/src/discovery/providers/gleif.provider.ts#gleif.fetch#2',
  'apps/api/src/discovery/providers/inpi-rne.provider.ts#inpi_rne.search#1',
  'apps/api/src/discovery/providers/openfda.provider.ts#openfda.search#1',
  'apps/api/src/discovery/providers/osm.provider.ts#osm.overpass#1',
  'apps/api/src/discovery/providers/public-web.provider.ts#crawl4ai.fetch#1',
  'apps/api/src/discovery/providers/public-web.provider.ts#crawl4ai.fetch#2',
  'apps/api/src/discovery/providers/public-web.provider.ts#searxng.search#1',
  'apps/api/src/discovery/providers/structured-harvest.provider.ts#crawl4ai.render#1',
  'apps/api/src/discovery/providers/structured-harvest.provider.ts#http.get#1',
  'apps/api/src/discovery/providers/ted.provider.ts#ted.search#1',
  'apps/api/src/discovery/providers/trade-fair.provider.ts#tradefair.algolia#1',
  'apps/api/src/discovery/providers/wikidata-enrich.provider.ts#wikidata.entity#1',
  'apps/api/src/discovery/providers/wikidata-enrich.provider.ts#wikidata.entity#2',
  'apps/api/src/discovery/providers/wikidata.provider.ts#wikidata.sparql#1',
  'apps/api/src/intent/intent-projection.service.ts#http.get#1',
  'apps/api/src/intent/page-fetcher.ts#crawl4ai.render#1',
  'apps/api/src/sanctions/sanctions-refresh.service.ts#sanctions.download#1',
  'apps/api/src/signals/signal-ingest.service.ts#openfda.search#1',
  'apps/api/src/signals/signal-ingest.service.ts#samgov.search#1',
  'apps/api/src/signals/signal-ingest.service.ts#ted.search#1',
  'apps/api/src/site-builder/agents/brand-research.ts#crawl4ai.fetch#1',
  'apps/api/src/site-builder/agents/brand-research.ts#searxng.search#1',
  'apps/api/src/temporal/patent-cache-broker-scanner.ts#google_patents.search#1',
  'apps/api/src/temporal/understanding.activities.ts#crawl4ai.fetch#1',
]);

export const EXPECTED_NON_TOOL_INVOKE_BOUNDARIES = Object.freeze([
  'apps/api/src/site-builder/eval/copy-sonnet-recovery-zero-call-preflight.ts#input.pricingBroker#1',
]);

const RECEIPT_FIELDS = Object.freeze([
  'schemaVersion', 'scopeKey', 'authorityId', 'accountId', 'operationId',
  'operationKey', 'resultStrategy', 'resultSchema', 'resultDigest',
  'artifactId', 'usage', 'costBasis', 'status',
]);
const PAYLOAD_EXCLUSIONS = Object.freeze([
  'body', 'prompt', 'reasoning', 'rawResponse', 'response', 'responseBody',
  'token', 'email', 'credential', 'credentials', 'personalData',
]);
const PRIVACY_CLASSES = new Set([
  'PUBLIC_ORGANIZATION', 'CONFIDENTIAL_TENANT', 'PERSONAL_DATA',
]);
const ARTIFACT_CONTRACTS = Object.freeze({
  'crawl4ai-fetch/v1': Object.freeze({ maxBytes: 300000, mediaTypes: Object.freeze(['text/markdown']), privacyClass: 'PERSONAL_DATA', ttlSeconds: 86400 }),
  'crawl4ai-render/v1': Object.freeze({ maxBytes: 3000000, mediaTypes: Object.freeze(['text/html']), privacyClass: 'PERSONAL_DATA', ttlSeconds: 86400 }),
  'http-get/v1': Object.freeze({ maxBytes: 3000000, mediaTypes: Object.freeze(['text/plain']), privacyClass: 'PERSONAL_DATA', ttlSeconds: 86400 }),
  'sanctions-download/v1': Object.freeze({ maxBytes: 33554432, mediaTypes: Object.freeze(['application/xml', 'text/xml']), privacyClass: 'PERSONAL_DATA', ttlSeconds: 86400 }),
});

function issue(code, path, message, producerId) {
  return Object.freeze({
    code,
    path,
    message,
    ...(producerId === undefined ? {} : { producerId }),
  });
}

function sorted(values) { return [...values].sort(); }
function sameSet(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function analyzeTypeScript(path, source) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const modelCalls = [];
  const toolCalls = [];
  const dynamicInvokes = [];
  const bigQueryValueImports = new Set();
  const stringConstantsByLocalName = new Map();
  let importsGoogleBigQuery = false;
  let constructsBigQuery = false;
  function collectConstants(node) {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.initializer && ts.isStringLiteralLike(node.initializer)
    ) stringConstantsByLocalName.set(node.name.text, node.initializer.text);
    ts.forEachChild(node, collectConstants);
  }
  collectConstants(sourceFile);
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      if (moduleName === '@google-cloud/bigquery') importsGoogleBigQuery = true;
      if (moduleName.endsWith('/adapters/bigquery-patents') || moduleName === '../adapters/bigquery-patents') {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text;
            if (
              !clause.isTypeOnly && !element.isTypeOnly &&
              ['bigqueryPatents', 'BigQueryPatentsClient'].includes(importedName)
            ) bigQueryValueImports.add(element.name.text);
          }
        }
      }
    }
    if (ts.isNewExpression(node)) {
      const constructorName = node.expression.getText(sourceFile);
      if (constructorName === 'BigQuery' || bigQueryValueImports.has(constructorName)) {
        constructsBigQuery = true;
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression.getText(sourceFile);
      if (
        ['generateText', 'generateStructured', 'reviewVision'].includes(method) ||
        (method === 'embed' && /(?:gateway|modelGateway)$/i.test(receiver))
      ) modelCalls.push(Object.freeze({ method, position: node.getStart(sourceFile) }));
      if (method === 'invoke') {
        const first = node.arguments[0];
        const toolId = first && ts.isStringLiteralLike(first)
          ? first.text
          : first && ts.isIdentifier(first)
            ? stringConstantsByLocalName.get(first.text)
            : undefined;
        if (toolId !== undefined) toolCalls.push(Object.freeze({ toolId, position: node.getStart(sourceFile) }));
        else dynamicInvokes.push(Object.freeze({ receiver, position: node.getStart(sourceFile) }));
      }
      if (bigQueryValueImports.has(receiver)) constructsBigQuery = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return Object.freeze({
    modelCalls: Object.freeze(modelCalls),
    toolCalls: Object.freeze(toolCalls),
    dynamicInvokes: Object.freeze(dynamicInvokes),
    importsGoogleBigQuery,
    constructsBigQuery,
  });
}

export function inspectExecutionAuthoritySource(path, source) {
  const analysis = analyzeTypeScript(path, source);
  return Object.freeze({
    modelMethods: Object.freeze(analysis.modelCalls.map((entry) => entry.method)),
    toolIds: Object.freeze(analysis.toolCalls.map((entry) => entry.toolId)),
    dynamicInvokeReceivers: Object.freeze(analysis.dynamicInvokes.map((entry) => entry.receiver)),
    importsGoogleBigQuery: analysis.importsGoogleBigQuery,
    constructsBigQuery: analysis.constructsBigQuery,
  });
}

async function listFiles(root, relative) {
  const entries = await readdir(resolve(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function readText(repoRoot, path) {
  return readFile(resolve(repoRoot, path), 'utf8');
}

async function readJson(repoRoot, path) {
  return JSON.parse(await readText(repoRoot, path));
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function closedKeys(value, allowed, issues, path, code) {
  if (!isRecord(value)) {
    issues.push(issue(code, path, 'expected a JSON object'));
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(issue(code, path, `unknown field ${key}`));
  }
  return true;
}

function exactArray(value, expected) {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index]);
}

function missingManifestInventory(path, issues) {
  issues.push(issue('EXECUTION_AUTHORITY_MANIFEST_MISSING', path, 'durable result strategy manifest is required'));
  for (const id of EXPECTED_TOOL_IDS) {
    issues.push(issue('EXECUTION_AUTHORITY_TOOL_DECLARATION_MISSING', path, `missing Tool contract ${id}`, id));
  }
  for (const entry of EXPECTED_MODEL_TASKS) {
    issues.push(issue('EXECUTION_AUTHORITY_MODEL_DECLARATION_MISSING', path, `missing Model contract ${entry.taskId}`, entry.taskId));
  }
}

function validateTopLevel(manifest, path, issues) {
  const allowed = [
    'schemaVersion', 'cutoverFence', 'physicalExecutionWiring', 'receipt',
    'resultDisposition', 'tools', 'modelTasks', 'artifactSchemas',
    'managedExternalAdapters',
  ];
  if (!closedKeys(manifest, allowed, issues, path, 'EXECUTION_AUTHORITY_MANIFEST_INVALID')) return;
  if (manifest.schemaVersion !== 'execution-authority-policy/v2') {
    issues.push(issue('EXECUTION_AUTHORITY_MANIFEST_INVALID', path, 'schemaVersion must be execution-authority-policy/v2'));
  }
  if (manifest.cutoverFence !== 'TASK_6_AUTHORITY_BOUND_PHYSICAL_EXECUTION_NOT_WIRED') {
    issues.push(issue('EXECUTION_AUTHORITY_CUTOVER_FENCE_INVALID', path, 'Task 6 physical cutover fence is mandatory'));
  }
  for (const key of ['tools', 'modelTasks', 'artifactSchemas', 'managedExternalAdapters']) {
    if (!Array.isArray(manifest[key])) issues.push(issue('EXECUTION_AUTHORITY_MANIFEST_INVALID', path, `${key} must be an array`));
  }
}

function validateReceipt(manifest, path, issues) {
  const receipt = manifest.receipt;
  const allowed = [
    'schema', 'author', 'attachedAtRuntime', 'fields', 'allowedStatus',
    'tokenCountsOnly', 'payloadExclusions',
  ];
  if (!closedKeys(receipt, allowed, issues, path, 'EXECUTION_AUTHORITY_RECEIPT_CONTRACT_INVALID')) return;
  if (
    receipt.schema !== 'durable-execution-receipt/v1' ||
    receipt.author !== 'TRUSTED_LEDGER_REQUIRED_AT_TASK_6_CUTOVER' ||
    receipt.attachedAtRuntime !== false ||
    !exactArray(receipt.fields, RECEIPT_FIELDS) ||
    !exactArray(receipt.allowedStatus, ['SETTLED']) ||
    receipt.tokenCountsOnly !== true ||
    !exactArray(receipt.payloadExclusions, PAYLOAD_EXCLUSIONS)
  ) {
    issues.push(issue('EXECUTION_AUTHORITY_RECEIPT_CONTRACT_INVALID', path, 'receipt must be closed, ledger-authored at cutover and payload-free'));
  }
  const disposition = manifest.resultDisposition;
  if (!closedKeys(
    disposition,
    ['schema', 'kinds', 'automaticPhysicalRetryAllowed', 'unknownStatus', 'controlStatus', 'replayStatus'],
    issues,
    path,
    'EXECUTION_AUTHORITY_RESULT_DISPOSITION_INVALID',
  )) return;
  if (
    disposition.schema !== 'execution-result-disposition/v1' ||
    !exactArray(disposition.kinds, ['valid_output', 'result_unknown', 'control_error', 'replay_error']) ||
    disposition.automaticPhysicalRetryAllowed !== false ||
    disposition.unknownStatus !== 'RESULT_UNKNOWN' ||
    disposition.controlStatus !== 'RELEASED' ||
    disposition.replayStatus !== 'SETTLED'
  ) issues.push(issue('EXECUTION_AUTHORITY_RESULT_DISPOSITION_INVALID', path, 'result dispositions must prohibit automatic physical retries'));
}

function validateDomainAck(entry, path, issues, producerId) {
  const ack = entry.domainAck;
  const allowed = [
    'mode', 'consumer', 'domainAggregateType', 'identitySource',
    'subjectRefRequired', 'personalDataDsrCompatible',
  ];
  if (!closedKeys(ack, allowed, issues, path, 'EXECUTION_AUTHORITY_DOMAIN_ACK_INVALID')) {
    issues.push(issue('EXECUTION_AUTHORITY_DOMAIN_ACK_INVALID', path, `invalid ACK contract ${producerId}`, producerId));
    return;
  }
  const bounded = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
  if (
    ack.mode !== 'CONTRACT_DECLARED_NOT_WIRED' ||
    !bounded(ack.consumer) || !bounded(ack.domainAggregateType) ||
    !bounded(ack.identitySource) || typeof ack.subjectRefRequired !== 'boolean' ||
    typeof ack.personalDataDsrCompatible !== 'boolean'
  ) issues.push(issue('EXECUTION_AUTHORITY_DOMAIN_ACK_INVALID', path, `incomplete ACK contract ${producerId}`, producerId));
  const personal = entry.privacyClass === 'PERSONAL_DATA';
  if (
    personal &&
    (ack.subjectRefRequired !== true || ack.personalDataDsrCompatible !== true)
  ) issues.push(issue('EXECUTION_AUTHORITY_PERSONAL_DATA_ACK_INVALID', path, `PERSONAL_DATA ACK requires hashed subject/DSR compatibility ${producerId}`, producerId));
}

function validateTools(manifest, path, issues) {
  if (!Array.isArray(manifest.tools)) return;
  const ids = manifest.tools.map((entry) => entry?.id).filter(Boolean);
  if (!sameSet(ids, EXPECTED_TOOL_IDS) || new Set(ids).size !== EXPECTED_TOOL_IDS.length) {
    issues.push(issue('EXECUTION_AUTHORITY_TOOL_INVENTORY_MISMATCH', path, 'manifest must declare exactly 18 registered Tools'));
  }
  const allowed = [
    'id', 'declarationPath', 'resultStrategy', 'resultSchema',
    'operationIdentity', 'privacyClass', 'resultConstraints',
    'costConstraints', 'domainAck',
  ];
  for (const entry of manifest.tools) {
    const id = entry?.id ?? '<unknown>';
    closedKeys(entry, allowed, issues, path, 'EXECUTION_AUTHORITY_TOOL_DECLARATION_INVALID');
    if (
      !EXPECTED_TOOL_IDS.includes(id) || !TOOL_SOURCE_PATHS.includes(entry?.declarationPath) ||
      !['typed_projection', 'artifact_reference'].includes(entry?.resultStrategy) ||
      typeof entry?.resultSchema !== 'string' || typeof entry?.operationIdentity !== 'string' ||
      !entry.operationIdentity.startsWith(`tool:${id}:`) || !PRIVACY_CLASSES.has(entry?.privacyClass)
    ) issues.push(issue('EXECUTION_AUTHORITY_TOOL_DECLARATION_INVALID', path, `invalid Tool declaration ${id}`, id));
    validateDomainAck(entry, path, issues, id);
    if (id === 'google_patents.search') {
      const result = entry.resultConstraints;
      const cost = entry.costConstraints;
      if (
        !isRecord(result) || result.maxRowsPerOperation !== 25 ||
        result.maxApplicantsPerPatent !== 32 || result.maxInventorsPerPatent !== 25 ||
        result.typedProjectionMaxPatents !== 2000 || result.rawBigQueryRowsRetained !== false ||
        !exactArray(result.inventorFields, ['name']) ||
        !sameSet(Object.keys(result), [
          'maxRowsPerOperation', 'maxApplicantsPerPatent',
          'maxInventorsPerPatent', 'typedProjectionMaxPatents',
          'rawBigQueryRowsRetained', 'inventorFields',
        ])
      ) issues.push(issue('EXECUTION_AUTHORITY_PATENT_RESULT_CONTRACT_INVALID', path, 'Patent Cache result constraints do not match current bounded path', id));
      if (
        !isRecord(cost) || cost.configuredDefaultMaximumBytesBilled !== '214748364800' ||
        cost.requiredMaximumBytesBilledAtCutover !== '214748364800' ||
        cost.runtimeHardMaximumBytesBilled !== null ||
        cost.runtimeOverrideStatus !== 'UNBOUNDED_PRE_CUTOVER' ||
        cost.costBasis !== 'estimated_upper_bound' ||
        cost.providerReportedBytesOptional !== true || cost.realBigQueryInTests !== false ||
        !sameSet(Object.keys(cost), [
          'configuredDefaultMaximumBytesBilled',
          'requiredMaximumBytesBilledAtCutover',
          'runtimeHardMaximumBytesBilled', 'runtimeOverrideStatus', 'costBasis',
          'providerReportedBytesOptional', 'realBigQueryInTests',
        ])
      ) issues.push(issue('EXECUTION_AUTHORITY_PATENT_COST_CONTRACT_INVALID', path, 'Patent Cache cost contract must expose the unbounded pre-cutover override and required Task 6 hard cap', id));
    }
  }
}

function validateModelTasks(manifest, path, issues) {
  if (!Array.isArray(manifest.modelTasks)) return;
  const ids = manifest.modelTasks.map((entry) => entry?.taskId).filter(Boolean);
  const expectedIds = EXPECTED_MODEL_TASKS.map((entry) => entry.taskId);
  if (!sameSet(ids, expectedIds) || new Set(ids).size !== expectedIds.length) {
    issues.push(issue('EXECUTION_AUTHORITY_MODEL_INVENTORY_MISMATCH', path, 'manifest must declare exactly 10 generic product Model tasks'));
  }
  const allowed = [
    'taskId', 'callsitePath', 'resultStrategy', 'resultSchema',
    'operationIdentity', 'privacyClass', 'domainAck',
  ];
  for (const entry of manifest.modelTasks) {
    const taskId = entry?.taskId ?? '<unknown>';
    const expected = EXPECTED_MODEL_TASKS.find((candidate) => candidate.taskId === taskId);
    closedKeys(entry, allowed, issues, path, 'EXECUTION_AUTHORITY_MODEL_DECLARATION_INVALID');
    if (
      !expected || entry.callsitePath !== expected.path ||
      entry.resultStrategy !== 'typed_projection' || entry.resultSchema !== expected.schema ||
      typeof entry.operationIdentity !== 'string' ||
      !entry.operationIdentity.startsWith(`model:${taskId}:`) ||
      !PRIVACY_CLASSES.has(entry.privacyClass)
    ) issues.push(issue('EXECUTION_AUTHORITY_MODEL_DECLARATION_INVALID', path, `invalid Model declaration ${taskId}`, taskId));
    validateDomainAck(entry, path, issues, taskId);
  }
}

function validateArtifacts(manifest, path, issues) {
  if (!Array.isArray(manifest.artifactSchemas)) return;
  const schemas = manifest.artifactSchemas.map((entry) => entry?.schema).filter(Boolean);
  if (!sameSet(schemas, Object.keys(ARTIFACT_CONTRACTS)) || new Set(schemas).size !== 4) {
    issues.push(issue('EXECUTION_AUTHORITY_ARTIFACT_INVENTORY_MISMATCH', path, 'manifest must declare exactly four artifact schemas'));
  }
  for (const entry of manifest.artifactSchemas) {
    const expected = ARTIFACT_CONTRACTS[entry?.schema];
    if (
      !expected || entry.artifactIdRequired !== true ||
      entry.privacyClass !== expected.privacyClass || entry.maxBytes !== expected.maxBytes ||
      entry.ttlSeconds !== expected.ttlSeconds || !exactArray(entry.mediaTypes, expected.mediaTypes) ||
      !sameSet(Object.keys(entry), ['schema', 'artifactIdRequired', 'privacyClass', 'mediaTypes', 'maxBytes', 'ttlSeconds'])
    ) issues.push(issue('EXECUTION_AUTHORITY_ARTIFACT_CONTRACT_INVALID', path, `invalid artifact contract ${entry?.schema ?? '<unknown>'}`));
  }
}

async function validateProtectedFiles(repoRoot, manifest, path, issues) {
  const wiring = manifest.physicalExecutionWiring;
  if (
    !closedKeys(wiring, ['status', 'protectedFiles'], issues, path, 'EXECUTION_AUTHORITY_WIRING_FENCE_INVALID') ||
    wiring.status !== 'NOT_WIRED' || !Array.isArray(wiring.protectedFiles)
  ) {
    issues.push(issue('EXECUTION_AUTHORITY_WIRING_FENCE_INVALID', path, 'physical execution wiring must remain NOT_WIRED'));
    return;
  }
  const protectedPaths = wiring.protectedFiles.map((entry) => entry?.path).filter(Boolean);
  if (
    !sameSet(protectedPaths, EXPECTED_PROTECTED_WIRING_PATHS) ||
    new Set(protectedPaths).size !== EXPECTED_PROTECTED_WIRING_PATHS.length
  ) {
    issues.push(issue('EXECUTION_AUTHORITY_WIRING_FENCE_INVALID', path, 'protected files must be the exact four Router/ToolBroker composition paths'));
  }
  for (const entry of wiring.protectedFiles) {
    if (
      !isRecord(entry) || !sameSet(Object.keys(entry), ['path', 'sha256']) ||
      typeof entry.path !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')
    ) {
      issues.push(issue('EXECUTION_AUTHORITY_WIRING_FENCE_INVALID', path, 'protected file entry is invalid'));
      continue;
    }
    const source = existsSync(resolve(repoRoot, entry.path)) ? await readText(repoRoot, entry.path) : null;
    if (source === null || sha256(source) !== entry.sha256) {
      issues.push(issue('EXECUTION_AUTHORITY_PHYSICAL_WIRING_DRIFT', entry.path, 'protected Router/ToolBroker composition changed before Task 6'));
    }
  }
}

function toolBlock(source, id) {
  const marker = `id: "${id}"`;
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const remainder = source.slice(start + marker.length);
  const next = remainder.search(/\n\s+id:\s*["'][a-z0-9_.]+["']/);
  return source.slice(start, next < 0 ? source.length : start + marker.length + next);
}

function numberConstants(source) {
  const values = new Map();
  for (const match of source.matchAll(/\b(?:export\s+)?const\s+([A-Z0-9_]+)\s*=\s*([0-9_]+)\s*;/g)) {
    const normalized = match[2].replaceAll('_', '');
    if (/^[0-9]+$/.test(normalized)) values.set(match[1], Number(normalized));
  }
  return values;
}

function stringConstants(source) {
  const values = new Map();
  for (const match of source.matchAll(/\b(?:export\s+)?const\s+([A-Z0-9_]+)\s*=\s*["']([^"']+)["'](?:\s+as\s+const)?\s*;/g)) {
    values.set(match[1], match[2]);
  }
  return values;
}

function resolveNumber(token, constants) {
  const normalized = token.replaceAll('_', '').trim();
  return /^[0-9]+$/.test(normalized) ? Number(normalized) : constants.get(token.trim());
}

function resolveString(token, constants) {
  const literal = token.trim().match(/^["']([^"']+)["']$/);
  return literal?.[1] ?? constants.get(token.trim());
}

function artifactSourceContract(block, completeSource) {
  const maxToken = block.match(/\bmaxBytes:\s*([A-Za-z0-9_]+)/)?.[1];
  const ttlToken = block.match(/\bttlSeconds:\s*([0-9_]+)/)?.[1];
  const mediaExpression = block.match(/\bmediaTypes:\s*\[([^\]]+)\]/)?.[1];
  if (!maxToken || !ttlToken || !mediaExpression) return null;
  const numbers = numberConstants(completeSource);
  const strings = stringConstants(completeSource);
  const mediaTypes = mediaExpression.split(',').map((token) => resolveString(token, strings));
  if (mediaTypes.some((entry) => typeof entry !== 'string')) return null;
  return Object.freeze({
    maxBytes: resolveNumber(maxToken, numbers),
    mediaTypes,
    privacyClass: block.match(/\bprivacyClass:\s*["']([^"']+)["']/)?.[1],
    ttlSeconds: resolveNumber(ttlToken, numbers),
  });
}

async function scanCurrentSources(repoRoot, manifest, issues) {
  const toolSources = await Promise.all(TOOL_SOURCE_PATHS.map((path) => readText(repoRoot, path)));
  const source = toolSources.join('\n');
  const sourceIds = [...source.matchAll(/\bid:\s*["']([a-z0-9_.]+)["']/g)].map((match) => match[1]);
  const registrationCount = [...source.matchAll(/\bregistry\.register\s*\(/g)].length;
  if (!sameSet(sourceIds, EXPECTED_TOOL_IDS) || new Set(sourceIds).size !== 18 || registrationCount !== 18) {
    issues.push(issue('EXECUTION_AUTHORITY_TOOL_SOURCE_INVENTORY_MISMATCH', 'apps/api/src/tools', 'source declarations/registrations must be exactly 18'));
  }
  const projectionSources = [
    await readText(repoRoot, 'apps/api/src/durable-results/catalog-result-projections.ts'),
    await readText(repoRoot, 'apps/api/src/durable-results/source-result-projections.ts'),
  ].join('\n');
  for (const entry of manifest.tools ?? []) {
    const declarationSource = await readText(repoRoot, entry.declarationPath);
    const block = toolBlock(declarationSource, entry.id);
    if (!block.includes('durableResultStrategy') || !block.includes(`kind: "${entry.resultStrategy}"`)) {
      issues.push(issue('EXECUTION_AUTHORITY_TOOL_STRATEGY_SOURCE_MISMATCH', entry.declarationPath, `source strategy mismatch ${entry.id}`, entry.id));
    }
    if (entry.resultStrategy === 'artifact_reference') {
      const expected = ARTIFACT_CONTRACTS[entry.resultSchema];
      const actual = artifactSourceContract(block, source);
      if (
        !block.includes(`schema: "${entry.resultSchema}"`) || !expected || !actual ||
        actual.maxBytes !== expected.maxBytes || actual.privacyClass !== expected.privacyClass ||
        actual.ttlSeconds !== expected.ttlSeconds || !exactArray(actual.mediaTypes, expected.mediaTypes)
      ) {
        issues.push(issue('EXECUTION_AUTHORITY_TOOL_SCHEMA_SOURCE_MISMATCH', entry.declarationPath, `artifact schema mismatch ${entry.id}`, entry.id));
      }
    } else {
      const sourceBinding =
        block.includes(`["${entry.id}"]`) || block.includes(`['${entry.id}']`) ||
        block.includes(`schema: "${entry.resultSchema}"`) || block.includes(`schema: '${entry.resultSchema}'`);
      if (!sourceBinding || !projectionSources.includes(`'${entry.id}': '${entry.resultSchema}'`)) {
        issues.push(issue('EXECUTION_AUTHORITY_TOOL_SCHEMA_SOURCE_MISMATCH', entry.declarationPath, `typed projection mapping mismatch ${entry.id}`, entry.id));
      }
    }
  }
  const genericSources = (await listFiles(repoRoot, 'apps/api/src'))
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.spec.ts'))
    .filter((path) => !path.startsWith('apps/api/src/site-builder/'));
  const discoveredModelTasks = new Set();
  for (const path of genericSources) {
    const content = await readText(repoRoot, path);
    for (const match of content.matchAll(/\bgetTask\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      discoveredModelTasks.add(match[1]);
    }
  }
  if (!sameSet(discoveredModelTasks, EXPECTED_MODEL_TASKS.map((entry) => entry.taskId))) {
    issues.push(issue('EXECUTION_AUTHORITY_MODEL_SOURCE_INVENTORY_MISMATCH', 'apps/api/src', 'generic product Model task inventory drifted from the closed registry'));
  }
  const modelBoundaryCalls = [];
  const toolPhysicalCalls = [];
  const nonToolInvokeBoundaries = [];
  const allProductSources = (await listFiles(repoRoot, 'apps/api/src'))
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.spec.ts'))
    .filter((path) => !path.startsWith('apps/api/src/model-gateway/'));
  for (const path of allProductSources) {
    const content = await readText(repoRoot, path);
    const analysis = analyzeTypeScript(path, content);
    const ordinals = new Map();
    for (const call of analysis.modelCalls) {
      const method = call.method;
      const ordinal = (ordinals.get(method) ?? 0) + 1;
      ordinals.set(method, ordinal);
      modelBoundaryCalls.push(`${path}#${method}#${ordinal}`);
    }
    const toolOrdinals = new Map();
    for (const call of analysis.toolCalls) {
      const ordinal = (toolOrdinals.get(call.toolId) ?? 0) + 1;
      toolOrdinals.set(call.toolId, ordinal);
      toolPhysicalCalls.push(`${path}#${call.toolId}#${ordinal}`);
      if (!EXPECTED_TOOL_IDS.includes(call.toolId)) {
        issues.push(issue('EXECUTION_AUTHORITY_UNREGISTERED_TOOL_CALL', path, `uncatalogued ToolBroker call ${call.toolId}`, call.toolId));
      }
    }
    const dynamicOrdinals = new Map();
    for (const call of analysis.dynamicInvokes) {
      const ordinal = (dynamicOrdinals.get(call.receiver) ?? 0) + 1;
      dynamicOrdinals.set(call.receiver, ordinal);
      nonToolInvokeBoundaries.push(`${path}#${call.receiver}#${ordinal}`);
    }
  }
  if (!sameSet(toolPhysicalCalls, EXPECTED_TOOL_CALLSITES)) {
    const expected = new Set(EXPECTED_TOOL_CALLSITES);
    const actual = new Set(toolPhysicalCalls);
    for (const key of sorted(actual).filter((entry) => !expected.has(entry))) {
      issues.push(issue('EXECUTION_AUTHORITY_TOOL_CALLSITE_UNCATALOGUED', key.split('#')[0], `uncatalogued Tool physical callsite ${key}`, key.split('#')[1]));
    }
    for (const key of EXPECTED_TOOL_CALLSITES.filter((entry) => !actual.has(entry))) {
      issues.push(issue('EXECUTION_AUTHORITY_TOOL_CALLSITE_MISSING', key.split('#')[0], `missing Tool physical callsite ${key}`, key.split('#')[1]));
    }
  }
  if (!sameSet(nonToolInvokeBoundaries, EXPECTED_NON_TOOL_INVOKE_BOUNDARIES)) {
    const expected = new Set(EXPECTED_NON_TOOL_INVOKE_BOUNDARIES);
    const actual = new Set(nonToolInvokeBoundaries);
    for (const key of sorted(actual).filter((entry) => !expected.has(entry))) {
      issues.push(issue('EXECUTION_AUTHORITY_DYNAMIC_INVOKE_UNCLASSIFIED', key.split('#')[0], `dynamic invoke is not an approved non-Tool boundary ${key}`));
    }
    for (const key of EXPECTED_NON_TOOL_INVOKE_BOUNDARIES.filter((entry) => !actual.has(entry))) {
      issues.push(issue('EXECUTION_AUTHORITY_NON_TOOL_BOUNDARY_MISSING', key.split('#')[0], `missing approved non-Tool invoke boundary ${key}`));
    }
  }
  if (!sameSet(modelBoundaryCalls, EXPECTED_MODEL_GATEWAY_BOUNDARIES)) {
    const expected = new Set(EXPECTED_MODEL_GATEWAY_BOUNDARIES);
    const actual = new Set(modelBoundaryCalls);
    for (const key of sorted(actual).filter((entry) => !expected.has(entry))) {
      issues.push(issue('EXECUTION_AUTHORITY_DIRECT_MODEL_GATEWAY_CALL', key.split('#')[0], `uncatalogued ModelGateway boundary ${key}`));
    }
    for (const key of EXPECTED_MODEL_GATEWAY_BOUNDARIES.filter((entry) => !actual.has(entry))) {
      issues.push(issue('EXECUTION_AUTHORITY_MODEL_GATEWAY_BOUNDARY_MISSING', key.split('#')[0], `missing ModelGateway boundary ${key}`));
    }
  }
  const modelProjectionSource = await readText(repoRoot, 'apps/api/src/durable-results/model-result-projections.ts');
  for (const entry of EXPECTED_MODEL_TASKS) {
    const callsite = await readText(repoRoot, entry.path);
    if (!callsite.includes(entry.taskId)) {
      issues.push(issue('EXECUTION_AUTHORITY_MODEL_CALLSITE_MISSING', entry.path, `missing Model task anchor ${entry.taskId}`, entry.taskId));
    }
    if (!modelProjectionSource.includes(`'${entry.taskId}': '${entry.schema}'`)) {
      issues.push(issue('EXECUTION_AUTHORITY_MODEL_SCHEMA_SOURCE_MISMATCH', 'apps/api/src/durable-results/model-result-projections.ts', `missing Model projection ${entry.taskId}`, entry.taskId));
    }
  }
  const receiptSource = existsSync(resolve(repoRoot, RECEIPT_PATH)) ? await readText(repoRoot, RECEIPT_PATH) : '';
  const ackSource = existsSync(resolve(repoRoot, ACK_PATH)) ? await readText(repoRoot, ACK_PATH) : '';
  for (const token of ['status', 'SETTLED', 'parseDurableExecutionReceipt', 'artifactId', 'costBasis']) {
    if (!receiptSource.includes(token)) issues.push(issue('EXECUTION_AUTHORITY_RECEIPT_SCHEMA_MISSING', RECEIPT_PATH, `receipt contract missing ${token}`));
  }
  for (const token of ['parseDomainAckContract', 'parseExecutionResultDisposition', 'PERSONAL_DATA', 'subjectIdHash', 'automaticPhysicalRetryAllowed']) {
    if (!ackSource.includes(token)) issues.push(issue('EXECUTION_AUTHORITY_DOMAIN_ACK_SCHEMA_MISSING', ACK_PATH, `ACK contract missing ${token}`));
  }
  const artifactRegistry = await readText(repoRoot, 'apps/api/src/durable-results/artifact/artifact-materializer.registry.ts');
  for (const schema of Object.keys(ARTIFACT_CONTRACTS)) {
    if (!artifactRegistry.includes(`'${schema}'`) && !artifactRegistry.includes(`"${schema}"`)) {
      issues.push(issue('EXECUTION_AUTHORITY_ARTIFACT_MATERIALIZER_MISSING', 'apps/api/src/durable-results/artifact/artifact-materializer.registry.ts', `missing artifact materializer ${schema}`));
    }
  }
  const patentScanner = await readText(repoRoot, 'apps/api/src/temporal/patent-cache-broker-scanner.ts');
  const patentAdapter = await readText(repoRoot, 'apps/api/src/adapters/bigquery-patents.ts');
  const patentProjectionSpec = await readText(repoRoot, 'apps/api/src/durable-results/catalog-result-projections.spec.ts');
  const patentRequired = [
    [patentScanner, 'const MAX_PATENTS_PER_ANCHOR = 25'],
    [patentScanner, '"google_patents.search"'],
    [patentAdapter, 'const DEFAULT_MAX_GB = 200'],
    [patentAdapter, 'this.deps.maxGb ??'],
    [patentAdapter, 'MAX_APPLICANTS_PER_PATENT = 32'],
    [patentProjectionSpec, "'$.data.patents.maxItems': 2000"],
    [patentProjectionSpec, "'$.data.patents[].inventors.maxItems': 25"],
  ];
  if (patentRequired.some(([text, token]) => !text.includes(token))) {
    issues.push(issue('EXECUTION_AUTHORITY_PATENT_SOURCE_CONSTRAINT_MISMATCH', 'apps/api/src', 'Patent Cache source constraints drifted from manifest', 'google_patents.search'));
  }
  const patentsActivity = await readText(repoRoot, 'apps/api/src/temporal/patents-cache.activities.ts');
  if (!patentsActivity.includes('createPatentCacheBrokerScanner')) {
    issues.push(issue('EXECUTION_AUTHORITY_PATENT_BROKER_ROUTE_MISSING', 'apps/api/src/temporal/patents-cache.activities.ts', 'Patent Cache activity must retain the broker scanner route', 'google_patents.search'));
  }
  const bigQueryAllowed = new Set([
    'apps/api/src/adapters/bigquery-patents.ts',
    'apps/api/src/tools/source-tools.ts',
  ]);
  for (const path of (await listFiles(repoRoot, 'apps/api/src'))
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))) {
    if (bigQueryAllowed.has(path)) continue;
    const analysis = analyzeTypeScript(path, await readText(repoRoot, path));
    if (analysis.importsGoogleBigQuery || analysis.constructsBigQuery) {
      issues.push(issue('EXECUTION_AUTHORITY_DIRECT_BIGQUERY_BYPASS', path, 'BigQuery physical access is allowed only inside the google_patents.search Tool adapter', 'google_patents.search'));
    }
  }
  return Object.freeze({
    modelGatewayBoundaryCount: modelBoundaryCalls.length,
    physicalToolCallsiteCount: toolPhysicalCalls.length,
    modelGatewayBoundaries: Object.freeze(sorted(modelBoundaryCalls)),
    physicalToolCallsites: Object.freeze(sorted(toolPhysicalCalls)),
  });
}

function validateManagedAdapters(manifest, path, issues) {
  const entries = manifest.managedExternalAdapters;
  if (
    !Array.isArray(entries) || entries.length !== 1 ||
    !sameSet(Object.keys(entries[0] ?? {}), [
      'adapter', 'managedPath', 'requiredBrokerTool', 'directPhysicalCalls',
      'testExecution',
    ]) ||
    entries[0].adapter !== 'google_patents.bigquery' ||
    entries[0].managedPath !== 'apps/api/src/temporal/patent-cache-broker-scanner.ts' ||
    entries[0].requiredBrokerTool !== 'google_patents.search' ||
    entries[0].directPhysicalCalls !== 'DISALLOWED_IN_MANAGED_ACTIVITY' ||
    entries[0].testExecution !== 'NO_REAL_BIGQUERY'
  ) issues.push(issue('EXECUTION_AUTHORITY_MANAGED_ADAPTER_INVALID', path, 'managed BigQuery adapter declaration is incomplete', 'google_patents.search'));
}

export async function verifyExecutionAuthorityPolicy(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const issues = [];
  let manifest = options.manifest;
  if (manifest === undefined && !existsSync(resolve(repoRoot, manifestPath))) {
    missingManifestInventory(manifestPath, issues);
    return Object.freeze({
      ok: false,
      issues: Object.freeze(issues),
      toolCount: 0,
      modelTaskCount: 0,
      physicalExecutionWiring: 'UNKNOWN',
      physicalToolCallsiteCount: 0,
      modelGatewayBoundaryCount: 0,
      physicalToolCallsites: Object.freeze([]),
      modelGatewayBoundaries: Object.freeze([]),
    });
  }
  try {
    if (manifest === undefined) manifest = await readJson(repoRoot, manifestPath);
  } catch (error) {
    issues.push(issue('EXECUTION_AUTHORITY_MANIFEST_INVALID', manifestPath, error instanceof Error ? error.message : String(error)));
    return Object.freeze({ ok: false, issues: Object.freeze(issues), toolCount: 0, modelTaskCount: 0, physicalExecutionWiring: 'UNKNOWN', physicalToolCallsiteCount: 0, modelGatewayBoundaryCount: 0, physicalToolCallsites: Object.freeze([]), modelGatewayBoundaries: Object.freeze([]) });
  }
  validateTopLevel(manifest, manifestPath, issues);
  validateReceipt(manifest, manifestPath, issues);
  validateTools(manifest, manifestPath, issues);
  validateModelTasks(manifest, manifestPath, issues);
  validateArtifacts(manifest, manifestPath, issues);
  validateManagedAdapters(manifest, manifestPath, issues);
  await validateProtectedFiles(repoRoot, manifest, manifestPath, issues);
  const callsites = await scanCurrentSources(repoRoot, manifest, issues);
  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues),
    toolCount: Array.isArray(manifest.tools) ? manifest.tools.length : 0,
    modelTaskCount: Array.isArray(manifest.modelTasks) ? manifest.modelTasks.length : 0,
    physicalExecutionWiring: manifest.physicalExecutionWiring?.status ?? 'UNKNOWN',
    physicalToolCallsiteCount: callsites.physicalToolCallsiteCount,
    modelGatewayBoundaryCount: callsites.modelGatewayBoundaryCount,
    physicalToolCallsites: callsites.physicalToolCallsites,
    modelGatewayBoundaries: callsites.modelGatewayBoundaries,
  });
}

function render(result) {
  if (result.ok) {
    return `execution-authority-policy: PASS tools=${result.toolCount} modelTasks=${result.modelTaskCount} toolCallsites=${result.physicalToolCallsiteCount} modelGatewayBoundaries=${result.modelGatewayBoundaryCount} physicalExecutionWiring=${result.physicalExecutionWiring}\n`;
  }
  const lines = ['execution-authority-policy: FAIL'];
  for (const entry of result.issues) {
    lines.push(`${entry.code}\t${entry.path}\t${entry.producerId ?? '-'}\t${entry.message}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const command = process.argv[2] ?? 'verify';
  if (command !== 'verify') throw new Error(`unknown command: ${command}`);
  const result = await verifyExecutionAuthorityPolicy();
  process.stdout.write(render(result));
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
