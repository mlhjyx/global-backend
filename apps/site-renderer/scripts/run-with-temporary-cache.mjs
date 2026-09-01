import { spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdtemp,
  opendir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const command = process.argv[2];
if (command !== "build" && command !== "dev") {
  throw new Error("SITE_RENDERER_SOURCE_COMMAND_INVALID");
}
const forwardedArgs = process.argv.slice(3);
if (
  forwardedArgs.some(
    (value) => value === "--config" || value.startsWith("--config="),
  )
) {
  throw new Error("SITE_RENDERER_CONFIG_OVERRIDE_FORBIDDEN");
}

const require = createRequire(import.meta.url);
const rendererRoot = path.resolve(import.meta.dirname, "..");
const astroCli = path.join(
  path.dirname(require.resolve("astro/package.json")),
  "astro.js",
);
async function rejectSourceSymlinks(root) {
  const entries = await opendir(root);
  for await (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("SITE_RENDERER_SOURCE_SYMLINK_FORBIDDEN");
    }
    if (entry.isDirectory()) await rejectSourceSymlinks(entryPath);
  }
}

async function run() {
  let cacheRoot;
  let ownsCacheRoot = false;
  let child;
  let expectedSignal;
  const forwardSignal = (signal) => {
    expectedSignal ??= signal;
    if (command === "build") process.exitCode = signalExitCode();
    if (child) child.kill(expectedSignal);
  };
  const forwardTerm = () => forwardSignal("SIGTERM");
  const forwardInterrupt = () => forwardSignal("SIGINT");
  const signalExitCode = () =>
    expectedSignal === "SIGTERM"
      ? 143
      : expectedSignal === "SIGINT"
        ? 130
        : undefined;
  const stopBeforeChild = () => {
    if (!expectedSignal) return false;
    if (command === "build") process.exitCode = signalExitCode();
    return true;
  };
  process.on("SIGTERM", forwardTerm);
  process.on("SIGINT", forwardInterrupt);

  try {
    const dependencyRoot = path.join(rendererRoot, "node_modules");
    const [rendererReal, dependencyReal, dependencyStat] = await Promise.all([
      realpath(rendererRoot),
      realpath(dependencyRoot),
      lstat(dependencyRoot),
    ]);
    if (
      rendererReal !== rendererRoot ||
      dependencyStat.isSymbolicLink() ||
      !dependencyStat.isDirectory() ||
      path.relative(rendererReal, dependencyReal) !== "node_modules"
    ) {
      throw new Error("SITE_RENDERER_DEPENDENCY_ROOT_INVALID");
    }
    if (stopBeforeChild()) return;

    cacheRoot = await mkdtemp(
      command === "build"
        ? path.join(tmpdir(), "global-site-renderer-source-cache-")
        : path.join(dependencyReal, ".site-renderer-dev-cache-"),
    );
    ownsCacheRoot = true;
    if (stopBeforeChild()) return;

    const fixedSourceRoot = path.join(rendererRoot, "src");
    const sourceRoot =
      command === "build" ? path.join(cacheRoot, "src") : fixedSourceRoot;
    if (command === "build") {
      await cp(fixedSourceRoot, sourceRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
      });
    }
    await rejectSourceSymlinks(sourceRoot);
    if (stopBeforeChild()) return;
    await symlink(dependencyReal, path.join(cacheRoot, "node_modules"), "dir");
    if (stopBeforeChild()) return;

    const childEnv = { ...process.env, RENDERER_CACHE_ROOT: cacheRoot };
    if (command === "build" && !childEnv.OUT_DIR) {
      childEnv.OUT_DIR = path.join(rendererRoot, "dist");
    }
    if (command === "dev") {
      childEnv.RENDERER_SOURCE_ROOT = fixedSourceRoot;
      childEnv.RENDERER_DEV_DEPENDENCY_ROOT = path.resolve(
        rendererRoot,
        "..",
        "..",
        "node_modules",
      );
    }
    for (const name of ["SITESPEC_PATH", "OUT_DIR", "PUBLIC_ASSET_DIR"]) {
      const value = childEnv[name];
      if (value && !path.isAbsolute(value)) {
        childEnv[name] = path.resolve(rendererRoot, value);
      }
    }

    await new Promise((resolve, reject) => {
      child = spawn(
        process.execPath,
        [
          astroCli,
          command,
          "--config",
          path.relative(cacheRoot, path.join(rendererRoot, "astro.config.mjs")),
          ...forwardedArgs,
        ],
        {
          cwd: cacheRoot,
          env: childEnv,
          stdio: "inherit",
        },
      );
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        const expectedExitCode = signalExitCode();
        if (
          code === 0 ||
          (expectedSignal !== undefined &&
            (signal === expectedSignal || code === expectedExitCode))
        )
          resolve();
        else
          reject(
            new Error(
              `SITE_RENDERER_SOURCE_PROCESS_FAILED:${command}:${code ?? "signal"}:${signal ?? "none"}`,
            ),
          );
      });
    });
    if (command === "build" && expectedSignal) {
      process.exitCode = signalExitCode();
    }
  } finally {
    try {
      if (ownsCacheRoot) {
        await rm(cacheRoot, { recursive: true, force: true });
      }
    } finally {
      process.off("SIGTERM", forwardTerm);
      process.off("SIGINT", forwardInterrupt);
    }
  }
}

await run();
