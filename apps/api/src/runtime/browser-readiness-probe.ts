import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DOCUMENT = "data:text/html,<title>runtime-readiness</title>";
// Chromium startup can legitimately exceed five seconds when the managed host
// is under normal build/renderer load. Keep the probe bounded, but leave enough
// time to avoid turning transient scheduling pressure into a permanent
// singleton fail-closed state.
const TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 1_000;
const REAP_GRACE_MS = 5_000;
const OUTPUT_LIMIT = 128 * 1024;
const CLEANUP_ERROR = "BROWSER_PROBE_CLEANUP_INCOMPLETE";
const UNAVAILABLE_ERROR = "BROWSER_RUNTIME_UNAVAILABLE";
const CONFIG_ERROR = "BROWSER_RUNTIME_CONFIG_INVALID";
const EXECUTABLES = new Set(["/usr/bin/chromium", "/usr/bin/google-chrome"]);
type Probe = (executable: string) => Promise<void>;
type BrowserIdentity = Awaited<ReturnType<typeof fs.lstat>>;
type ChildResult =
  | { readonly kind: "ok" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "cleanup";
      readonly child: childProcess.ChildProcess;
      readonly closed: Promise<void>;
    };
type RootRelease = "cleaned" | "retry" | "fenced";
type Recovery = "recovered" | "pending" | "fenced";
/**
 * Outstanding cleanup ownership for one probe attempt. It is kept only while
 * the attempt cannot yet prove that its child, process group and private root
 * are terminal; a missing obligation means the next call may start a child.
 */
interface CleanupObligation {
  readonly attempt: number;
  readonly root: string;
  readonly identity: BrowserIdentity | undefined;
  readonly child: childProcess.ChildProcess | undefined;
  readonly closed: Promise<void> | undefined;
  readonly fenced: boolean;
}
type ProbeResult =
  | { readonly kind: "ok" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "cleanup"; readonly obligation: CleanupObligation };

function browserEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: join(root, "home"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    TMPDIR: join(root, "tmp"),
    // Chromium's crashpad helper requires an explicit headless mode in the
    // managed container. Keep this in the isolated child environment so the
    // readiness probe exercises the same non-interactive runtime contract in
    // every environment.
    CHROME_HEADLESS: "1",
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
    "--disable-breakpad",
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

async function waitForGroupExit(
  pid: number | undefined,
  timeoutMs: number,
): Promise<void> {
  if (pid === undefined) return;
  const deadline = Date.now() + timeoutMs;
  while (true) {
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
        // A process may disappear before open (ENOENT) or after its proc file
        // has been opened (ESRCH). Neither leaves an executable group member.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH") continue;
        throw new Error(CLEANUP_ERROR, { cause: error });
      }
      const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pid && fields[0] !== "Z" && fields[0] !== "X")
        active = true;
    }
    if (!active) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(CLEANUP_ERROR);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(10, remaining)),
    );
  }
}

function runBrowserChild(executable: string, root: string): Promise<ChildResult> {
  return new Promise((resolve) => {
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
    let closedSignal!: () => void;
    // The close signal is recorded before any early return so a late real close
    // can be observed by the owning attempt instead of being forgotten.
    const closed = new Promise<void>((resolveClose) => {
      closedSignal = resolveClose;
    });
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
      }, KILL_GRACE_MS);
    };
    const timeout = setTimeout(stop, TIMEOUT_MS);
    const reapDeadline = setTimeout(() => {
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      resolve({ kind: "cleanup", child, closed });
    }, TIMEOUT_MS + REAP_GRACE_MS);
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
      closedSignal();
      if (settled) return;
      settled = true;
      void waitForGroupExit(child.pid, REAP_GRACE_MS).then(
        () => {
          if (uncertain) resolve({ kind: "cleanup", child, closed });
          else if (
            failed ||
            code !== 0 ||
            !stdout.includes("<title>runtime-readiness</title>")
          ) {
            resolve({ kind: "unavailable" });
          } else resolve({ kind: "ok" });
        },
        () => resolve({ kind: "cleanup", child, closed }),
      );
    });
  });
}

function sameIdentity(current: BrowserIdentity, identity: BrowserIdentity): boolean {
  return (
    current.isDirectory() &&
    !current.isSymbolicLink() &&
    current.dev === identity.dev &&
    current.ino === identity.ino &&
    current.uid === identity.uid &&
    (Number(current.mode) & 0o777) === 0o700
  );
}

