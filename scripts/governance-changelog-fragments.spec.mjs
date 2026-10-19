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
  CODE_ROOT_FILES,
  FRAGMENT_DIRECTORY,
  FRAGMENT_README,
  assembleChangelog,
  branchPredatesFragmentRule,
  fragmentRequirement,
  isFragmentPath,
  lifecycleExemptFragment,
  parseFragment,
  parseNameStatus,
  prFromSquashSubject,
  rewriteRelativeLinks,
  validateFragment,
  verifyChangelogFragments,
  verifyFragmentPolicy,
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

function details(path, text) {
  return validateFragment(path, text).map((issue) => issue.detail);
}

test("frontmatter errors say how to write the line instead of only quoting it", () => {
  const capitalised = details(
    FRAGMENT,
    fragmentText().replace("date: 2026-10-14", "Date: 2026-10-14"),
  );
  assert.ok(
    capitalised.some((detail) => /lowercase.*"date: …"/.test(detail)),
    JSON.stringify(capitalised),
  );
  assert.ok(
    capitalised.some((detail) => /date is missing/.test(detail)),
    JSON.stringify(capitalised),
  );

  const noSpace = details(
    FRAGMENT,
    fragmentText().replace(
      "title: Keep one fragment per PR",
      "title:Keep one fragment per PR",
    ),
  );
  assert.ok(
    noSpace.some((detail) =>
      /space after the colon.*"title: Keep one fragment per PR"/.test(detail),
    ),
    JSON.stringify(noSpace),
  );

  const unreadable = details(FRAGMENT, fragmentText({ extra: "just words" }));
  assert.ok(
    unreadable.some((detail) =>
      /"<key>: <value>".*date, pr, title/.test(detail),
    ),
    JSON.stringify(unreadable),
  );

  const byteOrderMark = details(FRAGMENT, `\uFEFF${fragmentText()}`);
  assert.ok(
    byteOrderMark.some((detail) => /byte order mark/.test(detail)),
    JSON.stringify(byteOrderMark),
  );
});

test("body errors point at the line of the file and say what a top-level item looks like", () => {
  // Frontmatter is lines 1-5, line 6 is blank, the body starts on line 7.
  const heading = details(
    FRAGMENT,
    fragmentText({ body: `## 起因\n\n${BODY}` }),
  );
  assert.ok(
    heading.some((detail) => /^line 7 /.test(detail)),
    JSON.stringify(heading),
  );

  const starred = details(
    FRAGMENT,
    fragmentText({ body: BODY.replace("- 起因：", "* 起因：") }),
  );
  assert.ok(
    starred.some((detail) =>
      /missing top-level item "- 起因：".*not indented/.test(detail),
    ),
    JSON.stringify(starred),
  );
});

test("a malformed file name says which characters a slug may use", () => {
  const named = details(
    `${FRAGMENT_DIRECTORY}/2026-10-14-One_Fragment.md`,
    fragmentText(),
  );
  assert.ok(
    named.some((detail) =>
      /lowercase letters, digits and hyphens/.test(detail),
    ),
    JSON.stringify(named),
  );
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

  const changelogOnly = [
    { status: "M", path: "infra/x.yml" },
    { status: "M", path: CHANGELOG_PATH },
  ];
  // A direct changelog edit counts only for a branch cut before the fragment
  // rule reached main; the caller decides that from the merge base.
  const legacyBranch = fragmentRequirement(changelogOnly, {
    changelogEditAccepted: true,
  });
  assert.equal(legacyBranch.satisfied, true);
  assert.equal(legacyBranch.changelogEdited, true);
  const newBranch = fragmentRequirement(changelogOnly, {
    changelogEditAccepted: false,
  });
  assert.equal(newBranch.satisfied, false);
  assert.equal(newBranch.changelogEdited, true);
  // Without the caller's word that the branch predates the rule, the edit
  // does not count.
  assert.equal(fragmentRequirement(changelogOnly).satisfied, false);
});

test("root files that go into the build or the runtime image need a fragment too", () => {
  for (const rootFile of [
    "Dockerfile",
    "runtime-entrypoint.mjs",
    "docker-compose.yml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "package.json",
    "pnpm-lock.yaml",
  ]) {
    const missing = fragmentRequirement([{ status: "M", path: rootFile }]);
    assert.equal(missing.required, true, rootFile);
    assert.equal(missing.satisfied, false, rootFile);
    assert.deepEqual(missing.codePaths, [rootFile]);
  }
  // Only the file at the root counts, not a file of that name elsewhere.
  for (const elsewhere of ["docs/Dockerfile", "docs/package.json"]) {
    assert.equal(
      fragmentRequirement([{ status: "M", path: elsewhere }]).required,
      false,
      elsewhere,
    );
  }
});

