import { createHash } from 'node:crypto';
import {
  lstat,
  opendir,
  readFile,
  realpath,
} from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PRODUCT_FORBIDDEN_SEGMENTS = new Set([
  '__fixtures__',
  '__mocks__',
  'eval',
  'fixtures',
  'test-support',
  'testing',
  'visual-tests',
]);
const PRODUCT_TEST_FILE = /\.(?:spec|test(?:-fixture)?)\.[cm]?[jt]sx?$/iu;
const PRODUCT_FORBIDDEN_FILE =
  /(?:^|[.-])(?:dev-token-verifier|m1eb-golden|sandbox(?:-discovery)?|stub-model)(?:[.-]|$)/iu;
const PRODUCT_GALLERY = /(?:^|[.-])gallery(?:[.-]|$)/iu;
const PRODUCT_GALLERY_CATALOG_FILES = new Set([
  'apps/site-renderer/product-assets/component-catalog-v1/area-gallery-spec.json',
  'apps/site-renderer/product-assets/component-catalog-v1/photo-gallery-spec.json',
]);
const DEPENDENCY_TEST_SEGMENTS = new Set([
  '__fixtures__',
  '__mocks__',
  '__tests__',
  'fixtures',
  'test',
  'tests',
]);
const REQUIRED_DEPENDENCY_RUNTIME_DIRECTORY =
  /(?:^|\/)node_modules\/@nestjs\/swagger\/dist\/fixtures(?:\/|$)/u;
const DEV_DEPENDENCY =
  /(?:^|\/)node_modules\/(?:\.pnpm\/)?(?:@global\+test-support(?:@|\/)|@nestjs\+(?:cli|schematics)@|@redocly\+|@vitest\+|vitest@|@playwright\+test@)/iu;

function sha256(contents) {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

function normalized(root, path) {
  return relative(root, path).split(sep).join('/');
}

function contained(root, path) {
  const relativePath = relative(root, path);
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..');
}

function dependencyRootFor(path) {
  const segments = resolve(path).split(sep);
  const index = segments.indexOf('node_modules');
  if (index < 0) return undefined;
  return segments.slice(0, index + 1).join(sep) || sep;
}

function productViolation(path) {
  const segments = path.split('/');
  if (segments.some((segment) => PRODUCT_FORBIDDEN_SEGMENTS.has(segment))) {
    return 'FORBIDDEN_RUNTIME_DIRECTORY';
  }
  const basename = segments.at(-1) ?? '';
  if (PRODUCT_TEST_FILE.test(basename)) return 'PRODUCT_TEST_FILE_PRESENT';
  if (
    PRODUCT_GALLERY.test(basename) &&
    !PRODUCT_GALLERY_CATALOG_FILES.has(path)
  ) {
    return 'GALLERY_ENTRYPOINT_PRESENT';
  }
  if (PRODUCT_FORBIDDEN_FILE.test(basename)) return 'SYNTHETIC_PROVIDER_PRESENT';
  return undefined;
}

function dependencyViolation(path) {
  const segments = path.split('/');
  if (
    segments.some((segment) => DEPENDENCY_TEST_SEGMENTS.has(segment)) &&
    !REQUIRED_DEPENDENCY_RUNTIME_DIRECTORY.test(path)
  ) {
    return 'FORBIDDEN_RUNTIME_DIRECTORY';
  }
  const basename = segments.at(-1) ?? '';
  if (PRODUCT_TEST_FILE.test(basename)) return 'PRODUCT_TEST_FILE_PRESENT';
  return undefined;
}

async function assertRuntimeSurface(root) {
  const absoluteRoot = resolve(root);
  const visit = async (directory) => {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const path = normalized(absoluteRoot, absolute);
      const dependencyRoot = dependencyRootFor(absolute);
      if (entry.isSymbolicLink()) {
        if (!dependencyRoot) {
          throw new Error(`runtime symlink outside dependency deployment: ${path}`);
        }
        let target;
        try {
          target = await realpath(absolute);
        } catch (error) {
          throw new Error(`runtime dependency symlink is broken: ${path}`, { cause: error });
        }
        if (!contained(dependencyRoot, target)) {
          throw new Error(`dependency symlink escapes deployment root: ${path}`);
        }
        continue;
      }
      if (dependencyRoot) {
        if (DEV_DEPENDENCY.test(`/${path}`)) {
          throw new Error(`DEV_DEPENDENCY_PRESENT:${path}`);
        }
        const violation = dependencyViolation(path);
        if (violation) throw new Error(`${violation}:${path}`);
      } else {
        const violation = productViolation(path);
        if (violation) throw new Error(`${violation}:${path}`);
      }
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (!entry.isFile()) {
        throw new Error(`runtime image contains unsupported entry: ${path}`);
      }
    }
  };
  const stat = await lstat(absoluteRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('runtime image root must be a non-symlink directory');
  }
  await visit(absoluteRoot);
}

