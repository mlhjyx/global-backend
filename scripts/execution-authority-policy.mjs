import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
        !exactArray(result.inventorFields, ['name'])
      ) issues.push(issue('EXECUTION_AUTHORITY_PATENT_RESULT_CONTRACT_INVALID', path, 'Patent Cache result constraints do not match current bounded path', id));
      if (
        !isRecord(cost) || cost.maximumBytesBilled !== '214748364800' ||
        cost.costBasis !== 'estimated_upper_bound' ||
        cost.providerReportedBytesOptional !== true || cost.realBigQueryInTests !== false
      ) issues.push(issue('EXECUTION_AUTHORITY_PATENT_COST_CONTRACT_INVALID', path, 'Patent Cache cost constraints must remain bounded and offline-tested', id));
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
  for (const entry of wiring.protectedFiles) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) {
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
  const next = source.indexOf('\n  id: "', start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
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
      if (!block.includes(`schema: "${entry.resultSchema}"`)) {
        issues.push(issue('EXECUTION_AUTHORITY_TOOL_SCHEMA_SOURCE_MISMATCH', entry.declarationPath, `artifact schema mismatch ${entry.id}`, entry.id));
      }
    } else if (!projectionSources.includes(`'${entry.id}': '${entry.resultSchema}'`)) {
      issues.push(issue('EXECUTION_AUTHORITY_TOOL_SCHEMA_SOURCE_MISMATCH', entry.declarationPath, `typed projection mapping mismatch ${entry.id}`, entry.id));
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
  const patentScanner = await readText(repoRoot, 'apps/api/src/temporal/patent-cache-broker-scanner.ts');
  const patentAdapter = await readText(repoRoot, 'apps/api/src/adapters/bigquery-patents.ts');
  const patentProjectionSpec = await readText(repoRoot, 'apps/api/src/durable-results/catalog-result-projections.spec.ts');
  const patentRequired = [
    [patentScanner, 'const MAX_PATENTS_PER_ANCHOR = 25'],
    [patentScanner, '"google_patents.search"'],
    [patentAdapter, 'const DEFAULT_MAX_GB = 200'],
    [patentAdapter, 'MAX_APPLICANTS_PER_PATENT = 32'],
    [patentProjectionSpec, "'$.data.patents.maxItems': 2000"],
    [patentProjectionSpec, "'$.data.patents[].inventors.maxItems': 25"],
  ];
  if (patentRequired.some(([text, token]) => !text.includes(token))) {
    issues.push(issue('EXECUTION_AUTHORITY_PATENT_SOURCE_CONSTRAINT_MISMATCH', 'apps/api/src', 'Patent Cache source constraints drifted from manifest', 'google_patents.search'));
  }
  const patentsActivity = await readText(repoRoot, 'apps/api/src/temporal/patents-cache.activities.ts');
  if (
    patentsActivity.includes("from '../adapters/bigquery-patents'") ||
    patentsActivity.includes('bigqueryPatents.') || patentScanner.includes('bigqueryPatents.')
  ) issues.push(issue('EXECUTION_AUTHORITY_DIRECT_BIGQUERY_BYPASS', 'apps/api/src/temporal', 'managed Patent Cache activity bypasses google_patents.search', 'google_patents.search'));
}

export async function verifyExecutionAuthorityPolicy(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const issues = [];
  let manifest;
  if (!existsSync(resolve(repoRoot, manifestPath))) {
    missingManifestInventory(manifestPath, issues);
    return Object.freeze({
      ok: false,
      issues: Object.freeze(issues),
      toolCount: 0,
      modelTaskCount: 0,
      physicalExecutionWiring: 'UNKNOWN',
    });
  }
  try {
    manifest = await readJson(repoRoot, manifestPath);
  } catch (error) {
    issues.push(issue('EXECUTION_AUTHORITY_MANIFEST_INVALID', manifestPath, error instanceof Error ? error.message : String(error)));
    return Object.freeze({ ok: false, issues: Object.freeze(issues), toolCount: 0, modelTaskCount: 0, physicalExecutionWiring: 'UNKNOWN' });
  }
  validateTopLevel(manifest, manifestPath, issues);
  validateReceipt(manifest, manifestPath, issues);
  validateTools(manifest, manifestPath, issues);
  validateModelTasks(manifest, manifestPath, issues);
  validateArtifacts(manifest, manifestPath, issues);
  await validateProtectedFiles(repoRoot, manifest, manifestPath, issues);
  await scanCurrentSources(repoRoot, manifest, issues);
  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues),
    toolCount: Array.isArray(manifest.tools) ? manifest.tools.length : 0,
    modelTaskCount: Array.isArray(manifest.modelTasks) ? manifest.modelTasks.length : 0,
    physicalExecutionWiring: manifest.physicalExecutionWiring?.status ?? 'UNKNOWN',
  });
}

function render(result) {
  if (result.ok) {
    return `execution-authority-policy: PASS tools=${result.toolCount} modelTasks=${result.modelTaskCount} physicalExecutionWiring=${result.physicalExecutionWiring}\n`;
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

