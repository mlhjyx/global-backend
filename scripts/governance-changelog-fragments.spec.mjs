import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHANGELOG_PATH,
  FRAGMENT_DIRECTORY,
  assembleChangelog,
  fragmentRequirement,
  isFragmentPath,
  parseFragment,
  parseNameStatus,
  prFromSquashSubject,
  rewriteRelativeLinks,
  validateFragment,
  verifyChangelogFragments,
} from "./governance-changelog-fragments.mjs";
import { createSafeGitEnvironment } from "./safe-git-environment.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIBRARY = join(
  REPOSITORY_ROOT,
  "scripts/governance-changelog-fragments.mjs",
);
const ASSEMBLER = join(REPOSITORY_ROOT, "scripts/changelog-assemble.mjs");

const BODY = [
  "- 起因：卖方 #26 的验收 run 失败。",
  "- 改动：",
  "  - 操作按查询归键。",
  "- 测试：先红后绿 7 项。",
  "- 未做：429 仍按控制错误处理。",
  "",
].join("\n");

// An override set to undefined leaves that key out of the frontmatter.
function fragmentText(overrides = {}) {
  const fields = {
    date: "2026-10-14",
    pr: "653",
    title: "Keep one fragment per PR",
    body: BODY,
    extra: "",
    ...overrides,
  };
  const lines = ["---", `date: ${fields.date}`];
  if (fields.pr !== undefined) lines.push(`pr: ${fields.pr}`);
  if (fields.title !== undefined) lines.push(`title: ${fields.title}`);
  if (fields.extra) lines.push(fields.extra);
  lines.push("---", "", fields.body);
  return lines.join("\n");
}

const FRAGMENT = `${FRAGMENT_DIRECTORY}/2026-10-14-one-fragment.md`;

function codes(issues) {
  return issues.map((issue) => issue.code).sort();
}

test("a well-formed fragment parses into date, PR, title and body", () => {
  const fragment = parseFragment(FRAGMENT, fragmentText());
  assert.deepEqual(fragment.issues, []);
  assert.equal(fragment.date, "2026-10-14");
  assert.equal(fragment.pr, 653);
  assert.equal(fragment.title, "Keep one fragment per PR");
  assert.equal(fragment.body, BODY.trimEnd());
});

test("the PR number may be left out until the PR exists", () => {
  for (const text of [
    fragmentText({ pr: undefined }),
    fragmentText({ pr: "" }),
  ]) {
    const fragment = parseFragment(FRAGMENT, text);
    assert.deepEqual(fragment.issues, []);
    assert.equal(fragment.pr, null);
  }
});

test("a quoted title loses its quotes, and a colon inside the title is kept", () => {
  const fragment = parseFragment(
    FRAGMENT,
    fragmentText({ title: '"Lease: give discovery runs 3 hours"' }),
  );
  assert.deepEqual(fragment.issues, []);
  assert.equal(fragment.title, "Lease: give discovery runs 3 hours");
});

