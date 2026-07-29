import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCurrentRouteRecoveryReport,
  writeCurrentRouteRecoveryReportCreateOnly,
} from '../src/site-builder/current-route-recovery';

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const HELP = `Usage:
  pnpm --filter @global/api prepare:site-builder:current-route-recovery -- \\
    --snapshot=<repository-relative-safe-snapshot-json> \\
    --output=<new-repository-relative-report-json>

This create-only preparation command never reads .env, mutates new-api, or
imports a model client. It derives the current route matrix from the registry,
admits only a redacted safe snapshot, and leaves dispatch NOT_AUTHORIZED.
`;

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const values = process.argv
    .slice(2)
    .filter((value) => value.startsWith(prefix));
  if (values.length !== 1) return null;
  return values[0]!.slice(prefix.length);
}

function repositoryJsonPath(
  value: string,
  role: 'snapshot' | 'output',
): string {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').includes('..') ||
    !value.endsWith('.json') ||
    /(^|\/)\.env(?:\.|$)/i.test(value)
  ) {
    throw new Error(`${role} must be a repository-relative non-.env JSON path`);
  }
  return value;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }
  const snapshotArgument = option('snapshot');
  const outputArgument = option('output');
  if (!snapshotArgument || !outputArgument) throw new Error(HELP);
  const snapshot = repositoryJsonPath(snapshotArgument, 'snapshot');
  const output = repositoryJsonPath(outputArgument, 'output');
  const raw = JSON.parse(
    await readFile(resolve(REPOSITORY_ROOT, snapshot), 'utf8'),
  ) as unknown;
  const report = buildCurrentRouteRecoveryReport(raw);
  await writeCurrentRouteRecoveryReportCreateOnly(
    REPOSITORY_ROOT,
    output,
    report,
  );
  process.stdout.write(
    `created ${output}; ${report.status}; dispatch remains NOT_AUTHORIZED\n`,
  );
}

await main();
