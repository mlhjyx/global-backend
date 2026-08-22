import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  EXPECTED_MODEL_TASKS,
  EXPECTED_TOOL_IDS,
  verifyExecutionAuthorityPolicy,
} from "./execution-authority-policy.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function copyFileToTemp(tempRoot, relativePath, mutate = (value) => value) {
  const source = await readFile(join(repositoryRoot, relativePath), "utf8");
  const target = join(tempRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, mutate(source), "utf8");
}

async function materializePolicyRepo(mutations = {}) {
  const tempRoot = await mkdtemp(join(tmpdir(), "execution-authority-policy-"));
  const requiredFiles = new Set([
    "docs/governance/durable-result-strategies.json",
    "apps/api/src/tools/builtin-tools.ts",
    "apps/api/src/tools/source-tools.ts",
    "apps/api/src/tools/tool-broker.ts",
    "apps/api/src/tools/budget-store.ts",
    "apps/api/src/durable-results/durable-execution-receipt.ts",
    "apps/api/src/durable-results/domain-ack.ts",
    "apps/api/src/durable-results/domain-ack-consumer-bindings.ts",
    "apps/api/src/durable-results/artifact/artifact-materializer.registry.ts",
    "apps/api/src/durable-results/artifact/materializers/crawl4ai.materializer.ts",
    "apps/api/src/durable-results/artifact/materializers/http-get.materializer.ts",
    "apps/api/src/durable-results/artifact/materializers/sanctions-download.materializer.ts",
    "apps/api/src/durable-results/artifact/materializers/crawl4ai.materializer.spec.ts",
    "apps/api/src/durable-results/artifact/materializers/http-get.materializer.spec.ts",
    "apps/api/src/durable-results/artifact/materializers/sanctions-download.materializer.spec.ts",
    "apps/api/src/temporal/patents-cache.activities.ts",
    "apps/api/src/temporal/discovery.activities.ts",
    "apps/api/src/temporal/understanding.activities.ts",
    "apps/api/src/sanctions/sanctions-refresh.service.ts",
    "apps/api/src/signals/signal-ingest.service.ts",
    "apps/api/src/intent/intent-projection.service.ts",
    "apps/api/src/temporal/patent-cache-broker-scanner.ts",
    "apps/api/src/discovery/providers/bigquery-patents.provider.ts",
    "apps/api/src/discovery/providers/public-web.provider.ts",
    "apps/api/src/discovery/providers/directory.provider.ts",
    "apps/api/src/discovery/providers/decision-maker.provider.ts",
    "apps/api/src/icp/icp-budget-execution.ts",
    "packages/db/prisma/migrations/20260823000000_execution_domain_ack/migration.sql",
  ]);
  for (const [path] of EXPECTED_MODEL_TASKS) requiredFiles.add(path);
  for (const path of requiredFiles) {
    await copyFileToTemp(tempRoot, path, mutations[path]);
  }
  return tempRoot;
}

function codes(result) {
  return result.issues.map((item) => item.code);
}

test("policy inventory is locked to all current physical Tools and product model tasks", () => {
  assert.equal(EXPECTED_TOOL_IDS.length, 18);
  assert.equal(EXPECTED_MODEL_TASKS.length, 10);
  assert.deepEqual(new Set(EXPECTED_TOOL_IDS).size, EXPECTED_TOOL_IDS.length);
  assert.deepEqual(
    new Set(EXPECTED_MODEL_TASKS.map(([, taskId]) => taskId)).size,
    EXPECTED_MODEL_TASKS.length,
  );
});

test("current repository has a complete execution authority policy", async () => {
  const result = await verifyExecutionAuthorityPolicy({
    repoRoot: repositoryRoot,
  });
  assert.deepEqual(result.issues, []);
});

test("artifact privacy declarations are source-aligned to PERSONAL_DATA", async () => {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "docs/governance/durable-result-strategies.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.artifactSchemas.map((entry) => [entry.schema, entry.privacyClass]),
    [
      ["crawl4ai-fetch/v1", "PERSONAL_DATA"],
      ["crawl4ai-render/v1", "PERSONAL_DATA"],
      ["http-get/v1", "PERSONAL_DATA"],
      ["sanctions-download/v1", "PERSONAL_DATA"],
    ],
  );
});

test("scanner catches source-derived tool strategy omissions", async () => {
  const tempRoot = await materializePolicyRepo({
    "apps/api/src/tools/source-tools.ts": (source) =>
      source.replace(
        'durableResultStrategy: {\n    kind: "typed_projection",\n    schema: CATALOG_RESULT_PROJECTION_SCHEMAS["google_patents.search"],\n  },',
        'omittedDurableResultStrategy: null,',
      ),
  });
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: tempRoot });
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_TOOL_STRATEGY_SOURCE_MISMATCH"));
});

