import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
const api = () =>
  import("./governance-organization-identity-child-profile.mjs");
const layout = {
  cwd: "/private/cwd",
  home: "/private/home",
  config: "/private/config",
  temporary: "/private/tmp",
  helpers: "/private/helpers",
};
test("filesystem root and trailing slash aliases cannot be workspace directories", async () => {
  const { buildReadOnlyChildProfile } = await api();
  for (const home of ["/", layout.cwd + "/"])
    assert.equal(
      buildReadOnlyChildProfile("GIT", { ...layout, home }).status,
      "HOLD",
    );
});
test("workspace paths cannot inject a second PATH or ceiling-directory entry", async () => {
  const { buildReadOnlyChildProfile } = await api();
  for (const key of Object.keys(layout))
    assert.equal(
      buildReadOnlyChildProfile("GIT", {
        ...layout,
        [key]: layout[key] + ":/tmp",
      }).status,
      "HOLD",
    );
});
test("Git and GH profiles have fixed read-only argv, isolated environments and no credential values", async () => {
  const { buildReadOnlyChildProfile } = await api();
  const git = buildReadOnlyChildProfile("GIT", layout),
    gh = buildReadOnlyChildProfile("GH", layout);
  for (const r of [git, gh]) {
    assert.equal(r.status, "PASS");
    assert.equal(r.admissionGranted, false);
    assert.equal(r.networkReadiness, "UNVERIFIED");
    assert.ok(r.argv.length <= 32);
    assert.ok(Object.keys(r.environment).length < 32);
    assert.equal(Object.isFrozen(r.environment), true);
  }
  assert.deepEqual(git.argv.slice(-5), [
    "ls-remote",
    "--exit-code",
    "--refs",
    "https://github.com/mlhjyx/global-backend.git",
    "refs/heads/main",
  ]);
  assert.ok(git.argv.includes("http.followRedirects=false"));
  assert.ok(git.argv.includes("http.sslVerify=true"));
  assert.ok(git.argv.includes("credential.helper="));
  assert.equal(git.environment.GIT_CONFIG_COUNT, "0");
  assert.equal(git.environment.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.deepEqual(gh.argv, [
    "api",
    "repos/mlhjyx/global-backend/branches/main",
    "--method",
    "GET",
    "--jq",
    "[.name,.commit.sha,.protected] | @tsv",
  ]);
  assert.equal(gh.environment.GH_HOST, "github.com");
  assert.equal(gh.credentialBinding.name, "GH_TOKEN");
  for (const r of [git, gh])
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_DEBUG",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "HTTPS_PROXY",
      "GIT_CONFIG_PARAMETERS",
    ])
      assert.equal(Object.hasOwn(r.environment, key), false);
});
test("other commands, extra values, aliases and overlapping workspace paths are rejected", async () => {
  const { buildReadOnlyChildProfile } = await api();
  assert.equal(buildReadOnlyChildProfile("PUSH", layout).status, "HOLD");
  for (const input of [
    null,
    { ...layout, extra: true },
    { ...layout, home: layout.cwd },
    { ...layout, home: layout.cwd + "/inside" },
    { ...layout, home: "/x/../home" },
    { ...layout, home: "relative" },
  ])
    assert.equal(buildReadOnlyChildProfile("GIT", input).status, "HOLD");
});
test("actual local Git ignores poisoned HOME and config environment without any network operation", async (t) => {
  const { buildReadOnlyChildProfile } = await api();
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-child-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dirs = Object.fromEntries(
    Object.keys(layout).map((k) => [k, path.join(root, k)]),
  );
  await Promise.all(Object.values(dirs).map((p) => mkdir(p, { mode: 0o700 })));
  await writeFile(
    path.join(dirs.home, ".gitconfig"),
    "[test]\n poison = inherited\n[http]\n proxy = http://invalid.example\n",
  );
  const profile = buildReadOnlyChildProfile("GIT", dirs);
  // This test substitutes the config read subcommand, never executes ls-remote.
  const flags = profile.argv.slice(0, -5);
  const env = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "test.poison",
    GIT_CONFIG_VALUE_0: "inherited",
    ...profile.environment,
    IDENTITY_GIT_AUTHORIZATION: "fixture-header",
  };
  const run = promisify(execFile);
  const result = await run(
    "/usr/bin/git",
    [...flags, "config", "--get", "http.proxy"],
    { cwd: dirs.cwd, env, timeout: 2000, maxBuffer: 4096 },
  );
  assert.equal(result.stdout.trim(), "");
  await assert.rejects(
    run("/usr/bin/git", [...flags, "config", "--get", "test.poison"], {
      cwd: dirs.cwd,
      env,
      timeout: 2000,
      maxBuffer: 4096,
    }),
    (e) => e.code === 1 && e.stdout === "",
  );
});
