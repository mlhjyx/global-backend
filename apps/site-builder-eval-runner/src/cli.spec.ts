import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, type CliDependencies } from './cli';

function fakeDependencies(
  overrides: Partial<CliDependencies> = {},
): CliDependencies & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeStdout: (message) => {
      stdout.push(message);
    },
    writeStderr: (message) => {
      stderr.push(message);
    },
    spawn: () => ({ status: 0 }),
    ...overrides,
  };
}

test('lists the immutable allowlist without dispatching an evaluation', () => {
  let dispatched = false;
  const dependencies = fakeDependencies({
    spawn: () => {
      dispatched = true;
      return { status: 0 };
    },
  });

  assert.equal(main(['list'], dependencies), 0);
  assert.equal(dispatched, false);
  assert.match(dependencies.stdout.join(''), /"aesthetic-review"/);
});

test('rejects missing and unknown commands without dispatch', () => {
  let dispatchCount = 0;
  const dependencies = fakeDependencies({
    spawn: () => {
      dispatchCount += 1;
      return { status: 0 };
    },
  });

  assert.equal(main([], dependencies), 2);
  assert.equal(main(['run', 'unknown-command'], dependencies), 2);
  assert.equal(dispatchCount, 0);
  assert.match(dependencies.stderr.join(''), /Usage:/);
  assert.match(
    dependencies.stderr.join(''),
    /UNKNOWN_SITE_BUILDER_EVALUATION_COMMAND/,
  );
});

test('dispatches only the exact legacy entrypoint and preserves arguments', () => {
  const calls: Array<{
    executable: string;
    arguments: readonly string[];
    options: { cwd: string; shell: false; stdio: 'inherit' };
  }> = [];
  const dependencies = fakeDependencies({
    spawn: (executable, args, options) => {
      calls.push({ executable, arguments: args, options });
      return { status: 7 };
    },
  });

  assert.equal(
    main(['run', 'verify-m1', '--', '--help', '--offline'], dependencies),
    7,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.executable, process.execPath);
  assert.deepEqual(calls[0]?.arguments.slice(0, 2), ['--import', 'tsx']);
  assert.match(
    calls[0]?.arguments[2] ?? '',
    /apps\/api\/scripts\/verify-site-builder-m1\.mts$/,
  );
  assert.deepEqual(calls[0]?.arguments.slice(3), ['--help', '--offline']);
  assert.equal(calls[0]?.options.shell, false);
});

test('fails closed when the evaluation process cannot be started', () => {
  const dependencies = fakeDependencies({
    spawn: () => ({ status: null, error: new Error('spawn unavailable') }),
  });

  assert.equal(main(['run', 'verify-m1'], dependencies), 1);
  assert.match(dependencies.stderr.join(''), /spawn unavailable/);
});
