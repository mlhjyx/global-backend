// Test-only byte-preserving dependency overlay. Never chmod a shared install.
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

async function packageDirectory(require, name) {
  let entry;
  try {
    entry = require.resolve(`${name}/package.json`);
  } catch {
    entry = require.resolve(name);
  }
  let directory = dirname(await realpath(entry));
  for (;;) {
    try {
      await readFile(join(directory, "package.json"));
      return directory;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) throw new Error("SDK_TEST_PACKAGE_UNAVAILABLE");
      directory = parent;
    }
  }
}

async function readableCopy(directory) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await readableCopy(path);
    else {
      const info = await lstat(path);
      await chmod(path, info.mode & 0o111 ? 0o755 : 0o644);
    }
  }
}

export async function prepareWorkerDependencies(repositoryRoot, output) {
  if (
    !isAbsolute(repositoryRoot) ||
    !isAbsolute(output) ||
    !output.startsWith("/tmp/codex-task4c-platform-temporal-")
  )
    throw new Error("SDK_TEST_OVERLAY_PATH_INVALID");
  const store = await realpath(join(repositoryRoot, "node_modules/.pnpm"));
  const appRequire = createRequire(
    join(repositoryRoot, "apps/api/package.json"),
  );
  const queue = [];
  for (const name of [
    "@temporalio/worker",
    "@temporalio/client",
    "@temporalio/activity",
    "@temporalio/workflow",
  ]) {
    const directory = await packageDirectory(appRequire, name);
    const metadata = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    if (metadata.name !== name || metadata.version !== "1.23.0")
      throw new Error("SDK_TEST_VERSION_MISMATCH");
    queue.push(directory);
  }
  const visited = new Set();
  const entries = new Set();
  while (queue.length) {
    const directory = queue.shift();
    if (visited.has(directory)) continue;
    if (!directory.startsWith(`${store}${sep}`) || visited.size >= 512)
      throw new Error("SDK_TEST_DEPENDENCY_SCOPE_INVALID");
    visited.add(directory);
    entries.add(relative(store, directory).split(sep)[0]);
    const metadata = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    const require = createRequire(join(directory, "package.json"));
    const dependencies = {
      ...metadata.dependencies,
      ...metadata.optionalDependencies,
      ...metadata.peerDependencies,
    };
    for (const name of Object.keys(dependencies)) {
      try {
        queue.push(await packageDirectory(require, name));
      } catch (error) {
        if (
          metadata.optionalDependencies?.[name] ||
          metadata.peerDependenciesMeta?.[name]?.optional
        )
          continue;
        throw new Error(`SDK_TEST_DEPENDENCY_UNAVAILABLE ${name}`, {
          cause: error,
        });
      }
    }
  }
  const target = join(output, ".pnpm");
  await mkdir(target, { recursive: false, mode: 0o700 });
  for (const entry of [...entries].sort()) {
    await cp(join(store, entry), join(target, entry), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
  }
  await readableCopy(target);
  return { packages: visited.size, storeEntries: entries.size };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await prepareWorkerDependencies(...process.argv.slice(2));
  process.stdout.write(
    `prepared isolated SDK dependency closure: ${result.packages} packages\n`,
  );
}
