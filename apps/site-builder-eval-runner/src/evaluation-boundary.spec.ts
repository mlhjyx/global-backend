import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolve } from 'node:path';
import {
  EVALUATION_COMPATIBILITY_SOURCE_ROOT,
  evaluationCommands,
  findProductEvaluationImports,
  repositoryRoot,
  resolveEvaluationCommand,
} from './catalog';

test('product runtime source has no dependency on evaluation compatibility source', () => {
  assert.deepEqual(findProductEvaluationImports(repositoryRoot()), []);
});

test('the API product build excludes the historical evaluation source tree', () => {
  const config = JSON.parse(
    readFileSync(resolve(repositoryRoot(), 'apps/api/tsconfig.build.json'), 'utf8'),
  ) as { exclude?: string[] };

  assert.ok(
    config.exclude?.some((entry) =>
      ['src/site-builder/eval', 'src/site-builder/eval/**'].includes(entry),
    ),
    'apps/api/tsconfig.build.json must exclude src/site-builder/eval',
  );
  assert.ok(
    config.exclude?.includes('src/site-builder/design/m1eb-golden.ts'),
    'apps/api/tsconfig.build.json must exclude the golden fixture generator',
  );
});

test('fixed-source legacy entrypoints remain at their evidence-bound paths', () => {
  const fixedSourceCommands = evaluationCommands.filter(
    (command) => command.provenance === 'historical_fixed_source',
  );

  assert.deepEqual(
    fixedSourceCommands.map((command) => command.legacyEntrypoint),
    [
      'apps/api/scripts/evaluate-site-builder-aesthetic-review.mts',
      'apps/api/scripts/evaluate-site-builder-brand-profile.mts',
      'apps/api/scripts/prepare-site-builder-copy-quality-matrix-manifest.mts',
    ],
  );
  for (const command of fixedSourceCommands) {
    assert.equal(
      readFileSync(resolve(repositoryRoot(), command.legacyEntrypoint)).length > 0,
      true,
    );
  }
  assert.equal(
    EVALUATION_COMPATIBILITY_SOURCE_ROOT,
    'apps/api/src/site-builder/eval',
  );
});

test('the successor command catalog is exact and rejects unknown execution', () => {
  assert.equal(evaluationCommands.length, 12);
  assert.equal(new Set(evaluationCommands.map((command) => command.name)).size, 12);
  for (const command of evaluationCommands) {
    assert.equal(resolveEvaluationCommand(command.name), command);
    assert.equal(Object.isFrozen(command), true);
  }
  assert.equal(Object.isFrozen(evaluationCommands), true);
  assert.equal(
    resolveEvaluationCommand('verify-m1').legacyEntrypoint,
    'apps/api/scripts/verify-site-builder-m1.mts',
  );
  assert.throws(
    () => resolveEvaluationCommand('unknown-command'),
    /UNKNOWN_SITE_BUILDER_EVALUATION_COMMAND/,
  );
});
