import { createHash } from 'node:crypto';
import { lstat, opendir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const BUILD_SHA = /^[0-9a-f]{40}$/;
const TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/i;
const SOURCE_FORBIDDEN_SEGMENTS = new Set([
  '__fixtures__',
  '__mocks__',
  'eval',
  'fixtures',
  'test-support',
  'testing',
  'visual-tests',
]);

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalTimestamp(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('artifact manifest builtAt must be canonical RFC3339 UTC');
  }
  return value;
}

function normalized(root, path) {
  return relative(root, path).split(sep).join('/');
}

function sourceFileAllowed(path) {
  const segments = path.split('/');
  return (
    !segments.some((segment) => SOURCE_FORBIDDEN_SEGMENTS.has(segment)) &&
    !TEST_FILE.test(segments.at(-1) ?? '')
  );
}

async function inventory(root, source) {
  const absoluteRoot = resolve(root);
  const rootStat = await lstat(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('manifest inventory root must be a non-symlink directory');
  }
  const files = [];
  const visit = async (directory) => {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const path = normalized(absoluteRoot, absolute);
      if (entry.isSymbolicLink()) {
        throw new Error(`manifest inventory symlink is forbidden: ${path}`);
      }
      if (source && !sourceFileAllowed(path)) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`manifest inventory entry must be a regular file: ${path}`);
      }
      const bytes = await readFile(absolute);
      files.push({ path, sha256: sha256(bytes), bytes: bytes.length });
    }
  };
  await visit(absoluteRoot);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const digest = sha256(
    files.map((file) => `${file.path}\0${file.sha256}\0${file.bytes}\n`).join(''),
  );
  return { digest, files };
}

export async function generateRuntimeArtifactManifest({
  buildSha,
  builtAt,
  components,
  sourceRoots,
  sbomPath,
}) {
  if (!BUILD_SHA.test(buildSha)) {
    throw new Error('artifact manifest buildSha must be 40 lowercase hex');
  }
  if (!Array.isArray(components) || components.length !== 3) {
    throw new Error('artifact manifest requires exactly api, contracts and renderer');
  }
  const componentNames = components.map(({ name }) => name).sort();
  if (componentNames.join(',') !== 'api,contracts,renderer') {
    throw new Error('artifact manifest component names are invalid');
  }
  if (!Array.isArray(sourceRoots) || sourceRoots.length === 0) {
    throw new Error('artifact manifest source roots are required');
  }
  const componentInventory = await Promise.all(
    components.map(async ({ name, root }) => ({
      name,
      ...(await inventory(root, false)),
    })),
  );
  componentInventory.sort((left, right) => left.name.localeCompare(right.name));
  const sourceInventory = await Promise.all(
    sourceRoots.map(async ({ name, root }) => ({
      name,
      ...(await inventory(root, true)),
    })),
  );
  sourceInventory.sort((left, right) => left.name.localeCompare(right.name));
  const sourceTreeDigest = sha256(
    sourceInventory.map((item) => `${item.name}\0${item.digest}\n`).join(''),
  );
  const sbomBytes = await readFile(sbomPath);

  return {
    schema_version: 'global-runtime-artifact-manifest/v1',
    build_sha: buildSha,
    built_at: canonicalTimestamp(builtAt),
    source_tree_digest: sourceTreeDigest,
    sbom: {
      path: 'apps/api/dist/runtime-sbom.cdx.json',
      sha256: sha256(sbomBytes),
    },
    components: componentInventory,
    source_roots: sourceInventory,
  };
}

function parseNamedRoot(value, label) {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`${label} must be name=path`);
  }
  return { name: value.slice(0, separator), root: value.slice(separator + 1) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0 || !args[index + 1]) throw new Error(`${flag} is required`);
    return args[index + 1];
  };
  const sources = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--source' && args[index + 1]) {
      sources.push(parseNamedRoot(args[index + 1], '--source'));
      index += 1;
    }
  }
  const output = value('--output');
  const manifest = await generateRuntimeArtifactManifest({
    buildSha: value('--build-sha'),
    builtAt: value('--built-at'),
    sbomPath: value('--sbom'),
    components: [
      parseNamedRoot(`api=${value('--api')}`, '--api'),
      parseNamedRoot(`contracts=${value('--contracts')}`, '--contracts'),
      parseNamedRoot(`renderer=${value('--renderer')}`, '--renderer'),
    ],
    sourceRoots: sources,
  });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(
    `${JSON.stringify({ status: 'RUNTIME_ARTIFACT_MANIFEST_WRITTEN' })}\n`,
  );
}
