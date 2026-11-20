import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSafeGitEnvironment } from '../../../scripts/safe-git-environment.mjs';
import { migrationIntroductionCommit } from './migration-integrity-gate.mjs';
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration = 'packages/db/prisma/migrations/20260101000000_fixture/migration.sql';
function git(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, env: createSafeGitEnvironment(), encoding: 'utf8', input });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function commit(root, message) {
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message]);
  return git(root, ['rev-parse', 'HEAD']);
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'g2-history-test-'));
  t.after(() => rmSync(root, { recursive: true }));
  git(root, ['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'README'), 'Synthetic owned Git fixture\n');
  commit(root, 'base');
  return root;
}
function writeMigration(root, text = 'SELECT 1;\n') {
  mkdirSync(dirname(join(root, migration)), { recursive: true });
  writeFileSync(join(root, migration), text);
}
function mergeCreated(t) {
  const root = fixture(t);
  git(root, ['checkout', '-qb', 'side']);
  writeFileSync(join(root, 'side'), 'side\n'); commit(root, 'side');
  git(root, ['checkout', '-q', 'main']);
  writeFileSync(join(root, 'main'), 'main\n'); commit(root, 'main');
  git(root, ['merge', '--no-ff', '--no-commit', 'side']);
  writeMigration(root); const first = commit(root, 'migration-first-created-in-merge');
  return { root, first };
}
test('ordinary add remains the origin after later modification', t => {
  const root = fixture(t); writeMigration(root); const first = commit(root, 'add');
  writeMigration(root, 'SELECT 2;\n'); commit(root, 'modified');
  assert.equal(migrationIntroductionCommit(migration, root), first);
  assert.equal(git(root, ['show', `${first}:${migration}`]), 'SELECT 1;');
  assert.equal(git(root, ['show', `HEAD:${migration}`]), 'SELECT 2;');
});
test('a migration genuinely created in a merge has its exact merge introduction', t => {
  const { root, first } = mergeCreated(t);
  assert.equal(migrationIntroductionCommit(migration, root), first);
});
test('later modification cannot replace a genuine merge introduction', t => {
  const { root, first } = mergeCreated(t); writeMigration(root, 'SELECT 2;\n'); commit(root, 'modified');
  assert.equal(migrationIntroductionCommit(migration, root), first);
  assert.equal(git(root, ['show', `${first}:${migration}`]), 'SELECT 1;');
});
test('importing a modified migration cannot wash its original add through a merge', t => {
  const root = fixture(t); git(root, ['checkout', '-qb', 'side']);
  writeMigration(root); const original = commit(root, 'real-add'); writeMigration(root, 'SELECT 2;\n'); commit(root, 'illegal-old-modification');
  git(root, ['checkout', '-q', 'main']); writeFileSync(join(root, 'main'), 'main\n'); commit(root, 'main'); git(root, ['merge', '--no-ff', '--no-edit', 'side']);
  assert.equal(migrationIntroductionCommit(migration, root), original);
  assert.equal(git(root, ['show', `${original}:${migration}`]), 'SELECT 1;');
  assert.equal(git(root, ['show', `HEAD:${migration}`]), 'SELECT 2;');
});
test('untracked paths do not invent an introduction', t => {
  const root = fixture(t); writeMigration(root);
  assert.equal(migrationIntroductionCommit(migration, root), '');
});
test('shallow history cannot claim an introduction at the artificial shallow root', t => {
  const root = fixture(t); writeMigration(root); commit(root, 'real-add'); writeFileSync(join(root, 'README'), 'later\n'); commit(root, 'later');
  const clone = join(root, 'shallow'); git(root, ['clone', '-q', '--depth=1', `file://${root}`, clone]);
  assert.equal(git(clone, ['rev-parse', '--is-shallow-repository']), 'true');
  assert.equal(migrationIntroductionCommit(migration, clone), '');
});
test('unreadable merge parent history stays unknown rather than qualifying merge-add', t => {
  const root = fixture(t); const parent = git(root, ['rev-parse', 'HEAD']); writeMigration(root); git(root, ['add', '.']); const tree = git(root, ['write-tree']);
  const raw = `tree ${tree}\nparent ${parent}\nparent ${'1'.repeat(40)}\nauthor Synthetic <fixture@example.invalid> 1700000000 +0000\ncommitter Synthetic <fixture@example.invalid> 1700000000 +0000\n\nMissing parent fixture\n`;
  const broken = git(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], raw); git(root, ['update-ref', 'refs/heads/main', broken]);
  assert.equal(migrationIntroductionCommit(migration, root), '');
});
test('real CLI remains active and refuses a non-disposable target before any connection', () => {
  const result = spawnSync(process.execPath, ['packages/db/scripts/migration-integrity-gate.mjs'], {
    cwd: repositoryRoot, env: { ...createSafeGitEnvironment(), APP_DATABASE_URL: '', PRISMA_CIGATE_FROM_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/global_dev' }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /refusing to deploy migrations to non-disposable database/);
});

test('a CLI symlink alias cannot silently turn the real gate into an import-only no-op', t => {
  const root = mkdtempSync(join(tmpdir(), 'g2-cli-alias-test-'));
  t.after(() => rmSync(root, { recursive: true }));
  const alias = join(root, 'gate-alias.mjs');
  symlinkSync(join(repositoryRoot, 'packages/db/scripts/migration-integrity-gate.mjs'), alias);
  const result = spawnSync(process.execPath, [alias], {
    cwd: repositoryRoot, env: { ...createSafeGitEnvironment(), APP_DATABASE_URL: '', PRISMA_CIGATE_FROM_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/global_dev' }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /refusing to deploy migrations to non-disposable database/);
});

function recreateAtMerge(root, label, text) {
  git(root, ['checkout', '-qb', `side-${label}`]); writeFileSync(join(root, `side-${label}`), 'side\n'); commit(root, `side-${label}`);
  git(root, ['checkout', '-q', 'main']); writeFileSync(join(root, `main-${label}`), 'main\n'); commit(root, `main-${label}`);
  git(root, ['merge', '--no-ff', '--no-commit', `side-${label}`]); writeMigration(root, text); return commit(root, `recreated-${label}`);
}
test('deletion and later merge recreation cannot replace the first provable merge blob', t => {
  const { root, first } = mergeCreated(t); git(root, ['rm', migration]); commit(root, 'deleted');
  const later = recreateAtMerge(root, 'later', 'SELECT 2;\n');
  assert.notEqual(later, first); assert.equal(git(root, ['log', '--diff-filter=A', '--format=%H', '-1', '--', migration]), '');
  assert.equal(migrationIntroductionCommit(migration, root), first);
  assert.equal(git(root, ['show', `${first}:${migration}`]), 'SELECT 1;');
  assert.equal(git(root, ['show', `HEAD:${migration}`]), 'SELECT 2;');
});
test('a path-simplified hidden ordinary add still anchors a later merge recreation', t => {
  const root = fixture(t); git(root, ['checkout', '-qb', 'hidden-origin']); writeMigration(root); const first = commit(root, 'hidden-real-add');
  git(root, ['checkout', '-q', 'main']); writeFileSync(join(root, 'main-old'), 'main\n'); commit(root, 'main-old');
  git(root, ['merge', '--no-ff', '--no-commit', 'hidden-origin']); git(root, ['rm', '--cached', migration]); rmSync(join(root, migration)); commit(root, 'resolved-without-migration');
  recreateAtMerge(root, 'new', 'SELECT 2;\n');
  assert.equal(git(root, ['log', '--diff-filter=A', '--format=%H', '-1', '--', migration]), '');
  assert.equal(migrationIntroductionCommit(migration, root), first);
  assert.equal(git(root, ['show', `${first}:${migration}`]), 'SELECT 1;');
});
test('independent merge-created origins are ambiguous rather than chosen by date or log order', t => {
  const { root, first } = mergeCreated(t); const common = git(root, ['merge-base', `${first}^1`, `${first}^2`]);
  git(root, ['checkout', '-qb', 'independent', common]); git(root, ['checkout', '-qb', 'independent-side']); writeFileSync(join(root, 'independent-side'), 'side\n'); commit(root, 'independent-side');
  git(root, ['checkout', '-q', 'independent']); writeFileSync(join(root, 'independent-main'), 'main\n'); commit(root, 'independent-main');
  git(root, ['merge', '--no-ff', '--no-commit', 'independent-side']); writeMigration(root, 'SELECT 2;\n'); const second = commit(root, 'second-independent-origin');
  assert.equal(git(root, ['merge-base', first, second]), common); git(root, ['checkout', '-q', 'main']);
  const merge = spawnSync('git', ['merge', '--no-ff', '--no-commit', 'independent'], {cwd:root,env:createSafeGitEnvironment(),encoding:'utf8'}); assert.equal(merge.status,1); writeMigration(root,'SELECT 2;\n'); commit(root,'resolve-two-origins');
  assert.equal(migrationIntroductionCommit(migration,root),'');
});
test('an origin on an unrelated non-HEAD ref cannot qualify an untracked path', t => {
  const root = fixture(t); const base = git(root,['rev-parse','HEAD']); git(root,['checkout','-qb','unrelated']); writeMigration(root); commit(root,'unrelated-add'); git(root,['checkout','-q','main']); assert.equal(git(root,['rev-parse','HEAD']),base); writeMigration(root);
  assert.equal(migrationIntroductionCommit(migration,root),'');
});

test('a previously tracked deleted migration cannot gain authority from an untracked working file', t => {
  const root=fixture(t);writeMigration(root);commit(root,'old-add');git(root,['rm',migration]);commit(root,'delete');writeMigration(root);
  assert.equal(migrationIntroductionCommit(migration,root),'');
});
test('an index-only recreation with prior history cannot gain a HEAD introduction', t => {
  const root=fixture(t);writeMigration(root);commit(root,'old-add');git(root,['rm',migration]);commit(root,'delete');writeMigration(root);git(root,['add',migration]);
  assert.equal(migrationIntroductionCommit(migration,root),'');
});
