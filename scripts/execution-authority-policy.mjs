import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, "..");
const MANIFEST_PATH = "docs/governance/durable-result-strategies.json";

export const EXPECTED_TOOL_IDS = Object.freeze([
  "searxng.search",
  "crawl4ai.fetch",
  "wikidata.sparql",
  "osm.overpass",
  "smtp.rcpt_probe",
  "crawl4ai.render",
  "http.get",
  "wikidata.entity",
  "gleif.fetch",
  "ted.search",
  "openfda.search",
  "companies_house.search",
  "inpi_rne.search",
  "google_patents.search",
  "tradefair.algolia",
  "mapyourshow.fetch",
  "samgov.search",
  "sanctions.download",
]);

export const EXPECTED_MODEL_TASKS = Object.freeze([
  ["apps/api/src/temporal/understanding.activities.ts", "company_understanding.extract_claims", "understanding-claims/v1"],
  ["apps/api/src/temporal/understanding.activities.ts", "company_understanding.extract_profile", "understanding-profile/v1"],
  ["apps/api/src/temporal/understanding.activities.ts", "company_understanding.extract_offerings", "understanding-offerings/v1"],
  ["apps/api/src/icp/icp.service.ts", "icp.design", "icp-design/v1"],
  ["apps/api/src/icp/icp.service.ts", "discovery.query_plan", "icp-query-plan/v1"],
  ["apps/api/src/discovery/taxonomy-resolver.ts", "taxonomy.normalize", "taxonomy-code/v1"],
  ["apps/api/src/discovery/fit-judge.ts", "discovery.qualify_fit", "fit-judgment/v1"],
  ["apps/api/src/discovery/providers/public-web.provider.ts", "discovery.extract_company", "discovery-extract-company/v1"],
  ["apps/api/src/discovery/providers/directory.provider.ts", "discovery.extract_list", "discovery-extract-list/v1"],
  ["apps/api/src/discovery/providers/decision-maker.provider.ts", "contact.find_decision_makers", "contact-decision-makers/v1"],
]);

const REQUIRED_ARTIFACT_SCHEMAS = Object.freeze([
  "sanctions-download/v1",
  "http-get/v1",
  "crawl4ai-fetch/v1",
  "crawl4ai-render/v1",
]);

const RECEIPT_FIELDS = Object.freeze([
  "operationId",
  "operationKey",
  "resultStrategy",
  "resultSchema",
  "resultDigest",
  "artifactId",
  "usage",
  "costBasis",
]);

function issue(code, path, message) {
  return Object.freeze({ code, path, message });
}

async function readText(repoRoot, path) {
  return readFile(resolve(repoRoot, path), "utf8");
}

async function readJson(repoRoot, path) {
  return JSON.parse(await readText(repoRoot, path));
}

function extractToolIds(source) {
  return [...source.matchAll(/\bid:\s*"([a-z0-9_.]+)"/g)].map((match) => match[1]);
}

function hasNeedle(source, needle) {
  return source.includes(needle);
}

function sorted(values) {
  return [...values].sort();
}

async function listFiles(root, relative = "") {
  const dir = resolve(root, relative);
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...await listFiles(root, child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

function validateClosedTopLevelObject(value, path, allowedKeys, issues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(issue("EXECUTION_AUTHORITY_MANIFEST_INVALID", path, "manifest must be a JSON object"));
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      issues.push(issue("EXECUTION_AUTHORITY_MANIFEST_UNKNOWN_FIELD", path, `unknown top-level field ${key}`));
    }
  }
  return true;
}

function validateManifestShape(manifest, issues) {
  const allowed = [
    "schemaVersion",
    "cutoverFence",
    "receipt",
    "tools",
    "modelTasks",
    "artifactSchemas",
    "managedExternalAdapters",
  ];
  if (!validateClosedTopLevelObject(manifest, MANIFEST_PATH, allowed, issues)) return;
  if (manifest.schemaVersion !== "execution-authority-policy/v1") {
    issues.push(issue("EXECUTION_AUTHORITY_MANIFEST_INVALID", MANIFEST_PATH, "schemaVersion must be execution-authority-policy/v1"));
  }
  if (manifest.cutoverFence !== "TASK_6_AUTHORITY_BOUND_PHYSICAL_EXECUTION_NOT_WIRED") {
    issues.push(issue("EXECUTION_AUTHORITY_CUTOVER_FENCE_INVALID", MANIFEST_PATH, "Task 6 physical execution cutover fence must remain declared"));
  }
  if (!manifest.receipt || typeof manifest.receipt !== "object" || Array.isArray(manifest.receipt)) {
    issues.push(issue("EXECUTION_AUTHORITY_RECEIPT_MANIFEST_MISSING", MANIFEST_PATH, "receipt contract is required"));
  } else {
    for (const field of RECEIPT_FIELDS) {
      if (!manifest.receipt.fields?.includes(field)) {
        issues.push(issue("EXECUTION_AUTHORITY_RECEIPT_FIELD_MISSING", MANIFEST_PATH, `receipt field missing: ${field}`));
      }
    }
    if (manifest.receipt.rejectsPayloadFields !== true) {
      issues.push(issue("EXECUTION_AUTHORITY_RECEIPT_PAYLOAD_GUARD_MISSING", MANIFEST_PATH, "receipt must reject body/prompt/raw response/credential/personal-data payload fields"));
    }
  }
  for (const key of ["tools", "modelTasks", "artifactSchemas", "managedExternalAdapters"]) {
    if (!Array.isArray(manifest[key])) {
      issues.push(issue("EXECUTION_AUTHORITY_MANIFEST_INVALID", MANIFEST_PATH, `${key} must be an array`));
    }
  }
}

