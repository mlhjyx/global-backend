import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import path from "node:path";

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function validate(relative) {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    relative.includes("\0")
  ) {
    throw new Error("FILESYSTEM_UNSAFE_PATH");
  }
}
function metadata(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
  };
}
function version(stat) {
  return {
    ...metadata(stat),
    size: stat.size,
    mtime: stat.mtimeMs,
    ctime: stat.ctimeMs,
  };
}
async function statOrMissing(absolute) {
  try {
    return await lstat(absolute);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`FILESYSTEM_LSTAT_FAILED:${error.code ?? "UNKNOWN"}`);
  }
}

// This is bounded observation, not exclusion of concurrent writers. Never follow
// any symlink supplied by a pathname component. Linux directory descriptors pin
// read traversal through /proc/self/fd; this is NOT writer exclusion for Git.
export async function inspectFilesystem({
  root,
  incoming,
  groups,
  indexed,
  maxBytes = 2 * 1024 ** 3,
  maxPaths = 200000,
}) {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("FILESYSTEM_ROOT_NOT_DIRECTORY");
  const local = [...new Set(Object.values(groups).flat())].sort();
  const destinations = [...new Set(incoming)].sort();
  if (local.length + destinations.length > maxPaths)
    throw new Error("FILESYSTEM_PATH_LIMIT");
  for (const relative of [...local, ...destinations]) validate(relative);
  const indexedSet = new Set(indexed);
  const collisions = [];
  let bytes = 0;
  const preservation = [[".", "ROOT", metadata(rootStat)]];
  const destinationRecords = [];
  async function observe(relative, records, includeContent) {
    const parts = relative.split("/");
    const directories = [];
    const bindings = [];
    try {
      const rootHandle = await open(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      directories.push(rootHandle);
      bindings.push({ handle: rootHandle, entry: root, expected: rootStat });
      if (
        digest(metadata(await rootHandle.stat())) !== digest(metadata(rootStat))
      )
        throw new Error("FILESYSTEM_OBSERVATION_DRIFT");
      for (let length = 1; length <= parts.length; length++) {
        const prefix = parts.slice(0, length).join("/");
        const absolute = `/proc/self/fd/${directories.at(-1).fd}/${parts[length - 1]}`;
        const stat = await statOrMissing(absolute);
        const leaf = length === parts.length;
        if (!stat) {
          records.push([prefix, "ABSENT"]);
          return { missing: true };
        }
        if (!leaf && !stat.isDirectory()) {
          records.push([prefix, "BLOCKING_ANCESTOR", metadata(stat)]);
          return { blocked: true };
        }
        if (!leaf) {
          const directory = await open(
            absolute,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          directories.push(directory);
          bindings.push({ handle: directory, entry: absolute, expected: stat });
          if (
            digest(metadata(await directory.stat())) !== digest(metadata(stat))
          )
            throw new Error("FILESYSTEM_OBSERVATION_DRIFT");
          records.push([prefix, "DIRECTORY", metadata(stat)]);
          continue;
        }
        if (stat.isSymbolicLink()) {
          const targetBytes = await readlink(absolute, { encoding: "buffer" });
          const target = targetBytes.toString("utf8");
          if (!Buffer.from(target, "utf8").equals(targetBytes))
            throw new Error("FILESYSTEM_SYMLINK_TARGET_ENCODING");
          const after = await lstat(absolute);
          if (digest(version(stat)) !== digest(version(after)))
            throw new Error("FILESYSTEM_OBSERVATION_DRIFT");
          records.push([prefix, "SYMLINK", metadata(stat), digest(target)]);
        } else if (stat.isFile()) {
          if (includeContent) {
            bytes += stat.size;
            if (bytes > maxBytes) throw new Error("FILESYSTEM_BYTE_LIMIT");
            const handle = await open(
              absolute,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
              const opened = await handle.stat();
              if (
                !opened.isFile() ||
                digest(version(opened)) !== digest(version(stat))
              )
                throw new Error("FILESYSTEM_OBSERVATION_DRIFT");
              const hash = createHash("sha256");
              const buffer = Buffer.alloc(64 * 1024);
              let count = 0;
              while (true) {
                const { bytesRead } = await handle.read(
                  buffer,
                  0,
                  buffer.length,
                  null,
                );
                if (!bytesRead) break;
                count += bytesRead;
                if (count > stat.size)
                  throw new Error("FILESYSTEM_OBSERVATION_DRIFT");
                hash.update(buffer.subarray(0, bytesRead));
              }
              const after = await handle.stat();
              const finalPath = await lstat(absolute);
              if (
                count !== stat.size ||
                digest(version(stat)) !== digest(version(after)) ||
                digest(version(stat)) !== digest(version(finalPath))
              )
                throw new Error("FILESYSTEM_OBSERVATION_DRIFT");
              records.push([
                prefix,
                "FILE",
                metadata(stat),
                count,
                hash.digest("hex"),
              ]);
            } finally {
              await handle.close();
            }
          } else records.push([prefix, "FILE", version(stat)]);
        } else if (stat.isDirectory()) {
          records.push([prefix, "DIRECTORY", metadata(stat)]);
        } else throw new Error("FILESYSTEM_SPECIAL_ENTITY_HOLD");
        return { exists: true, directory: stat.isDirectory() };
      }
    } finally {
      try {
        // An fd pins the inode, not its visible directory entry. Recheck each
        // child name through its still-open parent, then the root pathname.
        // Otherwise a renamed ancestor could make all leaf checks inspect a
        // detached old tree while the visible checkout contains new bytes.
        // This detects observed replacement; it does not exclude later writers.
        for (const { handle, entry, expected } of bindings.reverse()) {
          const visible = await statOrMissing(entry);
          const pinned = await handle.stat();
          if (
            !visible ||
            !visible.isDirectory() ||
            digest(metadata(visible)) !== digest(metadata(expected)) ||
            digest(metadata(pinned)) !== digest(metadata(expected))
          )
            throw new Error("FILESYSTEM_OBSERVATION_DRIFT");
        }
      } finally {
        for (const directory of directories.reverse()) await directory.close();
      }
    }
  }
  for (const relative of local) {
    const result = await observe(relative, preservation, true);
    if (result.blocked || result.directory)
      throw new Error("FILESYSTEM_LOCAL_INVENTORY_NOT_EXACT");
  }
  for (const relative of destinations) {
    const result = await observe(relative, destinationRecords, true);
    if (result.blocked)
      collisions.push({
        kind: "filesystem",
        path: relative,
        reason: "NON_DIRECTORY_ANCESTOR",
      });
    else if (result.exists && (result.directory || !indexedSet.has(relative)))
      collisions.push({
        kind: "filesystem",
        path: relative,
        reason: result.directory
          ? "DIRECTORY_DESTINATION"
          : "UNOWNED_DESTINATION",
      });
  }
  return {
    preservationDigest: digest(preservation),
    destinationDigest: digest(destinationRecords),
    collisions,
    observedLocalPathCount: local.length,
    observedBytes: bytes,
    concurrencyGuarantee: "OBSERVATION_ONLY_NO_WRITER_EXCLUSION",
  };
}
