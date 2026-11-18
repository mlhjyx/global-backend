import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, sha256Hex } from "./release-authorization.mjs";
import { CandidateBudgetLedger } from "./development-candidate-budget.mjs";
import {
  CANDIDATE_PREDICATE_TYPE,
  candidateMarker,
} from "./development-candidate-contract.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "candidate-cli-"));
  const trusted = join(dir, "trusted"),
    candidate = join(dir, "candidate");
  mkdirSync(trusted);
  mkdirSync(join(trusted, "scripts"));
  mkdirSync(join(trusted, "docs/governance"), { recursive: true });
  for (const file of [
    "development-candidate.mjs",
    "development-candidate-contract.mjs",
    "development-candidate-input.mjs",
    "development-candidate-budget.mjs",
    "release-authorization.mjs",
  ])
    copyFileSync(
      new URL(file, import.meta.url),
      join(trusted, "scripts", file),
    );
  const key = join(dir, "fixture-key");
  execFileSync("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    "fixture-owner",
    "-f",
    key,
  ]);
  writeFileSync(
    join(trusted, "docs/governance/release-authority-keys.json"),
    JSON.stringify({
      keys: [
        {
          key_id: "fixture-owner",
          principal: "fixture-owner",
          public_key: readFileSync(`${key}.pub`, "utf8").trim(),
          revoked_at: null,
        },
      ],
    }),
  );
  const git = (root, ...args) =>
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
        root,
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git(trusted, "init", "-q", "-b", "main");
  git(
    trusted,
    "remote",
    "add",
    "origin",
    "https://github.com/mlhjyx/global-backend.git",
  );
  git(trusted, "add", ".");
  git(trusted, "commit", "-qm", "trusted bootstrap");
  const trustedCommit = git(trusted, "rev-parse", "HEAD");
  git(trusted, "update-ref", "refs/remotes/origin/main", trustedCommit);
  git(trusted, "worktree", "add", "-qb", "claude/fixture", candidate);
  writeFileSync(join(candidate, "business.txt"), "approved candidate");
  git(candidate, "add", ".");
  git(candidate, "commit", "-qm", "business candidate");
  const workspaceIds = [
    "10000000-0000-4000-8000-000000000001",
    "10000000-0000-4000-8000-000000000002",
  ];
  const db = { host: "127.0.0.1", port: 15432, name: "global_candidate_cli" };
  const instance = {
    schemaVersion: "development-candidate-instance/v1",
    instanceId: "pump-cli",
    environment: "development",
    workspaceIds,
    apiOrigin: "http://127.0.0.1:13010",
    database: db,
    leaseDatabases: { API: db, WORKER: db, OUTBOX_RELAY: db },
    temporal: {
      address: "127.0.0.1:27233",
      namespace: "default",
      taskQueue: "understanding",
      tlsServerName: "candidate.local",
      authorizer: "native-machine-policy",
      configurationRevision: "9".repeat(64),
    },
    controlPlane: {
      issuer: "https://127.0.0.1:28446",
      jwks: "https://127.0.0.1:28446/jwks",
      targetId: "candidate",
      machineSubjects: ["candidate-api", "candidate-worker"],
    },
    dependencyProofs: Object.fromEntries(
      [
        "databasePrivileges",
        "temporalIdentity",
        "storage",
        "redis",
        "gateway",
        "renderer",
        "browser",
        "jwks",
        "grantVerification",
      ].map((name) => [name, "a".repeat(64)]),
    ),
    schedulesEnabled: false,
    sharedRuntimeMutation: false,
    readOnlyRoot: true,
  };
  const authorization = {
    schemaVersion: "development-candidate-authorization/v1",
    environment: "development",
    trustedWorkflowCommit: trustedCommit,
    candidateCommit: git(candidate, "rev-parse", "HEAD"),
    gitTree: git(candidate, "show", "-s", "--format=%T"),
    instanceId: instance.instanceId,
    workspaceIds,
    instanceManifestSha256: sha256Hex(canonicalJson(instance)),
    authorizedAt: new Date(Date.now() - 1000).toISOString(),
    validUntil: new Date(Date.now() + 3600_000).toISOString(),
    keyId: "fixture-owner",
    campaignCapMicrousd: 5_000_000,
    armCapMicrousd: 2_500_000,
  };
  const auth = join(dir, "authorization.json"),
    manifest = join(dir, "instance.json");
  writeFileSync(auth, JSON.stringify(authorization));
  writeFileSync(manifest, JSON.stringify(instance));
  execFileSync(
    "ssh-keygen",
    [
      "-Y",
      "sign",
      "-f",
      key,
      "-n",
      "development-candidate-authorization",
      auth,
    ],
    { stdio: "ignore" },
  );
  const base = [
    "--authorization",
    auth,
    "--signature",
    `${auth}.sig`,
    "--instance",
    manifest,
    "--trusted-commit",
    trustedCommit,
  ];
  const run = (command, extra = [], env = {}) =>
    spawnSync(
      process.execPath,
      [
        join(trusted, "scripts/development-candidate.mjs"),
        command,
        ...base,
        ...extra,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, GITHUB_ACTIONS: "false", ...env },
      },
    );
  return {
    dir,
    trusted,
    candidate,
    authorization,
    instance,
    auth,
    manifest,
    base,
    run,
    git,
  };
}

