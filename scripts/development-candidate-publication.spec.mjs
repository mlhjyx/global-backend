import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  prepareCandidateBuild,
  makeCandidatePredicate,
  candidateMain,
  readCandidateJson,
} from "./development-candidate.mjs";
import { candidateMarker } from "./development-candidate-contract.mjs";

test("candidate source is built unprivileged; publishing/signing is a separate main-only trusted job", () => {
  const source = readFileSync(
    new URL(
      "../.github/workflows/publish-development-candidate.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const build = source.slice(
    source.indexOf("  build:"),
    source.indexOf("  publish:"),
  );
  const publish = source.slice(source.indexOf("  publish:"));
  assert.match(build, /contents: read/u);
  assert.doesNotMatch(
    build,
    /id-token: write|packages: write|REGISTRY_TOKEN|docker login|docker push/u,
  );
  assert.match(publish, /needs: build/u);
  assert.match(publish, /environment: development-candidate-publication/u);
  assert.match(publish, /DEVELOPMENT_CANDIDATE_REGISTRY_TOKEN/u);
  assert.doesNotMatch(publish, /packages: write/u);
  assert.match(
    publish,
    /predicate-type: https:\/\/global-backend\.dev\/attestations\/development-candidate\/v1/u,
  );
  assert.match(publish, /push-to-registry: false/u);
  assert.equal(
    (source.match(/github\.ref == 'refs\/heads\/main'/gu) ?? []).length,
    2,
  );
  for (const match of source.matchAll(/uses:\s*([^\s]+)@([^\s]+)/gu))
    assert.match(match[2], /^[0-9a-f]{40}$/u);
  assert.ok(
    publish.indexOf("node trusted/scripts/verify-runtime-image.mjs") <
      publish.indexOf("docker login"),
  );
  assert.doesNotMatch(publish, /--entrypoint node.*runtime-image-verifier/u);
  assert.match(publish, /--marker "\$RUNNER_TEMP\/runtime-candidate\.json"/u);
  assert.ok(source.includes("candidate-build/context"));
});

test("normal release publication keeps its main-only source and signer policy", () => {
  const source = readFileSync(
    new URL("../.github/workflows/publish-runtime-image.yml", import.meta.url),
    "utf8",
  );
  assert.match(source, /if: github\.ref == 'refs\/heads\/main'/u);
  assert.match(source, /--source-ref refs\/heads\/main/u);
  assert.doesNotMatch(source, /development-candidate|CANDIDATE_BUILD/u);
});

test("committed archive excludes ignored host bytes and rejects modifications to protected budget/trust files", () => {
  const dir = mkdtempSync(join(tmpdir(), "candidate-export-"));
  const repo = join(dir, "source");
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-C",
        repo,
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), "local-only.txt\n");
  mkdirSync(join(repo, "scripts"));
  writeFileSync(join(repo, "scripts/trust.mjs"), "protected");
  git("add", ".");
  git("commit", "-qm", "trusted bootstrap");
  const trusted = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "business.txt"), "approved source");
  git("add", ".");
  git("commit", "-qm", "candidate business");
  writeFileSync(
    join(repo, "local-only.txt"),
    "uncommitted must never enter Docker",
  );
  const approval = {
    authorization: {
      candidateCommit: git("rev-parse", "HEAD"),
      gitTree: git("show", "-s", "--format=%T"),
      trustedWorkflowCommit: trusted,
      instanceId: "fixture",
      workspaceIds: [],
      validUntil: "2099-01-01T00:00:00.000Z",
      instanceManifestSha256: "a".repeat(64),
    },
    authorizationSha256: "b".repeat(64),
  };
  const output = join(dir, "export");
  prepareCandidateBuild(repo, output, approval);
  assert.equal(existsSync(join(output, "context/local-only.txt")), false);
  assert.equal(
    readFileSync(join(output, "context/business.txt"), "utf8"),
    "approved source",
  );
  assert.equal(
    existsSync(join(output, "context/.candidate-build/runtime-candidate.json")),
    true,
  );
  writeFileSync(
    join(repo, "scripts/trust.mjs"),
    "candidate tries to replace trusted code",
  );
  git("add", ".");
  git("commit", "-qm", "invalid protected edit");
  approval.authorization.candidateCommit = git("rev-parse", "HEAD");
  approval.authorization.gitTree = git("show", "-s", "--format=%T");
  assert.throws(
    () => prepareCandidateBuild(repo, join(dir, "invalid"), approval),
    /CANDIDATE_PROTECTED_SOURCE_CHANGED/u,
  );
  for (const path of [
    "apps/api/src/compliance/pii-crypto.extension.ts",
    "apps/api/src/temporal/deterministic-ledger-failure.interceptor.ts",
    "tsconfig.base.json",
    "apps/api/tsconfig.build.json",
  ]) {
    // Restore only this temporary fixture repository to its exact trusted
    // baseline. The real workspace and retained evidence are never reset.
    git("switch", "--detach", trusted);
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(
      join(repo, path),
      "candidate replaces actual isolation wiring",
    );
    git("add", ".");
    git("commit", "-qm", "invalid security wiring");
    approval.authorization.candidateCommit = git("rev-parse", "HEAD");
    approval.authorization.gitTree = git("show", "-s", "--format=%T");
    assert.throws(
      () =>
        prepareCandidateBuild(
          repo,
        join(dir, `invalid-${path.replaceAll("/", "-")}`),
          approval,
        ),
      /CANDIDATE_PROTECTED_SOURCE_CHANGED/u,
    );
  }
});

test("publisher refuses self-consistent metadata that differs from the approved marker", () => {
  const approval = {
    authorization: {
      candidateCommit: "a".repeat(40),
      trustedWorkflowCommit: "b".repeat(40),
      gitTree: "c".repeat(40),
      instanceId: "pump-ab",
      workspaceIds: [],
      validUntil: "2099-01-01T00:00:00.000Z",
      instanceManifestSha256: "d".repeat(64),
    },
    authorizationSha256: "e".repeat(64),
  };
  const build = {
    build_sha: approval.authorization.candidateCommit,
    artifact_digest: `sha256:${"f".repeat(64)}`,
    source_tree_digest: `sha256:${"1".repeat(64)}`,
  };
  const marker = candidateMarker(
    approval.authorization,
    approval.authorizationSha256,
  );
  assert.equal(
    makeCandidatePredicate(build, approval, marker).candidateCommit,
    build.build_sha,
  );
  assert.throws(
    () =>
      makeCandidatePredicate(build, approval, {
        ...marker,
        workspaceIds: ["extra-workspace"],
      }),
    /CANDIDATE_BUILD_MARKER_MISMATCH/u,
  );
  assert.throws(
    () =>
      makeCandidatePredicate(
        { ...build, build_sha: "f".repeat(40) },
        approval,
        marker,
      ),
    /CANDIDATE_BUILD_RECEIPT_MISMATCH/u,
  );
  assert.throws(() => candidateMain(["unexpected-command"]));
  assert.throws(() =>
    candidateMain(["validate-inputs", "--authorization", "missing-only"]),
  );
  const dir = mkdtempSync(join(tmpdir(), "candidate-json-boundary-"));
  const oversized = join(dir, "oversized.json");
  writeFileSync(oversized, " ".repeat(65_537));
  assert.throws(
    () => readCandidateJson(oversized),
    /CANDIDATE_INPUT_FILE_INVALID/u,
  );
});
