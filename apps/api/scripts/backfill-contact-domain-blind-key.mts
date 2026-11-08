/**
 * P1-01：存量 contact_point.domain_blind_key 回填（一次性数据迁移；在迁移
 * 20261109120000_contact_point_four_state 之后运行，幂等可重跑）。
 *
 * 背景：contact_point.value 是确定性 AES-GCM 密文（enc:v1:），按域聚合/去重不能明文查询。
 * 本脚本用 PII_ENCRYPTION_KEY 解密每条 email 值 → 取域 → HMAC 盲索引
 * （blindContactKey(`domain:<lower(domain>)`) = `bi:v1:<64hex>`）→ 批量回写。**绝不落明文域**，
 * 失败行保留 NULL 并计入报告（迁移 CHECK 允许 NULL）。
 *
 * 幂等：只扫 domain_blind_key IS NULL 的行；已回填行天然跳过。分批（默认 500/批），
 * 单行解密失败不中断全批。
 *
 * 运行（需 PII_ENCRYPTION_KEY 与 DATABASE_URL；owner 连接，绕过 RLS 是预期——
 * 回填跨租户，与 backfill-pii-encryption.mts 同一纪律）：
 *   cd /global/backend/apps/api && node --import tsx scripts/backfill-contact-domain-blind-key.mts
 *   cd /global/backend/apps/api && node --import tsx scripts/backfill-contact-domain-blind-key.mts --dry-run
 *
 * ⚠️ 未跑此回填：domain_blind_key 全 NULL，按域聚合的 pattern 学习/验重读到 0 条——不是
 * 数据没有，是索引没建（迁移只加列，不建值）。
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { blindContactKey, decryptPii } from '../src/compliance/pii-crypto';
import { emailDomainOfAddress } from '../src/discovery/contact-point-verification-state';

export interface BackfillOptions {
  dryRun: boolean;
  batchSize: number;
}

export interface BackfillCounts {
  scanned: number;
  updated: number;
  /** 解密/域解析失败：留 NULL 待人工核（行 id 只记日志，不落明文）。 */
  failed: number;
}

export function parseArgs(argv: string[]): BackfillOptions {
  const dryRun = argv.includes('--dry-run');
  const batchIndex = argv.indexOf('--batch-size');
  const batchSize = batchIndex >= 0 ? Number.parseInt(argv[batchIndex + 1] ?? '', 10) : 500;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new Error('--batch-size 必须是 1..5000 的整数');
  }
  return { dryRun, batchSize };
}

export async function runBackfill(
  prisma: PrismaClient,
  options: BackfillOptions,
): Promise<BackfillCounts> {
  const counts: BackfillCounts = { scanned: 0, updated: 0, failed: 0 };
  let cursor: string | null = null;
  for (;;) {
    const batch = await prisma.contactPoint.findMany({
      where: {
        type: 'email',
        domainBlindKey: null,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true, value: true },
      orderBy: { id: 'asc' },
      take: options.batchSize,
    });
    if (batch.length === 0) break;
    for (const row of batch) {
      counts.scanned += 1;
      let domain: string | null = null;
      try {
        const plaintext = decryptPii(row.value);
        domain = emailDomainOfAddress(plaintext);
      } catch {
        // 解密失败（密钥不匹配/密文损坏）：不把任何值写进日志。
        domain = null;
      }
      if (!domain) {
        counts.failed += 1;
        console.warn(`domain_blind_key: 跳过无法解析的行 ${row.id}`);
        continue;
      }
      if (!options.dryRun) {
        await prisma.contactPoint.update({
          where: { id: row.id },
          data: { domainBlindKey: blindContactKey(`domain:${domain}`) },
        });
      }
      counts.updated += 1;
    }
    cursor = batch[batch.length - 1].id;
    if (batch.length < options.batchSize) break;
  }
  return counts;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.PII_ENCRYPTION_KEY) {
    throw new Error('PII_ENCRYPTION_KEY 未配置——无法解密联系点值（fail-closed）');
  }
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    const counts = await runBackfill(prisma, options);
    console.log(
      `${options.dryRun ? '[dry-run] ' : ''}domain_blind_key 回填完成：` +
        `扫描 ${counts.scanned}，${options.dryRun ? '可回填' : '已回填'} ${counts.updated}，失败 ${counts.failed}`,
    );
    if (counts.failed > 0) {
      console.log('失败行保留 NULL（迁移 CHECK 允许），需人工核对密钥/密文后重跑本脚本。');
    }
  } finally {
    await prisma.$disconnect();
  }
}

// 直接执行才跑（被 import 时不自动触发全表回填）。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
