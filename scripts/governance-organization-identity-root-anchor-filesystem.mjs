import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const pass = (extra = {}) => ({ status: "PASS", ...extra });
const integrity = (code) => ({ status: "INTEGRITY_ERROR", code });

function hasExactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function modeOf(stat) {
  return Number(stat.mode & 0o777n);
}

async function verifiedFixtureDirectory(directoryPath, fixture) {
  const [stat, resolved] = await Promise.all([
    lstat(directoryPath, { bigint: true }),
    realpath(directoryPath),
  ]);
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    resolved === directoryPath &&
    modeOf(stat) === 0o700 &&
    Number(stat.uid) === fixture.expectedUid &&
    Number(stat.gid) === fixture.expectedGid
  );
}

export async function verifyFixtureRoot(
  fixture,
  receiptField,
  anchorDirectory,
) {
  const fixtureKeys = [
    "rootDirectory",
    "outputRoot",
    "targetPath",
    receiptField,
    "expectedUid",
    "expectedGid",
  ];
  if (
    !hasExactKeys(fixture, fixtureKeys) ||
    !path.isAbsolute(fixture.rootDirectory) ||
    !path.isAbsolute(fixture.outputRoot) ||
    !path.isAbsolute(fixture.targetPath) ||
    !path.isAbsolute(fixture[receiptField]) ||
    path.dirname(fixture.targetPath) !== fixture.rootDirectory ||
    !fixture.targetPath.startsWith(`${fixture.rootDirectory}/`) ||
    path.dirname(fixture.outputRoot) !== fixture.rootDirectory ||
    path.dirname(fixture[receiptField]) !== fixture.outputRoot ||
    !fixture[receiptField].startsWith(`${fixture.outputRoot}/`) ||
    fixture.rootDirectory === anchorDirectory
  ) {
    return integrity("ROOT_ANCHOR_FIXTURE_INVALID");
  }
  try {
    const [rootValid, outputValid] = await Promise.all([
      verifiedFixtureDirectory(fixture.rootDirectory, fixture),
      verifiedFixtureDirectory(fixture.outputRoot, fixture),
    ]);
    return rootValid && outputValid
      ? pass()
      : integrity("ROOT_ANCHOR_FIXTURE_ROOT_INVALID");
  } catch {
    return integrity("ROOT_ANCHOR_FIXTURE_ROOT_INVALID");
  }
}

export async function targetAbsent(targetPath) {
  try {
    await lstat(targetPath, { bigint: true });
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

export async function openVerifiedDirectory(directoryPath, fixture) {
  const handle = await open(
    directoryPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat({ bigint: true });
    const resolved = await realpath(directoryPath);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      modeOf(stat) !== 0o700 ||
      Number(stat.uid) !== fixture.expectedUid ||
      Number(stat.gid) !== fixture.expectedGid ||
      resolved !== directoryPath
    ) {
      throw new Error("ROOT_ANCHOR_DIRECTORY_INVALID");
    }
    return { handle, stablePath: `/proc/self/fd/${handle.fd}` };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function writeExclusiveCanonical(filePath, bytes, fixture) {
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.chown(fixture.expectedUid, fixture.expectedGid);
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      modeOf(stat) !== 0o600 ||
      Number(stat.uid) !== fixture.expectedUid ||
      Number(stat.gid) !== fixture.expectedGid ||
      Number(stat.size) !== bytes.length
    ) {
      return integrity("ROOT_ANCHOR_WRITE_METADATA_INVALID");
    }
    return pass({ stat });
  } catch {
    return integrity("ROOT_ANCHOR_CREATE_EXCLUSIVE_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readbackFile(filePath, expected, fixture, sha256) {
  let handle;
  try {
    const before = await lstat(filePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      return integrity("ROOT_ANCHOR_READBACK_INVALID");
    }
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(filePath, { bigint: true });
    if (
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.dev !== afterPath.dev ||
      opened.ino !== afterPath.ino ||
      modeOf(opened) !== 0o600 ||
      Number(opened.uid) !== fixture.expectedUid ||
      Number(opened.gid) !== fixture.expectedGid ||
      bytes.length !== expected.size ||
      sha256(bytes) !== expected.sha256
    ) {
      return integrity("ROOT_ANCHOR_READBACK_INVALID");
    }
    return pass({ bytes, stat: opened });
  } catch {
    return integrity("ROOT_ANCHOR_READBACK_INVALID");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
