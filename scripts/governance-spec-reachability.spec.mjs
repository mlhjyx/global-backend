import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MANUAL_SPECS,
  analyzeSpecReachability,
  findRelativeImports,
  findRunnerSpecPaths,
  listScriptFiles,
} from "./governance-spec-reachability.mjs";

const MANUAL = Object.freeze({
  reason: "needs a disposable database",
  run: "node --test scripts/manual.spec.mjs",
});

function analyze(sources, runnerPaths, manualSpecs = {}) {
  return analyzeSpecReachability({
    files: Object.keys(sources).sort(),
    runnerPaths,
    readSource: async (path) => sources[path],
    manualSpecs,
  });
}

function codes(issues) {
  return issues.map(({ code, path }) => `${code} ${path}`);
}

test("runner commands reach specs through pnpm scripts, line continuations and tsx", () => {
  const workflow = [
    "jobs:",
    "  check:",
    "    steps:",
    "      - run: pnpm docs:check",
    "      - run: pnpm memory:check # node --test scripts/inline-comment.spec.mjs",
    "      - run: |",
    "          # node --test scripts/commented.spec.mjs",
    "          node --test \\",
    "            scripts/continued.spec.mjs",
    "          cp scripts/copied.spec.mjs /tmp/ && echo copied",
    "      - run: pnpm --filter @global/api docs:check",
    '      - run: pnpm exec tsx --test "./scripts/typed.spec.mts" && echo done',
  ].join("\n");
  const rootScripts = {
    "docs:check": "pnpm gov:test && node scripts/tool.mjs",
    "gov:test":
      "node --test scripts/root.spec.mjs scripts/second.spec.mjs packages/db/test/other.spec.mjs",
    "memory:check": "node --test --test-concurrency=1 scripts/memory.spec.mjs",
    unused: "node --test scripts/unused.spec.mjs",
  };

  const { paths, issues } = findRunnerSpecPaths({
    workflows: [{ path: ".github/workflows/check.yml", text: workflow }],
    rootScripts,
  });

  assert.deepEqual(issues, []);
  assert.deepEqual(paths, [
    "scripts/continued.spec.mjs",
    "scripts/memory.spec.mjs",
    "scripts/root.spec.mjs",
    "scripts/second.spec.mjs",
    "scripts/typed.spec.mts",
  ]);
});

test("pnpm script expansion terminates on recursive scripts", () => {
  const { paths } = findRunnerSpecPaths({
    workflows: [{ path: "ci.yml", text: "run: pnpm loop" }],
    rootScripts: {
      loop: "pnpm again && node --test scripts/loop.spec.mjs",
      again: "pnpm loop",
    },
  });

  assert.deepEqual(paths, ["scripts/loop.spec.mjs"]);
});

test("only step run commands count, not step names, env values or echoed text", () => {
  const workflow = [
    "jobs:",
    "  check:",
    "    env:",
    "      CMD: node --test scripts/env.spec.mjs",
    "    steps:",
    "      - name: node --test scripts/named.spec.mjs",
    '        run: echo "node --test scripts/echoed.spec.mjs"',
    "      - run: node --test scripts/real.spec.mjs",
  ].join("\n");

  const { paths } = findRunnerSpecPaths({
    workflows: [{ path: "w.yml", text: workflow }],
    rootScripts: {},
  });

  assert.deepEqual(paths, ["scripts/real.spec.mjs"]);
});

test("folded, literal, quoted and multi-line run scalars are read whole", () => {
  const workflow = [
    "jobs:",
    "  check:",
    "    steps:",
    "      - run: >-",
    "          node --test",
    "          scripts/folded.spec.mjs",
    "      - run: node --test",
    "          scripts/plain.spec.mjs",
    "      - run: | # literal block",
    "          node --test scripts/literal.spec.mjs",
    "        name: after the block",
    '      - run: "node --test scripts/quoted.spec.mjs"',
  ].join("\n");

  const { paths } = findRunnerSpecPaths({
    workflows: [{ path: "w.yml", text: workflow }],
    rootScripts: {},
  });

  assert.deepEqual(paths, [
    "scripts/folded.spec.mjs",
    "scripts/literal.spec.mjs",
    "scripts/plain.spec.mjs",
    "scripts/quoted.spec.mjs",
  ]);
});

test("steps and jobs switched off with a literal false condition do not count", () => {
  const workflow = [
    "jobs:",
    "  disabled:",
    "    if: false",
    "    steps:",
    "      - run: node --test scripts/job-off.spec.mjs",
    "  enabled:",
    "    steps:",
    "      - if: ${{ false }}",
    "        run: node --test scripts/step-off.spec.mjs",
    "      - run: node --test scripts/late-off.spec.mjs",
    "        if: 'false' # quoted",
    "      - if: github.event_name == 'push'",
    "        run: node --test scripts/conditional.spec.mjs",
  ].join("\n");

  const { paths } = findRunnerSpecPaths({
    workflows: [{ path: "w.yml", text: workflow }],
    rootScripts: {},
  });

  assert.deepEqual(paths, ["scripts/conditional.spec.mjs"]);
});

test("root-preserving pnpm flags before the script name still expand it", () => {
  const workflow = [
    "      - run: pnpm run --silent quiet",
    "      - run: pnpm -w root",
    "      - run: pnpm --filter @global/api scoped",
  ].join("\n");

  const { paths } = findRunnerSpecPaths({
    workflows: [{ path: "w.yml", text: workflow }],
    rootScripts: {
      quiet: "node --test scripts/quiet.spec.mjs",
      root: "node --test scripts/root.spec.mjs",
      scoped: "node --test scripts/scoped.spec.mjs",
    },
  });

  assert.deepEqual(paths, ["scripts/quiet.spec.mjs", "scripts/root.spec.mjs"]);
});

