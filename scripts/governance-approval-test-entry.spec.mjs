import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildSyntheticApprovalStateKernelInput,
  buildSyntheticMergeReconciliationKernelInput,
} from './fixtures/approval-readback/merge-authorization/task4-round4-state-fixture.mjs';

const TEST_FILES = Object.freeze([
  'scripts/governance-approval-schemas.spec.mjs',
  'scripts/governance-approval-safe-json.spec.mjs',
  'scripts/governance-approval-readback.spec.mjs',
  'scripts/governance-approval-readback-fix.spec.mjs',
  'scripts/governance-approval-identity-review.spec.mjs',
  'scripts/governance-approval-state.spec.mjs',
  'scripts/governance-approval-state-review.spec.mjs',
  'scripts/governance-approval-state-round4.spec.mjs',
  'scripts/governance-approval-state-round5.spec.mjs',
  'scripts/governance-approval-status.spec.mjs',
  'scripts/governance-github-readback.spec.mjs',
  'scripts/governance-approval-attestation.spec.mjs',
  'scripts/governance-approval-test-entry.spec.mjs',
]);
const SCRIPT_NAME = 'approval-readback:test';
const EXPECTED_COMMAND = `node --test ${TEST_FILES.join(' ')}`;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOTS = Object.freeze(['scripts', 'apps', 'packages', '.github/workflows']);
const PRODUCT_SOURCE_ROOTS = new Set(['apps', 'packages']);
const SCAN_FILES = Object.freeze([
  'package.json',
  'runtime-entrypoint.mjs',
  'docs/governance/release-bundle.schema.json',
  'docs/templates/release-bundle.template.json',
]);
const SCANNED_EXTENSIONS = new Set([
  '.astro', '.cjs', '.cts', '.js', '.json', '.jsx', '.mjs', '.mts', '.ts', '.tsx', '.yaml', '.yml',
]);
const NON_MODULE_PRODUCT_EXTENSIONS = new Set([
  '.css', '.md', '.png', '.prisma', '.sql', '.svg', '.toml',
]);
const NON_MODULE_PRODUCT_FILE_NAMES = new Set(['.gitignore']);
const NON_MODULE_PRODUCT_FILE_SUFFIXES = Object.freeze(['.env.example']);
const SKIPPED_DIRECTORIES = new Set([
  '.code-intelligence', '.next', 'coverage', 'dist', 'node_modules',
]);
const FIXTURE_ROOT = 'scripts/fixtures/approval-readback/';
const SHIPPED_ASTRO_SOURCE = 'apps/site-renderer/src/pages/[...slug].astro';
const DECLARED_TEST_SUPPORT_ROOTS = Object.freeze([FIXTURE_ROOT]);
const KERNEL_POLICIES = Object.freeze({
  'governance-approval-state-kernel.mjs': Object.freeze({
    owner: 'scripts/governance-approval-state.mjs',
    declaredTestImporters: Object.freeze([
      'scripts/governance-approval-state.spec.mjs',
      'scripts/governance-approval-state-round4.spec.mjs',
      'scripts/governance-approval-state-round5.spec.mjs',
      'scripts/governance-approval-test-entry.spec.mjs',
    ]),
  }),
  'governance-approval-merge-reconciliation-kernel.mjs': Object.freeze({
    owner: 'scripts/governance-approval-merge-orchestration.mjs',
    declaredTestImporters: Object.freeze([
      'scripts/governance-approval-state-review.spec.mjs',
      'scripts/governance-approval-test-entry.spec.mjs',
    ]),
  }),
});

const approvalReferences = (command) => TEST_FILES.some((path) => command.includes(path))
  || command.includes(SCRIPT_NAME)
  || /node\s+--test\s+[^\n]*(?:governance-approval|governance-github-readback)/u.test(command);

const assertExactRootEntry = (scripts) => {
  assert.equal(scripts[SCRIPT_NAME], EXPECTED_COMMAND);
  const competing = Object.entries(scripts)
    .filter(([name, command]) => name !== SCRIPT_NAME && approvalReferences(String(command)));
  assert.deepEqual(competing, []);
};

const repositoryPath = (absolutePath, repositoryRoot) => relative(repositoryRoot, absolutePath)
  .split(sep)
  .join('/');

