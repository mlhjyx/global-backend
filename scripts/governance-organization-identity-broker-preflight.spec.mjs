import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  rm,
  readdir,
  symlink,
} from "node:fs/promises";
import { chown } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "./governance-organization-identity-controller-contracts.mjs";
const api = () =>
  import("./governance-organization-identity-broker-preflight.mjs");
test("every private workspace leaf requires a trusted parent chain", async (t) => {
  const { inspectBrokerPreparation } = await api();
  for (const key of ["cwd", "home", "config", "temporary"])
    for (const unsafeOwner of [false, true]) {
      const { manifest, root } = await fixture(t);
      const parent = path.join(root, "unsafe-parent"),
        leaf = path.join(parent, "private");
      await mkdir(parent, { mode: 0o700 });
      await mkdir(leaf, { mode: 0o700 });
      if (unsafeOwner) await chown(parent, 65534, 65534);
      else await chmod(parent, 0o777);
      manifest.layout[key] = leaf;
      const r = inspectBrokerPreparation(manifest);
      assert.equal(r.status, "HOLD");
      assert.notEqual(r.localChecks, "PASS");
    }
});
async function fixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "identity-broker-preflight-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = Object.fromEntries(
    ["cwd", "home", "config", "temporary", "helpers"].map((k) => [
      k,
      path.join(root, k),
    ]),
  );
  await Promise.all(
    Object.values(layout).map((p) => mkdir(p, { mode: 0o700 })),
  );
  const filePins = [];
  for (const role of ["NODE", "GIT", "GH", "GIT_REMOTE_HTTPS"]) {
    const p =
      role === "GIT_REMOTE_HTTPS"
        ? path.join(layout.helpers, "git-remote-https")
        : path.join(root, role);
    const body = "fixture-" + role;
    await writeFile(p, body, { mode: 0o555 });
    await chmod(p, 0o555);
    filePins.push({
      role,
      path: p,
      sha256: createHash("sha256").update(body).digest("hex"),
      size: body.length,
      mode: 0o555,
      uid: 0,
      gid: 0,
    });
  }
  return {
    root,
    manifest: {
      schemaVersion: "identity-broker-local-preflight/v1",
      layout,
      filePins,
    },
  };
}
test("integrated local inspection checks actual files/workspace but never grants execution", async (t) => {
  const { manifest } = await fixture(t);
  const { inspectBrokerPreparation } = await api();
  const r = inspectBrokerPreparation(manifest);
  assert.equal(r.status, "HOLD");
  assert.equal(r.code, "BROKER_EXECUTION_NOT_ADMITTED");
  assert.equal(r.localChecks, "PASS");
  assert.equal(r.admissionGranted, false);
  assert.equal(r.profiles.length, 2);
  assert.equal(r.fileObservation.closureCompleteness, "UNPROVEN");
  assert.ok(r.remainingGates.includes("COMPLETE_TRANSPORT_CLOSURE_REVIEW"));
});
test("missing tools, writable files, extra helpers and nonempty config all stop before execution", async (t) => {
  const { inspectBrokerPreparation } = await api();
  for (const mutation of ["role", "file", "helper", "config"]) {
    const { manifest } = await fixture(t);
    if (mutation === "role") manifest.filePins.pop();
    if (mutation === "file") await chmod(manifest.filePins[0].path, 0o755);
    if (mutation === "helper")
      await writeFile(
        path.join(manifest.layout.helpers, "unexpected"),
        "fixture",
      );
    if (mutation === "config")
      await writeFile(
        path.join(manifest.layout.config, "hosts.yml"),
        "fixture",
      );
    const r = inspectBrokerPreparation(manifest);
    assert.equal(r.status, "HOLD");
    assert.notEqual(r.localChecks, "PASS");
  }
});
test("actual CLI only inspects bounded canonical manifests and returns nonzero HOLD without creating records", async (t) => {
  const { manifest, root } = await fixture(t),
    p = path.join(root, "request.json");
  await writeFile(p, canonicalJsonBytes(manifest), { mode: 0o600 });
  const cli = path.resolve(
      "scripts/governance-organization-identity-broker-preflight.mjs",
    ),
    run = promisify(execFile);
  const before = await readdir(root);
  await assert.rejects(
    run(process.execPath, [cli, "inspect", p], {
      env: {},
      timeout: 5000,
      maxBuffer: 16384,
    }),
    (e) => {
      assert.equal(e.code, 2);
      assert.equal(e.stderr, "");
      assert.equal(JSON.parse(e.stdout).localChecks, "PASS");
      return true;
    },
  );
  assert.deepEqual(await readdir(root), before);
  await assert.rejects(
    run(process.execPath, [cli, "execute", p], {
      env: {},
      timeout: 5000,
      maxBuffer: 4096,
    }),
    (e) =>
      e.code === 64 &&
      JSON.parse(e.stdout).code === "BROKER_PREFLIGHT_ARGUMENTS_INVALID",
  );
  await writeFile(
    p,
    '{"schemaVersion":"fixture-private","schemaVersion":"duplicate"}',
  );
  await assert.rejects(
    run(process.execPath, [cli, "inspect", p], {
      env: {},
      timeout: 5000,
      maxBuffer: 4096,
    }),
    (e) => e.code === 2 && !e.stdout.includes("fixture-private"),
  );
});
test("manifest aliases and untrusted file modes are rejected by the real CLI", async (t) => {
  const { manifest, root } = await fixture(t),
    p = path.join(root, "request.json");
  await writeFile(p, canonicalJsonBytes(manifest), { mode: 0o644 });
  const cli = path.resolve(
    "scripts/governance-organization-identity-broker-preflight.mjs",
  );
  for (const target of [p, p + "-alias"]) {
    if (target !== p) await symlink(p, target);
    await assert.rejects(
      promisify(execFile)(process.execPath, [cli, "inspect", target], {
        env: {},
        timeout: 3000,
        maxBuffer: 4096,
      }),
      (e) =>
        e.code === 2 &&
        JSON.parse(e.stdout).code === "BROKER_PREFLIGHT_MANIFEST_INVALID",
    );
  }
});
