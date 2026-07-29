import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SITE_BUILDER_CURRENT_ROUTE_RECOVERY_ROUTE_BASELINE_COMMIT,
  buildCurrentRouteRecoveryReport,
  readCurrentRouteRecoveryRepositoryJson,
  writeCurrentRouteRecoveryReportCreateOnly,
} from '../src/site-builder/current-route-recovery';

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const HELP = `Usage:
  pnpm --filter @global/api prepare:site-builder:current-route-recovery -- \\
    --snapshot=<repository-relative-safe-snapshot-json> \\
    --catalog-source=<repository-relative-openox-source-bundle-json> \\
    --fixed-commit=<40-char-route-baseline-sha> \\
    --source-commit=<40-char-runner-and-catalog-sha> \\
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
  role: 'snapshot' | 'catalog-source' | 'output',
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

function assertFixedRouteBaseline(fixedCommit: string): void {
  if (
    fixedCommit !==
    SITE_BUILDER_CURRENT_ROUTE_RECOVERY_ROUTE_BASELINE_COMMIT
  ) {
    throw new Error('fixed commit does not match the frozen route baseline');
  }
  execFileSync('git', ['cat-file', '-e', `${fixedCommit}^{commit}`], {
    cwd: REPOSITORY_ROOT,
    stdio: 'ignore',
  });
  execFileSync('git', ['merge-base', '--is-ancestor', fixedCommit, 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    stdio: 'ignore',
  });
  execFileSync(
    'git',
    [
      'diff',
      '--quiet',
      fixedCommit,
      '--',
      'apps/api/src/site-builder/agents',
      'apps/api/src/model-gateway/model-transports.ts',
    ],
    { cwd: REPOSITORY_ROOT, stdio: 'ignore' },
  );
}

function assertFixedSourceBundleCommit(
  sourceCommit: string,
  catalogSource: string,
  catalogSha256: string,
): void {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error('source commit must be a 40-character commit SHA');
  }
  execFileSync('git', ['cat-file', '-e', `${sourceCommit}^{commit}`], {
    cwd: REPOSITORY_ROOT,
    stdio: 'ignore',
  });
  execFileSync('git', ['merge-base', '--is-ancestor', sourceCommit, 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    stdio: 'ignore',
  });
  const committedCatalog = execFileSync(
    'git',
    ['show', `${sourceCommit}:${catalogSource}`],
    { cwd: REPOSITORY_ROOT, encoding: null },
  );
  if (
    createHash('sha256').update(committedCatalog).digest('hex') !==
    catalogSha256
  ) {
    throw new Error('catalog source does not match its fixed source commit');
  }
  execFileSync(
    'git',
    [
      'diff',
      '--quiet',
      sourceCommit,
      '--',
      'apps/api/src/site-builder/current-route-recovery.ts',
      'apps/api/src/site-builder/site-builder-model-settlement.ts',
      'apps/api/scripts/prepare-site-builder-current-route-recovery.mts',
      catalogSource,
    ],
    { cwd: REPOSITORY_ROOT, stdio: 'ignore' },
  );
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }
  const snapshotArgument = option('snapshot');
  const catalogSourceArgument = option('catalog-source');
  const fixedCommit = option('fixed-commit');
  const sourceCommit = option('source-commit');
  const outputArgument = option('output');
  if (
    !snapshotArgument ||
    !catalogSourceArgument ||
    !fixedCommit ||
    !sourceCommit ||
    !outputArgument
  ) {
    throw new Error(HELP);
  }
  const snapshot = repositoryJsonPath(snapshotArgument, 'snapshot');
  const catalogSource = repositoryJsonPath(
    catalogSourceArgument,
    'catalog-source',
  );
  const output = repositoryJsonPath(outputArgument, 'output');
  assertFixedRouteBaseline(fixedCommit);
  const snapshotSource = await readCurrentRouteRecoveryRepositoryJson(
    REPOSITORY_ROOT,
    snapshot,
  );
  const catalog = await readCurrentRouteRecoveryRepositoryJson(
    REPOSITORY_ROOT,
    catalogSource,
  );
  const declaredCatalogPath = (
    snapshotSource.parsed as {
      pricing?: {
        sourceBundlePath?: unknown;
        sourceBundleCommitSha?: unknown;
      };
    }
  ).pricing?.sourceBundlePath;
  if (declaredCatalogPath !== catalogSource) {
    throw new Error('catalog source path does not match the safe snapshot');
  }
  const declaredSourceCommit = (
    snapshotSource.parsed as {
      pricing?: { sourceBundleCommitSha?: unknown };
    }
  ).pricing?.sourceBundleCommitSha;
  if (declaredSourceCommit !== sourceCommit) {
    throw new Error('source commit does not match the safe snapshot');
  }
  assertFixedSourceBundleCommit(sourceCommit, catalogSource, catalog.sha256);
  const report = buildCurrentRouteRecoveryReport(
    snapshotSource.parsed,
    catalog.parsed,
    catalog.sha256,
  );
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