const scanDirectory = async (directory, files, repositoryRoot, productSourceRoot) => {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(absolutePath, files, repositoryRoot, productSourceRoot);
    } else if (entry.isFile()) {
      const extension = extname(entry.name).toLowerCase();
      if (productSourceRoot
        && !SCANNED_EXTENSIONS.has(extension)
        && !NON_MODULE_PRODUCT_EXTENSIONS.has(extension)
        && !NON_MODULE_PRODUCT_FILE_NAMES.has(entry.name)
        && !NON_MODULE_PRODUCT_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
        throw new Error('APPROVAL_IMPORT_CAPABLE_EXTENSION_UNSCANNED');
      }
      if (SCANNED_EXTENSIONS.has(extension)) {
        files.push(repositoryPath(absolutePath, repositoryRoot));
      }
    }
  }
};

const loadBoundarySources = async (repositoryRoot = REPOSITORY_ROOT) => {
  const files = [...SCAN_FILES];
  for (const root of SCAN_ROOTS) {
    await scanDirectory(
      resolve(repositoryRoot, root),
      files,
      repositoryRoot,
      PRODUCT_SOURCE_ROOTS.has(root),
    );
  }
  const uniqueFiles = [...new Set(files)].sort();
  return new Map(await Promise.all(uniqueFiles.map(async (path) => [
    path,
    await readFile(resolve(repositoryRoot, path), 'utf8'),
  ])));
};

