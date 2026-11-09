import type { PrismaClient } from '@prisma/client';
import {
  checkProviderGates,
  runReverifySweep,
  type ReverifySummary,
} from '../enrichment/verification/reverify-sweep';
import type { EmailVerificationProvider } from '../enrichment/verification/email-verification-provider';
import {
  resolveConfiguredVerificationProviders,
  withSmtpProbeFallback,
} from '../enrichment/verification/provider-pool';
import type { ExecutionBroker } from '../tools/tool-contract';

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
  /** 工具型验证器（SMTP 兜底票）的出网闸门；worker 组合根注入，缺省时兜底票不参与。 */
  broker?: ExecutionBroker;
  /** 测试注入点；生产从 env 构造验证器池（主验在前）。 */
  providers?: EmailVerificationProvider[];
  now?: () => Date;
}) {
  return {
    async contactReverifySweepOnce(args: { limit?: number } = {}): Promise<ContactReverifySweepResult> {
      const now = deps.now ?? (() => new Date());
      const configured = (deps.providers ?? resolveConfiguredVerificationProviders()).filter(
        (provider) => provider.isConfigured(),
      );
      // 逐家过 data_provider（kill switch）+ source_policy 门；全被关掉则零调用。
      const gated: EmailVerificationProvider[] = [];
      const closed: string[] = [];
      for (const candidate of configured) {
        const gates = await checkProviderGates(deps.ownerDb, candidate);
        if (gates.ok) gated.push(candidate);
        else closed.push(`${candidate.key}: ${gates.reason}`);
      }
      // 门后可用票数 <2 时追加 SMTP 探测兜底票（零成本；开关/杀切/broker 缺省则不追加）。
      const fallback = await withSmtpProbeFallback(gated, {
        prisma: deps.ownerDb,
        ...(deps.broker ? { broker: deps.broker } : {}),
      });
      const usable = fallback.providers;
      if (fallback.note) console.log(`[contact-reverify] smtp fallback skipped: ${fallback.note}`);
      if (usable.length === 0) {
        // 没有任何外部验证器凭据时如实报 provider_unconfigured（兜底票为何没上见上一行日志）；
        // 有凭据但全被门关掉时报 provider_gate_closed。reason 词表保持稳定（调用方按等值判断）。
        const reason =
          configured.length === 0
            ? 'provider_unconfigured'
            : `provider_gate_closed(${closed.join(';')})`;
        console.log(`[contact-reverify] skipped: ${reason}`);
        return { status: 'skipped', reason, summary: null };
      }
      const limit = Math.min(
        Math.max(args.limit ?? envPositiveInt('CONTACT_REVERIFY_MAX_PER_ROUND', 500, 1, 1000), 1),
        1000,
      );
      const summary = await runReverifySweep({
        prisma: deps.ownerDb,
        providers: usable,
        actorId: 'contact-reverify-sweep',
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
