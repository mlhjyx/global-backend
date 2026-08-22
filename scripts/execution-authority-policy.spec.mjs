import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  EXPECTED_MODEL_TASKS,
  EXPECTED_TOOL_IDS,
  verifyExecutionAuthorityPolicy,
} from "./execution-authority-policy.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

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