// Every tracked file at the repository root is either a build or runtime
// input (CODE_ROOT_FILES) or one of these; a new root file needs a decision.
const NON_CODE_ROOT_FILES = Object.freeze([
  ".editorconfig",
  ".env.example",
  ".gitignore",
  ".gitleaks.toml",
  ".gitleaksignore",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "README.md",
]);

test("every tracked root file is classified as code or not", () => {
  const tracked = execFileSync("git", ["ls-files"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: createSafeGitEnvironment(),
  })
    .split("\n")
    .filter((path) => path && !path.includes("/"));
  assert.ok(tracked.includes("Dockerfile"), JSON.stringify(tracked));
  const unclassified = tracked.filter(
    (path) =>
      !CODE_ROOT_FILES.includes(path) && !NON_CODE_ROOT_FILES.includes(path),
  );
  assert.deepEqual(
    unclassified,
    [],
    "add each new root file to CODE_ROOT_FILES or NON_CODE_ROOT_FILES",
  );
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

test("angle-bracket targets and single-quoted titles are rebased too", () => {
  const body = [
    '- 起因：[有空格](<../../evidence/a b.md>)、[带标题](<../../evidence/c.md> "t")。',
    "- 改动：[单引号](../../backend/d.md 'title')、[外链](<https://example.org/a b>)。",
  ].join("\n");
  assert.equal(
    rewriteRelativeLinks(body, FRAGMENT_DIRECTORY, "docs/roadmap"),
    [
      '- 起因：[有空格](<../evidence/a b.md>)、[带标题](<../evidence/c.md> "t")。',
      "- 改动：[单引号](../backend/d.md 'title')、[外链](<https://example.org/a b>)。",
    ].join("\n"),
  );
});

test("reference-style link and footnote definitions are rejected because nothing checks or rebases them", () => {
  for (const definition of [
    "[r]: ../../evidence/d.md",
    '  [r]: <../../evidence/d.md> "title"',
    "[^1]: a footnote",
  ]) {
    const issues = validateFragment(
      FRAGMENT,
      fragmentText({ body: `${BODY}\n${definition}\n` }),
    );
    assert.deepEqual(codes(issues), ["CHANGELOG_FRAGMENT_LINK"], definition);
    assert.match(issues[0].detail, /\[text\]\(target\)/);
    // Frontmatter is lines 1-5, the body runs from line 7; BODY ends with a
    // newline, so a blank line 12 precedes the definition.
    assert.match(issues[0].detail, /^line 13 /);
  }
  // Inside a code block or an inline code span it is only text.
  for (const body of [
    `${BODY}\n\`\`\`md\n[r]: ../../evidence/d.md\n\`\`\`\n`,
    `${BODY}\n\`[r]: ../../evidence/d.md\`\n`,
  ]) {
    assert.deepEqual(validateFragment(FRAGMENT, fragmentText({ body })), []);
  }
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

async function fixtureRepository({ withRule = true } = {}) {
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
  if (withRule) await write(FRAGMENT_README, "# Fragments\n");
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

// main without the fragment README, a branch cut there that changes code and
// edits the changelog, then main takes the fragment rule and one more code PR.
async function legacyBranchFixture() {
  const fixture = await fixtureRepository({ withRule: false });
  const { git, write } = fixture;
  const legacyPoint = git("rev-parse", "HEAD");
  git("checkout", "-qb", "legacy-pr", legacyPoint);
  await write("scripts/x.mjs", "export {};\n");
  await write(CHANGELOG_PATH, `${CHANGELOG}\n- legacy PR entry\n`);
  git("add", "-A");
  git("commit", "-qm", "legacy PR edits the changelog");
  const legacyTip = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  await write(FRAGMENT_README, "# Fragments\n");
  git("add", "-A");
  git("commit", "-qm", "fragment rule (#658)");
  const ruleOnMain = git("rev-parse", "HEAD");
  await write("apps/api/src/a.ts", "export const a = 2;\n");
  git("commit", "-qam", "later code PR (#661)");
  const mainTip = git("rev-parse", "HEAD");
  return { ...fixture, legacyPoint, legacyTip, ruleOnMain, mainTip };
}

test("a branch cut before the fragment rule may still edit the changelog, with a warning", async () => {
  const { root, git, gitEnvironment, ruleOnMain } = await legacyBranchFixture();
  try {
    git("checkout", "-q", "legacy-pr");
    const legacy = runNode(
      LIBRARY,
      ["require", "--base", ruleOnMain, "--head", "HEAD"],
      root,
      gitEnvironment,
    );
    assert.equal(legacy.status, 0, legacy.stdout + legacy.stderr);
    assert.match(legacy.stdout, /^::warning::.*cut before the fragment rule/m);
    assert.match(legacy.stdout, /^::warning::.*changelog\.d\//m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a branch cut before the fragment rule keeps the exception after it merges main in, from either side", async () => {
  const { root, git, gitEnvironment, legacyTip, mainTip } =
    await legacyBranchFixture();
  try {
    // GitHub's "Update branch" and its conflict editor merge main into the
    // PR branch: the merge base becomes main's tip, which has the README.
    git("checkout", "-q", "legacy-pr");
    git("merge", "-q", "--no-edit", mainTip);
    const updated = runNode(
      LIBRARY,
      ["require", "--base", mainTip, "--head", "HEAD"],
      root,
      gitEnvironment,
    );
    assert.equal(updated.status, 0, updated.stdout + updated.stderr);
    assert.match(updated.stdout, /^::warning::.*cut before the fragment rule/m);

    // The same merge made from main's side puts main first among the parents.
    git("checkout", "-qb", "merged-from-main", mainTip);
    git("merge", "-q", "--no-edit", legacyTip);
    const reversed = runNode(
      LIBRARY,
      ["require", "--base", mainTip, "--head", "HEAD"],
      root,
      gitEnvironment,
    );
    assert.equal(reversed.status, 0, reversed.stdout + reversed.stderr);
    assert.match(
      reversed.stdout,
      /^::warning::.*cut before the fragment rule/m,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a branch cut before the fragment rule and then rebased onto main must write a fragment", async () => {
  const { root, git, gitEnvironment, legacyTip, mainTip } =
    await legacyBranchFixture();
  try {
    git("checkout", "-qb", "rebased-pr", legacyTip);
    git("rebase", "-q", mainTip);
    const rebased = runNode(
      LIBRARY,
      ["require", "--base", mainTip, "--head", "HEAD"],
      root,
      gitEnvironment,
    );
    assert.equal(rebased.status, 1, rebased.stdout + rebased.stderr);
    // A rebase leaves no trace of the old cut, so the error names it.
    assert.match(rebased.stderr, /cut after the fragment rule/);
    assert.match(rebased.stderr, /rebased onto it/);
    assert.match(rebased.stderr, /docs\/roadmap\/changelog\.d\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the cut-before check fails closed when it cannot find or read where the branch leaves base", async () => {
  const { root, git, write, legacyPoint, legacyTip, ruleOnMain, mainTip } =
    await legacyBranchFixture();
  try {
    assert.equal(branchPredatesFragmentRule(root, mainTip, legacyTip), true);
    git("checkout", "-qb", "late-pr", mainTip);
    await write("scripts/y.mjs", "export {};\n");
    git("add", "-A");
    git("commit", "-qm", "late PR");
    const lateTip = git("rev-parse", "HEAD");
    assert.equal(branchPredatesFragmentRule(root, mainTip, lateTip), false);
    // Nothing on the branch: nothing to accept.
    assert.equal(branchPredatesFragmentRule(root, mainTip, ruleOnMain), false);

    assert.throws(
      () => branchPredatesFragmentRule(root, "no-such-ref", lateTip),
      /cannot list the commits/,
    );

    // History that never meets base (a shallow clone looks the same).
    git("checkout", "-q", "--orphan", "unrelated");
    await write("scripts/z.mjs", "export {};\n");
    git("add", "-A");
    git("commit", "-qm", "unrelated root");
    const unrelated = git("rev-parse", "HEAD");
    assert.throws(
      () => branchPredatesFragmentRule(root, mainTip, unrelated),
      /never meets/,
    );

    // A fork point whose tree cannot be read is an error, not a legacy branch.
    const tree = git("rev-parse", `${legacyPoint}^{tree}`);
    await rm(join(root, ".git/objects", tree.slice(0, 2), tree.slice(2)));
    assert.throws(
      () => branchPredatesFragmentRule(root, mainTip, legacyTip),
      /cannot read the tree/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

    // A branch cut after the fragment rule reached main (its merge base has
    // the fragment README) may not edit the changelog instead of a fragment.
    git("checkout", "-qb", "late-pr", base);
    await write("scripts/x.mjs", "export {};\n");
    await write(CHANGELOG_PATH, `${CHANGELOG}\n- late PR entry\n`);
    git("add", "-A");
    git("commit", "-qm", "late PR edits the changelog");
    const late = runNode(
      LIBRARY,
      ["require", "--base", movedBase, "--head", "HEAD"],
      root,
      gitEnvironment,
    );
    assert.equal(late.status, 1, late.stdout + late.stderr);
    assert.match(late.stderr, /cut after the fragment rule/);
    assert.match(late.stderr, /docs\/roadmap\/changelog\.d\//);
    assert.doesNotMatch(satisfied.stdout, /::warning::/);

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

test("the require command diffs from the merge base, so code main merged after the branch point is not the PR's", async () => {
  const { root, git, write, gitEnvironment } = await fixtureRepository();
  try {
    git("checkout", "-qb", "docs-only");
    await write("docs/status/current.md", "# Current\n");
    git("add", "-A");
    git("commit", "-qm", "docs only");
    // main merges a code change after the branch point; the PR's base.sha is
    // that newer main, not the merge base.
    git("checkout", "-q", "main");
    await write("apps/api/src/a.ts", "export const a = 3;\n");
    git("commit", "-qam", "code PR (#650)");
    const movedBase = git("rev-parse", "HEAD");
    git("checkout", "-q", "docs-only");

    const result = runNode(
      LIBRARY,
      ["require", "--base", movedBase, "--head", "HEAD"],
      root,
      gitEnvironment,
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /not required/);
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

test("a fragment name reused after an assembly takes the PR number of the commit that added it last", async () => {
  const { root, git, write, gitEnvironment } = await fixtureRepository();
  const reused = `${FRAGMENT_DIRECTORY}/2026-10-20-fix-x.md`;
  try {
    await write(
      reused,
      fragmentText({ date: "2026-10-20", pr: undefined, title: "First fix" }),
    );
    git("add", "-A");
    git("commit", "-qm", "fix(x): first (#700)");
    git("rm", "-q", reused);
    git(
      "commit",
      "-qm",
      "docs(changelog): assemble fragments through #700 (#701)",
    );
    await write(
      reused,
      fragmentText({ date: "2026-10-20", pr: undefined, title: "Second fix" }),
    );
    git("add", "-A");
    git("commit", "-qm", "fix(x): second (#705)");

    const result = runNode(ASSEMBLER, [], root, gitEnvironment);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const changelog = await readFile(join(root, CHANGELOG_PATH), "utf8");
    assert.match(changelog, /^## 2026-10-20 · Second fix \(#705\)$/m);
    assert.doesNotMatch(changelog, /#700/);
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

    await write(FRAGMENT, fragmentText());
    const fixed = runNode(ASSEMBLER, [], root, gitEnvironment);
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
    assert.match(fixed.stdout, /folded 1 fragment into/);
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
  // The comment on the step must not promise that a changelog edit always
  // counts.
  assert.doesNotMatch(workflow, /\(or edits\s*(#\s*)?the changelog\)/);
  assert.match(workflow, /# .*cut before the fragment rule/);
});

test("CONTRIBUTING and the fragment README describe the transition the check enforces", async () => {
  for (const path of ["CONTRIBUTING.md", FRAGMENT_README]) {
    const text = await readFile(join(REPOSITORY_ROOT, path), "utf8");
    const transition = text
      .split("\n")
      .find((line) => /^- (\*\*)?过渡(\*\*)?：/.test(line));
    assert.ok(transition, `${path} has a transition item`);
    assert.match(transition, /片段规则合入 main 之前切出/, path);
    // Merging main in keeps the exception; a rebase loses it.
    assert.match(transition, /merge/, path);
    assert.match(transition, /rebase/, path);
    assert.doesNotMatch(transition, /不看 PR 何时开/, path);
  }
});

test("the merge runbook says who assembles the fragments, when, and how to roll back", async () => {
  const runbook = await readFile(
    join(REPOSITORY_ROOT, "docs/backend/ci-merge-automation.md"),
    "utf8",
  );
  const section = runbook.slice(runbook.indexOf("## Changelog 片段的汇编"));
  assert.ok(section.startsWith("## Changelog 片段的汇编"), "section exists");
  const body = section.slice(0, section.indexOf("\n## ", 1));
  assert.match(body, /发版列车/);
  assert.match(body, /node scripts\/changelog-assemble\.mjs --dry-run/);
  assert.match(body, /docs\(changelog\)/);
  assert.match(body, /回退/);
});

const POLICY_PATH = "docs/governance/docs-verification-policy.json";

function policyWith(directories) {
  return {
    lifecycleRequired: {
      prefixes: ["docs/roadmap/"],
      ...(directories ? { frontmatterFragmentDirectories: directories } : {}),
    },
  };
}

test("only the docs-verification policy exempts fragments from the lifecycle line", () => {
  const listed = policyWith([`${FRAGMENT_DIRECTORY}/`]);
  assert.equal(lifecycleExemptFragment(listed, FRAGMENT), true);
  assert.equal(
    lifecycleExemptFragment(listed, `${FRAGMENT_DIRECTORY}/README.md`),
    false,
  );
  assert.equal(
    lifecycleExemptFragment(listed, "docs/roadmap/release-plan.md"),
    false,
  );
  // Take the directory out of the policy and fragments need the line again.
  assert.equal(lifecycleExemptFragment(policyWith(), FRAGMENT), false);
  assert.equal(lifecycleExemptFragment(policyWith([]), FRAGMENT), false);
});

test("the policy may list only the directory whose frontmatter this script checks", () => {
  assert.deepEqual(
    verifyFragmentPolicy(policyWith([`${FRAGMENT_DIRECTORY}/`])),
    [],
  );
  assert.deepEqual(verifyFragmentPolicy(policyWith()), []);
  const drifted = verifyFragmentPolicy(
    policyWith([`${FRAGMENT_DIRECTORY}/`, "docs/research/"]),
  );
  assert.deepEqual(codes(drifted), ["CHANGELOG_FRAGMENT_POLICY"]);
  assert.equal(drifted[0].path, POLICY_PATH);
  assert.match(drifted[0].detail, /docs\/research\//);
});

test("docs:verify runs the fragment check and takes the lifecycle exemption from the policy", async () => {
  const verifyDocs = await readFile(
    join(REPOSITORY_ROOT, "scripts/verify-docs.mjs"),
    "utf8",
  );
  assert.match(verifyDocs, /from "\.\/governance-changelog-fragments\.mjs"/);
  assert.match(verifyDocs, /verifyChangelogFragments\(root\)/);
  assert.match(verifyDocs, /verifyFragmentPolicy\(policy\)/);
  assert.match(
    verifyDocs,
    /!lifecycleExemptFragment\(policy, repoPath\(path\)\)/,
  );
  assert.doesNotMatch(verifyDocs, /isFragmentPath/);

  const policy = JSON.parse(
    await readFile(join(REPOSITORY_ROOT, POLICY_PATH), "utf8"),
  );
  assert.deepEqual(policy.lifecycleRequired.frontmatterFragmentDirectories, [
    `${FRAGMENT_DIRECTORY}/`,
  ]);
  assert.deepEqual(verifyFragmentPolicy(policy), []);
});

function section(markdown, heading) {
  const start = markdown.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `${heading} exists`);
  const end = markdown.indexOf("\n## ", start + heading.length + 1);
  return markdown.slice(start, end === -1 ? undefined : end);
}

test("the docs-verification governance page records the fragment checks and their exceptions", async () => {
  const page = await readFile(
    join(REPOSITORY_ROOT, "docs/governance/docs-verification.md"),
    "utf8",
  );
  assert.match(
    section(page, "## 1. 运行方式"),
    /governance-changelog-fragments\.mjs require/,
  );
  const checks = section(page, "## 2. 检查面与失败语义");
  assert.match(checks, /^\| Changelog 片段格式 \|.*CHANGELOG_FRAGMENT_\*/m);
  assert.match(checks, /^\| 代码 PR 的 changelog 片段 \|/m);
  const scope = section(page, "## 3. 受控范围");
  assert.match(scope, /frontmatterFragmentDirectories/);
  const exceptions = section(page, "## 4. 当前显式例外");
  const fragmentRow = exceptions
    .split("\n")
    .find((line) => line.startsWith("| `docs/roadmap/changelog.d/"));
  assert.ok(fragmentRow, "lifecycle exemption row");
  for (const field of ["风险", "Owner", "关闭条件", "successor"]) {
    assert.ok(fragmentRow.includes(field), `${field} in ${fragmentRow}`);
  }
  const transitionRow = exceptions
    .split("\n")
    .find((line) => line.includes("changelogEditAccepted"));
  assert.ok(transitionRow, "transition exception row");
  for (const field of ["风险", "Owner", "关闭条件", "successor"]) {
    assert.ok(transitionRow.includes(field), `${field} in ${transitionRow}`);
  }
  // The closing condition names the check someone can run.
  assert.match(transitionRow, /gh pr list --state open/);
  assert.match(transitionRow, /cut before the fragment rule/);
});
