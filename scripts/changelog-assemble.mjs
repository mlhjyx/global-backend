#!/usr/bin/env node
// Fold the changelog fragments into docs/roadmap/changelog.md and delete them.
//
//   node scripts/changelog-assemble.mjs [--dry-run] [--root <dir>]
//
// Anyone (or a release train) runs it on a fresh branch from origin/main and
// opens the result as a docs(changelog) PR; nothing commits to main directly.
// Entries go newest day first; within a day they follow the entries already
// there, in PR order. A fragment without `pr:` takes the number from the
// squash commit that added it ("subject (#N)"); without one it is written
// without a number and reported on stderr. Nothing is written while any
// fragment is invalid.
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CHANGELOG_PATH,
  assembleChangelog,
  prFromHistory,
  readFragments,
} from "./governance-changelog-fragments.mjs";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const options = { root: DEFAULT_ROOT, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      options.dryRun = true;
    } else if (flag === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root needs a value");
      options.root = resolve(value);
      index += 1;
    } else {
      throw new Error(
        `unknown argument ${flag}; usage: changelog-assemble.mjs [--dry-run] [--root <dir>]`,
      );
    }
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  const { root, dryRun } = options;
  const { fragments, issues } = readFragments(root);
  if (issues.length > 0) {
    for (const { code, path, detail } of issues) {
      console.error(`ERROR ${code} ${path}: ${detail}`);
    }
    console.error(
      "changelog-assemble: nothing written; fix the fragments first",
    );
    return 1;
  }
  if (fragments.length === 0) {
    console.log("changelog-assemble: no fragments to assemble");
    return 0;
  }

  const resolved = fragments.map((fragment) => {
    if (fragment.pr !== null) return fragment;
    const pr = prFromHistory(root, fragment.path);
    if (pr === null) {
      console.error(
        `changelog-assemble: ${fragment.path} has no PR number in pr: or in the commit that added it; written without one`,
      );
    }
    return { ...fragment, pr };
  });

  const changelogFile = resolve(root, CHANGELOG_PATH);
  const assembled = assembleChangelog(
    readFileSync(changelogFile, "utf8"),
    resolved,
  );
  const summary = resolved
    .map(
      (fragment) =>
        `  ${fragment.date} · ${fragment.title}${fragment.pr ? ` (#${fragment.pr})` : ""}`,
    )
    .join("\n");
  if (dryRun) {
    console.log(
      `changelog-assemble: would fold ${resolved.length} fragments into ${CHANGELOG_PATH}:\n${summary}`,
    );
    return 0;
  }
  writeFileSync(changelogFile, assembled);
  for (const fragment of resolved) unlinkSync(resolve(root, fragment.path));
  console.log(
    `changelog-assemble: folded ${resolved.length} fragments into ${CHANGELOG_PATH} and removed them:\n${summary}\n` +
      "Run pnpm docs:verify, then open the change as a docs(changelog) PR.",
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
