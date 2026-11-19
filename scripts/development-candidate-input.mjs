import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** Read a bounded snapshot from the same descriptor that was validated. */
export function readCandidateInput(path, limit, invalidCode) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > limit) throw new Error(invalidCode);
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (n === 0) break;
      length += n;
    }
    const after = fstatSync(fd);
    if (length !== before.size || length !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(invalidCode);
    }
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
