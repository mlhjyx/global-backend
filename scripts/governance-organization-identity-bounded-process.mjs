import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  hasExactKeys,
  isPassivePlainData,
} from "./governance-organization-identity-controller-contracts.mjs";

const hold = (code) => ({ status: "HOLD", code });
const text = (v, max) =>
  typeof v === "string" && !v.includes("\0") && Buffer.byteLength(v) <= max;
function valid(input) {
  return (
    hasExactKeys(input, [
      "executable",
      "argv",
      "cwd",
      "environment",
      "timeoutMs",
      "maxOutputBytes",
    ]) &&
    text(input.executable, 4096) &&
    path.isAbsolute(input.executable) &&
    text(input.cwd, 4096) &&
    path.isAbsolute(input.cwd) &&
    Array.isArray(input.argv) &&
    input.argv.length <= 32 &&
    input.argv.every((v) => text(v, 4096)) &&
    input.environment !== null &&
    typeof input.environment === "object" &&
    !Array.isArray(input.environment) &&
    isPassivePlainData(input.environment) &&
    Object.keys(input.environment).length <= 32 &&
    Object.entries(input.environment).every(
      ([k, v]) => /^[A-Z_][A-Z0-9_]*$/u.test(k) && text(v, 16384),
    ) &&
    Object.entries(input.environment).reduce(
      (n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v),
      0,
    ) <= 65536 &&
    Number.isInteger(input.timeoutMs) &&
    input.timeoutMs > 0 &&
    input.timeoutMs <= 15000 &&
    Number.isInteger(input.maxOutputBytes) &&
    input.maxOutputBytes > 0 &&
    input.maxOutputBytes <= 8192
  );
}

// This primitive does not authorize an executable, environment or network call.
// The controller must bind them to its reviewed, installed contract before use.
export async function runBoundedProcess(input) {
  if (!valid(input) || process.platform !== "linux")
    return hold("PROCESS_INPUT_INVALID");
  const snapshot = {
    ...input,
    argv: [...input.argv],
    environment: { ...input.environment },
  };
  return new Promise((resolve) => {
    let child,
      timer,
      settled = false,
      failure = null,
      total = 0,
      stderrSeen = false;
    const output = [];
    const deadline = performance.now() + snapshot.timeoutMs;
    const killGroup = () => {
      if (!Number.isInteger(child?.pid) || child.pid <= 0) return false;
      try {
        process.kill(-child.pid, "SIGKILL");
        return true;
      } catch {
        return false;
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.length = 0;
      resolve(result);
    };
    const fail = (code) => {
      failure ??= code;
      killGroup();
    };
    try {
      child = spawn(snapshot.executable, snapshot.argv, {
        cwd: snapshot.cwd,
        env: snapshot.environment,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish(hold("PROCESS_SPAWN_FAILED"));
      return;
    }
    timer = setTimeout(
      () => fail("PROCESS_TIMEOUT"),
      Math.max(1, deadline - performance.now()),
    );
    const receive = (chunk, isError) => {
      if (settled || failure) return;
      if (performance.now() >= deadline) {
        fail("PROCESS_TIMEOUT");
        return;
      }
      total += chunk.length;
      if (total > snapshot.maxOutputBytes) {
        fail("PROCESS_OUTPUT_LIMIT");
        return;
      }
      if (isError) {
        stderrSeen ||= chunk.length > 0;
      } else output.push(chunk);
    };
    child.stdout.on("data", (chunk) => receive(chunk, false));
    child.stderr.on("data", (chunk) => receive(chunk, true));
    child.stdout.on("error", () => fail("PROCESS_STREAM_FAILED"));
    child.stderr.on("error", () => fail("PROCESS_STREAM_FAILED"));
    child.on("error", () => {
      failure ??= "PROCESS_SPAWN_FAILED";
    });
    child.on("exit", () => {
      // Terminate descendants retaining our pipes even when the leader exits.
      if (killGroup()) failure ??= "PROCESS_DESCENDANTS_TERMINATED";
    });
    child.on("close", (code, signal) => {
      if (failure) {
        finish(hold(failure));
        return;
      }
      if (performance.now() >= deadline) {
        finish(hold("PROCESS_TIMEOUT"));
        return;
      }
      if (code !== 0 || signal !== null) {
        finish(hold("PROCESS_EXIT_FAILED"));
        return;
      }
      if (stderrSeen) {
        finish(hold("PROCESS_STDERR"));
        return;
      }
      try {
        const stdout = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(output),
        );
        finish({
          status: "PASS",
          evidenceClass: "LOCAL_PROCESS_RESULT_ONLY",
          admissionGranted: false,
          exitCode: 0,
          stdout,
          stderr: "",
        });
      } catch {
        finish(hold("PROCESS_OUTPUT_ENCODING"));
      }
    });
  });
}
