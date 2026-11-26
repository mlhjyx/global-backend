/**
 * MT-P2 存量 PII 密钥升级与轮换回填 CLI（幂等可重跑；严格遵循 M4 最小权限边界）：
 *   - 租户表（canonical_contact / contact_point / field_evidence）：经 APP_DATABASE_URL（app_user）
 *     在逐租户 RLS 事务内重加密为 `enc:v2:<activeKeyId>:` 与 `bi:v2:<activeKeyId>:`；
 *   - 平台表（patent_inventor_cache / source_channel_record）与租户枚举（list_platform_workspace_ids_v1）：
 *     经 EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL（execution_budget_platform_writer）执行。
 *
 * 用法：
 *   cd /global/backend/apps/api && node --import tsx scripts/backfill-pii-encryption.mts [--dry-run] [--workspace <uuid>]
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { assertPiiKeyConfigured, getActivePiiKeyId } from '../src/compliance/pii-crypto';
import {
  listPlatformWorkspaceIds,
  reencryptPlatformPiiBatch,
  reencryptWorkspacePiiBatch,
  type ReencryptionRunSummary,
} from '../src/compliance/pii-reencryption';
import { createExecutionBudgetPlatformWriterClient } from '../src/execution-budget/execution-budget-platform-writer.database';

export interface BackfillCliOptions {
  dryRun: boolean;
  workspaceId: string | null;
  skipPlatform: boolean;
}

export function parseBackfillArgs(argv: string[]): BackfillCliOptions {
  const dryRun = argv.includes('--dry-run');
  const skipPlatform = argv.includes('--skip-platform');
  const wsIdx = argv.indexOf('--workspace');
  const workspaceId = wsIdx >= 0 ? (argv[wsIdx + 1]?.trim() ?? null) : null;
  if (wsIdx >= 0 && (!workspaceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(workspaceId))) {
    throw new Error('--workspace 必须是合法 UUID');
  }
  return { dryRun, workspaceId, skipPlatform };
}

export async function runBackfill(
  options: BackfillCliOptions = { dryRun: false, workspaceId: null, skipPlatform: false },
): Promise<ReencryptionRunSummary> {
  assertPiiKeyConfigured();
  const appUrl = process.env.APP_DATABASE_URL?.trim();
  if (!appUrl) {
    throw new Error('APP_DATABASE_URL 未配置 — 租户表回填必须经 app_user + RLS 执行');
  }
  const platformWriter = createExecutionBudgetPlatformWriterClient(process.env);
  if (!platformWriter) {
    throw new Error(
      'EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL 未配置 — 租户枚举与平台表回填必须经受限 platform_writer 执行',
    );
  }

  const appDb = new PrismaClient({ datasourceUrl: appUrl });
  const activeKeyId = getActivePiiKeyId();
  try {
    const workspaceIds = options.workspaceId
      ? [options.workspaceId.toLowerCase()]
      : await listPlatformWorkspaceIds(platformWriter);

    const workspaceCounts = [];
    for (const workspaceId of workspaceIds) {
      workspaceCounts.push(
        await reencryptWorkspacePiiBatch(appDb, workspaceId, {
          dryRun: options.dryRun,
          activeKeyId,
        }),
      );
    }

    const platformCounts =
      options.skipPlatform || options.workspaceId
        ? {
            patentCacheNames: 0,
            patentCacheKeys: 0,
            patentCacheDedup: 0,
            channelRecords: 0,
          }
        : await reencryptPlatformPiiBatch(platformWriter, {
            dryRun: options.dryRun,
            activeKeyId,
          });

    return {
      dryRun: options.dryRun,
      activeKeyId,
      workspacesScanned: workspaceIds.length,
      workspaceCounts,
      platformCounts,
    };
  } finally {
    await Promise.all([appDb.$disconnect(), platformWriter.$disconnect()]);
  }
}

async function main(): Promise<void> {
  const options = parseBackfillArgs(process.argv.slice(2));
  const summary = await runBackfill(options);
  console.log(JSON.stringify({ event: 'pii_reencryption_complete', ...summary }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
