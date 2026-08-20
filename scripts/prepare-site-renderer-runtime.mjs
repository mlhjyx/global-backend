import { copyFile, lstat, mkdir, opendir } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRuntimeArtifactClean } from './verify-runtime-artifact.mjs';

const ROOT_FILES = Object.freeze(['package.json', 'astro.config.mjs']);
const PRODUCT_TREES = Object.freeze(['src', 'public', 'product-assets']);
const FORBIDDEN_SEGMENTS = new Set([
  '__fixtures__',
  '__mocks__',
  'eval',
  'fixtures',
  'test-support',
  'testing',
  'visual-tests',
]);
const TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/i;
const GALLERY_ENTRYPOINT = /^(?:gallery|gallery[.-].*)\.(?:astro|[cm]?[jt]sx?|html)$/i;

function normalized(root, path) {
  return relative(root, path).split(sep).join('/');
}

function shouldExclude(relativePath) {
  const segments = relativePath.split('/');
  return (
    segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment)) ||
    TEST_FILE.test(basename(relativePath)) ||
    GALLERY_ENTRYPOINT.test(basename(relativePath))
  );
}

async function copyProductTree(sourceRoot, targetRoot, tree) {
  const sourceTree = join(sourceRoot, tree);
  try {
    const stat = await lstat(sourceTree);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`renderer runtime source tree must be a real directory: ${tree}`);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  const visit = async (sourceDirectory) => {
    const entries = await opendir(sourceDirectory);
    for await (const entry of entries) {
      const sourcePath = join(sourceDirectory, entry.name);
      const relativePath = normalized(sourceRoot, sourcePath);
      if (entry.isSymbolicLink()) {
        throw new Error(`renderer runtime source symlink is forbidden: ${relativePath}`);
      }
      if (shouldExclude(relativePath)) continue;
      const targetPath = join(targetRoot, relativePath);
      if (entry.isDirectory()) {
        await mkdir(targetPath, { recursive: true });
        await visit(sourcePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`renderer runtime source contains unsupported entry: ${relativePath}`);
      }
      await mkdir(join(targetPath, '..'), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
  };
  await mkdir(join(targetRoot, tree), { recursive: true });
  await visit(sourceTree);
}

export async function prepareSiteRendererRuntime(source, target) {
  const sourceRoot = resolve(source);
  const targetRoot = resolve(target);
  if (targetRoot === sourceRoot || targetRoot.startsWith(`${sourceRoot}${sep}`)) {
    throw new Error('renderer runtime target must be outside the source tree');
  }
  const sourceStat = await lstat(sourceRoot);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error('renderer runtime source must be a non-symlink directory');
  }
  await mkdir(targetRoot);

  for (const file of ROOT_FILES) {
    const sourceFile = join(sourceRoot, file);
    const stat = await lstat(sourceFile);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`renderer runtime root file must be a real file: ${file}`);
    }
    await copyFile(sourceFile, join(targetRoot, file));
  }
  for (const tree of PRODUCT_TREES) {
    await copyProductTree(sourceRoot, targetRoot, tree);
  }
  await assertRuntimeArtifactClean(targetRoot);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, target] = process.argv.slice(2);
  if (!source || !target) {
    throw new Error('usage: prepare-site-renderer-runtime.mjs <source> <target>');
  }
  await prepareSiteRendererRuntime(source, target);
  process.stdout.write(`${JSON.stringify({ status: 'SITE_RENDERER_RUNTIME_PREPARED' })}\n`);
}