const moduleSpecifiers = (source) => {
  const patterns = [
    /\bimport\s+(?:[^'";\n]+?\s+from\s+)?['"]([^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gu,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
};

const resolveSpecifier = (importer, specifier) => {
  const clean = specifier.split(/[?#]/u, 1)[0];
  if (clean.startsWith('.')) return posix.normalize(posix.join(posix.dirname(importer), clean));
  return clean.startsWith('scripts/') ? posix.normalize(clean) : null;
};

const moduleEdges = (sources) => [...sources].flatMap(([importer, source]) => (
  moduleSpecifiers(source)
    .map((specifier) => resolveSpecifier(importer, specifier))
    .filter((target) => target !== null)
    .map((target) => ({ importer, target }))
));

const fixtureReferences = (sources, edges) => {
  const references = edges.filter(({ target }) => target.startsWith(FIXTURE_ROOT));
  const explicitFixturePath = /(?:\.\.\/|\.\/)*scripts\/fixtures\/approval-readback\/[A-Za-z0-9_./-]*|(?:\.\.\/|\.\/)*fixtures\/approval-readback\/[A-Za-z0-9_./-]*/gu;
  for (const [importer, source] of sources) {
    for (const match of source.matchAll(explicitFixturePath)) {
      const target = resolveSpecifier(importer, match[0])
        ?? posix.normalize(match[0].replace(/^(?:\.\.\/|\.\/)+/u, ''));
      if (target.includes('fixtures/approval-readback/')) references.push({ importer, target });
    }
  }
  return references;
};

const isSpecImporter = (path) => /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(path);
const isDeclaredTestSupport = (path) => DECLARED_TEST_SUPPORT_ROOTS.some(
  (root) => path.startsWith(root),
);

const assertFixtureBoundary = (references) => {
  const forbidden = references
    .map(({ importer }) => importer)
    .filter((importer) => !isSpecImporter(importer) && !isDeclaredTestSupport(importer));
  assert.deepEqual([...new Set(forbidden)].sort(), [], 'APPROVAL_FIXTURE_IMPORT_FORBIDDEN');
};

const kernelImporters = (kernelName, edges) => {
  const importers = new Set(
  edges
    .filter(({ target }) => posix.basename(target) === kernelName)
    .map(({ importer }) => importer),
  );
  const policy = KERNEL_POLICIES[kernelName];
  const declaredOrder = policy === undefined
    ? []
    : [policy.owner, ...policy.declaredTestImporters];
  return [
    ...declaredOrder.filter((importer) => importers.delete(importer)),
    ...[...importers].sort(),
  ];
};

const kernelReferences = (kernelName, sources, edges) => {
  const importers = kernelImporters(kernelName, edges);
  for (const [importer, source] of sources) {
    if (source.includes(kernelName)) importers.push(importer);
  }
  return [...new Set(importers)];
};

const assertKernelBoundaries = (sources, edges) => {
  for (const [kernelName, policy] of Object.entries(KERNEL_POLICIES)) {
    const allowed = [policy.owner, ...policy.declaredTestImporters];
    const forbidden = kernelReferences(kernelName, sources, edges)
      .filter((importer) => !allowed.includes(importer));
    assert.deepEqual([...new Set(forbidden)].sort(), [], 'APPROVAL_KERNEL_IMPORT_FORBIDDEN');
    assert.deepEqual(kernelImporters(kernelName, edges), allowed);
  }
};

const assertApprovalImportBoundaries = (sources) => {
  const edges = moduleEdges(sources);
  assertFixtureBoundary(fixtureReferences(sources, edges));
  assertKernelBoundaries(sources, edges);
};

const relativeModuleSpecifier = (importer, target) => {
  const specifier = posix.relative(posix.dirname(importer), target);
  return specifier.startsWith('.') ? specifier : `./${specifier}`;
};

const withSyntheticProductRepository = async (extension, run) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'approval-import-boundary-'));
  try {
    for (const root of SCAN_ROOTS) {
      await mkdir(resolve(repositoryRoot, root), { recursive: true });
    }
    const seedFiles = new Map([
      ['package.json', '{}\n'],
      ['runtime-entrypoint.mjs', 'export {};\n'],
      ['docs/governance/release-bundle.schema.json', '{}\n'],
      ['docs/templates/release-bundle.template.json', '{}\n'],
      [`apps/product/Component${extension}`, "import './dependency.js';\n"],
    ]);
    for (const [path, source] of seedFiles) {
      const absolutePath = resolve(repositoryRoot, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, source, 'utf8');
    }
    await run(repositoryRoot);
  } finally {
    await rm(repositoryRoot, { recursive: true });
  }
};

test('package exposes one exact ordered closed approval test entry', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assertExactRootEntry(packageJson.scripts);
});

test('entry contract rejects omission, reorder, duplicate, glob, alias, and a second aggregate', () => {
  const base = { unrelated: 'node --test scripts/unrelated.spec.mjs', [SCRIPT_NAME]: EXPECTED_COMMAND };
  assert.doesNotThrow(() => assertExactRootEntry(base));

  const mutations = [
    { ...base, [SCRIPT_NAME]: `node --test ${TEST_FILES.slice(0, -1).join(' ')}` },
    { ...base, [SCRIPT_NAME]: `node --test ${[TEST_FILES[1], TEST_FILES[0], ...TEST_FILES.slice(2)].join(' ')}` },
    { ...base, [SCRIPT_NAME]: `node --test ${[...TEST_FILES, TEST_FILES[0]].join(' ')}` },
    { ...base, [SCRIPT_NAME]: 'node --test scripts/governance-approval-*.spec.mjs' },
    { ...base, [SCRIPT_NAME]: 'pnpm approval:test' },
    { ...base, 'approval:test': EXPECTED_COMMAND },
  ];
  for (const scripts of mutations) assert.throws(() => assertExactRootEntry(scripts));
});

test('canonical approval entry enforces executable fixture and pure-kernel import boundaries', async () => {
  const sources = await loadBoundarySources();
  assertApprovalImportBoundaries(sources);

  const fixtureMutation = new Map(sources);
  fixtureMutation.set(
    'apps/api/src/forbidden-fixture-import.mjs',
    "import '../../../scripts/fixtures/approval-readback/merge-authorization/task4-round4-state-fixture.mjs';",
  );
  assert.throws(
    () => assertApprovalImportBoundaries(fixtureMutation),
    /APPROVAL_FIXTURE_IMPORT_FORBIDDEN/u,
  );

  for (const kernelName of Object.keys(KERNEL_POLICIES)) {
    const kernelMutation = new Map(sources);
    kernelMutation.set(
      '.github/workflows/forbidden-kernel.yml',
      `run: \"node scripts/${kernelName}\"`,
    );
    assert.throws(
      () => assertApprovalImportBoundaries(kernelMutation),
      /APPROVAL_KERNEL_IMPORT_FORBIDDEN/u,
    );
  }
});

test('boundary loader includes the real OCI entrypoint and Astro product sources', async () => {
  const sources = await loadBoundarySources();
  assert.equal(sources.has('runtime-entrypoint.mjs'), true);
  assert.equal(sources.has(SHIPPED_ASTRO_SOURCE), true);
  const astroProductSources = [...sources.keys()].filter(
    (path) => path.startsWith('apps/') && path.endsWith('.astro'),
  );
  assert.notEqual(astroProductSources.length, 0);
});

test('real OCI and Astro product importers cannot reference approval fixtures or kernels', async () => {
  const sources = await loadBoundarySources();
  assert.equal(sources.has(SHIPPED_ASTRO_SOURCE), true);
  for (const importer of ['runtime-entrypoint.mjs', SHIPPED_ASTRO_SOURCE]) {
    const fixtureMutation = new Map(sources);
    const fixtureSpecifier = relativeModuleSpecifier(
      importer,
      'scripts/fixtures/approval-readback/merge-authorization/task4-round4-state-fixture.mjs',
    );
    fixtureMutation.set(importer, `${sources.get(importer)}\nimport '${fixtureSpecifier}';\n`);
    assert.throws(
      () => assertApprovalImportBoundaries(fixtureMutation),
      /APPROVAL_FIXTURE_IMPORT_FORBIDDEN/u,
    );

    const kernelMutation = new Map(sources);
    const kernelSpecifier = relativeModuleSpecifier(
      importer,
      'scripts/governance-approval-state-kernel.mjs',
    );
    kernelMutation.set(importer, `${sources.get(importer)}\nimport '${kernelSpecifier}';\n`);
    assert.throws(
      () => assertApprovalImportBoundaries(kernelMutation),
      /APPROVAL_KERNEL_IMPORT_FORBIDDEN/u,
    );
  }
});

test('boundary loader fails closed on unscanned import-capable product extensions', async () => {
  for (const extension of ['.vue', '.svelte', '.mdx']) {
    await withSyntheticProductRepository(extension, async (repositoryRoot) => {
      await assert.rejects(
        loadBoundarySources(repositoryRoot),
        /APPROVAL_IMPORT_CAPABLE_EXTENSION_UNSCANNED/u,
      );
    });
  }
});

test('boundary loader scans JSX product modules and parses their real import edges', async () => {
  await withSyntheticProductRepository('.jsx', async (repositoryRoot) => {
    const sources = await loadBoundarySources(repositoryRoot);
    assert.equal(sources.has('apps/product/Component.jsx'), true);
    assert.deepEqual(
      moduleEdges(sources).filter(({ importer }) => importer === 'apps/product/Component.jsx'),
      [{ importer: 'apps/product/Component.jsx', target: 'apps/product/dependency.js' }],
    );
  });
});

test('boundary loader fails closed on every unclassified product extension', async () => {
  await withSyntheticProductRepository('.futuremodule', async (repositoryRoot) => {
    await assert.rejects(
      loadBoundarySources(repositoryRoot),
      /APPROVAL_IMPORT_CAPABLE_EXTENSION_UNSCANNED/u,
    );
  });
});

test('pure kernel plans are non-admitted values with no side-effect ports', async () => {
  const [{ planApprovalStateTransition }, { planMergeAuthorizationReconciliation }] = await Promise.all([
    import('./governance-approval-state-kernel.mjs'),
    import('./governance-approval-merge-reconciliation-kernel.mjs'),
  ]);
  const statePlan = planApprovalStateTransition(buildSyntheticApprovalStateKernelInput());
  const reconciliationPlan = planMergeAuthorizationReconciliation(
    buildSyntheticMergeReconciliationKernelInput(),
  );
  assert.notEqual(statePlan.schemaVersion, 'approval-decision-state/v1');
  assert.equal(statePlan.schemaVersion, 'approval-state-transition-plan/v1');
  assert.equal(Object.hasOwn(statePlan, 'eventHistory'), false);
  assert.equal(Object.hasOwn(statePlan.nextProjection, 'eventHistory'), false);
  assert.equal(Object.hasOwn(statePlan.nextProjection, 'policySnapshot'), false);
  assert.equal(reconciliationPlan.schemaVersion, 'merge-authorization-reconciliation-plan/v1');
  assert.equal(Object.hasOwn(reconciliationPlan, 'ledger'), false);
});
