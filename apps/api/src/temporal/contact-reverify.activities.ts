import type { PrismaClient } from '@prisma/client';
import {
  checkProviderGates,
  runReverifySweep,
  type ReverifySummary,
} from '../enrichment/verification/reverify-sweep';
import { MillionVerifierProvider } from '../enrichment/verification/millionverifier.provider';
import type { EmailVerificationProvider } from '../enrichment/verification/email-verification-provider';

/**
 * P1-19：CONTACT_REVERIFY_SWEEP 的活动（每日 Schedule；Schedule 注册即 paused）。
 *
 * owner 连接（跨租户批处理是预期——与 CLI 同语义，取数/落库全部复用
 * `runReverifySweep`，不复制第二套逻辑）。三重门任一不满足 → `status='skipped'`，
 * 零供应商调用、零成本（这是 Schedule 可以被安全地「先注册、后放行」的根据）。
 */
export type ContactReverifySweepResult =
  | { status: 'skipped'; reason: string; summary: null }
  | { status: 'ran'; reason: null; summary: ReverifySummary };

function envPositiveInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function createContactReverifyActivities(deps: {
  ownerDb: PrismaClient;
  /** 测试注入点；生产从 env 构造 MillionVerifierProvider。 */
  provider?: EmailVerificationProvider;
  now?: () => Date;
}) {
  return {
    async contactReverifySweepOnce(args: { limit?: number } = {}): Promise<ContactReverifySweepResult> {
      const now = deps.now ?? (() => new Date());
      const provider = deps.provider ?? new MillionVerifierProvider();
      const gates = await checkProviderGates(deps.ownerDb, provider);
      if (!gates.ok) {
        console.log(`[contact-reverify] skipped: ${gates.reason}`);
        return { status: 'skipped', reason: gates.reason ?? 'provider_gate_closed', summary: null };
      }
      if (!provider.isConfigured()) {
        console.log('[contact-reverify] skipped: provider_unconfigured（凭据未配置）');
        return { status: 'skipped', reason: 'provider_unconfigured', summary: null };
      }
      const limit = Math.min(
        Math.max(args.limit ?? envPositiveInt('CONTACT_REVERIFY_MAX_PER_ROUND', 500, 1, 1000), 1),
        1000,
      );
      const summary = await runReverifySweep({
        prisma: deps.ownerDb,
        provider,
        options: {
          dryRun: false,
          limit,
          ratePerSecond: envPositiveInt('CONTACT_REVERIFY_RATE', 2, 1, 50),
          workspaceId: null,
          ignoreSchedule: false,
          requestBucket: now().toISOString().slice(0, 10),
          maxCostMicrousd: envPositiveInt('CONTACT_REVERIFY_MAX_COST_MICROUSD', 5_000_000, 0, 100_000_000),
        },
        now,
      });
      // 结构化统计日志（无 PII；run_event 是 discovery-run 域的账，Schedule 无 run，
      // 观测走 Temporal 可见性 + 该日志行 + 周报查询）。
      console.log(
        `[contact-reverify] selected=${summary.selected} calls=${summary.providerCalls} ` +
          `dup=${summary.duplicates} blocked=${summary.skippedSuppressed + summary.skippedCompliance} ` +
          `errors=${summary.errors} budgetSkipped=${summary.skippedBudget} ` +
          `costMicrousd=${summary.costMicrousd} states=${JSON.stringify(summary.byState)}`,
      );
      return { status: 'ran', reason: null, summary };
    },
  };
}

export type ContactReverifyActivities = ReturnType<typeof createContactReverifyActivities>;