function validateManifestCoverage(manifest, issues) {
  if (!manifest || typeof manifest !== "object") return;
  if (Array.isArray(manifest.tools)) {
    const manifestToolIds = sorted(manifest.tools.map((entry) => entry?.id).filter(Boolean));
    const expectedToolIds = sorted(EXPECTED_TOOL_IDS);
    if (manifestToolIds.join("\n") !== expectedToolIds.join("\n")) {
      issues.push(issue("EXECUTION_AUTHORITY_TOOL_INVENTORY_MISMATCH", MANIFEST_PATH, `manifest tool ids must exactly match ${EXPECTED_TOOL_IDS.length} registered tools`));
    }
    for (const entry of manifest.tools) {
      if (!entry || typeof entry !== "object") continue;
      if (!entry.id || !entry.resultStrategy || !entry.resultSchema) {
        issues.push(issue("EXECUTION_AUTHORITY_TOOL_DECLARATION_INCOMPLETE", MANIFEST_PATH, `tool declaration incomplete: ${entry.id ?? "<unknown>"}`));
      }
      if (!entry.operationIdentity || !entry.receipt || !entry.domainAck) {
        issues.push(issue("EXECUTION_AUTHORITY_TOOL_ACK_PATH_MISSING", MANIFEST_PATH, `tool lacks operation identity/receipt/domainAck path: ${entry.id ?? "<unknown>"}`));
      }
      if (entry.domainAck?.mode !== "ADDITIVE_ACK_REPOSITORY") {
        issues.push(issue("EXECUTION_AUTHORITY_DOMAIN_ACK_MODE_INVALID", MANIFEST_PATH, `tool must bind additive ACK repository path: ${entry.id ?? "<unknown>"}`));
      }
      if (entry.id === "google_patents.search") {
        if (entry.resultConstraints?.maxRows !== 50 || entry.domainAck?.identity !== "publicationNumber") {
          issues.push(issue("EXECUTION_AUTHORITY_PATENT_RESULT_CONTRACT_INVALID", MANIFEST_PATH, "google_patents.search must cap durable rows at 50 and ACK publicationNumber"));
        }
        if (
          entry.costConstraints?.maximumBytesBilled !== "214748364800" ||
          entry.costConstraints?.costBasis !== "estimated_upper_bound"
        ) {
          issues.push(issue("EXECUTION_AUTHORITY_PATENT_COST_CONTRACT_INVALID", MANIFEST_PATH, "google_patents.search must declare bounded estimated upper-bound BigQuery cost facts"));
        }
      }
    }
  }
  if (Array.isArray(manifest.modelTasks)) {
    const manifestTasks = sorted(manifest.modelTasks.map((entry) => entry?.taskId).filter(Boolean));
    const expectedTasks = sorted(EXPECTED_MODEL_TASKS.map(([, taskId]) => taskId));
    if (manifestTasks.join("\n") !== expectedTasks.join("\n")) {
      issues.push(issue("EXECUTION_AUTHORITY_MODEL_INVENTORY_MISMATCH", MANIFEST_PATH, `manifest model tasks must exactly match ${EXPECTED_MODEL_TASKS.length} product model tasks`));
    }
    for (const entry of manifest.modelTasks) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.resultStrategy !== "typed_projection" || !entry.resultSchema) {
        issues.push(issue("EXECUTION_AUTHORITY_MODEL_STRATEGY_MISSING", MANIFEST_PATH, `model task lacks typed strategy/schema: ${entry.taskId ?? "<unknown>"}`));
      }
      if (!entry.operationIdentity || !entry.receipt || !entry.domainAck) {
        issues.push(issue("EXECUTION_AUTHORITY_MODEL_ACK_PATH_MISSING", MANIFEST_PATH, `model task lacks operation identity/receipt/domainAck path: ${entry.taskId ?? "<unknown>"}`));
      }
      if (entry.domainAck?.mode !== "ADDITIVE_ACK_REPOSITORY") {
        issues.push(issue("EXECUTION_AUTHORITY_DOMAIN_ACK_MODE_INVALID", MANIFEST_PATH, `model task must bind additive ACK repository path: ${entry.taskId ?? "<unknown>"}`));
      }
    }
  }
  if (Array.isArray(manifest.artifactSchemas)) {
    const schemas = sorted(manifest.artifactSchemas.map((entry) => entry?.schema).filter(Boolean));
    if (schemas.join("\n") !== sorted(REQUIRED_ARTIFACT_SCHEMAS).join("\n")) {
      issues.push(issue("EXECUTION_AUTHORITY_ARTIFACT_SCHEMA_MISMATCH", MANIFEST_PATH, "artifact schema inventory must match materializer registry"));
    }
    for (const entry of manifest.artifactSchemas) {
      if (entry?.privacyClass !== "PERSONAL_DATA") {
        issues.push(issue("EXECUTION_AUTHORITY_ARTIFACT_PRIVACY_MISMATCH", MANIFEST_PATH, `artifact schema must stay PERSONAL_DATA: ${entry?.schema ?? "<unknown>"}`));
      }
    }
  }
}