test("fragment validation rejects each malformed shape with its own code", () => {
  const cases = [
    [
      `${FRAGMENT_DIRECTORY}/one-fragment.md`,
      fragmentText(),
      "CHANGELOG_FRAGMENT_FILENAME",
    ],
    [
      `${FRAGMENT_DIRECTORY}/2026-10-14-One_Fragment.md`,
      fragmentText(),
      "CHANGELOG_FRAGMENT_FILENAME",
    ],
    [FRAGMENT, BODY, "CHANGELOG_FRAGMENT_FRONTMATTER"],
    [
      FRAGMENT,
      `---\ndate: 2026-10-14\ntitle: x\n\n${BODY}`,
      "CHANGELOG_FRAGMENT_FRONTMATTER",
    ],
    [
      FRAGMENT,
      fragmentText({ extra: "author: someone" }),
      "CHANGELOG_FRAGMENT_FRONTMATTER",
    ],
    [
      FRAGMENT,
      fragmentText({ extra: "date: 2026-10-14" }),
      "CHANGELOG_FRAGMENT_FRONTMATTER",
    ],
    [
      FRAGMENT,
      fragmentText().replaceAll("\n", "\r\n"),
      "CHANGELOG_FRAGMENT_FRONTMATTER",
    ],
    [FRAGMENT, fragmentText({ date: "2026-10-13" }), "CHANGELOG_FRAGMENT_DATE"],
    [
      `${FRAGMENT_DIRECTORY}/2026-02-30-one-fragment.md`,
      fragmentText({ date: "2026-02-30" }),
      "CHANGELOG_FRAGMENT_DATE",
    ],
    [FRAGMENT, fragmentText({ date: "14.10.2026" }), "CHANGELOG_FRAGMENT_DATE"],
    [FRAGMENT, fragmentText({ pr: "#653" }), "CHANGELOG_FRAGMENT_PR"],
    [FRAGMENT, fragmentText({ pr: "0" }), "CHANGELOG_FRAGMENT_PR"],
    [FRAGMENT, fragmentText({ title: undefined }), "CHANGELOG_FRAGMENT_TITLE"],
    [FRAGMENT, fragmentText({ title: "" }), "CHANGELOG_FRAGMENT_TITLE"],
    [
      FRAGMENT,
      fragmentText({ title: "Keep it (#653)" }),
      "CHANGELOG_FRAGMENT_TITLE",
    ],
    [
      FRAGMENT,
      fragmentText({ title: "## Keep it" }),
      "CHANGELOG_FRAGMENT_TITLE",
    ],
    [FRAGMENT, fragmentText({ body: "" }), "CHANGELOG_FRAGMENT_BODY"],
    [
      FRAGMENT,
      fragmentText({ body: `## 2026-10-14 · Nested entry\n\n${BODY}` }),
      "CHANGELOG_FRAGMENT_BODY",
    ],
    [
      FRAGMENT,
      fragmentText({ body: `# Title\n\n${BODY}` }),
      "CHANGELOG_FRAGMENT_BODY",
    ],
    [
      FRAGMENT,
      fragmentText({
        body: BODY.replace("- 未做：429 仍按控制错误处理。\n", ""),
      }),
      "CHANGELOG_FRAGMENT_SECTIONS",
    ],
    [
      FRAGMENT,
      fragmentText({
        body: "- 改动：x\n- 起因：y\n- 测试：z\n- 未做：w\n",
      }),
      "CHANGELOG_FRAGMENT_SECTIONS",
    ],
    [
      FRAGMENT,
      fragmentText({ body: "- 起因：\n- 改动：x\n- 测试：z\n- 未做：w\n" }),
      "CHANGELOG_FRAGMENT_SECTIONS",
    ],
  ];
  for (const [path, text, code] of cases) {
    assert.ok(
      codes(validateFragment(path, text)).includes(code),
      `${path} should report ${code}; got ${JSON.stringify(validateFragment(path, text))}\n${text}`,
    );
  }
});

test("sections may carry extra top-level items, ASCII colons and fenced headings", () => {
  const body = [
    "- 起因：x",
    "- 改动:",
    "  - y",
    "- 测试：z",
    "- 部署：不需要",
    "- 未做：无",
    "",
    "```md",
    "## not a heading inside a fence",
    "```",
    "",
  ].join("\n");
  assert.deepEqual(validateFragment(FRAGMENT, fragmentText({ body })), []);
});

test("only Markdown files directly in the fragment directory, other than README, are fragments", () => {
  assert.equal(isFragmentPath(FRAGMENT), true);
  assert.equal(isFragmentPath(`${FRAGMENT_DIRECTORY}/README.md`), false);
  assert.equal(
    isFragmentPath(`${FRAGMENT_DIRECTORY}/nested/2026-10-14-x.md`),
    false,
  );
  assert.equal(isFragmentPath(`${FRAGMENT_DIRECTORY}/notes.txt`), false);
  assert.equal(isFragmentPath(CHANGELOG_PATH), false);
});

