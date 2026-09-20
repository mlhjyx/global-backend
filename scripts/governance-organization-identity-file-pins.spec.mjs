import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, symlink, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";

const api = () => import("./governance-organization-identity-file-pins.mjs");
test("proxy input does not run getter traps", async () => {
  const { verifyPinnedFileSet } = await api();
  let reads = 0;
  const entries = new Proxy([], {
    get() {
      reads++;
      return 1;
    },
  });
  assert.equal(verifyPinnedFileSet(entries).status, "HOLD");
  assert.equal(reads, 0);
});
async function fixture(t, body = "fixture-tool") {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-file-pins-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = path.join(root, "tool");
  await writeFile(p, body, { mode: 0o555 });
  await chmod(p, 0o555);
  return {
    role: "NODE",
    path: p,
    sha256: createHash("sha256").update(body).digest("hex"),
    size: Buffer.byteLength(body),
    mode: 0o555,
    uid: 0,
    gid: 0,
  };
}
test("actual file bytes and metadata are checked, never claimed as a complete executable closure", async (t) => {
  const entry = await fixture(t),
    { verifyPinnedFileSet, recheckPinnedFileSet } = await api();
  const r = verifyPinnedFileSet([entry]);
  assert.equal(r.status, "PASS");
  assert.equal(r.evidenceClass, "LOCAL_FILE_SET_ONLY");
  assert.equal(r.admissionGranted, false);
  assert.equal(r.closureCompleteness, "UNPROVEN");
  assert.equal(recheckPinnedFileSet(r).status, "PASS");
  assert.equal(
    recheckPinnedFileSet({ ...r }).code,
    "FILE_PIN_OBSERVATION_INVALID",
  );
  await chmod(entry.path, 0o755);
  assert.equal(recheckPinnedFileSet(r).status, "HOLD");
});
test("wrong bytes, size, mode, owner, duplicate role/path and malformed input fail closed", async (t) => {
  const entry = await fixture(t),
    { verifyPinnedFileSet } = await api();
  for (const delta of [
    { sha256: "a".repeat(64) },
    { size: entry.size + 1 },
    { mode: 0o755 },
    { uid: 1 },
    { gid: 1 },
    { path: "relative" },
    { extra: true },
  ])
    assert.equal(verifyPinnedFileSet([{ ...entry, ...delta }]).status, "HOLD");
  for (const entries of [
    null,
    [],
    [entry, entry],
    [entry, { ...entry, role: "GH" }],
    new Array(1),
  ])
    assert.equal(verifyPinnedFileSet(entries).status, "HOLD");
});
test("symlinks including parent aliases and hardlinks are rejected", async (t) => {
  const entry = await fixture(t),
    { verifyPinnedFileSet } = await api();
  const alias = entry.path + "-alias";
  await symlink(entry.path, alias);
  assert.equal(verifyPinnedFileSet([{ ...entry, path: alias }]).status, "HOLD");
  const parentAlias = path.dirname(entry.path) + "-alias";
  await symlink(path.dirname(entry.path), parentAlias);
  t.after(() => rm(parentAlias, { force: true }));
  assert.equal(
    verifyPinnedFileSet([{ ...entry, path: path.join(parentAlias, "tool") }])
      .status,
    "HOLD",
  );
  await link(entry.path, entry.path + "-hardlink");
  assert.equal(verifyPinnedFileSet([entry]).status, "HOLD");
});
test("same-size changes during an actual bounded read are detected by nanosecond metadata and hash", async (t) => {
  const entry = await fixture(t, "x".repeat(131072)),
    { verifyPinnedFileSet } = await api();
  const original = fs.readSync;
  let changed = false;
  t.mock.method(fs, "readSync", (...args) => {
    const n = original(...args);
    if (!changed) {
      changed = true;
      fs.chmodSync(entry.path, 0o755);
      fs.writeFileSync(entry.path, "y".repeat(entry.size));
      fs.chmodSync(entry.path, 0o555);
    }
    return n;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.equal(verifyPinnedFileSet([entry]).status, "HOLD");
  assert.equal(changed, true);
});
test("replacing equal-byte files after observation still invalidates the observation", async (t) => {
  const entry = await fixture(t),
    { verifyPinnedFileSet, recheckPinnedFileSet } = await api();
  const r = verifyPinnedFileSet([entry]);
  await rm(entry.path);
  await writeFile(entry.path, "fixture-tool", { mode: 0o555 });
  assert.equal(recheckPinnedFileSet(r).code, "FILE_PIN_DRIFT");
});
