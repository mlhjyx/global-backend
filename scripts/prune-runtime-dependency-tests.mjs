import { lstat, opendir, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_DIRECTORIES = new Set([
  '__fixtures__',
  '__mocks__',
  '__tests__',
  'fixtures',
  'test',
  'tests',
]);
const TEST_FILE = /\.(?:spec|test(?:-fixture)?)\.[cm]?[jt]sx?$/iu;
const REQUIRED_RUNTIME_DIRECTORY =
  /\/node_modules\/@nestjs\/swagger\/dist\/fixtures$/u;

function requiredRuntimeDirectory(path) {
  return REQUIRED_RUNTIME_DIRECTORY.test(path.replaceAll('\\', '/'));
}

export async function pruneRuntimeDependencyTests(root) {
  const absoluteRoot = resolve(root);
  if (basename(absoluteRoot) !== 'node_modules') {
    throw new Error('runtime dependency pruning requires an exact node_modules root');
  }
  const rootStat = await lstat(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('runtime dependency root must be a non-symlink directory');
  }

  let removedCount = 0;
  const visit = async (directory) => {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (
        entry.isDirectory() &&
        TEST_DIRECTORIES.has(entry.name) &&
        !requiredRuntimeDirectory(absolute)
      ) {
        await rm(absolute, { recursive: true, force: false });
        removedCount += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (entry.isFile() && TEST_FILE.test(entry.name)) {
        await rm(absolute);
        removedCount += 1;
      }
    }
  };
  await visit(absoluteRoot);
  return removedCount;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    throw new Error('usage: prune-runtime-dependency-tests.mjs <node_modules> [...]');
  }
  let removedCount = 0;
  for (const root of roots) removedCount += await pruneRuntimeDependencyTests(root);
  process.stdout.write(
    `${JSON.stringify({ status: 'RUNTIME_DEPENDENCY_TESTS_PRUNED', removed_count: removedCount })}\n`,
  );
}
