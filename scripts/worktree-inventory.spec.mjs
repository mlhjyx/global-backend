import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectWorktreeInventory,
  parseWorktreePorcelain,
} from './worktree-inventory.mjs';

const MAIN_HEAD = '1111111111111111111111111111111111111111';
const FEATURE_HEAD = '2222222222222222222222222222222222222222';

test('parseWorktreePorcelain returns a stable, path-sorted inventory', () => {
  const porcelain = [
    'worktree /repo/z-feature',
    `HEAD ${FEATURE_HEAD}`,
    'detached',
    'locked held by another process',
    '',
    'worktree /repo/main',
    `HEAD ${MAIN_HEAD}`,
    'branch refs/heads/main',
    'prunable gitdir file points to a missing location',
    '',
  ].join('\0');

  assert.deepEqual(parseWorktreePorcelain(porcelain), [
    {
      path: '/repo/main',
      head: MAIN_HEAD,
      branch: 'refs/heads/main',
      detached: false,
      bare: false,
      locked: false,
      lockReason: null,
      prunable: true,
      pruneReason: 'gitdir file points to a missing location',
    },
    {
      path: '/repo/z-feature',
      head: FEATURE_HEAD,
      branch: null,
      detached: true,
      bare: false,
      locked: true,
      lockReason: 'held by another process',
      prunable: false,
      pruneReason: null,
    },
  ]);
});

test('collectWorktreeInventory invokes only the read-only porcelain listing', () => {
  const calls = [];
  const runGit = (args) => {
    calls.push(args);
    return [
      'worktree /repo/main',
      `HEAD ${MAIN_HEAD}`,
      'branch refs/heads/main',
      '',
    ].join('\0');
  };

  assert.deepEqual(collectWorktreeInventory(runGit), {
    schemaVersion: 'git-worktree-inventory/v1',
    worktrees: [
      {
        path: '/repo/main',
        head: MAIN_HEAD,
        branch: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        lockReason: null,
        prunable: false,
        pruneReason: null,
      },
    ],
  });
  assert.deepEqual(calls, [['worktree', 'list', '--porcelain', '-z']]);
});

test('parseWorktreePorcelain rejects malformed records', () => {
  assert.throws(
    () => parseWorktreePorcelain(`HEAD ${MAIN_HEAD}\0\0`),
    /record must start with worktree/,
  );
  assert.throws(
    () => parseWorktreePorcelain('worktree /repo/main\0branch refs/heads/main\0\0'),
    /missing HEAD/,
  );
});