test("git name-status -z output parses into status and path pairs", () => {
  assert.deepEqual(
    parseNameStatus(
      "M\0apps/api/src/a.ts\0A\0docs/roadmap/changelog.d/2026-10-14-x.md\0D\0infra/x\0",
    ),
    [
      { status: "M", path: "apps/api/src/a.ts" },
      { status: "A", path: "docs/roadmap/changelog.d/2026-10-14-x.md" },
      { status: "D", path: "infra/x" },
    ],
  );
  assert.deepEqual(parseNameStatus(""), []);
});

test("a PR that changes apps, packages, scripts or infra needs a fragment or a changelog edit", () => {
  for (const codePath of [
    "apps/api/src/a.ts",
    "packages/db/prisma/schema.prisma",
    "scripts/verify-docs.mjs",
    "infra/backend-runtime.compose.yml",
  ]) {
    const missing = fragmentRequirement([
      { status: "M", path: codePath },
      { status: "M", path: "docs/status/current.md" },
    ]);
    assert.equal(missing.required, true, codePath);
    assert.equal(missing.satisfied, false, codePath);
    assert.deepEqual(missing.codePaths, [codePath]);
  }

  const withFragment = fragmentRequirement([
    { status: "M", path: "apps/api/src/a.ts" },
    { status: "A", path: FRAGMENT },
  ]);
  assert.equal(withFragment.satisfied, true);
  assert.deepEqual(withFragment.fragmentPaths, [FRAGMENT]);

  const editedFragment = fragmentRequirement([
    { status: "D", path: "scripts/old.mjs" },
    { status: "M", path: FRAGMENT },
  ]);
  assert.equal(editedFragment.satisfied, true);

  const withChangelog = fragmentRequirement([
    { status: "M", path: "infra/x.yml" },
    { status: "M", path: CHANGELOG_PATH },
  ]);
  assert.equal(withChangelog.satisfied, true);
  assert.equal(withChangelog.changelogEdited, true);
});

test("deleting a fragment, touching the README or editing docs alone does not count", () => {
  const deletedOnly = fragmentRequirement([
    { status: "M", path: "apps/api/src/a.ts" },
    { status: "D", path: FRAGMENT },
    { status: "M", path: `${FRAGMENT_DIRECTORY}/README.md` },
  ]);
  assert.equal(deletedOnly.satisfied, false);

  const docsOnly = fragmentRequirement([
    { status: "M", path: "docs/status/current.md" },
    { status: "M", path: "AGENTS.md" },
    { status: "M", path: ".github/workflows/ci.yml" },
    { status: "M", path: "apps-notes.md" },
  ]);
  assert.equal(docsOnly.required, false);
  assert.equal(docsOnly.satisfied, true);
});

test("a squash subject yields its PR number and nothing else does", () => {
  assert.equal(prFromSquashSubject("fix(x): keep it going (#645)"), 645);
  assert.equal(prFromSquashSubject("fix(x): see (#12) then (#645)"), 645);
  assert.equal(prFromSquashSubject("wip: local commit"), null);
  assert.equal(prFromSquashSubject(""), null);
});

test("relative links are rebased from the fragment directory onto the changelog", () => {
  const body = [
    "- 起因：见 [刷新流程](../../backend/dependency-refresh.md) 与 [证据](../../evidence/security/x.json#L3)。",
    "- 改动：[同目录](../release-plan.md)、[本目录](sibling.md)、[外链](https://example.org/a)、[锚点](#测试)、`[code](../../x.md)`。",
    '- 测试：![图](../../assets/a.png "title")',
    "- 未做：无",
  ].join("\n");
  assert.equal(
    rewriteRelativeLinks(body, FRAGMENT_DIRECTORY, "docs/roadmap"),
    [
      "- 起因：见 [刷新流程](../backend/dependency-refresh.md) 与 [证据](../evidence/security/x.json#L3)。",
      "- 改动：[同目录](release-plan.md)、[本目录](changelog.d/sibling.md)、[外链](https://example.org/a)、[锚点](#测试)、`[code](../../x.md)`。",
      '- 测试：![图](../assets/a.png "title")',
      "- 未做：无",
    ].join("\n"),
  );
});