test("approval digest binds the same bytes that the owner signed", () => {
  const f = fixture();
  const approved = join(f.dir, "approved.json");
  const original = readFileSync(f.auth);
  const bin = join(f.dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh-keygen"), `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { readFileSync, appendFileSync } = require("node:fs");
const check = spawnSync("ssh-keygen", process.argv.slice(2), {
  input: readFileSync(0), env: { ...process.env, PATH: process.env.FIXTURE_ORIGINAL_PATH },
});
if (check.status === 0) appendFileSync(process.env.FIXTURE_AUTH, " ");
process.exit(check.status ?? 1);
`, { mode: 0o700 });
  const result = f.run("validate-inputs", ["--output", approved], {
    PATH: `${bin}:${process.env.PATH}`,
    FIXTURE_ORIGINAL_PATH: process.env.PATH,
    FIXTURE_AUTH: f.auth,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.auth).length, original.length + 1);
  assert.equal(JSON.parse(readFileSync(approved)).authorizationSha256, sha256Hex(original));
});

test("real CLI verifies an owner signature and exports only committed candidate material", () => {
  const f = fixture();
  const approved = join(f.dir, "approved.json");
  const check = f.run("validate-inputs", ["--output", approved]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(
    JSON.parse(readFileSync(approved)).candidateCommit,
    f.authorization.candidateCommit,
  );
  const result = f.run("prepare-build", [
    "--candidate-root",
    f.candidate,
    "--output",
    join(f.dir, "build"),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(f.dir, "build/context/business.txt"), "utf8"),
    "approved candidate",
  );
});

test("CLI bounds malformed arguments, changed signatures, instance digests and dirty trusted code", () => {
  const f = fixture();
  for (const extra of [
    [],
    ["--output"],
    ["--output", join(f.dir, "out"), "--unknown", "value"],
    ["--output", join(f.dir, "out"), "--output", "duplicate"],
  ])
    assert.notEqual(f.run("validate-inputs", extra).status, 0);
  assert.notEqual(f.run("invalid", ["--output", join(f.dir, "out")]).status, 0);
  writeFileSync(
    f.manifest,
    JSON.stringify({ ...f.instance, instanceId: "wrong" }),
  );
  assert.notEqual(
    f.run("validate-inputs", ["--output", join(f.dir, "out")]).status,
    0,
  );
  writeFileSync(f.manifest, JSON.stringify(f.instance));
  writeFileSync(
    f.auth,
    JSON.stringify({ ...f.authorization, keyId: "not-authorized" }),
  );
  assert.notEqual(
    f.run("validate-inputs", ["--output", join(f.dir, "out")]).status,
    0,
  );
  writeFileSync(f.auth, JSON.stringify(f.authorization));
  writeFileSync(
    join(f.trusted, "scripts/development-candidate.mjs"),
    readFileSync(join(f.trusted, "scripts/development-candidate.mjs"), "utf8") +
      "\n// dirty\n",
  );
  assert.notEqual(
    f.run("validate-inputs", ["--output", join(f.dir, "out")]).status,
    0,
  );
});

test("predicate and verification CLI use normal owner approval plus pinned verifier stdout; tool failure is never a receipt", () => {
  const f = fixture();
  const digest = "d".repeat(64);
  const build = {
    build_sha: f.authorization.candidateCommit,
    artifact_digest: `sha256:${digest}`,
    source_tree_digest: `sha256:${"e".repeat(64)}`,
  };
  const markerPath = join(f.dir, "marker.json");
  writeFileSync(
    markerPath,
    JSON.stringify(
      candidateMarker(f.authorization, sha256Hex(readFileSync(f.auth))),
    ),
  );
  const buildPath = join(f.dir, "build.json"),
    predicatePath = join(f.dir, "predicate.json");
  writeFileSync(buildPath, JSON.stringify(build));
  assert.equal(
    f.run("make-predicate", [
      "--build-receipt",
      buildPath,
      "--marker",
      markerPath,
      "--output",
      predicatePath,
    ]).status,
    0,
  );
  writeFileSync(
    markerPath,
    JSON.stringify({
      ...candidateMarker(f.authorization, sha256Hex(readFileSync(f.auth))),
      instanceId: "forged",
    }),
  );
  assert.notEqual(
    f.run("make-predicate", [
      "--build-receipt",
      buildPath,
      "--marker",
      markerPath,
      "--output",
      join(f.dir, "forged.json"),
    ]).status,
    0,
  );
  const predicate = JSON.parse(readFileSync(predicatePath));
  assert.equal(predicate.candidateCommit, f.authorization.candidateCommit);
  const bin = join(f.dir, "bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env node\nconst fs=require('fs');fs.writeFileSync(process.env.FIXTURE_ARGS,JSON.stringify(process.argv.slice(2)));if(process.env.FIXTURE_GH_FAIL)process.exit(1);process.stdout.write(process.env.FIXTURE_VERIFICATION);\n`,
  );
  chmodSync(gh, 0o700);
  const image = `ghcr.io/mlhjyx/global-backend-development-candidate@sha256:${digest}`;
  const verified = [
    {
      verificationResult: {
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: CANDIDATE_PREDICATE_TYPE,
          subject: [{ name: image.split("@")[0], digest: { sha256: digest } }],
          predicate,
        },
      },
    },
  ];
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    FIXTURE_ARGS: join(f.dir, "args.json"),
    FIXTURE_VERIFICATION: JSON.stringify(verified),
  };
  const result = f.run(
    "verify-image",
    ["--image", image, "--output", join(f.dir, "receipt.json")],
    env,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(readFileSync(join(f.dir, "receipt.json"))).instance.instanceId,
    f.instance.instanceId,
  );
  const args = JSON.parse(readFileSync(env.FIXTURE_ARGS));
  assert.ok(args.includes("--signer-digest"));
  assert.ok(args.includes(f.authorization.trustedWorkflowCommit));
  assert.ok(args.includes("--deny-self-hosted-runners"));
  assert.notEqual(
    f.run(
      "verify-image",
      ["--image", image, "--output", join(f.dir, "failed.json")],
      { ...env, FIXTURE_GH_FAIL: "true" },
    ).status,
    0,
  );
  assert.notEqual(
    f.run(
      "verify-image",
      ["--image", image, "--output", join(f.dir, "unverified.json")],
      { ...env, FIXTURE_VERIFICATION: JSON.stringify({ status: "VERIFIED" }) },
    ).status,
    0,
  );
});

