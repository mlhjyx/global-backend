import type { EmailVerificationProvider } from './email-verification-provider';
import { EmailableProvider, resolveEmailableConfig } from './emailable.provider';
import { MillionVerifierProvider, resolveMillionVerifierConfig } from './millionverifier.provider';
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