const CHANGELOG = [
  "> 生命周期：`REFERENCE_ONLY`",
  "",
  "> 定位说明。",
  "",
  "## 2026-10-14 · Existing same-day entry (#645)",
  "",
  "- 起因：a",
  "",
  "## 2026-10-13 · Older entry",
  "",
  "- 起因：b",
  "",
  "## 目标",
  "",
  "legacy tail",
  "",
  "## 2026-10-20 · Legacy dated heading below the tail",
  "",
].join("\n");

function parsed(path, overrides = {}) {
  const fragment = parseFragment(path, fragmentText(overrides));
  assert.deepEqual(fragment.issues, []);
  return fragment;
}

test("assembly puts fragments newest day first, after the entries already on their day", () => {
  const output = assembleChangelog(CHANGELOG, [
    parsed(`${FRAGMENT_DIRECTORY}/2026-10-13-later.md`, {
      date: "2026-10-13",
      pr: "660",
      title: "Thirteenth later",
    }),
    parsed(`${FRAGMENT_DIRECTORY}/2026-10-15-new-day.md`, {
      date: "2026-10-15",
      pr: "",
      title: "Fifteenth",
    }),
    parsed(`${FRAGMENT_DIRECTORY}/2026-10-14-second.md`, {
      pr: "658",
      title: "Fourteenth second",
    }),
    parsed(`${FRAGMENT_DIRECTORY}/2026-10-14-first.md`, {
      pr: "654",
      title: "Fourteenth first",
    }),
    parsed(`${FRAGMENT_DIRECTORY}/2026-10-14-no-pr.md`, {
      pr: undefined,
      title: "Fourteenth without PR",
    }),
  ]);
  const headings = output.split("\n").filter((line) => line.startsWith("## "));
  assert.deepEqual(headings, [
    "## 2026-10-15 · Fifteenth",
    "## 2026-10-14 · Existing same-day entry (#645)",
    "## 2026-10-14 · Fourteenth first (#654)",
    "## 2026-10-14 · Fourteenth second (#658)",
    "## 2026-10-14 · Fourteenth without PR",
    "## 2026-10-13 · Older entry",
    "## 2026-10-13 · Thirteenth later (#660)",
    "## 目标",
    "## 2026-10-20 · Legacy dated heading below the tail",
  ]);
  assert.ok(
    output.startsWith(
      "> 生命周期：`REFERENCE_ONLY`\n\n> 定位说明。\n\n## 2026-10-15 · Fifteenth\n\n- 起因：",
    ),
  );
  assert.ok(
    output.includes(
      "- 未做：429 仍按控制错误处理。\n\n## 2026-10-14 · Existing same-day entry (#645)\n",
    ),
  );
  assert.ok(
    output.includes(
      "- 起因：b\n\n## 2026-10-13 · Thirteenth later (#660)\n\n- 起因：",
    ),
  );
  assert.ok(output.includes("- 未做：429 仍按控制错误处理。\n\n## 目标\n"));
  assert.ok(!output.includes("\n\n\n"), "no triple newlines");
  assert.ok(output.endsWith("\n"));
});

test("assembly without fragments leaves the changelog byte-identical", () => {
  assert.equal(assembleChangelog(CHANGELOG, []), CHANGELOG);
});

test("a fragment older than every leading entry lands before the undated tail", () => {
  const output = assembleChangelog(CHANGELOG, [
    parsed(`${FRAGMENT_DIRECTORY}/2026-10-01-old.md`, {
      date: "2026-10-01",
      pr: "1",
      title: "Old",
    }),
  ]);
  const headings = output.split("\n").filter((line) => line.startsWith("## "));
  assert.deepEqual(headings.slice(2, 4), [
    "## 2026-10-01 · Old (#1)",
    "## 目标",
  ]);
});

