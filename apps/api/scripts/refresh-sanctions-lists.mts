/**
 * Operator refresh of the official sanctions lists (B0 in
 * docs/superpowers/plans/2026-10-10-platform-schedule-admission-and-writer-grants.md): OFAC SDN,
 * OFAC Consolidated and EU FSF, without platform schedules or budget receipts. Runbook, the
 * separate enable step and rollback: docs/backend/sanctions-operator-refresh.md.
 *
 *   cd <worktree>/apps/api
 *   node --import tsx scripts/refresh-sanctions-lists.mts --source=all --dry-run
 *   node --import tsx scripts/refresh-sanctions-lists.mts --source=all
 *
 * Connects with DATABASE_URL (the database owner; apps/api/.env via dotenv) and refuses app_user.
 * Downloads only the seeded official endpoints through the guarded HTTP adapter, persists through
 * SanctionsRefreshService's unreceipted owner transaction, and never changes sanctions_source.status.
 * Exit codes: 0 every source succeeded, 1 a source failed, 2 refused or invalid arguments.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { SanctionsOperatorRefreshError } from '../src/sanctions/sanctions-operator-download';
import {
  SANCTIONS_OPERATOR_USAGE,
  formatSanctionsOperatorReport,
  parseSanctionsOperatorArgs,
  runSanctionsOperatorRefresh,
  type SanctionsOperatorArgs,
} from '../src/sanctions/sanctions-operator-refresh';
import { UnavailableRateLimitStore } from '../src/tools/redis-rate-limit-store';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';

const PREFIX = '[sanctions-refresh]';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<number> {
  let args: SanctionsOperatorArgs;
  try {
    args = parseSanctionsOperatorArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${PREFIX} ${message(error)}`);
    console.error(SANCTIONS_OPERATOR_USAGE);
    return 2;
  }
  if (args.kind === 'help') {
    console.log(SANCTIONS_OPERATOR_USAGE);
    return 0;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(`${PREFIX} SANCTIONS_OPERATOR_OWNER_REQUIRED: DATABASE_URL (the database owner connection) is not set`);
    return 2;
  }

  const owner = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    // Only the ToolBroker's source_policy decision is used; nothing is invoked through it.
    const sourcePolicy = buildToolBroker({
      sourcePolicyReader: sourcePolicyReaderFrom(owner),
      limiter: new UnavailableRateLimitStore('the operator sanctions refresh never invokes a Tool'),
    });
    const report = await runSanctionsOperatorRefresh(
      { owner, sourcePolicy, log: (line) => console.log(`${PREFIX} ${line}`) },
      args.options,
    );
    for (const line of formatSanctionsOperatorReport(report)) console.log(line);
    console.log(JSON.stringify({ sanctionsOperatorRefresh: report }));
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(`${PREFIX} ${message(error)}`);
    return error instanceof SanctionsOperatorRefreshError ? 2 : 1;
  } finally {
    await owner.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`${PREFIX} ${message(error)}`);
    process.exit(1);
  },
);