async function readJson(path, label) {
  const bytes = await readFile(path);
  if (bytes.length > 32 * 1024 * 1024) throw new Error(`${label} exceeds byte limit`);
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch (error) {
    throw new Error(`${label} must be valid JSON`, { cause: error });
  }
}

async function componentInventory(root, ignoredRootEntries = new Set()) {
  const absoluteRoot = resolve(root);
  const files = [];
  const visit = async (directory) => {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const path = normalized(absoluteRoot, absolute);
      if (!path.includes('/') && ignoredRootEntries.has(path)) continue;
      if (entry.isSymbolicLink()) throw new Error(`component symlink is forbidden: ${path}`);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error(`component entry must be a file: ${path}`);
      const bytes = await readFile(absolute);
      files.push({ path, sha256: sha256(bytes), bytes: bytes.length });
    }
  };
  await visit(absoluteRoot);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    digest: sha256(
      files.map((file) => `${file.path}\0${file.sha256}\0${file.bytes}\n`).join(''),
    ),
    files,
  };
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

async function installedProductionPackages(root) {
  const identities = new Set();
  for (const deployment of ['apps/api', 'apps/site-renderer']) {
    const virtualStore = resolve(root, deployment, 'node_modules/.pnpm');
    let entries;
    try {
      entries = await opendir(virtualStore);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for await (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const packageRoot = resolve(virtualStore, entry.name, 'node_modules');
      let packages;
      try {
        packages = await opendir(packageRoot);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      for await (const packageEntry of packages) {
        if (packageEntry.name === '.bin' || packageEntry.name === '.prisma') continue;
        const candidates = [];
        if (packageEntry.name.startsWith('@') && packageEntry.isDirectory()) {
          const scoped = await opendir(resolve(packageRoot, packageEntry.name));
          for await (const child of scoped) {
            if (child.isDirectory()) candidates.push(resolve(packageRoot, packageEntry.name, child.name));
          }
        } else if (packageEntry.isDirectory()) {
          candidates.push(resolve(packageRoot, packageEntry.name));
        }
        for (const candidate of candidates) {
          try {
            const decoded = JSON.parse(await readFile(resolve(candidate, 'package.json'), 'utf8'));
            if (typeof decoded.name === 'string' && typeof decoded.version === 'string') {
              identities.add(`${decoded.name}@${decoded.version}`);
            }
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
        }
      }
    }
  }
  return identities;
}

async function installedOperatingSystemPackagePurls(root) {
  let status;
  try {
    status = await readFile(resolve(root, 'var/lib/dpkg/status'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return new Set();
    throw error;
  }
  const purls = new Set();
  for (const paragraph of status.split(/\n\n+/u)) {
    const fields = new Map(
      paragraph
        .split('\n')
        .filter((line) => /^[A-Za-z][A-Za-z-]*: /u.test(line))
        .map((line) => {
          const separator = line.indexOf(': ');
          return [line.slice(0, separator), line.slice(separator + 2)];
        }),
    );
    if (fields.get('Status') !== 'install ok installed') continue;
    const packageName = fields.get('Package');
    const version = fields.get('Version');
    const architecture = fields.get('Architecture');
    if (!packageName || !version || !architecture) {
      throw new Error('installed dpkg package identity is incomplete');
    }
    const binaryName =
      fields.get('Multi-Arch') === 'same' ? `${packageName}:${architecture}` : packageName;
    purls.add(
      `pkg:deb/debian/${encodeURIComponent(binaryName)}@${encodeURIComponent(version)}?arch=${encodeURIComponent(architecture)}`,
    );
  }
  return purls;
}

export async function assertRuntimeImageValid(root) {
  const absoluteRoot = resolve(root);
  await assertRuntimeSurface(absoluteRoot);

  const dist = resolve(absoluteRoot, 'apps/api/dist');
  const manifestReceipt = await readJson(
    resolve(dist, 'artifact-manifest.json'),
    'runtime artifact manifest',
  );
  const attestationReceipt = await readJson(
    resolve(dist, 'build-attestation.json'),
    'build attestation',
  );
  const sbomReceipt = await readJson(
    resolve(dist, 'runtime-sbom.cdx.json'),
    'runtime SBOM',
  );
  const manifest = manifestReceipt.value;
  const attestation = attestationReceipt.value;
  const sbom = sbomReceipt.value;
  if (manifest?.schema_version !== 'global-runtime-artifact-manifest/v1') {
    throw new Error('runtime artifact manifest schema is invalid');
  }
  if (!Array.isArray(manifest.components) || manifest.components.length !== 3) {
    throw new Error('runtime artifact manifest components are invalid');
  }
  if (sha256(manifestReceipt.bytes) !== requireDigest(attestation?.artifact_manifest_digest, 'attestation manifest digest')) {
    throw new Error('runtime artifact manifest digest mismatch');
  }
  if (sha256(sbomReceipt.bytes) !== requireDigest(attestation?.sbom_digest, 'attestation SBOM digest')) {
    throw new Error('runtime SBOM digest mismatch');
  }

  const components = new Map(manifest.components.map((component) => [component?.name, component]));
  const definitions = [
    ['api', dist, new Set(['artifact-manifest.json', 'build-attestation.json'])],
    ['contracts', resolve(absoluteRoot, 'packages/contracts/dist'), new Set()],
    ['renderer', resolve(absoluteRoot, 'apps/site-renderer'), new Set(['node_modules'])],
  ];
  for (const [name, componentRoot, ignored] of definitions) {
    const expected = components.get(name);
    if (!expected || !Array.isArray(expected.files)) {
      throw new Error(`${name} component inventory is missing`);
    }
    const actual = await componentInventory(componentRoot, ignored);
    if (actual.digest !== requireDigest(expected.digest, `${name} component digest`)) {
      throw new Error(`${name} component digest mismatch`);
    }
    if (JSON.stringify(actual.files) !== JSON.stringify(expected.files)) {
      throw new Error(`${name} component file inventory mismatch`);
    }
  }
  const contractsDigest = requireDigest(components.get('contracts')?.digest, 'contracts digest');
  for (const deployment of ['apps/api', 'apps/site-renderer']) {
    const contractsLink = resolve(absoluteRoot, deployment, 'node_modules/@global/contracts');
    const contractsPackageRoot = await realpath(contractsLink);
    const rootEntries = [];
    const packageEntries = await opendir(contractsPackageRoot);
    for await (const entry of packageEntries) rootEntries.push(entry.name);
    const unexpected = rootEntries.filter((entry) => !['dist', 'package.json'].includes(entry)).sort();
    if (unexpected.length > 0) {
      throw new Error(`deployed @global/contracts contains non-runtime files: ${unexpected.join(',')}`);
    }
    const deployedContracts = await componentInventory(resolve(contractsPackageRoot, 'dist'));
    if (deployedContracts.digest !== contractsDigest) {
      throw new Error(`deployed @global/contracts digest mismatch: ${deployment}`);
    }
  }
  const rendererDigest = requireDigest(components.get('renderer')?.digest, 'renderer digest');
  if (rendererDigest !== requireDigest(attestation?.renderer_digest, 'attested renderer digest')) {
    throw new Error('attested renderer digest mismatch');
  }

  if (sbom?.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components)) {
    throw new Error('runtime SBOM format is invalid');
  }
  const covered = new Set(
    sbom.components
      .filter((component) => typeof component?.name === 'string' && typeof component?.version === 'string')
      .map((component) => `${component.name}@${component.version}`),
  );
  const installed = await installedProductionPackages(absoluteRoot);
  const missing = [...installed].filter((identity) => !covered.has(identity)).sort();
  if (missing.length > 0) {
    throw new Error(`runtime SBOM omits installed packages: ${missing.slice(0, 10).join(',')}`);
  }
  const coveredPurls = new Set(
    sbom.components
      .map((component) => component?.purl)
      .filter((purl) => typeof purl === 'string'),
  );
  const installedOperatingSystem = await installedOperatingSystemPackagePurls(
    absoluteRoot,
  );
  const missingOperatingSystem = [...installedOperatingSystem]
    .filter((purl) => !coveredPurls.has(purl))
    .sort();
  if (missingOperatingSystem.length > 0) {
    throw new Error(
      `runtime SBOM omits installed OS packages: ${missingOperatingSystem.slice(0, 10).join(',')}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2];
  if (!root) throw new Error('usage: verify-runtime-image.mjs <runtime-image-root>');
  await assertRuntimeImageValid(root);
  process.stdout.write(`${JSON.stringify({ status: 'RUNTIME_IMAGE_VERIFIED' })}\n`);
}
