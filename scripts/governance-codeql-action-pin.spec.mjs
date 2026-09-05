import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateRequiredContexts } from "./governance-contracts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = ".github/workflows/codeql-canary.yml";
const revision = "cdf488f595d80d6e07e03d4674febd5ab45fa938";
const version = "v4.37.9";
const tagObject = "a35ac6e6798d72df5475948b28efb89edc2e19ca";
const staleRevision = "5595ccaf912efad79be6eef63a5619ff05969be3";
const actions = ["github/codeql-action/init", "github/codeql-action/analyze"];

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function issueCodes(result) {
  return result.issues.map((issue) => issue.code);
}

function validate(policy, workflow) {
  return validateRequiredContexts(policy, new Map([[workflowPath, workflow]]), {
    codeowners: read(".github/CODEOWNERS"),
  });
}

test("CodeQL init and analyze are atomically policy-bound to the v4.37.9 peeled commit", () => {
  const policy = JSON.parse(read(".github/required-contexts.json"));
  const workflow = read(workflowPath);
  const pins = policy.workflow_action_pins.filter(
    (candidate) =>
      candidate.workflow === workflowPath && actions.includes(candidate.action),
  );

  assert.deepEqual(
    pins,
    actions.map((action) => ({
      workflow: workflowPath,
      action,
      revision,
      version,
    })),
  );
  for (const action of actions) {
    assert.match(
      workflow,
      new RegExp(`uses: ${action}@${revision} # ${version}`),
    );
  }

  const stalePolicy = structuredClone(policy);
  stalePolicy.workflow_action_pins.find(
    (candidate) =>
      candidate.workflow === workflowPath && candidate.action === actions[0],
  ).revision = staleRevision;
  assert.ok(
    issueCodes(validate(stalePolicy, workflow)).includes(
      "WORKFLOW_ACTION_UNPINNED",
    ),
  );

  const splitPins = workflow.replace(
    `${actions[1]}@${revision}`,
    `${actions[1]}@${staleRevision}`,
  );
  assert.ok(
    issueCodes(validate(policy, splitPins)).includes(
      "WORKFLOW_ACTION_UNPINNED",
    ),
  );

  const tagObjectPin = workflow.replace(
    `${actions[0]}@${revision}`,
    `${actions[0]}@${tagObject}`,
  );
  assert.ok(
    issueCodes(validate(policy, tagObjectPin)).includes(
      "WORKFLOW_ACTION_UNPINNED",
    ),
  );

  const movingTag = workflow.replace(
    `${actions[1]}@${revision}`,
    `${actions[1]}@${version}`,
  );
  assert.ok(
    issueCodes(validate(policy, movingTag)).includes(
      "WORKFLOW_ACTION_UNPINNED",
    ),
  );
});