test("runner globs fail closed instead of guessing which specs they match", () => {
  const { paths, issues } = findRunnerSpecPaths({
    workflows: [
      {
        path: ".github/workflows/ci.yml",
        text: "run: node --test 'scripts/*.spec.mjs' apps/x/*.spec.mjs",
      },
    ],
    rootScripts: {},
  });

  assert.deepEqual(paths, []);
  assert.deepEqual(codes(issues), [
    "SPEC_RUNNER_GLOB_UNSUPPORTED .github/workflows/ci.yml",
  ]);
});

test("relative imports come from import syntax, not comments, strings or type-only imports", () => {
  const source = [
    'import assert from "node:assert/strict";',
    'import "./side-effect.spec.mjs";',
    "import {",
    "  helper,",
    '} from "./helper.mjs";',
    "import type { Shape } from './types.spec.mts';",
    "import { type Only } from './all-types.spec.mts';",
    "import Mixed, { type Kind } from './mixed.mjs';",
    "export type { Other } from './other-types.spec.mts';",
    'export * from "../shared/reexport.mjs";',
    "await import('./late.spec.mjs');",
    "if (process.env.LATE) await import(`./conditional.spec.mjs`);",
    "/*",
    'import "./block-commented.spec.mjs";',
    "*/",
    '// import "./line-commented.spec.mjs";',
    "const call = \"await import('./in-string.spec.mjs')\";",
    'const text = await readFile(new URL("./read-only.spec.mjs", import.meta.url));',
  ].join("\n");

  assert.deepEqual(findRelativeImports(source), [
    "./side-effect.spec.mjs",
    "./helper.mjs",
    "./mixed.mjs",
    "../shared/reexport.mjs",
    "./late.spec.mjs",
    "./conditional.spec.mjs",
  ]);
});

test("specs are reachable through spec and helper imports, not through file reads", async () => {
  const { reachable, issues } = await analyze(
    {
      "scripts/root.spec.mjs": [
        'import "./child.spec.mjs";',
        'import { helper } from "./helper.mjs";',
        "await import('./nested/late.spec.mjs');",
        'await readFile(new URL("./read-only.spec.mjs", import.meta.url));',
      ].join("\n"),
      "scripts/child.spec.mjs": "",
      "scripts/helper.mjs": 'import "./via-helper.spec.mjs";',
      "scripts/via-helper.spec.mjs": "",
      "scripts/nested/late.spec.mjs": 'import "../child.spec.mjs";',
      "scripts/read-only.spec.mjs": "",
      "scripts/orphan.test.mjs": "",
    },
    ["scripts/root.spec.mjs"],
  );

  assert.deepEqual(reachable, [
    "scripts/child.spec.mjs",
    "scripts/nested/late.spec.mjs",
    "scripts/root.spec.mjs",
    "scripts/via-helper.spec.mjs",
  ]);
  assert.deepEqual(codes(issues), [
    "SPEC_UNREACHABLE scripts/orphan.test.mjs",
    "SPEC_UNREACHABLE scripts/read-only.spec.mjs",
  ]);
});

test("a runner that names a missing spec fails instead of counting as coverage", async () => {
  const { reachable, issues } = await analyze(
    { "scripts/present.spec.mjs": "" },
    ["scripts/present.spec.mjs", "scripts/deleted.spec.mjs"],
  );

  assert.deepEqual(reachable, ["scripts/present.spec.mjs"]);
  assert.deepEqual(codes(issues), [
    "SPEC_RUNNER_TARGET_MISSING scripts/deleted.spec.mjs",
  ]);
});

test("manual registrations need a reason and a run command and go stale when wired or deleted", async () => {
  const sources = {
    "scripts/root.spec.mjs": 'import "./wired.spec.mjs";',
    "scripts/wired.spec.mjs": "",
    "scripts/manual.spec.mjs": "",
    "scripts/incomplete.spec.mjs": "",
  };

  const { issues } = await analyze(sources, ["scripts/root.spec.mjs"], {
    "scripts/manual.spec.mjs": MANUAL,
    "scripts/wired.spec.mjs": MANUAL,
    "scripts/deleted.spec.mjs": MANUAL,
    "scripts/incomplete.spec.mjs": { reason: " ", run: MANUAL.run },
  });

  assert.deepEqual(codes(issues), [
    "MANUAL_SPEC_INCOMPLETE scripts/incomplete.spec.mjs",
    "MANUAL_SPEC_MISSING scripts/deleted.spec.mjs",
    "MANUAL_SPEC_REACHABLE scripts/wired.spec.mjs",
  ]);
});

test("the manual registry gives every entry a reason and a run command", () => {
  for (const [path, entry] of Object.entries(MANUAL_SPECS)) {
    assert.match(path, /^scripts\/.+\.(?:spec|test)\.[cm]?[jt]s$/);
    assert.deepEqual(Object.keys(entry).sort(), ["reason", "run"], path);
    assert.ok(entry.reason.trim().length > 0, path);
    assert.ok(entry.run.trim().length > 0, path);
  }
});

test("script enumeration walks nested directories without following symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spec-reachability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts", "nested"), { recursive: true });
  await writeFile(join(root, "scripts", "a.spec.mjs"), "");
  await writeFile(join(root, "scripts", "nested", "b.test.ts"), "");
  await writeFile(join(root, "scripts", "tool.mjs"), "");
  await mkdir(join(root, "elsewhere"));
  await writeFile(join(root, "elsewhere", "c.spec.mjs"), "");
  await symlink(join(root, "elsewhere"), join(root, "scripts", "linked"));

  assert.deepEqual(await listScriptFiles(root), [
    "scripts/a.spec.mjs",
    "scripts/nested/b.test.ts",
    "scripts/tool.mjs",
  ]);
});
