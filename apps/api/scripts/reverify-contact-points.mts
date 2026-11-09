/**
 * P1-19：存量邮箱再验证编排 CLI —— 批量、限流、幂等、审计行、dry-run。
 * 核心逻辑在 src/enrichment/verification/reverify-sweep.ts（与每日 Schedule 的 activity 共用，
 * 不要在此复制第二套取数/落库语义）。本文件只做参数解析与单次执行。
 *
 * 运行（凭据到位前 dry-run 可用；live 需 MILLIONVERIFIER_API_KEY + data_provider ENABLED）：
 *   cd /global/backend/apps/api && node --import tsx scripts/reverify-contact-points.mts --dry-run
 *   cd /global/backend/apps/api && node --import tsx scripts/reverify-contact-points.mts --limit 100 --rate 5
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import {
  checkProviderGates,
  runReverifySweep,
  type ReverifyOptions,
} from '../src/enrichment/verification/reverify-sweep';
import { resolveConfiguredVerificationProviders } from '../src/enrichment/verification/provider-pool';

export function parseReverifyArgs(argv: string[]): ReverifyOptions {
  const valueOf = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 ? (argv[index + 1] ?? null) : null;
  };
  const int = (raw: string | null, fallback: number, min: number, max: number, name: string): number => {
    if (raw === null) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(`${name} 必须是 ${min}..${max} 的整数`);
    }
    return parsed;
  };
  const now = new Date();
  return {
    dryRun: argv.includes('--dry-run'),
    limit: int(valueOf('--limit'), 100, 1, 1000, '--limit'),
    ratePerSecond: int(valueOf('--rate'), 5, 1, 50, '--rate'),
    workspaceId: valueOf('--workspace'),
    ignoreSchedule: argv.includes('--ignore-schedule'),
    requestBucket:
      valueOf('--request-bucket') ?? now.toISOString().slice(0, 10),
  };
}

async function main(): Promise<void> {
  const options = parseReverifyArgs(process.argv.slice(2));
  if (!process.env.PII_ENCRYPTION_KEY) {
    throw new Error('PII_ENCRYPTION_KEY 未配置——无法解密联系点值（fail-closed）');
  }
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    // 验证器池：凭据已配置的验证器（主验在前），再逐家过 data_provider/source_policy 门。
    const configured = resolveConfiguredVerificationProviders();
    const usable: typeof configured = [];
    const gateNotes: string[] = [];
    for (const candidate of configured) {
      const gates = await checkProviderGates(prisma, candidate);
      if (gates.ok) usable.push(candidate);
      else gateNotes.push(`${candidate.key}: ${gates.reason}`);
    }
    const poolNote =
      `验证器池：凭据已配置 [${configured.map((p) => p.key).join(', ') || '无'}]，` +
      `门通过 [${usable.map((p) => p.key).join(', ') || '无'}]` +
      (gateNotes.length > 0 ? `；未通过：${gateNotes.join('；')}` : '');
    if (options.dryRun) {
      // dry-run 离线：只报告门状态，不因 kill switch/凭据缺失而拒绝（方便部署前演练）。
      console.log(`[dry-run] ${poolNote}`);
    } else {
      if (usable.length === 0) {
        console.error(`拒绝执行：没有可用验证器（${poolNote}）`);
        process.exitCode = 2;
        return;
      }
    }
    if (!options.dryRun) {
      // 单飞锁：同 provider 池 + 同周期桶只允许一个 sweep 在跑（并发双跑会对同一批点各付一次
      // 供应商费用——事件账只去重记录，不退费）。会话级 advisory lock，进程退出自动释放。
      const [lock] = await prisma.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtextextended(${
          `reverify-sweep:${usable.map((p) => p.key).sort().join('+')}:${options.requestBucket}`
        }, 0))::boolean AS locked`;
      if (!lock?.locked) {
        console.error('拒绝执行：已有同验证器池/同周期桶的再验证在运行（并发双跑会重复计费）');
        process.exitCode = 2;
        return;
      }
    }
    const summary = await runReverifySweep({
      prisma,
      providers: usable,
      options,
      actorId: 'reverify-sweep:cli',
    });
    const header = options.dryRun ? '[dry-run] ' : '';
    console.log(
      `${header}再验证完成：选中 ${summary.selected}，供应商调用 ${summary.providerCalls}，` +
        `幂等跳过 ${summary.duplicates}，合规拦截 ${summary.skippedCompliance}，` +
        `suppression ${summary.skippedSuppressed}，预算跳过 ${summary.skippedBudget}，` +
        `错误 ${summary.errors}，成本 ${summary.costMicrousd} 微美元`,
    );
    if (!options.dryRun) {
      console.log(
        `状态分布：VALID ${summary.byState.VALID} / INVALID ${summary.byState.INVALID} / ` +
          `CATCH_ALL_RISKY ${summary.byState.CATCH_ALL_RISKY} / UNKNOWN ${summary.byState.UNKNOWN}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

// 直接执行才跑（被 vitest / Schedule activity import 时不自动触发）。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
