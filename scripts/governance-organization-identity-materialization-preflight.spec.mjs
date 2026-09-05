import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  verifyMaterializationFile,
  verifyMaterializationGitIdentity,
  verifyMaterializationReview,
  verifyMaterializationDestinations,
  verifyMaterializationOutput,
  verifyMaterializationPlannedFile,
  writeExclusiveMaterializationOutput,
} from "./governance-organization-identity-materialization-preflight.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "materialization-facts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "executable.mjs");
  writeFileSync(file, "export const answer = 42;\n", { mode: 0o500 });
  return {
    root,
    file,
    expected: { sha256: hash(readFileSync(file)), size: 26, mode: 0o500 },
  };
}

test("real regular bytes produce local facts, never independent authority", (t) => {
  const { root, file, expected } = fixture(t);
  assert.equal(
    verifyMaterializationFile(file, expected, [root]).status,
    "LOCAL_FACTS_VERIFIED",
  );
});

test("planned bytes require exact rendered or approved byte length, digest and mode", (t) => {
  const { file } = fixture(t);
  const bytes = readFileSync(file);
  const planned = { sha256: hash(bytes), size: 26, mode: 0o500 };
  assert.equal(
    verifyMaterializationPlannedFile(planned, bytes, 0o500).status,
    "LOCAL_FACTS_VERIFIED",
  );
  for (const change of [
    { size: 1 },
    { sha256: "a".repeat(64) },
    { mode: 0o777 },
  ]) {
    assert.equal(
      verifyMaterializationPlannedFile({ ...planned, ...change }, bytes, 0o500)
        .code,
      "PLANNED_BYTES_MISMATCH",
    );
  }
});

test("source checks reject missing, mismatched, symlink, hardlink, nonregular and escaped roots", (t) => {
  const { root, file, expected } = fixture(t);
  const symlink = path.join(root, "sym");
  symlinkSync(file, symlink);
  const directory = path.join(root, "directory");
  mkdirSync(directory);
  for (const [candidate, identity, roots] of [
    [path.join(root, "missing"), expected, [root]],
    [file, { ...expected, size: 1 }, [root]],
    [file, { ...expected, sha256: "0".repeat(64) }, [root]],
    [file, { ...expected, mode: 0o700 }, [root]],
    [symlink, expected, [root]],
    [directory, expected, [root]],
    [file, expected, [directory]],
  ])
    assert.equal(
      verifyMaterializationFile(candidate, identity, roots).status,
      "HOLD",
    );
  linkSync(file, path.join(root, "hard"));
  assert.equal(
    verifyMaterializationFile(file, expected, [root]).status,
    "HOLD",
  );
});

test("source replacement or byte drift invalidates the next bounded observation", (t) => {
  const { root, file, expected } = fixture(t);
  assert.equal(
    verifyMaterializationFile(file, expected, [root]).status,
    "LOCAL_FACTS_VERIFIED",
  );
  chmodSync(file, 0o700);
  writeFileSync(file, "export const answer = 43;\n");
  assert.equal(
    verifyMaterializationFile(file, expected, [root]).status,
    "HOLD",
  );
});

