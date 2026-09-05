import childProcess from "node:child_process";
import fs, { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DOCUMENT = "data:text/html,<title>runtime-readiness</title>";
const TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT = 128 * 1024;
const CLEANUP_ERROR = "BROWSER_PROBE_CLEANUP_INCOMPLETE";
const EXECUTABLES = new Set(["/usr/bin/chromium", "/usr/bin/google-chrome"]);
type Probe = (executable: string) => Promise<void>;
function browserEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: join(root, "home"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    TMPDIR: join(root, "tmp"),
  };
}

function browserArguments(root: string): string[] {
  return [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-component-update",
    "--no-first-run",
    "--no-default-browser-check",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    `--user-data-dir=${join(root, "profile")}`,
    "--dump-dom",
    DOCUMENT,
  ];
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForGroupExit(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw new Error(CLEANUP_ERROR, { cause: error });
    }
    // An exited orphan can remain a zombie until container init reaps it.
    // Only a still-executable member can continue touching the owned directory.
    const pids = (await fs.readdir("/proc")).filter((value) =>
      /^\d+$/.test(value),
    );
    if (pids.length > 4096) throw new Error(CLEANUP_ERROR);
    let active = false;
    for (const candidate of pids) {
      let raw: string;
      try {
        raw = await fs.readFile(`/proc/${candidate}/stat`, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error(CLEANUP_ERROR, { cause: error });
      }
      const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pid && fields[0] !== "Z" && fields[0] !== "X")
        active = true;
    }
    if (!active) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(CLEANUP_ERROR);
}

function runBrowserChild(executable: string, root: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(executable, browserArguments(root), {
      detached: true,
      cwd: root,
      env: browserEnvironment(root),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failed = false;
    let uncertain = false;
    let settled = false;
    let stdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      failed = true;
      if (killTimer) return;
      try {
        signalGroup(child.pid, "SIGTERM");
      } catch {
        uncertain = true;
      }
      killTimer = setTimeout(() => {
        try {
          signalGroup(child.pid, "SIGKILL");
        } catch {
          uncertain = true;
        }
      }, 500);
    };
    const timeout = setTimeout(stop, TIMEOUT_MS);
    const reapDeadline = setTimeout(() => {
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      reject(new Error(CLEANUP_ERROR));
    }, TIMEOUT_MS + 2_000);
    child.stdout.on("data", (data: Buffer) => {
      stdoutBytes += data.length;
      if (stdoutBytes > OUTPUT_LIMIT) stop();
      else stdout += data.toString("utf8");
    });
    child.stderr.on("data", (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes > OUTPUT_LIMIT) stop();
    });
    child.once("error", () => {
      failed = true;
    });
    child.once("exit", () => {
      try {
        signalGroup(child.pid, "SIGKILL");
      } catch {
        uncertain = true;
      }
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(reapDeadline);
      if (settled) return;
      settled = true;
      void waitForGroupExit(child.pid).then(
        () => {
          if (uncertain) reject(new Error(CLEANUP_ERROR));
          else if (
            failed ||
            code !== 0 ||
            !stdout.includes("<title>runtime-readiness</title>")
          ) {
            reject(new Error("BROWSER_RUNTIME_UNAVAILABLE"));
          } else resolve();
        },
        () => reject(new Error(CLEANUP_ERROR)),
      );
    });
  });
}

async function runProbe(executable: string): Promise<void> {
  // Capture a canonical parent once; never clean an ambient HOME/cache directory.
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, "global-browser-probe-"));
  let identity: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    identity = await fs.lstat(root);
  } catch (error) {
    throw new Error(CLEANUP_ERROR, { cause: error });
  }
  let safeToClean = true;
  let failure: Error | undefined;
  try {
    for (const child of ["home", "cache", "config", "tmp", "profile"]) {
      await mkdir(join(root, child), { mode: 0o700 });
    }
    await runBrowserChild(executable, root);
  } catch (error) {
    safeToClean = !(error instanceof Error && error.message === CLEANUP_ERROR);
    failure = new Error(
      safeToClean ? "BROWSER_RUNTIME_UNAVAILABLE" : CLEANUP_ERROR,
      { cause: error },
    );
  }
  if (safeToClean) {
    try {
      const current = await fs.lstat(root);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        current.uid !== identity.uid ||
        (current.mode & 0o777) !== 0o700
      ) {
        throw new Error("root identity changed");
      }
      await rm(root, { recursive: true, force: false });
    } catch (error) {
      failure = new Error(CLEANUP_ERROR, { cause: error });
    }
  }
  if (failure) throw failure;
}

/** One instance per runtime process; ambiguous cleanup stops further accumulation. */
export function createBrowserReadinessProbe(): Probe {
  let inFlight: Promise<void> | undefined;
  let executableInFlight: string | undefined;
  let cleanupIncomplete = false;
  return (executable) => {
    if (process.platform !== "linux" || !EXECUTABLES.has(executable)) {
      return Promise.reject(new Error("BROWSER_RUNTIME_CONFIG_INVALID"));
    }
    if (cleanupIncomplete) {
      return Promise.reject(new Error("BROWSER_PROBE_CLEANUP_INCOMPLETE"));
    }
    if (inFlight) {
      return executableInFlight === executable
        ? inFlight
        : Promise.reject(new Error("BROWSER_RUNTIME_CONFIG_INVALID"));
    }
    executableInFlight = executable;
    inFlight = runProbe(executable)
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          error.message === "BROWSER_PROBE_CLEANUP_INCOMPLETE"
        ) {
          cleanupIncomplete = true;
        }
        throw new Error(
          cleanupIncomplete
            ? "BROWSER_PROBE_CLEANUP_INCOMPLETE"
            : "BROWSER_RUNTIME_UNAVAILABLE",
        );
      })
      .finally(() => {
        inFlight = undefined;
        executableInFlight = undefined;
      });
    return inFlight;
  };
}

export const probeBrowserReadiness = createBrowserReadinessProbe();
