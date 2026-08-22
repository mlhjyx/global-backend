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
    "apps/api/src/durable-results/durable-execution-receipt.ts",
    "apps/api/src/durable-results/domain-ack.ts",
    "apps/api/src/durable-results/artifact/artifact-materializer.registry.ts",
    "apps/api/src/temporal/patents-cache.activities.ts",
    "apps/api/src/temporal/patent-cache-broker-scanner.ts",
    "apps/api/src/discovery/providers/bigquery-patents.provider.ts",
    "apps/api/src/discovery/providers/public-web.provider.ts",
    "apps/api/src/discovery/providers/directory.provider.ts",
    "apps/api/src/discovery/providers/decision-maker.provider.ts",
    "apps/api/src/icp/icp-budget-execution.ts",
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
