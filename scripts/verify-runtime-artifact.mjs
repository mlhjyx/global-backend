import { lstat, opendir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const FORBIDDEN_SEGMENTS = new Set([
  '__fixtures__',
  '__mocks__',
  'eval',
  'fixtures',
  'test-support',
  'testing',
  'visual-tests',
]);
const FORBIDDEN_FILE = /(?:^|[.-])(?:dev-token-verifier|m1eb-golden|sandbox(?:-discovery)?|stub-model)(?:[.-]|$)/i;
const TEST_FILE = /\.(?:spec|test(?:-fixture)?)\.[cm]?[jt]sx?$/i;
const GALLERY_ENTRYPOINT = /(?:^|[.-])gallery(?:[.-]|$)/i;
const PRODUCT_GALLERY_CATALOG_FILES = new Set([
  'product-assets/component-catalog-v1/area-gallery-spec.json',
  'product-assets/component-catalog-v1/photo-gallery-spec.json',
]);

function normalized(root, path) {
  return relative(root, path).split(sep).join('/');
}

function violationCode(path) {
  const segments = path.split('/');
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
    return 'FORBIDDEN_RUNTIME_DIRECTORY';
  }
  const basename = segments.at(-1) ?? '';
  if (TEST_FILE.test(basename)) return 'PRODUCT_TEST_FILE_PRESENT';
  if (
    GALLERY_ENTRYPOINT.test(basename) &&
    !PRODUCT_GALLERY_CATALOG_FILES.has(path)
  ) {
    return 'GALLERY_ENTRYPOINT_PRESENT';
  }
  if (FORBIDDEN_FILE.test(basename)) return 'SYNTHETIC_PROVIDER_PRESENT';
  return undefined;
}

export async function findForbiddenRuntimeArtifacts(root) {
  const absoluteRoot = resolve(root);
  const rootStat = await lstat(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('runtime artifact root must be a non-symlink directory');
  }
  const violations = [];
  const visit = async (directory) => {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const path = normalized(absoluteRoot, absolute);
      if (entry.isSymbolicLink()) {
        violations.push({ path, code: 'RUNTIME_SYMLINK_FORBIDDEN' });
        continue;
      }
      const code = violationCode(path);
      if (code) {
        violations.push({ path, code });
        if (entry.isDirectory()) continue;
      }
      if (entry.isDirectory()) await visit(absolute);
    }
  };
  await visit(absoluteRoot);
  return violations.sort((left, right) => left.path.localeCompare(right.path));
}

export async function assertRuntimeArtifactClean(root) {
  const violations = await findForbiddenRuntimeArtifacts(root);
  if (violations.length > 0) {
    throw new Error(
      `forbidden runtime artifacts: ${violations
        .map((item) => `${item.code}:${item.path}`)
        .join(',')}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2];
  if (!root) throw new Error('usage: verify-runtime-artifact.mjs <artifact-root>');
  await assertRuntimeArtifactClean(root);
  process.stdout.write(`${JSON.stringify({ status: 'RUNTIME_ARTIFACT_CLEAN' })}\n`);
}
