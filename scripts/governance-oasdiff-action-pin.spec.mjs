import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateRequiredContexts } from "./governance-contracts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const action = "oasdiff/oasdiff-action/breaking";
const revision = "033c15c845bef10f148afb0fa781bf1b2a7fe1bf";
const version = "v0.1.12";

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function issueCodes(result) {
  return result.issues.map((issue) => issue.code);
}

test("oasdiff breaking is policy-bound to the reviewed v0.1.12 commit", () => {
  const policy = JSON.parse(read(".github/required-contexts.json"));
  const workflow = read(".github/workflows/ci.yml");
  const pin = policy.workflow_action_pins.find(
    (candidate) =>
      candidate.workflow === ".github/workflows/ci.yml" &&
      candidate.action === action,
  );

  assert.deepEqual(pin, {
    workflow: ".github/workflows/ci.yml",
    action,
    revision,
    version,
  });
  assert.match(
    workflow,
    new RegExp(`uses: ${action}@${revision} # ${version}`),
  );
  assert.match(
    workflow,
    new RegExp(
      `uses: ${action}@${revision} # ${version}\\n` +
        String.raw`\s+with:\n(?:\s+[^\n]*\n)*?\s+review: "false"`,
    ),
  );

  const stalePolicy = structuredClone(policy);
  stalePolicy.workflow_action_pins.find(
    (candidate) =>
      candidate.workflow === ".github/workflows/ci.yml" &&
      candidate.action === action,
  ).revision = "b7c3adeb54330db1903d27c61db520e5661ad55b";

  assert.ok(
    issueCodes(
      validateRequiredContexts(
        stalePolicy,
        new Map([[".github/workflows/ci.yml", workflow]]),
        { codeowners: read(".github/CODEOWNERS") },
      ),
    ).includes("WORKFLOW_ACTION_UNPINNED"),
  );
});