async function scanToolSource(repoRoot, issues) {
  const source = [
    await readText(repoRoot, "apps/api/src/tools/builtin-tools.ts"),
    await readText(repoRoot, "apps/api/src/tools/source-tools.ts"),
  ].join("\n");
  const toolIds = sorted(extractToolIds(source));
  if (toolIds.join("\n") !== sorted(EXPECTED_TOOL_IDS).join("\n")) {
    issues.push(issue("EXECUTION_AUTHORITY_TOOL_SOURCE_INVENTORY_MISMATCH", "apps/api/src/tools", `source must register exactly ${EXPECTED_TOOL_IDS.length} tools`));
  }
  for (const toolId of EXPECTED_TOOL_IDS) {
    if (!source.includes(`id: "${toolId}"`)) {
      issues.push(issue("EXECUTION_AUTHORITY_TOOL_MISSING", "apps/api/src/tools", `missing tool ${toolId}`));
    }
    const idIndex = source.indexOf(`id: "${toolId}"`);
    const toolBlock = idIndex >= 0 ? source.slice(idIndex, idIndex + 2500) : "";
    if (!toolBlock.includes("durableResultStrategy")) {
      issues.push(issue("EXECUTION_AUTHORITY_TOOL_STRATEGY_SOURCE_MISMATCH", "apps/api/src/tools", `${toolId} must declare durableResultStrategy next to its Tool contract`));
    }
  }
}

async function scanModelSource(repoRoot, issues) {
  for (const [path, taskId, schema] of EXPECTED_MODEL_TASKS) {
    const source = await readText(repoRoot, path);
    if (!source.includes(taskId)) {
      issues.push(issue("EXECUTION_AUTHORITY_MODEL_CALLSITE_MISSING", path, `missing model task anchor ${taskId}`));
      continue;
    }
    if (!source.includes(`durableResultSchema: '${schema}'`) && !source.includes(`durableResultSchema: "${schema}"`)) {
      issues.push(issue("EXECUTION_AUTHORITY_MODEL_SCHEMA_BINDING_MISSING", path, `${taskId} must bind durableResultSchema ${schema}`));
    }
  }
}

async function scanReceiptSource(repoRoot, issues) {
  const path = "apps/api/src/durable-results/durable-execution-receipt.ts";
  if (!existsSync(resolve(repoRoot, path))) {
    issues.push(issue("EXECUTION_AUTHORITY_RECEIPT_PARSER_MISSING", path, "closed durable execution receipt parser is required"));
    return;
  }
  const source = await readText(repoRoot, path);
  for (const token of ["schemaVersion", "durable-execution-receipt/v1", "artifactId", "costBasis"]) {
    if (!hasNeedle(source, token)) {
      issues.push(issue("EXECUTION_AUTHORITY_RECEIPT_PARSER_INCOMPLETE", path, `receipt parser missing token ${token}`));
    }
  }
  for (const forbidden of ["prompt", "rawResponse", "responseBody", "credential", "email"]) {
    if (!source.includes(forbidden)) {
      issues.push(issue("EXECUTION_AUTHORITY_RECEIPT_PAYLOAD_GUARD_INCOMPLETE", path, `receipt parser must explicitly guard ${forbidden}`));
    }
  }
  for (const token of ["charged > upper", "bytesBilled", "maximumBytesBilled", "not_incurred", "token_pricing"]) {
    if (!source.includes(token)) {
      issues.push(issue("EXECUTION_AUTHORITY_RECEIPT_SEMANTICS_INCOMPLETE", path, `receipt parser must enforce cost semantic token ${token}`));
    }
  }
}

