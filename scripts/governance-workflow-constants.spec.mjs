import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  WORKFLOW_CONSTANT_ALLOWLIST,
  inspectWorkflowConstants,
  numericConstantsInSource,
  parseArguments,
} from "./governance-workflow-constants.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPORAL_DIRECTORY = "apps/api/src/temporal";

async function withFixture(files, run) {
  const root = await mkdtemp(join(tmpdir(), "workflow-constants-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents, "utf8");
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("reads module-level numeric constants with values, including `as const`, negatives and `let`", () => {
  const source = [
    "const VISIBLE = 20;",
    "const NEGATIVE = -3;",
    "const VERSION = 2 as const;",
    "const SEPARATED = 1_000;",
    "let LIMIT = 5;",
    "const NAME = 'x';",
    "const DERIVED = OTHER;",
    "const EXPRESSION = 2 * 2;",
    "function inner() { const NESTED = 5; return NESTED; }",
  ].join("\n");
  const found = numericConstantsInSource(source);
  assert.deepEqual(
    found.map(({ name, value, line }) => [name, value, line]),
    [
      ["VISIBLE", 20, 1],
      ["NEGATIVE", -3, 2],
      ["VERSION", 2, 3],
      ["SEPARATED", 1000, 4],
      ["LIMIT", 5, 5],
    ],
  );
});

test("fails a workflow file whose numeric constant has no allowlist entry", async () => {
  await withFixture(
    {
      [`${TEMPORAL_DIRECTORY}/sample.workflow.ts`]: "const KNOB = 3;\nexport const ok = KNOB;\n",
    },
    async (root) => {
      const issues = await inspectWorkflowConstants(root, { allowlist: {} });
      assert.equal(issues.length, 1);
      assert.equal(issues[0].code, "WORKFLOW_CONSTANT_NOT_ALLOWLISTED");
      assert.match(issues[0].path, /sample\.workflow\.ts:1$/);
      assert.match(issues[0].message, /KNOB/);
    },
  );
});

test("scans knob modules and workflow files outside the temporal directory", async () => {
  await withFixture(
    {
      [`${TEMPORAL_DIRECTORY}/sample.workflow-knobs.ts`]: "export const KNOB_DEFAULT = 7;\n",
      [`apps/api/src/other/domain.workflow.ts`]: "const OTHER = 9;\n",
    },
    async (root) => {
      const issues = await inspectWorkflowConstants(root, { allowlist: {} });
      assert.deepEqual(
        issues.map(({ code }) => code),
        ["WORKFLOW_CONSTANT_NOT_ALLOWLISTED", "WORKFLOW_CONSTANT_NOT_ALLOWLISTED"],
      );
    },
  );
});

test("passes an allowlisted constant and ignores non-workflow files", async () => {
  await withFixture(
    {
      [`${TEMPORAL_DIRECTORY}/sample.workflow.ts`]: "const KNOB = 3;\n",
      [`${TEMPORAL_DIRECTORY}/sample.activities.ts`]: "const FREE = 9;\n",
      [`${TEMPORAL_DIRECTORY}/nested/deep.workflow.ts`]: "const OTHER = 1;\n",
    },
    async (root) => {
      const issues = await inspectWorkflowConstants(root, {
        allowlist: {
          [`${TEMPORAL_DIRECTORY}/sample.workflow.ts`]: { KNOB: "frozen" },
          [`${TEMPORAL_DIRECTORY}/nested/deep.workflow.ts`]: { OTHER: "frozen" },
        },
      });
      assert.deepEqual(issues, []);
    },
  );
});

test("fails a stale allowlist entry", async () => {
  await withFixture(
    {
      [`${TEMPORAL_DIRECTORY}/sample.workflow.ts`]: "const RENAMED = 3;\n",
    },
    async (root) => {
      const issues = await inspectWorkflowConstants(root, {
        allowlist: {
          [`${TEMPORAL_DIRECTORY}/sample.workflow.ts`]: { KNOB: "frozen" },
        },
      });
      assert.equal(issues.length, 2);
      assert.deepEqual(
        issues.map(({ code }) => code).sort(),
        ["WORKFLOW_CONSTANT_ALLOWLIST_STALE", "WORKFLOW_CONSTANT_NOT_ALLOWLISTED"],
      );
    },
  );
});

test("every allowlist entry carries a reason", () => {
  for (const [file, constants] of Object.entries(WORKFLOW_CONSTANT_ALLOWLIST)) {
    for (const [name, reason] of Object.entries(constants)) {
      assert.equal(typeof reason, "string", `${file} ${name}`);
      assert.ok(reason.trim().length > 0, `${file} ${name} needs a reason`);
    }
  }
});

// The frozen replay contract, pinned by value: histories recorded without the
// input fields replay on these numbers, so changing one changes the command
// sequence of every such in-flight run. Editing a pin here requires draining
// in-flight histories first — make that deliberate, never incidental.
test("frozen replay defaults keep their pinned values", async () => {
  async function constantsOf(path) {
    const source = await readFile(join(REPOSITORY_ROOT, path), "utf8");
    return new Map(
      numericConstantsInSource(source, path).map(({ name, value }) => [name, value]),
    );
  }

  const knobs = await constantsOf("apps/api/src/temporal/discovery.workflow-knobs.ts");
  assert.equal(knobs.get("DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD_DEFAULT"), 20);
  assert.equal(knobs.get("DISCOVERY_DEEP_COMPANY_CONCURRENCY_DEFAULT"), 16);
  assert.equal(knobs.get("DISCOVERY_QUERY_BATCH_SIZE_DEFAULT"), 2);

  const retention = await constantsOf("apps/api/src/temporal/raw-retention.workflow.ts");
  assert.equal(retention.get("MAX_BUDGET_RECONCILE_BATCHES"), 5);
  assert.equal(retention.get("MAX_BATCHES_PER_WORKSPACE"), 20);
  assert.equal(retention.get("DEFAULT_PAGES_PER_RUN"), 2);
  assert.equal(retention.get("MAX_PAGES_PER_RUN"), 5);
  assert.equal(retention.get("PAGES_PER_RUN_CAP"), 20);
  assert.equal(retention.get("BATCHES_PER_WORKSPACE_CAP"), 100);
  assert.equal(retention.get("BUDGET_RECONCILE_BATCHES_CAP"), 50);

  const understanding = await constantsOf("apps/api/src/temporal/understanding.workflow.ts");
  assert.equal(understanding.get("EXECUTION_CONTRACT_VERSION"), 2);
  const discovery = await constantsOf("apps/api/src/temporal/discovery.workflow.ts");
  assert.equal(discovery.get("EXECUTION_CONTRACT_VERSION"), 2);
});

test("argument parsing rejects unknown flags and a missing --root value", () => {
  assert.deepEqual(parseArguments(["verify"]), {
    command: "verify",
    root: REPOSITORY_ROOT,
  });
  assert.throws(() => parseArguments(["verify", "--rooot", "/tmp"]), /unknown argument/);
  assert.throws(() => parseArguments(["verify", "--root"]), /--root requires a directory/);
  assert.throws(() => parseArguments(["verify", "--root", "--fast"]), /--root requires a directory/);
});

test("the repository's workflow files pass the check", async () => {
  const issues = await inspectWorkflowConstants(REPOSITORY_ROOT);
  assert.deepEqual(issues, []);
});