async function releaseRoot(
  root: string,
  identity: BrowserIdentity,
): Promise<RootRelease> {
  let current: BrowserIdentity;
  try {
    current = await fs.lstat(root);
  } catch {
    return "fenced";
  }
  if (!sameIdentity(current, identity)) return "fenced";
  try {
    await fs.rm(root, { recursive: true, force: false });
  } catch {
    return "retry";
  }
  return "cleaned";
}

async function runProbe(executable: string, attempt: number): Promise<ProbeResult> {
  // Capture a canonical parent once; never clean an ambient HOME/cache directory.
  const parent = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(join(parent, "global-browser-probe-"));
  let identity: BrowserIdentity;
  try {
    identity = await fs.lstat(root);
  } catch {
    // The just-created root cannot be proven ours; never guess-delete it.
    return {
      kind: "cleanup",
      obligation: { attempt, root, identity: undefined, child: undefined, closed: undefined, fenced: true },
    };
  }
  let result: ChildResult;
  try {
    for (const child of ["home", "cache", "config", "tmp", "profile"]) {
      await fs.mkdir(join(root, child), { mode: 0o700 });
    }
    result = await runBrowserChild(executable, root);
  } catch {
    result = { kind: "unavailable" };
  }
  if (result.kind === "cleanup") {
    return {
      kind: "cleanup",
      obligation: { attempt, root, identity, child: result.child, closed: result.closed, fenced: false },
    };
  }
  const release = await releaseRoot(root, identity);
  if (release === "cleaned") return result;
  return {
    kind: "cleanup",
    obligation: {
      attempt,
      root,
      identity,
      child: undefined,
      closed: undefined,
      fenced: release === "fenced",
    },
  };
}

async function waitWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  // Only the wait is bounded; the close promise itself stays owned by the
  // obligation so a later real close is never abandoned by this race.
  const settled = await Promise.race([promise.then(() => true), timedOut]);
  if (timer) clearTimeout(timer);
  return settled;
}

async function recoverObligation(obligation: CleanupObligation): Promise<Recovery> {
  if (obligation.fenced || obligation.identity === undefined) return "fenced";
  if (obligation.closed && !(await waitWithin(obligation.closed, REAP_GRACE_MS)))
    return "pending";
  try {
    await waitForGroupExit(obligation.child?.pid, REAP_GRACE_MS);
  } catch {
    return "pending";
  }
  const release = await releaseRoot(obligation.root, obligation.identity);
  if (release === "cleaned") return "recovered";
  return release === "fenced" ? "fenced" : "pending";
}

/**
 * One instance per runtime process. A cleanup obligation is retained until this
 * same attempt can prove its child/group/root terminal; only then may a later
 * call run a fresh full probe. Obligation transitions happen only inside the
 * singleflight call chain, so late close callbacks can never clear a newer
 * fence. A fenced identity (unknown or replaced root) stays closed to manual
 * operations instead of being deleted or ignored.
 */
export function createBrowserReadinessProbe(): Probe {
  let inFlight: Promise<void> | undefined;
  let executableInFlight: string | undefined;
  let obligation: CleanupObligation | undefined;
  let attempts = 0;
  const run = async (executable: string): Promise<void> => {
    if (obligation) {
      const current = obligation;
      let recovery: Recovery;
      try {
        recovery = await recoverObligation(current);
      } catch {
        recovery = "pending";
      }
      if (recovery !== "recovered" || obligation !== current)
        throw new Error(CLEANUP_ERROR);
      obligation = undefined;
    }
    attempts += 1;
    let result: ProbeResult;
    try {
      result = await runProbe(executable, attempts);
    } catch {
      throw new Error(UNAVAILABLE_ERROR);
    }
    if (result.kind === "ok") return;
    if (result.kind === "unavailable") throw new Error(UNAVAILABLE_ERROR);
    obligation = result.obligation;
    throw new Error(CLEANUP_ERROR);
  };
  return (executable) => {
    if (process.platform !== "linux" || !EXECUTABLES.has(executable)) {
      return Promise.reject(new Error(CONFIG_ERROR));
    }
    if (inFlight) {
      return executableInFlight === executable
        ? inFlight
        : Promise.reject(new Error(CONFIG_ERROR));
    }
    executableInFlight = executable;
    inFlight = run(executable).finally(() => {
      inFlight = undefined;
      executableInFlight = undefined;
    });
    return inFlight;
  };
}

export const probeBrowserReadiness = createBrowserReadinessProbe();
