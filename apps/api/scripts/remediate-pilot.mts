import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;

interface RemediatePilotTarget {
  readonly apply: boolean;
  readonly workspaceId: string;
  readonly companyProfileId: string;
}

export interface RemediatePilotOptions extends RemediatePilotTarget {
  readonly expectedDirtyEmailSha256: string;
}

export type WorkspaceRemediationTx = {
  companyProfile: Pick<Prisma.TransactionClient['companyProfile'], 'findUnique' | 'updateMany'>;
};

export interface RemediatePilotSummary {
  readonly mode: 'dry-run' | 'apply';
  readonly companyProfileFound: boolean;
  readonly companyProfileHadDirtyEmail: boolean;
  readonly companyProfileEmailCleared: boolean;
}

function assertTarget(workspaceId?: string, companyProfileId?: string): void {
  if (!workspaceId || !companyProfileId || !UUID.test(workspaceId) || !UUID.test(companyProfileId)) {
    throw new Error('PILOT_REMEDIATION_EXPLICIT_TARGET_REQUIRED');
  }
}

function assertExpectedDigest(value: string | undefined): asserts value is string {
  if (!value || !SHA256.test(value)) {
    throw new Error('PILOT_REMEDIATION_EXPECTED_EMAIL_SHA256_REQUIRED');
  }
}

export function parseRemediatePilotArgs(argv: readonly string[]): RemediatePilotTarget {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    tokens: true,
    options: {
      'workspace-id': { type: 'string' },
      'company-profile-id': { type: 'string' },
      apply: { type: 'boolean' },
    },
  });
  const optionNames = parsed.tokens.flatMap((token) => token.kind === 'option' ? [token.name] : []);
  if (optionNames.length !== new Set(optionNames).size) {
    throw new Error('PILOT_REMEDIATION_DUPLICATE_OPTION');
  }
  const workspaceId = parsed.values['workspace-id'];
  const companyProfileId = parsed.values['company-profile-id'];
  assertTarget(workspaceId, companyProfileId);
  return {
    apply: parsed.values.apply ?? false,
    workspaceId: workspaceId!,
    companyProfileId: companyProfileId!,
  };
}

export async function runWorkspacePilotRemediation(
  tx: WorkspaceRemediationTx,
  opts: RemediatePilotOptions,
): Promise<RemediatePilotSummary> {
  assertTarget(opts.workspaceId, opts.companyProfileId);
  assertExpectedDigest(opts.expectedDirtyEmailSha256);
  const where = { id: opts.companyProfileId, workspaceId: opts.workspaceId, deletedAt: null };
  const company = await tx.companyProfile.findUnique({
    where,
    select: { businessEmail: true, version: true },
  });
  const stored = company?.businessEmail ?? null;
  const matches = stored !== null &&
    createHash('sha256').update(stored).digest('hex') === opts.expectedDirtyEmailSha256;
  const summary: RemediatePilotSummary = {
    mode: opts.apply ? 'apply' : 'dry-run',
    companyProfileFound: company !== null,
    companyProfileHadDirtyEmail: matches,
    companyProfileEmailCleared: false,
  };
  if (!opts.apply || !company || !matches) return summary;

  const updated = await tx.companyProfile.updateMany({
    where: { ...where, version: company.version, businessEmail: stored },
    data: { businessEmail: null, version: { increment: 1 } },
  });
  if (updated.count !== 1) throw new Error('PILOT_PROFILE_CHANGED_DURING_REMEDIATION');
  return { ...summary, companyProfileEmailCleared: true };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: node --import tsx scripts/remediate-pilot.mts --workspace-id <uuid> --company-profile-id <uuid> [--apply]');
    console.log('Set APP_DATABASE_URL for app_user and PILOT_REMEDIATION_EXPECTED_EMAIL_SHA256 for the exact stale mailbox. Dry-run is the default.');
    return;
  }
  const target = parseRemediatePilotArgs(argv);
  const expectedDirtyEmailSha256 = process.env.PILOT_REMEDIATION_EXPECTED_EMAIL_SHA256?.trim();
  assertExpectedDigest(expectedDirtyEmailSha256);
  if (!process.env.APP_DATABASE_URL?.trim()) throw new Error('PILOT_REMEDIATION_APP_DATABASE_URL_REQUIRED');
  const prisma = new PrismaService();
  try {
    const readiness = await prisma.reconnect();
    if (readiness.status !== 'ready') throw new Error('PILOT_REMEDIATION_APP_DATABASE_NOT_READY');
    const summary = await prisma.withWorkspace(target.workspaceId, (tx) =>
      runWorkspacePilotRemediation(tx, { ...target, expectedDirtyEmailSha256 }),
    );
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await prisma.onModuleDestroy();
  }
}

if (typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof Error && /^PILOT_[A-Z_0-9]+$/u.test(error.message)
      ? error.message
      : 'PILOT_REMEDIATION_FAILED';
    console.error('[remediate-pilot]', code);
    process.exitCode = 1;
  });
}
