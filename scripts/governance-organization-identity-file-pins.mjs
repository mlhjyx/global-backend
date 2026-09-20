import {
  constants,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  canonicalJsonBytes,
  hasExactKeys,
  isPassivePlainData,
  isSha256,
  sha256,
} from "./governance-organization-identity-controller-contracts.mjs";

const observations = new WeakMap();
const hold = (code) => ({ status: "HOLD", code });
const MAX_FILE = 128 * 1024 * 1024,
  MAX_SET = 512 * 1024 * 1024;
const snapshot = (s) =>
  Object.fromEntries(
    [
      "dev",
      "ino",
      "mode",
      "uid",
      "gid",
      "nlink",
      "size",
      "mtimeNs",
      "ctimeNs",
    ].map((k) => [k, s[k].toString()]),
  );
const same = (a, b) => canonicalJsonBytes(a).equals(canonicalJsonBytes(b));
const directorySnapshot = (s) =>
  Object.fromEntries(
    ["dev", "ino", "mode", "uid", "gid"].map((k) => [k, s[k].toString()]),
  );
export function collectTrustedParentIdentities(file) {
  if (
    typeof file !== "string" ||
    !path.isAbsolute(file) ||
    path.normalize(file) !== file ||
    file.includes("\0")
  )
    throw Error("FILE_PIN_PARENT_INPUT_INVALID");
  const parents = [];
  let cursor = path.dirname(file);
  for (;;) {
    const s = lstatSync(cursor, { bigint: true });
    // Sticky root-owned temporary ancestors protect another user's private child
    // entries; writable non-sticky ancestors are never acceptable.
    if (
      !s.isDirectory() ||
      s.uid !== 0n ||
      ((s.mode & 0o022n) !== 0n && (s.mode & 0o1000n) === 0n)
    )
      throw Error("unsafe ancestor");
    parents.push({ path: cursor, identity: directorySnapshot(s) });
    if (cursor === "/") break;
    cursor = path.dirname(cursor);
  }
  return parents;
}
function valid(entries) {
  return (
    isPassivePlainData(entries) &&
    Array.isArray(entries) &&
    entries.length > 0 &&
    entries.length <= 256 &&
    entries.every(
      (e) =>
        hasExactKeys(e, [
          "role",
          "path",
          "sha256",
          "size",
          "mode",
          "uid",
          "gid",
        ]) &&
        typeof e.role === "string" &&
        /^[A-Z][A-Z0-9_]{0,63}$/u.test(e.role) &&
        typeof e.path === "string" &&
        e.path.length <= 4096 &&
        path.isAbsolute(e.path) &&
        path.normalize(e.path) === e.path &&
        !e.path.includes("\0") &&
        isSha256(e.sha256) &&
        Number.isSafeInteger(e.size) &&
        e.size >= 0 &&
        e.size <= MAX_FILE &&
        [0o444, 0o555].includes(e.mode) &&
        e.uid === 0 &&
        e.gid === 0,
    ) &&
    new Set(entries.map((e) => e.role)).size === entries.length &&
    new Set(entries.map((e) => e.path)).size === entries.length &&
    entries.reduce((total, e) => total + e.size, 0) <= MAX_SET
  );
}
function capture(entry, deadline) {
  const parents = collectTrustedParentIdentities(entry.path),
    before = lstatSync(entry.path, { bigint: true });
  if (
    realpathSync(entry.path) !== entry.path ||
    !before.isFile() ||
    before.nlink !== 1n ||
    before.uid !== 0n ||
    before.gid !== 0n ||
    Number(before.mode & 0o7777n) !== entry.mode ||
    before.size !== BigInt(entry.size)
  )
    throw Error("file mismatch");
  const fd = openSync(
    entry.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!same(snapshot(before), snapshot(opened))) throw Error("open drift");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      if (performance.now() >= deadline) throw Error("deadline");
      const count = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, entry.size - total + 1),
        null,
      );
      if (count === 0) break;
      total += count;
      if (total > entry.size) throw Error("byte bound");
      hash.update(buffer.subarray(0, count));
    }
    if (
      total !== entry.size ||
      hash.digest("hex") !== entry.sha256 ||
      !same(snapshot(opened), snapshot(fstatSync(fd, { bigint: true }))) ||
      !same(
        snapshot(opened),
        snapshot(lstatSync(entry.path, { bigint: true })),
      ) ||
      realpathSync(entry.path) !== entry.path ||
      !same(parents, collectTrustedParentIdentities(entry.path)) ||
      performance.now() >= deadline
    )
      throw Error("read drift");
    return {
      role: entry.role,
      path: entry.path,
      file: snapshot(opened),
      parents,
    };
  } finally {
    closeSync(fd);
  }
}

// Verifies only the submitted file set, never its transitive completeness or
// authorization. The controller still needs reviewed source/dependency closure.
export function verifyPinnedFileSet(entries) {
  try {
    if (process.platform !== "linux" || !valid(entries))
      return hold("FILE_PIN_INPUT_INVALID");
    const pinned = entries.map((e) => ({ ...e })),
      deadline = performance.now() + 15000;
    const facts = pinned.map((e) => capture(e, deadline));
    const result = Object.freeze({
      status: "PASS",
      evidenceClass: "LOCAL_FILE_SET_ONLY",
      admissionGranted: false,
      closureCompleteness: "UNPROVEN",
      fileSetSha256: sha256(canonicalJsonBytes(pinned)),
      filesystemObservationSha256: sha256(canonicalJsonBytes(facts)),
    });
    observations.set(result, { pinned, facts });
    return result;
  } catch {
    return hold("FILE_PIN_MISMATCH");
  }
}

export function recheckPinnedFileSet(observation) {
  const stored = observations.get(observation);
  if (!stored) return hold("FILE_PIN_OBSERVATION_INVALID");
  const current = verifyPinnedFileSet(stored.pinned);
  if (
    current.status !== "PASS" ||
    current.filesystemObservationSha256 !==
      observation.filesystemObservationSha256
  )
    return hold("FILE_PIN_DRIFT");
  return current;
}
