import type { PrismaClient } from '@prisma/client';
import type { ExecutionBroker } from '../../tools/tool-contract';
import type { EmailVerificationProvider } from './email-verification-provider';
import { EmailableProvider, resolveEmailableConfig } from './emailable.provider';
import { MillionVerifierProvider, resolveMillionVerifierConfig } from './millionverifier.provider';
import { SmtpProbeProvider, resolveSmtpProbeConfig } from './smtp-probe.provider';
import { ZeroBounceProvider, resolveZeroBounceConfig } from './zerobounce.provider';

/**
 * 验证器池：按固定顺序返回**凭据已配置**的验证器（主验在前）。
 *
 * 顺序即瀑布顺序（计划 §2.3.5.1：MillionVerifier 粗筛 → Emailable 二次确认 →
 * ZeroBounce 仲裁）。data_provider/source_policy 的 kill switch 由调用方
 * （再验证 sweep / CLI / Schedule activity）逐家过 `checkProviderGates`，
 * 本函数只看凭据。缺凭据的验证器不进入列表——瀑布不会浪费一次调用去确认
 * 「provider_unconfigured」，单票 positive 也自然停在 UNKNOWN。
 */
export function resolveConfiguredVerificationProviders(
  env: NodeJS.ProcessEnv = process.env,
): EmailVerificationProvider[] {
  return [
    new MillionVerifierProvider(resolveMillionVerifierConfig(env)),
    new EmailableProvider(resolveEmailableConfig(env)),
    // ZeroBounce = 仲裁席（仅在二次确认后未收敛时由瀑布调用）。
    new ZeroBounceProvider(resolveZeroBounceConfig(env)),
    // 注意：Truelist（catch-all 解析席）**不在此池**——瀑布的「主验 unknown/catch_all →
    // 解析器 → 地址级 valid 需第二票」分支属于 P1-06 后续编排改造；按位置取席位会把它
    // 误当仲裁席。适配器（truelist.provider.ts）已就位并登记 DISABLED，编排接线后再入池。
  ].filter((provider) => provider.isConfigured());
}

/** 兜底票的 kill switch 行（data_provider，seed 默认 ENABLED；与 email-guess 的自建验证共用）。 */
const SMTP_PROBE_PROVIDER_KEY = 'smtp_self';

export interface SmtpProbeFallbackDeps {
  /** 平台表读（data_provider kill switch）；owner 或 app 连接均可（平台表无 RLS）。 */
  prisma: Pick<PrismaClient, 'dataProvider'>;
  /** 工具调用的唯一出网闸门；缺省（脚本/测试未装配）时兜底票不启用。 */
  broker?: ExecutionBroker;
  env?: NodeJS.ProcessEnv;
}

export interface SmtpProbeFallbackOutcome {
  providers: EmailVerificationProvider[];
  /** 未追加时的原因（供 CLI/日志说明池状态）；追加或无需追加时为 null。 */
  note: string | null;
}

/**
 * 第二票兜底（P1-06）：外部验证器**门后可用数 < 2** 时，追加免费的 SMTP RCPT 探测票到
 * 瀑布末席——缺 key / kill switch 关闭的环境里也能凑齐双正投票。
 *
 * 为什么不入 `resolveConfiguredVerificationProviders`：席位取决于**过门后**的数量（凭据在
 * 而 data_provider 关闭的验证器占不了票位），且需要 broker（组合根对象）。两个以上外部
 * 验证器可用时本函数不追加——SMTP 不得占据瀑布的仲裁席。
 *
 * 追加前的三道检查：env 开关（`EMAIL_VERIFY_SMTP_PROBE_ENABLED`，缺省开）→ 票数 <2 →
 * broker 装上 + `data_provider.smtp_self=ENABLED`（运维 kill switch）。source_policy 门
 * 不在此处：SMTP 探测的治理域是逐个收件域名，由 broker 在 invoke 时权威执行。
 */
export async function withSmtpProbeFallback(
  providers: EmailVerificationProvider[],
  deps: SmtpProbeFallbackDeps,
): Promise<SmtpProbeFallbackOutcome> {
  const env = deps.env ?? process.env;
  if (!resolveSmtpProbeConfig(env).enabled) {
    return { providers, note: 'smtp_probe_disabled_by_env' };
  }
  if (providers.length >= 2) return { providers, note: null };
  if (!deps.broker) return { providers, note: 'smtp_probe_broker_unavailable' };
  const killSwitch = await deps.prisma.dataProvider.findUnique({
    where: { key: SMTP_PROBE_PROVIDER_KEY },
    select: { status: true },
  });
  if (killSwitch?.status !== 'ENABLED') {
    return { providers, note: 'smtp_probe_kill_switch_off' };
  }
  return {
    providers: [
      ...providers,
      new SmtpProbeProvider(deps.broker, { config: resolveSmtpProbeConfig(env) }),
    ],
    note: null,
  };
}
