/**
 * P1-01 / MT-P2：存量 contact_point.domain_blind_key 回填（幂等可重跑）。
 *
 * 背景：contact_point.value 是租户作用域确定性 AES-GCM 密文（enc:v2: 或遗留 enc:v1:）。
 * 本脚本在每条记录所属 workspaceId 上下文下解密 email → 取域 → 计算每租户盲索引
 * （`blindContactKey('domain:<lower(domain>)', { workspaceId, purpose: PII_PURPOSE.DOMAIN_BLIND_KEY })`）
 * → 批量回写。绝不落明文域，失败行保留 NULL 并计入报告。
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import {
  assertPiiKeyConfigured,
  blindContactKey,
  decryptPii,
  PII_PURPOSE,
} from '../src/compliance/pii-crypto';
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
      select: { id: true, workspaceId: true, value: true },
      orderBy: { id: 'asc' },
      take: options.batchSize,
    });
    if (batch.length === 0) break;
    for (const row of batch) {
      counts.scanned += 1;
      let domain: string | null = null;
      try {
        const plaintext = decryptPii(row.value, {
          workspaceId: row.workspaceId,
          purpose: PII_PURPOSE.CONTACT_POINT_VALUE,
        });
        domain = emailDomainOfAddress(plaintext);
      } catch {
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
          data: {
            domainBlindKey: blindContactKey(`domain:${domain}`, {
              workspaceId: row.workspaceId,
              purpose: PII_PURPOSE.DOMAIN_BLIND_KEY,
            }),
          },
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
  assertPiiKeyConfigured();
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