function gitFixture(t) {
  const f = fixture(t);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: f.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  writeFileSync(path.join(f.root, ".gitignore"), "evidence/\n");
  git("add", "executable.mjs", ".gitignore");
  git(
    "-c",
    "user.name=Local Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const commit = git("rev-parse", "HEAD");
  return {
    ...f,
    git,
    identity: {
      commit,
      blobId: git("rev-parse", `${commit}:executable.mjs`),
      sha256: f.expected.sha256,
      size: f.expected.size,
    },
  };
}

test("clean temporary Git bytes match tuple; wrong generator and dirty bytes HOLD", (t) => {
  const { root, file, identity } = gitFixture(t);
  assert.equal(
    verifyMaterializationGitIdentity(root, "executable.mjs", identity).status,
    "LOCAL_FACTS_VERIFIED",
  );
  assert.equal(
    verifyMaterializationGitIdentity(root, "executable.mjs", {
      ...identity,
      blobId: "0".repeat(40),
    }).code,
    "EXECUTING_GENERATOR_MISMATCH",
  );
  chmodSync(file, 0o700);
  writeFileSync(file, "changed\n");
  assert.equal(
    verifyMaterializationGitIdentity(root, "executable.mjs", identity).status,
    "HOLD",
  );
});

test("only absent ignored local outputs and absent destinations pass observation", (t) => {
  const { root, file } = gitFixture(t);
  mkdirSync(path.join(root, "evidence"));
  const output = path.join(root, "evidence", "new.json");
  assert.equal(
    verifyMaterializationOutput(root, output).status,
    "LOCAL_FACTS_VERIFIED",
  );
  assert.equal(
    verifyMaterializationOutput(root, path.join(root, "unignored.json")).status,
    "HOLD",
  );
  writeFileSync(output, "preserved");
  assert.equal(verifyMaterializationOutput(root, output).status, "HOLD");
  assert.equal(readFileSync(output, "utf8"), "preserved");
  assert.equal(
    verifyMaterializationDestinations([path.join(root, "missing")]).status,
    "LOCAL_FACTS_VERIFIED",
  );
  assert.equal(verifyMaterializationDestinations([file]).status, "HOLD");
});

test("exclusive writer revalidates the opened parent and creates no file after parent replacement", (t) => {
  const { root } = gitFixture(t);
  const parent = path.join(root, "evidence");
  const moved = path.join(root, "original-evidence");
  mkdirSync(parent);
  const output = path.join(parent, "candidate.json");
  assert.throws(
    () =>
      writeExclusiveMaterializationOutput(
        root,
        output,
        { fixture: "NOT_AUTHORITY" },
        () => {
          renameSync(parent, moved);
          mkdirSync(parent);
        },
      ),
    /OUTPUT_PARENT_DRIFT/,
  );
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(path.join(moved, "candidate.json")), false);
  const result = writeExclusiveMaterializationOutput(
    root,
    output,
    { fixture: "NOT_AUTHORITY" },
    () => {},
  );
  assert.equal(result.sha256, hash(readFileSync(output)));
  assert.throws(
    () =>
      writeExclusiveMaterializationOutput(
        root,
        output,
        { fixture: "NOT_AUTHORITY" },
        () => {},
      ),
    /OUTPUT_NOT_ABSENT_IGNORED/,
  );
});

test("review bytes bind exact scope and subjects; narrow, missing and forged declarations HOLD", (t) => {
  const { root } = fixture(t);
  const reportPath = path.join(root, "review.json");
  const subjects = {
    packetSha256: "1".repeat(64),
    generatorSha256: "2".repeat(64),
  };
  const scope = [
    "SOURCE_BYTES",
    "GENERATOR_CLOSURE",
    "PLANNED_BYTES",
    "ROOT_DESTINATIONS",
    "WHOLE_PACKET",
  ];
  const report = {
    schemaVersion: "materialization-local-review-declaration/v1",
    scope,
    subjects,
    verdict: "PASS",
    critical: 0,
    important: 0,
  };
  const write = (value) => {
    writeFileSync(reportPath, JSON.stringify(value), { mode: 0o600 });
    return {
      path: reportPath,
      sha256: hash(readFileSync(reportPath)),
      size: readFileSync(reportPath).length,
      mode: 0o600,
    };
  };
  const descriptor = write(report);
  const result = verifyMaterializationReview(descriptor, subjects, [root]);
  assert.equal(result.status, "LOCAL_FACTS_VERIFIED");
  assert.equal(result.authority, "LOCAL_REVIEW_DECLARATION_ONLY");
  assert.equal(
    verifyMaterializationReview(
      write({ ...report, scope: ["reviewIdentities"] }),
      subjects,
      [root],
    ).code,
    "REVIEW_SCOPE_INCOMPLETE",
  );
  assert.equal(
    verifyMaterializationReview(
      write({
        ...report,
        subjects: { ...subjects, packetSha256: "3".repeat(64) },
      }),
      subjects,
      [root],
    ).code,
    "REVIEW_SUBJECT_MISMATCH",
  );
  assert.equal(
    verifyMaterializationReview(
      { ...descriptor, path: path.join(root, "missing") },
      subjects,
      [root],
    ).status,
    "HOLD",
  );
  assert.equal(
    verifyMaterializationReview(descriptor, subjects, [root]).status,
    "HOLD",
  );
});
