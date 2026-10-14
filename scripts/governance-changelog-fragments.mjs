#!/usr/bin/env node
// Changelog fragments.
//
// Every PR used to insert its entry near the top of docs/roadmap/changelog.md.
// All of them edit the same lines, so each merge made the other open PRs
// conflict (45 of the 47 PRs #596–#643 edited the file; 24 of the 47 carry
// merges of main, each followed by another full CI round), although the
// ruleset does not require an up-to-date branch. Now each PR adds one file
// under docs/roadmap/changelog.d/ and scripts/changelog-assemble.mjs folds
// the files into the changelog later.
//
//   node scripts/governance-changelog-fragments.mjs verify   [--root <dir>]
//   node scripts/governance-changelog-fragments.mjs require  --base <rev> --head <rev> [--root <dir>]
//
// `verify` checks the fragment format (docs:verify runs the same check).
// `require` fails when the diff base...head changes apps/, packages/,
// scripts/ or infra/ without adding or editing a fragment or the changelog;
// the governance workflow runs it on every pull request.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSafeGitEnvironment } from "./safe-git-environment.mjs";

export const CHANGELOG_PATH = "docs/roadmap/changelog.md";
export const FRAGMENT_DIRECTORY = "docs/roadmap/changelog.d";
export const FRAGMENT_README = `${FRAGMENT_DIRECTORY}/README.md`;
export const CODE_PATH_PREFIXES = Object.freeze([
  "apps/",
  "packages/",
  "scripts/",
  "infra/",
]);
export const REQUIRED_SECTIONS = Object.freeze([
  "起因",
  "改动",
  "测试",
  "未做",
]);

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRAGMENT_NAME = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PR_NUMBER = /^[1-9]\d*$/;
const FRONTMATTER_KEYS = Object.freeze(["date", "pr", "title"]);
const TOP_LEVEL_ITEM = /^- ([^：:\s][^：:]*?)[：:](.*)$/;
const FENCE = /^\s*(?:```|~~~)/;
const DATED_HEADING = /^## (\d{4}-\d{2}-\d{2})\b/;
const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i;

function issue(code, path, detail) {
  return Object.freeze({ code, path, detail });
}

function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function isFragmentPath(repoPath) {
  const prefix = `${FRAGMENT_DIRECTORY}/`;
  if (!repoPath.startsWith(prefix)) return false;
  const name = repoPath.slice(prefix.length);
  return !name.includes("/") && name.endsWith(".md") && name !== "README.md";
}

function isCalendarDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function unquote(value) {
  return /^(["']).*\1$/.test(value) && value.length >= 2
    ? value.slice(1, -1)
    : value;
}

// Lines outside fenced code blocks, as [index, line] pairs.
function unfencedLines(lines) {
  const result = [];
  let inFence = false;
  for (const [index, line] of lines.entries()) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) result.push([index, line]);
  }
  return result;
}

function parseFrontmatter(path, lines, issues) {
  if (lines[0] !== "---") {
    issues.push(
      issue(
        "CHANGELOG_FRAGMENT_FRONTMATTER",
        path,
        "a fragment starts with a --- frontmatter block holding date, pr and title",
      ),
    );
    return null;
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    issues.push(
      issue(
        "CHANGELOG_FRAGMENT_FRONTMATTER",
        path,
        "the frontmatter block is not closed with ---",
      ),
    );
    return null;
  }
  const fields = new Map();
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([a-z]+):(?:\s+(.*))?$/);
    if (!match) {
      issues.push(
        issue(
          "CHANGELOG_FRAGMENT_FRONTMATTER",
          path,
          `unreadable frontmatter line: ${line}`,
        ),
      );
      continue;
    }
    const [, key, value = ""] = match;
    if (!FRONTMATTER_KEYS.includes(key)) {
      issues.push(
        issue(
          "CHANGELOG_FRAGMENT_FRONTMATTER",
          path,
          `unknown frontmatter key ${key}; allowed: ${FRONTMATTER_KEYS.join(", ")}`,
        ),
      );
      continue;
    }
    if (fields.has(key)) {
      issues.push(
        issue(
          "CHANGELOG_FRAGMENT_FRONTMATTER",
          path,
          `frontmatter key ${key} appears twice`,
        ),
      );
      continue;
    }
    fields.set(key, value.trim());
  }
  return { fields, bodyStart: end + 1 };
}

function checkDate(path, date, issues) {
  const nameDate = basename(path).match(FRAGMENT_NAME)?.[1];
  if (date === undefined || !isCalendarDate(date)) {
    issues.push(
      issue(
        "CHANGELOG_FRAGMENT_DATE",
        path,
        `date must be a calendar date YYYY-MM-DD, got ${date ?? "nothing"}`,
      ),
    );
  } else if (nameDate && nameDate !== date) {
    issues.push(
      issue(
        "CHANGELOG_FRAGMENT_DATE",
        path,
        `date ${date} differs from the file name's ${nameDate}`,
      ),
    );
  }
}

