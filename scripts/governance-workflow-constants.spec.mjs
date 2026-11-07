import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  WORKFLOW_CONSTANT_ALLOWLIST,
  inspectWorkflowConstants,
  numericConstantsInSource,
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

test("reads module-level numeric constants, including `as const` and negatives", () => {
  const source = [
    "const VISIBLE = 20;",
    "const NEGATIVE = -3;",
    "const VERSION = 2 as const;",
    "const NAME = 'x';",
    "const DERIVED = OTHER;",
    "let mutable = 4;",
    "function inner() { const NESTED = 5; return NESTED; }",
  ].join("\n");
  const found = numericConstantsInSource(source);
  assert.deepEqual(
    found.map(({ name, line }) => [name, line]),
    [
      ["VISIBLE", 1],
      ["NEGATIVE", 2],
      ["VERSION", 3],
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

test("the repository's workflow files pass the check", async () => {
  const issues = await inspectWorkflowConstants(REPOSITORY_ROOT);
  assert.deepEqual(issues, []);
});
