import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateRequiredContexts } from "./governance-contracts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const action = "oasdiff/oasdiff-action/breaking";
const revision = "2649ebe137aeb72a95707671204e829f86e091fc";
const version = "v0.1.13";

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function issueCodes(result) {
  return result.issues.map((issue) => issue.code);
}

function oasdiffStep(workflow) {
  const step = workflow.match(
    /      - name: oasdiff breaking（PR 且未标 breaking-change-approved）\n(?: {8}.*\n?)*/u,
  );

  assert.ok(step, "oasdiff breaking step must remain present");
  return step[0];
}

function assertOasdiffPolicy(policy, workflow) {
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

  const step = oasdiffStep(workflow);
  assert.match(step, new RegExp(`uses: ${action}@${revision} # ${version}`));
  assert.match(step, /        env:\n          OASDIFF_INTERNAL: "1"\n/u);
  assert.match(
    step,
    /        with:\n          base: base-openapi\.json\n          revision: packages\/contracts\/openapi\/openapi\.json\n          fail-on: ERR\n/u,
  );
  assert.match(step, /          review: "false"\n/u);
  assert.match(
    step,
    /github\.event_name == 'pull_request'[\s\S]*env\.HAS_BASE == '1'[\s\S]*breaking-change-approved/u,
  );
  assert.doesNotMatch(step, /continue-on-error\s*:/u);
  assert.doesNotMatch(step, /github-token\s*:/u);
}

test("oasdiff breaking is policy-bound to the reviewed v0.1.13 commit and privacy contract", () => {
  const policy = JSON.parse(read(".github/required-contexts.json"));
  const workflow = read(".github/workflows/ci.yml");

  assertOasdiffPolicy(policy, workflow);

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

  for (const [description, mutate] of [
    [
      "privacy env removed",
      (value) => value.replace(/          OASDIFF_INTERNAL: "1"\n/u, ""),
    ],
    [
      "privacy env changed",
      (value) =>
        value.replace('OASDIFF_INTERNAL: "1"', 'OASDIFF_INTERNAL: "0"'),
    ],
    [
      "review enabled",
      (value) => value.replace('review: "false"', 'review: "true"'),
    ],
    [
      "review removed",
      (value) => value.replace(/          review: "false"\n/u, ""),
    ],
    [
      "moving tag",
      (value) =>
        value.replace(`@${revision} # ${version}`, `@${version} # ${version}`),
    ],
    [
      "tag object pin",
      (value) =>
        value.replace(
          `@${revision} # ${version}`,
          "@1111111111111111111111111111111111111111 # v0.1.13 tag object",
        ),
    ],
    [
      "failure swallowing",
      (value) =>
        value.replace(
          `uses: ${action}@${revision} # ${version}\n`,
          `uses: ${action}@${revision} # ${version}\n        continue-on-error: true\n`,
        ),
    ],
  ]) {
    assert.throws(
      () => assertOasdiffPolicy(policy, mutate(workflow)),
      assert.AssertionError,
      description,
    );
  }
});