test("scanner catches declared tools that are no longer product-registered", async () => {
  const tempRoot = await materializePolicyRepo({
    "apps/api/src/tools/source-tools.ts": (source) =>
      source.replace("  registry.register(googlePatentsSearchTool as Tool);\n", ""),
  });
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: tempRoot });
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_TOOL_REGISTRATION_MISMATCH"));
});

test("scanner catches product model call-sites missing from the inventory", async () => {
  const tempRoot = await materializePolicyRepo({
    "apps/api/src/discovery/providers/public-web.provider.ts": (source) =>
      `${source}
async function unregisteredAuthorityModelCall(deps, ctx) {
  return executeStructuredTaskWithRuntime(
    deps.gateway,
    { task: 'discovery.unregistered_model', prompt: 'offline scanner fixture' },
    { ...ctx, durableResultSchema: 'taxonomy-code/v1' },
  );
}
`,
  });
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: tempRoot });
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_MODEL_SOURCE_INVENTORY_MISMATCH"));
});

test("scanner catches product model call-sites that omit durableResultSchema", async () => {
  const tempRoot = await materializePolicyRepo({
    "apps/api/src/discovery/providers/public-web.provider.ts": (source) =>
      `${source}
async function unreceiptedAuthorityModelCall(deps, ctx) {
  return executeStructuredTaskWithRuntime(
    deps.gateway,
    { task: 'discovery.extract_company', prompt: 'offline scanner fixture' },
    { ...ctx },
  );
}
`,
  });
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: tempRoot });
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_MODEL_SCHEMA_BINDING_MISSING"));
});

test("scanner catches direct product ModelGateway calls outside the approved runtime bridge", async () => {
  const tempRoot = await materializePolicyRepo({
    "apps/api/src/discovery/providers/public-web.provider.ts": (source) =>
      `${source}
async function directGatewayBypass(gateway, input, ctx) {
  return gateway.generateStructured(input, ctx);
}
`,
  });
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: tempRoot });
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_DIRECT_MODEL_GATEWAY_CALL"));
});

test("scanner catches artifact contract drift across materializer source and manifest", async () => {
  const tempRoot = await materializePolicyRepo({
    "apps/api/src/durable-results/artifact/materializers/http-get.materializer.ts": (source) =>
      source.replace("const MAX_HTTP_GET_ARTIFACT_BYTES = 3_000_000;", "const MAX_HTTP_GET_ARTIFACT_BYTES = 4_000_000;"),
  });
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: tempRoot });
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_ARTIFACT_CONTRACT_MISMATCH"));
});

test("scanner catches missing transaction-compatible Domain ACK and ledger receipt paths", async () => {
  const tempRoot = await materializePolicyRepo({
    "apps/api/src/durable-results/domain-ack.ts": (source) =>
      source.replace("PostgresDomainAckRepository", "LegacyDomainAckRepository"),
    "apps/api/src/tools/budget-store.ts": (source) =>
      source.replace("reserve_tool_budget_with_receipt_v1", "reserve_tool_budget"),
  });
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: tempRoot });
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_DOMAIN_ACK_REPOSITORY_MISSING"));
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_LEDGER_RECEIPT_SOURCE_MISSING"));
});

test("scanner catches SQL ACK trust and receipt-ready microusd wrapper regressions", async () => {
  const tempRoot = await materializePolicyRepo({
    "packages/db/prisma/migrations/20260823000000_execution_domain_ack/migration.sql": (source) =>
      source
        .replace("FORCE ROW LEVEL SECURITY", "NO FORCE ROW LEVEL SECURITY")
        .replace("\"status\" = 'SETTLED'", "\"status\" <> 'SETTLED'")
        .replace("reserve_tool_budget_microusd_with_receipt_v1", "reserve_tool_budget_microusd_v1"),
  });
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: tempRoot });
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_DOMAIN_ACK_SQL_TRUST_INCOMPLETE"));
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_MICROUSD_RECEIPT_WRAPPER_MISSING"));
});

test("scanner catches ToolBroker generic tool-result/v1 settlement compatibility regressions", async () => {
  const tempRoot = await materializePolicyRepo({
    "apps/api/src/tools/tool-broker.ts": (source) =>
      source.replace("schema: tool.durableResultStrategy.schema", "schema: 'tool-result/v1'"),
  });
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: tempRoot });
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_TOOLBROKER_TYPED_PROJECTION_MISSING"));
});