async function scanDomainAckSource(repoRoot, issues) {
  const path = "apps/api/src/durable-results/domain-ack.ts";
  if (!existsSync(resolve(repoRoot, path))) {
    issues.push(issue("EXECUTION_AUTHORITY_DOMAIN_ACK_SERVICE_MISSING", path, "additive Domain ACK service/repository is required"));
    return;
  }
  const source = await readText(repoRoot, path);
  for (const token of ["DomainAckService", "InMemoryDomainAckRepository", "applyWithAck", "DOMAIN_ACK_CONFLICT", "parseDurableExecutionReceipt"]) {
    if (!source.includes(token)) {
      issues.push(issue("EXECUTION_AUTHORITY_DOMAIN_ACK_SERVICE_INCOMPLETE", path, `Domain ACK service missing ${token}`));
    }
  }
}

async function scanArtifactSource(repoRoot, issues) {
  const source = await readText(repoRoot, "apps/api/src/durable-results/artifact/artifact-materializer.registry.ts");
  for (const schema of REQUIRED_ARTIFACT_SCHEMAS) {
    if (!source.includes(`'${schema}'`) && !source.includes(`"${schema}"`)) {
      issues.push(issue("EXECUTION_AUTHORITY_ARTIFACT_MATERIALIZER_MISSING", "apps/api/src/durable-results/artifact/artifact-materializer.registry.ts", `missing artifact materializer schema ${schema}`));
    }
  }
}

async function scanExternalAdapterBypasses(repoRoot, issues) {
  const sourceFiles = (await listFiles(repoRoot, "apps/api/src"))
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".spec.ts"));
  for (const path of sourceFiles) {
    if (path === "apps/api/src/adapters/bigquery-patents.ts") continue;
    if (path === "apps/api/src/tools/source-tools.ts") continue;
    const source = await readText(repoRoot, path);
    if (/@google-cloud\/bigquery|new BigQuery|bigqueryPatents\.(search|refresh|scan|searchPatentsByAssignee)/.test(source)) {
      issues.push(issue("EXECUTION_AUTHORITY_DIRECT_BIGQUERY_BYPASS", path, "managed product path must invoke google_patents.search through ToolBroker"));
    }
  }
}

async function scanGenericReplay(repoRoot, issues) {
  const sourceFiles = (await listFiles(repoRoot, "apps/api/src"))
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".spec.ts"));
  for (const path of sourceFiles) {
    const source = await readText(repoRoot, path);
    if (source.includes("genericReplay")) {
      issues.push(issue("EXECUTION_AUTHORITY_GENERIC_REPLAY_UNCLASSIFIED", path, "genericReplay is not allowed on product source paths"));
    }
  }
}

export async function verifyExecutionAuthorityPolicy(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const issues = [];
  let manifest = null;
  if (!existsSync(resolve(repoRoot, MANIFEST_PATH))) {
    issues.push(issue("EXECUTION_AUTHORITY_MANIFEST_MISSING", MANIFEST_PATH, "durable result strategy manifest is required"));
  } else {
    try {
      manifest = await readJson(repoRoot, MANIFEST_PATH);
      validateManifestShape(manifest, issues);
      validateManifestCoverage(manifest, issues);
    } catch (error) {
      issues.push(issue("EXECUTION_AUTHORITY_MANIFEST_INVALID", MANIFEST_PATH, error instanceof Error ? error.message : String(error)));
    }
  }

  await scanToolSource(repoRoot, issues);
  await scanModelSource(repoRoot, issues);
  await scanReceiptSource(repoRoot, issues);
  await scanDomainAckSource(repoRoot, issues);
  await scanArtifactSource(repoRoot, issues);
  await scanExternalAdapterBypasses(repoRoot, issues);
  await scanGenericReplay(repoRoot, issues);

  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues),
  });
}

function render(result) {
  if (result.ok) return "execution-authority-policy: PASS\n";
  const lines = ["execution-authority-policy: FAIL"];
  for (const item of result.issues) {
    lines.push(`${item.code}\t${item.path}\t${item.message}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const command = process.argv[2] ?? "verify";
  if (command !== "verify") {
    throw new Error(`unknown command: ${command}`);
  }
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