test("assembly rebases the fragment's relative links onto the changelog", () => {
  const body = BODY.replace(
    "- 测试：先红后绿 7 项。",
    "- 测试：见 [证据](../../evidence/x.md)。",
  );
  const output = assembleChangelog(CHANGELOG, [parsed(FRAGMENT, { body })]);
  assert.ok(output.includes("- 测试：见 [证据](../evidence/x.md)。"));
});

async function fixtureRepository() {
  const root = await mkdtemp(join(tmpdir(), "changelog-fragments-"));
  const gitEnvironment = {
    ...createSafeGitEnvironment(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: gitEnvironment,
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fragments@example.invalid");
  git("config", "user.name", "fragments");
  git("config", "commit.gpgsign", "false");
  const write = async (path, text) => {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  await write(CHANGELOG_PATH, CHANGELOG);
  await write(`${FRAGMENT_DIRECTORY}/README.md`, "# Fragments\n");
  await write("apps/api/src/a.ts", "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { root, git, write, gitEnvironment };
}

function runNode(script, args, root, env) {
  return spawnSync(process.execPath, [script, ...args, "--root", root], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

test("the require command fails a code change without a fragment and passes once one is added", async () => {
  const { root, git, write, gitEnvironment } = await fixtureRepository();
  try {
    const base = git("rev-parse", "HEAD");
    git("checkout", "-qb", "feature");
    await write("apps/api/src/a.ts", "export const a = 2;\n");
    git("commit", "-qam", "change code");
    // main moves on after the branch point; its own changes are not the PR's.
    git("checkout", "-q", "main");
    await write(
      `${FRAGMENT_DIRECTORY}/2026-10-13-other.md`,
      fragmentText({ date: "2026-10-13" }),
    );
    git("add", "-A");
    git("commit", "-qm", "other PR (#640)");
    const movedBase = git("rev-parse", "HEAD");
    git("checkout", "-q", "feature");

    const missing = runNode(
      LIBRARY,
      ["require", "--base", movedBase, "--head", "HEAD"],
      root,
      gitEnvironment,
    );
    assert.equal(missing.status, 1, missing.stdout + missing.stderr);
    assert.match(missing.stderr, /apps\/api\/src\/a\.ts/);
    assert.match(missing.stderr, /docs\/roadmap\/changelog\.d\//);

    await write(FRAGMENT, fragmentText());
    git("add", "-A");
    git("commit", "-qm", "add fragment");
    const satisfied = runNode(
      LIBRARY,
      ["require", "--base", base, "--head", "HEAD"],
      root,
      gitEnvironment,
    );
    assert.equal(satisfied.status, 0, satisfied.stdout + satisfied.stderr);
    assert.match(satisfied.stdout, /2026-10-14-one-fragment\.md/);

    const unknownBase = runNode(
      LIBRARY,
      [
        "require",
        "--base",
        "0000000000000000000000000000000000000001",
        "--head",
        "HEAD",
      ],
      root,
      gitEnvironment,
    );
    assert.equal(unknownBase.status, 1);
    assert.match(unknownBase.stderr, /cannot compute/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the assembler folds fragments into the changelog, takes a missing PR number from the squash commit and removes them", async () => {
  const { root, git, write, gitEnvironment } = await fixtureRepository();
  try {
    await write(
      `${FRAGMENT_DIRECTORY}/2026-10-14-squashed.md`,
      fragmentText({ pr: undefined, title: "Squashed without number" }),
    );
    git("add", "-A");
    git("commit", "-qm", "feat(x): squashed without number (#661)");
    await write(
      `${FRAGMENT_DIRECTORY}/2026-10-14-local.md`,
      fragmentText({ pr: undefined, title: "Local without number" }),
    );
    await write(
      `${FRAGMENT_DIRECTORY}/2026-10-15-numbered.md`,
      fragmentText({ date: "2026-10-15", pr: "662", title: "Numbered" }),
    );
    git("add", "-A");
    git("commit", "-qm", "wip: local commit");

    const dryRun = runNode(ASSEMBLER, ["--dry-run"], root, gitEnvironment);
    assert.equal(dryRun.status, 0, dryRun.stdout + dryRun.stderr);
    assert.equal(await readFile(join(root, CHANGELOG_PATH), "utf8"), CHANGELOG);
    assert.equal((await readdir(join(root, FRAGMENT_DIRECTORY))).length, 4);

    const result = runNode(ASSEMBLER, [], root, gitEnvironment);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const changelog = await readFile(join(root, CHANGELOG_PATH), "utf8");
    const headings = changelog
      .split("\n")
      .filter((line) => line.startsWith("## "));
    assert.deepEqual(headings.slice(0, 4), [
      "## 2026-10-15 · Numbered (#662)",
      "## 2026-10-14 · Existing same-day entry (#645)",
      "## 2026-10-14 · Squashed without number (#661)",
      "## 2026-10-14 · Local without number",
    ]);
    assert.deepEqual(await readdir(join(root, FRAGMENT_DIRECTORY)), [
      "README.md",
    ]);
    assert.match(result.stdout, /3 fragments/);
    assert.match(result.stderr, /2026-10-14-local\.md.*no PR number/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the assembler refuses to touch anything while a fragment is invalid", async () => {
  const { root, write, gitEnvironment } = await fixtureRepository();
  try {
    await write(FRAGMENT, fragmentText({ date: "2026-10-13" }));
    const result = runNode(ASSEMBLER, [], root, gitEnvironment);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CHANGELOG_FRAGMENT_DATE/);
    assert.equal(await readFile(join(root, CHANGELOG_PATH), "utf8"), CHANGELOG);
    assert.equal((await readdir(join(root, FRAGMENT_DIRECTORY))).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the fragment directory holds only the README and well-formed fragments", async () => {
  const { root, write } = await fixtureRepository();
  try {
    await write(FRAGMENT, fragmentText());
    assert.deepEqual(verifyChangelogFragments(root), []);
    await write(`${FRAGMENT_DIRECTORY}/notes.txt`, "x\n");
    await write(`${FRAGMENT_DIRECTORY}/nested/2026-10-14-x.md`, fragmentText());
    assert.deepEqual(codes(verifyChangelogFragments(root)), [
      "CHANGELOG_FRAGMENT_UNEXPECTED_FILE",
      "CHANGELOG_FRAGMENT_UNEXPECTED_FILE",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("this repository's fragments are well formed", () => {
  assert.deepEqual(verifyChangelogFragments(REPOSITORY_ROOT), []);
});

test("the governance workflow checks every pull request's diff for a fragment", async () => {
  const workflow = await readFile(
    join(REPOSITORY_ROOT, ".github/workflows/governance.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /^\s+fetch-depth: 0$/m,
    "the diff needs the PR's merge base",
  );
  assert.match(
    workflow,
    /^\s+if: \$\{\{ !cancelled\(\) && github\.event_name == 'pull_request' \}\}$/m,
  );
  assert.match(
    workflow,
    /^\s+BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}$/m,
  );
  assert.match(
    workflow,
    /^\s+HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}$/m,
  );
  assert.match(
    workflow,
    /^\s+run: node scripts\/governance-changelog-fragments\.mjs require --base "\$BASE_SHA" --head "\$HEAD_SHA"$/m,
  );
});

test("docs:verify runs the fragment check and exempts fragments from lifecycle metadata", async () => {
  const verifyDocs = await readFile(
    join(REPOSITORY_ROOT, "scripts/verify-docs.mjs"),
    "utf8",
  );
  assert.match(verifyDocs, /from "\.\/governance-changelog-fragments\.mjs"/);
  assert.match(verifyDocs, /verifyChangelogFragments\(root\)/);
  assert.match(verifyDocs, /!isFragmentPath\(repoPath\(path\)\)/);
});