test("scanner catches new product direct BigQuery bypasses outside the original managed files", async () => {
  const tempRoot = await materializePolicyRepo({
    "apps/api/src/discovery/providers/public-web.provider.ts": (source) =>
      `${source}\nimport { BigQuery } from '@google-cloud/bigquery';\nnew BigQuery();\n`,
  });
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: tempRoot });
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_DIRECT_BIGQUERY_BYPASS"));
});

test("scanner catches unclassified product genericReplay seams anywhere under apps/api/src", async () => {
  const tempRoot = await materializePolicyRepo({
    "apps/api/src/discovery/providers/decision-maker.provider.ts": (source) =>
      source.replace(
        "{ ...ctx, durableResultSchema: 'contact-decision-makers/v1' }",
        "{ ...ctx, genericReplay: { schema: 'adhoc/v1', project: (x) => x, restore: (x) => x } }",
      ),
  });
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: tempRoot });
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_GENERIC_REPLAY_UNCLASSIFIED"));
});

test("scanner catches missing executable consumer imports and transaction calls", async () => {
  const tempRoot = await materializePolicyRepo({
    "apps/api/src/icp/icp.service.ts": (source) =>
      source.replaceAll("applyDomainAckConsumerTransaction", "staticDomainAckCatalogLookup"),
  });
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: tempRoot });
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_DOMAIN_ACK_CONSUMER_CALL_MISSING"));
});

test("scanner catches PUBLIC SECURITY DEFINER access and broad principal admission", async () => {
  const tempRoot = await materializePolicyRepo({
    "packages/db/prisma/migrations/20260823000000_execution_domain_ack/migration.sql": (source) =>
      source
        .replace(
          "REVOKE ALL ON FUNCTION\n  apply_execution_domain_ack_v1",
          "REVOKE ALL ON FUNCTION\n  missing_apply_execution_domain_ack_v1",
        )
        .replace(
          "ELSIF session_user IS DISTINCT FROM 'app_user'",
          "ELSIF session_user <> 'app_user'",
        ),
  });
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: tempRoot });
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_DOMAIN_ACK_FUNCTION_ACL_INVALID"));
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_DOMAIN_ACK_PRINCIPAL_INVALID"));
});

test("scanner catches caller-authored ACK strategy, artifact and ack identity", async () => {
  const tempRoot = await materializePolicyRepo({
    "packages/db/prisma/migrations/20260823000000_execution_domain_ack/migration.sql": (source) =>
      source
        .replace("operation.\"result_schema_version\"", "p_ack->>'resultStrategy'")
        .replace("operation.\"result_json\"->>'artifactId'", "p_ack->>'artifactId'")
        .replace("public.digest", "p_ack->>'ackId' /* public.digest */"),
  });
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: tempRoot });
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_DOMAIN_ACK_DERIVATION_INVALID"));
});

test("scanner catches per-path receipt fact and old microusd wrapper regressions", async () => {
  const tempRoot = await materializePolicyRepo({
    "docs/governance/durable-result-strategies.json": (source) => {
      const manifest = JSON.parse(source);
      delete manifest.tools[0].receiptFacts;
      return `${JSON.stringify(manifest, null, 2)}\n`;
    },
    "apps/api/src/tools/budget-store.ts": (source) => source
      .replaceAll("reserve_tool_budget_microusd_with_receipt_v1", "reserve_tool_budget_microusd_v1")
      .replaceAll("settle_tool_budget_microusd_with_receipt_v1", "settle_tool_budget_microusd_v1"),
  });
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: tempRoot });
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_RECEIPT_FACTS_MISSING"));
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_MICROUSD_RECEIPT_WRAPPER_MISSING"));
});

test("scanner catches optional-hook typed projection and missing materializer tests", async () => {
  const tempRoot = await materializePolicyRepo({
    "apps/api/src/tools/tool-broker.ts": (source) => source.replace(
      "this.projectionRegistry.project(\n          tool.durableResultStrategy.schema,\n          result,",
      "this.projectionRegistry.project(\n          tool.durableResultStrategy.schema,\n          tool.durableReplayResult?.(result),",
    ),
    "apps/api/src/durable-results/artifact/materializers/http-get.materializer.spec.ts": (source) =>
      source.replaceAll("http-get/v1", "missing-http-get/v1"),
  });
  const result = await verifyExecutionAuthorityPolicy({ repoRoot: tempRoot });
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_TOOLBROKER_TYPED_PROJECTION_MISSING"));
  assert.ok(codes(result).includes("EXECUTION_AUTHORITY_ARTIFACT_MATERIALIZER_TEST_MISSING"));
});
