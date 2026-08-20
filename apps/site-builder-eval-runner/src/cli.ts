import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  type EvaluationCommand,
  evaluationCommands,
  repositoryRoot,
  resolveEvaluationCommand,
} from './catalog';

interface EvaluationProcessResult {
  readonly status: number | null;
  readonly error?: Error;
}

interface EvaluationProcessOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: 'inherit';
  readonly shell: false;
}

export interface CliDependencies {
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
  readonly spawn: (
    executable: string,
    arguments_: readonly string[],
    options: EvaluationProcessOptions,
  ) => EvaluationProcessResult;
}

const defaultDependencies: CliDependencies = Object.freeze({
  writeStdout: (message: string) => {
    process.stdout.write(message);
  },
  writeStderr: (message: string) => {
    process.stderr.write(message);
  },
  spawn: (
    executable: string,
    arguments_: readonly string[],
    options: EvaluationProcessOptions,
  ) => {
    const result = spawnSync(executable, arguments_, options);
    return Object.freeze({
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    });
  },
});

function usage(): string {
  return [
    'Usage:',
    '  site-builder-eval-runner list',
    '  site-builder-eval-runner run <command> [-- <legacy arguments...>]',
  ].join('\n');
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = defaultDependencies,
): number {
  if (argv[0] === 'list') {
    dependencies.writeStdout(`${JSON.stringify(evaluationCommands, null, 2)}\n`);
    return 0;
  }
  if (argv[0] !== 'run' || !argv[1]) {
    dependencies.writeStderr(`${usage()}\n`);
    return 2;
  }

  let command: EvaluationCommand;
  try {
    command = resolveEvaluationCommand(argv[1]);
  } catch (error) {
    dependencies.writeStderr(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  const separator = argv.indexOf('--');
  const legacyArguments =
    separator === -1 ? argv.slice(2) : argv.slice(separator + 1);
  const result = dependencies.spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve(repositoryRoot(), command.legacyEntrypoint),
      ...legacyArguments,
    ],
    {
      cwd: repositoryRoot(),
      env: process.env,
      stdio: 'inherit',
      shell: false,
    },
  );
  if (result.error) {
    dependencies.writeStderr(`${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

if (require.main === module) {
  process.exitCode = main();
}
