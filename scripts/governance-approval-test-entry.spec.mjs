import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, posix, relative, resolve, sep } from 'node:path';
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
const SCAN_FILES = Object.freeze([
  'package.json',
  'docs/governance/release-bundle.schema.json',
  'docs/templates/release-bundle.template.json',
]);
const SCANNED_EXTENSIONS = new Set([
  '.cjs', '.cts', '.js', '.json', '.mjs', '.mts', '.ts', '.tsx', '.yaml', '.yml',
]);
const SKIPPED_DIRECTORIES = new Set([
  '.code-intelligence', '.next', 'coverage', 'dist', 'node_modules',
]);
const FIXTURE_ROOT = 'scripts/fixtures/approval-readback/';
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

const repositoryPath = (absolutePath) => relative(REPOSITORY_ROOT, absolutePath)
  .split(sep)
  .join('/');

const scanDirectory = async (directory, files) => {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(absolutePath, files);
    } else if (entry.isFile() && SCANNED_EXTENSIONS.has(extname(entry.name))) {
      files.push(repositoryPath(absolutePath));
    }
  }
};

const loadBoundarySources = async () => {
  const files = [...SCAN_FILES];
  for (const root of SCAN_ROOTS) await scanDirectory(resolve(REPOSITORY_ROOT, root), files);
  const uniqueFiles = [...new Set(files)].sort();
  return new Map(await Promise.all(uniqueFiles.map(async (path) => [
    path,
    await readFile(resolve(REPOSITORY_ROOT, path), 'utf8'),
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
