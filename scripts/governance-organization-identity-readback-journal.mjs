import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  readSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import path from "node:path";
import {
  canonicalJsonBytes,
  hasExactKeys,
  isGitObjectId,
  isSha256,
  sha256,
  valuesEqual,
} from "./governance-organization-identity-controller-contracts.mjs";

const claims = new WeakMap();
const hold = (code) => ({ status: "HOLD", code });
const local = { evidenceClass: "LOCAL_JOURNAL_ONLY", admissionGranted: false };
const fileFlags = constants.O_NOFOLLOW | constants.O_NONBLOCK;
const valid = (input) =>
  hasExactKeys(input, ["root", "requestId", "requestSha256"]) &&
  typeof input.root === "string" &&
  path.isAbsolute(input.root) &&
  path.normalize(input.root) === input.root &&
  !input.root.includes("\0") &&
  typeof input.requestId === "string" &&
  /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(input.requestId) &&
  isSha256(input.requestSha256);
const validObservation = (value) =>
  hasExactKeys(value, ["headSha", "protected"]) &&
  isGitObjectId(value.headSha) &&
  value.protected === true;
const rootSafe = (s) =>
  s.isDirectory() && s.uid === process.geteuid() && (s.mode & 0o7777) === 0o700;
const identity = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
const fileSafe = (s) =>
  s.isFile() &&
  s.uid === process.geteuid() &&
  (s.mode & 0o7777) === 0o600 &&
  s.nlink === 1 &&
  s.size > 0 &&
  s.size <= 4096;
const record = (input) => ({
  schemaVersion: "local-readback-journal/v1",
  kind: "CLAIM",
  requestId: input.requestId,
  requestSha256: input.requestSha256,
});
const name = (input, kind) =>
  `${sha256(Buffer.from(input.requestId, "utf8"))}.${kind}.json`;
const anchored = (state, kind) =>
  `/proc/self/fd/${state.fd}/${name(state.input, kind)}`;
function rootUnchanged(state) {
  try {
    return (
      realpathSync(state.input.root) === state.input.root &&
      rootSafe(fstatSync(state.fd)) &&
      identity(state.identity, lstatSync(state.input.root))
    );
  } catch {
    return false;
  }
}
function openRoot(input) {
  let fd;
  try {
    if (realpathSync(input.root) !== input.root) return null;
    fd = openSync(
      input.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const state = { fd, input: { ...input }, identity: fstatSync(fd) };
    if (!rootSafe(state.identity) || !rootUnchanged(state)) {
      closeSync(fd);
      return null;
    }
    return state;
  } catch {
    if (fd !== undefined) closeSync(fd);
    return null;
  }
}
function exclusiveWrite(state, kind, value) {
  const bytes = canonicalJsonBytes(value);
  if (bytes.length > 4096) throw Error("bounded record");
  const fd = openSync(
    anchored(state, kind),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | fileFlags,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (count <= 0) throw Error("short write");
      offset += count;
    }
    fsyncSync(fd);
    if (!fileSafe(fstatSync(fd))) throw Error("unsafe record");
  } finally {
    closeSync(fd);
  }
  fsyncSync(state.fd);
}
function readRecord(state, kind) {
  const fd = openSync(anchored(state, kind), constants.O_RDONLY | fileFlags);
  try {
    const before = fstatSync(fd);
    if (!fileSafe(before)) throw Error("unsafe record");
    const bytes = Buffer.alloc(4097);
    let total = 0;
    while (total < bytes.length) {
      const count = readSync(fd, bytes, total, bytes.length - total, null);
      if (count === 0) break;
      total += count;
    }
    // A concurrent observer may see a complete record before its writer's
    // fsync returns. Synchronize the inode before reporting a durable readback.
    fsyncSync(fd);
    const after = fstatSync(fd);
    if (
      total !== before.size ||
      !identity(before, after) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw Error("record drift");
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, total),
      ),
    );
    if (!canonicalJsonBytes(parsed).equals(bytes.subarray(0, total)))
      throw Error("noncanonical record");
    return parsed;
  } finally {
    closeSync(fd);
  }
}

// Local durable deduplication only. Caller must independently validate authority,
// request/source/tool bindings and observations. This is not an authority receipt.
export function claimReadbackRequest(input) {
  if (process.platform !== "linux" || !valid(input))
    return hold("JOURNAL_INPUT_INVALID");
  const state = openRoot(input);
  if (!state) return hold("JOURNAL_ROOT_UNSAFE");
  try {
    exclusiveWrite(state, "claim", record(input));
    if (!rootUnchanged(state)) throw Error("root drift");
    const claim = Object.freeze({ status: "CLAIMED", ...local });
    claims.set(claim, state);
    return claim;
  } catch (error) {
    closeSync(state.fd);
    return hold(
      error?.code === "EEXIST"
        ? "JOURNAL_REQUEST_ALREADY_CLAIMED"
        : "JOURNAL_CLAIM_WRITE_FAILED",
    );
  }
}

export function abandonReadbackRequest(claim) {
  const state = claims.get(claim);
  if (!state) return hold("JOURNAL_CLAIM_INVALID");
  claims.delete(claim);
  closeSync(state.fd);
  return { status: "ABANDONED", ...local };
}

export function completeReadbackRequest(claim, observation) {
  const state = claims.get(claim);
  if (!state) return hold("JOURNAL_CLAIM_INVALID");
  claims.delete(claim);
  try {
    if (!validObservation(observation))
      return hold("JOURNAL_OBSERVATION_INVALID");
    if (!rootUnchanged(state)) return hold("JOURNAL_ROOT_DRIFT");
    const expected = record(state.input);
    if (!valuesEqual(readRecord(state, "claim"), expected))
      return hold("JOURNAL_CLAIM_DRIFT");
    const result = {
      ...expected,
      kind: "RESULT",
      claimSha256: sha256(canonicalJsonBytes(expected)),
      observation: { ...observation },
    };
    exclusiveWrite(state, "result", result);
    if (
      !rootUnchanged(state) ||
      !valuesEqual(readRecord(state, "result"), result)
    )
      return hold("JOURNAL_RESULT_DRIFT");
    return { status: "RECORDED", ...local };
  } catch {
    return hold("JOURNAL_RESULT_WRITE_FAILED");
  } finally {
    closeSync(state.fd);
  }
}

export function readReadbackRequest(input) {
  if (process.platform !== "linux" || !valid(input))
    return hold("JOURNAL_INPUT_INVALID");
  const state = openRoot(input);
  if (!state) return hold("JOURNAL_ROOT_UNSAFE");
  try {
    const expected = record(input);
    if (!valuesEqual(readRecord(state, "claim"), expected))
      return hold("JOURNAL_CLAIM_DRIFT");
    const result = readRecord(state, "result");
    if (
      !hasExactKeys(result, [
        "schemaVersion",
        "kind",
        "requestId",
        "requestSha256",
        "claimSha256",
        "observation",
      ]) ||
      !validObservation(result.observation) ||
      !valuesEqual(result, {
        ...expected,
        kind: "RESULT",
        claimSha256: sha256(canonicalJsonBytes(expected)),
        observation: result.observation,
      })
    )
      return hold("JOURNAL_RESULT_INVALID");
    if (!rootUnchanged(state)) return hold("JOURNAL_ROOT_DRIFT");
    fsyncSync(state.fd);
    return {
      status: "PASS",
      ...local,
      requestId: input.requestId,
      requestSha256: input.requestSha256,
      observation: result.observation,
    };
  } catch {
    return hold("JOURNAL_RESULT_UNAVAILABLE");
  } finally {
    closeSync(state.fd);
  }
}