test("budget export stays linked to owner-approved instance and complete non-reclaimable slices", () => {
  const f = fixture();
  const configuration = {
    campaignId: f.instance.instanceId,
    expiresAt: f.authorization.validUntil,
    capMicrousd: 5_000_000,
    arms: {
      A: { workspaceId: f.instance.workspaceIds[0], capMicrousd: 2_500_000 },
      B: { workspaceId: f.instance.workspaceIds[1], capMicrousd: 2_500_000 },
    },
  };
  const db = join(f.dir, "budget.sqlite");
  const ledger = new CandidateBudgetLedger(db, configuration);
  ledger.allocate({
    requestKey: "f".repeat(64),
    arm: "A",
    workspaceId: f.instance.workspaceIds[0],
    purpose: "icp.design",
    quoteSha256: "a".repeat(64),
    capMicrousd: 1_000_000,
  });
  ledger.close();
  const config = join(f.dir, "configuration.json"),
    output = join(f.dir, "budget-export.json");
  writeFileSync(config, JSON.stringify(configuration));
  const result = f.run("export-budget", [
    "--ledger",
    db,
    "--configuration",
    config,
    "--output",
    output,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(readFileSync(output)).allocations[0].state,
    "ALLOCATED",
  );
  writeFileSync(
    config,
    JSON.stringify({ ...configuration, campaignId: "other" }),
  );
  assert.notEqual(
    f.run("export-budget", [
      "--ledger",
      db,
      "--configuration",
      config,
      "--output",
      join(f.dir, "invalid.json"),
    ]).status,
    0,
  );
});