function checkPr(path, raw, issues) {
  if (raw === undefined || raw === "") return null;
  if (!PR_NUMBER.test(raw)) {
    issues.push(
      issue(
        "CHANGELOG_FRAGMENT_PR",
        path,
        `pr must be a PR number such as 653 or left empty, got ${raw}`,
      ),
    );
    return null;
  }
  return Number(raw);
}

function checkTitle(path, raw, issues) {
  const title = raw === undefined ? "" : unquote(raw).trim();
  if (!title) {
    issues.push(issue("CHANGELOG_FRAGMENT_TITLE", path, "title is required"));
  } else if (title.startsWith("#")) {
    issues.push(
      issue(
        "CHANGELOG_FRAGMENT_TITLE",
        path,
        "title is plain text; the assembler adds the heading",
      ),
    );
  } else if (/\(#\d+\)\s*$/.test(title)) {
    issues.push(
      issue(
        "CHANGELOG_FRAGMENT_TITLE",
        path,
        "put the PR number in pr:, not in the title; the assembler appends (#N)",
      ),
    );
  }
  return title;
}

// Content belonging to a top-level item: the rest of its line plus the
// indented lines below it, up to the next top-level item.
function itemHasContent(lines, start, rest) {
  if (rest.trim()) return true;
  for (const line of lines.slice(start + 1)) {
    if (/^- /.test(line) || /^#{1,6}\s/.test(line)) return false;
    if (line.trim()) return true;
  }
  return false;
}

function checkBody(path, body, issues) {
  if (!body.trim()) {
    issues.push(
      issue(
        "CHANGELOG_FRAGMENT_BODY",
        path,
        `the body lists ${REQUIRED_SECTIONS.join(" / ")} as top-level items`,
      ),
    );
    return;
  }
  const lines = body.split("\n");
  const visible = unfencedLines(lines);
  for (const [index, line] of visible) {
    if (/^#{1,2}\s/.test(line)) {
      issues.push(
        issue(
          "CHANGELOG_FRAGMENT_BODY",
          path,
          `body line ${index + 1} is a level-1 or level-2 heading; the assembler writes the entry heading`,
        ),
      );
    }
  }
  const items = visible
    .map(([index, line]) => {
      const match = line.match(TOP_LEVEL_ITEM);
      return match ? { index, label: match[1].trim(), rest: match[2] } : null;
    })
    .filter(Boolean);
  let previous = -1;
  for (const section of REQUIRED_SECTIONS) {
    const position = items.findIndex((item) => item.label === section);
    if (position === -1) {
      issues.push(
        issue(
          "CHANGELOG_FRAGMENT_SECTIONS",
          path,
          `missing top-level item "- ${section}："`,
        ),
      );
      continue;
    }
    if (position < previous) {
      issues.push(
        issue(
          "CHANGELOG_FRAGMENT_SECTIONS",
          path,
          `"- ${section}：" must follow the order ${REQUIRED_SECTIONS.join(" / ")}`,
        ),
      );
    }
    previous = Math.max(previous, position);
    const item = items[position];
    if (!itemHasContent(lines, item.index, item.rest)) {
      issues.push(
        issue(
          "CHANGELOG_FRAGMENT_SECTIONS",
          path,
          `"- ${section}：" is empty; write 无 when there is nothing to say`,
        ),
      );
    }
  }
}

export function parseFragment(path, text) {
  const issues = [];
  if (!FRAGMENT_NAME.test(basename(path))) {
    issues.push(
      issue(
        "CHANGELOG_FRAGMENT_FILENAME",
        path,
        "fragment files are named YYYY-MM-DD-<lowercase-slug>.md",
      ),
    );
  }
  if (text.includes("\r")) {
    issues.push(
      issue("CHANGELOG_FRAGMENT_FRONTMATTER", path, "use LF line endings"),
    );
    return { path, date: null, pr: null, title: "", body: "", issues };
  }
  const lines = text.split("\n");
  const frontmatter = parseFrontmatter(path, lines, issues);
  if (!frontmatter)
    return { path, date: null, pr: null, title: "", body: "", issues };
  const { fields, bodyStart } = frontmatter;
  const date = fields.get("date");
  checkDate(path, date, issues);
  const pr = checkPr(path, fields.get("pr"), issues);
  const title = checkTitle(path, fields.get("title"), issues);
  const body = lines.slice(bodyStart).join("\n").replace(/^\n+/, "").trimEnd();
  checkBody(path, body, issues);
  return { path, date: date ?? null, pr, title, body, issues };
}

export function validateFragment(path, text) {
  return parseFragment(path, text).issues;
}

function listFragmentDirectory(root) {
  try {
    return readdirSync(resolve(root, FRAGMENT_DIRECTORY), {
      withFileTypes: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

// Parsed fragments plus issues for anything else found in the directory.
export function readFragments(root = DEFAULT_ROOT) {
  const fragments = [];
  const issues = [];
  for (const entry of listFragmentDirectory(root)) {
    const path = `${FRAGMENT_DIRECTORY}/${entry.name}`;
    if (path === FRAGMENT_README && entry.isFile()) continue;
    if (!entry.isFile() || !isFragmentPath(path)) {
      issues.push(
        issue(
          "CHANGELOG_FRAGMENT_UNEXPECTED_FILE",
          path,
          `${FRAGMENT_DIRECTORY}/ holds only README.md and YYYY-MM-DD-<slug>.md fragments`,
        ),
      );
      continue;
    }
    const fragment = parseFragment(
      path,
      readFileSync(resolve(root, path), "utf8"),
    );
    fragments.push(fragment);
    issues.push(...fragment.issues);
  }
  fragments.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return { fragments, issues };
}

export function verifyChangelogFragments(root = DEFAULT_ROOT) {
  return readFragments(root).issues;
}

export function parseNameStatus(output) {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    changes.push({ status: fields[index], path: fields[index + 1] });
  }
  return changes;
}

export function fragmentRequirement(changes) {
  const codePaths = changes
    .filter(({ path }) =>
      CODE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)),
    )
    .map(({ path }) => path);
  const fragmentPaths = changes
    .filter(({ status, path }) => status !== "D" && isFragmentPath(path))
    .map(({ path }) => path);
  const changelogEdited = changes.some(
    ({ status, path }) => status !== "D" && path === CHANGELOG_PATH,
  );
  const required = codePaths.length > 0;
  return {
    required,
    satisfied: !required || fragmentPaths.length > 0 || changelogEdited,
    codePaths,
    fragmentPaths,
    changelogEdited,
  };
}

// GitHub squash merges end the subject with " (#N)".
export function prFromSquashSubject(subject) {
  const match = subject.match(/\(#(\d+)\)\s*$/);
  return match ? Number(match[1]) : null;
}

function rebaseTarget(target, fromDirectory, toDirectory) {
  if (!target || EXTERNAL_TARGET.test(target)) return target;
  const hash = target.indexOf("#");
  const file = hash === -1 ? target : target.slice(0, hash);
  const anchor = hash === -1 ? "" : target.slice(hash);
  const absolute = posix.normalize(posix.join(fromDirectory, file));
  const rebased = posix.relative(toDirectory, absolute) || ".";
  return `${rebased}${anchor}`;
}

function rewriteLine(line, fromDirectory, toDirectory) {
  // Split off inline code spans so links quoted as code stay untouched.
  return line
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith("`")
        ? part
        : part.replace(
            /(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g,
            (_, open, target, close) =>
              `${open}${rebaseTarget(target, fromDirectory, toDirectory)}${close}`,
          ),
    )
    .join("");
}

// A fragment's relative links are written from FRAGMENT_DIRECTORY; once the
// body moves into the changelog they must point from the changelog instead.
export function rewriteRelativeLinks(body, fromDirectory, toDirectory) {
  const lines = body.split("\n");
  let inFence = false;
  return lines
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : rewriteLine(line, fromDirectory, toDirectory);
    })
    .join("\n");
}

function compareFragments(left, right) {
  // Within one day: PR number ascending (merge order), unnumbered last, then path.
  const leftPr = left.pr ?? Number.POSITIVE_INFINITY;
  const rightPr = right.pr ?? Number.POSITIVE_INFINITY;
  if (leftPr !== rightPr) return leftPr - rightPr;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export function renderFragmentSection(fragment) {
  const heading = `## ${fragment.date} · ${fragment.title}${fragment.pr ? ` (#${fragment.pr})` : ""}`;
  const body = rewriteRelativeLinks(
    fragment.body,
    FRAGMENT_DIRECTORY,
    posix.dirname(CHANGELOG_PATH),
  );
  return [heading, "", ...body.split("\n")];
}

// Index of the line a fragment of `date` goes before: the first dated entry
// of an earlier day, or the first undated heading that ends the dated run.
function insertionIndex(lines, date) {
  for (const [index, line] of unfencedLines(lines)) {
    if (!line.startsWith("## ")) continue;
    const headingDate = line.match(DATED_HEADING)?.[1];
    if (!headingDate || headingDate < date) return index;
  }
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function assembleChangelog(changelog, fragments) {
  if (fragments.length === 0) return changelog;
  const ordered = fragments.toSorted(compareFragments);
  let lines = changelog.split("\n");
  for (const fragment of ordered) {
    const index = insertionIndex(lines, fragment.date);
    // One blank line on each side; at the end of the file the final "" (the
    // trailing newline) already closes the section.
    const before = index > 0 && lines[index - 1] !== "" ? [""] : [];
    const atEnd = index === lines.length - 1 && lines.at(-1) === "";
    const after = atEnd ? [] : [""];
    lines = [
      ...lines.slice(0, index),
      ...before,
      ...renderFragmentSection(fragment),
      ...after,
      ...lines.slice(index),
    ];
  }
  const text = lines.join("\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

function git(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: createSafeGitEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function changedPaths(root, base, head) {
  const result = git(root, [
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    `${base}...${head}`,
  ]);
  if (result.status !== 0) {
    throw new Error(
      `cannot compute the diff ${base}...${head}: ${(result.stderr || result.error?.message || "").trim()}`,
    );
  }
  return parseNameStatus(result.stdout);
}

// The squash commit that added a fragment carries its PR number.
export function prFromHistory(root, path) {
  const result = git(root, [
    "log",
    "--diff-filter=A",
    "--format=%s",
    "--",
    path,
  ]);
  if (result.status !== 0) return null;
  const subjects = result.stdout.split("\n").filter(Boolean);
  return subjects.length === 0 ? null : prFromSquashSubject(subjects.at(-1));
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = { command, root: DEFAULT_ROOT };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--root" || flag === "--base" || flag === "--head") {
      const value = rest[index + 1];
      if (!value) throw new Error(`${flag} needs a value`);
      options[flag.slice(2)] = flag === "--root" ? resolve(value) : value;
      index += 1;
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  return options;
}

function printIssues(issues) {
  for (const { code, path, detail } of issues) {
    console.error(`ERROR ${code} ${path}: ${detail}`);
  }
}

function runRequire({ root, base, head }) {
  if (!base || !head) throw new Error("require needs --base and --head");
  const result = fragmentRequirement(changedPaths(root, base, head));
  if (!result.required) {
    console.log(
      "changelog fragment: not required (no change under apps/, packages/, scripts/ or infra/)",
    );
    return 0;
  }
  if (result.satisfied) {
    const evidence = [
      ...result.fragmentPaths,
      ...(result.changelogEdited ? [CHANGELOG_PATH] : []),
    ];
    console.log(`changelog fragment: present (${evidence.join(", ")})`);
    return 0;
  }
  const shown = result.codePaths.slice(0, 10).join(", ");
  const more =
    result.codePaths.length > 10
      ? ` and ${result.codePaths.length - 10} more`
      : "";
  console.error(
    `::error::This PR changes ${shown}${more} but adds no changelog fragment. ` +
      `Add ${FRAGMENT_DIRECTORY}/<YYYY-MM-DD>-<slug>.md (format: ${FRAGMENT_README}).`,
  );
  return 1;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.command === "verify") {
      const issues = verifyChangelogFragments(options.root);
      printIssues(issues);
      console.log(
        `changelog fragments: ${issues.length === 0 ? "PASS" : "FAIL"}`,
      );
      return issues.length === 0 ? 0 : 1;
    }
    if (options.command === "require") return runRequire(options);
    throw new Error(
      "usage: governance-changelog-fragments.mjs <verify|require> [--base <rev> --head <rev>] [--root <dir>]",
    );
  } catch (error) {
    console.error(`::error::${error.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
