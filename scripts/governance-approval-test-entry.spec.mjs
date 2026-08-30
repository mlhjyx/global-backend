import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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

const approvalReferences = (command) => TEST_FILES.some((path) => command.includes(path))
  || command.includes(SCRIPT_NAME)
  || /node\s+--test\s+[^\n]*(?:governance-approval|governance-github-readback)/u.test(command);

const assertExactRootEntry = (scripts) => {
  assert.equal(scripts[SCRIPT_NAME], EXPECTED_COMMAND);
  const competing = Object.entries(scripts)
    .filter(([name, command]) => name !== SCRIPT_NAME && approvalReferences(String(command)));
  assert.deepEqual(competing, []);
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
