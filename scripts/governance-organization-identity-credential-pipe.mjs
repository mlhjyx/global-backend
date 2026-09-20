import {
  constants,
  fstatSync,
  readSync,
  readlinkSync,
  readFileSync,
} from "node:fs";
import { performance } from "node:perf_hooks";
import { hasExactKeys } from "./governance-organization-identity-controller-contracts.mjs";
const hold = (code) => ({ status: "HOLD", code });
const same = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.isFIFO() && b.isFIFO();

// Requires a nonblocking anonymous read pipe; caller owns and closes the descriptor. No credential lookup, environment fallback or authority assertion.
export async function readCredentialPipe(options) {
  if (
    options === null ||
    typeof options !== "object" ||
    !hasExactKeys(options, ["fd", "timeoutMs"]) ||
    !Number.isInteger(options.fd) ||
    options.fd < 3 ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 5000 ||
    process.platform !== "linux"
  )
    return hold("CREDENTIAL_PIPE_INPUT_INVALID");
  const sourceFd = options.fd,
    deadline = performance.now() + options.timeoutMs;
  const chunks = [],
    scratch = Buffer.alloc(8193);
  let total = 0,
    sourceIdentity;
  try {
    sourceIdentity = fstatSync(sourceFd);
    if (
      !sourceIdentity.isFIFO() ||
      !/^pipe:\[[0-9]+\]$/u.test(readlinkSync(`/proc/self/fd/${sourceFd}`))
    )
      return hold("CREDENTIAL_PIPE_REQUIRED");
    const info = readFileSync(`/proc/self/fdinfo/${sourceFd}`, "utf8");
    const flags = /^flags:\s+([0-7]+)$/mu.exec(info);
    if (
      info.length > 4096 ||
      !flags ||
      (Number.parseInt(flags[1], 8) & 3) !== 0
    )
      return hold("CREDENTIAL_PIPE_REQUIRED");
    if ((Number.parseInt(flags[1], 8) & constants.O_NONBLOCK) === 0)
      return hold("CREDENTIAL_PIPE_NONBLOCK_REQUIRED");
    for (;;) {
      if (performance.now() >= deadline) return hold("CREDENTIAL_PIPE_TIMEOUT");
      let size;
      try {
        size = readSync(
          sourceFd,
          scratch,
          0,
          Math.min(scratch.length, 8193 - total),
          null,
        );
      } catch (error) {
        if (error?.code !== "EAGAIN" && error?.code !== "EWOULDBLOCK")
          return hold("CREDENTIAL_PIPE_READ_FAILED");
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(5, Math.max(1, deadline - performance.now())),
          ),
        );
        continue;
      }
      if (size === 0) {
        if (total === 0) return hold("CREDENTIAL_PIPE_EMPTY");
        if (!same(sourceIdentity, fstatSync(sourceFd)))
          return hold("CREDENTIAL_PIPE_DRIFT");
        const bytes = Buffer.concat(chunks, total);
        if (!bytes.every((value) => value >= 0x21 && value <= 0x7e)) {
          bytes.fill(0);
          return hold("CREDENTIAL_PIPE_VALUE_INVALID");
        }
        // Caller must keep bytes in memory, never serialize them, then clear them.
        return {
          status: "PASS",
          evidenceClass: "LOCAL_PIPE_BYTES_ONLY",
          admissionGranted: false,
          bytes,
        };
      }
      total += size;
      if (total > 8192) return hold("CREDENTIAL_PIPE_LIMIT");
      chunks.push(Buffer.from(scratch.subarray(0, size)));
      scratch.fill(0);
    }
  } catch {
    return hold("CREDENTIAL_PIPE_UNAVAILABLE");
  } finally {
    scratch.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}
