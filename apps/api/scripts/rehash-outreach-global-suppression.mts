/**
 * MT-P2：outreach_global_suppression 带 pepper HMAC 重算/迁移运维脚本。
 *
 * 历史行存储的是无盐 sha256(canonicalEmail)，无法仅从旧哈希离线重算 HMAC；
 * 本脚本支持两种幂等迁移源（按 `OUTREACH_DNC_HMAC_PEPPER` 写入 `outreach-dnc:v1:` HMAC）：
 *   1. 从给定换行分隔邮箱文件（`--emails-file <path>`）匹配并迁移既有无盐（或退役 pepper）行；
 *   2. 对已知的 `source`/`reason` 重新写入 peppered 条目，或删除已被迁移替代的旧哈希行（需 `--prune-legacy` 且非 dry-run）。
 *
 * 安全约束：必须经 `EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL`（或拥有者迁移连接）运行，明确拒绝 `app_user`。
 */
import 'dotenv/config';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { parseOutreachDncPeppers } from '../src/compliance/pii-crypto';
import { canonicalizeSuppressionValue } from '../src/discovery/suppression-value';
import { assertExecutionBudgetPlatformWriterPrincipal } from '../src/execution-budget/execution-budget-platform-writer.database';

export interface RehashCliOptions {
  dryRun: boolean;
  pruneLegacy: boolean;
  emailsFile: string | null;
}

export interface RehashSummary {
  dryRun: boolean;
  candidatesChecked: number;
  migrated: number;
  alreadyCurrent: number;
  prunedLegacy: number;
}

export function parseRehashArgs(argv: string[]): RehashCliOptions {
  const dryRun = argv.includes('--dry-run');
  const pruneLegacy = argv.includes('--prune-legacy');
  const fileIdx = argv.indexOf('--emails-file');
  const emailsFile = fileIdx >= 0 ? (argv[fileIdx + 1]?.trim() ?? null) : null;
  if (fileIdx >= 0 && !emailsFile) {
    throw new Error('--emails-file 需要指定文件路径');
  }
  return { dryRun, pruneLegacy, emailsFile };
}

function hmacDnc(pepper: Buffer, canonicalEmail: string): string {
  return createHmac('sha256', pepper)
    .update('outreach-dnc:v1:')
    .update(canonicalEmail, 'utf8')
    .digest('hex');
}

function unsaltedSha256(canonicalEmail: string): string {
  return createHash('sha256').update(canonicalEmail).digest('hex');
}

export async function rehashOutreachGlobalSuppression(
  writer: PrismaClient,
  emails: readonly string[],
  options: { dryRun?: boolean; pruneLegacy?: boolean; pruneWriter?: PrismaClient } = {},
): Promise<RehashSummary> {
  const { activePepper, retiredPeppers } = parseOutreachDncPeppers(
    process.env.OUTREACH_DNC_HMAC_PEPPER,
    process.env.OUTREACH_DNC_HMAC_RETIRED_PEPPERS,
  );
  const dryRun = options.dryRun ?? false;
  const pruneLegacy = options.pruneLegacy ?? false;
  const deleter = options.pruneWriter ?? writer;

  const canonical = [
    ...new Set(
      emails
        .map((raw) => canonicalizeSuppressionValue('email', raw))
        .filter((val): val is string => val !== null),
    ),
  ];

  let migrated = 0;
  let alreadyCurrent = 0;
  let prunedLegacy = 0;

  for (const email of canonical) {
    const activeHash = hmacDnc(activePepper, email);
    const legacyHashes = [
      unsaltedSha256(email),
      ...retiredPeppers.map((pepper) => hmacDnc(pepper, email)),
    ].filter((h) => h !== activeHash);

    const existingActive = await writer.outreachGlobalSuppression.findUnique({
      where: { emailHash: activeHash },
      select: { id: true },
    });
    if (existingActive) {
      alreadyCurrent += 1;
      if (pruneLegacy && !dryRun && legacyHashes.length > 0) {
        const del = await deleter.outreachGlobalSuppression.deleteMany({
          where: { emailHash: { in: legacyHashes } },
        });
        prunedLegacy += del.count;
      }
      continue;
    }

    const legacyHit = legacyHashes.length
      ? await writer.outreachGlobalSuppression.findFirst({
          where: { emailHash: { in: legacyHashes } },
          select: { id: true, reason: true, source: true, emailHash: true },
        })
      : null;

    if (!legacyHit) continue;
    if (!dryRun) {
      await writer.outreachGlobalSuppression.createMany({
        data: [
          {
            emailHash: activeHash,
            reason: legacyHit.reason,
            source: legacyHit.source,
          },
        ],
        skipDuplicates: true,
      });
      if (pruneLegacy) {
        const del = await deleter.outreachGlobalSuppression.deleteMany({
          where: { emailHash: { in: legacyHashes } },
        });
        prunedLegacy += del.count;
      }
    }
    migrated += 1;
  }

  return {
    dryRun,
    candidatesChecked: canonical.length,
    migrated,
    alreadyCurrent,
    prunedLegacy,
  };
}

async function main(): Promise<void> {
  const options = parseRehashArgs(process.argv.slice(2));
  const writerUrl = process.env.EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL?.trim();
  if (!writerUrl) {
    throw new Error(
      'EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL 未配置（拒绝使用 app_user 或超级用户直连）',
    );
  }
  const ownerUrl = process.env.DATABASE_URL?.trim();
  if (options.pruneLegacy && !options.dryRun && !ownerUrl) {
    throw new Error(
      '--prune-legacy 需额外提供迁移期拥有者连接 DATABASE_URL（outreach_global_suppression 对 platform_writer 保持 append-only 禁删）',
    );
  }
  const writer = new PrismaClient({ datasourceUrl: writerUrl });
  const pruneWriter =
    options.pruneLegacy && !options.dryRun && ownerUrl
      ? new PrismaClient({ datasourceUrl: ownerUrl })
      : undefined;
  try {
    await assertExecutionBudgetPlatformWriterPrincipal(
      writer,
      'rehash-outreach-global-suppression',
    );
    const emails = options.emailsFile
      ? readFileSync(options.emailsFile, 'utf8').split(/\r?\n/u)
      : [];
    const summary = await rehashOutreachGlobalSuppression(writer, emails, {
      dryRun: options.dryRun,
      pruneLegacy: options.pruneLegacy,
      pruneWriter,
    });
    console.log(JSON.stringify({ event: 'outreach_dnc_rehash_complete', ...summary }));
  } finally {
    await Promise.all([writer.$disconnect(), pruneWriter?.$disconnect()]);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
